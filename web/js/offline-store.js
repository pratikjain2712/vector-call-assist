/* Campaign calling offline: a copy of the caller's queue and the results not sent yet, in IndexedDB
   (database "vector-caller", store "kv"; never localStorage), and the outbox that sends saved results with
   save_call_result(). A saved result is never dropped: it stays in the outbox until the server has it (sent,
   or answered "already saved"), and a result the server refuses moves to a "could not save" list that the
   caller sees. The outbox logic is pure (tested in tests/web/offline-store.test.js); the store is a thin
   IndexedDB wrapper that falls back to memory when IndexedDB is blocked.

   Outbox item: { id (client_record_id), seatId, campaignId, leadId, leadName, label, savedAt, callId,
                  result: { key, needs_date, needs_amount }, values, args (save_call_result arguments) } */
(function (root) {
  // ---- Outbox: pure functions over a list of items ----

  /* Adds an item once (by id). Returns the new list. */
  function add(list, item) {
    const l = Array.isArray(list) ? list : [];
    return l.some((x) => x.id === item.id) ? l.slice() : l.concat([item]);
  }

  /* What an error from the server means for one item:
     stop  - no network, login expired or seat not active: keep every item and try later;
     park  - the server refused this result (bad input, lead no longer reachable): keep it aside, go on. */
  function classify(error) {
    if (!error) return "ok";
    const code = String(error.code || "");
    const msg = String(error.message || "");
    if (!code) return "stop";
    if (code === "PGRST301" || /jwt|token/i.test(msg)) return "stop";
    if (code === "42501" && /seat/i.test(msg)) return "stop";
    if (code === "PGRST202" || code === "42883") return "stop";   // the function is not on the server yet
    if (/^(5|08|53|57)/.test(code)) return "stop";                 // server or connection trouble
    return "park";
  }

  /* Sends items oldest first with send(item) -> Promise<{ data, error }>. ready(item) may return false to
     leave an item for a later pass (a laptop call still waiting for the phone's call log) and may return an
     item with filled-in arguments. Resolves { pending, failed, sent, stopped, error }: pending is what is
     left to send, failed what the server refused (added to the failed list given), sent the items stored. */
  async function sync(list, failedList, send, ready) {
    const pending = [];
    const failed = (failedList || []).slice();
    const sent = [];
    let stopped = false, lastError = null;
    const items = (list || []).slice().sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    for (const raw of items) {
      if (stopped) { pending.push(raw); continue; }
      const item = ready ? ready(raw) : raw;
      if (!item) { pending.push(raw); continue; }
      let res;
      try { res = await send(item); } catch (e) { res = { error: { message: (e && e.message) || "Network error" } }; }
      const kind = classify(res && res.error);
      if (kind === "ok") { sent.push(Object.assign({}, item, { response: res.data })); continue; }
      lastError = res.error;
      if (kind === "stop") { stopped = true; pending.push(raw); continue; }
      failed.push(Object.assign({}, item, { error: res.error.message || String(res.error.code) }));
    }
    return { pending, failed, sent, stopped, error: lastError };
  }

  // ---- Store: IndexedDB key-value, in memory when IndexedDB cannot be opened ----

  const DB_NAME = "vector-caller";
  const STORE = "kv";
  const mem = {};
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      try {
        const req = root.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch (e) {} };
        req.onsuccess = () => done(req.result);
        req.onerror = () => done(null);
        req.onblocked = () => done(null);
      } catch (e) { done(null); }
    });
    return dbp;
  }

  async function get(key) {
    if (Object.prototype.hasOwnProperty.call(mem, key)) return mem[key];
    const db = await open();
    if (!db) return null;
    const v = await new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    if (!Object.prototype.hasOwnProperty.call(mem, key)) mem[key] = v;
    return mem[key];
  }

  /* Resolves true when saved in IndexedDB, false when kept in memory only. value undefined removes it. */
  async function set(key, value) {
    if (value === undefined) delete mem[key]; else mem[key] = value;
    const db = await open();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        if (value === undefined) store.delete(key); else store.put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  const api = { add, classify, sync, get, set, keys: {
    outbox: (seat) => "outbox:" + seat,
    failed: (seat) => "failed:" + seat,
    queue: (seat, campaign) => "queue:" + seat + ":" + campaign,
    campaigns: (seat) => "campaigns:" + seat,
  } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.OfflineStore = api;
})(typeof window !== "undefined" ? window : globalThis);
