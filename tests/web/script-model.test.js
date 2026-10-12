'use strict';
/* Tests for web/js/script-model.js: validation, preview, test runs (including a loop and a dead end),
   version diffs, report ranges and line splitting. No network and no DOM.
   Run: node tests/web/script-model.test.js
   Prints "script-model.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const M = require(path.join(__dirname, '..', '..', 'web', 'js', 'script-model.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

// A small valid script: open -> (yes) won, (no) retry -> open (a loop), and a dead-end route.
const good = () => [
  { id: 'open', title: 'Opening', start: true, say: ['Hi {name}, {me} here.'], tip: 'Smile first.',
    opts: [{ label: 'Yes', to: 'won' }, { label: 'No', to: 'retry' }] },
  { id: 'retry', title: 'Retry', say: ['Can I try once more?'],
    opts: [{ label: 'Yes', to: 'open' }, { label: 'No', to: 'lost' }] },
  { id: 'won', title: 'Enrolled', say: ['Welcome aboard.'], opts: [] },
  { id: 'lost', title: 'Not now', say: ['Thanks for your time.'], opts: [] },
];

// ----- splitLines -----
test('splitLines trims lines and drops blank ones', () => {
  assert.deepStrictEqual(M.splitLines('  one \r\n\n two\n   \nthree  '), ['one', 'two', 'three']);
});
test('splitLines treats null as no lines', () => {
  assert.deepStrictEqual(M.splitLines(null), []);
});

// ----- validateSteps -----
test('a valid script has no problems (end cards need no options)', () => {
  assert.deepStrictEqual(M.validateSteps(good()), []);
});
test('an empty list is reported', () => {
  assert.deepStrictEqual(M.validateSteps([]), ['Add at least one step.']);
});
test('a value that is not a list is reported', () => {
  assert.deepStrictEqual(M.validateSteps({ open: {} }), ['The script must be a list of steps.']);
});
test('a duplicate step id is reported once', () => {
  const s = good();
  s.push({ id: 'won', say: ['Again.'], opts: [] }, { id: 'won', say: ['And again.'], opts: [] });
  const errs = M.validateSteps(s);
  assert.deepStrictEqual(errs, ['Step id "won" is used more than once.']);
});
test('an option that points at a missing step is reported with both names', () => {
  const s = good();
  s[0].opts[1].to = 'nowhere';
  assert.deepStrictEqual(M.validateSteps(s), ['Step "open": the option "No" goes to "nowhere", which is not a step.']);
});
test('a missing start step is reported', () => {
  const s = good();
  delete s[0].start;
  assert.deepStrictEqual(M.validateSteps(s), ['Mark at least one step as the start.']);
});
test('a step with nothing to say is reported, blank lines do not count', () => {
  const s = good();
  s[1].say = ['   ', ''];
  assert.deepStrictEqual(M.validateSteps(s), ['Step "retry" has nothing to say.']);
});
test('an option with no label is reported', () => {
  const s = good();
  s[2].opts = [{ label: ' ', to: 'lost' }];
  assert.deepStrictEqual(M.validateSteps(s), ['Step "won" has an option with no label.']);
});
test('a step id with spaces or punctuation is reported', () => {
  const s = good();
  s[1].id = 'bad id!';
  s[0].opts[1].to = 'bad id!';
  const errs = M.validateSteps(s);
  assert.ok(errs.some((e) => e.startsWith('Step id "bad id!" may use only letters')), errs.join(' | '));
  assert.strictEqual(errs.length, 1);
});
test('two options with the same label in one step are reported', () => {
  const s = good();
  s[0].opts = [{ label: 'Yes', to: 'won' }, { label: 'Yes', to: 'lost' }];
  assert.deepStrictEqual(M.validateSteps(s), ['Step "open" has two options labelled "Yes".']);
});
test('a step without an id is reported by position', () => {
  const s = good();
  s[3].id = '';
  s[1].opts[1].to = 'won';
  assert.deepStrictEqual(M.validateSteps(s), ['Step 4 has no id.']);
});

// ----- renderPreview -----
test('preview lists what the rep sees for each step on the path', () => {
  assert.deepStrictEqual(M.renderPreview(good(), ['open', 'won']), [
    'Hi {name}, {me} here.',
    'Tip: Smile first.',
    'Choices: Yes / No',
    'Welcome aboard.',
    'End of call',
  ]);
});
test('preview shows a placeholder for a step id that is missing', () => {
  assert.deepStrictEqual(M.renderPreview(good(), ['ghost']), ['(step "ghost" is missing)']);
});

// ----- testRun -----
test('a run to an end card reports the path and end', () => {
  const r = M.testRun(good(), ['Yes']);
  assert.deepStrictEqual(r.path, ['open', 'won']);
  assert.strictEqual(r.status, 'end');
});
test('a run with no choices stops at the start step and lists its options', () => {
  const r = M.testRun(good(), []);
  assert.deepStrictEqual(r.path, ['open']);
  assert.strictEqual(r.status, 'unfinished');
  assert.strictEqual(r.current, 'open');
  assert.deepStrictEqual(r.options, ['Yes', 'No']);
});
test('a route that returns to a step already passed is a loop', () => {
  const r = M.testRun(good(), ['No', 'Yes']);
  assert.strictEqual(r.status, 'loop');
  assert.deepStrictEqual(r.path, ['open', 'retry', 'open']);
});
test('a route to a step id that does not exist is a dead end', () => {
  const s = good();
  s[0].opts[0].to = 'missing-step';
  const r = M.testRun(s, ['Yes']);
  assert.strictEqual(r.status, 'dead_end');
  assert.strictEqual(r.missing, 'missing-step');
  assert.deepStrictEqual(r.path, ['open']);
});
test('a choice that is not an option of the current step is refused', () => {
  const r = M.testRun(good(), ['Maybe']);
  assert.strictEqual(r.status, 'invalid_choice');
  assert.deepStrictEqual(r.options, ['Yes', 'No']);
});
test('a script with no start step cannot run', () => {
  const s = good();
  s[0].start = false;
  assert.strictEqual(M.testRun(s, []).status, 'no_start');
});
test('extra choices after an end card are ignored', () => {
  const r = M.testRun(good(), ['Yes', 'No', 'No']);
  assert.strictEqual(r.status, 'end');
  assert.deepStrictEqual(r.path, ['open', 'won']);
});

// ----- diffVersions -----
test('identical versions have no differences', () => {
  assert.deepStrictEqual(M.diffVersions(good(), good()), { added: [], removed: [], changed: [] });
});
test('added, removed and changed step ids are listed, sorted', () => {
  const a = good();
  const b = good();
  b.push({ id: 'callback', say: ['Call me later.'], opts: [] });   // added
  b.splice(3, 1);                                                  // removed: lost
  b[0].tip = 'Smile first, then ask.';                             // changed: open
  b[1].opts = [{ label: 'Yes', to: 'open' }, { label: 'No', to: 'callback' }];  // changed: retry
  assert.deepStrictEqual(M.diffVersions(a, b), {
    added: ['callback'], removed: ['lost'], changed: ['open', 'retry'],
  });
});
test('a change in the order of options counts as a change', () => {
  const a = good();
  const b = good();
  b[0].opts = [{ label: 'No', to: 'retry' }, { label: 'Yes', to: 'won' }];
  assert.deepStrictEqual(M.diffVersions(a, b), { added: [], removed: [], changed: ['open'] });
});
test('a missing version is treated as having no steps', () => {
  assert.deepStrictEqual(M.diffVersions(null, good()), { added: ['lost', 'open', 'retry', 'won'], removed: [], changed: [] });
});

// ----- reportRange -----
test('a one-day range runs from local midnight to the next midnight', () => {
  const r = M.reportRange('2026-10-12', '2026-10-12');
  assert.strictEqual(new Date(r.to).getTime() - new Date(r.from).getTime(), 86400000);
  assert.strictEqual(new Date(r.from).getDate(), 12);
});
test('a range with the to date before the from date is refused', () => {
  assert.throws(() => M.reportRange('2026-10-12', '2026-10-05'), /before the from date/);
});
test('a range over 400 days is refused', () => {
  assert.throws(() => M.reportRange('2025-01-01', '2026-10-12'), /400 days or less/);
});
test('a date that is not a real day is refused', () => {
  assert.throws(() => M.reportRange('2026-02-30', '2026-03-01'), /Pick both dates/);
});

console.log('script-model.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
