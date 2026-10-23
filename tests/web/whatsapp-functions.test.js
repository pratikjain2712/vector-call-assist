'use strict';
/* Tests for the WhatsApp Edge Functions' logic (supabase/functions/_shared/whatsapp.mjs and the whatsapp-*
   logic.mjs files). Meta's Graph API and the database are fakes: nothing leaves the machine. The SQL side
   (claims, RLS, consent) is tested in supabase/tests/whatsapp_test.sql.
   Run: node --test tests/web/whatsapp-functions.test.js */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');

const fn = path.join(__dirname, '..', '..', 'supabase', 'functions');
const load = (p) => import(path.join(fn, p));

const KEY = Buffer.alloc(32, 7).toString('base64');            // test-only encryption key
const APP_SECRET = 'test-app-secret';
const LEAD = '11111111-2222-3333-4444-555555555555';
const TPL = '99999999-2222-3333-4444-555555555555';

// A fake Graph API: records calls and answers from a list of handlers.
function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, init) => {
    const u = String(url);
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, method: (init && init.method) || 'GET', body, auth: init && init.headers && init.headers.Authorization });
    for (const [re, answer] of handlers) {
      if (re.test(u)) {
        const [status, json] = typeof answer === 'function' ? answer(u, body) : answer;
        return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: { message: 'no fake for ' + u, code: 100 } }), { status: 400 });
  };
  f.calls = calls;
  return f;
}

// A fake database: rpc(name, args) answers from a map and records the calls.
function fakeRpc(answers) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    const a = answers[name];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(args) : a;
  };
  rpc.calls = calls;
  rpc.called = (name) => calls.filter((c) => c.name === name);
  return rpc;
}
const dbError = (code, message) => Object.assign(new Error(message), { code });

function post(url, body, headers) {
  return new Request(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) });
}

async function prepared(W, extra) {
  return Object.assign({
    message_id: 'm-1', institute_id: 'inst-1', seat_id: 's-1', caller_name: 'Priya', institute_name: 'Sunrise Academy',
    lead: { id: LEAD, name: 'Asha', phone: '+919876500001', amount_due: 12000, promised_amount: 6000, promised_date: '2026-10-25' },
    template: { id: TPL, key: 'fees_reminder', meta_name: 'vec_fees_reminder', language: 'en', category: 'utility',
      body: 'Hello {{1}}, your fee of {{2}} is due. Thank you.', param_sources: ['lead_name', 'amount_due'] },
    account: { phone_number_id: '1234567890', token_source: 'stored' },
    token_cipher: await W.encryptToken('EAAtesttokenvalue1234567890', KEY),
  }, extra || {});
}

// ---------- shared helpers ----------

test('rupees and dates read the Indian way', async () => {
  const W = await load('_shared/whatsapp.mjs');
  assert.strictEqual(W.rupees(1200000), '₹12,00,000');
  assert.strictEqual(W.rupees(500), '₹500');
  assert.strictEqual(W.dayText('2026-10-25'), '25 Oct 2026');
  assert.strictEqual(W.dayText('nope'), '');
  assert.strictEqual(W.waNumber('+919876500001'), '919876500001');
  assert.strictEqual(W.waNumber('12345'), '');
  assert.strictEqual(W.indiaToday(new Date('2026-10-23T20:00:00Z')), '2026-10-24');   // 1:30 am in India
  assert.strictEqual(W.mondayOf('2026-10-25'), '2026-10-19');
  assert.strictEqual(W.mondayOf('2026-10-19'), '2026-10-19');
});

test('blanks are counted like the database does', async () => {
  const W = await load('_shared/whatsapp.mjs');
  assert.strictEqual(W.countBlanks('Hi {{1}}, pay {{2}}.'), 2);
  assert.strictEqual(W.countBlanks('Hi {{1}}, pay {{3}}.'), -1);
  assert.strictEqual(W.countBlanks('Hi {{ name }}.'), -1);
  assert.strictEqual(W.countBlanks('Hello.'), 0);
});

test('a template is filled from the lead, with amounts masked for the log', async () => {
  const W = await load('_shared/whatsapp.mjs');
  const ctx = await prepared(W);
  const out = W.fillParams(ctx.template, ctx);
  assert.deepStrictEqual(out.params, ['Asha', '₹12,000']);
  assert.deepStrictEqual(out.masked, ['Asha', '₹…']);
  assert.strictEqual(W.render(ctx.template.body, out.masked), 'Hello Asha, your fee of ₹… is due. Thank you.');
});

