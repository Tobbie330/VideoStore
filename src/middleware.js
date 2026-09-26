'use strict';
const crypto = require('node:crypto');
const session = require('express-session');
const { db, getSettings } = require('./db');

class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at')
        .run(sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600000).unref();

function isSubscriber(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!user.subscription_expires_at && new Date(user.subscription_expires_at + 'Z') > new Date();
}

function loadUser(req, res, next) {
  req.user = null;
  if (req.session.userId) {
    const u = db.prepare('SELECT id, username, email, role, subscription_expires_at, banned FROM users WHERE id = ?').get(req.session.userId);
    if (u && !u.banned) req.user = u;
    else delete req.session.userId;
  }
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  const settings = getSettings();
  res.locals.user = req.user;
  res.locals.isSubscriber = isSubscriber(req.user);
  res.locals.settings = settings;
  res.locals.csrf = req.session.csrf;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.navCategories = db.prepare('SELECT name, slug FROM categories ORDER BY sort_order, name').all();
  res.locals.showAds = !(settings.hide_ads_for_subscribers === '1' && isSubscriber(req.user));
  next();
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Multipart bodies aren't parsed yet; upload routes call csrfCheck after multer.
  if (req.is('multipart/form-data') && !req.body) return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(String(req.session.csrf || ''));
  if (a.length && a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(403).render('error', { title: 'Session expired', message: 'Your session expired. Go back, refresh the page and try again.' });
}

// Adult-content age confirmation. Search engine bots still see the gate page.
function ageGate(req, res, next) {
  const exempt = ['/age-check', '/terms', '/privacy', '/2257', '/dmca', '/healthz'];
  if (exempt.includes(req.path) || req.path.startsWith('/static/') || req.path.startsWith('/ads/')) return next();
  if (req.session.ageConfirmed || req.user) return next();
  if (req.method !== 'GET') return res.status(403).send('Age confirmation required');
  req.session.returnTo = req.originalUrl;
  res.redirect('/age-check');
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  flash(req, 'info', 'Please log in first.');
  res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (roles.includes(req.user.role)) return next();
    res.status(403).render('error', { title: 'Not allowed', message: 'You do not have access to this page.' });
  };
}

module.exports = { SqliteStore, loadUser, flash, csrfCheck, ageGate, requireLogin, requireRole, isSubscriber };
