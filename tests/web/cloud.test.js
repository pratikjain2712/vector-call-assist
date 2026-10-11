// Tests for web/js/cloud.js: flush, retry, dedupe and cancel. localStorage and the Supabase client are stubs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "../../web/js/cloud.js"), "utf8");
const SEAT = { id: "seat-1", institute_id: "inst-1", user_id: "u1", label: "Desk 1", role: "rep" };
const SESSION = { user: { id: "u1", email: "rep@example.org" } };

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

/* upsert: async (row, opts) => { error?: {...} } . Every call is recorded in client.upserts. */
function load({ upsert, seatRow = SEAT, enabled = true, rpc } = {}) {
  const storage = memoryStorage();
  const client = {
    upserts: [],
    listener: null,
    auth: {
      onAuthStateChange(fn) { client.listener = fn; },
      signInWithOtp: async () => ({ error: null }),
      signOut: async () => ({}),
    },
    rpc: rpc || (async () => ({ data: seatRow ? [seatRow] : [], error: null })),
    from: () => ({
      upsert: async (row, opts) => {
        client.upserts.push({ id: row.id, opts });
        return upsert ? upsert(row, opts) : { error: null };
      },
    }),
  };
  const ctx = {
    console,
    setTimeout,
    localStorage: storage,
    location: { origin: "https://example.org", pathname: "/" },
    setInterval: () => 0,
    VECTOR_CONFIG: enabled ? { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" } : {},
    supabase: { createClient: () => client },
    addEventListener: () => {},
  };
  ctx.window = ctx;
  vm.runInNewContext(SRC, ctx);
  return { Cloud: ctx.window.Cloud, client, storage };
}

const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function signIn(h) {
  await h.Cloud.init();
  h.client.listener("SIGNED_IN", SESSION);
  await wait();
}

const row = (id, extra) => Object.assign({
  id, client_record_id: "call-" + id, script_id: "vector-2.0-sales", script_version: 1,
  outcome: "won", dialled_at: "2026-10-12T10:00:00.000Z", connected_seconds: 42,
}, extra || {});

const queued = (h) => JSON.parse(h.storage.getItem("vca2-cloud-queue") || "[]");
const failedRows = (h) => JSON.parse(h.storage.getItem("vca2-cloud-failed") || "[]");

test("with no Supabase config, sync is off and nothing is queued", async () => {
  const h = load({ enabled: false });
  await h.Cloud.init();
  assert.equal(h.Cloud.enabled, false);
  assert.equal(h.Cloud.info().status, "off");
  assert.equal(h.Cloud.enqueue(row("a")), false);
  assert.equal(h.client.upserts.length, 0);
});

test("flush uploads a queued row once, with the conflict key, and empties the queue", async () => {
  const h = load();
  await signIn(h);
  assert.equal(h.Cloud.info().status, "ready");
  assert.equal(h.Cloud.enqueue(row("a")), true);
  await wait();
  assert.equal(h.client.upserts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.client.upserts[0].opts)), { onConflict: "seat_id,client_record_id", ignoreDuplicates: true });
  assert.equal(queued(h).length, 0);
  assert.equal(h.Cloud.info().pending, 0);
  assert.equal(h.Cloud.info().status, "ready");
});

test("the queued row carries the seat and institute it was made under", async () => {
  let sent = null;
  const h = load({ upsert: async (r) => { sent = r; return { error: null }; } });
  await signIn(h);
  h.Cloud.enqueue(row("a"));
  await wait();
  assert.equal(sent.seat_id, "seat-1");
  assert.equal(sent.institute_id, "inst-1");
});

test("dedupe: a row already uploaded is not uploaded twice", async () => {
  const h = load();
  await signIn(h);
  h.Cloud.enqueue(row("a"));
  await wait();
  assert.equal(h.client.upserts.length, 1);
  h.Cloud.enqueue(row("a"));            // same row again, after the upload
  await wait();
  assert.equal(h.client.upserts.length, 1);
  assert.equal(queued(h).length, 0);
});

