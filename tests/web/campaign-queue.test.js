const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../../web/js/campaign-queue.js");

const NOW = Date.parse("2026-10-24T11:00:00+05:30");
const iso = (offsetMin) => new Date(NOW + offsetMin * 60e3).toISOString();
const leads = [
  { id: "n1", name: "New old", status: "new", next_call_at: null, created_at: iso(-3000) },
  { id: "n2", name: "New recent", status: "new", next_call_at: null, created_at: iso(-10) },
  { id: "c1", name: "Call back overdue", status: "callback", next_call_at: iso(-120), created_at: iso(-5000) },
  { id: "p1", name: "Promise due", status: "promised", next_call_at: iso(-60), promised_date: "2026-10-24", created_at: iso(-9000) },
  { id: "c2", name: "Call back later today", status: "callback", next_call_at: iso(90), created_at: iso(-50) },
  { id: "r1", name: "No answer retry", status: "new", next_call_at: iso(30), created_at: iso(-4000) },
  { id: "d1", name: "Done", status: "done", next_call_at: null, created_at: iso(-1) },
  { id: "w1", name: "Wrong", status: "wrong_number", next_call_at: null, created_at: iso(-1) },
  { id: "x1", name: "Do not call", status: "do_not_call", do_not_call: true, next_call_at: null, created_at: iso(-1) },
];
const names = (list) => list.map((l) => l.id);

test("call backs and promises that are due come first, earliest first, then new leads oldest first", () => {
  assert.deepEqual(names(Q.callable(leads, NOW)), ["c1", "p1", "n1", "n2"]);
});

test("leads due later wait in their own group, soonest first; closed leads are left out", () => {
  const g = Q.groups(leads, NOW);
  assert.deepEqual(names(g.later), ["r1", "c2"]);
  assert.deepEqual(names(g.due), ["c1", "p1"]);
  assert.deepEqual(names(g.fresh), ["n1", "n2"]);
});

test("a lead becomes due when its time comes", () => {
  assert.deepEqual(names(Q.callable(leads, NOW + 91 * 60e3)), ["c1", "p1", "r1", "c2", "n1", "n2"]);
});

test("next lead skips the one just called", () => {
  assert.equal(Q.nextLead(leads, NOW, "c1").id, "p1");
  assert.equal(Q.nextLead([leads[0]], NOW, "n1"), null);
});

test("status lines in plain words", () => {
  assert.equal(Q.statusOf(leads[3], NOW).kind, "promise");
  assert.equal(Q.statusOf(leads[2], NOW).label, "Call back now");
  assert.equal(Q.statusOf({ status: "callback", next_call_at: iso(-3000) }, NOW).label, "Call back overdue");
  assert.equal(Q.statusOf(leads[0], NOW).label, "New");
  assert.equal(Q.statusOf({ status: "new", calls: 2 }, NOW).label, "Try again");
  assert.equal(Q.statusOf(leads[4], NOW).kind, "later");
  assert.match(Q.statusOf(leads[4], NOW).label, /^Call at \d{1,2}:\d{2} (am|pm)$/);
});

const R = (key, extra) => Object.assign({ key, needs_date: false, needs_amount: false }, extra);

test("a promise with a date and an amount makes the lead a promise due on that date", () => {
  const out = Q.applyResult(leads[0], R("will_pay_on", { needs_date: true, needs_amount: true }), { date: "2026-10-28", amount: "18000" }, NOW);
  assert.equal(out.status, "promised");
  assert.equal(out.promised_date, "2026-10-28");
  assert.equal(out.next_call_at, new Date(Date.parse("2026-10-28T10:00:00+05:30")).toISOString());
  assert.equal(out.calls, 1);
  assert.equal(out.last_result_key, "will_pay_on");
  assert.equal(leads[0].status, "new", "the input lead is not changed");
});

test("call back later uses the time given, or 10 am India time on the date", () => {
  const at = Date.parse("2026-10-25T16:30:00+05:30");
  assert.equal(Q.applyResult(leads[0], R("call_back_later", { needs_date: true }), { date: "2026-10-25", nextCallAt: at }, NOW).next_call_at, new Date(at).toISOString());
  const out = Q.applyResult(leads[0], R("call_back_later", { needs_date: true }), { date: "2026-10-25" }, NOW);
  assert.equal(out.status, "callback");
  assert.equal(out.next_call_at, new Date(Date.parse("2026-10-25T10:00:00+05:30")).toISOString());
});

test("no answer and busy try again later; a promise stays a promise", () => {
  const na = Q.applyResult(leads[0], R("no_answer"), {}, NOW);
  assert.equal(na.status, "callback");
  assert.equal(Date.parse(na.next_call_at) - NOW, 2 * 3600e3);
  const busy = Q.applyResult(leads[3], R("busy"), {}, NOW);
  assert.equal(busy.status, "promised");
  assert.equal(Date.parse(busy.next_call_at) - NOW, 30 * 60e3);
});

test("final results close the lead; do not call and wrong number mark it", () => {
  assert.equal(Q.applyResult(leads[0], R("paid", { needs_amount: true }), { amount: 5 }, NOW).status, "done");
  const dnc = Q.applyResult(leads[0], R("do_not_call"), {}, NOW);
  assert.equal(dnc.status, "do_not_call");
  assert.equal(dnc.do_not_call, true);
  assert.equal(Q.applyResult(leads[0], R("wrong_number"), {}, NOW).status, "wrong_number");
  assert.equal(Q.applyResult(leads[0], R("will_think"), {}, NOW).status, "callback");
});

test("a do-not-call lead is never reopened", () => {
  assert.equal(Q.applyResult(leads[8], R("no_answer"), {}, NOW).status, "do_not_call");
});

test("WhatsApp consent and the note are kept on the lead", () => {
  const out = Q.applyResult(leads[0], R("busy"), { waConsent: true, note: "Call after 6" }, NOW);
  assert.equal(out.consent_whatsapp, true);
  assert.equal(out.last_note, "Call after 6");
});

test("results waiting to be sent are laid over the server copy, oldest first", () => {
  const pending = [
    { leadId: "c1", savedAt: NOW + 2000, result: R("paid", { needs_amount: true }), values: { amount: 1 } },
    { leadId: "c1", savedAt: NOW + 1000, result: R("no_answer"), values: {} },
    { leadId: "n1", savedAt: NOW + 500, result: R("call_back_later", { needs_date: true }), values: { date: "2026-10-30" } },
    { leadId: "gone", savedAt: NOW, result: R("busy"), values: {} },
  ];
  const merged = Q.withPending(leads, pending);
  assert.equal(merged.find((l) => l.id === "c1").status, "done", "the later result wins");
  assert.equal(merged.find((l) => l.id === "c1").calls, 2);
  assert.deepEqual(names(Q.callable(merged, NOW)), ["p1", "n2"]);
  assert.equal(leads.find((l) => l.id === "c1").status, "callback", "the server copy is not changed");
});

test("extra fields: labels from the sheet keys, blanks dropped", () => {
  assert.deepEqual(Q.extraFields({ student: "Ravi", class: "10-A", parent_name: "", roll_no: 12 }),
    [["Student", "Ravi"], ["Class", "10-A"], ["Roll no", "12"]]);
  assert.deepEqual(Q.extraFields(null), []);
  assert.deepEqual(Q.extraFields([1, 2]), []);
});
