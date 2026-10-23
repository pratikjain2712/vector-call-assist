/* Tiny charts for the admin app (first used by the Insights tab, web/js/admin/insights.js): a forecast line
   with a likely range and a target, horizontal bars (optionally with a team-average mark) and a day × hour
   heatmap. Built from DOM nodes only (no HTML strings), so the page's Content-Security-Policy holds; sizes are
   SVG attributes or CSSOM (element.style), never style attributes in markup.
   Every chart: a tooltip on hover and on keyboard focus, a "Show as table" toggle with the same numbers,
   colours from the --chart-1 … --chart-6 tokens (one blue, light to dark, so lightness carries the value and
   dark mode gets its own steps), and a width that follows its box (fits 375px).
   Styles: css/admin-insights.css (.chart …). The pure helpers at the top are tested in Node
   (tests/web/charts.test.js). Loads as window.VectorCharts. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VectorCharts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------- pure helpers ----------

  // A round number at or above v for the top of an axis: 1, 2, 2.5, 5 or 10 × a power of ten.
  function niceMax(v) {
    const n = Number(v);
    if (!(n > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(n)));
    const f = n / p;
    const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return step * p;
  }

  // Evenly spaced ticks from 0 to max. Without a count: 4 or 5 steps, whichever gives round steps for niceMax.
  function ticks(max, count) {
    const m = max / Math.pow(10, Math.floor(Math.log10(max || 1)));
    const c = count || (Math.abs(m - 2.5) < 1e-9 || Math.abs(m - 5) < 1e-9 ? 5 : 4);
    const out = [];
    for (let i = 0; i <= c; i++) out.push((max * i) / c);
    return out;
  }

  // Maps a value from [d0, d1] to [r0, r1].
  function scale(d0, d1, r0, r1) {
    const span = d1 - d0 || 1;
    return (v) => r0 + ((v - d0) / span) * (r1 - r0);
  }

  // "x,y x,y …" for an SVG polyline, rounded to 0.1.
  function points(list) {
    return list.map((p) => (Math.round(p[0] * 10) / 10) + ',' + (Math.round(p[1] * 10) / 10)).join(' ');
  }

  // Index of the nearest x in a sorted list.
  function nearest(xs, x) {
    let best = 0;
    xs.forEach((v, i) => { if (Math.abs(v - x) < Math.abs(xs[best] - x)) best = i; });
    return best;
  }

  // ---------- DOM helpers (browser only) ----------

  function h(tag, props, kids) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else node.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach((c) => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }
  function s(tag, attrs, kids) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => {
      if (k === 'text') node.textContent = attrs[k];
      else if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach((c) => { if (c) node.appendChild(c); });
    return node;
  }

  let uid = 0;

  // The frame every chart shares: the plot, a tooltip, the "Show as table" toggle and the table.
  // table: { caption, head: [text], rows: [[text]] , num: [column indexes that are numbers] }
  function frame(opts) {
    const id = 'chart-' + (++uid);
    const wrap = h('div', { className: 'chart' + (opts.className ? ' ' + opts.className : '') });
    const plot = h('div', { className: 'chart-plot' });
    const tip = h('div', { className: 'chart-tip', role: 'status', 'aria-live': 'polite', hidden: true });
    plot.appendChild(tip);
    const tableBox = h('div', { className: 'chart-table scroll', id: id + '-table', hidden: true });
    const t = opts.table || { head: [], rows: [] };
    const num = t.num || [];
    tableBox.appendChild(h('table', null, [
      t.caption ? h('caption', { className: 'muted small', text: t.caption }) : null,
      h('thead', null, [h('tr', null, t.head.map((x, i) => h('th', { text: x, scope: 'col', className: num.includes(i) ? 'num' : null })))]),
      h('tbody', null, t.rows.map((r) => h('tr', null, r.map((x, i) => h(i === 0 ? 'th' : 'td',
        { text: x === null || x === undefined ? '' : String(x), scope: i === 0 ? 'row' : null, className: num.includes(i) ? 'num' : null }))))),
    ]));
    const toggle = h('button', { type: 'button', className: 'chart-toggle', 'aria-expanded': 'false', 'aria-controls': id + '-table', text: 'Show as table' });
    toggle.addEventListener('click', () => {
      const open = tableBox.hidden;
      tableBox.hidden = !open;
      plot.hidden = open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Show as chart' : 'Show as table';
    });
    wrap.appendChild(plot);
    wrap.appendChild(tableBox);
    wrap.appendChild(h('div', { className: 'chart-foot' }, [opts.legend || null, toggle]));

    // Shows the tooltip next to a mark (an element inside plot) or at x, y in the plot.
    function show(lines, anchor) {
      tip.textContent = '';
      (lines || []).forEach((line, i) => tip.appendChild(h(i === 0 ? 'strong' : 'span', { text: line })));
      tip.hidden = false;
      const pb = plot.getBoundingClientRect();
      const ab = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x + pb.left, top: anchor.y + pb.top, width: 0, height: 0 };
      const tw = tip.offsetWidth || 160;
      let left = ab.left - pb.left + ab.width / 2 - tw / 2;
      left = Math.max(0, Math.min(left, pb.width - tw));
      let top = ab.top - pb.top - (tip.offsetHeight || 40) - 8;
      if (top < 0) top = ab.top - pb.top + ab.height + 8;
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(top) + 'px';
    }
    const hide = () => { tip.hidden = true; };
    return { wrap, plot, show, hide };
  }

  // A legend row: [{ text, kind: 'line'|'dash'|'band'|'target'|'mark' }].
  function legend(items) {
    return h('ul', { className: 'chart-legend' }, items.map((it) => h('li', null, [
      h('span', { className: 'key key-' + (it.kind || 'line'), 'aria-hidden': 'true' }), it.text])));
  }

  // Hover and focus tooltips on a mark. lines: [value line, detail …].
  function hoverTip(f, node, lines) {
    node.addEventListener('mouseenter', () => f.show(lines, node));
    node.addEventListener('mouseleave', f.hide);
    node.addEventListener('focus', () => f.show(lines, node));
    node.addEventListener('blur', f.hide);
  }

  // Arrow keys move focus between items (one tab stop for the whole set).
  function roving(items, cols) {
    items.forEach((it, i) => {
      it.setAttribute('tabindex', i === 0 ? '0' : '-1');
      it.addEventListener('keydown', (e) => {
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols || 1, ArrowUp: -(cols || 1), Home: -i, End: items.length - 1 - i }[e.key];
        if (step === undefined) return;
        e.preventDefault();
        const j = Math.max(0, Math.min(items.length - 1, i + step));
        it.setAttribute('tabindex', '-1');
        items[j].setAttribute('tabindex', '0');
        items[j].focus();
      });
    });
  }

  // ---------- forecast line ----------

  // opts: { past: [{day, value}], future: [{day, value}], low, high, target, targetLabel, start, end, today,
  //         fmt(value) → text, dayText(day) → text, label (one sentence for screen readers), table }
  // Days are 'YYYY-MM-DD'; dayIndex turns them into numbers.
  function forecastChart(opts) {
    const W = 640, H = 240, L = 56, R = 16, T = 18, B = 30;
    const dayIndex = opts.dayIndex;
    const x0 = dayIndex(opts.start), x1 = Math.max(dayIndex(opts.end), x0 + 1);
    const all = opts.past.map((p) => p.value).concat(opts.future.map((p) => p.value), [opts.high || 0, opts.target || 0]);
    const top = niceMax(Math.max.apply(null, all.concat([1])) * 1.05);
    const X = scale(x0, x1, L, W - R), Y = scale(0, top, H - B, T);
    const f = frame({
      className: 'chart-line', table: opts.table,
      legend: legend([{ text: opts.pastLabel || 'So far', kind: 'line' }, { text: 'Forecast', kind: 'dash' },
        { text: 'Likely range', kind: 'band' }].concat(opts.target ? [{ text: 'Target', kind: 'target' }] : [])),
    });
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label, class: 'chart-svg', tabindex: '0' });
    // grid and y labels
    ticks(top).forEach((v, i) => {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: i === 0 ? 'axis' : 'grid' }));
      svg.appendChild(s('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick', text: i === 0 ? '0' : opts.fmtShort(v) }));
    });
    // x labels: start, today, end
    const xl = [[opts.start, 'start'], [opts.today, 'middle'], [opts.end, 'end']];
    xl.forEach(([d, anchor], i) => {
      if (i === 1 && (dayIndex(d) - x0 < 4 || x1 - dayIndex(d) < 4)) return;   // no room
      svg.appendChild(s('text', { x: X(dayIndex(d)), y: H - 8, 'text-anchor': anchor, class: 'tick',
        text: opts.dayText(d) + (i === 1 ? ' (today)' : '') }));
    });
    const now = opts.future.length ? opts.future[0] : opts.past[opts.past.length - 1];
    if (opts.target) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: Y(opts.target), y2: Y(opts.target), class: 'target' }));
      svg.appendChild(s('text', { x: L + 4, y: Y(opts.target) - 6, class: 'tick strong', text: opts.targetLabel || 'Target' }));
    }
    if (now && opts.future.length > 1 && opts.low !== null && opts.high !== null) {
      const nx = X(dayIndex(now.day)), ex = X(dayIndex(opts.end));
      svg.appendChild(s('polygon', { class: 'band', points: points([[nx, Y(now.value)], [ex, Y(opts.high)], [ex, Y(opts.low)]]) }));
    }
    if (now) svg.appendChild(s('line', { x1: X(dayIndex(now.day)), x2: X(dayIndex(now.day)), y1: T, y2: H - B, class: 'today' }));
    if (opts.past.length) {
      svg.appendChild(s('polyline', { class: 'past', points: points(opts.past.map((p) => [X(dayIndex(p.day)), Y(p.value)])) }));
    }
    if (opts.future.length > 1) {
      svg.appendChild(s('polyline', { class: 'future', points: points(opts.future.map((p) => [X(dayIndex(p.day)), Y(p.value)])) }));
      const last = opts.future[opts.future.length - 1];
      svg.appendChild(s('circle', { cx: X(dayIndex(last.day)), cy: Y(last.value), r: 5, class: 'dot-open' }));
    }
    if (now) svg.appendChild(s('circle', { cx: X(dayIndex(now.day)), cy: Y(now.value), r: 5, class: 'dot' }));

    // Crosshair: the pointer (or arrow keys) picks the nearest day; the tooltip lists what is known that day.
    const days = opts.past.map((p) => ({ day: p.day, lines: [opts.fmt(p.value), opts.dayText(p.day) + ': ' + (opts.pastLabel || 'so far').toLowerCase()] }))
      .concat(opts.future.slice(1).map((p, i, arr) => ({ day: p.day, lines: [opts.fmt(p.value), opts.dayText(p.day) + ': likely' +
        (i === arr.length - 1 && opts.low !== null ? ' (' + opts.fmt(opts.low) + ' – ' + opts.fmt(opts.high) + ')' : '')] })));
    const xs = days.map((d) => X(dayIndex(d.day)));
    const hair = s('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'hair', visibility: 'hidden' });
    svg.appendChild(hair);
    let at = days.length - 1;
    function point(i) {
      if (!days.length) return;
      at = Math.max(0, Math.min(days.length - 1, i));
      hair.setAttribute('x1', xs[at]); hair.setAttribute('x2', xs[at]); hair.setAttribute('visibility', 'visible');
      const box = svg.getBoundingClientRect();
      f.show(days[at].lines, { x: (xs[at] / W) * box.width, y: T / H * box.height });
    }
    const off = () => { hair.setAttribute('visibility', 'hidden'); f.hide(); };
    svg.addEventListener('mousemove', (e) => {
      const box = svg.getBoundingClientRect();
      point(nearest(xs, ((e.clientX - box.left) / box.width) * W));
    });
    svg.addEventListener('mouseleave', off);
    svg.addEventListener('focus', () => point(at));
    svg.addEventListener('blur', off);
    svg.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, Home: -1e6, End: 1e6 }[e.key];
      if (step === undefined) return;
      e.preventDefault();
      point(at + step);
    });
    f.plot.appendChild(svg);
    return f.wrap;
  }

  // ---------- horizontal bars ----------

  // opts: { rows: [{ label, value, max?, text, tip: [lines], strong }], max, mark: { value, label }, label, table }
  // Bars are HTML (a track and a fill); the team-average mark is a line across every track.
  function barChart(opts) {
    const max = opts.max || Math.max.apply(null, opts.rows.map((r) => r.value || 0).concat([1]));
    const f = frame({ className: 'chart-bars', table: opts.table,
      legend: opts.mark ? legend([{ text: opts.mark.label, kind: 'mark' }]) : null });
    const list = h('ul', { className: 'bars', 'aria-label': opts.label });
    const items = [];
    opts.rows.forEach((r) => {
      const fill = h('span', { className: 'bar-fill' + (r.strong ? ' strong' : '') + (r.value === null ? ' none' : '') });
      fill.style.width = r.value === null ? '0' : Math.max(0.5, Math.min(100, (r.value / max) * 100)) + '%';
      const track = h('span', { className: 'bar-track', 'aria-hidden': 'true' }, [fill]);
      if (opts.mark && opts.mark.value !== null && opts.mark.value !== undefined) {
        const m = h('span', { className: 'bar-mark' });
        m.style.left = Math.min(100, (opts.mark.value / max) * 100) + '%';
        track.appendChild(m);
      }
      const li = h('li', { className: 'bar-row', 'aria-label': r.label + ': ' + r.text }, [
        h('span', { className: 'bar-label', text: r.label }), track, h('span', { className: 'bar-value', text: r.text }),
      ]);
      hoverTip(f, li, r.tip || [r.text, r.label]);
      items.push(li);
      list.appendChild(li);
    });
    roving(items, 1);
    f.plot.appendChild(list);
    return f.wrap;
  }

  // ---------- heatmap ----------

  // opts: { rows: [label], cols: [label], cell(r, c) → { level 0-5 or null, text, tip: [lines] }, label, table,
  //         low, high (legend end texts) }
  function heatmap(opts) {
    const f = frame({ className: 'chart-heat', table: opts.table });
    const grid = h('div', { className: 'heat', role: 'grid', 'aria-label': opts.label });
    grid.style.gridTemplateColumns = '44px repeat(' + opts.cols.length + ', minmax(34px, 1fr))';
    const headRow = h('div', { className: 'heat-row', role: 'row' }, [h('span', { className: 'heat-corner', role: 'columnheader' })]
      .concat(opts.cols.map((c) => h('span', { className: 'heat-col', role: 'columnheader', text: c }))));
    grid.appendChild(headRow);
    const cells = [];
    opts.rows.forEach((rowLabel, ri) => {
      const row = h('div', { className: 'heat-row', role: 'row' }, [h('span', { className: 'heat-day', role: 'rowheader', text: rowLabel })]);
      opts.cols.forEach((colLabel, ci) => {
        const c = opts.cell(ri, ci);
        const cell = h('span', { className: 'heat-cell ' + (c.level === null ? 'lvl-none' : 'lvl-' + c.level), role: 'gridcell',
          'aria-label': rowLabel + ' ' + colLabel + ': ' + (c.tip || [c.text]).join(', '), text: c.text });
        hoverTip(f, cell, c.tip || [c.text]);
        cells.push(cell);
        row.appendChild(cell);
      });
      grid.appendChild(row);
    });
    roving(cells, opts.cols.length);
    f.plot.appendChild(h('div', { className: 'heat-scroll' }, [grid]));
    const scaleRow = h('div', { className: 'heat-scale', 'aria-hidden': 'true' }, [h('span', { text: opts.low || '' })]
      .concat([0, 1, 2, 3, 4, 5].map((l) => h('span', { className: 'heat-swatch lvl-' + l })), [h('span', { text: opts.high || '' }),
        h('span', { className: 'heat-swatch lvl-none' }), h('span', { text: 'too few calls' })]));
    f.plot.appendChild(scaleRow);
    return f.wrap;
  }

  return { niceMax, ticks, scale, points, nearest, forecastChart, barChart, heatmap, legend };
}));
