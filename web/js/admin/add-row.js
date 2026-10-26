'use strict';
/* Add row (owner feedback, 26 Oct 2026): besides importing Excel, every place data comes in has "+ Add one".
   - Fees: "+ Add student" (and "Edit details" on a student's page) through accounts_save_student, then
     accounts_add_fee_item for each fee and accounts_record_payment for "paid so far".
   - Calling > a calling list: "+ Add lead" through admin_add_leads with one row (consent keys: migration
     20261026100000_add_row.sql). New calling list, step 3: "Add leads by hand", a small table of rows.
   - A ready Excel template (the excel-export helper, js/excel-export.js) for both imports: the column headings the
     importers guess (fees.js guessImportColumns, lead-upload.js guessColumns) and one example row.
   This file holds what fees.js and campaigns.js share: the checks of the forms (phone numbers as the leads
   importer reads them, js/import-check.js), the duplicate check before a student is saved, the lead rows, the
   templates, and two small DOM pieces (the "Import from Excel | + Add one" switch and the template download).
   Money rules (docs/data-contract.md): a lead's amount due is offered only for a fees list and only to someone who
   can see money (ctx.canSeeMoney); a money heading never goes in a lead's extra fields; templates for someone who
   cannot see money have no amount column.
   The pure helpers are also loaded by tests/web/add-row.test.js (Node, no DOM). */
