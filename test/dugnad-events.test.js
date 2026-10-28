// Events, registration, privacy and permissions.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const dn = require('../src/dugnad');

const { db, days } = h;
let hoodA, hoodB, organiser, neighbour, third, outsider;
let org, nei, thr, out;

before(async () => {
  await h.start();
  hoodA = h.hood('Alpha');
  hoodB = h.hood('Beta');
  organiser = h.user('Olive Organiser', hoodA);
  neighbour = h.user('Nina Neighbour', hoodA);
  third = h.user('Thor Third', hoodA);
  outsider = h.user('Otto Outsider', hoodB);
  org = await new h.Client().login(organiser.email);
  nei = await new h.Client().login(neighbour.email);
  thr = await new h.Client().login(third.email);
  out = await new h.Client().login(outsider.email);
});
after(() => h.stop());

const participants = (id, status) => db.prepare('SELECT user_id FROM dugnad_participants WHERE event_id = ? AND registration_status = ?').all(id, status).map((r) => r.user_id);
const status = (id) => db.prepare('SELECT status FROM dugnad_events WHERE id = ?').get(id).status;

describe('events', () => {
  test('visitors are sent to log in before creating', async () => {
    const r = await new h.Client().get('/dugnad/create');
    assert.equal(r.status, 302);
    assert.match(r.location, /^\/login/);
  });

  test('an authenticated neighbour can create a draft and walk the steps', async () => {
    const id = await h.createEvent(org, { publish: false });
    assert.equal(status(id), 'draft');
    assert.equal((await org.get(`/dugnad/${id}/edit/6`)).status, 200);
  });

  test('required fields are validated', async () => {
    let r = await org.post('/dugnad/create', { title: '', host_name: 'X', category: 'cleanup' });
    assert.equal(r.status, 400);
    assert.match(r.text, /Give the dugnad a name/);
    r = await org.post('/dugnad/create', { title: 'T', host_name: '', category: 'cleanup' });
    assert.match(r.text, /Enter the host name/);
    r = await org.post('/dugnad/create', { title: 'T', host_name: 'X', category: 'nonsense' });
    assert.match(r.text, /Choose a category/);
  });

  test('the date, times and limits are validated', async () => {
    const id = await h.createEvent(org, { publish: false });
    const bad = async (body, text) => {
      const r = await org.post(`/dugnad/${id}/edit/2`, { event_date: days(5), start_time: '10:00', location_name: 'X', ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.text, text);
    };
    await bad({ event_date: '2020-01-01' }, /today or later/);
    await bad({ event_date: 'not-a-date' }, /valid date/);
    await bad({ end_time: '09:00' }, /end time must be after/);
    await bad({ registration_deadline: days(9) }, /deadline cannot be after/);
    await bad({ max_participants: '0' }, /whole number/);
    await bad({ location_url: 'javascript:alert(1)' }, /http/);
  });

  test('a length can stand in for the end time', async () => {
    const id = await h.createEvent(org, { when: { end_time: '', duration_minutes: '90' }, publish: false });
    assert.equal(db.prepare('SELECT end_time FROM dugnad_events WHERE id = ?').get(id).end_time, '11:30');
  });

  test('drafts are private: not discoverable and not openable by others', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Secret draft' }, publish: false });
    assert.doesNotMatch((await nei.get('/dugnad')).text, /Secret draft/);
    assert.equal((await nei.get(`/dugnad/${id}`)).status, 404);
    assert.match((await org.get('/dugnad/my-events')).text, /Secret draft/);
  });

  test('a draft cannot be published without a date or meeting point', async () => {
    let r = await org.post('/dugnad/create', { title: 'Half done', host_name: 'H', category: 'other' });
    const id = Number(r.location.match(/dugnad\/(\d+)/)[1]);
    r = await org.post(`/dugnad/${id}/publish`);
    assert.match(r.location, /edit/);
    assert.equal(status(id), 'draft');
  });

  test('published events appear in discovery, with the details people look for', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Visible dugnad', description: 'Bring a rake' }, when: { max_participants: '8' } });
    const page = (await nei.get('/dugnad')).text;
    assert.match(page, /Visible dugnad/);
    assert.match(page, /1 of 8 registered/);
    assert.match(page, /Hosted by Hosty/);
    assert.match(page, /Courtyard/);
    assert.equal(status(id), 'published');
  });

  test('discovery filters and search narrow the list', async () => {
    await h.createEvent(org, { basics: { title: 'Zebra painting' } });
    assert.match((await nei.get('/dugnad?q=zebra')).text, /Zebra painting/);
    assert.doesNotMatch((await nei.get('/dugnad?q=zebra')).text, /Visible dugnad/);
    assert.match((await org.get('/dugnad?filter=organizing')).text, /Zebra painting/);
    assert.doesNotMatch((await nei.get('/dugnad?filter=organizing')).text, /Zebra painting/);
    assert.match((await nei.get('/dugnad?q=nomatchatall')).text, /No dugnads match/);
  });

  test('events are scoped to the neighbourhood', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Alpha only' } });
    assert.doesNotMatch((await out.get('/dugnad')).text, /Alpha only/);
    assert.equal((await out.get(`/dugnad/${id}`)).status, 404);
    assert.equal((await out.post(`/dugnad/${id}/join`)).status, 404);
  });

  test('the organiser can edit their own event and others cannot', async () => {
    const id = await h.createEvent(org);
    let r = await org.post(`/dugnad/${id}/edit/1`, { title: 'Renamed', host_name: 'Hosty', category: 'gardening', visibility: 'hood', go: 'save' });
    assert.equal(r.status, 302);
    assert.equal(db.prepare('SELECT title FROM dugnad_events WHERE id = ?').get(id).title, 'Renamed');
    for (const attempt of [() => nei.post(`/dugnad/${id}/edit/1`, { title: 'Hacked', host_name: 'x', category: 'other' }), () => nei.get(`/dugnad/${id}/manage`),
      () => nei.post(`/dugnad/${id}/cancel`), () => nei.post(`/dugnad/${id}/complete`, { confirm: '1' }), () => nei.post(`/dugnad/${id}/announcements`, { title: 'a', message: 'b' })]) {
      assert.equal((await attempt()).status, 403);
    }
    assert.equal(db.prepare('SELECT title FROM dugnad_events WHERE id = ?').get(id).title, 'Renamed');
    assert.equal(status(id), 'published');
  });

  test('a cover image can be uploaded and is served; other file types are ignored', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = (type, name, data) => {
      const f = new FormData();
      Object.entries({ title: 'With cover', host_name: 'H', category: 'other', visibility: 'hood' }).forEach(([k, v]) => f.append(k, v));
      f.append('cover', new Blob([data], { type }), name);
      return f;
    };
    let r = await org.postForm('/dugnad/create', form('image/png', 'c.png', png));
    const id = Number(r.location.match(/dugnad\/(\d+)/)[1]);
    const key = db.prepare('SELECT cover_photo_key AS k FROM dugnad_events WHERE id = ?').get(id).k;
    assert.match(key, /^[a-f0-9]{32}\.png$/);
    assert.equal((await org.get(`/photos/${key}`)).status, 200);
    r = await org.postForm('/dugnad/create', form('text/plain', 'x.txt', 'not an image'));
    const id2 = Number(r.location.match(/dugnad\/(\d+)/)[1]);
    assert.equal(db.prepare('SELECT cover_photo_key AS k FROM dugnad_events WHERE id = ?').get(id2).k, null);
  });

  test('cancelled events cannot accept registrations', async () => {
    const id = await h.createEvent(org);
    assert.equal((await org.post(`/dugnad/${id}/cancel`)).status, 302);
    assert.equal(status(id), 'cancelled');
    const r = await nei.post(`/dugnad/${id}/join`, { next: 'event' });
    assert.match((await nei.follow(r)).text, /cancelled/);
    assert.equal(participants(id, 'registered').includes(neighbour.id), false);
  });

  test('completed events keep a history, with summary, and stay out of upcoming', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Finished work' } });
    const r = await org.post(`/dugnad/${id}/complete`, { summary: 'A great turnout', notes: 'Cleared two beds', confirm: '1' });
    assert.equal(r.status, 302);
    assert.equal(status(id), 'completed');
    const done = (await nei.get('/dugnad?filter=completed')).text;
    assert.match(done, /Finished work/);
    assert.doesNotMatch((await nei.get('/dugnad')).text, /Finished work/);
    const page = (await nei.get(`/dugnad/${id}`)).text;
    assert.match(page, /A great turnout/);
    assert.match(page, /Cleared two beds/);
    // Nobody can register for it or change it any more.
    assert.match((await nei.follow(await nei.post(`/dugnad/${id}/join`, { next: 'event' }))).text, /already completed/);
    assert.equal((await org.post(`/dugnad/${id}/edit/1`, { title: 'Nope', host_name: 'x', category: 'other' })).location, `/dugnad/${id}`);
  });

  test('completing needs a confirmation when tasks are unfinished or the date has not come', async () => {
    const id = await h.createEvent(org);
    await org.post(`/dugnad/${id}/tasks`, { title: 'Sweep', volunteers_needed: '1' });
    let r = await org.post(`/dugnad/${id}/complete`, { summary: 'x' });
    assert.equal(status(id), 'published');
    assert.match(r.location, /complete$/);
    r = await org.post(`/dugnad/${id}/complete`, { confirm: '1', leftover: 'cancelled' });
    assert.equal(status(id), 'completed');
    assert.equal(db.prepare('SELECT status FROM dugnad_tasks WHERE event_id = ?').get(id).status, 'cancelled');
  });

  test('my dugnads groups events with the next action', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Wrap me up' } });
    db.prepare('UPDATE dugnad_events SET event_date = ? WHERE id = ?').run(days(-1), id);
    const page = (await org.get('/dugnad/my-events')).text;
    assert.match(page, /Ready to wrap up/);
    assert.match(page, /Complete the event/);
    await nei.post(`/dugnad/${await h.createEvent(org, { basics: { title: 'Nina goes' } })}/join`);
    assert.match((await nei.get('/dugnad/my-events')).text, /Nina goes/);
  });

  test('the completion summary and a missing event give clear pages', async () => {
    assert.equal((await nei.get('/dugnad/99999')).status, 404);
    assert.equal((await nei.get('/dugnad/not-a-number')).status, 404);
  });
});

