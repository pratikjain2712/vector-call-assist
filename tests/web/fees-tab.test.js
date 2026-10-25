'use strict';
/* Tests for the pure helpers in web/js/admin/fees.js (Phase A.2): amounts in words (Indian), receipt numbers,
   money with paise, dates, years and boards from a sheet, the import column guess and rows, list filters,
   totals and pages, the payment form check, payments and reversals, the summary sums, and who sees what.
   Plus static checks: the tab is registered, loaded and styled, and its CSS rules start with .tab-fees.
   Run: node --test tests/web/fees-tab.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const F = require(path.join(root, 'web', 'js', 'admin', 'fees.js'));

// ----- receipts -----
test('amount in words, Indian style', () => {
  assert.strictEqual(F.amountInWords(0), 'Rupees Zero Only');
  assert.strictEqual(F.amountInWords(1), 'Rupees One Only');
  assert.strictEqual(F.amountInWords(15), 'Rupees Fifteen Only');
  assert.strictEqual(F.amountInWords(2000), 'Rupees Two Thousand Only');
  assert.strictEqual(F.amountInWords(12550.5), 'Rupees Twelve Thousand Five Hundred Fifty and Fifty Paise Only');
  assert.strictEqual(F.amountInWords(105000), 'Rupees One Lakh Five Thousand Only');
  assert.strictEqual(F.amountInWords(4320099), 'Rupees Forty Three Lakh Twenty Thousand Ninety Nine Only');
  assert.strictEqual(F.amountInWords(25000000), 'Rupees Two Crore Fifty Lakh Only');
  assert.strictEqual(F.amountInWords(1234567890), 'Rupees One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety Only');
  assert.strictEqual(F.amountInWords('0.05'), 'Rupees Zero and Five Paise Only');
  assert.strictEqual(F.amountInWords(-5), '');
  assert.strictEqual(F.amountInWords(null), '');
  assert.strictEqual(F.amountInWords('abc'), '');
});
test('receipt numbers come from the payment id', () => {
  assert.strictEqual(F.receiptNo('1a2b3c4d-5e6f-4000-8000-000000000001'), 'R-1A2B3C4D');
  assert.strictEqual(F.receiptNo('ab-cd-ef-12-34'), 'R-ABCDEF12');
  assert.strictEqual(F.receiptNo(''), '');
  assert.strictEqual(F.receiptNo(null), '');
});
test('money with paise only when there are paise', () => {
  assert.strictEqual(F.rupees2(1250000), '₹12,50,000');
  assert.strictEqual(F.rupees2(99.5), '₹99.50');
  assert.strictEqual(F.rupees2('1234.05'), '₹1,234.05');
  assert.strictEqual(F.rupees2(-500), '-₹500');
  assert.strictEqual(F.rupees2(null), '');
});

// ----- sheet values -----
test('dates: ISO and day-first Indian forms; bad dates are null', () => {
  assert.strictEqual(F.parseDay('2026-11-05'), '2026-11-05');
  assert.strictEqual(F.parseDay('05/11/2026'), '2026-11-05');
  assert.strictEqual(F.parseDay('5-11-2026'), '2026-11-05');
  assert.strictEqual(F.parseDay('05.11.26'), '2026-11-05');
  assert.strictEqual(F.parseDay(''), '');
  assert.strictEqual(F.parseDay('31/02/2026'), null);
  assert.strictEqual(F.parseDay('next week'), null);
});
test('academic years and boards', () => {
  assert.strictEqual(F.parseYear('2026-27'), '2026-27');
  assert.strictEqual(F.parseYear('2026-2027'), '2026-27');
  assert.strictEqual(F.parseYear('2026/27'), '2026-27');
  assert.strictEqual(F.parseYear(''), '');
  assert.strictEqual(F.parseYear('26-27'), null);
  assert.strictEqual(F.parseBoard('cbse'), 'CBSE');
  assert.strictEqual(F.parseBoard('State board'), 'State');
  assert.strictEqual(F.parseBoard('igcse'), 'IGCSE');
  assert.strictEqual(F.parseBoard(''), '');
  assert.strictEqual(F.parseBoard('XYZ'), null);
});

// ----- import -----
test('import column guess: named fee columns with their own and a shared due date', () => {
  const m = F.guessImportColumns(['Admission No', 'Student Name', 'Class', 'Section', 'Board', 'Father Name', 'Mobile', 'Alt Mobile',
    'Academic Year', 'Tuition Fee', 'Tuition Due Date', 'Transport Fee', 'Due Date', 'Paid so far']);
  assert.deepStrictEqual([m.admission_no, m.name, m.class_label, m.section, m.board, m.parent_name, m.phone, m.alt_phone, m.academic_year, m.paid_so_far, m.paid_on],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 13, -1]);
  assert.deepStrictEqual(m.fees, [
    { head: 'Tuition', headCol: -1, amount: 9, due: 10 },
    { head: 'Transport', headCol: -1, amount: 11, due: 12 },
  ]);
});
test('import column guess: numbered fee groups and one fee head column', () => {
  const m = F.guessImportColumns(['Adm No', 'Name', 'Std', 'Parent', 'Phone', 'Fee head 1', 'Amount 1', 'Due date 1', 'Fee head 2', 'Amount 2', 'Due date 2']);
  assert.strictEqual(m.admission_no, 0);
  assert.strictEqual(m.name, 1);
  assert.strictEqual(m.class_label, 2);
  assert.strictEqual(m.parent_name, 3);
  assert.strictEqual(m.phone, 4);
  assert.deepStrictEqual(m.fees, [{ head: '', headCol: 5, amount: 6, due: 7 }, { head: '', headCol: 8, amount: 9, due: 10 }]);
  const one = F.guessImportColumns(['Student', 'Fee head', 'Amount', 'Due date', 'Payment date', 'Amount paid']);
  assert.deepStrictEqual(one.fees, [{ head: '', headCol: 1, amount: 2, due: 3 }]);
  assert.strictEqual(one.paid_on, 4);
  assert.strictEqual(one.paid_so_far, 5);
});
test('import rows: values cleaned, fees built, problems by sheet row', () => {
  const header = ['Admission No', 'Student Name', 'Class', 'Board', 'Mobile', 'Academic Year', 'Tuition Fee', 'Tuition Due Date', 'Paid so far'];
  const sheet = { header, rows: [
    ['A1', 'Kabir', '8', 'cbse', '098765 00011', '2026-2027', '18,000', '01/04/2026', '₹6,000'],
    ['A2', 'Isha', '8', '', '', '', '', '', ''],
    ['A1', 'Again', '8', '', '', '', '', '', ''],
    ['A3', '', '8', '', '', '', '', '', ''],
    ['A4', 'Tara', '8', 'XYZ', '', '', '', '', ''],
    ['A5', 'Ravi', '8', '', '12345', '', '', '', ''],
    ['A6', 'Mira', '8', '', '', '', '18000', '', ''],
    ['A7', 'Om', '8', '', '', '', 'lots', '01/04/2026', ''],
  ] };
  const b = F.buildImportRows(sheet, F.guessImportColumns(header), { academicYear: '2025-26' });
  assert.deepStrictEqual(b.rows[0], {
    name: 'Kabir', admission_no: 'A1', class_label: '8', board: 'CBSE', academic_year: '2026-27', phone: '+919876500011',
    paid_so_far: 6000, fees: [{ head: 'Tuition', amount: 18000, due_date: '2026-04-01', academic_year: '2026-27' }],
  });
  assert.deepStrictEqual(b.rows[1], { name: 'Isha', admission_no: 'A2', class_label: '8', academic_year: '2025-26' });
  assert.deepStrictEqual(b.sheetRows, [2, 3]);
  assert.deepStrictEqual(b.problems.map((p) => p.row), [4, 5, 6, 7, 8, 9]);
  assert.match(b.problems[0].reason, /twice/);
  assert.match(b.problems[1].reason, /No student name/);
  assert.match(b.problems[2].reason, /Unknown board/);
  assert.match(b.problems[3].reason, /10-digit/);
  assert.match(b.problems[4].reason, /no due date/);
  assert.match(b.problems[5].reason, /not an amount/);
  assert.deepStrictEqual(b.counts, { total: 8, ready: 2, skipped: 6 });
});
test('server skips map back to sheet rows; counts add up; the summary line', () => {
  assert.deepStrictEqual(F.serverSkips({ skipped_rows: [{ row: 2, reason: 'bad phone number' }] }, [2, 5, 9]), [{ row: 5, reason: 'bad phone number' }]);
  const t = F.addImportCounts(F.addImportCounts({}, { added: 2, updated: 1, skipped: 0, fee_items_added: 3, payments_added: 1 }), { added: 1 });
  assert.deepStrictEqual(t, { added: 3, updated: 1, skipped: 0, fee_items_added: 3, payments_added: 1 });
  assert.strictEqual(F.importSummary(t), 'Added 3 students, updated 1, skipped 0. 3 fee items and 1 opening payment added.');
});

// ----- list -----
test('filters: blanks left out, active students, up to 5000', () => {
  assert.deepStrictEqual(F.filtersToRpc({}), { status: 'active', limit: 5000 });
  assert.deepStrictEqual(F.filtersToRpc({ search: '  meena ', class_label: '8', board: 'CBSE', academic_year: '', only_due: true }),
    { status: 'active', limit: 5000, search: 'meena', class_label: '8', board: 'CBSE', only_due: true });
});
test('totals: due now adds only what is owed; money hidden gives null amounts', () => {
  const rows = [
    { total_fees: 22000, paid: 5000, balance_due_now: 7000 },
    { total_fees: 15000, paid: 16000, balance_due_now: -1000 },
  ];
  assert.deepStrictEqual(F.listTotals(rows), { students: 2, with_dues: 1, total_fees: 37000, paid: 21000, due_now: 7000, money: true });
  const hidden = F.listTotals([{ money_hidden: true, balance_due_now: null }]);
  assert.strictEqual(hidden.money, false);
  assert.strictEqual(hidden.due_now, null);
});
test('pages of 50, kept in range', () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);
  const p = F.pageOf(rows, 3);
  assert.deepStrictEqual([p.page, p.pages, p.from, p.to, p.rows.length], [3, 3, 101, 120, 20]);
  assert.strictEqual(F.pageOf(rows, 9).page, 3);
  assert.strictEqual(F.pageOf(rows, 0).page, 1);
  assert.deepStrictEqual(F.pageOf([], 1), { rows: [], page: 1, pages: 1, from: 0, to: 0 });
});
test('filter choices sort classes as numbers', () => {
  assert.deepStrictEqual(F.choices([{ c: '10' }, { c: '8' }, { c: 'LKG' }, { c: '9' }, { c: '8' }, { c: '' }], 'c'), ['8', '9', '10', 'LKG']);
});

// ----- payments -----
test('payment form check', () => {
  const ok = { amount: '2,000', paid_on: '2026-10-25', mode: 'upi', reference: 'UTR1234' };
  assert.strictEqual(F.paymentProblem(ok, '2026-10-25'), '');
  assert.match(F.paymentProblem({ ...ok, amount: '0' }, '2026-10-25'), /amount/);
  assert.match(F.paymentProblem({ ...ok, paid_on: '2026-10-26' }, '2026-10-25'), /future/);
  assert.match(F.paymentProblem({ ...ok, reference: '' }, '2026-10-25'), /reference/);
  assert.match(F.paymentProblem({ ...ok, reference: 'name@okbank' }, '2026-10-25'), /not a UPI ID/);
  assert.strictEqual(F.paymentProblem({ ...ok, mode: 'cash', reference: '' }, '2026-10-25'), '');
  assert.match(F.paymentProblem({ ...ok, mode: 'gold' }, '2026-10-25'), /how it was paid/);
  assert.deepStrictEqual(F.REF_MODES, ['upi', 'bank', 'card']);
});
test('payments: receipts, reversals and reversed payments', () => {
  const rows = F.paymentRows([
    { id: 'bbbbbbbb-1', reverses_id: 'aaaaaaaa-1' },
    { id: 'aaaaaaaa-1', reversed_by: 'bbbbbbbb-1' },
    { id: 'cccccccc-1' },
  ]);
  assert.deepStrictEqual(rows.map((r) => [r.receipt, r.is_reversal, r.reversed, r.of_receipt, r.reversal_receipt]), [
    ['R-BBBBBBBB', true, false, 'R-AAAAAAAA', ''],
    ['R-AAAAAAAA', false, true, '', 'R-BBBBBBBB'],
    ['R-CCCCCCCC', false, false, '', ''],
  ]);
  assert.strictEqual(F.modeLabel('bank'), 'Bank transfer');
});

// ----- summary -----
test('month range and collections by mode', () => {
  assert.deepStrictEqual(F.monthRange(new Date(2026, 9, 25)), { from: '2026-10-01', to: '2026-10-25' });
  assert.deepStrictEqual(F.collectedByMode({ by_mode: [{ mode: 'cash', payments: 2, amount: 3000 }, { mode: 'upi', payments: 1, amount: 9000 }] })
    .map((m) => [m.label, m.amount]), [['UPI', 9000], ['Cash', 3000]]);
});
test('the summary no longer adds up promises per calling list in the browser (one definition, on the server)', () => {
  // "Broken promises" used to be promises_vs_payments of each running fees list added up here (every promise call,
  // 2 days of grace); Reports counted open promises in admin_fees_ledger. Both now read admin_fees_ledger.
  assert.strictEqual(F.promiseTotals, undefined);
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'fees.js'), 'utf8');
  assert.ok(!/promises_vs_payments|ledger_collected/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.ok(/S\.loadFeeNumbers\(ctx, r\)/.test(src) && /S\.feeCards\(summary, 'this month'\)/.test(src));
});
test('fees campaign name', () => {
  assert.strictEqual(F.campaignName({}), 'Fees');
  assert.strictEqual(F.campaignName({ class_label: '8', board: 'CBSE', due_by: '2026-11-15' }), 'Fees · 8 · CBSE · due by 15 Nov');
});

// ----- roles -----
test('who sees the tab and who changes the ledger', () => {
  const owner = { role: 'admin', access_role: 'owner' };
  const oldAdmin = { role: 'admin' };
  const manager = { role: 'admin', access_role: 'manager' };
  const accounts = { role: 'accounts', access_role: 'accounts' };
  const caller = { role: 'rep', access_role: 'caller' };
  assert.deepStrictEqual([owner, oldAdmin, manager, accounts, caller].map((s) => F.tabVisible(s, false)), [true, true, false, true, false]);
  assert.strictEqual(F.tabVisible(manager, true), true);
  assert.deepStrictEqual([owner, manager, accounts, caller].map(F.canManage), [true, false, true, false]);
  assert.deepStrictEqual([owner, manager, accounts].map((s) => F.canMakeCampaign(s, true)), [true, true, true]);
  assert.strictEqual(F.canMakeCampaign(manager, false), false);
  assert.strictEqual(F.isAccounts({ role: 'accounts' }), true);
  assert.deepStrictEqual(F.ACCOUNTS_TABS, ['fees']);   // the fees collection report is inside Fees
});

// ----- static checks -----
test('the tab is registered, loaded after its helpers, and styled with .tab-fees rules', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'fees.js'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'shell.js'), 'utf8');
  assert.ok(/registerTab\(\{\s*id: 'fees'/.test(src));
  assert.ok(html.indexOf('<script src="js/lead-upload.js">') < html.indexOf('<script src="js/admin/fees.js">'));
  assert.ok(html.indexOf('<script src="js/admin/fees.js">') < html.indexOf('<script src="js/admin/shell.js">'));
  assert.ok(html.includes('<link rel="stylesheet" href="css/admin-fees.css">'));
  assert.ok(/S\.tabsFor\(ctx\.seat, ctx\.canSeeMoney\)/.test(shell));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|style=/.test(src));
  const css = fs.readFileSync(path.join(root, 'web', 'css', 'admin-fees.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  css.replace(/([^{}]+)\{/g, (m, sel) => { selectors.push(sel.trim()); return m; });
  selectors.filter((s) => !s.startsWith('@media')).forEach((s) => s.split(',').forEach((one) => {
    assert.ok(/^(\.tab-fees|body\.fees-printing)\b/.test(one.trim()), one.trim());
  }));
});
