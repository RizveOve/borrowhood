const { db } = require('./db');
const { translator, pickLang } = require('./i18n');
const { fmtDate, fmtDateTime } = require('./util');

const userQuery = db.prepare(`
  SELECT u.*, n.name AS hood_name, n.join_code AS hood_code, n.kind AS hood_kind
  FROM users u LEFT JOIN neighbourhoods n ON n.id = u.neighbourhood_id
  WHERE u.id = ?`);
const unreadQuery = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0');
const openMessagesQuery = db.prepare("SELECT COUNT(*) AS c FROM contact_messages WHERE status = 'open'");
const unreadMessagesQuery = db.prepare(`SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE (c.owner_id = ? OR c.asker_id = ?) AND m.sender_id <> ? AND m.read_at IS NULL`);
const pendingQuery = db.prepare(`
  SELECT COUNT(*) AS c FROM loans l JOIN items i ON i.id = l.item_id
  WHERE l.status = 'pending' AND (i.owner_id = ? OR (i.is_org = 1 AND ? = 1))`);

function loadUser(req, res, next) {
  const id = req.session && req.session.userId;
  req.user = id ? userQuery.get(id) || null : null;
  if (id && !req.user) req.session = null;

  res.locals.user = req.user;
  res.locals.path = req.path;
  res.locals.url = req.originalUrl;
  const lang = pickLang(req);
  req.lang = lang;
  req.t = translator(lang);
  res.locals.lang = lang;
  res.locals.t = req.t;
  res.locals.fmtDate = (iso) => fmtDate(iso, lang);
  res.locals.fmtDateTime = (ts) => fmtDateTime(ts, lang);
  res.locals.flash = null;
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  res.locals.unread = 0;
  res.locals.pendingCount = 0;
  res.locals.openMessages = 0;
  res.locals.unreadMessages = 0;
  if (req.user) {
    const isAdmin = req.user.role === 'admin' ? 1 : 0;
    res.locals.unread = unreadQuery.get(req.user.id).c;
    res.locals.pendingCount = pendingQuery.get(req.user.id, isAdmin).c;
    if (isAdmin) res.locals.openMessages = openMessagesQuery.get().c;
    res.locals.unreadMessages = unreadMessagesQuery.get(req.user.id, req.user.id, req.user.id).c;
  }
  next();
}

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

// Regular users must belong to a neighbourhood; the admin sees everything.
function requireHood(req, res, next) {
  if (req.user.role !== 'admin' && !req.user.neighbourhood_id) return res.redirect('/neighbourhood');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).render('error', { title: req.t('err.forbidden'), message: req.t('err.admins_only') });
  next();
}

const isAdmin = (user) => user && user.role === 'admin';

module.exports = { loadUser, flash, requireAuth, requireHood, requireAdmin, isAdmin };
