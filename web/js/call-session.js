/* Per-call records, kept in this browser (IndexedDB via Vault, key "calls"; never localStorage): calls placed from the laptop through the phone,
   and calls finished in the script without the phone ("manual"). Exported as the Calls tab of the
   results workbook. Times are shown as ISO 8601 with offset. */
(function () {
  const KEY = 'calls';

  function all() {
    const v = Vault.get(KEY);
    return Array.isArray(v) ? v : [];
  }
  function write(list) {
    Vault.set(KEY, list);   // in memory at once; the IndexedDB copy is written in the background
    return true;
  }
  function get(sessionId) { return all().find((r) => r.sessionId === sessionId) || null; }

  function add(rec) {
    const list = all().filter((r) => r.sessionId !== rec.sessionId);
    list.push(rec);
    write(list);
    return rec;
  }

  /* Undo of an outcome that created its record: the record goes. */
  function remove(sessionId) { write(all().filter((r) => r.sessionId !== sessionId)); }

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

  /* The Calls tab: one row per call attempt, built for dashboards. Fixed columns first, then one
     column per script question (the answer picked, blank if not asked) and one per objection
     ("Yes" if raised). Questions and objections come from the page so new ones get a column automatically. */
  const COLUMNS = [
    'Session ID', 'Call source', 'Lead row', 'Lead name', 'Phone',
    'Dialled at', 'Line in use at', 'Call ended at', 'Total call time (s)', 'Connected time (s)',
    'Answered', 'Duration source', 'Call status',
    'Outcome', 'Outcome code', 'Outcome at', 'Stage reached', 'Script time (s)', 'Answer path',
    'Objections raised', 'Notes', 'Save status', 'Updated at',
  ];
  const num = (v) => (v == null || v === '' ? '' : Number(v));

  /* questions: [{ key, label }], objections: [chip text]. Returns rows for SheetJS aoa_to_sheet. */
  function toAoa(list, questions, objections) {
    const header = COLUMNS.concat(questions.map((q) => 'Q: ' + q.label), objections.map((o) => 'Objection: ' + o));
    const rows = list.slice().sort((a, b) => (a.dialWallMs || a.outcomeAtMs || 0) - (b.dialWallMs || b.outcomeAtMs || 0)).map((r) => {
      const total = r.offhookWallMs && r.endWallMs ? Math.round((r.endWallMs - r.offhookWallMs) / 1000) : '';
      const answers = r.answers || {};
      const raised = r.objectionList || (r.objections ? String(r.objections).split('; ') : []);
      return [
        r.sessionId || '', r.source || 'laptop', r.rowIndex == null ? '' : r.rowIndex + 2, r.leadName || '', r.phoneE164 || r.phone || '',
        iso(r.dialWallMs), iso(r.offhookWallMs), iso(r.endWallMs), total, num(r.connectedSeconds),
        r.answered == null ? '' : (r.answered ? 'yes' : 'no'), r.detection || '', r.callStatus || '',
        r.outcome || '', r.outcomeCode || '', iso(r.outcomeAtMs), r.stageReached || '', num(r.scriptSeconds), r.path || '',
        raised.join('; '), r.notes || '', r.saveStatus || '', iso(r.updatedAt),
      ].concat(
        questions.map((q) => answers[q.key] || ''),
        objections.map((o) => (raised.includes(o) ? 'Yes' : '')),
      );
    });
    return [header].concat(rows);
  }

  /* Latest call for one sheet row, or null. Records made before sheetName existed match any sheet. */
  function latestFor(sheetName, rowIndex) {
    return all()
      .filter((r) => r.rowIndex === rowIndex && (r.sheetName == null || r.sheetName === sheetName))
      .sort((a, b) => (b.outcomeAtMs || b.dialWallMs || 0) - (a.outcomeAtMs || a.dialWallMs || 0))[0] || null;
  }

  window.CallRecords = { all, get, add, update, remove, iso, toAoa, latestFor, COLUMNS };
})();
