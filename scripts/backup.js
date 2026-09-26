'use strict';
// Backs up the database and uploaded files to BACKUP_DIR.
//   node scripts/backup.js          run once
//   node scripts/backup.js --loop   run now, then every BACKUP_INTERVAL_HOURS
// Database: a consistent snapshot (VACUUM INTO) per run; the newest BACKUP_KEEP are kept.
// Files: videos, thumbnails, ad images and the encrypted ID documents are
// mirrored (new/changed files copied, deleted files removed).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const keep = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const intervalHours = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS || 24));

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function backupDatabase() {
  const src = path.join(dataDir, 'videostore.db');
  if (!fs.existsSync(src)) throw new Error(`database not found at ${src}`);
  const dir = path.join(backupDir, 'db');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `videostore-${stamp()}.db`);
  const db = new DatabaseSync(src);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(dest);
  } finally {
    db.close();
  }
  const snapshots = fs.readdirSync(dir).filter((f) => /^videostore-.*\.db$/.test(f)).sort();
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) fs.rmSync(path.join(dir, old));
  // The key that decrypts ID documents (only exists if DOCS_ENCRYPTION_KEY isn't set).
  const keyFile = path.join(dataDir, 'docs.key');
  if (fs.existsSync(keyFile)) fs.copyFileSync(keyFile, path.join(dir, 'docs.key'));
  return dest;
}

function mirror(src, dest) {
  let copied = 0;
  let removed = 0;
  if (!fs.existsSync(src)) return { copied, removed };
  fs.mkdirSync(dest, { recursive: true });
  const names = new Set(fs.readdirSync(src));
  for (const name of names) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (!st.isFile()) continue;
    const dt = fs.existsSync(d) ? fs.statSync(d) : null;
    if (!dt || dt.size !== st.size || dt.mtimeMs < st.mtimeMs) {
      fs.copyFileSync(s, d + '.partial');
      fs.renameSync(d + '.partial', d);
      copied += 1;
    }
  }
  for (const name of fs.readdirSync(dest)) {
    if (!names.has(name)) { fs.rmSync(path.join(dest, name), { force: true }); removed += 1; }
  }
  return { copied, removed };
}

function runOnce() {
  const started = Date.now();
  const db = backupDatabase();
  const files = {};
  for (const sub of ['videos', 'thumbs', 'ads', 'private']) files[sub] = mirror(path.join(uploadDir, sub), path.join(backupDir, 'files', sub));
  console.log(`[backup] ${new Date().toISOString()} database -> ${path.basename(db)}; files ${JSON.stringify(files)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

function safeRun() {
  try { runOnce(); } catch (e) { console.error('[backup] FAILED:', e.message); process.exitCode = 1; }
}

if (require.main === module) {
  safeRun();
  if (process.argv.includes('--loop')) setInterval(safeRun, intervalHours * 3600 * 1000);
}

module.exports = { runOnce, backupDatabase, mirror };
