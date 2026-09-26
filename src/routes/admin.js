'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { db, slugify, setSetting } = require('../db');
const { SLOTS } = require('../ads');
const pipeline = require('../pipeline');
const scanner = require('../scanner');
const { upload, receive, discard } = require('../uploads');
const { flash, requireRole } = require('../middleware');
const { grantPremium } = require('./billing');
const privateDocs = require('../privateDocs');
const V = require('../videos');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/', async (req, res) => {
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  const stats = {
    live: count("SELECT COUNT(*) AS n FROM videos WHERE status = 'approved'"),
    pending: count("SELECT COUNT(*) AS n FROM videos WHERE status = 'pending'"),
    processing: count("SELECT COUNT(*) AS n FROM videos WHERE status = 'processing'"),
    blocked: count("SELECT COUNT(*) AS n FROM videos WHERE status IN ('infected','failed')"),
    users: count('SELECT COUNT(*) AS n FROM users'),
    subscribers: count("SELECT COUNT(*) AS n FROM users WHERE subscription_expires_at > datetime('now')"),
    reports: count('SELECT COUNT(*) AS n FROM reports WHERE resolved = 0'),
    applications: count("SELECT COUNT(*) AS n FROM creator_applications WHERE status = 'pending'"),
    views: count('SELECT COALESCE(SUM(views), 0) AS n FROM videos'),
    revenue30: count("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE created_at > datetime('now', '-30 days')"),
    adImpressions: count('SELECT COALESCE(SUM(impressions), 0) AS n FROM ads'),
    adClicks: count('SELECT COALESCE(SUM(clicks), 0) AS n FROM ads'),
  };
  const scannerOnline = await scanner.ping();
  res.render('admin/dashboard', { title: 'Admin', stats, scannerOnline });
});

// ---- videos / moderation ----