test('typed blanks: array or object, cleaned, no links, required', async () => {
  const W = await load('_shared/whatsapp.mjs');
  const t = { param_sources: ['lead_name', 'promised_date', 'typed'] };
  const ctx = { lead: { name: 'Asha', promised_date: '2026-10-25' } };
  assert.deepStrictEqual(W.fillParams(t, ctx, ['', '', 'Monday\n  morning']).params, ['Asha', '25 Oct 2026', 'Monday morning']);
  assert.deepStrictEqual(W.fillParams(t, ctx, { 3: 'Monday' }).params, ['Asha', '25 Oct 2026', 'Monday']);
  assert.match(W.fillParams(t, ctx, []).error, /Fill in blank 3/);
  assert.match(W.fillParams(t, ctx, ['', '', 'see https://x.test']).error, /Links/);
  assert.match(W.fillParams({ param_sources: ['amount_due'] }, { lead: {} }).error, /no amount due/);
});

test('STOP in English, Hinglish and Hindi; not every mention of stop', async () => {
  const W = await load('_shared/whatsapp.mjs');
  ['STOP', 'stop.', 'Stop!!', 'pls stop', 'Unsubscribe', 'band karo', 'Band kar do 🙏', 'message mat bhejo', 'ab band karo bhai',
    'बंद करो', 'मत भेजो', 'स्टॉप', 'whatsapp band karo'].forEach((m) => assert.ok(W.isStopMessage(m), m));
  ['ok', 'I will pay on Monday', 'Please do not stop my admission, I will pay the fees next week', 'bus stop ke paas hai institute kya'
  ].forEach((m) => assert.ok(!W.isStopMessage(m), m));
});

test('tokens are encrypted with AES-GCM and never stored in plain', async () => {
  const W = await load('_shared/whatsapp.mjs');
  const c1 = await W.encryptToken('EAAsecret-token', KEY);
  const c2 = await W.encryptToken('EAAsecret-token', KEY);
  assert.match(c1, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.notStrictEqual(c1, c2, 'a new IV each time');
  assert.ok(!c1.includes('EAAsecret'));
  assert.strictEqual(await W.decryptToken(c1, KEY), 'EAAsecret-token');
  await assert.rejects(W.decryptToken(c1, Buffer.alloc(32, 8).toString('base64')));
  await assert.rejects(W.encryptToken('x', 'short'), /32 bytes/);
});

test('webhook signatures: right secret only', async () => {
  const W = await load('_shared/whatsapp.mjs');
  const body = '{"entry":[]}';
  const sig = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
  assert.strictEqual(await W.verifySignature(body, sig, APP_SECRET), true);
  assert.strictEqual(await W.verifySignature(body + ' ', sig, APP_SECRET), false);
  assert.strictEqual(await W.verifySignature(body, sig, 'other'), false);
  assert.strictEqual(await W.verifySignature(body, 'sha256=zz', APP_SECRET), false);
  assert.strictEqual(await W.verifySignature(body, '', APP_SECRET), false);
  assert.strictEqual(W.sameSecret('abc', 'abc'), true);
  assert.strictEqual(W.sameSecret('abc', 'abd'), false);
  assert.strictEqual(W.sameSecret('', ''), false);
});

test('Meta errors become plain sentences', async () => {
  const W = await load('_shared/whatsapp.mjs');
  assert.match(W.metaErrorText({ code: 190 }, 401), /access token/);
  assert.match(W.metaErrorText({ code: 131026 }, 400), /not on WhatsApp/);
  assert.match(W.metaErrorText({ code: 1, message: 'odd' }, 400), /WhatsApp said: odd/);
});

// ---------- whatsapp-send ----------

async function sendDeps(rpcAnswers, graphHandlers) {
  const W = await load('_shared/whatsapp.mjs');
  const ctx = await prepared(W);
  const rpc = fakeRpc(Object.assign({ wa_prepare_send: ctx, wa_mark_message: null, wa_account_error: null }, rpcAnswers || {}));
  const f = fakeFetch(graphHandlers || [[/\/1234567890\/messages$/, [200, { messages: [{ id: 'wamid.SENT' }] }]]]);
  return { env: { WHATSAPP_TOKEN_KEY: KEY }, fetch: f, rpc, userId: async (h) => (h === 'Bearer good' ? 'user-1' : null) };
}

test('send: a signed-in caller sends an approved template', async () => {
  const { handle } = await load('whatsapp-send/logic.mjs');
  const deps = await sendDeps();
  const res = await handle(post('https://x/functions/v1/whatsapp-send', { lead_id: LEAD, template_key: 'fees_reminder' }, { Authorization: 'Bearer good' }), deps);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, message_id: 'm-1' });
  assert.deepStrictEqual(deps.rpc.called('wa_prepare_send')[0].args, { p_user: 'user-1', p_lead: LEAD, p_template_key: 'fees_reminder' });
  const call = deps.fetch.calls[0];
  assert.strictEqual(call.url, 'https://graph.facebook.com/v23.0/1234567890/messages');
  assert.strictEqual(call.auth, 'Bearer EAAtesttokenvalue1234567890');
  assert.strictEqual(call.body.to, '919876500001');
  assert.strictEqual(call.body.template.name, 'vec_fees_reminder');
  assert.deepStrictEqual(call.body.template.components[0].parameters.map((p) => p.text), ['Asha', '₹12,000']);
  const mark = deps.rpc.called('wa_mark_message')[0].args;
  assert.strictEqual(mark.p_status, 'sent');
  assert.strictEqual(mark.p_meta_id, 'wamid.SENT');
  assert.strictEqual(mark.p_body, 'Hello Asha, your fee of ₹… is due. Thank you.');
});

