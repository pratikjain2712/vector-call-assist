'use strict';
/* Tests for the pure helpers in web/js/admin.js: date ranges, CSV formatting with the formula guard,
   the results pivot and pairing health. No network and no DOM.
   Run: node tests/web/admin.test.js
   Prints "admin.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const H = require(path.join(__dirname, '..', '..', 'web', 'js', 'admin.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

// ----- lastNDays -----
test('last 7 days ends today and starts six days back', () => {
  assert.deepStrictEqual(H.lastNDays(new Date(2026, 9, 12, 15, 30), 7), { from: '2026-10-06', to: '2026-10-12' });
});
test('last 7 days crosses a month boundary', () => {
  assert.deepStrictEqual(H.lastNDays(new Date(2026, 9, 3, 8, 0), 7), { from: '2026-09-27', to: '2026-10-03' });
});
test('last 7 days crosses a year boundary', () => {
  assert.deepStrictEqual(H.lastNDays(new Date(2026, 0, 2, 23, 59), 7), { from: '2025-12-27', to: '2026-01-02' });
});
test('one day range is today only', () => {
  assert.deepStrictEqual(H.lastNDays(new Date(2026, 9, 12, 1, 0), 1), { from: '2026-10-12', to: '2026-10-12' });
});

// ----- parseYmd and rangeToTimestamps -----
test('parseYmd rejects impossible dates and bad shapes', () => {
  assert.strictEqual(H.parseYmd('2026-02-30'), null);
  assert.strictEqual(H.parseYmd('2026-13-01'), null);
  assert.strictEqual(H.parseYmd('12/10/2026'), null);
  assert.strictEqual(H.parseYmd(''), null);
  assert.strictEqual(H.parseYmd(undefined), null);
  assert.ok(H.parseYmd('2028-02-29') instanceof Date);
});
test('range covers from the first day to the midnight after the last day', () => {
  const r = H.rangeToTimestamps('2026-10-06', '2026-10-12');
  assert.strictEqual(r.from, new Date(2026, 9, 6).toISOString());
  assert.strictEqual(r.to, new Date(2026, 9, 13).toISOString());
});
test('a single-day range runs to the next midnight', () => {
  const r = H.rangeToTimestamps('2026-10-12', '2026-10-12');
  assert.strictEqual(r.from, new Date(2026, 9, 12).toISOString());
  assert.strictEqual(r.to, new Date(2026, 9, 13).toISOString());
});
test('range across a DST change keeps whole local days', () => {
  const r = H.rangeToTimestamps('2026-03-27', '2026-03-29');
  assert.strictEqual(r.to, new Date(2026, 2, 30).toISOString());
});
test('to before from is refused', () => {
  assert.throws(() => H.rangeToTimestamps('2026-10-12', '2026-10-06'), /before the from date/);
});
test('a range over 400 days is refused', () => {
  assert.throws(() => H.rangeToTimestamps('2024-01-01', '2026-10-12'), /400 days/);
});
test('missing or invalid dates are refused', () => {
  assert.throws(() => H.rangeToTimestamps('', '2026-10-12'), /Pick both dates/);
  assert.throws(() => H.rangeToTimestamps('2026-10-01', '2026-02-30'), /Pick both dates/);
});

// ----- formula guard and CSV -----
test('plain text is left alone', () => {
  assert.strictEqual(H.csvCell('Rep 1'), 'Rep 1');
});
test('= + - @ at the start get a leading apostrophe', () => {
  assert.strictEqual(H.csvCell('=1+1'), "'=1+1");
  assert.strictEqual(H.csvCell('+cmd'), "'+cmd");
  assert.strictEqual(H.csvCell('-2+3'), "'-2+3");
  assert.strictEqual(H.csvCell('@SUM(A1)'), "'@SUM(A1)");
});
test('a tab or carriage return at the start is guarded too', () => {
  assert.strictEqual(H.guardCell('\tcmd'), "'\tcmd");
  assert.strictEqual(H.guardCell('\rcmd'), "'\rcmd");
});
test('phone numbers are not guarded', () => {
  assert.strictEqual(H.guardCell('+91 98765 43210'), '+91 98765 43210');
  assert.strictEqual(H.guardCell('+1-555-0100'), '+1-555-0100');
  assert.strictEqual(H.guardCell('+44 (0) 20.7946.0000'), '+44 (0) 20.7946.0000');
});
test('something that only starts like a phone number is still guarded', () => {
  assert.strictEqual(H.guardCell('+1+1'), "'+1+1");
  assert.strictEqual(H.guardCell('+HYPERLINK("x")'), "'+HYPERLINK(\"x\")");
});
test('numbers and null are not changed by the guard', () => {
  assert.strictEqual(H.guardCell(-5), -5);
  assert.strictEqual(H.csvCell(-5), '-5');
  assert.strictEqual(H.csvCell(0), '0');
  assert.strictEqual(H.csvCell(null), '');
  assert.strictEqual(H.csvCell(undefined), '');
});
test('a cell with a comma, quote or newline is quoted and its quotes doubled', () => {
  assert.strictEqual(H.csvCell('Rep, senior'), '"Rep, senior"');
  assert.strictEqual(H.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(H.csvCell('a\nb'), '"a\nb"');
});
test('a guarded cell that also needs quotes gets both', () => {
  assert.strictEqual(H.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
});
test('toCsv writes a header, CRLF line endings and a final newline', () => {
  assert.strictEqual(H.toCsv(['A', 'B'], [['x', 1], ['=2', 'y,z']]), 'A,B\r\nx,1\r\n\'=2,"y,z"\r\n');
});
test('toCsv with no rows writes only the header', () => {
  assert.strictEqual(H.toCsv(['A'], []), 'A\r\n');
});

// ----- team CSV rows -----
test('team rows put the connect rate in percent with one decimal', () => {
  const rows = H.teamCsvRows([{
    label: 'Rep 1', day: '2026-10-06', calls: 3, connected_calls: 2, connect_rate: 0.6667,
    talk_seconds: 150, last_activity: '2026-10-06T12:00:00+00:00',
  }]);
  assert.deepStrictEqual(rows, [['Rep 1', '2026-10-06', 3, 2, 66.7, 150, '2026-10-06T12:00:00+00:00']]);
});
test('a rep label starting with = is guarded in the CSV', () => {
  const csv = H.toCsv(H.TEAM_HEADERS, H.teamCsvRows([{
    label: '=Rep', day: '2026-10-06', calls: 1, connected_calls: 0, connect_rate: 0, talk_seconds: 0, last_activity: null,
  }]));
  assert.ok(csv.includes("\r\n'=Rep,2026-10-06,1,0,0,0,\r\n"), csv);
});
test('rateToPercent handles 1 and empty values', () => {
  assert.strictEqual(H.rateToPercent(1), 100);
  assert.strictEqual(H.rateToPercent(null), '');
});

// ----- results pivot -----
test('pivot sums counts per rep and sorts reps by label', () => {
  const pivot = H.pivotOutcomes([
    { seat_id: 'b', label: 'Rep 2', outcome: 'won', outcome_count: 1 },
    { seat_id: 'a', label: 'Rep 1', outcome: 'answered', outcome_count: 2 },
    { seat_id: 'a', label: 'Rep 1', outcome: 'callback', outcome_count: 1 },
    { seat_id: 'a', label: 'Rep 1', outcome: 'won', outcome_count: 1 },
    { seat_id: 'a', label: 'Rep 1', outcome: 'busy', outcome_count: 1 },
    { seat_id: 'b', label: 'Rep 2', outcome: 'answered', outcome_count: 1 },
  ]);
  assert.deepStrictEqual(pivot.map((r) => r.label), ['Rep 1', 'Rep 2']);
  assert.deepStrictEqual(pivot[0].counts, { answered: 2, callback: 1, won: 1, busy: 1 });
  assert.strictEqual(pivot[0].total, 5);
  assert.strictEqual(pivot[1].total, 2);
});
test('pivot of no rows is empty', () => {
  assert.deepStrictEqual(H.pivotOutcomes([]), []);
});

// ----- pairing health -----
test('pairing health: active with a phone is ok', () => {
  assert.deepStrictEqual(H.pairingHealth({ status: 'active', has_phone: true }), { level: 'ok', text: 'Phone paired' });
});
test('pairing health: active without a phone is a warning', () => {
  assert.deepStrictEqual(H.pairingHealth({ status: 'active', has_phone: false }), { level: 'warn', text: 'No phone paired' });
});
test('pairing health: invited and revoked seats have nothing to check', () => {
  assert.strictEqual(H.pairingHealth({ status: 'invited', has_phone: false }).level, 'none');
  assert.strictEqual(H.pairingHealth({ status: 'revoked', has_phone: false }).level, 'none');
});

console.log('admin.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
