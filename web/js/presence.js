/* What the caller screen tells the admin Home tab about the call ("Callers right now"), and how often.
   Pure helpers used by main.js (campPresence) and tested under Node (tests/web/presence.test.js).
   The server side is report_presence() in supabase/migrations/20261025190000_presence_call_state.sql.

   callState(input) -> 'none' | 'dialling' | 'connected' | 'wrapup' | 'unconfirmed'
     input.phase           the paired phone's call phase for the call on screen: REQUESTED, OFFHOOK, ENDED, FAILED
                           (null when the phone has not reported a call)
     input.paired          a phone is paired with this browser
     input.awaitingResult  a call has started on this page and its result is not saved yet (Dial pressed, the first
                           answer tapped, or a phone call on screen still waiting for its outcome)
     input.wrapupSince     when the phone went idle (ms), 0 when not known; input.now (ms)
   "dialling" and "connected" come only from the paired phone. After the phone hangs up, "wrapup" lasts until the
   result is saved or the caller moves on, at most 10 minutes. With no phone paired (or none reporting a call),
   a call the page has started is "unconfirmed".

   createReporter({ send, gapMs }) -> { request(), pending() }: request() sends now, or once at the end of the
   2-second gap after the last send, so a burst of changes sends at most one update per gap; send() reads the
   latest state when it runs. */
(function (root) {
  const WRAPUP_MAX_MS = 10 * 60 * 1000;
  const GAP_MS = 2000;
  const STATES = ['none', 'dialling', 'connected', 'wrapup', 'unconfirmed'];

  function callState(input) {
    const i = input || {};
    const phase = i.paired ? i.phase || null : null;
    if (phase === 'REQUESTED') return 'dialling';
    if (phase === 'OFFHOOK') return 'connected';
    if (!i.awaitingResult) return 'none';
    if (phase === 'ENDED' || phase === 'FAILED') {
      const since = Number(i.wrapupSince) || 0;
      const now = Number(i.now) || Date.now();
      return since && now - since > WRAPUP_MAX_MS ? 'none' : 'wrapup';
    }
    return 'unconfirmed';
  }

  /* When the call started (ms), for "On a call · 3:12": the moment the line went into use, else the dial, else
     when the page started the call. null for no call. */
  function startedAt(state, times) {
    const t = times || {};
    const pick = (...xs) => xs.find((x) => Number(x) > 0) || null;
    if (state === 'connected' || state === 'wrapup') return pick(t.offhookWallMs, t.dialWallMs, t.beganAt);
    if (state === 'dialling') return pick(t.dialWallMs, t.beganAt);
    if (state === 'unconfirmed') return pick(t.beganAt, t.dialWallMs);
    return null;
  }

  /* The arguments for report_presence. p_on_call stays true while a call is going on, for older databases. */
  function args(state, started, phoneOk) {
    const st = STATES.includes(state) ? state : 'none';
    return {
      p_on_call: st === 'dialling' || st === 'connected' || st === 'unconfirmed',
      p_phone_ok: phoneOk !== false,
      p_call_state: st,
      p_call_started_at: st !== 'none' && started ? new Date(started).toISOString() : null,
    };
  }

  /* Two reports are the same when nothing Home shows would change. */
  const key = (a) => [a.p_call_state, a.p_phone_ok, a.p_call_started_at].join('|');

  function createReporter(opts) {
    const o = opts || {};
    const gap = o.gapMs == null ? GAP_MS : o.gapMs;
    const now = o.now || (() => Date.now());
    const setT = o.setTimeout || ((f, ms) => setTimeout(f, ms));
    const clearT = o.clearTimeout || ((t) => clearTimeout(t));
    let last = -Infinity;
    let timer = null;
    let busy = false;
    let again = false;

    async function fire() {
      timer = null;
      if (busy) { again = true; return; }
      busy = true;
      last = now();
      try { await o.send(); } catch (e) { /* the next request or heartbeat tries again */ }
      finally {
        busy = false;
        if (again) { again = false; request(); }
      }
    }
    function request() {
      if (busy) { again = true; return; }
      if (timer) return;
      const wait = last + gap - now();
      if (wait <= 0) { fire(); return; }
      timer = setT(fire, wait);
    }
    return {
      request,
      pending: () => !!timer || again,
      cancel: () => { if (timer) clearT(timer); timer = null; again = false; },
    };
  }

  const api = { WRAPUP_MAX_MS, GAP_MS, STATES, callState, startedAt, args, key, createReporter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VectorPresence = api;
})(typeof window !== 'undefined' ? window : globalThis);