test('send: no login, bad input and database refusals', async () => {
  const { handle } = await load('whatsapp-send/logic.mjs');
  const deps = await sendDeps();
  let res = await handle(post('https://x/f', { lead_id: LEAD, template_key: 'fees_reminder' }), deps);
  assert.strictEqual(res.status, 401);
  res = await handle(post('https://x/f', { lead_id: LEAD, template_key: 'fees_reminder' }, { Authorization: 'Bearer bad' }), deps);
  assert.strictEqual(res.status, 401);
  res = await handle(post('https://x/f', { lead_id: 'nope', template_key: 'fees_reminder' }, { Authorization: 'Bearer good' }), deps);
  assert.strictEqual(res.status, 400);
  res = await handle(post('https://x/f', 'not json', { Authorization: 'Bearer good' }), deps);
  assert.strictEqual(res.status, 400);
  res = await handle(new Request('https://x/f', { method: 'GET' }), deps);
  assert.strictEqual(res.status, 405);
  const refused = await sendDeps({ wa_prepare_send: dbError('22023', 'this person has not agreed to WhatsApp messages') });
  res = await handle(post('https://x/f', { lead_id: LEAD, template_key: 'fees_reminder' }, { Authorization: 'Bearer good' }), refused);
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(await res.json(), { error: 'This person has not agreed to WhatsApp messages.' });
  assert.strictEqual(refused.fetch.calls.length, 0, 'nothing goes to Meta');
  const notMine = await sendDeps({ wa_prepare_send: dbError('42501', 'this lead is not assigned to you') });
  res = await handle(post('https://x/f', { lead_id: LEAD, template_key: 'fees_reminder' }, { Authorization: 'Bearer good' }), notMine);
  assert.strictEqual(res.status, 403);
  const broken = await sendDeps({ wa_prepare_send: dbError('XX000', 'boom with internals') });
  res = await handle(post('https://x/f', { lead_id: LEAD, template_key: 'fees_reminder' }, { Authorization: 'Bearer good' }), broken);
  assert.strictEqual(res.status, 500);
  assert.ok(!(await res.text()).includes('internals'));
});

test('send: a Meta failure is logged as failed; a bad token marks the account', async () => {
  const { handle } = await load('whatsapp-send/logic.mjs');
  let deps = await sendDeps({}, [[/messages$/, [400, { error: { code: 131026, message: 'undeliverable' } }]]]);
  let res = await handle(post('https://x/f', { lead_id: LEAD, template_key: 'fees_reminder' }, { Authorization: 'Bearer good' }), deps);
  assert.strictEqual(res.status, 502);
  assert.match((await res.json()).error, /not on WhatsApp/);
  assert.strictEqual(deps.rpc.called('wa_mark_message')[0].args.p_status, 'failed');
  assert.strictEqual(deps.rpc.called('wa_account_error').length, 0);
  deps = await sendDeps({}, [[/messages$/, [401, { error: { code: 190, message: 'expired' } }]]]);
  res = await handle(post('https://x/f', { lead_id: LEAD, template_key: 'fees_reminder' }, { Authorization: 'Bearer good' }), deps);
  assert.strictEqual(res.status, 502);
  assert.strictEqual(deps.rpc.called('wa_account_error').length, 1);
});

test('send: a missing value fails before Meta is called', async () => {
  const { handle } = await load('whatsapp-send/logic.mjs');
  const W = await load('_shared/whatsapp.mjs');
  const ctx = await prepared(W);
  ctx.lead.amount_due = null;
  const deps = await sendDeps({ wa_prepare_send: ctx });
  const res = await handle(post('https://x/f', { lead_id: LEAD, template_key: 'fees_reminder' }, { Authorization: 'Bearer good' }), deps);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(deps.fetch.calls.length, 0);
  assert.strictEqual(deps.rpc.called('wa_mark_message')[0].args.p_status, 'failed');
});

