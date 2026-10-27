// Dugnad: community work days. Overview, create/edit wizard, event page, registration,
// participant management, announcements, and finishing an event. Tasks and equipment are in dugnad-work.js.
const router = require('express').Router();
const multer = require('multer');
const { db, tx } = require('../db');
const { requireAuth, requireHood, flash } = require('../auth');
const { notify } = require('../notify');
const { savePhoto, deletePhoto, ALLOWED_TYPES } = require('../storage');
const { today } = require('../util');
const dn = require('../dugnad');
const { withEvent, managerOnly, editable, backTo, text, int, dateOrNull, timeOrNull, urlOrNull, bool, hoodMembers } = require('./dugnad-shared');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_TYPES.includes(file.mimetype)),
}).single('cover');
const parseCover = (req, res) => new Promise((resolve) => upload(req, res, (err) => resolve(err ? 'err.photo' : null)));

const STEPS = 6;
const title = (req) => req.t('dugnad.title');

// A numeric :id only, so /dugnad/create and /dugnad/my-events are never mistaken for an event.
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));

// ---- Overview -----------------------------------------------------------------------------------

router.get('/dugnad', (req, res) => {
  const u = req.user;
  const f = {
    filter: dn.FILTERS.includes(req.query.filter) ? req.query.filter : 'upcoming',
    q: text(req.query.q, 80),
  };
  const events = u ? dn.discover(u, f) : [];
  res.render('dugnad/index', { title: title(req), f, events, FILTERS: dn.FILTERS, hasHood: !!(u && (u.neighbourhood_id || dn.isAdmin(u))), wide: true });
});

router.get('/dugnad/my-events', requireAuth, (req, res) => {
  const groups = dn.myEvents(req.user);
  res.render('dugnad/my-events', { title: req.t('dugnad.my_title'), groups, nextAction: (e) => dn.nextAction(e, req.user, e.my_status), wide: true });
});

// ---- Create and edit (a draft is saved at every step, so nothing is lost moving between steps) ------

function wizard(req, res, ev, step, values, error = null, status = 200) {
  const hoodId = ev ? ev.neighbourhood_id : req.user.neighbourhood_id;
  const data = { title: req.t('dugnad.wizard_title'), ev, step, STEPS, v: values, error, CATEGORIES: dn.CATEGORIES, wide: true };
  if (step === 1 && dn.isAdmin(req.user)) data.hoods = db.prepare('SELECT id, name FROM neighbourhoods ORDER BY name').all();
  if (step === 3) {
    data.members = hoodMembers(hoodId, ev ? ev.organizer_id : req.user.id);
    data.invited = new Set(db.prepare('SELECT user_id FROM dugnad_invites WHERE event_id = ?').all(ev.id).map((r) => r.user_id));
  }
  if (step === 4) data.tasks = dn.tasksOf(ev.id);
  if (step === 5) {
    data.reqs = dn.requirementsOf(ev, req.user);
    data.tasks = dn.tasksOf(ev.id);
    data.templates = db.prepare('SELECT * FROM dugnad_checklist_templates ORDER BY id').all();
    data.templateItems = db.prepare('SELECT template_id, equipment_name, equipment_name_nb FROM dugnad_checklist_template_items ORDER BY template_id, sort_order').all();
  }
  if (step === 6) {
    data.tasks = dn.tasksOf(ev.id);
    data.reqs = dn.requirementsOf(ev, null);
    data.invitedCount = db.prepare('SELECT COUNT(*) AS c FROM dugnad_invites WHERE event_id = ?').get(ev.id).c;
    data.problem = dn.publishProblem(ev);
  }
  res.status(status).render('dugnad/wizard', data);
}

router.get('/dugnad/create', requireAuth, requireHood, (req, res) => {
  wizard(req, res, null, 1, { host_name: req.user.name, category: 'cleanup', visibility: 'hood' });
});

