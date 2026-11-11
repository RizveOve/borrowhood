// Dugnad work: tasks and volunteers, the equipment planner (linked to the existing items and loans),
// checklist templates, and community equipment requests with offers from neighbours.
const router = require('express').Router();
const { db, tx } = require('../db');
const { requireAuth, flash } = require('../auth');
const { notify } = require('../notify');
const { getItem } = require('../items');
const { requestLoan } = require('../loan-requests');
const { today } = require('../util');
const dn = require('../dugnad');
const { withEvent, managerOnly, editable, backTo, fail, text, int, dateOrNull, bool } = require('./dugnad-shared');

const link = (ev) => dn.eventLink(ev);
const open = [requireAuth, withEvent];
const manage = [requireAuth, withEvent, managerOnly, editable];
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));

// ---- Tasks ---------------------------------------------------------------------------------------

function readTask(b) {
  const v = {
    title: text(b.title, 100), description: text(b.description, 1000), required_skills: text(b.required_skills, 200),
    estimated_minutes: b.estimated_minutes ? int(b.estimated_minutes, 1, 1440) : null,
    volunteers_needed: int(b.volunteers_needed || 1, 1, 200),
    priority: dn.PRIORITIES.includes(b.priority) ? b.priority : 'normal',
    notes: text(b.notes, 500),
  };
  const error = !v.title ? 'dugnad.err_title' : !v.volunteers_needed ? 'dugnad.err_volunteers' : b.estimated_minutes && !v.estimated_minutes ? 'dugnad.err_duration' : null;
  return { v, error };
}

