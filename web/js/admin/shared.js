'use strict';
/* Shared helpers for the admin app (web/admin.html): the tab registry, hash routes (#home, #reports?script=…),
   money and date formatting, and small DOM builders. Every tab module (web/js/admin/<tab>.js) registers itself
   here with VectorAdminShared.registerTab({ id, label, mount(container, ctx), unmount() }); js/admin/shell.js
   draws the tabs and mounts each one the first time it is opened.
   Money rules (docs/phase-a-plan.md): show ₹ only when ctx.canSeeMoney is true; paid amounts carry the
   REPORTED_BY_CALLER label.
   The pure helpers below are also loaded by tests/web/admin-shell.test.js (Node, no DOM). */
(function () {
  // ---------- tabs and routes ----------
  // The seven tabs in the order they appear. A module with another id goes after these.
  const TAB_ORDER = ['home', 'insights', 'campaigns', 'scripts', 'callers', 'reports', 'settings'];
  const DEFAULT_TAB = 'home';
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

  // '#reports?script=abc&from=2026-10-01' to { tab: 'reports', params: { script: 'abc', from: '2026-10-01' } }.
  // Anything that is not a tab route (empty, or a sign-in link's #access_token=…) gives tab null.
  function parseHash(hash) {
    const m = /^#?([a-z][a-z0-9-]{0,30})(?:\?(.*))?$/.exec(String(hash || ''));
    if (!m) return { tab: null, params: {} };
    const params = {};
    if (m[2]) {
      new URLSearchParams(m[2]).forEach((v, k) => { params[k] = v; });
    }
    return { tab: m[1], params };
  }

  // The other way round. Empty and missing values are left out, so links stay short.
  function buildHash(tab, params) {
    const q = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
    });
    const s = q.toString();
    return '#' + tab + (s ? '?' + s : '');
  }

  // The tab to open for a route: the route's tab when it is known, else the default (or the first known tab).
  function resolveTab(route, knownIds) {
    const ids = knownIds || [];
    if (route && route.tab && ids.includes(route.tab)) return route.tab;
    return ids.includes(DEFAULT_TAB) ? DEFAULT_TAB : (ids[0] || null);
  }

  // ---------- who may use the admin app ----------
  // 'admin' is the role of today's seats; 'owner' and 'manager' are the Phase A roles.
  const ADMIN_ROLES = ['admin', 'owner', 'manager'];
  const isAdminRole = (role) => ADMIN_ROLES.includes(String(role || ''));

  // ---------- money ----------
  const REPORTED_BY_CALLER = 'reported by caller';

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

  // A browser download of text, such as a CSV. The BOM makes Excel read the file as UTF-8.
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

  const registry = createRegistry();
  const helpers = {
    TAB_ORDER, DEFAULT_TAB, createRegistry, parseHash, buildHash, resolveTab, ADMIN_ROLES, isAdminRole,
    REPORTED_BY_CALLER, rupees, rupeesShort, count, MONTHS, ymd, parseYmd, toDate, formatDate, formatTime,
    formatDateTime, lastNDays, escapeHtml,
    // browser only
    el, say, placeholder, download, registerTab: registry.register, tabs: registry.list, tab: registry.get,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof window !== 'undefined') window.VectorAdminShared = helpers;
})();
