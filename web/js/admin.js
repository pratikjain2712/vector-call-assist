'use strict';
/* Pure helpers of the admin app (web/admin.html), for Vector 2.0: date ranges, CSV with the formula guard,
   the results-by-outcome pivot and pairing health. The page code lives in web/js/admin/: shell.js (sign-in,
   tabs), callers.js (team activity and seats) and reports.js (results and CSV). Reports are read with admin_*
   RPCs (supabase/migrations/0004_admin_views.sql), checked by the database.
   Shared with the page as window.VectorAdminHelpers; also loaded by tests/web/admin.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------
  const OUTCOMES = ['answered', 'no_answer', 'busy', 'callback', 'interested', 'not_interested', 'won', 'dropped_network', 'other'];
  const TEAM_HEADERS = ['Rep', 'Day', 'Calls', 'Connected calls', 'Connect rate (%)', 'Talk time (s)', 'Last call'];
  const MAX_DAYS = 400;
  const FORMULA_START = /^[=+\-@\t\r]/;   // cells starting with these could run as formulas in a spreadsheet
  const PHONE_LIKE = /^\+?[0-9][0-9 ()\-.]*$/; // phone numbers may start with + and are left alone
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

  // 'YYYY-MM-DD' to a local-midnight Date, or null when it is not a real calendar date.
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]) - 1, day = Number(m[3]);
    const d = new Date(y, mo, day);
    return d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day ? d : null;
  }

  // The last n calendar days ending on `now`, both ends included, as local 'YYYY-MM-DD' dates.
  function lastNDays(now, n) {
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (n - 1));
    return { from: ymd(from), to: ymd(to) };
  }

  // An inclusive date range to the [from, to) instants the RPCs take: local midnight of the first
  // day, and local midnight of the day after the last one.
  function rangeToTimestamps(fromYmd, toYmd) {
    const a = parseYmd(fromYmd);
    const b = parseYmd(toYmd);
    if (!a || !b) throw new Error('Pick both dates.');
    if (b < a) throw new Error('The to date is before the from date.');
    const days = Math.round((b - a) / 86400000) + 1; // round() absorbs the 23 and 25 hour days
    if (days > MAX_DAYS) throw new Error('Choose a range of ' + MAX_DAYS + ' days or less.');
    const end = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
    return { from: a.toISOString(), to: end.toISOString() };
  }

  // Formula guard: a text cell starting with = + - @ (or a tab or CR) gets a leading apostrophe,
  // unless it looks like a phone number. Numbers are never changed.
  function guardCell(v) {
    if (typeof v !== 'string') return v;
    return FORMULA_START.test(v) && !PHONE_LIKE.test(v) ? "'" + v : v;
  }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(guardCell(v));
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(headers, rows) {
    return [headers].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function rateToPercent(rate) {
    if (rate === null || rate === undefined || rate === '') return '';
    return Math.round(Number(rate) * 1000) / 10;   // one decimal place
  }

  function teamCsvRows(rows) {
    return rows.map((r) => [
      r.label, r.day, r.calls, r.connected_calls, rateToPercent(r.connect_rate), r.talk_seconds, r.last_activity,
    ]);
  }

  // Results by outcome: one entry per rep with a count for each outcome and a total, sorted by label.
  function pivotOutcomes(rows) {
    const byRep = new Map();
    rows.forEach((r) => {
      if (!byRep.has(r.seat_id)) byRep.set(r.seat_id, { seat_id: r.seat_id, label: r.label, counts: {}, total: 0 });
      const rep = byRep.get(r.seat_id);
      const n = Number(r.outcome_count) || 0;
      rep.counts[r.outcome] = (rep.counts[r.outcome] || 0) + n;
      rep.total += n;
    });
    return Array.from(byRep.values()).sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  // Pairing health for one row of admin_seat_list.
  function pairingHealth(seat) {
    if (seat.status === 'revoked') return { level: 'none', text: 'Revoked' };
    if (seat.status === 'invited') return { level: 'none', text: 'Invite not claimed' };
    return seat.has_phone ? { level: 'ok', text: 'Phone paired' } : { level: 'warn', text: 'No phone paired' };
  }

  const helpers = {
    OUTCOMES, TEAM_HEADERS, MAX_DAYS, ymd, parseYmd, lastNDays, rangeToTimestamps,
    guardCell, csvCell, toCsv, rateToPercent, teamCsvRows, pivotOutcomes, pairingHealth, EMAIL,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof window !== 'undefined') window.VectorAdminHelpers = helpers;
})();
