// Notifications, reminders and announcements.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const dn = require('../src/dugnad');

const { db, days } = h;
let organiser, ann, ben, cat, dan, org, a, b, c, d;

before(async () => {
  await h.start();
  const hood = h.hood('Notify hood');
  organiser = h.user('Olga Organiser', hood);
  ann = h.user('Ann Neighbour', hood);
  ben = h.user('Ben Neighbour', hood);
  cat = h.user('Cat Neighbour', hood);
  dan = h.user('Dan Neighbour', hood);
  [org, a, b, c, d] = await Promise.all([organiser, ann, ben, cat, dan].map((u) => new h.Client().login(u.email)));
});
after(() => h.stop());

// Notifications about this event that a person has received.
const got = (user, id) => h.notes(user.id).filter((n) => n.link && n.link.startsWith(`/dugnad/${id}`));

describe('notifications', () => {
  test('joining notifies the organiser, and requests link to the manage page', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Join me' } });
    await a.post(`/dugnad/${id}/join`);
    assert.ok(got(organiser, id).some((n) => /Ann Neighbour joined "Join me"/.test(n.body)));
    const id2 = await h.createEvent(org, { basics: { title: 'Ask me' }, rules: { approval_required: '1' } });
    await a.post(`/dugnad/${id2}/join`);
    const ask = got(organiser, id2).find((n) => /asked to join/.test(n.body));
    assert.ok(ask);
    assert.match(ask.link, /manage/);
    await org.post(`/dugnad/${id2}/participants/${ann.id}/approve`);
    assert.ok(got(ann, id2).some((n) => /You are in/.test(n.body)));
    assert.equal(got(organiser, id2).filter((n) => /asked to join/.test(n.body)).length, 1, 'no duplicate');
  });

  test('leaving and coming back are both reported to the organiser, each in its own words', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Back again' } });
    await a.post(`/dugnad/${id}/join`);
    await a.post(`/dugnad/${id}/leave`);
    await a.post(`/dugnad/${id}/join`);
    const text = got(organiser, id).map((n) => n.body);
    assert.equal(text.filter((x) => /Ann Neighbour joined "Back again"/.test(x)).length, 1);
    assert.equal(text.filter((x) => /Ann Neighbour left "Back again"/.test(x)).length, 1);
    assert.equal(text.filter((x) => /Ann Neighbour rejoined "Back again"/.test(x)).length, 1);
  });

  test('every notification says which dugnad it concerns and links to it', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Linked up' } });
    await a.post(`/dugnad/${id}/join`);
    await org.post(`/dugnad/${id}/announcements`, { title: 'News', message: 'Bring gloves', notify: '1' });
    const all = [...got(ann, id), ...got(organiser, id)];
    assert.ok(all.length >= 2);
    for (const n of all) assert.match(n.body, /Linked up/);
  });

  test('announcements notify registered participants once, and never the author or people not signed up', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Announce' }, rules: { approval_required: '1' } });
    await Promise.all([a, b, c].map((x) => x.post(`/dugnad/${id}/join`)));
    await org.post(`/dugnad/${id}/participants/${ann.id}/approve`);
    await org.post(`/dugnad/${id}/participants/${ben.id}/approve`);
    await b.post(`/dugnad/${id}/leave`);
    // Ann is registered, Ben withdrew, Cat is still pending, Dan never joined.
    const r = await org.post(`/dugnad/${id}/announcements`, { title: 'Meeting point moved', message: 'Now by the gate', notify: '1' });
    assert.equal(r.status, 302);
    const said = (u) => got(u, id).filter((n) => /Meeting point moved/.test(n.body));
    assert.equal(said(ann).length, 1);
    assert.equal(said(ben).length, 0);
    assert.equal(said(cat).length, 0);
    assert.equal(said(dan).length, 0);
    assert.equal(said(organiser).length, 0);
    assert.ok(h.mails.some((m) => m.includes(ann.email) && m.includes('News about Announce')));
    // Without the notify box nobody is told; editing never sends another.
    await org.post(`/dugnad/${id}/announcements`, { title: 'Quiet note', message: 'No ping' });
    assert.equal(got(ann, id).filter((n) => /Quiet note/.test(n.body)).length, 0);
    const aid = db.prepare('SELECT id FROM dugnad_announcements WHERE title = ?').get('Meeting point moved').id;
    db.prepare("UPDATE dugnad_announcements SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(aid);
    await org.post(`/dugnad/${id}/announcements/${aid}/edit`, { title: 'Meeting point moved', message: 'Now by the other gate' });
    assert.equal(said(ann).length, 1);
    // Readers see them newest first, with the edit marked.
    const page = (await a.get(`/dugnad/${id}`)).text;
    assert.ok(page.indexOf('Quiet note') < page.indexOf('Meeting point moved'));
    assert.match(page, /edited/);
    // Only the organiser publishes; an empty one is refused.
    assert.equal((await a.post(`/dugnad/${id}/announcements`, { title: 'Fake', message: 'x', notify: '1' })).status, 403);
    await org.post(`/dugnad/${id}/announcements`, { title: '', message: '' });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dugnad_announcements WHERE event_id = ?').get(id).c, 2);
    await org.post(`/dugnad/${id}/announcements/${aid}/delete`);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dugnad_announcements WHERE event_id = ?').get(id).c, 1);
  });

  test('cancelling tells everyone waiting or signed up, once, and not the organiser', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Rained off' }, when: { max_participants: '2' } });
    await Promise.all([a, b, c].map((x) => x.post(`/dugnad/${id}/join`)));
    await c.post(`/dugnad/${id}/leave`);
    await org.post(`/dugnad/${id}/cancel`);
    const told = (u) => got(u, id).filter((n) => /was cancelled/.test(n.body)).length;
    assert.equal(told(ann), 1);
    assert.equal(told(ben), 1, 'the waitlisted neighbour');
    assert.equal(told(cat), 0, 'withdrawn');
    assert.equal(told(organiser), 0);
    await org.post(`/dugnad/${id}/cancel`);
    assert.equal(told(ann), 1, 'cancelling twice does not repeat it');
  });

  test('changing the date, time or place notifies participants; other edits stay quiet', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Moving day' } });
    await a.post(`/dugnad/${id}/join`);
    const changed = () => got(ann, id).filter((n) => /Details changed/.test(n.body)).length;
    await org.post(`/dugnad/${id}/edit/1`, { title: 'Moving day', host_name: 'Hosty', category: 'cleanup', visibility: 'hood', description: 'A better description', go: 'save' });
    assert.equal(changed(), 0);
    await org.post(`/dugnad/${id}/edit/2`, { event_date: days(8), start_time: '11:00', location_name: 'Courtyard', go: 'save' });
    assert.equal(changed(), 1);
    await org.post(`/dugnad/${id}/edit/2`, { event_date: days(8), start_time: '11:00', location_name: 'Courtyard', go: 'save' });
    assert.equal(changed(), 1, 'saving without changes does not notify');
    assert.equal(got(organiser, id).filter((n) => /Details changed/.test(n.body)).length, 0);
  });

  test('invitations are sent once, when the dugnad is published', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Invite party' }, publish: false });
    await org.post(`/dugnad/${id}/edit/3`, { registration_required: '1', allow_leave: '1', invites: [String(ann.id), String(ben.id)] });
    assert.equal(got(ann, id).length, 0, 'nothing is sent for a draft');
    await org.post(`/dugnad/${id}/publish`);
    assert.equal(got(ann, id).filter((n) => /invited you/.test(n.body)).length, 1);
    await org.post(`/dugnad/${id}/edit/3`, { registration_required: '1', allow_leave: '1', invites: [String(ann.id), String(cat.id)] });
    assert.equal(got(ann, id).filter((n) => /invited you/.test(n.body)).length, 1, 'no repeat for the same person');
    assert.equal(got(cat, id).filter((n) => /invited you/.test(n.body)).length, 1, 'a new invitee is told');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dugnad_invites WHERE event_id = ? AND user_id = ?').get(id, ben.id).c, 0, 'un-ticked people are no longer invited');
  });

  test('task assignments and offers reach the right person', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Tasks note' } });
    await org.post(`/dugnad/${id}/tasks`, { title: 'Hedge', volunteers_needed: '1' });
    const t = db.prepare('SELECT id FROM dugnad_tasks WHERE event_id = ?').get(id).id;
    await a.post(`/dugnad/${id}/join`);
    await b.post(`/dugnad/${id}/join`);
    await a.post(`/dugnad/${id}/tasks/${t}/volunteer`);
    assert.ok(got(organiser, id).some((n) => /Ann Neighbour volunteered for "Hedge"/.test(n.body)));
    assert.equal(got(ben, id).filter((n) => /Hedge/.test(n.body)).length, 0);
    await a.post(`/dugnad/${id}/tasks/${t}/withdraw`);
    assert.ok(got(organiser, id).some((n) => /dropped out of "Hedge"/.test(n.body)));
  });

  test('a notification to a person who no longer exists fails quietly', () => {
    assert.doesNotThrow(() => dn.notifyAll([987654], (x) => x.t('dugnad.n_completed', { title: 'x' }), '/dugnad/1'));
  });

  test('completing tells the people who were registered', async () => {
    const id = await h.createEvent(org, { basics: { title: 'All done' } });
    await a.post(`/dugnad/${id}/join`);
    await org.post(`/dugnad/${id}/complete`, { confirm: '1' });
    assert.ok(got(ann, id).some((n) => /is completed\. Thank you/.test(n.body)));
    assert.equal(got(dan, id).length, 0);
  });
});

