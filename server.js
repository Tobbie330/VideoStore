'use strict';
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const config = require('./src/config');
const { db, seed } = require('./src/db');
const { SqliteStore, loadUser, csrfCheck, ageGate, regionBlock } = require('./src/middleware');
const { pickAd } = require('./src/ads');
const V = require('./src/videos');
const pipeline = require('./src/pipeline');

if (config.isProd && config.sessionSecret === 'dev-only-secret-change-me') {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

seed();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'RATING': 'RTA-5042-1996-1400-1577-RTA', // RTA label so parental filters can block the site
  });
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(session({
  store: new SqliteStore(),
  secret: config.sessionSecret,
  name: 'vs.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd && config.trustProxy > 0, maxAge: 30 * 24 * 3600 * 1000 },
}));
app.use(loadUser);
app.use(regionBlock);
app.use(csrfCheck);

app.locals.pickAd = pickAd;
app.locals.fmtDuration = V.formatDuration;
app.locals.fmtViews = V.formatViews;
app.locals.fmtMoney = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

// Partner ad clicks + images (outside the age gate so partners can verify them).
app.get('/ads/click/:id', (req, res) => {
  const ad = db.prepare('SELECT id, target_url FROM ads WHERE id = ?').get(Number(req.params.id));
  if (!ad || !ad.target_url) return res.redirect('/');
  db.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').run(ad.id);
  res.redirect(ad.target_url);
});
app.use('/ads/img', express.static(config.adDir, { maxAge: '7d', index: false }));

app.use(ageGate);
app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/billing').router);
app.use('/', require('./src/routes/creators'));
app.use('/', require('./src/routes/public'));
app.use('/studio', require('./src/routes/studio'));
app.use('/admin', require('./src/routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong.' });
});

if (require.main === module) {
  pipeline.start();
  app.listen(config.port, () => console.log(`VideoStore listening on :${config.port}`));
}

module.exports = app;
