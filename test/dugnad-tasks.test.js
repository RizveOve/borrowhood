// Tasks and volunteers.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const dn = require('../src/dugnad');

const { db } = h;
let organiser, ann, ben, cat, outsider, org, a, b, c, out;

before(async () => {
  await h.start();
  const hood = h.hood('Tasks hood');
  organiser = h.user('Olga Organiser', hood);
  ann = h.user('Ann Volunteer', hood);
  ben = h.user('Ben Volunteer', hood);
  cat = h.user('Cat Volunteer', hood);
  outsider = h.user('Other Hood', h.hood('Elsewhere'));
  [org, a, b, c, out] = await Promise.all([organiser, ann, ben, cat, outsider].map((u) => new h.Client().login(u.email)));
});
after(() => h.stop());

const addTask = async (id, body = {}) => {
  await org.post(`/dugnad/${id}/tasks`, { title: 'Sweep paths', volunteers_needed: '1', ...body });
  return db.prepare('SELECT id FROM dugnad_tasks WHERE event_id = ? ORDER BY id DESC').get(id).id;
};
const assigned = (taskId) => db.prepare("SELECT user_id FROM dugnad_task_assignments WHERE task_id = ? AND assignment_status = 'assigned'").all(taskId).map((r) => r.user_id);
const pending = (taskId) => db.prepare("SELECT user_id FROM dugnad_task_assignments WHERE task_id = ? AND assignment_status = 'pending'").all(taskId).map((r) => r.user_id);
const taskStatus = (taskId) => db.prepare('SELECT status FROM dugnad_tasks WHERE id = ?').get(taskId).status;

