// Equipment planner, checklist templates, loans, community requests and offers.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const dn = require('../src/dugnad');

const { db, days } = h;
let hood, organiser, owner1, owner2, bystander, org, o1, o2, by;

before(async () => {
  await h.start();
  hood = h.hood('Equipment hood');
  organiser = h.user('Olive Organiser', hood);
  owner1 = h.user('Rake Owner', hood);
  owner2 = h.user('Second Owner', hood);
  bystander = h.user('Bystander', hood);
  [org, o1, o2, by] = await Promise.all([organiser, owner1, owner2, bystander].map((u) => new h.Client().login(u.email)));
});
after(() => h.stop());

const loans = (itemId) => db.prepare('SELECT * FROM loans WHERE item_id = ?').all(itemId);
const addReq = async (id, body = {}) => {
  await org.post(`/dugnad/${id}/equipment`, { equipment_name: 'Garden rake', quantity_needed: '1', ...body });
  return db.prepare('SELECT id FROM dugnad_equipment_requirements WHERE event_id = ? ORDER BY id DESC').get(id).id;
};
const state = (id, rid) => dn.requirementsOf(dn.getEvent(id), null).find((r) => r.id === rid);
const ask = (id, rid, itemId, extra = {}) => org.post(`/dugnad/${id}/equipment/${rid}/request`, { item_id: String(itemId), start_date: days(7), end_date: days(7), ...extra });
const approve = (client, loanId) => client.post(`/loans/${loanId}/approve`);

describe('equipment requirements and templates', () => {
  test('requirements are validated and tied to the event and its tasks', async () => {
    const id = await h.createEvent(org);
    await org.post(`/dugnad/${id}/tasks`, { title: 'Garden', volunteers_needed: '1' });
    const task = db.prepare('SELECT id FROM dugnad_tasks WHERE event_id = ?').get(id).id;
    for (const bad of [{ equipment_name: '' }, { quantity_needed: '0' }, { quantity_needed: '-3' }, { quantity_needed: 'two' }, { needed_from: days(5), needed_until: days(2) }]) {
      await org.post(`/dugnad/${id}/equipment`, { equipment_name: 'Spade', quantity_needed: '2', ...bad });
    }
    assert.equal(dn.requirementsOf(dn.getEvent(id), null).length, 0);
    const rid = await addReq(id, { equipment_name: 'Spade', quantity_needed: '2', essential: 'optional', task_id: String(task), description: 'Sharp ones' });
    const r = db.prepare('SELECT * FROM dugnad_equipment_requirements WHERE id = ?').get(rid);
    assert.deepEqual([r.event_id, r.task_id, r.quantity_needed, r.essential, r.status], [id, task, 2, 0, 'needed']);
    // Another event's task id is ignored rather than linking across events.
    const other = await h.createEvent(org);
    await org.post(`/dugnad/${other}/equipment`, { equipment_name: 'Hose', quantity_needed: '1', task_id: String(task) });
    assert.equal(db.prepare('SELECT task_id FROM dugnad_equipment_requirements WHERE event_id = ?').get(other).task_id, null);
    assert.equal((await by.post(`/dugnad/${id}/equipment`, { equipment_name: 'X', quantity_needed: '1' })).status, 403);
  });

  test('a checklist copies its items; later changes to the template never change the event', async () => {
    const id = await h.createEvent(org);
    const r = await org.post(`/dugnad/${id}/equipment/template`, { category: 'cleanup', next: 'edit5' });
    assert.equal(r.status, 302);
    let reqs = dn.requirementsOf(dn.getEvent(id), null);
    assert.deepEqual(reqs.map((x) => x.equipment_name).sort(), ['Brooms', 'Litter pickers', 'Rakes', 'Safety vests', 'Trash bags', 'Work gloves']);
    assert.ok(reqs.every((x) => x.state === 'needed' || x.state === 'available'), 'nothing is assumed to be available or secured');
    assert.equal(reqs.find((x) => x.equipment_name === 'Trash bags').quantity_needed, 10);
    // Adding the same checklist again adds nothing new.
    await org.post(`/dugnad/${id}/equipment/template`, { category: 'cleanup' });
    assert.equal(dn.requirementsOf(dn.getEvent(id), null).length, 6);
    // Change the central template: the event keeps what it had.
    db.prepare("UPDATE dugnad_checklist_template_items SET equipment_name = 'CHANGED', suggested_quantity = 99 WHERE equipment_name = 'Brooms'").run();
    reqs = dn.requirementsOf(dn.getEvent(id), null);
    assert.ok(reqs.some((x) => x.equipment_name === 'Brooms'));
    assert.ok(!reqs.some((x) => x.equipment_name === 'CHANGED'));
    // The five suggested templates exist, and an unknown one is refused.
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dugnad_checklist_templates').get().c, 5);
    await org.post(`/dugnad/${id}/equipment/template`, { category: 'nonsense' });
    assert.equal(dn.requirementsOf(dn.getEvent(id), null).length, 6);
  });

  test('checklist items are edited, marked optional and removed', async () => {
    const id = await h.createEvent(org);
    const rid = await addReq(id, { equipment_name: 'Ladder' });
    await org.post(`/dugnad/${id}/equipment/${rid}/edit`, { equipment_name: 'Tall ladder', quantity_needed: '2', essential: 'optional', status: 'no_longer_needed' });
    const r = state(id, rid);
    assert.deepEqual([r.equipment_name, r.quantity_needed, r.essential, r.state], ['Tall ladder', 2, 0, 'no_longer_needed']);
    await org.post(`/dugnad/${id}/equipment/${rid}/delete`);
    assert.equal(dn.requirementsOf(dn.getEvent(id), null).length, 0);
  });
});