test("dedupe: the same call (seat and client_record_id) queued twice is sent once", async () => {
  const h = load();
  await signIn(h);
  // Upload is held so the second enqueue happens while the first is still waiting.
  let release;
  h.client.from = () => ({
    upsert: (r) => { h.client.upserts.push({ id: r.id }); return new Promise((res) => { release = () => res({ error: null }); }); },
  });
  h.Cloud.enqueue(row("a"));
  await wait(5);
  h.Cloud.enqueue(row("b", { client_record_id: "call-a" }));
  assert.equal(queued(h).length, 1);
  release();
  await wait();
  assert.equal(h.client.upserts.length, 1);
});

test("retry: a network error keeps the row queued, marks offline, and a later flush sends it once", async () => {
  let fail = true;
  const h = load({ upsert: async () => (fail ? { error: { message: "TypeError: Failed to fetch" } } : { error: null }) });
  await signIn(h);
  h.Cloud.enqueue(row("a"));
  await wait();
  assert.equal(queued(h).length, 1, "row stays queued");
  assert.equal(failedRows(h).length, 0, "not parked as invalid");
  assert.equal(h.Cloud.info().status, "offline");
  assert.equal(h.Cloud.info().pending, 1);
  fail = false;
  await h.Cloud.flush();
  await wait();
  assert.equal(queued(h).length, 0);
  assert.equal(h.client.upserts.length, 2, "tried twice, uploaded once");
  assert.equal(h.Cloud.info().status, "ready");
});

test("a thrown error (no response at all) is also a network error and keeps the row", async () => {
  let fail = true;
  const h = load({ upsert: async () => { if (fail) throw new Error("socket hang up"); return { error: null }; } });
  await signIn(h);
  h.Cloud.enqueue(row("a"));
  await wait();
  assert.equal(queued(h).length, 1);
  assert.equal(h.Cloud.info().status, "offline");
  fail = false;
  await h.Cloud.flush();
  await wait();
  assert.equal(queued(h).length, 0);
});

test("a row the server rejects is parked, and the rows after it still upload", async () => {
  const h = load({
    upsert: async (r) => (r.id === "bad" ? { error: { code: "22P02", message: "invalid input" } } : { error: null }),
  });
  await signIn(h);
  h.Cloud.enqueue(row("bad"));
  h.Cloud.enqueue(row("good"));
  await wait();
  assert.equal(queued(h).length, 0);
  assert.equal(failedRows(h).length, 1);
  assert.equal(failedRows(h)[0].row.id, "bad");
  assert.deepEqual(h.client.upserts.map((u) => u.id), ["bad", "good"]);
});

test("a revoked seat (42501) stops the flush, keeps the rows, and shows no_seat", async () => {
  const h = load({ upsert: async () => ({ error: { code: "42501", message: "permission denied" } }) });
  await signIn(h);
  h.Cloud.enqueue(row("a"));
  h.Cloud.enqueue(row("b"));
  await wait();
  assert.equal(h.Cloud.info().status, "no_seat");
  assert.equal(queued(h).length, 2);
  assert.equal(h.client.upserts.length, 1, "stops at the first refusal");
});

test("a row added while an upload is in flight is not lost", async () => {
  const h = load();
  await signIn(h);
  const pending = [];
  h.client.from = () => ({
    upsert: (r) => { h.client.upserts.push({ id: r.id }); return new Promise((res) => pending.push(() => res({ error: null }))); },
  });
  h.Cloud.enqueue(row("first"));
  await wait(5);
  h.Cloud.enqueue(row("second"));        // queued while "first" is still uploading
  pending.shift()();                      // "first" finishes
  await wait(5);
  pending.shift()();                      // "second" finishes
  await wait();
  assert.deepEqual(h.client.upserts.map((u) => u.id), ["first", "second"]);
  assert.equal(queued(h).length, 0);
});

