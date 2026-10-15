// Adds demo data for presentations (two neighbourhoods, five neighbours, items with photos, some loans).
// Usage: npm run seed:demo   (all demo users have password "password123")
const { ensureAdmin } = require('../src/db');
const { seedOrgItems, attachSeedPhotos, seedDemo } = require('../src/seed');

(async () => {
  ensureAdmin();
  await seedOrgItems();
  seedDemo();
  await attachSeedPhotos();
  console.log('Demo data ready.');
  console.log('  Solsiden Borettslag (code DEMO42): kari@ / ola@ / amira@example.com');
  console.log('  Moholt Studentby   (code MOHO24): jonas@ / lin@example.com');
  console.log('  Password for all demo users: password123');
})();
