// Creating a loan request. Used by the item page and by the Dugnad equipment planner, so both go
// through the same checks and the owner always decides in the normal loan workflow.
const { db } = require('./db');
const { notify, managersOf } = require('./notify');
const { today, daysBetween, isISODate } = require('./util');

const MAX_DAYS = 30;

const overlapQuery = db.prepare(`SELECT 1 FROM loans
  WHERE item_id = ? AND id <> ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`);
const overlaps = (itemId, start, end, exceptId = 0) => !!overlapQuery.get(itemId, exceptId, end, start);

// Validates and inserts a pending loan. Returns { loanId } or { error: <translation key> }.
function requestLoan(item, user, { start, end, message }) {
  const t = today();
  if (item.owner_id === user.id) return { error: 'err.own_item' };
  if (!isISODate(start) || !isISODate(end)) return { error: 'err.dates' };
  if (start < t) return { error: 'err.past' };
  if (end < start) return { error: 'err.order' };
  if (daysBetween(start, end) > MAX_DAYS) return { error: 'err.max_days' };
  if (overlaps(item.id, start, end)) return { error: 'err.booked' };
  if (db.prepare("SELECT 1 FROM loans WHERE item_id = ? AND borrower_id = ? AND status = 'pending'").get(item.id, user.id)) {
    return { error: 'err.dup' };
  }

  const r = db.prepare('INSERT INTO loans (item_id, borrower_id, start_date, end_date, message) VALUES (?, ?, ?, ?, ?)')
    .run(item.id, user.id, start, end, message || null);
  for (const m of managersOf(item)) {
    notify(m, (x) => x.t('n.request', { name: user.name, title: item.title, from: x.d(start), to: x.d(end) }),
      '/loans?tab=lending', { email: true, subject: (x) => x.t('mail.request', { title: item.title }) });
  }
  return { loanId: Number(r.lastInsertRowid) };
}

module.exports = { requestLoan, overlaps, MAX_DAYS };
