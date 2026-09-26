'use strict';
const path = require('node:path');
const express = require('express');
const config = require('../config');
const { db } = require('../db');
const V = require('../videos');
const { flash, requireLogin, isSubscriber } = require('../middleware');

const router = express.Router();

router.get('/healthz', (req, res) => res.json({ ok: true }));

router.get('/age-check', (req, res) => res.render('age-check', { title: 'Adults only' }));
router.post('/age-check', (req, res) => {
  if (req.body.confirm !== 'yes') return res.redirect('https://www.google.com');
  req.session.ageConfirmed = true;
  const to = req.session.returnTo && req.session.returnTo.startsWith('/') && !req.session.returnTo.startsWith('//') ? req.session.returnTo : '/';
  delete req.session.returnTo;
  res.redirect(to);
});

for (const page of ['terms', 'privacy', '2257', 'dmca']) {
  router.get(`/${page}`, (req, res) => res.render(`legal/${page}`, { title: page.toUpperCase() }));
}

function listingParams(req) {
  return { sort: req.query.sort, page: req.query.page, access: req.query.access };
}

router.get('/', (req, res) => {
  const result = V.listVideos(listingParams(req));
  const featured = result.page === 1 && !req.query.access
    ? db.prepare(`SELECT id FROM videos WHERE status = 'approved' AND featured = 1 ORDER BY published_at DESC LIMIT 4`).all()
      .map((r) => V.getVideo(r.id)) : [];
  res.render('list', { title: 'Home', heading: 'Videos', featured, ...result, tags: V.popularTags(30) });
});

router.get('/categories', (req, res) => {
  const cats = db.prepare(`SELECT c.*, COUNT(v.id) AS n,
      (SELECT id FROM videos WHERE category_id = c.id AND status = 'approved' ORDER BY views DESC LIMIT 1) AS cover_id
      FROM categories c LEFT JOIN videos v ON v.category_id = c.id AND v.status = 'approved'
      GROUP BY c.id ORDER BY c.sort_order, c.name`).all();
  res.render('categories', { title: 'Categories', categories: cats });
});

router.get('/category/:slug', (req, res, next) => {
  const cat = db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.params.slug);
  if (!cat) return next();
  const result = V.listVideos({ ...listingParams(req), categoryId: cat.id });
  res.render('list', { title: cat.name, heading: cat.name, subheading: cat.description, ...result, tags: [] });
});

router.get('/tags', (req, res) => {
  res.render('tags', { title: 'Tags', tags: V.popularTags(500) });
});

router.get('/tag/:slug', (req, res, next) => {
  const tag = db.prepare('SELECT * FROM tags WHERE slug = ?').get(req.params.slug);
  if (!tag) return next();
  const result = V.listVideos({ ...listingParams(req), tagId: tag.id });
  res.render('list', { title: `#${tag.name}`, heading: `#${tag.name}`, ...result, tags: [] });
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 100);
  const result = V.listVideos({ ...listingParams(req), q });
  const tagHits = q ? db.prepare("SELECT name, slug FROM tags WHERE name LIKE ? LIMIT 15").all(`%${q}%`) : [];
  res.render('list', { title: `Search: ${q}`, heading: q ? `Results for “${q}”` : 'Search', ...result, tags: tagHits });
});

router.get('/creator/:username', (req, res, next) => {
  const u = db.prepare('SELECT id, username, created_at FROM users WHERE username = ?').get(req.params.username);
  if (!u) return next();
  const result = V.listVideos({ ...listingParams(req), userId: u.id });
  res.render('list', { title: u.username, heading: u.username, subheading: `${result.total} videos`, ...result, tags: [] });
});

function canView(video, user) {
  if (video.status === 'approved') return true;
  return !!user && (user.role === 'admin' || user.id === video.user_id);
}

