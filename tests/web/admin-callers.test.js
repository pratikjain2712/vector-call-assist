'use strict';
/* Tests for the pure helpers of the Callers tab (web/js/admin/callers.js): role names, campaign member lists
   for admin_set_campaign_members, campaign changes and the "now" words. No network and no DOM.
   Run: node --test tests/web/admin-callers.test.js
   Prints "admin-callers.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const C = require(path.join(root, 'web', 'js', 'admin', 'callers.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

test('roles from access_role, and old admin seats are owners', () => {
  assert.strictEqual(C.roleLabel({ access_role: 'owner' }), 'Owner');
  assert.strictEqual(C.roleLabel({ access_role: 'manager', role: 'admin' }), 'Manager');
  assert.strictEqual(C.roleLabel({ access_role: 'caller', role: 'rep' }), 'Caller');
  assert.strictEqual(C.roleOf({ role: 'admin' }), 'owner');
  assert.strictEqual(C.roleOf({ role: 'rep' }), 'caller');
  assert.strictEqual(C.roleOf(null), 'caller');
});

const ROWS = [
  { seat_id: 'a', status: 'active', campaigns: [{ id: 'k1' }, { id: 'k2' }] },
  { seat_id: 'b', status: 'active', campaigns: [{ id: 'k1' }] },
  { seat_id: 'c', status: 'active', campaigns: [] },
  { seat_id: 'r', status: 'revoked', campaigns: [{ id: 'k1' }] },
];
test('member list after adding a seat to a campaign', () => {
  assert.deepStrictEqual(C.membersAfter(ROWS, 'k1', 'c', true), ['a', 'b', 'c']);
  assert.deepStrictEqual(C.membersAfter(ROWS, 'k2', 'c', true), ['a', 'c']);
});
test('member list after taking a seat off a campaign (revoked seats left out)', () => {
  assert.deepStrictEqual(C.membersAfter(ROWS, 'k1', 'a', false), ['b']);
  assert.deepStrictEqual(C.membersAfter(ROWS, 'k2', 'a', false), []);
  assert.deepStrictEqual(C.membersAfter([], 'k9', 'x', true), ['x']);
});
test('campaign changes', () => {
  assert.deepStrictEqual(C.campaignChanges(['k1', 'k2'], ['k2', 'k3']), { added: ['k3'], removed: ['k1'] });
  assert.deepStrictEqual(C.campaignChanges([], []), { added: [], removed: [] });
  assert.deepStrictEqual(C.campaignChanges(null, ['k1']), { added: ['k1'], removed: [] });
});
test('now words', () => {
  assert.strictEqual(C.nowText({ status: 'on_call' }), 'On a call');
  assert.strictEqual(C.nowText({ status: 'phone_offline' }), 'Phone offline');
  assert.strictEqual(C.nowText({ status: 'idle', idle_minutes: 46 }), 'No calls for 46 min');
  assert.strictEqual(C.nowText({ status: 'not_started' }), 'No calls today');
  assert.strictEqual(C.nowText(null), '');
});

console.log('admin-callers.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
