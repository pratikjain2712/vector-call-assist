'use strict';
/* Vector Autopilot, the pure part (docs/autopilot-plan.md, phase 1): the planner's maths (working days, daily
   target, end date, call hours), which suggestion cards to show and to whom, the words on a card, the three
   numbers on Today and what changed on the one-screen setup. The database does the same sums
   (supabase/migrations/20261026120000_autopilot_engine.sql); the page uses these to redo them when the owner
   changes a field. Loaded by admin.html (window.VectorAutopilotModel) and by tests/web/autopilot.test.js. */
(function (root) {
  const DAY = 24 * 3600 * 1000;
  const pad2 = (n) => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // 'YYYY-MM-DD' to a UTC day number and back (no time zones involved).
  function dayNum(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY : null;
  }
  function ymdOf(n) {
    const d = new Date(n * DAY);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  const addDays = (ymd, n) => ymdOf(dayNum(ymd) + n);
  const shortDate = (ymd) => { const n = dayNum(ymd); if (n === null) return ''; const d = new Date(n * DAY); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };

  // Working days (Monday to Saturday) from one date to another, both counted. At least 1 (like ap_working_days).
  function workingDays(from, to) {
    const a = dayNum(from), b = dayNum(to);
    if (a === null || b === null) return 1;
    let n = 0;
    for (let d = a; d <= b; d++) if (new Date(d * DAY).getUTCDay() !== 0) n++;
    return Math.max(1, n);
  }

  // The list's daily target: everyone called by the end date, shared by the focus callers.
  // { total: calls a day for the list, perCaller } ; nulls when there is nobody to call.
  function dailyTarget(people, days, callers) {
    const p = Math.max(0, Math.floor(Number(people) || 0));
    if (!p) return { total: null, perCaller: null };
    const total = Math.min(10000, Math.ceil(p / Math.max(1, Math.floor(Number(days) || 1))));
    return { total, perCaller: Math.ceil(total / Math.max(1, Math.floor(Number(callers) || 0))) };
  }

  // A fees list ends a week after the due date, and never sooner than a week from today.
  function endDate(due, today) {
    const t = dayNum(today);
    const d = dayNum(due);
    return ymdOf(Math.max((d === null ? t : d) + 7, t + 7));
  }

  // '7–9 pm', '11 am–1 pm' (two hours from h), like ix_hour_range.
  function hourText(h) { const x = ((h % 24) + 24) % 24; return (x % 12 === 0 ? 12 : x % 12) + (x < 12 ? ' am' : ' pm'); }
  function hourRange(h) {
    const a = Number(h), b = a + 2;
    const sameHalf = (a % 24 < 12) === (b % 24 < 12) && b % 24 !== 0;
    return sameHalf ? (a % 12 === 0 ? 12 : a % 12) + '–' + hourText(b) : hourText(a) + '–' + hourText(b);
  }
  const HOUR_CHOICES = [{ value: '', label: 'Any time' }].concat(
    [8, 10, 12, 14, 16, 17, 18, 19].map((h) => ({ value: String(h), label: hourRange(h) })));

  // 'Class 8 State Board', 'Class 10 CBSE', 'Nursery' (like ap_class_text).
  function classText(cls, board) {
    const c = String(cls || '').trim();
    const m = /^(\d{1,2})(st|nd|rd|th)?$/i.exec(c);
    const b = board === 'State' ? 'State Board' : board === 'Other' ? '' : String(board || '');
    return [m ? 'Class ' + m[1] : c, b].filter(Boolean).join(' ');
  }

  // Who sees which kind (same rule as ap_may_see): owners all; managers the calling kinds, fees lists only with
  // money access; anyone else nothing.
  const CALLING = ['fees_due_list', 'missed_promises', 'enquiries_uncalled', 'list_behind_pace', 'new_list', 'balance_work', 'close_paid'];
  function maySee(viewer, money, kind) {
    if (viewer === 'owner') return true;
    if (viewer === 'manager') return CALLING.includes(kind) && (!!money || (kind !== 'fees_due_list' && kind !== 'new_list'));
    return false;
  }

  // The "Needs your OK" cards to show: one per dedupe key, best first (priority, then oldest), at most max,
  // leaving out kinds in skip (setup gaps while the Getting started list is on the page).
  function visibleCards(cards, opts) {
    const o = opts || {};
    const seen = new Set();
    return (cards || [])
      .filter((c) => c && c.id && !(o.skip || []).includes(c.kind) && (!o.viewer || maySee(o.viewer, o.money, c.kind)))
      .filter((c) => { const k = c.dedupe_key || c.id; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (Number(a.priority) || 50) - (Number(b.priority) || 50) || String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .slice(0, o.max === undefined ? 3 : o.max);
  }

  // Short rupees for a card: '₹6.2L', '₹38,500'.
  function rupeesShort(amount) {
    const n = Number(amount);
    if (amount === null || amount === undefined || amount === '' || !Number.isFinite(n)) return '';
    const one = (v) => String(Math.round(v * 10) / 10);
    if (Math.abs(n) >= 1e7) return '₹' + one(n / 1e7) + 'Cr';
    if (Math.abs(n) >= 1e5) return '₹' + one(n / 1e5) + 'L';
    return (n < 0 ? '-₹' : '₹') + groupIN(Math.abs(n));
  }

  // A count with Indian grouping: 120000 to '1,20,000'.
  function groupIN(v) {
    const s = String(Math.round(Math.abs(Number(v) || 0)));
    const last3 = s.slice(-3), rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return (Number(v) < 0 ? '-' : '') + (rest ? rest + ',' + last3 : last3);
  }

  // The one-line why of a card, with the amount when it may be shown.
  function whyText(card, money) {
    const w = (card && card.why) || {};
    const t = String(w.text || '');
    if (!money || w.amount === null || w.amount === undefined) return t;
    const label = card.kind === 'missed_promises' ? ' promised.' : ' due.';
    return t + ' ' + rupeesShort(w.amount) + label;
  }
  const impactText = (card) => String(((card && card.impact) || {}).text || '');

  // What a card's Confirm button says, and whether it has a Change.
  function actionsFor(card) {
    const k = card && card.kind;
    const plan = (card && card.plan) || {};
    if (k === 'setup_gaps') return { confirm: 'Open settings', change: false };
    if (k === 'fees_due_list' && plan.action === 'topup') return { confirm: 'Confirm', change: false };
    if (k === 'missed_promises') return { confirm: 'Confirm', change: false };
    return { confirm: 'Confirm', change: true };
  }

  // The three numbers on Today. n: autopilot_numbers(). Each: { key, label, value, sub, pct, goal }.
  function numberTiles(n, money) {
    const x = n || {};
    const f = x.fees || {};
    const a = x.admissions || {};
    const t = x.team || {};
    const count = groupIN;
    const tiles = [];
    const usePct = money && f.pct !== null && f.pct !== undefined;
    const pct = usePct ? Number(f.pct) : (f.parents_pct === null || f.parents_pct === undefined ? null : Number(f.parents_pct));
    tiles.push({
      key: 'fees', label: 'Fees collected this term',
      value: pct === null ? '—' : pct + '%',
      sub: usePct ? rupeesShort(f.collected_amount) + ' of ' + rupeesShort(f.due_amount) + ' due'
        : (Number(f.parents) > 0 ? count(f.parents_paid) + ' of ' + count(f.parents) + ' parents paid' : 'No fees due yet'),
      pct, goal: f.goal_pct === undefined ? null : Number(f.goal_pct),
    });
    const at = Number(a.target) || 0;
    tiles.push({
      key: 'admissions', label: 'Admissions confirmed',
      value: at ? count(a.confirmed) + ' of ' + count(at) : count(a.confirmed),
      sub: at ? (a.pct === null || a.pct === undefined ? '' : a.pct + '% of the target') : 'No target set',
      pct: at ? Number(a.pct) || 0 : null, goal: at ? 100 : null,
    });
    tiles.push({
      key: 'team', label: 'Team today',
      value: count(t.calls) + ' calls',
      sub: count(t.reached) + ' reached · ' + count(t.callers) + ' of ' + count(t.callers_total) + ' callers calling',
      pct: null, goal: null,
    });
    return tiles;
  }

  // 'on track' | 'behind' for a tile with a goal, or ''.
  function tileState(tile) {
    if (!tile || tile.pct === null || tile.pct === undefined || tile.goal === null || tile.goal === undefined) return '';
    return Number(tile.pct) >= Number(tile.goal) ? 'on track' : 'behind';
  }

  // The changes the owner made on the one-screen setup: only the keys that differ from the plan.
  // form: { name, callers [ids], script_id, hour ('' = any time), daily_target, end_date, whatsapp, add_callers }.
  function overrides(plan, form) {
    const p = plan || {};
    const f = form || {};
    const out = {};
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    const sortIds = (v) => (Array.isArray(v) ? v.slice().sort() : v);
    if (f.name !== undefined && String(f.name).trim() !== String(p.name || '')) out.name = String(f.name).trim();
    ['callers', 'add_callers'].forEach((k) => { if (f[k] !== undefined && !same(sortIds(f[k]), sortIds(p[k] || []))) out[k] = f[k]; });
    if (f.script_id !== undefined && (f.script_id || null) !== (p.script_id || null)) out.script_id = f.script_id || null;
    if (f.hour !== undefined) {
      const h = f.hour === '' || f.hour === null ? null : Number(f.hour);
      const ph = p.hour === undefined || p.hour === null ? null : Number(p.hour);
      if (h !== ph) out.hour = h;
    }
    if (f.daily_target !== undefined) {
      const d = f.daily_target === '' || f.daily_target === null ? null : Number(f.daily_target);
      if (d !== (p.daily_target === undefined ? null : p.daily_target)) out.daily_target = d;
    }
    if (f.end_date !== undefined && f.end_date && f.end_date !== p.end_date) out.end_date = f.end_date;
    if (f.whatsapp !== undefined && !!f.whatsapp !== !!p.whatsapp) out.whatsapp = !!f.whatsapp;
    return out;
  }

  // What a problem with the setup form is, in plain words, or ''.
  function setupProblem(f) {
    const x = f || {};
    if (x.name !== undefined && !String(x.name).trim()) return 'Give the list a name.';
    if (x.name !== undefined && String(x.name).trim().length > 120) return 'Keep the name under 120 characters.';
    if (x.daily_target !== undefined && x.daily_target !== '' && x.daily_target !== null) {
      const n = Number(x.daily_target);
      if (!Number.isInteger(n) || n < 1 || n > 10000) return 'The daily target is a number of calls from 1 to 10,000.';
    }
    if (x.end_date !== undefined && x.today && x.end_date && x.end_date < x.today) return 'The end date is in the past.';
    return '';
  }

  // How long ago, for the feed: 'just now', '25 min ago', '3:05 pm', 'yesterday 7:00 pm'.
  function whenText(iso, now) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const n = now instanceof Date ? now.getTime() : Date.now();
    const mins = Math.round((n - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const d = new Date(t), today = new Date(n);
    const hm = (d.getHours() % 12 || 12) + ':' + pad2(d.getMinutes()) + ' ' + (d.getHours() < 12 ? 'am' : 'pm');
    if (d.toDateString() === today.toDateString()) return hm;
    return 'yesterday ' + hm;
  }

  // Whether Today should ask for a new plan: never ran, or the last run is 15 minutes old.
  const PLAN_EVERY_MS = 15 * 60 * 1000;
  function needsPlan(lastRunAt, now) {
    const t = Date.parse(lastRunAt || '');
    const n = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
    return !Number.isFinite(t) || n - t >= PLAN_EVERY_MS;
  }

  const api = { dayNum, ymdOf, addDays, shortDate, workingDays, dailyTarget, endDate, hourRange, classText, HOUR_CHOICES, CALLING, maySee,
    visibleCards, rupeesShort, groupIN, whyText, impactText, actionsFor, numberTiles, tileState, overrides, setupProblem, whenText,
    PLAN_EVERY_MS, needsPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VectorAutopilotModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
