// Seed content: organisation items for the BorrowHood shelf, and stock photos for seed/demo items.
// Photos live in seed/photos (from Wikimedia Commons, see credits.json) and are copied into
// the normal photo storage (disk, S3 or Netlify Blobs) so they are served like any uploaded photo.
const fs = require('fs');
const path = require('path');
const { db, tx } = require('./db');
const bcrypt = require('bcryptjs');
const { savePhoto } = require('./storage');
const { ROOT } = require('./paths');
const { today, addDays } = require('./util');

const PHOTO_DIR = path.join(ROOT, 'seed', 'photos');
const CREDITS = JSON.parse(fs.readFileSync(path.join(PHOTO_DIR, 'credits.json'), 'utf8'));

const SHELF = 'BorrowHood shelf, community room';
const ORG_ITEMS = [
  { title: 'Cordless drill 18V', category: 'tools', photo: 'cordless-drill', description: 'Drill/driver with two batteries, charger and a basic bit set.' },
  { title: 'Step ladder (4 steps)', category: 'tools', photo: 'step-ladder', description: 'Foldable steel step ladder with handrail. Max 150 kg.' },
  { title: '4-person tent', category: 'outdoor', photo: 'tent', description: 'Easy pitch dome tent with footprint and pegs.' },
  { title: 'Pressure washer', category: 'garden', photo: 'pressure-washer', description: 'For balconies, bikes and garden furniture. 10 m hose included.' },
  { title: 'Carpet & upholstery cleaner', category: 'cleaning', photo: 'carpet-cleaner', description: 'Portable spot cleaner. Bring your own cleaning liquid and empty the tank after use.' },
  { title: 'Folding table + 8 chairs', category: 'party', photo: 'folding-table', description: 'For parties in the common room or courtyard.' },
];

// Title → photo for items created by the seed scripts (older titles included for existing databases).
const TITLE_PHOTOS = {
  ...Object.fromEntries(ORG_ITEMS.map((i) => [i.title, i.photo])),
  'Step ladder 3 m': 'step-ladder',
  'Hammer drill': 'hammer-drill',
  'Bike repair stand': 'bike-stand',
  'Waffle iron': 'waffle-iron',
  'Hiking backpack 60 L': 'backpack',
  'Steam cleaner': 'steam-cleaner',
  'Projector + screen': 'projector',
  'Sewing machine': 'sewing-machine',
  'Camping stove': 'camping-stove',
  'Cross-country skis': 'skis',
  'Cordless hedge trimmer': 'hedge-trimmer',
};

async function seedPhoto(slug) {
  const buffer = await fs.promises.readFile(path.join(PHOTO_DIR, slug + '.jpg'));
  const key = await savePhoto({ buffer, mimetype: 'image/jpeg' });
  const c = CREDITS[slug];
  return { key, credit: `${c.author} · ${c.license}`, source: c.source };
}

async function seedOrgItems() {
  if (process.env.SEED_ORG_ITEMS === '0') return;
  if (db.prepare('SELECT 1 FROM items WHERE is_org = 1').get()) return;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  const photos = [];
  for (const it of ORG_ITEMS) photos.push(await seedPhoto(it.photo));
  const stmt = db.prepare(`INSERT INTO items (owner_id, is_org, title, category, location, description, photo_key, photo_credit, photo_source)
                           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`);
  tx(() => ORG_ITEMS.forEach((it, i) => stmt.run(admin.id, it.title, it.category, SHELF, it.description, photos[i].key, photos[i].credit, photos[i].source)));
  console.log(`[setup] Seeded ${ORG_ITEMS.length} organisation items`);
}

// Gives seed and demo items without a photo their stock photo. Never touches real users' items.
async function attachSeedPhotos() {
  const rows = db.prepare(`SELECT i.id, i.title FROM items i JOIN users u ON u.id = i.owner_id
    WHERE i.photo_key IS NULL AND (i.is_org = 1 OR u.email LIKE '%@example.com')`).all();
  let n = 0;
  for (const r of rows) {
    const slug = TITLE_PHOTOS[r.title];
    if (!slug) continue;
    const p = await seedPhoto(slug);
    db.prepare('UPDATE items SET photo_key = ?, photo_credit = ?, photo_source = ? WHERE id = ?').run(p.key, p.credit, p.source, r.id);
    n++;
  }
  if (n) console.log(`[setup] Added stock photos to ${n} item(s)`);
}

