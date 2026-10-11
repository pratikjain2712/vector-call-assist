const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePhone, checkPhones, problemText } = require("../../web/js/import-check.js");

test("keeps the leading zero out of the way: 09876543210 is 10 digits", () => {
  assert.deepEqual(normalizePhone("09876543210"), { status: "ok", digits: "9876543210", reason: "" });
});

test("accepts plain 10 digits, spaces, and +91 with or without a space", () => {
  assert.equal(normalizePhone("9876543210").status, "ok");
  assert.equal(normalizePhone("98765 43210").status, "ok");
  assert.equal(normalizePhone("+91 98765 43210").digits, "9876543210");
  assert.equal(normalizePhone("+919876543210").status, "ok");
  assert.equal(normalizePhone("+91 098765 43210").status, "ok");
});

test("flags numbers that are not 10 digits after the allowed prefixes are removed", () => {
  assert.equal(normalizePhone("98765432").status, "bad");          // 8 digits
  assert.equal(normalizePhone("987654321").status, "bad");         // 9 digits: a dropped leading zero
  assert.equal(normalizePhone("098765432100").status, "bad");      // 12 digits
  assert.equal(normalizePhone("+1 415 555 0100").status, "bad");   // not an Indian number
  assert.equal(normalizePhone("abc").status, "bad");
});

test("empty cells are missing, not bad", () => {
  assert.equal(normalizePhone("").status, "missing");
  assert.equal(normalizePhone("   ").status, "missing");
  assert.equal(normalizePhone(null).status, "missing");
  assert.equal(normalizePhone(undefined).status, "missing");
});

test("numeric input loses nothing it still has: a 10-digit number passes", () => {
  assert.equal(normalizePhone(9876543210).status, "ok");
});

test("a repeated number is a duplicate, and points at the first lead", () => {
  const r = checkPhones(["09876543210", "9876543211", "+91 9876543210", "9876543211"]);
  assert.equal(r.flags[0].status, "ok");
  assert.equal(r.flags[1].status, "ok");
  assert.equal(r.flags[2].status, "duplicate");
  assert.equal(r.flags[2].reason, "Same number as lead 1");
  assert.equal(r.flags[3].status, "duplicate");
  assert.equal(r.flags[3].reason, "Same number as lead 2");
  assert.deepEqual(r.counts, { ok: 2, missing: 0, bad: 0, duplicate: 2 });
  assert.equal(r.problems, 2);
});

test("counts every kind of problem and keeps one flag per row (no rows dropped)", () => {
  const values = ["9876543210", "", "98765", "9876543210", "09876543210", "9123456789"];
  const r = checkPhones(values);
  assert.equal(r.flags.length, values.length);
  assert.deepEqual(r.counts, { ok: 2, missing: 1, bad: 1, duplicate: 2 });
  assert.equal(r.problems, 4);
  assert.equal(r.flags[1].status, "missing");
  assert.equal(r.flags[2].status, "bad");
});

test("a clean list has no problems", () => {
  const r = checkPhones(["9876543210", "9123456789"]);
  assert.equal(r.problems, 0);
  assert.equal(problemText(r.counts), "All phone numbers look right.");
});

test("the import message gives a short count and says nothing was dropped", () => {
  const text = problemText({ ok: 5, missing: 0, bad: 2, duplicate: 1 });
  assert.match(text, /^3 phone numbers need checking \(2 not 10 digits, 1 repeated\)/);
  assert.match(text, /kept/);
  assert.match(problemText({ ok: 0, missing: 1, bad: 0, duplicate: 0 }), /^1 phone number needs checking/);
});

test("hyphens are removed before the check: 98765-43210 is valid", () => {
  assert.deepEqual(normalizePhone("98765-43210"), { status: "ok", digits: "9876543210", reason: "" });
});

test("Excel stores 91 plus 10 digits as a number: 918828151105 is valid", () => {
  assert.deepEqual(normalizePhone("918828151105"), { status: "ok", digits: "8828151105", reason: "" });
  assert.equal(normalizePhone(918828151105).status, "ok");
});

test("the accepted forms all pass: 10 digits, 0 plus 10, +91 with spaces", () => {
  assert.equal(normalizePhone("9876543210").status, "ok");
  assert.equal(normalizePhone("09876543210").status, "ok");
  assert.equal(normalizePhone("+91 98765 43210").status, "ok");
});

test("a 10-digit number that starts with 91 is not cut down", () => {
  assert.deepEqual(normalizePhone("9123456789"), { status: "ok", digits: "9123456789", reason: "" });
});

test("a 9-digit number (a dropped leading zero) and a 5-digit number are flagged", () => {
  assert.equal(normalizePhone("987654321").status, "bad");
  assert.equal(normalizePhone("12345").status, "bad");
});

test("duplicates are found after normalisation: 918828151105 and 8828151105 are the same lead", () => {
  const r = checkPhones(["918828151105", "8828151105"]);
  assert.equal(r.flags[0].status, "ok");
  assert.equal(r.flags[1].status, "duplicate");
  assert.equal(r.flags[1].reason, "Same number as lead 1");
});
