// Demo data for presentations: two neighbourhoods, five neighbours, items with photos and some loans.
// Usage: npm run seed:demo   (all demo users have password "password123")
const bcrypt = require('bcryptjs');
const { db, tx, ensureAdmin } = require('../src/db');
const { seedOrgItems, attachSeedPhotos } = require('../src/seed');
const { today, addDays } = require('../src/util');

(async () => {
  ensureAdmin();
  await seedOrgItems();

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

  await attachSeedPhotos();
  console.log('Demo data ready.');
  console.log('  Solsiden Borettslag (code DEMO42): kari@ / ola@ / amira@example.com');
  console.log('  Moholt Studentby   (code MOHO24): jonas@ / lin@example.com');
  console.log('  Password for all demo users: password123');
})();
