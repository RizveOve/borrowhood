// Netlify build step: copies the stock photos into public/stock so the CDN serves them.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'public', 'stock');
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'seed', 'photos'))) {
  if (f.endsWith('.jpg')) fs.copyFileSync(path.join(root, 'seed', 'photos', f), path.join(dest, f));
}
console.log('Copied stock photos to public/stock');
