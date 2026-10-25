#!/usr/bin/env node
'use strict';
/* Builds the seed SQL of the central template library from supabase/templates/library.json and
   supabase/templates/common_answers.json, and writes it into the migration
   supabase/migrations/20261025140000_template_library.sql between the "seed: start" and "seed: end" lines.
   Run after changing either JSON file:   node scripts/build-template-seed.js
   Check only (exit 1 when the migration is out of date):   node scripts/build-template-seed.js --check
   tests/web/template-seed.test.js runs the same check. The migration seeds a new database only; on a live
   database, change templates with platform_upsert_template / platform_upsert_common_answer (Scripts > Library). */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'supabase', 'templates', 'library.json');
const COMMON = path.join(ROOT, 'supabase', 'templates', 'common_answers.json');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261025140000_template_library.sql');
const START = '-- seed: start (made by scripts/build-template-seed.js from supabase/templates/*.json; do not edit by hand)';
const END = '-- seed: end';

// A SQL string literal (standard_conforming_strings is on: only the quote is doubled).
const lit = (v) => (v === null || v === undefined ? 'null' : "'" + String(v).replace(/'/g, "''") + "'");
const arr = (list) => (Array.isArray(list) && list.length ? 'array[' + list.map(lit).join(', ') + ']::text[]' : "'{}'::text[]");
const json = (v) => lit(JSON.stringify(v === undefined ? [] : v)) + '::jsonb';

function buildSeed(library, common) {
  const lines = [START];
  lines.push('insert into public.script_templates (key, name, call_type, audience, about, class_labels, boards, language, steps, pushbacks) values');
  lines.push(library.map((t) => '  (' + [
    lit(t.key), lit(t.name), lit(t.call_type), lit(t.audience), lit(t.about),
    arr((t.tags || {}).class_labels), arr((t.tags || {}).boards), lit(t.language || 'en'),
    json(t.steps), json(t.pushbacks || []),
  ].join(', ') + ')').join(',\n') + ';');
  lines.push('insert into public.common_answers (key, label, answer, fallback, result, checks, tags) values');
  lines.push(common.map((a) => '  (' + [
    lit(a.key), lit(a.label), lit(a.answer), lit(a.fallback), lit(a.result), arr(a.check), arr(a.tags),
  ].join(', ') + ')').join(',\n') + ';');
  lines.push(END);
  return lines.join('\n');
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const seedFromFiles = () => buildSeed(readJson(LIB), readJson(COMMON));

// The seed block now in the migration, or null when the markers are missing.
function seedInMigration(sql) {
  const a = sql.indexOf(START);
  const b = a < 0 ? -1 : sql.indexOf(END, a + START.length);
  if (a < 0 || b < 0) return null;
  return sql.slice(a, b + END.length);
}

if (require.main === module) {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const now = seedInMigration(sql);
  if (now === null) { console.error('The migration has no seed markers.'); process.exit(1); }
  const want = seedFromFiles();
  if (process.argv.includes('--check')) {
    if (now !== want) { console.error('The migration seed is out of date. Run: node scripts/build-template-seed.js'); process.exit(1); }
    console.log('The migration seed matches the JSON files.');
  } else if (now !== want) {
    fs.writeFileSync(MIGRATION, sql.replace(now, () => want));
    console.log('Seed written into ' + path.relative(ROOT, MIGRATION) + '.');
  } else {
    console.log('The migration seed is already up to date.');
  }
}

module.exports = { buildSeed, seedFromFiles, seedInMigration, MIGRATION, START, END };
