/* Phase A.2: caller. The campaign picker: the running and paused campaigns the caller may work (my_campaigns():
   member campaigns and open campaigns, with call_type_key, class_label, board, open_to_all, my_leads_due and
   pool_leads_due), grouped by purpose (Fees, Admissions, Sales, Others) and filtered by purpose, class and board.
   Pure functions; main.js draws the picker. Tested under Node (tests/web/caller-a2.test.js). */
(function (root) {
  const PURPOSES = ["fees", "admissions", "sales", "others"];
  const PURPOSE_OF = { fees: "fees", fee: "fees", fees_collection: "fees", admission: "admissions", admissions: "admissions", sales: "sales" };
  const clean = (v) => (v == null ? "" : String(v).trim());

  /* fees | admissions | sales | others, from the campaign's call type key. */
  function purposeOf(c) { return PURPOSE_OF[clean(c && c.call_type_key).toLowerCase()] || "others"; }

  /* Leads waiting now: the caller's own due leads plus the pool's (open campaigns hand those out next). */
  function waiting(c) { return Math.max(0, Number(c && c.my_leads_due) || 0) + Math.max(0, Number(c && c.pool_leads_due) || 0); }

  /* "8th · CBSE", or "" without tags. With a class or board filter set (f), a campaign without that tag applies to
     everyone, so it says so: words.classes ("All classes") or words.boards ("All boards"). */
  function tagLine(c, f, words) {
    const w = Object.assign({ classes: "All classes", boards: "All boards" }, words || {});
    const want = f || {};
    const cls = clean(c && c.class_label) || (clean(want.class_label) ? w.classes : "");
    const brd = clean(c && c.board) || (clean(want.board) ? w.boards : "");
    return [cls, brd].filter(Boolean).join(" · ");
  }

  // Classes in school order where we can tell (Nursery, LKG, UKG, 1st … 12th), then the rest by name.
  const EARLY = { nursery: -3, "pre-nursery": -4, lkg: -2, ukg: -1 };
  function classRank(label) {
    const s = label.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EARLY, s)) return EARLY[s];
    const m = /^(\d{1,2})/.exec(s);
    return m ? Number(m[1]) : 100;
  }
  /* The filter choices that exist in the list: { purposes, classes, boards }, each without duplicates (any case). */
  function options(list) {
    const uniq = (vals) => {
      const seen = new Map();
      vals.forEach((v) => { const k = v.toLowerCase(); if (v && !seen.has(k)) seen.set(k, v); });
      return [...seen.values()];
    };
    const cs = list || [];
    const purposes = PURPOSES.filter((p) => cs.some((c) => purposeOf(c) === p));
    const classes = uniq(cs.map((c) => clean(c.class_label))).sort((a, b) => classRank(a) - classRank(b) || a.localeCompare(b));
    const boards = uniq(cs.map((c) => clean(c.board))).sort((a, b) => a.localeCompare(b));
    return { purposes, classes, boards };
  }

  /* The campaigns that match every filter set: f = { purpose, class_label, board } ("" or null = any). A campaign
     with no class tag is for every class, so it matches any class filter; the same for the board. */
  function filter(list, f) {
    const want = f || {};
    const eq = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
    return (list || []).filter((c) =>
      (!want.purpose || purposeOf(c) === want.purpose) &&
      (!clean(want.class_label) || !clean(c.class_label) || eq(c.class_label, want.class_label)) &&
      (!clean(want.board) || !clean(c.board) || eq(c.board, want.board)));
  }

  /* [{ purpose, campaigns }] in the order Fees, Admissions, Sales, Others; campaigns keep the list's order
     (my_campaigns() sorts by status, call type, class, board and name). Empty groups are left out. */
  function groups(list) {
    return PURPOSES.map((p) => ({ purpose: p, campaigns: (list || []).filter((c) => purposeOf(c) === p) })).filter((g) => g.campaigns.length);
  }

  /* A filter as saved in this browser, checked against the choices that exist now (unknown values are dropped). */
  function validFilter(f, opts) {
    const o = opts || { purposes: [], classes: [], boards: [] };
    const pick = (v, list) => { const s = clean(v); return list.find((x) => x.toLowerCase() === s.toLowerCase()) || ""; };
    const w = f && typeof f === "object" ? f : {};
    return { purpose: o.purposes.includes(w.purpose) ? w.purpose : "", class_label: pick(w.class_label, o.classes), board: pick(w.board, o.boards) };
  }

  /* Autopilot: the lists the caller is a focus caller of (my_campaigns().is_focus), in the list's order. */
  function focus(list) { return (list || []).filter((c) => c && c.is_focus === true); }

  const api = { PURPOSES, purposeOf, waiting, tagLine, options, filter, groups, validFilter, focus };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CampaignPicker = api;
})(typeof window !== "undefined" ? window : globalThis);
