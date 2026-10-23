'use strict';
/* Pure helpers of the admin team tools (web/admin.html): week start, progress bars, note length, target
   parsing, the weekly summary columns and the not-calling list. The page code is in web/js/admin/callers.js
   (rep progress, not calling, daily targets, supervisor notes) and web/js/admin/reports.js (weekly summary).
   A function the database does not have yet shows NOT_YET ("not available yet").
   Shared with the page as window.VectorAdminTeamHelpers; also loaded by tests/web/admin-team.test.js. */
(function () {
  // ---------- pure helpers ----------
  const NOT_YET = 'not available yet';
  const NOTE_MAX = 1000;
  const TARGET_MAX = 100000;
  const FORMULA_START = /^[=+\-@\t\r]/;   // same guard as js/admin.js
  const PHONE_LIKE = /^\+?[0-9][0-9 ()\-.]*$/;
  // The three daily targets: the metric name the database takes, the words shown, and the field of the rep progress row.
  const TARGETS = [
    { metric: 'calls', name: 'calls', field: 'calls_target' },
    { metric: 'connected_calls', name: 'connected calls', field: 'connected_target' },
    { metric: 'talk_minutes', name: 'talk minutes', field: 'talk_target' },
  ];

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

  // The Monday on or before a date (a 'YYYY-MM-DD' string or a Date), as 'YYYY-MM-DD'; null for a bad date.
  function weekStart(input) {
    const d = input instanceof Date
      ? new Date(input.getFullYear(), input.getMonth(), input.getDate())
      : parseYmd(input);
    if (!d) return null;
    const back = (d.getDay() + 6) % 7;   // getDay() is 0 for Sunday, so Monday gives 0 and Sunday gives 6
    return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
  }

  // The width of a progress bar in whole percent, 0 to 100. A missing or zero target gives 0.
  function barPercent(value, target) {
    const v = Number(value), t = Number(target);
    if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((v / t) * 100)));
  }

  // The real percentage of the target, so 150 means 150%. null when there is no target.
  function percentOfTarget(value, target) {
    const v = Number(value), t = Number(target);
    if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;
    return Math.round((v / t) * 100);
  }

  // A note as the database will see it: trimmed, and no more than 1000 characters (code points, as the database counts).
  function noteCheck(text) {
    const t = String(text === null || text === undefined ? '' : text).trim();
    const length = Array.from(t).length;
    if (!length) return { ok: false, length: 0, error: 'Write a note first.' };
    if (length > NOTE_MAX) return { ok: false, length, error: 'Notes can be up to ' + NOTE_MAX + ' characters. This one has ' + length + '.' };
    return { ok: true, length, text: t };
  }

  // A typed daily target. Blank means leave it as it is (value null). Otherwise a whole number from 0 to TARGET_MAX.
  function parseTarget(raw) {
    const s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (s === '') return { ok: true, value: null };
    if (!/^\d+$/.test(s)) return { ok: false, error: 'Targets are whole numbers, such as 20.' };
    const n = Number(s);
    if (n > TARGET_MAX) return { ok: false, error: 'Targets can be up to ' + TARGET_MAX + '.' };
    return { ok: true, value: n };
  }

  // Formula guard, the same as js/admin.js: a text cell starting with = + - @ (or a tab or CR) gets a leading apostrophe,
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

  // Columns of the weekly summary: every field of the first row except ids, in the order the database returns them.
  function summaryColumns(rows) {
    if (!rows || !rows.length) return [];
    return Object.keys(rows[0]).filter((k) => !/(^|_)id$/.test(k));
  }

  // A column name as a heading: connected_calls becomes "Connected calls".
  function headerText(key) {
    const s = String(key).replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Rep seats with no calls on the chosen day, sorted by label. Rows marked as admins are left out.
  function notCalling(rows) {
    return (rows || [])
      .filter((r) => (r.role === undefined || r.role === 'rep') && Number(r.calls || 0) === 0)
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  // Active rep seats from admin_seat_list rows.
  function repSeats(seats) {
    return (seats || []).filter((s) => s.role === 'rep' && s.status === 'active');
  }

  // Talk seconds as minutes with one decimal place.
  function talkMinutes(seconds) {
    return Math.round((Number(seconds) || 0) / 6) / 10;
  }

  const helpers = {
    NOT_YET, NOTE_MAX, TARGET_MAX, TARGETS, ymd, parseYmd, weekStart, barPercent, percentOfTarget, noteCheck,
    parseTarget, guardCell, csvCell, toCsv, summaryColumns, headerText, notCalling, repSeats, talkMinutes,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof window !== 'undefined') window.VectorAdminTeamHelpers = helpers;
})();
