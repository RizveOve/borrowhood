// Seed content: organisation items for the BorrowHood shelf, and stock photos for seed/demo items.
// Photos live in seed/photos (from Wikimedia Commons, see credits.json) and are copied into
// the normal photo storage (local disk or S3) so they are served like any uploaded photo.
const fs = require('fs');
const path = require('path');
const { db, tx } = require('./db');
const { savePhoto } = require('./storage');

const PHOTO_DIR = path.join(__dirname, '..', 'seed', 'photos');
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

module.exports = { seedOrgItems, attachSeedPhotos };