router.post('/dugnad/:id/tasks', ...manage, (req, res) => {
  const { v, error } = readTask(req.body || {});
  if (error) return fail(req, res, error, `/dugnad/${req.ev.id}/edit/4`);
  const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM dugnad_tasks WHERE event_id = ?').get(req.ev.id).n;
  db.prepare(`INSERT INTO dugnad_tasks (event_id, title, description, estimated_minutes, volunteers_needed, required_skills, priority, notes, sort_order, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.ev.id, v.title, v.description || null, v.estimated_minutes, v.volunteers_needed, v.required_skills || null, v.priority, v.notes || null, order, req.user.id);
  backTo(req, res, `/dugnad/${req.ev.id}/edit/4`);
});

router.post('/dugnad/:id/tasks/:tid/edit', ...manage, (req, res) => {
  const task = dn.getTask(req.ev.id, req.params.tid);
  if (!task) return res.sendStatus(404);
  const { v, error } = readTask(req.body || {});
  if (error) return fail(req, res, error, `/dugnad/${req.ev.id}/edit/4`);
  const assigned = dn.assignedCount(task.id);
  if (v.volunteers_needed < assigned) return fail(req, res, 'dugnad.err_volunteers_below', `/dugnad/${req.ev.id}/edit/4`, { n: assigned });
  const status = dn.TASK_STATUSES.includes((req.body || {}).status) ? req.body.status : task.status;
  db.prepare(`UPDATE dugnad_tasks SET title = ?, description = ?, estimated_minutes = ?, volunteers_needed = ?, required_skills = ?,
    priority = ?, notes = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(v.title, v.description || null, v.estimated_minutes, v.volunteers_needed, v.required_skills || null, v.priority, v.notes || null, status, task.id);
  flash(req, 'ok', req.t('dugnad.saved'));
  backTo(req, res, `/dugnad/${req.ev.id}/edit/4`);
});

router.post('/dugnad/:id/tasks/:tid/delete', ...manage, (req, res) => {
  const task = dn.getTask(req.ev.id, req.params.tid);
  if (!task) return res.sendStatus(404);
  const people = db.prepare('SELECT user_id FROM dugnad_task_assignments WHERE task_id = ?').all(task.id).map((r) => r.user_id);
  // A task that already has volunteers is only deleted after an explicit confirmation.
  if (people.length && !bool((req.body || {}).confirm)) return fail(req, res, 'dugnad.err_task_has_people', `/dugnad/${req.ev.id}/edit/4`);
  db.prepare('DELETE FROM dugnad_tasks WHERE id = ?').run(task.id);
  dn.notifyAll(people, (x) => x.t('dugnad.n_task_removed', { task: task.title, title: req.ev.title }), link(req.ev));
  backTo(req, res, `/dugnad/${req.ev.id}/edit/4`);
});

router.post('/dugnad/:id/tasks/:tid/move', ...manage, (req, res) => {
  dn.moveTask(req.ev, req.params.tid, (req.body || {}).dir === 'up' ? 'up' : 'down');
  backTo(req, res, `/dugnad/${req.ev.id}/edit/4`);
});

router.post('/dugnad/:id/tasks/:tid/volunteer', ...open, (req, res) => {
  const r = dn.assignVolunteer(req.ev, req.params.tid, req.user.id, { by: req.user.id, direct: false });
  if (r.error) return fail(req, res, r.error, `/dugnad/${req.ev.id}#tasks`);
  if (req.ev.organizer_id !== req.user.id) {
    notify(req.ev.organizer_id, (x) => x.t(r.status === 'pending' ? 'dugnad.n_task_request' : 'dugnad.n_task_volunteer', { name: req.user.name, task: r.task.title, title: req.ev.title }),
      r.status === 'pending' ? `${link(req.ev)}/manage#tasks` : link(req.ev));
  }
  flash(req, 'ok', req.t(r.status === 'pending' ? 'dugnad.task_requested' : 'dugnad.task_joined', { task: r.task.title }));
  backTo(req, res, `/dugnad/${req.ev.id}#tasks`);
});

router.post('/dugnad/:id/tasks/:tid/withdraw', ...open, (req, res) => {
  const task = dn.releaseVolunteer(req.ev, req.params.tid, req.user.id);
  if (task && req.ev.organizer_id !== req.user.id) {
    notify(req.ev.organizer_id, (x) => x.t('dugnad.n_task_withdrew', { name: req.user.name, task: task.title, title: req.ev.title }), `${link(req.ev)}/manage#tasks`);
  }
  backTo(req, res, `/dugnad/${req.ev.id}#tasks`);
});

// The organiser puts a registered participant on a task, or accepts someone's application.
router.post('/dugnad/:id/tasks/:tid/assign', ...manage, (req, res) => {
  const uid = Number((req.body || {}).user_id) || 0;
  const r = dn.assignVolunteer(req.ev, req.params.tid, uid, { by: req.user.id, direct: true });
  if (r.error) return fail(req, res, r.error, `/dugnad/${req.ev.id}/manage#tasks`);
  if (uid !== req.user.id) notify(uid, (x) => x.t('dugnad.n_task_assigned', { task: r.task.title, title: req.ev.title }), `${link(req.ev)}#tasks`);
  backTo(req, res, `/dugnad/${req.ev.id}/manage#tasks`);
});

router.post('/dugnad/:id/tasks/:tid/assignments/:uid/:action', ...manage, (req, res) => {
  const uid = Number(req.params.uid) || 0;
  const { action } = req.params;
  if (action === 'approve') {
    const r = dn.assignVolunteer(req.ev, req.params.tid, uid, { by: req.user.id, direct: true });
    if (r.error) return fail(req, res, r.error, `/dugnad/${req.ev.id}/manage#tasks`);
    notify(uid, (x) => x.t('dugnad.n_task_assigned', { task: r.task.title, title: req.ev.title }), `${link(req.ev)}#tasks`);
  } else if (action === 'remove') {
    const task = dn.releaseVolunteer(req.ev, req.params.tid, uid);
    if (task && uid !== req.user.id) notify(uid, (x) => x.t('dugnad.n_task_unassigned', { task: task.title, title: req.ev.title }), `${link(req.ev)}#tasks`);
  } else return res.sendStatus(404);
  backTo(req, res, `/dugnad/${req.ev.id}/manage#tasks`);
});

// The organiser sets any status; a volunteer on the task can move it along (but not cancel it).
router.post('/dugnad/:id/tasks/:tid/status', ...open, (req, res) => {
  const task = dn.getTask(req.ev.id, req.params.tid);
  if (!task) return res.sendStatus(404);
  const status = (req.body || {}).status;
  const mine = db.prepare("SELECT 1 FROM dugnad_task_assignments WHERE task_id = ? AND user_id = ? AND assignment_status = 'assigned'").get(task.id, req.user.id);
  const allowed = req.isManager || (mine && req.ev.status === 'published' && ['open', 'in_progress', 'completed'].includes(status));
  if (!allowed || !dn.TASK_STATUSES.includes(status)) return res.status(403).render('error', { title: req.t('err.forbidden'), message: req.t('dugnad.err_forbidden') });
  db.prepare("UPDATE dugnad_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, task.id);
  backTo(req, res, `/dugnad/${req.ev.id}#tasks`);
});

// ---- Equipment requirements -----------------------------------------------------------------------

function readRequirement(req, b) {
  const v = {
    equipment_name: text(b.equipment_name, 60), description: text(b.description, 300),
    quantity_needed: int(b.quantity_needed || 1, 1, 999),
    essential: b.essential === 'optional' ? 0 : 1,
    needed_from: dateOrNull(b.needed_from), needed_until: dateOrNull(b.needed_until),
    task_id: null,
  };
  if (/^\d+$/.test(b.task_id || '') && dn.getTask(req.ev.id, b.task_id)) v.task_id = Number(b.task_id);
  const error = !v.equipment_name ? 'dugnad.err_equipment_name' : !v.quantity_needed ? 'dugnad.err_quantity'
    : (b.needed_from && !v.needed_from) || (b.needed_until && !v.needed_until) ? 'err.dates'
      : v.needed_from && v.needed_until && v.needed_until < v.needed_from ? 'err.order' : null;
  return { v, error };
}

router.post('/dugnad/:id/equipment', ...manage, (req, res) => {
  const { v, error } = readRequirement(req, req.body || {});
  if (error) return fail(req, res, error, `/dugnad/${req.ev.id}/edit/5`);
  db.prepare(`INSERT INTO dugnad_equipment_requirements (event_id, task_id, equipment_name, description, quantity_needed, essential, needed_from, needed_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.ev.id, v.task_id, v.equipment_name, v.description || null, v.quantity_needed, v.essential, v.needed_from, v.needed_until);
  backTo(req, res, `/dugnad/${req.ev.id}/edit/5`);
});

router.post('/dugnad/:id/equipment/:rid/edit', ...manage, (req, res) => {
  const r = requirement(req);
  if (!r) return res.sendStatus(404);
  const { v, error } = readRequirement(req, req.body || {});
  if (error) return fail(req, res, error, `/dugnad/${req.ev.id}/edit/5`);
  const status = (req.body || {}).status === 'no_longer_needed' ? 'no_longer_needed' : 'needed';
  db.prepare(`UPDATE dugnad_equipment_requirements SET task_id = ?, equipment_name = ?, description = ?, quantity_needed = ?, essential = ?,
    needed_from = ?, needed_until = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(v.task_id, v.equipment_name, v.description || null, v.quantity_needed, v.essential, v.needed_from, v.needed_until, status, r.id);
  flash(req, 'ok', req.t('dugnad.saved'));
  backTo(req, res, `/dugnad/${req.ev.id}/edit/5`);
});

const requirement = (req) => db.prepare('SELECT * FROM dugnad_equipment_requirements WHERE id = ? AND event_id = ?').get(Number(req.params.rid) || 0, req.ev.id);

// Removing a requirement only removes the Dugnad side. Loan requests already made stay as they are
// in the loan system; the organiser cancels them there if they are not wanted any more.
router.post('/dugnad/:id/equipment/:rid/delete', ...manage, (req, res) => {
  const r = requirement(req);
  if (!r) return res.sendStatus(404);
  const live = db.prepare(`SELECT COUNT(*) AS c FROM dugnad_equipment_links l JOIN loans ln ON ln.id = l.loan_id
    WHERE l.requirement_id = ? AND ln.status IN ('pending', 'approved')`).get(r.id).c;
  if (live && !bool((req.body || {}).confirm)) return fail(req, res, 'dugnad.err_requirement_has_loans', `/dugnad/${req.ev.id}/edit/5`);
  db.prepare('DELETE FROM dugnad_equipment_requirements WHERE id = ?').run(r.id);
  if (live) flash(req, 'ok', req.t('dugnad.requirement_removed_loans'));
  backTo(req, res, `/dugnad/${req.ev.id}/edit/5`);
});

// Copies the template's items into the event. The template stays as it is, and later changes to it
// never reach this event. Items already on the list are skipped.
router.post('/dugnad/:id/equipment/template', ...manage, (req, res) => {
  const tpl = db.prepare('SELECT id FROM dugnad_checklist_templates WHERE category = ?').get(String((req.body || {}).category || ''));
  if (!tpl) return fail(req, res, 'dugnad.err_template', `/dugnad/${req.ev.id}/edit/5`);
  const nb = req.lang === 'nb';
  const have = new Set(db.prepare('SELECT LOWER(equipment_name) AS n FROM dugnad_equipment_requirements WHERE event_id = ?').all(req.ev.id).map((r) => r.n));
  let added = 0;
  tx(() => {
    for (const it of db.prepare('SELECT * FROM dugnad_checklist_template_items WHERE template_id = ? ORDER BY sort_order').all(tpl.id)) {
      const name = nb ? it.equipment_name_nb : it.equipment_name;
      if (have.has(name.toLowerCase())) continue;
      db.prepare('INSERT INTO dugnad_equipment_requirements (event_id, equipment_name, quantity_needed, essential, needed_from, needed_until) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.ev.id, name, it.suggested_quantity, it.essential_by_default, req.ev.event_date, req.ev.event_date);
      added++;
    }
  });
  flash(req, 'ok', req.t('dugnad.template_added', { n: added }));
  backTo(req, res, `/dugnad/${req.ev.id}/edit/5`);
});

// ---- Find equipment and borrow it through the existing loan workflow -------------------------------

router.get('/dugnad/:id/equipment/:rid/find', ...manage, (req, res) => {
  const r = requirement(req);
  if (!r) return res.sendStatus(404);
  const q = text(req.query.q, 60) || r.equipment_name;
  const from = r.needed_from && r.needed_from >= today() ? r.needed_from : (req.ev.event_date && req.ev.event_date >= today() ? req.ev.event_date : today());
  const until = r.needed_until && r.needed_until >= from ? r.needed_until : from;
  const results = dn.searchEquipment(req.ev, req.user, q, { from, to: until });
  const linked = new Set(db.prepare('SELECT item_id FROM dugnad_equipment_links WHERE requirement_id = ?').all(r.id).map((l) => l.item_id));
  res.render('dugnad/find', { title: req.t('dugnad.find_title'), ev: req.ev, r, q, results, linked, from, until, error: /^err\.\w+$/.test(req.query.error || '') ? req.query.error : null });
});

// Asks to borrow through the normal loan request. Nothing is reserved or approved here: the owner decides.
router.post('/dugnad/:id/equipment/:rid/request', ...manage, (req, res) => {
  const r = requirement(req);
  const b = req.body || {};
  const item = getItem(b.item_id);
  const find = `/dugnad/${req.ev.id}/equipment/${r && r.id}/find`;
  if (!r || !item) return res.sendStatus(404);
  if (db.prepare('SELECT 1 FROM dugnad_equipment_links WHERE requirement_id = ? AND item_id = ?').get(r.id, item.id)) return res.redirect(`${find}?error=dugnad.err_linked`);
  const prefix = req.t('dugnad.loan_message', { title: req.ev.title });
  const result = requestLoan(item, req.user, {
    start: String(b.start_date || ''), end: String(b.end_date || ''),
    message: `${prefix}${text(b.message, 300) ? ' ' + text(b.message, 300) : ''}`.slice(0, 500),
  });
  if (result.error) return res.redirect(`${find}?error=${result.error}`);
  db.prepare('INSERT INTO dugnad_equipment_links (requirement_id, item_id, loan_id) VALUES (?, ?, ?)').run(r.id, item.id, result.loanId);
  flash(req, 'ok', req.t('dugnad.loan_requested', { title: item.title }));
  backTo(req, res, `/dugnad/${req.ev.id}/manage#equipment`);
});

// The organiser brings one of their own items: no loan needed, and nothing else is changed.
router.post('/dugnad/:id/equipment/:rid/own', ...manage, (req, res) => {
  const r = requirement(req);
  const item = getItem((req.body || {}).item_id);
  if (!r || !item) return res.sendStatus(404);
  if (item.owner_id !== req.user.id) return fail(req, res, 'dugnad.err_not_yours', `/dugnad/${req.ev.id}/manage#equipment`);
  db.prepare('INSERT OR IGNORE INTO dugnad_equipment_links (requirement_id, item_id, own) VALUES (?, ?, 1)').run(r.id, item.id);
  backTo(req, res, `/dugnad/${req.ev.id}/manage#equipment`);
});

router.post('/dugnad/:id/equipment/:rid/links/:lid/remove', ...manage, (req, res) => {
  const r = requirement(req);
  if (!r) return res.sendStatus(404);
  db.prepare('DELETE FROM dugnad_equipment_links WHERE id = ? AND requirement_id = ?').run(Number(req.params.lid) || 0, r.id);
  backTo(req, res, `/dugnad/${req.ev.id}/manage#equipment`);
});

// ---- Community equipment requests and offers ------------------------------------------------------

function readRequest(req, b) {
  const v = {
    equipment_name: text(b.equipment_name, 60), description: text(b.description, 300), instructions: text(b.instructions, 300),
    quantity_needed: int(b.quantity_needed || 1, 1, 999), essential: b.essential === 'optional' ? 0 : 1,
    needed_from: dateOrNull(b.needed_from), needed_until: dateOrNull(b.needed_until), requirement_id: null,
  };
  if (/^\d+$/.test(b.requirement_id || '') && db.prepare('SELECT 1 FROM dugnad_equipment_requirements WHERE id = ? AND event_id = ?').get(Number(b.requirement_id), req.ev.id)) {
    v.requirement_id = Number(b.requirement_id);
  }
  const error = !v.equipment_name ? 'dugnad.err_equipment_name' : !v.quantity_needed ? 'dugnad.err_quantity'
    : (b.needed_from && !v.needed_from) || (b.needed_until && !v.needed_until) ? 'err.dates'
      : v.needed_from && v.needed_until && v.needed_until < v.needed_from ? 'err.order' : null;
  return { v, error };
}

router.post('/dugnad/:id/requests', ...manage, (req, res) => {
  const { v, error } = readRequest(req, req.body || {});
  if (error) return fail(req, res, error, `/dugnad/${req.ev.id}/manage#requests`);
  db.prepare(`INSERT INTO dugnad_equipment_requests (event_id, requirement_id, created_by, equipment_name, description, quantity_needed, essential, needed_from, needed_until, instructions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.ev.id, v.requirement_id, req.user.id, v.equipment_name, v.description || null, v.quantity_needed, v.essential, v.needed_from, v.needed_until, v.instructions || null);
  flash(req, 'ok', req.t('dugnad.request_published'));
  backTo(req, res, `/dugnad/${req.ev.id}/manage#requests`);
});

const request = (req) => db.prepare('SELECT * FROM dugnad_equipment_requests WHERE id = ? AND event_id = ?').get(Number(req.params.qid) || 0, req.ev.id);

router.post('/dugnad/:id/requests/:qid/edit', ...manage, (req, res) => {
  const q = request(req);
  if (!q) return res.sendStatus(404);
  const { v, error } = readRequest(req, req.body || {});
  if (error) return fail(req, res, error, `/dugnad/${req.ev.id}/manage#requests`);
  db.prepare(`UPDATE dugnad_equipment_requests SET equipment_name = ?, description = ?, quantity_needed = ?, essential = ?, needed_from = ?,
    needed_until = ?, instructions = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(v.equipment_name, v.description || null, v.quantity_needed, v.essential, v.needed_from, v.needed_until, v.instructions || null, q.id);
  flash(req, 'ok', req.t('dugnad.saved'));
  backTo(req, res, `/dugnad/${req.ev.id}/manage#requests`);
});

router.post('/dugnad/:id/requests/:qid/cancel', ...manage, (req, res) => {
  const q = request(req);
  if (!q) return res.sendStatus(404);
  db.prepare("UPDATE dugnad_equipment_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(q.id);
  backTo(req, res, `/dugnad/${req.ev.id}/manage#requests`);
});

// A neighbour offers one of their own listed items. The organiser then asks to borrow it (normal loan request).
router.post('/dugnad/:id/requests/:qid/offer', ...open, (req, res) => {
  const q = request(req);
  if (!q) return res.sendStatus(404);
  const here = `/dugnad/${req.ev.id}#requests`;
  if (req.ev.status !== 'published' || q.status !== 'open') return fail(req, res, 'dugnad.err_request_closed', here);
  if (req.isManager) return fail(req, res, 'dugnad.err_own_request', here);
  const item = getItem((req.body || {}).item_id);
  if (!item || item.owner_id !== req.user.id || item.is_org) return fail(req, res, 'dugnad.err_not_yours', here);
  if (db.prepare("SELECT 1 FROM dugnad_equipment_offers WHERE request_id = ? AND item_id = ? AND status = 'offered'").get(q.id, item.id)) return fail(req, res, 'dugnad.err_already_offered', here);
  tx(() => {
    db.prepare("DELETE FROM dugnad_equipment_offers WHERE request_id = ? AND offered_by = ? AND status = 'declined'").run(q.id, req.user.id);
    db.prepare('INSERT INTO dugnad_equipment_offers (request_id, offered_by, item_id, message) VALUES (?, ?, ?, ?)')
      .run(q.id, req.user.id, item.id, text((req.body || {}).message, 300) || null);
  });
  notify(q.created_by, (x) => x.t('dugnad.n_offer', { name: req.user.name, item: item.title, request: q.equipment_name, title: req.ev.title }), `${link(req.ev)}/manage#requests`);
  flash(req, 'ok', req.t('dugnad.offered', { item: item.title }));
  backTo(req, res, here);
});

router.post('/dugnad/:id/requests/:qid/decline', ...open, (req, res) => {
  const q = request(req);
  if (!q) return res.sendStatus(404);
  if (!db.prepare('SELECT 1 FROM dugnad_equipment_offers WHERE request_id = ? AND offered_by = ?').get(q.id, req.user.id)) {
    db.prepare("INSERT INTO dugnad_equipment_offers (request_id, offered_by, status) VALUES (?, ?, 'declined')").run(q.id, req.user.id);
  }
  backTo(req, res, `/dugnad/${req.ev.id}#requests`);
});

router.post('/dugnad/:id/offers/:oid/withdraw', ...open, (req, res) => {
  const o = db.prepare(`SELECT o.* FROM dugnad_equipment_offers o JOIN dugnad_equipment_requests q ON q.id = o.request_id
    WHERE o.id = ? AND q.event_id = ?`).get(Number(req.params.oid) || 0, req.ev.id);
  if (!o || o.offered_by !== req.user.id) return res.sendStatus(404);
  db.prepare("UPDATE dugnad_equipment_offers SET status = 'withdrawn', updated_at = datetime('now') WHERE id = ?").run(o.id);
  backTo(req, res, `/dugnad/${req.ev.id}#requests`);
});

// The organiser asks to borrow an offered item through the loan system. The owner still decides.
router.post('/dugnad/:id/offers/:oid/request-loan', ...manage, (req, res) => {
  const o = db.prepare(`SELECT o.*, q.requirement_id, q.needed_from, q.needed_until FROM dugnad_equipment_offers o
    JOIN dugnad_equipment_requests q ON q.id = o.request_id WHERE o.id = ? AND q.event_id = ?`).get(Number(req.params.oid) || 0, req.ev.id);
  const back = `/dugnad/${req.ev.id}/manage#requests`;
  if (!o || o.status !== 'offered' || !o.item_id) return res.sendStatus(404);
  if (o.loan_id) return fail(req, res, 'dugnad.err_linked', back);
  const item = getItem(o.item_id);
  const b = req.body || {};
  const start = String(b.start_date || '') || (o.needed_from && o.needed_from >= today() ? o.needed_from : req.ev.event_date) || today();
  const end = String(b.end_date || '') || o.needed_until || start;
  const result = requestLoan(item, req.user, { start, end, message: req.t('dugnad.loan_message', { title: req.ev.title }) });
  if (result.error) return fail(req, res, result.error, back);
  tx(() => {
    db.prepare("UPDATE dugnad_equipment_offers SET loan_id = ?, updated_at = datetime('now') WHERE id = ?").run(result.loanId, o.id);
    // Linked to the requirement too, so the planner reads the loan's state from one place.
    if (o.requirement_id) db.prepare('INSERT OR IGNORE INTO dugnad_equipment_links (requirement_id, item_id, loan_id) VALUES (?, ?, ?)').run(o.requirement_id, item.id, result.loanId);
  });
  notify(o.offered_by, (x) => x.t('dugnad.n_offer_loan', { item: item.title, title: req.ev.title }), '/loans?tab=lending');
  flash(req, 'ok', req.t('dugnad.loan_requested', { title: item.title }));
  backTo(req, res, back);
});

module.exports = router;
