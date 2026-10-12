'use strict';
/* Tests for the pure helpers in web/js/admin-team.js: bar widths, the CSV formula guard (checked against
   the one in web/js/admin.js), week start on Monday, note length and target parsing. Also a few static
   checks on the admin page files (no inline script or style, no HTML strings, same supabase-js pin as index.html).
   No network and no DOM.
   Run: node --test tests/web/admin-team.test.js
   Prints "admin-team.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'web', 'js', 'admin-team.js'));
const A = require(path.join(root, 'web', 'js', 'admin.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

// ----- bar width -----
test('bar is empty with no target, a zero target or a bad number', () => {
  assert.strictEqual(T.barPercent(5, undefined), 0);
  assert.strictEqual(T.barPercent(5, null), 0);
  assert.strictEqual(T.barPercent(5, 0), 0);
  assert.strictEqual(T.barPercent(NaN, 10), 0);
  assert.strictEqual(T.barPercent(5, 'x'), 0);
});
test('bar clamps to 0 and 100', () => {
  assert.strictEqual(T.barPercent(-3, 10), 0);
  assert.strictEqual(T.barPercent(10, 10), 100);
  assert.strictEqual(T.barPercent(37, 10), 100);
});
test('bar rounds to a whole percent in between', () => {
  assert.strictEqual(T.barPercent(25, 40), 63);   // 62.5 rounds up
  assert.strictEqual(T.barPercent(0, 40), 0);
});
test('percent of target is the real figure, above 100 when exceeded', () => {
  assert.strictEqual(T.percentOfTarget(150, 100), 150);
  assert.strictEqual(T.percentOfTarget(1, 3), 33);
  assert.strictEqual(T.percentOfTarget(1, 0), null);
});

// ----- CSV formula guard -----
test('a cell starting with = + - @ tab or CR gets a leading apostrophe', () => {
  assert.strictEqual(T.guardCell('=1+1'), "'=1+1");
  assert.strictEqual(T.guardCell('+1 x'), "'+1 x");
  assert.strictEqual(T.guardCell('-5'), "'-5");
  assert.strictEqual(T.guardCell('@SUM(A1)'), "'@SUM(A1)");
  assert.strictEqual(T.guardCell('\tx'), "'\tx");
  assert.strictEqual(T.guardCell('\rx'), "'\rx");
});
test('phone-like text and plain text are left alone, and numbers are never changed', () => {
  assert.strictEqual(T.guardCell('+447700900123'), '+447700900123');
  assert.strictEqual(T.guardCell('+91 (98) 1234-5678'), '+91 (98) 1234-5678');
  assert.strictEqual(T.guardCell('Rep 1'), 'Rep 1');
  assert.strictEqual(T.guardCell(-5), -5);
  assert.strictEqual(T.guardCell(0), 0);
});
test('csv cell quotes commas, quotes and line breaks, and writes null as empty', () => {
  assert.strictEqual(T.csvCell('Rep, 1'), '"Rep, 1"');
  assert.strictEqual(T.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(T.csvCell('a\nb'), '"a\nb"');
  assert.strictEqual(T.csvCell(null), '');
  assert.strictEqual(T.csvCell(undefined), '');
});
test('weekly CSV guard matches the team activity CSV guard on the same cells', () => {
  const samples = ['=HYPERLINK("x")', '+1', '+447700900123', '-x', '@a', '\tb', 'Rep 1', 'a,b', 'q"q', 7, 0.5, null, ''];
  samples.forEach((v) => {
    assert.strictEqual(T.csvCell(v), A.csvCell(v), 'differs for ' + JSON.stringify(v));
  });
});
test('toCsv writes the header, CRLF line ends and a final line break', () => {
  assert.strictEqual(T.toCsv(['Rep', 'Calls'], [['Rep 1', 3], ['=evil', 0]]), 'Rep,Calls\r\nRep 1,3\r\n\'=evil,0\r\n');
});

// ----- week start (Monday) -----
test('2026-10-12 is itself the Monday of its week', () => {
  assert.strictEqual(T.weekStart('2026-10-12'), '2026-10-12');
});
test('a Wednesday and a Sunday go back to their Monday', () => {
  assert.strictEqual(T.weekStart('2026-10-14'), '2026-10-12');
  assert.strictEqual(T.weekStart('2026-10-11'), '2026-10-05');   // Sunday ends the Monday-to-Sunday week
  assert.strictEqual(T.weekStart('2026-10-18'), '2026-10-12');
});
test('week start crosses a month boundary', () => {
  assert.strictEqual(T.weekStart('2026-11-01'), '2026-10-26');   // a Sunday
  assert.strictEqual(T.weekStart('2026-11-02'), '2026-11-02');   // a Monday
});
test('week start takes a Date in local time', () => {
  assert.strictEqual(T.weekStart(new Date(2026, 9, 14, 23, 30)), '2026-10-12');
});
test('week start refuses bad dates', () => {
  assert.strictEqual(T.weekStart('2026-02-30'), null);
  assert.strictEqual(T.weekStart(''), null);
  assert.strictEqual(T.weekStart('12/10/2026'), null);
});

// ----- note length -----
test('a note of 1000 characters is accepted and trimmed', () => {
  const r = T.noteCheck('  ' + 'a'.repeat(1000) + '  ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.length, 1000);
  assert.strictEqual(r.text.length, 1000);
});
test('a note of 1001 characters is refused', () => {
  const r = T.noteCheck('a'.repeat(1001));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.length, 1001);
});
test('characters are counted as code points, so emoji count once', () => {
  assert.strictEqual(T.noteCheck('\u{1F600}'.repeat(1000)).ok, true);
  assert.strictEqual(T.noteCheck('\u{1F600}'.repeat(1001)).ok, false);
});
test('an empty or blank note is refused', () => {
  assert.strictEqual(T.noteCheck('').ok, false);
  assert.strictEqual(T.noteCheck('   \n ').ok, false);
  assert.strictEqual(T.noteCheck(null).ok, false);
});

// ----- targets -----
test('a blank target means leave it; a whole number is kept', () => {
  assert.deepStrictEqual(T.parseTarget(''), { ok: true, value: null });
  assert.deepStrictEqual(T.parseTarget('  '), { ok: true, value: null });
  assert.deepStrictEqual(T.parseTarget(' 20 '), { ok: true, value: 20 });
  assert.deepStrictEqual(T.parseTarget('0'), { ok: true, value: 0 });
});
test('targets that are not whole numbers in range are refused', () => {
  assert.strictEqual(T.parseTarget('2.5').ok, false);
  assert.strictEqual(T.parseTarget('-1').ok, false);
  assert.strictEqual(T.parseTarget('abc').ok, false);
  assert.strictEqual(T.parseTarget('100001').ok, false);
  assert.strictEqual(T.parseTarget('100000').ok, true);
});

// ----- rows -----
test('summary columns drop ids and keep the database order', () => {
  assert.deepStrictEqual(
    T.summaryColumns([{ seat_id: 'a', label: 'Rep 1', calls: 3, connected_calls: 1 }]),
    ['label', 'calls', 'connected_calls']);
  assert.deepStrictEqual(T.summaryColumns([]), []);
});
test('heading text turns a column name into words', () => {
  assert.strictEqual(T.headerText('connected_calls'), 'Connected calls');
  assert.strictEqual(T.headerText('calls'), 'Calls');
});
test('not calling lists rep rows with zero calls, sorted, and leaves out admin rows', () => {
  const rows = [
    { label: 'Rep 3', calls: 0 },
    { label: 'Rep 1', calls: 2 },
    { label: 'Rep 2', calls: '0' },
    { label: 'Office', calls: 0, role: 'admin' },
  ];
  assert.deepStrictEqual(T.notCalling(rows).map((r) => r.label), ['Rep 2', 'Rep 3']);
  assert.deepStrictEqual(T.notCalling([]), []);
});
test('rep seats are the active reps only', () => {
  const seats = [
    { seat_id: 'a', label: 'Rep 1', role: 'rep', status: 'active' },
    { seat_id: 'b', label: 'Rep 2', role: 'rep', status: 'invited' },
    { seat_id: 'c', label: 'Admin', role: 'admin', status: 'active' },
  ];
  assert.deepStrictEqual(T.repSeats(seats).map((s) => s.label), ['Rep 1']);
});
test('talk seconds show as minutes with one decimal', () => {
  assert.strictEqual(T.talkMinutes(90), 1.5);
  assert.strictEqual(T.talkMinutes(0), 0);
  assert.strictEqual(T.talkMinutes(null), 0);
});

// ----- static checks on the page files -----
const adminHtml = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
const adminTeamJs = fs.readFileSync(path.join(root, 'web', 'js', 'admin-team.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
test('admin page has no inline script or style attributes', () => {
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(adminHtml), 'inline script tag');
  assert.ok(!/\sstyle\s*=/i.test(adminHtml), 'style attribute');
});
test('admin-team.js builds the page without HTML strings', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(adminTeamJs));
});
test('supabase-js on the admin page uses the same URL and hash as index.html', () => {
  const tag = (src) => (/<script src="(https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*)" integrity="([^"]+)"/.exec(src) || []).slice(1).join(' ');
  assert.ok(tag(adminHtml) !== '', 'admin page has no pinned supabase-js');
  assert.strictEqual(tag(adminHtml), tag(indexHtml));
});

console.log('admin-team.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
