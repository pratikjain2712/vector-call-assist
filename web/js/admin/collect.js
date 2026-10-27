'use strict';
/* Collect fee: the counter screen (#fees/collect) and Pending dues (#fees/pending), parts shown by fees.js.
   Made for the fees office at the counter: one search box (focused), tap the student, the amount is already
   the full due (or tap a chip), the mode is the institute's most used one, Save. Then a line with Receipt ·
   WhatsApp · Undo and the search box is ready for the next parent in the queue.
     1. Search (collect_search): name, parent, phone or admission no, in the picked centre and batch; each match
        shows class · board · batch, the parent and "Due ₹6,000" (or "No dues"); "+ Add student" after them.
     2. The form (collect_student): amount (focused, the due now filled in), chips "Full ₹6,000" and one per
        unpaid fee when several are due, mode as four buttons (Cash · UPI · Cheque · Card/Bank), the reference
        only for UPI, cheque and card/bank (UTR or cheque no.), "+ Note", the date (today, "change"), and one
        button "Save ₹6,000", off until the form is right. Enter saves.
     3. Saved (accounts_record_payment, the same rules and duplicate-reference check as the student page):
        Receipt (print), Send on WhatsApp (when the institute's WhatsApp is connected and the parent agreed; a
        wa.me link with the receipt), Undo for 10 minutes (accounts_reverse_payment, "Entered by mistake").
   "By you today ₹ · this month ₹" (collected_by_me) at the top. Pending dues (collect_pending): students with
   dues in the centre and batch, most due first or oldest first, each with Collect (the form for that student).
   Who: owners, Accounts and managers who can see money record payments (can_record_payment, 20261027110000; a
   manager's Undo works on their own payment for 10 minutes); others with the Fees tab see Pending only.
   The mode starts at the one this login last saved with (per login in this browser), else the institute's
   most used. "Record payment" on a student's page opens this screen for that student (one payment form).
   The pure helpers are also loaded by tests/web/collect.test.js (Node, no DOM). */
