const router = require('express').Router();
const { db, tx } = require('../db');
const { requireAuth, flash, isAdmin } = require('../auth');
const { getItem, canManage } = require('../items');
const { notify, managersOf } = require('../notify');
const { today, addDays, photoStep } = require('../util');
const { requestLoan, overlaps } = require('../loan-requests');
const { savePhoto, ALLOWED_TYPES } = require('../storage');
const multer = require('multer');

const MAX_LOAN_PHOTOS = 6; // per step (pickup / hand-back)

const loanPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: MAX_LOAN_PHOTOS }, // the browser shrinks photos first
  fileFilter: (req, file, cb) => cb(null, ALLOWED_TYPES.includes(file.mimetype)),
}).array('photos', MAX_LOAN_PHOTOS);

router.post('/items/:id/request', requireAuth, (req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.sendStatus(404);
  const b = req.body || {};
  const result = requestLoan(item, req.user, {
    start: String(b.start_date || ''),
    end: String(b.end_date || ''),
    message: String(b.message || '').trim().slice(0, 500),
  });
  // Errors are passed back as translation keys and shown on the item page.
  if (result.error) return res.redirect(`/items/${item.id}?error=${result.error}#request`);
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
  attachPhotos([...lending, ...borrowing]);
  attachIssues([...lending, ...borrowing]);
  attachDugnad([...lending, ...borrowing]);
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

// --- Pickup and return photos ---------------------------------------------------------------

const photosForLoans = db.prepare(`SELECT p.id, p.loan_id, p.kind, p.photo_key, p.created_at, u.name AS user_name
  FROM loan_photos p LEFT JOIN users u ON u.id = p.user_id
  WHERE p.loan_id IN (SELECT value FROM json_each(?)) ORDER BY p.created_at, p.id`);

// Adds `pickupPhotos` and `returnPhotos` to every loan in the list.
function attachPhotos(loans) {
  for (const l of loans) { l.pickupPhotos = []; l.returnPhotos = []; }
  if (!loans.length) return;
  const byId = new Map(loans.map((l) => [l.id, l]));
  for (const p of photosForLoans.all(JSON.stringify([...byId.keys()]))) {
    // The same loan can be in both lists (an admin borrowing a shelf item); fill each copy.
    for (const l of loans) if (l.id === p.loan_id) (p.kind === 'pickup' ? l.pickupPhotos : l.returnPhotos).push(p);
  }
}

// Loans requested for a dugnad say so, with a link to it. The loan itself is an ordinary loan.
const dugnadForLoans = db.prepare(`SELECT l.loan_id, e.id, e.title FROM dugnad_equipment_links l
  JOIN dugnad_equipment_requirements r ON r.id = l.requirement_id JOIN dugnad_events e ON e.id = r.event_id
  WHERE l.loan_id IN (SELECT value FROM json_each(?))`);

function attachDugnad(loans) {
  if (!loans.length) return;
  const found = new Map(dugnadForLoans.all(JSON.stringify([...new Set(loans.map((l) => l.id))])).map((r) => [r.loan_id, r]));
  for (const l of loans) l.dugnad = found.get(l.id) || null;
}

// The borrower confirms each handover with photos: when they get the item and when they give it back.
// The step is only offered at the right moment and only once, so the photos show the condition then.
const STEPS = {
  pickup: { column: 'picked_up_at', notice: 'n.picked_up', flash: 'flash.picked_up' },
  return: { column: 'handed_back_at', notice: 'n.handed_back', flash: 'flash.handed_back' },
};

function photoStepRoute(kind) {
  const step = STEPS[kind];
  return async (req, res) => {
    const loan = loadLoan(req, res);
    if (!loan) return;
    if (loan.borrower_id !== req.user.id) return res.sendStatus(403);
    const done = (type, key) => {
      flash(req, type, req.t(key, { n: MAX_LOAN_PHOTOS }));
      back(req, res, '/loans?tab=borrowing');
    };

    const err = await new Promise((resolve) => loanPhotoUpload(req, res, (e) => resolve(e)));
    if (photoStep(loan) !== kind) return done('error', 'flash.photo_not_now');
    if (err && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) return done('error', 'flash.photo_limit');
    if (err) return done('error', 'err.photo');
    if (!req.files || !req.files.length) return done('error', 'flash.photo_required');

    const keys = [];
    for (const f of req.files) keys.push(await savePhoto(f));
    tx(() => {
      for (const key of keys) {
        db.prepare('INSERT INTO loan_photos (loan_id, user_id, kind, photo_key) VALUES (?, ?, ?, ?)')
          .run(loan.id, req.user.id, kind, key);
      }
      db.prepare(`UPDATE loans SET ${step.column} = datetime('now') WHERE id = ?`).run(loan.id);
    });

    for (const id of managersOf(loan)) {
      if (id === req.user.id) continue;
      notify(id, (x) => x.t(step.notice, { name: req.user.name, title: loan.title, n: keys.length }), '/loans?tab=lending',
        { email: kind === 'return', subject: (x) => x.t('mail.handed_back', { title: loan.title }) });
    }
    done('ok', step.flash);
  };
}

router.post('/loans/:id/picked-up', requireAuth, photoStepRoute('pickup'));
router.post('/loans/:id/hand-back', requireAuth, photoStepRoute('return'));

// --- Reporting a problem when an item comes back -------------------------------------------

const MAX_ISSUE_LEN = 1000;

const issuesForLoans = db.prepare(`SELECT li.*, u.name AS reporter_name FROM loan_issues li
  LEFT JOIN users u ON u.id = li.reporter_id
  WHERE li.loan_id IN (SELECT value FROM json_each(?)) ORDER BY li.id`);
const issuePhotos = db.prepare(`SELECT p.* FROM loan_issue_photos p
  WHERE p.issue_id IN (SELECT value FROM json_each(?)) ORDER BY p.id`);

// Adds `issue` (with `photos`) to every loan that has a reported problem.
function attachIssues(loans) {
  for (const l of loans) l.issue = null;
  if (!loans.length) return;
  const issues = issuesForLoans.all(JSON.stringify([...new Set(loans.map((l) => l.id))]));
  if (!issues.length) return;
  const byIssue = new Map(issues.map((i) => [i.id, { ...i, photos: [] }]));
  for (const p of issuePhotos.all(JSON.stringify([...byIssue.keys()]))) byIssue.get(p.issue_id).photos.push(p);
  for (const issue of byIssue.values()) for (const l of loans) if (l.id === issue.loan_id) l.issue = issue;
}

// Instead of "Mark returned": the item is back, but something is wrong with it.
// The loan ends, the problem goes into the owner–borrower chat, and admins see it on the dashboard.
router.post('/loans/:id/problem', requireAuth, async (req, res) => {
  const loan = loadLoan(req, res);
  if (!loan) return;
  if (!canManage(req.user, loan)) return res.sendStatus(403);
  const done = (type, key) => {
    flash(req, type, req.t(key, { n: MAX_LOAN_PHOTOS }));
    back(req, res, '/loans?tab=lending');
  };

  const err = await new Promise((resolve) => loanPhotoUpload(req, res, (e) => resolve(e)));
  if (loan.status !== 'approved') return done('error', 'flash.photo_not_now');
  if (err && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) return done('error', 'flash.photo_limit');
  if (err) return done('error', 'err.photo');
  const body = String((req.body || {}).body || '').trim().slice(0, MAX_ISSUE_LEN);
  if (body.length < 5) return done('error', 'flash.problem_text');

  const keys = [];
  for (const f of req.files || []) keys.push(await savePhoto(f));
  const { findOrCreate } = require('./messages');
  const convId = tx(() => {
    const issueId = Number(db.prepare('INSERT INTO loan_issues (loan_id, reporter_id, body) VALUES (?, ?, ?)')
      .run(loan.id, req.user.id, body).lastInsertRowid);
    for (const key of keys) db.prepare('INSERT INTO loan_issue_photos (issue_id, photo_key) VALUES (?, ?)').run(issueId, key);
    db.prepare("UPDATE loans SET status = 'returned', returned_at = datetime('now') WHERE id = ?").run(loan.id);
    // Start the conversation with the problem, so both can sort it out there.
    const id = findOrCreate(loan.item_id, loan.owner_id, loan.borrower_id);
    db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)')
      .run(id, req.user.id, `⚠️ ${req.t('loans.problem_msg', { title: loan.title })}\n\n${body}`);
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(id);
    return id;
  });

  notify(loan.borrower_id, (x) => x.t('n.problem', { name: req.user.name, title: loan.title }), `/messages/${convId}`,
    { email: true, subject: (x) => x.t('mail.problem', { title: loan.title }) });
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all().map((r) => r.id);
  for (const id of admins) {
    if (id === req.user.id) continue;
    notify(id, (x) => x.t('n.problem_admin', { owner: req.user.name, name: loan.borrower_name, title: loan.title }), '/admin#problems');
  }
  flash(req, 'ok', req.t('flash.problem_reported', { name: loan.borrower_name }));
  res.redirect(`/messages/${convId}`);
});

module.exports = router;
