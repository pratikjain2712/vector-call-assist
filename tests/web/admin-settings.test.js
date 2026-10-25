'use strict';
/* Tests for the pure helpers of the Settings tab (web/js/admin/settings.js): time zone choices, the plan line,
   add-ons, AI draft use, result button needs, label checks and the activity log in plain English.
   No network and no DOM.
   Run: node --test tests/web/admin-settings.test.js
   Prints "admin-settings.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const T = require(path.join(root, 'web', 'js', 'admin', 'settings.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

test('time zones: India first, and an unusual zone is kept', () => {
  assert.deepStrictEqual(T.zoneChoices('Asia/Kolkata')[0], ['Asia/Kolkata', 'India (IST)']);
  const z = T.zoneChoices('Africa/Nairobi');
  assert.deepStrictEqual(z[z.length - 1], ['Africa/Nairobi', 'Africa/Nairobi']);
  assert.strictEqual(T.zoneChoices('UTC').length, T.TIME_ZONES.length);
});
test('plan line', () => {
  assert.strictEqual(T.planText({ status: 'trial', trial_days_left: 3, seats_used: 5, seat_limit: 5 }), 'Trial: 3 days left · 5 of 5 seats used');
  assert.strictEqual(T.planText({ status: 'trial', trial_days_left: 1 }), 'Trial: 1 day left');
  assert.strictEqual(T.planText({ status: 'trial', trial_days_left: 0 }), 'Trial ended');
  assert.strictEqual(T.planText({ status: 'active', seats_used: 12, seat_limit: 20 }), 'Paid plan · 12 of 20 seats used');
  assert.strictEqual(T.planText({ status: 'suspended' }), 'Paused: payment needed');
});
test('add-ons with the "Add Scripts" note', () => {
  const off = T.featureRows([]);
  assert.deepStrictEqual(off.map((f) => [f.key, f.on]), [['scripts', false], ['ai_drafts', false]]);
  assert.ok(/^Add Scripts to use/.test(off[0].note) && /^Add Scripts to use/.test(off[1].note));
  const on = T.featureRows(['scripts', 'ai_drafts']);
  assert.ok(on.every((f) => f.on && !/^Add/.test(f.note)));
  assert.strictEqual(T.featureRows(null)[0].on, false);
});
test('AI drafts used', () => {
  assert.strictEqual(T.aiUsageText({ used: 3, limit: 20 }), '3 of 20 AI drafts used this month');
  assert.strictEqual(T.aiUsageText([{ drafts_used: 4, monthly_limit: 50 }]), '4 of 50 AI drafts used this month');
  assert.strictEqual(T.aiUsageText(7), '7 of 20 AI drafts used this month');
  assert.strictEqual(T.aiUsageText(null), '');
});
test('what a result button asks for', () => {
  assert.strictEqual(T.resultNeeds({ needs_date: true, needs_amount: true }), 'date, amount');
  assert.strictEqual(T.resultNeeds({ needs_reason: true }), 'reason');
  assert.strictEqual(T.resultNeeds({}), '');
});
test('labels: trimmed, 1 to 60 characters', () => {
  assert.deepStrictEqual(T.checkLabel('  Parent   meeting ', 'call type'), { ok: true, text: 'Parent meeting' });
  assert.strictEqual(T.checkLabel('', 'button').ok, false);
  assert.strictEqual(T.checkLabel('x'.repeat(61), 'button').ok, false);
  assert.strictEqual(T.checkLabel('x'.repeat(60), 'button').ok, true);
});
test('activity log in plain English', () => {
  assert.strictEqual(T.actionText({ action: 'seat.role_set', target_label: 'Ravi', target_rest: ':manager' }), 'Changed a role: Ravi to manager');
  assert.strictEqual(T.actionText({ action: 'money.exported', target: 'fees_report:1200' }), 'Downloaded a file with money (fees report, 1,200 rows)');
  assert.strictEqual(T.actionText({ action: 'money.access_given', target_label: 'Priya' }), 'Allowed a manager to see money: Priya');
  assert.strictEqual(T.actionText({ action: 'institute.changed', target: 'name,time_zone' }), 'Changed the institute name and time zone');
  assert.strictEqual(T.actionText({ action: 'campaign.paused', target_label: 'Oct fees' }), 'Paused a campaign: Oct fees');
  assert.strictEqual(T.actionText({ action: 'whatsapp.number_connected' }), 'Whatsapp number connected');
  assert.strictEqual(T.actionText({}), 'Something changed');
});
test('the tab keeps the password panel and leaves a WhatsApp section', () => {
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'settings.js'), 'utf8');
  ['\'login\'', '\'reset-send\'', '\'settings-whatsapp\'', 'settings-whatsapp.js'].forEach((s) => assert.ok(src.includes(s), s));
});

// ---------- Phase A.2: common answers ----------
test('common answers that need the institute facts', () => {
  const rows = [{ key: 'who', check: [], filled: true }, { key: 'location', check: ['Add your address.'], filled: false },
    { key: 'discount', check: ['Add discounts.'], filled: true }];
  assert.deepStrictEqual(T.answersToFill(rows).map((r) => r.key), ['location', 'discount']);
  assert.strictEqual(T.fillSummary(rows), '1 of 2 filled in');
  assert.deepStrictEqual(T.answersToFill(null), []);
});

console.log('admin-settings.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
