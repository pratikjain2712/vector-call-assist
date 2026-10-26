'use strict';
/* Tests for the pure Autopilot helpers (web/js/admin/autopilot-model.js), the filter bar's helpers
   (web/js/admin/filter-bar.js) and the caller picker's focus lists (web/js/campaign-picker.js).
   Run: node --test tests/web/autopilot.test.js */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const M = require(path.join(__dirname, '..', '..', 'web', 'js', 'admin', 'autopilot-model.js'));
const FB = require(path.join(__dirname, '..', '..', 'web', 'js', 'admin', 'filter-bar.js'));
const CP = require(path.join(__dirname, '..', '..', 'web', 'js', 'campaign-picker.js'));

// ---------- planner defaults and target maths ----------
test('working days count Monday to Saturday, both ends, at least 1', () => {
  assert.strictEqual(M.workingDays('2026-10-26', '2026-11-01'), 6);   // Mon..Sun
  assert.strictEqual(M.workingDays('2026-11-01', '2026-11-01'), 1);   // a Sunday alone still counts as 1
  assert.strictEqual(M.workingDays('2026-10-26', '2026-11-08'), 12);
  assert.strictEqual(M.workingDays('bad', '2026-11-08'), 1);
});

test('daily target: people over working days, shared by the focus callers', () => {
  assert.deepStrictEqual(M.dailyTarget(40, 11, 2), { total: 4, perCaller: 2 });
  assert.deepStrictEqual(M.dailyTarget(46, 12, 2), { total: 4, perCaller: 2 });
  assert.deepStrictEqual(M.dailyTarget(240, 6, 3), { total: 40, perCaller: 14 });
  assert.deepStrictEqual(M.dailyTarget(5, 10, 0), { total: 1, perCaller: 1 });   // no focus callers: one caller's worth
  assert.deepStrictEqual(M.dailyTarget(0, 10, 2), { total: null, perCaller: null });
  assert.strictEqual(M.dailyTarget(1e9, 1, 1).total, 10000);   // the database's cap
});

test('end date: a week after the due date, never sooner than a week from today', () => {
  assert.strictEqual(M.endDate('2026-11-01', '2026-10-26'), '2026-11-08');
  assert.strictEqual(M.endDate('2026-10-10', '2026-10-26'), '2026-11-02');   // overdue fees
  assert.strictEqual(M.endDate(null, '2026-10-26'), '2026-11-02');
});

test('call hours in words, like the brief', () => {
  assert.strictEqual(M.hourRange(19), '7–9 pm');
  assert.strictEqual(M.hourRange(11), '11 am–1 pm');
  assert.strictEqual(M.hourRange(10), '10 am–12 pm');
  assert.strictEqual(M.HOUR_CHOICES[0].label, 'Any time');
  assert.ok(M.HOUR_CHOICES.some((c) => c.value === '19' && c.label === '7–9 pm'));
});

test('class text for names and cards', () => {
  assert.strictEqual(M.classText('8th', 'State'), 'Class 8 State Board');
  assert.strictEqual(M.classText('10th', 'CBSE'), 'Class 10 CBSE');
  assert.strictEqual(M.classText('Nursery', null), 'Nursery');
  assert.strictEqual(M.classText('', 'Other'), '');
});

test('overrides: only what the owner changed', () => {
  const plan = { name: 'Term 2 fees – Class 8 State Board', callers: ['a', 'b'], script_id: 's1', hour: 19, daily_target: 4, end_date: '2026-11-08', whatsapp: false };
  assert.deepStrictEqual(M.overrides(plan, { name: plan.name, callers: ['b', 'a'], script_id: 's1', hour: '19', daily_target: '4', end_date: '2026-11-08', whatsapp: false }), {});
  assert.deepStrictEqual(M.overrides(plan, { name: ' Class 8 fees ', callers: ['c'], hour: '', daily_target: '6', end_date: '2026-11-10', whatsapp: true, script_id: '' }),
    { name: 'Class 8 fees', callers: ['c'], hour: null, daily_target: 6, end_date: '2026-11-10', whatsapp: true, script_id: null });
  assert.deepStrictEqual(M.overrides({ add_callers: ['x'] }, { add_callers: ['y'] }), { add_callers: ['y'] });
});

