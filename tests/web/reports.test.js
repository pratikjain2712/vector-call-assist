'use strict';
/* Tests for the pure helpers in web/js/admin/reports.js: date presets, promise status and "send back", student
   and class from a lead's sheet columns, the sales funnel steps, biggest drop and notes, the Fees cards with
   and without money, and the workbooks of each report (no ₹ columns without money). No network and no DOM.
   Run: node --test tests/web/reports.test.js
   Prints "reports.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const R = require(path.join(root, 'web', 'js', 'admin', 'reports.js'));
const A = require(path.join(root, 'web', 'js', 'admin.js'));
const T = require(path.join(root, 'web', 'js', 'admin-team.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}
const hasRupee = (sheets) => sheets.some((s) => s.headers.some((h) => /₹/.test(h)));

// ----- picker and dates -----
test('the five reports in the mockup order, Fees first', () => {
  assert.deepStrictEqual(R.REPORTS.map((r) => r.label), ['Fees collection', 'Enquiry to admission', 'Call results', 'Why calls are lost', 'Weekly summary']);
  assert.strictEqual(R.DEFAULT_REPORT, 'fees');
});
test('date presets: last 7 and 30 days include today', () => {
  const now = new Date(2026, 9, 24, 15, 0);   // Saturday 24 Oct 2026
  assert.deepStrictEqual(R.presetRange('last7', now), { from: '2026-10-18', to: '2026-10-24' });
  assert.deepStrictEqual(R.presetRange('last30', now), { from: '2026-09-25', to: '2026-10-24' });
});
test('date presets: this week starts on Monday, this month on the 1st', () => {
  assert.deepStrictEqual(R.presetRange('week', new Date(2026, 9, 24)), { from: '2026-10-19', to: '2026-10-24' });
  assert.deepStrictEqual(R.presetRange('week', new Date(2026, 9, 25)), { from: '2026-10-19', to: '2026-10-25' });   // Sunday
  assert.deepStrictEqual(R.presetRange('week', new Date(2026, 9, 19)), { from: '2026-10-19', to: '2026-10-19' });   // Monday
  assert.deepStrictEqual(R.presetRange('month', new Date(2026, 9, 24)), { from: '2026-10-01', to: '2026-10-24' });
  assert.strictEqual(R.presetRange('custom', new Date()), null);
  assert.deepStrictEqual(R.presetRange('today', new Date(2026, 9, 24, 15)), { from: '2026-10-24', to: '2026-10-24' });
  assert.deepStrictEqual(R.DATE_PRESETS.map((p) => p.id), ['today', 'last7', 'week', 'last30', 'month', 'custom']);
});

// ----- promises -----
test('promise status: due today, days late, not yet due', () => {
  assert.deepStrictEqual(R.promiseStatus(0), { text: 'Due today', level: 'due' });
  assert.deepStrictEqual(R.promiseStatus(1), { text: '1 day late', level: 'late' });
  assert.deepStrictEqual(R.promiseStatus('2'), { text: '2 days late', level: 'late' });
  assert.deepStrictEqual(R.promiseStatus(-3), { text: 'Not yet due', level: 'later' });
  assert.deepStrictEqual(R.promiseStatus(null), { text: '', level: '' });
});
test('send back takes the promises due today or late, not the ones still to come', () => {
  const rows = [{ lead_id: 'a', days_late: 2 }, { lead_id: 'b', days_late: 0 }, { lead_id: 'c', days_late: -3 }, { lead_id: 'd', days_late: null }];
  assert.deepStrictEqual(R.dueForSendBack(rows), ['a', 'b']);
  assert.deepStrictEqual(R.dueForSendBack(null), []);
});
test('student and class come from loosely named sheet columns', () => {
  assert.strictEqual(R.studentClass({ 'Student Name': 'Ravi', Class: '10-A' }), 'Ravi · 10-A');
  assert.strictEqual(R.studentClass({ student: ' Asha ', 'Class & Section': '9 B' }), 'Asha · 9 B');
  assert.strictEqual(R.studentClass({ child_name: 'Meena', Std: 7 }), 'Meena · 7');
  assert.strictEqual(R.studentClass({ Grade: '12' }), '12');
  assert.strictEqual(R.studentClass({ City: 'Pune', 'Student roll no': 4 }), '');
  assert.strictEqual(R.studentClass(null), '');
  assert.strictEqual(R.studentClass(['x']), '');
});

// ----- sales funnel -----
const F = { called: 189, picked_up: 117, heard_pitch: 78, interested: 36, joined: 23, no_step: 0, pitch_guessed: false,
  top_reason: { reason: 'price', calls: 12 } };
test('funnel steps with their share of all calls', () => {
  const s = R.funnelSteps(F);
  assert.deepStrictEqual(s.map((x) => x.label), ['Called', 'Picked up', 'Heard the pitch', 'Interested', 'Joined']);
  assert.deepStrictEqual(s.map((x) => x.count), [189, 117, 78, 36, 23]);
  assert.deepStrictEqual(s.map((x) => x.percent), [100, 62, 41, 19, 12]);
  assert.deepStrictEqual(R.funnelSteps({}).map((x) => x.percent), [0, 0, 0, 0, 0]);
});
test('biggest drop is the step that loses the most calls', () => {
  assert.deepStrictEqual(R.biggestDrop(R.funnelSteps(F)), { from: 'Called', to: 'Picked up', lost: 72 });
  const g = R.funnelSteps({ called: 100, picked_up: 90, heard_pitch: 80, interested: 20, joined: 10 });
  assert.deepStrictEqual(R.biggestDrop(g), { from: 'Heard the pitch', to: 'Interested', lost: 60 });
  assert.strictEqual(R.biggestDrop(R.funnelSteps({ called: 5, picked_up: 5, heard_pitch: 5, interested: 5, joined: 5 })), null);
});
test('funnel notes: drop, top reason in plain words, guessed pitch and calls with no step', () => {
  const n = R.funnelNotes(Object.assign({}, F, { pitch_guessed: true, no_step: 4 }));
  assert.strictEqual(n[0], 'Biggest drop: between "Called" and "Picked up" (72 calls).');
  assert.strictEqual(n[1], 'Top reason given on lost calls: Price (12 calls).');
  assert.ok(/middle step/.test(n[2]), n[2]);
  assert.ok(/^4 picked-up calls have no script step recorded/.test(n[3]), n[3]);
  assert.ok(/^1 picked-up call has no script step recorded, so it is/.test(R.funnelNotes(Object.assign({}, F, { no_step: 1 }))[2]));
  assert.deepStrictEqual(R.funnelNotes({ called: 0 }), ['No sales calls in these dates.']);
  assert.strictEqual(R.funnelNotes(Object.assign({}, F, { top_reason: null }))[1], 'No reason recorded on lost calls yet.');
  assert.ok(R.funnelNotes(Object.assign({}, F, { top_reason: { reason: 'Fees too high', calls: 1 } }))[1].includes('Fees too high (1 call)'));
});

// ----- Fees collection -----
const REP = { leads: 240, total_due: 4320000, paid_leads: 80, paid_calls: 85, paid_amount: 1440000, promised_leads: 50,
  promised_amount: 900000, broken_promises: 14, money_hidden: false };
test('fees cards with money: rupees in Indian format, paid is what the parent said, not in Paid (office) yet', () => {
  const c = R.feesCards(REP, true);
  assert.deepStrictEqual(c.map((x) => x.label), ['Total due', 'Parent said they paid', 'Promised', 'Promised date missed']);
  assert.deepStrictEqual(c.map((x) => x.value), ['₹43,20,000', '₹14,40,000', '₹9,00,000', '14']);
  assert.strictEqual(c[0].sub, '240 parents');
  assert.strictEqual(c[1].sub, '80 parents · not in Paid (office) yet');
  assert.strictEqual(c[3].level, 'bad');
});
test('fees cards without money: counts only, no ₹ anywhere', () => {
  const hidden = Object.assign({}, REP, { total_due: null, paid_amount: null, promised_amount: null, money_hidden: true });
  const c = R.feesCards(hidden, false);
  assert.deepStrictEqual(c.map((x) => x.value), ['240', '80', '50', '14']);
  assert.ok(c.every((x) => !/₹/.test(x.value + x.sub)), JSON.stringify(c));
  assert.strictEqual(c[1].sub, 'parents · not in Paid (office) yet');
  assert.strictEqual(R.feesCards(Object.assign({}, hidden, { leads: 1 }), false)[0].sub, 'parent');
});

// ----- workbooks -----
const PROMISES = [
  { lead_id: 'a', name: 'Parent One', extra: { Student: 'Ravi', Class: '10-A' }, amount: 18000, promised_date: '2026-10-24', days_late: 0, caller: 'Ravi', campaign: 'Oct fees' },
  { lead_id: 'b', name: '=Parent', extra: {}, amount: 9000, promised_date: '2026-10-22', days_late: 2, caller: null, campaign: 'Oct fees' },
];
test('fees workbook with money has ₹ columns and the amounts as numbers', () => {
  const s = R.feesSheets(REP, PROMISES, true);
  assert.deepStrictEqual(s.map((x) => x.name), ['Fees collection', 'Promises due this week']);
  assert.deepStrictEqual(s[0].headers, ['Measure', 'Parents', 'Amount (₹)']);
  assert.deepStrictEqual(s[0].rows[0], ['Total due', 240, 4320000]);
  assert.ok(/^Parent said they paid \(not in Paid \(office\) yet\)$/.test(s[0].rows[1][0]));
  assert.deepStrictEqual(s[1].headers, ['Parent', 'Student and class', 'Promised amount (₹)', 'Promised for', 'Caller', 'Calling list', 'Status']);
  assert.deepStrictEqual(s[1].rows[0], ['Parent One', 'Ravi · 10-A', 18000, '2026-10-24', 'Ravi', 'Oct fees', 'Due today']);
  assert.deepStrictEqual(s[1].rows[1], ['=Parent', '', 9000, '2026-10-22', 'Not assigned', 'Oct fees', '2 days late']);
});
test('fees workbook without money has no ₹ column and no amount anywhere', () => {
  const s = R.feesSheets(REP, PROMISES, false);
  assert.ok(!hasRupee(s));
  const all = JSON.stringify(s.map((x) => x.rows));
  [4320000, 1440000, 900000, 18000, 9000].forEach((n) => assert.ok(!all.includes(String(n)), n));
  assert.ok(s[0].notes.some((n) => /counts only/.test(n)));
  assert.ok(s[1].rows.every((r) => r.length === s[1].headers.length));
});
test('funnel workbook: one sheet with the steps and the notes', () => {
  const s = R.funnelSheets(F);
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual(s[0].rows[2], ['Heard the pitch', 78, 41]);
  assert.ok(s[0].notes[0].startsWith('Biggest drop'));
  assert.ok(!hasRupee(s));
});
test('results workbook: outcome pivot and team activity', () => {
  const reps = A.pivotOutcomes([{ seat_id: 's1', label: 'Rep 1', outcome: 'won', outcome_count: 2 }, { seat_id: 's1', label: 'Rep 1', outcome: 'busy', outcome_count: 1 }]);
  const s = R.resultsSheets(reps, A.OUTCOMES, A.TEAM_HEADERS, A.teamCsvRows([{ label: 'Rep 1', day: '2026-10-24', calls: 3, connected_calls: 2, connect_rate: 0.6667, talk_seconds: 90, last_activity: 'x' }]));
  assert.deepStrictEqual(s.map((x) => x.name), ['Call results', 'Team activity']);
  assert.strictEqual(s[0].headers[0], 'Caller');
  assert.strictEqual(s[0].headers[s[0].headers.length - 1], 'Total');
  assert.strictEqual(s[0].rows[0][s[0].rows[0].length - 1], 3);
  assert.strictEqual(s[0].rows[0][1 + A.OUTCOMES.indexOf('won')], 2);
  assert.deepStrictEqual(s[1].rows[0].slice(0, 5), ['Rep 1', '2026-10-24', 3, 2, 66.7]);
});
test('weekly workbook uses the weekly summary columns', () => {
  const rows = [{ day: '2026-10-19', calls: 10, connected_calls: 4 }];
  const cols = T.summaryColumns(rows);
  const s = R.weeklySheets(rows, cols, T.headerText);
  assert.deepStrictEqual(s[0].headers, ['Day', 'Calls', 'Connected calls']);
  assert.deepStrictEqual(s[0].rows, [['2026-10-19', 10, 4]]);
});
test('why calls are lost workbook: script tables, loss reasons and suggestions', () => {
  const s = R.lostSheets(
    { script_name: 'Vector sales', version: 7, total_calls: 20, steps: [{ step: 'fees', calls: 8, share: 0.4 }, { step: null, calls: 2, share: 0.1 }], objections: [], outcomes: [{ outcome: 'not_interested', calls: 5 }] },
    { reasons: [{ reason: 'price', calls: 3 }], stages: [{ stage: 'not_recorded', calls: 1 }], suggestions: [{ text: 'Show the fee earlier.', decision: 'approved' }, { text: 'x', decision: null }] });
  assert.deepStrictEqual(s.map((x) => x.name), ['Where calls ended', 'Objections', 'Outcomes', 'Lost calls by reason', 'Lost calls by stage', 'Suggested changes']);
  assert.deepStrictEqual(s[0].rows, [['fees', 8, 40], ['(no end card logged)', 2, 10]]);
  assert.strictEqual(s[0].notes[0], 'Vector sales v7, 20 calls.');
  assert.deepStrictEqual(s[2].rows, [['not interested', 5]]);
  assert.deepStrictEqual(s[3].rows, [['Price', 3]]);
  assert.deepStrictEqual(s[4].rows, [['(not recorded)', 1]]);
  assert.deepStrictEqual(s[5].rows, [['Show the fee earlier.', 'approved'], ['x', 'Not decided']]);
  assert.strictEqual(R.lostSheets(null, null).length, 6);
});

console.log('reports.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
