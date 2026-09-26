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
  res.redirect(req.get('referer') && req.get('referer').includes('/admin/') ? req.get('referer') : '/admin/videos');
});

router.post('/videos/:id/retry', (req, res) => {
  db.prepare("UPDATE videos SET next_attempt_at = NULL WHERE id = ? AND status = 'processing'").run(Number(req.params.id));
  pipeline.kick();
  res.redirect('/admin/videos?status=processing');
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
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id) AS videos FROM users u
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
  res.render('admin/settings', { title: 'Settings', plans, paymentMode: config.paymentMode });
});

router.post('/settings', (req, res) => {
  setSetting('site_name', String(req.body.site_name || 'VideoStore').slice(0, 60));
  for (const k of ['hide_ads_for_subscribers', 'auto_approve', 'open_creator_signup']) setSetting(k, req.body[k] === 'yes' ? '1' : '0');
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
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
