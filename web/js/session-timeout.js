/* Session lock for the caller page. After 30 minutes with no input the screen locks: the page is covered and
   only Continue opens it again (other input does not), so nobody walking past sees lead names. The caller stays
   signed in for the working day: with the cloud on, the real sign-out comes only after 12 hours with no input,
   and the sign-in screen says why. With the cloud off, only the lock shows. Times come from the wall clock, so
   a laptop that slept counts the time it slept. The state machine (step) takes times as arguments. */
(function (root) {
  const IDLE_MS = 30 * 60 * 1000;
  const SIGN_OUT_MS = 12 * 60 * 60 * 1000;
  const $ = (id) => document.getElementById(id);

  function initial(now) { return { phase: "active", last: now, lockedAt: 0 }; }

  /* ev: "activity" (any input), "continue" (the Continue button) or "tick" (a timer check).
     o.canSignOut: true when a cloud session is open and must be ended after SIGN_OUT_MS with no input.
     Returns { state, action }. action: "lock" (cover the page), "unlock", "sign-out", or null. */
  function step(s, ev, now, o) {
    const canSignOut = !!(o && o.canSignOut);
    if (ev === "continue") return { state: initial(now), action: s.phase === "locked" ? "unlock" : null };
    if (ev === "activity") {
      if (s.phase === "locked") return { state: s, action: null };   // locked: only Continue opens it
      return { state: initial(now), action: null };
    }
    if (ev !== "tick" || s.phase === "signed_out") return { state: s, action: null };
    const idle = now - s.last;
    if (canSignOut && idle >= SIGN_OUT_MS) return { state: { phase: "signed_out", last: s.last, lockedAt: s.lockedAt || now }, action: "sign-out" };
    if (s.phase === "active" && idle >= IDLE_MS) return { state: { phase: "locked", last: s.last, lockedAt: now }, action: "lock" };
    return { state: s, action: null };
  }

  let st = null;
  function cloudOpen() {
    const c = root.Cloud && root.Cloud.info ? root.Cloud.info() : {};
    return !!(c.enabled && (c.status === "ready" || c.status === "offline"));
  }
  function overlay(on, cloud) {
    const box = $("still-there");
    if (!box) return;
    $("still-text").textContent = root.I18n.t(cloud ? "timeout.text" : "timeout.textOff");
    box.hidden = !on;
    if (on) $("still-continue").focus();
  }
  function activity() {
    const now = Date.now();
    st = step(st || initial(now), "activity", now).state;
  }
  function onContinue() {
    const now = Date.now();
    const r = step(st || initial(now), "continue", now);
    st = r.state;
    overlay(false);
  }
  async function signOutForTimeout() {
    try { await root.Cloud.signOut(); } catch (e) {}
    const msg = $("signin-msg");
    if (msg) msg.textContent = root.I18n.t("timeout.signedOut");
  }
  function tick() {
    const now = Date.now();
    if (!st) st = initial(now);
    if ($("app").hidden) { st = initial(now); overlay(false); return; }   // sign-in or pairing screen: not running
    const cloud = cloudOpen();
    const r = step(st, "tick", now, { canSignOut: cloud });
    st = r.state;
    if (r.action === "lock") overlay(true, cloud);
    if (r.action === "sign-out") { overlay(false); signOutForTimeout(); }
  }

  function init() {
    st = initial(Date.now());
    ["pointerdown", "keydown", "input", "touchstart", "wheel"].forEach((ev) =>
      document.addEventListener(ev, activity, { capture: true, passive: true }));
    $("still-continue").addEventListener("click", onContinue);
    setInterval(tick, 1000);
  }

  root.SessionTimeout = { IDLE_MS, SIGN_OUT_MS, initial, step, init };
})(window);