describe('reminders', () => {
  const sent = (u, id, re) => got(u, id).filter((n) => re.test(n.body)).length;

  test('one a day before and one a few hours before, each sent once to those registered', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Reminder day' }, when: { event_date: days(10), start_time: '10:00', end_time: '12:00' } });
    await a.post(`/dugnad/${id}/join`);
    const dayBefore = { date: days(9), time: '08:00' };
    assert.equal(dn.runReminders({ date: days(5), time: '08:00' }), 0, 'too early');
    const first = dn.runReminders(dayBefore);
    assert.equal(first, 2, 'organiser and Ann');
    assert.equal(dn.runReminders(dayBefore), 0, 'not repeated');
    assert.equal(sent(ann, id, /Tomorrow: "Reminder day"/), 1);
    assert.equal(sent(dan, id, /Reminder day/), 0, 'only people who are going');
    // A neighbour who joins late still gets theirs once.
    await b.post(`/dugnad/${id}/join`);
    dn.runReminders({ date: days(9), time: '20:00' });
    dn.runReminders({ date: days(9), time: '21:00' });
    assert.equal(sent(ben, id, /Tomorrow/), 1);
    assert.equal(sent(ann, id, /Tomorrow/), 1);
    // On the day: not too early, then once, and not after it has started.
    assert.equal(dn.runReminders({ date: days(10), time: '05:00' }), 0);
    dn.runReminders({ date: days(10), time: '07:30' });
    dn.runReminders({ date: days(10), time: '08:30' });
    assert.equal(sent(ann, id, /Today at 10:00/), 1);
    dn.runReminders({ date: days(10), time: '10:30' });
    assert.equal(sent(ann, id, /Today at/), 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dugnad_reminders WHERE event_id = ? AND user_id = ?').get(id, ann.id).c, 2);
  });

  test('cancelled and draft events send no reminders', async () => {
    const cancelled = await h.createEvent(org, { basics: { title: 'Never mind' }, when: { event_date: days(20) } });
    await a.post(`/dugnad/${cancelled}/join`);
    await org.post(`/dugnad/${cancelled}/cancel`);
    const draft = await h.createEvent(org, { basics: { title: 'Still a draft' }, when: { event_date: days(20) }, publish: false });
    dn.runReminders({ date: days(19), time: '09:00' });
    assert.equal(sent(ann, cancelled, /Tomorrow/), 0);
    assert.equal(sent(organiser, draft, /Tomorrow/), 0);
  });

  test('a registration deadline reminder goes to invited people who have not signed up', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Deadline soon' }, when: { event_date: days(30), registration_deadline: days(25) }, publish: false });
    await org.post(`/dugnad/${id}/edit/3`, { registration_required: '1', allow_leave: '1', invites: [String(ann.id), String(ben.id)] });
    await org.post(`/dugnad/${id}/publish`);
    await a.post(`/dugnad/${id}/join`);
    dn.runReminders({ date: days(24), time: '09:00' });
    dn.runReminders({ date: days(24), time: '10:00' });
    assert.equal(sent(ben, id, /by tomorrow/), 1);
    assert.equal(sent(ann, id, /by tomorrow/), 0, 'already signed up');
    assert.equal(sent(dan, id, /by tomorrow/), 0, 'not invited');
  });
});