// ---------- whatsapp-webhook ----------

function signed(body, secret) {
  const raw = JSON.stringify(body);
  return post('https://x/functions/v1/whatsapp-webhook', raw,
    { 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', secret || APP_SECRET).update(raw).digest('hex') });
}
const webhookEnv = { WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me-please' };

test('webhook: GET verify answers the challenge only with the right token', async () => {
  const { handle } = await load('whatsapp-webhook/logic.mjs');
  const deps = { env: webhookEnv, rpc: fakeRpc({}) };
  let res = await handle(new Request('https://x/w?hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=4242'), deps);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), '4242');
  res = await handle(new Request('https://x/w?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242'), deps);
  assert.strictEqual(res.status, 403);
});

test('webhook: a bad signature is refused before anything is stored', async () => {
  const { handle } = await load('whatsapp-webhook/logic.mjs');
  const rpc = fakeRpc({});
  let res = await handle(signed({ entry: [] }, 'not-the-secret'), { env: webhookEnv, rpc });
  assert.strictEqual(res.status, 401);
  res = await handle(post('https://x/w', '{"entry":[]}'), { env: webhookEnv, rpc });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(rpc.calls.length, 0);
  res = await handle(signed({ entry: [] }), { env: {}, rpc });
  assert.strictEqual(res.status, 500, 'no app secret configured');
});

test('webhook: statuses, replies, STOP and template updates are stored', async () => {
  const { handle, parsePayload } = await load('whatsapp-webhook/logic.mjs');
  const payload = { object: 'whatsapp_business_account', entry: [
    { id: '555', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' },
      statuses: [
        { id: 'wamid.A', status: 'delivered', timestamp: '1792000000' },
        { id: 'wamid.B', status: 'failed', timestamp: '1792000001', errors: [{ code: 131026, title: 'Message undeliverable' }] },
        { id: 'wamid.C', status: 'deleted' },
      ],
      messages: [
        { from: '919876500001', id: 'wamid.IN1', timestamp: '1792000002', type: 'text', text: { body: 'Band karo' } },
        { from: '919876500002', id: 'wamid.IN2', timestamp: '1792000003', type: 'button', button: { text: 'Yes, I will pay' } },
        { from: '919876500003', id: 'wamid.IN3', type: 'image', image: { id: 'x' } },
      ] } }] },
    { id: '555', changes: [{ field: 'message_template_status_update', value: {
      event: 'APPROVED', message_template_id: 777, message_template_name: 'vec_fees_reminder', message_template_language: 'en', reason: 'NONE' } }] },
  ] };
  const parsed = parsePayload(payload);
  assert.strictEqual(parsed.replies[2].text, '[image]');
  const rpc = fakeRpc({ wa_status_update: true, wa_store_reply: { stored: true }, wa_template_status: 1 });
  const res = await handle(signed(payload), { env: webhookEnv, rpc });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).done, { statuses: 2, replies: 3, stops: 1, templates: 1 });
  const st = rpc.called('wa_status_update');
  assert.strictEqual(st[1].args.p_error, 'Message undeliverable');
  assert.strictEqual(st[0].args.p_at, new Date(1792000000 * 1000).toISOString());
  const replies = rpc.called('wa_store_reply');
  assert.deepStrictEqual(replies.map((r) => r.args.p_is_stop), [true, false, false]);
  assert.strictEqual(replies[0].args.p_phone_number_id, '1234567890');
  assert.strictEqual(replies[1].args.p_body, 'Yes, I will pay');
  assert.deepStrictEqual(rpc.called('wa_template_status')[0].args, {
    p_template: null, p_waba_id: '555', p_meta_name: 'vec_fees_reminder', p_meta_template_id: '777', p_status: 'APPROVED', p_reason: 'NONE' });
});

test('webhook: a database failure asks Meta to send it again', async () => {
  const { handle } = await load('whatsapp-webhook/logic.mjs');
  const rpc = fakeRpc({ wa_status_update: dbError('08006', 'connection lost') });
  const res = await handle(signed({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1' },
    statuses: [{ id: 'wamid.A', status: 'read' }] } }] }] }), { env: webhookEnv, rpc });
  assert.strictEqual(res.status, 500);
});

// ---------- whatsapp-reminders ----------