router.get('/video/:id{/:slug}', (req, res, next) => {
  const video = V.getVideo(Number(req.params.id));
  if (!video || !video.video_file || !canView(video, req.user)) return next();
  if (req.params.slug !== video.slug) return res.redirect(301, `/video/${video.id}/${video.slug}`);

  // Count one view per session per video.
  req.session.viewed = req.session.viewed || [];
  if (!req.session.viewed.includes(video.id)) {
    db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').run(video.id);
    req.session.viewed = [...req.session.viewed.slice(-200), video.id];
    video.views += 1;
  }
  const isOwner = !!req.user && req.user.id === video.user_id;
  const locked = video.access === 'premium' && !isSubscriber(req.user) && !isOwner;
  const myVote = req.user ? db.prepare('SELECT value FROM votes WHERE video_id = ? AND user_id = ?').get(video.id, req.user.id) : null;
  res.render('video', {
    title: video.title,
    video,
    locked,
    myVote: myVote ? myVote.value : 0,
    tags: V.tagsFor(video.id),
    related: V.related(video),
  });
});

router.post('/video/:id/vote', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  const value = Number(req.body.value);
  const video = db.prepare("SELECT id, slug FROM videos WHERE id = ? AND status = 'approved'").get(id);
  if (!video) return res.status(404).json({ error: 'not found' });
  if (value === 1 || value === -1) {
    db.prepare('INSERT INTO votes (video_id, user_id, value) VALUES (?, ?, ?) ON CONFLICT(video_id, user_id) DO UPDATE SET value = excluded.value')
      .run(id, req.user.id, value);
  } else {
    db.prepare('DELETE FROM votes WHERE video_id = ? AND user_id = ?').run(id, req.user.id);
  }
  const s = db.prepare('SELECT COALESCE(SUM(value = 1), 0) AS likes, COUNT(*) AS n FROM votes WHERE video_id = ?').get(id);
  if (req.get('accept') && req.get('accept').includes('application/json')) return res.json(s);
  res.redirect(`/video/${id}/${video.slug}`);
});

const REPORT_REASONS = ['Underage or non-consensual content', 'I appear in this video and did not consent', 'Copyright / stolen content', 'Illegal content', 'Spam or misleading', 'Other'];

router.get('/video/:id/report', (req, res, next) => {
  const video = db.prepare("SELECT id, title, slug FROM videos WHERE id = ? AND status = 'approved'").get(Number(req.params.id));
  if (!video) return next();
  res.render('report', { title: 'Report video', video, reasons: REPORT_REASONS });
});

router.post('/video/:id/report', (req, res, next) => {
  const video = db.prepare("SELECT id, slug FROM videos WHERE id = ? AND status = 'approved'").get(Number(req.params.id));
  if (!video) return next();
  const reason = REPORT_REASONS.includes(req.body.reason) ? req.body.reason : 'Other';
  db.prepare('INSERT INTO reports (video_id, user_id, reason, details) VALUES (?, ?, ?, ?)')
    .run(video.id, req.user ? req.user.id : null, reason, String(req.body.details || '').slice(0, 2000));
  flash(req, 'success', 'Thanks — our team will review this report.');
  res.redirect(`/video/${video.id}/${video.slug}`);
});

// ---- media (never served statically so the paywall can't be bypassed) ----

router.get('/media/video/:id', (req, res, next) => {
  const v = db.prepare('SELECT id, user_id, status, access, video_file FROM videos WHERE id = ?').get(Number(req.params.id));
  if (!v || !v.video_file || !canView(v, req.user)) return next();
  if (v.access === 'premium' && !isSubscriber(req.user) && !(req.user && req.user.id === v.user_id)) {
    return res.status(402).send('Subscription required');
  }
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(config.videoDir, path.basename(v.video_file)));
});

router.get('/media/thumb/:id', (req, res, next) => {
  const v = db.prepare('SELECT id, user_id, status, thumb_file FROM videos WHERE id = ?').get(Number(req.params.id));
  if (!v || !v.thumb_file || !canView(v, req.user)) return next();
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(config.thumbDir, path.basename(v.thumb_file)));
});

module.exports = router;
