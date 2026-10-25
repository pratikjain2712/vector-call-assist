const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../web/js/presence.js');

const NOW = Date.parse('2026-10-25T11:00:00+05:30');

test('dialling and connected come only from the paired phone', () => {
  assert.equal(P.callState({ paired: true, phase: 'REQUESTED', awaitingResult: true }), 'dialling');
  assert.equal(P.callState({ paired: true, phase: 'OFFHOOK', awaitingResult: true }), 'connected');
  // A live phone call counts even before the page marks the call started.
  assert.equal(P.callState({ paired: true, phase: 'OFFHOOK', awaitingResult: false }), 'connected');
  // Without a paired phone the phase is not believed: only the page says a call is on.
  assert.equal(P.callState({ paired: false, phase: 'OFFHOOK', awaitingResult: true }), 'unconfirmed');
  assert.equal(P.callState({ paired: false, phase: 'OFFHOOK', awaitingResult: false }), 'none');
});

test('after the phone hangs up: wrap-up until the save, at most 10 minutes', () => {
  const ended = { paired: true, phase: 'ENDED', awaitingResult: true, now: NOW };
  assert.equal(P.callState(ended), 'wrapup');
  assert.equal(P.callState({ ...ended, phase: 'FAILED' }), 'wrapup');
  assert.equal(P.callState({ ...ended, wrapupSince: NOW - 9 * 60e3 }), 'wrapup');
  assert.equal(P.callState({ ...ended, wrapupSince: NOW - 10 * 60e3 - 1 }), 'none');
  // Saved (or moved to another lead): nothing waits for a result.
  assert.equal(P.callState({ ...ended, awaitingResult: false }), 'none');
});

test('a call only the page knows about is unconfirmed', () => {
  assert.equal(P.callState({ paired: false, phase: null, awaitingResult: true }), 'unconfirmed');
  // Paired, but the first answer was tapped without dialling through the phone.
  assert.equal(P.callState({ paired: true, phase: null, awaitingResult: true }), 'unconfirmed');
  assert.equal(P.callState({ paired: true, phase: null, awaitingResult: false }), 'none');
  assert.equal(P.callState(null), 'none');
});

test('when the call started', () => {
  const t = { offhookWallMs: 300, dialWallMs: 200, beganAt: 100 };
  assert.equal(P.startedAt('connected', t), 300);
  assert.equal(P.startedAt('connected', { dialWallMs: 200, beganAt: 100 }), 200);
  assert.equal(P.startedAt('dialling', t), 200);
  assert.equal(P.startedAt('unconfirmed', t), 100);
  assert.equal(P.startedAt('wrapup', t), 300);
  assert.equal(P.startedAt('none', t), null);
  assert.equal(P.startedAt('dialling', {}), null);
});

test('report_presence arguments and the change key', () => {
  const a = P.args('connected', NOW, true);
  assert.deepEqual(a, { p_on_call: true, p_phone_ok: true, p_call_state: 'connected', p_call_started_at: new Date(NOW).toISOString() });
  assert.deepEqual(P.args('wrapup', NOW, false), { p_on_call: false, p_phone_ok: false, p_call_state: 'wrapup', p_call_started_at: new Date(NOW).toISOString() });
  assert.deepEqual(P.args('none', NOW, undefined), { p_on_call: false, p_phone_ok: true, p_call_state: 'none', p_call_started_at: null });
  assert.equal(P.args('unconfirmed', null, true).p_on_call, true);
  assert.equal(P.args('ringing', NOW, true).p_call_state, 'none');
  assert.notEqual(P.key(P.args('dialling', NOW, true)), P.key(P.args('connected', NOW, true)));
  assert.notEqual(P.key(P.args('connected', NOW, true)), P.key(P.args('connected', NOW, false)));
  assert.equal(P.key(P.args('connected', NOW, true)), P.key(P.args('connected', NOW, true)));
});

// A fake clock and timers for the reporter.
function clock() {
  let t = 0;
  const timers = [];
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    now: () => t,
    setTimeout: (f, ms) => { const x = { at: t + ms, f }; timers.push(x); return x; },
    clearTimeout: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      const end = t + ms;
      await flush();
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.f();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

test('debounce: the first change goes at once, a burst sends at most one update per 2 seconds', async () => {
  const c = clock();
  const sent = [];
  let state = 'dialling';
  const r = P.createReporter({ send: async () => { sent.push([c.now(), state]); }, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  r.request();
  await c.advance(0);
  assert.deepEqual(sent, [[0, 'dialling']]);
  // Connect and hang up within half a second: one more update, 2 seconds after the first, with the latest state.
  await c.advance(200); state = 'connected'; r.request();
  await c.advance(300); state = 'wrapup'; r.request(); r.request();
  assert.equal(r.pending(), true);
  await c.advance(1499);
  assert.equal(sent.length, 1);
  await c.advance(1);
  assert.deepEqual(sent, [[0, 'dialling'], [2000, 'wrapup']]);
  assert.equal(r.pending(), false);
  // Quiet for a while: the next change goes at once again.
  await c.advance(5000); state = 'none'; r.request();
  await c.advance(0);
  assert.deepEqual(sent[2], [7000, 'none']);
});

test('debounce: a change while a report is on its way waits for it, and a failed send is not fatal', async () => {
  const c = clock();
  const sent = [];
  let release;
  let fail = false;
  const r = P.createReporter({
    send: () => { sent.push(c.now()); if (fail) return Promise.reject(new Error('offline')); return new Promise((res) => { release = res; }); },
    now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
  });
  r.request();
  await c.advance(0);
  r.request();   // still in flight
  await c.advance(3000);
  assert.deepEqual(sent, [0]);
  fail = true;
  release();
  await c.advance(0);
  assert.deepEqual(sent, [0, 3000]);   // more than 2 seconds after the first: sent at once
  await c.advance(10);
  r.request();
  await c.advance(1989);
  assert.deepEqual(sent, [0, 3000]);
  await c.advance(1);
  assert.deepEqual(sent, [0, 3000, 5000]);
  r.request();
  r.cancel();
  await c.advance(5000);
  assert.equal(sent.length, 3);
});