describe('registration', () => {
  test('a neighbour can join, and the organiser holds the first place', async () => {
    const id = await h.createEvent(org, { when: { max_participants: '5' } });
    assert.deepEqual(participants(id, 'registered'), [organiser.id]);
    const r = await nei.post(`/dugnad/${id}/join`, { next: 'event' });
    assert.match((await nei.follow(r)).text, /You are signed up/);
    assert.deepEqual(participants(id, 'registered').sort(), [organiser.id, neighbour.id].sort());
    assert.equal(dn.getEvent(id).registered, 2);
    assert.equal(dn.spotsLeft(dn.getEvent(id)), 3);
  });

  test('duplicate registrations are prevented', async () => {
    const id = await h.createEvent(org);
    await nei.post(`/dugnad/${id}/join`);
    const r = await nei.post(`/dugnad/${id}/join`, { next: 'event' });
    assert.match((await nei.follow(r)).text, /already signed up/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dugnad_participants WHERE event_id = ? AND user_id = ?').get(id, neighbour.id).c, 1);
  });

  test('approval mode: requests wait for the organiser', async () => {
    const id = await h.createEvent(org, { rules: { approval_required: '1' } });
    await nei.post(`/dugnad/${id}/join`);
    assert.deepEqual(participants(id, 'pending'), [neighbour.id]);
    assert.equal(dn.getEvent(id).registered, 1);
    // Not the neighbour themselves, nor another neighbour, may approve.
    assert.equal((await nei.post(`/dugnad/${id}/participants/${neighbour.id}/approve`)).status, 403);
    await org.post(`/dugnad/${id}/participants/${neighbour.id}/approve`);
    assert.deepEqual(participants(id, 'registered').sort(), [organiser.id, neighbour.id].sort());
    await thr.post(`/dugnad/${id}/join`);
    await org.post(`/dugnad/${id}/participants/${third.id}/reject`);
    assert.deepEqual(participants(id, 'rejected'), [third.id]);
    assert.match((await thr.follow(await thr.post(`/dugnad/${id}/join`, { next: 'event' }))).text, /closed your sign-up/);
  });

  test('participant limits are enforced, with a waiting list that moves up', async () => {
    const id = await h.createEvent(org, { when: { max_participants: '2' } });
    await nei.post(`/dugnad/${id}/join`);
    await thr.post(`/dugnad/${id}/join`);
    assert.deepEqual(participants(id, 'registered').sort(), [organiser.id, neighbour.id].sort());
    assert.deepEqual(participants(id, 'waitlisted'), [third.id]);
    assert.match((await thr.get(`/dugnad/${id}`)).text, /waiting list/i);
    await nei.post(`/dugnad/${id}/leave`);
    assert.deepEqual(participants(id, 'waitlisted'), []);
    assert.ok(participants(id, 'registered').includes(third.id));
    assert.ok(h.notes(third.id).some((n) => /place opened up/.test(n.body)));
  });

  test('the limit cannot be set below the people already registered', async () => {
    const id = await h.createEvent(org);
    await nei.post(`/dugnad/${id}/join`);
    const r = await org.post(`/dugnad/${id}/edit/2`, { event_date: days(7), start_time: '10:00', location_name: 'X', max_participants: '1' });
    assert.equal(r.status, 400);
    assert.match(r.text, /already registered/);
  });

  test('leaving follows the event rules', async () => {
    const open = await h.createEvent(org);
    await nei.post(`/dugnad/${open}/join`);
    await nei.post(`/dugnad/${open}/leave`);
    assert.equal(db.prepare('SELECT registration_status AS s FROM dugnad_participants WHERE event_id = ? AND user_id = ?').get(open, neighbour.id).s, 'withdrawn');
    assert.equal(dn.getEvent(open).registered, 1);
    // They can come back, and the page offers it again.
    assert.match((await nei.get(`/dugnad/${open}`)).text, /Join dugnad/);
    await nei.post(`/dugnad/${open}/join`);
    assert.equal(dn.getEvent(open).registered, 2);

    const locked = await h.createEvent(org, { rules: { allow_leave: '' } });
    await nei.post(`/dugnad/${locked}/join`);
    assert.match((await nei.follow(await nei.post(`/dugnad/${locked}/leave`, { next: 'event' }))).text, /does not allow cancelling/);
    assert.equal(dn.getEvent(locked).registered, 2);

    assert.match((await org.follow(await org.post(`/dugnad/${open}/leave`, { next: 'event' }))).text, /organiser cannot leave/);
  });

  test('registration closes after the deadline, once the event has passed, and when none is needed', async () => {
    const id = await h.createEvent(org);
    db.prepare('UPDATE dugnad_events SET registration_deadline = ? WHERE id = ?').run(days(-1), id);
    assert.match((await nei.follow(await nei.post(`/dugnad/${id}/join`, { next: 'event' }))).text, /deadline has passed/);
    const past = await h.createEvent(org);
    db.prepare('UPDATE dugnad_events SET event_date = ? WHERE id = ?').run(days(-2), past);
    assert.match((await nei.follow(await nei.post(`/dugnad/${past}/join`, { next: 'event' }))).text, /already taken place/);
    const free = await h.createEvent(org, { rules: { registration_required: '', allow_leave: '1' } });
    assert.match((await nei.follow(await nei.post(`/dugnad/${free}/join`, { next: 'event' }))).text, /needs no sign-up/);
  });

  test('the organiser can remove a participant, and attendance is recorded', async () => {
    const id = await h.createEvent(org);
    await nei.post(`/dugnad/${id}/join`);
    await org.post(`/dugnad/${id}/participants/${neighbour.id}/attended`);
    assert.equal(db.prepare('SELECT attendance_status AS a FROM dugnad_participants WHERE event_id = ? AND user_id = ?').get(id, neighbour.id).a, 'attended');
    assert.equal((await nei.post(`/dugnad/${id}/participants/${neighbour.id}/absent`)).status, 403);
    await org.post(`/dugnad/${id}/participants/${neighbour.id}/remove`);
    assert.equal(participants(id, 'registered').includes(neighbour.id), false);
    assert.match((await nei.follow(await nei.post(`/dugnad/${id}/join`, { next: 'event' }))).text, /closed your sign-up/);
    const page = (await nei.get(`/dugnad/${id}`)).text;
    assert.doesNotMatch(page, /Join dugnad/, 'no join button for someone the organiser removed');
    assert.match(page, /closed your sign-up/);
  });

  test('private events respect access restrictions', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Invite only', visibility: 'private' } });
    await org.post(`/dugnad/${id}/edit/3`, { registration_required: '1', allow_leave: '1', invites: String(neighbour.id) });
    assert.match((await nei.get('/dugnad')).text, /Invite only/);
    assert.equal((await nei.get(`/dugnad/${id}`)).status, 200);
    assert.doesNotMatch((await thr.get('/dugnad')).text, /Invite only/);
    assert.equal((await thr.get(`/dugnad/${id}`)).status, 404);
    assert.equal((await thr.post(`/dugnad/${id}/join`)).status, 404);
    await nei.post(`/dugnad/${id}/join`);
    assert.equal(dn.getEvent(id).registered, 2);
  });

  test('the full address and the participant list are only for people who signed up', async () => {
    const id = await h.createEvent(org, { when: { location_address: 'Secret Street 12', location_url: 'https://maps.example.com/x' } });
    let page = (await nei.get(`/dugnad/${id}`)).text;
    assert.doesNotMatch(page, /Secret Street 12/);
    assert.doesNotMatch(page, /maps\.example\.com/);
    assert.doesNotMatch(page, /Olive Organiser<\/span>/);
    assert.match(page, /shown after you sign up/);
    // Being invited is not enough either: the address is for people who signed up.
    await org.post(`/dugnad/${id}/edit/3`, { registration_required: '1', allow_leave: '1', invites: String(neighbour.id) });
    assert.doesNotMatch((await nei.get(`/dugnad/${id}`)).text, /Secret Street 12/);
    await nei.post(`/dugnad/${id}/join`);
    page = (await nei.get(`/dugnad/${id}`)).text;
    assert.match(page, /Secret Street 12/);
    assert.match(page, /Nina Neighbour/);
    assert.doesNotMatch(page, new RegExp(neighbour.email.replace('.', '\\.')));
  });

  test('reports reach the admin the same way as the contact form', async () => {
    const id = await h.createEvent(org);
    const before = db.prepare("SELECT COUNT(*) AS c FROM contact_messages WHERE topic = 'report'").get().c;
    await nei.post(`/dugnad/${id}/report`, { reason: 'This looks like spam to me.' });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM contact_messages WHERE topic = 'report'").get().c, before + 1);
    await nei.post(`/dugnad/${id}/report`, { reason: 'short' });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM contact_messages WHERE topic = 'report'").get().c, before + 1);
  });
});
