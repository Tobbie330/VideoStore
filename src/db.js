'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','creator','admin')),
  subscription_expires_at TEXT,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- status flow: processing -> (scanning/stripping) -> pending -> approved | rejected
--              processing -> infected | failed
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT 'free' CHECK (access IN ('free','premium')),
  status TEXT NOT NULL DEFAULT 'processing',
  status_detail TEXT NOT NULL DEFAULT '',
  -- 'solo' = only the uploader appears; 'releases' = release forms/IDs attached for others
  performers TEXT NOT NULL DEFAULT 'solo',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  quarantine_file TEXT,
  quarantine_thumb TEXT,
  video_file TEXT,
  thumb_file TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status, published_at);
CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category_id);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

CREATE TABLE IF NOT EXISTS votes (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  PRIMARY KEY (video_id, user_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  days INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  provider TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- slot: header | sidebar | in_feed | below_player | footer
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  partner TEXT NOT NULL,
  slot TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image','html')),
  image_file TEXT,
  html TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Creator identity verification (18 U.S.C. 2257 style records).
CREATE TABLE IF NOT EXISTS creator_applications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  legal_name TEXT NOT NULL,
  date_of_birth TEXT NOT NULL,
  country TEXT NOT NULL,
  stage_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ID photos, selfies and release forms. Stored encrypted, only admins can view.
-- status: quarantine (waiting for virus scan) -> stored | infected
CREATE TABLE IF NOT EXISTS private_docs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  application_id INTEGER REFERENCES creator_applications(id) ON DELETE RESTRICT,
  -- Kept when a video is deleted: 2257 records must be retained after removal.
  video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  video_title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  status TEXT NOT NULL DEFAULT 'quarantine',
  quarantine_file TEXT,
  stored_file TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  site_name: 'VideoStore',
  hide_ads_for_subscribers: '1',
  creator_applications_open: '1',
  // Region blocking (item: age-verification laws). Comma-separated ISO codes:
  // countries ("GB") or country-region ("US-TX").
  blocked_regions: '',
  // Business details used on the legal pages.
  business_name: '',
  business_address: '',
  contact_email: '',
  custodian_name: '',
  custodian_address: '',
  legal_terms: '',
  legal_privacy: '',
  legal_2257: '',
  legal_dmca: '',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seed() {
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
    const email = config.adminEmail;
    const password = config.adminPassword;
    db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run('admin', email, bcrypt.hashSync(password, 12));
    console.warn(`[seed] Created admin account ${email}. Change the password after first login!`);
  }
  if (!db.prepare('SELECT 1 FROM categories').get()) {
    const ins = db.prepare('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, ?)');
    ['Amateur', 'Professional', 'Solo', 'Couples', 'Behind the Scenes'].forEach((n, i) => ins.run(n, slugify(n), i));
  }
  if (!db.prepare('SELECT 1 FROM plans').get()) {
    const ins = db.prepare('INSERT INTO plans (name, price_cents, days) VALUES (?, ?, ?)');
    ins.run('Monthly', 999, 30);
    ins.run('Quarterly', 2499, 90);
    ins.run('Yearly', 7999, 365);
  }
}

module.exports = { db, getSettings, setSetting, slugify, transaction, seed };
