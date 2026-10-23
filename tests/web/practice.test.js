'use strict';
/* Tests for the pure helpers in web/js/practice.js (filling the pretend lead, walking steps, the summary) and
   static checks on web/practice.html (strict CSP, no inline script or style, no call_outcomes in the page code).
   Run: node --test tests/web/practice.test.js
   Prints "practice.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const P = require(path.join(root, 'web', 'js', 'practice.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

const STEPS = [
  { id: 'hello', start: true, say: ['Hi {name}, this is {me}.'], opts: [{ label: 'Yes', to: 'fee' }, { label: 'No', to: 'later' }] },
  { id: 'fee', title: 'Fee', say: ['{student} has {amount} due by {due_date}.'], opts: [{ label: 'Will pay', to: 'end' }, { label: 'Broken', to: 'nowhere' }] },
  { id: 'later', title: 'Not now', say: ['Okay, bye.'] },
  { id: 'end', title: 'Promise', say: ['Thank you, {name}.'] },
];

test('fillLine fills known values and leaves unknown ones', () => {
  const vals = Object.assign({}, P.PRETEND_LEAD, { me: 'Ravi' });
  assert.strictEqual(P.fillLine('Hi {name}, this is {me}.', vals), 'Hi Priya Sharma, this is Ravi.');
  assert.strictEqual(P.fillLine('{ student } owes {amount}', vals), 'Aarav Sharma owes ₹18,000');
  assert.strictEqual(P.fillLine('Hello {Name}', vals), 'Hello Priya Sharma');
  assert.strictEqual(P.fillLine('Batch {batch_code}', vals), 'Batch {batch_code}');
  assert.strictEqual(P.fillLine(null, vals), '');
});
test('startStep finds the start, or the first step', () => {
  assert.strictEqual(P.startStep(STEPS).id, 'hello');
  assert.strictEqual(P.startStep([{ id: 'a' }, { id: 'b' }]).id, 'a');
  assert.strictEqual(P.startStep([]), null);
  assert.strictEqual(P.startStep(null), null);
});
test('optionsOf drops options that go nowhere; isEnd for end cards', () => {
  assert.deepStrictEqual(P.optionsOf(STEPS, P.stepById(STEPS, 'fee')).map((o) => o.label), ['Will pay']);
  assert.strictEqual(P.isEnd(STEPS, P.stepById(STEPS, 'end')), true);
  assert.strictEqual(P.isEnd(STEPS, P.stepById(STEPS, 'hello')), false);
});
test('stepName uses the title, else the id', () => {
  assert.strictEqual(P.stepName(P.stepById(STEPS, 'fee')), 'Fee');
  assert.strictEqual(P.stepName(P.stepById(STEPS, 'hello')), 'hello');
  assert.strictEqual(P.stepName(null), 'Step');
});
test('formatClock and formatSpoken', () => {
  assert.strictEqual(P.formatClock(7), '0:07');
  assert.strictEqual(P.formatClock(185), '3:05');
  assert.strictEqual(P.formatClock(3723), '1:02:03');
  assert.strictEqual(P.formatClock(-4), '0:00');
  assert.strictEqual(P.formatSpoken(200), '3m 20s');
  assert.strictEqual(P.formatSpoken(120), '2m');
  assert.strictEqual(P.formatSpoken(9), '9 sec');
});
test('summarise adds up repeat visits, totals and names the longest step', () => {
  const s = P.summarise([
    { id: 'hello', name: 'hello', ms: 5000 },
    { id: 'fee', name: 'Fee', ms: 20000 },
    { id: 'hello', name: 'hello', ms: 3000 },
    { id: 'fee', name: 'Fee', ms: 10000 },
    { id: 'end', name: 'Promise', ms: 2000 },
  ]);
  assert.strictEqual(s.totalSeconds, 40);
  assert.deepStrictEqual(s.steps.map((x) => x.id + ':' + x.seconds), ['hello:8', 'fee:30', 'end:2']);
  assert.strictEqual(s.slowest.id, 'fee');
});
test('summarise: one step has no longest step', () => {
  assert.strictEqual(P.summarise([{ id: 'a', name: 'a', ms: 4000 }]).slowest, null);
  assert.strictEqual(P.summarise([]).totalSeconds, 0);
});

const html = fs.readFileSync(path.join(root, 'web', 'practice.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'web', 'js', 'practice.js'), 'utf8');
test('practice.html: strict CSP, no inline script, style or handlers', () => {
  const csp = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html) || [])[1] || '';
  assert.ok(/script-src 'self' https:\/\/cdn\.jsdelivr\.net;/.test(csp), csp);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), csp);
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'inline script');
  assert.ok(!/<style[\s>]/i.test(html), 'style tag');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline handler');
  assert.ok(/integrity="sha384-/.test(html), 'SRI on the CDN script');
});
test('practice.js never writes calls and builds without HTML strings', () => {
  assert.ok(!/call_outcomes/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no call_outcomes in code');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(src));
  assert.ok(!/\.from\(/.test(src), 'no direct table access');
});

console.log('practice.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