async function saveBasics(req, res, ev) {
  const uploadError = await parseCover(req, res);
  const b = req.body || {};
  const v = {
    title: text(b.title, 80),
    host_name: text(b.host_name, 60),
    description: text(b.description, 2000),
    category: dn.CATEGORY_KEYS.includes(b.category) ? b.category : '',
    visibility: b.visibility === 'private' ? 'private' : 'hood',
  };
  let hood = ev ? ev.neighbourhood_id : req.user.neighbourhood_id;
  if (dn.isAdmin(req.user)) {
    hood = /^\d+$/.test(b.neighbourhood_id || '') && db.prepare('SELECT 1 FROM neighbourhoods WHERE id = ?').get(Number(b.neighbourhood_id)) ? Number(b.neighbourhood_id) : null;
    v.neighbourhood_id = hood ?? '';
  }
  const error = uploadError || (!v.title ? 'dugnad.err_title' : !v.host_name ? 'dugnad.err_host' : !v.category ? 'dugnad.err_category' : null);
  if (error) return wizard(req, res, ev, 1, { ...(ev || {}), ...v }, req.t(error), 400);

  let cover = ev ? ev.cover_photo_key : null;
  if (req.file) {
    const key = await savePhoto(req.file);
    if (cover) await deletePhoto(cover);
    cover = key;
  } else if (cover && b.remove_cover === '1') {
    await deletePhoto(cover);
    cover = null;
  }

  let id;
  if (ev) {
    id = ev.id;
    db.prepare(`UPDATE dugnad_events SET title = ?, host_name = ?, description = ?, category = ?, visibility = ?,
      neighbourhood_id = ?, cover_photo_key = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(v.title, v.host_name, v.description || null, v.category, v.visibility, hood, cover, ev.id);
    announceChange(ev, dn.getEvent(ev.id));
  } else {
    id = Number(db.prepare(`INSERT INTO dugnad_events (organizer_id, neighbourhood_id, host_name, title, description, category, visibility, cover_photo_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, hood, v.host_name, v.title, v.description || null, v.category, v.visibility, cover).lastInsertRowid);
  }
  nav(req, res, id, 1);
}

// Next / back / stay on the same step.
function nav(req, res, id, step) {
  const go = (req.body && req.body.go) || 'next';
  const to = go === 'back' ? Math.max(1, step - 1) : go === 'save' ? step : Math.min(STEPS, step + 1);
  if (go === 'save') flash(req, 'ok', req.t('dugnad.saved'));
  res.redirect(`/dugnad/${id}/edit/${to}`);
}

router.post('/dugnad/create', requireAuth, requireHood, (req, res) => saveBasics(req, res, null));

// Tell the people who signed up when the things they plan around change.
const WATCHED = ['title', 'event_date', 'start_time', 'end_time', 'location_name', 'location_address', 'location_url'];
function announceChange(before, after) {
  if (before.status !== 'published' || !WATCHED.some((k) => (before[k] || null) !== (after[k] || null))) return;
  dn.notifyAll(dn.audience(after, undefined, [after.organizer_id]),
    (x) => x.t('dugnad.n_changed', { title: after.title }), dn.eventLink(after),
    { email: true, subject: (x) => x.t('dugnad.mail_changed', { title: after.title }) });
}

router.get('/dugnad/:id/edit/:step', requireAuth, withEvent, managerOnly, editable, (req, res) => {
  const step = int(req.params.step, 1, STEPS);
  if (!step) return res.sendStatus(404);
  wizard(req, res, req.ev, step, req.ev);
});

