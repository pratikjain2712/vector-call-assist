/* Browser storage for lead data and the phone link key. IndexedDB (database "vector-call-assist", store "kv")
   holds the lead sheet ("sheet"), the call records ("calls") and the link key ("link-key"). None of them is
   written to localStorage. Each value is also kept in memory for this page, so reads stay synchronous.
   If IndexedDB cannot be opened (private window, blocked site data), values live in memory until the page
   is reloaded. Read Vault.ready once before the first read after a page load. */
(function () {
  const DB_NAME = 'vector-call-assist';
  const STORE = 'kv';
  const OPEN_TIMEOUT_MS = 4000;
  // Older versions kept these in localStorage. They are moved into IndexedDB once, then removed.
  const LEGACY = { sheet: 'vca2-sheet', calls: 'vca2-calls' };
  const KEYS = ['sheet', 'calls', 'link-key'];

  const mirror = {};
  let db = null;

  function openDb() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch (e) {} };
        req.onsuccess = () => done(req.result);
        req.onerror = () => done(null);
        req.onblocked = () => done(null);
      } catch (e) { done(null); }
    });
  }

  function idbGet(key) {
    return new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  // value === undefined removes the key.
  function idbWrite(key, value) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        if (value === undefined) store.delete(key); else store.put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  function get(key) {
    return Object.prototype.hasOwnProperty.call(mirror, key) ? mirror[key] : null;
  }

  /* Resolves true when the value is saved in IndexedDB. Resolves false when it is kept in memory only. */
  function set(key, value) {
    mirror[key] = value;
    return db ? idbWrite(key, value) : Promise.resolve(false);
  }

  function remove(key) {
    delete mirror[key];
    return db ? idbWrite(key, undefined) : Promise.resolve(false);
  }

  function readLegacy(name) {
    try { const raw = localStorage.getItem(name); return raw == null ? null : JSON.parse(raw); } catch (e) { return null; }
  }

  function dropLegacy(name) {
    try { localStorage.removeItem(name); } catch (e) {}
  }

  async function init() {
    try { db = await openDb(); } catch (e) { db = null; }
    if (db) {
      for (const key of KEYS) {
        try { const stored = await idbGet(key); if (stored != null) mirror[key] = stored; } catch (e) {}
      }
    }
    for (const key of Object.keys(LEGACY)) {
      try {
        const legacyName = LEGACY[key];
        const legacy = readLegacy(legacyName);
        if (legacy == null) continue;
        if (mirror[key] == null) mirror[key] = legacy;
        if (await set(key, mirror[key])) dropLegacy(legacyName);
      } catch (e) {}
    }
  }

  window.Vault = {
    ready: init(),
    persistent: () => !!db,
    get: get,
    set: set,
    remove: remove,
  };
})();
