'use strict';
/* Tests for the pure helpers of web/js/admin/collect.js (Collect fee, Pending dues) and web/js/admin/centres.js
   (the centre switcher, the centre added to RPCs, batches): search ranking, amount chips, the mode to start
   with, the form check and the Save words, Undo's 10 minutes, the WhatsApp receipt, and the centre filter
   helpers. Plus static checks: both files are loaded by admin.html before shell.js, build with el() only, and
   every RPC they name exists in the migrations.
   Run: node --test tests/web/collect.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const CO = require(path.join(root, 'web', 'js', 'admin', 'collect.js'));
const C = require(path.join(root, 'web', 'js', 'admin', 'centres.js'));

const students = [
  { name: 'Riya Bhosale', parent_name: 'Sunita Bhosale', admission_no: 'A201', phone: '+919999000201' },
  { name: 'Aarav Shah', parent_name: 'Meena Shah', admission_no: 'A101', phone: '+919876500001' },
  { name: 'Bhoomi Rao', parent_name: 'Ravi Rao', admission_no: 'B7', phone: '+919876500777' },
  { name: 'Kavya Mariya', parent_name: 'Riya Mariya', admission_no: 'C9', phone: null },
];

// ----- search ranking -----
test('ranking: admission no first, then name start, then a word of the name, then the parent', () => {
  assert.deepStrictEqual(CO.rankRows(students, 'bho').map((r) => r.name + ':' + r.rank), ['Bhoomi Rao:1', 'Riya Bhosale:2']);
  assert.deepStrictEqual(CO.rankRows(students, 'riya').map((r) => r.name + ':' + r.rank), ['Riya Bhosale:1', 'Kavya Mariya:3']);
  assert.strictEqual(CO.rankRows(students, 'a101')[0].rank, 0);
  assert.strictEqual(CO.rankRows(students, 'A1')[0].name, 'Aarav Shah');   // admission no starts with it
  assert.deepStrictEqual(CO.rankRows(students, 'sunita riya').map((r) => r.rank), [3]);
});
test('ranking: 4+ phone digits, "contains" only from 3 letters, nothing for empty', () => {
  assert.deepStrictEqual(CO.rankRows(students, '0777').map((r) => r.name), ['Bhoomi Rao']);
  assert.deepStrictEqual(CO.rankRows(students, '077').map((r) => r.name), []);
  assert.deepStrictEqual(CO.rankRows(students, 'ari').map((r) => r.name), ['Kavya Mariya']);   // "Mariya" contains it
  assert.deepStrictEqual(CO.rankRows(students, 'ar').map((r) => r.name), ['Aarav Shah'].filter(() => false));
  assert.deepStrictEqual(CO.rankRows(students, '   '), []);
  assert.strictEqual(CO.rankRows(students, 'a', 2).length, 2);
});

// ----- the form -----
test('amount chips: Full, one per fee when several are due, the next fee when nothing is due', () => {
  const info = { due_now: 6000, unpaid: [
    { fee_item_id: 'f1', head: 'Term 1 tuition', left: 4000, is_due: true, due_date: '2026-09-17' },
    { fee_item_id: 'f2', head: 'Exam fee', left: 2000, is_due: true, due_date: '2026-10-22' },
    { fee_item_id: 'f3', head: 'Term 2 tuition', left: 5000, is_due: false, due_date: '2026-11-26' }] };
  assert.deepStrictEqual(CO.amountChips(info).map((c) => c.label + '=' + c.amount),
    ['Full ₹6,000=6000', 'Term 1 tuition ₹4,000=4000', 'Exam fee ₹2,000=2000']);
  assert.deepStrictEqual(CO.amountChips({ due_now: 4000, unpaid: [info.unpaid[0], info.unpaid[2]] }).map((c) => c.label), ['Full ₹4,000']);
  assert.deepStrictEqual(CO.amountChips({ due_now: 0, unpaid: [info.unpaid[2]] }).map((c) => c.label), ['Term 2 tuition ₹5,000 · due 26 Nov']);
  assert.deepStrictEqual(CO.amountChips({ due_now: -500, unpaid: [] }), []);
  assert.deepStrictEqual(CO.amountChips({ money_hidden: true, due_now: null, unpaid: info.unpaid }), []);
  assert.strictEqual(CO.startAmount({ due_now: 6000 }), '6000');
  assert.strictEqual(CO.startAmount({ due_now: 0 }), '');
  assert.strictEqual(CO.startAmount({ due_now: 1250.5 }), '1250.5');
  assert.strictEqual(CO.startAmount({ money_hidden: true, due_now: null }), '');
});
test('mode to start with: the institute\'s most used mode, card as Card/Bank, else Cash', () => {
  assert.strictEqual(CO.modeDefault('upi'), 'upi');
  assert.strictEqual(CO.modeDefault('card'), 'bank');
  assert.strictEqual(CO.modeDefault('other'), 'cash');
  assert.strictEqual(CO.modeDefault(undefined), 'cash');
  assert.deepStrictEqual(CO.MODES.map((m) => m[1]), ['Cash', 'UPI', 'Cheque', 'Card/Bank']);
  assert.strictEqual(CO.refLabel('cash'), null);
  assert.strictEqual(CO.refLabel('cheque'), 'Cheque no.');
  assert.ok(CO.refLabel('upi').startsWith('UTR'));
});
test('form check and the Save words', () => {
  const ok = { amount: '6,000', mode: 'cash', reference: '', note: '', paid_on: '2026-10-27' };
  assert.strictEqual(CO.collectProblem(ok, '2026-10-27'), '');
  assert.strictEqual(CO.collectProblem({ ...ok, amount: '' }, '2026-10-27'), 'Enter the amount paid.');
  assert.strictEqual(CO.collectProblem({ ...ok, amount: '12abc' }, '2026-10-27'), 'Enter the amount paid.');
  assert.strictEqual(CO.collectProblem({ ...ok, amount: '0' }, '2026-10-27'), 'Enter the amount paid.');
  assert.match(CO.collectProblem({ ...ok, mode: 'upi' }, '2026-10-27'), /UTR/);
  assert.match(CO.collectProblem({ ...ok, mode: 'cheque' }, '2026-10-27'), /cheque number/);
  assert.match(CO.collectProblem({ ...ok, mode: 'upi', reference: 'riya@okaxis' }, '2026-10-27'), /not a UPI ID/);
  assert.strictEqual(CO.collectProblem({ ...ok, mode: 'upi', reference: '512345678901' }, '2026-10-27'), '');
  assert.match(CO.collectProblem({ ...ok, paid_on: '2026-10-28' }, '2026-10-27'), /future/);
  assert.match(CO.collectProblem({ ...ok, note: 'x'.repeat(301) }, '2026-10-27'), /too long/);
  assert.strictEqual(CO.saveLabel('6000'), 'Save ₹6,000');
  assert.strictEqual(CO.saveLabel('₹ 1,25,000'), 'Save ₹1,25,000');
  assert.strictEqual(CO.saveLabel('99.5'), 'Save ₹99.50');
  assert.strictEqual(CO.saveLabel(''), 'Save');
  assert.strictEqual(CO.parseRupees('Rs. 500'), 500);
  assert.ok(Number.isNaN(CO.parseRupees('5,00x')));
});
test('Undo for 10 minutes; the receipt for WhatsApp; the "By you" line', () => {
  assert.strictEqual(CO.canUndo(1000, 1000 + 9 * 60000), true);
  assert.strictEqual(CO.canUndo(1000, 1000 + 10 * 60000), false);
  assert.strictEqual(CO.canUndo(null, 5), false);
  const msg = CO.receiptMessage({ receipt: 'R-1A2B3C4D', institute: 'Sunrise', amount: 6000, student: 'Riya Bhosale', paid_on: '2026-10-27', mode: 'upi', reference: '512345678901', left: 5000 });
  assert.match(msg, /Fee receipt R-1A2B3C4D from Sunrise/);
  assert.match(msg, /Received ₹6,000 for Riya Bhosale on 27 Oct 2026 \(UPI, 512345678901\)/);
  assert.match(msg, /Left to pay: ₹5,000/);
  assert.strictEqual(CO.waNumber('+919999000201'), '919999000201');
  assert.strictEqual(CO.waNumber('98765 43210'), '919876543210');
  assert.strictEqual(CO.waLink('', 'x'), '');
  assert.ok(CO.waLink('+919999000201', 'a b').startsWith('https://wa.me/919999000201?text=a%20b'));
  assert.strictEqual(CO.meLine({ today_amount: 12500, month_amount: 124000 }), 'By you today ₹12,500 · this month ₹1,24,000');
  assert.strictEqual(CO.meLine({ money_hidden: true, today_payments: 1, month_payments: 4 }), 'By you today 1 payment · this month 4 payments');
  assert.strictEqual(CO.classLine({ class_label: '8', section: 'A', board: 'State', batch_name: '8th SB Morning' }), 'Class 8-A · State · 8th SB Morning');
  assert.strictEqual(CO.dueText({ due_now: 0 }), 'No dues');
  assert.strictEqual(CO.dueText({ money_hidden: true, has_dues: true }), 'Has dues');
});

// ----- centres -----
const listData = {
  has_centres: true, my_centre_ids: null,
  centres: [{ id: 'cA', name: 'Andheri', active: true }, { id: 'cB', name: 'Borivali', active: true }, { id: 'cT', name: 'Thane', active: false }],
  batches: [{ id: 'b1', centre_id: 'cA', name: '8th SB Morning', active: true }, { id: 'b2', centre_id: 'cB', name: '8th SB Evening', active: true },
    { id: 'b3', centre_id: null, name: '10th CBSE A', active: true }, { id: 'b4', centre_id: 'cA', name: 'Old', active: false }],
};
test('centre filter: the centre is added to the RPCs that take it, with their other arguments', () => {
  assert.deepStrictEqual(C.withCentre('admin_fees_ledger', { p_institute: 'i', p_from: 'a', p_to: 'b' }, 'cA'),
    { p_institute: 'i', p_from: 'a', p_to: 'b', p_campaign: null, p_seat: null, p_centre: 'cA' });
  assert.deepStrictEqual(C.withCentre('admin_home_summary', { p_day: 'week', p_campaign: null }, 'cA'), { p_day: 'week', p_campaign: null, p_centre: 'cA' });
  assert.deepStrictEqual(C.withCentre('my_suggestions', undefined, 'cA'), { p_centre: 'cA' });
  assert.deepStrictEqual(C.withCentre('admin_promises_ledger', { p_institute: 'i' }, 'cA'),
    { p_institute: 'i', p_campaign: null, p_seat: null, p_days: 7, p_centre: 'cA' });
  assert.deepStrictEqual(C.withCentre('accounts_students', { p_filters: { search: 'x' } }, 'cA'), { p_filters: { search: 'x', centre_id: 'cA' } });
  assert.deepStrictEqual(C.withCentre('accounts_create_fees_campaign', { p_name: 'Fees' }, 'cA').p_start, true);
  // Unchanged: no centre picked, an RPC without a centre, or a centre already chosen.
  const args = { p_institute: 'i' };
  assert.strictEqual(C.withCentre('admin_fees_ledger', args, ''), args);
  assert.strictEqual(C.withCentre('accounts_record_payment', args, 'cA'), args);
  assert.deepStrictEqual(C.withCentre('collect_search', { p_q: 'r', p_centre: null }, 'cA'), { p_q: 'r', p_centre: null });
  assert.deepStrictEqual(C.withCentre('admin_campaign_list', { p_centre: 'cB' }, 'cA'), { p_centre: 'cB' });
});
test('centres: the switcher, the remembered centre and the batches of a centre', () => {
  const all = C.normalise(listData);
  assert.strictEqual(all.has, true);
  assert.deepStrictEqual(C.switchOptions(all).options.map((o) => o.label), ['All centres', 'Andheri', 'Borivali']);
  const one = C.normalise({ ...listData, my_centre_ids: ['cA'] });
  assert.strictEqual(C.switchOptions(one).fixed.name, 'Andheri');
  const two = C.normalise({ ...listData, my_centre_ids: ['cA', 'cB'] });
  assert.deepStrictEqual(C.switchOptions(two).options.map((o) => o.label), ['All my centres', 'Andheri', 'Borivali']);
  assert.strictEqual(C.normalise({ has_centres: false, centres: [] }).has, false);
  assert.deepStrictEqual(C.switchOptions(C.normalise(null)).options, []);
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  assert.strictEqual(C.readCentre(ls, 'Me@x.in', all), '');
  assert.strictEqual(C.writeCentre(ls, 'me@x.in', 'cB'), true);
  assert.strictEqual(C.readCentre(ls, 'ME@x.in', all), 'cB');
  assert.strictEqual(C.readCentre(ls, 'me@x.in', one), 'cA');            // a person limited to one centre: that one
  C.writeCentre(ls, 'me@x.in', 'cT');
  assert.strictEqual(C.readCentre(ls, 'me@x.in', all), '');              // a centre turned off is not picked
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.strictEqual(C.readCentre(broken, 'me', all), '');
  assert.strictEqual(C.writeCentre(broken, 'me', 'cA'), false);
  assert.deepStrictEqual(C.batchesFor(all.batches, 'cA').map((b) => b.name), ['8th SB Morning', '10th CBSE A']);
  assert.deepStrictEqual(C.batchesFor(all.batches, '').map((b) => b.name), ['8th SB Evening', '8th SB Morning', '10th CBSE A']);
  assert.strictEqual(C.centreName(all, 'cB'), 'Borivali');
});

// ----- static checks -----
test('page: centres.js loads before shell.js, collect.js after fees.js, and the stylesheet is linked', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
  const at = (s) => html.indexOf(s.startsWith('js/') ? 'src="' + s + '"' : s);
  assert.ok(at('js/admin/centres.js') > 0 && at('js/admin/centres.js') < at('js/admin/shell.js'));
  assert.ok(at('js/admin/collect.js') > at('js/admin/fees.js') && at('js/admin/collect.js') < at('js/admin/shell.js'));
  assert.ok(at('css/admin-collect.css') > 0);
  assert.ok(at('id="centre-pick"') > 0 && at('id="quickbar"') > 0);
});
test('collect.js and centres.js build with el() only and name RPCs that exist', () => {
  const sql = fs.readdirSync(path.join(root, 'supabase', 'migrations')).map((f) => fs.readFileSync(path.join(root, 'supabase', 'migrations', f), 'utf8')).join('\n');
  ['collect.js', 'centres.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(root, 'web', 'js', 'admin', f), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src), f + ' uses no HTML strings');
    const names = [...src.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(names.length > 0);
    names.forEach((n) => assert.ok(new RegExp('function public\\.' + n + '\\(').test(sql), f + ': ' + n + ' is in the migrations'));
  });
});
