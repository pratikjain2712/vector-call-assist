/* Per-call records for calls placed from the laptop, kept in this browser (vca2-calls),
   and the CSV export. Times come from the phone's clock and are shown as ISO 8601 with offset. */
(function () {
  const KEY = 'vca2-calls';

  function all() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function get(sessionId) { return all().find((r) => r.sessionId === sessionId) || null; }

  function add(rec) {
    const list = all().filter((r) => r.sessionId !== rec.sessionId);
    list.push(rec);
    write(list);
    return rec;
  }

  function update(sessionId, patch) {
    const list = all();
    const r = list.find((x) => x.sessionId === sessionId);
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: Date.now() });
    write(list);
    return r;
  }

  /* ISO 8601 in this browser's time zone, with the offset, e.g. 2026-10-11T19:43:06.203+05:30 */
  function iso(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const off = -d.getTimezoneOffset();
    const a = Math.abs(off);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' +
      p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3) +
      (off >= 0 ? '+' : '-') + p(Math.floor(a / 60)) + ':' + p(a % 60);
  }

  const COLUMNS = [
    'Session ID', 'Lead name', 'Phone', 'Dialled at', 'Line in use at', 'Call ended at',
    'Total call time (s)', 'Connected time (s)', 'Answered', 'Duration source', 'Call status',
    'Outcome', 'Objections raised', 'Notes', 'Save status', 'Updated at',
  ];

  /* Formula-injection guard: a leading = + - @ would make Excel run the cell as a formula. */
  function guard(v) {
    const s = v == null ? '' : String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }
  function quote(s) {
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function textCell(v) { return quote(guard(v)); }
  /* Phone numbers are written as ="+91…" so Excel keeps them as text (no scientific notation, no lost +). */
  function phoneCell(v) { return v ? quote('="' + String(v).replace(/"/g, '') + '"') : ''; }

  function row(r) {
    const total = r.offhookWallMs && r.endWallMs ? Math.round((r.endWallMs - r.offhookWallMs) / 1000) : '';
    return [
      textCell(r.sessionId), textCell(r.leadName), phoneCell(r.phoneE164 || r.phone),
      iso(r.dialWallMs), iso(r.offhookWallMs), iso(r.endWallMs),
      total, r.connectedSeconds == null ? '' : r.connectedSeconds,
      r.answered == null ? '' : (r.answered ? 'yes' : 'no'), textCell(r.detection || ''), textCell(r.callStatus || ''),
      textCell(r.outcome || ''), textCell(r.objections || ''), textCell(r.notes || ''),
      textCell(r.saveStatus || ''), iso(r.updatedAt),
    ].join(',');
  }

  /* UTF-8 with a byte-order mark (so Excel shows ₹ and names correctly), CRLF line endings. */
  function toCsv(list) {
    return '﻿' + [COLUMNS.join(',')].concat(list.map(row)).join('\r\n') + '\r\n';
  }

  function download(filename, list) {
    const blob = new Blob([toCsv(list)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  window.CallRecords = { all, get, add, update, iso, toCsv, download, COLUMNS };
})();
