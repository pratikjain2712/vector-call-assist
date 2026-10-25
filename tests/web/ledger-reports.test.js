'use strict';
/* Tests for the Phase A.2 fee-ledger helpers of Reports (web/js/admin/reports.js), Home (web/js/admin/home.js)
   and Insights (web/js/insights-model.js): ledger cards and money rules, collected by mode and by day, the
   ledger state of a promise, "send back" leaving paid promises out, the Excel workbook with a Ledger sheet, the
   Home fees tile and "Needs your attention", and promises kept measured against the ledger. No network, no DOM.
   Run: node --test tests/web/ledger-reports.test.js
   Prints "ledger-reports.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const R = require(path.join(root, 'web', 'js', 'admin', 'reports.js'));
const H = require(path.join(root, 'web', 'js', 'admin', 'home.js'));
const M = require(path.join(root, 'web', 'js', 'insights-model.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}
const hasRupee = (x) => /₹/.test(JSON.stringify(x));

const LED = {
  from: '2026-10-19', to: '2026-10-25', today: '2026-10-25', money_hidden: false, has_ledger: true, linked_leads: 4,
  due_now: { students: 3, amount: 22000 },
  collected: { payments: 4, reversed: 1, total: 18000,
    by_mode: [{ mode: 'bank', payments: 1, amount: 10000 }, { mode: 'cash', payments: 1, amount: 2000 }, { mode: 'upi', payments: 2, amount: 6000 }],
    by_day: [{ day: '2026-10-22', payments: 1, amount: 5000 }, { day: '2026-10-25', payments: 1, amount: 1000 }] },
  promised: { leads: 2, amount: 11000 },
  broken: { leads: 1, part_paid: 1, amount: 4000 },
  promises_paid: { leads: 1 },
};
const HIDDEN = JSON.parse(JSON.stringify(LED));
HIDDEN.money_hidden = true;
HIDDEN.due_now.amount = null; HIDDEN.collected.total = null; HIDDEN.promised.amount = null; HIDDEN.broken.amount = null;
HIDDEN.collected.by_mode.forEach((m) => { m.amount = null; });
HIDDEN.collected.by_day.forEach((m) => { m.amount = null; });

// ----- Reports: cards -----
test('ledger cards with money: due now and collected from the ledger, promised from calls', () => {
  const c = R.ledgerCards(LED, true);
  assert.deepStrictEqual(c.map((x) => x.label), ['Total due now', 'Collected', 'Promised, not yet paid', 'Broken promises']);
  assert.deepStrictEqual(c.map((x) => x.value), ['₹22,000', '₹18,000', '₹11,000', '1']);
  assert.strictEqual(c[0].sub, '3 students · fee ledger');
  assert.strictEqual(c[1].sub, '4 payments · fee ledger');
  assert.strictEqual(c[2].sub, '2 parents · from calls');
  assert.strictEqual(c[3].sub, 'Date passed, not paid in the ledger · 1 partly paid');
});
test('ledger cards without money: counts only, never ₹', () => {
  const c = R.ledgerCards(HIDDEN, false);
  assert.deepStrictEqual(c.map((x) => x.value), ['3', '4', '2', '1']);
  assert.ok(!hasRupee(c));
  assert.strictEqual(R.ledgerCards(null, false)[0].value, '0');
});

// ----- Reports: by mode and by day -----
test('collected by mode follows UPI, cash, cheque, card, bank, other and leaves out empty modes', () => {
  const m = R.modeSplit(LED.collected.by_mode.concat([{ mode: 'card', payments: 0, amount: 0 }]), true);
  assert.deepStrictEqual(m.map((x) => x.label), ['UPI', 'Cash', 'Bank transfer']);
  assert.deepStrictEqual(m.map((x) => x.text), ['₹6,000', '₹2,000', '₹10,000']);
  const hidden = R.modeSplit(HIDDEN.collected.by_mode, false);
  assert.deepStrictEqual(hidden.map((x) => x.text), ['2 payments', '1 payment', '1 payment']);
  assert.ok(hidden.every((x) => x.amount === null));
  assert.deepStrictEqual(R.modeSplit(null, true), []);
  assert.strictEqual(R.modeLabel('cheque'), 'Cheque');
});
test('collected by day fills every day of a short range with 0', () => {
  const d = R.dayRows(LED.collected.by_day, LED.from, LED.to);
  assert.strictEqual(d.length, 7);
  assert.deepStrictEqual(d[0], { day: '2026-10-19', payments: 0, amount: null });
  assert.deepStrictEqual(d[3], { day: '2026-10-22', payments: 1, amount: 5000 });
  assert.strictEqual(d[6].day, '2026-10-25');
});
test('collected by day lists only days with payments on a long range', () => {
  const d = R.dayRows(LED.collected.by_day, '2026-09-01', '2026-10-25');
  assert.deepStrictEqual(d.map((x) => x.day), ['2026-10-22', '2026-10-25']);
  assert.deepStrictEqual(R.dayRows(null, 'bad', 'dates'), []);
});

// ----- Reports: promises -----
test('ledger state of a promise: paid on a date by a mode, partly paid, not paid, not in the ledger', () => {
  assert.deepStrictEqual(R.ledgerStatus({ ledger_state: 'paid', paid_on: '2026-10-22', paid_mode: 'upi' }), { text: 'Paid on 22 Oct by UPI', level: 'good' });
  assert.deepStrictEqual(R.ledgerStatus({ ledger_state: 'part_paid', paid_amount: 2000 }, true), { text: 'Partly paid (₹2,000)', level: 'part' });
  assert.deepStrictEqual(R.ledgerStatus({ ledger_state: 'part_paid', paid_amount: null }, false), { text: 'Partly paid', level: 'part' });
  assert.deepStrictEqual(R.ledgerStatus({ ledger_state: 'not_paid' }), { text: 'Not paid', level: 'late' });
  assert.deepStrictEqual(R.ledgerStatus({ ledger_state: 'no_student' }), { text: 'Not in the fee ledger', level: 'later' });
  assert.deepStrictEqual(R.ledgerStatus(null), { text: '', level: '' });
});
test('send back leaves out promises paid in the ledger and closed leads', () => {
  const rows = [
    { lead_id: 'a', days_late: 2, lead_status: 'promised', ledger_state: 'part_paid' },
    { lead_id: 'b', days_late: 0, lead_status: 'promised', ledger_state: 'paid' },
    { lead_id: 'c', days_late: 1, lead_status: 'done', ledger_state: 'paid' },
    { lead_id: 'd', days_late: 0, lead_status: 'promised', ledger_state: 'not_paid' },
    { lead_id: 'e', days_late: -1, lead_status: 'promised', ledger_state: 'not_paid' },
  ];
  assert.deepStrictEqual(R.dueForSendBack(rows), ['a', 'd']);
});

// ----- Reports: Excel -----
const PROMISES = [
  { name: 'Mr Shah', extra: { Student: 'Riya', Class: '8' }, amount: 5000, promised_date: '2026-10-23', days_late: 2, caller: 'Rep 1',
    campaign: 'Oct fees', lead_status: 'promised', ledger_state: 'paid', paid_amount: 5000, paid_on: '2026-10-22', paid_mode: 'upi' },
];
const REP = { paid_calls: 85, paid_amount: 1440000 };
test('Excel with the ledger and money: summary, promises with the ledger column, and a Ledger sheet', () => {
  const s = R.feesSheets(REP, PROMISES, true, LED);
  assert.deepStrictEqual(s.map((x) => x.name), ['Fees collection', 'Promises due this week', 'Ledger']);
  assert.deepStrictEqual(s[0].headers, ['Measure', 'Count', 'Amount (₹)']);
  assert.deepStrictEqual(s[0].rows[0], ['Total due now (fee ledger, students)', 3, 22000]);
  assert.deepStrictEqual(s[0].rows[1], ['Collected (fee ledger, payments)', 4, 18000]);
  assert.deepStrictEqual(s[0].rows[4], ['Paid after a call (reported by caller, calls)', 85, 1440000]);
  assert.ok(s[1].headers.includes('In the fee ledger'));
  assert.ok(s[1].rows[0].includes('Paid on 22 Oct by UPI'));
  assert.deepStrictEqual(s[2].headers, ['Collected', 'Mode or day', 'Payments', 'Amount (₹)']);
  assert.deepStrictEqual(s[2].rows[0], ['By mode', 'UPI', 2, 6000]);
  assert.deepStrictEqual(s[2].rows.slice(-2), [['By day', '2026-10-22', 1, 5000], ['By day', '2026-10-25', 1, 1000]]);
});
test('Excel with the ledger and no money: no ₹ columns anywhere', () => {
  const s = R.feesSheets(REP, PROMISES, false, HIDDEN);
  assert.ok(!s.some((x) => x.headers.some((h) => /₹/.test(h))));
  assert.deepStrictEqual(s[0].rows[1], ['Collected (fee ledger, payments)', 4]);
  assert.deepStrictEqual(s[2].rows[0], ['By mode', 'UPI', 2]);
  assert.ok(s[2].notes.some((n) => /counts only/.test(n)));
});
test('Excel without the ledger keeps the caller-reported workbook', () => {
  const s = R.feesSheets({ leads: 240 }, [], false);
  assert.deepStrictEqual(s.map((x) => x.name), ['Fees collection', 'Promises due this week']);
  assert.deepStrictEqual(s[0].rows[0], ['Total due', 240]);
});

// ----- Reports for an Accounts seat -----
test('an Accounts seat gets Fees collection only; owners and managers get every report', () => {
  assert.deepStrictEqual(R.reportsFor({ role: 'accounts', access_role: 'accounts' }).map((r) => r.id), ['fees']);
  assert.deepStrictEqual(R.reportsFor({ role: 'accounts' }).map((r) => r.id), ['fees']);
  assert.strictEqual(R.reportsFor({ role: 'admin', access_role: 'manager' }).length, R.REPORTS.length);
  assert.strictEqual(R.reportsFor(null).length, R.REPORTS.length);
  assert.strictEqual(R.isAccountsSeat({ admin_kind: 'accounts' }), true);
  assert.strictEqual(R.isAccountsSeat({ role: 'admin', admin_kind: 'owner' }), false);
});
test('Excel for Accounts (no caller-reported report): ledger rows only, money kept', () => {
  const s = R.feesSheets(null, PROMISES, true, LED);
  assert.deepStrictEqual(s.map((x) => x.name), ['Fees collection', 'Promises due this week', 'Ledger']);
  assert.strictEqual(s[0].rows.length, 4);
  assert.ok(!s[0].rows.some((r) => /reported by caller/.test(r[0])));
  assert.deepStrictEqual(s[0].rows[1], ['Collected (fee ledger, payments)', 4, 18000]);
});

// ----- Home -----
const HOME_LED = { has_ledger: true, money_hidden: false, collected: { payments: 3, amount: 12500 },
  promises_due_unpaid: { count: 2, amount: 9000 }, released_today: { count: 3, idle: 2, inactive: 0, revoked: 1, admin: 0 } };
test('Home fees tile with a ledger: collected (ledger) and promised (calls), apart', () => {
  const t = H.feesTile({ has_fees: true, promised_amount: 30000, promised_calls: 4 }, HOME_LED, 'today', true);
  assert.deepStrictEqual(t, { label: 'Collected today (ledger)', value: '₹12,500', sub: 'Promised today (calls): ₹30,000',
    note: 'Collected is from the fee ledger. Promised is reported by caller.' });
  const w = H.feesTile({ promised_calls: 1, promised_amount: null }, Object.assign({}, HOME_LED, { collected: { payments: 1, amount: null } }), 'week', true);
  assert.strictEqual(w.label, 'Collected this week (ledger)');
  assert.strictEqual(w.value, '1 payment');
  assert.strictEqual(w.sub, 'Promised this week (calls): 1 promise');
});
test('Home fees tile without money access: counts only', () => {
  const t = H.feesTile({ promised_amount: 30000, promised_calls: 4 }, HOME_LED, 'yesterday', false);
  assert.strictEqual(t.label, 'Collected yesterday (ledger)');
  assert.strictEqual(t.value, '3 payments');
  assert.strictEqual(t.sub, 'Promised yesterday (calls): 4 promises');
  assert.ok(!hasRupee(t));
});
test('Home fees tile without a ledger: what callers reported, as before', () => {
  assert.strictEqual(H.feesTile({ has_fees: false }, null, 'today', true), null);
  const t = H.feesTile({ has_fees: true, paid_calls: 5, promised_calls: 2 }, { has_ledger: false }, 'today', false);
  assert.deepStrictEqual(t, { label: 'Fees: paid', value: '5 calls', sub: '2 promises', note: 'reported by caller' });
  const m = H.feesTile({ has_fees: true, paid_amount: 1000, promised_amount: 500 }, null, 'today', true);
  assert.strictEqual(m.value, '₹1,000');
});
test('Needs your attention with a ledger: promises not yet paid in the ledger, and follow-ups back in the pool', () => {
  const items = H.attentionItems({ promises_due_today: { count: 5, amount: 50000 } }, { canSeeMoney: true, ledger: HOME_LED });
  assert.deepStrictEqual(items.map((i) => i.key), ['promises', 'released']);
  assert.strictEqual(items[0].text, '2 promises due today are not yet paid in the ledger.');
  assert.strictEqual(items[0].detail, '₹9,000 still to pay.');
  assert.deepStrictEqual(items[0].params, { report: 'fees' });
  assert.strictEqual(items[1].text, '3 follow-ups returned to the pool today.');
  assert.ok(/2 because their callers had not called for a day/.test(items[1].detail));
  assert.ok(/1 because the caller was removed/.test(items[1].detail));
  assert.strictEqual(items[1].tab, 'callers');
});
test('Needs your attention: no ₹ without money access, nothing when all is paid', () => {
  const items = H.attentionItems({}, { canSeeMoney: false, ledger: HOME_LED });
  assert.strictEqual(items[0].detail, '');
  const none = H.attentionItems({ promises_due_today: { count: 2 } }, { ledger: Object.assign({}, HOME_LED,
    { promises_due_unpaid: { count: 0, amount: 0 }, released_today: { count: 0 } }) });
  assert.deepStrictEqual(none, []);
});
test('Needs your attention without a ledger keeps the old promise rule, and still lists releases', () => {
  const items = H.attentionItems({ promises_due_today: { count: 1, amount: null } },
    { ledger: { has_ledger: false, released_today: { count: 1, admin: 1 } } });
  assert.strictEqual(items[0].text, '1 fee promise is due today.');
  assert.strictEqual(items[1].text, '1 follow-up returned to the pool today.');
  assert.strictEqual(items[1].detail, '1 by an admin. Any caller can pick them up now.');
});

// ----- Insights -----
const PVP = { campaign_id: 'k', grace_days: 2, promises: 6, kept: 2, part_paid: 1, broken: 1, waiting: 1, no_student: 1,
  rows: [
    { state: 'kept', promised_on: '2026-10-01', promised_date: '2026-10-03' },
    { state: 'kept', promised_on: '2026-10-01', promised_date: '2026-10-06' },
    { state: 'part_paid', promised_on: '2026-10-01', promised_date: '2026-10-12' },
    { state: 'broken', promised_on: '2026-10-01', promised_date: '2026-10-20' },
    { state: 'waiting', promised_on: '2026-10-20', promised_date: '2026-10-27' },
    { state: 'no_student', promised_on: '2026-10-01', promised_date: '2026-10-02' },
  ] };
test('promises kept against the ledger: buckets by days away, part paid counts as not kept', () => {
  const lp = M.ledgerPromises(PVP);
  assert.deepStrictEqual(lp.buckets.map((b) => [b.bucket, b.promises, b.kept, b.waiting]),
    [['1–3 days', 1, 1, 0], ['4–7 days', 1, 1, 1], ['8–14 days', 1, 0, 0], ['15+ days', 1, 0, 0]]);
  assert.strictEqual(lp.judged, 4);
  assert.strictEqual(lp.noStudent, 1);
  const r = M.promiseBuckets(lp.buckets);
  assert.strictEqual(r.judged, 4);
  assert.strictEqual(r.rows[0].rate, 1);
});
test('promises kept: no ledger-linked promise means the caller-reported method', () => {
  assert.strictEqual(M.ledgerPromises({ promises: 3, no_student: 3, rows: [] }), null);
  assert.strictEqual(M.ledgerPromises({ promises: 0, no_student: 0 }), null);
  assert.strictEqual(M.ledgerPromises(null), null);
});

console.log('ledger-reports.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