describe('tasks', () => {
  test('the organiser can create, edit, reorder and delete tasks', async () => {
    const id = await h.createEvent(org);
    const t1 = await addTask(id, { title: 'First', description: 'd', estimated_minutes: '30', required_skills: 'strong', priority: 'high', volunteers_needed: '2' });
    const t2 = await addTask(id, { title: 'Second' });
    const row = db.prepare('SELECT * FROM dugnad_tasks WHERE id = ?').get(t1);
    assert.deepEqual([row.title, row.estimated_minutes, row.volunteers_needed, row.priority, row.required_skills], ['First', 30, 2, 'high', 'strong']);
    await org.post(`/dugnad/${id}/tasks/${t1}/edit`, { title: 'First renamed', volunteers_needed: '3', priority: 'low', status: 'in_progress', notes: 'note' });
    const edited = db.prepare('SELECT * FROM dugnad_tasks WHERE id = ?').get(t1);
    assert.deepEqual([edited.title, edited.volunteers_needed, edited.priority, edited.status, edited.notes], ['First renamed', 3, 'low', 'in_progress', 'note']);
    await org.post(`/dugnad/${id}/tasks/${t2}/move`, { dir: 'up' });
    assert.deepEqual(dn.tasksOf(id).map((t) => t.id), [t2, t1]);
    await org.post(`/dugnad/${id}/tasks/${t2}/delete`);
    assert.deepEqual(dn.tasksOf(id).map((t) => t.id), [t1]);
  });

  test('task fields are validated', async () => {
    const id = await h.createEvent(org);
    for (const bad of [{ title: '' }, { volunteers_needed: '0' }, { volunteers_needed: 'many' }, { estimated_minutes: 'soon' }]) {
      await org.post(`/dugnad/${id}/tasks`, { title: 'T', volunteers_needed: '1', ...bad });
    }
    assert.equal(dn.tasksOf(id).length, 0);
  });

  test('people who are not the organiser cannot create, change or delete tasks', async () => {
    const id = await h.createEvent(org);
    const t = await addTask(id);
    await a.post(`/dugnad/${id}/join`);
    for (const attempt of [() => a.post(`/dugnad/${id}/tasks`, { title: 'Mine', volunteers_needed: '1' }), () => a.post(`/dugnad/${id}/tasks/${t}/edit`, { title: 'X', volunteers_needed: '1' }),
      () => a.post(`/dugnad/${id}/tasks/${t}/delete`), () => a.post(`/dugnad/${id}/tasks/${t}/assign`, { user_id: String(ann.id) }), () => a.post(`/dugnad/${id}/tasks/${t}/move`, { dir: 'up' })]) {
      assert.equal((await attempt()).status, 403);
    }
    assert.equal(dn.tasksOf(id).length, 1);
    assert.equal(dn.tasksOf(id)[0].title, 'Sweep paths');
    assert.equal((await out.post(`/dugnad/${id}/tasks/${t}/volunteer`)).status, 404);
  });

  test('participants can volunteer, but only after signing up', async () => {
    const id = await h.createEvent(org);
    const t = await addTask(id, { volunteers_needed: '2' });
    assert.match((await a.follow(await a.post(`/dugnad/${id}/tasks/${t}/volunteer`, { next: 'event' }))).text, /Sign up for the dugnad first/);
    assert.deepEqual(assigned(t), []);
    await a.post(`/dugnad/${id}/join`);
    await a.post(`/dugnad/${id}/tasks/${t}/volunteer`);
    assert.deepEqual(assigned(t), [ann.id]);
    assert.match((await a.follow(await a.post(`/dugnad/${id}/tasks/${t}/volunteer`, { next: 'event' }))).text, /already have/);
    assert.deepEqual(assigned(t), [ann.id]);
  });

  test('the volunteer limit is enforced on the server', async () => {
    const id = await h.createEvent(org);
    const t = await addTask(id, { volunteers_needed: '1' });
    await Promise.all([a, b].map((x) => x.post(`/dugnad/${id}/join`)));
    await a.post(`/dugnad/${id}/tasks/${t}/volunteer`);
    const r = await b.post(`/dugnad/${id}/tasks/${t}/volunteer`, { next: 'event' });
    assert.match((await b.follow(r)).text, /task is full/);
    assert.deepEqual(assigned(t), [ann.id]);
    // Even the organiser cannot overfill it by assigning; raising the limit makes room.
    await b.post(`/dugnad/${id}/leave`);
    await org.post(`/dugnad/${id}/join`);
    assert.match((await org.follow(await org.post(`/dugnad/${id}/tasks/${t}/assign`, { user_id: String(organiser.id), next: 'manage' }))).text, /task is full/);
    await org.post(`/dugnad/${id}/tasks/${t}/edit`, { title: 'Sweep', volunteers_needed: '2' });
    await org.post(`/dugnad/${id}/tasks/${t}/assign`, { user_id: String(organiser.id) });
    assert.deepEqual(assigned(t).sort(), [ann.id, organiser.id].sort());
    // The limit cannot drop below the people already on it.
    await org.post(`/dugnad/${id}/tasks/${t}/edit`, { title: 'Sweep', volunteers_needed: '1' });
    assert.equal(db.prepare('SELECT volunteers_needed AS n FROM dugnad_tasks WHERE id = ?').get(t).n, 2);
    assert.equal(dn.tasksOf(id)[0].label, 'assigned');
  });

  test('with approval on, a volunteer waits for the organiser', async () => {
    const id = await h.createEvent(org, { rules: { approval_required: '1' } });
    const t = await addTask(id, { volunteers_needed: '1' });
    await a.post(`/dugnad/${id}/join`);
    await org.post(`/dugnad/${id}/participants/${ann.id}/approve`);
    await a.post(`/dugnad/${id}/tasks/${t}/volunteer`);
    assert.deepEqual(pending(t), [ann.id]);
    assert.deepEqual(assigned(t), []);
    assert.equal((await a.post(`/dugnad/${id}/tasks/${t}/assignments/${ann.id}/approve`)).status, 403);
    await org.post(`/dugnad/${id}/tasks/${t}/assignments/${ann.id}/approve`);
    assert.deepEqual(assigned(t), [ann.id]);
    assert.ok(h.notes(ann.id).some((n) => /given the task/.test(n.body)));
  });

  test('the organiser assigns and removes volunteers, and they are told', async () => {
    const id = await h.createEvent(org);
    const t = await addTask(id, { volunteers_needed: '2' });
    await b.post(`/dugnad/${id}/join`);
    await org.post(`/dugnad/${id}/tasks/${t}/assign`, { user_id: String(ben.id) });
    assert.deepEqual(assigned(t), [ben.id]);
    assert.ok(h.notes(ben.id).some((n) => /given the task "Sweep paths"/.test(n.body)));
    // Someone who has not signed up cannot be assigned.
    await org.post(`/dugnad/${id}/tasks/${t}/assign`, { user_id: String(cat.id) });
    assert.deepEqual(assigned(t), [ben.id]);
    await org.post(`/dugnad/${id}/tasks/${t}/assignments/${ben.id}/remove`);
    assert.deepEqual(assigned(t), []);
    assert.ok(h.notes(ben.id).some((n) => /taken off the task/.test(n.body)));
  });

  test('status: organisers set any, volunteers move their own task along, others cannot', async () => {
    const id = await h.createEvent(org);
    const t = await addTask(id);
    await Promise.all([a, b].map((x) => x.post(`/dugnad/${id}/join`)));
    await a.post(`/dugnad/${id}/tasks/${t}/volunteer`);
    assert.equal((await b.post(`/dugnad/${id}/tasks/${t}/status`, { status: 'completed' })).status, 403);
    assert.equal(taskStatus(t), 'open');
    assert.equal((await a.post(`/dugnad/${id}/tasks/${t}/status`, { status: 'cancelled' })).status, 403);
    await a.post(`/dugnad/${id}/tasks/${t}/status`, { status: 'in_progress' });
    assert.equal(taskStatus(t), 'in_progress');
    await a.post(`/dugnad/${id}/tasks/${t}/status`, { status: 'completed' });
    assert.equal(taskStatus(t), 'completed');
    await org.post(`/dugnad/${id}/tasks/${t}/status`, { status: 'cancelled' });
    assert.equal(taskStatus(t), 'cancelled');
    // A closed task takes no new volunteers.
    assert.match((await b.follow(await b.post(`/dugnad/${id}/tasks/${t}/volunteer`, { next: 'event' }))).text, /task is closed/);
  });

  test('finishing every task does not complete the event', async () => {
    const id = await h.createEvent(org);
    const t = await addTask(id);
    await org.post(`/dugnad/${id}/tasks/${t}/status`, { status: 'completed' });
    assert.equal(db.prepare('SELECT status FROM dugnad_events WHERE id = ?').get(id).status, 'published');
  });

  test('deleting a task with volunteers needs confirmation, and they are told', async () => {
    const id = await h.createEvent(org);
    const t = await addTask(id);
    await a.post(`/dugnad/${id}/join`);
    await a.post(`/dugnad/${id}/tasks/${t}/volunteer`);
    await org.post(`/dugnad/${id}/tasks/${t}/delete`);
    assert.equal(dn.tasksOf(id).length, 1);
    await org.post(`/dugnad/${id}/tasks/${t}/delete`, { confirm: '1' });
    assert.equal(dn.tasksOf(id).length, 0);
    assert.ok(h.notes(ann.id).some((n) => /was removed/.test(n.body)));
  });

  test('leaving an event leaves no invalid task assignments, and waiting volunteers can step in', async () => {
    const id = await h.createEvent(org);
    const t = await addTask(id, { volunteers_needed: '1' });
    await Promise.all([a, b].map((x) => x.post(`/dugnad/${id}/join`)));
    await a.post(`/dugnad/${id}/tasks/${t}/volunteer`);
    const r = await a.post(`/dugnad/${id}/leave`, { next: 'event' });
    assert.match((await a.follow(r)).text, /1 task\(s\) were released/);
    assert.deepEqual(assigned(t), []);
    assert.ok(h.notes(organiser.id).some((n) => /Ann Volunteer left .* 1 task\(s\) were released/.test(n.body)));
    await b.post(`/dugnad/${id}/tasks/${t}/volunteer`);
    assert.deepEqual(assigned(t), [ben.id]);
    // Removed participants lose their tasks too.
    await org.post(`/dugnad/${id}/participants/${ben.id}/remove`);
    assert.deepEqual(assigned(t), []);
    const orphans = db.prepare(`SELECT COUNT(*) AS c FROM dugnad_task_assignments a JOIN dugnad_tasks t ON t.id = a.task_id
      LEFT JOIN dugnad_participants p ON p.event_id = t.event_id AND p.user_id = a.user_id AND p.registration_status = 'registered'
      WHERE p.id IS NULL`).get().c;
    assert.equal(orphans, 0);
  });
});