test('reminders: needs the cron secret', async () => {
  const { handle } = await load('whatsapp-reminders/logic.mjs');
  const rpc = fakeRpc({});
  let res = await handle(post('https://x/r', {}), { env: { WHATSAPP_CRON_SECRET: 'cron-secret-123' }, rpc });
  assert.strictEqual(res.status, 401);
  res = await handle(post('https://x/r', {}, { 'x-cron-secret': 'nope' }), { env: { WHATSAPP_CRON_SECRET: 'cron-secret-123' }, rpc });
  assert.strictEqual(res.status, 401);
  res = await handle(post('https://x/r', {}, { 'x-cron-secret': 'x' }), { env: {}, rpc });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(rpc.calls.length, 0);
});

test('reminders: each claimed reminder is sent once and logged; a weekday has no brief', async () => {
  const { handle } = await load('whatsapp-reminders/logic.mjs');
  const W = await load('_shared/whatsapp.mjs');
  const promise = { key: 'promise_due', meta_name: 'vec_promise_due', language: 'en', category: 'utility',
    body: 'Hello {{1}}, your payment of {{2}} is due on {{3}}. Thank you.', param_sources: ['lead_name', 'promised_amount', 'promised_date'] };
  const a = await prepared(W, { message_id: 'r-1', template: promise });
  const b = await prepared(W, { message_id: 'r-2', template: promise, lead: { id: LEAD, name: 'Bina', phone: '+919876500003', promised_amount: null, promised_date: '2026-10-25' } });
  const rpc = fakeRpc({ wa_claim_reminders: [a, b], wa_mark_message: null });
  const f = fakeFetch([[/messages$/, [200, { messages: [{ id: 'wamid.R' }] }]]]);
  const res = await handle(post('https://x/r', { today: '2026-10-24' }, { 'x-cron-secret': 'cron-secret-123' }),
    { env: { WHATSAPP_CRON_SECRET: 'cron-secret-123', WHATSAPP_TOKEN_KEY: KEY }, fetch: f, rpc });
  const out = await res.json();
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(out.reminders, { claimed: 2, sent: 1, failed: 1 });
  assert.strictEqual(out.brief, null, 'Saturday: no brief');
  assert.deepStrictEqual(rpc.called('wa_claim_reminders')[0].args, { p_today: '2026-10-24', p_limit: 500 });
  assert.strictEqual(f.calls.length, 1, 'the one without a promised amount is not sent');
  assert.deepStrictEqual(f.calls[0].body.template.components[0].parameters.map((p) => p.text), ['Asha', '₹6,000', '25 Oct 2026']);
  assert.deepStrictEqual(rpc.called('wa_mark_message').map((c) => c.args.p_status).sort(), ['failed', 'sent']);
  assert.strictEqual(rpc.called('wa_mark_message').find((c) => c.args.p_status === 'sent').args.p_body,
    'Hello Asha, your payment of ₹… is due on 25 Oct 2026. Thank you.');
});

test('brief: Monday sends admin_weekly_brief lines to opted-in owners, with no money in the log', async () => {
  const { handle, briefLines, briefParams } = await load('whatsapp-reminders/logic.mjs');
  assert.deepStrictEqual(briefLines([{ line: 'A' }, 'B', { admin_weekly_brief: ['C', 'D'] }, { n: 3 }]), ['A', 'B', 'C', 'D']);
  const tpl = { param_sources: ['typed', 'typed'] };
  assert.deepStrictEqual(briefParams(tpl, 'Fees Oct', ['x', 'y']), ['Fees Oct', 'x · y']);
  const one = briefParams({ param_sources: ['institute_name', 'typed'] }, 'Fees Oct', ['x']);
  assert.strictEqual(one.length, 2);
  assert.strictEqual(one[1], 'Fees Oct: x', 'one typed blank holds the campaign and the lines');
  const W = await load('_shared/whatsapp.mjs');
  const brief = {
    message_id: 'b-1', institute_id: 'inst-1', institute_name: 'Sunrise', phone: '+919876511111', campaign_name: 'Fees Oct',
    lines: ['Calls: 120 this week.', 'Collected ₹2.1L, reported by callers.'],
    template: { key: 'weekly_brief', meta_name: 'vec_weekly_brief', language: 'en', category: 'utility',
      body: 'Your Vector week for {{1}}: {{2}} Open Vector for details.', param_sources: ['typed', 'typed'] },
    account: { phone_number_id: '1234567890', token_source: 'platform' }, token_cipher: null,
  };
  const rpc = fakeRpc({ wa_claim_reminders: [], wa_brief_available: true, wa_claim_briefs: [brief], wa_mark_message: null });
  const f = fakeFetch([[/messages$/, [200, { messages: [{ id: 'wamid.B' }] }]]]);
  const res = await handle(post('https://x/r', { today: '2026-10-26' }, { 'x-cron-secret': 'cron-secret-123' }),
    { env: { WHATSAPP_CRON_SECRET: 'cron-secret-123', WHATSAPP_PLATFORM_TOKEN: 'EAAplatformtoken12345678' }, fetch: f, rpc });
  const out = await res.json();
  assert.deepStrictEqual(out.brief, { available: true, claimed: 1, sent: 1, failed: 0 });
  assert.deepStrictEqual(rpc.called('wa_claim_briefs')[0].args, { p_week: '2026-10-26' });
  assert.strictEqual(f.calls[0].body.to, '919876511111');
  assert.strictEqual(f.calls[0].auth, 'Bearer EAAplatformtoken12345678');
  assert.deepStrictEqual(f.calls[0].body.template.components[0].parameters.map((p) => p.text),
    ['Fees Oct', 'Calls: 120 this week. · Collected ₹2.1L, reported by callers.']);
  assert.strictEqual(rpc.called('wa_mark_message')[0].args.p_body, 'Weekly brief: Fees Oct');
});

