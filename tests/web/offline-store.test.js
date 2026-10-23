// Tests for the outbox in web/js/offline-store.js: saved results are sent once, in order, and never lost.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../web/js/offline-store.js");

const item = (id, savedAt, extra) => Object.assign({ id, savedAt, leadId: "l-" + id, args: { p_client_record_id: id } }, extra);

test("an item is added once", () => {
  let l = S.add([], item("a", 1));
  l = S.add(l, item("a", 1));
  l = S.add(l, item("b", 2));
  assert.deepEqual(l.map((x) => x.id), ["a", "b"]);
});

test("errors: network and login trouble stop the pass; a refused result is parked", () => {
  assert.equal(S.classify(null), "ok");
  assert.equal(S.classify({ message: "Failed to fetch" }), "stop");
  assert.equal(S.classify({ code: "PGRST301", message: "JWT expired" }), "stop");
  assert.equal(S.classify({ code: "42501", message: "no active seat for this login" }), "stop");
  assert.equal(S.classify({ code: "PGRST202", message: "Could not find the function" }), "stop");
  assert.equal(S.classify({ code: "503", message: "unavailable" }), "stop");
  assert.equal(S.classify({ code: "42501", message: "lead not found" }), "park");
  assert.equal(S.classify({ code: "23514", message: "Paid needs an amount" }), "park");
  assert.equal(S.classify({ code: "22023", message: "rating must be 1 to 5" }), "park");
});

test("sync sends oldest first and keeps nothing that was stored", async () => {
  const seen = [];
  const r = await S.sync([item("b", 2), item("a", 1)], [], async (it) => { seen.push(it.id); return { data: { outcome_id: "o-" + it.id } }; });
  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.sent.map((x) => x.id), ["a", "b"]);
  assert.equal(r.sent[0].response.outcome_id, "o-a");
  assert.equal(r.stopped, false);
});

test("offline: the first network error stops the pass and every item stays", async () => {
  let calls = 0;
  const r = await S.sync([item("a", 1), item("b", 2), item("c", 3)], [], async (it) => {
    calls++;
    if (it.id === "a") return { data: {} };
    throw new Error("Failed to fetch");
  });
  assert.equal(calls, 2, "c is not tried after b failed");
  assert.deepEqual(r.sent.map((x) => x.id), ["a"]);
  assert.deepEqual(r.pending.map((x) => x.id), ["b", "c"]);
  assert.equal(r.stopped, true);
});

test("a refused result is parked with its reason and the rest still go", async () => {
  const r = await S.sync([item("a", 1), item("b", 2)], [item("old", 0, { error: "x" })], async (it) =>
    (it.id === "a" ? { error: { code: "23514", message: "Paid needs an amount" } } : { data: {} }));
  assert.deepEqual(r.failed.map((x) => [x.id, x.error]), [["old", "x"], ["a", "Paid needs an amount"]]);
  assert.deepEqual(r.sent.map((x) => x.id), ["b"]);
  assert.deepEqual(r.pending, []);
});

test("an item that is not ready waits for a later pass; ready can fill in arguments", async () => {
  const sentArgs = [];
  const r = await S.sync([item("a", 1, { callId: "s1" }), item("b", 2)], [],
    async (it) => { sentArgs.push(it.args); return { data: {} }; },
    (it) => (it.id === "a" ? null : Object.assign({}, it, { args: Object.assign({}, it.args, { p_connected_seconds: 40 }) })));
  assert.deepEqual(r.pending.map((x) => x.id), ["a"]);
  assert.equal(sentArgs[0].p_connected_seconds, 40);
});

test("sending twice is safe: the server's 'already saved' answer counts as sent", async () => {
  const server = new Map();
  const send = async (it) => {
    const dup = server.has(it.id);
    if (!dup) server.set(it.id, it);
    return { data: { duplicate: dup } };
  };
  const first = await S.sync([item("a", 1)], [], send);
  const again = await S.sync([item("a", 1)], [], send);
  assert.equal(server.size, 1);
  assert.equal(first.sent.length, 1);
  assert.equal(again.sent[0].response.duplicate, true);
});

test("the store keeps values in memory when IndexedDB is not there", async () => {
  assert.equal(await S.set("k", { a: 1 }), false);
  assert.deepEqual(await S.get("k"), { a: 1 });
  await S.set("k", undefined);
  assert.equal(await S.get("k"), null);
  assert.equal(S.keys.outbox("seat"), "outbox:seat");
  assert.equal(S.keys.queue("seat", "camp"), "queue:seat:camp");
});
