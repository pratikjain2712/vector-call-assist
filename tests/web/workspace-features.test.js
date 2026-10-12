// Tests for the pure parts of the workspace features: session timeout state machine, feedback length
// counting, the terms hash helper and terms acceptance check, the i18n lookup with English fallback,
// the access settings and the first-run walkthrough flag. Also guards the page against inline scripts
// and inline style attributes (content security policy). Browser storage and the cloud client are stubs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const WEB = path.join(__dirname, "../../web");
const read = (f) => fs.readFileSync(path.join(WEB, f), "utf8");

function memoryStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

/* Loads the given web/js files into one sandbox, the way the page loads them (window is the sandbox). */
function load(files) {
  const ctx = {
    console,
    crypto: webcrypto,
    TextEncoder,
    localStorage: memoryStorage(),
    setInterval: () => 0,
    setTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}

const MIN = 60 * 1000;
// Objects made inside the vm sandbox have another prototype; compare them as plain JSON.
const plain = (o) => JSON.parse(JSON.stringify(o));

// ---- i18n ----

test("i18n: English and Hindi lookup, variables, and normalize", () => {
  const { I18n } = load(["js/i18n.js"]);
  assert.equal(I18n.translate("feedback.send", "en"), "Send");
  assert.equal(I18n.translate("feedback.send", "hi"), "भेजें");
  assert.equal(I18n.translate("feedback.count", "en", { n: 5, max: 2000 }), "5 of 2000 characters");
  assert.equal(I18n.translate("feedback.count", "hi", { n: 5, max: 2000 }), "2000 में से 5 अक्षर");
  assert.equal(I18n.translate("feedback.count", "en"), "{n} of {max} characters");
  assert.equal(I18n.normalize("hi"), "hi");
  assert.equal(I18n.normalize("fr"), "en");
  assert.equal(I18n.normalize(undefined), "en");
});

test("i18n: a Hindi string missing falls back to English, and an unknown key is returned as the key", () => {
  const ctx = load(["js/i18n.js"]);
  const { I18n } = ctx;
  delete I18n.STRINGS.hi["feedback.title"];
  assert.equal(I18n.translate("feedback.title", "hi"), "Send feedback");
  assert.equal(I18n.translate("no.such.key", "hi"), "no.such.key");
  assert.equal(I18n.translate("no.such.key", "en"), "no.such.key");
});

test("i18n: every English string has a Hindi draft entry", () => {
  const { I18n } = load(["js/i18n.js"]);
  const missing = Object.keys(I18n.STRINGS.en).filter((k) => !Object.prototype.hasOwnProperty.call(I18n.STRINGS.hi, k));
  assert.deepEqual(missing, []);
});

// ---- session timeout ----

test("session timeout: warns after 30 idle minutes, signs out 5 minutes later when the cloud is on", () => {
  const { SessionTimeout: T } = load(["js/i18n.js", "js/session-timeout.js"]);
  let s = T.initial(0);
  let r = T.step(s, "tick", 30 * MIN - 1000, { canSignOut: true });
  assert.equal(r.action, null);
  r = T.step(s, "tick", 30 * MIN, { canSignOut: true });
  assert.equal(r.action, "warn");
  assert.equal(r.state.phase, "warning");
  s = r.state;
  r = T.step(s, "tick", 34 * MIN + 59 * 1000, { canSignOut: true });
  assert.equal(r.action, null, "no sign-out before the 5 minutes are up");
  r = T.step(s, "tick", 35 * MIN, { canSignOut: true });
  assert.equal(r.action, "sign-out");
  assert.equal(r.state.phase, "signed_out");
  assert.equal(T.step(r.state, "tick", 90 * MIN, { canSignOut: true }).action, null, "signed out is final until activity");
});

test("session timeout: with the cloud off, the message shows but nobody is signed out", () => {
  const { SessionTimeout: T } = load(["js/i18n.js", "js/session-timeout.js"]);
  let r = T.step(T.initial(0), "tick", 30 * MIN, { canSignOut: false });
  assert.equal(r.action, "warn");
  r = T.step(r.state, "tick", 120 * MIN, { canSignOut: false });
  assert.equal(r.action, null);
  assert.equal(r.state.phase, "warning");
});

test("session timeout: activity resets the timer, and dismisses the message while it shows", () => {
  const { SessionTimeout: T } = load(["js/i18n.js", "js/session-timeout.js"]);
  let r = T.step(T.initial(0), "activity", 20 * MIN, {});
  assert.equal(r.action, null);
  assert.equal(r.state.last, 20 * MIN);
  assert.equal(T.step(r.state, "tick", 49 * MIN, { canSignOut: true }).action, null, "30 minutes count from the last activity");
  const warned = T.step(T.initial(0), "tick", 30 * MIN, { canSignOut: true });
  const back = T.step(warned.state, "activity", 31 * MIN, { canSignOut: true });
  assert.equal(back.action, "dismiss");
  assert.equal(back.state.phase, "active");
});

test("session timeout: a laptop that slept past both periods signs out at once when the cloud is on", () => {
  const { SessionTimeout: T } = load(["js/i18n.js", "js/session-timeout.js"]);
  assert.equal(T.step(T.initial(0), "tick", 40 * MIN, { canSignOut: true }).action, "sign-out");
  assert.equal(T.step(T.initial(0), "tick", 40 * MIN, { canSignOut: false }).action, "warn");
});

// ---- feedback ----

test("feedback: counts characters, not UTF-16 units", () => {
  const { Feedback: F } = load(["js/feedback.js"]);
  assert.equal(F.count("abc"), 3);
  assert.equal(F.count("a\u{1F600}"), 2);
  assert.equal(F.count(""), 0);
  assert.equal(F.count(null), 0);
});

test("feedback: the limit is 2000 characters, and clamp cuts to it", () => {
  const { Feedback: F } = load(["js/feedback.js"]);
  assert.equal(F.MAX, 2000);
  assert.equal(F.check("x".repeat(2000)), "ok");
  assert.equal(F.check("x".repeat(2001)), "long");
  assert.equal(F.count(F.clamp("\u{1F600}".repeat(2005))), 2000);
  assert.equal(F.clamp("short"), "short");
});

test("feedback: blank messages are empty", () => {
  const { Feedback: F } = load(["js/feedback.js"]);
  assert.equal(F.check("   \n\t "), "empty");
  assert.equal(F.check(undefined), "empty");
  assert.equal(F.check(" ok "), "ok");
});

// ---- terms ----

test("terms: SHA-256 hash helper gives the standard hex digest of a string", async () => {
  const { TermsGate } = load(["js/i18n.js", "js/terms.js", "js/terms-gate.js"]);
  assert.equal(await TermsGate.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await TermsGate.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(await TermsGate.sha256Hex("abc"), await TermsGate.sha256Hex("abc"));
  assert.notEqual(await TermsGate.sha256Hex("abc"), await TermsGate.sha256Hex("abd"));
});

test("terms: the draft is versioned and marked as needing legal review", () => {
  const { TERMS } = load(["js/terms.js"]);
  assert.equal(TERMS.version, "2026-10-draft");
  assert.equal(TERMS.draft, true);
  assert.ok(TERMS.text.length > 200);
});

test("terms: an acceptance counts only for the same version, with a time", () => {
  const { TermsGate } = load(["js/i18n.js", "js/terms.js", "js/terms-gate.js"]);
  const v = "2026-10-draft";
  assert.equal(TermsGate.acceptedFor([{ terms_version: v, accepted_at: "2026-10-12T10:00:00Z" }], v), true);
  assert.equal(TermsGate.acceptedFor({ terms_version: v, accepted_at: "2026-10-12T10:00:00Z" }, v), true);
  assert.equal(TermsGate.acceptedFor([{ terms_version: "2026-09", accepted_at: "2026-09-01T00:00:00Z" }], v), false);
  assert.equal(TermsGate.acceptedFor([{ terms_version: v, accepted_at: null }], v), false);
  assert.equal(TermsGate.acceptedFor([], v), false);
  assert.equal(TermsGate.acceptedFor(null, v), false);
});

// ---- access settings ----

test("access settings: prefs are clean, default and stored as three values", () => {
  const ctx = load(["js/i18n.js", "js/access-settings.js"]);
  const A = ctx.AccessSettings;
  assert.deepEqual(plain(A.normalize(null)), { large: false, contrast: false, lang: "en" });
  assert.deepEqual(plain(A.normalize({ large: true, contrast: "yes", lang: "hi", leadName: "x" })), { large: true, contrast: false, lang: "hi" });
  assert.deepEqual(plain(A.bodyClasses({ large: true, contrast: false })), { "large-text": true, "high-contrast": false });
  const store = memoryStorage({ [A.KEY]: "{not json" });
  assert.deepEqual(plain(A.readPrefs(store)), { large: false, contrast: false, lang: "en" });
  A.writePrefs(store, { large: true, contrast: true, lang: "hi" });
  assert.deepEqual(Object.keys(JSON.parse(store._map.get(A.KEY))).sort(), ["contrast", "lang", "large"]);
});

// ---- first-run walkthrough ----

test("walkthrough: shows on the first run only, has four steps, and never nags without storage", () => {
  const { Onboarding: O } = load(["js/i18n.js", "js/modal.js", "js/onboarding.js"]);
  const store = memoryStorage();
  assert.equal(O.STEPS.length, 4);
  assert.equal(O.shouldShow(store), true);
  O.markDone(store);
  assert.equal(O.shouldShow(store), false);
  assert.equal(O.shouldShow(null), false);
  assert.equal(O.nextStep(0), 1);
  assert.equal(O.nextStep(3), 3);
  assert.equal(O.isLast(3), true);
  assert.equal(O.isLast(2), false);
});

// ---- page checks ----

test("page: no inline scripts and no inline style attributes in the workspace page", () => {
  const html = read("app.html");
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)];
  assert.deepEqual(inlineScripts.map((m) => m[0]), []);
  assert.equal(/\sstyle\s*=/.test(html), false);
});

test("page: the new modules are loaded by app.html and the access stylesheet is linked", () => {
  const html = read("app.html");
  for (const f of ["i18n", "terms", "modal", "terms-gate", "session-timeout", "feedback", "access-settings", "onboarding", "main"]) {
    assert.ok(html.includes('src="js/' + f + '.js"'), f);
  }
  assert.ok(html.includes('href="css/access.css"'));
});
