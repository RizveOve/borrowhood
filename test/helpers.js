// Test helpers: boots the real app against a throwaway database and gives each test a "browser".
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
process.env.ADMIN_PASSWORD = 'admin-pass-123';
delete process.env.SES_FROM;
delete process.env.SEED_DEMO;

// Mail is printed to the console when SES is not configured; keep test output readable.
const log = console.log;
const mails = [];
console.log = (...a) => (String(a[0]).startsWith('[mail]') ? mails.push(String(a[0])) : String(a[0]).startsWith('[setup]') ? null : log(...a));

const { app, init } = require('../src/app');
const { db } = require('../src/db');
const util = require('../src/util');

let server;
let base;
async function start() {
  await init();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
}
function stop() {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// Form body; a list (e.g. several invitees) becomes repeated fields, as a browser sends them.
const formBody = (body) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) for (const x of [].concat(v)) p.append(k, x);
  return p;
};

// A cookie-keeping client that does not follow redirects, so tests can see where an action sends you.
class Client {
  constructor() { this.jar = new Map(); }
  async req(method, url, body) {
    const headers = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    const r = await fetch(base + url, { method, redirect: 'manual', headers, body: body ? formBody(body) : undefined });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  }
  // Multipart form (file uploads).
  async postForm(url, form) {
    const headers = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    const r = await fetch(base + url, { method: 'POST', redirect: 'manual', headers, body: form });
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  }
  get(url) { return this.req('GET', url); }
  post(url, body = {}) { return this.req('POST', url, body); }
  // Follows one redirect, as a browser would, to read the flash message and the page it lands on.
  async follow(res) { return this.get(res.location); }
  async login(email) {
    const r = await this.post('/login', { email, password: 'password123' });
    if (r.status !== 302) throw new Error('login failed for ' + email);
    return this;
  }
}

let n = 0;
const hood = (name) => Number(db.prepare('INSERT INTO neighbourhoods (name, join_code) VALUES (?, ?)').run(name, `T${++n}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()).lastInsertRowid);
const hash = bcrypt.hashSync('password123', 4);
const user = (name, hoodId) => {
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${++n}@test.no`;
  const id = Number(db.prepare('INSERT INTO users (email, name, password_hash, neighbourhood_id) VALUES (?, ?, ?, ?)').run(email, name, hash, hoodId).lastInsertRowid);
  return { id, email, name };
};
const item = (ownerId, title, description = '') => Number(db.prepare(
  "INSERT INTO items (owner_id, title, category, location, description) VALUES (?, ?, 'tools', 'Basement', ?)").run(ownerId, title, description).lastInsertRowid);
const notes = (userId) => db.prepare('SELECT body, link FROM notifications WHERE user_id = ? ORDER BY id').all(userId);
const days = (k) => util.addDays(util.today(), k);

// Creates an event through the wizard, the way a person does, and returns its id.
async function createEvent(c, { basics = {}, when = {}, rules = {}, publish = true } = {}) {
  let r = await c.post('/dugnad/create', { title: 'Courtyard day', host_name: 'Hosty', category: 'cleanup', visibility: 'hood', ...basics });
  const id = Number((r.location || '').match(/\/dugnad\/(\d+)\/edit\/2/)?.[1]);
  if (!id) throw new Error('create failed: ' + r.status + ' ' + r.text.slice(0, 200));
  r = await c.post(`/dugnad/${id}/edit/2`, { event_date: days(7), start_time: '10:00', end_time: '12:00', location_name: 'Courtyard', ...when });
  if (r.status !== 302) throw new Error('step 2 failed: ' + r.text.slice(0, 300));
  r = await c.post(`/dugnad/${id}/edit/3`, { registration_required: '1', allow_leave: '1', ...rules });
  if (r.status !== 302) throw new Error('step 3 failed');
  if (publish) {
    r = await c.post(`/dugnad/${id}/publish`);
    if (!/published$/.test(r.location || '')) throw new Error('publish failed: ' + r.location);
  }
  return id;
}

module.exports = { start, stop, Client, db, hood, user, item, notes, days, createEvent, mails, util };
