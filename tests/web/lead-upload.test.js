/* Tests for web/js/lead-upload.js (lead sheets for campaigns) and the pure helpers of web/js/admin/campaigns.js.
   Run: node --test tests/web/lead-upload.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const LU = require("../../web/js/lead-upload.js");
const C = require("../../web/js/admin/campaigns.js");

const sheet = (rows) => LU.tidy(rows);

// ----- reading the sheet -----
test("parseCsv keeps quoted commas, quotes and a leading 0, and drops the BOM", () => {
  const rows = LU.parseCsv('﻿Name,Phone,Note\r\n"Rao, Asha",09876543210,"said ""ok"""\nArun,9876543211,\n');
  assert.deepEqual(rows, [["Name", "Phone", "Note"], ["Rao, Asha", "09876543210", 'said "ok"'], ["Arun", "9876543211", ""]]);
});

test("cellText turns Excel numbers, dates and blanks into text", () => {
  assert.equal(LU.cellText(9876543210), "9876543210");
  assert.equal(LU.cellText(919876543210), "919876543210");
  assert.equal(LU.cellText(12000.5), "12000.5");
  assert.equal(LU.cellText(new Date(2026, 10, 5)), "2026-11-05");
  assert.equal(LU.cellText(null), "");
  assert.equal(LU.cellText("  x "), "x");
});

test("tidy drops blank rows, names blank headings and pads short rows", () => {
  const s = sheet([["Name", "", "Phone"], ["", "", ""], ["Asha", "x"], []]);
  assert.deepEqual(s.header, ["Name", "Column 2", "Phone"]);
  assert.deepEqual(s.rows, [["Asha", "x", ""]]);
  assert.deepEqual(LU.tidy([]), { header: [], rows: [] });
});

// ----- money words, as extra_has_money_key -----
test("looksLikeMoney matches the database's money words", () => {
  ["Amount due", "Fee", "fees_pending", "Paid", "Balance fee", "Rupees", "Rs", "INR", "Price", "Cost", "Due ₹"]
    .forEach((h) => assert.equal(LU.looksLikeMoney(h), true, h));
  ["Name", "Class", "Feedback", "Due date", "Mrs name", "Hours", "Course"].forEach((h) => assert.equal(LU.looksLikeMoney(h), false, h));
});

// ----- column guesses -----
test("guessColumns finds name, phone and the amount due; money columns are not extra fields", () => {
  const g = LU.guessColumns(["Parent name", "Mobile", "Total fee", "Balance fee", "Student name", "Class"]);
  assert.equal(g.name, 0);
  assert.equal(g.phone, 1);
  assert.equal(g.amount, 3);                       // the one with "balance" wins over "Total fee"
  assert.deepEqual(g.extra, [4, 5]);               // Total fee is money: left out
});

test("guessColumns falls back to any money column, and -1 when there is none", () => {
  assert.equal(LU.guessColumns(["Name", "Phone", "Fees"]).amount, 2);
  const g = LU.guessColumns(["Student", "Contact number", "Class"]);
  assert.equal(g.name, -1);
  assert.equal(g.phone, 1);
  assert.equal(g.amount, -1);
});

// ----- amounts -----
test("parseAmount reads rupees written the usual ways", () => {
  assert.equal(LU.parseAmount("12,000"), 12000);
  assert.equal(LU.parseAmount("₹ 8,000.50"), 8000.5);
  assert.equal(LU.parseAmount("Rs. 1 20 000"), 120000);
  assert.equal(LU.parseAmount(4500), 4500);
  assert.equal(LU.parseAmount(""), null);
  assert.equal(LU.parseAmount("-"), null);
  assert.ok(Number.isNaN(LU.parseAmount("twelve")));
  assert.ok(Number.isNaN(LU.parseAmount(-5)));
  assert.ok(Number.isNaN(LU.parseAmount("1.234")));
});

// ----- building the upload -----
test("buildLeads skips bad numbers, repeats, rows without a name and bad amounts, and says which", () => {
  const s = sheet([
    ["Parent name", "Mobile", "Balance", "Student", "Class"],
    ["Asha", "098765 43210", "12,000", "Ravi", "10"],
    ["Arun", "+91 98765-43211", "", "Meena", ""],
    ["Bad", "12345", "1", "X", "9"],
    ["Missing", "", "1", "X", "9"],
    ["Repeat", "9876543210", "1", "X", "9"],
    ["", "9876543212", "1", "X", "9"],
    ["Wrong amount", "9876543213", "lots", "X", "9"],
  ]);
  const out = LU.buildLeads(s, { name: 0, phone: 1, amount: 2, extra: [3, 4] });
  assert.deepEqual(out.counts, { total: 7, ready: 2, bad: 2, repeats: 1, noName: 1, badAmount: 1 });
  assert.deepEqual(out.rows[0], { name: "Asha", phone: "+919876543210", amount_due: 12000, extra: { Student: "Ravi", Class: "10" } });
  assert.deepEqual(out.rows[1], { name: "Arun", phone: "+919876543211", amount_due: null, extra: { Student: "Meena" } });
  assert.deepEqual(out.problems.map((p) => p.row), [4, 5, 6, 7, 8]);
  assert.match(out.problems[2].reason, /Same number as lead 1/);
});

test("buildLeads never puts the name, phone or amount column in extra fields", () => {
  const s = sheet([["Name", "Phone", "Fee"], ["A", "9876543210", "5"]]);
  const out = LU.buildLeads(s, { name: 0, phone: 1, amount: -1, extra: [0, 1, 2] });
  assert.deepEqual(out.rows[0].extra, { Fee: "5" });   // the page blocks this case with moneyInExtra before upload
  assert.deepEqual(LU.moneyInExtra(s.header, [0, 2]), ["Fee"]);
  assert.deepEqual(LU.moneyInExtra(s.header, [0]), []);
});

test("skipText reads like the mockup", () => {
  assert.equal(LU.skipText({ bad: 12, repeats: 8 }), "12 bad numbers and 8 repeats will be skipped");
  assert.equal(LU.skipText({ bad: 1, repeats: 0 }), "1 bad number will be skipped");
  assert.equal(LU.skipText({ bad: 0, repeats: 1, noName: 2, badAmount: 1 }),
    "1 repeat, 2 rows without a name and 1 row with a wrong amount will be skipped");
  assert.equal(LU.skipText({ bad: 0, repeats: 0 }), "");
});

test("chunk, addCounts and equalText", () => {
  assert.deepEqual(LU.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(LU.chunk([], 1000), []);
  const total = LU.addCounts(LU.addCounts({}, [{ added: 3, bad_numbers: 1, repeats: 0, other_skipped: 0 }]), { added: 2, repeats: 2 });
  assert.deepEqual(total, { added: 5, bad_numbers: 1, repeats: 2, other_skipped: 0 });
  assert.equal(LU.equalText(220, 2), "Equal parts (110 each)");
  assert.equal(LU.equalText(10, 3), "Equal parts (about 3 each)");
  assert.equal(LU.equalText(0, 2), "Equal parts");
  assert.equal(LU.equalText(10, 0), "Equal parts");
});

// ----- campaigns tab helpers -----
test("dateRange writes dates like the mockup", () => {
  assert.equal(C.dateRange("2026-10-15", "2026-10-31"), "15 – 31 Oct");
  assert.equal(C.dateRange("2026-10-01", "2026-11-11"), "1 Oct – 11 Nov");
  assert.equal(C.dateRange("2026-10-10", null), "From 10 Oct");
  assert.equal(C.dateRange(null, "2026-11-20"), "Until 20 Nov");
  assert.equal(C.dateRange(null, null), "No dates");
  assert.equal(C.dateRange("2026-12-20", "2027-01-05"), "20 Dec 2026 – 5 Jan 2027");
  assert.equal(C.dateRange("2026-11-03", "2026-11-03"), "3 Nov");
});

test("status labels, actions and pills", () => {
  assert.equal(C.statusLabel("running"), "Running");
  assert.deepEqual(C.statusActions("draft").map((a) => a.status), ["running", "closed"]);
  assert.deepEqual(C.statusActions("running").map((a) => a.label), ["Pause", "Close"]);
  assert.deepEqual(C.statusActions("paused").map((a) => a.label), ["Resume", "Close"]);
  assert.deepEqual(C.statusActions("closed"), []);
  assert.equal(C.typeTone("fees"), "tone-warn");
  assert.equal(C.typeTone("sales"), "tone-accent");
  assert.equal(C.typeTone("my_own"), "tone-plain");
  assert.equal(C.percent(173, 240), 72);
  assert.equal(C.percent(5, 0), 0);
  assert.equal(C.percent(9, 4), 100);
});

test("scriptChoices offers live scripts only, and filters by type once the switch is on", () => {
  const scripts = [
    { id: "b", name: "Sales", call_type_id: "sales", script_versions: [{ version: 7, published: true, steps: [{ id: "x" }] }] },
    { id: "a", name: "Fees reminder", call_type_id: "fees", script_versions: [{ version: 2, published: false }, { version: 3, published: true, steps: [] }] },
    { id: "c", name: "Draft only", script_versions: [{ version: 1, published: false }] },
    { id: "d", name: "Any type", call_type_id: null, script_versions: [{ version: 1, published: true }] },
  ];
  assert.deepEqual(C.scriptChoices(scripts, "fees", false).map((s) => s.name + " v" + s.version), ["Any type v1", "Fees reminder v3", "Sales v7"]);
  assert.deepEqual(C.scriptChoices(scripts, "fees", true).map((s) => s.id), ["d", "a"]);
  assert.equal(C.SCRIPT_TYPE_FILTER, false);   // switched on by the integration agent with scripts.call_type_id
});

test("formProblem checks the form before a save", () => {
  const ok = { name: "Nov fees", typeId: "t", startDate: "2026-11-01", endDate: "2026-11-20", target: "40", leadCount: 3, seatCount: 2 };
  assert.equal(C.formProblem(ok, true), "");
  assert.equal(C.formProblem({ ...ok, name: " " }, false), "Give the campaign a name.");
  assert.equal(C.formProblem({ ...ok, typeId: "" }, false), "Pick a type.");
  assert.equal(C.formProblem({ ...ok, endDate: "2026-10-01" }, false), "The end date is before the start date.");
  assert.match(C.formProblem({ ...ok, target: "0" }, false), /daily target/);
  assert.match(C.formProblem({ ...ok, target: "2.5" }, false), /daily target/);
  assert.equal(C.formProblem({ ...ok, target: "" }, false), "");
  assert.match(C.formProblem({ ...ok, moneyInExtra: ["Fee"] }, false), /Column "Fee" has money/);
  assert.equal(C.formProblem({ ...ok, leadCount: 0 }, false), "");          // a draft needs no leads
  assert.equal(C.formProblem({ ...ok, leadCount: 0 }, true), "Add a lead sheet before you start.");
  assert.equal(C.formProblem({ ...ok, seatCount: 0 }, true), "Pick at least one caller before you start.");
});

test("addedText sums up an upload", () => {
  assert.equal(C.addedText({ added: 220, bad_numbers: 12, repeats: 8, other_skipped: 0 }), "220 leads added. 12 bad numbers, 8 repeats skipped.");
  assert.equal(C.addedText({ added: 1 }), "1 lead added.");
});

// ----- static checks -----
test("the Campaigns tab builds DOM without HTML strings and keeps its CSS under .tab-campaigns", () => {
  const root = path.join(__dirname, "..", "..");
  const js = fs.readFileSync(path.join(root, "web", "js", "admin", "campaigns.js"), "utf8");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(js));
  assert.ok(!/select\(\s*['"]\*['"]\s*\)/.test(js), "no select('*')");
  assert.ok(!/amount_due['"]?\s*[,)]/.test(js.replace(/amount_due_total|amount_due:|'amount_due'/g, "")), "no direct amount_due reads");
  const css = fs.readFileSync(path.join(root, "web", "css", "admin-campaigns.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{/g, "");
  const selectors = css.split("}").map((r) => r.split("{")[0].trim()).filter(Boolean);
  selectors.forEach((sel) => sel.split(",").forEach((one) => {
    const s = one.trim();
    assert.ok(s.startsWith(".tab-campaigns") || s.startsWith("#camp-"), "unscoped rule: " + s);
  }));
  const html = fs.readFileSync(path.join(root, "web", "admin.html"), "utf8");
  assert.ok(html.indexOf("js/lead-upload.js") < html.indexOf("js/admin/campaigns.js"));
  assert.ok(html.indexOf("js/import-check.js") < html.indexOf("js/lead-upload.js"));
});
