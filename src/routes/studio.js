'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { db, slugify, transaction } = require('../db');
const V = require('../videos');
const pipeline = require('../pipeline');
const { upload, receive, discard } = require('../uploads');
const { flash, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireRole('creator', 'admin'));

const STATUS_LABELS = {
  processing: 'Processing',
  pending: 'Awaiting review',
  approved: 'Live',
  rejected: 'Rejected',
  infected: 'Blocked: virus found',
  failed: 'Failed',
};

router.get('/', (req, res) => {
  const videos = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v LEFT JOIN categories c ON c.id = v.category_id
      WHERE v.user_id = ? ORDER BY v.id DESC`).all(req.user.id);
  res.render('studio/index', { title: 'My Studio', videos, STATUS_LABELS });
});

router.get('/status', (req, res) => {
  const rows = db.prepare('SELECT id, status, status_detail FROM videos WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
  res.json(rows.map((r) => ({ ...r, label: STATUS_LABELS[r.status] || r.status })));
});

router.get('/upload', (req, res) => {
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY sort_order, name').all();
  res.render('studio/upload', { title: 'Upload', categories, maxMb: Math.round(config.maxUploadBytes / 1048576), popularTags: V.popularTags(40) });
});

function readForm(body) {
  const errors = [];
  const title = String(body.title || '').trim().slice(0, 150);
  const description = String(body.description || '').trim().slice(0, 5000);
  const categoryId = Number(body.category_id) || null;
  const access = body.access === 'premium' ? 'premium' : 'free';
  const tags = V.parseTags(body.tags);
  if (title.length < 3) errors.push('Title must be at least 3 characters.');
  if (categoryId && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) errors.push('Pick a valid category.');
  return { errors, title, description, categoryId, access, tags };
}

router.post('/upload', receive(upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }])), (req, res) => {
  const wantsJson = (req.get('accept') || '').includes('application/json');
  const form = readForm(req.body);
  const video = req.files && req.files.video && req.files.video[0];
  const thumb = req.files && req.files.thumbnail && req.files.thumbnail[0];
  if (!video) form.errors.push('Choose a video file.');
  if (req.body.compliance !== 'yes') form.errors.push('You must confirm the compliance statement.');
  if (form.errors.length) {
    discard(req);
    if (wantsJson) return res.status(400).json({ error: form.errors.join(' ') });
    flash(req, 'error', form.errors.join(' '));
    return res.redirect('/studio/upload');
  }
  const id = transaction(() => {
    const r = db.prepare(`INSERT INTO videos (user_id, category_id, title, slug, description, access, status, status_detail, quarantine_file, quarantine_thumb)
        VALUES (?, ?, ?, ?, ?, ?, 'processing', 'Queued for virus scan', ?, ?)`)
      .run(req.user.id, form.categoryId, form.title, slugify(form.title), form.description, form.access,
        path.basename(video.path), thumb ? path.basename(thumb.path) : null);
    const vid = Number(r.lastInsertRowid);
    V.setTags(vid, form.tags);
    return vid;
  });
  pipeline.kick();
  if (wantsJson) return res.json({ ok: true, id, redirect: '/studio' });
  flash(req, 'success', 'Upload received! It is being virus-scanned and cleaned of metadata.');
  res.redirect('/studio');
});

function ownVideo(req) {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(Number(req.params.id));
  if (!v) return null;
  if (v.user_id !== req.user.id && req.user.role !== 'admin') return null;
  return v;
}

router.get('/video/:id/edit', (req, res, next) => {
  const video = ownVideo(req);
  if (!video) return next();
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY sort_order, name').all();
  res.render('studio/edit', { title: 'Edit video', video, categories, tags: V.tagsFor(video.id).map((t) => t.name).join(', ') });
});

router.post('/video/:id/edit', (req, res, next) => {
  const video = ownVideo(req);
  if (!video) return next();
  const form = readForm(req.body);
  if (form.errors.length) {
    flash(req, 'error', form.errors.join(' '));
    return res.redirect(`/studio/video/${video.id}/edit`);
  }
  transaction(() => {
    db.prepare('UPDATE videos SET title = ?, slug = ?, description = ?, category_id = ?, access = ? WHERE id = ?')
      .run(form.title, slugify(form.title), form.description, form.categoryId, form.access, video.id);
    V.setTags(video.id, form.tags);
  });
  flash(req, 'success', 'Saved.');
  res.redirect(req.user.role === 'admin' && video.user_id !== req.user.id ? '/admin/videos' : '/studio');
});

function deleteVideoFiles(v) {
  for (const [dir, f] of [[config.videoDir, v.video_file], [config.thumbDir, v.thumb_file],
    [config.quarantineDir, v.quarantine_file], [config.quarantineDir, v.quarantine_thumb]]) {
    if (f) fs.rm(path.join(dir, path.basename(f)), { force: true }, () => {});
  }
}

router.post('/video/:id/delete', (req, res, next) => {
  const video = ownVideo(req);
  if (!video) return next();
  if (video.status === 'processing' && video.quarantine_file) {
    flash(req, 'error', 'Wait until processing finishes before deleting.');
    return res.redirect('/studio');
  }
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM video_tags)').run();
  deleteVideoFiles(video);
  flash(req, 'success', 'Video deleted.');
  res.redirect(req.body.back === 'admin' ? '/admin/videos' : '/studio');
});

module.exports = router;
module.exports.deleteVideoFiles = deleteVideoFiles;
