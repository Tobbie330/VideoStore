'use strict';
// Creator ID verification, release forms, encrypted document storage, review
// queue, region blocking, legal pages and backups.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'videostore-compliance-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.CLAMAV_HOST = '127.0.0.1';
process.env.TRUST_PROXY = '1';
process.env.DOCS_ENCRYPTION_KEY = 'ab'.repeat(32);

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const { startFakeClamd, client, EICAR } = require('./helpers');

let clamd;
let server;
let base;
let db;
let pipeline;
let config;

// Distinctive bytes so we can prove the stored files are encrypted.
const ID_FRONT = Buffer.from('%PDF-1.4 FAKE-ID-FRONT-JANE-DOE-1990-01-01 ' + 'x'.repeat(200));
const SELFIE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('FAKE-SELFIE-JPEG ' + 'y'.repeat(200))]);
const RELEASE = Buffer.from('%PDF-1.4 MODEL-RELEASE-SIGNED-BY-SAM ' + 'z'.repeat(200));

before(async () => {
  clamd = await startFakeClamd();
  process.env.CLAMAV_PORT = String(clamd.address().port);
  const app = require('../server');
  db = require('../src/db').db;
  pipeline = require('../src/pipeline');
  config = require('../src/config');
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25', '-c:v', 'libx264', path.join(tmp, 'v.mp4')]);
});

