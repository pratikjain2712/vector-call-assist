'use strict';
/* Excel (.xlsx) downloads for the admin app (web/admin.html), one workbook per report.
   Uses the same SheetJS build the calling page uses for its lead sheets (xlsx 0.18.5, see web/app.html and
   web/js/main.js), loaded only when someone downloads, from jsDelivr (allowed by the admin page's CSP) with the
   same integrity hash as the cdnjs copy: the two files are byte for byte the npm package.
   A sheet is { name, headers: [..], rows: [[..], ..], notes: [..] }: notes are plain lines under the table.
   Text cells get the same formula guard as the CSV downloads (js/admin.js), so a name such as "=1+1" stays text.
   Money rules are the caller's job (reports.js): leave the ₹ columns out unless ctx.canSeeMoney, and call
   log_money_export before building a file with them.
   The pure helpers are also loaded by tests/web/excel-export.test.js (Node, no DOM). */
(function () {
  const SRC = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const INTEGRITY = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';
  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const FORMULA_START = /^[=+\-@\t\r]/;          // same guard as js/admin.js
  const PHONE_LIKE = /^\+?[0-9][0-9 ()\-.]*$/;
  const BAD_SHEET_CHARS = /[\\/?*[\]:]/g;        // Excel refuses these in a sheet name
  const MAX_SHEET_NAME = 31;
  const MAX_COL_WIDTH = 50;

  // ---------- pure helpers ----------

  function guardCell(v) {
    if (typeof v !== 'string') return v;
    return FORMULA_START.test(v) && !PHONE_LIKE.test(v) ? "'" + v : v;
  }

  // One cell as Excel should get it: numbers stay numbers, null and undefined are empty, the rest is guarded text.
  function cellValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? v : '';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return guardCell(String(v));
  }

  // Header row, data rows and (after an empty row) the notes, as an array of arrays for SheetJS.
  function toAoa(sheet) {
    const aoa = [(sheet.headers || []).map(cellValue)];
    (sheet.rows || []).forEach((r) => aoa.push((r || []).map(cellValue)));
    const notes = (sheet.notes || []).filter(Boolean);
    if (notes.length) {
      aoa.push([]);
      notes.forEach((n) => aoa.push([cellValue(n)]));
    }
    return aoa;
  }

  // A sheet name Excel accepts: no \ / ? * [ ] :, 31 characters at most, not empty, not used twice.
  function sheetName(name, used) {
    let base = String(name || '').replace(BAD_SHEET_CHARS, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '');
    if (!base) base = 'Sheet';
    base = base.slice(0, MAX_SHEET_NAME).trim();
    const taken = used || new Set();
    let out = base;
    for (let i = 2; taken.has(out.toLowerCase()); i++) {
      const tail = ' (' + i + ')';
      out = base.slice(0, MAX_SHEET_NAME - tail.length).trim() + tail;
    }
    taken.add(out.toLowerCase());
    return out;
  }

  // Column widths from the longest value in each column (header and rows; notes are left out).
  function columnWidths(sheet) {
    const rows = [sheet.headers || []].concat(sheet.rows || []);
    const n = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
    const widths = [];
    for (let c = 0; c < n; c++) {
      const longest = rows.reduce((m, r) => {
        const v = r ? r[c] : '';
        return Math.max(m, v === null || v === undefined ? 0 : String(v).length);
      }, 0);
      widths.push({ wch: Math.min(MAX_COL_WIDTH, Math.max(8, longest + 2)) });
    }
    return widths;
  }

  // 'vector-fees-collection-2026-10-01-to-2026-10-07.xlsx': lower case, letters, digits and hyphens only.
  function fileName(parts) {
    const s = (parts || []).filter((p) => p !== null && p !== undefined && p !== '')
      .map((p) => String(p).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
      .filter(Boolean).join('-');
    return (s || 'vector-report') + '.xlsx';
  }

  // The workbook, built with the SheetJS object passed in (window.XLSX in the browser, require('xlsx') in tests).
  function build(X, sheets) {
    if (!sheets || !sheets.length) throw new Error('Nothing to put in the file.');
    const wb = X.utils.book_new();
    const used = new Set();
    sheets.forEach((s) => {
      const ws = X.utils.aoa_to_sheet(toAoa(s));
      ws['!cols'] = columnWidths(s);
      X.utils.book_append_sheet(wb, ws, sheetName(s.name, used));
    });
    return wb;
  }

  // ---------- browser only ----------

  let loading = null;

  // SheetJS, loaded once. Rejects with a plain message when it cannot load (offline, blocked).
  function load() {
    if (typeof window !== 'undefined' && window.XLSX && window.XLSX.utils) return Promise.resolve(window.XLSX);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.integrity = INTEGRITY;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.addEventListener('load', () => {
        if (window.XLSX && window.XLSX.utils) resolve(window.XLSX);
        else { loading = null; reject(new Error('The Excel writer did not load. Check your internet connection and try again.')); }
      });
      s.addEventListener('error', () => {
        loading = null;
        s.remove();
        reject(new Error('The Excel writer did not load. Check your internet connection and try again.'));
      });
      document.head.appendChild(s);
    });
    return loading;
  }

  // Builds the workbook and starts the download. Resolves when the browser has the file.
  async function download(sheets, name) {
    const X = await load();
    const buf = X.write(build(X, sheets), { type: 'array', bookType: 'xlsx' });
    const url = URL.createObjectURL(new Blob([buf], { type: MIME }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  const api = { SRC, INTEGRITY, MIME, guardCell, cellValue, toAoa, sheetName, columnWidths, fileName, build, load, download };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VectorExcel = api;
})();
