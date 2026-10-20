// About us page with a contact form. Messages go to the admin dashboard.
const router = require('express').Router();
const { db } = require('../db');
const { flash } = require('../auth');
const { notify } = require('../notify');
const { isEmail } = require('../util');

const TOPICS = ['question', 'problem', 'report', 'feedback'];
const MAX_PER_HOUR = 5;

function render(req, res, values, error = null, status = 200) {
  const item = values.item_id
    ? db.prepare('SELECT id, title FROM items WHERE id = ?').get(Number(values.item_id) || 0)
    : null;
  res.status(status).render('about', { title: req.t('about.title'), values, item, TOPICS, error, wide: true });
}

router.get('/about', (req, res) => {
  const u = req.user;
  render(req, res, {
    name: u ? u.name : '',
    email: u ? u.email : '',
    topic: TOPICS.includes(req.query.topic) ? req.query.topic : 'question',
    item_id: /^\d+$/.test(req.query.item || '') ? req.query.item : '',
    message: '',
  });
});

router.post('/contact', (req, res) => {
  const b = req.body || {};
  const v = {
    name: String(b.name || '').trim().slice(0, 60),
    email: String(b.email || '').trim().toLowerCase().slice(0, 254),
    topic: TOPICS.includes(b.topic) ? b.topic : 'question',
    item_id: /^\d+$/.test(b.item_id || '') ? b.item_id : '',
    message: String(b.message || '').trim().slice(0, 2000),
  };

  // Hidden field that people never see but spam bots fill in: pretend it worked.
  if (b.website) {
    flash(req, 'ok', req.t('contact.sent'));
    return res.redirect('/about');
  }

  let error = null;
  if (!v.name) error = 'err.name';
  else if (!isEmail(v.email)) error = 'err.email';
  else if (v.message.length < 10) error = 'contact.err_short';
  else if (db.prepare("SELECT COUNT(*) AS c FROM contact_messages WHERE email = ? AND created_at > datetime('now', '-1 hour')").get(v.email).c >= MAX_PER_HOUR) {
    error = 'contact.err_limit';
  }
  if (error) return render(req, res, v, req.t(error), 400);

  const item = v.item_id ? db.prepare('SELECT id FROM items WHERE id = ?').get(Number(v.item_id)) : null;
  const r = db.prepare('INSERT INTO contact_messages (user_id, name, email, topic, message, item_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user ? req.user.id : null, v.name, v.email, v.topic, v.message, item ? item.id : null);

  for (const admin of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) {
    notify(admin.id, (x) => x.t('contact.n_new', { name: v.name, topic: x.t('topic.' + v.topic) }), `/admin#msg-${r.lastInsertRowid}`,
      { email: true, subject: (x) => x.t('contact.mail_new', { topic: x.t('topic.' + v.topic) }) });
  }
  flash(req, 'ok', req.t('contact.sent'));
  res.redirect('/about');
});

module.exports = router;
