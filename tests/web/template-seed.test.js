'use strict';
/* The seed of the central template library in supabase/migrations/20261025140000_template_library.sql must be
   exactly what scripts/build-template-seed.js makes from supabase/templates/library.json and
   common_answers.json. After changing a JSON file, run: node scripts/build-template-seed.js
   Run: node --test tests/web/template-seed.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const B = require(path.join(__dirname, '..', '..', 'scripts', 'build-template-seed.js'));
const ROOT = path.join(__dirname, '..', '..');
const LIB = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase', 'templates', 'library.json'), 'utf8'));
const COMMON = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase', 'templates', 'common_answers.json'), 'utf8'));
const SQL = fs.readFileSync(B.MIGRATION, 'utf8');

test('the migration seed matches the JSON files', () => {
  const seed = B.seedInMigration(SQL);
  assert.ok(seed, 'the migration has the seed markers');
  assert.strictEqual(seed, B.seedFromFiles(), 'run: node scripts/build-template-seed.js');
});

test('every template and common answer is in the seed once', () => {
  const seed = B.seedInMigration(SQL);
  LIB.forEach((t) => assert.strictEqual(seed.split("  ('" + t.key + "', ").length - 1, 1, t.key));
  COMMON.forEach((a) => assert.strictEqual(seed.split("  ('" + a.key + "', ").length - 1, 1, a.key));
});

test('quotes are doubled and the JSON reads back the same', () => {
  const one = B.buildSeed([{ key: 'k_x', name: "Parent's call", call_type: 'fees', audience: null, about: 'a',
    tags: { class_labels: ['8th'], boards: ['CBSE'] }, language: 'en', steps: [{ id: 'a', say: ["It's due"] }], pushbacks: [] }], [
    { key: 'a_b', label: 'Why?', answer: "We're here.", tags: ['all'], check: ['Add it.'] }]);
  assert.match(one, /'Parent''s call'/);
  assert.match(one, /array\['8th'\]::text\[\], array\['CBSE'\]::text\[\]/);
  assert.match(one, /'\[\{"id":"a","say":\["It''s due"\]\}\]'::jsonb/);
  assert.match(one, /\('a_b', 'Why\?', 'We''re here\.', null, null, array\['Add it\.'\]::text\[\], array\['all'\]::text\[\]\)/);
  // Empty lists are empty arrays, not null.
  const two = B.buildSeed([{ key: 'k_y', name: 'N', call_type: 'fees', steps: [] }], []);
  assert.match(two, /'\{\}'::text\[\], '\{\}'::text\[\], 'en', '\[\]'::jsonb, '\[\]'::jsonb/);
});