(function () {
  const inNode = typeof window === 'undefined' && typeof module !== 'undefined' && module.exports;
  const IC = inNode ? require('../import-check.js') : window.ImportCheck;
  const LU = inNode ? require('../lead-upload.js') : window.LeadUpload;

  const BOARDS = ['CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other'];
  const MODES = ['upi', 'cash', 'cheque', 'card', 'bank', 'other'];
  const REF_MODES = ['upi', 'bank', 'card'];
  const MAX_FEES = 10;
  const MAX_HAND_ROWS = 100;
  const str = (v) => String(v === null || v === undefined ? '' : v).trim();
  const lowerName = (v) => str(v).toLowerCase().replace(/\s+/g, ' ');

  // ---------- phone numbers ----------

  // A phone as the database keeps it ('+919876543210'), like normalise_phone and the lead importer:
  // { status: 'ok' | 'missing' | 'bad', value }. value is '' unless status is ok.
  function phone(raw) {
    const p = IC.normalizePhone(raw);
    return { status: p.status, value: p.status === 'ok' ? '+91' + p.digits : '' };
  }

  // ---------- dates, years, boards ----------

  const pad2 = (n) => String(n).padStart(2, '0');
  // 'YYYY-MM-DD' that is a real date, else null.
  function realDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(s));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])
      ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) : null;
  }
  // '2026-27', '2026-2027', '2026/27' to '2026-27'; '' for blank; null when it is not a year pair.
  function year(v) {
    const s = str(v);
    if (!s) return '';
    const x = /^(\d{4})\s*[-/–]\s*(\d{2}|\d{4})$/.exec(s);
    return x ? x[1] + '-' + x[2].slice(-2) : null;
  }
  // 'cbse' to 'CBSE', 'State board' to 'State'; '' for blank; null when unknown.
  function board(v) {
    const s = str(v).toLowerCase().replace(/\s+board$/, '').replace(/^board\s+/, '');
    if (!s) return '';
    if (s === 'state' || s === 'ssc') return 'State';
    return BOARDS.find((b) => b.toLowerCase() === s) || null;
  }

  // ---------- + Add student ----------

  // The student form: { name, admission_no, class_label, section, board, academic_year, parent_name, phone,
  // alt_phone, fees: [{ head, amount, due_date }], paid: { amount, paid_on, mode, reference } }.
  // opts: { today 'YYYY-MM-DD', phoneRequired (default true), withMoney (fees and paid so far are checked) }.
  // Returns the first problem as { field, text } (field: the form key, 'fee-<i>-<key>' or 'paid-<key>'), or null.
  function studentProblem(f, opts) {
    const x = f || {};
    const o = opts || {};
    const bad = (field, text) => ({ field, text });
    if (!str(x.name)) return bad('name', 'Write the student\'s name.');
    if (str(x.name).length > 120) return bad('name', 'Keep the name under 120 characters.');
    if (str(x.admission_no).length > 40) return bad('admission_no', 'Keep the admission number under 40 characters.');
    if (str(x.class_label).length > 20) return bad('class_label', 'Keep the class under 20 characters.');
    if (str(x.section).length > 20) return bad('section', 'Keep the section under 20 characters.');
    if (board(x.board) === null) return bad('board', 'Pick the board: CBSE, ICSE, State, IB, IGCSE or Other.');
    if (year(x.academic_year) === null) return bad('academic_year', 'The academic year should look like 2026-27.');
    if (str(x.parent_name).length > 120) return bad('parent_name', 'Keep the parent\'s name under 120 characters.');
    const p = phone(x.phone);
    if (p.status === 'missing' && o.phoneRequired !== false) return bad('phone', 'Enter the parent\'s 10-digit mobile number.');
    if (p.status === 'bad') return bad('phone', 'The phone is not a 10-digit mobile number.');
    const alt = phone(x.alt_phone);
    if (alt.status === 'bad') return bad('alt_phone', 'The alternate phone is not a 10-digit mobile number.');
    if (p.status === 'ok' && alt.value === p.value) return bad('alt_phone', 'The alternate phone is the same as the phone.');
    if (!o.withMoney) return null;
    const fees = x.fees || [];
    if (fees.length > MAX_FEES) return bad('fees', 'Add at most ' + MAX_FEES + ' fees here; add more on the student\'s page.');
    for (let i = 0; i < fees.length; i++) {
      const fee = fees[i] || {};
      if (!str(fee.head) && !str(fee.amount) && !str(fee.due_date)) continue;   // an empty fee line is left out
      const at = (k) => 'fee-' + i + '-' + k;
      if (!str(fee.head)) return bad(at('head'), 'Write the name of fee ' + (i + 1) + ', such as Term 2 tuition.');
      if (str(fee.head).length > 80) return bad(at('head'), 'Keep the fee name under 80 characters.');
      const amount = LU.parseAmount(fee.amount);
      if (amount === null || Number.isNaN(amount) || amount <= 0) return bad(at('amount'), 'Enter the amount of ' + str(fee.head) + ' in rupees.');
      if (!realDay(fee.due_date)) return bad(at('due_date'), 'Pick the due date of ' + str(fee.head) + '.');
    }
    const paid = x.paid || {};
    if (str(paid.amount)) {
      const amount = LU.parseAmount(paid.amount);
      if (amount === null || Number.isNaN(amount) || amount <= 0) return bad('paid-amount', 'Paid so far: enter the amount in rupees, or leave it empty.');
      if (!realDay(paid.paid_on)) return bad('paid-paid_on', 'Paid so far: pick the date it was paid.');
      if (o.today && paid.paid_on > o.today) return bad('paid-paid_on', 'Paid so far: the date cannot be in the future.');
      if (paid.paid_on < '2000-01-01') return bad('paid-paid_on', 'Paid so far: the date is too far back.');
      if (!MODES.includes(paid.mode)) return bad('paid-mode', 'Paid so far: pick how it was paid.');
      const ref = str(paid.reference);
      if (REF_MODES.includes(paid.mode) && !ref) return bad('paid-reference', 'Paid so far: enter the reference (UTR or transaction number) for this mode.');
      if (ref.length > 60) return bad('paid-reference', 'Paid so far: the reference is too long (60 characters at most).');
      if (/@/.test(ref)) return bad('paid-reference', 'Paid so far: enter the UTR or transaction number, not a UPI ID.');
    }
    return null;
  }

  // accounts_save_student's p_data: every key, so an edit can clear a field ('' clears). Phones normalised.
  function studentData(f) {
    const x = f || {};
    return {
      name: str(x.name), admission_no: str(x.admission_no), class_label: str(x.class_label), section: str(x.section),
      board: board(x.board) || '', academic_year: year(x.academic_year) || '', parent_name: str(x.parent_name),
      phone: phone(x.phone).value, alt_phone: phone(x.alt_phone).value,
    };
  }

  // The fee lines to add, as accounts_add_fee_item's arguments (empty lines left out).
  function studentFees(f) {
    const yr = year((f || {}).academic_year) || null;
    return ((f && f.fees) || []).filter((fee) => fee && (str(fee.head) || str(fee.amount) || str(fee.due_date)))
      .map((fee) => ({ p_head: str(fee.head), p_amount: LU.parseAmount(fee.amount), p_due_date: realDay(fee.due_date), p_academic_year: yr }));
  }

  // "Paid so far" as accounts_record_payment's arguments (without p_student), or null when it is empty.
  function studentPayment(f) {
    const p = (f && f.paid) || {};
    const amount = LU.parseAmount(p.amount);
    if (amount === null || Number.isNaN(amount) || amount <= 0) return null;
    return { p_amount: amount, p_paid_on: realDay(p.paid_on), p_mode: p.mode, p_reference: str(p.reference) || null,
      p_note: 'Paid so far, added with the student' };
  }

  // Students already in the list that look like this one, before it is saved: the same admission number (any
  // case; the database refuses it), or the same phone (or alternate phone) and the same name.
  // students: accounts_students rows; selfId: the student being edited (left out). Returns
  // [{ student_id, name, class_label, section, admission_no, reason: 'admission' | 'phone_name', text }].
  function findDuplicates(f, students, selfId) {
    const x = f || {};
    const adm = str(x.admission_no).toLowerCase();
    const nm = lowerName(x.name);
    const phones = [phone(x.phone).value, phone(x.alt_phone).value].filter(Boolean);
    const out = [];
    (students || []).forEach((s) => {
      if (!s || (selfId && s.student_id === selfId)) return;
      const theirs = [s.phone, s.alt_phone].filter(Boolean);
      let reason = null;
      if (adm && str(s.admission_no).toLowerCase() === adm) reason = 'admission';
      else if (nm && lowerName(s.name) === nm && phones.some((p) => theirs.includes(p))) reason = 'phone_name';
      if (!reason) return;
      out.push({ student_id: s.student_id, name: s.name, class_label: s.class_label || '', section: s.section || '',
        admission_no: s.admission_no || '', reason,
        text: reason === 'admission' ? 'Admission number ' + s.admission_no + ' is already ' + s.name + '\'s.'
          : s.name + ' with the same phone is already in the list' + (s.class_label ? ' (class ' + [s.class_label, s.section].filter(Boolean).join('-') + ')' : '') + '.' });
    });
    return out.sort((a, b) => (a.reason === 'admission' ? 0 : 1) - (b.reason === 'admission' ? 0 : 1));
  }

  // ---------- + Add lead ----------

  // Extra fields a list's leads show to callers, from some of its leads' extra (first seen first, at most 6):
  // money headings, the "where we got the number" keys and empty keys are left out.
  const SOURCE_KEYS = ['source', 'source_date'];
  function extraKeysOf(leads) {
    const keys = [];
    (leads || []).forEach((l) => {
      const ex = l && l.extra && typeof l.extra === 'object' ? l.extra : {};
      Object.keys(ex).forEach((k) => {
        const key = str(k);
        if (!key || keys.includes(key) || SOURCE_KEYS.includes(key.toLowerCase()) || LU.looksLikeMoney(key)) return;
        if (keys.length < 6) keys.push(key);
      });
    });
    return keys;
  }

  // The extra fields of the add-lead form: the list's own (known) or, for a list with no leads yet, the usual
  // ones for its call type: fees and admission 'Student', 'Class'; sales 'Course'; the rest none.
  const TYPE_FIELDS = { fees: ['Student', 'Class'], admission: ['Student', 'Class'], sales: ['Course'], renewal: ['Student', 'Course'] };
  function leadFields(typeKey, known) {
    const k = (known || []).filter((x) => str(x) && !LU.looksLikeMoney(x));
    return k.length ? k.slice(0, 6) : (TYPE_FIELDS[typeKey] || []).slice();
  }

  // Whether the add-lead form and the hand table offer "Amount due": fees lists, for someone who can see money.
  const amountAllowed = (typeKey, canSeeMoney) => typeKey === 'fees' && !!canSeeMoney;

  // One lead for admin_add_leads from the form: f { name, phone, extra: { key: value }, amount, source,
  // consent_call, consent_whatsapp }; opts { amount: amountAllowed() }. Returns { row, problem: { field, text } }.
  function leadRow(f, opts) {
    const x = f || {};
    const o = opts || {};
    const bad = (field, text) => ({ row: null, problem: { field, text } });
    const name = str(x.name);
    if (!name) return bad('name', 'Write the person\'s name.');
    if (name.length > 120) return bad('name', 'Keep the name under 120 characters.');
    const p = phone(x.phone);
    if (p.status === 'missing') return bad('phone', 'Enter a 10-digit mobile number.');
    if (p.status === 'bad') return bad('phone', 'The phone is not a 10-digit mobile number.');
    const extra = {};
    Object.keys(x.extra || {}).forEach((k) => {
      const v = str(x.extra[k]);
      if (v && str(k)) extra[str(k).slice(0, 60)] = v.slice(0, 300);
    });
    const money = Object.keys(extra).find((k) => LU.looksLikeMoney(k));
    if (money) return bad('extra', '"' + money + '" looks like money: use Amount due instead.');
    const source = str(x.source);
    if (source) extra.source = source.slice(0, 300);
    let amount = null;
    if (o.amount && str(x.amount)) {
      amount = LU.parseAmount(x.amount);
      if (amount === null || Number.isNaN(amount)) return bad('amount', 'Amount due: enter rupees, such as 12,500.');
    }
    const row = { name: name.slice(0, 120), phone: p.value, amount_due: amount, extra };
    if (x.consent_call === false) row.consent_call = false;
    if (x.consent_whatsapp === true) row.consent_whatsapp = true;
    return { row, problem: null };
  }

  // What admin_add_leads said about one lead, in words: { ok, text }.
  function oneLeadText(counts, name, listName) {
    const c = Array.isArray(counts) ? counts[0] || {} : counts || {};
    if (Number(c.added) > 0) return { ok: true, text: name + ' added to ' + listName + '.' };
    if (Number(c.bad_numbers) > 0) return { ok: false, text: 'Not added: the phone is not a 10-digit mobile number.' };
    if (Number(c.repeats) > 0) return { ok: false, text: 'Not added: this number is already on ' + listName + '.' };
    return { ok: false, text: 'Not added: check the name, the amount and the other fields.' };
  }

  // The hand table of New calling list: rows [{ name, phone, extra: { key: value }, amount }], cols: the extra keys.
  // Fully empty rows are left out. Returns { rows (for admin_add_leads), problems [{ row (1-based), field, text }],
  // counts { filled, ready } }. The same number twice is a problem on the second row.
  function handRows(rows, opts) {
    const o = opts || {};
    const out = [];
    const problems = [];
    const seen = new Map();
    let filled = 0;
    (rows || []).slice(0, MAX_HAND_ROWS).forEach((r, i) => {
      const x = r || {};
      const any = str(x.name) || str(x.phone) || str(x.amount) || Object.keys(x.extra || {}).some((k) => str(x.extra[k]));
      if (!any) return;
      filled++;
      const one = leadRow(x, { amount: o.amount });
      if (one.problem) { problems.push({ row: i + 1, field: one.problem.field, text: 'Row ' + (i + 1) + ': ' + one.problem.text }); return; }
      if (seen.has(one.row.phone)) {
        problems.push({ row: i + 1, field: 'phone', text: 'Row ' + (i + 1) + ': same number as row ' + seen.get(one.row.phone) + '.' });
        return;
      }
      seen.set(one.row.phone, i + 1);
      out.push(one.row);
    });
    return { rows: out, problems, counts: { filled, ready: out.length } };
  }

  // ---------- Excel templates ----------

  // The students and fees template: the headings fees.js guessImportColumns matches, one example row (fake
  // numbers), and a second sheet that says how to fill it (the importer reads only the first sheet).
  const STUDENT_HEADERS = ['Admission no', 'Student name', 'Class', 'Section', 'Board', 'Academic year', 'Parent name', 'Phone',
    'Alternate phone', 'Fee head 1', 'Amount 1', 'Due date 1', 'Fee head 2', 'Amount 2', 'Due date 2', 'Paid so far', 'Paid on'];
  function studentTemplate(opts) {
    const o = opts || {};
    const yr = o.academicYear || '2026-27';
    const y1 = yr.slice(0, 4);
    return [
      { name: 'Students', headers: STUDENT_HEADERS.slice(),
        rows: [['A101', 'Aarav Shah', '8', 'A', 'CBSE', yr, 'Meena Shah', '9876500001', '', 'Term 1 tuition', 12000, y1 + '-04-10',
          'Term 2 tuition', 10000, y1 + '-10-10', 5000, y1 + '-04-05']] },
      { name: 'How to fill', headers: ['Column', 'What to write'], rows: [
        ['Admission no', 'Optional. A student with a known admission number is updated, not added twice.'],
        ['Student name', 'Needed.'],
        ['Class, Section', 'Such as 8 and A.'],
        ['Board', 'CBSE, ICSE, State, IB, IGCSE or Other.'],
        ['Academic year', 'Such as ' + yr + '.'],
        ['Phone, Alternate phone', '10-digit mobile numbers. +91 or a 0 in front is fine.'],
        ['Fee head, Amount, Due date', 'One group per fee (1, 2, 3 …). Amount in rupees; due date as YYYY-MM-DD or DD/MM/YYYY.'],
        ['Paid so far, Paid on', 'Optional. What the student paid before, and the date.'],
        ['', 'Delete the example row before you import. One student per row; keep the first row as it is.'],
      ] },
    ];
  }

  // The lead sheet template for a calling list: Name, Phone, the list's extra fields (or its type's), Amount due
  // (fees lists, for someone who can see money), Source. Headings lead-upload.js guessColumns matches.
  const EXAMPLE = { student: 'Aarav', class: '8', course: 'Data Analytics', section: 'A', board: 'CBSE' };
  function leadTemplate(opts) {
    const o = opts || {};
    const extras = leadFields(o.typeKey, o.extras);
    const money = amountAllowed(o.typeKey, o.money);
    const headers = ['Name', 'Phone'].concat(extras, money ? ['Amount due'] : [], ['Source']);
    const row = ['Meena Shah', '9876500001'].concat(extras.map((k) => EXAMPLE[k.toLowerCase()] || ''), money ? [12000] : [],
      ['the enquiry form on our website']);
    return [
      { name: 'Leads', headers, rows: [row] },
      { name: 'How to fill', headers: ['Column', 'What to write'], rows: [
        ['Name', 'Needed. The person the caller asks for.'],
        ['Phone', 'Needed. A 10-digit mobile number; +91 or a 0 in front is fine. The same number twice is skipped.'],
      ].concat(extras.map((k) => [k, 'Shown to the caller.']),
        money ? [['Amount due', 'Rupees, such as 12500. Only in this column: never put money in another column.']] : [],
        [['Source', 'Where you got the number, so the caller can answer "Where did you get my number?".'],
          ['', 'Delete the example row before you upload. One person per row; keep the first row as it is.']]) },
    ];
  }

  const helpers = {
    BOARDS, MODES, REF_MODES, MAX_FEES, MAX_HAND_ROWS, STUDENT_HEADERS, phone, realDay, year, board,
    studentProblem, studentData, studentFees, studentPayment, findDuplicates,
    extraKeysOf, leadFields, amountAllowed, leadRow, oneLeadText, handRows, studentTemplate, leadTemplate,
  };
  if (inNode) { module.exports = helpers; return; }

  // ---------- browser only ----------

  // "Import from Excel | + Add one": two buttons side by side, one pressed. items: [{ key, label, id, controls }].
  // onPick(key) runs when a button is pressed. Returns { node, set(key) }.
  function modeSwitch(el, label, items, picked, onPick) {
    const buttons = items.map((it) => el('button', { type: 'button', id: it.id, text: it.label, 'aria-pressed': 'false',
      'aria-controls': it.controls || null }));
    const node = el('div', { className: 'addrow-switch', role: 'group', 'aria-label': label }, buttons);
    const set = (key) => {
      items.forEach((it, i) => buttons[i].setAttribute('aria-pressed', String(it.key === key)));
    };
    items.forEach((it, i) => buttons[i].addEventListener('click', () => { set(it.key); onPick(it.key); }));
    set(picked);
    return { node, set };
  }

  // A "Download a ready Excel template" button: builds sheets() on click and downloads name; says so in msgNode.
  function templateButton(el, say, id, sheets, name, msgNode) {
    const b = el('button', { type: 'button', className: 'linkish addrow-template', id, text: 'Download a ready Excel template' });
    b.addEventListener('click', async () => {
      if (!window.VectorExcel) { say(msgNode, 'The Excel writer is not on this page.', true); return; }
      b.disabled = true;
      try {
        await window.VectorExcel.download(sheets(), name);
        say(msgNode, 'Template downloaded: fill one row per line under the headings, then import it here.');
      } catch (err) {
        say(msgNode, (err && err.message) || 'Could not make the template.', true);
      } finally { b.disabled = false; }
    });
    return b;
  }

  window.VectorAddRow = Object.assign({ modeSwitch, templateButton }, helpers);
})();
