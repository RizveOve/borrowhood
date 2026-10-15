const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { isEmail } = require('../util');
const { LANGS } = require('../i18n');

const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : null);

router.get('/', (req, res) => (req.user ? res.redirect('/items') : res.render('landing', { wide: true })));

// Shareable invite link: /join/ABC123
router.get('/join/:code', (req, res) => {
  const code = encodeURIComponent(req.params.code.toUpperCase());
  res.redirect(req.user ? `/neighbourhood?code=${code}` : `/signup?code=${code}`);
});

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/items');
  res.render('signup', { title: req.t('auth.signup'), values: { code: req.query.code || '' }, error: null });
});

router.post('/signup', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const code = String(b.code || '').trim().toUpperCase();

  let error = null;
  if (!name || name.length > 60) error = 'err.name';
  else if (!isEmail(email)) error = 'err.email';
  else if (password.length < 8) error = 'err.password_short';
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) error = 'err.email_taken';
  if (error) return res.status(400).render('signup', { title: req.t('auth.signup'), values: { name, email, code }, error: req.t(error) });

  const r = db.prepare('INSERT INTO users (email, name, password_hash, lang) VALUES (?, ?, ?, ?)')
    .run(email, name, bcrypt.hashSync(password, 10), req.lang);
  req.session.userId = Number(r.lastInsertRowid);
  res.redirect('/neighbourhood' + (code ? '?code=' + encodeURIComponent(code) : ''));
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/items');
  res.render('login', { title: req.t('auth.login'), values: { next: req.query.next || '' }, error: null });
});

router.post('/login', (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(b.password || ''), user.password_hash)) {
    return res.status(401).render('login', { title: req.t('auth.login'), values: { email, next: b.next }, error: req.t('err.login') });
  }
  req.session.userId = user.id;
  res.redirect(safeNext(b.next) || (user.role === 'admin' ? '/admin' : '/items'));
});

router.post('/logout', (req, res) => {
  const lang = req.lang;
  req.session = { lang };
  res.redirect('/');
});

// Language switch: remembered on the account when logged in, and in the session cookie otherwise.
router.get('/lang', (req, res) => {
  const lang = LANGS.includes(req.query.l) ? req.query.l : 'en';
  req.session.lang = lang;
  if (req.user) db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, req.user.id);
  res.redirect(safeNext(req.query.next) || '/');
});

module.exports = router;
