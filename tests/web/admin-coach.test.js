'use strict';
/* Tests for the pure helpers in web/js/admin-coach.js: the date range, coaching key labels and figures,
   tip results and the leaderboard ranking. Also checks that the page and the database migration agree on
   the function names, and that the script builds the page without HTML strings. No network and no DOM.
   Run: node --test tests/web/admin-coach.test.js
   Prints "admin-coach.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const C = require(path.join(root, 'web', 'js', 'admin-coach.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

test('date range covers whole local days, to is exclusive', () => {
  const r = C.rangeIso('2026-10-01', '2026-10-07');
  assert.strictEqual(new Date(r.from).getTime(), new Date(2026, 9, 1).getTime());
  assert.strictEqual(new Date(r.to).getTime(), new Date(2026, 9, 8).getTime());
  assert.strictEqual(C.rangeIso('2026-10-07', '2026-10-01'), null, 'to before from');
  assert.strictEqual(C.rangeIso('2026-02-30', '2026-03-01'), null, 'not a real date');
  assert.strictEqual(C.rangeIso('', '2026-03-01'), null);
});

test('coaching keys read as plain words', () => {
  assert.strictEqual(C.keyLabel('connect'), 'Connect rate');
  assert.strictEqual(C.keyLabel('reason_missing'), 'Loss reasons picked');
  assert.strictEqual(C.keyLabel('stage:Fee'), 'Lost at the Fee step');
  assert.strictEqual(C.keyLabel('objection:Too expensive'), 'Lost on "Too expensive"');
});

test('figures: connect as %, reasons as share picked, stages per 100 calls', () => {
  assert.strictEqual(C.figure('connect', 30), '30%');
  assert.strictEqual(C.figure('connect', '61.7'), '62%');
  assert.strictEqual(C.figure('reason_missing', 75), '25% picked');
  assert.strictEqual(C.figure('stage:Fee', 40), '40 per 100 calls');
  assert.strictEqual(C.figure('connect', null), '–');
  assert.strictEqual(C.figure('connect', 'x'), '–');
});

test('tip results', () => {
  assert.deepStrictEqual(C.tipResult({ result: 'improved' }), { text: 'Improved', cls: 'ok' });
  assert.deepStrictEqual(C.tipResult({ result: 'worse' }), { text: 'Worse', cls: 'bad' });
  assert.strictEqual(C.tipResult({ result: 'same' }).text, 'No change yet');
  assert.strictEqual(C.tipResult({ result: 'waiting', tip_key: 'connect', after_calls: 4 }).text, 'Waiting: 4 of 10 calls');
  assert.strictEqual(C.tipResult({ result: 'waiting', tip_key: 'reason_missing', after_calls: 2 }).text, 'Waiting: 2 of 5 lost calls');
  assert.strictEqual(C.tipResult({ result: 'waiting', tip_key: 'connect', after_calls: 30 }).text, 'Waiting: 10 of 10 calls');
});

test('leaderboard ranks highest first, ties share a rank, bars scale to the top', () => {
  const rows = [
    { label: 'Meera', won: 5, calls: 20 },
    { label: 'Arjun', won: 3, calls: 20 },
    { label: 'Ravi', won: 5, calls: 32, me: true },
    { label: 'Nisha', won: 0, calls: 0 },
  ];
  const won = C.rankBoard(rows, 'won');
  assert.deepStrictEqual(won.map((r) => [r.label, r.rank, r.pct, r.top]), [
    ['Meera', 1, 100, true], ['Ravi', 1, 100, true], ['Arjun', 3, 60, false], ['Nisha', 4, 0, false],
  ]);
  assert.ok(won.find((r) => r.label === 'Ravi').me, 'me kept');
  const calls = C.rankBoard(rows, 'calls');
  assert.strictEqual(calls[0].label, 'Ravi');
  assert.strictEqual(calls[1].rank, 2);
  assert.strictEqual(calls[2].rank, 2, 'Arjun and Meera tie on 20 calls');
});

test('leaderboard with nobody scoring has no top and no bars', () => {
  const r = C.rankBoard([{ label: 'A', won: 0 }, { label: 'B', won: 0 }], 'won');
  assert.ok(r.every((x) => !x.top && x.pct === 0 && x.rank === 1));
  assert.deepStrictEqual(C.rankBoard(null, 'won'), []);
});

test('note length', () => {
  assert.deepStrictEqual(C.noteCheck('  call after 6pm '), { ok: true, text: 'call after 6pm' });
  assert.strictEqual(C.noteCheck('x'.repeat(301)).ok, false);
  assert.strictEqual(C.noteCheck('x'.repeat(300)).ok, true);
});

// ----- static checks -----
const js = fs.readFileSync(path.join(root, 'web', 'js', 'admin-coach.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261013100012_coaching_leaderboard.sql'), 'utf8');

test('admin-coach.js builds the page without HTML strings', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(js));
});
test('every function the page calls exists in the migration and is granted', () => {
  const calls = [...js.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 5);
  for (const name of new Set(calls)) {
    assert.ok(new RegExp('create or replace function public\\.' + name + '\\(').test(sql), 'missing ' + name);
    assert.ok(new RegExp('grant execute on function public\\.' + name + '\\(').test(sql), 'not granted ' + name);
  }
});
test('admin page loads the script and has the elements it uses', () => {
  assert.ok(/<script src="js\/admin-coach\.js"><\/script>/.test(html));
  const ids = [...js.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]);
  for (const id of new Set(ids)) assert.ok(html.includes('id="' + id + '"'), 'admin.html has no #' + id);
  for (const m of C.METRICS) assert.ok(html.includes('data-metric="' + m.key + '"'), 'no button for ' + m.key);
});

console.log('admin-coach.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
