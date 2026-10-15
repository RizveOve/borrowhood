const router = require('express').Router();
const { db, tx } = require('../db');
const { requireAuth, flash, isAdmin } = require('../auth');
const { getItem, canManage } = require('../items');
const { notify, managersOf } = require('../notify');
const { today, addDays, daysBetween, isISODate } = require('../util');

const MAX_DAYS = 30;

const overlapQuery = db.prepare(`SELECT 1 FROM loans
  WHERE item_id = ? AND id <> ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`);
const overlaps = (itemId, start, end, exceptId = 0) => !!overlapQuery.get(itemId, exceptId, end, start);

router.post('/items/:id/request', requireAuth, (req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.sendStatus(404);
  const b = req.body || {};
  const start = String(b.start_date || '');
  const end = String(b.end_date || '');
  const message = String(b.message || '').trim().slice(0, 500);
  const t = today();
  // Errors are passed back as translation keys and shown on the item page.
  const back = (key) => res.redirect(`/items/${item.id}?error=${key}#request`);

  if (item.owner_id === req.user.id) return back('err.own_item');
  if (!isISODate(start) || !isISODate(end)) return back('err.dates');
  if (start < t) return back('err.past');
  if (end < start) return back('err.order');
  if (daysBetween(start, end) > MAX_DAYS) return back('err.max_days');
  if (overlaps(item.id, start, end)) return back('err.booked');
  if (db.prepare("SELECT 1 FROM loans WHERE item_id = ? AND borrower_id = ? AND status = 'pending'").get(item.id, req.user.id)) {
    return back('err.dup');
  }

  db.prepare('INSERT INTO loans (item_id, borrower_id, start_date, end_date, message) VALUES (?, ?, ?, ?, ?)')
    .run(item.id, req.user.id, start, end, message || null);
  for (const m of managersOf(item)) {
    notify(m, (x) => x.t('n.request', { name: req.user.name, title: item.title, from: x.d(start), to: x.d(end) }),
      '/loans?tab=lending', { email: true, subject: (x) => x.t('mail.request', { title: item.title }) });
  }
  flash(req, 'ok', req.t('flash.requested'));
  res.redirect('/loans?tab=borrowing');
});

const loanSelect = `SELECT l.*, i.title, i.category, i.photo_key, i.is_org, i.owner_id, i.location,
  b.name AS borrower_name, b.flat AS borrower_flat, b.email AS borrower_email,
  o.name AS owner_name, o.flat AS owner_flat, o.email AS owner_email
  FROM loans l JOIN items i ON i.id = l.item_id
  JOIN users b ON b.id = l.borrower_id JOIN users o ON o.id = i.owner_id`;
const order = `ORDER BY CASE l.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
  CASE WHEN l.status IN ('pending', 'approved') THEN l.start_date END ASC, l.created_at DESC LIMIT 100`;

router.get('/loans', requireAuth, (req, res) => {
  const lending = db.prepare(`${loanSelect} WHERE (i.owner_id = ? OR (i.is_org = 1 AND ? = 1)) ${order}`)
    .all(req.user.id, isAdmin(req.user) ? 1 : 0);
  const borrowing = db.prepare(`${loanSelect} WHERE l.borrower_id = ? ${order}`).all(req.user.id);
  let tab = req.query.tab;
  if (tab !== 'lending' && tab !== 'borrowing') {
    tab = lending.some((l) => l.status === 'pending') ? 'lending' : 'borrowing';
  }
  res.render('loans', { title: req.t('loans.title'), tab, lending, borrowing });
});

function loadLoan(req, res) {
  const loan = db.prepare(`${loanSelect} WHERE l.id = ?`).get(Number(req.params.id) || 0);
  if (!loan) res.sendStatus(404);
  return loan;
}

// Go back to the page the action came from (same site only), e.g. the item page or the loans list.
const back = (req, res, fallback) => {
  let target = fallback;
  try {
    const ref = new URL(req.get('Referer'));
    if (ref.host === (req.get('X-Forwarded-Host') || req.get('Host'))) target = ref.pathname + ref.search;
  } catch { /* no or invalid referer */ }
  res.redirect(target);
};

