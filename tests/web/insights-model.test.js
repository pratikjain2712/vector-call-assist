'use strict';
/* Tests for web/js/insights-model.js: the forecast (pace, pickup, promises kept, cap, range, target date),
   What-if (same model, sliders at their defaults give the forecast), "What closes the gap", the best-time
   grid and call hours, promises by days away, coaching tips and compare. No network and no DOM.
   Run: node --test tests/web/insights-model.test.js
   Prints "insights-model.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const M = require(path.join(__dirname, '..', '..', 'web', 'js', 'insights-model.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol || 1e-6), (msg || '') + ' got ' + a + ', want ' + b);

// A fees campaign: 7 days of 20 calls a day by 2 callers, half picked up, ₹ paid 2000 a picked-up call
// on average, no promises. Today is day 7; the end is 10 days away.
function feesData(extra) {
  const daily = [];
  for (let i = 6; i >= 0; i--) daily.push({ day: M.addDays('2026-10-24', -i), calls: 20, callers: 2, value: 20000 });
  return Object.assign({
    kind: 'amount', call_type_key: 'fees', today: '2026-10-24', start_date: '2026-10-18', end_date: '2026-11-03',
    callers: 2, leads: 400, cap: 10000000, target: 900000,
    stats: { calls: 140, picked: 70, good: 70, direct_value: 140000, promises_made: 0, promise_value_made: 0,
             evening_calls: 0, evening_picked: 0 },
    promises: { judged: 0, kept: 0, broken: 0, broken_value: 0 }, open_promises: [], daily, hours: [],
  }, extra || {});
}

// ----- dates -----
test('days between and adding days cross months and leap years', () => {
  assert.strictEqual(M.daysBetween('2026-10-24', '2026-11-03'), 10);
  assert.strictEqual(M.addDays('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(M.addDays('2026-12-31', 1), '2027-01-01');
});

// ----- baseline -----
test('baseline: pace, calls per caller and pickup come from the last 7 days', () => {
  const b = M.baseline(feesData());
  near(b.pace, 20);
  near(b.perCaller, 10);
  assert.strictEqual(b.callers, 2);
  near(b.pickupAll, 0.5);
  near(b.directPerPicked, 2000);
  assert.strictEqual(b.enoughData, true);
});
test('baseline: idle days lower the pace but not the calls per caller', () => {
  const d = feesData();
  d.daily[0].calls = 0; d.daily[0].callers = 0; d.daily[1].calls = 0; d.daily[1].callers = 0;
  const b = M.baseline(d);
  near(b.pace, 100 / 7);
  near(b.perCaller, 10);
});
test('baseline: promises kept are shrunk towards 60% when few are judged', () => {
  near(M.baseline(feesData()).keptRate, 0.6);
  const b = M.baseline(feesData({ promises: { judged: 96, kept: 96, broken: 0, broken_value: 0 } }));
  near(b.keptRate, (96 + 2.4) / 100);
});
test('baseline: evening pickup is used only with enough evening and day calls', () => {
  const few = M.baseline(feesData({ stats: Object.assign(feesData().stats, { evening_calls: 5, evening_picked: 5 }) }));
  assert.strictEqual(few.eveningKnown, false);
  near(few.pickupEvening, 0.5);
  const ok = M.baseline(feesData({ stats: Object.assign(feesData().stats, { evening_calls: 40, evening_picked: 30 }) }));
  assert.strictEqual(ok.eveningKnown, true);
  near(ok.pickupEvening, 0.75);
  near(ok.pickupDay, 40 / 100);
  near(ok.eveningShare, 40 / 140);
});

// ----- forecast -----
test('forecast: got so far plus days left × pace × pickup × value per picked-up call', () => {
  const f = M.forecast(M.baseline(feesData()));
  assert.strictEqual(f.ok, true);
  near(f.likely, 140000 + 10 * 20 * 0.5 * 2000);
  assert.ok(f.low < f.likely && f.likely < f.high, 'the likely value is inside the range');
  near(f.gap, 900000 - 340000);
});
test('forecast: never more than the cap (amount due)', () => {
  const f = M.forecast(M.baseline(feesData({ cap: 200000, target: 180000 })));
  near(f.likely, 200000);
  assert.ok(f.high <= 200000);
});
test('forecast: open promises add their value × kept share on their date', () => {
  const d = feesData({ open_promises: [{ date: '2026-10-26', value: 10000 }, { date: '2026-12-01', value: 99999 }],
    promises: { judged: 46, kept: 23, broken: 0, broken_value: 0 } });
  const b = M.baseline(d);
  const f = M.forecast(b);
  const kept = (23 + 2.4) / 50;
  near(f.likely, 140000 + 10000 * kept + 10 * 20 * 0.5 * 2000, 1e-6, 'a promise after the end does not count');
  near(f.path[1].value - f.path[0].value, 20 * 0.5 * 2000, 1e-6);
  near(f.path[2].value - f.path[1].value, 20 * 0.5 * 2000 + 10000 * kept, 1e-6);
});
test('forecast: promise value made per picked-up call adds future promises × kept', () => {
  const d = feesData({ stats: Object.assign(feesData().stats, { promises_made: 10, promise_value_made: 70000 }) });
  const f = M.forecast(M.baseline(d));
  near(f.likely, 140000 + 10 * 20 * 0.5 * (2000 + 1000 * 0.6));
});
test('forecast: under 50 calls says not enough data', () => {
  const d = feesData({ stats: Object.assign(feesData().stats, { calls: 49 }) });
  const f = M.forecast(M.baseline(d));
  assert.strictEqual(f.ok, false);
  assert.strictEqual(f.reason, 'no_data');
});
test('forecast: a campaign without an end date has no forecast', () => {
  assert.strictEqual(M.forecast(M.baseline(feesData({ end_date: null }))).reason, 'no_end');
});
test('forecast: the range is narrower with more data', () => {
  const small = M.forecast(M.baseline(feesData({ stats: Object.assign(feesData().stats, { calls: 60, picked: 30, good: 6, direct_value: 60000 }) })));
  const big = M.forecast(M.baseline(feesData({ stats: Object.assign(feesData().stats, { calls: 6000, picked: 3000, good: 1200, direct_value: 6000000 }) })));
  assert.ok((small.high - small.low) / small.likely > (big.high - big.low) / big.likely);
});
test('forecast: reaches target on the first day the expected value passes it', () => {
  const f = M.forecast(M.baseline(feesData({ target: 250000 })));
  // 140000 + 20000 a day: 250000 is passed on day 6.
  assert.strictEqual(f.reachDate, '2026-10-30');
  assert.strictEqual(f.reachesBeforeEnd, true);
  const late = M.forecast(M.baseline(feesData({ target: 500000 })));
  assert.strictEqual(late.reachDate, '2026-11-11');
  assert.strictEqual(late.reachesBeforeEnd, false);
  assert.strictEqual(M.forecast(M.baseline(feesData({ target: 100000 }))).reachDate, '2026-10-24');
});
test('forecast: counts for sales (no promises, no money)', () => {
  const d = feesData({ kind: 'count', call_type_key: 'sales', cap: 400, target: 60,
    stats: { calls: 140, picked: 70, good: 14, direct_value: 14, promises_made: 0, promise_value_made: 0, evening_calls: 0, evening_picked: 0 } });
  const f = M.forecast(M.baseline(d));
  near(f.likely, 14 + 10 * 20 * 0.5 * 0.2);
  assert.strictEqual(M.unitLabel('sales', 'count'), 'joinings');
  assert.strictEqual(M.unitLabel('fees', 'count'), 'payments');
  assert.strictEqual(M.unitLabel('fees', 'amount'), '₹');
});

// ----- what-if -----
test('what-if at the default sliders gives the forecast', () => {
  const b = M.baseline(feesData());
  assert.deepStrictEqual(M.forecast(b, M.defaultPlan(b)), M.forecast(b));
});
test('what-if: one more caller adds half again to the pace', () => {
  const b = M.baseline(feesData());
  near(M.paceFor(b, { callers: 3, perCaller: 10, eveningShare: 0 }), 30);
  const f = M.forecast(b, { callers: 3, perCaller: 10, eveningShare: 0 });
  near(f.likely, 140000 + 10 * 30 * 0.5 * 2000);
});
test('what-if: more evening calls raise pickup when evenings pick up more', () => {
  const b = M.baseline(feesData({ stats: Object.assign(feesData().stats, { evening_calls: 40, evening_picked: 30 }) }));
  const base = M.forecast(b);
  const more = M.forecast(b, Object.assign(M.defaultPlan(b), { eveningShare: 0.8 }));
  assert.ok(more.likely > base.likely);
  near(M.pickupFor(b, { eveningShare: 1 }), 0.75);
});
test('what-if: no calls yet uses callers × calls a day', () => {
  const d = feesData({ daily: [], stats: Object.assign(feesData().stats, { calls: 60 }) });
  const b = M.baseline(d);
  near(M.paceFor(b, { callers: 2, perCaller: 30, eveningShare: 0 }), 60 * 6 / 7);
});

// ----- what closes the gap -----
test('gap: calls a day that reach the target, and suggestions sorted by gain', () => {
  const b = M.baseline(feesData({ target: 400000, promises: { judged: 10, kept: 5, broken: 5, broken_value: 50000 } }));
  const need = M.perCallerForTarget(b);
  assert.ok(M.forecast(b, Object.assign(M.defaultPlan(b), { perCaller: need })).likely >= 400000);
  assert.ok(M.forecast(b, Object.assign(M.defaultPlan(b), { perCaller: need - 1 })).likely < 400000);
  const list = M.gapSuggestions(b);
  assert.deepStrictEqual(list.map((s) => s.id).sort(), ['broken', 'caller', 'calls']);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].gain >= list[i].gain);
  const calls = list.find((s) => s.id === 'calls');
  assert.strictEqual(calls.reaches, true);
  assert.ok(calls.extraCalls > 0);
});
test('gap: nothing to suggest when the target is reached or there is no target', () => {
  assert.deepStrictEqual(M.gapSuggestions(M.baseline(feesData({ target: 100000 }))), []);
  assert.deepStrictEqual(M.gapSuggestions(M.baseline(feesData({ target: null }))), []);
});

// ----- best time to call -----
const heatRows = [
  { dow: 1, hour: 11, calls: 40, picked: 10 }, { dow: 1, hour: 19, calls: 20, picked: 14 },
  { dow: 6, hour: 10, calls: 10, picked: 6 }, { dow: 2, hour: 20, calls: 2, picked: 2 },
];
test('heat grid: rates need enough calls, hours span the data', () => {
  const g = M.heatGrid(heatRows);
  assert.deepStrictEqual(g.hours, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  near(g.cell(1, 19).rate, 0.7);
  assert.strictEqual(g.cell(2, 20).rate, null, 'two calls are too few');
  assert.strictEqual(g.cell(3, 12).calls, 0);
  near(g.overall, 32 / 72);
});
test('heat grid: tip and call hours', () => {
  const g = M.heatGrid(heatRows);
  assert.strictEqual(M.heatTip(g), 'Most people pick up on Mon 7 pm (70%), Sat 10 am (60%), Mon 11 am (25%). Most calls are made on Mon 11 am (25%).');
  assert.deepStrictEqual(M.callHoursFromGrid(g, 'Asia/Kolkata'), { days: { mon: [19], sat: [10] }, source: 'insights', tz: 'Asia/Kolkata' });
  assert.strictEqual(M.callHoursFromGrid(M.heatGrid([])), null);
});
test('hour text and levels', () => {
  assert.strictEqual(M.hourText(0), '12 am');
  assert.strictEqual(M.hourText(12), '12 pm');
  assert.strictEqual(M.hourText(19), '7 pm');
  assert.strictEqual(M.hourRange(19, 21), '7–9 pm');
  assert.strictEqual(M.hourRange(10, 13), '10 am–1 pm');
  assert.strictEqual(M.level(null, 0, 1), null);
  assert.strictEqual(M.level(0.25, 0.25, 0.7), 0);
  assert.strictEqual(M.level(0.7, 0.25, 0.7), 5);
});

test('call hours in words', () => {
  assert.strictEqual(M.callHoursText(null), 'Any time');
  assert.strictEqual(M.callHoursText({ days: { mon: [19, 20], tue: [20, 19], sat: [10, 11, 15] } }), 'Mon, Tue 7–9 pm; Sat 10 am–12 pm, 3–4 pm');
});

// ----- where calls end, promises, coaching, compare -----
test('call ends: share per step and the biggest one', () => {
  const r = M.callEnds([{ step: 'open', step_label: 'Opening', calls: 10 }, { step: 'fees', step_label: 'Fees', calls: 30 }, { step: null, step_label: null, calls: 10 }]);
  near(r.rows[1].share, 0.6);
  assert.strictEqual(r.top.label, 'Fees');
  assert.strictEqual(r.rows[2].label, 'Not recorded');
});
test('promises: kept share per bucket and a tip when far dates are kept less', () => {
  const r = M.promiseBuckets([
    { bucket: '1–3 days', bucket_order: 1, promises: 20, kept: 16, waiting: 1 },
    { bucket: '4–7 days', bucket_order: 2, promises: 10, kept: 6, waiting: 0 },
    { bucket: '8–14 days', bucket_order: 3, promises: 8, kept: 3, waiting: 2 },
    { bucket: '15+ days', bucket_order: 4, promises: 5, kept: 1, waiting: 4 },
  ]);
  near(r.rows[0].rate, 0.8);
  assert.strictEqual(r.judged, 43);
  assert.match(r.tip, /within 7 days.*73%.*31%/);
  assert.strictEqual(M.promiseBuckets([{ bucket: '1–3 days', bucket_order: 1, promises: 0, kept: 0, waiting: 0 }]).rows[0].rate, null);
});
test('coaching: good per 100 picked-up calls and team average', () => {
  const c = M.coaching([
    { seat_id: 'a', label: 'Neha', calls: 200, picked: 100, good: 31 },
    { seat_id: 'b', label: 'Amit', calls: 150, picked: 100, good: 13 },
    { seat_id: 'c', label: 'New', calls: 5, picked: 3, good: 1 },
  ]);
  assert.deepStrictEqual(c.rows.map((r) => [r.label, r.per100]), [['Neha', 31], ['Amit', 13], ['New', null]]);
  assert.strictEqual(c.team, 22);
});
test('step tips: skipped step first, else a slow step', () => {
  const rows = [
    { seat_id: null, step: 'open', step_label: 'Opening', step_order: 1, timed_calls: 100, calls_with_step: 100, avg_seconds: 25 },
    { seat_id: null, step: 'ask', step_label: 'Questions', step_order: 2, timed_calls: 100, calls_with_step: 80, avg_seconds: 40 },
    { seat_id: 'p', label: 'Priya', step: 'open', timed_calls: 20, calls_with_step: 20, avg_seconds: 20 },
    { seat_id: 'p', label: 'Priya', step: 'ask', timed_calls: 20, calls_with_step: 8, avg_seconds: 30 },
    { seat_id: 'a', label: 'Amit', step: 'open', timed_calls: 20, calls_with_step: 20, avg_seconds: 60 },
    { seat_id: 'a', label: 'Amit', step: 'ask', timed_calls: 20, calls_with_step: 18, avg_seconds: 40 },
    { seat_id: 'n', label: 'Neha', step: 'open', timed_calls: 20, calls_with_step: 20, avg_seconds: 24 },
    { seat_id: 'n', label: 'Neha', step: 'ask', timed_calls: 20, calls_with_step: 17, avg_seconds: 41 },
  ];
  const tips = M.stepTips(rows);
  assert.deepStrictEqual(tips.map((t) => t.text), [
    'Priya skips the Questions step in 60% of calls (team: 20%).',
    'Amit spends 1 min on the Opening step (team: 25 sec).',
  ]);
  assert.deepStrictEqual(M.teamSteps(rows).map((s) => s.stepLabel), ['Opening', 'Questions']);
  assert.strictEqual(M.durationText(90), '1 min 30 sec');
});
test('compare: headline numbers and differences', () => {
  const rows = M.compare({ calls: 100, picked: 50, good: 10, active_days: 5, promises_judged: 10, promises_kept: 6 },
                         { calls: 100, picked: 40, good: 10, active_days: 4, promises_judged: 0, promises_kept: 0 });
  near(rows[0].delta, 0.1);
  near(rows[1].a, 20);
  assert.strictEqual(rows[2].delta, null);
  near(rows[3].b, 25);
});
test('wilson interval stays inside 0 to 1', () => {
  const w = M.wilson(0, 10);
  assert.ok(w.low >= 0 && w.low < 1e-9 && w.high > 0 && w.high < 1);
});

console.log('insights-model.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