router.get('/videos', (req, res) => {
  const status = String(req.query.status || 'pending');
  const q = String(req.query.q || '').trim();
  const where = [];
  const params = [];
  if (status !== 'all') { where.push('v.status = ?'); params.push(status); }
  if (q) { where.push('(v.title LIKE ? OR u.username LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const videos = db.prepare(`SELECT v.*, u.username, c.name AS category_name,
      (SELECT COUNT(*) FROM reports r WHERE r.video_id = v.id AND r.resolved = 0) AS open_reports
      FROM videos v JOIN users u ON u.id = v.user_id LEFT JOIN categories c ON c.id = v.category_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.id DESC LIMIT 200`).all(...params);
  res.render('admin/videos', { title: 'Videos', videos, status, q });
});

router.post('/videos/:id/status', (req, res) => {
  const action = req.body.action;
  const id = Number(req.params.id);
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (v && v.video_file) {
    if (action === 'approve') db.prepare("UPDATE videos SET status = 'approved', status_detail = '', published_at = COALESCE(published_at, datetime('now')) WHERE id = ?").run(id);
    if (action === 'reject') db.prepare("UPDATE videos SET status = 'rejected', status_detail = ? WHERE id = ?").run(String(req.body.reason || '').slice(0, 300), id);
    if (action === 'feature') db.prepare('UPDATE videos SET featured = 1 - featured WHERE id = ?').run(id);
    if (action === 'free' || action === 'premium') db.prepare('UPDATE videos SET access = ? WHERE id = ?').run(action, id);
  }
  if (req.body.back === 'review') return res.redirect(action === 'approve' || action === 'reject' ? '/admin/videos?status=pending' : `/admin/videos/${id}/review`);
  res.redirect(req.get('referer') && req.get('referer').includes('/admin/') ? req.get('referer') : '/admin/videos');
});

router.post('/videos/:id/retry', (req, res) => {
  db.prepare("UPDATE videos SET next_attempt_at = NULL WHERE id = ? AND status = 'processing'").run(Number(req.params.id));
  pipeline.kick();
  res.redirect('/admin/videos?status=processing');
});

// Review page: watch the video next to the uploader's verified identity and
// the release forms attached to it.
router.get('/videos/:id/review', (req, res, next) => {
  const video = db.prepare(`SELECT v.*, u.username, u.role AS uploader_role, c.name AS category_name FROM videos v
      JOIN users u ON u.id = v.user_id LEFT JOIN categories c ON c.id = v.category_id WHERE v.id = ?`).get(Number(req.params.id));
  if (!video) return next();
  const application = db.prepare("SELECT * FROM creator_applications WHERE user_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1").get(video.user_id);
  const docs = db.prepare('SELECT * FROM private_docs WHERE video_id = ? ORDER BY id').all(video.id);
  const reports = db.prepare('SELECT * FROM reports WHERE video_id = ? ORDER BY id DESC').all(video.id);
  res.render('admin/review', { title: 'Review video', video, application, docs, reports, tags: V.tagsFor(video.id) });
});

// ---- creator applications & identity records ----

router.get('/creators', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const applications = db.prepare(`SELECT a.*, u.username, u.email FROM creator_applications a JOIN users u ON u.id = a.user_id
      WHERE a.status = ? ORDER BY a.id DESC LIMIT 200`).all(status);
  res.render('admin/creators', { title: 'Creator applications', applications, status });
});

router.get('/creators/:id', (req, res, next) => {
  const application = db.prepare(`SELECT a.*, u.username, u.email, u.role, r.username AS reviewer FROM creator_applications a
      JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.reviewed_by WHERE a.id = ?`).get(Number(req.params.id));
  if (!application) return next();
  const docs = db.prepare('SELECT * FROM private_docs WHERE application_id = ? ORDER BY id').all(application.id);
  const releases = db.prepare("SELECT * FROM private_docs WHERE user_id = ? AND kind = 'release' ORDER BY id DESC").all(application.user_id);
  res.render('admin/creator', { title: application.legal_name, application, docs, releases });
});

router.post('/creators/:id', (req, res, next) => {
  const a = db.prepare('SELECT * FROM creator_applications WHERE id = ?').get(Number(req.params.id));
  if (!a) return next();
  const note = String(req.body.note || '').slice(0, 500);
  if (req.body.action === 'approve') {
    if (req.body.checked !== 'yes') {
      flash(req, 'error', 'Tick the box confirming you checked the ID before approving.');
      return res.redirect(`/admin/creators/${a.id}`);
    }
    db.prepare("UPDATE creator_applications SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(note, req.user.id, a.id);
    db.prepare("UPDATE users SET role = 'creator' WHERE id = ? AND role = 'member'").run(a.user_id);
    flash(req, 'success', 'Approved — the account can now upload.');
  } else if (req.body.action === 'reject') {
    db.prepare("UPDATE creator_applications SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(note, req.user.id, a.id);
    flash(req, 'success', 'Application rejected.');
  }
  res.redirect('/admin/creators');
});

// Decrypts and shows one private document. Never cached, admin-only.
router.get('/docs/:id', (req, res, next) => {
  const doc = db.prepare("SELECT * FROM private_docs WHERE id = ? AND status = 'stored'").get(Number(req.params.id));
  if (!doc) return next();
  let data;
  try {
    data = privateDocs.decryptFile(path.join(config.privateDir, doc.stored_file));
  } catch (e) {
    console.error(`[docs] cannot decrypt doc ${doc.id}:`, e.message);
    return res.status(500).render('error', { title: 'Cannot open document', message: 'This document could not be decrypted. Check DOCS_ENCRYPTION_KEY.' });
  }
  const isPdf = doc.mime === 'application/pdf' || /\.pdf$/i.test(doc.original_name);
  const isImage = /^image\/(jpeg|png|webp)$/.test(doc.mime);
  res.set({
    'Cache-Control': 'no-store',
    'Content-Type': isPdf ? 'application/pdf' : isImage ? doc.mime : 'application/octet-stream',
    'Content-Disposition': `${isPdf || isImage ? 'inline' : 'attachment'}; filename="document-${doc.id}${path.extname(doc.original_name).replace(/[^.\w]/g, '')}"`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  });
  res.send(data);
});

// ---- reports ----

router.get('/reports', (req, res) => {
  const reports = db.prepare(`SELECT r.*, v.title, v.slug, u.username FROM reports r JOIN videos v ON v.id = r.video_id
      LEFT JOIN users u ON u.id = r.user_id WHERE r.resolved = ? ORDER BY r.id DESC LIMIT 200`).all(req.query.resolved === '1' ? 1 : 0);
  res.render('admin/reports', { title: 'Reports', reports, resolved: req.query.resolved === '1' });
});

router.post('/reports/:id/resolve', (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id));
  if (r) {
    db.prepare('UPDATE reports SET resolved = 1 WHERE id = ?').run(r.id);
    if (req.body.takedown === 'yes') db.prepare("UPDATE videos SET status = 'rejected', status_detail = 'Removed after report' WHERE id = ?").run(r.video_id);
  }
  res.redirect('/admin/reports');
});

// ---- categories ----

router.get('/categories', (req, res) => {
  const categories = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS n
      FROM categories c ORDER BY sort_order, name`).all();
  res.render('admin/categories', { title: 'Categories', categories });
});

router.post('/categories', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (name) {
    try {
      db.prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)')
        .run(name, slugify(name), String(req.body.description || '').slice(0, 500), Number(req.body.sort_order) || 0);
      flash(req, 'success', `Added “${name}”.`);
    } catch {
      flash(req, 'error', 'A category with that name already exists.');
    }
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id', (req, res) => {
  const id = Number(req.params.id);
  if (req.body.action === 'delete') {
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  } else {
    const name = String(req.body.name || '').trim().slice(0, 60);
    try {
      db.prepare('UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?')
        .run(name, slugify(name), String(req.body.description || '').slice(0, 500), Number(req.body.sort_order) || 0, id);
    } catch {
      flash(req, 'error', 'A category with that name already exists.');
    }
  }
  res.redirect('/admin/categories');
});

