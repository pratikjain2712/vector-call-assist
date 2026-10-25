// Phase A.2: caller. The campaign picker (grouping and filters), placeholder filling, and the common answers
// (web/js/campaign-picker.js, web/js/placeholders.js, web/js/common-answers.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Picker = require("../../web/js/campaign-picker.js");
const P = require("../../web/js/placeholders.js");
const Common = require("../../web/js/common-answers.js");

const root = path.join(__dirname, "..", "..");

// ---- Campaign picker ----

const LIST = [
  { campaign_id: "a", name: "Admissions 2027", call_type_key: "admission", class_label: "LKG", board: null, my_leads_due: 2, pool_leads_due: 5 },
  { campaign_id: "f8c", name: "Term 2 fees", call_type_key: "fees", class_label: "8th", board: "CBSE", my_leads_due: 1, pool_leads_due: 11 },
  { campaign_id: "f8i", name: "Term 2 fees", call_type_key: "fees", class_label: "8th", board: "ICSE", my_leads_due: 0, pool_leads_due: 0 },
  { campaign_id: "f10", name: "Term 2 fees", call_type_key: "fees", class_label: "10th", board: "cbse", my_leads_due: null },
  { campaign_id: "s", name: "Spoken English", call_type_key: "sales", class_label: null, board: null, my_leads_due: 3 },
  { campaign_id: "e", name: "PTM reminder", call_type_key: "event", class_label: "8th", board: "CBSE", my_leads_due: 0, pool_leads_due: 4 },
  { campaign_id: "r", name: "Renewal", call_type_key: "renewal", class_label: null, board: null },
];
const ids = (list) => list.map((c) => c.campaign_id);

test("picker: purposes come from the call type; anything other than fees, admission and sales is Others", () => {
  assert.equal(Picker.purposeOf({ call_type_key: "fees" }), "fees");
  assert.equal(Picker.purposeOf({ call_type_key: "admission" }), "admissions");
  assert.equal(Picker.purposeOf({ call_type_key: "sales" }), "sales");
  assert.equal(Picker.purposeOf({ call_type_key: "absence" }), "others");
  assert.equal(Picker.purposeOf({}), "others");
});

test("picker: groups in the order Fees, Admissions, Sales, Others, keeping the server's order inside a group", () => {
  const g = Picker.groups(LIST);
  assert.deepEqual(g.map((x) => x.purpose), ["fees", "admissions", "sales", "others"]);
  assert.deepEqual(ids(g[0].campaigns), ["f8c", "f8i", "f10"]);
  assert.deepEqual(ids(g[3].campaigns), ["e", "r"]);
  assert.deepEqual(Picker.groups(LIST.filter((c) => c.call_type_key === "sales")).map((x) => x.purpose), ["sales"]);
  assert.deepEqual(Picker.groups([]), []);
});

test("picker: filter choices are the tags in use, classes in school order, boards without case duplicates", () => {
  const o = Picker.options(LIST);
  assert.deepEqual(o.purposes, ["fees", "admissions", "sales", "others"]);
  assert.deepEqual(o.classes, ["LKG", "8th", "10th"]);
  assert.deepEqual(o.boards, ["CBSE", "ICSE"]);
});

test("picker: filters by purpose, class and board together; untagged campaigns do not match a tag filter", () => {
  assert.deepEqual(ids(Picker.filter(LIST, { class_label: "8th" })), ["f8c", "f8i", "e"]);
  assert.deepEqual(ids(Picker.filter(LIST, { class_label: "8th", purpose: "fees" })), ["f8c", "f8i"]);
  assert.deepEqual(ids(Picker.filter(LIST, { class_label: "8TH", purpose: "fees", board: "cbse" })), ["f8c"]);
  assert.deepEqual(ids(Picker.filter(LIST, { board: "CBSE" })), ["f8c", "f10", "e"]);
  assert.deepEqual(ids(Picker.filter(LIST, { purpose: "", class_label: "", board: "" })), ids(LIST));
  assert.deepEqual(ids(Picker.filter(LIST, { purpose: "sales", board: "ICSE" })), []);
});

