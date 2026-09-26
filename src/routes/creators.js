'use strict';
// Members apply to become creators by submitting their legal name, date of
// birth and photo ID + a selfie holding the ID. An admin checks the documents
// and approves the application, which turns the account into a creator.
const fs = require('node:fs');
const express = require('express');
const { db, getSettings, transaction } = require('../db');
const privateDocs = require('../privateDocs');
const { ScannerUnavailableError } = require('../scanner');
const { upload, receive, discard } = require('../uploads');
const { flash, requireLogin } = require('../middleware');

const router = express.Router();
const MAX_DOC_BYTES = 25 * 1024 * 1024;

function age(dob) {
  const d = new Date(dob + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return -1;
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a -= 1;
  return a;
}

function latestApplication(userId) {
  return db.prepare('SELECT * FROM creator_applications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
}

router.get('/become-creator', requireLogin, (req, res) => {
  res.render('creator-apply', {
    title: 'Become a creator',
    application: latestApplication(req.user.id),
    open: getSettings().creator_applications_open === '1',
  });
});

router.post('/become-creator', requireLogin, receive(upload.fields([
  { name: 'id_front', maxCount: 1 }, { name: 'id_back', maxCount: 1 }, { name: 'selfie', maxCount: 1 },
])), async (req, res) => {
  const fail = (msg) => {
    discard(req);
    flash(req, 'error', msg);
    res.redirect('/become-creator');
  };
  if (getSettings().creator_applications_open !== '1') return fail('Creator applications are closed right now.');
  if (req.user.role !== 'member') return fail('Your account can already upload.');
  const prev = latestApplication(req.user.id);
  if (prev && prev.status === 'pending') return fail('Your application is already being reviewed.');

  const b = req.body;
  const legalName = String(b.legal_name || '').trim().slice(0, 150);
  const dob = String(b.date_of_birth || '');
  const country = String(b.country || '').trim().slice(0, 60);
  const stageName = String(b.stage_name || '').trim().slice(0, 60);
  const files = req.files || {};
  const errors = [];
  if (legalName.length < 3) errors.push('Enter your full legal name as it appears on your ID.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || age(dob) < 18 || age(dob) > 120) errors.push('You must be 18 or older.');
  if (!country) errors.push('Enter your country.');
  if (!files.id_front) errors.push('Upload a photo of the front of your ID.');
  if (!files.selfie) errors.push('Upload a selfie of you holding your ID.');
  if (Object.values(files).flat().some((f) => f.size > MAX_DOC_BYTES)) errors.push('Each file must be under 25 MB.');
  if (b.agree !== 'yes') errors.push('You must agree to the creator terms.');
  if (errors.length) return fail(errors.join(' '));

  // Record everything, then scan + encrypt the documents before responding.
  const { appId, docIds } = transaction(() => {
    const r = db.prepare('INSERT INTO creator_applications (user_id, legal_name, date_of_birth, country, stage_name) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, legalName, dob, country, stageName);
    const id = Number(r.lastInsertRowid);
    const ids = [];
    for (const kind of ['id_front', 'id_back', 'selfie']) {
      if (files[kind]) ids.push(privateDocs.addQuarantined(files[kind][0], { userId: req.user.id, applicationId: id, kind }));
    }
    return { appId: id, docIds: ids };
  });

  try {
    for (const id of docIds) {
      const doc = db.prepare('SELECT * FROM private_docs WHERE id = ?').get(id);
      if (!(await privateDocs.processDoc(doc))) throw Object.assign(new Error('A file failed the virus scan.'), { infected: true });
    }
  } catch (e) {
    privateDocs.removeDocs('application_id', appId);
    db.prepare('DELETE FROM creator_applications WHERE id = ?').run(appId);
    for (const f of Object.values(files).flat()) fs.rm(f.path, { force: true }, () => {});
    if (e instanceof ScannerUnavailableError) return fail('Our security scanner is busy. Please try again in a few minutes.');
    if (e.infected) return fail('One of your files was rejected by our virus scanner.');
    console.error('[creators] application failed:', e);
    return fail('Something went wrong. Please try again.');
  }

  flash(req, 'success', 'Application sent! We will review your documents shortly.');
  res.redirect('/become-creator');
});

module.exports = router;