test("rows for another seat wait in the queue and are not uploaded", async () => {
  const h = load();
  await signIn(h);
  const other = Object.assign(row("other"), { seat_id: "seat-9", institute_id: "inst-1" });
  const q = [other];
  h.storage.setItem("vca2-cloud-queue", JSON.stringify(q));
  await h.Cloud.flush();
  await wait();
  assert.equal(h.client.upserts.length, 0);
  assert.equal(queued(h).length, 1);
});

test("cancel (undo) removes a queued row before it uploads", async () => {
  const h = load({ upsert: async () => ({ error: { message: "Failed to fetch" } }) });   // keep it queued
  await signIn(h);
  h.Cloud.enqueue(row("a"));
  await wait();
  assert.equal(queued(h).length, 1);
  assert.equal(h.Cloud.cancel(["a"]), true);
  assert.equal(queued(h).length, 0);
});

test("cancel refuses a row that already uploaded, and removes nothing", async () => {
  const h = load();
  await signIn(h);
  h.Cloud.enqueue(row("a"));
  await wait();
  assert.equal(h.Cloud.cancel(["a"]), false);
  assert.equal(h.client.upserts.length, 1);
});

test("cancel refuses a row that is uploading right now", async () => {
  const h = load();
  await signIn(h);
  let release;
  h.client.from = () => ({
    upsert: (r) => { h.client.upserts.push({ id: r.id }); return new Promise((res) => { release = () => res({ error: null }); }); },
  });
  h.Cloud.enqueue(row("a"));
  await wait(5);
  assert.equal(h.Cloud.cancel(["a"]), false);
  release();
  await wait();
  assert.equal(h.client.upserts.length, 1);
});

/* The invited seat is claimed once per sign-in, before the seat is read. */
const claimRpc = (calls, claimResult) => async (name) => {
  calls.push(name);
  if (name === "claim_my_invite") return claimResult();
  return { data: [SEAT], error: null };
};

test("sign-in claims the invited seat once, before reading the seat; 'no invitation' is ignored", async () => {
  const calls = [];
  const h = load({ rpc: claimRpc(calls, async () => ({ data: null, error: { code: "P0001", message: "no invitation found for this email" } })) });
  await signIn(h);
  h.client.listener("TOKEN_REFRESHED", SESSION);
  await wait();
  assert.equal(calls[0], "claim_my_invite");
  assert.equal(calls.filter((n) => n === "claim_my_invite").length, 1);
  assert.equal(h.Cloud.info().status, "ready");
});

test("a network failure on the claim is tried again on the next session change", async () => {
  const calls = [];
  let first = true;
  const h = load({ rpc: claimRpc(calls, async () => {
    if (first) { first = false; return { data: null, error: { message: "Failed to fetch" } }; }
    return { data: "seat-9", error: null };
  }) });
  await signIn(h);
  assert.equal(calls.filter((n) => n === "claim_my_invite").length, 1);
  h.client.listener("TOKEN_REFRESHED", SESSION);
  await wait();
  assert.equal(calls.filter((n) => n === "claim_my_invite").length, 2);
  h.client.listener("TOKEN_REFRESHED", SESSION);
  await wait();
  assert.equal(calls.filter((n) => n === "claim_my_invite").length, 2);
});

test("sign-out clears the claim, so the next sign-in claims again", async () => {
  const calls = [];
  const h = load({ rpc: claimRpc(calls, async () => ({ data: "seat-9", error: null })) });
  await signIn(h);
  h.client.listener("SIGNED_OUT", null);
  await wait();
  h.client.listener("SIGNED_IN", SESSION);
  await wait();
  assert.equal(calls.filter((n) => n === "claim_my_invite").length, 2);
});

test("with no Supabase config, nothing is claimed", async () => {
  const calls = [];
  const h = load({ enabled: false, rpc: claimRpc(calls, async () => ({ data: null, error: null })) });
  await h.Cloud.init();
  assert.equal(calls.length, 0);
});
