const { db } = require('./db');
const { translator } = require('./i18n');
const { fmtDate } = require('./util');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

let ses;
let sns;

// Delivers one email: through Amazon SES when SES_FROM is set, otherwise prints it to the console.
// Throws on failure, so the mail worker (src/mailer.js) can retry it.
async function deliverMail(to, subject, text) {
  if (!process.env.SES_FROM) {
    console.log(`[mail] to=${to} | ${subject}\n        ${text.replace(/\n/g, '\n        ')}`);
    return;
  }
  const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
  ses ||= new SESv2Client({});
  await ses.send(new SendEmailCommand({
    FromEmailAddress: process.env.SES_FROM,
    Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
  }));
}

// On AWS (SNS_TOPIC_ARN set) emails are published to SNS, which queues them in SQS for the mail
// worker, so a slow or failing SES call never holds up a page and failed emails are retried.
// Elsewhere they are delivered straight away.
async function sendMail(to, subject, text) {
  try {
    if (!process.env.SNS_TOPIC_ARN) return await deliverMail(to, subject, text);
    const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
    sns ||= new SNSClient({});
    await sns.send(new PublishCommand({
      TopicArn: process.env.SNS_TOPIC_ARN,
      Message: JSON.stringify({ to, subject, text }),
      MessageAttributes: { type: { DataType: 'String', StringValue: 'email' } },
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

module.exports = { notify, managersOf, sendMail, deliverMail };