// ---- ads / partners ----

router.get('/ads', (req, res) => {
  const ads = db.prepare('SELECT * FROM ads ORDER BY partner, slot, id').all();
  const partners = db.prepare(`SELECT partner, COUNT(*) AS ads, SUM(impressions) AS impressions, SUM(clicks) AS clicks
      FROM ads GROUP BY partner ORDER BY partner`).all();
  const edit = req.query.edit ? db.prepare('SELECT * FROM ads WHERE id = ?').get(Number(req.query.edit)) : null;
  res.render('admin/ads', { title: 'Ads & partners', ads, partners, SLOTS, edit });
});

function readAd(body) {
  const url = String(body.target_url || '').trim();
  return {
    name: String(body.name || '').trim().slice(0, 100) || 'Untitled ad',
    partner: String(body.partner || '').trim().slice(0, 100) || 'Unknown partner',
    slot: SLOTS[body.slot] ? body.slot : 'sidebar',
    kind: body.kind === 'html' ? 'html' : 'image',
    html: String(body.html || '').slice(0, 20000),
    target_url: /^https?:\/\//i.test(url) ? url : '',
    weight: Math.max(1, Math.min(100, Number(body.weight) || 1)),
    active: body.active === 'yes' ? 1 : 0,
    starts_at: /^\d{4}-\d{2}-\d{2}$/.test(body.starts_at || '') ? body.starts_at : null,
    ends_at: /^\d{4}-\d{2}-\d{2}$/.test(body.ends_at || '') ? body.ends_at : null,
  };
}

