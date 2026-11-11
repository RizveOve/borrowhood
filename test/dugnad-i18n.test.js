// Every Dugnad text used in the code exists in both languages, so no raw keys show up on a page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DICTS } = require('../src/i18n');

const root = path.join(__dirname, '..');
const used = new Set();
const prefixes = new Set();
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(js|ejs)$/.test(f.name) && !/i18n/.test(f.name)) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/'(dugnad\.[a-z_0-9.]+)'/g)) used.add(m[1]);
      for (const m of s.matchAll(/'(dugnad\.[a-z_0-9]+\.)' \+/g)) prefixes.add(m[1]);
    }
  }
};
walk(path.join(root, 'src'));
walk(path.join(root, 'views'));

test('every static Dugnad key is translated into English and Norwegian', () => {
  const missing = [];
  for (const k of used) {
    if (k.endsWith('.')) continue;
    for (const lang of ['en', 'nb']) if (!DICTS[lang][k]) missing.push(`${lang}:${k}`);
  }
  assert.deepEqual(missing, []);
});

test('the dynamic Dugnad key families are complete', () => {
  const families = {
    'dugnad.cat.': ['cleanup', 'gardening', 'painting', 'repairs', 'snow', 'gathering', 'shared', 'recycling', 'other'],
    'dugnad.reg.': ['open', 'registered', 'pending', 'waitlisted', 'full', 'closed', 'no_registration', 'completed', 'cancelled'],
    'dugnad.status.': ['draft', 'published', 'completed', 'cancelled'],
    'dugnad.status_note.': ['draft', 'completed', 'cancelled'],
    'dugnad.priority.': ['low', 'normal', 'high'],
    'dugnad.task_st.': ['open', 'volunteers_needed', 'assigned', 'in_progress', 'completed', 'cancelled'],
    'dugnad.req.': ['needed', 'available', 'pending', 'approved', 'partial', 'unavailable', 'no_longer_needed'],
    'dugnad.rq.': ['open', 'offers', 'partial', 'fulfilled', 'cancelled'],
    'dugnad.link.': ['own', 'pending', 'approved', 'active', 'returned', 'rejected', 'cancelled'],
    'dugnad.att.': ['attended', 'absent'],
    'dugnad.filter.': require('../src/dugnad').FILTERS,
    'dugnad.step.': ['basics', 'when', 'people', 'tasks', 'equipment', 'review'],
  };
  const missing = [];
  for (const [prefix, names] of Object.entries(families)) {
    for (const n of names) for (const lang of ['en', 'nb']) if (!DICTS[lang][prefix + n]) missing.push(`${lang}:${prefix}${n}`);
  }
  assert.deepEqual(missing, []);
  // Anything built from a prefix in the code must be one of the families checked above.
  for (const p of prefixes) assert.ok(families[p], `unchecked family ${p}`);
});

test('the two languages have the same Dugnad keys and the same placeholders', () => {
  const keys = (d) => Object.keys(d).filter((k) => k.startsWith('dugnad.'));
  assert.deepEqual(keys(DICTS.nb).sort(), keys(DICTS.en).sort());
  const bad = [];
  for (const k of keys(DICTS.en)) {
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    if (ph(DICTS.en[k]) !== ph(DICTS.nb[k])) bad.push(k);
  }
  assert.deepEqual(bad, []);
});
