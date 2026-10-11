'use strict';
/* Tests for web/js/supabase-client.js. No network: fetch and localStorage are stubbed.
   Run: node supabase/tests/supabase_client_test.js
   Prints "supabase_client_test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const path = require('path');
const VectorCloud = require(path.join(__dirname, '..', '..', 'web', 'js', 'supabase-client.js'));
const OutcomeQueue = require(path.join(__dirname, '..', '..', 'web', 'js', 'outcome-queue.js'));

const URL_BASE = 'https://proj.supabase.co';
const PUB = 'sb_publishable_TESTKEY';
const SESSION_KEY = 'vca-cloud-session';

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: value });
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m
  };
}

function fakeJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return enc({ alg: 'HS256', typ: 'JWT' }) + '.' + enc(payload) + '.c2lnbmF0dXJl';
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function jsonResponse(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status: status, text: async () => text };
}

let calls = [];
let responder = null;
let store = makeStorage();

defineGlobal('fetch', async (url, init) => {
  const call = {
    url: url,
    init: init || {},
    method: (init && init.method) || 'GET',
    headers: (init && init.headers) || {},
    body: init && init.body ? JSON.parse(init.body) : undefined
  };
  calls.push(call);
  const out = responder(call);
  if (out instanceof Error) throw out;
  return out;
});

function reset() {
  calls = [];
  responder = () => jsonResponse(200, []);
  store = makeStorage();
  defineGlobal('localStorage', store);
  VectorCloud.configure({ url: URL_BASE, publishableKey: PUB });
}

function setSession(s) { store.setItem(SESSION_KEY, JSON.stringify(s)); }
function freshSession(token, refresh) {
  return { access_token: token, refresh_token: refresh || 'R1', expires_at: nowSec() + 3600 };
}
function storedSession() {
  const raw = store.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

const OUTCOME = {
  clientRecordId: 'c-1',
  seatId: 's1',
  instituteId: 'i1',
  outcome: 'callback',
  scriptId: 'intro',
  scriptVersion: 2,
  scriptStep: 'ask',
  objection: 'price',
  dialledAt: '2026-10-12T09:30:00.000Z',
  connectedSeconds: 42,
  phoneSessionId: 'ph-1'
};

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('configure refuses a service_role key (checked in the JWT payload)', () => {
  assert.throws(() => VectorCloud.configure({ url: URL_BASE, publishableKey: fakeJwt({ role: 'service_role' }) }), /service_role/);
  assert.throws(() => VectorCloud.configure({ url: URL_BASE, publishableKey: 'sb_secret_abc' }), /service_role/);
});

test('configure accepts a publishable key and requires url and key over https', () => {
  assert.strictEqual(VectorCloud.configure({ url: URL_BASE + '/', publishableKey: fakeJwt({ role: 'anon' }) }), true);
  assert.throws(() => VectorCloud.configure({ publishableKey: PUB }), /url/);
  assert.throws(() => VectorCloud.configure({ url: URL_BASE }), /publishable key/);
  assert.throws(() => VectorCloud.configure({ url: 'http://proj.example.com', publishableKey: PUB }), /https/);
});

test('signIn posts the password grant and stores the session', async () => {
  responder = () => jsonResponse(200, { access_token: 'A1', refresh_token: 'R1', expires_in: 3600, user: { id: 'u1' } });
  const r = await VectorCloud.signIn(' rep@example.com ', 'pw');
  assert.strictEqual(r.user.id, 'u1');
  const c = calls[0];
  assert.strictEqual(c.url, URL_BASE + '/auth/v1/token?grant_type=password');
  assert.strictEqual(c.method, 'POST');
  assert.strictEqual(c.headers.apikey, PUB);
  assert.deepStrictEqual(c.body, { email: 'rep@example.com', password: 'pw' });
  const s = storedSession();
  assert.strictEqual(s.access_token, 'A1');
  assert.strictEqual(s.refresh_token, 'R1');
  assert.ok(s.expires_at >= nowSec() + 3590 && s.expires_at <= nowSec() + 3610);
  assert.ok(!store.getItem(SESSION_KEY).includes(PUB), 'the publishable key must not be stored');
});

test('signIn reports the server message and stores nothing on failure', async () => {
  responder = () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
  await assert.rejects(VectorCloud.signIn('a@b.c', 'x'), /Invalid login credentials/);
  assert.strictEqual(store.getItem(SESSION_KEY), null);
});

test('signOut clears the stored session', async () => {
  setSession(freshSession('A1'));
  assert.strictEqual(VectorCloud.isSignedIn(), true);
  await VectorCloud.signOut();
  assert.strictEqual(store.getItem(SESSION_KEY), null);
  assert.strictEqual(VectorCloud.isSignedIn(), false);
});

test('rpc sends apikey, the session token and the JSON body', async () => {
  setSession(freshSession('A1'));
  await VectorCloud.rpc('register_device', { p_seat: 's1', p_kind: 'phone', p_fingerprint: 'fp' });
  const c = calls[0];
  assert.strictEqual(c.url, URL_BASE + '/rest/v1/rpc/register_device');
  assert.strictEqual(c.method, 'POST');
  assert.strictEqual(c.headers.apikey, PUB);
  assert.strictEqual(c.headers.Authorization, 'Bearer A1');
  assert.strictEqual(c.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(c.body, { p_seat: 's1', p_kind: 'phone', p_fingerprint: 'fp' });
});

test('rpc falls back to the publishable key when signed out', async () => {
  await VectorCloud.rpc('claim_my_invite', {});
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer ' + PUB);
  assert.deepStrictEqual(calls[0].body, {});
});

test('claimMyInvite and registerDevice call their functions with the right arguments', async () => {
  setSession(freshSession('A1'));
  await VectorCloud.claimMyInvite();
  await VectorCloud.registerDevice('s9', 'tablet', 'fp9');
  assert.strictEqual(calls[0].url, URL_BASE + '/rest/v1/rpc/claim_my_invite');
  assert.strictEqual(calls[1].url, URL_BASE + '/rest/v1/rpc/register_device');
  assert.deepStrictEqual(calls[1].body, { p_seat: 's9', p_kind: 'tablet', p_fingerprint: 'fp9' });
});

test('mySeat reads the active seat and returns the first row', async () => {
  setSession(freshSession('A1'));
  responder = () => jsonResponse(200, [{ id: 's1', label: 'Rep 1', role: 'rep', status: 'active', institute_id: 'i1' }]);
  const seat = await VectorCloud.mySeat();
  assert.strictEqual(calls[0].method, 'GET');
  assert.strictEqual(calls[0].url, URL_BASE + '/rest/v1/seats?select=id,label,role,status,institute_id&status=eq.active');
  assert.strictEqual(seat.id, 's1');
});

test('uploadOutcome maps camelCase fields to the call_outcomes columns', async () => {
  setSession(freshSession('A1'));
  responder = () => jsonResponse(201);
  await VectorCloud.uploadOutcome(OUTCOME);
  const c = calls[0];
  assert.strictEqual(c.url, URL_BASE + '/rest/v1/call_outcomes');
  assert.strictEqual(c.method, 'POST');
  assert.strictEqual(c.headers.Prefer, 'return=minimal');
  assert.strictEqual(c.headers.Authorization, 'Bearer A1');
  assert.deepStrictEqual(c.body, {
    client_record_id: 'c-1',
    seat_id: 's1',
    institute_id: 'i1',
    outcome: 'callback',
    script_id: 'intro',
    script_version: 2,
    script_step: 'ask',
    objection: 'price',
    dialled_at: '2026-10-12T09:30:00.000Z',
    connected_seconds: 42,
    phone_session_id: 'ph-1'
  });
});

test('uploadOutcome treats 409 (duplicate) as success', async () => {
  setSession(freshSession('A1'));
  responder = () => jsonResponse(409, { code: '23505', message: 'duplicate key' });
  await VectorCloud.uploadOutcome(OUTCOME);
});

test('uploadOutcome throws a permanent error on 400 and 422', async () => {
  setSession(freshSession('A1'));
  for (const status of [400, 422]) {
    responder = () => jsonResponse(status, { message: 'check constraint violated' });
    await assert.rejects(VectorCloud.uploadOutcome(OUTCOME), (err) => {
      assert.strictEqual(err.permanent, true);
      assert.ok(/check constraint violated/.test(err.message));
      return true;
    });
  }
});

test('uploadOutcome throws a retryable error on 500', async () => {
  setSession(freshSession('A1'));
  responder = () => jsonResponse(500, { message: 'boom' });
  await assert.rejects(VectorCloud.uploadOutcome(OUTCOME), (err) => {
    assert.ok(err instanceof Error);
    assert.notStrictEqual(err.permanent, true);
    return true;
  });
});

test('uploadOutcome treats 408, 429 and network errors as retryable', async () => {
  setSession(freshSession('A1'));
  for (const status of [408, 429]) {
    responder = () => jsonResponse(status, { message: 'slow down' });
    await assert.rejects(VectorCloud.uploadOutcome(OUTCOME), (err) => err.permanent !== true);
  }
  responder = () => new TypeError('fetch failed');
  await assert.rejects(VectorCloud.uploadOutcome(OUTCOME), (err) => err.permanent !== true);
});

test('uploadOutcome refuses to send while signed out (retryable, not permanent)', async () => {
  await assert.rejects(VectorCloud.uploadOutcome(OUTCOME), (err) => err.permanent !== true && /Not signed in/.test(err.message));
  assert.strictEqual(calls.length, 0);
});

test('refreshIfNeeded refreshes only when the token is near expiry', async () => {
  setSession(freshSession('A1', 'R1'));
  await VectorCloud.refreshIfNeeded();
  assert.strictEqual(calls.length, 0, 'no refresh while the token has an hour left');

  setSession({ access_token: 'A1', refresh_token: 'R1', expires_at: nowSec() + 30 });
  responder = () => jsonResponse(200, { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 });
  const s = await VectorCloud.refreshIfNeeded();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, URL_BASE + '/auth/v1/token?grant_type=refresh_token');
  assert.deepStrictEqual(calls[0].body, { refresh_token: 'R1' });
  assert.strictEqual(s.access_token, 'A2');
  assert.strictEqual(storedSession().refresh_token, 'R2');

  await VectorCloud.refreshIfNeeded();
  assert.strictEqual(calls.length, 1, 'the new token is fresh, so no second refresh');
});

test('a rejected refresh clears the session and asks for sign-in', async () => {
  setSession({ access_token: 'A1', refresh_token: 'R1', expires_at: nowSec() + 5 });
  responder = () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Refresh Token Not Found' });
  await assert.rejects(VectorCloud.refreshIfNeeded(), /Sign in again/);
  assert.strictEqual(store.getItem(SESSION_KEY), null);
});

test('the session still works when localStorage is blocked', async () => {
  const blocked = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('SecurityError'); }
  };
  defineGlobal('localStorage', blocked);
  responder = () => jsonResponse(200, { access_token: 'A7', refresh_token: 'R7', expires_in: 3600 });
  await VectorCloud.signIn('a@b.c', 'pw');
  responder = () => jsonResponse(200, []);
  await VectorCloud.rpc('claim_my_invite', {});
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer A7');
  await VectorCloud.signOut();
  assert.strictEqual(VectorCloud.isSignedIn(), false);
});

test('uploader works with the outcome queue: 400 is rejected, 500 stays pending', async () => {
  setSession(freshSession('A1'));
  const q1 = OutcomeQueue.create(makeStorage(), VectorCloud.uploader);
  q1.add(OUTCOME);
  responder = () => jsonResponse(400, { message: 'bad row' });
  await q1.flush();
  assert.strictEqual(q1.status().rejected, 1);

  const q2 = OutcomeQueue.create(makeStorage(), VectorCloud.uploader);
  q2.add(Object.assign({}, OUTCOME, { clientRecordId: 'c-2' }));
  responder = () => jsonResponse(500, { message: 'down' });
  await q2.flush();
  assert.strictEqual(q2.status().pending, 1);
  assert.strictEqual(q2.status().rejected, 0);
});

test('uploader also accepts a queue item wrapper', async () => {
  setSession(freshSession('A1'));
  responder = () => jsonResponse(201);
  await VectorCloud.uploader({ outcome: OUTCOME, attempts: 0 });
  assert.strictEqual(calls[0].body.client_record_id, 'c-1');
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    reset();
    try {
      await t.fn();
      passed++;
      console.log('ok   - ' + t.name);
    } catch (e) {
      failed++;
      console.log('FAIL - ' + t.name + '\n       ' + (e && e.message));
    }
  }
  console.log('supabase_client_test: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
