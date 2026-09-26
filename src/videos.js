'use strict';
const { db, slugify } = require('./db');

const PAGE_SIZE = 24;
const SORTS = {
  newest: 'v.published_at DESC',
  popular: 'v.views DESC',
  rated: 'score DESC, v.views DESC',
  longest: 'v.duration_seconds DESC',
};

const BASE_SELECT = `
  SELECT v.id, v.title, v.slug, v.access, v.thumb_file, v.duration_seconds, v.views, v.published_at, v.featured,
         u.username AS uploader, c.name AS category_name, c.slug AS category_slug,
         COALESCE((SELECT SUM(value = 1) FROM votes WHERE video_id = v.id), 0) AS likes,
         COALESCE((SELECT COUNT(*) FROM votes WHERE video_id = v.id), 0) AS vote_count,
         (COALESCE((SELECT SUM(value = 1) FROM votes WHERE video_id = v.id), 0) + 1.0) /
         (COALESCE((SELECT COUNT(*) FROM votes WHERE video_id = v.id), 0) + 2.0) AS score
  FROM videos v
  JOIN users u ON u.id = v.user_id
  LEFT JOIN categories c ON c.id = v.category_id`;

// filters: { categoryId, tagId, q, access, userId, sort, page }
function listVideos(filters = {}) {
  const where = ["v.status = 'approved'"];
  const params = [];
  if (filters.categoryId) { where.push('v.category_id = ?'); params.push(filters.categoryId); }
  if (filters.tagId) { where.push('v.id IN (SELECT video_id FROM video_tags WHERE tag_id = ?)'); params.push(filters.tagId); }
  if (filters.access === 'free' || filters.access === 'premium') { where.push('v.access = ?'); params.push(filters.access); }
  if (filters.userId) { where.push('v.user_id = ?'); params.push(filters.userId); }
  if (filters.excludeId) { where.push('v.id != ?'); params.push(filters.excludeId); }
  if (filters.q) {
    const words = String(filters.q).trim().split(/\s+/).filter(Boolean).slice(0, 8);
    for (const w of words) {
      const like = `%${w.replace(/[%_\\]/g, '\\$&')}%`;
      where.push(`(v.title LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\'
        OR v.id IN (SELECT vt.video_id FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE t.name LIKE ? ESCAPE '\\'))`);
      params.push(like, like, like);
    }
  }
  const sort = SORTS[filters.sort] ? filters.sort : 'newest';
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = filters.limit || PAGE_SIZE;
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM videos v WHERE ${whereSql}`).get(...params).n;
  const rows = db.prepare(`${BASE_SELECT} WHERE ${whereSql} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);
  return { videos: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)), sort };
}

function getVideo(id) {
  return db.prepare(`${BASE_SELECT.replace('SELECT v.id,', 'SELECT v.*, v.id,')} WHERE v.id = ?`).get(id);
}

function tagsFor(videoId) {
  return db.prepare('SELECT t.name, t.slug FROM tags t JOIN video_tags vt ON vt.tag_id = t.id WHERE vt.video_id = ? ORDER BY t.name').all(videoId);
}

function parseTags(input) {
  return [...new Set(String(input || '').split(/[,#\n]/).map((t) => t.trim().toLowerCase().replace(/\s+/g, ' ')).filter((t) => t && t.length <= 40))].slice(0, 25);
}

function setTags(videoId, tagNames) {
  db.prepare('DELETE FROM video_tags WHERE video_id = ?').run(videoId);
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const insTag = db.prepare('INSERT INTO tags (name, slug) VALUES (?, ?)');
  const link = db.prepare('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)');
  for (const name of tagNames) {
    let row = findTag.get(name);
    if (!row) {
      let slug = slugify(name);
      if (db.prepare('SELECT 1 FROM tags WHERE slug = ?').get(slug)) slug = `${slug}-${Date.now().toString(36)}`;
      row = { id: insTag.run(name, slug).lastInsertRowid };
    }
    link.run(videoId, row.id);
  }
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM video_tags)').run();
}

function popularTags(limit = 60) {
  return db.prepare(`SELECT t.name, t.slug, COUNT(*) AS n FROM tags t
      JOIN video_tags vt ON vt.tag_id = t.id JOIN videos v ON v.id = vt.video_id AND v.status = 'approved'
      GROUP BY t.id ORDER BY n DESC, t.name LIMIT ?`).all(limit);
}

function related(video, limit = 12) {
  return db.prepare(`${BASE_SELECT} WHERE v.status = 'approved' AND v.id != ?
      ORDER BY (SELECT COUNT(*) FROM video_tags a JOIN video_tags b ON a.tag_id = b.tag_id WHERE a.video_id = v.id AND b.video_id = ?) DESC,
               (v.category_id IS ?) DESC, v.views DESC LIMIT ?`).all(video.id, video.id, video.category_id, limit);
}

function formatDuration(s) {
  s = Number(s) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function formatViews(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

module.exports = { listVideos, getVideo, tagsFor, parseTags, setTags, popularTags, related, formatDuration, formatViews, SORTS, PAGE_SIZE };
