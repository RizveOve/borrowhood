// One-click demo login for presentations.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { seedDemo } = require('../src/seed');

const { db } = h;
before(() => h.start());
after(() => h.stop());
afterEach(() => { delete process.env.DEMO_LOGIN; });

test('no demo data: no demo buttons, and the demo login is refused', async () => {
  const c = new h.Client();
  assert.doesNotMatch((await c.get('/')).text, /action="\/demo-login"/);
  assert.doesNotMatch((await c.get('/login')).text, /action="\/demo-login"/);
  assert.equal((await c.post('/demo-login', { as: 'kari' })).status, 404);
});

test('with demo data, one click on the landing page signs in as Kari', async () => {
  seedDemo();
  const c = new h.Client();
  const landing = (await c.get('/')).text;
  assert.match(landing, /Try the demo as Kari/);
  for (const name of ['Ola Hansen', 'Amira Haddad', 'Jonas Berg', 'Lin Chen']) assert.match(landing, new RegExp(name));
  assert.match((await c.get('/login')).text, /Try the demo as Kari/);

  const r = await c.post('/demo-login', { as: 'kari' });
  assert.equal(r.location, '/items');
  const kari = db.prepare("SELECT id FROM users WHERE email = 'kari@example.com'").get();
  assert.match((await c.get('/me')).text, /Kari Nordmann/);
  assert.equal((await c.get('/login')).location, '/items');
  assert.ok(kari);
});

test('works even if someone changed the demo password', async () => {
  db.prepare("UPDATE users SET password_hash = 'x' WHERE email = 'jonas@example.com'").run();
  const c = new h.Client();
  assert.equal((await c.post('/demo-login', { as: 'jonas' })).location, '/items');
  assert.match((await c.get('/me')).text, /Jonas Berg/);
});

test('only the fixed demo accounts can be used: not other users, emails or the admin', async () => {
  const hood = h.hood('Real');
  const real = h.user('Real Person', hood);
  const c = new h.Client();
  for (const as of [real.email, String(real.id), 'admin', 'kari@example.com', '']) {
    assert.equal((await c.post('/demo-login', { as })).status, 404, as);
  }
  assert.equal((await c.get('/me')).status, 302); // still signed out
});

test('DEMO_LOGIN=0 hides and turns off the demo login', async () => {
  process.env.DEMO_LOGIN = '0';
  const c = new h.Client();
  assert.doesNotMatch((await c.get('/')).text, /action="\/demo-login"/);
  assert.equal((await c.post('/demo-login', { as: 'kari' })).status, 404);
});