router.post('/dugnad/:id/edit/:step', requireAuth, withEvent, managerOnly, editable, async (req, res) => {
  const step = int(req.params.step, 1, 3);
  const ev = req.ev;
  if (!step) return res.sendStatus(404);
  if (step === 1) return saveBasics(req, res, ev);
  const b = req.body || {};

  if (step === 2) {
    const v = {
      event_date: dateOrNull(b.event_date), start_time: timeOrNull(b.start_time), end_time: timeOrNull(b.end_time),
      location_name: text(b.location_name, 80), location_address: text(b.location_address, 160),
      location_url: urlOrNull(b.location_url), registration_deadline: dateOrNull(b.registration_deadline),
      max_participants: b.max_participants ? int(b.max_participants, 1, 500) : null,
    };
    const duration = int(b.duration_minutes, 15, 1440);
    if (!v.end_time && duration && v.start_time) {
      const total = Number(v.start_time.slice(0, 2)) * 60 + Number(v.start_time.slice(3)) + duration;
      if (total < 24 * 60) v.end_time = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
    let error = null;
    if (b.event_date && !v.event_date) error = 'dugnad.err_date';
    else if (v.event_date && v.event_date < today() && v.event_date !== ev.event_date) error = 'dugnad.err_date_past';
    else if (b.start_time && !v.start_time) error = 'dugnad.err_time';
    else if (v.end_time && v.start_time && v.end_time <= v.start_time) error = 'dugnad.err_end';
    else if (b.location_url && !v.location_url) error = 'dugnad.err_url';
    else if (b.registration_deadline && !v.registration_deadline) error = 'dugnad.err_deadline_date';
    else if (v.registration_deadline && v.event_date && v.registration_deadline > v.event_date) error = 'dugnad.err_deadline_order';
    else if (b.max_participants && !v.max_participants) error = 'dugnad.err_max';
    else if (v.max_participants && v.max_participants < ev.registered) error = 'dugnad.err_max_below';
    else if (ev.status === 'published' && dn.publishProblem({ ...ev, ...v })) error = dn.publishProblem({ ...ev, ...v });
    if (error) return wizard(req, res, ev, 2, { ...ev, ...v, ...b }, req.t(error, { n: ev.registered }), 400);
    db.prepare(`UPDATE dugnad_events SET event_date = ?, start_time = ?, end_time = ?, location_name = ?, location_address = ?,
      location_url = ?, registration_deadline = ?, max_participants = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(v.event_date, v.start_time, v.end_time, v.location_name || null, v.location_address || null, v.location_url, v.registration_deadline, v.max_participants, ev.id);
    const after = dn.getEvent(ev.id);
    announceChange(ev, after);
    dn.promoteWaitlist(ev.id); // a higher limit frees places for people waiting
    return nav(req, res, ev.id, 2);
  }

  // step 3: participation rules and invitations
  db.prepare("UPDATE dugnad_events SET registration_required = ?, approval_required = ?, allow_leave = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bool(b.registration_required), bool(b.approval_required), bool(b.allow_leave), ev.id);
  const ids = new Set([].concat(b.invites || []).map(Number));
  const members = hoodMembers(ev.neighbourhood_id, ev.organizer_id).map((m) => m.id).filter((id) => ids.has(id));
  tx(() => {
    db.prepare(`DELETE FROM dugnad_invites WHERE event_id = ? AND user_id NOT IN (SELECT value FROM json_each(?))`).run(ev.id, JSON.stringify(members));
    for (const id of members) db.prepare('INSERT OR IGNORE INTO dugnad_invites (event_id, user_id, invited_by) VALUES (?, ?, ?)').run(ev.id, id, req.user.id);
  });
  dn.notifyInvitees(dn.getEvent(ev.id));
  nav(req, res, ev.id, 3);
});

router.post('/dugnad/:id/publish', requireAuth, withEvent, managerOnly, (req, res) => {
  if (req.ev.status !== 'draft') return res.redirect(`/dugnad/${req.ev.id}`);
  const r = dn.publishEvent(req.ev, req.user);
  if (r.error) {
    flash(req, 'error', req.t(r.error));
    return res.redirect(`/dugnad/${req.ev.id}/edit/${['dugnad.err_date', 'dugnad.err_date_past', 'dugnad.err_time', 'dugnad.err_end', 'dugnad.err_location', 'dugnad.err_deadline_order'].includes(r.error) ? 2 : 1}`);
  }
  res.redirect(`/dugnad/${req.ev.id}/published`);
});

router.get('/dugnad/:id/published', requireAuth, withEvent, managerOnly, (req, res) => {
  if (req.ev.status !== 'published') return res.redirect(`/dugnad/${req.ev.id}`);
  res.render('dugnad/published', { title: req.ev.title, ev: req.ev });
});

router.post('/dugnad/:id/delete', requireAuth, withEvent, managerOnly, async (req, res) => {
  if (req.ev.status !== 'draft') return res.redirect(`/dugnad/${req.ev.id}`);
  db.prepare('DELETE FROM dugnad_events WHERE id = ?').run(req.ev.id);
  await deletePhoto(req.ev.cover_photo_key);
  flash(req, 'ok', req.t('dugnad.draft_deleted'));
  res.redirect('/dugnad/my-events');
});

// ---- Event page ---------------------------------------------------------------------------------

router.get('/dugnad/:id', requireAuth, withEvent, (req, res) => {
  const { ev, isManager } = req;
  const me = dn.getParticipant(ev.id, req.user.id);
  const myStatus = me ? me.registration_status : null;
  const going = myStatus === 'registered' || isManager;
  const published = ev.status !== 'draft';
  const tasks = dn.tasksOf(ev.id);
  const myItems = db.prepare('SELECT id, title FROM items WHERE owner_id = ? AND is_org = 0 ORDER BY title').all(req.user.id);
  res.render('dugnad/event', {
    title: ev.title, ev, me, myStatus, going, isManager, tasks,
    label: dn.registrationLabel(ev, myStatus),
    reason: dn.closedReason(ev),
    reqs: published ? dn.requirementsOf(ev, null) : [],
    requests: published ? dn.requestsOf(ev, req.user) : [],
    announcements: dn.announcementsOf(ev.id),
    participants: going ? dn.participantsOf(ev.id).filter((p) => p.registration_status === 'registered') : [],
    invited: dn.isInvited(ev.id, req.user.id),
    myItems,
    myTasks: new Set(db.prepare('SELECT task_id FROM dugnad_task_assignments WHERE user_id = ? AND assignment_status = \'assigned\'').all(req.user.id).map((r) => r.task_id)),
    myPending: new Set(db.prepare('SELECT task_id FROM dugnad_task_assignments WHERE user_id = ? AND assignment_status = \'pending\'').all(req.user.id).map((r) => r.task_id)),
    wide: true,
  });
});

// ---- Registration ---------------------------------------------------------------------------------

router.post('/dugnad/:id/join', requireAuth, withEvent, (req, res) => {
  const r = dn.joinEvent(req.ev.id, req.user);
  if (r.error) flash(req, 'error', req.t(r.error));
  else flash(req, 'ok', req.t({ registered: 'dugnad.joined', pending: 'dugnad.requested', waitlisted: 'dugnad.waitlisted' }[r.status], { title: req.ev.title }));
  backTo(req, res);
});

router.post('/dugnad/:id/leave', requireAuth, withEvent, (req, res) => {
  const r = dn.leaveEvent(req.ev.id, req.user);
  if (r.error) flash(req, 'error', req.t(r.error));
  else flash(req, 'ok', req.t(r.released ? 'dugnad.left_tasks' : 'dugnad.left', { title: req.ev.title, n: r.released }));
  backTo(req, res);
});

// ---- Participants (organiser) --------------------------------------------------------------------

router.post('/dugnad/:id/participants/:uid/:action', requireAuth, withEvent, managerOnly, editable, (req, res) => {
  const uid = Number(req.params.uid) || 0;
  const { ev } = req;
  const act = req.params.action;
  let r = {};
  if (act === 'approve' || act === 'reject') r = dn.decideRequest(ev, uid, act === 'approve');
  else if (act === 'remove') r = dn.removeParticipant(ev, uid);
  else if (['attended', 'absent', 'clear'].includes(act)) r = dn.setAttendance(ev, uid, act) ? {} : { error: 'dugnad.err_not_registered' };
  else return res.sendStatus(404);
  if (r.error) flash(req, 'error', req.t(r.error));
  backTo(req, res, `/dugnad/${ev.id}/manage#participants`);
});

// Attendance can also be corrected after the event has been completed.
router.post('/dugnad/:id/attendance/:uid/:value', requireAuth, withEvent, managerOnly, (req, res) => {
  if (req.ev.status === 'completed' && dn.setAttendance(req.ev, Number(req.params.uid) || 0, req.params.value)) flash(req, 'ok', req.t('dugnad.saved'));
  backTo(req, res, `/dugnad/${req.ev.id}`);
});

// ---- Organiser page ------------------------------------------------------------------------------

router.get('/dugnad/:id/manage', requireAuth, withEvent, managerOnly, (req, res) => {
  const { ev } = req;
  if (ev.status !== 'published') return res.redirect(ev.status === 'draft' ? `/dugnad/${ev.id}/edit/1` : `/dugnad/${ev.id}`);
  res.render('dugnad/manage', {
    title: ev.title, ev,
    participants: dn.participantsOf(ev.id),
    tasks: dn.tasksOf(ev.id),
    reqs: dn.requirementsOf(ev, req.user),
    requests: dn.requestsOf(ev, req.user),
    announcements: dn.announcementsOf(ev.id),
    wide: true,
  });
});

// ---- Announcements -------------------------------------------------------------------------------

function readAnnouncement(b) {
  const a = { title: text(b.title, 100), message: text(b.message, 2000) };
  return { a, error: !a.title ? 'dugnad.err_title' : !a.message ? 'dugnad.err_message' : null };
}

router.post('/dugnad/:id/announcements', requireAuth, withEvent, managerOnly, (req, res) => {
  const { ev } = req;
  if (ev.status !== 'published') { flash(req, 'error', req.t('dugnad.err_not_open')); return backTo(req, res); }
  const { a, error } = readAnnouncement(req.body || {});
  if (error) { flash(req, 'error', req.t(error)); return backTo(req, res, `/dugnad/${ev.id}/manage#announcements`); }
  db.prepare('INSERT INTO dugnad_announcements (event_id, author_id, title, message) VALUES (?, ?, ?, ?)').run(ev.id, req.user.id, a.title, a.message);
  if (bool((req.body || {}).notify)) {
    dn.notifyAll(dn.audience(ev, ['registered'], [req.user.id]), (x) => x.t('dugnad.n_announcement', { title: ev.title, subject: a.title }), `${dn.eventLink(ev)}#announcements`,
      { email: true, subject: (x) => x.t('dugnad.mail_announcement', { title: ev.title }) });
  }
  flash(req, 'ok', req.t('dugnad.announced'));
  backTo(req, res, `/dugnad/${ev.id}/manage#announcements`);
});

router.post('/dugnad/:id/announcements/:aid/edit', requireAuth, withEvent, managerOnly, (req, res) => {
  const { a, error } = readAnnouncement(req.body || {});
  if (error) flash(req, 'error', req.t(error));
  else {
    db.prepare("UPDATE dugnad_announcements SET title = ?, message = ?, updated_at = datetime('now') WHERE id = ? AND event_id = ?")
      .run(a.title, a.message, Number(req.params.aid) || 0, req.ev.id);
    flash(req, 'ok', req.t('dugnad.saved'));
  }
  backTo(req, res, `/dugnad/${req.ev.id}/manage#announcements`);
});

router.post('/dugnad/:id/announcements/:aid/delete', requireAuth, withEvent, managerOnly, (req, res) => {
  db.prepare('DELETE FROM dugnad_announcements WHERE id = ? AND event_id = ?').run(Number(req.params.aid) || 0, req.ev.id);
  backTo(req, res, `/dugnad/${req.ev.id}/manage#announcements`);
});

// ---- Completing and cancelling -------------------------------------------------------------------

router.get('/dugnad/:id/complete', requireAuth, withEvent, managerOnly, (req, res) => {
  if (req.ev.status !== 'published') return res.redirect(`/dugnad/${req.ev.id}`);
  const tasks = dn.tasksOf(req.ev.id);
  res.render('dugnad/complete', {
    title: req.ev.title, ev: req.ev, tasks,
    outstanding: tasks.filter((t) => ['open', 'in_progress'].includes(t.status)),
    future: !!req.ev.event_date && req.ev.event_date > today(),
    attended: dn.participantsOf(req.ev.id).filter((p) => p.attendance_status === 'attended').length,
    error: null,
  });
});

router.post('/dugnad/:id/complete', requireAuth, withEvent, managerOnly, (req, res) => {
  const { ev } = req;
  if (ev.status !== 'published') return res.redirect(`/dugnad/${ev.id}`);
  const b = req.body || {};
  const outstanding = dn.tasksOf(ev.id).filter((t) => ['open', 'in_progress'].includes(t.status));
  const future = !!ev.event_date && ev.event_date > today();
  // Unfinished tasks or a date that hasn't come yet need an explicit yes.
  if ((outstanding.length || future) && !bool(b.confirm)) {
    flash(req, 'error', req.t('dugnad.err_confirm'));
    return res.redirect(`/dugnad/${ev.id}/complete`);
  }
  dn.completeEvent(ev, {
    summary: text(b.summary, 1000), notes: text(b.notes, 2000),
    leftover: ['completed', 'cancelled'].includes(b.leftover) ? b.leftover : 'keep',
  });
  flash(req, 'ok', req.t('dugnad.completed'));
  res.redirect(`/dugnad/${ev.id}`);
});

router.post('/dugnad/:id/cancel', requireAuth, withEvent, managerOnly, (req, res) => {
  if (!['draft', 'published'].includes(req.ev.status)) return res.redirect(`/dugnad/${req.ev.id}`);
  dn.cancelEvent(req.ev);
  flash(req, 'ok', req.t('dugnad.cancelled', { title: req.ev.title }));
  res.redirect(`/dugnad/${req.ev.id}`);
});

// ---- Report --------------------------------------------------------------------------------------

// Reports go to the admin the same way as the About & contact form.
router.post('/dugnad/:id/report', requireAuth, withEvent, (req, res) => {
  const reason = text((req.body || {}).reason, 1500);
  if (reason.length < 10) { flash(req, 'error', req.t('contact.err_short')); return backTo(req, res); }
  const recent = db.prepare("SELECT COUNT(*) AS c FROM contact_messages WHERE email = ? AND created_at > datetime('now', '-1 hour')").get(req.user.email).c;
  if (recent >= 5) { flash(req, 'error', req.t('contact.err_limit')); return backTo(req, res); }
  const message = `Dugnad “${req.ev.title}” (/dugnad/${req.ev.id}): ${reason}`;
  const r = db.prepare("INSERT INTO contact_messages (user_id, name, email, topic, message) VALUES (?, ?, ?, 'report', ?)")
    .run(req.user.id, req.user.name, req.user.email, message);
  for (const admin of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) {
    notify(admin.id, (x) => x.t('contact.n_new', { name: req.user.name, topic: x.t('topic.report'), preview: message.slice(0, 140) }), `/admin#msg-${r.lastInsertRowid}`);
  }
  flash(req, 'ok', req.t('contact.sent'));
  backTo(req, res);
});

module.exports = router;
