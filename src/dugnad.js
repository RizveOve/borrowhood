// Dugnad: rules and queries. The routes call into this module, so the permission and capacity rules
// live in one place and are enforced on the server whatever the page shows.
const { db, tx } = require('./db');
const { notify } = require('./notify');
const { overlaps } = require('./loan-requests');
const { today, addDays, TZ } = require('./util');

const isAdmin = (u) => !!u && u.role === 'admin';

const CATEGORIES = [
  { key: 'cleanup', emoji: '🧹' }, { key: 'gardening', emoji: '🌱' }, { key: 'painting', emoji: '🎨' },
  { key: 'repairs', emoji: '🔧' }, { key: 'snow', emoji: '❄️' }, { key: 'gathering', emoji: '🎉' },
  { key: 'shared', emoji: '🏡' }, { key: 'recycling', emoji: '♻️' }, { key: 'other', emoji: '🤝' },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
const catEmoji = (k) => (CATEGORIES.find((c) => c.key === k) || CATEGORIES.at(-1)).emoji;

const PRIORITIES = ['low', 'normal', 'high'];
const TASK_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'];
const ACTIVE = ['pending', 'registered', 'waitlisted']; // registration states that still hold a place in line

// ---- Events -------------------------------------------------------------------------------------

const EVENT_SQL = `SELECT e.*, o.name AS organizer_name, n.name AS hood_name,
  (SELECT COUNT(*) FROM dugnad_participants p WHERE p.event_id = e.id AND p.registration_status = 'registered') AS registered,
  (SELECT COUNT(*) FROM dugnad_participants p WHERE p.event_id = e.id AND p.registration_status = 'pending') AS pending,
  (SELECT COUNT(*) FROM dugnad_participants p WHERE p.event_id = e.id AND p.registration_status = 'waitlisted') AS waitlisted
  FROM dugnad_events e JOIN users o ON o.id = e.organizer_id LEFT JOIN neighbourhoods n ON n.id = e.neighbourhood_id`;
const eventById = db.prepare(EVENT_SQL + ' WHERE e.id = ?');
const getEvent = (id) => eventById.get(Number(id) || 0);

const participantQuery = db.prepare('SELECT * FROM dugnad_participants WHERE event_id = ? AND user_id = ?');
const getParticipant = (eventId, userId) => participantQuery.get(eventId, userId);
const isInvited = (eventId, userId) => !!db.prepare('SELECT 1 FROM dugnad_invites WHERE event_id = ? AND user_id = ?').get(eventId, userId);

const canManage = (user, ev) => !!user && (isAdmin(user) || ev.organizer_id === user.id);

// Drafts are private to the organiser. Private events are for invited people and participants.
// Everything else is visible in its own neighbourhood (and admin events everywhere).
function canView(user, ev) {
  if (!user) return false;
  if (canManage(user, ev)) return true;
  if (ev.status === 'draft') return false;
  const p = getParticipant(ev.id, user.id);
  if (p && ACTIVE.includes(p.registration_status)) return true;
  if (ev.visibility === 'private') return isInvited(ev.id, user.id);
  return ev.neighbourhood_id === null || ev.neighbourhood_id === user.neighbourhood_id;
}

const spotsLeft = (ev) => (ev.max_participants == null ? null : Math.max(0, ev.max_participants - ev.registered));
const isFull = (ev) => ev.max_participants != null && ev.registered >= ev.max_participants;
const hasEnded = (ev, t = today()) => !!ev.event_date && ev.event_date < t;
const deadlinePassed = (ev, t = today()) => !!ev.registration_deadline && t > ev.registration_deadline;

// Why registration is not open, as a translation key, or null when people can sign up.
function closedReason(ev, t = today()) {
  if (ev.status === 'cancelled') return 'dugnad.err_cancelled';
  if (ev.status === 'completed') return 'dugnad.err_completed';
  if (ev.status !== 'published') return 'dugnad.err_not_open';
  if (!ev.registration_required) return 'dugnad.err_no_registration';
  if (hasEnded(ev, t)) return 'dugnad.err_past_event';
  if (deadlinePassed(ev, t)) return 'dugnad.err_deadline';
  return null;
}

// One word for the card/detail badge: where does this person stand with this event?
function registrationLabel(ev, myStatus, t = today()) {
  if (ev.status === 'cancelled') return { key: 'cancelled', tone: 'overdue' };
  if (ev.status === 'completed') return { key: 'completed', tone: '' };
  if (myStatus === 'registered') return { key: 'registered', tone: 'ok' };
  if (myStatus === 'pending') return { key: 'pending', tone: 'warn' };
  if (myStatus === 'waitlisted') return { key: 'waitlisted', tone: 'warn' };
  if (!ev.registration_required) return { key: 'no_registration', tone: '' };
  if (closedReason(ev, t)) return { key: 'closed', tone: '' };
  if (isFull(ev)) return { key: 'full', tone: 'overdue' };
  return { key: 'open', tone: 'ok' };
}

function durationMinutes(ev) {
  if (!ev.start_time || !ev.end_time) return null;
  const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const d = mins(ev.end_time) - mins(ev.start_time);
  return d > 0 ? d : null;
}

function nowTime() {
  return new Date().toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

// SQL for "events this person may see", with the parameters it needs (admin, organiser, hood, invited, participant).
const VISIBLE_SQL = `(? = 1 OR e.organizer_id = ?
  OR (e.visibility = 'hood' AND (e.neighbourhood_id IS NULL OR e.neighbourhood_id = ?))
  OR EXISTS (SELECT 1 FROM dugnad_invites i WHERE i.event_id = e.id AND i.user_id = ?)
  OR EXISTS (SELECT 1 FROM dugnad_participants p WHERE p.event_id = e.id AND p.user_id = ?
             AND p.registration_status IN ('pending', 'registered', 'waitlisted')))`;
const visibleParams = (u) => [isAdmin(u) ? 1 : 0, u.id, u.neighbourhood_id ?? -1, u.id, u.id];

const FILTERS = ['upcoming', 'hood', 'organizing', 'participating', 'open', 'completed'];

// Events for the overview. Drafts never show up here (they are in My Dugnads for the organiser).
function discover(user, { filter = 'upcoming', q = '' } = {}) {
  const t = today();
  const where = ["e.status IN ('published', 'completed')", VISIBLE_SQL];
  const params = [user.id, ...visibleParams(user)]; // first param: my_status subquery
  const upcoming = "e.status = 'published' AND e.event_date >= ?";
  if (filter === 'completed') where.push("e.status = 'completed'");
  else if (filter === 'organizing') where.push('e.organizer_id = ?'), params.push(user.id);
  else if (filter === 'participating') {
    where.push(upcoming, "EXISTS (SELECT 1 FROM dugnad_participants p WHERE p.event_id = e.id AND p.user_id = ? AND p.registration_status IN ('pending', 'registered', 'waitlisted'))");
    params.push(t, user.id);
  } else if (filter === 'hood') {
    where.push(upcoming, 'e.neighbourhood_id = ?');
    params.push(t, user.neighbourhood_id ?? -1);
  } else if (filter === 'open') {
    where.push(upcoming, 'e.registration_required = 1', '(e.registration_deadline IS NULL OR e.registration_deadline >= ?)',
      '(e.max_participants IS NULL OR (SELECT COUNT(*) FROM dugnad_participants p WHERE p.event_id = e.id AND p.registration_status = \'registered\') < e.max_participants)');
    params.push(t, t);
  } else where.push(upcoming), params.push(t);
  if (q) {
    where.push('(e.title LIKE ? OR e.description LIKE ? OR e.location_name LIKE ? OR e.location_address LIKE ?)');
    params.push(...Array(4).fill(`%${q}%`));
  }
  const rows = db.prepare(`SELECT * FROM (SELECT e2.*, (SELECT registration_status FROM dugnad_participants p
      WHERE p.event_id = e2.id AND p.user_id = ?) AS my_status
    FROM (${EVENT_SQL}) e2) e WHERE ${where.join(' AND ')}
    ORDER BY ${filter === 'completed' ? 'e.event_date DESC' : 'e.event_date, e.start_time'}, e.id`).all(...params);
  return rows;
}

// Everything a person has to do with, grouped for My Dugnads.
function myEvents(user) {
  const rows = db.prepare(`SELECT e.*, (SELECT registration_status FROM dugnad_participants p
      WHERE p.event_id = e.id AND p.user_id = ?) AS my_status,
    (SELECT attendance_status FROM dugnad_participants p WHERE p.event_id = e.id AND p.user_id = ?) AS my_attendance
    FROM (${EVENT_SQL}) e
    WHERE e.organizer_id = ? OR EXISTS (SELECT 1 FROM dugnad_participants p WHERE p.event_id = e.id AND p.user_id = ?
      AND p.registration_status IN ('pending', 'registered', 'waitlisted'))
    ORDER BY e.event_date IS NULL DESC, e.event_date, e.start_time, e.id`).all(user.id, user.id, user.id, user.id);
  const t = today();
  const out = { organizing: [], needsWrapUp: [], participating: [], completed: [], attended: [], drafts: [] };
  for (const e of rows) {
    const mine = e.organizer_id === user.id;
    if (e.status === 'draft') out.drafts.push(e);
    else if (e.status === 'completed') {
      if (mine) out.completed.push(e);
      else if (e.my_attendance !== 'absent') out.attended.push(e);
    }
    else if (e.status === 'cancelled') continue;
    else if (mine) (hasEnded(e, t) ? out.needsWrapUp : out.organizing).push(e);
    else if (!hasEnded(e, t)) out.participating.push(e);
  }
  out.completed.reverse();
  out.attended.reverse();
  return out;
}

// What this person should do next with an event, as a translation key and link.
function nextAction(ev, user, myStatus) {
  const base = `/dugnad/${ev.id}`;
  if (ev.organizer_id === user.id || isAdmin(user)) {
    if (ev.status === 'draft') return { key: 'dugnad.next_finish', href: `${base}/edit/1` };
    if (ev.status === 'published' && hasEnded(ev)) return { key: 'dugnad.next_complete', href: `${base}/complete` };
    if (ev.status === 'published') return { key: ev.pending ? 'dugnad.next_requests' : 'dugnad.next_manage', href: `${base}/manage` };
    return { key: 'dugnad.next_open', href: base };
  }
  if (myStatus === 'registered' && ev.status === 'published') return { key: 'dugnad.next_tasks', href: `${base}#tasks` };
  return { key: 'dugnad.next_open', href: base };
}

// ---- Notifications ------------------------------------------------------------------------------

// People who should hear about changes to an event: organiser excluded, everyone once.
function audience(ev, statuses = ['registered', 'pending', 'waitlisted'], exclude = []) {
  const ids = db.prepare(`SELECT user_id FROM dugnad_participants WHERE event_id = ? AND registration_status IN (${statuses.map(() => '?').join(',')})`)
    .all(ev.id, ...statuses).map((r) => r.user_id);
  return [...new Set(ids)].filter((id) => !exclude.includes(id));
}

function notifyAll(ids, body, link, opts = {}) {
  for (const id of ids) notify(id, body, link, opts);
}

const eventLink = (ev) => `/dugnad/${ev.id}`;

// ---- Registration -------------------------------------------------------------------------------

function writeParticipant(eventId, userId, status) {
  db.prepare(`INSERT INTO dugnad_participants (event_id, user_id, registration_status) VALUES (?, ?, ?)
    ON CONFLICT (event_id, user_id) DO UPDATE SET registration_status = excluded.registration_status,
      attendance_status = NULL, updated_at = datetime('now')`).run(eventId, userId, status);
}

function dropAssignments(ev, userId) {
  return db.prepare(`DELETE FROM dugnad_task_assignments WHERE user_id = ?
    AND task_id IN (SELECT id FROM dugnad_tasks WHERE event_id = ?)`).run(userId, ev.id).changes;
}

// When a place frees up, the person waiting longest gets it.
function promoteWaitlist(evId) {
  const promoted = [];
  for (;;) {
    const ev = getEvent(evId);
    if (!ev || ev.status !== 'published' || isFull(ev)) break;
    const next = db.prepare("SELECT user_id FROM dugnad_participants WHERE event_id = ? AND registration_status = 'waitlisted' ORDER BY registered_at, id LIMIT 1").get(evId);
    if (!next) break;
    writeParticipant(evId, next.user_id, 'registered');
    promoted.push(next.user_id);
  }
  const ev = getEvent(evId);
  for (const id of promoted) notify(id, (x) => x.t('dugnad.n_promoted', { title: ev.title }), eventLink(ev));
  return promoted;
}

function joinEvent(evId, user) {
  const result = tx(() => {
    const ev = getEvent(evId);
    if (!ev) return { error: 'err.not_found' };
    const reason = closedReason(ev);
    if (reason) return { error: reason };
    const existing = getParticipant(ev.id, user.id);
    if (existing && ACTIVE.includes(existing.registration_status)) return { error: 'dugnad.err_already' };
    if (existing && ['rejected', 'removed'].includes(existing.registration_status)) return { error: 'dugnad.err_blocked' };
    const status = ev.approval_required ? 'pending' : isFull(ev) ? 'waitlisted' : 'registered';
    writeParticipant(ev.id, user.id, status);
    return { ev, status };
  });
  if (result.error) return result;
  const { ev, status } = result;
  const key = { pending: 'dugnad.n_request', registered: 'dugnad.n_joined', waitlisted: 'dugnad.n_waitlisted' }[status];
  notify(ev.organizer_id, (x) => x.t(key, { name: user.name, title: ev.title }), status === 'pending' ? `${eventLink(ev)}/manage#participants` : eventLink(ev));
  return { status };
}

function leaveEvent(evId, user) {
  const ev = getEvent(evId);
  const p = ev && getParticipant(ev.id, user.id);
  if (!p || !ACTIVE.includes(p.registration_status)) return { error: 'dugnad.err_not_registered' };
  if (ev.organizer_id === user.id) return { error: 'dugnad.err_organizer_leave' };
  if (ev.status !== 'published') return { error: 'dugnad.err_not_open' };
  if (!ev.allow_leave && p.registration_status === 'registered') return { error: 'dugnad.err_no_leave' };
  const released = tx(() => {
    writeParticipant(ev.id, user.id, 'withdrawn');
    return dropAssignments(ev, user.id);
  });
  if (p.registration_status === 'registered') {
    notify(ev.organizer_id, (x) => x.t(released ? 'dugnad.n_left_tasks' : 'dugnad.n_left', { name: user.name, title: ev.title, n: released }), `${eventLink(ev)}/manage#participants`);
    promoteWaitlist(ev.id);
  }
  return { released };
}

function decideRequest(ev, userId, approve) {
  const p = getParticipant(ev.id, userId);
  if (!p || p.registration_status !== 'pending') return { error: 'dugnad.err_not_pending' };
  const status = approve ? (isFull(getEvent(ev.id)) ? 'waitlisted' : 'registered') : 'rejected';
  writeParticipant(ev.id, userId, status);
  const key = { registered: 'dugnad.n_approved', waitlisted: 'dugnad.n_approved_waitlist', rejected: 'dugnad.n_rejected' }[status];
  notify(userId, (x) => x.t(key, { title: ev.title }), eventLink(ev), { email: true, subject: (x) => x.t('dugnad.mail_request', { title: ev.title }) });
  return { status };
}

function removeParticipant(ev, userId) {
  const p = getParticipant(ev.id, userId);
  if (!p || !ACTIVE.includes(p.registration_status) || userId === ev.organizer_id) return { error: 'dugnad.err_not_registered' };
  tx(() => {
    writeParticipant(ev.id, userId, 'removed');
    dropAssignments(ev, userId);
  });
  notify(userId, (x) => x.t('dugnad.n_removed', { title: ev.title }), eventLink(ev));
  if (p.registration_status === 'registered') promoteWaitlist(ev.id);
  return {};
}

function participantsOf(evId) {
  return db.prepare(`SELECT p.*, u.name, u.flat, u.email FROM dugnad_participants p JOIN users u ON u.id = p.user_id
    WHERE p.event_id = ? AND p.registration_status IN ('pending', 'registered', 'waitlisted')
    ORDER BY CASE p.registration_status WHEN 'pending' THEN 0 WHEN 'registered' THEN 1 ELSE 2 END, p.registered_at, p.id`).all(evId);
}

function setAttendance(ev, userId, value) {
  const p = getParticipant(ev.id, userId);
  if (!p || p.registration_status !== 'registered') return false;
  db.prepare("UPDATE dugnad_participants SET attendance_status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(['attended', 'absent'].includes(value) ? value : null, p.id);
  return true;
}

// ---- Tasks --------------------------------------------------------------------------------------

function tasksOf(evId) {
  const tasks = db.prepare('SELECT * FROM dugnad_tasks WHERE event_id = ? ORDER BY sort_order, id').all(evId);
  const byId = new Map(tasks.map((t) => [t.id, Object.assign(t, { assigned: [], pending: [], equipment: [] })]));
  const rows = db.prepare(`SELECT a.*, u.name FROM dugnad_task_assignments a JOIN users u ON u.id = a.user_id
    WHERE a.task_id IN (SELECT id FROM dugnad_tasks WHERE event_id = ?) ORDER BY a.assigned_at, a.id`).all(evId);
  for (const a of rows) byId.get(a.task_id)[a.assignment_status === 'assigned' ? 'assigned' : 'pending'].push(a);
  for (const r of db.prepare('SELECT id, task_id, equipment_name, quantity_needed FROM dugnad_equipment_requirements WHERE event_id = ? AND task_id IS NOT NULL').all(evId)) {
    byId.get(r.task_id)?.equipment.push(r);
  }
  for (const t of tasks) {
    t.full = t.assigned.length >= t.volunteers_needed;
    t.label = t.status === 'open' ? (t.full ? 'assigned' : 'volunteers_needed') : t.status;
  }
  return tasks;
}

const getTask = (evId, taskId) => db.prepare('SELECT * FROM dugnad_tasks WHERE id = ? AND event_id = ?').get(Number(taskId) || 0, evId);

function assignedCount(taskId) {
  return db.prepare("SELECT COUNT(*) AS c FROM dugnad_task_assignments WHERE task_id = ? AND assignment_status = 'assigned'").get(taskId).c;
}

// Put someone on a task, or ask to (pending) when the organiser has to approve. The limit is checked
// again inside the transaction, so two people cannot take the last place at once.
function assignVolunteer(ev, taskId, userId, { by, direct }) {
  return tx(() => {
    const task = getTask(ev.id, taskId);
    if (!task) return { error: 'err.not_found' };
    if (ev.status !== 'published') return { error: 'dugnad.err_not_open' };
    if (['completed', 'cancelled'].includes(task.status)) return { error: 'dugnad.err_task_closed' };
    const p = getParticipant(ev.id, userId);
    if (!p || p.registration_status !== 'registered') return { error: 'dugnad.err_join_first' };
    const existing = db.prepare('SELECT * FROM dugnad_task_assignments WHERE task_id = ? AND user_id = ?').get(task.id, userId);
    if (existing && existing.assignment_status === 'assigned') return { error: 'dugnad.err_task_already' };
    const needsApproval = !direct && !!ev.approval_required && ev.organizer_id !== userId;
    if (!needsApproval && assignedCount(task.id) >= task.volunteers_needed) return { error: 'dugnad.err_task_full' };
    if (existing && needsApproval) return { error: 'dugnad.err_task_already' };
    const status = needsApproval ? 'pending' : 'assigned';
    db.prepare(`INSERT INTO dugnad_task_assignments (task_id, user_id, assignment_status, assigned_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id, user_id) DO UPDATE SET assignment_status = excluded.assignment_status,
        assigned_by = excluded.assigned_by, updated_at = datetime('now')`).run(task.id, userId, status, by);
    return { task, status };
  });
}

function releaseVolunteer(ev, taskId, userId) {
  const task = getTask(ev.id, taskId);
  if (!task) return null;
  const r = db.prepare('DELETE FROM dugnad_task_assignments WHERE task_id = ? AND user_id = ?').run(task.id, userId);
  return r.changes ? task : null;
}

function moveTask(ev, taskId, dir) {
  const tasks = db.prepare('SELECT id FROM dugnad_tasks WHERE event_id = ? ORDER BY sort_order, id').all(ev.id).map((t) => t.id);
  const i = tasks.indexOf(Number(taskId));
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= tasks.length) return;
  [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
  tx(() => tasks.forEach((id, n) => db.prepare('UPDATE dugnad_tasks SET sort_order = ? WHERE id = ?').run(n, id)));
}

// ---- Equipment ----------------------------------------------------------------------------------

// How a linked item stands, read from the loan itself so it can never drift out of step with it.
function linkState(l, t = today()) {
  if (l.own) return 'own';
  if (!l.loan_status) return 'cancelled';
  if (l.loan_status === 'pending') return 'pending';
  if (l.loan_status === 'approved') return l.start_date <= t && l.end_date >= t ? 'active' : 'approved';
  if (l.loan_status === 'returned') return 'returned';
  if (l.loan_status === 'declined') return 'rejected';
  return 'cancelled';
}
const SECURED = ['own', 'approved', 'active', 'returned'];

const linkRows = db.prepare(`SELECT l.*, i.title AS item_title, i.owner_id, i.is_org, i.photo_key, i.category,
    u.name AS owner_name, ln.status AS loan_status, ln.start_date, ln.end_date
  FROM dugnad_equipment_links l JOIN items i ON i.id = l.item_id JOIN users u ON u.id = i.owner_id
  LEFT JOIN loans ln ON ln.id = l.loan_id
  WHERE l.requirement_id IN (SELECT id FROM dugnad_equipment_requirements WHERE event_id = ?) ORDER BY l.id`);

// Needed / available in the neighbourhood / request pending / approved / partially fulfilled /
// unavailable / no longer needed. Being listed in the library is never counted as secured.
function requirementStatus(r, matches) {
  if (r.status === 'no_longer_needed') return 'no_longer_needed';
  if (r.secured >= r.quantity_needed) return 'approved';
  if (r.secured > 0) return 'partial';
  if (r.pendingCount > 0) return 'pending';
  if (r.links.length) return 'unavailable';
  return matches > 0 ? 'available' : 'needed';
}

function requirementsOf(ev, user) {
  const reqs = db.prepare('SELECT r.*, t.title AS task_title FROM dugnad_equipment_requirements r LEFT JOIN dugnad_tasks t ON t.id = r.task_id WHERE r.event_id = ? ORDER BY r.essential DESC, r.id').all(ev.id);
  const byId = new Map(reqs.map((r) => [r.id, Object.assign(r, { links: [], secured: 0, pendingCount: 0 })]));
  const t = today();
  for (const l of linkRows.all(ev.id)) {
    l.state = linkState(l, t);
    const r = byId.get(l.requirement_id);
    r.links.push(l);
    if (SECURED.includes(l.state)) r.secured += l.quantity;
    if (l.state === 'pending') r.pendingCount += l.quantity;
  }
  for (const r of reqs) {
    const matches = r.status === 'needed' && !r.links.length && user ? searchEquipment(ev, user, r.equipment_name, {}).filter((i) => !i.mine && !i.booked).length : 0;
    r.matches = matches;
    r.state = requirementStatus(r, matches);
  }
  return reqs;
}

const singular = (w) => [...new Set([w, w.replace(/s$/, ''), w.replace(/es$/, ''), w.replace(/er$/, ''), w.replace(/r$/, '')])].filter((v) => v.length >= 3);

// Looks through the existing item library (same items as Browse). Items in the event's neighbourhood
// come first, then the BorrowHood shelf, then other neighbourhoods.
function searchEquipment(ev, user, query, { from, to } = {}) {
  const tokens = [...new Set(String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2).flatMap(singular))];
  if (!tokens.length) return [];
  const hood = ev.neighbourhood_id ?? user.neighbourhood_id ?? -1;
  const rows = db.prepare(`SELECT i.id, i.title, i.description, i.category, i.photo_key, i.location, i.is_org, i.owner_id,
      u.name AS owner_name, u.neighbourhood_id AS owner_hood, n.name AS hood_name
    FROM items i JOIN users u ON u.id = i.owner_id LEFT JOIN neighbourhoods n ON n.id = u.neighbourhood_id
    WHERE ${tokens.map(() => '(LOWER(i.title) LIKE ? OR LOWER(i.description) LIKE ?)').join(' OR ')} LIMIT 200`)
    .all(...tokens.flatMap((w) => [`%${w}%`, `%${w}%`]));
  const start = from || ev.event_date || today();
  const end = to || ev.event_date || start;
  for (const r of rows) {
    const text = `${r.title} ${r.description || ''}`.toLowerCase();
    r.score = tokens.filter((w) => text.includes(w)).length;
    r.mine = r.owner_id === user.id;
    r.booked = overlaps(r.id, start, end);
    r.near = !r.is_org && r.owner_hood === hood;
  }
  return rows.sort((a, b) => (b.near - a.near) || (b.is_org - a.is_org) || (b.score - a.score) || (a.booked - b.booked) || a.title.localeCompare(b.title));
}

// Community requests, with the offers made and the state worked out from the loans behind them.
function requestsOf(ev, user) {
  const reqs = db.prepare('SELECT q.*, u.name AS creator_name FROM dugnad_equipment_requests q JOIN users u ON u.id = q.created_by WHERE q.event_id = ? ORDER BY q.id DESC').all(ev.id);
  const offers = db.prepare(`SELECT o.*, u.name AS owner_name, i.title AS item_title, i.photo_key, i.category, i.owner_id,
      ln.status AS loan_status, ln.start_date, ln.end_date
    FROM dugnad_equipment_offers o JOIN users u ON u.id = o.offered_by LEFT JOIN items i ON i.id = o.item_id LEFT JOIN loans ln ON ln.id = o.loan_id
    WHERE o.request_id IN (SELECT id FROM dugnad_equipment_requests WHERE event_id = ?) ORDER BY o.id`).all(ev.id);
  const t = today();
  const byId = new Map(reqs.map((q) => [q.id, Object.assign(q, { offers: [], secured: 0, mine: false })]));
  for (const o of offers) {
    o.state = o.loan_id ? linkState(o, t) : null;
    const q = byId.get(o.request_id);
    if (o.status === 'offered') {
      q.offers.push(o);
      if (SECURED.includes(o.state)) q.secured += 1;
    } else if (o.status === 'declined' && o.offered_by === user.id) q.declined = true;
    if (o.offered_by === user.id && o.status === 'offered') q.mine = true;
  }
  for (const q of reqs) {
    q.state = q.status === 'cancelled' ? 'cancelled'
      : q.secured >= q.quantity_needed ? 'fulfilled'
        : q.secured > 0 ? 'partial'
          : q.offers.length ? 'offers' : 'open';
  }
  return reqs;
}

// ---- Announcements ------------------------------------------------------------------------------

const announcementsOf = (evId) => db.prepare(`SELECT a.*, u.name AS author_name FROM dugnad_announcements a
  LEFT JOIN users u ON u.id = a.author_id WHERE a.event_id = ? ORDER BY a.created_at DESC, a.id DESC`).all(evId);

// ---- Publishing, completing, cancelling ----------------------------------------------------------

// Everything a draft needs before neighbours can see it. Returns a translation key or null.
function publishProblem(ev) {
  if (!ev.title) return 'dugnad.err_title';
  if (!ev.event_date) return 'dugnad.err_date';
  if (ev.event_date < today()) return 'dugnad.err_date_past';
  if (!ev.start_time) return 'dugnad.err_time';
  if (ev.end_time && ev.end_time <= ev.start_time) return 'dugnad.err_end';
  if (!ev.location_name) return 'dugnad.err_location';
  if (ev.registration_deadline && ev.registration_deadline > ev.event_date) return 'dugnad.err_deadline_order';
  return null;
}

function publishEvent(ev, user) {
  const problem = publishProblem(ev);
  if (problem) return { error: problem };
  tx(() => {
    db.prepare("UPDATE dugnad_events SET status = 'published', updated_at = datetime('now') WHERE id = ?").run(ev.id);
    // The organiser takes the first place and so can be given tasks and have attendance recorded.
    if (!getParticipant(ev.id, ev.organizer_id)) writeParticipant(ev.id, ev.organizer_id, 'registered');
  });
  notifyInvitees(getEvent(ev.id));
  return {};
}

function notifyInvitees(ev) {
  if (ev.status !== 'published') return;
  const rows = db.prepare('SELECT user_id FROM dugnad_invites WHERE event_id = ? AND notified = 0 AND user_id <> ?').all(ev.id, ev.organizer_id);
  for (const r of rows) {
    notify(r.user_id, (x) => x.t('dugnad.n_invited', { name: ev.host_name, title: ev.title, date: x.d(ev.event_date) }), eventLink(ev),
      { email: true, subject: (x) => x.t('dugnad.mail_invited', { title: ev.title }) });
  }
  db.prepare('UPDATE dugnad_invites SET notified = 1 WHERE event_id = ?').run(ev.id);
}

function completeEvent(ev, { summary, notes, leftover }) {
  tx(() => {
    db.prepare(`UPDATE dugnad_events SET status = 'completed', completion_summary = ?, completion_notes = ?,
      completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(summary || null, notes || null, ev.id);
    if (['completed', 'cancelled'].includes(leftover)) {
      db.prepare("UPDATE dugnad_tasks SET status = ?, updated_at = datetime('now') WHERE event_id = ? AND status IN ('open', 'in_progress')").run(leftover, ev.id);
    }
  });
  notifyAll(audience(ev, ['registered'], [ev.organizer_id]), (x) => x.t('dugnad.n_completed', { title: ev.title }), eventLink(ev));
}

function cancelEvent(ev) {
  db.prepare("UPDATE dugnad_events SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(ev.id);
  // Equipment loans are not touched: they carry on in the normal loan workflow.
  notifyAll(audience(ev, undefined, [ev.organizer_id]), (x) => x.t('dugnad.n_cancelled', { title: ev.title, date: x.d(ev.event_date) }), eventLink(ev),
    { email: true, subject: (x) => x.t('dugnad.mail_cancelled', { title: ev.title }) });
}

// ---- Reminders ----------------------------------------------------------------------------------

const logReminder = db.prepare('INSERT OR IGNORE INTO dugnad_reminders (event_id, user_id, kind) VALUES (?, ?, ?)');

// Called by the hourly job: a day before, a few hours before, and when the sign-up deadline is near.
// Each person gets each reminder once per event, even if they join late.
function runReminders(now = { date: today(), time: nowTime() }) {
  let sent = 0;
  const send = (ev, ids, kind, key) => {
    for (const id of ids) {
      if (!logReminder.run(ev.id, id, kind).changes) continue;
      notify(id, (x) => x.t(key, { title: ev.title, date: x.d(ev.event_date), time: ev.start_time, place: ev.location_name || '' }), eventLink(ev),
        { email: kind !== 'deadline', subject: (x) => x.t('dugnad.mail_reminder', { title: ev.title }) });
      sent++;
    }
  };
  const tomorrow = addDays(now.date, 1);
  const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const upcoming = db.prepare("SELECT id FROM dugnad_events WHERE status = 'published' AND (event_date IN (?, ?) OR registration_deadline = ?)")
    .all(now.date, tomorrow, tomorrow);
  for (const { id } of upcoming) {
    const ev = getEvent(id);
    const going = audience(ev, ['registered']);
    if (ev.event_date === tomorrow) send(ev, going, 'day', 'dugnad.n_reminder_day');
    if (ev.event_date === now.date && ev.start_time) {
      const untilStart = mins(ev.start_time) - mins(now.time);
      if (untilStart >= 0 && untilStart <= 240) send(ev, going, 'hours', 'dugnad.n_reminder_hours');
    }
    if (ev.registration_deadline === tomorrow && ev.registration_required) {
      const invited = db.prepare(`SELECT i.user_id FROM dugnad_invites i WHERE i.event_id = ? AND NOT EXISTS
        (SELECT 1 FROM dugnad_participants p WHERE p.event_id = i.event_id AND p.user_id = i.user_id AND p.registration_status IN ('registered', 'pending', 'waitlisted'))`)
        .all(ev.id).map((r) => r.user_id);
      send(ev, invited, 'deadline', 'dugnad.n_deadline');
    }
  }
  return sent;
}

module.exports = {
  CATEGORIES, CATEGORY_KEYS, catEmoji, PRIORITIES, TASK_STATUSES, FILTERS, ACTIVE,
  getEvent, getParticipant, isInvited, canView, canManage, isAdmin, spotsLeft, isFull, hasEnded, deadlinePassed, closedReason,
  registrationLabel, durationMinutes, discover, myEvents, nextAction,
  audience, notifyAll, eventLink, joinEvent, leaveEvent, decideRequest, removeParticipant, promoteWaitlist, participantsOf, setAttendance,
  tasksOf, getTask, assignedCount, assignVolunteer, releaseVolunteer, moveTask,
  linkState, SECURED, requirementsOf, searchEquipment, requestsOf, announcementsOf,
  publishProblem, publishEvent, notifyInvitees, completeEvent, cancelEvent, runReminders, writeParticipant,
};
