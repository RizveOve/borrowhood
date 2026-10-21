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
