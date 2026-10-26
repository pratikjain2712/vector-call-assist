'use strict';
/* Fees basics for the Fees tab (web/admin.html): written for office staff and owners who are not at ease with
   computers: big text, one main button per screen, plain words, short steps with "Step 1 of 3", a preview in
   words before anything is saved for many students, a clear "Done" and an Undo where there can be one.
   - Fee plan (#fees/plans, part "fee-plans"): the fees of a class for a year, set once (name, amount, due date,
     who pays: every student, only bus students, or only students ticked), and discount rules ("Sibling 10% on
     tuition"). "Apply to all students in Class 8" shows what will happen ("This will add ₹18,000 Term 2 tuition
     for 133 students in Class 8. Continue?"), with ticks per student for the optional fees and the discount
     rules, then adds the fees. Applying again adds nothing; after a change it says "apply the change to N
     students". Server: fee_plans_list, fee_plan_save, fee_plan_preview, fee_plan_apply, fee_plan_undo.
   - Give a discount (on a student's page, through VectorFeesBasics.discountPanel): how much (₹ or %), on which
     fees (the whole year or some fees), why (Sibling, Staff child, Merit, Financial help, Other with a note) and
     who approved it. accounts_give_discount; Remove with a reason: accounts_remove_discount (kept in the history).
   - Today's collection (#fees/today, part "day-closing"): the day closing sheet for a day (today first): totals
     by mode, every payment, totals per person who took the money, cheques to bank, reversals, the grand total in
     figures and words; Print and Download Excel (log_money_export 'day_closing' first). ledger_day_closing.
   Money rules: ₹ only when the server sends amounts (money_hidden false). Contract: docs/data-contract.md,
   "Fees basics". The pure helpers at the top are also loaded by tests/web/fees-basics.test.js (Node, no DOM). */
