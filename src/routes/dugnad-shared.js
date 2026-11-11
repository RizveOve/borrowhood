// Helpers shared by the Dugnad route files.
const { db } = require('../db');
const { flash } = require('../auth');
const dn = require('../dugnad');
const { isISODate } = require('../util');

// Loads the event for :id. People who may not see it get the same 404 as for an event that doesn't exist.
function withEvent(req, res, next) {
  const ev = dn.getEvent(req.params.id);
  if (!ev || !dn.canView(req.user, ev)) {
    return res.status(404).render('error', { title: req.t('err.not_found'), message: req.t('dugnad.not_found') });
  }
  req.ev = ev;
  req.isManager = dn.canManage(req.user, ev);
  next();
}

// Only the organiser (or an admin) may continue. Checked on the server for every management action.
function managerOnly(req, res, next) {
  if (!req.isManager) return res.status(403).render('error', { title: req.t('err.forbidden'), message: req.t('dugnad.err_forbidden') });
  next();
}

// Management actions are for events that are still going: not once completed or cancelled.
function editable(req, res, next) {
  if (['completed', 'cancelled'].includes(req.ev.status)) {
    flash(req, 'error', req.t(req.ev.status === 'completed' ? 'dugnad.err_completed' : 'dugnad.err_cancelled'));
    return res.redirect(`/dugnad/${req.ev.id}`);
  }
  next();
}

// Where to go after an action: the page it was started from (only known places, never a free-form URL).
function backTo(req, res, fallback) {
  const id = req.ev.id;
  const places = {
    edit4: `/dugnad/${id}/edit/4`, edit5: `/dugnad/${id}/edit/5`, edit6: `/dugnad/${id}/edit/6`,
    manage: `/dugnad/${id}/manage`, event: `/dugnad/${id}`,
  };
  const key = String((req.body && req.body.next) || req.query.next || '');
  const [place, anchor] = key.split('#');
  const base = places[place] || fallback || `/dugnad/${id}`;
  res.redirect(anchor && /^[\w-]+$/.test(anchor) ? `${base}#${anchor}` : base);
}

// Flash an error (a translation key) and go back.
function fail(req, res, key, fallback, vars) {
  flash(req, 'error', req.t(key, vars));
  backTo(req, res, fallback);
}

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v, min, max) => (/^\d{1,6}$/.test(String(v ?? '').trim()) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
const dateOrNull = (v) => (isISODate(String(v || '')) ? String(v) : null);
const timeOrNull = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : null);
const urlOrNull = (v) => (/^https?:\/\/[^\s<>"]{3,300}$/i.test(String(v || '').trim()) ? String(v).trim() : null);
const bool = (v) => (v === '1' || v === 'on' || v === 'true' ? 1 : 0);

const hoodMembers = (hoodId, exceptId) => (hoodId == null ? [] : db.prepare(
  'SELECT id, name, flat FROM users WHERE neighbourhood_id = ? AND id <> ? AND role = \'user\' ORDER BY name').all(hoodId, exceptId));

module.exports = { withEvent, managerOnly, editable, backTo, fail, text, int, dateOrNull, timeOrNull, urlOrNull, bool, hoodMembers };
