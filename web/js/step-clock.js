/* Time spent on each script step of a call, and the furthest step reached (call_outcomes.step_times and
   reached_step; Insights uses them for coaching, "where calls end" and the sales funnel). A step's time adds
   up when the caller comes back to it. "Furthest" is the step with the highest rank seen: the page passes
   stage * 1000 + the step's place in the script, so a later stage wins, then a later step. Pure: the clock
   is given (now in ms). Tested in tests/web/step-clock.test.js. */
(function (root) {
  const MAX_STEP_SECONDS = 3600;   // a step left open for hours (a break) counts as one hour at most

  function create() {
    let times = Object.create(null);
    let current = null, since = 0, reached = null, reachedRank = -Infinity, paused = true;

    function close(now) {
      if (current != null && !paused) times[current] = (times[current] || 0) + Math.max(0, now - since);
      since = now;
    }
    return {
      /* The step on screen is now id (rank: how far into the script it is). */
      enter(id, rank, now) {
        close(now);
        current = id; paused = false;
        if (rank > reachedRank || (rank === reachedRank && reached == null)) { reached = id; reachedRank = rank; }
      },
      /* Stop counting (the call ended or the page left the script). */
      pause(now) { close(now); paused = true; },
      /* { times: { stepId: seconds }, reached } so far. */
      result(now) {
        close(now == null ? since : now);
        const out = {};
        Object.keys(times).forEach((k) => { out[k] = Math.min(MAX_STEP_SECONDS, Math.round(times[k] / 1000)); });
        return { times: out, reached: reached };
      },
      reset() { times = Object.create(null); current = null; since = 0; reached = null; reachedRank = -Infinity; paused = true; },
      current: () => current,
    };
  }

  const api = { create, MAX_STEP_SECONDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.StepClock = api;
})(typeof window !== "undefined" ? window : globalThis);
