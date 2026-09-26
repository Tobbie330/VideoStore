'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { db } = require('../db');
const { flash, requireLogin } = require('../middleware');

const router = express.Router();

// Simple in-memory login throttle: 10 failed attempts per IP per 15 minutes.
const failures = new Map();
function throttled(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60 * 1000) { failures.delete(ip); return false; }
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, first: Date.now() };
  f.count += 1;
  failures.set(ip, f);
}

function safeReturn(req) {
  const to = req.session.returnTo;
  delete req.session.returnTo;
  return to && to.startsWith('/') && !to.startsWith('//') ? to : '/';
}

function logIn(req, res, userId) {
  const ageConfirmed = req.session.ageConfirmed;
  const returnTo = safeReturn(req);
  req.session.regenerate((err) => {
    if (err) return res.status(500).send('Session error');
    req.session.userId = userId;
    req.session.ageConfirmed = ageConfirmed;
    res.redirect(returnTo);
  });
}

router.get('/login', (req, res) => res.render('auth/login', { title: 'Log in' }));

function clientIp(req) {
  return (config.trustProxy && config.clientIpHeader && req.get(config.clientIpHeader)) || req.ip;
}

router.post('/login', (req, res) => {
  const ip = clientIp(req);
  if (throttled(ip)) {
    flash(req, 'error', 'Too many attempts. Try again in 15 minutes.');
    return res.redirect('/login');
  }
  const login = String(req.body.login || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(login, login);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    recordFailure(ip);
    flash(req, 'error', 'Wrong username/email or password.');
    return res.redirect('/login');
  }
  if (user.banned) {
    flash(req, 'error', 'This account has been suspended.');
    return res.redirect('/login');
  }
  logIn(req, res, user.id);
});

router.get('/register', (req, res) => res.render('auth/register', { title: 'Sign up' }));

router.post('/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const errors = [];
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) errors.push('Username must be 3–24 letters, numbers or underscores.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (req.body.adult !== 'yes') errors.push('You must confirm you are 18 or older.');
  if (!errors.length && db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(username, email)) {
    errors.push('That username or email is already registered.');
  }
  if (errors.length) {
    return res.status(400).render('auth/register', { title: 'Sign up', errors, form: { username, email } });
  }
  const r = db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'member')")
    .run(username, email, bcrypt.hashSync(password, 12));
  logIn(req, res, Number(r.lastInsertRowid));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/account', requireLogin, (req, res) => {
  const payments = db.prepare('SELECT p.*, pl.name AS plan_name FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.render('auth/account', { title: 'My account', payments });
});

router.post('/account/password', requireLogin, (req, res) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), row.password_hash)) {
    flash(req, 'error', 'Current password is wrong.');
  } else if (String(req.body.password || '').length < 8) {
    flash(req, 'error', 'New password must be at least 8 characters.');
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(req.body.password), 12), req.user.id);
    flash(req, 'success', 'Password updated.');
  }
  res.redirect('/account');
});

module.exports = router;
