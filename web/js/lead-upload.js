/* Lead upload for campaigns (admin app, Campaigns tab): read a sheet's rows, guess which column is the name,
   the phone and the amount due, and turn the rows into what admin_add_leads takes. Pure functions, no browser
   APIs, so the same file runs in the page and under Node (tests/web/lead-upload.test.js).
   Phone checks come from web/js/import-check.js (ImportCheck), the same rules the caller app and the
   database (normalise_phone) use. The sheet itself is read in the page: XLSX for .xlsx (as in the caller
   app, js/main.js readSheet) and parseCsv below for .csv, so a 0 at the start of a number is kept.
   Money rule (docs/data-contract.md): money never goes in a lead's extra fields. looksLikeMoney mirrors the
   database's extra_has_money_key, so the page can stop a money column before the server refuses it. */
(function (root) {
  const IC = root.ImportCheck || (typeof require === "function" ? require("./import-check.js") : null);

  /* CSV text to rows of cells. Quotes, "" inside quotes, commas and line breaks inside quotes; a BOM at the
     start is dropped. Same reader as the caller app (js/main.js parseCsv). */
  function parseCsv(text) {
    const src = String(text == null ? "" : text).replace(/^﻿/, "");
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && src[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  /* One cell as text: dates as YYYY-MM-DD, numbers without exponent where possible, the rest trimmed. */
  function cellText(v) {
    if (v == null) return "";
    if (v instanceof Date) {
      if (Number.isNaN(v.getTime())) return "";
      return v.getFullYear() + "-" + pad2(v.getMonth() + 1) + "-" + pad2(v.getDate());
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "";
      return Number.isInteger(v) && Math.abs(v) < 1e21 ? v.toFixed(0) : String(v);
    }
    return String(v).trim();
  }

  /* Rows from the sheet to { header, rows }: blank rows dropped, every row as long as the header, cells as
     text. The first non-blank row is the header; blank headings become "Column 3" and so on. */
  function tidy(aoa) {
    const all = (aoa || []).map((r) => Array.from(r || [], cellText)).filter((r) => r.some((c) => c !== ""));
    if (!all.length) return { header: [], rows: [] };
    const header = all.shift().map((h, i) => h || "Column " + (i + 1));
    const rows = all.map((r) => { const x = r.slice(0, header.length); while (x.length < header.length) x.push(""); return x; });
    return { header, rows };
  }

  // Money words, as extra_has_money_key in the database: amount, fee(s), paid, balance, rupee(s), rs, inr,
  // price, cost, or a ₹ anywhere in the heading.
  const MONEY_WORDS = ["amount", "fee", "fees", "paid", "balance", "rupee", "rupees", "rs", "inr", "price", "cost"];
  function looksLikeMoney(heading) {
    const h = String(heading == null ? "" : heading);
    if (h.indexOf("₹") >= 0) return true;
    return h.toLowerCase().split(/[^a-z0-9₹]+/).some((w) => MONEY_WORDS.indexOf(w) >= 0);
  }

  function findCol(header, re, skip) {
    for (let i = 0; i < header.length; i++) if (skip.indexOf(i) < 0 && re.test(header[i])) return i;
    return -1;
  }

  /* Best guess of the name, phone and amount due columns (-1 when none), like the caller app's sheet reader.
     The amount is the first money-looking heading with "due", "balance" or "pending" in it, else any money
     heading. Every other column is offered as an extra field, except money columns. */
  function guessColumns(header) {
    const h = header || [];
    let name = findCol(h, /^(full[ _]?name|name|lead[ _]?name|parent[ _]?name|student[ _]?name|candidate)/i, []);
    if (name < 0) name = findCol(h, /name/i, []);
    let phone = findCol(h, /phone|mobile|whats|cell/i, [name]);
    if (phone < 0) phone = findCol(h, /contact|number/i, [name]);
    let amount = -1;
    for (let i = 0; i < h.length && amount < 0; i++) {
      if (i !== name && i !== phone && looksLikeMoney(h[i]) && /due|balance|pending|outstanding/i.test(h[i])) amount = i;
    }
    if (amount < 0) for (let i = 0; i < h.length && amount < 0; i++) if (i !== name && i !== phone && looksLikeMoney(h[i])) amount = i;
    const extra = [];
    h.forEach((x, i) => { if (i !== name && i !== phone && i !== amount && !looksLikeMoney(x)) extra.push(i); });
    return { name, phone, amount, extra };
  }

  /* An amount cell to a number of rupees (two decimals at most), null when blank, NaN when it is not an
     amount. Accepts ₹, Rs, commas and spaces: "₹12,000", "Rs. 8000.50", "12 000". */
  function parseAmount(v) {
    if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : NaN;
    let s = String(v == null ? "" : v).trim();
    if (s === "" || s === "-") return null;
    s = s.replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/[,\s]/g, "");
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return NaN;
    return Number(s);
  }

  /* The rows for admin_add_leads, and what will be skipped.
     map: { name, phone, amount (-1 for none), extra: [column indexes] }.
     Returns { rows: [{ name, phone, amount_due, extra }], counts: { total, ready, bad, repeats, noName,
     badAmount }, problems: [{ row, reason }] }. row is the sheet row number (header = 1).
     bad = missing or not 10 digits; repeats = the second and later copies of a number. Skipped rows are
     left out of rows; the server checks everything again. */
  function buildLeads(sheet, map) {
    const rows = (sheet && sheet.rows) || [];
    const header = (sheet && sheet.header) || [];
    const m = map || {};
    const extraCols = (m.extra || []).filter((i) => i !== m.name && i !== m.phone && i !== m.amount && i >= 0 && i < header.length);
    const check = IC.checkPhones(rows.map((r) => (m.phone >= 0 ? r[m.phone] : "")));
    const counts = { total: rows.length, ready: 0, bad: 0, repeats: 0, noName: 0, badAmount: 0 };
    const out = [];
    const problems = [];
    rows.forEach((r, i) => {
      const f = check.flags[i];
      const at = i + 2;
      if (f.status === "missing" || f.status === "bad") { counts.bad++; problems.push({ row: at, reason: f.reason }); return; }
      if (f.status === "duplicate") { counts.repeats++; problems.push({ row: at, reason: f.reason }); return; }
      const name = (m.name >= 0 ? String(r[m.name] || "") : "").trim().slice(0, 120);
      if (!name) { counts.noName++; problems.push({ row: at, reason: "No name" }); return; }
      let amount = null;
      if (m.amount >= 0) {
        amount = parseAmount(r[m.amount]);
        if (Number.isNaN(amount)) { counts.badAmount++; problems.push({ row: at, reason: "Amount due is not a number" }); return; }
      }
      const extra = {};
      extraCols.forEach((c) => {
        const v = String(r[c] == null ? "" : r[c]).trim();
        if (v) extra[header[c].slice(0, 60)] = v.slice(0, 300);
      });
      out.push({ name, phone: "+91" + f.digits, amount_due: amount, extra });
      counts.ready++;
    });
    return { rows: out, counts, problems };
  }

  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  /* "12 bad numbers and 8 repeats will be skipped", plus rows without a name or with a bad amount.
     Empty when nothing is skipped. */
  function skipText(counts) {
    const c = counts || {};
    const parts = [];
    if (c.bad) parts.push(plural(c.bad, "bad number", "bad numbers"));
    if (c.repeats) parts.push(plural(c.repeats, "repeat", "repeats"));
    if (c.noName) parts.push(plural(c.noName, "row without a name", "rows without a name"));
    if (c.badAmount) parts.push(plural(c.badAmount, "row with a wrong amount", "rows with a wrong amount"));
    if (!parts.length) return "";
    const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
    return list + " will be skipped";
  }

  /* The headings that would put money in extra fields (should be empty before upload). */
  function moneyInExtra(header, extraCols) {
    return (extraCols || []).filter((i) => looksLikeMoney((header || [])[i])).map((i) => header[i]);
  }

  /* Rows in parts of at most size (admin_add_leads takes 5000 at a time). */
  function chunk(list, size) {
    const n = Math.max(1, size | 0);
    const out = [];
    for (let i = 0; i < (list || []).length; i += n) out.push(list.slice(i, i + n));
    return out;
  }

  /* Adds up admin_add_leads answers ({ added, bad_numbers, repeats, other_skipped }, or a one-row list). */
  function addCounts(a, b) {
    const x = Array.isArray(b) ? b[0] || {} : b || {};
    const k = ["added", "bad_numbers", "repeats", "other_skipped"];
    const out = {};
    k.forEach((key) => { out[key] = (Number((a || {})[key]) || 0) + (Number(x[key]) || 0); });
    return out;
  }

  /* "Equal parts (110 each)" for the share picker; "about" when it does not divide evenly. */
  function equalText(leads, callers) {
    if (!callers || !leads) return "Equal parts";
    const each = leads / callers;
    return "Equal parts (" + (Number.isInteger(each) ? each : "about " + Math.round(each)) + " each)";
  }

  const api = { parseCsv, cellText, tidy, looksLikeMoney, guessColumns, parseAmount, buildLeads, skipText,
    moneyInExtra, chunk, addCounts, equalText, MONEY_WORDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LeadUpload = api;
})(typeof window !== "undefined" ? window : globalThis);
