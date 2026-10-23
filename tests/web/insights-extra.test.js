'use strict';
/* Tests for the pure helpers in web/js/admin/insights-extra.js (script test maths and labels), plus static
   checks: the module and its stylesheet are linked in admin.html before insights.js, no HTML strings, and
   every CSS rule is scoped to the Insights tab. No network and no DOM.
   Run: node --test tests/web/insights-extra.test.js
   Prints "insights-extra.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const X = require(path.join(root, 'web', 'js', 'admin', 'insights-extra.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);

// ----- maths -----
test('logGamma matches known values', () => {
  assert.ok(near(Math.exp(X.logGamma(5)), 24, 1e-9));
  assert.ok(near(Math.exp(X.logGamma(1)), 1, 1e-12));
  assert.ok(near(Math.exp(2 * X.logGamma(0.5)), Math.PI, 1e-9));
  assert.ok(near(X.logGamma(101), 363.73937555556347, 1e-7));
});
test('probBBeatsA: equal results give one half', () => {
  assert.ok(near(X.probBBeatsA(10, 100, 10, 100), 0.5, 1e-9));
  assert.ok(near(X.probBBeatsA(0, 0, 0, 0), 0.5, 1e-9));
});
test('probBBeatsA: matches a known case (12/96 against 9/102)', () => {
  // Checked by simulation: about 0.79.
  const p = X.probBBeatsA(9, 102, 12, 96);
  assert.ok(p > 0.78 && p < 0.81, String(p));
});
test('probBBeatsA: symmetric', () => {
  const p = X.probBBeatsA(20, 150, 35, 160);
  const q = X.probBBeatsA(35, 160, 20, 150);
  assert.ok(near(p + q, 1, 1e-9), p + q);
});
test('probBBeatsA: a big clear gap is near 1 or 0, and it stays finite with many calls', () => {
  assert.ok(X.probBBeatsA(100, 1000, 150, 1000) > 0.999);
  assert.ok(X.probBBeatsA(300, 1000, 200, 1000) < 0.001);
  const p = X.probBBeatsA(1500, 5000, 1550, 5000);
  assert.ok(Number.isFinite(p) && p > 0.5 && p < 1, String(p));
});
test('probBBeatsA: bad input is cleaned (good above calls, negatives, text)', () => {
  assert.ok(near(X.probBBeatsA(-3, 'x', 0, 0), 0.5, 1e-9));
  assert.ok(Number.isFinite(X.probBBeatsA(50, 10, 1, 10)));
});

// ----- verdict -----
test('testVerdict: under the minimum, no winner and how many more calls', () => {
  const v = X.testVerdict({ picked_up: 40, good: 30 }, { picked_up: 12, good: 1 });
  assert.strictEqual(v.state, 'need_more');
  assert.strictEqual(v.winner, null);
  assert.strictEqual(v.needA, 10);
  assert.strictEqual(v.needB, 38);
  assert.strictEqual(v.per100A, 75);
});
test('testVerdict: a clear winner after the minimum', () => {
  const v = X.testVerdict({ picked_up: 100, good: 10 }, { picked_up: 100, good: 25 });
  assert.strictEqual(v.state, 'winner');
  assert.strictEqual(v.winner, 'b');
  assert.ok(v.sure >= 0.9);
  assert.strictEqual(v.per100B, 25);
  const w = X.testVerdict({ picked_up: 100, good: 25 }, { picked_up: 100, good: 10 });
  assert.strictEqual(w.winner, 'a');
});
test('testVerdict: close results keep testing, with the leader', () => {
  const v = X.testVerdict({ picked_up: 102, good: 9 }, { picked_up: 96, good: 12 });
  assert.strictEqual(v.state, 'no_winner');
  assert.strictEqual(v.leader, 'b');
  assert.ok(v.sure > 0.5 && v.sure < 0.9);
});
test('testVerdict: minimum and sureness can be changed', () => {
  const v = X.testVerdict({ picked_up: 20, good: 2 }, { picked_up: 20, good: 9 }, { minCalls: 10, sure: 0.95 });
  assert.strictEqual(v.state, 'winner');
  assert.strictEqual(X.MIN_CALLS, 50);
  assert.strictEqual(X.SURE, 0.9);
});

// ----- labels -----
test('per100 rounds and needs calls', () => {
  assert.strictEqual(X.per100(9, 102), 9);
  assert.strictEqual(X.per100(12, 96), 13);
  assert.strictEqual(X.per100(0, 0), null);
});
test('surePercent never says 0% or 100%', () => {
  assert.strictEqual(X.surePercent(0.92), 92);
  assert.strictEqual(X.surePercent(0.9999), 99);
  assert.strictEqual(X.surePercent(0), 1);
});
test('formatDuration', () => {
  assert.strictEqual(X.formatDuration(340), '5m 40s');
  assert.strictEqual(X.formatDuration(360), '6m');
  assert.strictEqual(X.formatDuration(45), '45 sec');
  assert.strictEqual(X.formatDuration(null), '');
  assert.strictEqual(X.formatDuration('x'), '');
});
test('defaultPair: published against the newest other version', () => {
  assert.deepStrictEqual(X.defaultPair([{ version: 7 }, { version: 6, published: true }, { version: 5 }]), { a: 6, b: 7 });
  assert.deepStrictEqual(X.defaultPair([{ version: 7, published: true }, { version: 6 }, { version: 5 }]), { a: 7, b: 6 });
  assert.deepStrictEqual(X.defaultPair([{ version: 2 }, { version: 3 }]), { a: 2, b: 3 });
  assert.strictEqual(X.defaultPair([{ version: 1, published: true }]), null);
  assert.strictEqual(X.defaultPair(null), null);
});

// ----- static checks -----
const adminHtml = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'insights-extra.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web', 'css', 'admin-insights-extra.css'), 'utf8');
test('admin.html links the module before insights.js, and its stylesheet', () => {
  const at = (f) => adminHtml.indexOf('<script src="js/admin/' + f + '"></script>');
  assert.ok(at('insights-extra.js') > -1, 'script tag');
  assert.ok(at('shared.js') < at('insights-extra.js') && at('insights-extra.js') < at('insights.js'));
  assert.ok(adminHtml.includes('<link rel="stylesheet" href="css/admin-insights-extra.css">'));
});
test('the module builds without HTML strings and exports the two mount functions', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(src));
  assert.strictEqual(typeof X.mountWeeklyBrief, 'function');
  assert.strictEqual(typeof X.mountScriptTest, 'function');
});
test('every CSS rule is scoped to the Insights tab', () => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  const re = /([^{}]+)\{/g;
  let m;
  while ((m = re.exec(noComments))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@media')) continue;
    sel.split(',').forEach((s) => selectors.push(s.trim()));
  }
  assert.ok(selectors.length > 10);
  selectors.forEach((s) => assert.ok(/^(:root(\[data-theme="dark"\]|:not\(\[data-theme="light"\]\))\s+)?\.tab-insights\s/.test(s), s));
});

console.log('insights-extra.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