test("picker: waiting = own due leads plus the pool; tag line; a saved filter is checked against the choices", () => {
  assert.equal(Picker.waiting(LIST[1]), 12);
  assert.equal(Picker.waiting(LIST[3]), 0);
  assert.equal(Picker.waiting({ my_leads_due: -2, pool_leads_due: "3" }), 3);
  assert.equal(Picker.tagLine(LIST[1]), "8th · CBSE");
  assert.equal(Picker.tagLine(LIST[4]), "");
  const o = Picker.options(LIST);
  assert.deepEqual(Picker.validFilter({ purpose: "fees", class_label: "8TH", board: "IB" }, o), { purpose: "fees", class_label: "8th", board: "" });
  assert.deepEqual(Picker.validFilter(null, o), { purpose: "", class_label: "", board: "" });
  assert.deepEqual(Picker.validFilter({ purpose: "nope" }, o).purpose, "");
});

// ---- Placeholders ----

const LEAD = {
  name: "Sunita Sharma", created_at: "2026-10-20T05:00:00Z",
  extra: { Student: "Aarav", class: "Class 8th", source: "the enquiry form on our website", enquiry_date: "12/10/2026", course_name: "Spoken English" },
};
const vals = P.values({ me: "Priya Shah", institute: "Sunrise Public School", lead: LEAD, campaign: { board: "CBSE", class_label: "9th", fees_due_by: "2026-10-31" },
  money: { amount_due: 18000, money_hidden: false } });

test("placeholders: values from the lead, its extra fields, the campaign, the money and the institute", () => {
  assert.deepEqual(vals, {
    name: "Sunita Sharma", me: "Priya", institute: "Sunrise Public School", student: "Aarav", class: "8th", board: "CBSE",
    amount_due: "₹18,000", due_date: "31 October", course: "Spoken English", source: "the enquiry form on our website", source_date: "12 October",
  });
});

test("placeholders: the ledger balance stands in for the amount; hidden money fills nothing; the date added is the source date", () => {
  const v = P.values({ lead: { name: "X", created_at: "2026-10-20T05:00:00Z", extra: { source: "a webinar" } }, ledger: { balance_due_now: 6500.5 } });
  assert.equal(v.amount_due, "₹6,500.5");
  assert.equal(v.source_date, "20 October");
  assert.equal(P.values({ money: { amount_due: 100, money_hidden: true } }).amount_due, "");
  assert.equal(P.values({ ledger: { balance_due_now: 0 } }).amount_due, "");
  assert.equal(P.values({ ledger: { balance_due_now: 500, money_hidden: true } }).amount_due, "");
});

test("placeholders: every placeholder is filled when known", () => {
  const line = "Hi {name}, this is {me} from {institute}. {student} in {class} class, the {board} board: {amount_due} by {due_date}. " +
    "Our {course} course. We got your number from {source}, on {source_date}.";
  assert.equal(P.fill(line, vals), "Hi Sunita Sharma, this is Priya from Sunrise Public School. Aarav in 8th class, the CBSE board: ₹18,000 by 31 October. " +
    "Our Spoken English course. We got your number from the enquiry form on our website, on 12 October.");
});

test("placeholders: a missing value never shows braces; the words around it go too", () => {
  const cases = [
    ["Thank you, {name}!", "Thank you!"],
    ["Hello, am I speaking with {name}?", "Hello, am I speaking with the right person?"],
    ["This is {me} from {institute}.", "This is calling from our institute."],
    ["I am calling about {student}'s fee.", "I am calling about your child's fee."],
    ["Thank you for your enquiry about admission in {class} class.", "Thank you for your enquiry about admission."],
    ["We follow the {board} board.", "We follow our board."],
    ["The fee of {amount_due} was due on {due_date}.", "The fee was due."],
    ["The fee for the new term is {amount_due}, due by {due_date}.", "The fee for the new term is the amount due."],
    ["You had asked about our {course} course through {source}.", "You had asked about our course."],
    ["Thank you for joining {source} on {source_date}.", "Thank you for joining us."],
    ["Odd {unknown} token.", "Odd token."],
  ];
  for (const [line, want] of cases) assert.equal(P.fill(line, {}), want, line);
  for (const [line] of cases) assert.ok(!/[{}]/.test(P.fill(line, {})), line);
});

test("placeholders: an answer's fallback is used when any of its placeholders is missing", () => {
  const answer = "We got your number from {source}, on {source_date}. Shall I stop the calls?";
  const fallback = "I am sorry, I do not have that detail in front of me.";
  assert.equal(P.fill(answer, vals, { fallback }), "We got your number from the enquiry form on our website, on 12 October. Shall I stop the calls?");
  assert.equal(P.fill(answer, { source: "a fair" }, { fallback }), fallback);
  assert.equal(P.fill("No placeholders here.", {}, { fallback }), "No placeholders here.");
  assert.deepEqual(P.missing(answer, { source: "x" }), ["source_date"]);
});