test('brief: skipped when admin_weekly_brief is not in the database', async () => {
  const { handle } = await load('whatsapp-reminders/logic.mjs');
  const rpc = fakeRpc({ wa_brief_available: false });
  const res = await handle(post('https://x/r', { job: 'brief', today: '2026-10-24' }, { 'x-cron-secret': 'cron-secret-123' }),
    { env: { WHATSAPP_CRON_SECRET: 'cron-secret-123' }, fetch: fakeFetch([]), rpc });
  const out = await res.json();
  assert.deepStrictEqual(out.brief, { available: false, claimed: 0, sent: 0, failed: 0 });
  assert.strictEqual(out.reminders, null);
  assert.strictEqual(rpc.called('wa_claim_briefs').length, 0);
});

// ---------- whatsapp-admin ----------

async function adminDeps(ctx, rpcAnswers, graphHandlers, env) {
  const rpc = fakeRpc(Object.assign({ wa_admin_context: ctx, wa_connect: null, wa_disconnect: null, wa_template_status: 1, wa_account_error: null }, rpcAnswers || {}));
  return { env: Object.assign({ WHATSAPP_TOKEN_KEY: KEY }, env || {}), fetch: fakeFetch(graphHandlers || []), rpc,
    userId: async (h) => (h === 'Bearer good' ? 'owner-1' : null) };
}
const ownerCtx = { institute_id: 'inst-1', seat_id: 's-1', is_owner: true, account: null, token_cipher: null };
const connectGraph = [
  [/\/1234567890\?fields=/, [200, { display_phone_number: '+91 98765 00000', verified_name: 'Sunrise Academy' }]],
  [/\/5550001\/phone_numbers/, [200, { data: [{ id: '1234567890' }] }]],
  [/\/5550001\/subscribed_apps/, [200, { success: true }]],
];
const asOwner = (body) => post('https://x/a', body, { Authorization: 'Bearer good' });

test('admin: the owner connects; the token is checked with Meta and stored encrypted', async () => {
  const { handle } = await load('whatsapp-admin/logic.mjs');
  const W = await load('_shared/whatsapp.mjs');
  const deps = await adminDeps(ownerCtx, {}, connectGraph);
  const res = await handle(asOwner({ action: 'connect', phone_number_id: '1234567890', waba_id: '5550001',
    display_name: 'Sunrise Academy', access_token: 'EAAtesttokenvalue1234567890' }), deps);
  const out = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(out));
  assert.strictEqual(out.display_phone, '+91 98765 00000');
  assert.strictEqual(out.warning, null);
  assert.ok(!JSON.stringify(out).includes('EAAtest'), 'the token is never sent back');
  const args = deps.rpc.called('wa_connect')[0].args;
  assert.strictEqual(args.p_user, 'owner-1');
  assert.strictEqual(args.p_token_source, 'stored');
  assert.ok(!args.p_token_cipher.includes('EAAtest'));
  assert.strictEqual(await W.decryptToken(args.p_token_cipher, KEY), 'EAAtesttokenvalue1234567890');
  assert.ok(deps.fetch.calls.every((c) => c.auth === 'Bearer EAAtesttokenvalue1234567890'));
});