test('setup problems in plain words', () => {
  assert.strictEqual(M.setupProblem({ name: '  ' }), 'Give the list a name.');
  assert.match(M.setupProblem({ name: 'x', daily_target: '0' }), /1 to 10,000/);
  assert.strictEqual(M.setupProblem({ name: 'x', end_date: '2026-10-01', today: '2026-10-26' }), 'The end date is in the past.');
  assert.strictEqual(M.setupProblem({ name: 'x', daily_target: '', end_date: '2026-11-01', today: '2026-10-26' }), '');
});

// ---------- cards: dedupe, order, role filtering ----------
const cards = [
  { id: '1', kind: 'setup_gaps', dedupe_key: 'setup:answers', priority: 60, created_at: '2026-10-26T01:00:00Z' },
  { id: '2', kind: 'missed_promises', dedupe_key: 'missed_promises:2026-10-26', priority: 20, created_at: '2026-10-26T01:00:00Z' },
  { id: '3', kind: 'fees_due_list', dedupe_key: 'fees_list:8th:state:2026-11-01', priority: 16, created_at: '2026-10-26T01:00:00Z' },
  { id: '4', kind: 'fees_due_list', dedupe_key: 'fees_list:8th:state:2026-11-01', priority: 16, created_at: '2026-10-26T02:00:00Z' },
  { id: '5', kind: 'list_behind_pace', dedupe_key: 'pace:x:2026-44', priority: 30, created_at: '2026-10-26T01:00:00Z' },
  { id: '6', kind: 'enquiries_uncalled', dedupe_key: 'enquiries:y', priority: 40, created_at: '2026-10-26T01:00:00Z' },
];

test('at most 3 cards, one per dedupe key, best first', () => {
  assert.deepStrictEqual(M.visibleCards(cards).map((c) => c.id), ['3', '2', '5']);
  assert.deepStrictEqual(M.visibleCards(cards, { max: 10 }).map((c) => c.id), ['3', '2', '5', '6', '1']);
});

test('setup gaps are left out while Getting started is on the page', () => {
  assert.ok(!M.visibleCards(cards, { max: 10, skip: ['setup_gaps'] }).some((c) => c.kind === 'setup_gaps'));
});

test('role filtering: owner all, manager calling only (fees lists with money), others nothing', () => {
  assert.strictEqual(M.visibleCards(cards, { max: 10, viewer: 'owner' }).length, 5);
  assert.deepStrictEqual(M.visibleCards(cards, { max: 10, viewer: 'manager', money: false }).map((c) => c.kind), ['missed_promises', 'list_behind_pace', 'enquiries_uncalled']);
  assert.deepStrictEqual(M.visibleCards(cards, { max: 10, viewer: 'manager', money: true }).map((c) => c.kind), ['fees_due_list', 'missed_promises', 'list_behind_pace', 'enquiries_uncalled']);
  assert.strictEqual(M.visibleCards(cards, { max: 10, viewer: 'accounts', money: true }).length, 0);
  assert.strictEqual(M.maySee('caller', true, 'missed_promises'), false);
});

test('the why line shows money only when allowed', () => {
  const c = { kind: 'fees_due_list', why: { text: '40 parents still owe it.', amount: 480000 } };
  assert.strictEqual(M.whyText(c, true), '40 parents still owe it. ₹4.8L due.');
  assert.strictEqual(M.whyText(c, false), '40 parents still owe it.');
  assert.strictEqual(M.whyText({ kind: 'missed_promises', why: { text: 'x.', amount: 22500 } }, true), 'x. ₹22,500 promised.');
});

test('buttons per kind: setup opens settings, missed promises and top-ups have no Change', () => {
  assert.deepStrictEqual(M.actionsFor({ kind: 'setup_gaps' }), { confirm: 'Open settings', change: false });
  assert.deepStrictEqual(M.actionsFor({ kind: 'missed_promises' }), { confirm: 'Confirm', change: false });
  assert.deepStrictEqual(M.actionsFor({ kind: 'fees_due_list', plan: { action: 'topup' } }), { confirm: 'Confirm', change: false });
  assert.deepStrictEqual(M.actionsFor({ kind: 'fees_due_list', plan: { action: 'create' } }), { confirm: 'Confirm', change: true });
});

