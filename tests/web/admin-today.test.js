'use strict';
/* Tests for the pure helpers of the Today tab (web/js/admin/today.js): the getting-started checklist, worked out
   from what the server said. No network and no DOM.
   Run: node --test tests/web/admin-today.test.js */
const assert = require('assert');
const path = require('path');
const T = require(path.join(__dirname, '..', '..', 'web', 'js', 'admin', 'today.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

const answers = (filled) => [
  { key: 'who', check: [], filled: true },   // needs no facts: not counted
  ...['location', 'landline', 'website', 'fees', 'discount'].map((k, i) => ({ key: k, check: ['Add it.'], filled: i < filled })),
];
const NEW = {
  ledger: { has_ledger: false }, answers: answers(0), seats: [{ role: 'admin', status: 'active' }],
  campaigns: [], whatsapp: { account: null },
};
const DONE = {
  ledger: { has_ledger: true }, answers: answers(5),
  seats: [{ role: 'admin', status: 'active' }, { role: 'rep', status: 'invited' }],
  campaigns: [{ status: 'running', script_name: 'Fees reminder' }], whatsapp: { account: { status: 'connected' } },
};

test('a new institute: five things to do, in order, each with a link', () => {
  const items = T.checklistItems(NEW);
  assert.deepStrictEqual(items.map((i) => i.key), ['students', 'answers', 'caller', 'list', 'whatsapp']);
  assert.deepStrictEqual(items.map((i) => i.text), ['Import students and fees', 'Fill common answers (0 of 5)', 'Add a caller',
    'Start a calling list from a template', 'Connect WhatsApp']);
  assert.ok(items.every((i) => !i.done && /^#/.test(i.href)));
  assert.deepStrictEqual(items.map((i) => i.href), ['#fees', '#settings', '#team', '#calling/scripts?new=pick', '#settings']);
  assert.strictEqual(T.showChecklist(items, false), true);
});
test('each item is done from real data', () => {
  const items = T.checklistItems(DONE);
  assert.ok(items.every((i) => i.done), JSON.stringify(items));
  assert.strictEqual(items[1].text, 'Fill common answers (5 of 5)');
  assert.strictEqual(T.showChecklist(items, false), false);   // hidden when everything is done
});
test('part done: the count of common answers, a removed caller does not count, a draft list does not count', () => {
  const items = T.checklistItems(Object.assign({}, DONE, {
    answers: answers(2),
    seats: [{ role: 'admin', status: 'active' }, { role: 'rep', status: 'revoked' }],
    campaigns: [{ status: 'draft', script_name: 'Fees reminder' }, { status: 'running', script_name: null }],
  }));
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.strictEqual(by.answers.text, 'Fill common answers (2 of 5)');
  assert.strictEqual(by.answers.done, false);
  assert.strictEqual(by.caller.done, false);
  assert.strictEqual(by.list.done, false);
  assert.strictEqual(by.students.done, true);
  assert.strictEqual(T.showChecklist(items, false), true);
  assert.strictEqual(T.showChecklist(items, true), false);   // closed by the owner
});
test('an answer the server could not give leaves that item out', () => {
  const items = T.checklistItems({ ledger: null, answers: null, seats: [], campaigns: null, whatsapp: null });
  assert.deepStrictEqual(items.map((i) => i.key), ['caller']);
  assert.deepStrictEqual(T.checklistItems({}), []);
  assert.strictEqual(T.showChecklist([], false), false);
});

console.log('admin-today.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
