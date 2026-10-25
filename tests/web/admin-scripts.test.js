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

// ---------- Phase A.2: the template library ----------
const M = require(path.join(__dirname, '..', '..', 'web', 'js', 'script-model.js'));
const TPL = require(path.join(__dirname, '..', '..', 'web', 'js', 'script-templates.js'));

test('templateArgs sends null for blank filters', () => {
  assert.deepStrictEqual(P.templateArgs({ callType: 'fees', classLabel: ' 8th ', board: '', language: 'hinglish' }),
    { p_call_type: 'fees', p_class_label: '8th', p_board: null, p_language: 'hinglish' });
  assert.deepStrictEqual(P.templateArgs(null), { p_call_type: null, p_class_label: null, p_board: null, p_language: null });
});

test('templateTags, templateSize and languageLabel describe a template', () => {
  assert.strictEqual(P.templateTags({ class_labels: [], boards: [] }), 'All classes · All boards');
  assert.strictEqual(P.templateTags({ class_labels: ['9th', '10th'], boards: ['CBSE'] }), '9th, 10th · CBSE');
  assert.strictEqual(P.templateSize({ steps: [1, 2], pushbacks: [1], check_marks: 3 }), '2 steps · 1 pushback answer · 3 facts to fill in');
  assert.strictEqual(P.templateSize({ steps: [1], pushbacks: [] }), '1 step · 0 pushback answers');
  assert.strictEqual(P.languageLabel('hinglish'), 'Hinglish');
  assert.strictEqual(P.languageLabel('en'), 'English');
});

test('localTemplates and filterLocal stand in for a database without the library', () => {
  const rows = P.localTemplates(TPL.TEMPLATES);
  assert.strictEqual(rows.length, TPL.TEMPLATES.length);
  assert.ok(rows.every((r) => r.language === 'en' && r.class_labels.length === 0 && r.check_marks >= 0));
  assert.ok(P.filterLocal(rows, { p_call_type: 'fees' }).every((r) => r.call_type === 'fees'));
  assert.strictEqual(P.filterLocal(rows, { p_language: 'hinglish' }).length, 0);
});

test('splitList and readJsonList read the Library form', () => {
  assert.deepStrictEqual(P.splitList('8th, 9th\n9th,, 10th '), ['8th', '9th', '10th']);
  assert.deepStrictEqual(P.readJsonList('', 'Steps'), { value: [] });
  assert.deepStrictEqual(P.readJsonList('[{"id":"a"}]', 'Steps'), { value: [{ id: 'a' }] });
  assert.match(P.readJsonList('{}', 'Steps').error, /must be a JSON list/);
  assert.match(P.readJsonList('[', 'Steps').error, /not valid JSON/);
});

test('libraryProblems allows "Check this" marks but not broken endings', () => {
  const t = TPL.template('fees_reminder');
  const keys = ['paid', 'will_pay_on', 'paid_part', 'already_paid', 'refused', 'no_answer', 'busy', 'wrong_number', 'call_back_later', 'do_not_call'];
  assert.deepStrictEqual(P.libraryProblems(t, keys, M), []);
  const broken = JSON.parse(JSON.stringify(t));
  broken.steps.find((s) => s.id === 'refused').result = 'joined';
  assert.match(P.libraryProblems(broken, keys, M).join(' '), /not a result of this call type/);
  assert.deepStrictEqual(P.libraryProblems({ steps: 'x' }, keys, M), ['The steps must be a list.']);
});