describe('finding equipment and borrowing it through the loan system', () => {
  test('the planner searches the existing library, neighbourhood first', async () => {
    const id = await h.createEvent(org);
    const rid = await addReq(id, { equipment_name: 'Garden rakes' });
    const near = h.item(owner1.id, 'Garden rake', 'steel tines');
    const far = h.item(h.user('Far Away', h.hood('Far hood')).id, 'Leaf rake', '');
    h.item(owner1.id, 'Hammer', 'unrelated');
    const page = (await org.get(`/dugnad/${id}/equipment/${rid}/find`)).text;
    assert.match(page, /Garden rake/);
    assert.match(page, /Leaf rake/);
    assert.doesNotMatch(page, /Hammer/);
    assert.ok(page.indexOf('Garden rake') < page.indexOf('Leaf rake'), 'the neighbourhood item is listed first');
    const results = dn.searchEquipment(dn.getEvent(id), { id: organiser.id, neighbourhood_id: hood }, 'rakes', {});
    assert.deepEqual(results.map((x) => x.id), [near, far]);
    assert.match((await org.get(`/dugnad/${id}/equipment/${rid}/find?q=zzzznothing`)).text, /No matching equipment found/);
    assert.equal((await by.get(`/dugnad/${id}/equipment/${rid}/find`)).status, 403);
  });

  test('the planner marks the item as booked when the owner has already lent it then', async () => {
    const id = await h.createEvent(org);
    const rid = await addReq(id, { equipment_name: 'Wheelbarrow' });
    const wb = h.item(owner1.id, 'Wheelbarrow');
    db.prepare("INSERT INTO loans (item_id, borrower_id, start_date, end_date, status) VALUES (?, ?, ?, ?, 'approved')").run(wb, bystander.id, days(6), days(8));
    assert.match((await org.get(`/dugnad/${id}/equipment/${rid}/find`)).text, /Booked then/);
    const r = await ask(id, rid, wb);
    assert.match(r.location, /error=err\.booked/);
    assert.equal(loans(wb).length, 1);
  });

  test('a loan request uses the existing loan system, is never auto-approved, and is not duplicated', async () => {
    const id = await h.createEvent(org, { basics: { title: 'Rake day' } });
    const rid = await addReq(id, { quantity_needed: '1' });
    const rake = h.item(owner1.id, 'Garden rake');
    assert.equal(state(id, rid).state, 'needed');
    const r = await ask(id, rid, rake, { message: 'Thanks!' });
    assert.match(r.location, /manage/);
    const [loan] = loans(rake);
    assert.equal(loans(rake).length, 1);
    assert.deepEqual([loan.borrower_id, loan.status, loan.start_date, loan.end_date], [organiser.id, 'pending', days(7), days(7)]);
    assert.match(loan.message, /For the dugnad "Rake day"\. Thanks!/);
    const link = db.prepare('SELECT * FROM dugnad_equipment_links WHERE requirement_id = ?').get(rid);
    assert.deepEqual([link.item_id, link.loan_id, link.own], [rake, loan.id, 0]);
    // Not secured just because a request exists.
    assert.equal(state(id, rid).state, 'pending');
    assert.equal(state(id, rid).secured, 0);
    // The owner got the normal notification and sees the loan in the normal place.
    assert.ok(h.notes(owner1.id).some((n) => /wants to borrow/i.test(n.body) || /Garden rake/.test(n.body)));
    assert.match((await o1.get('/loans?tab=lending')).text, /Garden rake/);
    assert.match((await org.get('/loans?tab=borrowing')).text, /For the dugnad “Rake day”/);
    // Asking again for the same item makes no second loan and no second link.
    const again = await ask(id, rid, rake);
    assert.match(again.location, /error=dugnad\.err_linked/);
    assert.equal(loans(rake).length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dugnad_equipment_links WHERE requirement_id = ?').get(rid).c, 1);
    // Only the organiser may ask.
    assert.equal((await by.post(`/dugnad/${id}/equipment/${rid}/request`, { item_id: String(rake), start_date: days(7), end_date: days(7) })).status, 403);
    // Own items cannot be borrowed.
    const mine = h.item(organiser.id, 'My own rake');
    assert.match((await ask(id, rid, mine)).location, /error=err\.own_item/);
    assert.equal(loans(mine).length, 0);
  });

  test('owner approval and rejection are reflected in the planner, without copying loan data', async () => {
    const id = await h.createEvent(org);
    const rid = await addReq(id, { quantity_needed: '1' });
    const rake = h.item(owner1.id, 'Garden rake');
    await ask(id, rid, rake);
    const [loan] = loans(rake);
    assert.equal((await by.post(`/loans/${loan.id}/approve`)).status, 403);
    assert.equal(loans(rake)[0].status, 'pending');
    await approve(o1, loan.id);
    assert.equal(state(id, rid).state, 'approved');
    assert.equal(state(id, rid).links[0].state, 'approved');
    // Rejected instead:
    const rid2 = await addReq(id, { quantity_needed: '1', equipment_name: 'Rake B' });
    const rake2 = h.item(owner2.id, 'Garden rake B');
    await ask(id, rid2, rake2);
    await o2.post(`/loans/${loans(rake2)[0].id}/decline`);
    assert.equal(state(id, rid2).state, 'unavailable');
    assert.equal(state(id, rid2).links[0].state, 'rejected');
    // Cancelling the loan in the loan system shows up too, and the requirement is needed again once unlinked.
    const rid3 = await addReq(id, { quantity_needed: '1', equipment_name: 'Rake C' });
    const rake3 = h.item(owner2.id, 'Garden rake C');
    await ask(id, rid3, rake3);
    await org.post(`/loans/${loans(rake3)[0].id}/cancel`);
    assert.equal(state(id, rid3).links[0].state, 'cancelled');
    await org.post(`/dugnad/${id}/equipment/${rid3}/links/${state(id, rid3).links[0].id}/remove`);
    assert.equal(state(id, rid3).state, 'needed');
    // The loan record itself is still there, untouched by the unlink.
    assert.equal(loans(rake3).length, 1);
  });

  test('partial contributions are not shown as fulfilled', async () => {
    const id = await h.createEvent(org);
    const rid = await addReq(id, { quantity_needed: '3', equipment_name: 'Rakes' });
    const a = h.item(owner1.id, 'Rake one');
    const b = h.item(owner2.id, 'Rake two');
    await ask(id, rid, a);
    await ask(id, rid, b);
    assert.equal(state(id, rid).state, 'pending');
    await approve(o1, loans(a)[0].id);
    assert.equal(state(id, rid).state, 'partial');
    assert.equal(state(id, rid).secured, 1);
    await approve(o2, loans(b)[0].id);
    assert.equal(state(id, rid).state, 'partial');
    assert.equal(state(id, rid).secured, 2);
    // The third comes from the organiser's own shed.
    const own = h.item(organiser.id, 'Own rake');
    await org.post(`/dugnad/${id}/equipment/${rid}/own`, { item_id: String(own) });
    assert.equal(state(id, rid).state, 'approved');
    assert.equal(state(id, rid).secured, 3);
    assert.equal(loans(own).length, 0);
    // Somebody else's item cannot be claimed as "mine".
    const notMine = h.item(owner1.id, 'Not mine');
    await org.post(`/dugnad/${id}/equipment/${rid}/own`, { item_id: String(notMine) });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM dugnad_equipment_links WHERE item_id = ?').get(notMine).c, 0);
  });

  test('removing a requirement never cancels a loan without confirmation, and then leaves it alone', async () => {
    const id = await h.createEvent(org);
    const rid = await addReq(id);
    const rake = h.item(owner1.id, 'Garden rake');
    await ask(id, rid, rake);
    await org.post(`/dugnad/${id}/equipment/${rid}/delete`);
    assert.equal(dn.requirementsOf(dn.getEvent(id), null).length, 1, 'blocked until confirmed');
    await org.post(`/dugnad/${id}/equipment/${rid}/delete`, { confirm: '1' });
    assert.equal(dn.requirementsOf(dn.getEvent(id), null).length, 0);
    assert.equal(loans(rake)[0].status, 'pending', 'the loan request is still there');
  });

  test('completing or cancelling a dugnad leaves equipment loans running', async () => {
    const id = await h.createEvent(org);
    const rid = await addReq(id);
    const rake = h.item(owner1.id, 'Garden rake');
    await ask(id, rid, rake);
    await approve(o1, loans(rake)[0].id);
    await org.post(`/dugnad/${id}/complete`, { confirm: '1', summary: 'Done' });
    assert.equal(loans(rake)[0].status, 'approved');
    assert.equal(loans(rake).length, 1);
    const id2 = await h.createEvent(org);
    const rid2 = await addReq(id2);
    const rake2 = h.item(owner2.id, 'Garden rake 2');
    await ask(id2, rid2, rake2);
    await org.post(`/dugnad/${id2}/cancel`);
    assert.equal(loans(rake2)[0].status, 'pending');
  });

  test('the existing item request still works as before', async () => {
    const thing = h.item(owner1.id, 'Plain drill');
    const r = await by.post(`/items/${thing}/request`, { start_date: days(2), end_date: days(3), message: 'hi' });
    assert.match(r.location, /\/loans/);
    assert.equal(loans(thing)[0].status, 'pending');
    const bad = await by.post(`/items/${thing}/request`, { start_date: days(2), end_date: days(3) });
    assert.match(bad.location, /error=err\.dup/);
    assert.equal(loans(thing).length, 1);
    assert.match((await by.get(`/items/${thing}`)).text, /Plain drill/);
    assert.equal((await by.get('/items')).status, 200);
  });
});

describe('community equipment requests and offers', () => {
  const makeRequest = async (id, body = {}) => {
    await org.post(`/dugnad/${id}/requests`, { equipment_name: 'Wheelbarrow', quantity_needed: '2', needed_from: days(7), needed_until: days(7), instructions: 'By the shed', ...body });
    return db.prepare('SELECT id FROM dugnad_equipment_requests WHERE event_id = ? ORDER BY id DESC').get(id).id;
  };
  const rq = (id, qid) => dn.requestsOf(dn.getEvent(id), { id: organiser.id }).find((q) => q.id === qid);

  test('an organiser publishes a request that neighbours can see, and edit or close it', async () => {
    const id = await h.createEvent(org);
    const qid = await makeRequest(id);
    assert.match((await by.get(`/dugnad/${id}`)).text, /Wheelbarrow/);
    assert.equal(rq(id, qid).state, 'open');
    await org.post(`/dugnad/${id}/requests/${qid}/edit`, { equipment_name: 'Wheelbarrow', quantity_needed: '3', instructions: 'By the shed' });
    assert.equal(rq(id, qid).quantity_needed, 3);
    assert.equal((await by.post(`/dugnad/${id}/requests/${qid}/cancel`)).status, 403);
    await org.post(`/dugnad/${id}/requests/${qid}/cancel`);
    assert.equal(rq(id, qid).state, 'cancelled');
    assert.doesNotMatch((await by.get(`/dugnad/${id}`)).text, /Wheelbarrow/);
    // Validation
    await org.post(`/dugnad/${id}/requests`, { equipment_name: 'Hose', quantity_needed: '0' });
    assert.equal(dn.requestsOf(dn.getEvent(id), { id: 0 }).length, 1);
  });

  test('offers go through the loan system and a request is only fulfilled by confirmed contributions', async () => {
    const id = await h.createEvent(org);
    const qid = await makeRequest(id, { quantity_needed: '2' });
    const wb1 = h.item(owner1.id, 'Wheelbarrow red');
    const wb2 = h.item(owner2.id, 'Wheelbarrow blue');
    // Offering means picking one of your own items.
    assert.match((await o1.follow(await o1.post(`/dugnad/${id}/requests/${qid}/offer`, { item_id: String(wb2), next: 'event' }))).text, /not one of your items/);
    await o1.post(`/dugnad/${id}/requests/${qid}/offer`, { item_id: String(wb1), message: 'Happy to help' });
    assert.equal(rq(id, qid).state, 'offers');
    assert.ok(h.notes(organiser.id).some((n) => /offered Wheelbarrow red/.test(n.body)));
    assert.equal(loans(wb1).length, 0, 'an offer alone creates no loan');
    // The same item cannot be offered twice; the organiser cannot offer to themselves.
    await o1.post(`/dugnad/${id}/requests/${qid}/offer`, { item_id: String(wb1) });
    assert.equal(rq(id, qid).offers.length, 1);
    await org.post(`/dugnad/${id}/requests/${qid}/offer`, { item_id: String(h.item(organiser.id, 'Mine')) });
    assert.equal(rq(id, qid).offers.length, 1);
    await o2.post(`/dugnad/${id}/requests/${qid}/offer`, { item_id: String(wb2) });
    const [offer1, offer2] = rq(id, qid).offers;
    // Only the organiser turns an offer into a loan request, and the owner still decides.
    assert.equal((await o1.post(`/dugnad/${id}/offers/${offer1.id}/request-loan`)).status, 403);
    await org.post(`/dugnad/${id}/offers/${offer1.id}/request-loan`);
    assert.equal(loans(wb1).length, 1);
    assert.equal(loans(wb1)[0].status, 'pending');
    assert.equal(rq(id, qid).state, 'offers');
    await org.post(`/dugnad/${id}/offers/${offer1.id}/request-loan`);
    assert.equal(loans(wb1).length, 1, 'no second loan');
    await approve(o1, loans(wb1)[0].id);
    assert.equal(rq(id, qid).state, 'partial');
    assert.equal(rq(id, qid).secured, 1);
    await org.post(`/dugnad/${id}/offers/${offer2.id}/request-loan`);
    await approve(o2, loans(wb2)[0].id);
    assert.equal(rq(id, qid).state, 'fulfilled');
    assert.ok(h.notes(owner1.id).length > 0);
  });

  test('an owner can decline, and an offer can be withdrawn', async () => {
    const id = await h.createEvent(org);
    const qid = await makeRequest(id, { quantity_needed: '1' });
    await by.post(`/dugnad/${id}/requests/${qid}/decline`);
    assert.doesNotMatch((await by.get(`/dugnad/${id}`)).text, /Offer<\/button>/);
    assert.equal(rq(id, qid).offers.length, 0);
    const wb = h.item(owner1.id, 'Wheelbarrow green');
    await o1.post(`/dugnad/${id}/requests/${qid}/offer`, { item_id: String(wb) });
    const offer = rq(id, qid).offers[0];
    assert.equal((await o2.post(`/dugnad/${id}/offers/${offer.id}/withdraw`)).status, 404);
    await o1.post(`/dugnad/${id}/offers/${offer.id}/withdraw`);
    assert.equal(rq(id, qid).offers.length, 0);
    assert.equal(rq(id, qid).state, 'open');
  });

  test('an offer linked to a requirement updates the planner from the same loan', async () => {
    const id = await h.createEvent(org);
    const rid = await addReq(id, { equipment_name: 'Wheelbarrow', quantity_needed: '1' });
    await org.post(`/dugnad/${id}/requests`, { equipment_name: 'Wheelbarrow', quantity_needed: '1', requirement_id: String(rid), needed_from: days(7), needed_until: days(7) });
    const qid = db.prepare('SELECT id FROM dugnad_equipment_requests WHERE event_id = ?').get(id).id;
    const wb = h.item(owner1.id, 'Wheelbarrow big');
    await o1.post(`/dugnad/${id}/requests/${qid}/offer`, { item_id: String(wb) });
    await org.post(`/dugnad/${id}/offers/${rq(id, qid).offers[0].id}/request-loan`);
    assert.equal(state(id, rid).state, 'pending');
    await approve(o1, loans(wb)[0].id);
    assert.equal(state(id, rid).state, 'approved');
    assert.equal(rq(id, qid).state, 'fulfilled');
  });
});
