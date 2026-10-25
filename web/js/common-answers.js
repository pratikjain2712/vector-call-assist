/* Phase A.2: caller. Common answers ("Where did you get my number?", "Do not call me again" …) for the answer
   search (/) and the helper column of every script, built-in and custom.
   Rows: { key, label, answer, tags, fallback?, result?, check? } as in supabase/templates/common_answers.json.
   They come from the database (my_common_answers(), when the institute's copy exists) or from the static copy
   web/data/common_answers.json (same content as supabase/templates/common_answers.json; a test checks it).
   check: a fact the institute must add first. An answer with a check is hidden until the database says it is
   filled (filled / check_filled true, or an empty check list); the static copy never says so.
   Pure functions, tested under Node (tests/web/caller-a2.test.js). */
(function (root) {
  const text = (v) => (typeof v === "string" ? v.trim() : "");

  /* Usable rows, in order, each { key, label, answer, fallback, result, tags, hidden }. Rows without a key, label
     or answer, and repeated keys, are left out. */
  function normalize(rows, fromDb) {
    const out = [], seen = new Set();
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (!r || typeof r !== "object") return;
      const key = text(r.key), label = text(r.label), answer = text(r.answer) || text(r.text);
      if (!key || !label || !answer || seen.has(key)) return;
      seen.add(key);
      const check = Array.isArray(r.check) ? r.check.filter((c) => text(c)) : text(r.check) ? [text(r.check)] : [];
      const filled = !!fromDb && (r.filled === true || r.check_filled === true || r.is_filled === true || (Array.isArray(r.check) && !check.length));
      out.push({
        key, label, answer,
        fallback: text(r.fallback) || null,
        result: text(r.result) || null,
        tags: (Array.isArray(r.tags) ? r.tags : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean),
        hidden: check.length > 0 && !filled,
      });
    });
    return out;
  }

  /* The answers to offer on a call of this call type (null: type unknown, only answers tagged "all"). Hidden
     answers are left out. */
  function visible(list, callTypeKey) {
    const type = text(callTypeKey).toLowerCase();
    return (list || []).filter((a) => !a.hidden && (a.tags.includes("all") || (type && a.tags.includes(type))));
  }

  /* As answer-search items next to a script's own: { key, chip, say, fallback, result, tags, common }. Labels the
     script already answers (any case) are skipped, so a script's own answer wins. */
  function asItems(list, takenLabels) {
    const taken = new Set((takenLabels || []).map((l) => String(l).toLowerCase().trim()));
    return (list || []).filter((a) => !taken.has(a.label.toLowerCase())).map((a) => ({
      key: "c:" + a.key, chip: a.label, say: a.answer, fallback: a.fallback, result: a.result, tags: a.tags, common: true,
    }));
  }

  const api = { normalize, visible, asItems };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CommonAnswers = api;
})(typeof window !== "undefined" ? window : globalThis);
