/* Phone number checks for a lead sheet. Pure functions, no browser APIs, so the same file runs in the page
   and under Node (tests/web/import-check.test.js).
   Rules: remove spaces and hyphens; then remove +91, or 91 when the number is 12 digits (Excel stores 91 + 10
   digits as a number), then one leading 0. What is left must be exactly 10 digits. Empty cells are
   "missing". The second and later copies of a number are "duplicate". Rows are never dropped: the page keeps
   every lead and marks the ones that need a look. Values are text: a number cell is read as a string upstream. */
(function (root) {
  function normalizePhone(raw) {
    const s = String(raw == null ? "" : raw).replace(/[\s \-]+/g, "");
    if (s === "") return { status: "missing", digits: "", reason: "No number" };
    let d = s;
    if (d.startsWith("+91")) d = d.slice(3);
    else if (/^91\d{10}$/.test(d)) d = d.slice(2);
    if (d.startsWith("0")) d = d.slice(1);
    if (!/^\d{10}$/.test(d)) return { status: "bad", digits: d, reason: "Not 10 digits" };
    return { status: "ok", digits: d, reason: "" };
  }

  /* values: the phone cell of every lead, in sheet order. flags[i] belongs to values[i]. */
  function checkPhones(values) {
    const counts = { ok: 0, missing: 0, bad: 0, duplicate: 0 };
    const firstLead = new Map();   // digits -> lead number (1-based) of the first copy
    const flags = (values || []).map((v, i) => {
      const n = normalizePhone(v);
      if (n.status !== "ok") { counts[n.status]++; return n; }
      if (firstLead.has(n.digits)) {
        counts.duplicate++;
        return { status: "duplicate", digits: n.digits, reason: "Same number as lead " + firstLead.get(n.digits) };
      }
      firstLead.set(n.digits, i + 1);
      counts.ok++;
      return n;
    });
    return { flags, counts, problems: counts.missing + counts.bad + counts.duplicate };
  }

  /* One line for the import message. Says how many, and that nothing was dropped. */
  function problemText(counts) {
    const total = counts.missing + counts.bad + counts.duplicate;
    if (!total) return "All phone numbers look right.";
    const parts = [];
    if (counts.missing) parts.push(counts.missing + " without a number");
    if (counts.bad) parts.push(counts.bad + " not 10 digits");
    if (counts.duplicate) parts.push(counts.duplicate + " repeated");
    return total + " phone number" + (total === 1 ? "" : "s") + " need" + (total === 1 ? "s" : "") + " checking (" + parts.join(", ") +
      "). Those leads are kept and marked on the lead bar.";
  }

  const api = { normalizePhone, checkPhones, problemText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ImportCheck = api;
})(typeof window !== "undefined" ? window : globalThis);
