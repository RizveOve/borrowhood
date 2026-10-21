const crypto = require('crypto');

const TZ = process.env.APP_TZ || 'Europe/Oslo';

// Dates are stored as plain YYYY-MM-DD strings in the app's time zone.
function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}

function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function fmtDate(iso, lang = 'en') {
  if (!iso) return '';
  // Norwegian short months end with "." ("26. okt."), which doubles up at the end of a sentence.
  return new Date(iso.slice(0, 10) + 'T00:00:00Z').toLocaleDateString(lang === 'nb' ? 'nb-NO' : 'en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  }).replace(/\.$/, '');
}

// Timestamps from SQLite's datetime('now') are UTC ("2026-10-20 18:57:03"); show them in local time.
function fmtDateTime(ts, lang = 'en') {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  const locale = lang === 'nb' ? 'nb-NO' : 'en-GB';
  const date = d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: TZ }).replace(/\.$/, '');
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  return `${date} ${time}`;
}

const CATEGORIES = [
  { key: 'tools', label: 'Tools', emoji: '🛠️' },
  { key: 'garden', label: 'Garden', emoji: '🌱' },
  { key: 'outdoor', label: 'Outdoor', emoji: '⛺' },
  { key: 'sports', label: 'Sports', emoji: '🚲' },
  { key: 'kitchen', label: 'Kitchen', emoji: '🍳' },
  { key: 'cleaning', label: 'Cleaning', emoji: '🧽' },
  { key: 'party', label: 'Party', emoji: '🎉' },
  { key: 'kids', label: 'Kids', emoji: '🧸' },
  { key: 'electronics', label: 'Electronics', emoji: '🔌' },
  { key: 'other', label: 'Other', emoji: '📦' },
];
const CAT_KEYS = CATEGORIES.map((c) => c.key);
const catEmoji = (k) => (CATEGORIES.find((c) => c.key === k) || CATEGORIES.at(-1)).emoji;
const catLabel = (k) => (CATEGORIES.find((c) => c.key === k) || CATEGORIES.at(-1)).label;

const HOOD_KINDS = {
  apartment: 'Apartment building',
  borettslag: 'Housing cooperative (borettslag)',
  student: 'Student housing',
};

function joinCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return s;
}

function isEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

// Derived state shown to people: an approved loan becomes "active" or "overdue" over time.
function loanState(l, t = today()) {
  if (l.status !== 'approved') return l.status;
  if (l.handed_back_at) return 'handed_back';
  if (l.end_date < t) return 'overdue';
  if (l.start_date <= t) return 'active';
  return 'approved';
}

// The borrower's next step that needs photos, or null. Pickup can be confirmed from the start
// date; hand-back only after pickup. Each step happens once, so its photos show the condition
// at that moment and can't be replaced later.
function photoStep(l, t = today()) {
  if (l.status !== 'approved') return null;
  if (!l.picked_up_at) return l.start_date <= t ? 'pickup' : null;
  if (!l.handed_back_at) return 'return';
  return null;
}

const STATE_LABEL = {
  pending: 'Pending', approved: 'Approved', active: 'On loan', overdue: 'Overdue', handed_back: 'Handed back',
  declined: 'Declined', cancelled: 'Cancelled', returned: 'Returned',
};

module.exports = {
  TZ, today, addDays, daysBetween, isISODate, fmtDate, fmtDateTime,
  CATEGORIES, CAT_KEYS, catEmoji, catLabel, HOOD_KINDS,
  joinCode, isEmail, loanState, photoStep, STATE_LABEL,
};
