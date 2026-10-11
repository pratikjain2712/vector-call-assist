/* Lead list helpers: search, filters, the daily queue and a status line per lead. Pure functions over the
   sheet rows (arrays of cells). cols gives the column index of name, phone, outcome and callback. Dates are
   YYYY-MM-DD text. Used by main.js and tested under Node (tests/web/lead-list.test.js). */
(function (root) {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function cell(row, i) {
    if (row == null || i == null || i < 0) return "";
    return String(row[i] == null ? "" : row[i]).trim();
  }
  function digits(s) { return String(s == null ? "" : s).replace(/\D/g, ""); }
  function validDate(v) { const s = String(v == null ? "" : v).trim(); return DATE_RE.test(s) ? s : ""; }
  function todayIso(d) {
    const x = d || new Date();
    const p = (n) => String(n).padStart(2, "0");
    return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate());
  }
  function isCalled(row, cols) { return cell(row, cols.outcome) !== ""; }
  function callbackOf(row, cols) { return validDate(cell(row, cols.callback)); }
  function isDue(row, cols, today) { const cb = callbackOf(row, cols); return !!cb && cb <= today; }
  /* "No answer" with no callback date: a retry that stays in the queue until a final outcome replaces it. */
  function isRetry(row, cols) {
    const outcome = cell(row, cols.outcome).toLowerCase().replace(/_/g, " ");
    return outcome === "no answer" && !callbackOf(row, cols);
  }

  /* Name: any part of it, ignoring case. Number: the digits typed (at least 3) inside the stored number.
     "+91" at the start of the query is a country code and is dropped; a leading 0 is ignored. */
  function matchesQuery(row, cols, query) {
    const q = String(query == null ? "" : query).trim().toLowerCase();
    if (!q) return true;
    if (cell(row, cols.name).toLowerCase().includes(q)) return true;
    let qd = digits(q);
    if (/^\+91/.test(q)) qd = qd.slice(2);
    const candidates = [qd, qd.replace(/^0+/, "")].filter((x) => x.length >= 3);
    if (!candidates.length) return false;
    const stored = digits(cell(row, cols.phone));
    return candidates.some((x) => stored.includes(x));
  }

  /* The daily queue: callbacks that are due (earliest date first, then sheet order), then no-answer retries
     (sheet order), then new leads that were never called, in sheet order. Any other called lead with no due
     callback is not in the queue. */
  function dailyQueue(rows, cols, today) {
    const t = today || todayIso();
    const due = [];
    const retry = [];
    const fresh = [];
    rows.forEach((row, i) => {
      if (isDue(row, cols, t)) due.push(i);
      else if (isRetry(row, cols)) retry.push(i);
      else if (!isCalled(row, cols)) fresh.push(i);
    });
    due.sort((a, b) => {
      const da = callbackOf(rows[a], cols), db = callbackOf(rows[b], cols);
      if (da !== db) return da < db ? -1 : 1;
      return a - b;
    });
    return due.concat(retry, fresh);
  }

  /* opts.status: queue (default in the page) | all | not_called | called | due. Returns sheet row indexes. */
  function filterLeads(rows, cols, opts, today) {
    const o = opts || {};
    const t = today || todayIso();
    const status = o.status || "all";
    const order = status === "queue" ? dailyQueue(rows, cols, t) : rows.map((_, i) => i);
    return order.filter((i) => {
      const row = rows[i];
      if (status === "called" && !isCalled(row, cols)) return false;
      if (status === "not_called" && isCalled(row, cols)) return false;
      if (status === "due" && !isDue(row, cols, t)) return false;
      return matchesQuery(row, cols, o.query);
    });
  }

  /* One short line about a lead's state: kind is due | called | new. */
  function statusOf(row, cols, today) {
    const t = today || todayIso();
    const cb = callbackOf(row, cols);
    if (cb && cb < t) return { kind: "due", label: "Callback overdue, due " + cb };
    if (cb && cb === t) return { kind: "due", label: "Callback due today" };
    if (cb) return { kind: "called", label: "Callback on " + cb };
    if (isRetry(row, cols)) return { kind: "called", label: "No answer, to try again" };
    if (isCalled(row, cols)) return { kind: "called", label: "Called: " + cell(row, cols.outcome) };
    return { kind: "new", label: "New, not called yet" };
  }

  const api = { todayIso, validDate, matchesQuery, dailyQueue, filterLeads, statusOf, isCalled, callbackOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LeadList = api;
})(typeof window !== "undefined" ? window : globalThis);
