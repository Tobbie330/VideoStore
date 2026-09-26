'use strict';
// Subscriptions. All payment code lives in this file so a processor can be
// added without touching the rest of the site.
//
// PAYMENT_MODE=demo (the only mode today): choosing a plan grants premium
// instantly with no charge, so the whole site can be tested end to end.
//
// To add a real processor (CCBill, Segpay, Verotel, Epoch...):
//   1. In POST /premium/:planId, redirect to (or embed) the processor's
//      payment form, passing req.user.id and plan.id as custom fields.
//   2. Add a webhook route here (mount it before CSRF in server.js) that
//      verifies the processor's signature, then calls grantPremium() on
//      a successful charge/renewal and revokePremium() on cancel/refund.
//   3. Record each charge in the payments table with the processor's
//      transaction id as `reference` so repeated webhooks are ignored.
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const { flash, requireLogin } = require('../middleware');

const router = express.Router();

function grantPremium(userId, days) {
  db.prepare(`UPDATE users SET subscription_expires_at = datetime(
      CASE WHEN subscription_expires_at > datetime('now') THEN subscription_expires_at ELSE datetime('now') END, ?)
    WHERE id = ?`).run(`+${Number(days)} days`, userId);
}

function revokePremium(userId) {
  db.prepare("UPDATE users SET subscription_expires_at = datetime('now') WHERE id = ?").run(userId);
}

function recordPayment(userId, planId, amountCents, provider, reference) {
  if (db.prepare('SELECT 1 FROM payments WHERE provider = ? AND reference = ?').get(provider, reference)) return false;
  db.prepare('INSERT INTO payments (user_id, plan_id, amount_cents, provider, reference) VALUES (?, ?, ?, ?, ?)')
    .run(userId, planId, amountCents, provider, reference);
  return true;
}

router.get('/premium', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY price_cents').all();
  const premiumCount = db.prepare("SELECT COUNT(*) AS n FROM videos WHERE status = 'approved' AND access = 'premium'").get().n;
  res.render('premium', { title: 'Go Premium', plans, premiumCount, paymentMode: config.paymentMode });
});

router.post('/premium/:planId', requireLogin, (req, res, next) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND active = 1').get(Number(req.params.planId));
  if (!plan) return next();
  if (config.paymentMode !== 'demo') {
    return res.status(503).render('error', { title: 'Checkout', message: 'Payments are not set up yet.' });
  }
  grantPremium(req.user.id, plan.days);
  recordPayment(req.user.id, plan.id, 0, 'demo', 'demo-' + crypto.randomBytes(6).toString('hex'));
  flash(req, 'success', `Premium activated for ${plan.days} days (demo mode — no charge).`);
  res.redirect('/account');
});

module.exports = { router, grantPremium, revokePremium, recordPayment };
