'use strict';
/* Fees tab of the admin app (web/admin.html), Phase A.2: the institute's fee ledger.
   - Summary: due now (all students), collected this month (ledger payments, by mode), promised and not yet
     paid, and broken promises (running and paused fees campaigns, judged against the ledger).
   - Students: search (name, parent, phone, admission no), class, board, academic year, "only with dues";
     total fees, paid, due now and the last payment; a totals row; pages of 50.
   - One student (#fees?student=<id>): details, fee items (add, void with a reason), payments (record, reverse
     with a reason; reversals stay in the list), calls made to the parent, and a printable receipt per payment.
   - Import students and fees from Excel or CSV (the same reader as the Campaigns tab), with a preview.
   - "Call parents with dues": a fees campaign made from the ledger.
   Who sees it: owners, managers who can see money, and Accounts seats (the shell shows Accounts only Fees and
   Reports). Owners and Accounts record payments and change the ledger; managers only read it and, with money
   access, make fees campaigns. The database checks every call.
   Reads: accounts_students, accounts_student_detail, ledger_collected, promises_vs_payments, and the call_types,
   campaigns and scripts tables (the fees type, its running campaigns, live scripts). Writes:
   accounts_record_payment, accounts_reverse_payment, accounts_add_fee_item, accounts_void_fee_item,
   accounts_import_students, accounts_create_fees_campaign. Contract: docs/data-contract.md, "Phase A.2".
   Money rules: ₹ only when the server returns it (money_hidden false); ledger amounts say "recorded in ledger",
   amounts from calls say "reported by caller". No bank, card or UPI ids: a reference is a UTR or cheque number.
   The pure helpers at the top are also loaded by tests/web/fees-tab.test.js (Node, no DOM). */