router.post('/loans/:id/approve', requireAuth, (req, res) => {
  const loan = loadLoan(req, res);
  if (!loan) return;
  if (!canManage(req.user, loan)) return res.sendStatus(403);
  if (loan.status !== 'pending') return back(req, res, '/loans?tab=lending');
  if (loan.end_date < today()) {
    flash(req, 'error', req.t('flash.past_dates'));
    return back(req, res, '/loans?tab=lending');
  }
  if (overlaps(loan.item_id, loan.start_date, loan.end_date, loan.id)) {
    flash(req, 'error', req.t('flash.clash'));
    return back(req, res, '/loans?tab=lending');
  }

  const clashing = db.prepare(`SELECT id, borrower_id FROM loans
    WHERE item_id = ? AND id <> ? AND status = 'pending' AND start_date <= ? AND end_date >= ?`)
    .all(loan.item_id, loan.id, loan.end_date, loan.start_date);
  tx(() => {
    db.prepare("UPDATE loans SET status = 'approved', decided_at = datetime('now') WHERE id = ?").run(loan.id);
    for (const c of clashing) db.prepare("UPDATE loans SET status = 'declined', decided_at = datetime('now') WHERE id = ?").run(c.id);
  });

  notify(loan.borrower_id, (x) => x.t('n.approved', { title: loan.title, from: x.d(loan.start_date), to: x.d(loan.end_date) }) + ' '
    + (loan.is_org ? x.t('n.pickup_org', { location: loan.location })
      : x.t('n.pickup', { owner: loan.owner_name, email: loan.owner_email, location: loan.location })),
  '/loans?tab=borrowing', { email: true, subject: (x) => x.t('mail.approved', { title: loan.title }) });
  for (const c of clashing) {
    notify(c.borrower_id, (x) => x.t('n.taken', { title: loan.title }), `/items/${loan.item_id}`);
  }
  // Same-day or next-day loans: the reminder would otherwise arrive too late or not at all.
  if (loan.end_date <= addDays(today(), 1)) db.prepare('UPDATE loans SET reminder_sent = 1 WHERE id = ?').run(loan.id);
  flash(req, 'ok', req.t('flash.approved', { name: loan.borrower_name }));
  back(req, res, '/loans?tab=lending');
});

router.post('/loans/:id/decline', requireAuth, (req, res) => {
  const loan = loadLoan(req, res);
  if (!loan) return;
  if (!canManage(req.user, loan)) return res.sendStatus(403);
  if (loan.status !== 'pending' && !(loan.status === 'approved' && loan.start_date > today())) {
    return back(req, res, '/loans?tab=lending');
  }
  db.prepare("UPDATE loans SET status = 'declined', decided_at = datetime('now') WHERE id = ?").run(loan.id);
  notify(loan.borrower_id, (x) => x.t('n.declined', { title: loan.title, from: x.d(loan.start_date), to: x.d(loan.end_date) }),
    '/loans?tab=borrowing', { email: true, subject: (x) => x.t('mail.declined', { title: loan.title }) });
  flash(req, 'ok', req.t('flash.declined'));
  back(req, res, '/loans?tab=lending');
});

router.post('/loans/:id/cancel', requireAuth, (req, res) => {
  const loan = loadLoan(req, res);
  if (!loan) return;
  if (loan.borrower_id !== req.user.id) return res.sendStatus(403);
  if (loan.status !== 'pending' && !(loan.status === 'approved' && loan.start_date > today())) {
    flash(req, 'error', req.t('flash.started'));
    return back(req, res, '/loans?tab=borrowing');
  }
  db.prepare("UPDATE loans SET status = 'cancelled', decided_at = datetime('now') WHERE id = ?").run(loan.id);
  for (const m of managersOf(loan)) {
    notify(m, (x) => x.t('n.cancelled', { name: loan.borrower_name, title: loan.title, from: x.d(loan.start_date), to: x.d(loan.end_date) }), '/loans?tab=lending');
  }
  flash(req, 'ok', req.t('flash.cancelled'));
  back(req, res, '/loans?tab=borrowing');
});

router.post('/loans/:id/returned', requireAuth, (req, res) => {
  const loan = loadLoan(req, res);
  if (!loan) return;
  if (!canManage(req.user, loan)) return res.sendStatus(403);
  if (loan.status !== 'approved') return back(req, res, '/loans?tab=lending');
  db.prepare("UPDATE loans SET status = 'returned', returned_at = datetime('now') WHERE id = ?").run(loan.id);
  notify(loan.borrower_id, (x) => x.t('n.returned', { title: loan.title }), '/loans?tab=borrowing');
  flash(req, 'ok', req.t('flash.returned', { title: loan.title }));
  back(req, res, '/loans?tab=lending');
});

module.exports = router;
