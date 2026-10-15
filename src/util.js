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
  if (l.end_date < t) return 'overdue';
  if (l.start_date <= t) return 'active';
  return 'approved';
}

const STATE_LABEL = {
  pending: 'Pending', approved: 'Approved', active: 'On loan', overdue: 'Overdue',
  declined: 'Declined', cancelled: 'Cancelled', returned: 'Returned',
};

module.exports = {
  TZ, today, addDays, daysBetween, isISODate, fmtDate,
  CATEGORIES, CAT_KEYS, catEmoji, catLabel, HOOD_KINDS,
  joinCode, isEmail, loanState, STATE_LABEL,
};
