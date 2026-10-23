'use strict';
/* Tests for the pure helpers of the Scripts tab (web/js/admin/scripts.js): good result rate, "Used in",
   live version, AI usage line, the AI form check and the easy-to-read badge. No DOM.
   Run: node --test tests/web/admin-scripts.test.js */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const P = require(path.join(__dirname, '..', '..', 'web', 'js', 'admin', 'scripts.js'));

test('goodRate rounds to a whole percent and shows a dash without calls', () => {
  assert.strictEqual(P.goodRate(173, 100), '58%');
  assert.strictEqual(P.goodRate(3, 1), '33%');
  assert.strictEqual(P.goodRate(0, 0), '—');
  assert.strictEqual(P.goodRate(null, 5), '—');
});

test('usedInText lists campaigns and marks closed and draft ones', () => {
  assert.strictEqual(P.usedInText([]), 'Not used');
  assert.strictEqual(P.usedInText(null), 'Not used');
  assert.strictEqual(P.usedInText([{ name: 'Oct fees', status: 'running' }, { name: 'Sep fees', status: 'closed' }, { name: 'Nov', status: 'draft' }]),
    'Oct fees, Sep fees (closed), Nov (draft)');
});

test('liveText shows the live version or Draft', () => {
  assert.strictEqual(P.liveText({ live_version: 3 }), 'v3');
  assert.strictEqual(P.liveText({ live_version: null }), 'Draft');
});

test('usageText and usageLeft read admin_ai_usage', () => {
  assert.strictEqual(P.usageText({ used: 3, monthly_limit: 20 }), '3 of 20 AI drafts used this month');
  assert.strictEqual(P.usageText(null), '');
  assert.strictEqual(P.usageLeft({ used: 3, monthly_limit: 20 }), 17);
  assert.strictEqual(P.usageLeft({ used: 25, monthly_limit: 20 }), 0);
  assert.strictEqual(P.usageLeft(null), null);
});

test('briefProblem asks for the type, who, and what the call is for, and checks lengths', () => {
  const ok = { call_type: 'fees', audience: 'Parents', purpose: 'Remind about the fee.', facts: '', never_say: '' };
  assert.strictEqual(P.briefProblem(ok), '');
  assert.strictEqual(P.briefProblem(Object.assign({}, ok, { call_type: '' })), 'Choose the call type.');
  assert.strictEqual(P.briefProblem(Object.assign({}, ok, { audience: '' })), 'Say who you call.');
  assert.strictEqual(P.briefProblem(Object.assign({}, ok, { purpose: '  ' })), 'Write what the call is for.');
  assert.match(P.briefProblem(Object.assign({}, ok, { facts: 'x'.repeat(1501) })), /1500/);
  assert.match(P.briefProblem(Object.assign({}, ok, { never_say: 'x'.repeat(601) })), /600/);
});

test('scoreBadge gives a tone for the easy-to-read score', () => {
  assert.deepStrictEqual(P.scoreBadge({ score: 96, label: 'Easy to read' }), { text: 'Easy to read (96/100)', tone: 'easy' });
  assert.strictEqual(P.scoreBadge({ score: 60, label: 'Fairly easy to read' }).tone, 'ok');
  assert.strictEqual(P.scoreBadge({ score: 30, label: 'Hard to read' }).tone, 'hard');
  assert.strictEqual(P.scoreBadge(null), null);
});
