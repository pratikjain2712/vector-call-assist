const test = require("node:test");
const assert = require("node:assert/strict");
const StepClock = require("../../web/js/step-clock.js");

test("time on each step adds up across visits, in whole seconds", () => {
  const c = StepClock.create();
  c.enter("hello", 0, 0);
  c.enter("fee", 4001, 10_400);
  c.enter("hello", 0, 20_000);   // went back
  c.enter("fee", 4001, 25_000);
  const r = c.result(31_000);
  assert.deepEqual(r.times, { hello: 15, fee: 16 });
  assert.equal(r.reached, "fee");
});

test("the furthest step is the highest rank seen, not the last one", () => {
  const c = StepClock.create();
  c.enter("open", 0, 0);
  c.enter("pitch", 2003, 1000);
  c.enter("open", 0, 2000);
  assert.equal(c.result(3000).reached, "pitch");
});

test("paused time is not counted, and a step left open counts an hour at most", () => {
  const c = StepClock.create();
  c.enter("a", 0, 0);
  c.pause(5000);
  c.enter("a", 0, 100_000);
  assert.equal(c.result(102_000).times.a, 7);
  const d = StepClock.create();
  d.enter("b", 0, 0);
  assert.equal(d.result(5 * 3600e3).times.b, StepClock.MAX_STEP_SECONDS);
});

test("reset starts a new call", () => {
  const c = StepClock.create();
  c.enter("a", 0, 0);
  c.reset();
  assert.deepEqual(c.result(10_000), { times: {}, reached: null });
  assert.equal(c.current(), null);
});