test("placeholders: parts for drawing; {name} and {me} with no value become hints", () => {
  assert.deepEqual(P.parts("Hi {name}, this is {me} from {institute}.", { me: "Priya", institute: "" }, { hints: true }), [
    { text: "Hi " }, { key: "name", hint: "lead's name" }, { text: ", this is " }, { key: "me", value: "Priya" }, { text: " from our institute." },
  ]);
  assert.deepEqual(P.parts("Thank you, {name}!", {}), [{ text: "Thank you!" }]);
});

test("placeholders: dates in ISO, dd/mm/yyyy and words; source line keys", () => {
  assert.equal(P.dateText("2026-10-05", true), "5 Oct");
  assert.equal(P.dateText("05/11/2026", false), "5 November");
  assert.equal(P.dateText("12 Oct 2026", true), "12 Oct");
  assert.equal(P.dateText("last week", true), "last week");
  assert.deepEqual(P.sourceOf(LEAD), { source: "the enquiry form on our website", date: "12 Oct", longDate: "12 October" });
  assert.ok(P.isSourceKey("Lead_Source") && P.isSourceKey("enquiry date") && !P.isSourceKey("student"));
});

// ---- Common answers ----

const STATIC = JSON.parse(fs.readFileSync(path.join(root, "web", "data", "common_answers.json"), "utf8"));

test("common answers: the page's static copy is the same as supabase/templates/common_answers.json", () => {
  const a = fs.readFileSync(path.join(root, "web", "data", "common_answers.json"), "utf8");
  const b = fs.readFileSync(path.join(root, "supabase", "templates", "common_answers.json"), "utf8");
  assert.equal(a, b);
});

test("common answers: answers with a check stay hidden in the static copy; the call type picks the rest", () => {
  const list = Common.normalize(STATIC, false);
  assert.equal(list.length, STATIC.length);
  const hidden = list.filter((a) => a.hidden).map((a) => a.key).sort();
  assert.deepEqual(hidden, STATIC.filter((a) => Array.isArray(a.check) && a.check.length).map((a) => a.key).sort());
  const fees = Common.visible(list, "fees").map((a) => a.key);
  assert.ok(fees.includes("where_number") && fees.includes("do_not_call"));
  assert.ok(!fees.includes("sales_call"), "sales_call is for sales, admission and renewal");
  assert.ok(!fees.includes("fee_amount"), "hidden until filled");
  assert.ok(Common.visible(list, "sales").map((a) => a.key).includes("sales_call"));
  assert.ok(!Common.visible(list, null).map((a) => a.key).includes("joined_elsewhere"));
  const dnc = list.find((a) => a.key === "do_not_call");
  assert.equal(dnc.result, "do_not_call");
  assert.ok(list.find((a) => a.key === "where_number").fallback);
});

test("common answers: the database copy shows a checked answer once it is filled", () => {
  const rows = [
    { key: "location", label: "Where is the institute?", answer: "Near the bus stand.", tags: ["all"], check: ["Add your address."], filled: true },
    { key: "fee_amount", label: "How much is the fee?", answer: "Let me tell you.", tags: ["all"], check: ["Fee list."] },
    { key: "discount", label: "Is there a discount?", answer: "No discount now.", tags: ["all"], check: [] },
    { key: "", label: "No key", answer: "x", tags: ["all"] },
    { key: "location", label: "Duplicate", answer: "y", tags: ["all"] },
  ];
  const list = Common.normalize(rows, true);
  assert.deepEqual(list.map((a) => [a.key, a.hidden]), [["location", false], ["fee_amount", true], ["discount", false]]);
  assert.equal(Common.normalize(rows.slice(0, 1), false)[0].hidden, true, "the static copy never says filled");
});

test("common answers: as search items, a label the script already answers is skipped", () => {
  const list = Common.visible(Common.normalize(STATIC, false), "fees");
  const items = Common.asItems(list, ["where did you get my number?"]);
  assert.ok(!items.some((i) => i.chip === "Where did you get my number?"));
  const dnc = items.find((i) => i.key === "c:do_not_call");
  assert.equal(dnc.chip, "Do not call me again");
  assert.equal(dnc.result, "do_not_call");
  assert.equal(dnc.common, true);
});
