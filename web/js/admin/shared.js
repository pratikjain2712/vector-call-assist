'use strict';
/* Shared helpers for the admin app (web/admin.html): the tab registry, hash routes (#today, #calling/scripts,
   #fees?student=…), who gets which tab, simple and advanced mode, the fee numbers every tab shows, money and
   date formatting, and small DOM builders. Every tab module (web/js/admin/<tab>.js) registers itself here with
   VectorAdminShared.registerTab({ id, label, mount(container, ctx), unmount() }); js/admin/shell.js draws the
   tabs and mounts each one the first time it is opened. A module with part: true is not a tab of its own: a tab
   mounts it inside itself with ctx.part(id, container).
   Money rules (docs/data-contract.md): show ₹ only when ctx.canSeeMoney is true; money the fees office recorded is
   "Paid (office)", money only a parent mentioned on a call is "Parent said (not paid yet)".
   One number, one definition: due now, collected, promised and "Promised date missed" all come from one server
   function, admin_fees_ledger (migration 20261025150000), read through loadFeeNumbers() below; Home's "Collected
   today" reads admin_home_ledger, which counts payments with the same ledger_collected.
   The pure helpers below are also loaded by tests/web/admin-shell.test.js (Node, no DOM). */
(function () {
  // ---------- tabs and routes ----------
  // The five tabs in the order they appear (owner feedback: "too many options"). A module with another id goes
  // after these.
  const TAB_ORDER = ['today', 'fees', 'calling', 'team', 'settings'];
  const DEFAULT_TAB = 'today';
  // The file of a tab's module and stylesheet when it is not js/admin/<id>.js (Team is still callers.js).
  const TAB_MODULE = { team: 'callers' };
  const TAB_ID = /^[a-z][a-z0-9-]{0,30}$/;

  // A list of tab definitions in TAB_ORDER. register() checks the shape and refuses a second tab with the same id.
  function createRegistry() {
    const tabs = [];
    const rank = (id) => { const i = TAB_ORDER.indexOf(id); return i === -1 ? TAB_ORDER.length : i; };
    return {
      register(def) {
        if (!def || !TAB_ID.test(String(def.id || ''))) throw new Error('A tab needs an id of lowercase letters.');
        if (!def.label || typeof def.label !== 'string') throw new Error('Tab "' + def.id + '" needs a label.');
        if (typeof def.mount !== 'function') throw new Error('Tab "' + def.id + '" needs a mount function.');
        if (tabs.some((t) => t.id === def.id)) throw new Error('Tab "' + def.id + '" is registered twice.');
        tabs.push(def);
        tabs.sort((a, b) => rank(a.id) - rank(b.id));   // stable, so extra tabs keep the order they came in
        return def;
      },
      list: () => tabs.slice(),
      get: (id) => tabs.find((t) => t.id === id) || null,
    };
  }

  // '#calling/scripts?edit=abc' to { tab: 'calling', sub: 'scripts', params: { edit: 'abc' } }; sub is null when
  // the address names no sub-view. Anything that is not a tab route (empty, or a sign-in link's
  // #access_token=…) gives tab null.
  function parseHash(hash) {
    const m = /^#?([a-z][a-z0-9-]{0,30})(?:\/([a-z][a-z0-9-]{0,30}))?(?:\?(.*))?$/.exec(String(hash || ''));
    if (!m) return { tab: null, sub: null, params: {} };
    const params = {};
    if (m[3]) {
      new URLSearchParams(m[3]).forEach((v, k) => { params[k] = v; });
    }
    return { tab: m[1], sub: m[2] || null, params };
  }

  // The other way round. tab may carry a sub-view ('calling/scripts'). Empty and missing values are left out,
  // so links stay short.
  function buildHash(tab, params) {
    const q = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
    });
    const s = q.toString();
    return '#' + tab + (s ? '?' + s : '');
  }
  const routeHash = (r) => buildHash(r.tab + (r.sub ? '/' + r.sub : ''), r.params);

  // Links from before the five tabs (bookmarks, old e-mails) to where things are now: #home -> #today,
  // #insights -> #today?more=1 (More analysis open), #campaigns -> #calling, #scripts -> #calling/scripts,
  // #callers -> #team, #reports -> #today/reports, or #fees/report for the fees collection report (and always
  // for an Accounts seat, which has Fees only). The params go along. null when the route is not an old one.
  function redirectRoute(route, opts) {
    const r = route || {};
    const o = opts || {};
    const p = Object.assign({}, r.params || {});
    if (r.tab === 'home') return { tab: 'today', sub: null, params: p };
    if (r.tab === 'insights') return { tab: 'today', sub: null, params: Object.assign(p, { more: '1' }) };
    if (r.tab === 'campaigns') return { tab: 'calling', sub: null, params: p };
    if (r.tab === 'scripts') return { tab: 'calling', sub: 'scripts', params: p };
    if (r.tab === 'callers') return { tab: 'team', sub: null, params: p };
    if (r.tab === 'reports') {
      if (p.report === 'fees' || o.accounts) { delete p.report; return { tab: 'fees', sub: 'report', params: p }; }
      return { tab: 'today', sub: 'reports', params: p };
    }
    return null;
  }

  // The tab to open for a route: the route's tab when it is known, else the default (or the first known tab).
  function resolveTab(route, knownIds) {
    const ids = knownIds || [];
    if (route && route.tab && ids.includes(route.tab)) return route.tab;
    return ids.includes(DEFAULT_TAB) ? DEFAULT_TAB : (ids[0] || null);
  }

  // ---------- who may use the admin app, and which tabs ----------
  // 'admin' is the role of today's seats; 'owner' and 'manager' are the Phase A roles.
  const ADMIN_ROLES = ['admin', 'owner', 'manager'];
  const isAdminRole = (role) => ADMIN_ROLES.includes(String(role || ''));

  // 'owner', 'manager' or 'accounts' for a my_active_seat row. Admin seats from before roles are owners.
  function seatKind(seat) {
    const s = seat || {};
    if (s.role === 'accounts' || s.access_role === 'accounts' || s.admin_kind === 'accounts') return 'accounts';
    if (s.access_role === 'manager' || s.admin_kind === 'manager') return 'manager';
    return 'owner';
  }

  // The tabs a person gets, in order: an owner all five; a manager Today, Calling and Team, and Fees only when
  // they may see money; Accounts Fees only (its fees collection report is inside Fees).
  function tabsFor(seat, canSeeMoney) {
    const kind = seatKind(seat);
    if (kind === 'accounts') return ['fees'];
    if (kind === 'manager') return TAB_ORDER.filter((id) => id !== 'settings' && (id !== 'fees' || !!canSeeMoney));
    return TAB_ORDER.slice();
  }

  // ---------- simple and advanced ----------
  // The admin app opens simple. Rarely used fields and panels carry the class "adv" and stay hidden until the
  // person turns on "Show advanced options" (Settings). Remembered per login in this browser only; storage that
  // throws (a private window, blocked site data) just means simple.
  const ADVANCED_KEY = 'vector-admin-advanced';
  const advancedKey = (who) => ADVANCED_KEY + (who ? ':' + String(who).toLowerCase() : '');
  function readAdvanced(store, who) {
    try { return !!store && store.getItem(advancedKey(who)) === '1'; } catch (err) { return false; }
  }
  function writeAdvanced(store, who, on) {
    try {
      if (!store) return false;
      if (on) store.setItem(advancedKey(who), '1'); else store.removeItem(advancedKey(who));
      return true;
    } catch (err) { return false; }
  }

  // ---------- money ----------
  // Money the fees office recorded in the fee ledger, and money a parent only mentioned on a call.
  const PAID_OFFICE = 'Paid (office)';
  const PARENT_SAID = 'Parent said (not paid yet)';
  const REPORTED_BY_CALLER = PARENT_SAID;   // the old name, kept for modules that still use it
  const MISSED = 'Promised date missed';

  // Whole rupees with Indian grouping: 4320000 to '₹43,20,000'. Paise are rounded. '' for a missing amount.
  function rupees(amount) {
    if (amount === null || amount === undefined || amount === '') return '';
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '';
    const digits = String(Math.abs(n));
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + '₹' + (rest ? rest + ',' + last3 : last3);
  }

  // Short form for big numbers on cards: '₹31.2L' (lakhs) and '₹1.5Cr' (crores), one decimal place,
  // '.0' dropped. Under one lakh it is the full amount, such as '₹38,500'.
  function rupeesShort(amount) {
    if (amount === null || amount === undefined || amount === '') return '';
    const n = Number(amount);
    if (!Number.isFinite(n)) return '';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const short = (v, unit) => sign + '₹' + String(Math.round(v * 10) / 10) + unit;
    if (Math.round(abs / 1e4) >= 1000) return short(abs / 1e7, 'Cr');   // 99.95 lakh and up would read 100L, so crore
    if (abs >= 1e5) return short(abs / 1e5, 'L');
    return rupees(n);
  }

  // A count with Indian grouping and no ₹: 120000 to '1,20,000'.
  function count(n) {
    const s = rupees(n);
    return s.replace('₹', '');
  }

  // admin_fees_ledger's answer, the one source of the fee numbers, in one shape for every tab:
  // { from, to, today, money, hasLedger, due: { students, amount }, collected: { payments, reversed, amount, byMode,
  //   byDay }, promised: { parents, amount }, missed: { parents, partPaid, amount } }. Amounts are null unless the
  // server sent them (money access).
  //   due        active students whose balance due today is above 0 (fee items due till today minus payments)
  //   collected  payments in the fee ledger dated from..to; reversed payments, reversals and opening balances
  //              ("paid so far" at import) left out
  //   promised   open promises from calls dated today or later, not yet paid in the ledger (what is still to pay)
  //   missed     open promises whose date has passed (yesterday or earlier), not fully paid in the ledger
  function feeNumbers(led) {
    const d = led || {};
    const part = (k) => d[k] || {};
    const n = (v) => Number(v) || 0;
    const amt = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const money = d.money_hidden === false;
    const due = part('due_now');
    const col = part('collected');
    const pro = part('promised');
    const brk = part('broken');
    return {
      from: d.from || null, to: d.to || null, today: d.today || null, money, hasLedger: !!d.has_ledger,
      due: { students: n(due.students), amount: money ? amt(due.amount) : null },
      collected: { payments: n(col.payments), reversed: n(col.reversed), amount: money ? amt(col.total) : null,
        byMode: Array.isArray(col.by_mode) ? col.by_mode : [], byDay: Array.isArray(col.by_day) ? col.by_day : [] },
      promised: { parents: n(pro.leads), amount: money ? amt(pro.amount) : null },
      missed: { parents: n(brk.leads), partPaid: n(brk.part_paid), amount: money ? amt(brk.amount) : null },
    };
  }

  // The four fee cards, the same on the Fees tab and in the fees collection report: [{ key, label, value, sub,
  // level }]. nums: feeNumbers(); period: the words for its dates (periodText). ₹ only when nums.money.
  function feeCards(nums, period) {
    const x = nums || feeNumbers(null);
    const show = (amount, n, one, many) => (x.money && amount !== null ? rupees(amount) : count(n) + ' ' + (Number(n) === 1 ? one : many));
    const plural = (n, one, many) => count(n) + ' ' + (Number(n) === 1 ? one : many);
    return [
      { key: 'due', label: 'Due now', value: show(x.due.amount, x.due.students, 'student', 'students'),
        sub: plural(x.due.students, 'student', 'students') + ' · fees due till today, minus ' + PAID_OFFICE.toLowerCase(), level: 'bad' },
      { key: 'collected', label: 'Collected' + (period ? ' ' + period : ''), value: show(x.collected.amount, x.collected.payments, 'payment', 'payments'),
        sub: plural(x.collected.payments, 'payment', 'payments') + ' · ' + PAID_OFFICE, level: 'good' },
      { key: 'promised', label: 'Promised, not paid yet', value: show(x.promised.amount, x.promised.parents, 'parent', 'parents'),
        sub: plural(x.promised.parents, 'parent', 'parents') + ' · ' + PARENT_SAID.toLowerCase(), level: '' },
      { key: 'missed', label: MISSED, value: count(x.missed.parents),
        sub: (x.money && x.missed.amount ? rupees(x.missed.amount) + ' still to pay · ' : '') + 'date passed, not paid' +
          (x.missed.partPaid ? ' · ' + count(x.missed.partPaid) + ' partly paid' : ''), level: 'bad' },
    ];
  }

  // The words for a date range next to a number: 'today', 'this month', 'in these dates (1 Oct – 25 Oct)'.
  // today: the 'YYYY-MM-DD' of today.
  function periodText(from, to, today) {
    if (!from || !to) return '';
    if (today && from === today && to === today) return 'today';
    if (today && to === today && from === today.slice(0, 8) + '01') return 'this month';
    return 'in these dates (' + formatDate(from, { year: false }) + ' – ' + formatDate(to, { year: false }) + ')';
  }

  // ---------- dates ----------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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

  // A 'YYYY-MM-DD' date, a Date or an ISO timestamp to a Date in local time, or null.
  function toDate(v) {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    if (v === null || v === undefined || v === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return parseYmd(v);   // a plain day: no rolling 30 Feb into March
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // '24 Oct 2026'. With { year: false }: '24 Oct'. '' for a missing or bad date.
  function formatDate(v, opts) {
    const d = toDate(v);
    if (!d) return '';
    const s = d.getDate() + ' ' + MONTHS[d.getMonth()];
    return opts && opts.year === false ? s : s + ' ' + d.getFullYear();
  }

  // '3:05 pm', local time.
  function formatTime(v) {
    const d = toDate(v);
    if (!d) return '';
    const h = d.getHours() % 12 || 12;
    return h + ':' + pad2(d.getMinutes()) + ' ' + (d.getHours() < 12 ? 'am' : 'pm');
  }

  // '24 Oct, 3:05 pm'.
  function formatDateTime(v) {
    const d = toDate(v);
    return d ? formatDate(d, { year: false }) + ', ' + formatTime(d) : '';
  }

  // The last n calendar days ending on `now`, both ends included, as local 'YYYY-MM-DD' dates.
  function lastNDays(now, n) {
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (n - 1));
    return { from: ymd(from), to: ymd(to) };
  }

  // The first of this month to today, local dates.
  function monthToDate(now) {
    const d = now || new Date();
    return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(d) };
  }

  // ---------- text ----------
  // For the rare place that needs an HTML string. The admin pages build with el() instead, which never parses markup.
  function escapeHtml(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- DOM (browser only) ----------
  // Builds an element from text and child nodes only: no HTML strings, so names from the database are never
  // parsed as markup. props: text, className, onClick, value, checked, disabled, hidden, any other attribute.
  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v === undefined || v === null) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else if (k === 'onClick') node.addEventListener('click', v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'required') node[k] = !!v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  // Sets a status line: plain text, red when isError.
  function say(node, text, isError) {
    if (typeof node === 'string') node = document.getElementById(node);
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
  }

  // The "coming soon" content of a tab that is not built yet.
  function placeholder(container, title, text) {
    container.appendChild(el('div', { className: 'tab-head' }, [el('h1', { text: title })]));
    container.appendChild(el('div', { className: 'panel soon' }, [
      el('p', { text: text }),
      el('p', { className: 'muted', text: 'Coming soon.' }),
    ]));
  }

  // A browser download of text. The BOM makes Excel read a text file as UTF-8.
  function download(text, name, type) {
    const blob = new Blob(['﻿' + text], { type: type || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // The fee numbers for a date range ({ from, to } 'YYYY-MM-DD'; campaign and seat optional), from
  // admin_fees_ledger, in feeNumbers() shape. null when the database does not have the function yet.
  async function loadFeeNumbers(ctx, range) {
    const r = range || {};
    try {
      const led = await ctx.rpc('admin_fees_ledger', { p_institute: ctx.institute.id, p_from: r.from, p_to: r.to,
        p_campaign: r.campaign || null, p_seat: r.seat || null });
      const out = feeNumbers(led);
      out.raw = led;
      if (!ctx.canSeeMoney) { out.money = false; out.due.amount = null; out.collected.amount = null; out.promised.amount = null; out.missed.amount = null; }
      return out;
    } catch (err) {
      if (ctx.isMissing && ctx.isMissing(err)) return null;
      throw err;
    }
  }

  // Simple or advanced, for the signed-in person (ctx.email), and a switch that changes it on this page.
  const store = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (err) { return null; } };
  let advancedWho = null;
  function applyAdvanced(on) {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.classList.toggle('show-advanced', !!on);
    document.dispatchEvent(new CustomEvent('vector:advanced', { detail: { on: !!on } }));
  }
  function startAdvanced(who) { advancedWho = who || null; applyAdvanced(readAdvanced(store(), advancedWho)); }
  const isAdvanced = () => typeof document !== 'undefined' && !!document.body && document.body.classList.contains('show-advanced');
  function setAdvanced(on) { writeAdvanced(store(), advancedWho, on); applyAdvanced(on); }

  const registry = createRegistry();
  const helpers = {
    TAB_ORDER, DEFAULT_TAB, TAB_MODULE, createRegistry, parseHash, buildHash, routeHash, redirectRoute, resolveTab,
    ADMIN_ROLES, isAdminRole, seatKind, tabsFor, ADVANCED_KEY, advancedKey, readAdvanced, writeAdvanced,
    PAID_OFFICE, PARENT_SAID, REPORTED_BY_CALLER, MISSED, rupees, rupeesShort, count, feeNumbers, feeCards, periodText,
    MONTHS, ymd, parseYmd, toDate, formatDate, formatTime, formatDateTime, lastNDays, monthToDate, escapeHtml,
    // browser only
    el, say, placeholder, download, loadFeeNumbers, startAdvanced, isAdvanced, setAdvanced,
    registerTab: registry.register, tabs: registry.list, tab: registry.get,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof window !== 'undefined') window.VectorAdminShared = helpers;
})();
