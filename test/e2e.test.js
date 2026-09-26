'use strict';
// End-to-end test: fake clamd + real ffmpeg + the real app over HTTP.
// Needs ffmpeg/ffprobe (set FFMPEG_PATH / FFPROBE_PATH if not on PATH).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'videostore-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.CLAMAV_HOST = '127.0.0.1';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const { startFakeClamd, client, EICAR } = require('./helpers');
let clamd;

function probeTags(file) {
  const out = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file]));
  return out;
}

let server;
let base;
let app;
let pipeline;
let db;

before(async () => {
  clamd = await startFakeClamd();
  process.env.CLAMAV_PORT = String(clamd.address().port);
  app = require('../server');
  pipeline = require('../src/pipeline');
  db = require('../src/db').db;
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Test videos carrying metadata that must be removed.
  const meta = ['-metadata', 'title=SECRET-TITLE', '-metadata', 'comment=SECRET-COMMENT', '-metadata', 'location=+40.7128-074.0060/',
    '-metadata', 'creation_time=2024-01-01T00:00:00Z', '-metadata:s:v', 'handler_name=SECRET-CAMERA'];
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=duration=6',
    '-c:v', 'libx264', '-c:a', 'aac', '-shortest', ...meta, path.join(tmp, 'h264.mp4')]);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25',
    '-c:v', 'mpeg4', ...meta, path.join(tmp, 'mpeg4.mkv')]);
  fs.writeFileSync(path.join(tmp, 'virus.mp4'), EICAR);
});

after(() => {
  server && server.close();
  clamd && clamd.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function upload(c, file, fields) {
  const fd = new FormData();
  fd.set('_csrf', c.csrf);
  for (const [k, v] of Object.entries({ performers: 'solo', ...fields })) fd.set(k, v);
  fd.set('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
  return c.req('POST', '/studio/upload', { body: fd, headers: { accept: 'application/json' } });
}

test('age gate blocks visitors until confirmed', async () => {
  const c = client(base);
  const r = await c.req('GET', '/');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.location, '/age-check');
  await c.req('GET', '/age-check');
  const ok = await c.req('POST', '/age-check', { form: { confirm: 'yes' } });
  assert.strictEqual(ok.location, '/');
  assert.strictEqual((await c.req('GET', '/')).status, 200);
});

test('POST without CSRF token is rejected', async () => {
  const c = client(base);
  const r = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ login: 'x', password: 'y' }), redirect: 'manual' });
  assert.strictEqual(r.status, 403);
  void c;
});

