const router = require('express').Router();
const { db } = require('../db');
const { requireAuth, requireAdmin, flash } = require('../auth');
const { runReminders } = require('../jobs');
const { today, joinCode } = require('../util');

router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  const t = today();
  const stats = db.prepare(`SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'user') AS users,
      (SELECT COUNT(*) FROM neighbourhoods) AS hoods,
      (SELECT COUNT(*) FROM items) AS items,
      (SELECT COUNT(*) FROM items WHERE is_org = 1) AS org_items,
      (SELECT COUNT(*) FROM loans WHERE status = 'pending') AS pending,
      (SELECT COUNT(*) FROM loans WHERE status = 'approved' AND start_date <= ? AND end_date >= ?) AS active,
      (SELECT COUNT(*) FROM loans WHERE status = 'approved' AND handed_back_at IS NULL AND end_date < ?) AS overdue,
      (SELECT COUNT(*) FROM loans WHERE status = 'returned') AS returned`).get(t, t, t);

  const loanSelect = `SELECT l.*, i.title, i.is_org, b.name AS borrower_name, b.email AS borrower_email, o.name AS owner_name
    FROM loans l JOIN items i ON i.id = l.item_id JOIN users b ON b.id = l.borrower_id JOIN users o ON o.id = i.owner_id`;
  const overdue = db.prepare(`${loanSelect} WHERE l.status = 'approved' AND l.handed_back_at IS NULL AND l.end_date < ? ORDER BY l.end_date`).all(t);
  const orgPending = db.prepare(`${loanSelect} WHERE l.status = 'pending' AND i.is_org = 1 ORDER BY l.start_date`).all();
  const loans = db.prepare(`${loanSelect} ORDER BY l.id DESC LIMIT 30`).all();

  const hoods = db.prepare(`SELECT n.*,
      (SELECT COUNT(*) FROM users WHERE neighbourhood_id = n.id) AS members,
      (SELECT COUNT(*) FROM items i JOIN users u ON u.id = i.owner_id WHERE u.neighbourhood_id = n.id) AS items
    FROM neighbourhoods n ORDER BY n.created_at DESC`).all();
  const users = db.prepare(`SELECT u.id, u.name, u.email, u.flat, u.role, u.created_at, n.name AS hood_name,
      (SELECT COUNT(*) FROM items WHERE owner_id = u.id) AS items
    FROM users u LEFT JOIN neighbourhoods n ON n.id = u.neighbourhood_id ORDER BY u.created_at DESC`).all();
  const items = db.prepare(`SELECT i.id, i.title, i.category, i.is_org, u.name AS owner_name, n.name AS hood_name
    FROM items i JOIN users u ON u.id = i.owner_id LEFT JOIN neighbourhoods n ON n.id = u.neighbourhood_id
    ORDER BY i.is_org DESC, i.created_at DESC`).all();

  const messages = db.prepare(`SELECT m.*, i.title AS item_title FROM contact_messages m
    LEFT JOIN items i ON i.id = m.item_id
    ORDER BY m.status = 'resolved', m.created_at DESC LIMIT 50`).all();

  res.render('admin', { title: req.t('nav.admin'), stats, overdue, orgPending, loans, hoods, users, items, messages, todayIso: t, wide: true });
});

router.post('/users/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u || u.role === 'admin') {
    flash(req, 'error', req.t('flash.admin_nodelete'));
  } else {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    flash(req, 'ok', req.t('flash.user_deleted', { email: u.email }));
  }
  res.redirect('/admin#users');
});

router.post('/neighbourhoods/:id/delete', (req, res) => {
  const n = db.prepare('SELECT * FROM neighbourhoods WHERE id = ?').get(Number(req.params.id));
  if (n) {
    db.prepare('DELETE FROM neighbourhoods WHERE id = ?').run(n.id);
    flash(req, 'ok', req.t('flash.hood_deleted', { name: n.name }));
  }
  res.redirect('/admin#hoods');
});

router.post('/neighbourhoods/:id/code', (req, res) => {
  let code;
  do code = joinCode(); while (db.prepare('SELECT 1 FROM neighbourhoods WHERE join_code = ?').get(code));
  db.prepare('UPDATE neighbourhoods SET join_code = ? WHERE id = ?').run(code, Number(req.params.id));
  flash(req, 'ok', req.t('flash.new_code', { code }));
  res.redirect('/admin#hoods');
});

router.post('/messages/:id/resolve', (req, res) => {
  db.prepare("UPDATE contact_messages SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(Number(req.params.id));
  res.redirect('/admin#messages');
});

router.post('/messages/:id/reopen', (req, res) => {
  db.prepare("UPDATE contact_messages SET status = 'open', resolved_at = NULL WHERE id = ?").run(Number(req.params.id));
  res.redirect('/admin#messages');
});

router.post('/reminders', (req, res) => {
  const r = runReminders();
  flash(req, 'ok', req.t('flash.job', { r: r.reminders, o: r.overdue }));
  res.redirect('/admin');
});

module.exports = router;
