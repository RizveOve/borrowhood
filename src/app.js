const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
// The Express app, shared by the normal server (src/server.js) and the Netlify function.
const { ensureAdmin } = require('./db');
const { seedOrgItems, attachSeedPhotos, seedDemo } = require('./seed');
const { loadUser } = require('./auth');
const { ROOT } = require('./paths');
const util = require('./util');

const app = express();
app.engine('ejs', require('ejs').__express); // explicit, so bundlers (Netlify) include ejs
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

Object.assign(app.locals, {
  fmtDate: util.fmtDate, catEmoji: util.catEmoji, catLabel: util.catLabel,
  CATEGORIES: util.CATEGORIES, HOOD_KINDS: util.HOOD_KINDS, STATE_LABEL: util.STATE_LABEL,
  loanState: util.loanState, photoStep: util.photoStep, today: util.today,
  navTabs, asset, dn: require('./dugnad'),
});

// Versioned URLs for CSS/JS so browsers pick up changes immediately (they are cached for a day).
const assetVersions = {};
function asset(file) {
  const full = path.join(ROOT, 'public', file);
  try {
    const mtime = fs.statSync(full).mtimeMs;
    if (!assetVersions[file] || assetVersions[file].mtime !== mtime) {
      assetVersions[file] = { mtime, v: crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex').slice(0, 8) };
    }
    return `/${file}?v=${assetVersions[file].v}`;
  } catch {
    return '/' + file;
  }
}

// Main navigation, shared by the desktop header and the mobile tab bar.
// The profile is reached through the avatar in the header, so it isn't a tab.
function navTabs(user, counts, t) {
  const tabs = [
    { href: '/items', label: t('nav.browse'), match: (p) => p === '/items' || /^\/items\/\d+/.test(p), icon: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>' },
    { href: '/items/new', label: t('nav.lend'), match: (p) => p === '/items/new', icon: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>' },
    { href: '/loans', label: t('nav.loans'), match: (p) => p.startsWith('/loans'), badge: counts.pending, icon: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>' },
    { href: '/messages', label: t('nav.messages'), match: (p) => p.startsWith('/messages'), badge: counts.inbox, icon: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>' },
    { href: '/about', label: t('nav.about'), match: (p) => p.startsWith('/about'), icon: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>' },
    { href: '/dugnad', label: t('nav.dugnad'), match: (p) => p.startsWith('/dugnad'), icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>' },
  ];
  if (user.role === 'admin') tabs.push({ href: '/admin', label: t('nav.admin'), match: (p) => p.startsWith('/admin'), badge: counts.contact, icon: '<path d="M6 20V14M12 20V4M18 20v-9"/>' });
  return tabs;
}

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1d' }));
app.use('/stock', express.static(path.join(ROOT, 'seed', 'photos'), { maxAge: '7d' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(cookieSession({
  name: 'bh',
  keys: [process.env.SESSION_SECRET || 'dev-only-secret'],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === '1',
}));
app.use(loadUser);

app.use(require('./routes/auth'));
app.use(require('./routes/neighbourhood'));
app.use(require('./routes/items'));
app.use(require('./routes/loans'));
app.use(require('./routes/account'));
app.use(require('./routes/contact'));
app.use(require('./routes/dugnad'));
app.use(require('./routes/dugnad-work'));
app.use(require('./routes/messages'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: req.t('err.not_found'), message: req.t('err.not_found_text') }));
app.use((err, req, res, next) => {
  console.error(err);
  const t = req.t || ((k) => k);
  res.status(500).render('error', { title: t('err.server'), message: t('err.server_text') });
});

// First-run setup: master admin, BorrowHood shelf items, stock photos and (optionally) demo data.
async function init() {
  ensureAdmin();
  await seedOrgItems();
  if (process.env.SEED_DEMO === '1') await seedDemo();
  await attachSeedPhotos();
}

module.exports = { app, init };
