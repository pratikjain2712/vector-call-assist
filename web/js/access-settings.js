/* Settings menu: text size (four steps), high contrast, and the interface language. The choices are CSS classes
   on the body (text-s, text-l, text-xl, high-contrast) and the lang attribute on the page. They are kept in
   localStorage under "vca2-access" as three values only: no lead data is stored there. */
(function (root) {
  const KEY = "vca2-access";
  const $ = (id) => document.getElementById(id);
  const SIZES = ["s", "m", "l", "xl"];
  const store = () => { try { return root.localStorage; } catch (e) { return null; } };

  /* Pure: clean prefs from anything (missing or wrong values fall back to the defaults). */
  function normalize(v) {
    const o = v && typeof v === "object" ? v : {};
    // Older saves had large: true, which is now the "l" step.
    const size = SIZES.includes(o.size) ? o.size : (o.large === true ? "l" : "m");
    return { size: size, contrast: o.contrast === true, lang: root.I18n.normalize(o.lang) };
  }
  function readPrefs(storage) {
    try { return normalize(JSON.parse((storage && storage.getItem(KEY)) || "null")); }
    catch (e) { return normalize(null); }
  }
  function writePrefs(storage, prefs) {
    try { storage.setItem(KEY, JSON.stringify(normalize(prefs))); } catch (e) {}
  }
  /* Pure: which body classes a set of prefs turns on. */
  function bodyClasses(prefs) {
    return { "text-s": prefs.size === "s", "text-l": prefs.size === "l", "text-xl": prefs.size === "xl", "high-contrast": !!prefs.contrast };
  }

  let prefs = normalize(null);
  let onChange = null;

  function apply() {
    const classes = bodyClasses(prefs);
    Object.keys(classes).forEach((name) => document.body.classList.toggle(name, classes[name]));
    document.documentElement.lang = prefs.lang;
    root.I18n.setLang(prefs.lang);
    root.I18n.apply(document);
    $("pref-size").querySelectorAll("[data-size]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.size === prefs.size)));
    $("pref-contrast").checked = prefs.contrast;
    $("pref-lang").value = prefs.lang;
  }
  function update(patch) {
    prefs = normalize(Object.assign({}, prefs, patch));
    writePrefs(store(), prefs);
    apply();
    if (onChange) onChange();
  }

  function init(opts) {
    onChange = opts && opts.onChange;
    prefs = readPrefs(store());
    apply();
    $("pref-size").querySelectorAll("[data-size]").forEach((b) => b.addEventListener("click", () => update({ size: b.dataset.size })));
    $("pref-contrast").addEventListener("change", (ev) => update({ contrast: ev.target.checked }));
    $("pref-lang").addEventListener("change", (ev) => update({ lang: ev.target.value }));
    $("pref-walkthrough").addEventListener("click", () => { $("settings-panel").open = false; root.Onboarding.show(); });
  }

  root.AccessSettings = { KEY, SIZES, normalize, readPrefs, writePrefs, bodyClasses, init };
})(window);
