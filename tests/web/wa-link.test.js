const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../../web/js/wa-link.js");

test("numbers become wa.me numbers with the country code", () => {
  assert.equal(W.waNumber("+91 98765 43210"), "919876543210");
  assert.equal(W.waNumber("09876543210"), "919876543210");
  assert.equal(W.waNumber("9876543210"), "919876543210");
  assert.equal(W.waNumber("12345"), "");
  assert.equal(W.waNumber(null), "");
});

test("the link opens the caller's own WhatsApp with the message filled in", () => {
  assert.equal(W.link("+919876543210", "Hi & bye"), "https://wa.me/919876543210?text=Hi%20%26%20bye");
  assert.equal(W.link("bad", "x"), "");
});

test("consent: hidden for do not call, a wrong number or a no; shown otherwise", () => {
  assert.equal(W.allowed({ consent_whatsapp: false }, "", "paid"), true);
  assert.equal(W.allowed({ consent_whatsapp: true }, "no", "paid"), false);
  assert.equal(W.allowed({ do_not_call: true }, "yes", "paid"), false);
  assert.equal(W.allowed({}, "yes", "do_not_call"), false);
  assert.equal(W.allowed({}, "yes", "wrong_number"), false);
  assert.equal(W.allowed(null, "yes", "paid"), false);
  assert.equal(W.needsAsking({ consent_whatsapp: false }, ""), true);
  assert.equal(W.needsAsking({ consent_whatsapp: true }, ""), false);
  assert.equal(W.needsAsking({ consent_whatsapp: false }, "yes"), false);
});

test("the message carries the promised date and amount", () => {
  const m = W.message({ key: "will_pay_on", name: "Sunita Sharma", me: "Pratik", campaign: "Oct fees", date: "2026-10-28", amount: 118000 });
  assert.match(m, /^Hello Sunita, this is Pratik \(Oct fees\)\./);
  assert.match(m, /you will pay ₹1,18,000 on 28 October\./);
  assert.match(W.message({ key: "call_back_later", name: "", date: "2026-11-02" }), /^Hello there, this is your caller\.[\s\S]*again on 2 November\./);
  assert.match(W.message({ key: "unknown_result", name: "A" }), /Thank you for your time today\.$/);
});

test("an in-app sender can be plugged in later", async () => {
  assert.equal(W.hasSender(), false);
  await assert.rejects(W.send({ text: "x" }));
  const got = [];
  W.setSender((msg) => { got.push(msg); return "queued"; });
  assert.equal(W.hasSender(), true);
  assert.equal(await W.send({ leadId: "l1", phone: "+919876543210", text: "hi" }), "queued");
  assert.equal(got[0].leadId, "l1");
  W.setSender(null);
  assert.equal(W.hasSender(), false);
});
