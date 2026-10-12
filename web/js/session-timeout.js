/* Session timeout for the workspace. After 30 minutes with no input, "Still there?" appears. With the cloud
   on, no answer within 5 more minutes signs the rep out of the cloud and the sign-in screen says why. With
   the cloud off, only the message shows. Any input (or Continue) resets the timer. Times come from the wall
   clock, so a laptop that slept counts the time it slept. The state machine (step) takes times as arguments. */
(function (root) {
  const IDLE_MS = 30 * 60 * 1000;
  const GRACE_MS = 5 * 60 * 1000;
  const $ = (id) => document.getElementById(id);

  function initial(now) { return { phase: "active", last: now, warnedAt: 0 }; }

  /* ev: "activity" (any input, or Continue) or "tick" (a timer check).
     o.canSignOut: true when a cloud session is open and must be ended after the grace period.
     Returns { state, action }. action: "warn" (show the message), "dismiss" (hide it), "sign-out", or null. */
  function step(s, ev, now, o) {
    const canSignOut = !!(o && o.canSignOut);
    if (ev === "activity") return { state: initial(now), action: s.phase === "warning" ? "dismiss" : null };
    if (ev !== "tick" || s.phase === "signed_out") return { state: s, action: null };
    const idle = now - s.last;
    if (s.phase === "active") {
      if (canSignOut && idle >= IDLE_MS + GRACE_MS) return { state: { phase: "signed_out", last: s.last, warnedAt: now }, action: "sign-out" };
      if (idle >= IDLE_MS) return { state: { phase: "warning", last: s.last, warnedAt: now }, action: "warn" };
      return { state: s, action: null };
    }
    // warning: sign out only when a cloud session is open, and only after the grace period
    if (canSignOut && now - s.warnedAt >= GRACE_MS) return { state: { phase: "signed_out", last: s.last, warnedAt: s.warnedAt }, action: "sign-out" };
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
    const r = step(st || initial(now), "activity", now);
    st = r.state;
    if (r.action === "dismiss") overlay(false);
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
    if (r.action === "warn") overlay(true, cloud);
    if (r.action === "sign-out") { overlay(false); signOutForTimeout(); }
  }

  function init() {
    st = initial(Date.now());
    ["pointerdown", "keydown", "input", "touchstart", "wheel"].forEach((ev) =>
      document.addEventListener(ev, activity, { capture: true, passive: true }));
    $("still-continue").addEventListener("click", activity);
    setInterval(tick, 1000);
  }

  root.SessionTimeout = { IDLE_MS, GRACE_MS, initial, step, init };
})(window);
