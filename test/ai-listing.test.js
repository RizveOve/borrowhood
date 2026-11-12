// AI listing suggestions from a photo. Claude is replaced by a fake client, so these tests are free and offline.
process.env.AI_HOURLY_LIMIT = '3';
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const ai = require('../src/ai');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const photoForm = (type = 'image/png', data = png) => {
  const f = new FormData();
  f.append('photo', new Blob([data], { type }), 'item.png');
  return f;
};

// Fake Claude: answers with `reply` and remembers each request.
let calls;
let reply;
const fakeCreate = async (params) => {
  calls.push(params);
  if (reply instanceof Error) throw reply;
  return reply;
};
ai.setClient({ messages: { create: fakeCreate }, beta: { messages: { create: fakeCreate } } });
const answer = (json, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text: JSON.stringify(json) }] });

let users;
before(async () => {
  await h.start();
  const hood = h.hood('Alpha');
  users = ['Ada', 'Ben', 'Cy', 'Dee'].map((n) => h.user(n, hood));
});
after(() => h.stop());
beforeEach(() => {
  calls = [];
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('listing suggestions from a photo', () => {
  test('switched off without an API key: no button, and the endpoint does not exist', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const c = await new h.Client().login(users[0].email);
    assert.doesNotMatch((await c.get('/items/new')).text, /data-ai-suggest/);
    assert.equal((await c.postForm('/items/suggest', photoForm())).status, 404);
    assert.equal(calls.length, 0);
  });

  test('suggests a cleaned-up title, a valid category and a description, in the user\'s language', async () => {
    h.db.prepare("UPDATE users SET lang = 'nb' WHERE id = ?").run(users[0].id);
    const c = await new h.Client().login(users[0].email);
    assert.match((await c.get('/items/new')).text, /data-ai-suggest/);
    reply = answer({ is_item: true, title: '  Bosch   batteridrill ', category: 'tools', description: 'Drill med to batterier.' });
    const r = await c.postForm('/items/suggest', photoForm());
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { title: 'Bosch batteridrill', category: 'tools', description: 'Drill med to batterier.' });

    const [req] = calls;
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.fallbacks, 'default');
    assert.deepEqual(req.output_config.format.schema.properties.category.enum, h.util.CAT_KEYS);
    const [image, text] = req.messages[0].content;
    assert.equal(image.source.media_type, 'image/png');
    assert.equal(image.source.data, png.toString('base64'));
    assert.match(text.text, /Norwegian/);
  });

  test('an unknown category falls back to "other", and long text is cut to the form limits', async () => {
    const c = await new h.Client().login(users[1].email);
    reply = answer({ is_item: true, title: 'x'.repeat(200), category: 'spaceships', description: 'y'.repeat(2000) });
    const s = JSON.parse((await c.postForm('/items/suggest', photoForm())).text);
    assert.equal(s.category, 'other');
    assert.equal(s.title.length, 80);
    assert.equal(s.description.length, 1000);
  });

  test('no item in the photo, a refusal or an API error give a friendly message instead of a suggestion', async () => {
    const c = await new h.Client().login(users[2].email);
    reply = answer({ is_item: false, title: '', category: 'other', description: '' });
    let r = await c.postForm('/items/suggest', photoForm());
    assert.equal(r.status, 422);
    assert.match(JSON.parse(r.text).error, /couldn't recognise/);

    reply = { stop_reason: 'refusal', content: [] };
    assert.equal((await c.postForm('/items/suggest', photoForm())).status, 422);

    reply = new Error('overloaded');
    r = await c.postForm('/items/suggest', photoForm());
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.text).error, /aren't available/);
  });

  test('a missing or non-image file is rejected without calling Claude', async () => {
    const c = await new h.Client().login(users[3].email);
    assert.equal((await c.postForm('/items/suggest', new FormData())).status, 400);
    assert.equal((await c.postForm('/items/suggest', photoForm('text/plain', 'hello'))).status, 400);
    assert.equal(calls.length, 0);
  });

  test('each user has an hourly limit, to keep costs down', async () => {
    const c = await new h.Client().login(users[1].email); // already used 1 of 3 above
    reply = answer({ is_item: true, title: 'Ladder', category: 'tools', description: '' });
    assert.equal((await c.postForm('/items/suggest', photoForm())).status, 200);
    assert.equal((await c.postForm('/items/suggest', photoForm())).status, 200);
    const r = await c.postForm('/items/suggest', photoForm());
    assert.equal(r.status, 429);
    assert.equal(calls.length, 2);
  });

  test('logged-out visitors cannot use it', async () => {
    assert.equal((await new h.Client().postForm('/items/suggest', photoForm())).status, 302);
    assert.equal(calls.length, 0);
  });
});
