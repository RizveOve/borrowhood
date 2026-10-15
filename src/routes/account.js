const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, flash } = require('../auth');

router.get('/me', requireAuth, (req, res) => {
  const items = db.prepare(`SELECT i.*,
      (SELECT COUNT(*) FROM loans l WHERE l.item_id = i.id AND l.status = 'returned') AS times_lent
    FROM items i WHERE i.owner_id = ? ORDER BY i.created_at DESC`).all(req.user.id);
  const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM loans l JOIN items i ON i.id = l.item_id WHERE i.owner_id = ? AND l.status = 'returned') AS lent,
      (SELECT COUNT(*) FROM loans WHERE borrower_id = ? AND status = 'returned') AS borrowed`).get(req.user.id, req.user.id);
  res.render('me', { title: req.t('nav.me'), items, stats });
});

router.post('/me', requireAuth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60);
  const flat = String(b.flat || '').trim().slice(0, 30);
  if (!name) {
    flash(req, 'error', req.t('flash.name_empty'));
    return res.redirect('/me');
  }
  db.prepare('UPDATE users SET name = ?, flat = ? WHERE id = ?').run(name, flat || null, req.user.id);
  flash(req, 'ok', req.t('flash.profile_saved'));
  res.redirect('/me');
});

router.post('/me/password', requireAuth, (req, res) => {
  const b = req.body || {};
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(b.current || ''), user.password_hash)) {
    flash(req, 'error', req.t('flash.pw_wrong'));
  } else if (String(b.password || '').length < 8) {
    flash(req, 'error', req.t('flash.pw_short'));
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), req.user.id);
    flash(req, 'ok', req.t('flash.pw_changed'));
  }
  res.redirect('/me');
});

router.get('/notifications', requireAuth, (req, res) => {
  const notes = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.user.id);
  res.locals.unread = 0;
  res.render('notifications', { title: req.t('notes.title'), notes });
});

module.exports = router;
