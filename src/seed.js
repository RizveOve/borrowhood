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

// Upcoming dugnads for the demo neighbourhoods, with tasks, equipment needs and a few sign-ups. Dates are
// relative to today, and they are added again whenever the demo users have none left upcoming, so the
// list is never empty on a demo.
function seedDemoDugnads(t) {
  const upcoming = db.prepare(`SELECT COUNT(*) AS c FROM dugnad_events d JOIN users u ON u.id = d.organizer_id
    WHERE u.email LIKE '%@example.com' AND d.status = 'published' AND d.event_date >= ?`).get(t).c;
  if (upcoming) return;
  const find = (email) => db.prepare('SELECT id, name, neighbourhood_id FROM users WHERE email = ?').get(email);
  const plan = [
    { host: 'kari@example.com', title: 'Autumn clean-up of the courtyard', category: 'cleanup', days: 3, start: '10:00', end: '13:00',
      place: 'By the bike room', address: 'Solsiden Borettslag, courtyard', max: 12,
      description: 'Rake leaves, sweep the paths and tidy the shared outdoor furniture before winter. Coffee and buns afterwards.',
      joiners: ['ola@example.com', 'amira@example.com'],
      tasks: [['Rake the leaves', 3, 'high'], ['Sweep the paths', 2, 'normal'], ['Wipe down outdoor furniture', 2, 'low']],
      volunteers: [[0, 'ola@example.com'], [1, 'amira@example.com']],
      equipment: [['Rakes', 3, 1, 0], ['Brooms', 2, 1, 1], ['Trash bags', 10, 0, null], ['Work gloves', 6, 0, null]],
      announce: ['Please bring gloves', 'We have rakes and brooms covered. If you have work gloves, bring a pair.'] },
    { host: 'ola@example.com', title: 'Paint the bike room', category: 'painting', days: 8, start: '16:30', end: '19:30',
      place: 'Bike room, basement', max: 2, approval: 1, description: 'A fresh coat of paint for the bike room. Two painters needed.', joiners: ['kari@example.com'],
      tasks: [['Paint the walls', 2, 'normal']], equipment: [['Paint rollers', 2, 1, null], ['Drop cloths', 2, 1, null]] },
    { host: 'amira@example.com', title: 'Plant bulbs along the fence', category: 'gardening', days: 12, start: '12:00', end: '14:00',
      place: 'The fence by the entrance', max: 4, description: 'Spring bulbs now means colour in April.', joiners: ['kari@example.com', 'ola@example.com'],
      tasks: [['Dig planting holes', 2, 'normal'], ['Plant the bulbs', 2, 'normal']], equipment: [['Spades', 2, 1, null], ['Gardening gloves', 4, 0, null]] },
    { host: 'jonas@example.com', title: 'Tidy the ski room before winter', category: 'shared', days: 5, start: '18:00', end: '20:00',
      place: 'Block 7 ski room', max: 8, description: 'Sort the shared ski room so everyone can find their gear.', joiners: ['lin@example.com'],
      tasks: [['Sort and label shelves', 2, 'normal'], ['Sweep and mop', 1, 'low']], equipment: [['Brooms', 2, 0, null]] },
    { host: 'lin@example.com', title: 'Community dinner in the garden', category: 'gathering', days: 15, start: '17:00', end: '21:00',
      place: 'Shared garden, Block 3', max: 20, private: 1, invite: ['jonas@example.com'], description: 'An invitation-only potluck for the Block 3 neighbours.', joiners: [],
      tasks: [['Set up tables', 3, 'normal']], equipment: [['Folding tables', 3, 1, null], ['Chairs', 10, 1, null]] },
  ];
  tx(() => {
    for (const d of plan) {
      const h = find(d.host);
      if (!h) continue;
      const id = Number(db.prepare(`INSERT INTO dugnad_events (organizer_id, neighbourhood_id, host_name, title, description, category, visibility,
        event_date, start_time, end_time, location_name, location_address, max_participants, approval_required, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`)
        .run(h.id, h.neighbourhood_id, h.name, d.title, d.description, d.category, d.private ? 'private' : 'hood',
          addDays(t, d.days), d.start, d.end, d.place, d.address || null, d.max, d.approval || 0).lastInsertRowid);
      for (const email of [d.host, ...d.joiners]) {
        const u = find(email);
        if (u && u.neighbourhood_id === h.neighbourhood_id) db.prepare("INSERT OR IGNORE INTO dugnad_participants (event_id, user_id, registration_status) VALUES (?, ?, 'registered')").run(id, u.id);
      }
      for (const email of d.invite || []) {
        const u = find(email);
        if (u) db.prepare('INSERT OR IGNORE INTO dugnad_invites (event_id, user_id, invited_by, notified) VALUES (?, ?, ?, 1)').run(id, u.id, h.id);
      }
      const taskIds = d.tasks.map(([title, needed, priority], i) => Number(db.prepare(
        'INSERT INTO dugnad_tasks (event_id, title, volunteers_needed, priority, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, title, needed, priority, i, h.id).lastInsertRowid));
      for (const [n, email] of d.volunteers || []) {
        const u = find(email);
        if (u) db.prepare("INSERT OR IGNORE INTO dugnad_task_assignments (task_id, user_id, assignment_status, assigned_by) VALUES (?, ?, 'assigned', ?)").run(taskIds[n], u.id, h.id);
      }
      for (const [name, qty, essential, task] of d.equipment) {
        db.prepare(`INSERT INTO dugnad_equipment_requirements (event_id, task_id, equipment_name, quantity_needed, essential, needed_from, needed_until)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, task == null ? null : taskIds[task], name, qty, essential, addDays(t, d.days), addDays(t, d.days));
      }
      if (d.announce) db.prepare('INSERT INTO dugnad_announcements (event_id, author_id, title, message) VALUES (?, ?, ?, ?)').run(id, h.id, ...d.announce);
    }
  });

  // An open community request, so neighbours have something to offer to.
  const first = db.prepare("SELECT e.id, e.organizer_id FROM dugnad_events e WHERE e.title = 'Autumn clean-up of the courtyard' ORDER BY e.id DESC LIMIT 1").get();
  if (first) {
    db.prepare(`INSERT INTO dugnad_equipment_requests (event_id, created_by, equipment_name, description, quantity_needed, essential, needed_from, needed_until, instructions)
      VALUES (?, ?, 'Wheelbarrow', 'For carrying leaves to the container', 1, 1, ?, ?, 'Leave it by the bike room, we will return it the same day.')`)
      .run(first.id, first.organizer_id, addDays(t, 3), addDays(t, 3));
  }
}

module.exports = { seedOrgItems, attachSeedPhotos, seedDemo };
