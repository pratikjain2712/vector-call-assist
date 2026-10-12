/* Settings menu: large text, high contrast, and the interface language. The choices are CSS classes on the
   body (large-text, high-contrast) and the lang attribute on the page. They are kept in localStorage under
   "vca2-access" as three values only: no lead data is stored there. */
(function (root) {
  const KEY = "vca2-access";
  const $ = (id) => document.getElementById(id);
  const store = () => { try { return root.localStorage; } catch (e) { return null; } };

  /* Pure: clean prefs from anything (missing or wrong values fall back to the defaults). */
  function normalize(v) {
    const o = v && typeof v === "object" ? v : {};
    return { large: o.large === true, contrast: o.contrast === true, lang: root.I18n.normalize(o.lang) };
  }
  function readPrefs(storage) {
    try { return normalize(JSON.parse((storage && storage.getItem(KEY)) || "null")); }
    catch (e) { return normalize(null); }
  }
  function writePrefs(storage, prefs) {
    try { storage.setItem(KEY, JSON.stringify(normalize(prefs))); } catch (e) {}
  }
  /* Pure: which body classes a set of prefs turns on. */
  function bodyClasses(prefs) { return { "large-text": !!prefs.large, "high-contrast": !!prefs.contrast }; }

  let prefs = normalize(null);
  let onChange = null;

  function apply() {
    const classes = bodyClasses(prefs);
    Object.keys(classes).forEach((name) => document.body.classList.toggle(name, classes[name]));
    document.documentElement.lang = prefs.lang;
    root.I18n.setLang(prefs.lang);
    root.I18n.apply(document);
    $("pref-large").checked = prefs.large;
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
    $("pref-large").addEventListener("change", (ev) => update({ large: ev.target.checked }));
    $("pref-contrast").addEventListener("change", (ev) => update({ contrast: ev.target.checked }));
    $("pref-lang").addEventListener("change", (ev) => update({ lang: ev.target.value }));
    $("pref-walkthrough").addEventListener("click", () => { $("settings-panel").open = false; root.Onboarding.show(); });
  }

  root.AccessSettings = { KEY, normalize, readPrefs, writePrefs, bodyClasses, init };
})(window);