after(() => {
  server && server.close();
  clamd && clamd.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function register(name) {
  const c = client(base);
  await c.enter();
  await c.req('GET', '/register');
  const r = await c.req('POST', '/register', { form: { username: name, email: `${name}@test.local`, password: 'password123', adult: 'yes' } });
  assert.strictEqual(r.status, 302);
  return c;
}

test('creator verification, release forms and review queue', async () => {
  const jane = await register('jane');

  // Members can't upload until verified.
  assert.strictEqual((await jane.req('GET', '/studio/upload')).status, 403);

  // Under-18 date of birth is refused.
  await jane.req('GET', '/become-creator');
  let r = await jane.req('POST', '/become-creator', {
    body: jane.multipart({ legal_name: 'Jane Doe', date_of_birth: '2015-01-01', country: 'US', agree: 'yes' },
      [['id_front', 'id.pdf', ID_FRONT, 'application/pdf'], ['selfie', 's.jpg', SELFIE, 'image/jpeg']]),
  });
  assert.strictEqual(r.status, 302);
  assert.match((await jane.req('GET', '/become-creator')).text, /18 or older/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM creator_applications').get().n, 0);

  // A virus in an ID file is refused and nothing is kept.
  r = await jane.req('POST', '/become-creator', {
    body: jane.multipart({ legal_name: 'Jane Doe', date_of_birth: '1990-01-01', country: 'US', agree: 'yes' },
      [['id_front', 'id.pdf', Buffer.from(EICAR), 'application/pdf'], ['selfie', 's.jpg', SELFIE, 'image/jpeg']]),
  });
  assert.match((await jane.req('GET', '/become-creator')).text, /rejected by our virus scanner/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM private_docs').get().n, 0);

  // Valid application.
  r = await jane.req('POST', '/become-creator', {
    body: jane.multipart({ legal_name: 'Jane Doe', date_of_birth: '1990-01-01', country: 'US', stage_name: 'JD', agree: 'yes' },
      [['id_front', 'id.pdf', ID_FRONT, 'application/pdf'], ['selfie', 's.jpg', SELFIE, 'image/jpeg']]),
  });
  assert.strictEqual(r.status, 302);
  assert.match((await jane.req('GET', '/become-creator')).text, /under review/);
  const app = db.prepare('SELECT * FROM creator_applications').get();
  assert.strictEqual(app.status, 'pending');

  // Documents are encrypted at rest and nothing is left in quarantine.
  const docs = db.prepare('SELECT * FROM private_docs WHERE application_id = ?').all(app.id);
  assert.strictEqual(docs.length, 2);
  for (const d of docs) {
    assert.strictEqual(d.status, 'stored');
    const raw = fs.readFileSync(path.join(config.privateDir, d.stored_file));
    assert.ok(!raw.includes('FAKE-ID-FRONT') && !raw.includes('FAKE-SELFIE'), 'stored file must be encrypted');
  }
  assert.deepStrictEqual(fs.readdirSync(config.quarantineDir), []);

  // Only admins can open documents; admins get the original bytes back.
  const idDoc = docs.find((d) => d.kind === 'id_front');
  assert.strictEqual((await jane.req('GET', `/admin/docs/${idDoc.id}`)).status, 403);
  const admin = client(base);
  await admin.login('admin@test.local', 'admin-pass-123');
  const docRes = await admin.req('GET', `/admin/docs/${idDoc.id}`);
  assert.strictEqual(docRes.status, 200);
  assert.ok(docRes.buf.equals(ID_FRONT));
  assert.strictEqual(docRes.headers.get('cache-control'), 'no-store');

  // Approving requires ticking the checklist.
  await admin.req('GET', `/admin/creators/${app.id}`);
  await admin.req('POST', `/admin/creators/${app.id}`, { form: { action: 'approve' } });
  assert.strictEqual(db.prepare('SELECT status FROM creator_applications WHERE id = ?').get(app.id).status, 'pending');
  await admin.req('GET', `/admin/creators/${app.id}`);
  await admin.req('POST', `/admin/creators/${app.id}`, { form: { action: 'approve', checked: 'yes' } });
  assert.strictEqual(db.prepare("SELECT role FROM users WHERE username = 'jane'").get().role, 'creator');

  // Uploading with other people requires release forms.
  await jane.req('GET', '/studio/upload');
  const video = fs.readFileSync(path.join(tmp, 'v.mp4'));
  r = await jane.req('POST', '/studio/upload', {
    headers: { accept: 'application/json' },
    body: jane.multipart({ title: 'Duo video', performers: 'releases', compliance: 'yes' }, [['video', 'v.mp4', video, 'video/mp4']]),
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.text, /release form/);

  r = await jane.req('POST', '/studio/upload', {
    headers: { accept: 'application/json' },
    body: jane.multipart({ title: 'Duo video', performers: 'releases', compliance: 'yes' },
      [['video', 'v.mp4', video, 'video/mp4'], ['releases', 'sam-release.pdf', RELEASE, 'application/pdf']]),
  });
  assert.strictEqual(r.status, 200, r.text);
  const vid = JSON.parse(r.text).id;
  await pipeline.tick();

  // Creator uploads always wait for review.
  let v = db.prepare('SELECT * FROM videos WHERE id = ?').get(vid);
  assert.strictEqual(v.status, 'pending', v.status_detail);
  const rel = db.prepare('SELECT * FROM private_docs WHERE video_id = ?').get(vid);
  assert.strictEqual(rel.status, 'stored');
  assert.ok(!fs.readFileSync(path.join(config.privateDir, rel.stored_file)).includes('MODEL-RELEASE'));

  // Review page shows the verified identity and the release form.
  const review = await admin.req('GET', `/admin/videos/${vid}/review`);
  assert.match(review.text, /Jane Doe/);
  assert.match(review.text, /sam-release\.pdf/);
  await admin.req('POST', `/admin/videos/${vid}/status`, { form: { action: 'approve', back: 'review' } });
  v = db.prepare('SELECT * FROM videos WHERE id = ?').get(vid);
  assert.strictEqual(v.status, 'approved');

  // Deleting the video keeps the release form (2257 records must be retained).
  await jane.req('GET', '/studio');
  await jane.req('POST', `/studio/video/${vid}/delete`, { form: {} });
  assert.ok(!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(vid));
  const kept = db.prepare('SELECT * FROM private_docs WHERE id = ?').get(rel.id);
  assert.ok(kept, 'release record kept');
  assert.strictEqual(kept.video_title, 'Duo video');
  assert.ok(fs.existsSync(path.join(config.privateDir, kept.stored_file)));
});

test('region blocking uses location headers', async () => {
  const admin = client(base);
  await admin.login('admin@test.local', 'admin-pass-123');
  await admin.req('GET', '/admin/settings');
  await admin.req('POST', '/admin/settings', { form: { site_name: 'VideoStore', blocked_regions: 'us-tx, GB, not-a-code' } });
  assert.strictEqual(db.prepare("SELECT value FROM settings WHERE key = 'blocked_regions'").get().value, 'US-TX, GB');

  const texas = client(base, { 'cf-ipcountry': 'US', 'cf-region-code': 'TX' });
  const r = await texas.req('GET', '/');
  assert.strictEqual(r.status, 451);
  assert.match(r.text, /Not available in your region/);
  assert.strictEqual((await texas.req('GET', '/terms')).status, 200);

  assert.strictEqual((await client(base, { 'cf-ipcountry': 'GB' }).req('GET', '/')).status, 451);
  assert.strictEqual((await client(base, { 'cf-ipcountry': 'US', 'cf-region-code': 'CA' }).req('GET', '/')).status, 302); // -> age gate
  assert.strictEqual((await client(base).req('GET', '/')).status, 302);

  // An admin travelling in a blocked region can still log in and manage the site.
  const admTx = client(base, { 'cf-ipcountry': 'US', 'cf-region-code': 'TX' });
  const login = await admTx.login('admin@test.local', 'admin-pass-123');
  assert.strictEqual(login.status, 302);
  assert.strictEqual((await admTx.req('GET', '/admin')).status, 200);

  await admin.req('POST', '/admin/settings', { form: { site_name: 'VideoStore', blocked_regions: '' } });
});

test('legal pages use business details and admin-written text', async () => {
  const admin = client(base);
  await admin.login('admin@test.local', 'admin-pass-123');
  await admin.req('GET', '/admin/settings');
  await admin.req('POST', '/admin/settings', {
    form: { site_name: 'VideoStore', business_name: 'Acme Media LLC', contact_email: 'abuse@acme.test', custodian_name: 'Pat Custodian', custodian_address: '1 Main St\nSpringfield' },
  });
  const p2257 = await admin.req('GET', '/2257');
  assert.match(p2257.text, /Pat Custodian/);
  assert.match(p2257.text, /1 Main St<br>Springfield/);
  assert.match((await admin.req('GET', '/dmca')).text, /abuse@acme\.test/);

  await admin.req('GET', '/admin/legal');
  await admin.req('POST', '/admin/legal', { form: { legal_terms: '## Our Terms\n\nBe nice. <script>alert(1)</script>' } });
  const terms = await admin.req('GET', '/terms');
  assert.match(terms.text, /<h2>Our Terms<\/h2>/);
  assert.match(terms.text, /&lt;script&gt;/);
  assert.doesNotMatch(terms.text, /<script>alert/);
  assert.doesNotMatch(terms.text, /Template text/);
});

test('backup script snapshots the database and mirrors files', () => {
  const backup = require('../scripts/backup');
  backup.runOnce();
  const snaps = fs.readdirSync(path.join(tmp, 'backups', 'db')).filter((f) => f.endsWith('.db'));
  assert.strictEqual(snaps.length, 1);
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(path.join(tmp, 'backups', 'db', snaps[0]), { readOnly: true });
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 2);
  copy.close();
  const privateFiles = fs.readdirSync(config.privateDir);
  assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'backups', 'files', 'private')).sort(), privateFiles.sort());
});