(function () {
  const inNode = typeof window === 'undefined' && typeof module !== 'undefined' && module.exports;
  const S = inNode ? require('./shared.js') : window.VectorAdminShared;
  const LU = inNode ? require('../lead-upload.js') : window.LeadUpload;
  const FH = inNode ? require('./fees.js') : window.VectorFeesHelpers;

  // ---------- pure helpers ----------

  const REASONS = [['sibling', 'Sibling'], ['staff_child', 'Staff child'], ['merit', 'Merit'], ['financial_help', 'Financial help'], ['other', 'Other']];
  const WHO = [['all', 'Every student'], ['bus', 'Bus students only'], ['chosen', 'Students I tick']];
  const DAY_MODES = ['cash', 'upi', 'cheque', 'card', 'bank', 'other'];
  const MAX_FEES = 30;
  const pad2 = (n) => String(n).padStart(2, '0');
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const plural = (n, one, many) => S.count(n) + ' ' + (Number(n) === 1 ? one : many);
  const reasonLabel = (k) => (REASONS.find((r) => r[0] === k) || [k, 'Other'])[1];
  const whoLabel = (k) => (WHO.find((w) => w[0] === k) || WHO[0])[1];
  const rupees = (v) => FH.rupees2(v);

  // The academic year a date falls in (April to March): 25 Oct 2026 and 10 Feb 2027 are both '2026-27'.
  function academicYearFor(date) {
    const d = date || new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return y + '-' + pad2((y + 1) % 100);
  }

  // 'Class 8' for '8th' or '8', 'Class Nursery' for 'Nursery'; with the board and section when the plan has them.
  function classText(p) {
    const x = p || {};
    const raw = String(x.class_label || '').trim();
    const m = /^(\d{1,2})\s*(st|nd|rd|th)?$/i.exec(raw);
    const base = 'Class ' + (m ? m[1] : raw) + (x.section ? '-' + x.section : '');
    return x.board ? base + ' (' + x.board + ')' : base;
  }

  // Two fees to start a new plan, so the office only types the amounts: Term 1 and Term 2 tuition.
  function starterFees(year) {
    const y = Number(String(year || academicYearFor()).slice(0, 4));
    return [
      { head: 'Term 1 tuition', amount: '', due_date: y + '-04-15', who: 'all' },
      { head: 'Term 2 tuition', amount: '', due_date: y + '-10-15', who: 'all' },
    ];
  }

  // What is wrong with a plan form, or null: { step (1 or 2), field, text }.
  // p: { academic_year, class_label, board, section, items: [{ head, amount, due_date, who }], rules: [{ reason, percent, note, head }] }
  function planProblem(p) {
    const x = p || {};
    if (!String(x.class_label || '').trim()) return { step: 1, field: 'class', text: 'Write the class. For example: 8' };
    if (!FH.parseYear(x.academic_year)) return { step: 1, field: 'year', text: 'Write the academic year like this: 2026-27' };
    const items = (x.items || []).filter((f) => String(f.head || '').trim() || String(f.amount || '').trim());
    if (!items.length) return { step: 2, field: 'fee-0-head', text: 'Add at least one fee, with its name and amount.' };
    if (items.length > MAX_FEES) return { step: 2, field: 'fee-add', text: 'A plan can have at most ' + MAX_FEES + ' fees.' };
    const seen = new Set();
    for (let i = 0; i < (x.items || []).length; i++) {
      const f = x.items[i];
      const head = String(f.head || '').trim();
      if (!head && !String(f.amount || '').trim()) continue;
      if (!head) return { step: 2, field: 'fee-' + i + '-head', text: 'Write the name of fee ' + (i + 1) + '. For example: Term 1 tuition' };
      if (head.length > 80) return { step: 2, field: 'fee-' + i + '-head', text: 'The name of fee ' + (i + 1) + ' is too long.' };
      if (seen.has(head.toLowerCase())) return { step: 2, field: 'fee-' + i + '-head', text: '"' + head + '" is in the list twice.' };
      seen.add(head.toLowerCase());
      const amount = LU.parseAmount(f.amount);
      if (amount === null || Number.isNaN(amount) || amount <= 0) return { step: 2, field: 'fee-' + i + '-amount', text: 'Write the amount of ' + head + ' in rupees. For example: 18000' };
      if (!FH.parseDay(f.due_date)) return { step: 2, field: 'fee-' + i + '-due', text: 'Pick the date ' + head + ' is due.' };
    }
    for (let i = 0; i < (x.rules || []).length; i++) {
      const r = x.rules[i];
      const pct = Number(String(r.percent || '').replace('%', '').trim());
      if (!(pct > 0 && pct <= 100)) return { step: 2, field: 'rule-' + i + '-percent', text: 'Write the discount in percent, from 1 to 100. For example: 10' };
      if (r.reason === 'other' && !String(r.note || '').trim()) return { step: 2, field: 'rule-' + i + '-note', text: 'Write what the "Other" discount is for.' };
      if (r.head && !seen.has(String(r.head).toLowerCase())) return { step: 2, field: 'rule-' + i + '-head', text: 'The discount is on a fee that is not in the list.' };
    }
    return null;
  }

  // The p_data fee_plan_save takes, from the form (blank fee lines left out).
  function planData(p) {
    const x = p || {};
    const out = {
      academic_year: FH.parseYear(x.academic_year) || '', class_label: String(x.class_label || '').trim(),
      board: x.board || '', section: String(x.section || '').trim(), auto_apply: x.auto_apply !== false,
      items: (x.items || []).filter((f) => String(f.head || '').trim()).map((f) => {
        const it = { head: String(f.head).trim(), amount: LU.parseAmount(f.amount), due_date: FH.parseDay(f.due_date), who: f.who || 'all' };
        if (f.id) it.id = f.id;
        return it;
      }),
      rules: (x.rules || []).map((r) => {
        const out2 = { reason: r.reason || 'sibling', percent: Number(String(r.percent).replace('%', '').trim()), heads: r.head ? [r.head] : [] };
        if (String(r.note || '').trim()) out2.note = String(r.note).trim();
        if (r.id) out2.id = r.id;
        return out2;
      }),
    };
    return out;
  }

  // The ticks the preview starts with: optional fees ticked for the students the server ticks by default (bus
  // fees: students who use the bus); discount rules ticked for nobody (those already given show as given).
  // Returns { items: { itemId: Set(studentId) }, rules: { ruleId: Set(studentId) } }.
  function defaultTicks(preview) {
    const pv = preview || {};
    const items = {};
    const rules = {};
    (pv.items || []).filter((it) => it.who !== 'all').forEach((it) => {
      items[it.id] = new Set((pv.rows || []).filter((r) => (r.items || {})[it.id] === 'missing' && it.who === 'bus' && r.uses_bus).map((r) => r.student_id));
    });
    (pv.rules || []).forEach((ru) => { rules[ru.id] = new Set(); });
    return { items, rules };
  }

  // What applying will do with these ticks: { perItem [{ id, head, amount, who, add, already, change, other,
  // cancelled }], addFees, addAmount (null when money is hidden), students (who get a new or changed fee or a
  // discount), change, remove, discounts, nothing, sentence }.
  function planPreview(preview, ticks, opts) {
    const pv = preview || {};
    const t = ticks || defaultTicks(pv);
    const money = !pv.money_hidden;
    const who = new Set();
    const perItem = (pv.items || []).map((it) => {
      let add = 0;
      (pv.rows || []).forEach((r) => {
        const st = (r.items || {})[it.id];
        const ticked = it.who === 'all' || (t.items[it.id] && t.items[it.id].has(r.student_id));
        if (st === 'missing' && ticked) { add++; who.add(r.student_id); }
        if (st === 'change') who.add(r.student_id);
      });
      return { id: it.id, head: it.head, amount: num(it.amount), who: it.who, add, already: (Number(it.has) || 0) + (Number(it.same) || 0),
        change: Number(it.change) || 0, other: Number(it.other) || 0, cancelled: Number(it.cancelled) || 0 };
    });
    let discounts = 0;
    (pv.rules || []).forEach((ru) => {
      const set = t.rules[ru.id] || new Set();
      (pv.rows || []).forEach((r) => {
        if (set.has(r.student_id) && !(r.rules || []).includes(ru.id)) { discounts++; who.add(r.student_id); }
      });
    });
    const addFees = perItem.reduce((s, x) => s + x.add, 0);
    const addAmount = money ? perItem.reduce((s, x) => s + x.add * (x.amount || 0), 0) : null;
    const change = perItem.reduce((s, x) => s + x.change, 0);
    const removed = (pv.removed || []).reduce((s, x) => s + (Number(x.students) || 0), 0);
    const cls = classText((pv.plan) || (opts && opts.plan) || {});
    const nothing = !addFees && !change && !removed && !discounts;
    const parts = [];
    const adding = perItem.filter((x) => x.add > 0);
    if (adding.length === 1) {
      const x = adding[0];
      parts.push('This will add ' + (money && x.amount !== null ? rupees(x.amount) + ' ' : '') + x.head + ' for ' + plural(x.add, 'student', 'students') + ' in ' + cls + '.');
    } else if (adding.length > 1) {
      parts.push('This will add ' + plural(addFees, 'fee', 'fees') + (money ? ' (' + rupees(addAmount) + ' in all)' : '') + ' for ' +
        plural(who.size, 'student', 'students') + ' in ' + cls + '.');
    }
    const more = [];
    perItem.filter((x) => x.change > 0).forEach((x) => more.push('change ' + x.head + (money && x.amount !== null ? ' to ' + rupees(x.amount) : '') + ' for ' + plural(x.change, 'student', 'students')));
    (pv.removed || []).filter((x) => Number(x.students) > 0).forEach((x) => more.push('cancel ' + x.head + ' for ' + plural(x.students, 'student', 'students')));
    if (discounts) more.push('give ' + plural(discounts, 'discount', 'discounts'));
    if (more.length) parts.push((parts.length ? 'It will also ' : 'This will ') + more.join(', ') + (parts.length ? '.' : ' in ' + cls + '.'));
    const sentence = nothing ? 'Every student in ' + cls + ' already has these fees. Nothing to add.' : parts.join(' ') + ' Continue?';
    return { perItem, addFees, addAmount, students: who.size, change, remove: removed, discounts, nothing, sentence };
  }

  // "Done" after fee_plan_apply: 'Done. 266 fees added for 133 students. Balances and calling lists are updated.'
  function applyDoneText(res, plan) {
    const r = res || {};
    if (!Number(r.added) && !Number(r.changed) && !Number(r.removed) && !Number(r.discounts)) {
      return 'Nothing to add: every student in ' + classText(plan) + ' already has these fees.';
    }
    const bits = [];
    if (Number(r.added)) bits.push(plural(r.added, 'fee', 'fees') + ' added');
    if (Number(r.changed)) bits.push(plural(r.changed, 'fee', 'fees') + ' changed');
    if (Number(r.removed)) bits.push(plural(r.removed, 'fee', 'fees') + ' cancelled');
    if (Number(r.discounts)) bits.push(plural(r.discounts, 'discount', 'discounts') + ' given');
    return 'Done. ' + bits.join(', ') + ' for ' + plural(r.students || 0, 'student', 'students') + '. Balances and calling lists are updated.';
  }

  // A discount split over fees, as the server does it (discount_give_rows). fees: [{ id, head, amount, left,
  // due_date }] (left: what is still not discounted). kind 'amount' | 'percent'. Returns { lines [{ id, head,
  // amount }], total, problem } (problem: '' or why it cannot be given).
  function discountSplit(fees, kind, value) {
    const list = (fees || []).filter((f) => Number(f.left === undefined ? f.amount : f.left) > 0)
      .map((f) => ({ ...f, left: Number(f.left === undefined ? f.amount : f.left), amount: Number(f.amount) }))
      .sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));
    const v = Number(value);
    const out = { lines: [], total: 0, problem: '' };
    if (!list.length) { out.problem = 'There are no fees to give a discount on.'; return out; }
    if (!(v > 0)) { out.problem = 'Write the discount.'; return out; }
    const round2 = (n) => Math.round(n * 100) / 100;
    if (kind === 'percent') {
      if (v > 100) { out.problem = 'A percent discount can be at most 100.'; return out; }
      list.forEach((f) => { const a = Math.min(round2(f.amount * v / 100), f.left); if (a > 0) out.lines.push({ id: f.id, head: f.head, amount: a }); });
    } else {
      const lefts = round2(list.reduce((s, f) => s + f.left, 0));
      if (v > lefts) { out.problem = 'The discount is more than what is left to pay on these fees (' + rupees(lefts) + ').'; return out; }
      let given = 0;
      list.forEach((f, i) => {
        const a = i === list.length - 1 ? Math.min(round2(v - given), f.left) : Math.min(round2(v * f.left / lefts), f.left);
        if (a > 0) { out.lines.push({ id: f.id, head: f.head, amount: a }); given = round2(given + a); }
      });
    }
    out.total = Math.round(out.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    return out;
  }

  // What is wrong with the discount form, or '' . d: { kind, value, whole_year, fee_items [ids], reason, note, approved_by }.
  function discountProblem(d) {
    const x = d || {};
    if (!['amount', 'percent'].includes(x.kind)) return 'Pick rupees or percent.';
    const v = LU.parseAmount(String(x.value || '').replace('%', ''));
    if (v === null || Number.isNaN(v) || v <= 0) return x.kind === 'percent' ? 'Write the percent. For example: 10' : 'Write the amount in rupees. For example: 2000';
    if (x.kind === 'percent' && v > 100) return 'A percent discount can be at most 100.';
    if (!x.whole_year && !(x.fee_items || []).length) return 'Tick at least one fee.';
    if (!REASONS.some((r) => r[0] === x.reason)) return 'Pick the reason.';
    if (x.reason === 'other' && !String(x.note || '').trim()) return 'Write what the discount is for.';
    if (String(x.approved_by || '').trim().length > 80) return 'The name of the person who approved is too long.';
    return '';
  }

  // The p_data accounts_give_discount takes.
  function discountData(d) {
    const x = d || {};
    const out = { kind: x.kind, value: LU.parseAmount(String(x.value || '').replace('%', '')), whole_year: !!x.whole_year, reason: x.reason };
    if (!x.whole_year) out.fee_items = (x.fee_items || []).slice();
    if (String(x.note || '').trim()) out.note = String(x.note).trim();
    if (String(x.approved_by || '').trim()) out.approved_by = String(x.approved_by).trim();
    return out;
  }

  // A discount in one line: 'Sibling · 10% on Term 1 tuition, Term 2 tuition'.
  function discountText(g) {
    const x = g || {};
    const on = x.scope === 'year' ? 'the whole year' : (x.fees || []).filter((f) => !f.fee_cancelled).map((f) => f.head).join(', ') || 'a cancelled fee';
    return (x.reason_label || reasonLabel(x.reason)) + ' · ' + (x.percent ? Number(x.percent) + '% on ' : 'on ') + on + (x.note ? ' (' + x.note + ')' : '');
  }

  // ledger_day_closing in one shape for the page and the Excel: { day, money, total, count, words, modes [{ mode,
  // label, payments, amount }], persons, cheques { count, amount, rows }, reversed { count, amount }, payments, reversals }.
  function dayTotals(dc) {
    const d = dc || {};
    const money = d.money_hidden === false;
    const t = d.totals || {};
    const byMode = new Map((d.by_mode || []).map((m) => [m.mode, m]));
    const amt = (v) => (money ? (num(v) || 0) : null);
    return {
      day: d.day || '', today: d.today || '', money,
      total: amt(t.amount), count: Number(t.payments) || 0,
      words: money ? FH.amountInWords(num(t.amount) || 0) : '',
      modes: DAY_MODES.map((m) => ({ mode: m, label: FH.modeLabel(m), payments: Number((byMode.get(m) || {}).payments) || 0, amount: amt((byMode.get(m) || {}).amount) })),
      persons: (d.by_person || []).map((p) => ({ label: p.label || 'Unknown', payments: Number(p.payments) || 0, amount: amt(p.amount) })),
      cheques: { count: Number(t.cheques) || 0, amount: amt(t.cheque_amount), rows: d.cheques || [] },
      reversed: { count: Number(t.reversed) || 0, amount: amt(t.reversed_amount) },
      payments: d.payments || [], reversals: d.reversals || [],
    };
  }

  const classOf = (r) => [r.class_label, r.section].filter(Boolean).join('-');

  // The day closing as Excel sheets (VectorExcel): Summary, Payments, Cheques, Reversals. ₹ columns only with money.
  function daySheets(dc, instituteName) {
    const x = dayTotals(dc);
    const m = x.money;
    const day = S.formatDate(x.day);
    const summary = [];
    x.modes.forEach((r) => summary.push(['By mode', r.label, r.payments].concat(m ? [r.amount] : [])));
    x.persons.forEach((r) => summary.push(['Taken by', r.label, r.payments].concat(m ? [r.amount] : [])));
    summary.push(['Cheques to bank', '', x.cheques.count].concat(m ? [x.cheques.amount] : []));
    summary.push(['Cancelled (reversed)', '', x.reversed.count].concat(m ? [x.reversed.amount] : []));
    summary.push(['Grand total', '', x.count].concat(m ? [x.total] : []));
    return [
      { name: 'Summary', headers: ['What', 'Who / mode', 'Payments'].concat(m ? ['Amount (₹)'] : []), rows: summary,
        notes: [(instituteName || '') + ' · Collection on ' + day, m ? 'In words: ' + x.words : 'Amounts are hidden for you.', 'Paid (office): recorded by the fees office. Reversed payments are not counted.'] },
      { name: 'Payments', headers: ['Time', 'Student', 'Class', 'Admission no'].concat(m ? ['Amount (₹)'] : [], ['Mode', 'Reference', 'Recorded by', 'Status']),
        rows: x.payments.map((p) => [S.formatTime(p.at), p.student, classOf(p), p.admission_no || ''].concat(m ? [num(p.amount)] : [],
          [FH.modeLabel(p.mode), p.reference || '', p.recorded_by_label || '', p.reversed ? 'Cancelled: ' + (p.reversed_reason || '') : 'Paid'])) },
      { name: 'Cheques', headers: ['Student', 'Class', 'Cheque no'].concat(m ? ['Amount (₹)'] : [], ['Note']),
        rows: x.cheques.rows.map((c) => [c.student, classOf(c), c.reference || ''].concat(m ? [num(c.amount)] : [], [c.note || ''])) },
      { name: 'Reversals', headers: ['Time', 'Student', 'Class'].concat(m ? ['Amount (₹)'] : [], ['Mode', 'Reason', 'Recorded by', 'Payment date']),
        rows: x.reversals.map((r) => [S.formatTime(r.at), r.student, classOf(r)].concat(m ? [num(r.amount)] : [],
          [FH.modeLabel(r.mode), r.reason || '', r.recorded_by_label || '', S.formatDate(r.paid_on)])) },
    ];
  }

  const helpers = {
    REASONS, WHO, DAY_MODES, MAX_FEES, reasonLabel, whoLabel, academicYearFor, classText, starterFees, planProblem, planData,
    defaultTicks, planPreview, applyDoneText, discountSplit, discountProblem, discountData, discountText, dayTotals, daySheets,
  };
  if (inNode) { module.exports = helpers; return; }

  // ---------- the pages (browser only) ----------

  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const X = window.VectorExcel;
  const errText = (err) => (err && err.message ? err.message : 'Try again.');
  const today = () => S.ymd(new Date());
  const help = (text, id) => el('p', { className: 'fb-help', id: id || null, text });
  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const canManage = (ctx) => FH.canManage(ctx.seat);
  const stepHead = (n, of, title, id) => el('div', { className: 'fb-step' }, [
    el('p', { className: 'fb-step-no', text: 'Step ' + n + ' of ' + of }),
    el('h3', { id: id || null, tabindex: '-1', text: title }),
  ]);
  function bigField(label, input, helpText, id) {
    return el('label', { className: 'fb-field', id: id || null }, [el('span', { className: 'fb-label', text: label }), input, helpText ? help(helpText) : null]);
  }
  function focusFirst(box) {
    const h = box && box.querySelector('h2[tabindex], h3[tabindex]');
    if (h) h.focus();
  }

  // =========================== Fee plan (#fees/plans) ===========================

  // Set by the Fees tab (fees.js): the classes of its students, and what to reload after fees change.
  const hooks = { classes: () => [], changed: () => {} };

  const plans = { ctx: null, box: null, list: [], form: null, preview: null, ticks: null, seq: 0, lastApply: null };

  function plansBuild(box) {
    box.appendChild(el('div', { className: 'panel fb-intro' }, [
      el('h2', { id: 'fp-title', tabindex: '-1', text: 'Fee plan' }),
      help('The fees of a class, set once and added to all its students.'),
      canManage(plans.ctx) ? el('div', { className: 'fb-actions' }, [el('button', { type: 'button', className: 'primary', id: 'fp-new', text: '+ Make a fee plan' })]) : null,
      msg('fp-msg'),
    ]));
    box.appendChild(el('div', { id: 'fp-list', className: 'fb-plans' }));
    box.appendChild(el('div', { id: 'fp-edit', className: 'panel fb-wizard', hidden: true }));
    box.appendChild(el('div', { id: 'fp-preview', className: 'panel fb-wizard', hidden: true }));
    if ($('fp-new')) $('fp-new').addEventListener('click', () => openPlanForm(null));
  }

  async function loadPlans() {
    const n = ++plans.seq;
    say('fp-msg', 'Loading…');
    try {
      const data = await plans.ctx.rpc('fee_plans_list');
      if (n !== plans.seq || !plans.ctx) return;
      plans.list = Array.isArray(data) ? data : [];
      say('fp-msg', '');
      renderPlans();
    } catch (err) {
      if (n === plans.seq && plans.ctx) say('fp-msg', 'Could not load the fee plans: ' + errText(err), true);
    }
  }

  function showPlansView(which) {
    $('fp-list').hidden = which !== 'list';
    $('fp-edit').hidden = which !== 'edit';
    $('fp-preview').hidden = which !== 'preview';
    const intro = plans.box.querySelector('.fb-intro');
    if (intro) intro.hidden = which !== 'list';
  }

  function renderPlans() {
    const box = $('fp-list');
    box.textContent = '';
    // One main button: "+ Make a fee plan" only while there is no plan; then "Apply" on a plan that needs it.
    if ($('fp-new')) $('fp-new').classList.toggle('primary', !plans.list.length);
    if (!plans.list.length) {
      box.appendChild(el('div', { className: 'panel fb-empty', id: 'fp-empty' }, [
        el('p', { className: 'fb-lead', text: 'No fee plan yet.' }),

      ]));
      return;
    }
    plans.list.forEach((p) => {
      const money = !p.money_hidden;
      const pend = p.pending || {};
      const total = (p.items || []).filter((it) => it.who === 'all').reduce((s, it) => s + (Number(it.amount) || 0), 0);
      const card = el('div', { className: 'panel fb-plan', 'data-plan': p.id, id: 'fp-plan-' + p.id }, [
        el('div', { className: 'fb-plan-head' }, [
          el('h3', { text: classText(p) + ' · ' + p.academic_year }),
          el('p', { className: 'fb-plan-count', text: plural(p.students || 0, 'student', 'students') }),
        ]),
        el('ul', { className: 'fb-fee-list' }, (p.items || []).map((it) => el('li', null, [
          el('span', { className: 'fb-fee-name', text: it.head }),
          el('span', { className: 'fb-fee-amt', text: money ? rupees(it.amount) : '' }),
          el('span', { className: 'fb-fee-sub', text: 'Due ' + S.formatDate(it.due_date) + (it.who !== 'all' ? ' · ' + whoLabel(it.who) : '') }),
        ]))),
        money && total ? el('p', { className: 'fb-plan-total', text: 'Every student pays ' + rupees(total) + ' in the year' + ((p.items || []).some((it) => it.who !== 'all') ? ', plus the fees only some pay.' : '.') }) : null,
        (p.rules || []).length ? el('p', { className: 'fb-plan-rules', text: 'Discounts: ' + p.rules.map((r) => r.reason_label + ' ' + Number(r.percent) + '% on ' + ((r.heads || []).join(', ') || 'the fees every student pays')).join('; ') }) : null,
      ]);
      const acts = el('div', { className: 'fb-actions' });
      if (Number(pend.students) > 0) {
        card.appendChild(el('p', { className: 'fb-callout', id: 'fp-pending-' + p.id, text: Number(pend.change) || Number(pend.remove)
          ? 'The plan changed. Apply the change to ' + plural(pend.students, 'student', 'students') + '.'
          : plural(pend.students, 'student does', 'students do') + ' not have these fees yet.' }));
      } else {
        card.appendChild(el('p', { className: 'fb-ok', text: 'Every student of ' + classText(p) + ' has these fees.' }));
      }
      if (canManage(plans.ctx)) {
        const apply = el('button', { type: 'button', className: Number(pend.students) > 0 ? 'primary' : null, id: 'fp-apply-' + p.id,
          text: Number(pend.change) || Number(pend.remove) ? 'Apply the change to ' + plural(pend.students, 'student', 'students') : 'Apply to all students in ' + classText({ class_label: p.class_label }) });
        apply.addEventListener('click', () => openPreview(p));
        const edit = el('button', { type: 'button', id: 'fp-edit-' + p.id, text: 'Change the fees' });
        edit.addEventListener('click', () => openPlanForm(p));
        acts.appendChild(apply);
        acts.appendChild(edit);
      }
      card.appendChild(acts);
      box.appendChild(card);
    });
  }

  // The plan form: Step 1 (class and year), Step 2 (fees and discounts), then Step 3 is the preview.
  function openPlanForm(p) {
    const year = p ? p.academic_year : academicYearFor();
    plans.form = {
      id: p ? p.id : null, academic_year: year, class_label: p ? p.class_label : '', board: p ? p.board || '' : '', section: p ? p.section || '' : '',
      auto_apply: p ? p.auto_apply !== false : true,
      items: p ? (p.items || []).map((it) => ({ id: it.id, head: it.head, amount: it.amount === null ? '' : String(Number(it.amount)), due_date: it.due_date, who: it.who })) : starterFees(year),
      rules: p ? (p.rules || []).map((r) => ({ id: r.id, reason: r.reason, percent: String(Number(r.percent)), note: r.note || '', head: (r.heads || [])[0] || '' })) : [],
      step: 1,
    };
    renderPlanForm();
    showPlansView('edit');
    focusFirst($('fp-edit'));
  }

  function readPlanForm() {
    const f = plans.form;
    if (!f) return;
    const v = (id) => { const n = $(id); return n ? n.value : undefined; };
    if (f.step === 1) {
      f.class_label = v('fp-class'); f.academic_year = v('fp-year'); f.board = v('fp-board'); f.section = v('fp-section') || '';
      f.auto_apply = $('fp-auto').checked;
    } else {
      f.items = f.items.map((it, i) => ({ ...it, head: v('fp-fee-' + i + '-head'), amount: v('fp-fee-' + i + '-amount'), due_date: v('fp-fee-' + i + '-due'), who: v('fp-fee-' + i + '-who') }));
      f.rules = f.rules.map((r, i) => ({ ...r, reason: v('fp-rule-' + i + '-reason'), percent: v('fp-rule-' + i + '-percent'), note: v('fp-rule-' + i + '-note') || '', head: v('fp-rule-' + i + '-head') || '' }));
    }
  }

  function renderPlanForm() {
    const f = plans.form;
    const box = $('fp-edit');
    box.textContent = '';
    const classes = hooks.classes();
    if (f.step === 1) {
      box.appendChild(stepHead(1, 3, f.id ? 'Which class is this plan for?' : 'Which class is the fee plan for?', 'fp-step-h'));
      const cls = el('input', { id: 'fp-class', type: 'text', maxlength: '20', value: f.class_label, list: 'fp-classes', autocomplete: 'off' });
      const board = el('select', { id: 'fp-board' }, [el('option', { value: '', text: 'All boards' })].concat(FH.BOARDS.map((b) => el('option', { value: b, text: b }))));
      board.value = f.board || '';
      box.appendChild(el('div', { className: 'fb-grid' }, [
        bigField('Class', cls, 'As in your student list, e.g. 8'),
        el('datalist', { id: 'fp-classes' }, classes.map((c) => el('option', { value: c }))),
        bigField('Academic year', el('input', { id: 'fp-year', type: 'text', maxlength: '9', value: f.academic_year, inputmode: 'numeric' })),
      ]));
      // Rare: one board or one section only, and turning off "new students get it".
      box.appendChild(el('details', { className: 'fb-more', id: 'fp-more', open: f.board || f.section || !f.auto_apply ? '' : null }, [
        el('summary', { text: 'More options' }),
        el('div', { className: 'fb-grid' }, [
          bigField('Board', board),
          bigField('Section', el('input', { id: 'fp-section', type: 'text', maxlength: '20', value: f.section }), 'Empty = every section'),
        ]),
        el('label', { className: 'check' }, [el('input', { type: 'checkbox', id: 'fp-auto', checked: f.auto_apply }), ' New students of this class get these fees']),
      ]));
      const next = el('button', { type: 'button', className: 'primary', id: 'fp-next', text: 'Next: the fees' });
      const cancel = el('button', { type: 'button', id: 'fp-cancel', text: 'Cancel' });
      next.addEventListener('click', () => goStep(2));
      cancel.addEventListener('click', () => { plans.form = null; showPlansView('list'); });
      box.appendChild(el('div', { className: 'fb-actions' }, [next, cancel]));
    } else {
      box.appendChild(stepHead(2, 3, 'The fees of ' + classText(f) + ' for ' + f.academic_year, 'fp-step-h'));
      const lines = el('div', { className: 'fb-fees', id: 'fp-fees' });
      f.items.forEach((it, i) => {
        const who = el('select', { id: 'fp-fee-' + i + '-who' }, WHO.map((w) => el('option', { value: w[0], text: w[1] })));
        who.value = it.who || 'all';
        const remove = el('button', { type: 'button', className: 'fb-remove', text: 'Remove', 'aria-label': 'Remove fee ' + (i + 1) });
        remove.addEventListener('click', () => { readPlanForm(); f.items.splice(i, 1); renderPlanForm(); });
        lines.appendChild(el('fieldset', { className: 'fb-fee' }, [
          el('legend', { text: 'Fee ' + (i + 1) }),
          bigField('Name of the fee', el('input', { id: 'fp-fee-' + i + '-head', type: 'text', maxlength: '80', value: it.head, autocomplete: 'off' }), null),
          bigField('Amount for one student (₹)', el('input', { id: 'fp-fee-' + i + '-amount', type: 'text', inputmode: 'decimal', value: it.amount, autocomplete: 'off' }), null),
          bigField('Due date', el('input', { id: 'fp-fee-' + i + '-due', type: 'date', value: it.due_date || '' })),
          bigField('Who pays', who),
          f.items.length > 1 ? remove : null,
        ]));
      });
      box.appendChild(lines);
      const addFee = el('button', { type: 'button', id: 'fp-fee-add', text: '+ Add another fee' });
      addFee.addEventListener('click', () => { readPlanForm(); f.items.push({ head: '', amount: '', due_date: '', who: 'all' }); renderPlanForm(); const n = $('fp-fee-' + (f.items.length - 1) + '-head'); if (n) n.focus(); });
      box.appendChild(el('div', { className: 'fb-actions' }, [addFee]));

      const rl = el('div', { className: 'fb-rules', id: 'fp-rules' });
      f.rules.forEach((r, i) => {
        const reason = el('select', { id: 'fp-rule-' + i + '-reason' }, REASONS.map((x) => el('option', { value: x[0], text: x[1] })));
        reason.value = r.reason || 'sibling';
        const on = el('select', { id: 'fp-rule-' + i + '-head' }, [el('option', { value: '', text: 'Every fee all students pay' })]
          .concat(f.items.filter((it) => String(it.head || '').trim()).map((it) => el('option', { value: it.head, text: it.head }))));
        on.value = r.head || '';
        const remove = el('button', { type: 'button', className: 'fb-remove', text: 'Remove', 'aria-label': 'Remove discount ' + (i + 1) });
        remove.addEventListener('click', () => { readPlanForm(); f.rules.splice(i, 1); renderPlanForm(); });
        rl.appendChild(el('fieldset', { className: 'fb-fee' }, [
          el('legend', { text: 'Discount ' + (i + 1) }),
          bigField('Reason', reason),
          bigField('Percent off', el('input', { id: 'fp-rule-' + i + '-percent', type: 'text', inputmode: 'decimal', value: r.percent, autocomplete: 'off' })),
          bigField('On', on),
          bigField('Note', el('input', { id: 'fp-rule-' + i + '-note', type: 'text', maxlength: '200', value: r.note || '' })),
          remove,
        ]));
      });
      const addRule = el('button', { type: 'button', id: 'fp-rule-add', text: '+ Add a discount' });
      addRule.addEventListener('click', () => { readPlanForm(); f.rules.push({ reason: 'sibling', percent: '10', note: '', head: '' }); renderPlanForm(); });
      // Discount rules ("Sibling 10% on tuition") are rare: behind "More options"; ticked per student on step 3.
      box.appendChild(el('details', { className: 'fb-more', id: 'fp-more2', open: f.rules.length ? '' : null }, [
        el('summary', { text: 'More options: discounts' }),
        rl, el('div', { className: 'fb-actions' }, [addRule]),
      ]));

      const save = el('button', { type: 'button', className: 'primary', id: 'fp-save', text: 'Next: check and add to students' });
      const back = el('button', { type: 'button', id: 'fp-back', text: 'Back' });
      save.addEventListener('click', savePlan);
      back.addEventListener('click', () => goStep(1));
      box.appendChild(el('div', { className: 'fb-actions fb-main' }, [save, back]));
    }
    box.appendChild(msg('fp-form-msg'));
  }

  function goStep(n) {
    readPlanForm();
    const f = plans.form;
    if (n === 2) {
      const p = planProblem(f);
      if (p && p.step === 1) { showFormProblem(p); return; }
    }
    f.step = n;
    renderPlanForm();
    focusFirst($('fp-edit'));
  }

  function showFormProblem(p) {
    say('fp-form-msg', p.text, true);
    const node = $('fp-' + p.field);
    if (node) { node.setAttribute('aria-invalid', 'true'); node.focus(); node.addEventListener('input', () => node.removeAttribute('aria-invalid'), { once: true }); }
  }

  async function savePlan() {
    readPlanForm();
    const f = plans.form;
    const p = planProblem(f);
    if (p) {
      if (p.step === 1) { f.step = 1; renderPlanForm(); }
      showFormProblem(p);
      return;
    }
    const btn = $('fp-save');
    btn.disabled = true;
    say('fp-form-msg', 'Saving…');
    try {
      let id = await plans.ctx.rpc('fee_plan_save', { p_plan: f.id, p_data: planData(f) });
      if (Array.isArray(id)) id = id[0];
      plans.form = null;
      await loadPlans();
      const saved = plans.list.find((x) => x.id === id) || { id, class_label: f.class_label, board: f.board, academic_year: f.academic_year };
      openPreview(saved, 'Fee plan saved.');
    } catch (err) {
      btn.disabled = false;
      say('fp-form-msg', 'Not saved: ' + errText(err), true);
    }
  }

  // Step 3: what applying will do, with ticks for the optional fees and discounts, and one main button.
  async function openPreview(p, note) {
    showPlansView('preview');
    const box = $('fp-preview');
    box.textContent = '';
    box.appendChild(stepHead(3, 3, 'Check, then add the fees to the students', 'fp-step-h'));
    box.appendChild(el('p', { className: 'msg', id: 'fp-pv-loading', text: 'Counting the students…' }));
    focusFirst(box);
    try {
      const pv = await plans.ctx.rpc('fee_plan_preview', { p_plan: p.id });
      if (!plans.ctx) return;
      plans.preview = pv || {};
      plans.ticks = defaultTicks(plans.preview);
      renderPreview(note);
    } catch (err) {
      box.appendChild(el('p', { className: 'msg error', text: 'Could not count the students: ' + errText(err) }));
    }
  }

  function renderPreview(note) {
    const pv = plans.preview;
    const box = $('fp-preview');
    box.textContent = '';
    box.appendChild(stepHead(3, 3, 'Check, then add the fees to the students', 'fp-step-h'));
    if (note) box.appendChild(el('p', { className: 'fb-done', id: 'fp-saved', text: note }));
    const sum = planPreview(pv, plans.ticks);
    const money = !pv.money_hidden;
    box.appendChild(el('p', { className: 'fb-sentence', id: 'fp-sentence', role: 'status', text: sum.sentence }));
    box.appendChild(el('ul', { className: 'fb-pv-list', id: 'fp-pv-items' }, sum.perItem.map((x) => el('li', null, [
      el('span', { className: 'fb-fee-name', text: x.head + (money && x.amount !== null ? ' · ' + rupees(x.amount) : '') }),
      el('span', { className: 'fb-fee-sub', text: [
        x.add ? 'add for ' + plural(x.add, 'student', 'students') : 'nothing to add',
        x.already ? plural(x.already, 'already has it', 'already have it') : '',
        x.change ? 'change for ' + S.count(x.change) : '',
        x.other ? S.count(x.other) + ' with another amount (left as it is)' : '',
        x.cancelled ? S.count(x.cancelled) + ' cancelled by hand (not added again)' : '',
      ].filter(Boolean).join(' · ') }),
    ]))));
    const optional = (pv.items || []).filter((it) => it.who !== 'all');
    const rules = pv.rules || [];
    if ((optional.length || rules.length) && (pv.rows || []).length) {
      box.appendChild(el('h4', { className: 'fb-sub', text: 'Tick the students for these' }));
      const cols = optional.map((it) => ({ kind: 'item', id: it.id, label: it.head }))
        .concat(rules.map((r) => ({ kind: 'rule', id: r.id, label: r.reason_label + ' ' + Number(r.percent) + '%' })));
      const body = el('tbody', { id: 'fp-ticks' });
      (pv.rows || []).forEach((r) => {
        const tr = el('tr', { 'data-student': r.student_id }, [el('td', { 'data-label': 'Student' }, [
          el('div', { className: 'fb-fee-name', text: r.name }),
          el('div', { className: 'fb-fee-sub', text: [r.section ? 'Section ' + r.section : '', r.admission_no ? 'Adm. no ' + r.admission_no : ''].filter(Boolean).join(' · ') }),
        ])]);
        cols.forEach((c) => {
          const td = el('td', { 'data-label': c.label, className: 'fb-tick' });
          if (c.kind === 'item') {
            const st = (r.items || {})[c.id];
            if (st === 'missing') {
              const box2 = el('input', { type: 'checkbox', 'aria-label': c.label + ' for ' + r.name, checked: plans.ticks.items[c.id].has(r.student_id), 'data-col': c.id });
              box2.addEventListener('change', () => { if (box2.checked) plans.ticks.items[c.id].add(r.student_id); else plans.ticks.items[c.id].delete(r.student_id); updateSentence(); });
              td.appendChild(el('label', { className: 'check' }, [box2, el('span', { className: 'sr-only', text: c.label })]));
            } else td.appendChild(el('span', { className: 'fb-fee-sub', text: st === 'cancelled' ? 'Cancelled' : st === 'other' ? 'Other amount' : 'Has it' }));
          } else if ((r.rules || []).includes(c.id)) {
            td.appendChild(el('span', { className: 'fb-fee-sub', text: 'Given' }));
          } else {
            const box2 = el('input', { type: 'checkbox', 'aria-label': c.label + ' for ' + r.name, checked: plans.ticks.rules[c.id].has(r.student_id), 'data-col': c.id });
            box2.addEventListener('change', () => { if (box2.checked) plans.ticks.rules[c.id].add(r.student_id); else plans.ticks.rules[c.id].delete(r.student_id); updateSentence(); });
            td.appendChild(el('label', { className: 'check' }, [box2, el('span', { className: 'sr-only', text: c.label })]));
          }
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      box.appendChild(el('div', { className: 'scroll fb-tick-scroll' }, [el('table', { className: 'stack fb-tick-table' }, [
        el('thead', null, [el('tr', null, [el('th', { text: 'Student' })].concat(cols.map((c) => el('th', { text: c.label }))))]),
        body,
      ])]));
    }
    const go = el('button', { type: 'button', className: 'primary', id: 'fp-go', disabled: sum.nothing,
      text: sum.nothing ? 'Nothing to add' : 'Yes, add the fees' });
    go.addEventListener('click', applyPlan);
    const back = el('button', { type: 'button', id: 'fp-pv-back', text: sum.nothing ? 'Back to fee plans' : 'No, go back' });
    back.addEventListener('click', () => { showPlansView('list'); renderPlans(); });
    box.appendChild(el('div', { className: 'fb-actions fb-main' }, [go, back]));
    box.appendChild(msg('fp-pv-msg'));
    box.appendChild(el('div', { id: 'fp-result' }));
  }

  function updateSentence() {
    const sum = planPreview(plans.preview, plans.ticks);
    $('fp-sentence').textContent = sum.sentence;
    const go = $('fp-go');
    go.disabled = sum.nothing;
    go.textContent = sum.nothing ? 'Nothing to add' : 'Yes, add the fees';
  }

  async function applyPlan() {
    const pv = plans.preview;
    const go = $('fp-go');
    go.disabled = true;
    say('fp-pv-msg', 'Adding the fees…');
    const chosen = {};
    Object.keys(plans.ticks.items).forEach((k) => { chosen[k] = [...plans.ticks.items[k]]; });
    const rules = {};
    Object.keys(plans.ticks.rules).forEach((k) => { if (plans.ticks.rules[k].size) rules[k] = [...plans.ticks.rules[k]]; });
    try {
      const res = await plans.ctx.rpc('fee_plan_apply', { p_plan: pv.plan.id, p_chosen: chosen, p_rules: rules });
      plans.lastApply = res || {};
      say('fp-pv-msg', '');
      const out = $('fp-result');
      out.textContent = '';
      out.appendChild(el('p', { className: 'fb-done', id: 'fp-done', role: 'status', text: applyDoneText(res, pv.plan) }));
      const acts = el('div', { className: 'fb-actions' });
      if (res && res.can_undo) {
        const undo = el('button', { type: 'button', id: 'fp-undo', text: 'Undo' });
        undo.addEventListener('click', undoApply);
        acts.appendChild(undo);
      }
      const back = el('button', { type: 'button', className: 'primary', id: 'fp-back-list', text: 'Back to fee plans' });
      back.addEventListener('click', () => { showPlansView('list'); });
      acts.appendChild(back);
      out.appendChild(acts);
      go.hidden = true;
      $('fp-pv-back').hidden = true;
      $('fp-done').focus && $('fp-done').setAttribute('tabindex', '-1');
      loadPlans();
      hooks.changed();
    } catch (err) {
      go.disabled = false;
      say('fp-pv-msg', 'Not added: ' + errText(err), true);
    }
  }

  async function undoApply() {
    const btn = $('fp-undo');
    btn.disabled = true;
    try {
      const res = await plans.ctx.rpc('fee_plan_undo', { p_apply: plans.lastApply.apply_id });
      $('fp-done').textContent = 'Undone. ' + plural((res || {}).fees_cancelled || 0, 'fee was', 'fees were') + ' taken off again.';
      btn.hidden = true;
      loadPlans();
      hooks.changed();
    } catch (err) {
      btn.disabled = false;
      say('fp-pv-msg', 'Could not undo: ' + errText(err), true);
    }
  }

  S.registerTab({
    id: 'fee-plans',
    label: 'Fee plan',
    part: true,
    mount(box, c) {
      plans.ctx = c; plans.box = box;
      plansBuild(box);
      showPlansView('list');
      loadPlans();
    },
    show() {
      if (!plans.ctx) return;
      if ($('fp-edit').hidden && $('fp-preview').hidden) { loadPlans(); focusFirst(plans.box); }
    },
    unmount() { plans.seq++; Object.assign(plans, { ctx: null, box: null, list: [], form: null, preview: null, ticks: null, lastApply: null }); },
  });

  // =========================== Today's collection (#fees/today) ===========================

  const day = { ctx: null, box: null, data: null, seq: 0 };

  function dayBuild(box) {
    const pick = el('input', { id: 'dc-day', type: 'date', value: today(), max: today() });
    const print = el('button', { type: 'button', className: 'primary', id: 'dc-print', text: 'Print' });
    const excel = el('button', { type: 'button', id: 'dc-excel', text: 'Download Excel' });
    box.appendChild(el('div', { className: 'panel fb-day-head' }, [
      el('h2', { id: 'dc-title', tabindex: '-1', text: 'Today\'s collection' }),
      el('div', { className: 'fb-day-bar' }, [bigField('Day', pick, null, 'dc-day-field'), el('div', { className: 'fb-actions' }, [print, excel])]),
      msg('dc-msg'),
    ]));
    box.appendChild(el('div', { id: 'dc-sheet', className: 'fb-sheet' }));
    pick.addEventListener('change', () => loadDay());
    print.addEventListener('click', printDay);
    excel.addEventListener('click', downloadDay);
  }

  async function loadDay() {
    const n = ++day.seq;
    const d = $('dc-day').value || today();
    say('dc-msg', 'Loading…');
    try {
      const data = await day.ctx.rpc('ledger_day_closing', { p_institute: day.ctx.institute.id, p_day: d });
      if (n !== day.seq || !day.ctx) return;
      day.data = data || {};
      say('dc-msg', day.data.money_hidden ? 'Amounts are hidden for you, so you see counts only.' : '');
      renderDay();
    } catch (err) {
      if (n === day.seq && day.ctx) say('dc-msg', 'Could not load the collection: ' + errText(err), true);
    }
  }

  const tableOf = (id, heads, rows, numCols) => el('div', { className: 'scroll' }, [el('table', { className: 'stack fb-day-table', id }, [
    el('thead', null, [el('tr', null, heads.map((h, i) => el('th', { text: h, className: (numCols || []).includes(i) ? 'num' : null })))]),
    el('tbody', null, rows),
  ])]);
  const td = (text, label, cls) => el('td', { text: text === null || text === undefined ? '' : String(text), 'data-label': label, className: cls || null });

  function renderDay() {
    const x = dayTotals(day.data);
    const m = x.money;
    const box = $('dc-sheet');
    box.textContent = '';
    const isToday = x.day === x.today;
    box.appendChild(el('div', { className: 'panel fb-sheet-head' }, [
      el('p', { className: 'fb-sheet-inst', text: day.ctx.institute.name || '' }),
      el('h3', { id: 'dc-day-title', text: 'Collection on ' + S.formatDate(x.day) + (isToday ? ' (today)' : '') }),
      el('div', { className: 'fb-grand', id: 'dc-total' }, [
        el('div', { className: 'fb-grand-label', text: 'Grand total' }),
        el('div', { className: 'fb-grand-value', id: 'dc-total-value', text: m ? rupees(x.total) : plural(x.count, 'payment', 'payments') }),
        m ? el('div', { className: 'fb-grand-words', id: 'dc-words', text: x.words }) : null,
        el('div', { className: 'fb-grand-sub', text: plural(x.count, 'payment', 'payments') + (x.reversed.count ? ' · ' + plural(x.reversed.count, 'payment', 'payments') + ' cancelled, not counted' : '') }),
      ]),
    ]));
    box.appendChild(el('div', { className: 'panel' }, [
      el('h4', { className: 'fb-sub', text: 'By mode' }),
      el('div', { className: 'fb-modes', id: 'dc-modes' }, x.modes.map((r) => el('div', { className: 'fb-mode' + (r.payments ? '' : ' empty'), id: 'dc-mode-' + r.mode }, [
        el('div', { className: 'fb-mode-label', text: r.label }),
        el('div', { className: 'fb-mode-value', text: m ? rupees(r.amount || 0) : S.count(r.payments) }),
        el('div', { className: 'fb-mode-sub', text: plural(r.payments, 'payment', 'payments') }),
      ]))),
    ]));
    box.appendChild(el('div', { className: 'panel' }, [
      el('h4', { className: 'fb-sub', text: 'Who took the money' }),
      x.persons.length ? tableOf('dc-persons', ['Name', 'Payments'].concat(m ? ['Amount'] : []), x.persons.map((p) => el('tr', null, [
        td(p.label, 'Name'), td(S.count(p.payments), 'Payments', 'num')].concat(m ? [td(rupees(p.amount), 'Amount', 'num')] : []))), [1, 2])
        : help('No payments on this day.'),
    ]));
    box.appendChild(el('div', { className: 'panel' }, [
      el('h4', { className: 'fb-sub', text: 'Cheques to deposit in the bank' }),
      x.cheques.rows.length ? tableOf('dc-cheques', ['Student', 'Class', 'Cheque no'].concat(m ? ['Amount'] : []), x.cheques.rows.map((c) => el('tr', null, [
        td(c.student, 'Student'), td(classOf(c), 'Class'), td(c.reference || '', 'Cheque no')].concat(m ? [td(rupees(c.amount), 'Amount', 'num')] : []))), [3])
        : help('No cheques on this day.'),
      x.cheques.rows.length ? el('p', { className: 'fb-total-line', id: 'dc-cheque-total', text: plural(x.cheques.count, 'cheque', 'cheques') + (m ? ', ' + rupees(x.cheques.amount) + ' in all' : '') }) : null,
    ]));
    box.appendChild(el('div', { className: 'panel' }, [
      el('h4', { className: 'fb-sub', text: 'Every payment' }),
      x.payments.length ? tableOf('dc-payments', ['Time', 'Student', 'Class'].concat(m ? ['Amount'] : [], ['Mode', 'Reference', 'Recorded by']), x.payments.map((p) => el('tr', { className: p.reversed ? 'reversed' : null }, [
        td(S.formatTime(p.at), 'Time'), td(p.student + (p.reversed ? ' (cancelled: ' + (p.reversed_reason || '') + ')' : ''), 'Student'), td(classOf(p), 'Class')]
        .concat(m ? [td(rupees(p.amount), 'Amount', 'num')] : [], [td(FH.modeLabel(p.mode), 'Mode'), td(p.reference || '', 'Reference'), td(p.recorded_by_label || '', 'Recorded by')]))), m ? [3] : [])
        : help('No payments on this day.'),
    ]));
    if (x.reversals.length) {
      box.appendChild(el('div', { className: 'panel' }, [
        el('h4', { className: 'fb-sub', text: 'Payments cancelled (reversed)' }),
        tableOf('dc-reversals', ['Time', 'Student'].concat(m ? ['Amount'] : [], ['Mode', 'Reason', 'By']), x.reversals.map((r) => el('tr', { className: 'reversal' }, [
          td(S.formatTime(r.at), 'Time'), td(r.student, 'Student')].concat(m ? [td('−' + rupees(r.amount), 'Amount', 'num')] : [],
          [td(FH.modeLabel(r.mode), 'Mode'), td(r.reason || '', 'Reason'), td(r.recorded_by_label || '', 'By')]))), m ? [2] : []),
      ]));
    }
    box.appendChild(el('p', { className: 'fb-sign', text: 'Counted by: ____________________      Checked by: ____________________' }));
  }

  function printDay() {
    document.body.classList.add('fees-printing-day');
    try { window.print(); } finally { setTimeout(() => document.body.classList.remove('fees-printing-day'), 0); }
  }

  async function downloadDay() {
    if (!day.data) return;
    const btn = $('dc-excel');
    btn.disabled = true;
    say('dc-msg', 'Preparing the Excel file…');
    let data = day.data;
    let note = '';
    try {
      if (!data.money_hidden) {
        const x = dayTotals(data);
        try {
          await day.ctx.rpc('log_money_export', { p_institute: day.ctx.institute.id, p_what: 'day_closing', p_rows: x.payments.length + x.reversals.length + 10 });
        } catch (err) {
          data = Object.assign({}, data, { money_hidden: true });
          note = ' The file has no ₹ columns: ' + errText(err);
        }
      }
      const name = X.fileName(['vector collection', data.day]);
      await X.download(daySheets(data, day.ctx.institute.name), name);
      say('dc-msg', 'Saved ' + name + '.' + note, !!note);
    } catch (err) {
      say('dc-msg', 'Could not download: ' + errText(err), true);
    } finally {
      btn.disabled = false;
    }
  }
  const afterPrint = () => document.body.classList.remove('fees-printing-day');

  S.registerTab({
    id: 'day-closing',
    label: 'Today\'s collection',
    part: true,
    mount(box, c) {
      day.ctx = c; day.box = box;
      dayBuild(box);
      window.addEventListener('afterprint', afterPrint);
      loadDay();
    },
    show(params) {
      if (!day.ctx) return;
      if (params && params.day && FH.parseDay(params.day)) $('dc-day').value = params.day;
      loadDay();
      focusFirst(day.box);
    },
    unmount() { day.seq++; window.removeEventListener('afterprint', afterPrint); Object.assign(day, { ctx: null, box: null, data: null }); },
  });

  // =========================== Give a discount (on a student's page) ===========================

  // The discount panel: three steps and a check line before saving. detail: accounts_student_detail;
  // onDone(text): called after a discount is given or undone (the page reloads the student).
  function discountPanel(ctx, detail, onDone) {
    const st = detail.student || {};
    const b = detail.balance || {};
    const money = !detail.money_hidden;
    const fees = (detail.fee_items || []).filter((f) => !f.is_void)
      .map((f) => ({ id: f.id, head: f.head, amount: Number(f.amount) || 0, left: (Number(f.amount) || 0) - (Number(f.discount) || 0), due_date: f.due_date }));
    const d = { kind: 'amount', value: '', whole_year: true, fee_items: [], reason: 'sibling', note: '', approved_by: (ctx.seat && ctx.seat.label) || '', step: 1 };
    const box = el('div', { className: 'panel fb-wizard', id: 'fd-panel' });

    function read() {
      const v = (id) => { const n = box.querySelector('#' + id); return n ? n.value : undefined; };
      if (d.step === 1) {
        const k = box.querySelector('input[name="fd-kind"]:checked');
        if (k) d.kind = k.value;
        d.value = v('fd-value');
      } else if (d.step === 2) {
        const w = box.querySelector('input[name="fd-on"]:checked');
        d.whole_year = !w || w.value === 'year';
        d.fee_items = Array.from(box.querySelectorAll('input[name="fd-fee"]:checked')).map((x) => x.value);
      } else {
        const r = box.querySelector('input[name="fd-reason"]:checked');
        if (r) d.reason = r.value;
        d.note = v('fd-note') || '';
        d.approved_by = v('fd-approved') || '';
      }
    }
    const split = () => discountSplit(d.whole_year ? fees : fees.filter((f) => d.fee_items.includes(f.id)), d.kind, LU.parseAmount(String(d.value).replace('%', '')));
    function stepProblem() {
      const x = discountProblem(Object.assign({}, d, d.step < 3 ? { reason: 'sibling' } : {}, d.step < 2 ? { whole_year: true } : {}));
      if (x) return x;
      if (d.step >= 2) { const s = split(); if (s.problem) return s.problem; }
      return '';
    }
    function render() {
      box.textContent = '';
      const radio = (name, value, label, checked, id) => el('label', { className: 'check' }, [el('input', { type: 'radio', name, value, checked, id: id || null }), ' ' + label]);
      if (d.step === 1) {
        box.appendChild(stepHead(1, 3, 'How much is the discount?', 'fd-h'));
        box.appendChild(el('div', { className: 'fb-radios', role: 'radiogroup', 'aria-label': 'Rupees or percent' }, [
          radio('fd-kind', 'amount', 'An amount in rupees (₹)', d.kind === 'amount', 'fd-kind-amount'),
          radio('fd-kind', 'percent', 'A percent (%) of the fees', d.kind === 'percent', 'fd-kind-percent'),
        ]));
        box.appendChild(bigField('Discount', el('input', { id: 'fd-value', type: 'text', inputmode: 'decimal', value: d.value, autocomplete: 'off' }), null));
      } else if (d.step === 2) {
        box.appendChild(stepHead(2, 3, 'On which fees?', 'fd-h'));
        box.appendChild(el('div', { className: 'fb-radios', role: 'radiogroup', 'aria-label': 'Which fees' }, [
          radio('fd-on', 'year', 'The whole year (all fees)', d.whole_year, 'fd-on-year'),
          radio('fd-on', 'some', 'Only the fees I tick', !d.whole_year, 'fd-on-some'),
        ]));
        const list = el('div', { className: 'fb-fee-ticks', id: 'fd-fees' }, fees.map((f) => el('label', { className: 'check' }, [
          el('input', { type: 'checkbox', name: 'fd-fee', value: f.id, checked: d.fee_items.includes(f.id) }),
          ' ' + f.head + (money ? ' · ' + rupees(f.amount) : '') + ' · due ' + S.formatDate(f.due_date),
        ])));
        list.hidden = d.whole_year;
        box.appendChild(list);
      } else {
        box.appendChild(stepHead(3, 3, 'Why, and who approved it?', 'fd-h'));
        box.appendChild(el('div', { className: 'fb-radios', role: 'radiogroup', 'aria-label': 'Reason' }, REASONS.map((r) => radio('fd-reason', r[0], r[1], d.reason === r[0], 'fd-reason-' + r[0]))));
        box.appendChild(bigField('Note', el('input', { id: 'fd-note', type: 'text', maxlength: '200', value: d.note }), 'Needed for "Other"'));
        box.appendChild(el('details', { className: 'fb-more' }, [el('summary', { text: 'Approved by: ' + (d.approved_by || 'you') }),
          bigField('Approved by', el('input', { id: 'fd-approved', type: 'text', maxlength: '80', value: d.approved_by }))]));
        const s = split();
        const total = Number(b.balance_total);
        box.appendChild(el('p', { className: 'fb-sentence', id: 'fd-check', text: money && !s.problem
          ? 'The discount is ' + rupees(s.total) + '. ' + st.name + '\'s fees left for the year go from ' + rupees(total) + ' to ' + rupees(total - s.total) + '.'
          : 'Check the discount, then save it.' }));
      }
      const main = el('button', { type: 'button', className: 'primary', id: 'fd-next', text: d.step < 3 ? 'Next' : 'Give the discount' });
      const back = el('button', { type: 'button', id: 'fd-back', text: d.step > 1 ? 'Back' : 'Cancel' });
      main.addEventListener('click', next);
      back.addEventListener('click', () => { read(); if (d.step > 1) { d.step--; render(); focusFirst(box); } else box.remove(); });
      box.appendChild(el('div', { className: 'fb-actions fb-main' }, [main, back]));
      box.appendChild(msg('fd-msg'));
    }
    async function next() {
      read();
      const p = stepProblem();
      if (p) { say(box.querySelector('#fd-msg'), p, true); return; }
      if (d.step < 3) { d.step++; render(); focusFirst(box); return; }
      const btn = box.querySelector('#fd-next');
      btn.disabled = true;
      say(box.querySelector('#fd-msg'), 'Saving…');
      try {
        const res = await ctx.rpc('accounts_give_discount', { p_student: st.id, p_data: discountData(d) });
        onDone('Discount of ' + (money ? rupees((res || {}).amount) : '') + ' given to ' + st.name + '.', res && res.grant_id);
      } catch (err) {
        btn.disabled = false;
        say(box.querySelector('#fd-msg'), 'Not saved: ' + errText(err), true);
      }
    }
    box.addEventListener('change', (e) => {
      const list = box.querySelector('#fd-fees');
      if (list && e.target && e.target.name === 'fd-on') list.hidden = e.target.value === 'year';
    });
    render();
    return box;
  }

  window.VectorFeesBasics = Object.assign({ discountPanel, hooks }, helpers);
})();
