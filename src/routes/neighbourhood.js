const router = require('express').Router();
const { db } = require('../db');
const { requireAuth, flash } = require('../auth');
const { joinCode, HOOD_KINDS } = require('../util');

router.get('/neighbourhood', requireAuth, (req, res) => {
  const hood = req.user.neighbourhood_id
    ? db.prepare(`SELECT n.*,
        (SELECT COUNT(*) FROM users WHERE neighbourhood_id = n.id) AS members,
        (SELECT COUNT(*) FROM items i JOIN users u ON u.id = i.owner_id WHERE u.neighbourhood_id = n.id) AS items
       FROM neighbourhoods n WHERE n.id = ?`).get(req.user.neighbourhood_id)
    : null;
  res.render('neighbourhood', { title: req.t('hood.title'), hood, code: req.query.code || '', error: null });
});

router.post('/neighbourhood/join', requireAuth, (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  const hood = db.prepare('SELECT * FROM neighbourhoods WHERE join_code = ?').get(code);
  if (!hood) {
    return res.status(400).render('neighbourhood', { title: req.t('hood.title'), hood: null, code, error: req.t('hood.err_code') });
  }
  db.prepare('UPDATE users SET neighbourhood_id = ? WHERE id = ?').run(hood.id, req.user.id);
  flash(req, 'ok', req.t('hood.welcome', { name: hood.name }));
  res.redirect('/items');
});

router.post('/neighbourhood/create', requireAuth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const city = String(b.city || '').trim().slice(0, 60);
  const kind = HOOD_KINDS[b.kind] ? b.kind : 'apartment';
  if (!name) {
    return res.status(400).render('neighbourhood', { title: req.t('hood.title'), hood: null, code: '', error: req.t('hood.err_name') });
  }
  let code;
  do code = joinCode(); while (db.prepare('SELECT 1 FROM neighbourhoods WHERE join_code = ?').get(code));
  const r = db.prepare('INSERT INTO neighbourhoods (name, kind, city, join_code, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, city || null, code, req.user.id);
  db.prepare('UPDATE users SET neighbourhood_id = ? WHERE id = ?').run(Number(r.lastInsertRowid), req.user.id);
  flash(req, 'ok', req.t('hood.created', { name, code }));
  res.redirect('/neighbourhood');
});

router.post('/neighbourhood/leave', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET neighbourhood_id = NULL WHERE id = ?').run(req.user.id);
  flash(req, 'ok', req.t('hood.left'));
  res.redirect('/neighbourhood');
});

module.exports = router;
