'use strict';
// Upload processing queue. Every upload goes through, in order:
//   1. virus scan (ClamAV container)         -> infected files are deleted
//   2. ffprobe validation (must be real video)
//   3. ffmpeg rewrite with ALL metadata stripped
//   4. thumbnail: uploaded image is scanned + stripped, or one is generated
//   5. moved out of quarantine -> "pending" (moderation) or "approved"
// Until step 5 completes the file only exists in the quarantine folder,
// which is never served over HTTP.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');
const scanner = require('./scanner');
const media = require('./media');
const privateDocs = require('./privateDocs');

const MAX_ATTEMPTS = 20;
let current = null; // promise of the run in progress
let timer = null;

for (const dir of [config.quarantineDir, config.videoDir, config.thumbDir, config.adDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Synchronous on purpose: an infected/failed file must be gone before its
// status is written.
function rm(file) {
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch (e) { console.error(`[pipeline] could not delete ${file}: ${e.message}`); }
}

function setStatus(id, status, detail = '') {
  db.prepare('UPDATE videos SET status = ?, status_detail = ? WHERE id = ?').run(status, detail, id);
}

function randomName(ext) {
  return crypto.randomBytes(16).toString('hex') + ext;
}

async function scanOrThrow(file, label) {
  const result = await scanner.scanFile(file);
  if (!result.clean) {
    const err = new Error(`${label} infected: ${result.signature}`);
    err.infected = true;
    throw err;
  }
}

async function processVideo(video) {
  const qVideo = path.join(config.quarantineDir, video.quarantine_file);
  const qThumb = video.quarantine_thumb ? path.join(config.quarantineDir, video.quarantine_thumb) : null;

  // 0. Release forms / performer IDs attached to this upload: scan + encrypt.
  const docs = db.prepare("SELECT * FROM private_docs WHERE video_id = ? AND status = 'quarantine'").all(video.id);
  if (docs.length) setStatus(video.id, 'processing', 'Scanning release forms');
  for (const doc of docs) {
    if (!(await privateDocs.processDoc(doc))) {
      const err = new Error(`Release form "${doc.original_name}" infected`);
      err.infected = true;
      throw err;
    }
  }

  // 1. Virus scan the raw upload (and the custom thumbnail) before any parsing.
  setStatus(video.id, 'processing', 'Scanning for viruses');
  await scanOrThrow(qVideo, 'Video');
  if (qThumb) await scanOrThrow(qThumb, 'Thumbnail');

  // 2. Make sure it really is a video.
  setStatus(video.id, 'processing', 'Checking video');
  let info;
  try {
    info = await media.probe(qVideo);
  } catch (e) {
    throw Object.assign(new Error('File is not a readable video'), { permanent: true });
  }
  if (!info.videoCodec) throw Object.assign(new Error('File has no video track'), { permanent: true });

  // 3. Strip all metadata tags.
  setStatus(video.id, 'processing', 'Removing metadata tags');
  const outName = randomName('.mp4');
  const tmpOut = path.join(config.quarantineDir, 'clean-' + outName);
  try {
    await media.stripVideo(qVideo, tmpOut, info);
  } catch (e) {
    rm(tmpOut);
    throw Object.assign(e, { permanent: true });
  }

  // 4. Thumbnail (always re-encoded so it carries no EXIF/GPS either).
  setStatus(video.id, 'processing', 'Creating thumbnail');
  const thumbName = randomName('.jpg');
  const tmpThumb = path.join(config.quarantineDir, 'clean-' + thumbName);
  try {
    if (qThumb) {
      await media.stripImage(qThumb, tmpThumb, { maxWidth: 1280 });
    } else {
      const at = info.duration > 4 ? Math.floor(info.duration * 0.1) : 0;
      await media.stripImage(tmpOut, tmpThumb, { maxWidth: 1280, seekSeconds: at });
    }
  } catch (e) {
    rm(tmpOut); rm(tmpThumb);
    throw Object.assign(e, { permanent: true });
  }

  // 5. Publish out of quarantine.
  fs.renameSync(tmpOut, path.join(config.videoDir, outName));
  fs.renameSync(tmpThumb, path.join(config.thumbDir, thumbName));
  rm(qVideo); rm(qThumb);

  // Every upload waits for a person to review it, except an admin's own uploads.
  const owner = db.prepare('SELECT role FROM users WHERE id = ?').get(video.user_id);
  const approve = !!owner && owner.role === 'admin';
  db.prepare(`UPDATE videos SET video_file = ?, thumb_file = ?, duration_seconds = ?,
      quarantine_file = NULL, quarantine_thumb = NULL, status = ?, status_detail = '',
      published_at = CASE WHEN ? = 'approved' THEN datetime('now') ELSE published_at END
    WHERE id = ?`)
    .run(outName, thumbName, info.duration, approve ? 'approved' : 'pending', approve ? 'approved' : 'pending', video.id);
}

async function handle(video) {
  try {
    await processVideo(video);
    console.log(`[pipeline] video ${video.id} processed`);
  } catch (e) {
    if (e.infected) {
      console.warn(`[pipeline] video ${video.id}: ${e.message} - deleting`);
      rm(path.join(config.quarantineDir, video.quarantine_file));
      if (video.quarantine_thumb) rm(path.join(config.quarantineDir, video.quarantine_thumb));
      db.prepare("UPDATE videos SET status = 'infected', status_detail = ?, quarantine_file = NULL, quarantine_thumb = NULL WHERE id = ?")
        .run(e.message, video.id);
      privateDocs.removeDocs('video_id', video.id);
    } else if (e.permanent || video.attempts + 1 >= MAX_ATTEMPTS) {
      console.warn(`[pipeline] video ${video.id} failed: ${e.message}`);
      rm(path.join(config.quarantineDir, video.quarantine_file));
      if (video.quarantine_thumb) rm(path.join(config.quarantineDir, video.quarantine_thumb));
      db.prepare("UPDATE videos SET status = 'failed', status_detail = ?, quarantine_file = NULL, quarantine_thumb = NULL WHERE id = ?")
        .run(e.message.slice(0, 500), video.id);
      privateDocs.removeDocs('video_id', video.id);
    } else {
      // Scanner down etc. - keep it in quarantine and retry with backoff.
      const delay = Math.min(60 * 30, 15 * 2 ** video.attempts);
      console.warn(`[pipeline] video ${video.id} retry in ${delay}s: ${e.message}`);
      db.prepare(`UPDATE videos SET attempts = attempts + 1, status_detail = ?,
          next_attempt_at = datetime('now', ?) WHERE id = ?`)
        .run(`Waiting to retry: ${e.message}`.slice(0, 500), `+${delay} seconds`, video.id);
    }
  }
}

// Processes queued uploads one at a time. If a run is already in progress,
// returns that run instead of starting a second one.
function tick() {
  if (current) return current;
  current = (async () => {
    for (;;) {
      const next = db.prepare(`SELECT * FROM videos WHERE status = 'processing' AND quarantine_file IS NOT NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now')) ORDER BY id LIMIT 1`).get();
      if (!next) break;
      await handle(next);
    }
  })().finally(() => { current = null; });
  return current;
}

function start() {
  if (timer) return;
  timer = setInterval(() => tick().catch((e) => console.error('[pipeline]', e)), 10000);
  timer.unref();
  kick();
}

function kick() {
  setImmediate(() => tick().catch((e) => console.error('[pipeline]', e)));
}

// Used for partner ad images: scan + strip synchronously, return clean file name.
async function cleanImage(quarantinePath) {
  try {
    await scanOrThrow(quarantinePath, 'Image');
    const name = randomName('.jpg');
    await media.stripImage(quarantinePath, path.join(config.adDir, name), { maxWidth: 1456 });
    return name;
  } finally {
    rm(quarantinePath);
  }
}

module.exports = { start, kick, tick, cleanImage };
