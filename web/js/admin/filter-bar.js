'use strict';
/* A simple filter bar for any list in the admin app (docs/autopilot-plan.md, phase 1): a search box, 3–4 quick
   filter chips with counts ("Promise missed 9"), a Class picker when the rows have more than one class, and
   "act on these" buttons that get the rows on screen. One chip at a time; tapping it again shows everything.
   Used by Calling (a calling list's people) and Team; Fees can adopt it for its students list:

     const bar = VectorFilterBar.create(container, {
       id: 'fees-fbar', placeholder: 'Search name or phone',
       searchText: (row) => row.name + ' ' + row.phone,          // what the search looks in
       chips: [{ key: 'due', label: 'With dues', test: (row) => row.balance > 0 }, …],
       classOf: (row) => row.class_label,                         // optional: shows the Class picker
       actions: [{ label: 'Download', run: (rows) => … }],        // optional: "act on these"
       onChange: (rows, state) => render(rows),                   // called with the rows that match
     });
     bar.setRows(allRows);

   Pure helpers (matches, filterRows, chipCounts, classOptions) are also loaded by tests/web/filter-bar.test.js. */
(function (root) {
  const norm = (v) => String(v === null || v === undefined ? '' : v).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
  const digits = (v) => String(v || '').replace(/\D/g, '');

  // Whether one row passes the search (every word starts a word of searchText; 4+ digits also match phone digits),
  // the chip and the class. state: { q, chip, cls }; opts: { searchText, chips, classOf }.
  function matches(row, state, opts) {
    const s = state || {};
    const o = opts || {};
    const q = norm(s.q);
    if (q) {
      const hay = norm(o.searchText ? o.searchText(row) : JSON.stringify(row));
      const tokens = hay.split(/[^a-z0-9\u0900-\u097f]+/).filter(Boolean);
      const words = q.split(/[^a-z0-9\u0900-\u097f]+/).filter(Boolean);
      const qd = digits(q);
      // Every word starts a word of the row ("bhos" finds Bhosale, "1" does not find "12"), or 4+ digits are in a phone.
      const ok = (words.length > 0 && words.every((w) => tokens.some((t) => t.startsWith(w)))) || (qd.length >= 4 && digits(hay).includes(qd));
      if (!ok) return false;
    }
    if (s.chip) {
      const chip = (o.chips || []).find((c) => c.key === s.chip);
      if (chip && !chip.test(row)) return false;
    }
    if (s.cls && o.classOf && norm(o.classOf(row)) !== norm(s.cls)) return false;
    return true;
  }

  const filterRows = (rows, state, opts) => (rows || []).filter((r) => matches(r, state, opts));

  // The count on each chip: rows that match the search and class with that chip on. { all, <key>: n }.
  function chipCounts(rows, state, opts) {
    const base = Object.assign({}, state || {}, { chip: '' });
    const pool = filterRows(rows, base, opts);
    const out = { all: pool.length };
    ((opts && opts.chips) || []).forEach((c) => { out[c.key] = pool.filter((r) => c.test(r)).length; });
    return out;
  }

  // The classes in the rows, in school order where we can tell ('8th' before '10th'), then by name.
  function classOptions(rows, classOf) {
    if (!classOf) return [];
    const seen = new Map();
    (rows || []).forEach((r) => { const v = String(classOf(r) || '').trim(); if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v); });
    const rank = (v) => { const m = /^(\d{1,2})/.exec(v); return m ? Number(m[1]) : 100; };
    return [...seen.values()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  // ---------- the bar (browser only) ----------
  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v === undefined || v === null) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else if (k === 'value') node.value = v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function create(container, options) {
    const o = Object.assign({ id: 'fbar', placeholder: 'Search', chips: [], actions: [] }, options || {});
    const state = { q: '', chip: '', cls: '' };
    let rows = [];
    let shown = [];
    const id = o.id;
    const search = el('input', { type: 'search', id: id + '-q', placeholder: o.placeholder, 'aria-label': o.placeholder, autocomplete: 'off' });
    const chipBox = el('div', { className: 'fbar-chips', role: 'group', 'aria-label': 'Quick filters' });
    const clsSel = el('select', { id: id + '-class', 'aria-label': 'Class', hidden: 'hidden' });
    const acts = el('div', { className: 'fbar-actions' });
    const bar = el('div', { className: 'fbar', id }, [search, chipBox, clsSel, acts]);
    container.appendChild(bar);

    function chipButton(key, label, n) {
      const b = el('button', { type: 'button', className: 'fbar-chip', 'data-chip': key, 'aria-pressed': String(state.chip === key || (!state.chip && key === '')) },
        [label + ' ', el('span', { className: 'fbar-n', text: String(n) })]);
      b.addEventListener('click', () => { state.chip = key === '' || state.chip === key ? '' : key; update(); });
      return b;
    }
    function draw() {
      const counts = chipCounts(rows, state, o);
      chipBox.textContent = '';
      chipBox.appendChild(chipButton('', o.allLabel || 'All', counts.all));
      o.chips.forEach((c) => chipBox.appendChild(chipButton(c.key, c.label, counts[c.key])));
      const classes = classOptions(rows, o.classOf);
      if (classes.length > 1) {
        const keep = state.cls;
        clsSel.textContent = '';
        clsSel.appendChild(el('option', { value: '', text: 'All classes' }));
        classes.forEach((c) => clsSel.appendChild(el('option', { value: c, text: c })));
        clsSel.value = classes.includes(keep) ? keep : '';
        state.cls = clsSel.value;
        clsSel.hidden = false;
      } else { clsSel.hidden = true; state.cls = ''; }
      acts.textContent = '';
      o.actions.forEach((a, i) => {
        const b = el('button', { type: 'button', className: 'fbar-act', id: id + '-act-' + i, text: a.label + (shown.length ? ' (' + shown.length + ')' : '') });
        if (!shown.length) b.disabled = true;
        b.addEventListener('click', () => a.run(shown.slice(), Object.assign({}, state)));
        acts.appendChild(b);
      });
    }
    function update() {
      shown = filterRows(rows, state, o);
      draw();
      if (typeof o.onChange === 'function') o.onChange(shown.slice(), Object.assign({}, state));
    }
    search.addEventListener('input', () => { state.q = search.value; update(); });
    clsSel.addEventListener('change', () => { state.cls = clsSel.value; update(); });
    return {
      el: bar,
      state,
      setRows(list) { rows = Array.isArray(list) ? list : []; update(); },
      set(next) { Object.assign(state, next || {}); search.value = state.q || ''; update(); },
      rows: () => shown.slice(),
    };
  }

  const api = { matches, filterRows, chipCounts, classOptions, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VectorFilterBar = api;
})(typeof window !== 'undefined' ? window : globalThis);
