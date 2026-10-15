// Downloads the seed item photos from Wikimedia Commons into seed/photos/ and records credits.
// Only needed when changing the photo list; the downloaded files are committed with the repo.
// Usage: node scripts/fetch-photos.js
const fs = require('fs');
const path = require('path');

const PHOTOS = {
  'cordless-drill': 'File:Cordless electric (screw) drill.jpg',
  'step-ladder': 'File:Step Ladder.jpg',
  'tent': 'File:Dome tent in the BWCA (CDM11452CT).jpg',
  'pressure-washer': 'File:Kawasaki Pressure Washer HPW 302.jpg',
  'carpet-cleaner': 'File:Bissell spot clean pro.jpg',
  'folding-table': 'File:Folding table and chairs, green 2008.jpg',
  'hammer-drill': 'File:Makita HP1501 unloaded.jpg',
  'bike-stand': 'File:Working at a stand, Bicycle Kitchen, Los Angeles.jpg',
  'waffle-iron': 'File:Waffle Maker.jpg',
  'backpack': 'File:A backpack with trekking poles and shoes.jpg',
  'steam-cleaner': 'File:Polti steam mop or portable.jpg',
  'projector': 'File:InFocus IN34.jpg',
  'sewing-machine': 'File:Vesta sewing machine IMGP0718.jpg',
  'camping-stove': 'File:Coleman stove.jpg',
  'skis': 'File:Cross-country skis.jpg',
  'hedge-trimmer': 'File:Cordless electric hedge trimmer 4.jpg',
};

const DIR = path.join(__dirname, '..', 'seed', 'photos');
const UA = { 'User-Agent': 'BorrowHood student project (seed photos)' };
const strip = (s = '') => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const creditsFile = path.join(DIR, 'credits.json');
  const credits = fs.existsSync(creditsFile) ? JSON.parse(fs.readFileSync(creditsFile, 'utf8')) : {};
  for (const [slug, title] of Object.entries(PHOTOS)) {
    if (credits[slug] && fs.existsSync(path.join(DIR, slug + '.jpg'))) continue;
    await new Promise((r) => setTimeout(r, 1500)); // stay polite to the Commons API
    const api = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
      action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '960', format: 'json',
    });
    const page = Object.values((await (await fetch(api, { headers: UA })).json()).query.pages)[0];
    const info = page.imageinfo[0];
    const img = await fetch(info.thumburl || info.url, { headers: UA });
    if (!img.ok) throw new Error(`${slug}: HTTP ${img.status}`);
    fs.writeFileSync(path.join(DIR, slug + '.jpg'), Buffer.from(await img.arrayBuffer()));
    credits[slug] = {
      author: strip(info.extmetadata.Artist?.value) || 'Unknown',
      license: info.extmetadata.LicenseShortName?.value,
      source: info.descriptionurl,
    };
    fs.writeFileSync(creditsFile, JSON.stringify(credits, null, 2) + '\n');
    console.log(`${slug}: ${credits[slug].license} – ${credits[slug].author}`);
  }
})();
