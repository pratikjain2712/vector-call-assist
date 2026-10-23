const test = require("node:test");
const assert = require("node:assert/strict");
const RB = require("../../web/js/result-buttons.js");

// The fees call type as my_campaigns() returns it.
const FEES = [
  { key: "paid", label: "Paid", needs_amount: true, counts_as_good: true, common: false },
  { key: "will_pay_on", label: "Will pay on date", needs_date: true, needs_amount: true, counts_as_good: true, common: false },
  { key: "refused", label: "Refused", needs_reason: true, common: false },
  { key: "no_answer", label: "No answer", common: true },
  { key: "call_back_later", label: "Call back later", needs_date: true, common: true },
  { key: "do_not_call", label: "Do not call again", common: true },
];
const byKey = (k) => FEES.find((r) => r.key === k);

test("the call type's results and the common ones are split, in order", () => {
  const s = RB.split(FEES.concat([null, { key: "x" }]));
  assert.deepEqual(s.main.map((r) => r.key), ["paid", "will_pay_on", "refused"]);
  assert.deepEqual(s.common.map((r) => r.key), ["no_answer", "call_back_later", "do_not_call"]);
  assert.deepEqual(RB.split(null), { main: [], common: [] });
});

test("tone: good results green, a clear no red", () => {
  assert.equal(RB.tone(byKey("paid")), "good");
  assert.equal(RB.tone(byKey("refused")), "bad");
  assert.equal(RB.tone(byKey("no_answer")), "");
});

test("amounts in Indian format are read", () => {
  assert.equal(RB.parseAmount("18,000"), 18000);
  assert.equal(RB.parseAmount("₹ 1,18,000.50"), 118000.5);
  assert.equal(RB.parseAmount("Rs. 500"), 500);
  assert.equal(RB.parseAmount(""), null);
  assert.equal(RB.parseAmount("abc"), null);
  assert.equal(RB.parseAmount("-5"), null);
  assert.equal(RB.parseAmount("1.234"), null);
});

test("fields follow what the result needs", () => {
  assert.deepEqual(RB.fields(byKey("will_pay_on")), ["date", "amount"]);
  assert.deepEqual(RB.fields(byKey("refused")), ["reason"]);
  assert.deepEqual(RB.fields({ key: "rated", needs_rating: true }), ["rating"]);
  assert.deepEqual(RB.fields(null), []);
});

test("problems say what is missing in plain words", () => {
  assert.deepEqual(RB.problems(null, {}), ["Pick how the call ended."]);
  assert.deepEqual(RB.problems(byKey("will_pay_on"), {}), ["Pick the date.", "Enter the amount in rupees."]);
  assert.deepEqual(RB.problems(byKey("will_pay_on"), { date: "2026-10-28", amount: "18,000" }), []);
  assert.deepEqual(RB.problems(byKey("refused"), { reason: "  " }), ["Give the reason."]);
  assert.deepEqual(RB.problems({ key: "rated", needs_rating: true }, { rating: "7" }), ["Pick a rating from 1 to 5."]);
  assert.deepEqual(RB.problems(byKey("call_back_later"), { date: "2026-10-28", time: "25:00" }), ["Enter the time as hh:mm."]);
  assert.deepEqual(RB.problems(byKey("no_answer"), { note: "x".repeat(301) }), ["Keep the note under 300 characters."]);
});

test("save arguments carry only what the result asks for, plus note, reason and consent", () => {
  const args = RB.toArgs(byKey("will_pay_on"), { date: "2026-10-28", amount: "18,000", note: " After salary ", waConsent: true, rating: 4 },
    { id: "rec-1", leadId: "lead-1", stepTimes: { hello: 5 }, reachedStep: "fee", scriptStep: "fee", scriptId: "s1", scriptVersion: 3,
      dialledAt: Date.parse("2026-10-24T05:00:00Z"), connectedSeconds: 61.4, phoneSessionId: "ph-1" });
  assert.deepEqual(args, {
    p_client_record_id: "rec-1", p_lead: "lead-1", p_result_key: "will_pay_on", p_promised_date: "2026-10-28", p_amount: 18000,
    p_note: "After salary", p_consent_whatsapp: true, p_step_times: { hello: 5 }, p_reached_step: "fee", p_script_step: "fee",
    p_script_id: "s1", p_script_version: 3, p_dialled_at: "2026-10-24T05:00:00.000Z", p_connected_seconds: 61, p_phone_session_id: "ph-1",
  });
  const plain = RB.toArgs(byKey("no_answer"), { date: "2026-10-28", amount: "5" }, { id: "r", leadId: "l" });
  assert.deepEqual(plain, { p_client_record_id: "r", p_lead: "l", p_result_key: "no_answer" });
});

test("call back later with a time is sent as India time", () => {
  const args = RB.toArgs(byKey("call_back_later"), { date: "2026-10-28", time: "16:30" }, { id: "r", leadId: "l" });
  assert.equal(args.p_next_call_at, "2026-10-28T11:00:00.000Z");
  assert.equal(RB.callAt("2026-10-28", ""), null);
});
