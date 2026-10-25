/* Phase A.2: caller. Placeholders in script lines and answers, filled on the call:
   {name} {me} {institute} {student} {class} {board} {amount_due} {due_date} {course} {source} {source_date}
   (docs/template-library.md, "Placeholders").
   values() works out each value from the lead, its extra fields, the campaign, the money and ledger answers and the
   institute. fill() gives plain text; parts() gives pieces for the page to draw (a filled value is highlighted).
   A value that is missing never shows as raw braces: an answer's own "fallback" text is used when it has one,
   otherwise the placeholder is dropped with the words around it ("in {class} class") or replaced by a plain
   word ("your child"). {name} and {me} can instead show a hint ("lead's name") for the caller to say.
   Pure functions, tested under Node (tests/web/caller-a2.test.js). */
(function (root) {
  const KEYS = ["name", "me", "institute", "student", "class", "board", "amount_due", "due_date", "course", "source", "source_date"];
  const TOKEN = /\{([a-z_]+)\}/g;
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  // Keys of the lead's extra fields (sheet columns), compared in lower case with _ and - read as spaces.
  const EXTRA = {
    student: ["student", "student name", "child", "child name", "ward", "ward name", "kid"],
    class: ["class", "grade", "std", "standard", "class label"],
    board: ["board"],
    course: ["course", "course name", "program", "programme", "interested in"],
    source: ["source", "lead source", "enquiry source", "came from", "how did you hear", "channel"],
    source_date: ["source date", "enquiry date", "enquired on", "enquired", "enquiry on", "date of enquiry", "lead date",
      "added on", "date added", "registered on", "registration date"],
    due_date: ["due date", "due by", "due on", "last date"],
  };
  const normKey = (k) => String(k).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

  /* The value of the first extra key that matches one of names, as trimmed text ("" when none). */
  function extraValue(extra, names) {
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) return "";
    const byKey = Object.create(null);
    Object.keys(extra).forEach((k) => { const v = extra[k]; if (v != null && String(v).trim() !== "") byKey[normKey(k)] = String(v).trim(); });
    for (const n of names) if (byKey[n]) return byKey[n];
    return "";
  }
  /* True when an extra key is one of the source keys (the lead card shows them on their own line). */
  function isSourceKey(k) { const n = normKey(k); return EXTRA.source.includes(n) || EXTRA.source_date.includes(n); }

  /* A date as "12 October" (long) or "12 Oct" (short), India time. Takes ISO text, milliseconds, dd/mm/yyyy or
     anything Date.parse reads; other text comes back as it is. */
  function dateText(v, short) {
    if (v == null || v === "") return "";
    let t = NaN;
    if (typeof v === "number") t = v;
    else {
      const s = String(v).trim();
      let m;
      if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) t = Date.parse(s + "T12:00:00+05:30");
      else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) t = Date.parse(m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0") + "T12:00:00+05:30");
      else if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /[a-z]{3}/i.test(s)) t = Date.parse(s);
      if (!Number.isFinite(t)) return s;
    }
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: short ? "short" : "long", timeZone: "Asia/Kolkata" });
  }
  function rupees(n) {
    const v = Number(n);
    if (n == null || n === "" || !Number.isFinite(v)) return "";
    return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";
  const cleanClass = (s) => String(s || "").trim().replace(/^(class|std\.?|standard|grade)\s+/i, "");

  /* Where the lead came from: { source, date } as text, date in the short form for the lead card. */
  function sourceOf(lead) {
    const l = lead || {};
    const src = extraValue(l.extra, EXTRA.source);
    const d = extraValue(l.extra, EXTRA.source_date) || l.created_at || "";
    return { source: src, date: dateText(d, true), longDate: dateText(d, false) };
  }

  /* ctx: { name, me, institute, lead, campaign, money, ledger }. lead: { name, extra, created_at, due_date };
     due_date: the lead's own (extra), else my_call_queue's due_date (campaign fees_due_by or the student's oldest
     unpaid fee item), else the campaign's fees_due_by.
     campaign: { class_label, board, fees_due_by }; money: lead_money() row; ledger: lead_ledger() row.
     Returns { key: text } with "" for every value that is not known. */
  function values(ctx) {
    const c = ctx || {}, l = c.lead || {}, camp = c.campaign || {}, ex = l.extra;
    const money = c.money && !c.money.money_hidden ? c.money : null;
    const ledger = c.ledger && !c.ledger.money_hidden ? c.ledger : null;
    let amount = money && money.amount_due != null ? rupees(money.amount_due) : "";
    if (!amount && ledger && Number(ledger.balance_due_now) > 0) amount = rupees(ledger.balance_due_now);
    const src = sourceOf(l);
    return {
      name: String(c.name != null ? c.name : l.name || "").trim(),
      me: firstName(c.me),
      institute: String(c.institute || "").trim(),
      student: extraValue(ex, EXTRA.student),
      class: cleanClass(extraValue(ex, EXTRA.class) || camp.class_label || ""),
      board: extraValue(ex, EXTRA.board) || String(camp.board || "").trim(),
      amount_due: amount,
      due_date: dateText(extraValue(ex, EXTRA.due_date) || l.due_date || camp.fees_due_by || "", false),
      course: extraValue(ex, EXTRA.course),
      source: src.source,
      source_date: src.source ? src.longDate : dateText(extraValue(ex, EXTRA.source_date), false),
    };
  }

  /* The placeholders in text that have no value. Unknown placeholders count as missing. */
  function missing(text, vals) {
    const out = [];
    String(text || "").replace(TOKEN, (m, k) => { if (!(vals && own(vals, k) && vals[k])) out.push(k); return m; });
    return out;
  }

  // What to do with a missing value: phrases that go with it, then a plain word for what is left.
  const DROP = {
    name: [[/,\s*\{name\}(?=\s*[!.?])/g, ""], [/\b(speaking (?:with|to))\s+\{name\}/gi, "$1 the right person"], [/\s*\{name\}/g, ""]],
    me: [[/\b(this is|i am|i'm)\s+\{me\},?\s+(?:calling\s+)?from\b/gi, "$1 calling from"], [/\s*\{me\}/g, ""]],
    institute: [[/\{institute\}/g, "our institute"]],
    student: [[/\{student\}/g, "your child"]],
    class: [[/\s*\b(?:in|of|for|from)\s+\{class\}\s+class\b/gi, ""], [/\{class\}\s+class\b/gi, "class"], [/\s*\{class\}/g, ""]],
    board: [[/\bthe\s+\{board\}\s+board\b/gi, "our board"], [/\s*\{board\}/g, ""]],
    amount_due: [[/\s+of\s+\{amount_due\}/gi, ""], [/\{amount_due\}/g, "the amount due"]],
    due_date: [[/,\s*due\s+(?:on|by|before)\s+\{due_date\}/gi, ""], [/,?\s*\b(?:on|by|before)\s+\{due_date\}/gi, ""], [/\{due_date\}/g, "the due date"]],
    course: [[/\{course\}\s+(course|classes)\b/gi, "$1"], [/\{course\}/g, "our courses"]],
    source: [[/\bjoining\s+\{source\}/gi, "joining us"], [/\s*\b(?:from|through|via)\s+\{source\}/gi, ""], [/\s*\{source\}/g, ""]],
    source_date: [[/,?\s*\b(?:on|in|from|since)\s+\{source_date\}/gi, ""], [/\s*\{source_date\}/g, ""]],
  };
  function tidy(s) {
    return s.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").replace(/([,;:])(?=[.!?])/g, "")
      .replace(/,\s*,/g, ",").replace(/\(\s*\)/g, "").replace(/^\s*[,;:]\s*/, "").replace(/[ \t]{2,}/g, " ").trim();
  }
  /* text with every missing placeholder dropped or replaced (keep: keys left as they are, for hints). */
  function dropMissing(text, vals, keep) {
    let s = String(text || "");
    const gone = missing(s, vals).filter((k) => !(keep && keep.includes(k)));
    if (!gone.length) return s;
    new Set(gone).forEach((k) => {
      (DROP[k] || [[new RegExp("\\s*\\{" + k + "\\}", "g"), ""]]).forEach(([re, to]) => { s = s.replace(re, to); });
    });
    return tidy(s);
  }

  /* The text to say: opts.fallback is used instead when a placeholder in text has no value (and the fallback's own
     missing values are dropped). */
  function choose(text, vals, opts) {
    const o = opts || {};
    if (o.fallback && missing(text, vals).length) return String(o.fallback);
    return String(text || "");
  }
  function fill(text, vals, opts) {
    const s = dropMissing(choose(text, vals, opts), vals);
    return s.replace(TOKEN, (m, k) => (own(vals, k) && vals[k] ? vals[k] : ""));
  }
  /* For drawing: [{ text }] plain pieces, { key, value } filled values, { key, hint } for {name} / {me} with no
     value when opts.hints is on (the page shows "lead's name" in a blank box, as before). */
  const HINTS = { name: "lead's name", me: "your name" };
  function parts(text, vals, opts) {
    const o = opts || {};
    const s = dropMissing(choose(text, vals, o), vals, o.hints ? ["name", "me"] : null);
    const out = [];
    let at = 0;
    s.replace(TOKEN, (m, k, i) => {
      if (i > at) out.push({ text: s.slice(at, i) });
      if (own(vals, k) && vals[k]) out.push({ key: k, value: vals[k] });
      else if (o.hints && own(HINTS, k)) out.push({ key: k, hint: HINTS[k] });
      at = i + m.length;
      return m;
    });
    if (at < s.length) out.push({ text: s.slice(at) });
    return out;
  }

  const api = { KEYS, values, missing, fill, parts, sourceOf, isSourceKey, dateText, rupees, extraValue };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Placeholders = api;
})(typeof window !== "undefined" ? window : globalThis);
