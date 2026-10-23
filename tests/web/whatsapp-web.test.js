'use strict';
/* Tests for the WhatsApp browser code: the caller helper web/js/whatsapp-client.js (with a fake supabase-js
   client) and the pure helpers of the Settings panel web/js/admin/settings-whatsapp.js. No network, no DOM.
   Run: node --test tests/web/whatsapp-web.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const C = require(path.join(root, 'web', 'js', 'whatsapp-client.js'));
const P = require(path.join(root, 'web', 'js', 'admin', 'settings-whatsapp.js'));
const S = require(path.join(root, 'web', 'js', 'admin', 'shared.js'));

const LEAD = '11111111-2222-3333-4444-555555555555';
const TEMPLATES = [
  { key: 'promise_due', label: 'Promise due', call_type_key: 'fees', result_key: 'will_pay_on', category: 'utility', body: 'Hi {{1}}, pay {{2}} on {{3}}.', param_sources: ['lead_name', 'promised_amount', 'promised_date'] },
  { key: 'fees_reminder', label: 'Fees reminder', call_type_key: 'fees', result_key: null, category: 'utility', body: 'Hi {{1}}.', param_sources: ['lead_name'] },
  { key: 'course_details', label: 'Course details', call_type_key: 'sales', result_key: 'interested', category: 'marketing', body: 'Hi {{1}}, {{2}} here.', param_sources: ['lead_name', 'typed'] },
  { key: 'thanks', label: 'Thanks', call_type_key: null, result_key: null, category: 'utility', body: 'Thank you {{1}}.', param_sources: ['lead_name'] },
];

// A fake supabase-js client: functions.invoke answers with the given result and records the call.
function fakeClient(result) {
  const calls = [];
  return {
    calls,
    functions: { invoke: async (name, opts) => { calls.push({ name, opts }); if (result instanceof Error) throw result; return result; } },
    rpc: async (name) => (name === 'my_whatsapp_templates' ? { data: TEMPLATES, error: null } : { data: null, error: { message: 'nope' } }),
  };
}
const httpError = (status, body) => ({ name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
  context: new Response(JSON.stringify(body), { status }) });

// ---------- caller helper ----------

test('templates for a call ending: exact ending, then the type, then any call', () => {
  assert.deepStrictEqual(C.forResult(TEMPLATES, 'fees', 'will_pay_on').map((t) => t.key), ['promise_due', 'fees_reminder', 'thanks']);
  assert.deepStrictEqual(C.forResult(TEMPLATES, 'fees', 'paid').map((t) => t.key), ['fees_reminder', 'thanks']);
  assert.deepStrictEqual(C.forResult(TEMPLATES, 'sales', 'interested').map((t) => t.key), ['course_details', 'thanks']);
  assert.deepStrictEqual(C.forResult(TEMPLATES, 'sales', 'interested', true).map((t) => t.key), ['thanks']);
  assert.deepStrictEqual(C.forResult(null, 'fees', 'paid'), []);
});

test('typed blanks and the preview', () => {
  assert.deepStrictEqual(C.typedBlanks(TEMPLATES[2]), [2]);
  assert.deepStrictEqual(C.typedBlanks(TEMPLATES[0]), []);
  assert.strictEqual(C.preview(TEMPLATES[0], { lead_name: 'Asha', promised_amount: '₹6,000' }), 'Hi Asha, pay ₹6,000 on [promised date].');
  assert.strictEqual(C.preview(TEMPLATES[2], { lead_name: 'Asha' }, ['', 'Batch B']), 'Hi Asha, Batch B here.');
  assert.strictEqual(C.preview(TEMPLATES[2], { lead_name: 'Asha' }, { 2: 'Batch C' }), 'Hi Asha, Batch C here.');
  assert.strictEqual(C.preview(TEMPLATES[2], {}), 'Hi [name], [typed by you] here.');
});

test('sendAfterCall calls whatsapp-send with the lead, the template and what was typed', async () => {
  const client = fakeClient({ data: { ok: true, message_id: 'm-1' }, error: null });
  const out = await C.sendAfterCall(client, LEAD, 'course_details', ['', 'Batch B']);
  assert.deepStrictEqual(out, { ok: true, messageId: 'm-1' });
  assert.strictEqual(client.calls[0].name, 'whatsapp-send');
  assert.deepStrictEqual(client.calls[0].opts.body, { lead_id: LEAD, template_key: 'course_details', params: ['', 'Batch B'] });
  await C.sendAfterCall(client, LEAD, 'fees_reminder');
  assert.deepStrictEqual(client.calls[1].opts.body, { lead_id: LEAD, template_key: 'fees_reminder' });
});

test('sendAfterCall shows the server\'s sentence and never throws', async () => {
  let out = await C.sendAfterCall(fakeClient({ data: null, error: httpError(400, { error: 'This person has not agreed to WhatsApp messages.' }) }), LEAD, 'fees_reminder');
  assert.deepStrictEqual(out, { ok: false, error: 'This person has not agreed to WhatsApp messages.' });
  out = await C.sendAfterCall(fakeClient(new TypeError('Failed to fetch')), LEAD, 'fees_reminder');
  assert.deepStrictEqual(out, { ok: false, error: 'No connection. Try again.' });
  out = await C.sendAfterCall(fakeClient({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request' } }), LEAD, 'fees_reminder');
  assert.strictEqual(out.ok, false);
  out = await C.sendAfterCall(fakeClient({ data: { ok: true } }), 'not-a-uuid', 'fees_reminder');
  assert.deepStrictEqual(out, { ok: false, error: 'Choose a lead first.' });
  out = await C.sendAfterCall(fakeClient({ data: { ok: true } }), LEAD, 'Bad Key');
  assert.deepStrictEqual(out, { ok: false, error: 'Choose a message first.' });
  out = await C.sendAfterCall(null, LEAD, 'fees_reminder');
  assert.strictEqual(out.ok, false);
});

test('loadTemplates and statusText', async () => {
  assert.strictEqual((await C.loadTemplates(fakeClient({}))).length, 4);
  assert.strictEqual(C.statusText('read'), 'Read');
  assert.strictEqual(C.statusText('failed'), 'Not delivered');
  assert.strictEqual(C.statusText('odd'), '');
});

// ---------- Settings panel helpers ----------

test('blank counting matches the server rule', () => {
  assert.strictEqual(P.countBlanks('Hi {{1}}, pay {{2}}.'), 2);
  assert.strictEqual(P.countBlanks('Hi {{2}}.'), -1);
  assert.strictEqual(P.countBlanks('Hi {{1}} {{1}}.'), 1);
  assert.strictEqual(P.countBlanks('Hi {{x}}.'), -1);
});

test('every starter template passes the checks and uses known fillers', () => {
  assert.deepStrictEqual(P.STARTERS.map((s) => s.key), ['fees_reminder', 'promise_due', 'course_details', 'weekly_brief']);
  P.STARTERS.forEach((s) => {
    assert.strictEqual(P.checkTemplate(s), '', s.key);
    assert.strictEqual(P.countBlanks(s.body), s.param_sources.length, s.key);
    assert.ok(/^[a-z][a-z0-9_]{1,39}$/.test(s.key));
  });
  assert.strictEqual(P.STARTERS.find((s) => s.key === 'promise_due').category, 'utility', 'the reminder job needs a utility template');
});

test('template form checks', () => {
  const ok = { label: 'Fees', body: 'Hello {{1}}, pay soon.', param_sources: ['lead_name'] };
  assert.strictEqual(P.checkTemplate(ok), '');
  assert.match(P.checkTemplate(Object.assign({}, ok, { label: '' })), /name/);
  assert.match(P.checkTemplate(Object.assign({}, ok, { body: '' })), /Write the message/);
  assert.match(P.checkTemplate(Object.assign({}, ok, { body: 'Hello {{2}} now.' })), /in order/);
  assert.match(P.checkTemplate(Object.assign({}, ok, { param_sources: [] })), /fills each blank/);
  assert.match(P.checkTemplate(Object.assign({}, ok, { param_sources: ['bank'] })), /fills each blank/);
  assert.match(P.checkTemplate(Object.assign({}, ok, { body: '{{1}}, pay soon.' })), /starts or ends/);
  assert.match(P.checkTemplate(Object.assign({}, ok, { body: 'Pay soon {{1}}.' })), /starts or ends/);
});

test('connect form checks', () => {
  const f = { phone_number_id: '1234567890', waba_id: '5550001', display_name: 'Sunrise', access_token: 'EAAtesttokenvalue1234567890' };
  assert.strictEqual(P.checkConnect(f, false), '');
  assert.match(P.checkConnect(Object.assign({}, f, { phone_number_id: '12ab' }), false), /phone number ID/);
  assert.match(P.checkConnect(Object.assign({}, f, { waba_id: '' }), false), /Business Account ID/);
  assert.match(P.checkConnect(Object.assign({}, f, { display_name: '' }), false), /display name/);
  assert.match(P.checkConnect(Object.assign({}, f, { access_token: '' }), false), /Paste/);
  assert.strictEqual(P.checkConnect(Object.assign({}, f, { access_token: '' }), true), '', 'keeps the saved token');
  assert.match(P.checkConnect(Object.assign({}, f, { access_token: 'has spaces in it but long enough' }), false), /does not look right/);
});

test('status words, cost and call endings', () => {
  assert.strictEqual(P.statusLabel({ meta_status: 'approved' }), 'Approved');
  assert.strictEqual(P.statusLabel({ meta_status: 'rejected', meta_reason: 'PROMOTIONAL' }), 'Rejected: PROMOTIONAL');
  assert.strictEqual(P.statusLabel({ meta_status: 'draft' }), 'Not sent for approval');
  assert.strictEqual(P.costText(0.115, S.rupees), '₹0.12');
  assert.strictEqual(P.costText(360.5, S.rupees), '₹360.50');
  assert.strictEqual(P.costText(270000, S.rupees), '₹2,70,000');
  const types = [{ key: 'fees', label: 'Fees collection', active: true, results: [
    { key: 'paid', label: 'Paid', common: false }, { key: 'no_answer', label: 'No answer', common: true }] },
  { key: 'old', label: 'Old', active: false, results: [] }];
  assert.deepStrictEqual(P.endingOptions(types), [
    { value: '', label: 'Any call' }, { value: 'fees|', label: 'Fees collection: any ending' }, { value: 'fees|paid', label: 'Fees collection: Paid' }]);
  assert.strictEqual(P.endingLabel({ call_type_key: 'fees', result_key: 'paid' }, types), 'Fees collection: Paid');
  assert.strictEqual(P.endingLabel({ call_type_key: null }, types), 'Any call');
  assert.strictEqual(P.endingLabel({ call_type_key: 'x', result_key: 'y' }, []), 'x: y');
});

test('the browser files build no HTML strings and keep secrets out', () => {
  ['web/js/whatsapp-client.js', 'web/js/admin/settings-whatsapp.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(src), f);
    assert.ok(!/localStorage|sessionStorage/.test(src), f + ' keeps nothing in browser storage');
  });
  const css = fs.readFileSync(path.join(root, 'web', 'css', 'admin-settings-whatsapp.css'), 'utf8');
  css.split('\n').filter((l) => /^[^\s/@}].*\{/.test(l)).forEach((l) => assert.ok(l.startsWith('.tab-settings'), l));
});