// Demo data for presentations: two neighbourhoods, five neighbours, items and some loans.
// All demo users have the password "password123". Safe to run more than once.
function seedDemo() {
  const t = today();
  const hash = bcrypt.hashSync('password123', 10);
  const hoodId = (code) => db.prepare('SELECT id FROM neighbourhoods WHERE join_code = ?').get(code)?.id;
  const user = (hood, email, name, flat) => Number(db.prepare(
    'INSERT INTO users (email, name, flat, password_hash, neighbourhood_id) VALUES (?, ?, ?, ?, ?)'
  ).run(email, name, flat, hash, hood).lastInsertRowid);
  const item = (owner, title, category, location, description) => Number(db.prepare(
    'INSERT INTO items (owner_id, title, category, location, description) VALUES (?, ?, ?, ?, ?)'
  ).run(owner, title, category, location, description).lastInsertRowid);
  const loan = (itemId, borrower, s, e, status) => db.prepare(
    'INSERT INTO loans (item_id, borrower_id, start_date, end_date, status) VALUES (?, ?, ?, ?, ?)'
  ).run(itemId, borrower, s, e, status);

  if (!hoodId('DEMO42')) {
    tx(() => {
      const hood = Number(db.prepare(`INSERT INTO neighbourhoods (name, kind, city, join_code)
        VALUES ('Solsiden Borettslag', 'borettslag', 'Trondheim', 'DEMO42')`).run().lastInsertRowid);
      const kari = user(hood, 'kari@example.com', 'Kari Nordmann', 'H0201');
      const ola = user(hood, 'ola@example.com', 'Ola Hansen', 'H0305');
      const amira = user(hood, 'amira@example.com', 'Amira Haddad', 'U0102');

      const drill = item(kari, 'Hammer drill', 'tools', 'Flat H0201', 'Makita hammer drill, good for concrete walls. Bits included.');
      const bike = item(ola, 'Bike repair stand', 'sports', 'Bike room, basement', 'Clamp stand plus a basic tool kit.');
      const waffle = item(ola, 'Waffle iron', 'kitchen', 'Flat H0305', 'Heart-shaped, of course.');
      item(amira, 'Hiking backpack 60 L', 'outdoor', 'Flat U0102', 'Rain cover included.');
      item(amira, 'Steam cleaner', 'cleaning', 'Flat U0102', 'Steam mop with handheld unit for tiles and bathrooms.');

      loan(drill, ola, addDays(t, 1), addDays(t, 3), 'pending');
      loan(bike, kari, addDays(t, -2), addDays(t, 1), 'approved'); // due tomorrow → reminder
      loan(waffle, amira, addDays(t, -6), addDays(t, -1), 'approved'); // overdue
      loan(drill, amira, addDays(t, -20), addDays(t, -18), 'returned');
    });
  }

  if (!hoodId('MOHO24')) {
    tx(() => {
      const hood = Number(db.prepare(`INSERT INTO neighbourhoods (name, kind, city, join_code)
        VALUES ('Moholt Studentby', 'student', 'Trondheim', 'MOHO24')`).run().lastInsertRowid);
      const jonas = user(hood, 'jonas@example.com', 'Jonas Berg', 'Block 7, 304');
      const lin = user(hood, 'lin@example.com', 'Lin Chen', 'Block 3, 112');

      const projector = item(jonas, 'Projector + screen', 'electronics', 'Block 7, room 304', 'HDMI projector and a 2 m pull-up screen. Great for movie nights.');
      item(jonas, 'Cross-country skis', 'sports', 'Block 7 ski room', 'Classic skis, 190 cm, boots size 43 and poles.');
      item(lin, 'Sewing machine', 'other', 'Block 3, room 112', 'Old but reliable. Good for hemming trousers and simple repairs.');
      item(lin, 'Camping stove', 'outdoor', 'Block 3, room 112', 'Two-burner gas stove. Gas canister not included.');
      item(lin, 'Cordless hedge trimmer', 'garden', 'Block 3 storage', 'For the shared garden. Battery and charger included.');

      const kari = db.prepare("SELECT id FROM users WHERE email = 'kari@example.com'").get();
      if (kari) loan(projector, kari.id, addDays(t, 3), addDays(t, 4), 'approved');
    });
  }

  seedDemoDugnads(t);
}

// A few upcoming dugnads for the demo neighbourhoods. Dates are relative to today, and they are added
// again whenever the demo users have none left upcoming, so the list is never empty on a demo.
function seedDemoDugnads(t) {
  const upcoming = db.prepare(`SELECT COUNT(*) AS c FROM dugnads d JOIN users u ON u.id = d.host_id
    WHERE u.email LIKE '%@example.com' AND d.event_date >= ?`).get(t).c;
  if (upcoming) return;
  const find = (email) => db.prepare('SELECT id, name, neighbourhood_id FROM users WHERE email = ?').get(email);
  // [host, title, days from today, time, people allowed, other neighbours who have signed up]
  const plan = [
    ['kari@example.com', 'Autumn clean-up of the courtyard', 3, '10:00', 12, ['ola@example.com', 'amira@example.com']],
    ['ola@example.com', 'Paint the bike room', 8, '16:30', 2, ['kari@example.com']], // full
    ['amira@example.com', 'Plant bulbs along the fence', 12, '12:00', 4, ['kari@example.com', 'ola@example.com']],
    ['jonas@example.com', 'Tidy the ski room before winter', 5, '18:00', 8, ['lin@example.com']],
    ['lin@example.com', 'Tidy the shared garden', 15, '11:00', 20, []],
  ];
  tx(() => {
    for (const [host, title, days, time, capacity, joiners] of plan) {
      const h = find(host);
      if (!h) continue;
      const id = Number(db.prepare(`INSERT INTO dugnads (neighbourhood_id, host_id, host_name, title, event_date, event_time, capacity)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(h.neighbourhood_id, h.id, h.name, title, addDays(t, days), time, capacity).lastInsertRowid);
      for (const email of [host, ...joiners]) {
        const u = find(email);
        if (u && u.neighbourhood_id === h.neighbourhood_id) db.prepare('INSERT OR IGNORE INTO dugnad_signups (dugnad_id, user_id) VALUES (?, ?)').run(id, u.id);
      }
    }
  });
}

module.exports = { seedOrgItems, attachSeedPhotos, seedDemo };
