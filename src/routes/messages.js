// Private messages between people interested in an item and its owner.
// A conversation belongs to one item and one "asker"; the other side is the item's owner
// (for BorrowHood shelf items that is the admin).
const router = require('express').Router();
const { db } = require('../db');
const { requireAuth, flash } = require('../auth');
const { getItem } = require('../items');
const { notify } = require('../notify');
const { fmtDateTime } = require('../util');

const MAX_LEN = 2000;

const convSelect = `SELECT c.*, i.title AS item_title, i.category, i.photo_key, i.is_org,
    o.name AS owner_name, a.name AS asker_name
  FROM conversations c
  LEFT JOIN items i ON i.id = c.item_id
  JOIN users o ON o.id = c.owner_id
  JOIN users a ON a.id = c.asker_id`;

// The chat page talks to these routes with fetch() and asks for JSON instead of HTML.
const wantsJson = (req) => (req.get('Accept') || '').includes('application/json');

function loadConversation(req, res) {
  const c = db.prepare(`${convSelect} WHERE c.id = ?`).get(Number(req.params.id) || 0);
  if (!c || (c.owner_id !== req.user.id && c.asker_id !== req.user.id)) {
    if (wantsJson(req)) res.status(404).json({ error: 'not_found' });
    else res.status(404).render('error', { title: req.t('err.not_found'), message: req.t('err.not_found_text') });
    return null;
  }
  return c;
}

const unreadQuery = db.prepare(`SELECT COUNT(*) AS c FROM messages m JOIN conversations c ON c.id = m.conversation_id
  WHERE (c.owner_id = ? OR c.asker_id = ?) AND m.sender_id <> ? AND m.read_at IS NULL`);
const unreadFor = (userId) => unreadQuery.get(userId, userId, userId).c;

const markRead = (convId, userId) => db.prepare(`UPDATE messages SET read_at = datetime('now')
  WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL`).run(convId, userId);

const toJson = (m, req) => ({ id: m.id, mine: m.sender_id === req.user.id, body: m.body, time: fmtDateTime(m.created_at, req.lang) });

function findOrCreate(itemId, ownerId, askerId) {
  const existing = db.prepare('SELECT id FROM conversations WHERE item_id = ? AND asker_id = ?').get(itemId, askerId);
  if (existing) return existing.id;
  return Number(db.prepare('INSERT INTO conversations (item_id, owner_id, asker_id) VALUES (?, ?, ?)')
    .run(itemId, ownerId, askerId).lastInsertRowid);
}

function send(req, conv, body) {
  const id = Number(db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)')
    .run(conv.id, req.user.id, body).lastInsertRowid);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conv.id);
  const to = conv.owner_id === req.user.id ? conv.asker_id : conv.owner_id;
  const preview = body.length > 140 ? body.slice(0, 140).trimEnd() + '…' : body;
  const title = conv.item_title || '';
  // Unread messages show on the Messages tab; email only (no bell notification) to avoid doubles.
  notify(to, (x) => x.t('msg.n_new', { name: req.user.name, title, preview }), `/messages/${conv.id}`,
    { email: true, inApp: false, subject: (x) => x.t('msg.mail_new', { name: req.user.name, title }) });
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

const readBody = (req) => String((req.body || {}).body || '').trim().slice(0, MAX_LEN);

// Inbox: every conversation with at least one message, newest first.
router.get('/messages', requireAuth, (req, res) => {
  const me = req.user.id;
  const conversations = db.prepare(`${convSelect.replace('SELECT c.*,', `SELECT c.*,
      (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT sender_id FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> ${me} AND m.read_at IS NULL) AS unread,`)}
    WHERE (c.owner_id = ? OR c.asker_id = ?) AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
    ORDER BY c.updated_at DESC, c.id DESC`).all(me, me);
  res.render('messages', { title: req.t('msg.title'), conversations });
});

// Polled by every page (about every 20 s) to keep the Messages badge up to date.
router.get('/messages/unread-count', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ unread: unreadFor(req.user.id) });
});

router.get('/messages/:id', requireAuth, (req, res) => {
  const conv = loadConversation(req, res);
  if (!conv) return;
  markRead(conv.id, req.user.id);
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
  res.locals.unreadMessages = unreadFor(req.user.id);
  const other = conv.owner_id === req.user.id
    ? { id: conv.asker_id, name: conv.asker_name }
    : { id: conv.owner_id, name: conv.is_org ? 'BorrowHood' : conv.owner_name };
  res.render('conversation', { title: other.name, conv, messages, other, wide: false });
});

// Polled by an open chat (every few seconds): messages newer than ?after=<last id>.
// Only writes to the database when there is something new to mark as read.
router.get('/messages/:id/updates', requireAuth, (req, res) => {
  const conv = loadConversation(req, res);
  if (!conv) return;
  const after = Number(req.query.after) || 0;
  const fresh = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id').all(conv.id, after);
  if (fresh.some((m) => m.sender_id !== req.user.id && !m.read_at)) markRead(conv.id, req.user.id);
  res.set('Cache-Control', 'no-store').json({ messages: fresh.map((m) => toJson(m, req)), unread: unreadFor(req.user.id) });
});

router.post('/messages/:id', requireAuth, (req, res) => {
  const conv = loadConversation(req, res);
  if (!conv) return;
  const body = readBody(req);
  const message = body ? send(req, conv, body) : null;
  if (wantsJson(req)) return message ? res.json({ message: toJson(message, req) }) : res.status(400).json({ error: 'empty' });
  res.redirect(`/messages/${conv.id}#latest`);
});

// "Ask the owner" from an item page: starts (or continues) the conversation about that item.
router.post('/items/:id/ask', requireAuth, (req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.sendStatus(404);
  if (item.owner_id === req.user.id) return res.redirect(`/items/${item.id}`);
  const body = readBody(req);
  if (!body) {
    flash(req, 'error', req.t('msg.err_empty'));
    return res.redirect(`/items/${item.id}#ask`);
  }
  const id = findOrCreate(item.id, item.owner_id, req.user.id);
  send(req, db.prepare(`${convSelect} WHERE c.id = ?`).get(id), body);
  res.redirect(`/messages/${id}#latest`);
});

// Open the conversation with someone about an item, e.g. from the loans page.
// Allowed for the item's owner (with anyone who requested it) and for anyone asking the owner.
router.get('/messages/with/:itemId/:userId', requireAuth, (req, res) => {
  const item = getItem(req.params.itemId);
  const other = Number(req.params.userId);
  if (!item || other === req.user.id) return res.sendStatus(404);
  let askerId;
  if (item.owner_id === req.user.id) {
    const related = db.prepare('SELECT 1 FROM loans WHERE item_id = ? AND borrower_id = ?').get(item.id, other)
      || db.prepare('SELECT 1 FROM conversations WHERE item_id = ? AND asker_id = ?').get(item.id, other);
    if (!related) return res.sendStatus(404);
    askerId = other;
  } else if (item.owner_id === other) {
    askerId = req.user.id;
  } else {
    return res.sendStatus(404);
  }
  res.redirect(`/messages/${findOrCreate(item.id, item.owner_id, askerId)}`);
});

module.exports = router;
