'use strict';
/* Tests for the pure helpers in web/js/excel-export.js: cell values and the formula guard, sheet names Excel
   accepts, column widths, file names, and a workbook built with the real SheetJS (xlsx 0.18.5 from
   node_modules, the same file the page loads) and read back. Also checks that the page loads that same file
   with its integrity hash. No network and no DOM.
   Run: node --test tests/web/excel-export.test.js
   Prints "excel-export.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..', '..');
const E = require(path.join(root, 'web', 'js', 'excel-export.js'));
const A = require(path.join(root, 'web', 'js', 'admin.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

// ----- cells -----
test('numbers stay numbers, empty values are blank, booleans read Yes and No', () => {
  assert.strictEqual(E.cellValue(4320000), 4320000);
  assert.strictEqual(E.cellValue(0), 0);
  assert.strictEqual(E.cellValue(null), '');
  assert.strictEqual(E.cellValue(undefined), '');
  assert.strictEqual(E.cellValue(NaN), '');
  assert.strictEqual(E.cellValue(true), 'Yes');
  assert.strictEqual(E.cellValue(false), 'No');
});
test('text that could run as a formula gets an apostrophe; phone numbers do not', () => {
  assert.strictEqual(E.cellValue('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.strictEqual(E.cellValue('@SUM(A1)'), "'@SUM(A1)");
  assert.strictEqual(E.cellValue('-1+2'), "'-1+2");
  assert.strictEqual(E.cellValue('+91 98765 43210'), '+91 98765 43210');
  assert.strictEqual(E.cellValue('Ravi'), 'Ravi');
});
test('the guard is the same as the CSV guard in js/admin.js', () => {
  ['=1+1', '+1', '-x', '@a', '\tx', '+919876543210', 'plain', '9876543210'].forEach((v) => {
    assert.strictEqual(E.guardCell(v), A.guardCell(v), v);
  });
});
test('toAoa puts the headers first and the notes after an empty row', () => {
  const aoa = E.toAoa({ headers: ['A', 'B'], rows: [[1, '=x'], [null, 'y']], notes: ['Note one', '', null] });
  assert.deepStrictEqual(aoa, [['A', 'B'], [1, "'=x"], ['', 'y'], [], ['Note one']]);
});
test('toAoa with no notes has no empty row', () => {
  assert.deepStrictEqual(E.toAoa({ headers: ['A'], rows: [] }), [['A']]);
});

// ----- sheet names -----
test('sheet names lose the characters Excel refuses and fit 31 characters', () => {
  assert.strictEqual(E.sheetName('Fees: Oct/Nov [10-A]'), 'Fees Oct Nov 10-A');
  const long = E.sheetName('Promises due this week for every campaign we run');
  assert.ok(long.length <= 31, long);
  assert.strictEqual(E.sheetName(''), 'Sheet');
  assert.strictEqual(E.sheetName("'quoted'"), 'quoted');
});
test('a sheet name is never used twice, whatever the case', () => {
  const used = new Set();
  assert.strictEqual(E.sheetName('Outcomes', used), 'Outcomes');
  assert.strictEqual(E.sheetName('outcomes', used), 'outcomes (2)');
  assert.strictEqual(E.sheetName('Outcomes', used), 'Outcomes (3)');
  const a = E.sheetName('x'.repeat(40), used);
  const b = E.sheetName('x'.repeat(40), used);
  assert.notStrictEqual(a, b);
  assert.ok(b.length <= 31, b);
});

// ----- widths and file names -----
test('column widths follow the longest value, between 8 and 50', () => {
  const w = E.columnWidths({ headers: ['Parent', 'N'], rows: [['A very long parent name here', 3], [null, 12345]] });
  assert.deepStrictEqual(w, [{ wch: 30 }, { wch: 8 }]);
  assert.strictEqual(E.columnWidths({ headers: ['x'.repeat(80)], rows: [] })[0].wch, 50);
});
test('file names are lower case with hyphens and end in .xlsx', () => {
  assert.strictEqual(E.fileName(['vector fees collection', '2026-10-01', 'to', '2026-10-07']),
    'vector-fees-collection-2026-10-01-to-2026-10-07.xlsx');
  assert.strictEqual(E.fileName(['Vector', 'Sales v7 (new)!', null, '']), 'vector-sales-v7-new.xlsx');
  assert.strictEqual(E.fileName([]), 'vector-report.xlsx');
  assert.ok(!/[/\\]/.test(E.fileName(['../../etc/passwd'])));
});

// ----- a real workbook -----
const XLSX = require(path.join(root, 'node_modules', 'xlsx'));
test('build makes one sheet per entry and the data reads back', () => {
  const wb = E.build(XLSX, [
    { name: 'Fees collection', headers: ['Measure', 'Parents', 'Amount (₹)'], rows: [['Total due', 240, 4320000]], notes: ['Paid amounts are reported by caller.'] },
    { name: 'Promises due this week', headers: ['Parent', 'Status'], rows: [['=cmd', 'Due today']] },
  ]);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const back = XLSX.read(buf, { type: 'buffer' });
  assert.deepStrictEqual(back.SheetNames, ['Fees collection', 'Promises due this week']);
  const rows = XLSX.utils.sheet_to_json(back.Sheets['Fees collection'], { header: 1, defval: '' });
  assert.deepStrictEqual(rows[0], ['Measure', 'Parents', 'Amount (₹)']);
  assert.deepStrictEqual(rows[1], ['Total due', 240, 4320000]);
  assert.strictEqual(typeof rows[1][2], 'number');
  assert.strictEqual(rows[rows.length - 1][0], 'Paid amounts are reported by caller.');
  const p = XLSX.utils.sheet_to_json(back.Sheets['Promises due this week'], { header: 1 });
  assert.strictEqual(p[1][0], "'=cmd");
  assert.ok(!back.Sheets['Promises due this week'].B2.f, 'no formula cell');
});
test('build refuses an empty list of sheets', () => {
  assert.throws(() => E.build(XLSX, []), /Nothing to put in the file/);
});

// ----- the page loads the same SheetJS file -----
test('the jsDelivr copy is the same file as node_modules and the cdnjs copy on app.html', () => {
  const file = fs.readFileSync(path.join(root, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));
  const hash = 'sha384-' + crypto.createHash('sha384').update(file).digest('base64');
  assert.strictEqual(E.INTEGRITY, hash);
  const app = fs.readFileSync(path.join(root, 'web', 'app.html'), 'utf8');
  assert.ok(app.includes('xlsx/0.18.5/xlsx.full.min.js" integrity="' + hash + '"'), 'app.html uses the same version and hash');
  assert.ok(/^https:\/\/cdn\.jsdelivr\.net\/npm\/xlsx@0\.18\.5\//.test(E.SRC), 'jsDelivr is the CDN the admin CSP allows');
});
test('the admin page loads excel-export.js before the Reports tab', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
  const at = html.indexOf('<script src="js/excel-export.js"></script>');
  assert.ok(at > -1 && at < html.indexOf('<script src="js/admin/reports.js"></script>'));
});
test('excel-export.js builds no HTML strings', () => {
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'excel-export.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(src));
});

console.log('excel-export.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