test('upload pipeline: scan, strip metadata, publish, paywall, ads', async () => {
  const admin = client(base);
  await admin.enter();
  await admin.req('GET', '/login');
  const login = await admin.req('POST', '/login', { form: { login: 'admin@test.local', password: 'admin-pass-123' } });
  assert.strictEqual(login.status, 302);
  await admin.req('GET', '/studio/upload');

  // Missing compliance checkbox -> rejected and nothing left in quarantine.
  const bad = await upload(admin, path.join(tmp, 'h264.mp4'), { title: 'No compliance' });
  assert.strictEqual(bad.status, 400);

  const r1 = await upload(admin, path.join(tmp, 'h264.mp4'), { title: 'Clean H264', tags: 'outdoor, Test Tag', access: 'free', compliance: 'yes' });
  assert.strictEqual(r1.status, 200, r1.text);
  const r2 = await upload(admin, path.join(tmp, 'mpeg4.mkv'), { title: 'Needs transcode', access: 'premium', compliance: 'yes' });
  assert.strictEqual(r2.status, 200, r2.text);
  const r3 = await upload(admin, path.join(tmp, 'virus.mp4'), { title: 'Evil', compliance: 'yes' });
  assert.strictEqual(r3.status, 200, r3.text);
  const [id1, id2, id3] = [r1, r2, r3].map((r) => JSON.parse(r.text).id);

  await pipeline.tick();

  const cfg = require('../src/config');
  const v1 = db.prepare('SELECT * FROM videos WHERE id = ?').get(id1);
  const v2 = db.prepare('SELECT * FROM videos WHERE id = ?').get(id2);
  const v3 = db.prepare('SELECT * FROM videos WHERE id = ?').get(id3);
  assert.strictEqual(v1.status, 'approved', v1.status_detail); // admin uploads auto-approve
  assert.strictEqual(v2.status, 'approved', v2.status_detail);
  assert.strictEqual(v3.status, 'infected');
  assert.match(v3.status_detail, /Eicar/);
  assert.ok(v1.duration_seconds >= 5);

  // Quarantine is empty: bad upload, virus and originals are all gone.
  assert.deepStrictEqual(fs.readdirSync(cfg.quarantineDir), []);

  // No metadata survives in either published file.
  for (const v of [v1, v2]) {
    const info = probeTags(path.join(cfg.videoDir, v.video_file));
    const dump = JSON.stringify(info);
    assert.ok(!dump.includes('SECRET'), `metadata left in ${v.title}: ${dump}`);
    assert.ok(!dump.includes('40.7128'), 'GPS left');
    assert.ok(!dump.includes('2024-01-01'), 'creation time left');
    assert.ok(!/Lavf|Lavc/.test(JSON.stringify(info.format.tags || {})), 'encoder tag left');
    assert.strictEqual(info.streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
  }
  const thumbInfo = probeTags(path.join(cfg.thumbDir, v1.thumb_file));
  assert.strictEqual(thumbInfo.streams[0].codec_name, 'mjpeg');

  // Browsing, tags, search.
  const guest = client(base);
  await guest.enter();
  const home = await guest.req('GET', '/');
  assert.match(home.text, /Clean H264/);
  assert.match(home.text, /Needs transcode/);
  assert.doesNotMatch(home.text, /Evil/);
  assert.match((await guest.req('GET', '/tag/test-tag')).text, /Clean H264/);
  assert.match((await guest.req('GET', '/search?q=outdoor')).text, /Clean H264/);

  // Paywall: guests can stream free video but not premium.
  const free = await guest.req('GET', `/media/video/${id1}`, { headers: { range: 'bytes=0-99' } });
  assert.strictEqual(free.status, 206);
  assert.strictEqual((await guest.req('GET', `/media/video/${id2}`)).status, 402);
  const page = await guest.req('GET', `/video/${id2}/${v2.slug}`);
  assert.match(page.text, /This is a Premium video/);
  assert.doesNotMatch(page.text, /<video/);
  assert.strictEqual((await admin.req('GET', `/media/video/${id2}`, { headers: { range: 'bytes=0-9' } })).status, 206);

  // Demo subscription unlocks premium for a member.
  const member = client(base);
  await member.enter();
  await member.req('GET', '/register');
  const reg = await member.req('POST', '/register', { form: { username: 'member1', email: 'm@test.local', password: 'password123', adult: 'yes' } });
  assert.strictEqual(reg.status, 302);
  assert.strictEqual((await member.req('GET', `/media/video/${id2}`)).status, 402);
  await member.req('GET', '/premium');
  const plan = db.prepare('SELECT id FROM plans ORDER BY id LIMIT 1').get();
  await member.req('POST', `/premium/${plan.id}`, { form: {} });
  assert.strictEqual((await member.req('GET', `/media/video/${id2}`, { headers: { range: 'bytes=0-9' } })).status, 206);

  // Members can't reach studio/admin.
  assert.strictEqual((await member.req('GET', '/studio')).status, 403);
  assert.strictEqual((await member.req('GET', '/admin')).status, 403);

  // Partner ads: HTML ads render sandboxed; subscribers see no ads.
  await admin.req('GET', '/admin/ads');
  const fd = new FormData();
  fd.set('_csrf', admin.csrf);
  for (const [k, v] of Object.entries({ partner: 'Acme', name: 'Banner', slot: 'sidebar', kind: 'html', html: '<b>ACME-AD</b>', weight: '1', active: 'yes' })) fd.set(k, v);
  const adRes = await admin.req('POST', '/admin/ads', { body: fd });
  assert.strictEqual(adRes.status, 302);
  const watchPage = await guest.req('GET', `/video/${id1}/${v1.slug}`);
  assert.match(watchPage.text, /<iframe class="ad-frame" sandbox="allow-scripts/);
  assert.match(watchPage.text, /ACME-AD/);
  assert.doesNotMatch((await member.req('GET', `/video/${id1}/${v1.slug}`)).text, /ACME-AD/);

  // Reports reach the admin queue.
  await guest.req('GET', `/video/${id1}/report`);
  await guest.req('POST', `/video/${id1}/report`, { form: { reason: 'Copyright / stolen content', details: 'mine' } });
  assert.match((await admin.req('GET', '/admin/reports')).text, /Copyright/);
});

test('scanner offline keeps upload in quarantine and retries', async () => {
  const cfg = require('../src/config');
  const realPort = cfg.clamav.port;
  cfg.clamav.port = 1; // nothing listens here
  const q = path.join(cfg.quarantineDir, 'upload-offline-test');
  fs.copyFileSync(path.join(tmp, 'h264.mp4'), q);
  const r = db.prepare("INSERT INTO videos (user_id, title, slug, status, quarantine_file) VALUES (1, 'Offline', 'offline', 'processing', 'upload-offline-test')").run();
  await pipeline.tick();
  let v = db.prepare('SELECT * FROM videos WHERE id = ?').get(r.lastInsertRowid);
  assert.strictEqual(v.status, 'processing');
  assert.strictEqual(v.attempts, 1);
  assert.ok(fs.existsSync(q), 'file stays in quarantine');

  cfg.clamav.port = realPort;
  db.prepare('UPDATE videos SET next_attempt_at = NULL WHERE id = ?').run(r.lastInsertRowid);
  await pipeline.tick();
  v = db.prepare('SELECT * FROM videos WHERE id = ?').get(r.lastInsertRowid);
  assert.strictEqual(v.status, 'approved');
});
