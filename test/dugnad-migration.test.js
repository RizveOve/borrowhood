// The first version of Dugnad kept events in a simple table. They must move into the full model intact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const run = (dbPath, code) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], {
  cwd: root, env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8',
});

test('events and sign-ups from the first version are carried over and the old tables are dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-migrate-'));
  const dbPath = path.join(dir, 'old.db');
  try {
    // A database as the first version left it: current schema plus the two old tables with data.
    run(dbPath, "require('./src/db')");
    run(dbPath, `
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(process.env.DB_PATH);
      d.exec(\`
        DROP TABLE dugnad_participants;
        DROP TABLE dugnad_events;
        INSERT INTO neighbourhoods (id, name, join_code) VALUES (1, 'Old hood', 'OLD1');
        INSERT INTO users (id, email, name, password_hash, neighbourhood_id) VALUES (1, 'a@x.no', 'Ada', 'x', 1), (2, 'b@x.no', 'Bo', 'x', 1);
        CREATE TABLE dugnads (id INTEGER PRIMARY KEY, neighbourhood_id INTEGER, host_id INTEGER NOT NULL, host_name TEXT NOT NULL,
          title TEXT NOT NULL, event_date TEXT NOT NULL, event_time TEXT NOT NULL, capacity INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE dugnad_signups (dugnad_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (dugnad_id, user_id));
        INSERT INTO dugnads (id, neighbourhood_id, host_id, host_name, title, event_date, event_time, capacity) VALUES (7, 1, 1, 'Ada A', 'Old clean-up', '2099-05-01', '10:30', 12);
        INSERT INTO dugnad_signups (dugnad_id, user_id) VALUES (7, 1), (7, 2);
      \`);
    `);
    // Opening it with the new code migrates it.
    const out = run(dbPath, `
      const { db } = require('./src/db');
      const e = db.prepare('SELECT * FROM dugnad_events').all();
      const p = db.prepare("SELECT user_id, registration_status FROM dugnad_participants ORDER BY user_id").all();
      const old = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('dugnads', 'dugnad_signups')").all();
      console.log(JSON.stringify({ e, p, old, templates: db.prepare('SELECT COUNT(*) AS c FROM dugnad_checklist_templates').get().c }));
    `);
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.e.length, 1);
    assert.deepEqual([r.e[0].id, r.e[0].title, r.e[0].host_name, r.e[0].organizer_id, r.e[0].event_date, r.e[0].start_time, r.e[0].max_participants, r.e[0].status, r.e[0].neighbourhood_id],
      [7, 'Old clean-up', 'Ada A', 1, '2099-05-01', '10:30', 12, 'published', 1]);
    assert.deepEqual(r.p.map((x) => [x.user_id, x.registration_status]), [[1, 'registered'], [2, 'registered']]);
    assert.deepEqual(r.old, []);
    assert.equal(r.templates, 5);
    // Running it again is harmless.
    const again = JSON.parse(run(dbPath, "const { db } = require('./src/db'); console.log(JSON.stringify(db.prepare('SELECT COUNT(*) AS c FROM dugnad_events').get()))").trim().split('\n').pop());
    assert.equal(again.c, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