test('three numbers: ₹ with money, parents without', () => {
  const n = { fees: { pct: 82, collected_amount: 3120000, due_amount: 3800000, goal_pct: 90, parents: 100, parents_paid: 80, parents_pct: 80 },
    admissions: { confirmed: 10, target: 40, pct: 25 }, team: { calls: 142, reached: 86, callers: 5, callers_total: 5 } };
  const t = M.numberTiles(n, true);
  assert.deepStrictEqual(t.map((x) => x.value), ['82%', '10 of 40', '142 calls']);
  assert.strictEqual(t[0].sub, '₹31.2L of ₹38L due');
  assert.strictEqual(M.tileState(t[0]), 'behind');
  const hidden = M.numberTiles({ fees: { pct: null, parents: 100, parents_paid: 92, parents_pct: 92, goal_pct: 90 }, admissions: {}, team: {} }, false);
  assert.strictEqual(hidden[0].value, '92%');
  assert.strictEqual(hidden[0].sub, '92 of 100 parents paid');
  assert.ok(!/₹/.test(JSON.stringify(hidden)));
  assert.strictEqual(M.tileState(hidden[0]), 'on track');
  assert.strictEqual(hidden[1].sub, 'No target set');
});

test('plan again after 15 minutes', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  assert.strictEqual(M.needsPlan(null, now), true);
  assert.strictEqual(M.needsPlan('2026-10-26T09:50:00Z', now), false);
  assert.strictEqual(M.needsPlan('2026-10-26T09:45:00Z', now), true);
});

// ---------- filter bar ----------
const people = [
  { name: 'Sunita Bhosale', phone: '+919999010001', status: 'promised', cls: '10th', missed: true },
  { name: 'Ravi Kumar', phone: '+919999010002', status: 'new', cls: '10th' },
  { name: 'Meena Shah', phone: '+919999060003', status: 'new', cls: '8th' },
  { name: 'Asha Rao', phone: '+919999060004', status: 'done', cls: '8th' },
];
const opts = {
  searchText: (r) => r.name + ' ' + r.phone,
  chips: [{ key: 'tocall', label: 'To call', test: (r) => r.status === 'new' }, { key: 'missed', label: 'Promise missed', test: (r) => !!r.missed }],
  classOf: (r) => r.cls,
};

test('filter bar: chip counts follow the search and class', () => {
  assert.deepStrictEqual(FB.chipCounts(people, {}, opts), { all: 4, tocall: 2, missed: 1 });
  assert.deepStrictEqual(FB.chipCounts(people, { cls: '8th' }, opts), { all: 2, tocall: 1, missed: 0 });
  assert.deepStrictEqual(FB.chipCounts(people, { q: 'shah' }, opts), { all: 1, tocall: 1, missed: 0 });
  assert.deepStrictEqual(FB.chipCounts(people, { chip: 'missed' }, opts), { all: 4, tocall: 2, missed: 1 });   // a chip does not change counts
});

test('filter bar: search by words or 4+ phone digits, one chip, class', () => {
  assert.deepStrictEqual(FB.filterRows(people, { q: 'BHOSALE sunita' }, opts).map((r) => r.name), ['Sunita Bhosale']);
  assert.deepStrictEqual(FB.filterRows(people, { q: '6000' }, opts).map((r) => r.name), ['Meena Shah', 'Asha Rao']);
  assert.deepStrictEqual(FB.filterRows(people, { chip: 'tocall', cls: '10th' }, opts).map((r) => r.name), ['Ravi Kumar']);
  assert.strictEqual(FB.filterRows(people, { q: 'nobody' }, opts).length, 0);
});

test('filter bar: classes in school order', () => {
  assert.deepStrictEqual(FB.classOptions(people.concat([{ cls: 'Nursery' }, { cls: '9th' }]), (r) => r.cls), ['8th', '9th', '10th', 'Nursery']);
  assert.deepStrictEqual(FB.classOptions(people, null), []);
});

// ---------- caller picker ----------
test('picker: focus lists first ("For you")', () => {
  const list = [{ campaign_id: 'a', is_focus: false }, { campaign_id: 'b', is_focus: true, focus_target: 12 }, { campaign_id: 'c' }];
  assert.deepStrictEqual(CP.focus(list).map((c) => c.campaign_id), ['b']);
  assert.deepStrictEqual(CP.focus(null), []);
});
