'use strict';
// Partner ad slots. Admins add ads per partner in /admin/ads; views call
// pickAd(slot) and each slot rotates through active ads by weight.
const { db } = require('./db');

const SLOTS = {
  header: { label: 'Header banner', size: '728 × 90' },
  sidebar: { label: 'Sidebar box', size: '300 × 250' },
  in_feed: { label: 'In video grid', size: '300 × 250 (shown as a tile)' },
  below_player: { label: 'Below video player', size: '728 × 90' },
  footer: { label: 'Footer banner', size: '728 × 90' },
};

function pickAd(slot) {
  const ads = db.prepare(`SELECT * FROM ads WHERE slot = ? AND active = 1
      AND (starts_at IS NULL OR starts_at = '' OR starts_at <= date('now'))
      AND (ends_at IS NULL OR ends_at = '' OR ends_at >= date('now'))`).all(slot);
  if (!ads.length) return null;
  const total = ads.reduce((s, a) => s + Math.max(1, a.weight), 0);
  let r = Math.random() * total;
  let chosen = ads[0];
  for (const a of ads) {
    r -= Math.max(1, a.weight);
    if (r <= 0) { chosen = a; break; }
  }
  db.prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ?').run(chosen.id);
  return chosen;
}

module.exports = { SLOTS, pickAd };
