// Tests for web/js/script-adapter.js: saved steps to the call page's FLOW shape, and the cases that must return null.
// No network and no DOM. Run: node --test tests/web/script-adapter.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const A = require(path.join(__dirname, "..", "..", "web", "js", "script-adapter.js"));

// Open -> (yes) discovery, (no) close. Discovery -> (yes) won, (no) lost. Two end cards.
const good = () => [
  { id: "open", title: "Opening", start: true, say: ["Hi {name}, {me} here."], tip: "Smile first.",
    opts: [{ label: "Yes", to: "discovery" }, { label: "No", to: "lost" }] },
  { id: "discovery", title: "Discovery", stage: 1, say: ["What do you do now?"],
    opts: [{ label: "Working engineer", to: "won" }, { label: "Student", to: "lost" }, { label: "Maybe later", to: "lost" }] },
  { id: "won", title: "Enrolled", say: ["Welcome aboard."], opts: [] },
  { id: "lost", title: "", say: ["Thanks for your time."] },
];

test("a valid saved script converts to the FLOW shape", () => {
  const flow = A.adaptSteps(good());
  assert.ok(flow, "expected a flow");
  assert.deepEqual(Object.keys(flow).sort(), ["discovery", "lost", "open", "won"]);
  assert.equal(flow.open.stage, 0);
  assert.deepEqual(flow.open.say, ["Hi {name}, {me} here."]);
  assert.equal(flow.open.tip, "Smile first.");
  assert.deepEqual(flow.open.opts, [
    { k: "yes", hint: "Yes", to: "discovery" },
    { k: "no", hint: "No", to: "lost" },
  ]);
  assert.equal(flow.discovery.stage, 1);
  assert.equal("tip" in flow.discovery, false);
  // Labels that are not yes, no, maybe or next take the spare kinds in order.
  assert.deepEqual(flow.discovery.opts.map((o) => o.k), ["yes", "no", "maybe"]);
  assert.deepEqual(flow.discovery.opts.map((o) => o.hint), ["Working engineer", "Student", "Maybe later"]);
  assert.deepEqual(flow.won, { end: { tone: "neutral", label: "Enrolled", note: "" } });
  // An empty title falls back to the step id.
  assert.deepEqual(flow.lost, { end: { tone: "neutral", label: "lost", note: "" } });
});

test("a stage is inherited from the step before when a step has none", () => {
  const steps2 = [
    { id: "a", start: true, say: ["one"], opts: [{ label: "Next", to: "b" }] },
    { id: "b", stage: 4, say: ["two"], opts: [{ label: "Yes", to: "c" }, { label: "No", to: "c" }] },
    { id: "c", say: ["three"], opts: [{ label: "Yes", to: "end" }] },
    { id: "end", opts: [] },
  ];
  const f2 = A.adaptSteps(steps2);
  assert.equal(f2.a.stage, 0);
  assert.equal(f2.b.stage, 4);
  assert.equal(f2.c.stage, 4);
  assert.deepEqual(f2.b.opts.map((o) => o.k), ["yes", "no"]);
});

test("a dangling option target returns null", () => {
  const steps = good();
  steps[0].opts[1].to = "nowhere";
  assert.equal(A.adaptSteps(steps), null);
});

test("a missing start step returns null", () => {
  const steps = good();
  delete steps[0].start;
  assert.equal(A.adaptSteps(steps), null);
  assert.equal(A.startStepId(steps), null);
});

test("two start steps return null", () => {
  const steps = good();
  steps[1].start = true;
  assert.equal(A.adaptSteps(steps), null);
  assert.equal(A.startStepId(steps), null);
});

test("a duplicate step id returns null", () => {
  const steps = good();
  steps[3].id = "won";
  assert.equal(A.adaptSteps(steps), null);
});

test("a missing step id returns null", () => {
  const steps = good();
  delete steps[2].id;
  assert.equal(A.adaptSteps(steps), null);
});

test("more than three options on a step returns null", () => {
  const steps = good();
  steps[1].opts.push({ label: "Other", to: "won" });
  assert.equal(A.adaptSteps(steps), null);
});

test("a single option becomes next, whatever its label", () => {
  const steps = [
    { id: "open", start: true, say: ["Hello."], opts: [{ label: "Continue", to: "end" }] },
    { id: "end", opts: [] },
  ];
  const flow = A.adaptSteps(steps);
  assert.deepEqual(flow.open.opts, [{ k: "next", hint: "Continue", to: "end" }]);
});

test("a label naming yes, no, maybe or next takes that kind", () => {
  const steps = [
    { id: "s", start: true, say: ["Ask."], opts: [{ label: "NO", to: "e" }, { label: " next ", to: "e" }] },
    { id: "e", opts: [] },
  ];
  const flow = A.adaptSteps(steps);
  assert.deepEqual(flow.s.opts.map((o) => o.k), ["no", "next"]);
  assert.deepEqual(flow.s.opts.map((o) => o.hint), ["NO", "next"]);
});

test("the __proto__ id is handled as an ordinary id", () => {
  const steps = [
    { id: "__proto__", start: true, say: ["Start."], opts: [{ label: "Yes", to: "constructor" }] },
    { id: "constructor", opts: [] },
  ];
  const flow = A.adaptSteps(steps);
  assert.ok(flow, "expected a flow");
  assert.equal(Object.getPrototypeOf(flow), null);
  assert.equal(flow["__proto__"].opts[0].to, "constructor");
  assert.deepEqual(flow["constructor"], { end: { tone: "neutral", label: "constructor", note: "" } });
  assert.equal(({}).end, undefined, "Object.prototype must not be changed");
});

test("bad input returns null and never throws", () => {
  assert.equal(A.adaptSteps(null), null);
  assert.equal(A.adaptSteps("steps"), null);
  assert.equal(A.adaptSteps([]), null);
  assert.equal(A.adaptSteps([null]), null);
  const steps = good();
  steps[0].stage = 9;
  assert.equal(A.adaptSteps(steps), null);
  const noSay = good();
  noSay[0].say = [];
  assert.equal(A.adaptSteps(noSay), null);
});
