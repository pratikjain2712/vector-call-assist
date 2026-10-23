'use strict';
/* Tests for Sprint 9 script checks in web/js/script-model.js (ending results, more than 3 options, pushback
   answers, "Check this" marks) and the starter scripts in web/js/script-templates.js. No network, no DOM.
   Run: node tests/web/script-templates.test.js
   Prints "script-templates.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const M = require(path.join(__dirname, '..', '..', 'web', 'js', 'script-model.js'));
const T = require(path.join(__dirname, '..', '..', 'web', 'js', 'script-templates.js'));
const A = require(path.join(__dirname, '..', '..', 'web', 'js', 'script-adapter.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}

// The built-in result keys (docs/data-contract.md), with the common results every type has.
const COMMON = ['no_answer', 'busy', 'wrong_number', 'call_back_later', 'do_not_call'];
const RESULTS = {
  fees: ['paid', 'will_pay_on', 'paid_part', 'already_paid', 'refused'].concat(COMMON),
  sales: ['joined', 'interested', 'will_think', 'not_interested'].concat(COMMON),
  admission: ['visit_booked', 'form_sent', 'not_this_year', 'joined_elsewhere'].concat(COMMON),
};

const small = () => [
  { id: 'open', start: true, say: ['Hello {name}.'], opts: [{ label: 'Yes', to: 'paid' }, { label: 'Stop', to: 'stop' }] },
  { id: 'paid', title: 'Paid', say: ['Thank you.'], result: 'paid' },
  { id: 'stop', title: 'Do not call', say: ['Sorry.'], opts: [], result: 'do_not_call' },
];

// ----- ending results -----
test('without result keys, endings need no result (old scripts)', () => {
  const s = small();
  delete s[1].result;
  assert.deepStrictEqual(M.validateSteps(s), []);
});
test('with result keys, linked endings pass', () => {
  assert.deepStrictEqual(M.validateSteps(small(), { resultKeys: RESULTS.fees }), []);
});
test('an ending without a result is reported by its title', () => {
  const s = small();
  delete s[1].result;
  assert.deepStrictEqual(M.validateSteps(s, { resultKeys: RESULTS.fees }), ['The ending "Paid" is not linked to a result.']);
});
test('an ending with a result of another type is reported', () => {
  const s = small();
  s[1].result = 'joined';
  assert.deepStrictEqual(M.validateSteps(s, { resultKeys: RESULTS.fees }),
    ['The ending "Paid" is linked to "joined", which is not a result of this call type.']);
});
test('a step with options needs no result', () => {
  const s = small();
  s[0].result = 'nonsense';
  assert.deepStrictEqual(M.validateSteps(s, { resultKeys: RESULTS.fees }), []);
});

// ----- options and marks -----
test('more than 3 options is reported (the call page shows 3)', () => {
  const s = small();
  s[0].opts.push({ label: 'A', to: 'paid' }, { label: 'B', to: 'paid' });
  assert.deepStrictEqual(M.validateSteps(s), ['Step "open" has more than 3 options. Callers can pick from 3 at most.']);
});
test('a "Check this" mark on a step is a problem', () => {
  const s = small();
  s[0].check = ['Is the fee ₹18,000?', '  '];
  assert.deepStrictEqual(M.validateSteps(s), ['Check this (step "open"): Is the fee ₹18,000?']);
});
test('an empty check list is no problem', () => {
  const s = small();
  s[0].check = [];
  assert.deepStrictEqual(M.validateSteps(s), []);
});

// ----- pushbacks -----
test('no pushbacks is fine', () => {
  assert.deepStrictEqual(M.validatePushbacks(undefined), []);
  assert.deepStrictEqual(M.validatePushbacks([]), []);
});
test('a pushback list that is not a list is reported', () => {
  assert.deepStrictEqual(M.validatePushbacks({}), ['Pushback answers must be a list.']);
});
test('a pushback needs a label and an answer', () => {
  assert.deepStrictEqual(M.validatePushbacks([{ label: ' ', answer: '' }]), ['Pushback 1 has no label.', 'Pushback 1 has no answer.']);
});
test('two pushbacks with one label (any case) are reported', () => {
  assert.deepStrictEqual(M.validatePushbacks([{ label: 'No time', answer: 'a' }, { label: 'no time', answer: 'b' }]),
    ['Two pushbacks are labelled "no time".']);
});
test('long labels and answers and too many pushbacks are reported', () => {
  const many = Array.from({ length: 13 }, (_, i) => ({ label: 'L' + i, answer: 'A' }));
  assert.ok(M.validatePushbacks(many).includes('Keep to 12 pushback answers or fewer.'));
  const long = M.validatePushbacks([{ label: 'x'.repeat(61), answer: 'y'.repeat(601) }]);
  assert.strictEqual(long.length, 2);
  assert.ok(/longer than 60/.test(long[0]) && /longer than 600/.test(long[1]));
});
test('a marked pushback is a problem', () => {
  assert.deepStrictEqual(M.validatePushbacks([{ label: 'Parts?', answer: 'Yes.', check: ['Is this allowed?'] }]),
    ['Check this (pushback "Parts?"): Is this allowed?']);
});
test('validateScript joins step and pushback problems', () => {
  const script = { steps: small(), pushbacks: [{ label: 'X', answer: '' }] };
  script.steps[1].result = 'joined';
  assert.strictEqual(M.validateScript(script, { resultKeys: RESULTS.fees }).length, 2);
  assert.deepStrictEqual(M.validateScript(null), ['The script must be an object with steps.']);
});
test('checkMarks lists every mark with where it is', () => {
  const script = { steps: small(), pushbacks: [{ label: 'Parts?', answer: 'Yes.', check: ['Rule?'] }] };
  script.steps[1].check = ['Amount?'];
  assert.deepStrictEqual(M.checkMarks(script), [
    { where: 'step', index: 1, name: 'Paid', text: 'Amount?' },
    { where: 'pushback', index: 0, name: 'Parts?', text: 'Rule?' },
  ]);
});
test('endings are the steps without options', () => {
  assert.deepStrictEqual(M.endings(small()).map((s) => s.id), ['paid', 'stop']);
});

// ----- templates -----
test('there are three templates: fees, sales, admission', () => {
  assert.deepStrictEqual(T.TEMPLATES.map((t) => t.call_type), ['fees', 'sales', 'admission']);
  assert.deepStrictEqual(T.TEMPLATES.map((t) => t.name), ['Fees reminder', 'Course sales', 'Admission follow-up']);
});
T.TEMPLATES.forEach((t) => {
  test(t.name + ': only "Check this" marks stand between it and publishing', () => {
    const problems = M.validateScript(t, { resultKeys: RESULTS[t.call_type] });
    assert.ok(problems.length > 0, 'a template has marks for the institute\'s own facts');
    assert.deepStrictEqual(problems.filter((p) => !p.startsWith('Check this')), []);
  });
  test(t.name + ': with the marks cleared it is valid and has a do-not-call ending', () => {
    const c = T.template(t.key);
    c.steps.forEach((s) => delete s.check);
    c.pushbacks.forEach((p) => delete p.check);
    assert.deepStrictEqual(M.validateScript(c, { resultKeys: RESULTS[t.call_type] }), []);
    assert.ok(M.endings(c.steps).some((s) => s.result === 'do_not_call'));
  });
  test(t.name + ': the call page can show it', () => {
    const flow = A.adaptSteps(t.steps);
    assert.ok(flow, 'adaptSteps returned null');
    assert.strictEqual(A.startStepId(t.steps), 'open');
  });
  test(t.name + ': every step is reachable from the start', () => {
    const seen = new Set(['open']);
    const queue = ['open'];
    while (queue.length) {
      const id = queue.shift();
      const s = t.steps.find((x) => x.id === id);
      (s.opts || []).forEach((o) => { if (!seen.has(o.to)) { seen.add(o.to); queue.push(o.to); } });
    }
    assert.deepStrictEqual(t.steps.map((s) => s.id).filter((id) => !seen.has(id)), []);
  });
});
test('template() returns a copy that can be changed safely', () => {
  const a = T.template('fees_reminder');
  a.steps[0].say[0] = 'changed';
  assert.notStrictEqual(T.template('fees_reminder').steps[0].say[0], 'changed');
  assert.strictEqual(T.template('nope'), null);
});

// ----- the call page carries the ending's result -----
test('adaptSteps keeps the result of an end card', () => {
  const flow = A.adaptSteps(small());
  assert.strictEqual(flow.paid.end.result, 'paid');
  assert.strictEqual(flow.open.end, undefined);
});

console.log('script-templates.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
