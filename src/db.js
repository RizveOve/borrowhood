const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { ROOT } = require('./paths');

const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'borrowhood.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// On Netlify the file is copied to and from Blobs, so it must be self-contained (no WAL side files).
const JOURNAL = process.env.DB_JOURNAL === 'delete' ? 'DELETE' : 'WAL';

let conn;
let generation = 0;

// Statements prepared at module load keep working after the connection is reopened (see replaceWith).
function prepare(sql) {
  let stmt;
  let gen = -1;
  const current = () => {
    if (gen !== generation) {
      stmt = conn.prepare(sql);
      gen = generation;
    }
    return stmt;
  };
  return {
    get: (...args) => current().get(...args),
    all: (...args) => current().all(...args),
    run: (...args) => current().run(...args),
  };
}

const db = { prepare, exec: (sql) => conn.exec(sql) };

function open() {
  conn = new DatabaseSync(DB_PATH);
  conn.exec(`PRAGMA journal_mode = ${JOURNAL}; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;`);
  generation++;
  migrate();
}

function migrate() {
  db.exec(`
CREATE TABLE IF NOT EXISTS neighbourhoods (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'apartment',
  city        TEXT,
  join_code   TEXT NOT NULL UNIQUE,
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name             TEXT NOT NULL,
  flat             TEXT,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  neighbourhood_id INTEGER REFERENCES neighbourhoods(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An item is visible in its owner's neighbourhood. Organisation items (is_org = 1)
-- are owned by the admin, visible to every neighbourhood and approved by the admin.
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_org      INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  location    TEXT NOT NULL,
  description TEXT,
  photo_key   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  borrower_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'declined', 'cancelled', 'returned')),
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  overdue_sent  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at    TEXT,
  returned_at   TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Photos taken when an item is picked up and when it is handed back, as a record of its condition.
CREATE TABLE IF NOT EXISTS loan_photos (
  id         INTEGER PRIMARY KEY,
  loan_id    INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('pickup', 'return')),
  photo_key  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_loan_photos_loan ON loan_photos(loan_id);
-- Messages sent through the About & contact page; handled by the admin.
CREATE TABLE IF NOT EXISTS contact_messages (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  topic       TEXT NOT NULL CHECK (topic IN ('question', 'problem', 'report', 'feedback')),
  message     TEXT NOT NULL,
  item_id     INTEGER REFERENCES items(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Private conversations between someone interested in an item and its owner.
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER REFERENCES items(id) ON DELETE SET NULL,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asker_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, asker_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  read_at         TEXT
);

-- Dugnad: community work days. Dates and times are plain strings in the app's time zone (see util.js),
-- like loan dates. A draft may be incomplete, so date and time are only required to publish.
-- neighbourhood_id is NULL for events created by the admin (visible to every neighbourhood).
CREATE TABLE IF NOT EXISTS dugnad_events (
  id                    INTEGER PRIMARY KEY,
  organizer_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  neighbourhood_id      INTEGER REFERENCES neighbourhoods(id) ON DELETE CASCADE,
  host_name             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  category              TEXT NOT NULL DEFAULT 'other',
  cover_photo_key       TEXT,
  visibility            TEXT NOT NULL DEFAULT 'hood' CHECK (visibility IN ('hood', 'private')),
  event_date            TEXT,
  start_time            TEXT,
  end_time              TEXT,
  location_name         TEXT,
  location_address      TEXT,
  location_url          TEXT,
  registration_deadline TEXT,
  max_participants      INTEGER CHECK (max_participants IS NULL OR max_participants >= 1),
  registration_required INTEGER NOT NULL DEFAULT 1,
  approval_required     INTEGER NOT NULL DEFAULT 0,
  allow_leave           INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'completed', 'cancelled')),
  equipment_suggested   INTEGER NOT NULL DEFAULT 0,
  completion_summary    TEXT,
  completion_notes      TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at          TEXT
);

CREATE TABLE IF NOT EXISTS dugnad_participants (
  id                  INTEGER PRIMARY KEY,
  event_id            INTEGER NOT NULL REFERENCES dugnad_events(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_status TEXT NOT NULL CHECK (registration_status IN ('pending', 'registered', 'waitlisted', 'withdrawn', 'rejected', 'removed')),
  attendance_status   TEXT CHECK (attendance_status IN ('attended', 'absent')),
  registered_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS dugnad_invites (
  event_id   INTEGER NOT NULL REFERENCES dugnad_events(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notified   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);

-- Open and in progress are stored; "volunteers needed" and "assigned" are worked out from the volunteers.
CREATE TABLE IF NOT EXISTS dugnad_tasks (
  id                INTEGER PRIMARY KEY,
  event_id          INTEGER NOT NULL REFERENCES dugnad_events(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  estimated_minutes INTEGER,
  volunteers_needed INTEGER NOT NULL DEFAULT 1 CHECK (volunteers_needed >= 1),
  required_skills   TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  notes             TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dugnad_task_assignments (
  id                INTEGER PRIMARY KEY,
  task_id           INTEGER NOT NULL REFERENCES dugnad_tasks(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_status TEXT NOT NULL CHECK (assignment_status IN ('pending', 'assigned')),
  assigned_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, user_id)
);

-- What an event needs. Whether it is secured is worked out from the links and their loans.
CREATE TABLE IF NOT EXISTS dugnad_equipment_requirements (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES dugnad_events(id) ON DELETE CASCADE,
  task_id         INTEGER REFERENCES dugnad_tasks(id) ON DELETE SET NULL,
  equipment_name  TEXT NOT NULL,
  description     TEXT,
  quantity_needed INTEGER NOT NULL CHECK (quantity_needed >= 1),
  essential       INTEGER NOT NULL DEFAULT 1,
  needed_from     TEXT,
  needed_until    TEXT,
  status          TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'no_longer_needed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A requirement points at an existing item. A borrowed item has a loan_id: the loan itself (status,
-- dates, owner decision) stays in the loans table. own = 1 when the organiser brings their own item.
CREATE TABLE IF NOT EXISTS dugnad_equipment_links (
  id             INTEGER PRIMARY KEY,
  requirement_id INTEGER NOT NULL REFERENCES dugnad_equipment_requirements(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  loan_id        INTEGER REFERENCES loans(id) ON DELETE SET NULL,
  own            INTEGER NOT NULL DEFAULT 0,
  quantity       INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (requirement_id, item_id)
);

CREATE TABLE IF NOT EXISTS dugnad_equipment_requests (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES dugnad_events(id) ON DELETE CASCADE,
  requirement_id  INTEGER REFERENCES dugnad_equipment_requirements(id) ON DELETE SET NULL,
  created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  equipment_name  TEXT NOT NULL,
  description     TEXT,
  quantity_needed INTEGER NOT NULL CHECK (quantity_needed >= 1),
  essential       INTEGER NOT NULL DEFAULT 1,
  needed_from     TEXT,
  needed_until    TEXT,
  instructions    TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A neighbour offers one of their own listed items, or declines (item_id NULL) to hide the request.
CREATE TABLE IF NOT EXISTS dugnad_equipment_offers (
  id         INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES dugnad_equipment_requests(id) ON DELETE CASCADE,
  offered_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    INTEGER REFERENCES items(id) ON DELETE CASCADE,
  loan_id    INTEGER REFERENCES loans(id) ON DELETE SET NULL,
  message    TEXT,
  status     TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'declined', 'withdrawn')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dugnad_checklist_templates (
  id             INTEGER PRIMARY KEY,
  category       TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  name_nb        TEXT NOT NULL,
  description    TEXT,
  description_nb TEXT
);

CREATE TABLE IF NOT EXISTS dugnad_checklist_template_items (
  id                  INTEGER PRIMARY KEY,
  template_id         INTEGER NOT NULL REFERENCES dugnad_checklist_templates(id) ON DELETE CASCADE,
  equipment_name      TEXT NOT NULL,
  equipment_name_nb   TEXT NOT NULL,
  suggested_quantity  INTEGER NOT NULL DEFAULT 1,
  essential_by_default INTEGER NOT NULL DEFAULT 0,
  sort_order          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dugnad_announcements (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES dugnad_events(id) ON DELETE CASCADE,
  author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per reminder sent, so nobody gets the same reminder twice (including people who join late).
CREATE TABLE IF NOT EXISTS dugnad_reminders (
  event_id INTEGER NOT NULL REFERENCES dugnad_events(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  sent_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_dugnad_events_when ON dugnad_events(status, event_date, start_time);
CREATE INDEX IF NOT EXISTS idx_dugnad_participants_user ON dugnad_participants(user_id, registration_status);
CREATE INDEX IF NOT EXISTS idx_dugnad_tasks_event ON dugnad_tasks(event_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_dugnad_requirements_event ON dugnad_equipment_requirements(event_id);
CREATE INDEX IF NOT EXISTS idx_dugnad_links_loan ON dugnad_equipment_links(loan_id);
CREATE INDEX IF NOT EXISTS idx_dugnad_requests_event ON dugnad_equipment_requests(event_id);
CREATE INDEX IF NOT EXISTS idx_dugnad_announcements_event ON dugnad_announcements(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_hood ON users(neighbourhood_id);
CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_conv_asker ON conversations(asker_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_contact_status ON contact_messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id);
CREATE INDEX IF NOT EXISTS idx_loans_item ON loans(item_id, status);
CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
  `);

  // Lightweight migrations for databases created by earlier versions.
  const itemCols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (!itemCols.includes('photo_credit')) db.exec('ALTER TABLE items ADD COLUMN photo_credit TEXT');
  if (!itemCols.includes('photo_source')) db.exec('ALTER TABLE items ADD COLUMN photo_source TEXT');
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('lang')) db.exec('ALTER TABLE users ADD COLUMN lang TEXT');
  // The borrower confirms pickup and hand-back, each with photos (see loan_photos).
  const loanCols = db.prepare('PRAGMA table_info(loans)').all().map((c) => c.name);
  if (!loanCols.includes('picked_up_at')) db.exec('ALTER TABLE loans ADD COLUMN picked_up_at TEXT');
  if (!loanCols.includes('handed_back_at')) db.exec('ALTER TABLE loans ADD COLUMN handed_back_at TEXT');

  // Dugnads created before equipment was suggested from the name.
  const eventCols = db.prepare('PRAGMA table_info(dugnad_events)').all().map((c) => c.name);
  if (!eventCols.includes('equipment_suggested')) db.exec('ALTER TABLE dugnad_events ADD COLUMN equipment_suggested INTEGER NOT NULL DEFAULT 0');

  migrateFirstDugnads();
  seedChecklistTemplates();
}

