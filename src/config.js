'use strict';
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const uploadDir = process.env.UPLOAD_DIR || path.join(root, 'uploads');

module.exports = {
  port: Number(process.env.PORT || 3000),
  isProd: process.env.NODE_ENV === 'production',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  dbPath: path.join(dataDir, 'videostore.db'),
  uploadDir,
  // Files land here first and are never served until scanned and stripped.
  quarantineDir: path.join(uploadDir, 'quarantine'),
  videoDir: path.join(uploadDir, 'videos'),
  thumbDir: path.join(uploadDir, 'thumbs'),
  adDir: path.join(uploadDir, 'ads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 4000) * 1024 * 1024,
  adminEmail: process.env.ADMIN_EMAIL || 'admin@example.com',
  adminPassword: process.env.ADMIN_PASSWORD || 'changeme123',
  clamav: {
    host: process.env.CLAMAV_HOST || '127.0.0.1',
    port: Number(process.env.CLAMAV_PORT || 3310),
    timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS || 10 * 60 * 1000),
  },
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  // Only "demo" exists today: premium is granted instantly with no charge.
  // A real processor (CCBill, Segpay, Verotel...) plugs into src/routes/billing.js.
  paymentMode: process.env.PAYMENT_MODE || 'demo',
  trustProxy: process.env.TRUST_PROXY === '1',
};