test('admin: connect refusals', async () => {
  const { handle } = await load('whatsapp-admin/logic.mjs');
  let deps = await adminDeps(Object.assign({}, ownerCtx, { is_owner: false }), {}, connectGraph);
  let res = await handle(asOwner({ action: 'connect', phone_number_id: '1234567890', waba_id: '5550001', display_name: 'S', access_token: 'EAAtesttokenvalue1234567890' }), deps);
  assert.strictEqual(res.status, 403, 'a manager');
  deps = await adminDeps(ownerCtx, {}, connectGraph);
  res = await handle(asOwner({ action: 'connect', phone_number_id: 'abc', waba_id: '5550001', display_name: 'S', access_token: 'EAAtesttokenvalue1234567890' }), deps);
  assert.strictEqual(res.status, 400);
  res = await handle(asOwner({ action: 'connect', phone_number_id: '1234567890', waba_id: '5550001', display_name: 'S' }), deps);
  assert.match((await res.json()).error, /Paste the access token/);
  deps = await adminDeps(ownerCtx, {}, [[/\/1234567890\?fields=/, [401, { error: { code: 190, message: 'bad' } }]]]);
  res = await handle(asOwner({ action: 'connect', phone_number_id: '1234567890', waba_id: '5550001', display_name: 'S', access_token: 'EAAtesttokenvalue1234567890' }), deps);
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /access token/);
  assert.strictEqual(deps.rpc.called('wa_connect').length, 0);
  deps = await adminDeps(ownerCtx, {}, [connectGraph[0], [/phone_numbers/, [200, { data: [{ id: '42' }] }]]]);
  res = await handle(asOwner({ action: 'connect', phone_number_id: '1234567890', waba_id: '5550001', display_name: 'S', access_token: 'EAAtesttokenvalue1234567890' }), deps);
  assert.match((await res.json()).error, /not in that WhatsApp Business Account/);
  deps = await adminDeps(ownerCtx, {}, connectGraph, { WHATSAPP_TOKEN_KEY: '' });
  res = await handle(asOwner({ action: 'connect', phone_number_id: '1234567890', waba_id: '5550001', display_name: 'S', access_token: 'EAAtesttokenvalue1234567890' }), deps);
  assert.strictEqual(res.status, 500, 'no encryption key on the server');
});

test('admin: reconnect keeps the stored token; a failed webhook subscription is a warning', async () => {
  const { handle } = await load('whatsapp-admin/logic.mjs');
  const W = await load('_shared/whatsapp.mjs');
  const ctx = Object.assign({}, ownerCtx, { account: { status: 'connected', token_source: 'stored', waba_id: '5550001' },
    token_cipher: await W.encryptToken('EAAoldtokenvalue12345678901', KEY) });
  const deps = await adminDeps(ctx, {}, [connectGraph[0], connectGraph[1], [/subscribed_apps/, [400, { error: { code: 200, message: 'no permission' } }]]]);
  const res = await handle(asOwner({ action: 'connect', phone_number_id: '1234567890', waba_id: '5550001', display_name: 'New name' }), deps);
  const out = await res.json();
  assert.strictEqual(res.status, 200);
  assert.match(out.warning, /delivery updates/);
  assert.strictEqual(deps.rpc.called('wa_connect')[0].args.p_token_cipher, null);
  assert.strictEqual(deps.fetch.calls[0].auth, 'Bearer EAAoldtokenvalue12345678901');
});

