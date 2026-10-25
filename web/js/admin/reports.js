'use strict';
/* Reports tab of the admin app (web/admin.html). One filter bar (dates, campaign, caller) and a report picker:
   - Fees collection: total due, paid after a call, promised, promise date passed and not paid; the promises
     due this week with "Send these back to callers" (their next call time becomes now, so they come up first).
   - Sales funnel: called, picked up, heard the pitch, interested, joined; the biggest drop and the top reason.
   - Results: results by outcome and the team activity CSV (moved here from the old admin page).
   - Why calls are lost: script results for one version, where calls ended and what went wrong, with suggested
     changes the admin approves or rejects (moved here from the script editor). Needs the Scripts add-on.
   - Weekly summary, with its CSV.
   "Download Excel" saves the open report as one .xlsx workbook (js/excel-export.js). CSV downloads stay.
   Phase A.2 (migration 20261025150000): with a fee ledger, Fees collection reads admin_fees_ledger (total due
   now and collected, split by mode and by day, from the ledger; promised and broken promises from calls,
   checked against the ledger) and admin_promises_ledger (each promise says paid on <date> by <mode>, partly
   paid or not paid). "Paid after a call" stays apart, labelled "reported by caller". The Excel file then has a
   Ledger sheet. Without the ledger functions or any students, the report is what callers reported, as before.
   Reads: admin_fees_report, admin_promises_due, admin_sales_funnel (migration 20261024100024),
   admin_results_by_outcome, admin_team_activity, admin_weekly_summary, admin_script_report, admin_loss_insights,
   admin_seat_list, my_features, the campaigns table. Writes: admin_send_back_leads, admin_decide_suggestion,
   log_money_export. The database checks the admin role, the institute and money access on every call.
   Money rules (docs/data-contract.md): ₹ only when ctx.canSeeMoney and the server did not hide it; paid amounts
   say "reported by caller"; an Excel file with ₹ columns is logged with log_money_export first, and without
   money access the file has counts only.
   Linkable: #reports?report=funnel opens a report; #reports?script=<id>&version=<id> opens script results.
   The pure helpers at the top are also loaded by tests/web/reports.test.js (Node, no DOM). */
