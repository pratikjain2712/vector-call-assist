'use strict';
/* Tests for the pure helpers of the Home tab (web/js/admin/home.js): durations, the change against the day
   before, caller status words, result summaries, the "Needs your attention" rules (money only when allowed)
   and campaign progress. No network and no DOM.
   Run: node --test tests/web/admin-home.test.js
   Prints "admin-home.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const H = require(path.join(root, 'web', 'js', 'admin', 'home.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

test('durations read as hours and minutes', () => {
  assert.strictEqual(H.duration(0), '—');
  assert.strictEqual(H.duration(null), '—');
  assert.strictEqual(H.duration(45), '45s');
  assert.strictEqual(H.duration(58 * 60), '58m');
  assert.strictEqual(H.duration(9 * 3600 + 40 * 60), '9h 40m');
  assert.strictEqual(H.duration(3600 + 5 * 60), '1h 05m');
});
test('minutes read as min or hours', () => {
  assert.strictEqual(H.minutes(45), '45 min');
  assert.strictEqual(H.minutes(65), '1h 05m');
});
test('percent is whole and null without a whole', () => {
  assert.strictEqual(H.percent(87, 142), 61);
  assert.strictEqual(H.percent(1, 0), null);
});
test('change against the day before', () => {
  assert.strictEqual(H.changeText(142, 127, 'today'), '12% more than yesterday');
  assert.strictEqual(H.changeText(90, 100, 'week'), '10% fewer than last week');
  assert.strictEqual(H.changeText(50, 50, 'yesterday'), 'Same as the day before');
  assert.strictEqual(H.changeText(0, 0, 'today'), '');
  assert.strictEqual(H.changeText(5, 0, 'today'), 'No calls yesterday by this time');
});
test('caller status words and levels', () => {
  assert.deepStrictEqual(H.statusInfo({ status: 'on_call' }), { text: 'On a call', level: 'ok' });
  assert.deepStrictEqual(H.statusInfo({ status: 'ready' }), { text: 'Ready', level: 'ok' });
  assert.deepStrictEqual(H.statusInfo({ status: 'idle', idle_minutes: 45 }), { text: 'No calls for 45 min', level: 'warn' });
  assert.deepStrictEqual(H.statusInfo({ status: 'phone_offline' }), { text: 'Phone offline', level: 'danger' });
  assert.strictEqual(H.statusInfo(null).text, 'No calls today');
});
test('results read as counts and words', () => {
  assert.strictEqual(H.resultsText([{ label: 'Paid', count: 5 }, { label: 'Will pay on date', count: 4 }]), '5 paid · 4 will pay on date');
  assert.strictEqual(H.resultsText([]), '—');
  assert.strictEqual(H.resultsText([{ label: 'Paid', count: 0 }]), '—');
});

const SUMMARY = {
  promises_due_today: { count: 6, amount: 54000 },
  callers: [
    { seat_id: 's1', label: 'Sana', now: { status: 'phone_offline', since: '2026-10-24T05:50:00Z' } },
    { seat_id: 's2', label: 'Amit', now: { status: 'idle', idle_minutes: 50 } },
    { seat_id: 's3', label: 'Ravi', now: { status: 'idle', idle_minutes: 20 } },
    { seat_id: 's4', label: 'Neha', now: { status: 'on_call' } },
  ],
  script_ends: [{ script_id: 'sc1', script_name: 'Vector sales v7', step: 'fees', step_label: 'Fees', share: 0.4, picked_up: 117 }],
};
test('needs attention: the four rules in order, with links', () => {
  const items = H.attentionItems(SUMMARY, { canSeeMoney: true });
  assert.deepStrictEqual(items.map((i) => i.key), ['promises', 'phone-s1', 'script-sc1', 'idle-s2']);
  assert.strictEqual(items[0].text, '6 fee promises are due today.');
  assert.strictEqual(items[0].detail, '₹54,000 in total, reported by caller.');
  assert.deepStrictEqual([items[0].tab, items[0].params], ['reports', { view: 'fees' }]);
  assert.strictEqual(items[1].text, 'Sana\'s phone is offline.');
  assert.ok(/Calls cannot start\.$/.test(items[1].detail));
  assert.deepStrictEqual([items[1].tab, items[1].params], ['callers', { seat: 's1' }]);
  assert.strictEqual(items[2].text, 'Vector sales v7: 40% of picked-up calls end at the Fees step.');
  assert.deepStrictEqual(items[2].params, { script: 'sc1' });
  assert.strictEqual(items[3].text, 'Amit has made no calls for 50 min.');
});
test('needs attention: no ₹ without money access', () => {
  const items = H.attentionItems(SUMMARY, { canSeeMoney: false });
  assert.strictEqual(items[0].detail, '');
  assert.ok(!items.some((i) => /₹/.test(i.text + i.detail)));
  // The server hides the amount (null) even when the page thinks it may show it.
  const hidden = H.attentionItems({ promises_due_today: { count: 1, amount: null } }, { canSeeMoney: true });
  assert.strictEqual(hidden[0].text, '1 fee promise is due today.');
  assert.strictEqual(hidden[0].detail, '');
});
test('needs attention: nothing when all is well', () => {
  assert.deepStrictEqual(H.attentionItems({ promises_due_today: { count: 0 }, callers: [], script_ends: [] }), []);
  assert.deepStrictEqual(H.attentionItems(null), []);
});
test('campaign progress', () => {
  const p = H.campaignProgress({ leads_total: 240, leads_called: 173, end_date: '2026-10-31', status: 'running' });
  assert.strictEqual(p.pct, 72);
  assert.strictEqual(p.text, '173 of 240 leads called · ends 31 Oct');
  const q = H.campaignProgress({ leads_total: 0, leads_called: 0, end_date: null, status: 'paused' });
  assert.strictEqual(q.pct, 0);
  assert.strictEqual(q.text, '0 of 0 leads called · no end date · paused');
});
test('refresh every minute', () => {
  assert.strictEqual(H.REFRESH_MS, 60000);
  assert.deepStrictEqual(H.DAYS.map((d) => d[0]), ['today', 'yesterday', 'week']);
});

console.log('admin-home.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
