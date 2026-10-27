const { db } = require('./db');
const { notify, managersOf } = require('./notify');
const { today, addDays } = require('./util');
const { runReminders: runDugnadReminders } = require('./dugnad');

// Return reminder the day before the end date, and a one-time overdue alert.
function runReminders() {
  const t = today();
  const tomorrow = addDays(t, 1);
  const base = `SELECT l.id, l.borrower_id, l.end_date, i.id AS item_id, i.title, i.owner_id, i.is_org, b.name AS borrower_name
                FROM loans l JOIN items i ON i.id = l.item_id JOIN users b ON b.id = l.borrower_id
                WHERE l.status = 'approved' AND l.handed_back_at IS NULL`;

  const due = db.prepare(`${base} AND l.reminder_sent = 0 AND l.end_date = ?`).all(tomorrow);
  for (const l of due) {
    notify(l.borrower_id, (m) => m.t('n.reminder', { title: l.title, date: m.d(l.end_date) }), '/loans?tab=borrowing',
      { email: true, subject: (m) => m.t('mail.reminder', { title: l.title }) });
    db.prepare('UPDATE loans SET reminder_sent = 1 WHERE id = ?').run(l.id);
  }

  const overdue = db.prepare(`${base} AND l.overdue_sent = 0 AND l.end_date < ?`).all(t);
  for (const l of overdue) {
    const subject = (m) => m.t('mail.overdue', { title: l.title });
    notify(l.borrower_id, (m) => m.t('n.overdue', { title: l.title, date: m.d(l.end_date) }), '/loans?tab=borrowing', { email: true, subject });
    for (const id of managersOf(l)) {
      notify(id, (m) => m.t('n.overdue_owner', { name: l.borrower_name, title: l.title, date: m.d(l.end_date) }), '/loans?tab=lending', { email: true, subject });
    }
    db.prepare('UPDATE loans SET overdue_sent = 1, reminder_sent = 1 WHERE id = ?').run(l.id);
  }

  // Dugnad: a day before, a few hours before, and when a sign-up deadline is near.
  const dugnad = runDugnadReminders();

  if (due.length || overdue.length || dugnad) console.log(`[jobs] reminders=${due.length} overdue=${overdue.length} dugnad=${dugnad}`);
  return { reminders: due.length, overdue: overdue.length, dugnad };
}

function startJobs() {
  runReminders();
  setInterval(runReminders, 60 * 60 * 1000).unref();
}

module.exports = { runReminders, startJobs };