(function () {
  const inNode = typeof window === 'undefined' && typeof module !== 'undefined' && module.exports;
  const S = inNode ? require('./shared.js') : window.VectorAdminShared;

  // ---------- pure helpers ----------

  const REPORTS = [
    { id: 'fees', label: 'Fees collection' },
    { id: 'funnel', label: 'Sales funnel' },
    { id: 'results', label: 'Results' },
    { id: 'lost', label: 'Why calls are lost' },
    { id: 'weekly', label: 'Weekly summary' },
  ];
  const DEFAULT_REPORT = 'fees';
  // An Accounts seat (Phase A.2) opens Reports for Fees collection only: the other reports are for owners and
  // managers, and their functions refuse Accounts.
  const ACCOUNTS_REPORTS = ['fees'];
  const isAccountsSeat = (seat) => !!seat && (seat.access_role === 'accounts' || seat.role === 'accounts' || seat.admin_kind === 'accounts');
  const reportsFor = (seat) => (isAccountsSeat(seat) ? REPORTS.filter((r) => ACCOUNTS_REPORTS.includes(r.id)) : REPORTS.slice());
  const DATE_PRESETS = [
    { id: 'last7', label: 'Last 7 days' },
    { id: 'week', label: 'This week' },
    { id: 'last30', label: 'Last 30 days' },
    { id: 'month', label: 'This month' },
    { id: 'custom', label: 'Pick dates' },
  ];
  const REASON_LABEL = {
    price: 'Price', timing: 'Timing', already_enrolled: 'Already enrolled', no_need: 'No need',
    wrong_person: 'Wrong person', other: 'Other', not_recorded: 'Not recorded',
  };
  const PROMISE_DAYS = 7;
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const plural = (n, one, many) => n + ' ' + (Number(n) === 1 ? one : many);
  const reasonLabel = (r) => REASON_LABEL[r] || String(r || '');

  // The from and to days of a date preset, as local 'YYYY-MM-DD'. "This week" starts on Monday. null for custom.
  function presetRange(id, now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const back = (days) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
    if (id === 'last7') return { from: ymd(back(6)), to: ymd(today) };
    if (id === 'last30') return { from: ymd(back(29)), to: ymd(today) };
    if (id === 'week') return { from: ymd(back((today.getDay() + 6) % 7)), to: ymd(today) };
    if (id === 'month') return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(today) };
    return null;
  }

  // Status of a promise from days_late (today minus the promised date): due today, N days late, or not yet due.
  function promiseStatus(daysLate) {
    const n = num(daysLate);
    if (n === null || !Number.isFinite(n)) return { text: '', level: '' };
    if (n === 0) return { text: 'Due today', level: 'due' };
    if (n > 0) return { text: plural(n, 'day late', 'days late'), level: 'late' };
    return { text: 'Not yet due', level: 'later' };
  }

  // The leads "Send these back to callers" sends: promises due today or late (not the ones still to come),
  // still open, and not already paid in the fee ledger.
  function dueForSendBack(promises) {
    return (promises || []).filter((p) => num(p.days_late) !== null && num(p.days_late) >= 0 &&
      p.lead_status !== 'done' && p.ledger_state !== 'paid').map((p) => p.lead_id);
  }

  // ---------- the fee ledger (Phase A.2) ----------

  // Payment modes in the ledger (payments.mode), in the order they are shown.
  const MODES = [
    ['upi', 'UPI'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['card', 'Card'], ['bank', 'Bank transfer'], ['other', 'Other'],
  ];
  const modeLabel = (m) => (MODES.find((x) => x[0] === m) || [m, m ? String(m) : 'Other'])[1];
  const FROM_LEDGER = 'fee ledger';
  const FROM_CALLS = 'from calls';

  // What the ledger shows for one promise (a row of admin_promises_ledger): { text, level }.
  // money: the paid amount may be shown (part paid only).
  function ledgerStatus(p, money) {
    const r = p || {};
    if (r.ledger_state === 'paid') {
      const on = r.paid_on ? ' on ' + S.formatDate(r.paid_on, { year: false }) : '';
      const by = r.paid_mode ? ' by ' + modeLabel(r.paid_mode) : '';
      return { text: 'Paid' + on + by, level: 'good' };
    }
    if (r.ledger_state === 'part_paid') {
      const amt = money && num(r.paid_amount) !== null ? ' (' + S.rupees(r.paid_amount) + ')' : '';
      return { text: 'Partly paid' + amt, level: 'part' };
    }
    if (r.ledger_state === 'not_paid') return { text: 'Not paid', level: 'late' };
    if (r.ledger_state === 'no_student') return { text: 'Not in the fee ledger', level: 'later' };
    return { text: '', level: '' };
  }

  // The four ledger cards from admin_fees_ledger. money: show ₹ (else counts only).
  function ledgerCards(led, money) {
    const d = led || {};
    const part = (k) => d[k] || {};
    const n = (v) => Number(v) || 0;
    const due = part('due_now');
    const col = part('collected');
    const pro = part('promised');
    const brk = part('broken');
    const value = (amount, count) => (money ? S.rupees(n(amount)) : S.count(n(count)));
    const brokenSub = 'Date passed, not paid in the ledger' + (n(brk.part_paid) ? ' · ' + S.count(n(brk.part_paid)) + ' partly paid' : '');
    return [
      { label: 'Total due now', value: value(due.amount, due.students), sub: plural(S.count(n(due.students)), 'student', 'students') + ' · ' + FROM_LEDGER, level: '' },
      { label: 'Collected', value: value(col.total, col.payments), sub: plural(S.count(n(col.payments)), 'payment', 'payments') + ' · ' + FROM_LEDGER, level: 'good' },
      { label: 'Promised, not yet paid', value: value(pro.amount, pro.leads), sub: plural(S.count(n(pro.leads)), 'parent', 'parents') + ' · ' + FROM_CALLS, level: '' },
      { label: 'Broken promises', value: S.count(n(brk.leads)), sub: brokenSub, level: 'bad' },
    ];
  }

  // Collected by mode, in MODES order, only the modes with payments: [{ mode, label, payments, amount, text }].
  function modeSplit(byMode, money) {
    const list = Array.isArray(byMode) ? byMode : [];
    const known = MODES.map((m) => m[0]);
    return list.filter((r) => r && Number(r.payments) > 0)
      .map((r) => ({ mode: r.mode, label: modeLabel(r.mode), payments: Number(r.payments) || 0, amount: money ? num(r.amount) : null }))
      .sort((a, b) => (known.indexOf(a.mode) + 99 * (known.indexOf(a.mode) < 0)) - (known.indexOf(b.mode) + 99 * (known.indexOf(b.mode) < 0)))
      .map((r) => Object.assign(r, { text: money ? S.rupees(r.amount || 0) : plural(S.count(r.payments), 'payment', 'payments') }));
  }

  // Collected by day for the chart: every day from..to (when the range is 14 days or less) with 0 for days without
  // payments, else only the days with payments. [{ day 'YYYY-MM-DD', payments, amount }] oldest first.
  function dayRows(byDay, from, to) {
    const got = {};
    (Array.isArray(byDay) ? byDay : []).forEach((r) => { if (r && r.day) got[String(r.day).slice(0, 10)] = r; });
    const a = S.parseYmd(from);
    const b = S.parseYmd(to);
    const out = [];
    if (a && b && b >= a && Math.round((b - a) / 86400000) <= 13) {
      for (let d = new Date(a); d <= b; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        const k = ymd(d);
        const r = got[k] || {};
        out.push({ day: k, payments: Number(r.payments) || 0, amount: num(r.amount) });
      }
      return out;
    }
    return Object.keys(got).sort().map((k) => ({ day: k, payments: Number(got[k].payments) || 0, amount: num(got[k].amount) }));
  }

  // Student and class from a lead's sheet columns (extra), such as { "Student name": "Ravi", "Class": "10-A" }
  // to 'Ravi · 10-A'. Column names are matched loosely; '' when neither is there.
  const STUDENT_KEY = /^(student|child|ward|son|daughter)( (full )?name)?$/;
  const CLASS_KEY = /^(class|grade|std|standard|section|division|batch|class section|class and section)$/;
  function studentClass(extra) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return '';
    const keys = Object.keys(extra);
    const norm = (k) => String(k).toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    const pick = (re) => {
      const k = keys.find((x) => re.test(norm(x)));
      const v = k === undefined ? '' : extra[k];
      return v === null || v === undefined ? '' : String(v).trim();
    };
    return [pick(STUDENT_KEY), pick(CLASS_KEY)].filter(Boolean).join(' · ');
  }

  // The five funnel steps from admin_sales_funnel, each with its share of all calls (0 to 100, whole numbers).
  function funnelSteps(f) {
    const d = f || {};
    const called = Number(d.called) || 0;
    return [
      ['called', 'Called'], ['picked_up', 'Picked up'], ['heard_pitch', 'Heard the pitch'],
      ['interested', 'Interested'], ['joined', 'Joined'],
    ].map(([key, label]) => {
      const count = Number(d[key]) || 0;
      return { key, label, count, percent: called ? Math.round((count * 100) / called) : 0 };
    });
  }

  // The step where most calls are lost (by number of calls), or null when no step loses any.
  function biggestDrop(steps) {
    let best = null;
    for (let i = 1; i < (steps || []).length; i++) {
      const lost = steps[i - 1].count - steps[i].count;
      if (lost > 0 && (!best || lost > best.lost)) best = { from: steps[i - 1].label, to: steps[i].label, lost };
    }
    return best;
  }

  // The plain lines under the funnel.
  function funnelNotes(f) {
    const d = f || {};
    if (!Number(d.called)) return ['No sales calls in these dates.'];
    const lines = [];
    const drop = biggestDrop(funnelSteps(d));
    if (drop) lines.push('Biggest drop: between "' + drop.from + '" and "' + drop.to + '" (' + plural(drop.lost, 'call', 'calls') + ').');
    const top = d.top_reason;
    if (top && top.reason) lines.push('Top reason given on lost calls: ' + reasonLabel(top.reason) + ' (' + plural(top.calls, 'call', 'calls') + ').');
    else lines.push('No reason recorded on lost calls yet.');
    if (d.pitch_guessed) lines.push('No step is marked as the pitch in your script, so the middle step is used for "Heard the pitch".');
    if (Number(d.no_step) > 0) {
      lines.push(plural(d.no_step, 'picked-up call has', 'picked-up calls have') + ' no script step recorded, so ' +
        (Number(d.no_step) === 1 ? 'it is' : 'they are') + ' not counted as hearing the pitch.');
    }
    return lines;
  }

  // The four Fees collection cards. money: show ₹ (else counts only). The paid card says "reported by caller".
  function feesCards(rep, money) {
    const r = rep || {};
    const parents = (n) => plural(S.count(Number(n) || 0), 'parent', 'parents');
    const card = (label, amount, n, sub, level) => ({
      label,
      value: money ? S.rupees(Number(amount) || 0) : S.count(Number(n) || 0),
      sub: money ? parents(n) + (sub ? ' · ' + sub : '') : (Number(n) === 1 ? 'parent' : 'parents') + (sub ? ' · ' + sub : ''),
      level: level || '',
    });
    return [
      card('Total due', r.total_due, r.leads, ''),
      card('Paid after a call', r.paid_amount, r.paid_leads, S.REPORTED_BY_CALLER, 'good'),
      card('Promised', r.promised_amount, r.promised_leads, 'not paid yet'),
      { label: 'Promise date passed, not paid', value: S.count(Number(r.broken_promises) || 0), sub: 'Call these again first', level: 'bad' },
    ];
  }

  // ---------- workbooks (one per report; see js/excel-export.js for the sheet shape) ----------

  // money: put ₹ columns in. Only after log_money_export said yes.
  // led: admin_fees_ledger (Phase A.2). With it the summary counts money received from the fee ledger, the
  // promises say what the ledger shows, and a Ledger sheet lists collections by mode and by day. Without it
  // (an older database, or no ledger yet) the file is as before: what callers reported.
  function feesSheets(rep, promises, money, led) {
    const r = rep || {};
    const n = (v) => Number(v) || 0;
    const amount = (v) => (money ? [num(v)] : []);
    if (led) return ledgerSheets(rep || null, promises, money, led);
    const summary = {
      name: 'Fees collection',
      headers: ['Measure', 'Parents'].concat(money ? ['Amount (₹)'] : []),
      rows: [
        ['Total due', n(r.leads)].concat(amount(r.total_due)),
        ['Paid after a call (' + S.REPORTED_BY_CALLER + ')', n(r.paid_leads)].concat(amount(r.paid_amount)),
        ['Promised, not paid yet', n(r.promised_leads)].concat(amount(r.promised_amount)),
        ['Promise date passed, not paid', n(r.broken_promises)].concat(money ? [null] : []),
      ],
      notes: ['Paid amounts are ' + S.REPORTED_BY_CALLER + '.'].concat(money ? [] : ['Amounts are hidden, so this file has counts only.']),
    };
    const due = {
      name: 'Promises due this week',
      headers: ['Parent', 'Student and class'].concat(money ? ['Promised amount (₹)'] : [])
        .concat(['Promised for', 'Caller', 'Campaign', 'Status']),
      rows: (promises || []).map((p) => [p.name, studentClass(p.extra)].concat(money ? [num(p.amount)] : [])
        .concat([p.promised_date || '', p.caller || 'Not assigned', p.campaign || '', promiseStatus(p.days_late).text])),
    };
    return [summary, due];
  }

  function ledgerSheets(r, promises, money, led) {
    const n = (v) => Number(v) || 0;
    const amount = (v) => (money ? [num(v)] : []);
    const part = (k) => led[k] || {};
    const due = part('due_now');
    const col = part('collected');
    const pro = part('promised');
    const brk = part('broken');
    const summary = {
      name: 'Fees collection',
      headers: ['Measure', 'Count'].concat(money ? ['Amount (₹)'] : []),
      rows: [
        ['Total due now (fee ledger, students)', n(due.students)].concat(amount(due.amount)),
        ['Collected (fee ledger, payments)', n(col.payments)].concat(amount(col.total)),
        ['Promised, not yet paid (calls, parents)', n(pro.leads)].concat(amount(pro.amount)),
        ['Broken promises (date passed, not paid in the ledger)', n(brk.leads)].concat(amount(brk.amount)),
      ].concat(r ? [['Paid after a call (' + S.REPORTED_BY_CALLER + ', calls)', n(r.paid_calls)].concat(amount(r.paid_amount))] : []),
      notes: ['Due and collected come from the fee ledger. Promises come from calls and are checked against the ledger.']
        .concat(r ? ['Paid after a call is ' + S.REPORTED_BY_CALLER + ' and is not added to Collected.'] : [])
        .concat(money ? [] : ['Amounts are hidden, so this file has counts only.']),
    };
    const dueSheet = {
      name: 'Promises due this week',
      headers: ['Parent', 'Student and class'].concat(money ? ['Promised amount (₹)'] : [])
        .concat(['Promised for', 'Caller', 'Campaign', 'Status', 'In the fee ledger'])
        .concat(money ? ['Paid since the promise (₹)'] : []),
      rows: (promises || []).map((p) => [p.name, studentClass(p.extra)].concat(money ? [num(p.amount)] : [])
        .concat([p.promised_date || '', p.caller || 'Not assigned', p.campaign || '', promiseStatus(p.days_late).text,
          ledgerStatus(p, false).text])
        .concat(money ? [num(p.paid_amount)] : [])),
    };
    const modes = modeSplit(col.by_mode, money).map((m) => ['By mode', m.label, m.payments].concat(money ? [m.amount] : []));
    const days = dayRows(col.by_day, led.from, led.to).filter((d) => d.payments > 0)
      .map((d) => ['By day', d.day, d.payments].concat(money ? [d.amount] : []));
    const ledger = {
      name: 'Ledger',
      headers: ['Collected', 'Mode or day', 'Payments'].concat(money ? ['Amount (₹)'] : []),
      rows: modes.concat(days),
      notes: ['Payments in the fee ledger dated ' + (led.from || '') + ' to ' + (led.to || '') +
        '. Reversed payments and opening balances are left out.'].concat(money ? [] : ['Amounts are hidden, so this sheet has counts only.']),
    };
    return [summary, dueSheet, ledger];
  }

  function funnelSheets(f) {
    return [{
      name: 'Sales funnel',
      headers: ['Step', 'Calls', 'Share of calls (%)'],
      rows: funnelSteps(f).map((s) => [s.label, s.count, s.percent]),
      notes: funnelNotes(f),
    }];
  }

  // reps: pivotOutcomes() rows; outcomes: the outcome names in column order; team: admin_team_activity rows
  // already shaped as teamHeaders / teamRows (js/admin.js).
  function resultsSheets(reps, outcomes, teamHeaders, teamRows) {
    const pretty = (s) => String(s).replace(/_/g, ' ');
    return [
      {
        name: 'Results by outcome',
        headers: ['Caller'].concat(outcomes.map(pretty)).concat(['Total']),
        rows: (reps || []).map((r) => [r.label].concat(outcomes.map((o) => r.counts[o] || 0)).concat([r.total])),
      },
      { name: 'Team activity', headers: teamHeaders, rows: teamRows || [] },
    ];
  }

  function weeklySheets(rows, cols, headerText) {
    return [{ name: 'Weekly summary', headers: cols.map(headerText), rows: (rows || []).map((r) => cols.map((k) => r[k])) }];
  }

  // d: admin_script_report; ins: admin_loss_insights (either may be missing).
  function lostSheets(d, ins) {
    const share = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 10);
    const a = d || {};
    const b = ins || {};
    return [
      { name: 'Where calls ended', headers: ['Step', 'Calls', 'Share (%)'],
        rows: (a.steps || []).map((r) => [r.step || '(no end card logged)', r.calls, share(r.share)]),
        notes: [(a.script_name || 'Script') + ' v' + (a.version || '') + ', ' + plural(Number(a.total_calls) || 0, 'call', 'calls') + '.'] },
      { name: 'Objections', headers: ['Objection', 'Calls'], rows: (a.objections || []).map((r) => [r.objection, r.calls]) },
      { name: 'Outcomes', headers: ['Outcome', 'Calls'], rows: (a.outcomes || []).map((r) => [String(r.outcome).replace(/_/g, ' '), r.calls]) },
      { name: 'Lost calls by reason', headers: ['Reason', 'Calls'], rows: (b.reasons || []).map((r) => [reasonLabel(r.reason), r.calls]) },
      { name: 'Lost calls by stage', headers: ['Stage', 'Calls'], rows: (b.stages || []).map((r) => [r.stage === 'not_recorded' ? '(not recorded)' : r.stage, r.calls]) },
      { name: 'Suggested changes', headers: ['Suggestion', 'Decision'],
        rows: (b.suggestions || []).map((s) => [s.text, s.decision ? String(s.decision).replace(/_/g, ' ') : 'Not decided']) },
    ];
  }

  const helpers = {
    REPORTS, DEFAULT_REPORT, DATE_PRESETS, PROMISE_DAYS, presetRange, promiseStatus, dueForSendBack, studentClass,
    funnelSteps, biggestDrop, funnelNotes, feesCards, feesSheets, funnelSheets, resultsSheets, weeklySheets, lostSheets,
    MODES, modeLabel, ledgerStatus, ledgerCards, modeSplit, dayRows, isAccountsSeat, reportsFor,
  };
  if (inNode) { module.exports = helpers; return; }

  // ---------- the page (browser only) ----------

  const A = window.VectorAdminHelpers;
  const T = window.VectorAdminTeamHelpers;
  const M = window.ScriptModel;
  const X = window.VectorExcel;
  const C = window.VectorCharts;
  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const PICK_KEY = 'vector-admin-report';

  let ctx = null;
  let picked = DEFAULT_REPORT;
  let accounts = false;       // an Accounts seat: Fees collection only, from the ledger
  let scriptsAllowed = true;  // the Scripts add-on (my_features); a database without it allows everything
  let outcomes = [];
  let weeklyRows = [];
  let scripts = [];           // { id, name }
  let versions = [];          // { id, version, published } of the picked script
  let fees = null;            // { rep, promises, from, to } of the last Fees load
  let funnel = null;          // { data, from, to } of the last funnel load
  let lost = null;            // { report, insights, version } of the last script report
  let seq = { results: 0, week: 0, script: 0, fees: 0, funnel: 0 };

  const cell = (text, cls, label) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || '', 'data-label': label || null });
  const field = (text, input) => el('label', null, [text + ' ', input]);
  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const pretty = (s) => String(s).replace(/_/g, ' ');
  const pct = (share) => (share == null ? '' : (Math.round(Number(share) * 1000) / 10) + '%');
  const stageLabel = (s) => (s === 'not_recorded' ? '(not recorded)' : s);
  const storage = {
    get() { try { return localStorage.getItem(PICK_KEY); } catch (err) { return null; } },
    set(v) { try { localStorage.setItem(PICK_KEY, v); } catch (err) { /* only a convenience */ } },
  };

  async function rpc(name, args) {
    try { return await ctx.rpc(name, args); } catch (err) {
      if (ctx.isMissing(err)) throw new Error(T.NOT_YET);
      throw err;
    }
  }
  function report(id, err, prefix) {
    if (err && err.message === T.NOT_YET) say(id, 'This report is not available yet. Ask your Vector contact to update the database.', false);
    else say(id, (prefix || '') + (err && err.message ? err.message : 'Try again.'), true);
  }
  const firstRow = (data) => (Array.isArray(data) ? data[0] : data) || {};

  // ---------- page ----------

  function build(box) {
    box.appendChild(el('div', { className: 'tab-head' }, [
      el('h1', { text: 'Reports' }),
      el('p', { className: 'muted', text: 'Results of your calls. Download them to open in Excel.' }),
    ]));

    const presets = el('select', { id: 'rp-dates' }, DATE_PRESETS.map((p) => el('option', { value: p.id, text: p.label })));
    box.appendChild(el('div', { className: 'panel filters' }, [
      el('form', { id: 'rp-filters', className: 'row' }, [
        field('Dates', presets),
        field('From', el('input', { id: 'rp-from', type: 'date', required: true })),
        field('To', el('input', { id: 'rp-to', type: 'date', required: true })),
        field('Campaign', el('select', { id: 'rp-campaign' }, [el('option', { value: '', text: 'All campaigns' })])),
        field('Caller', el('select', { id: 'rp-caller' }, [el('option', { value: '', text: 'All callers' })])),
        el('button', { type: 'submit', text: 'Show' }),
        el('button', { type: 'button', id: 'rp-excel', text: 'Download Excel' }),
      ]),
      msg('rp-msg'),
    ]));

    box.appendChild(el('div', { className: 'picker', role: 'group', 'aria-label': 'Pick a report', hidden: accounts },
      reportsFor(ctx.seat).map((r) => el('button', { type: 'button', id: 'rp-pick-' + r.id, 'data-report': r.id, 'aria-pressed': 'false', text: r.label }))));

    // Fees collection
    box.appendChild(el('div', { className: 'panel report', id: 'rp-fees', 'data-report': 'fees' }, [
      el('h2', { text: 'Fees collection' }),
      el('p', { id: 'fees-source', className: 'muted small', text: 'Fees campaigns. Paid counts calls in the dates you picked; due and promised are as of now.' }),
      msg('fees-msg'),
      el('div', { className: 'cards', id: 'fees-cards' }),
      el('p', { id: 'fees-money-note', className: 'muted small', hidden: true, text: 'Amounts are hidden for you, so you see counts only.' }),
      el('p', { id: 'fees-seat-note', className: 'muted small', hidden: true, text: 'Due and collected are for every caller. The caller filter applies to promises.' }),
      el('div', { className: 'subpanel', id: 'fees-ledger', hidden: true }, [
        el('h3', { id: 'fees-modes-title', text: 'Collected, by how parents paid' }),
        el('ul', { id: 'fees-modes', className: 'plain fees-modes', 'aria-labelledby': 'fees-modes-title' }),
        el('p', { id: 'fees-modes-empty', className: 'muted', hidden: true, text: 'No payments in the fee ledger in these dates.' }),
        el('p', { id: 'fees-reported', className: 'fees-reported small' }),
        el('h3', { text: 'Collected by day' }),
        el('div', { id: 'fees-days' }),
      ]),
      el('div', { className: 'subpanel' }, [
        el('div', { className: 'row between' }, [
          el('h3', { text: 'Promises due this week' }),
          el('button', { type: 'button', id: 'fees-send', text: 'Send these back to callers' }),
        ]),
        el('p', { id: 'promise-note', className: 'muted small', text: 'Promises due today or late go to the top of their callers\' lists.' }),
        el('div', { className: 'scroll' }, [el('table', { className: 'stack', id: 'promise-table' }, [
          el('thead', null, [el('tr', { id: 'promise-head' })]),
          el('tbody', { id: 'promise-body' }),
        ])]),
        el('p', { id: 'promise-empty', className: 'muted', hidden: true, text: 'No promises due this week.' }),
      ]),
    ]));

    // Sales funnel
    box.appendChild(el('div', { className: 'panel report', id: 'rp-funnel', 'data-report': 'funnel', hidden: true }, [
      el('h2', { text: 'Sales funnel: from call to joining' }),
      el('p', { className: 'muted small', text: 'Sales campaigns and calls made before campaigns. Each call counts once.' }),
      msg('funnel-msg'),
      el('ol', { className: 'funnel', id: 'funnel-list' }),
      el('div', { id: 'funnel-notes', className: 'notes' }),
    ]));

    // Results by outcome (kept from the old admin page)
    box.appendChild(el('div', { className: 'panel report', id: 'results', 'data-report': 'results', hidden: true }, [
      el('div', { className: 'row between' }, [
        el('h2', { text: 'Results by outcome' }),
        el('button', { type: 'button', id: 'csv', text: 'Download team activity (CSV)' }),
      ]),
      el('p', { id: 'results-note', className: 'muted small', hidden: true, text: 'This report counts calls of every campaign.' }),
      msg('results-msg'),
      el('div', { className: 'scroll' }, [el('table', null, [
        el('thead', null, [el('tr', { id: 'outcome-head' })]),
        el('tbody', { id: 'outcome-body' }),
      ])]),
      el('p', { id: 'outcome-empty', className: 'muted', hidden: true, text: 'No outcomes in this range.' }),
    ]));

    // Why calls are lost (script results, kept from the script editor)
    box.appendChild(el('div', { className: 'panel report', id: 'script-results', 'data-report': 'lost', hidden: true }, [
      el('h2', { text: 'Why calls are lost' }),
      el('p', { className: 'muted', text: 'Where calls ended for one version of a script, and why calls were lost.' }),
      el('p', { id: 'lost-locked', className: 'locked', hidden: true, text: 'This report needs the Scripts add-on. Add Scripts to use this.' }),
      el('form', { id: 'sr-form', className: 'row wrap' }, [
        field('Script', el('select', { id: 'sr-script' })),
        field('Version', el('select', { id: 'sr-version' })),
        el('button', { type: 'submit', text: 'Run report' }),
      ]),
      msg('sr-msg'),
      el('div', { id: 'report-out' }),
      el('div', { id: 'insights-out', className: 'insights', 'aria-live': 'polite' }),
    ]));

    // Weekly summary (its own week; every campaign and caller)
    box.appendChild(el('div', { className: 'panel report', id: 'weekly', 'data-report': 'weekly', hidden: true }, [
      el('div', { className: 'row between' }, [
        el('h2', { text: 'Weekly summary' }),
        el('button', { type: 'button', id: 'week-csv', text: 'Download CSV' }),
      ]),
      el('p', { className: 'muted small', text: 'One week, every campaign and caller.' }),
      el('form', { id: 'week-form', className: 'row' }, [
        field('Week starting (Monday)', el('input', { id: 'week-start', type: 'date', required: true })),
        el('button', { type: 'submit', text: 'Show week' }),
      ]),
      msg('week-msg'),
      el('div', { className: 'scroll' }, [el('table', { className: 'stack', id: 'week-table', hidden: true }, [
        el('thead', { id: 'week-head' }),
        el('tbody', { id: 'week-body' }),
      ])]),
      el('p', { id: 'week-empty', className: 'muted', hidden: true, text: 'No activity in this week.' }),
    ]));
  }

  function wire() {
    $('rp-filters').addEventListener('submit', (e) => { e.preventDefault(); loadPicked(); });
    $('rp-dates').addEventListener('change', () => {
      const r = presetRange($('rp-dates').value, new Date());
      if (!r) { $('rp-from').focus(); return; }
      $('rp-from').value = r.from;
      $('rp-to').value = r.to;
      loadPicked();
    });
    const toCustom = () => { $('rp-dates').value = 'custom'; };
    $('rp-from').addEventListener('change', toCustom);
    $('rp-to').addEventListener('change', toCustom);
    $('rp-campaign').addEventListener('change', loadPicked);
    $('rp-caller').addEventListener('change', loadPicked);
    $('rp-excel').addEventListener('click', downloadExcel);
    document.querySelectorAll('.tab-reports .picker button').forEach((b) => {
      b.addEventListener('click', () => pick(b.getAttribute('data-report'), true));
    });
    $('fees-send').addEventListener('click', sendBack);
    $('csv').addEventListener('click', downloadTeamCsv);
    $('week-form').addEventListener('submit', (e) => { e.preventDefault(); loadWeek(); });
    $('week-start').addEventListener('change', snapWeek);
    $('week-csv').addEventListener('click', downloadWeekCsv);
    $('sr-script').addEventListener('change', () => pickScript($('sr-script').value));
    $('sr-form').addEventListener('submit', (e) => { e.preventDefault(); runScriptReport(); });
  }

  // Shows one report and loads it. A click remembers the choice for next time (this browser only).
  function pick(id, byUser) {
    if (!reportsFor(ctx && ctx.seat).some((r) => r.id === id)) id = DEFAULT_REPORT;
    picked = id;
    if (byUser) storage.set(id);
    document.querySelectorAll('.tab-reports .picker button').forEach((b) => {
      b.setAttribute('aria-pressed', b.getAttribute('data-report') === id ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-reports .panel.report').forEach((p) => { p.hidden = p.getAttribute('data-report') !== id; });
    say('rp-msg', '');
    loadPicked();
  }

  function loadPicked() {
    if (!ctx) return;
    if (picked === 'fees') loadFees();
    else if (picked === 'funnel') loadFunnel();
    else if (picked === 'results') loadResults();
    else if (picked === 'weekly') { if (!weeklyRows.length) loadWeek(); }
    else if (picked === 'lost' && scriptsAllowed && $('sr-version').value && lost) runScriptReport();
  }

  // The filter bar as RPC arguments, or null (with a message) when the dates are wrong.
  function filters() {
    let r;
    try { r = A.rangeToTimestamps($('rp-from').value, $('rp-to').value); } catch (err) {
      say('rp-msg', err.message, true);
      return null;
    }
    say('rp-msg', '');
    return {
      from: r.from, to: r.to, fromDay: $('rp-from').value, toDay: $('rp-to').value,
      campaign: $('rp-campaign').value || null, seat: $('rp-caller').value || null,
    };
  }
  const rangeText = (f) => S.formatDate(f.fromDay) + ' to ' + S.formatDate(f.toDay);

  // Campaign and caller lists for the filters (owners and managers). A failure leaves "All" only and says so.
  // Accounts seats are not callers, so they are not in the caller list.
  async function loadFilterLists() {
    const mine = ctx;
    let failed = false;
    const [camps, seats] = await Promise.all([
      ctx.client.from('campaigns').select('id, name, status').order('name')
        .then((r) => { if (r.error) { failed = true; return []; } return r.data || []; }, () => { failed = true; return []; }),
      ctx.rpc('admin_seat_list', { p_institute: ctx.institute.id }).then((d) => d || [], () => { failed = true; return []; }),
    ]);
    if (ctx !== mine) return;
    if (failed) say('rp-msg', 'Could not load the campaign and caller lists, so the filters show "All" only. Reload to try again.', true);
    const fill = (sel, first, items) => {
      const keep = sel.value;
      sel.textContent = '';
      sel.appendChild(el('option', { value: '', text: first }));
      items.forEach((i) => sel.appendChild(el('option', { value: i.id, text: i.text })));
      if (keep && items.some((i) => i.id === keep)) sel.value = keep;
    };
    fill($('rp-campaign'), 'All campaigns', camps.map((c) => ({
      id: c.id, text: c.name + (c.status === 'draft' ? ' (draft)' : c.status === 'closed' ? ' (closed)' : ''),
    })));
    fill($('rp-caller'), 'All callers', seats
      .filter((s) => s.status !== 'invited' && s.role !== 'accounts' && s.access_role !== 'accounts')
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      .map((s) => ({ id: s.seat_id, text: (s.label || 'No name') + (s.status === 'revoked' ? ' (removed)' : '') })));
  }

  // Whether the Scripts add-on is on (trial = everything). A database without my_features allows it.
  async function loadFeatures() {
    try {
      const f = await ctx.rpc('my_features');
      scriptsAllowed = !Array.isArray(f) || f.includes('scripts');
    } catch (err) {
      scriptsAllowed = true;
    }
    $('lost-locked').hidden = scriptsAllowed;
    $('sr-form').hidden = !scriptsAllowed;
  }

  // ---------- Fees collection ----------

  // Asks a ledger function; null when the database does not have it yet (then the page shows what callers reported).
  async function ledgerRpc(name, args) {
    try { return await ctx.rpc(name, args); } catch (err) {
      if (ctx.isMissing(err)) return null;
      throw err;
    }
  }

  // Due and collected come from the fee ledger (admin_fees_ledger) when the database has it and the institute
  // has students; promises then carry what the ledger shows (admin_promises_ledger). Otherwise the report is
  // what callers reported (admin_fees_report, admin_promises_due). "Paid after a call" is always loaded and shown
  // apart, labelled "reported by caller".
  async function loadFees() {
    const f = filters();
    if (!f) return;
    const n = ++seq.fees;
    say('fees-msg', 'Loading...');
    const id = ctx.institute.id;
    try {
      const [rep, led] = await Promise.all([
        accounts ? Promise.resolve(null)
          : rpc('admin_fees_report', { p_institute: id, p_from: f.from, p_to: f.to, p_campaign: f.campaign, p_seat: f.seat, p_tz: ctx.tz }),
        ledgerRpc('admin_fees_ledger', { p_institute: id, p_from: f.fromDay, p_to: f.toDay, p_campaign: f.campaign, p_seat: f.seat }),
      ]);
      if (n !== seq.fees) return;
      const useLedger = !!(led && led.has_ledger);
      let promises = useLedger
        ? await ledgerRpc('admin_promises_ledger', { p_institute: id, p_campaign: f.campaign, p_seat: f.seat, p_days: PROMISE_DAYS })
        : null;
      if (accounts && !useLedger) throw new Error(led ? 'The fee ledger has no students yet. Import students and fees on the Fees tab.' : T.NOT_YET);
      if (!promises) promises = await rpc('admin_promises_due', { p_institute: id, p_campaign: f.campaign, p_seat: f.seat, p_tz: ctx.tz, p_days: PROMISE_DAYS });
      if (n !== seq.fees) return;
      fees = { rep: rep ? firstRow(rep) : null, led: useLedger ? led : null, promises: promises || [], from: f.fromDay, to: f.toDay, seat: f.seat };
      renderFees();
      say('fees-msg', (useLedger ? 'Collected and paid after a call: ' : 'Paid after a call: ') + rangeText(f) + '.');
    } catch (err) {
      if (n !== seq.fees) return;
      fees = null;
      renderFees();
      report('fees-msg', err, 'Could not load: ');
    }
  }

  // ₹ only when this admin may see money and the server sent it.
  const feesMoney = () => !!(ctx && ctx.canSeeMoney && fees &&
    (fees.led ? fees.led.money_hidden === false : fees.rep && fees.rep.money_hidden === false));

  function renderCards(list) {
    const cards = $('fees-cards');
    list.forEach((c) => cards.appendChild(el('div', { className: 'card' + (c.level ? ' ' + c.level : '') }, [
      el('div', { className: 'card-label', text: c.label }),
      el('div', { className: 'card-value', text: c.value }),
      el('div', { className: 'card-sub', text: c.sub }),
    ])));
  }

  // The ledger part: collected by mode, what callers reported (kept apart) and the chart of collections by day.
  function renderLedger(money) {
    const led = fees.led;
    const col = led.collected || {};
    const modes = modeSplit(col.by_mode, money);
    const list = $('fees-modes');
    modes.forEach((m) => list.appendChild(el('li', { 'data-mode': m.mode }, [
      el('span', { className: 'mode-label', text: m.label }),
      el('span', { className: 'mode-value', text: m.text }),
      money ? el('span', { className: 'mode-count', text: plural(S.count(m.payments), 'payment', 'payments') }) : null,
    ])));
    $('fees-modes-empty').hidden = modes.length > 0;
    $('fees-reported').hidden = !fees.rep;
    const r = fees.rep || {};
    const calls = Number(r.paid_calls) || 0;
    const amt = money && r.paid_amount !== null && r.paid_amount !== undefined ? ' (' + S.rupees(r.paid_amount) + ')' : '';
    $('fees-reported').textContent = 'Callers marked ' + plural(S.count(calls), 'call', 'calls') + ' as paid in these dates' + amt +
      ', ' + S.REPORTED_BY_CALLER + '. This is not added to Collected.';
    const box = $('fees-days');
    const days = dayRows(col.by_day, led.from || fees.from, led.to || fees.to);
    if (!days.length) { box.appendChild(el('p', { className: 'muted', text: 'No payments to show.' })); return; }
    const value = (d) => (money ? Number(d.amount) || 0 : d.payments);
    const text = (d) => (money ? S.rupees(Number(d.amount) || 0) : S.count(d.payments));
    box.appendChild(C.barChart({
      label: 'Collected by day, from the fee ledger',
      rows: days.map((d) => ({ label: S.formatDate(d.day, { year: false }), value: value(d), text: text(d),
        tip: [text(d), S.formatDate(d.day) + ': ' + plural(S.count(d.payments), 'payment', 'payments')] })),
      table: { caption: 'Collected by day (fee ledger)', head: ['Day', 'Payments'].concat(money ? ['Amount'] : []), num: [1, 2],
        rows: days.map((d) => [S.formatDate(d.day), S.count(d.payments)].concat(money ? [S.rupees(Number(d.amount) || 0)] : [])) },
    }));
  }

  function renderFees() {
    const cards = $('fees-cards');
    const head = $('promise-head');
    const body = $('promise-body');
    cards.textContent = '';
    head.textContent = '';
    body.textContent = '';
    $('fees-modes').textContent = '';
    $('fees-days').textContent = '';
    const ledger = !!(fees && fees.led);
    $('fees-ledger').hidden = !ledger;
    $('fees-seat-note').hidden = !ledger || !fees.seat;
    $('fees-money-note').hidden = !fees || feesMoney();
    $('promise-empty').hidden = !fees || fees.promises.length > 0;
    $('fees-send').disabled = !fees || dueForSendBack(fees.promises).length === 0;
    $('fees-send').hidden = accounts;   // sending leads back to callers is for owners and managers
    $('fees-source').textContent = ledger
      ? 'Due and collected come from the fee ledger. Promises come from calls and are checked against the ledger.'
      : 'Fees campaigns. Paid counts calls in the dates you picked; due and promised are as of now.' +
        (fees ? ' There is no fee ledger yet, so paid amounts are ' + S.REPORTED_BY_CALLER + '.' : '');
    $('promise-note').textContent = 'Promises due today or late, and not paid' + (ledger ? ' in the ledger' : '') +
      ', go to the top of their callers\' lists.';
    if (!fees) return;
    const money = feesMoney();
    renderCards(ledger ? ledgerCards(fees.led, money) : feesCards(fees.rep, money));
    if (ledger) renderLedger(money);
    const cols = ['Parent', 'Student'].concat(money ? ['Amount'] : []).concat(['Promised for', 'Caller', 'Status'])
      .concat(ledger ? ['Fee ledger'] : []);
    cols.forEach((c) => head.appendChild(el('th', { text: c, className: c === 'Amount' ? 'num' : '' })));
    fees.promises.forEach((p) => {
      const closed = p.ledger_state === 'paid' || p.lead_status === 'done';
      const st = closed ? { text: 'Done', level: 'later' } : promiseStatus(p.days_late);
      const cells = [cell(p.name, '', 'Parent'), cell(studentClass(p.extra), '', 'Student')];
      if (money) cells.push(cell(S.rupees(p.amount), 'num', 'Amount'));
      cells.push(cell(S.formatDate(p.promised_date, { year: false }), '', 'Promised for'));
      cells.push(cell(p.caller || 'Not assigned', '', 'Caller'));
      cells.push(cell(st.text, 'status ' + st.level, 'Status'));
      if (ledger) {
        const lg = ledgerStatus(p, money);
        cells.push(cell(lg.text, 'status ledger-' + (lg.level || 'none'), 'Fee ledger'));
      }
      body.appendChild(el('tr', { 'data-ledger': ledger ? p.ledger_state || '' : null }, cells));
    });
  }

  // "Send these back to callers": promises due today or late come up first in their callers' lists.
  function sendBack() {
    const ids = fees ? dueForSendBack(fees.promises) : [];
    if (!ids.length) { say('fees-msg', 'No promises are due today or late.', false); return; }
    ctx.confirm({
      title: 'Send these back to callers?',
      text: plural(ids.length, 'parent', 'parents') + ' with a promise due today or late will be at the top of their callers\' lists now.',
      button: 'Send back',
      run: async () => ({ changed: await ctx.rpc('admin_send_back_leads', { p_institute: ctx.institute.id, p_leads: ids }) }),
      done: (out) => plural(Number(out.changed) || 0, 'parent', 'parents') + ' sent back to callers.',
      reload: loadFees,
    });
  }

  // ---------- Sales funnel ----------

  async function loadFunnel() {
    const f = filters();
    if (!f) return;
    const n = ++seq.funnel;
    say('funnel-msg', 'Loading...');
    try {
      const data = await rpc('admin_sales_funnel', { p_institute: ctx.institute.id, p_from: f.from, p_to: f.to, p_campaign: f.campaign, p_seat: f.seat });
      if (n !== seq.funnel) return;
      funnel = { data: firstRow(data), from: f.fromDay, to: f.toDay };
      renderFunnel();
      say('funnel-msg', 'Showing ' + rangeText(f) + '.');
    } catch (err) {
      if (n !== seq.funnel) return;
      funnel = null;
      renderFunnel();
      report('funnel-msg', err, 'Could not load: ');
    }
  }

  function renderFunnel() {
    const list = $('funnel-list');
    const notes = $('funnel-notes');
    list.textContent = '';
    notes.textContent = '';
    if (!funnel) return;
    const steps = funnelSteps(funnel.data);
    steps.forEach((s, i) => {
      const fill = el('div', { className: 'fill' + (i === steps.length - 1 ? ' last' : '') });
      fill.style.width = s.percent + '%';
      list.appendChild(el('li', null, [
        el('span', { className: 'f-label', text: s.label }),
        el('div', { className: 'f-bar', 'aria-hidden': 'true' }, [fill]),
        el('span', { className: 'f-num', text: S.count(s.count) + (i ? ' (' + s.percent + '%)' : '') }),
      ]));
    });
    funnelNotes(funnel.data).forEach((line) => notes.appendChild(el('p', { text: line })));
  }

  // ---------- results by outcome and the team activity CSV ----------

  async function loadResults() {
    const f = filters();
    if (!f) return;
    const n = ++seq.results;
    $('results-note').hidden = !f.campaign;
    say('results-msg', 'Loading...');
    try {
      const o = await ctx.rpc('admin_results_by_outcome', { p_institute: ctx.institute.id, p_from: f.from, p_to: f.to });
      if (n !== seq.results) return;
      outcomes = (o || []).filter((r) => !f.seat || r.seat_id === f.seat);
      renderOutcomes();
      say('results-msg', 'Showing ' + rangeText(f) + '.');
    } catch (err) {
      if (n === seq.results) say('results-msg', 'Could not load: ' + err.message, true);
    }
  }

  function renderOutcomes() {
    const head = $('outcome-head');
    const body = $('outcome-body');
    head.textContent = '';
    body.textContent = '';
    head.appendChild(el('th', { text: 'Rep' }));
    A.OUTCOMES.forEach((o) => head.appendChild(el('th', { text: o.replace(/_/g, ' '), className: 'num' })));
    head.appendChild(el('th', { text: 'Total', className: 'num' }));
    const reps = A.pivotOutcomes(outcomes);
    $('outcome-empty').hidden = reps.length > 0;
    reps.forEach((rep) => {
      const cells = [cell(rep.label)];
      A.OUTCOMES.forEach((o) => cells.push(cell(rep.counts[o] || 0, 'num')));
      cells.push(cell(rep.total, 'num'));
      body.appendChild(el('tr', null, cells));
    });
  }

  // Team activity of the chosen dates (and caller), one row per rep and day.
  async function teamRows(f) {
    const team = (await ctx.rpc('admin_team_activity', { p_institute: ctx.institute.id, p_from: f.from, p_to: f.to, p_tz: ctx.tz })) || [];
    return team.filter((r) => !f.seat || r.seat_id === f.seat);
  }

  async function downloadTeamCsv() {
    const f = filters();
    if (!f) return;
    const btn = $('csv');
    btn.disabled = true;
    try {
      const team = await teamRows(f);
      if (!team.length) { say('results-msg', 'No calls in this range, so nothing to download.', true); return; }
      S.download(A.toCsv(A.TEAM_HEADERS, A.teamCsvRows(team)), 'vector-team-activity-' + f.fromDay + '-to-' + f.toDay + '.csv');
    } catch (err) {
      say('results-msg', 'Could not download: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- weekly summary ----------

  function snapWeek() {
    const start = T.weekStart($('week-start').value);
    if (start) $('week-start').value = start;
    return start;
  }

  async function loadWeek() {
    const start = snapWeek();
    if (!start) { say('week-msg', 'Pick a date in the week you want.', true); return; }
    const n = ++seq.week;
    say('week-msg', 'Loading...');
    try {
      const rows = (await rpc('admin_weekly_summary', { p_institute: ctx.institute.id, p_week_start: start, p_tz: ctx.tz })) || [];
      if (n !== seq.week) return;
      weeklyRows = rows;
      renderWeek();
      say('week-msg', 'Week starting Monday ' + S.formatDate(start) + ', days in ' + ctx.tz + '.');
    } catch (err) {
      if (n !== seq.week) return;
      weeklyRows = [];
      renderWeek();
      report('week-msg', err, 'Could not load: ');
    }
  }

  function renderWeek() {
    const head = $('week-head');
    const body = $('week-body');
    head.textContent = '';
    body.textContent = '';
    const cols = T.summaryColumns(weeklyRows);
    $('week-table').hidden = cols.length === 0;
    $('week-empty').hidden = weeklyRows.length > 0;
    head.appendChild(el('tr', null, cols.map((k) => el('th', {
      text: T.headerText(k),
      className: typeof weeklyRows[0][k] === 'number' ? 'num' : '',
    }))));
    weeklyRows.forEach((r) => {
      body.appendChild(el('tr', null, cols.map((k) => cell(r[k], typeof r[k] === 'number' ? 'num' : '', T.headerText(k)))));
    });
  }

  function downloadWeekCsv() {
    if (!weeklyRows.length) { say('week-msg', 'No activity in this week, so nothing to download.', true); return; }
    const cols = T.summaryColumns(weeklyRows);
    const csv = T.toCsv(cols.map(T.headerText), weeklyRows.map((r) => cols.map((k) => r[k])));
    S.download(csv, 'vector-weekly-summary-' + $('week-start').value + '.csv');
  }

  // ---------- why calls are lost: script results for one version ----------

  async function loadScripts() {
    const { data, error } = await ctx.client.from('scripts').select('id, name').order('name');
    if (error) { say('sr-msg', 'Could not load scripts: ' + error.message, true); return; }
    scripts = data || [];
    const sel = $('sr-script');
    const keep = sel.value;
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: scripts.length ? 'Pick a script' : 'No scripts yet' }));
    scripts.forEach((s) => sel.appendChild(el('option', { value: s.id, text: s.name })));
    if (keep && scripts.some((s) => s.id === keep)) sel.value = keep;
  }

  // Fills the version list of one script; the published version is picked unless wantVersion names another.
  async function pickScript(scriptId, wantVersion) {
    const n = ++seq.script;
    versions = [];
    lost = null;
    const sel = $('sr-version');
    sel.textContent = '';
    $('report-out').textContent = '';
    $('insights-out').textContent = '';
    if (!scriptId) return;
    const { data, error } = await ctx.client.from('script_versions')
      .select('id, version, published')
      .eq('script_id', scriptId)
      .order('version', { ascending: false });
    if (n !== seq.script) return;
    if (error) { say('sr-msg', 'Could not load versions: ' + error.message, true); return; }
    versions = data || [];
    versions.forEach((v) => sel.appendChild(el('option', {
      value: v.id, text: 'v' + v.version + (v.published ? ' (published)' : ' (draft)'),
    })));
    const p = versions.find((v) => v.id === wantVersion) || versions.find((v) => v.published) || versions[0];
    if (p) sel.value = p.id;
    say('sr-msg', '');
  }

  async function runScriptReport() {
    if (!scriptsAllowed) return;
    const v = versions.find((x) => x.id === $('sr-version').value);
    if (!v) { say('sr-msg', 'Pick a script and a version.', true); return; }
    let r;
    try {
      r = M.reportRange($('rp-from').value, $('rp-to').value);
    } catch (err) { say('sr-msg', err.message, true); return; }

    say('sr-msg', 'Loading...');
    $('report-out').textContent = '';
    $('insights-out').textContent = '';
    let data;
    try {
      data = await ctx.rpc('admin_script_report', {
        p_institute: ctx.institute.id, p_script_version_id: v.id, p_from: r.from, p_to: r.to,
      });
    } catch (err) { say('sr-msg', 'Could not load the report: ' + err.message, true); return; }
    say('sr-msg', 'Showing v' + v.version + ', ' + S.formatDate($('rp-from').value) + ' to ' + S.formatDate($('rp-to').value) + '.');
    lost = { report: data || {}, insights: null, version: v };
    renderScriptReport(data || {});
    loadInsights(v, r);
  }

  function renderScriptReport(d) {
    const out = $('report-out');
    out.textContent = '';
    const total = Number(d.total_calls) || 0;
    out.appendChild(el('p', {
      text: total + (total === 1 ? ' call' : ' calls') + ' for ' + (d.script_name || 'this script') + ' v' + d.version + ' in the range.',
    }));
    if (!total) return;
    out.appendChild(reportTable('Where calls ended', ['Step', 'Calls', 'Share'],
      (d.steps || []).map((r) => [r.step || '(no end card logged)', r.calls, pct(r.share)])));
    out.appendChild(reportTable('Objections raised', ['Objection', 'Calls'],
      (d.objections || []).map((r) => [r.objection, r.calls])));
    out.appendChild(reportTable('Outcomes', ['Outcome', 'Calls'],
      (d.outcomes || []).map((r) => [pretty(r.outcome), r.calls])));
  }

  async function loadInsights(v, r) {
    const out = $('insights-out');
    out.textContent = '';
    let data;
    try {
      data = await ctx.rpc('admin_loss_insights', {
        p_institute: ctx.institute.id, p_script_version_id: v.id, p_from: r.from, p_to: r.to,
      });
    } catch (err) {
      out.appendChild(el('p', { className: 'msg', text: 'Could not load insights: ' + err.message }));
      return;
    }
    if (lost && lost.version === v) lost.insights = data || {};
    renderInsights(data || {}, v, r);
  }

  function renderInsights(d, v, r) {
    const out = $('insights-out');
    out.textContent = '';
    out.appendChild(el('h3', { text: 'What went wrong on lost calls' }));
    if (!d.calls) { out.appendChild(el('p', { className: 'muted', text: 'No calls for this version in the range.' })); return; }
    const rate = d.lost_rate == null ? '' : ' (' + pct(d.lost_rate) + ')';
    let line = d.lost + ' of ' + d.calls + ' calls lost' + rate + ' on v' + d.version + '.';
    if (d.previous_version != null && d.previous_calls) {
      line += ' v' + d.previous_version + ' lost ' + pct(d.previous_lost_rate) + ' of ' + d.previous_calls + ' calls.';
    }
    out.appendChild(el('p', { text: line }));
    if (!d.enough_calls) out.appendChild(el('p', { className: 'muted', text: 'Suggestions appear after 10 calls on this version.' }));
    out.appendChild(reportTable('Lost calls by reason', ['Reason', 'Calls'],
      (d.reasons || []).map((x) => [reasonLabel(x.reason), x.calls])));
    out.appendChild(reportTable('Where lost calls ended', ['Stage', 'Calls'],
      (d.stages || []).map((x) => [stageLabel(x.stage), x.calls])));
    out.appendChild(reportTable('Objections on lost calls', ['Objection', 'Calls'],
      (d.objections || []).map((x) => [x.objection, x.calls])));

    const block = el('div', { className: 'report-block' }, [el('h3', { text: 'Suggested changes' })]);
    const sugg = d.suggestions || [];
    if (!sugg.length) block.appendChild(el('p', { className: 'muted', text: 'No single change stands out yet.' }));
    sugg.forEach((s) => {
      const row = el('div', { className: 'suggestion' }, [el('p', { text: s.text })]);
      if (s.decision) {
        const when = s.decided_at ? ' on ' + S.formatDate(s.decided_at) : '';
        row.appendChild(el('p', { className: 'muted', text: pretty(s.decision) + when + '. Change the script in the Scripts tab, then publish a new version.' }));
      }
      const approve = el('button', { type: 'button', text: s.decision === 'approved' ? 'Approved' : 'Approve' });
      const reject = el('button', { type: 'button', text: s.decision === 'rejected' ? 'Rejected' : 'Reject' });
      approve.addEventListener('click', () => decideSuggestion(v, s.key, 'approved', r, s.text));
      reject.addEventListener('click', () => decideSuggestion(v, s.key, 'rejected', r, s.text));
      row.appendChild(el('div', { className: 'suggestion-actions' }, [approve, reject]));
      block.appendChild(row);
    });
    out.appendChild(block);
  }

  async function decideSuggestion(v, key, decision, r, note) {
    try {
      await ctx.rpc('admin_decide_suggestion', {
        p_institute: ctx.institute.id, p_script_version_id: v.id, p_target_key: key, p_decision: decision, p_note: note,
      });
    } catch (err) { say('sr-msg', 'Could not save the decision: ' + err.message, true); return; }
    loadInsights(v, r);
  }

  function reportTable(caption, headers, rows) {
    const block = el('div', { className: 'scroll report-block' }, [el('h4', { text: caption })]);
    block.appendChild(el('table', null, [
      el('thead', null, [el('tr', null, headers.map((h, i) => el('th', { text: h, className: i ? 'num' : '' })))]),
      el('tbody', null, rows.map((r) => el('tr', null, r.map((c, i) => cell(c, i ? 'num' : ''))))),
    ]));
    if (!rows.length) block.appendChild(el('p', { className: 'muted', text: 'None.' }));
    return block;
  }

  // A link such as #reports?script=…&version=… (from the Scripts tab) picks that version and runs its report.
  async function openFromLink(params) {
    if (!params.script) return;
    if (!scripts.some((s) => s.id === params.script)) await loadScripts();
    if (!scripts.some((s) => s.id === params.script)) { say('sr-msg', 'That script is not in this institute.', true); return; }
    $('sr-script').value = params.script;
    await pickScript(params.script, params.version);
    $('script-results').scrollIntoView({ block: 'start' });
    if ($('sr-version').value) runScriptReport();
  }

  // ---------- Excel ----------

  // The open report as a workbook. Money columns only when this admin may see money, and only after the export
  // is written to the audit log; if that fails the file is made without them.
  async function downloadExcel() {
    const f = filters();
    if (!f) return;
    const btn = $('rp-excel');
    btn.disabled = true;
    say('rp-msg', 'Preparing the Excel file...');
    try {
      let sheets;
      let name;
      let note = '';
      if (picked === 'fees') {
        if (!fees) throw new Error('Show the report first, then download it.');
        let money = feesMoney();
        const col = fees.led ? fees.led.collected || {} : {};
        const sheetRows = fees.led ? 5 + modeSplit(col.by_mode, true).length +
          dayRows(col.by_day, fees.led.from, fees.led.to).filter((d) => d.payments > 0).length : 4;
        if (money) {
          try {
            await ctx.rpc('log_money_export', { p_institute: ctx.institute.id, p_what: 'fees_report', p_rows: fees.promises.length + sheetRows });
          } catch (err) {
            money = false;
            note = ' The file has no ₹ columns: ' + err.message;
          }
        }
        sheets = feesSheets(fees.rep, fees.promises, money, fees.led);
        name = X.fileName(['vector fees collection', fees.from, 'to', fees.to]);
      } else if (picked === 'funnel') {
        if (!funnel) throw new Error('Show the report first, then download it.');
        sheets = funnelSheets(funnel.data);
        name = X.fileName(['vector sales funnel', funnel.from, 'to', funnel.to]);
      } else if (picked === 'results') {
        const team = await teamRows(f);
        sheets = resultsSheets(A.pivotOutcomes(outcomes), A.OUTCOMES, A.TEAM_HEADERS, A.teamCsvRows(team));
        name = X.fileName(['vector results', f.fromDay, 'to', f.toDay]);
      } else if (picked === 'lost') {
        if (!lost) throw new Error('Run the report first, then download it.');
        sheets = lostSheets(lost.report, lost.insights);
        name = X.fileName(['vector why calls are lost', lost.report.script_name, 'v' + lost.version.version, f.fromDay, 'to', f.toDay]);
      } else {
        if (!weeklyRows.length) throw new Error('No activity in this week, so nothing to download.');
        const cols = T.summaryColumns(weeklyRows);
        sheets = weeklySheets(weeklyRows, cols, T.headerText);
        name = X.fileName(['vector weekly summary', $('week-start').value]);
      }
      await X.download(sheets, name);
      say('rp-msg', 'Saved ' + name + '.' + note, !!note);
    } catch (err) {
      say('rp-msg', 'Could not download: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  let scriptsReady = null;   // the first load of the script list, so a link waits for it

  S.registerTab({
    id: 'reports',
    label: 'Reports',
    mount(box, c) {
      ctx = c;
      accounts = isAccountsSeat(ctx.seat);
      build(box);
      wire();
      const d = presetRange('last7', new Date());
      $('rp-dates').value = 'last7';
      $('rp-from').value = d.from;
      $('rp-to').value = d.to;
      $('week-start').value = T.weekStart(new Date());
      if (accounts) {
        // Accounts: Fees collection only, for every campaign and caller; no campaign or caller lists (the caller
        // list is an owner/manager function), and nothing that would show its refusal.
        scriptsReady = Promise.resolve();
        $('rp-campaign').closest('label').hidden = true;
        $('rp-caller').closest('label').hidden = true;
        pick('fees');
        return;
      }
      loadFilterLists();
      loadFeatures();
      scriptsReady = loadScripts();
      const route = ctx.route();
      const first = route.params && route.params.script ? 'lost' : (route.params && route.params.report) || storage.get();
      pick(first);
      if (picked !== 'results') loadResults();   // the results table is filled from the start, as before
    },
    show(params) {
      if (!params || accounts) return;
      if (params.script) {
        if (picked !== 'lost') pick('lost');
        const mine = ctx;
        scriptsReady.then(() => { if (ctx === mine) openFromLink(params); });
      } else if (params.report && params.report !== picked) {
        pick(params.report);
      }
    },
    unmount() {
      ctx = null;
      accounts = false;
      outcomes = []; weeklyRows = []; scripts = []; versions = [];
      fees = null; funnel = null; lost = null;
      Object.keys(seq).forEach((k) => { seq[k]++; });
      scriptsReady = null;
    },
  });
})();
