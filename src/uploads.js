'use strict';
// Multer config: every upload is written with a random name into the
// quarantine folder. Nothing in quarantine is ever served.
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');
const config = require('./config');
const { csrfCheck } = require('./middleware');
const privateDocs = require('./privateDocs');

fs.mkdirSync(config.quarantineDir, { recursive: true });

const storage = multer.diskStorage({
  destination: config.quarantineDir,
  filename: (req, file, cb) => cb(null, 'upload-' + crypto.randomBytes(16).toString('hex')),
});

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpg|mpeg|3gp|ts)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;
const DOC_FIELDS = ['releases', 'id_front', 'id_back', 'selfie'];

function fileFilter(req, file, cb) {
  if (file.fieldname === 'video') {
    return cb(null, file.mimetype.startsWith('video/') || VIDEO_EXT.test(file.originalname));
  }
  if (file.fieldname === 'thumbnail' || file.fieldname === 'image') {
    return cb(null, file.mimetype.startsWith('image/') || IMAGE_EXT.test(file.originalname));
  }
  if (DOC_FIELDS.includes(file.fieldname)) {
    if (privateDocs.isAllowed(file)) return cb(null, true);
    return cb(new Error(`"${file.originalname}" must be a photo (JPG, PNG, WEBP, HEIC) or a PDF.`));
  }
  cb(null, false);
}

const upload = multer({ storage, fileFilter, limits: { fileSize: config.maxUploadBytes, files: 13, fields: 40 } });

function allFiles(req) {
  if (req.file) return [req.file];
  if (!req.files) return [];
  return Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
}

function discard(req) {
  for (const f of allFiles(req)) fs.rm(f.path, { force: true }, () => {});
}

// Runs multer, then the CSRF check (multipart bodies can only be checked after
// parsing). Files from any failed request (bad CSRF, validation error) are
// deleted as soon as the response is sent.
function receive(middleware) {
  return [
    discardOnFinish,
    (req, res, next) => middleware(req, res, (err) => {
      if (!err) return next();
      discard(req);
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${Math.round(config.maxUploadBytes / 1048576)} MB).` : err.message;
      if (req.xhr || (req.get('accept') || '').includes('application/json')) return res.status(400).json({ error: msg });
      res.status(400).render('error', { title: 'Upload failed', message: msg });
    }),
    csrfCheck,
  ];
}

function discardOnFinish(req, res, next) {
  res.on('finish', () => { if (res.statusCode >= 400) discard(req); });
  next();
}

module.exports = { upload, receive, discard };