test('admin: submit a template for approval, edit an approved one, read statuses', async () => {
  const { handle } = await load('whatsapp-admin/logic.mjs');
  const W = await load('_shared/whatsapp.mjs');
  const ctx = Object.assign({}, ownerCtx, { account: { status: 'connected', token_source: 'stored', waba_id: '5550001', display_name: 'Sunrise' },
    token_cipher: await W.encryptToken('EAAtesttokenvalue1234567890', KEY) });
  const tpl = { id: TPL, key: 'fees_reminder', meta_name: 'vec_fees_reminder', language: 'en', category: 'utility',
    body: 'Hello {{1}}, your fee of {{2}} is due. Thank you.', param_sources: ['lead_name', 'amount_due'], meta_template_id: null };
  let deps = await adminDeps(ctx, { wa_template_for_admin: tpl }, [[/\/5550001\/message_templates$/, [200, { id: '777', status: 'PENDING', category: 'UTILITY' }]]]);
  let res = await handle(asOwner({ action: 'submit_template', template_id: TPL }), deps);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, status: 'pending', note: null });
  const sent = deps.fetch.calls[0].body;
  assert.strictEqual(sent.name, 'vec_fees_reminder');
  assert.strictEqual(sent.category, 'UTILITY');
  assert.deepStrictEqual(sent.components[0].example.body_text, [['Asha', '₹12,000']]);
  assert.deepStrictEqual(deps.rpc.called('wa_template_status')[0].args,
    { p_template: TPL, p_waba_id: null, p_meta_name: null, p_meta_template_id: '777', p_status: 'PENDING', p_reason: null });

  deps = await adminDeps(ctx, { wa_template_for_admin: Object.assign({}, tpl, { meta_template_id: '777' }) }, [[/\/777$/, [200, { success: true }]]]);
  res = await handle(asOwner({ action: 'submit_template', template_id: TPL }), deps);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(deps.fetch.calls[0].url, 'https://graph.facebook.com/v23.0/777');
  assert.strictEqual(deps.fetch.calls[0].body.category, undefined, 'an edit keeps its category');

  deps = await adminDeps(ctx, {}, [[/message_templates\?fields=/, [200, { data: [
    { id: '777', name: 'vec_fees_reminder', status: 'APPROVED' }, { id: '778', name: 'someone_elses', status: 'APPROVED' },
    { id: '779', name: 'vec_course_details', status: 'REJECTED', rejected_reason: 'PROMOTIONAL' }] }]]]);
  res = await handle(asOwner({ action: 'refresh_templates' }), deps);
  assert.deepStrictEqual(await res.json(), { ok: true, updated: 2 });
  assert.deepStrictEqual(deps.rpc.called('wa_template_status').map((c) => c.args.p_meta_name), ['vec_fees_reminder', 'vec_course_details']);
});

test('admin: submit needs a connected number; disconnect and unknown actions', async () => {
  const { handle } = await load('whatsapp-admin/logic.mjs');
  let deps = await adminDeps(ownerCtx);
  let res = await handle(asOwner({ action: 'submit_template', template_id: TPL }), deps);
  assert.match((await res.json()).error, /Connect your WhatsApp number first/);
  res = await handle(asOwner({ action: 'disconnect' }), deps);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(deps.rpc.called('wa_disconnect')[0].args, { p_user: 'owner-1' });
  deps = await adminDeps(ownerCtx, { wa_disconnect: dbError('42501', 'only an owner can disconnect WhatsApp') });
  res = await handle(asOwner({ action: 'disconnect' }), deps);
  assert.strictEqual(res.status, 403);
  res = await handle(asOwner({ action: 'explode' }), deps);
  assert.strictEqual(res.status, 400);
  res = await handle(post('https://x/a', { action: 'disconnect' }), deps);
  assert.strictEqual(res.status, 401);
});

test('deps: the service client is used for RPCs and login checks', async () => {
  const { makeDeps } = await load('_shared/deps.mjs');
  const seen = [];
  const createClient = (url, key) => ({
    rpc: async (name, args) => { seen.push([url, key, name, args]); return name === 'bad' ? { data: null, error: { code: '42501', message: 'no' } } : { data: 7, error: null }; },
    auth: { getUser: async (t) => (t === 'tok' ? { data: { user: { id: 'u-1' } }, error: null } : { data: null, error: { message: 'bad jwt' } }) },
  });
  const deps = makeDeps(createClient, { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' });
  assert.strictEqual(await deps.rpc('ok', { a: 1 }), 7);
  await assert.rejects(deps.rpc('bad', {}), (e) => e.code === '42501');
  assert.strictEqual(await deps.userId('Bearer tok'), 'u-1');
  assert.strictEqual(await deps.userId('Bearer nope'), null);
  assert.deepStrictEqual(seen[0], ['https://p.supabase.co', 'svc', 'ok', { a: 1 }]);
});

test('the Edge Function wrappers stay thin and print no secrets', async () => {
  const fs = require('node:fs');
  for (const name of ['whatsapp-send', 'whatsapp-webhook', 'whatsapp-reminders', 'whatsapp-admin']) {
    const ts = fs.readFileSync(path.join(fn, name, 'index.ts'), 'utf8');
    assert.ok(ts.includes('import { handle } from "./logic.mjs"'), name);
    assert.ok(ts.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length <= 8, name + ' is a thin wrapper');
  }
  for (const f of ['_shared/whatsapp.mjs', '_shared/deps.mjs', 'whatsapp-send/logic.mjs', 'whatsapp-webhook/logic.mjs', 'whatsapp-reminders/logic.mjs', 'whatsapp-admin/logic.mjs']) {
    const src = fs.readFileSync(path.join(fn, f), 'utf8');
    assert.ok(!/console\.(log|error)\([^)]*(token|secret|SERVICE_ROLE)[^)]*\)/i.test(src.replace(/console\.error\('[^']*'/g, '')), f + ' logs no secret values');
  }
});
