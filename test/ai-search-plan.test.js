// AI "describe what you need" search and the AI dugnad planner. Claude is replaced by a fake client.
process.env.AI_HOURLY_LIMIT = '4';
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const ai = require('../src/ai');

const { db } = h;
let calls;
let reply;
const fakeCreate = async (params) => {
  calls.push(params);
  if (reply instanceof Error) throw reply;
  return reply;
};
ai.setClient({ messages: { create: fakeCreate }, beta: { messages: { create: fakeCreate } } });
const answer = (json) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(json) }] });

let hoodA, ola, kari, nina, olaC, kariC, ninaC;
before(async () => {
  await h.start();
  hoodA = h.hood('Alpha');
  ola = h.user('Ola Organiser', hoodA);
  kari = h.user('Kari Lender', hoodA);
  nina = h.user('Nina Neighbour', hoodA);
  h.item(kari.id, 'Cordless drill', 'Bosch, two batteries');
  h.item(kari.id, 'Bormaskin', 'Gammel, men virker');
  h.item(kari.id, 'Garden rake');
  olaC = await new h.Client().login(ola.email);
  kariC = await new h.Client().login(kari.email);
  ninaC = await new h.Client().login(nina.email);
});
after(() => h.stop());
beforeEach(() => {
  calls = [];
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('describe what you need', () => {
  const needs = { understood: true, tip: 'Use wall plugs.', needs: [
    { name: 'Drill', why: 'for the holes', keywords: ['drill', 'bormaskin', 'ab'] },
    { name: 'Stud finder', why: 'to avoid pipes', keywords: ['stud finder', 'detektor'] },
  ] };

  test('switched off without a key: no box on Browse, and the search falls back to a normal search', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.doesNotMatch((await ninaC.get('/items')).text, /action="\/items\/ask"/);
    const r = await ninaC.get('/items/ask?q=hang+a+mirror');
    assert.equal(r.location, '/items?q=hang%20a%20mirror');
    assert.equal(calls.length, 0);
  });

  test('shows each thing Claude suggests with the items neighbours lend, in English and Norwegian', async () => {
    assert.match((await ninaC.get('/items')).text, /action="\/items\/ask"/);
    reply = answer(needs);
    const r = await ninaC.get('/items/ask?q=Hang+a+heavy+mirror');
    assert.equal(r.status, 200);
    assert.match(r.text, /Use wall plugs\./);
    const [drill, stud] = r.text.split('<section class="ask-need">').slice(1);
    assert.match(drill, /Cordless drill/);
    assert.match(drill, /Bormaskin/); // found through the Norwegian search word
    assert.doesNotMatch(drill, /Garden rake/);
    assert.match(stud, /Nobody lends this yet/);
    assert.match(calls[0].messages[0].content, /Hang a heavy mirror/);
  });

  test('asking the same thing again is answered from memory, without paying for another call', async () => {
    const r = await ninaC.get('/items/ask?q=hang%20a%20HEAVY%20mirror');
    assert.match(r.text, /Cordless drill/);
    assert.equal(calls.length, 0);
  });

  test('a message that is not a need, or an API error, gives a friendly message', async () => {
    reply = answer({ understood: false, needs: [], tip: '' });
    assert.match((await ninaC.get('/items/ask?q=hello+there')).text, /couldn’t work out what you need/);
    reply = new Error('overloaded');
    assert.match((await ninaC.get('/items/ask?q=paint+a+bedroom')).text, /aren&#39;t available right now/);
  });

  test('each user has an hourly limit (4 here; Nina has asked 3 new questions above)', async () => {
    reply = answer(needs);
    assert.doesNotMatch((await ninaC.get('/items/ask?q=job+a')).text, /used all/);
    assert.match((await ninaC.get('/items/ask?q=job+b')).text, /used all your AI suggestions/);
    assert.equal(calls.length, 1);
    assert.match((await kariC.get('/items/ask?q=job+b')).text, /Cordless drill/); // other users are not affected
  });
});

describe('dugnad planner', () => {
  let id;
  const plan = {
    notes: 'Bring gloves.',
    tasks: [
      { title: 'Rake leaves', description: 'In the courtyard.', estimated_minutes: 90, volunteers_needed: 4, priority: 'high' },
      { title: 'Clean the bike shed', description: 'Sort and sweep.', estimated_minutes: 9999, volunteers_needed: 0, priority: 'urgent' },
    ],
    equipment: [
      { name: 'Rake', quantity: 4, essential: true, for_task: 'Rake leaves' },
      { name: 'Broom', quantity: 2, essential: false, for_task: 'Something else' },
    ],
  };

  before(async () => { id = await h.createEvent(olaC, { publish: false, basics: { title: 'Autumn clean-up' } }); });

  test('switched off without a key: no planner on the Tasks step', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    assert.doesNotMatch((await olaC.get(`/dugnad/${id}/edit/4`)).text, /ai-plan/);
    assert.equal((await olaC.post(`/dugnad/${id}/ai-plan`)).location, `/dugnad/${id}/edit/4`);
  });

  test('suggests a plan from the event details, with numbers kept in range and matching items counted', async () => {
    assert.match((await olaC.get(`/dugnad/${id}/edit/4`)).text, /action="\/dugnad\/\d+\/ai-plan"/);
    reply = answer(plan);
    const r = await olaC.post(`/dugnad/${id}/ai-plan`, { notes: 'About 12 people' });
    assert.equal(r.status, 200);
    assert.match(r.text, /Bring gloves\./);
    assert.match(r.text, /Rake leaves/);
    assert.match(r.text, /1 in the app/); // Kari's garden rake
    assert.match(r.text, /24 hours|1440 min/); // 9999 minutes is cut to a day
    const sent = calls[0].messages[0].content;
    assert.match(sent, /Autumn clean-up/);
    assert.match(sent, /About 12 people/);
    assert.equal(calls[0].output_config.format.type, 'json_schema');
  });

  test('only the ticked suggestions are added, checked like hand-made ones, and equipment links to its task', async () => {
    const pick = (o) => JSON.stringify(o);
    const r = await olaC.post(`/dugnad/${id}/ai-plan/apply`, {
      task: [pick(plan.tasks[0]), pick({ title: '', volunteers_needed: 1 }), 'not json'],
      equipment: [pick(plan.equipment[0]), pick(plan.equipment[1]), pick({ name: 'rake', quantity: 1 })],
    });
    assert.equal(r.location, `/dugnad/${id}/edit/4`);
    const tasks = db.prepare('SELECT * FROM dugnad_tasks WHERE event_id = ?').all(id);
    assert.deepEqual(tasks.map((t) => [t.title, t.volunteers_needed, t.priority]), [['Rake leaves', 4, 'high']]);
    const reqs = db.prepare('SELECT * FROM dugnad_equipment_requirements WHERE event_id = ? ORDER BY id').all(id);
    assert.deepEqual(reqs.map((q) => [q.equipment_name, q.quantity_needed, q.essential, q.task_id]),
      [['Rake', 4, 1, tasks[0].id], ['Broom', 2, 0, null]]); // the second "rake" is a duplicate
    assert.match((await olaC.follow(r)).text, /Added 1 tasks and 2 equipment items/);
  });

  test('the next plan is told what is already planned', async () => {
    reply = answer({ notes: '', tasks: [], equipment: [] });
    const r = await olaC.post(`/dugnad/${id}/ai-plan`, {});
    assert.match(r.text, /couldn&#39;t suggest a plan/);
    assert.match(calls[0].messages[0].content, /Tasks already planned: Rake leaves/);
    assert.match(calls[0].messages[0].content, /Equipment already on the list: Rake; Broom/);
  });

  test('the planner is easy to find: a pointer on steps 1-3, the card on Tasks and Equipment, a button when managing', async () => {
    for (const step of [1, 2, 3]) assert.match((await olaC.get(`/dugnad/${id}/edit/${step}`)).text, /class="small muted ai-hint"/);
    for (const step of [4, 5]) assert.match((await olaC.get(`/dugnad/${id}/edit/${step}`)).text, new RegExp(`action="/dugnad/${id}/ai-plan"`));
    const published = await h.createEvent(olaC);
    assert.match((await olaC.get(`/dugnad/${published}/manage`)).text, new RegExp(`href="/dugnad/${published}/edit/4#ai-plan"`));
  });

  test('only the organiser can use the planner', async () => {
    assert.equal((await kariC.post(`/dugnad/${id}/ai-plan`)).status, 404); // a draft is invisible to others
    assert.equal((await kariC.post(`/dugnad/${id}/ai-plan/apply`, { task: JSON.stringify(plan.tasks[0]) })).status, 404);
    assert.equal(calls.length, 0);
  });
});