(function () {
  const inNode = typeof window === 'undefined' && typeof module !== 'undefined' && module.exports;
  const S = inNode ? require('./shared.js') : window.VectorAdminShared;
  const IC = inNode ? require('../import-check.js') : window.ImportCheck;
  const LU = inNode ? require('../lead-upload.js') : window.LeadUpload;

  // ---------- pure helpers ----------

  const MODES = [['upi', 'UPI'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['card', 'Card'], ['bank', 'Bank transfer'], ['other', 'Other']];
  const REF_MODES = ['upi', 'bank', 'card'];
  const BOARDS = ['CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other'];
  const PAGE_SIZE = 50;
  const LIST_LIMIT = 5000;
  const IMPORT_CHUNK = 5000;
  const RECORDED_IN_LEDGER = 'recorded in ledger';
  const ACCOUNTS_TABS = ['fees', 'reports'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const plural = (n, one, many) => S.count(n) + ' ' + (Number(n) === 1 ? one : many);

  const modeLabel = (m) => (MODES.find((x) => x[0] === m) || [m, String(m || '')])[1];
  const needsReference = (mode) => REF_MODES.includes(mode);

  // Who may do what. seat: my_active_seat (access_role owner / manager / caller / accounts; old seats have role only).
  function roleOf(seat) {
    const s = seat || {};
    if (s.access_role) return s.access_role;
    if (s.role === 'accounts') return 'accounts';
    return s.role === 'admin' ? 'owner' : 'caller';
  }
  const isAccounts = (seat) => roleOf(seat) === 'accounts';
  const canManage = (seat) => ['owner', 'accounts'].includes(roleOf(seat));
  const canMakeCampaign = (seat, money) => canManage(seat) || (roleOf(seat) === 'manager' && !!money);
  // The Fees tab: owners, Accounts, and managers who can see money.
  const tabVisible = (seat, money) => ['owner', 'accounts'].includes(roleOf(seat)) || (roleOf(seat) === 'manager' && !!money);

  // Indian money with paise when there are any: 1250000 to '₹12,50,000', 99.5 to '₹99.50'. '' when missing.
  function rupees2(amount) {
    const n = num(amount);
    if (n === null || !Number.isFinite(n)) return '';
    const paise = Math.round(Math.abs(n) * 100) % 100;
    const whole = S.rupees((n < 0 ? -1 : 1) * Math.floor(Math.round(Math.abs(n) * 100) / 100));
    return paise ? whole + '.' + pad2(paise) : whole;
  }

  // An amount in words, Indian style (lakh, crore), for receipts: 12550.5 to
  // 'Rupees Twelve Thousand Five Hundred Fifty and Fifty Paise Only'. '' for a missing or negative amount.
  const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function twoDigits(n) {
    if (n < 20) return ONES[n];
    return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  }
  function indianWords(n) {
    if (n === 0) return 'Zero';
    const parts = [];
    const crore = Math.floor(n / 1e7);
    const lakh = Math.floor((n % 1e7) / 1e5);
    const thousand = Math.floor((n % 1e5) / 1e3);
    const hundred = Math.floor((n % 1e3) / 100);
    const rest = n % 100;
    if (crore) parts.push(indianWords(crore) + ' Crore');
    if (lakh) parts.push(twoDigits(lakh) + ' Lakh');
    if (thousand) parts.push(twoDigits(thousand) + ' Thousand');
    if (hundred) parts.push(ONES[hundred] + ' Hundred');
    if (rest) parts.push(twoDigits(rest));
    return parts.join(' ');
  }
  function amountInWords(amount) {
    const n = num(amount);
    if (n === null || !Number.isFinite(n) || n < 0) return '';
    const paiseAll = Math.round(n * 100);
    const r = Math.floor(paiseAll / 100);
    const p = paiseAll % 100;
    return 'Rupees ' + indianWords(r) + (p ? ' and ' + twoDigits(p) + ' Paise' : '') + ' Only';
  }

  // The receipt number of a payment: 'R-' and the first 8 characters of its id, in capitals.
  function receiptNo(paymentId) {
    const s = String(paymentId || '').replace(/[^0-9a-z]/gi, '');
    return s ? 'R-' + s.slice(0, 8).toUpperCase() : '';
  }

  // A date cell to 'YYYY-MM-DD': 2026-11-05, 05/11/2026, 5-11-2026, 05.11.26 (day first, as in India).
  // '' for a blank cell, null when it is not a real date.
  function parseDay(v) {
    const s = String(v === null || v === undefined ? '' : v).trim();
    if (!s) return '';
    let y, m, d;
    let x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (x) { y = +x[1]; m = +x[2]; d = +x[3]; } else {
      x = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
      if (!x) return null;
      d = +x[1]; m = +x[2]; y = +x[3];
      if (x[3].length === 2) y += 2000;
    }
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return ymd(dt);
  }

  // '2026-27', '2026-2027', '2026/27' to '2026-27'. '' for blank, null when it is not a year pair.
  function parseYear(v) {
    const s = String(v === null || v === undefined ? '' : v).trim();
    if (!s) return '';
    const x = /^(\d{4})\s*[-/–]\s*(\d{2}|\d{4})$/.exec(s);
    if (!x) return null;
    return x[1] + '-' + x[2].slice(-2);
  }

  // A board as the database keeps it: 'cbse' to 'CBSE', 'State board' to 'State'. '' for blank, null when unknown.
  function parseBoard(v) {
    const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase().replace(/\s+board$/, '').replace(/^board\s+/, '');
    if (!s) return '';
    if (s === 'state' || s === 'ssc' || s === 'state syllabus') return 'State';
    const hit = BOARDS.find((b) => b.toLowerCase() === s);
    return hit || null;
  }

  // ---------- import: column guessing ----------

  const IMPORT_FIELDS = [
    ['admission_no', 'Admission no'], ['name', 'Student name'], ['class_label', 'Class'], ['section', 'Section'],
    ['board', 'Board'], ['academic_year', 'Academic year'], ['parent_name', 'Parent name'], ['phone', 'Phone'],
    ['alt_phone', 'Alternate phone'], ['paid_so_far', 'Paid so far'], ['paid_on', 'Paid on'],
  ];
  const norm = (h) => String(h || '').toLowerCase().replace(/[₹().:#_]/g, ' ').replace(/\s+/g, ' ').trim();
  const PHONE_WORD = /\b(phone|mobile|mob|whatsapp|contact|cell|number|no)\b/;

  // Best guess of each column (-1 when none) and of the fee columns, from the header row.
  // Fee columns: numbered groups ('Fee head 1', 'Amount 1', 'Due date 1'), one 'Fee head' + 'Amount' + 'Due date',
  // or money columns named after the fee ('Tuition fee', with 'Tuition due date' or one shared 'Due date').
  // Returns { admission_no, name, ..., fees: [{ head, headCol, amount, due }] }.
  function guessImportColumns(header) {
    const h = (header || []).map(norm);
    const taken = new Set();
    const find = (test) => {
      for (let i = 0; i < h.length; i++) if (!taken.has(i) && test(h[i])) { taken.add(i); return i; }
      return -1;
    };
    const map = {};
    map.admission_no = find((x) => /\b(admission|adm|admn|enrol+ment|enrol+|registration|reg|gr|sr|scholar)\b/.test(x) && !/date/.test(x));
    map.paid_on = find((x) => /\b(paid|payment|received)\b.*\b(on|date)\b|\bdate of payment\b/.test(x));
    map.paid_so_far = find((x) => /\b(paid|received|collected)\b/.test(x) && !/\b(date|on|mode)\b/.test(x));
    map.alt_phone = find((x) => PHONE_WORD.test(x) && /\b(alt|alternate|alternative|other|second|2|secondary)\b/.test(x));
    map.parent_name = find((x) => /\b(parent|father|mother|guardian)\b/.test(x) && !PHONE_WORD.test(x));
    map.phone = find((x) => /\b(phone|mobile|mob|whatsapp|contact|cell)\b/.test(x));
    map.name = find((x) => /^(student|child|ward|pupil)('?s)?( full)? name$|^(full )?name$|^student$|^name of (the )?student$/.test(x));
    if (map.name < 0) map.name = find((x) => /\bname\b/.test(x) && !/\b(parent|father|mother|guardian|fee|head|school)\b/.test(x));
    map.class_label = find((x) => /^(class|grade|std|standard)\b/.test(x) && !/\bsection\b/.test(x));
    map.section = find((x) => /^(section|sec|div|division)\b/.test(x));
    map.board = find((x) => /\b(board|curriculum|syllabus)\b/.test(x));
    map.academic_year = find((x) => /\b(academic|session)\b|^year$/.test(x));

    const fees = [];
    // Numbered groups.
    const groups = new Map();
    h.forEach((x, i) => {
      if (taken.has(i)) return;
      let m = /^(fee )?(head|name|particular|particulars|type)\s*(\d+)$/.exec(x);
      if (m) { const g = groups.get(m[3]) || {}; g.headCol = i; groups.set(m[3], g); return; }
      m = /^(fee |fees )?(amount|fee|fees)\s*(\d+)$/.exec(x);
      if (m) { const g = groups.get(m[3]) || {}; g.amount = i; groups.set(m[3], g); return; }
      m = /^(fee )?due( date| on)?\s*(\d+)$/.exec(x);
      if (m) { const g = groups.get(m[3]) || {}; g.due = i; groups.set(m[3], g); }
    });
    [...groups.keys()].sort((a, b) => a - b).forEach((k) => {
      const g = groups.get(k);
      if (g.amount === undefined) return;
      [g.headCol, g.amount, g.due].forEach((i) => { if (i !== undefined) taken.add(i); });
      fees.push({ head: g.headCol === undefined ? 'Fee ' + k : '', headCol: g.headCol === undefined ? -1 : g.headCol, amount: g.amount, due: g.due === undefined ? -1 : g.due });
    });
    // One 'Fee head' column with 'Amount' and 'Due date'.
    if (!fees.length) {
      const headCol = h.findIndex((x, i) => !taken.has(i) && /^(fee )?(head|particular|particulars|fee type|fee name)$/.test(x));
      const amount = h.findIndex((x, i) => !taken.has(i) && /^(fee )?amount$/.test(x));
      if (headCol >= 0 && amount >= 0) {
        taken.add(headCol); taken.add(amount);
        const due = find((x) => /^(fee )?due( date| on)?$/.test(x));
        fees.push({ head: '', headCol, amount, due });
      }
    }
    // Money columns named after the fee.
    const shared = () => h.findIndex((x, i) => !taken.has(i) && /^(fee |fees )?due( date| on| by)?$|^last date$/.test(x));
    h.forEach((x, i) => {
      if (taken.has(i)) return;
      if (!LU.looksLikeMoney(header[i]) || /\b(paid|balance|total|due|pending|outstanding|discount|concession)\b/.test(x)) return;
      const head = x.replace(/\b(fee|fees|amount|rs|inr|rupees)\b/g, ' ').replace(/\s+/g, ' ').trim();
      const title = head ? head.charAt(0).toUpperCase() + head.slice(1) : 'Fee';
      taken.add(i);
      let due = head ? h.findIndex((y, j) => !taken.has(j) && y.includes(head) && /\b(due|date|by)\b/.test(y)) : -1;
      if (due >= 0) taken.add(due);
      fees.push({ head: title, headCol: -1, amount: i, due });
    });
    // Fee groups without a due date column share a plain 'Due date' column.
    const s = shared();
    if (s >= 0 && fees.some((f) => f.due < 0)) {
      taken.add(s);
      fees.forEach((f) => { if (f.due < 0) f.due = s; });
    }
    map.fees = fees;
    return map;
  }

  // The rows accounts_import_students takes, from the sheet and the column choices.
  // Returns { rows, sheetRows (the sheet row of each row, header = 1), problems [{ row, reason }], counts }.
  // The server checks everything again and says why it skipped a row.
  function buildImportRows(sheet, map, opts) {
    const rows = (sheet && sheet.rows) || [];
    const m = map || {};
    const o = opts || {};
    const out = [];
    const sheetRows = [];
    const problems = [];
    const seen = new Set();
    const cell = (r, i) => (i === undefined || i === null || i < 0 ? '' : String(r[i] === null || r[i] === undefined ? '' : r[i]).trim());
    rows.forEach((r, idx) => {
      const at = idx + 2;
      const bad = (reason) => { problems.push({ row: at, reason }); };
      const name = cell(r, m.name).slice(0, 120);
      if (!name) return bad('No student name');
      const row = { name };
      const adm = cell(r, m.admission_no).slice(0, 40);
      if (adm) {
        if (seen.has(adm.toLowerCase())) return bad('Admission number ' + adm + ' is twice in the file');
        row.admission_no = adm;
      }
      ['class_label', 'section'].forEach((k) => { const v = cell(r, m[k]).slice(0, 20); if (v) row[k] = v; });
      const parent = cell(r, m.parent_name).slice(0, 120);
      if (parent) row.parent_name = parent;
      const board = parseBoard(cell(r, m.board));
      if (board === null) return bad('Unknown board "' + cell(r, m.board) + '" (use CBSE, ICSE, State, IB, IGCSE or Other)');
      if (board) row.board = board;
      const year = parseYear(cell(r, m.academic_year) || o.academicYear || '');
      if (year === null) return bad('Academic year should look like 2026-27');
      if (year) row.academic_year = year;
      for (const k of ['phone', 'alt_phone']) {
        const raw = cell(r, m[k]);
        if (!raw) continue;
        const p = IC.normalizePhone(raw);
        if (p.status !== 'ok') return bad((k === 'phone' ? 'Phone' : 'Alternate phone') + ' is not a 10-digit number');
        row[k] = '+91' + p.digits;
      }
      const paidRaw = cell(r, m.paid_so_far);
      if (paidRaw) {
        const paid = LU.parseAmount(paidRaw);
        if (Number.isNaN(paid)) return bad('Paid so far is not an amount');
        if (paid) row.paid_so_far = paid;
      }
      const paidOn = parseDay(cell(r, m.paid_on));
      if (paidOn === null) return bad('Paid on is not a date');
      if (paidOn && row.paid_so_far) row.paid_on = paidOn;
      const fees = [];
      for (const f of m.fees || []) {
        const amountRaw = cell(r, f.amount);
        if (!amountRaw) continue;
        const head = (f.headCol >= 0 ? cell(r, f.headCol) : '') || String(f.head || '').trim();
        const amount = LU.parseAmount(amountRaw);
        if (Number.isNaN(amount)) return bad('Fee amount "' + amountRaw + '" is not an amount');
        if (!amount) continue;
        if (!head) return bad('A fee has no name (fee head)');
        const due = parseDay(cell(r, f.due));
        if (due === null) return bad('Due date of ' + head + ' is not a date');
        if (!due) return bad(head + ' has no due date');
        const fee = { head: head.slice(0, 80), amount, due_date: due };
        if (year) fee.academic_year = year;
        fees.push(fee);
      }
      if (fees.length) row.fees = fees;
      if (adm) seen.add(adm.toLowerCase());
      out.push(row);
      sheetRows.push(at);
    });
    return { rows: out, sheetRows, problems, counts: { total: rows.length, ready: out.length, skipped: problems.length } };
  }

  // The server's skipped_rows ({ row: n-th row sent }) as sheet rows.
  function serverSkips(result, sheetRows) {
    return ((result && result.skipped_rows) || []).map((s) => ({ row: (sheetRows || [])[Number(s.row) - 1] || s.row, reason: s.reason }));
  }

  // Adds up accounts_import_students answers.
  function addImportCounts(a, b) {
    const out = {};
    ['added', 'updated', 'skipped', 'fee_items_added', 'payments_added'].forEach((k) => { out[k] = (Number((a || {})[k]) || 0) + (Number((b || {})[k]) || 0); });
    return out;
  }

  // 'Added 12 students, updated 3, skipped 1. 30 fee items and 5 opening payments added.'
  function importSummary(c) {
    const x = c || {};
    return 'Added ' + plural(x.added || 0, 'student', 'students') + ', updated ' + S.count(x.updated || 0) +
      ', skipped ' + S.count(x.skipped || 0) + '. ' + plural(x.fee_items_added || 0, 'fee item', 'fee items') + ' and ' +
      plural(x.payments_added || 0, 'opening payment', 'opening payments') + ' added.';
  }

  // ---------- list ----------

  // The list filters as accounts_students takes them. Blank filters are left out.
  function filtersToRpc(f) {
    const x = f || {};
    const out = { status: 'active', limit: LIST_LIMIT };
    const s = String(x.search || '').trim();
    if (s) out.search = s.slice(0, 80);
    ['class_label', 'board', 'academic_year'].forEach((k) => { const v = String(x[k] || '').trim(); if (v) out[k] = v; });
    if (x.only_due) out.only_due = true;
    return out;
  }

  // Totals of the listed students. Due now adds only what is owed (an advance does not lower it).
  // Amounts are null when any row came back without money.
  function listTotals(rows) {
    const list = rows || [];
    const money = list.every((r) => !r.money_hidden);
    const sum = (k, pos) => list.reduce((t, r) => t + Math.max(pos ? 0 : -Infinity, Number(r[k]) || 0), 0);
    return {
      students: list.length,
      with_dues: list.filter((r) => Number(r.balance_due_now) > 0).length,
      total_fees: money ? sum('total_fees') : null,
      paid: money ? sum('paid') : null,
      due_now: money ? sum('balance_due_now', true) : null,
      money,
    };
  }

  // One page of rows: { rows, page (1-based, kept in range), pages, from, to } (from and to are 1-based, for "1–50 of 120").
  function pageOf(rows, page, size) {
    const list = rows || [];
    const n = size || PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(list.length / n));
    const p = Math.min(Math.max(1, Number(page) || 1), pages);
    const start = (p - 1) * n;
    const part = list.slice(start, start + n);
    return { rows: part, page: p, pages, from: part.length ? start + 1 : 0, to: start + part.length };
  }

  // Distinct values for a filter (class, year), sorted like the school does: '8', '9', '10', then words.
  function choices(rows, key) {
    const set = new Set((rows || []).map((r) => String(r[key] || '').trim()).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
  }

  // ---------- payments ----------

  // What is wrong with a payment form, or '' when it can be sent. today: 'YYYY-MM-DD'.
  function paymentProblem(p, today) {
    const x = p || {};
    const amount = LU.parseAmount(x.amount);
    if (amount === null || Number.isNaN(amount) || amount <= 0) return 'Enter the amount paid, in rupees.';
    if (!x.paid_on) return 'Enter the date of the payment.';
    if (!parseDay(x.paid_on)) return 'Enter the date of the payment.';
    if (today && x.paid_on > today) return 'The payment date cannot be in the future.';
    if (!MODES.some((mm) => mm[0] === x.mode)) return 'Pick how it was paid.';
    const ref = String(x.reference || '').trim();
    if (needsReference(x.mode) && !ref) return 'Enter the reference (UTR or transaction number) for a ' + modeLabel(x.mode) + ' payment.';
    if (ref.length > 60) return 'The reference is too long (60 characters at most).';
    if (/@/.test(ref)) return 'Enter the UTR or transaction number, not a UPI ID.';
    if (String(x.note || '').length > 300) return 'The note is too long (300 characters at most).';
    return '';
  }

  // Payments for the table: each with its receipt number, and whether it is a reversal or was reversed.
  function paymentRows(payments) {
    const list = payments || [];
    return list.map((p) => ({
      ...p,
      receipt: receiptNo(p.id),
      is_reversal: !!p.reverses_id,
      reversed: !!p.reversed_by,
      of_receipt: p.reverses_id ? receiptNo(p.reverses_id) : '',
      reversal_receipt: p.reversed_by ? receiptNo(p.reversed_by) : '',
    }));
  }

  // ---------- summary ----------

  // 'YYYY-MM-01' to today, local dates.
  function monthRange(now) {
    const d = now || new Date();
    return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(d) };
  }

  // promises_vs_payments answers of several campaigns, added up: promises waiting or part paid (and what is
  // still to come on them), and broken promises. Amounts null when any answer hid money.
  function promiseTotals(results) {
    const list = (results || []).filter(Boolean);
    const money = list.every((r) => !r.money_hidden);
    const t = { open: 0, open_amount: money ? 0 : null, broken: 0, broken_amount: money ? 0 : null, kept: 0, promises: 0, money };
    list.forEach((r) => {
      t.promises += Number(r.promises) || 0;
      t.kept += Number(r.kept) || 0;
      t.broken += Number(r.broken) || 0;
      t.open += (Number(r.waiting) || 0) + (Number(r.part_paid) || 0);
      (r.rows || []).forEach((x) => {
        if (!money) return;
        const promised = Number(x.promised_amount) || 0;
        const paid = Number(x.paid_amount) || 0;
        if (x.state === 'waiting' || x.state === 'part_paid') t.open_amount += Math.max(0, promised - paid);
        if (x.state === 'broken') t.broken_amount += promised;
      });
    });
    return t;
  }

  // ledger_collected by mode, biggest first: [{ mode, label, payments, amount }].
  function collectedByMode(data) {
    return ((data && data.by_mode) || []).map((m) => ({ mode: m.mode, label: modeLabel(m.mode), payments: Number(m.payments) || 0, amount: num(m.amount) }))
      .sort((a, b) => (b.amount || 0) - (a.amount || 0) || b.payments - a.payments);
  }

  // The default name of a fees campaign: 'Fees · 8th · CBSE · due by 15 Nov'.
  function campaignName(f) {
    const x = f || {};
    return ['Fees', String(x.class_label || '').trim(), String(x.board || '').trim(),
      x.due_by ? 'due by ' + S.formatDate(x.due_by, { year: false }) : ''].filter(Boolean).join(' · ');
  }

  const helpers = {
    MODES, REF_MODES, BOARDS, PAGE_SIZE, LIST_LIMIT, RECORDED_IN_LEDGER, ACCOUNTS_TABS, IMPORT_FIELDS,
    modeLabel, needsReference, roleOf, isAccounts, canManage, canMakeCampaign, tabVisible, rupees2, amountInWords,
    receiptNo, parseDay, parseYear, parseBoard, guessImportColumns, buildImportRows, serverSkips, addImportCounts,
    importSummary, filtersToRpc, listTotals, pageOf, choices, paymentProblem, paymentRows, monthRange,
    promiseTotals, collectedByMode, campaignName,
  };
  if (inNode) { module.exports = helpers; return; }

  // ---------- the page (browser only) ----------

  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const XLSX_SRI = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';

  let ctx = null;
  let box = null;
  let allRows = [];        // every active student (summary and filter choices)
  let listRows = [];       // the filtered list
  let page = 1;
  let detail = null;       // accounts_student_detail of the open student
  let studentId = null;
  let feesTypeId = null;
  let imp = null;          // { sheet, map, file, built }
  let xlsxLoading = null;
  let searchTimer = null;
  let seq = { list: 0, all: 0, detail: 0, summary: 0 };

  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const field = (text, input, cls) => el('label', { className: cls || null }, [text + ' ', input]);
  const cell = (text, cls, label) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || null, 'data-label': label || null });
  const money = (v) => (v === null || v === undefined ? '' : rupees2(v));
  const today = () => ymd(new Date());
  const rows = (d) => (Array.isArray(d) ? d : d ? [d] : []);
  const errText = (err) => (err && err.message ? err.message : 'Try again.');

  // ---------- page ----------

  function build() {
    const manage = canManage(ctx.seat);
    const head = el('div', { className: 'tab-head' }, [
      el('h1', { text: 'Fees' }),
      el('p', { className: 'muted', text: 'Students, their fees and the payments your fees office recorded.' }),
    ]);
    if (isAccounts(ctx.seat)) {
      head.appendChild(el('p', { className: 'small' }, [el('a', { href: 'reset.html', id: 'fees-password', text: 'Change your password' })]));
    }
    box.appendChild(head);

    box.appendChild(el('div', { className: 'panel fees-summary', id: 'fees-summary', 'aria-labelledby': 'fees-summary-h' }, [
      el('h2', { id: 'fees-summary-h', text: 'Summary' }),
      el('div', { className: 'fees-cards', id: 'fees-cards' }),
      el('p', { id: 'fees-modes', className: 'muted small' }),
      msg('fees-summary-msg'),
    ]));

    const actions = el('div', { className: 'fees-actions', id: 'fees-actions' });
    if (manage) actions.appendChild(el('button', { type: 'button', id: 'fees-import-open', text: 'Import students and fees' }));
    if (canMakeCampaign(ctx.seat, ctx.canSeeMoney)) actions.appendChild(el('button', { type: 'button', id: 'fees-camp-open', text: 'Call parents with dues' }));
    box.appendChild(actions);

    box.appendChild(el('div', { className: 'panel fees-import', id: 'fees-import', hidden: true }));
    box.appendChild(el('div', { className: 'panel fees-camp', id: 'fees-camp', hidden: true }));

    const boardSel = el('select', { id: 'fees-f-board' }, [el('option', { value: '', text: 'All boards' })]
      .concat(BOARDS.map((b) => el('option', { value: b, text: b }))));
    box.appendChild(el('div', { className: 'panel fees-list', id: 'fees-list' }, [
      el('h2', { text: 'Students' }),
      el('form', { id: 'fees-filters', className: 'row fees-filters', role: 'search' }, [
        field('Search', el('input', { id: 'fees-f-search', type: 'search', placeholder: 'Name, parent, phone or admission no', autocomplete: 'off' }), 'grow'),
        field('Class', el('select', { id: 'fees-f-class' }, [el('option', { value: '', text: 'All classes' })])),
        field('Board', boardSel),
        field('Academic year', el('select', { id: 'fees-f-year' }, [el('option', { value: '', text: 'All years' })])),
        el('label', { className: 'check' }, [el('input', { type: 'checkbox', id: 'fees-f-due' }), ' Only with dues']),
      ]),
      msg('fees-list-msg'),
      el('div', { className: 'scroll' }, [el('table', { className: 'stack fees-table', id: 'fees-table' }, [
        el('thead', null, [el('tr', null, [
          el('th', { text: 'Student' }), el('th', { text: 'Class' }), el('th', { text: 'Parent' }),
          el('th', { className: 'num', text: 'Total fees' }), el('th', { className: 'num', text: 'Paid' }),
          el('th', { className: 'num', text: 'Due now' }), el('th', { text: 'Last payment' }),
        ])]),
        el('tbody', { id: 'fees-body' }),
        el('tfoot', { id: 'fees-foot' }),
      ])]),
      el('p', { id: 'fees-empty', className: 'muted', hidden: true, text: 'No students match. Import your students and fees to start.' }),
      el('div', { className: 'fees-pager', id: 'fees-pager' }, [
        el('button', { type: 'button', id: 'fees-prev', text: 'Previous' }),
        el('span', { id: 'fees-page', className: 'muted small', 'aria-live': 'polite' }),
        el('button', { type: 'button', id: 'fees-next', text: 'Next' }),
      ]),
    ]));

    box.appendChild(el('div', { className: 'fees-student', id: 'fees-student', hidden: true }));
    box.appendChild(el('div', { className: 'panel fees-receipt', id: 'fees-receipt', hidden: true, role: 'region', 'aria-labelledby': 'fees-r-title' }));
  }

  function wire() {
    $('fees-filters').addEventListener('submit', (e) => { e.preventDefault(); loadList(); });
    $('fees-f-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadList, 300);
    });
    ['fees-f-class', 'fees-f-board', 'fees-f-year', 'fees-f-due'].forEach((id) => $(id).addEventListener('change', loadList));
    $('fees-prev').addEventListener('click', () => { page--; renderList(); });
    $('fees-next').addEventListener('click', () => { page++; renderList(); });
    if ($('fees-import-open')) $('fees-import-open').addEventListener('click', () => togglePanel('fees-import', openImport));
    if ($('fees-camp-open')) $('fees-camp-open').addEventListener('click', () => togglePanel('fees-camp', openCampaign));
  }

  function togglePanel(id, open) {
    const p = $(id);
    if (!p.hidden) { p.hidden = true; return; }
    ['fees-import', 'fees-camp'].forEach((x) => { $(x).hidden = x !== id; });
    open();
    p.hidden = false;
    const h = p.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
  }

  // ---------- views ----------

  function showView(params) {
    const id = params && params.student;
    closeReceipt();
    const listView = !id;
    ['fees-summary', 'fees-actions', 'fees-list'].forEach((x) => { $(x).hidden = !listView; });
    if (listView) { $('fees-import').hidden = true; $('fees-camp').hidden = true; }
    $('fees-student').hidden = listView;
    if (listView) {
      const wasStudent = !!studentId;
      studentId = null;
      detail = null;
      if (wasStudent) { loadAll(); loadList(); }
      return;
    }
    if (id !== studentId) {
      studentId = id;
      loadStudent(id);
    }
  }

  // ---------- summary ----------

  // Every active student, for "due now" and the filter choices.
  async function loadAll() {
    const n = ++seq.all;
    try {
      const data = rows(await ctx.rpc('accounts_students', { p_filters: { status: 'active', limit: LIST_LIMIT } }));
      if (n !== seq.all || !ctx) return;
      allRows = data;
      fillChoices();
      renderSummary();
    } catch (err) {
      if (n === seq.all && ctx) say('fees-summary-msg', 'Could not load the students: ' + errText(err), true);
    }
  }

  function fillChoices() {
    const fill = (id, list, all) => {
      const sel = $(id);
      const keep = sel.value;
      sel.textContent = '';
      sel.appendChild(el('option', { value: '', text: all }));
      list.forEach((v) => sel.appendChild(el('option', { value: v, text: v })));
      if (keep && list.includes(keep)) sel.value = keep;
    };
    fill('fees-f-class', choices(allRows, 'class_label'), 'All classes');
    fill('fees-f-year', choices(allRows, 'academic_year'), 'All years');
  }

  let collected = null;
  let promises = null;

  async function loadSummary() {
    const n = ++seq.summary;
    const r = monthRange(new Date());
    const [c, p] = await Promise.all([
      ctx.rpc('ledger_collected', { p_institute: ctx.institute.id, p_from: r.from, p_to: r.to }).catch((err) => ({ error: err })),
      loadPromises().catch((err) => ({ error: err })),
    ]);
    if (n !== seq.summary || !ctx) return;
    collected = c;
    promises = p;
    renderSummary();
  }

  // promises_vs_payments of each running or paused fees campaign the seat can read.
  async function loadPromises() {
    const typeId = await feesType();
    if (!typeId) return promiseTotals([]);
    const { data, error } = await ctx.client.from('campaigns').select('id, name, status, call_type_id')
      .eq('institute_id', ctx.institute.id).eq('call_type_id', typeId).in('status', ['running', 'paused']);
    if (error) throw new Error(error.message);
    const list = await Promise.all((data || []).map((c) => ctx.rpc('promises_vs_payments', { p_campaign: c.id }).catch(() => null)));
    const t = promiseTotals(list);
    t.campaigns = (data || []).length;
    return t;
  }

  // The id of the built-in fees call type (for the campaigns and the scripts of fees calls).
  async function feesType() {
    if (feesTypeId) return feesTypeId;
    const { data, error } = await ctx.client.from('call_types').select('id, key').eq('key', 'fees').is('institute_id', null);
    if (error) throw new Error(error.message);
    feesTypeId = data && data[0] ? data[0].id : null;
    return feesTypeId;
  }

  function card(label, value, sub, level, id) {
    return el('div', { className: 'fees-card' + (level ? ' ' + level : ''), id: id || null }, [
      el('div', { className: 'fees-card-label', text: label }),
      el('div', { className: 'fees-card-value', text: value }),
      el('div', { className: 'fees-card-sub', text: sub }),
    ]);
  }

  function renderSummary() {
    const box2 = $('fees-cards');
    if (!box2) return;
    box2.textContent = '';
    const t = listTotals(allRows);
    box2.appendChild(card('Due now', t.money ? rupees2(t.due_now) : S.count(t.with_dues),
      plural(t.with_dues, 'student', 'students') + ' · ' + RECORDED_IN_LEDGER, 'bad', 'fees-card-due'));
    const c = collected && !collected.error ? collected : null;
    box2.appendChild(card('Collected this month', c ? (c.money_hidden ? S.count(c.payments || 0) : rupees2(c.total || 0)) : '…',
      c ? plural(c.payments || 0, 'payment', 'payments') + ' · ' + RECORDED_IN_LEDGER : (collected && collected.error ? 'Could not load' : ''), 'good', 'fees-card-collected'));
    const p = promises && !promises.error ? promises : null;
    box2.appendChild(card('Promised, not yet paid', p ? (p.money ? rupees2(p.open_amount) : S.count(p.open)) : '…',
      p ? plural(p.open, 'promise', 'promises') + ' · ' + S.REPORTED_BY_CALLER : (promises && promises.error ? 'Could not load' : ''), '', 'fees-card-promised'));
    box2.appendChild(card('Broken promises', p ? S.count(p.broken) : '…',
      p ? (p.money && p.broken ? rupees2(p.broken_amount) + ' promised, nothing paid' : 'Promise date + 2 days passed, nothing paid') : '', 'bad', 'fees-card-broken'));
    const modes = c ? collectedByMode(c) : [];
    $('fees-modes').textContent = modes.length
      ? 'This month by mode: ' + modes.map((m) => m.label + ' ' + (m.amount === null ? plural(m.payments, 'payment', 'payments') : rupees2(m.amount))).join(' · ')
      : (c ? 'No payments recorded this month yet.' : '');
    if (!t.money && allRows.length) say('fees-summary-msg', 'Amounts are hidden for you, so you see counts only.');
  }

  // ---------- list ----------

  function currentFilters() {
    return {
      search: $('fees-f-search').value, class_label: $('fees-f-class').value, board: $('fees-f-board').value,
      academic_year: $('fees-f-year').value, only_due: $('fees-f-due').checked,
    };
  }

  async function loadList() {
    const n = ++seq.list;
    say('fees-list-msg', 'Loading…');
    try {
      const data = rows(await ctx.rpc('accounts_students', { p_filters: filtersToRpc(currentFilters()) }));
      if (n !== seq.list || !ctx) return;
      listRows = data;
      page = 1;
      renderList();
      say('fees-list-msg', listRows.length >= LIST_LIMIT ? 'Showing the first ' + S.count(LIST_LIMIT) + ' students. Use the filters to narrow the list.' : '');
    } catch (err) {
      if (n === seq.list && ctx) say('fees-list-msg', 'Could not load the students: ' + errText(err), true);
    }
  }

  function renderList() {
    const body = $('fees-body');
    const foot = $('fees-foot');
    body.textContent = '';
    foot.textContent = '';
    const pg = pageOf(listRows, page, PAGE_SIZE);
    page = pg.page;
    pg.rows.forEach((r) => {
      const link = el('a', { href: S.buildHash('fees', { student: r.student_id }), text: r.name, className: 'fees-name' });
      const who = el('td', { 'data-label': 'Student' }, [link]);
      if (r.admission_no) who.appendChild(el('div', { className: 'muted small', text: 'Adm. no ' + r.admission_no }));
      const cls = [r.class_label, r.section].filter(Boolean).join('-') + (r.board ? ' · ' + r.board : '');
      const parent = el('td', { 'data-label': 'Parent' }, [
        el('div', { text: r.parent_name || '' }),
        el('div', { className: 'muted small', text: r.phone || 'No phone' }),
      ]);
      const due = Number(r.balance_due_now);
      const last = r.last_payment_on
        ? [money(r.last_payment_amount), S.formatDate(r.last_payment_on), modeLabel(r.last_payment_mode)].filter(Boolean).join(' · ')
        : 'None yet';
      body.appendChild(el('tr', null, [
        who, cell(cls, '', 'Class'), parent,
        cell(r.money_hidden ? '' : money(r.total_fees), 'num', 'Total fees'),
        cell(r.money_hidden ? '' : money(r.paid), 'num', 'Paid'),
        cell(r.money_hidden ? (due > 0 ? 'Due' : '') : money(r.balance_due_now), 'num' + (due > 0 ? ' due' : ''), 'Due now'),
        cell(last, '', 'Last payment'),
      ]));
    });
    $('fees-empty').hidden = listRows.length > 0;
    if (listRows.length) {
      const t = listTotals(listRows);
      foot.appendChild(el('tr', { className: 'fees-total' }, [
        cell('Total: ' + plural(t.students, 'student', 'students'), '', ''),
        cell('', '', ''),
        cell(S.count(t.with_dues) + ' with dues', '', ''),
        cell(t.money ? money(t.total_fees) : '', 'num', 'Total fees'),
        cell(t.money ? money(t.paid) : '', 'num', 'Paid'),
        cell(t.money ? money(t.due_now) : '', 'num', 'Due now'),
        cell(RECORDED_IN_LEDGER, 'muted small', ''),
      ]));
    }
    $('fees-pager').hidden = pg.pages <= 1;
    $('fees-page').textContent = pg.from ? 'Page ' + pg.page + ' of ' + pg.pages + ' · ' + S.count(pg.from) + '–' + S.count(pg.to) + ' of ' + S.count(listRows.length) : '';
    $('fees-prev').disabled = pg.page <= 1;
    $('fees-next').disabled = pg.page >= pg.pages;
  }

  // ---------- one student ----------

  async function loadStudent(id) {
    const n = ++seq.detail;
    const wrap = $('fees-student');
    wrap.textContent = '';
    wrap.appendChild(el('p', { className: 'msg', text: 'Loading…' }));
    try {
      const d = await ctx.rpc('accounts_student_detail', { p_student: id });
      if (n !== seq.detail || !ctx) return;
      detail = d || {};
      renderStudent();
    } catch (err) {
      if (n !== seq.detail || !ctx) return;
      wrap.textContent = '';
      wrap.appendChild(el('p', null, [el('a', { href: '#fees', text: '← All students' })]));
      wrap.appendChild(el('p', { className: 'msg error', role: 'status', text: 'Could not open this student: ' + errText(err) }));
    }
  }

  async function reloadStudent(note, isError) {
    const id = studentId;
    await loadStudent(id);
    if (note) say('fs-msg', note, isError);
    loadAll();
    loadList();
    loadSummary();
  }

  function fact(label, value) {
    return el('div', { className: 'fees-fact' }, [el('dt', { text: label }), el('dd', { text: value || '—' })]);
  }

  function renderStudent() {
    const wrap = $('fees-student');
    wrap.textContent = '';
    const st = detail.student || {};
    const b = detail.balance || {};
    const hidden = !!detail.money_hidden;
    const manage = canManage(ctx.seat);

    wrap.appendChild(el('p', { className: 'fees-back' }, [el('a', { href: '#fees', id: 'fs-back', text: '← All students' })]));
    const head = el('div', { className: 'panel' }, [
      el('h2', { id: 'fs-name', tabindex: '-1', text: st.name || 'Student' }),
      el('dl', { className: 'fees-facts' }, [
        fact('Admission no', st.admission_no),
        fact('Class', [st.class_label, st.section].filter(Boolean).join('-') + (st.board ? ' · ' + st.board : '')),
        fact('Academic year', st.academic_year),
        fact('Parent', st.parent_name),
        fact('Phone', st.phone),
        fact('Alternate phone', st.alt_phone),
        fact('Status', st.status === 'left' ? 'Left' : 'Studying'),
        fact('Added from', { import: 'Excel import', admission: 'Admission call', manual: 'Added by hand' }[st.source] || st.source),
      ]),
    ]);
    wrap.appendChild(head);

    const cards = el('div', { className: 'fees-cards', id: 'fs-cards' }, [
      card('Due now', hidden ? '—' : rupees2(b.balance_due_now || 0), 'fees due till today, minus paid', Number(b.balance_due_now) > 0 ? 'bad' : 'good', 'fs-due'),
      card('Paid', hidden ? '—' : rupees2(b.paid || 0), RECORDED_IN_LEDGER, 'good', 'fs-paid'),
      card('Total fees', hidden ? '—' : rupees2(b.total_fees || 0), 'all fee items', '', 'fs-total'),
      card('Left to pay (year)', hidden ? '—' : rupees2(b.balance_total || 0), 'including fees not due yet', '', 'fs-left'),
    ]);
    wrap.appendChild(el('div', { className: 'panel' }, [
      el('h3', { text: 'Balance' }),
      cards,
      hidden ? el('p', { className: 'muted small', text: 'Amounts are hidden for you, so you see counts only.' }) : null,
      msg('fs-msg'),
    ]));

    if (manage) wrap.appendChild(paymentForm());
    wrap.appendChild(paymentsPanel(manage, hidden));
    wrap.appendChild(feeItemsPanel(manage, hidden));
    wrap.appendChild(callsPanel(hidden));
    const h = $('fs-name');
    if (h) h.focus({ preventScroll: false });
  }

  function paymentForm() {
    const mode = el('select', { id: 'fs-pay-mode' }, MODES.map((m) => el('option', { value: m[0], text: m[1] })));
    const ref = el('input', { id: 'fs-pay-ref', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'UTR or transaction no.' });
    const refLabel = el('span', { id: 'fs-pay-ref-label', text: 'Reference (needed)' });
    const form = el('form', { id: 'fs-pay', className: 'row fees-pay', novalidate: 'novalidate' }, [
      field('Amount (₹)', el('input', { id: 'fs-pay-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', required: true })),
      field('Date', el('input', { id: 'fs-pay-date', type: 'date', value: today(), max: today(), required: true })),
      field('Mode', mode),
      el('label', null, [refLabel, ref]),
      field('Note', el('input', { id: 'fs-pay-note', type: 'text', maxlength: '300', autocomplete: 'off' }), 'grow'),
      el('button', { type: 'submit', text: 'Record payment' }),
    ]);
    const syncRef = () => {
      const need = needsReference(mode.value);
      refLabel.textContent = need ? 'Reference (needed)' : 'Reference (cheque no., optional)';
      ref.placeholder = mode.value === 'cheque' ? 'Cheque no.' : need ? 'UTR or transaction no.' : '';
      ref.required = need;
    };
    mode.addEventListener('change', syncRef);
    syncRef();
    form.addEventListener('submit', (e) => { e.preventDefault(); recordPayment(); });
    return el('div', { className: 'panel' }, [
      el('h3', { text: 'Record a payment' }),
      el('p', { className: 'muted small', text: 'Enter the UTR or cheque number as the reference. Never enter UPI IDs, card or bank account numbers.' }),
      form,
      msg('fs-pay-msg'),
    ]);
  }

  async function recordPayment() {
    const p = {
      amount: $('fs-pay-amount').value, paid_on: $('fs-pay-date').value, mode: $('fs-pay-mode').value,
      reference: $('fs-pay-ref').value.trim(), note: $('fs-pay-note').value.trim(),
    };
    const problem = paymentProblem(p, today());
    if (problem) { say('fs-pay-msg', problem, true); return; }
    const btn = $('fs-pay').querySelector('button[type="submit"]');
    btn.disabled = true;
    say('fs-pay-msg', 'Saving…');
    const amount = LU.parseAmount(p.amount);
    try {
      const id = await ctx.rpc('accounts_record_payment', {
        p_student: studentId, p_amount: amount, p_paid_on: p.paid_on, p_mode: p.mode,
        p_reference: p.reference || null, p_note: p.note || null,
      });
      await reloadStudent('Payment of ' + rupees2(amount) + ' recorded. Receipt ' + receiptNo(id) + '.');
    } catch (err) {
      say('fs-pay-msg', 'Not saved: ' + errText(err), true);
      btn.disabled = false;
    }
  }

  // An inline "reason" row under a table row, for voiding a fee or reversing a payment.
  function reasonRow(colspan, idBase, button, onGo) {
    const input = el('input', { id: idBase + '-reason', type: 'text', maxlength: '300', autocomplete: 'off', required: true });
    const go = el('button', { type: 'button', className: 'danger', id: idBase + '-go', text: button });
    const cancel = el('button', { type: 'button', text: 'Cancel' });
    const note = el('p', { className: 'msg', role: 'status', id: idBase + '-msg' });
    const tr = el('tr', { className: 'fees-reason' }, [el('td', { colspan: String(colspan) }, [
      el('div', { className: 'row' }, [field('Reason (required)', input, 'grow'), go, cancel]), note,
    ])]);
    cancel.addEventListener('click', () => tr.remove());
    go.addEventListener('click', async () => {
      const reason = input.value.trim();
      if (!reason) { say(note, 'Write the reason.', true); input.focus(); return; }
      go.disabled = true;
      try { await onGo(reason); } catch (err) { say(note, errText(err), true); go.disabled = false; }
    });
    setTimeout(() => input.focus(), 0);
    return tr;
  }

  function paymentsPanel(manage, hidden) {
    const list = paymentRows(detail.payments);
    const body = el('tbody', { id: 'fs-pay-body' });
    list.forEach((p) => {
      const status = p.is_reversal ? 'Reversal of ' + p.of_receipt + (p.note ? ': ' + p.note : '')
        : p.reversed ? 'Reversed (' + p.reversal_receipt + ')' : 'Paid';
      const acts = el('td', { 'data-label': 'Actions', className: 'actions' });
      const tr = el('tr', { className: p.is_reversal ? 'reversal' : p.reversed ? 'reversed' : null, 'data-payment': p.id }, [
        cell(p.receipt, 'mono', 'Receipt'),
        cell(S.formatDate(p.paid_on), '', 'Date'),
        cell(hidden ? '—' : (p.is_reversal ? '−' : '') + money(p.amount), 'num', 'Amount'),
        cell(modeLabel(p.mode), '', 'Mode'),
        cell(p.reference || '', '', 'Reference'),
        cell(p.is_reversal ? '' : (p.note || ''), '', 'Note'),
        cell(p.recorded_by_label || '', '', 'Recorded by'),
        cell(status, 'status', 'Status'),
        acts,
      ]);
      if (!p.is_reversal) {
        const r = el('button', { type: 'button', text: 'Receipt', 'aria-label': 'Receipt ' + p.receipt });
        r.addEventListener('click', () => showReceipt(p));
        acts.appendChild(r);
      }
      if (manage && !p.is_reversal && !p.reversed) {
        const rev = el('button', { type: 'button', className: 'danger', text: 'Reverse', 'aria-label': 'Reverse ' + p.receipt });
        rev.addEventListener('click', () => {
          if (tr.nextSibling && tr.nextSibling.classList && tr.nextSibling.classList.contains('fees-reason')) return;
          tr.after(reasonRow(9, 'fs-rev', 'Reverse this payment', async (reason) => {
            await ctx.rpc('accounts_reverse_payment', { p_payment: p.id, p_reason: reason });
            await reloadStudent('Payment ' + p.receipt + ' reversed. It stays in the list with its reversal.');
          }));
        });
        acts.appendChild(rev);
      }
      body.appendChild(tr);
    });
    return el('div', { className: 'panel' }, [
      el('h3', { text: 'Payments (' + RECORDED_IN_LEDGER + ')' }),
      el('p', { className: 'muted small', text: 'A wrong payment is reversed, never deleted: the reversal is a new line with the reason.' }),
      list.length ? el('div', { className: 'scroll' }, [el('table', { className: 'stack', id: 'fs-pay-table' }, [
        el('thead', null, [el('tr', null, ['Receipt', 'Date', 'Amount', 'Mode', 'Reference', 'Note', 'Recorded by', 'Status', ''].map((h, i) => el('th', { text: h, className: i === 2 ? 'num' : null })))]),
        body,
      ])]) : el('p', { className: 'muted', id: 'fs-pay-empty', text: 'No payments recorded yet.' }),
    ]);
  }

  function feeItemsPanel(manage, hidden) {
    const items = detail.fee_items || [];
    const body = el('tbody', { id: 'fs-fee-body' });
    items.forEach((f) => {
      const acts = el('td', { 'data-label': 'Actions', className: 'actions' });
      const tr = el('tr', { className: f.is_void ? 'void' : null }, [
        cell(f.head, '', 'Fee'),
        cell(hidden ? '—' : money(f.amount), 'num', 'Amount'),
        cell(S.formatDate(f.due_date), '', 'Due date'),
        cell(f.academic_year || '', '', 'Year'),
        cell(f.is_void ? 'Void: ' + (f.void_reason || '') : 'Active', 'status', 'Status'),
        acts,
      ]);
      if (manage && !f.is_void) {
        const v = el('button', { type: 'button', className: 'danger', text: 'Void', 'aria-label': 'Void ' + f.head });
        v.addEventListener('click', () => {
          if (tr.nextSibling && tr.nextSibling.classList && tr.nextSibling.classList.contains('fees-reason')) return;
          tr.after(reasonRow(6, 'fs-void', 'Void this fee', async (reason) => {
            await ctx.rpc('accounts_void_fee_item', { p_fee_item: f.id, p_reason: reason });
            await reloadStudent('Fee "' + f.head + '" voided.');
          }));
        });
        acts.appendChild(v);
      }
      body.appendChild(tr);
    });
    const panel = el('div', { className: 'panel' }, [
      el('h3', { text: 'Fee items' }),
      items.length ? el('div', { className: 'scroll' }, [el('table', { className: 'stack', id: 'fs-fee-table' }, [
        el('thead', null, [el('tr', null, ['Fee', 'Amount', 'Due date', 'Year', 'Status', ''].map((h, i) => el('th', { text: h, className: i === 1 ? 'num' : null })))]),
        body,
      ])]) : el('p', { className: 'muted', text: 'No fees added yet.' }),
    ]);
    if (manage) {
      const st = detail.student || {};
      const form = el('form', { id: 'fs-fee', className: 'row fees-add', novalidate: 'novalidate' }, [
        field('Fee', el('input', { id: 'fs-fee-head', type: 'text', maxlength: '80', placeholder: 'Term 2 tuition', required: true }), 'grow'),
        field('Amount (₹)', el('input', { id: 'fs-fee-amount', type: 'text', inputmode: 'decimal', required: true })),
        field('Due date', el('input', { id: 'fs-fee-due', type: 'date', required: true })),
        field('Academic year', el('input', { id: 'fs-fee-year', type: 'text', placeholder: '2026-27', value: st.academic_year || '', maxlength: '7' })),
        el('button', { type: 'submit', text: 'Add fee' }),
      ]);
      form.addEventListener('submit', (e) => { e.preventDefault(); addFee(); });
      panel.appendChild(el('h4', { text: 'Add a fee' }));
      panel.appendChild(form);
      panel.appendChild(msg('fs-fee-msg'));
    }
    return panel;
  }

  async function addFee() {
    const head = $('fs-fee-head').value.trim();
    const amount = LU.parseAmount($('fs-fee-amount').value);
    const due = $('fs-fee-due').value;
    const year = parseYear($('fs-fee-year').value);
    if (!head) { say('fs-fee-msg', 'Write the name of the fee, such as Term 2 tuition.', true); return; }
    if (amount === null || Number.isNaN(amount) || amount <= 0) { say('fs-fee-msg', 'Enter the amount in rupees.', true); return; }
    if (!parseDay(due)) { say('fs-fee-msg', 'Pick the due date.', true); return; }
    if (year === null) { say('fs-fee-msg', 'The academic year should look like 2026-27.', true); return; }
    try {
      await ctx.rpc('accounts_add_fee_item', { p_student: studentId, p_head: head, p_amount: amount, p_due_date: due, p_academic_year: year || null });
      await reloadStudent('Fee "' + head + '" of ' + rupees2(amount) + ' added.');
    } catch (err) { say('fs-fee-msg', 'Not added: ' + errText(err), true); }
  }

  function callsPanel(hidden) {
    const calls = detail.calls || [];
    return el('div', { className: 'panel' }, [
      el('h3', { text: 'Calls to this parent' }),
      el('p', { className: 'muted small', text: 'Promised amounts are ' + S.REPORTED_BY_CALLER + '. Only payments above are ' + RECORDED_IN_LEDGER + '.' }),
      calls.length ? el('div', { className: 'scroll' }, [el('table', { className: 'stack', id: 'fs-calls' }, [
        el('thead', null, [el('tr', null, ['When', 'Caller', 'Campaign', 'Result', 'Promised for', 'Promised amount', 'Note'].map((h, i) => el('th', { text: h, className: i === 5 ? 'num' : null })))]),
        el('tbody', null, calls.map((c) => el('tr', { className: c.corrects_id ? 'correction' : null }, [
          cell(S.formatDateTime(c.at), '', 'When'),
          cell(c.caller || '', '', 'Caller'),
          cell(c.campaign_name || '', '', 'Campaign'),
          cell((c.result_label || String(c.result_key || '').replace(/_/g, ' ')) + (c.corrects_id ? ' (correction)' : ''), '', 'Result'),
          cell(c.promised_date ? S.formatDate(c.promised_date) : '', '', 'Promised for'),
          cell(hidden || c.promised_amount === null || c.promised_amount === undefined ? '' : money(c.promised_amount) + ' (' + S.REPORTED_BY_CALLER + ')', 'num', 'Promised amount'),
          cell(c.note || '', '', 'Note'),
        ]))),
      ])]) : el('p', { className: 'muted', text: 'No calls to this parent yet.' }),
    ]);
  }

  // ---------- receipt ----------

  function showReceipt(p) {
    const st = (detail && detail.student) || {};
    const r = $('fees-receipt');
    r.textContent = '';
    const line = (label, value, id) => el('div', { className: 'fees-r-line' }, [el('dt', { text: label }), el('dd', { text: value || '—', id: id || null })]);
    const amount = detail.money_hidden ? null : num(p.amount);
    r.appendChild(el('div', { className: 'fees-r-head' }, [
      el('div', { className: 'fees-r-inst', id: 'fees-r-inst', text: ctx.institute.name || 'Institute' }),
      el('h2', { id: 'fees-r-title', tabindex: '-1', text: 'Fee receipt' }),
      p.reversed ? el('p', { className: 'fees-r-void', text: 'This payment was reversed (' + p.reversal_receipt + '). This receipt is not valid.' }) : null,
    ]));
    r.appendChild(el('dl', { className: 'fees-r-lines' }, [
      line('Receipt no', p.receipt, 'fees-r-no'),
      line('Date', S.formatDate(p.paid_on), 'fees-r-date'),
      line('Student', st.name, 'fees-r-student'),
      line('Admission no', st.admission_no),
      line('Class', [st.class_label, st.section].filter(Boolean).join('-') + (st.board ? ' · ' + st.board : '')),
      line('Parent', st.parent_name),
      line('Amount', amount === null ? 'Hidden' : rupees2(amount), 'fees-r-amount'),
      line('In words', amount === null ? '' : amountInWords(amount), 'fees-r-words'),
      line('Mode', modeLabel(p.mode), 'fees-r-mode'),
      line('Reference', p.reference, 'fees-r-ref'),
      p.note ? line('Note', p.note) : null,
      line('Received by', p.recorded_by_label),
    ]));
    r.appendChild(el('p', { className: 'fees-r-foot muted small', text: 'Recorded in the fee ledger. This is a computer-made receipt.' }));
    const print = el('button', { type: 'button', className: 'primary', id: 'fees-r-print', text: 'Print' });
    const close = el('button', { type: 'button', id: 'fees-r-close', text: 'Close' });
    print.addEventListener('click', printReceipt);
    close.addEventListener('click', () => { closeReceipt(); const b = document.querySelector('[data-payment="' + p.id + '"] button'); if (b) b.focus(); });
    r.appendChild(el('div', { className: 'row fees-r-actions' }, [print, close]));
    $('fees-student').hidden = true;
    r.hidden = false;
    $('fees-r-title').focus();
  }

  function closeReceipt() {
    const r = $('fees-receipt');
    if (!r || r.hidden) return;
    r.hidden = true;
    r.textContent = '';
    if (studentId) $('fees-student').hidden = false;
  }

  // Prints only the receipt (see the print rules in css/admin-fees.css).
  function printReceipt() {
    document.body.classList.add('fees-printing');
    try { window.print(); } finally {
      setTimeout(() => document.body.classList.remove('fees-printing'), 0);
    }
  }
  const afterPrint = () => document.body.classList.remove('fees-printing');

  // ---------- import ----------

  function openImport() {
    imp = { sheet: null, map: null, file: '', built: null };
    const p = $('fees-import');
    p.textContent = '';
    const input = el('input', { type: 'file', id: 'fees-imp-file', accept: '.xlsx,.xls,.csv', className: 'file-input' });
    input.addEventListener('change', () => { if (input.files && input.files[0]) readImportFile(input.files[0]); });
    p.appendChild(el('h2', { text: 'Import students and fees' }));
    p.appendChild(el('p', { className: 'muted small', text: 'One student per row. Columns: admission no, student, class, section, board, parent, phone, alternate phone, academic year, then each fee (name, amount, due date), and paid so far. A student with a known admission number is updated, not added twice.' }));
    p.appendChild(el('label', { className: 'drop', for: 'fees-imp-file' }, [
      el('span', { className: 'drop-title', id: 'fees-imp-name', text: 'Choose an Excel or CSV file' }),
      el('span', { className: 'muted small', text: 'First row: column names.' }),
      input,
    ]));
    p.appendChild(el('div', { id: 'fees-imp-map', hidden: true }));
    p.appendChild(el('div', { id: 'fees-imp-preview' }));
    p.appendChild(msg('fees-imp-msg'));
    p.appendChild(el('div', { id: 'fees-imp-result' }));
  }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = XLSX_URL;
      s.integrity = XLSX_SRI;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('no reader')));
      s.onerror = () => { xlsxLoading = null; s.remove(); reject(new Error('no reader')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }

  async function readImportFile(file) {
    const mine = imp;
    say('fees-imp-msg', 'Reading ' + file.name + '…');
    try {
      let aoa;
      if (/\.csv$/i.test(file.name)) aoa = LU.parseCsv(await file.text());
      else {
        let X;
        try { X = await loadXlsx(); } catch (err) {
          say('fees-imp-msg', 'The spreadsheet reader did not load. Check your internet connection, or save the sheet as .csv.', true);
          return;
        }
        const wb = X.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', raw: true, cellDates: true });
        aoa = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
      }
      if (imp !== mine) return;
      const sheet = LU.tidy(aoa);
      if (!sheet.rows.length) { say('fees-imp-msg', 'That sheet has no rows under the header row.', true); return; }
      imp.sheet = sheet;
      imp.file = file.name;
      imp.map = guessImportColumns(sheet.header);
      $('fees-imp-name').textContent = file.name + ' · ' + plural(sheet.rows.length, 'row', 'rows');
      say('fees-imp-msg', '');
      renderImportMap();
    } catch (err) {
      say('fees-imp-msg', 'Could not read that file. Use an .xlsx or .csv file with a header row.', true);
    }
  }

  function colSelect(id, value, noneText) {
    const sel = el('select', { id }, [el('option', { value: '-1', text: noneText || 'Not in the sheet' })]
      .concat(imp.sheet.header.map((h, i) => el('option', { value: String(i), text: h }))));
    sel.value = String(value === undefined ? -1 : value);
    return sel;
  }

  function renderImportMap() {
    const box2 = $('fees-imp-map');
    box2.textContent = '';
    box2.hidden = false;
    const grid = el('div', { className: 'fees-map' });
    IMPORT_FIELDS.forEach(([k, label]) => {
      const sel = colSelect('fees-imp-col-' + k, imp.map[k], k === 'name' ? 'Pick a column' : null);
      sel.addEventListener('change', () => { imp.map[k] = Number(sel.value); renderPreview(); });
      grid.appendChild(el('label', null, [label, sel]));
    });
    box2.appendChild(el('h3', { text: 'Match the columns' }));
    box2.appendChild(grid);
    const year = el('input', { id: 'fees-imp-year', type: 'text', placeholder: '2026-27', maxlength: '9' });
    year.addEventListener('input', renderPreview);
    box2.appendChild(el('div', { className: 'row' }, [field('Academic year when the sheet has none', year)]));

    box2.appendChild(el('h3', { text: 'Fees' }));
    const list = el('div', { id: 'fees-imp-fees', className: 'fees-map-fees' });
    box2.appendChild(list);
    const add = el('button', { type: 'button', id: 'fees-imp-addfee', text: 'Add a fee column' });
    add.addEventListener('click', () => { imp.map.fees.push({ head: '', headCol: -1, amount: -1, due: -1 }); renderFeeMap(); renderPreview(); });
    box2.appendChild(add);
    renderFeeMap();
    renderPreview();
  }

  function renderFeeMap() {
    const list = $('fees-imp-fees');
    list.textContent = '';
    if (!imp.map.fees.length) list.appendChild(el('p', { className: 'muted small', text: 'No fee columns found. Add one, or import students only.' }));
    imp.map.fees.forEach((f, i) => {
      const head = el('input', { id: 'fees-imp-fee-head-' + i, type: 'text', value: f.head, maxlength: '80', placeholder: 'Tuition' });
      const headCol = colSelect('fees-imp-fee-headcol-' + i, f.headCol, 'Use the name typed here');
      const amount = colSelect('fees-imp-fee-amount-' + i, f.amount, 'Pick a column');
      const due = colSelect('fees-imp-fee-due-' + i, f.due, 'Pick a column');
      head.addEventListener('input', () => { f.head = head.value; renderPreview(); });
      headCol.addEventListener('change', () => { f.headCol = Number(headCol.value); renderPreview(); });
      amount.addEventListener('change', () => { f.amount = Number(amount.value); renderPreview(); });
      due.addEventListener('change', () => { f.due = Number(due.value); renderPreview(); });
      const remove = el('button', { type: 'button', text: 'Remove', 'aria-label': 'Remove fee ' + (i + 1) });
      remove.addEventListener('click', () => { imp.map.fees.splice(i, 1); renderFeeMap(); renderPreview(); });
      list.appendChild(el('fieldset', { className: 'fees-fee-group' }, [
        el('legend', { text: 'Fee ' + (i + 1) }),
        el('label', null, ['Fee name', head]), el('label', null, ['Fee name column', headCol]),
        el('label', null, ['Amount column', amount]), el('label', null, ['Due date column', due]), remove,
      ]));
    });
  }

  function renderPreview() {
    const out = $('fees-imp-preview');
    out.textContent = '';
    $('fees-imp-result').textContent = '';
    if (!imp || !imp.sheet) return;
    if (imp.map.name < 0) { say('fees-imp-msg', 'Pick the column with the student\'s name.', true); return; }
    const built = buildImportRows(imp.sheet, imp.map, { academicYear: $('fees-imp-year') ? $('fees-imp-year').value : '' });
    imp.built = built;
    const sample = built.rows.slice(0, 5);
    out.appendChild(el('h3', { text: 'Preview' }));
    out.appendChild(el('p', { id: 'fees-imp-count', text: plural(built.counts.ready, 'student', 'students') + ' ready' +
      (built.problems.length ? '; ' + plural(built.problems.length, 'row has a problem and will be skipped', 'rows have a problem and will be skipped') : '') + '.' }));
    if (sample.length) {
      out.appendChild(el('div', { className: 'scroll' }, [el('table', { className: 'stack' }, [
        el('thead', null, [el('tr', null, ['Student', 'Adm. no', 'Class', 'Parent', 'Phone', 'Fees', 'Paid so far'].map((h) => el('th', { text: h })))]),
        el('tbody', null, sample.map((r) => el('tr', null, [
          cell(r.name, '', 'Student'), cell(r.admission_no || '', '', 'Adm. no'),
          cell([r.class_label, r.section].filter(Boolean).join('-') + (r.board ? ' · ' + r.board : ''), '', 'Class'),
          cell(r.parent_name || '', '', 'Parent'), cell(r.phone || '', '', 'Phone'),
          cell((r.fees || []).map((f) => f.head + ' ' + rupees2(f.amount) + ' by ' + S.formatDate(f.due_date)).join('; '), '', 'Fees'),
          cell(r.paid_so_far ? rupees2(r.paid_so_far) : '', '', 'Paid so far'),
        ]))),
      ])]));
    }
    if (built.problems.length) {
      out.appendChild(el('h4', { text: 'Rows that will be skipped' }));
      out.appendChild(el('ul', { className: 'fees-problems', id: 'fees-imp-problems' },
        built.problems.slice(0, 50).map((p) => el('li', { text: 'Row ' + p.row + ': ' + p.reason }))));
      if (built.problems.length > 50) out.appendChild(el('p', { className: 'muted small', text: 'And ' + S.count(built.problems.length - 50) + ' more.' }));
    }
    const go = el('button', { type: 'button', className: 'primary', id: 'fees-imp-go', text: 'Import ' + plural(built.counts.ready, 'student', 'students'), disabled: !built.counts.ready });
    go.addEventListener('click', runImport);
    out.appendChild(el('div', { className: 'row' }, [go]));
    say('fees-imp-msg', '');
  }

  async function runImport() {
    const built = imp && imp.built;
    if (!built || !built.rows.length) return;
    const go = $('fees-imp-go');
    go.disabled = true;
    say('fees-imp-msg', 'Importing…');
    let total = {};
    const skips = [];
    try {
      for (let i = 0; i < built.rows.length; i += IMPORT_CHUNK) {
        const part = built.rows.slice(i, i + IMPORT_CHUNK);
        const res = (await ctx.rpc('accounts_import_students', { p_rows: part })) || {};
        total = addImportCounts(total, res);
        serverSkips(res, built.sheetRows.slice(i, i + IMPORT_CHUNK)).forEach((s) => skips.push(s));
      }
    } catch (err) {
      say('fees-imp-msg', 'The import stopped: ' + errText(err) + (total.added || total.updated ? ' What was sent before this is saved.' : ''), true);
      go.disabled = false;
      return;
    }
    say('fees-imp-msg', '');
    const res = $('fees-imp-result');
    res.textContent = '';
    res.appendChild(el('p', { id: 'fees-imp-done', className: 'fees-done', text: importSummary(total) }));
    if (skips.length) {
      res.appendChild(el('h4', { text: 'Skipped by the server' }));
      res.appendChild(el('ul', { className: 'fees-problems' }, skips.slice(0, 50).map((s) => el('li', { text: 'Row ' + s.row + ': ' + s.reason }))));
    }
    if (built.problems.length) res.appendChild(el('p', { className: 'muted small', text: plural(built.problems.length, 'row was', 'rows were') + ' not sent because of the problems above.' }));
    loadAll();
    loadList();
  }

  // ---------- fees campaign ----------

  async function openCampaign() {
    const p = $('fees-camp');
    p.textContent = '';
    const classes = choices(allRows, 'class_label');
    const dl = el('datalist', { id: 'fees-c-classes' }, classes.map((c) => el('option', { value: c })));
    const board = el('select', { id: 'fees-c-board' }, [el('option', { value: '', text: 'All boards' })].concat(BOARDS.map((b) => el('option', { value: b, text: b }))));
    const script = el('select', { id: 'fees-c-script' }, [el('option', { value: '', text: 'No script' })]);
    const name = el('input', { id: 'fees-c-name', type: 'text', maxlength: '120', required: true, value: campaignName({}) });
    const cls = el('input', { id: 'fees-c-class', type: 'text', maxlength: '20', list: 'fees-c-classes', placeholder: 'All classes' });
    const due = el('input', { id: 'fees-c-due', type: 'date' });
    let named = false;
    name.addEventListener('input', () => { named = true; });
    const rename = () => { if (!named) name.value = campaignName({ class_label: cls.value, board: board.value, due_by: due.value }); };
    [cls, board, due].forEach((x) => x.addEventListener('input', rename));
    board.addEventListener('change', rename);
    const form = el('form', { id: 'fees-c-form', className: 'fees-c-form', novalidate: 'novalidate' }, [
      el('div', { className: 'row' }, [
        field('Campaign name', name, 'grow'),
        field('Class', cls), dl,
        field('Board', board),
      ]),
      el('div', { className: 'row' }, [
        field('Fees due by', due),
        field('Call only when more than (₹) is due', el('input', { id: 'fees-c-min', type: 'text', inputmode: 'decimal', value: '0' })),
        field('Script', script, 'grow'),
      ]),
      el('label', { className: 'check' }, [el('input', { type: 'checkbox', id: 'fees-c-open', checked: true }), ' Open to all callers']),
      el('p', { className: 'muted small', text: 'Each parent with a balance gets one call. The amount on the call is the balance due by that date. When a payment is recorded here, the call list updates by itself and parents who paid are not called again.' }),
      el('div', { className: 'row' }, [el('button', { type: 'submit', text: 'Make the campaign' })]),
    ]);
    form.addEventListener('submit', (e) => { e.preventDefault(); createCampaign(); });
    p.appendChild(el('h2', { text: 'Call parents with dues' }));
    p.appendChild(form);
    p.appendChild(msg('fees-c-msg'));
    p.appendChild(el('div', { id: 'fees-c-done' }));
    try {
      const typeId = await feesType();
      const { data, error } = await ctx.client.from('scripts').select('id, name, call_type_id, script_versions(published)').eq('institute_id', ctx.institute.id);
      if (error) throw new Error(error.message);
      (data || []).filter((s) => (!s.call_type_id || s.call_type_id === typeId) && (s.script_versions || []).some((v) => v.published))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach((s) => script.appendChild(el('option', { value: s.id, text: s.name })));
    } catch (err) {
      say('fees-c-msg', 'Could not load the scripts, so the campaign will have none: ' + errText(err));
    }
  }

  async function createCampaign() {
    const name = $('fees-c-name').value.trim();
    const min = LU.parseAmount($('fees-c-min').value || '0');
    if (!name) { say('fees-c-msg', 'Give the campaign a name.', true); return; }
    if (min === null || Number.isNaN(min)) { say('fees-c-msg', 'The minimum due must be an amount in rupees, or 0.', true); return; }
    const btn = $('fees-c-form').querySelector('button[type="submit"]');
    btn.disabled = true;
    say('fees-c-msg', 'Making the campaign…');
    try {
      const id = await ctx.rpc('accounts_create_fees_campaign', {
        p_name: name, p_class_label: $('fees-c-class').value.trim() || null, p_board: $('fees-c-board').value || null,
        p_due_by: $('fees-c-due').value || null, p_min_due: min || 0, p_script: $('fees-c-script').value || null,
        p_open_to_all: $('fees-c-open').checked, p_start: true,
      });
      say('fees-c-msg', '');
      const done = $('fees-c-done');
      done.textContent = '';
      const open = $('fees-c-open').checked;
      const text = open ? 'Campaign "' + name + '" is made. When it has parents to call it starts at once, and every caller can pick it.'
        : 'Campaign "' + name + '" is made as a draft. An admin adds callers and starts it in Campaigns.';
      done.appendChild(el('p', { id: 'fees-c-made', className: 'fees-done', text }));
      if (!isAccounts(ctx.seat)) done.appendChild(el('p', null, [el('a', { href: S.buildHash('campaigns', { id }), id: 'fees-c-link', text: 'Open the campaign' })]));
      loadSummary();
    } catch (err) {
      say('fees-c-msg', 'Not made: ' + errText(err), true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- tab ----------

  S.registerTab({
    id: 'fees',
    label: 'Fees',
    visible: (c) => tabVisible(c.seat, c.canSeeMoney),
    mount(container, c) {
      ctx = c;
      box = container;
      build();
      wire();
      window.addEventListener('afterprint', afterPrint);
      loadAll();
      loadList();
      loadSummary();
    },
    show(params) { if (ctx) showView(params || {}); },
    unmount() {
      window.removeEventListener('afterprint', afterPrint);
      clearTimeout(searchTimer);
      Object.keys(seq).forEach((k) => { seq[k]++; });
      ctx = null; box = null; allRows = []; listRows = []; detail = null; studentId = null; feesTypeId = null;
      imp = null; collected = null; promises = null; page = 1;
    },
  });
})();
