'use strict';
// Encrypted storage for identity documents and release forms.
// Files are virus-scanned, then encrypted with AES-256-GCM before being
// written to disk. They are never served publicly; only admins can view them.
// Originals are kept byte-for-byte (they are legal records), so metadata is
// not stripped here — it's protected by the encryption instead.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { db } = require('./db');
const scanner = require('./scanner');

fs.mkdirSync(config.privateDir, { recursive: true });

function loadKey() {
  if (config.docsKey) {
    const key = Buffer.from(config.docsKey, /^[0-9a-f]{64}$/i.test(config.docsKey) ? 'hex' : 'base64');
    if (key.length !== 32) throw new Error('DOCS_ENCRYPTION_KEY must be 32 bytes (64 hex characters).');
    return key;
  }
  if (config.isProd) {
    console.error('DOCS_ENCRYPTION_KEY must be set in production. Run `openssl rand -hex 32`, put it in .env, and keep a copy somewhere safe.');
    process.exit(1);
  }
  // No key configured (development): generate one and keep it with the database so docs stay
  // readable across restarts. Setting DOCS_ENCRYPTION_KEY is better, because then
  // a copy of the data volume alone can't decrypt the documents.
  const keyFile = path.join(path.dirname(config.dbPath), 'docs.key');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn(`[docs] No DOCS_ENCRYPTION_KEY set; generated ${keyFile}. Back this file up — without it the ID documents can't be read.`);
  }
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

// File format: 12-byte IV | 16-byte auth tag | ciphertext
function encryptFile(src, dest) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(fs.readFileSync(src)), cipher.final()]);
  fs.writeFileSync(dest, Buffer.concat([iv, cipher.getAuthTag(), enc]), { mode: 0o600 });
}

function decryptFile(file) {
  const buf = fs.readFileSync(file);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
}

const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
function isAllowed(file) {
  return ALLOWED.test(file.mimetype) || /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(file.originalname);
}

// Records an uploaded file (still in quarantine) as a private doc.
function addQuarantined(file, fields) {
  const r = db.prepare(`INSERT INTO private_docs (user_id, application_id, video_id, video_title, kind, original_name, mime, status, quarantine_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'quarantine', ?)`)
    .run(fields.userId, fields.applicationId || null, fields.videoId || null, fields.videoTitle || '', fields.kind,
      String(file.originalname || '').slice(0, 200), file.mimetype || 'application/octet-stream', path.basename(file.path));
  return Number(r.lastInsertRowid);
}

// Scans and encrypts one quarantined doc. Throws ScannerUnavailableError if the
// scanner is down (caller retries). Returns false if the file was infected.
async function processDoc(doc) {
  const q = path.join(config.quarantineDir, doc.quarantine_file);
  const result = await scanner.scanFile(q);
  if (!result.clean) {
    fs.rmSync(q, { force: true });
    db.prepare("UPDATE private_docs SET status = 'infected', quarantine_file = NULL WHERE id = ?").run(doc.id);
    return false;
  }
  const name = crypto.randomBytes(16).toString('hex') + '.enc';
  encryptFile(q, path.join(config.privateDir, name));
  fs.rmSync(q, { force: true });
  db.prepare("UPDATE private_docs SET status = 'stored', stored_file = ?, quarantine_file = NULL WHERE id = ?").run(name, doc.id);
  return true;
}

function removeDocs(where, id) {
  if (!['video_id', 'application_id', 'user_id'].includes(where)) throw new Error('bad column');
  const docs = db.prepare(`SELECT * FROM private_docs WHERE ${where} = ?`).all(id);
  for (const d of docs) {
    if (d.stored_file) fs.rmSync(path.join(config.privateDir, d.stored_file), { force: true });
    if (d.quarantine_file) fs.rmSync(path.join(config.quarantineDir, d.quarantine_file), { force: true });
  }
  db.prepare(`DELETE FROM private_docs WHERE ${where} = ?`).run(id);
}

module.exports = { encryptFile, decryptFile, isAllowed, addQuarantined, processDoc, removeDocs };
