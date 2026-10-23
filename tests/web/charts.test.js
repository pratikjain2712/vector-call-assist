'use strict';
/* Tests for the pure helpers in web/js/charts.js (axis tops and ticks, scales, polyline points, nearest point),
   plus static checks: no HTML strings, colours only from the chart tokens, every chart has a table toggle.
   Run: node --test tests/web/charts.test.js
   Prints "charts.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const C = require(path.join(root, 'web', 'js', 'charts.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

test('niceMax rounds up to 1, 2, 2.5, 5 or 10 × a power of ten', () => {
  assert.strictEqual(C.niceMax(0), 1);
  assert.strictEqual(C.niceMax(7), 10);
  assert.strictEqual(C.niceMax(180), 200);
  assert.strictEqual(C.niceMax(2100000), 2500000);
  assert.strictEqual(C.niceMax(4320000), 5000000);
  assert.strictEqual(C.niceMax(100), 100);
});
test('ticks are round steps from 0', () => {
  assert.deepStrictEqual(C.ticks(500), [0, 100, 200, 300, 400, 500]);
  assert.deepStrictEqual(C.ticks(200), [0, 50, 100, 150, 200]);
  assert.deepStrictEqual(C.ticks(2500000), [0, 500000, 1000000, 1500000, 2000000, 2500000]);
  assert.deepStrictEqual(C.ticks(10, 2), [0, 5, 10]);
});
test('scale maps a domain to a range, also reversed', () => {
  const y = C.scale(0, 100, 200, 20);
  assert.strictEqual(y(0), 200);
  assert.strictEqual(y(100), 20);
  assert.strictEqual(y(50), 110);
});
test('points and nearest', () => {
  assert.strictEqual(C.points([[1.234, 5], [10, 20.06]]), '1.2,5 10,20.1');
  assert.strictEqual(C.nearest([0, 10, 20], 14), 1);
  assert.strictEqual(C.nearest([0, 10, 20], 16), 2);
});
test('charts build without HTML strings and colour only from tokens', () => {
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'charts.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(src));
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(src), 'no colour literals in charts.js (CSS holds them)');
  assert.ok(/Show as table/.test(src));
  const css = fs.readFileSync(path.join(root, 'web', 'css', 'admin-insights.css'), 'utf8');
  css.split('\n').filter((l) => /^\s*[.:@]/.test(l) && /\{/.test(l) && !/^\s*@/.test(l)).forEach((l) => {
    assert.ok(/\.tab-insights|^\s*:root/.test(l), 'rule scoped to the tab: ' + l.trim());
  });
});
test('the Insights tab loads its model and charts before itself', () => {
  const html = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
  const at = (f) => html.indexOf('<script src="js/' + f + '"></script>');
  assert.ok(at('insights-model.js') > -1 && at('charts.js') > -1);
  assert.ok(at('insights-model.js') < at('admin/insights.js') && at('charts.js') < at('admin/insights.js'));
});

console.log('charts.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