(function () {
  const inNode = typeof window === 'undefined' && typeof module !== 'undefined' && module.exports;
  const S = inNode ? require('./shared.js') : window.VectorAdminShared;

  // ---------- pure helpers ----------

  const MODES = [['cash', 'Cash'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['bank', 'Card/Bank']];
  const UNDO_MS = 10 * 60 * 1000;
  const UNDO_REASON = 'Entered by mistake';

  // The mode button to start with: the institute's most used mode (card counts as Card/Bank), else Cash.
  function modeDefault(top) {
    if (top === 'card') return 'bank';
    return MODES.some((m) => m[0] === top) ? top : 'cash';
  }
  const modeLabel = (m) => ({ cash: 'Cash', upi: 'UPI', cheque: 'Cheque', bank: 'Card/Bank', card: 'Card', other: 'Other' }[m] || String(m || ''));
  // The reference field: its label, or null when the mode has none (cash).
  function refLabel(mode) {
    if (mode === 'upi') return 'UTR (UPI reference)';
    if (mode === 'cheque') return 'Cheque no.';
    if (mode === 'bank' || mode === 'card') return 'UTR / transaction no.';
    return null;
  }

  // '6,000', '₹ 6000.50', '6000' to a number; '' to null; anything else NaN.
  function parseRupees(v) {
    const s = String(v === null || v === undefined ? '' : v).replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
    if (!s) return null;
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return NaN;
    return Number(s);
  }

  // What is wrong with the form, or '' when Save can go. f: { amount, mode, reference, note, paid_on }.
  function collectProblem(f, today) {
    const x = f || {};
    const amount = parseRupees(x.amount);
    if (amount === null || Number.isNaN(amount) || amount <= 0) return 'Enter the amount paid.';
    if (!MODES.some((m) => m[0] === x.mode) && x.mode !== 'card') return 'Pick how it was paid.';
    const ref = String(x.reference || '').trim();
    if (refLabel(x.mode) && !ref) return 'Enter the ' + (x.mode === 'cheque' ? 'cheque number' : 'UTR (transaction number)') + '.';
    if (ref.length > 60) return 'The reference is too long (60 characters at most).';
    if (/@/.test(ref)) return 'Enter the UTR, not a UPI ID.';
    if (!x.paid_on || !/^\d{4}-\d{2}-\d{2}$/.test(x.paid_on)) return 'Pick the date.';
    if (today && x.paid_on > today) return 'The date cannot be in the future.';
    if (x.paid_on < '2000-01-01') return 'Check the date.';
    if (String(x.note || '').length > 300) return 'The note is too long (300 characters at most).';
    return '';
  }

  // The words on the Save button: 'Save ₹6,000' once the amount is right.
  function saveLabel(amountText) {
    const n = parseRupees(amountText);
    if (!n || Number.isNaN(n) || n <= 0) return 'Save';
    const paise = Math.round(n * 100) % 100;
    return 'Save ' + S.rupees(Math.floor(n)) + (paise ? '.' + String(paise).padStart(2, '0') : '');
  }

  // The amount chips for a student (collect_student): "Full ₹6,000" when something is due; one chip per unpaid
  // fee when more than one is due; with nothing due, the next fee ("Term 2 tuition ₹5,000 · due 5 Nov").
  // [] without money access.
  function amountChips(info) {
    const x = info || {};
    if (x.money_hidden) return [];
    const due = Number(x.due_now) || 0;
    const unpaid = (x.unpaid || []).filter((u) => Number(u.left) > 0);
    const chips = [];
    if (due > 0) chips.push({ key: 'full', label: 'Full ' + S.rupees(due), amount: due });
    const dueItems = unpaid.filter((u) => u.is_due);
    if (dueItems.length > 1) dueItems.forEach((u) => chips.push({ key: String(u.fee_item_id), label: u.head + ' ' + S.rupees(u.left), amount: Number(u.left) }));
    if (due <= 0) {
      const next = unpaid.find((u) => !u.is_due);
      if (next) chips.push({ key: String(next.fee_item_id), label: next.head + ' ' + S.rupees(next.left) + ' · due ' + S.formatDate(next.due_date, { year: false }), amount: Number(next.left) });
    }
    return chips;
  }

  // The amount to fill in when a student is picked: the due now, else nothing.
  function startAmount(info) {
    const due = Number((info || {}).due_now) || 0;
    return !info || info.money_hidden || due <= 0 ? '' : String(Math.round(due * 100) / 100);
  }

  // The best matches first, the same order as collect_search (for the test backend and tests):
  // 0 admission no, 1 name starts, 2 a word of the name starts, 3 every word starts a word of name or parent,
  // 4 admission no starts, 5 4+ digits in a phone, 6 name contains (3+ letters). Others are left out.
  function rankOf(row, query) {
    const q = String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!q) return null;
    const name = String(row.name || '').toLowerCase();
    const parent = String(row.parent_name || '').toLowerCase();
    const adm = String(row.admission_no || '').toLowerCase();
    const qd = q.replace(/\D/g, '');
    const words = q.split(' ').filter(Boolean);
    const both = ' ' + name + ' ' + parent;
    if (adm && adm === q) return 0;
    if (name.startsWith(q)) return 1;
    if ((' ' + name).includes(' ' + q)) return 2;
    if (words.every((w) => both.includes(' ' + w))) return 3;
    if (adm && adm.startsWith(q)) return 4;
    if (qd.length >= 4 && (String(row.phone || '').includes(qd) || String(row.alt_phone || '').includes(qd))) return 5;
    if (q.length >= 3 && name.includes(q)) return 6;
    return null;
  }
  function rankRows(rows, query, limit) {
    return (rows || []).map((r) => ({ r, k: rankOf(r, query) })).filter((x) => x.k !== null)
      .sort((a, b) => a.k - b.k || String(a.r.name).localeCompare(String(b.r.name)))
      .slice(0, limit || 12).map((x) => Object.assign({}, x.r, { rank: x.k }));
  }

  // 'Class 8-A · State · 8th SB Morning' for a result or a pending row.
  function classLine(r) {
    const x = r || {};
    const cls = [x.class_label, x.section].filter(Boolean).join('-');
    return [cls ? (/^\d/.test(cls) ? 'Class ' + cls : cls) : '', x.board || '', x.batch_name || ''].filter(Boolean).join(' · ');
  }
  // 'Due ₹6,000', 'No dues', or 'Has dues' without money access.
  function dueText(r) {
    const x = r || {};
    if (x.money_hidden) return x.has_dues ? 'Has dues' : 'No dues';
    const n = Number(x.due_now) || 0;
    return n > 0 ? 'Due ' + S.rupees(n) : 'No dues';
  }

  const canUndo = (savedAt, now) => !!savedAt && (now - savedAt) < UNDO_MS && (now - savedAt) >= 0;

  // The receipt as a WhatsApp message (no UPI ids or account numbers: the UTR only).
  function receiptMessage(p) {
    const x = p || {};
    return 'Fee receipt ' + (x.receipt || '') + (x.institute ? ' from ' + x.institute : '') + '\n' +
      'Received ' + S.rupees(x.amount) + ' for ' + (x.student || '') + ' on ' + S.formatDate(x.paid_on) + ' (' + modeLabel(x.mode) +
      (x.reference ? ', ' + x.reference : '') + ').' + (x.left !== null && x.left !== undefined ? '\nLeft to pay: ' + S.rupees(Math.max(0, x.left)) + '.' : '') +
      '\nThank you.';
  }
  function waNumber(phone) {
    let d = String(phone || '').replace(/[^\d+]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    else if (d.length === 10) d = '91' + d;
    return /^\d{11,15}$/.test(d) ? d : '';
  }
  const waLink = (phone, text) => (waNumber(phone) ? 'https://wa.me/' + waNumber(phone) + '?text=' + encodeURIComponent(text) : '');

  // "By you today ₹12,500 · this month ₹1,24,000" (collected_by_me); counts without money access.
  function meLine(me) {
    const x = me || {};
    const part = (amt, n) => (x.money_hidden ? S.count(n || 0) + ' ' + (Number(n) === 1 ? 'payment' : 'payments') : S.rupees(amt || 0));
    return 'By you today ' + part(x.today_amount, x.today_payments) + ' · this month ' + part(x.month_amount, x.month_payments);
  }

  const helpers = { MODES, UNDO_MS, UNDO_REASON, modeDefault, modeLabel, refLabel, parseRupees, collectProblem, saveLabel,
    amountChips, startAmount, rankOf, rankRows, classLine, dueText, canUndo, receiptMessage, waNumber, waLink, meLine };
  if (inNode) { module.exports = helpers; return; }
  window.VectorCollect = helpers;

  // ---------- the page (browser only) ----------

  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => String(n).padStart(2, '0');
  const todayYmd = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  const errText = (err) => (err && err.message ? err.message : 'Try again.');
  const C = window.VectorCentres;

  const st = {
    ctx: null, box: null, me: null, topMode: 'cash', batch: '', seq: 0, timer: null, results: [],
    info: null, mode: 'cash', saving: false, last: null, undoTimer: null,
  };
  const canCollect = () => !!st.ctx && S.canCollect(st.ctx.seat, st.ctx.canSeeMoney);
  // The last mode this login saved with (per login in this browser), else the institute's most used one.
  const MODE_KEY = 'vector-collect-mode';
  const lastMode = () => { const m = S.recall(MODE_KEY, st.ctx.email, null); return MODES.some((x) => x[0] === m) ? m : null; };

  function build(box) {
    const batchSel = C && st.ctx.centres ? C.batchPicker('collect-batch', st.ctx.centres, st.ctx.centre, st.batch, (v) => { st.batch = v; search(); }) : null;
    box.appendChild(el('div', { className: 'collect' }, [
      el('p', { className: 'back' }, [el('a', { href: '#fees', id: 'collect-back', text: '← Fees' })]),
      el('div', { className: 'collect-head' }, [
        el('h2', { id: 'collect-title', tabindex: '-1', text: 'Collect fee' }),
        el('p', { id: 'collect-me', className: 'collect-me muted' }),
      ]),
      el('div', { id: 'collect-done', className: 'collect-done', role: 'status', hidden: true }),
      el('form', { id: 'collect-find', className: 'collect-find', role: 'search' }, [
        el('input', { id: 'collect-q', type: 'search', autocomplete: 'off', enterkeyhint: 'search',
          placeholder: 'Student, parent, phone or admission no', 'aria-label': 'Find the student' }),
        batchSel,
      ]),
      el('ul', { id: 'collect-results', className: 'plain collect-results', 'aria-label': 'Students found' }),
      el('form', { id: 'collect-pay', className: 'collect-pay', novalidate: 'novalidate', hidden: true }),
      el('p', { id: 'collect-msg', className: 'msg', role: 'status' }),
    ]));
    // Enter picks the best match (searching first when the box changed since the last search).
    $('collect-find').addEventListener('submit', async (e) => {
      e.preventDefault();
      clearTimeout(st.timer);
      if (st.lastQ !== $('collect-q').value.trim()) await search();
      const first = st.results[0];
      if (first && st.ctx) pick(first.student_id);
    });
    $('collect-q').addEventListener('input', () => { clearTimeout(st.timer); st.timer = setTimeout(search, 200); });
    $('collect-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('collect-find').requestSubmit(); return; }
      if (e.key === 'ArrowDown') { const b = document.querySelector('#collect-results button'); if (b) { e.preventDefault(); b.focus(); } }
    });
    $('collect-pay').addEventListener('submit', (e) => { e.preventDefault(); save(); });
  }

  async function loadMe() {
    try {
      const me = await st.ctx.rpc('collected_by_me');
      if (!st.ctx) return;
      st.me = me || null;
      st.topMode = modeDefault(me && me.top_mode);
      $('collect-me').textContent = me ? meLine(me) : '';
    } catch (err) {
      if (st.ctx) $('collect-me').textContent = '';
    }
  }

  async function search() {
    const q = $('collect-q').value.trim();
    st.lastQ = q;
    const n = ++st.seq;
    const list = $('collect-results');
    if (!q) { st.results = []; list.textContent = ''; say('collect-msg', ''); return; }
    try {
      const rows = await st.ctx.rpc('collect_search', { p_q: q, p_centre: st.ctx.centre || null, p_batch: st.batch || null, p_limit: 12 });
      if (n !== st.seq || !st.ctx) return;
      st.results = Array.isArray(rows) ? rows : [];
      drawResults(q);
    } catch (err) {
      if (n === st.seq && st.ctx) say('collect-msg', 'Could not search: ' + errText(err), true);
    }
  }

  function drawResults(q) {
    const list = $('collect-results');
    list.textContent = '';
    say('collect-msg', st.results.length ? '' : 'No student matches "' + q + '".');
    st.results.forEach((r) => {
      const due = dueText(r);
      const b = el('button', { type: 'button', className: 'collect-hit', 'data-student': r.student_id }, [
        el('span', { className: 'collect-hit-main' }, [
          el('span', { className: 'collect-hit-name', text: r.name }),
          el('span', { className: 'collect-hit-sub muted', text: [classLine(r), r.parent_name ? 'Parent ' + r.parent_name : ''].filter(Boolean).join(' · ') }),
        ]),
        el('span', { className: 'collect-hit-due' + (/^Due|^Has/.test(due) ? ' due' : ''), text: due }),
      ]);
      b.addEventListener('click', () => pick(r.student_id));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' && b.parentNode.nextSibling) { const x = b.parentNode.nextSibling.querySelector('button, a'); if (x) { e.preventDefault(); x.focus(); } }
        if (e.key === 'ArrowUp') { e.preventDefault(); const p = b.parentNode.previousSibling; (p ? p.querySelector('button') : $('collect-q')).focus(); }
      });
      list.appendChild(el('li', null, [b]));
    });
    if (canCollect()) {
      list.appendChild(el('li', { className: 'collect-add' }, [
        el('a', { href: S.buildHash('fees', { add: '1' }), id: 'collect-add', className: 'linkish-a', text: '+ Add student' }),
      ]));
    }
  }

  // ---------- the form ----------

  async function pick(studentId) {
    clearTimeout(st.timer);
    st.seq++;
    say('collect-msg', 'Opening…');
    try {
      const info = await st.ctx.rpc('collect_student', { p_student: studentId });
      if (!st.ctx) return;
      st.info = info || {};
      say('collect-msg', '');
      drawForm();
    } catch (err) {
      say('collect-msg', 'Could not open this student: ' + errText(err), true);
    }
  }

  function drawForm() {
    const info = st.info;
    const s = info.student || {};
    const form = $('collect-pay');
    form.textContent = '';
    $('collect-find').hidden = true;
    $('collect-results').hidden = true;
    const due = info.money_hidden ? (info.has_dues ? 'Has dues' : 'No dues') : (Number(info.due_now) > 0 ? 'Due now ' + S.rupees(info.due_now) : 'No dues now');
    const change = el('button', { type: 'button', className: 'linkish', id: 'collect-change', text: 'Change student' });
    change.addEventListener('click', backToSearch);
    form.appendChild(el('div', { className: 'collect-who' }, [
      el('div', null, [
        el('div', { className: 'collect-who-name', id: 'collect-who', text: s.name || '' }),
        el('div', { className: 'muted small', text: [classLine(s), s.parent_name ? 'Parent ' + s.parent_name : ''].filter(Boolean).join(' · ') }),
      ]),
      el('div', { className: 'collect-who-due' + (Number(info.due_now) > 0 ? ' due' : ''), id: 'collect-due', text: due }),
    ]));
    if (!canCollect()) {
      form.appendChild(el('p', { className: 'muted', text: 'Only the owner and Accounts record payments.' }));
      form.appendChild(change);
      form.hidden = false;
      return;
    }
    const amount = el('input', { id: 'collect-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: startAmount(info),
      placeholder: Number(info.due_now) > 0 && !info.money_hidden ? 'Due ' + S.rupees(info.due_now) : 'Amount', 'aria-describedby': 'collect-due' });
    const chips = el('div', { className: 'collect-chips', id: 'collect-chips' });
    amountChips(info).forEach((c) => {
      const b = el('button', { type: 'button', className: 'collect-chip', 'data-chip': c.key, text: c.label });
      b.addEventListener('click', () => { amount.value = String(c.amount); sync(); amount.focus(); });
      chips.appendChild(b);
    });
    st.mode = lastMode() || st.topMode;
    const modes = el('div', { className: 'collect-modes', role: 'radiogroup', 'aria-label': 'Paid by', id: 'collect-modes' });
    MODES.forEach((m) => {
      const b = el('button', { type: 'button', role: 'radio', className: 'collect-mode', 'data-mode': m[0], text: m[1] });
      b.addEventListener('click', () => { st.mode = m[0]; sync(); const r = $('collect-ref'); if (refLabel(st.mode) && r) r.focus(); });
      modes.appendChild(b);
    });
    const ref = el('input', { id: 'collect-ref', type: 'text', autocomplete: 'off', maxlength: '60' });
    const refWrap = el('label', { id: 'collect-ref-wrap', className: 'collect-ref' }, [el('span', { id: 'collect-ref-label' }), ref]);
    const note = el('input', { id: 'collect-note', type: 'text', maxlength: '300', autocomplete: 'off' });
    const noteWrap = el('label', { id: 'collect-note-wrap', hidden: true }, ['Note', note]);
    const date = el('input', { id: 'collect-date', type: 'date', value: todayYmd(), max: todayYmd() });
    const dateWrap = el('label', { id: 'collect-date-wrap', hidden: true }, ['Date', date]);
    const noteOpen = el('button', { type: 'button', className: 'linkish', id: 'collect-note-open', text: '+ Note' });
    noteOpen.addEventListener('click', () => { noteWrap.hidden = false; noteOpen.hidden = true; note.focus(); });
    const dateText = el('span', { id: 'collect-date-text', text: 'Today' });
    const dateOpen = el('button', { type: 'button', className: 'linkish', id: 'collect-date-open', text: 'change' });
    dateOpen.addEventListener('click', () => { dateWrap.hidden = false; dateOpen.parentNode.hidden = true; date.focus(); });
    const saveBtn = el('button', { type: 'submit', className: 'primary collect-save', id: 'collect-save', text: 'Save', disabled: true });
    form.appendChild(el('label', { className: 'collect-amount' }, ['Amount (₹)', amount]));
    form.appendChild(chips);
    form.appendChild(modes);
    form.appendChild(refWrap);
    form.appendChild(el('div', { className: 'collect-extra' }, [noteOpen, el('span', { className: 'muted small' }, ['Date: ', dateText, ' · ', dateOpen])]));
    form.appendChild(noteWrap);
    form.appendChild(dateWrap);
    form.appendChild(el('div', { className: 'collect-actions' }, [saveBtn, change]));
    [amount, ref, note, date].forEach((x) => x.addEventListener('input', sync));
    form.hidden = false;
    sync();
    amount.focus();
    amount.select();
  }

  function formValues() {
    return { amount: $('collect-amount').value, mode: st.mode, reference: refLabel(st.mode) ? $('collect-ref').value : '',
      note: $('collect-note').value, paid_on: $('collect-date').value };
  }

  function sync() {
    if (!$('collect-amount')) return;
    document.querySelectorAll('#collect-modes .collect-mode').forEach((b) => b.setAttribute('aria-checked', String(b.getAttribute('data-mode') === st.mode)));
    const label = refLabel(st.mode);
    $('collect-ref-wrap').hidden = !label;
    $('collect-ref-label').textContent = label || '';
    $('collect-ref').placeholder = st.mode === 'cheque' ? '000123' : '12-digit UTR';
    const f = formValues();
    const problem = collectProblem(f, todayYmd());
    const btn = $('collect-save');
    btn.disabled = !!problem || st.saving;
    btn.textContent = saveLabel(f.amount);
    const d = $('collect-date').value;
    $('collect-date-text').textContent = d === todayYmd() ? 'Today' : S.formatDate(d);
    document.querySelectorAll('#collect-chips .collect-chip').forEach((b) => {
      const c = amountChips(st.info).find((x) => x.key === b.getAttribute('data-chip'));
      b.setAttribute('aria-pressed', String(!!c && parseRupees(f.amount) === c.amount));
    });
  }

  async function save() {
    if (st.saving) return;
    const f = formValues();
    const problem = collectProblem(f, todayYmd());
    if (problem) { say('collect-msg', problem, true); return; }
    const amount = parseRupees(f.amount);
    const s = st.info.student || {};
    st.saving = true;
    sync();
    say('collect-msg', 'Saving…');
    try {
      const id = await st.ctx.rpc('accounts_record_payment', {
        p_student: s.id, p_amount: amount, p_paid_on: f.paid_on, p_mode: f.mode,
        p_reference: f.reference.trim() || null, p_note: f.note.trim() || null,
      });
      st.last = { id, student: s, amount, mode: f.mode, reference: f.reference.trim(), paid_on: f.paid_on, at: Date.now(),
        wa: st.info.whatsapp || {}, left: st.info.money_hidden ? null : (Number(st.info.balance_total) || 0) - amount };
      st.saving = false;
      S.remember(MODE_KEY, st.ctx.email, f.mode);
      say('collect-msg', '');
      drawDone();
      backToSearch(true);
      loadMe();
    } catch (err) {
      st.saving = false;
      sync();
      const m = errText(err);
      say('collect-msg', /already recorded/i.test(m) ? 'Not saved: this ' + modeLabel(f.mode) + ' reference is already recorded. Check the number.' : 'Not saved: ' + m, true);
    }
  }

  function receiptNo(id) {
    const FH = window.VectorFeesHelpers;
    return FH ? FH.receiptNo(id) : 'R-' + String(id || '').replace(/[^0-9a-z]/gi, '').slice(0, 8).toUpperCase();
  }

  // The line after a save: what was saved, Receipt · WhatsApp · Undo (10 minutes).
  function drawDone(undone) {
    const d = $('collect-done');
    const x = st.last;
    d.textContent = '';
    if (!x) { d.hidden = true; return; }
    d.hidden = false;
    d.classList.toggle('undone', !!undone);
    if (undone) {
      d.appendChild(el('span', { text: 'Undone: ' + S.rupees(x.amount) + ' from ' + x.student.name + ' was reversed ("' + UNDO_REASON + '").' }));
      return;
    }
    d.appendChild(el('span', { className: 'collect-done-text' }, [
      el('strong', { text: '✓ ' + S.rupees(x.amount) + ' received' }), ' from ' + x.student.name + ' · ' + modeLabel(x.mode) + ' · Receipt ' + receiptNo(x.id),
    ]));
    const acts = el('span', { className: 'collect-done-acts' });
    const rec = el('button', { type: 'button', id: 'collect-receipt', text: 'Print receipt' });
    rec.addEventListener('click', () => openReceipt(x));
    acts.appendChild(rec);
    const next = el('button', { type: 'button', id: 'collect-next', className: 'primary', text: 'Next student' });
    next.addEventListener('click', () => { $('collect-q').focus(); });
    acts.appendChild(next);
    if (x.wa && x.wa.connected && x.wa.consent && waNumber(x.student.phone)) {
      const text = receiptMessage({ receipt: receiptNo(x.id), institute: st.ctx.institute.name, amount: x.amount, student: x.student.name,
        paid_on: x.paid_on, mode: x.mode, reference: x.reference, left: x.left });
      acts.appendChild(el('a', { href: waLink(x.student.phone, text), target: '_blank', rel: 'noopener', className: 'button-link', id: 'collect-wa', text: 'Send on WhatsApp' }));
    }
    const undo = el('button', { type: 'button', id: 'collect-undo', className: 'danger', text: 'Undo' });
    undo.addEventListener('click', () => runUndo(undo));
    acts.appendChild(undo);
    d.appendChild(acts);
    clearTimeout(st.undoTimer);
    st.undoTimer = setTimeout(() => { const u = $('collect-undo'); if (u) u.remove(); }, Math.max(0, UNDO_MS - (Date.now() - x.at)));
  }

  async function runUndo(btn) {
    const x = st.last;
    if (!x || !canUndo(x.at, Date.now())) { btn.remove(); return; }
    btn.disabled = true;
    try {
      await st.ctx.rpc('accounts_reverse_payment', { p_payment: x.id, p_reason: UNDO_REASON });
      drawDone(true);
      st.last = null;
      loadMe();
      $('collect-q').focus();
    } catch (err) {
      btn.disabled = false;
      say('collect-msg', 'Could not undo: ' + errText(err), true);
    }
  }

  async function openReceipt(x) {
    const R = window.VectorFeesReceipt;
    if (!R) return;
    try {
      const detail = await st.ctx.rpc('accounts_student_detail', { p_student: x.student.id });
      const pay = ((detail && detail.payments) || []).find((p) => p.id === x.id);
      if (!pay) throw new Error('the payment is not there any more');
      R.show(detail, pay, () => { const b = $('collect-receipt'); if (b) b.focus(); });
    } catch (err) {
      say('collect-msg', 'Could not open the receipt: ' + errText(err), true);
    }
  }

  // Back to the search box, empty and focused (after a save: ready for the next parent).
  function backToSearch(fresh) {
    st.info = null;
    $('collect-pay').hidden = true;
    $('collect-pay').textContent = '';
    $('collect-find').hidden = false;
    $('collect-results').hidden = false;
    if (fresh === true) { $('collect-q').value = ''; st.lastQ = ''; st.results = []; $('collect-results').textContent = ''; }
    $('collect-q').focus();
    if (fresh !== true && $('collect-q').value.trim()) search();
  }

  S.registerTab({
    id: 'collect',
    label: 'Collect fee',
    part: true,
    mount(box, c) {
      st.ctx = c; st.box = box; st.batch = '';
      build(box);
      loadMe();
    },
    show(params) {
      if (!st.ctx) return;
      const p = params || {};
      const back = $('collect-back');
      if (p.from === 'student' && p.student) { back.href = S.buildHash('fees', { student: p.student }); back.textContent = '← Student'; }
      else { back.href = '#fees'; back.textContent = '← Fees'; }
      if (p.student) { pick(p.student); return; }
      if (!st.info) $('collect-q').focus();
    },
    unmount() {
      clearTimeout(st.timer); clearTimeout(st.undoTimer);
      Object.assign(st, { ctx: null, box: null, me: null, results: [], info: null, last: null, saving: false, seq: st.seq + 1 });
    },
  });

  // ---------- Pending dues ----------

  const pend = { ctx: null, sort: 'amount', batch: '', rows: [], total: 0, seq: 0, page: 100 };

  function pendBuild(box) {
    const sortBtn = (key, text) => {
      const b = el('button', { type: 'button', className: 'pending-sort', 'data-sort': key, text, 'aria-pressed': String(pend.sort === key) });
      b.addEventListener('click', () => { pend.sort = key; loadPending(); });
      return b;
    };
    const batchSel = C && pend.ctx.centres ? C.batchPicker('pending-batch', pend.ctx.centres, pend.ctx.centre, pend.batch, (v) => { pend.batch = v; loadPending(); }) : null;
    box.appendChild(el('div', { className: 'panel pending' }, [
      el('p', { className: 'back pending-back' }, [el('a', { href: '#fees', id: 'pending-back', text: '← Fees' })]),
      el('div', { className: 'pending-head' }, [
        el('div', null, [
          el('h2', { id: 'pending-title', tabindex: '-1', text: 'Pending dues' }),
          el('p', { id: 'pending-total', className: 'muted small' }),
        ]),
        el('div', { className: 'pending-tools', role: 'group', 'aria-label': 'Sort' }, [sortBtn('amount', 'Most due'), sortBtn('date', 'Oldest first'), batchSel]),
      ]),
      el('ul', { id: 'pending-list', className: 'plain pending-list' }),
      el('p', { id: 'pending-msg', className: 'msg', role: 'status' }),
      el('button', { type: 'button', id: 'pending-more', text: 'Show more', hidden: true }),
    ]));
    $('pending-more').addEventListener('click', () => loadPending(true));
  }

  async function loadPending(more) {
    const n = ++pend.seq;
    document.querySelectorAll('.pending-sort').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-sort') === pend.sort)));
    if (!more) say('pending-msg', 'Loading…');
    try {
      const rows = await pend.ctx.rpc('collect_pending', { p_centre: pend.ctx.centre || null, p_batch: pend.batch || null, p_sort: pend.sort,
        p_limit: pend.page, p_offset: more ? pend.rows.length : 0 });
      if (n !== pend.seq || !pend.ctx) return;
      const list = Array.isArray(rows) ? rows : [];
      pend.rows = more ? pend.rows.concat(list) : list;
      pend.total = list[0] ? Number(list[0].total_rows) : (more ? pend.total : 0);
      const first = pend.rows[0] || {};
      $('pending-total').textContent = pend.total
        ? S.count(pend.total) + ' ' + (pend.total === 1 ? 'student' : 'students') + (first.money_hidden || first.total_due === null || first.total_due === undefined ? '' : ' · ' + S.rupees(first.total_due) + ' due')
        : '';
      drawPending(more ? list : pend.rows, !more);
      say('pending-msg', pend.rows.length ? '' : 'Nobody has dues here. Well done.');
      $('pending-more').hidden = pend.rows.length >= pend.total;
    } catch (err) {
      if (n === pend.seq && pend.ctx) say('pending-msg', 'Could not load the dues: ' + errText(err), true);
    }
  }

  function drawPending(rows, clear) {
    const list = $('pending-list');
    if (clear) list.textContent = '';
    const collect = S.canCollect(pend.ctx.seat, pend.ctx.canSeeMoney);
    rows.forEach((r) => {
      const since = r.oldest_due_date ? 'since ' + S.formatDate(r.oldest_due_date, { year: false }) : '';
      list.appendChild(el('li', { className: 'pending-row', 'data-student': r.student_id }, [
        el('div', { className: 'pending-who' }, [
          el('a', { href: S.buildHash('fees', { student: r.student_id }), className: 'pending-name', text: r.name }),
          el('div', { className: 'muted small', text: [classLine(r), r.parent_name, r.phone ? String(r.phone).replace(/^\+91/, '') : ''].filter(Boolean).join(' · ') }),
        ]),
        el('div', { className: 'pending-due' }, [
          el('div', { className: 'pending-amt', text: r.money_hidden ? 'Has dues' : S.rupees(r.due_now) }),
          el('div', { className: 'muted small', text: since }),
        ]),
        collect ? el('a', { href: S.buildHash('fees/collect', { student: r.student_id }), className: 'button-link primary pending-collect',
          text: 'Collect', 'aria-label': 'Collect from ' + r.name }) : null,
      ]));
    });
  }

  S.registerTab({
    id: 'pending',
    label: 'Pending dues',
    part: true,
    mount(box, c) {
      pend.ctx = c; pend.rows = []; pend.batch = ''; pend.sort = 'amount';
      pendBuild(box);
    },
    show() { if (pend.ctx) loadPending(); },
    unmount() { pend.ctx = null; pend.rows = []; pend.seq++; },
  });
})();
