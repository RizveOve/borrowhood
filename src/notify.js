const { db } = require('./db');
const { translator } = require('./i18n');
const { fmtDate } = require('./util');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

// Sends through Amazon SES when SES_FROM is set; otherwise prints to the console.
async function sendMail(to, subject, text) {
  if (!process.env.SES_FROM) {
    console.log(`[mail] to=${to} | ${subject}\n        ${text.replace(/\n/g, '\n        ')}`);
    return;
  }
  try {
    const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    const ses = new SESv2Client({});
    await ses.send(new SendEmailCommand({
      FromEmailAddress: process.env.SES_FROM,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
    }));
  } catch (e) {
    console.error('[mail] failed to send to', to, e.message);
  }
}

const insert = db.prepare('INSERT INTO notifications (user_id, body, link) VALUES (?, ?, ?)');
const recipient = db.prepare('SELECT email, lang FROM users WHERE id = ?');

// In-app notification (optionally also emailed), written in the recipient's language.
// `body` and `subject` are functions ({ t, d }) => string, where d formats a date.
// inApp: false skips the bell notification (e.g. chat messages, which have their own unread badge).
function notify(userId, body, link = null, { email = false, subject = null, inApp = true } = {}) {
  const u = recipient.get(userId);
  if (!u) return;
  const ctx = { t: translator(u.lang), d: (iso) => fmtDate(iso, u.lang) };
  const text = body(ctx);
  if (inApp) insert.run(userId, text, link);
  if (email) sendMail(u.email, subject ? subject(ctx) : 'BorrowHood', `${text}\n\n${APP_URL}${link || '/'}\n\n– BorrowHood`);
}

// Who decides on requests for an item: its owner, or every admin for organisation items.
function managersOf(item) {
  if (!item.is_org) return [item.owner_id];
  return db.prepare("SELECT id FROM users WHERE role = 'admin'").all().map((r) => r.id);
}

module.exports = { notify, managersOf, sendMail };
