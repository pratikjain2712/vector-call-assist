const test = require("node:test");
const assert = require("node:assert/strict");
const LeadList = require("../../web/js/lead-list.js");

// Columns: 0 name, 1 phone, 2 outcome, 3 callback date
const COLS = { name: 0, phone: 1, outcome: 2, callback: 3 };
const TODAY = "2026-10-12";
const rows = [
  ["Asha Verma", "9876543210", "", ""],              // 0 new
  ["Ravi Kumar", "09123456789", "Enrolling", ""],   // 1 called, nothing due
  ["Meena Iyer", "9000011122", "Callback", "2026-10-10"], // 2 overdue callback
  ["Dev Shah", "9988776655", "Callback", "2026-10-12"],   // 3 due today
  ["Priya Nair", "8111122233", "", ""],             // 4 new
  ["Sam Lee", "7000011122", "Not this time", "2026-10-20"], // 5 called, callback in future
];

test("search matches part of the name, ignoring case", () => {
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { query: "ASHA" }, TODAY), [0]);
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { query: "  iyer " }, TODAY), [2]);
});

test("search matches the number, with or without +91 or a leading 0", () => {
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { query: "9123456" }, TODAY), [1]);
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { query: "09123456" }, TODAY), [1]);
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { query: "+91 98765" }, TODAY), [0]);
});

test("a short digit query does not match numbers", () => {
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { query: "98" }, TODAY), []);
});

test("status filters: called, not called, callback due", () => {
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { status: "not_called" }, TODAY), [0, 4]);
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { status: "called" }, TODAY), [1, 2, 3, 5]);
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { status: "due" }, TODAY), [2, 3]);
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { status: "all" }, TODAY), [0, 1, 2, 3, 4, 5]);
});

test("search combines with a status filter", () => {
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { status: "due", query: "dev" }, TODAY), [3]);
  assert.deepEqual(LeadList.filterLeads(rows, COLS, { status: "not_called", query: "dev" }, TODAY), []);
});

test("daily queue: due callbacks first (earliest date first), then new leads that were never called", () => {
  assert.deepEqual(LeadList.dailyQueue(rows, COLS, TODAY), [2, 3, 0, 4]);
});

test("a called lead with no due callback is not in the queue", () => {
  const q = LeadList.dailyQueue(rows, COLS, TODAY);
  assert.equal(q.includes(1), false);
  assert.equal(q.includes(5), false);
});

test("queue order follows the date, not the sheet order, among due callbacks", () => {
  const r = [
    ["A", "1", "Callback", "2026-10-12"],
    ["B", "2", "Callback", "2026-10-09"],
    ["C", "3", "", ""],
    ["D", "4", "Callback", "2026-10-11"],
  ];
  assert.deepEqual(LeadList.dailyQueue(r, COLS, TODAY), [1, 3, 0, 2]);
});

test("the queue moves on: a lead whose callback falls due tomorrow appears then", () => {
  assert.deepEqual(LeadList.dailyQueue(rows, COLS, "2026-10-20"), [2, 3, 5, 0, 4]);
});

test("a malformed callback date is ignored", () => {
  const r = [["X", "1", "Callback", "12/10/2026"]];
  assert.deepEqual(LeadList.dailyQueue(r, COLS, TODAY), []);
});

test("status line per lead", () => {
  assert.equal(LeadList.statusOf(rows[2], COLS, TODAY).kind, "due");
  assert.equal(LeadList.statusOf(rows[3], COLS, TODAY).label, "Callback due today");
  assert.equal(LeadList.statusOf(rows[1], COLS, TODAY).label, "Called: Enrolling");
  assert.equal(LeadList.statusOf(rows[0], COLS, TODAY).kind, "new");
});

test("todayIso uses the local calendar date", () => {
  assert.equal(LeadList.todayIso(new Date(2026, 9, 5, 23, 59)), "2026-10-05");
});

test("a No answer with no callback date stays in Today's queue until a final outcome", () => {
  const r = [
    ["Ana", "1", "No answer", ""],             // 0 retry
    ["Ben", "2", "No answer", "2026-10-20"],   // 1 callback later: not in the queue
    ["Cy", "3", "Enrolling", ""],              // 2 final outcome: not in the queue
    ["Dee", "4", "", ""],                      // 3 new
    ["Eli", "5", "Callback", "2026-10-11"],    // 4 due
  ];
  assert.deepEqual(LeadList.dailyQueue(r, COLS, TODAY), [4, 0, 3]);
  assert.deepEqual(LeadList.filterLeads(r, COLS, { status: "queue" }, TODAY), [4, 0, 3]);
  assert.deepEqual(LeadList.filterLeads(r, COLS, { status: "due" }, TODAY), [4]);
  assert.equal(LeadList.statusOf(r[0], COLS, TODAY).label, "No answer, to try again");
});
