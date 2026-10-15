// Runs BorrowHood inside Netlify Functions.
//
// Serverless functions have no lasting disk, so the SQLite database file is kept in Netlify Blobs:
//   - a new function instance downloads the latest copy before handling its first request
//   - every request first checks (cheaply, by ETag) whether another instance saved a newer copy
//   - a request that changed data uploads the file again, but only if nobody else saved in the
//     meantime; if someone did, the request is replayed on the newer data so nothing is lost
// This suits a demo or a small community. For heavier traffic, use a hosted database instead.
const fs = require('fs');
const crypto = require('crypto');

const KEY = 'borrowhood.db';

function setDefaults() {
  const env = process.env;
  env.DB_PATH = '/tmp/borrowhood.db'; // working copy; the real copy lives in Blobs
  env.DB_JOURNAL = 'delete';
  env.PHOTO_STORE = 'blobs';
  env.SEED_DEMO ??= '1';
  env.APP_URL ||= env.URL || '';
  env.COOKIE_SECURE ??= (env.URL || '').startsWith('https://') ? '1' : '0';
}

const store = () => require('@netlify/blobs').getStore({ name: 'borrowhood', consistency: 'strong' });

// Which saved copy the local file matches: a version number stored in the blob's metadata, plus the
// blob's ETag for conditional writes (Netlify returns it; the local `netlify dev` emulator does not).
let version = 0;
let etag = null;
let booted = null;

// A random cookie-signing secret, created once and shared by all instances (unless SESSION_SECRET is set).
async function sessionSecret() {
  const existing = await store().get('session-secret');
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  const r = await store().set('session-secret', secret, { onlyIfNew: true });
  return r.modified ? secret : store().get('session-secret');
}

// Fetch the saved copy into the local file. Returns false if nothing has been saved yet.
async function download(db) {
  const remote = await store().getWithMetadata(KEY, { type: 'arrayBuffer' });
  if (!remote) return false;
  const data = Buffer.from(remote.data);
  if (db) db.replaceWith(data);
  else fs.writeFileSync(process.env.DB_PATH, data);
  version = Number(remote.metadata?.version) || 0;
  etag = remote.etag || null;
  return true;
}

// Upload the local file. Returns false if another instance saved a newer copy first.
async function save(db) {
  const next = version + 1;
  const condition = etag ? { onlyIfMatch: etag } : version === 0 ? { onlyIfNew: true } : {};
  const r = await store().set(KEY, db.snapshot(), { metadata: { version: next }, ...condition });
  if (r.modified) {
    version = next;
    etag = r.etag || null;
  }
  return r.modified;
}

// Load a newer copy saved by another instance, if there is one (a cheap metadata check).
async function pull(db) {
  const meta = await store().getMetadata(KEY);
  if (meta && (Number(meta.metadata?.version) || 0) !== version) await download(db);
}

async function boot() {
  setDefaults();
  process.env.SESSION_SECRET ||= await sessionSecret();
  const found = await download();
  const db = require('./db');
  const { app, init } = require('./app');
  const before = db.totalChanges();
  await init();
  // First ever start seeds the database; if another instance beat us to it, use its copy.
  if ((!found || db.totalChanges() > before) && !(await save(db))) await download(db);

  // Express listens on a private port inside the function; requests are forwarded to it.
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { db, port: server.address().port };
}

function ready() {
  booted ||= boot().catch((e) => {
    booted = null;
    throw e;
  });
  return booted;
}

// Run fn against the latest data and save whatever it changed. If another instance saved in the
// meantime, reload its copy and run fn again so neither change is lost.
async function withData(fn) {
  const { db } = await ready();
  for (let attempt = 1; ; attempt++) {
    await pull(db);
    const before = db.totalChanges();
    const result = await fn();
    if (db.totalChanges() === before || (await save(db))) return result;
    if (attempt === 3) {
      console.error('[netlify] could not save changes after 3 attempts');
      return result;
    }
  }
}

const HOP_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'host'];

// Netlify Function (v2) handler: forwards the request to Express and returns its response.
async function handle(req) {
  const { port } = await ready();
  const url = new URL(req.url);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  const headers = new Headers(req.headers);
  HOP_HEADERS.forEach((h) => headers.delete(h));
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

  return withData(async () => {
    const res = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: req.method, headers, body, redirect: 'manual',
    });
    const data = await res.arrayBuffer();
    const out = new Headers(res.headers);
    HOP_HEADERS.forEach((h) => out.delete(h));
    return new Response(req.method === 'HEAD' ? null : data, { status: res.status, headers: out });
  });
}

// Scheduled function: return reminders and overdue alerts.
async function runScheduledReminders() {
  await ready();
  const { runReminders } = require('./jobs');
  const r = await withData(async () => runReminders());
  console.log('[netlify] reminders', r);
}

module.exports = { handle, runScheduledReminders };
