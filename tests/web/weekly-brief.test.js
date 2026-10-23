'use strict';
/* Tests for supabase/functions/weekly-brief/logic.js (the Monday email), with fetch mocked: who may call it,
   the database calls, composing the email, the Resend sender, skipping when email is not set up, dry runs and
   failures. No network.
   Run: node --test tests/web/weekly-brief.test.js
   Prints "weekly-brief.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const root = path.join(__dirname, '..', '..');

const INST_A = '11111111-1111-4111-8111-111111111111';
const INST_B = '22222222-2222-4222-8222-222222222222';
const LINES = ['Fees Oct: 40 of 82 leads have a good result so far.', 'People pick up most on weekdays 7–9 pm (68%).',
  'No promises have come due yet.', 'Script one: v2 gets 3 more good results per 100 picked-up calls than v1.'];
const ENV = { SUPABASE_URL: 'https://proj.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'service-key-test',
  RESEND_API_KEY: 're_test_key', BRIEF_FROM_EMAIL: 'Vector <brief@example.in>', BRIEF_APP_URL: 'https://app.example.in/' };

// A fetch stand-in: the two RPCs and Resend. calls records every request.
function fakeFetch(opts) {
  const o = opts || {};
  const calls = [];
  async function f(url, init) {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers, body });
    const reply = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data), json: async () => data });
    if (url.endsWith('/rest/v1/rpc/weekly_brief_recipients')) {
      return reply(200, o.recipients || [
        { institute_id: INST_A, institute_name: 'Inst <A>', emails: ['owner1@a.in', 'owner2@a.in'] },
        { institute_id: INST_B, institute_name: 'Inst B', emails: ['owner@b.in', 'not-an-email'] },
        { institute_id: 'bad', institute_name: 'Bad', emails: ['x@y.in'] },
      ]);
    }
    if (url.endsWith('/rest/v1/rpc/weekly_brief_lines')) {
      if (o.failLinesFor === body.p_institute) return reply(400, { message: 'campaign not found' });
      return reply(200, LINES);
    }
    if (url === 'https://api.resend.com/emails') {
      if (o.failEmailTo && body.to[0] === o.failEmailTo) return reply(422, { name: 'validation_error', message: 'bad address' });
      return reply(200, { id: 'email-1' });
    }
    return reply(404, { message: 'no route' });
  }
  f.calls = calls;
  return f;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

(async () => {
  const L = await import(pathToFileURL(path.join(root, 'supabase', 'functions', 'weekly-brief', 'logic.js')).href);

  test('sameSecret compares whole strings', () => {
    assert.strictEqual(L.sameSecret('abc', 'abc'), true);
    assert.strictEqual(L.sameSecret('abc', 'abd'), false);
    assert.strictEqual(L.sameSecret('abc', 'abcd'), false);
    assert.strictEqual(L.sameSecret('', ''), false);
  });
  test('isAuthorised: service role bearer or the cron secret only', () => {
    assert.strictEqual(L.isAuthorised({ authorization: 'Bearer service-key-test' }, ENV), true);
    assert.strictEqual(L.isAuthorised(new Map([['authorization', 'Bearer service-key-test']]), ENV), true);
    assert.strictEqual(L.isAuthorised({ authorization: 'Bearer anon-key' }, ENV), false);
    assert.strictEqual(L.isAuthorised({}, ENV), false);
    assert.strictEqual(L.isAuthorised({ 'x-brief-secret': 'cron-secret' }, ENV), false, 'no secret configured');
    assert.strictEqual(L.isAuthorised({ 'x-brief-secret': 'cron-secret' }, Object.assign({}, ENV, { BRIEF_CRON_SECRET: 'cron-secret' })), true);
  });
  test('composeEmail: subject, numbered text, escaped HTML, link to Insights', () => {
    const m = L.composeEmail({ instituteName: 'Inst <A>', lines: LINES.concat(['', null]), appUrl: 'https://app.example.in/', today: new Date(Date.UTC(2026, 9, 26)) });
    assert.strictEqual(m.subject, 'Your week in 4 lines: Inst <A>, 26 Oct');
    assert.ok(m.text.includes('1. Fees Oct: 40 of 82'));
    assert.ok(m.text.includes('4. Script one'));
    assert.ok(!m.text.includes('5. '));
    assert.ok(m.text.includes('https://app.example.in/admin.html#insights'));
    assert.ok(m.html.includes('Inst &lt;A&gt;') && !m.html.includes('<A>'));
    assert.ok(m.html.includes('7–9 pm'));
    assert.ok(!/₹/.test(m.text), 'counts only');
  });
  test('createSender: Resend when key and sender are set; reports what is missing otherwise', () => {
    assert.strictEqual(L.createSender(ENV, fakeFetch()).configured, true);
    const off = L.createSender({}, fakeFetch());
    assert.strictEqual(off.configured, false);
    assert.deepStrictEqual(off.missing, ['RESEND_API_KEY', 'BRIEF_FROM_EMAIL']);
    const other = L.createSender({ BRIEF_EMAIL_PROVIDER: 'sendgrid' }, fakeFetch());
    assert.strictEqual(other.configured, false);
  });
  test('a run emails each owner, one email each, through Resend', async () => {
    const f = fakeFetch();
    const res = await L.handleRequest({ method: 'POST', headers: { authorization: 'Bearer service-key-test' }, body: {}, env: ENV, fetchImpl: f, log: () => {} });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { institutes: 2, emails: 3, sent: 3, skipped: 0, failed: 0, dryRun: false });
    const sends = f.calls.filter((c) => c.url === 'https://api.resend.com/emails');
    assert.deepStrictEqual(sends.map((c) => c.body.to[0]), ['owner1@a.in', 'owner2@a.in', 'owner@b.in']);
    assert.strictEqual(sends[0].headers.Authorization, 'Bearer re_test_key');
    assert.strictEqual(sends[0].body.from, 'Vector <brief@example.in>');
    const lineCalls = f.calls.filter((c) => c.url.endsWith('weekly_brief_lines'));
    assert.deepStrictEqual(lineCalls.map((c) => c.body), [
      { p_institute: INST_A, p_campaign: null, p_money: false }, { p_institute: INST_B, p_campaign: null, p_money: false }]);
    assert.strictEqual(lineCalls[0].url, 'https://proj.supabase.co/rest/v1/rpc/weekly_brief_lines');
    assert.strictEqual(lineCalls[0].headers.apikey, 'service-key-test');
  });
  test('without email settings the run skips sending and logs it, without secrets', async () => {
    const f = fakeFetch();
    const logs = [];
    const env = { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_SERVICE_ROLE_KEY };
    const res = await L.handleRequest({ method: 'POST', headers: { authorization: 'Bearer service-key-test' }, body: null, env, fetchImpl: f, log: (m) => logs.push(m) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, 0);
    assert.strictEqual(res.body.skipped, 3);
    assert.ok(logs.some((m) => /email is not set up \(RESEND_API_KEY, BRIEF_FROM_EMAIL\)/.test(m)), logs.join('\n'));
    assert.ok(!f.calls.some((c) => c.url.includes('resend')));
    assert.ok(!logs.join('\n').includes('service-key-test'));
  });
  test('dry run composes everything and sends nothing', async () => {
    const f = fakeFetch();
    const res = await L.handleRequest({ method: 'POST', headers: { authorization: 'Bearer service-key-test' }, body: { dry_run: true }, env: ENV, fetchImpl: f, log: () => {} });
    assert.strictEqual(res.body.dryRun, true);
    assert.strictEqual(res.body.sent, 0);
    assert.strictEqual(res.body.preview.length, 2);
    assert.strictEqual(res.body.preview[0].to, 2);
    assert.deepStrictEqual(res.body.preview[1].lines, LINES);
    assert.ok(!f.calls.some((c) => c.url.includes('resend')));
  });
  test('one institute failing does not stop the others; failed emails are counted', async () => {
    const f = fakeFetch({ failLinesFor: INST_A, failEmailTo: 'owner@b.in' });
    const logs = [];
    const res = await L.handleRequest({ method: 'POST', headers: { authorization: 'Bearer service-key-test' }, body: {}, env: ENV, fetchImpl: f, log: (m) => logs.push(m) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, 0);
    assert.strictEqual(res.body.failed, 3);
    assert.ok(logs.some((m) => m.includes('could not compose (campaign not found)')));
    assert.ok(logs.some((m) => m.includes('an email failed (email provider answered 422: bad address)')));
    assert.ok(!logs.join('\n').includes('@'), 'no email addresses in the log');
  });
  test('refuses other methods, strangers and a server without settings', async () => {
    const f = fakeFetch();
    assert.strictEqual((await L.handleRequest({ method: 'GET', headers: {}, env: ENV, fetchImpl: f })).status, 405);
    assert.strictEqual((await L.handleRequest({ method: 'POST', headers: { authorization: 'Bearer nope' }, env: ENV, fetchImpl: f })).status, 401);
    assert.strictEqual((await L.handleRequest({ method: 'POST', headers: {}, env: {}, fetchImpl: f, log: () => {} })).status, 500);
    assert.strictEqual(f.calls.length, 0);
  });
  test('a failing recipients call answers 500 with a plain message', async () => {
    const f = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ message: 'boom' }) });
    const res = await L.handleRequest({ method: 'POST', headers: { authorization: 'Bearer service-key-test' }, body: {}, env: ENV, fetchImpl: f, log: () => {} });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error, 'The weekly brief run failed. See the function log.');
  });

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + t.name + '\n  ' + e.message); }
  }
  console.log('weekly-brief.test: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