// The first version of Dugnad kept one simple table (dugnads) with a sign-up list. Move those events
// into the full model, keeping their ids, and drop the old tables.
function migrateFirstDugnads() {
  const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (!has('dugnads')) return;
  db.exec('BEGIN');
  try {
    db.exec(`INSERT OR IGNORE INTO dugnad_events
        (id, organizer_id, neighbourhood_id, host_name, title, event_date, start_time, max_participants, status, created_at)
      SELECT id, host_id, neighbourhood_id, host_name, title, event_date, event_time, capacity, 'published', created_at FROM dugnads`);
    if (has('dugnad_signups')) {
      db.exec(`INSERT OR IGNORE INTO dugnad_participants (event_id, user_id, registration_status, registered_at)
        SELECT dugnad_id, user_id, 'registered', created_at FROM dugnad_signups`);
      db.exec('DROP TABLE dugnad_signups');
    }
    db.exec('DROP TABLE dugnads');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seedChecklistTemplates() {
  if (db.prepare('SELECT 1 FROM dugnad_checklist_templates LIMIT 1').get()) return;
  const addTemplate = db.prepare('INSERT INTO dugnad_checklist_templates (category, name, name_nb, description, description_nb) VALUES (?, ?, ?, ?, ?)');
  const addItem = db.prepare(`INSERT INTO dugnad_checklist_template_items
    (template_id, equipment_name, equipment_name_nb, suggested_quantity, essential_by_default, sort_order) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const t of require('./dugnad-templates')) {
    const id = Number(addTemplate.run(t.category, t.name, t.name_nb, t.description, t.description_nb).lastInsertRowid);
    t.items.forEach(([en, nb, qty, essential], i) => addItem.run(id, en, nb, qty, essential, i));
  }
}

open();

// Swap in a newer copy of the database (used on Netlify when another instance has saved changes).
function replaceWith(buffer) {
  conn.close();
  fs.writeFileSync(DB_PATH, buffer);
  open();
}

const snapshot = () => fs.readFileSync(DB_PATH);
const totalChanges = () => conn.prepare('SELECT total_changes() AS c').get().c;

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Create the single master admin on first start. If ADMIN_PASSWORD is set, it is also the admin's
// current password: changing the variable (e.g. in Netlify) and restarting resets it.
function ensureAdmin() {
  const admin = db.prepare("SELECT id, password_hash FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (admin) {
    const wanted = process.env.ADMIN_PASSWORD;
    if (wanted && !bcrypt.compareSync(wanted, admin.password_hash)) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(wanted, 10), admin.id);
      console.log('[setup] Admin password reset from ADMIN_PASSWORD');
    }
    return;
  }
  const email = (process.env.ADMIN_EMAIL || 'admin@borrowhood.no').toLowerCase();
  const name = process.env.ADMIN_NAME || 'BorrowHood Admin';
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    console.log(`[setup] No ADMIN_PASSWORD set. Generated admin password: ${password}`);
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
  } else {
    db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run(email, name, bcrypt.hashSync(password, 10));
  }
  console.log(`[setup] Master admin: ${email}`);
}

module.exports = { db, tx, ensureAdmin, replaceWith, snapshot, totalChanges, DB_PATH };
