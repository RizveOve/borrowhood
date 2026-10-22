// Dugnad: community work days that neighbours create and sign up for.
const router = require('express').Router();
const { db, tx } = require('../db');
const { requireAuth, requireHood, flash, isAdmin } = require('../auth');
const { today, isISODate } = require('../util');

const MIN_SPOTS = 2; // the host takes one
const MAX_SPOTS = 200;

// Upcoming dugnads in the user's neighbourhood (plus the admin's, which are for everyone), soonest first.
const upcoming = db.prepare(`
  SELECT d.*,
    (SELECT COUNT(*) FROM dugnad_signups s WHERE s.dugnad_id = d.id) AS registered,
    EXISTS (SELECT 1 FROM dugnad_signups s WHERE s.dugnad_id = d.id AND s.user_id = ?) AS joined
  FROM dugnads d
  WHERE d.event_date >= ? AND (? = 1 OR d.neighbourhood_id IS NULL OR d.neighbourhood_id = ?)
  ORDER BY d.event_date, d.event_time, d.id`);

const findOne = db.prepare(`
  SELECT d.*, (SELECT COUNT(*) FROM dugnad_signups s WHERE s.dugnad_id = d.id) AS registered
  FROM dugnads d WHERE d.id = ?`);

const canSee = (user, d) => isAdmin(user) || d.neighbourhood_id === null || d.neighbourhood_id === user.neighbourhood_id;

function render(req, res, values, error = null, status = 200) {
  const u = req.user;
  const events = u ? upcoming.all(u.id, today(), isAdmin(u) ? 1 : 0, u.neighbourhood_id || 0) : [];
  res.status(status).render('dugnad', { title: req.t('dugnad.title'), events, values, error, minDate: today(), MIN_SPOTS, MAX_SPOTS, wide: true });
}

router.get('/dugnad', (req, res) => {
  render(req, res, { title: '', date: '', time: '', host_name: req.user ? req.user.name : '', capacity: '10' });
});

router.post('/dugnad', requireAuth, requireHood, (req, res) => {
  const b = req.body || {};
  const v = {
    title: String(b.title || '').trim().slice(0, 80),
    date: String(b.date || ''),
    time: String(b.time || ''),
    host_name: String(b.host_name || '').trim().slice(0, 60),
    capacity: String(b.capacity || '').trim(),
  };
  const capacity = /^\d+$/.test(v.capacity) ? Number(v.capacity) : 0;

  let error = null;
  if (!v.title) error = 'dugnad.err_title';
  else if (!v.host_name) error = 'dugnad.err_host';
  else if (!isISODate(v.date) || v.date < today()) error = 'dugnad.err_date';
  else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) error = 'dugnad.err_time';
  else if (capacity < MIN_SPOTS || capacity > MAX_SPOTS) error = 'dugnad.err_spots';
  if (error) return render(req, res, v, req.t(error, { min: MIN_SPOTS, max: MAX_SPOTS }), 400);

  tx(() => {
    const r = db.prepare('INSERT INTO dugnads (neighbourhood_id, host_id, host_name, title, event_date, event_time, capacity) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.neighbourhood_id || null, req.user.id, v.host_name, v.title, v.date, v.time, capacity);
    db.prepare('INSERT INTO dugnad_signups (dugnad_id, user_id) VALUES (?, ?)').run(Number(r.lastInsertRowid), req.user.id);
  });
  flash(req, 'ok', req.t('dugnad.created'));
  res.redirect('/dugnad#list');
});

router.post('/dugnad/:id/join', requireAuth, (req, res) => {
  const d = findOne.get(Number(req.params.id) || 0);
  if (!d || !canSee(req.user, d)) return res.redirect('/dugnad');
  const joined = tx(() => {
    const fresh = findOne.get(d.id);
    if (fresh.registered >= fresh.capacity) return false;
    db.prepare('INSERT OR IGNORE INTO dugnad_signups (dugnad_id, user_id) VALUES (?, ?)').run(d.id, req.user.id);
    return true;
  });
  flash(req, joined ? 'ok' : 'error', req.t(joined ? 'dugnad.joined' : 'dugnad.full', { title: d.title }));
  res.redirect('/dugnad#list');
});

router.post('/dugnad/:id/leave', requireAuth, (req, res) => {
  const d = findOne.get(Number(req.params.id) || 0);
  // The host holds the first spot; they cancel the whole dugnad instead of leaving it.
  if (d && d.host_id !== req.user.id) {
    db.prepare('DELETE FROM dugnad_signups WHERE dugnad_id = ? AND user_id = ?').run(d.id, req.user.id);
    flash(req, 'ok', req.t('dugnad.left', { title: d.title }));
  }
  res.redirect('/dugnad#list');
});

router.post('/dugnad/:id/cancel', requireAuth, (req, res) => {
  const d = findOne.get(Number(req.params.id) || 0);
  if (d && (d.host_id === req.user.id || isAdmin(req.user))) {
    db.prepare('DELETE FROM dugnads WHERE id = ?').run(d.id);
    flash(req, 'ok', req.t('dugnad.cancelled', { title: d.title }));
  }
  res.redirect('/dugnad#list');
});

module.exports = router;
