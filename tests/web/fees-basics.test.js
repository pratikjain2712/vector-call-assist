'use strict';
/* Tests for the pure helpers in web/js/admin/fees-basics.js: the fee plan form check and data, the preview
   before applying a plan (counts, ticks and the sentence), the "Done" text, discount maths (as the server
   splits it), the day closing totals and its amount in words, and the Excel sheets. Plus static checks: the
   file is loaded after fees.js, builds with el() only, and the two parts are registered.
   Run: node --test tests/web/fees-basics.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const B = require(path.join(root, 'web', 'js', 'admin', 'fees-basics.js'));

// ----- the plan form -----
test('academic year: April to March', () => {
  assert.strictEqual(B.academicYearFor(new Date(2026, 9, 26)), '2026-27');
  assert.strictEqual(B.academicYearFor(new Date(2027, 1, 10)), '2026-27');
  assert.strictEqual(B.academicYearFor(new Date(2027, 3, 1)), '2027-28');
  assert.strictEqual(B.academicYearFor(new Date(2099, 5, 1)), '2099-00');
});

test('class in words', () => {
  assert.strictEqual(B.classText({ class_label: '8th' }), 'Class 8');
  assert.strictEqual(B.classText({ class_label: '8', board: 'CBSE' }), 'Class 8 (CBSE)');
  assert.strictEqual(B.classText({ class_label: '10th', section: 'A', board: 'ICSE' }), 'Class 10-A (ICSE)');
  assert.strictEqual(B.classText({ class_label: 'Nursery' }), 'Class Nursery');
});

test('a new plan starts with Term 1 and Term 2 tuition, amounts empty', () => {
  const f = B.starterFees('2026-27');
  assert.deepStrictEqual(f.map((x) => [x.head, x.amount, x.due_date, x.who]),
    [['Term 1 tuition', '', '2026-04-15', 'all'], ['Term 2 tuition', '', '2026-10-15', 'all']]);
});

test('plan form problems point at the step and the field', () => {
  const ok = { class_label: '8', academic_year: '2026-27', items: [{ head: 'Term 1 tuition', amount: '18,000', due_date: '2026-04-15', who: 'all' }] };
  assert.strictEqual(B.planProblem(ok), null);
  assert.deepStrictEqual(B.planProblem({ ...ok, class_label: ' ' }), { step: 1, field: 'class', text: 'Write the class. For example: 8' });
  assert.strictEqual(B.planProblem({ ...ok, academic_year: '2026' }).field, 'year');
  assert.strictEqual(B.planProblem({ ...ok, items: [{ head: '', amount: '' }] }).field, 'fee-0-head');
  assert.strictEqual(B.planProblem({ ...ok, items: [{ head: 'T1', amount: 'abc', due_date: '2026-04-15' }] }).field, 'fee-0-amount');
  assert.strictEqual(B.planProblem({ ...ok, items: [{ head: 'T1', amount: '100', due_date: '' }] }).field, 'fee-0-due');
  assert.match(B.planProblem({ ...ok, items: [ok.items[0], { ...ok.items[0], head: 'term 1 TUITION' }] }).text, /twice/);
  // blank lines are skipped, not errors
  assert.strictEqual(B.planProblem({ ...ok, items: [ok.items[0], { head: '', amount: '', due_date: '' }] }), null);
  assert.strictEqual(B.planProblem({ ...ok, rules: [{ reason: 'sibling', percent: '150' }] }).field, 'rule-0-percent');
  assert.strictEqual(B.planProblem({ ...ok, rules: [{ reason: 'other', percent: '10', note: '' }] }).field, 'rule-0-note');
  assert.strictEqual(B.planProblem({ ...ok, rules: [{ reason: 'merit', percent: '10', head: 'Bus' }] }).field, 'rule-0-head');
  assert.strictEqual(B.planProblem({ ...ok, rules: [{ reason: 'sibling', percent: '10%', head: 'Term 1 tuition' }] }), null);
});

test('plan data for fee_plan_save', () => {
  const d = B.planData({ class_label: ' 8 ', academic_year: '2026-2027', board: 'CBSE', auto_apply: true,
    items: [{ id: 'i1', head: 'Term 1 tuition', amount: '₹18,000', due_date: '15/04/2026', who: 'all' }, { head: '', amount: '' },
      { head: 'Bus fee', amount: '5500', due_date: '2026-04-15', who: 'bus' }],
    rules: [{ reason: 'sibling', percent: '10%', head: 'Term 1 tuition', note: '' }] });
  assert.deepStrictEqual(d, {
    academic_year: '2026-27', class_label: '8', board: 'CBSE', section: '', auto_apply: true,
    items: [{ id: 'i1', head: 'Term 1 tuition', amount: 18000, due_date: '2026-04-15', who: 'all' }, { head: 'Bus fee', amount: 5500, due_date: '2026-04-15', who: 'bus' }],
    rules: [{ reason: 'sibling', percent: 10, heads: ['Term 1 tuition'] }],
  });
});

// ----- the preview -----
// Class 8: 4 students. Term 2 (all): 3 missing, 1 already has it. Bus fee (bus): S1 uses the bus. A sibling rule.
const preview = {
  plan: { id: 'p', class_label: '8th', board: null, academic_year: '2026-27' }, money_hidden: false, students: 4,
  items: [
    { id: 't2', head: 'Term 2 tuition', amount: 18000, who: 'all', missing: 3, same: 1, has: 0, change: 0, other: 0, cancelled: 0 },
    { id: 'bus', head: 'Bus fee', amount: 5500, who: 'bus', missing: 3, same: 0, has: 1, change: 0, other: 0, cancelled: 0 },
  ],
  removed: [], rules: [{ id: 'sib', reason: 'sibling', reason_label: 'Sibling', percent: 10 }],
  rows: [
    { student_id: 's1', name: 'Asha', uses_bus: true, items: { t2: 'missing', bus: 'missing' }, rules: [] },
    { student_id: 's2', name: 'Bala', uses_bus: false, items: { t2: 'missing', bus: 'missing' }, rules: [] },
    { student_id: 's3', name: 'Chirag', uses_bus: false, items: { t2: 'missing', bus: 'missing' }, rules: ['sib'] },
    { student_id: 's4', name: 'Dina', uses_bus: true, items: { t2: 'same', bus: 'has' }, rules: [] },
  ],
};

test('default ticks: bus fees for bus students only, discounts for nobody', () => {
  const t = B.defaultTicks(preview);
  assert.deepStrictEqual([...t.items.bus], ['s1']);
  assert.deepStrictEqual([...t.rules.sib], []);
  assert.strictEqual(t.items.t2, undefined);
});

test('preview with default ticks: two fees, the sentence with ₹ and Continue?', () => {
  const p = B.planPreview(preview);
  assert.deepStrictEqual(p.perItem.map((x) => [x.head, x.add, x.already]), [['Term 2 tuition', 3, 1], ['Bus fee', 1, 1]]);
  assert.strictEqual(p.addFees, 4);
  assert.strictEqual(p.addAmount, 3 * 18000 + 5500);
  assert.strictEqual(p.students, 3);
  assert.strictEqual(p.sentence, 'This will add 4 fees (₹59,500 in all) for 3 students in Class 8. Continue?');
});

test('preview: one fee only reads like the office says it', () => {
  const t = B.defaultTicks(preview);
  t.items.bus.clear();
  const p = B.planPreview(preview, t);
  assert.strictEqual(p.sentence, 'This will add ₹18,000 Term 2 tuition for 3 students in Class 8. Continue?');
});

test('preview: ticks change the counts; a discount already given is not counted twice', () => {
  const t = B.defaultTicks(preview);
  t.items.bus.add('s2');
  t.rules.sib.add('s2');
  t.rules.sib.add('s3');   // already has it
  const p = B.planPreview(preview, t);
  assert.strictEqual(p.addFees, 5);
  assert.strictEqual(p.discounts, 1);
  assert.match(p.sentence, /It will also give 1 discount\./);
});

test('preview: changes and removed fees, money hidden', () => {
  const pv = { ...preview, money_hidden: true,
    items: [{ ...preview.items[0], amount: null, missing: 0, same: 0, has: 1, change: 3 }],
    rows: preview.rows.map((r) => ({ ...r, items: { t2: r.student_id === 's4' ? 'has' : 'change' } })),
    removed: [{ id: 'lab', head: 'Lab kit', students: 2 }], rules: [] };
  const p = B.planPreview(pv, { items: {}, rules: {} });
  assert.strictEqual(p.addFees, 0);
  assert.strictEqual(p.addAmount, null);
  assert.strictEqual(p.change, 3);
  assert.strictEqual(p.remove, 2);
  assert.strictEqual(p.students, 3);
  assert.strictEqual(p.sentence, 'This will change Term 2 tuition for 3 students, cancel Lab kit for 2 students in Class 8. Continue?');
});

test('preview: nothing to do', () => {
  const pv = { ...preview, items: [{ ...preview.items[0], missing: 0, same: 4 }], rows: preview.rows.map((r) => ({ ...r, items: { t2: 'same' } })), rules: [] };
  const p = B.planPreview(pv, { items: {}, rules: {} });
  assert.strictEqual(p.nothing, true);
  assert.strictEqual(p.sentence, 'Every student in Class 8 already has these fees. Nothing to add.');
});

test('done text after applying', () => {
  assert.strictEqual(B.applyDoneText({ added: 266, students: 133 }, { class_label: '8th' }), 'Done. 266 fees added for 133 students. Balances and calling lists are updated.');
  assert.strictEqual(B.applyDoneText({ added: 0, changed: 3, removed: 1, discounts: 2, students: 3 }), 'Done. 3 fees changed, 1 fee cancelled, 2 discounts given for 3 students. Balances and calling lists are updated.');
  assert.strictEqual(B.applyDoneText({ added: 0, students: 0 }, { class_label: '8th', board: 'CBSE' }), 'Nothing to add: every student in Class 8 (CBSE) already has these fees.');
});

// ----- discounts -----
const fees = [
  { id: 't2', head: 'Term 2 tuition', amount: 12000, left: 12000, due_date: '2026-11-25' },
  { id: 't1', head: 'Term 1 tuition', amount: 10000, left: 10000, due_date: '2026-09-25' },
  { id: 'lab', head: 'Lab kit', amount: 500, left: 500, due_date: '2026-10-25' },
];

test('discount maths: an amount is split by what is left, oldest fee first, paise on the last', () => {
  const s = B.discountSplit(fees, 'amount', 1000);
  assert.deepStrictEqual(s.lines.map((l) => [l.id, l.amount]), [['t1', 444.44], ['lab', 22.22], ['t2', 533.34]]);
  assert.strictEqual(s.total, 1000);
  assert.strictEqual(s.problem, '');
});

test('discount maths: a percent applies to each fee, never more than what is left', () => {
  const s = B.discountSplit(fees, 'percent', 10);
  assert.deepStrictEqual(s.lines.map((l) => [l.id, l.amount]), [['t1', 1000], ['lab', 50], ['t2', 1200]]);
  assert.strictEqual(s.total, 2250);
  const part = B.discountSplit([{ id: 'x', head: 'X', amount: 500, left: 100, due_date: '2026-01-01' }], 'percent', 50);
  assert.deepStrictEqual(part.lines.map((l) => l.amount), [100]);
});

test('discount maths: problems', () => {
  assert.match(B.discountSplit(fees, 'amount', 99999).problem, /more than what is left to pay on these fees \(₹22,500\)/);
  assert.match(B.discountSplit(fees, 'percent', 120).problem, /at most 100/);
  assert.match(B.discountSplit([], 'amount', 10).problem, /no fees/);
  assert.match(B.discountSplit(fees, 'amount', 0).problem, /Write the discount/);
  assert.match(B.discountSplit([{ id: 'x', head: 'X', amount: 500, left: 0 }], 'amount', 10).problem, /no fees/);
});

test('discount form check and data', () => {
  const ok = { kind: 'percent', value: '10%', whole_year: true, reason: 'sibling', approved_by: 'Kavita' };
  assert.strictEqual(B.discountProblem(ok), '');
  assert.match(B.discountProblem({ ...ok, value: '' }), /percent/);
  assert.match(B.discountProblem({ ...ok, kind: 'amount', value: 'abc' }), /rupees/);
  assert.match(B.discountProblem({ ...ok, value: '120' }), /at most 100/);
  assert.match(B.discountProblem({ ...ok, whole_year: false, fee_items: [] }), /Tick at least one fee/);
  assert.match(B.discountProblem({ ...ok, reason: 'other' }), /what the discount is for/);
  assert.match(B.discountProblem({ ...ok, reason: 'boss' }), /reason/);
  assert.deepStrictEqual(B.discountData(ok), { kind: 'percent', value: 10, whole_year: true, reason: 'sibling', approved_by: 'Kavita' });
  assert.deepStrictEqual(B.discountData({ kind: 'amount', value: '₹2,000', whole_year: false, fee_items: ['a'], reason: 'other', note: ' Brother ' }),
    { kind: 'amount', value: 2000, whole_year: false, reason: 'other', fee_items: ['a'], note: 'Brother' });
});

test('discount in one line', () => {
  assert.strictEqual(B.discountText({ reason: 'sibling', reason_label: 'Sibling', percent: 10, scope: 'fees', fees: [{ head: 'Term 1 tuition' }, { head: 'Term 2 tuition' }] }),
    'Sibling · 10% on Term 1 tuition, Term 2 tuition');
  assert.strictEqual(B.discountText({ reason: 'other', percent: null, scope: 'year', note: 'Brother in Class 5', fees: [] }), 'Other · on the whole year (Brother in Class 5)');
  assert.strictEqual(B.reasonLabel('staff_child'), 'Staff child');
});

// ----- the day closing -----
const closing = {
  day: '2026-10-26', today: '2026-10-26', money_hidden: false,
  totals: { payments: 4, amount: 157500, reversed: 1, reversed_amount: 5000, cheques: 1, cheque_amount: 14000 },
  by_mode: [{ mode: 'cash', payments: 2, amount: 51000 }, { mode: 'upi', payments: 1, amount: 92500 }, { mode: 'cheque', payments: 1, amount: 14000 },
    { mode: 'card', payments: 0, amount: 0 }, { mode: 'bank', payments: 0, amount: 0 }, { mode: 'other', payments: 0, amount: 0 }],
  by_person: [{ label: 'Kavita Joshi', payments: 3, amount: 125000 }, { label: 'Anita Sharma', payments: 1, amount: 32500 }],
  payments: [{ at: '2026-10-26T04:30:00Z', student: 'Asha', class_label: '8th', section: 'A', amount: 14000, mode: 'cheque', reference: 'Cheque 100234', recorded_by_label: 'Kavita Joshi', reversed: false },
    { at: '2026-10-26T05:00:00Z', student: 'Bala', class_label: '8th', section: 'B', amount: 5000, mode: 'cash', reference: null, recorded_by_label: 'Kavita Joshi', reversed: true, reversed_reason: 'Wrong amount' }],
  cheques: [{ student: 'Asha', class_label: '8th', section: 'A', amount: 14000, reference: 'Cheque 100234' }],
  reversals: [{ at: '2026-10-26T05:05:00Z', student: 'Bala', class_label: '8th', section: 'B', amount: 5000, mode: 'cash', reason: 'Wrong amount', recorded_by_label: 'Kavita Joshi', paid_on: '2026-10-26' }],
};

test('day closing totals: all six modes in order, persons, cheques, the total in words', () => {
  const x = B.dayTotals(closing);
  assert.deepStrictEqual(x.modes.map((m) => [m.label, m.payments, m.amount]),
    [['Cash', 2, 51000], ['UPI', 1, 92500], ['Cheque', 1, 14000], ['Card', 0, 0], ['Bank transfer', 0, 0], ['Other', 0, 0]]);
  assert.strictEqual(x.modes.reduce((s, m) => s + m.amount, 0), x.total);
  assert.strictEqual(x.persons.reduce((s, m) => s + m.amount, 0), x.total);
  assert.strictEqual(x.total, 157500);
  assert.strictEqual(x.words, 'Rupees One Lakh Fifty Seven Thousand Five Hundred Only');
  assert.deepStrictEqual([x.cheques.count, x.cheques.amount, x.reversed.count, x.reversed.amount], [1, 14000, 1, 5000]);
});

test('day closing totals without money: counts only, no words', () => {
  const x = B.dayTotals({ ...closing, money_hidden: true, totals: { ...closing.totals, amount: null } });
  assert.strictEqual(x.total, null);
  assert.strictEqual(x.words, '');
  assert.strictEqual(x.count, 4);
  assert.strictEqual(x.modes[0].amount, null);
  // missing modes still show, as 0
  assert.strictEqual(B.dayTotals({ money_hidden: false, totals: {}, by_mode: [] }).modes.length, 6);
});

test('day closing Excel: four sheets, ₹ columns only with money', () => {
  const sh = B.daySheets(closing, 'Sunrise');
  assert.deepStrictEqual(sh.map((s) => s.name), ['Summary', 'Payments', 'Cheques', 'Reversals']);
  assert.ok(sh[0].headers.includes('Amount (₹)'));
  assert.deepStrictEqual(sh[0].rows[sh[0].rows.length - 1], ['Grand total', '', 4, 157500]);
  assert.ok(sh[0].notes.some((n) => n.includes('One Lakh Fifty Seven Thousand')));
  assert.deepStrictEqual(sh[1].rows[1].slice(1, 5), ['Bala', '8th-B', '', 5000]);
  assert.strictEqual(sh[1].rows[1][8], 'Cancelled: Wrong amount');
  assert.deepStrictEqual(sh[2].rows[0], ['Asha', '8th-A', 'Cheque 100234', 14000, '']);
  const hidden = B.daySheets({ ...closing, money_hidden: true });
  hidden.forEach((s) => assert.ok(!s.headers.some((h) => h.includes('₹')), s.name));
});

// ----- static checks -----
test('loaded after fees.js and before the shell; el() only; both parts registered; styles scoped', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'fees-basics.js'), 'utf8');
  const fees = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'fees.js'), 'utf8');
  const at = (f) => html.indexOf('<script src="js/admin/' + f + '">');
  assert.ok(at('fees.js') > 0 && at('fees.js') < at('fees-basics.js') && at('fees-basics.js') < at('shell.js'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|style=/.test(src));
  assert.ok(/id: 'fee-plans',\s*label: 'Fee plan',\s*part: true/.test(src));
  assert.ok(/id: 'day-closing',[\s\S]{0,60}part: true/.test(src));
  assert.ok(/'log_money_export', \{ p_institute: day\.ctx\.institute\.id, p_what: 'day_closing'/.test(src));
  assert.ok(fees.includes("href: '#fees/today'") && fees.includes("text: 'Today\\'s collection'"));
  assert.ok(fees.includes("text: 'Cancel this fee'") && !/text: 'Void'/.test(fees));
});