router.post('/ads', receive(upload.single('image')), async (req, res) => {
  const ad = readAd(req.body);
  const id = Number(req.body.id) || null;
  let imageFile = null;
  if (req.file) {
    try {
      imageFile = await pipeline.cleanImage(req.file.path);
    } catch (e) {
      discard(req);
      flash(req, 'error', `Image rejected: ${e.message}`);
      return res.redirect('/admin/ads' + (id ? `?edit=${id}` : ''));
    }
  }
  if (id) {
    const old = db.prepare('SELECT image_file FROM ads WHERE id = ?').get(id);
    if (!old) return res.redirect('/admin/ads');
    if (imageFile && old.image_file) fs.rm(path.join(config.adDir, old.image_file), { force: true }, () => {});
    db.prepare(`UPDATE ads SET name=?, partner=?, slot=?, kind=?, html=?, target_url=?, weight=?, active=?, starts_at=?, ends_at=?,
        image_file = COALESCE(?, image_file) WHERE id = ?`)
      .run(ad.name, ad.partner, ad.slot, ad.kind, ad.html, ad.target_url, ad.weight, ad.active, ad.starts_at, ad.ends_at, imageFile, id);
    flash(req, 'success', 'Ad updated.');
  } else {
    db.prepare(`INSERT INTO ads (name, partner, slot, kind, html, target_url, weight, active, starts_at, ends_at, image_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ad.name, ad.partner, ad.slot, ad.kind, ad.html, ad.target_url, ad.weight, ad.active, ad.starts_at, ad.ends_at, imageFile);
    flash(req, 'success', 'Ad created.');
  }
  res.redirect('/admin/ads');
});

router.post('/ads/:id/delete', (req, res) => {
  const ad = db.prepare('SELECT image_file FROM ads WHERE id = ?').get(Number(req.params.id));
  if (ad) {
    db.prepare('DELETE FROM ads WHERE id = ?').run(Number(req.params.id));
    if (ad.image_file) fs.rm(path.join(config.adDir, ad.image_file), { force: true }, () => {});
  }
  res.redirect('/admin/ads');
});

// ---- users ----

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id) AS videos,
      EXISTS (SELECT 1 FROM creator_applications a WHERE a.user_id = u.id AND a.status = 'approved') AS id_verified FROM users u
      ${q ? 'WHERE u.username LIKE ? OR u.email LIKE ?' : ''} ORDER BY u.id DESC LIMIT 200`).all(...(q ? [`%${q}%`, `%${q}%`] : []));
  res.render('admin/users', { title: 'Users', users, q });
});

router.post('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id && req.body.action !== 'grant') {
    flash(req, 'error', 'You cannot change your own role or ban yourself.');
    return res.redirect('/admin/users');
  }
  const a = req.body.action;
  if (['member', 'creator', 'admin'].includes(a)) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(a, id);
  if (a === 'ban') db.prepare('UPDATE users SET banned = 1 - banned WHERE id = ?').run(id);
  if (a === 'grant') {
    grantPremium(id, Math.max(1, Math.min(3650, Number(req.body.days) || 30)));
  }
  if (a === 'revoke') db.prepare('UPDATE users SET subscription_expires_at = NULL WHERE id = ?').run(id);
  res.redirect('/admin/users' + (req.body.q ? `?q=${encodeURIComponent(req.body.q)}` : ''));
});

// ---- plans & settings ----

router.get('/settings', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans ORDER BY price_cents').all();
  res.render('admin/settings', { title: 'Settings', plans, paymentMode: config.paymentMode, geoActive: config.trustProxy });
});

router.post('/settings', (req, res) => {
  setSetting('site_name', String(req.body.site_name || 'VideoStore').slice(0, 60));
  for (const k of ['hide_ads_for_subscribers', 'creator_applications_open']) setSetting(k, req.body[k] === 'yes' ? '1' : '0');
  for (const k of ['business_name', 'business_address', 'contact_email', 'custodian_name', 'custodian_address']) {
    setSetting(k, String(req.body[k] || '').trim().slice(0, 500));
  }
  const regions = String(req.body.blocked_regions || '').toUpperCase().split(/[\s,]+/)
    .filter((r) => /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(r));
  setSetting('blocked_regions', [...new Set(regions)].join(', '));
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
});

// ---- legal pages ----

const LEGAL_PAGES = { terms: 'Terms of Service', privacy: 'Privacy Policy', 2257: '2257 Statement', dmca: 'DMCA & Content Removal' };

router.get('/legal', (req, res) => {
  res.render('admin/legal', { title: 'Legal pages', LEGAL_PAGES });
});

router.post('/legal', (req, res) => {
  for (const k of Object.keys(LEGAL_PAGES)) setSetting(`legal_${k}`, String(req.body[`legal_${k}`] || '').slice(0, 100000));
  flash(req, 'success', 'Legal pages saved.');
  res.redirect('/admin/legal');
});

router.post('/plans', (req, res) => {
  const id = Number(req.body.id) || null;
  const name = String(req.body.name || '').trim().slice(0, 40);
  const price = Math.round(Number(req.body.price) * 100);
  const days = Number(req.body.days);
  if (req.body.action === 'delete' && id) {
    db.prepare('UPDATE plans SET active = 0 WHERE id = ?').run(id);
  } else if (name && price >= 0 && days > 0) {
    if (id) db.prepare('UPDATE plans SET name = ?, price_cents = ?, days = ?, active = 1 WHERE id = ?').run(name, price, days, id);
    else db.prepare('INSERT INTO plans (name, price_cents, days) VALUES (?, ?, ?)').run(name, price, days);
  } else {
    flash(req, 'error', 'Plan needs a name, a price and a number of days.');
  }
  res.redirect('/admin/settings');
});

module.exports = router;
