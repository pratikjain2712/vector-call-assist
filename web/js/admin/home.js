'use strict';
/* Home tab of the admin app (web/admin.html): the day's numbers, callers right now, what needs attention and
   campaign progress (docs/phase-a-plan.md, Sprint 10, and "From the mockup review").
   Reads one RPC, admin_home_summary(p_day, p_campaign) (migration 20261024100023), which checks the admin and
   counts days in the institute's time zone. Numbers refresh every 60 seconds while this tab is open and the
   browser tab is visible; a hidden page does not poll and catches up when it is shown again.
   Money: ₹ amounts come back only when the server allows it (can_see_money), and are shown only when
   ctx.canSeeMoney too; paid and promised amounts carry "reported by caller". Otherwise counts only.
   The pure helpers below are also loaded by tests/web/admin-home.test.js (Node, no DOM). */
(function () {
  const S = (typeof window !== 'undefined' && window.VectorAdminShared) || require('./shared.js');

  // ---------- pure helpers ----------

  const REFRESH_MS = 60 * 1000;
  const IDLE_ALERT_MIN = 45;    // "a caller idle 45 min" in Needs your attention
  const DAYS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week']];
  const BEFORE = { today: 'yesterday', yesterday: 'the day before', week: 'last week' };

  // Seconds as '9h 40m', '58m' or '45s'. '—' for nothing.
  function duration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (!s) return '—';
    if (s < 60) return s + 's';
    const m = Math.round(s / 60);
    const h = Math.floor(m / 60);
    return h ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m + 'm';
  }

  // Minutes as '45 min' or '1h 05m'.
  function minutes(n) {
    const m = Math.max(0, Math.round(Number(n) || 0));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  // Whole percent of part in whole, or null when whole is 0.
  function percent(part, whole) {
    const w = Number(whole) || 0;
    return w > 0 ? Math.round(100 * (Number(part) || 0) / w) : null;
  }

  // '12% more than yesterday', '5% fewer than last week', 'Same as yesterday', '' when there is nothing to compare.
  function changeText(now, before, day) {
    const b = Number(before) || 0;
    const n = Number(now) || 0;
    const than = BEFORE[day] || 'before';
    if (!b) return n ? 'No calls ' + (day === 'week' ? 'last week' : than) + ' by this time' : '';
    const p = Math.round(100 * (n - b) / b);
    if (p === 0) return 'Same as ' + than;
    return Math.abs(p) + '% ' + (p > 0 ? 'more' : 'fewer') + ' than ' + than;
  }

  // What a caller is doing now: { text, level } where level is ok | warn | danger | muted.
  function statusInfo(now) {
    const st = now && now.status;
    if (st === 'on_call') return { text: 'On a call', level: 'ok' };
    if (st === 'ready') return { text: 'Ready', level: 'ok' };
    if (st === 'idle') return { text: 'No calls for ' + minutes(now.idle_minutes), level: 'warn' };
    if (st === 'phone_offline') return { text: 'Phone offline', level: 'danger' };
    return { text: 'No calls today', level: 'muted' };
  }

  // [{label: 'Paid', count: 5}, …] as '5 paid · 4 will pay on date'. '—' when empty.
  function resultsText(results) {
    const list = (results || []).filter((r) => r && r.label && Number(r.count) > 0);
    if (!list.length) return '—';
    return list.map((r) => S.count(r.count) + ' ' + String(r.label).toLowerCase()).join(' · ');
  }

  const plural = (n, one, many) => S.count(n) + ' ' + (Number(n) === 1 ? one : many);

  // The "Needs your attention" list, in a fixed order: promises due today, phones offline, script steps where
  // many calls end, callers idle 45 min or more. Each item: { key, text, detail, tab, params, link }.
  // opts.canSeeMoney: show the ₹ total of the promises (when the server sent one).
  function attentionItems(summary, opts) {
    const o = opts || {};
    const out = [];
    const sm = summary || {};
    const due = sm.promises_due_today || {};
    if (Number(due.count) > 0) {
      const amount = o.canSeeMoney && due.amount !== null && due.amount !== undefined ? S.rupees(due.amount) : '';
      out.push({
        key: 'promises',
        text: plural(due.count, 'fee promise is', 'fee promises are') + ' due today.',
        detail: amount ? amount + ' in total, ' + S.REPORTED_BY_CALLER + '.' : '',
        tab: 'reports', params: { report: 'fees' }, link: 'See list',
      });
    }
    (sm.callers || []).forEach((c) => {
      if (c.now && c.now.status === 'phone_offline') {
        const since = c.now.since ? S.formatTime(c.now.since) : '';
        out.push({
          key: 'phone-' + c.seat_id,
          text: c.label + '\'s phone is offline.',
          detail: (since ? 'Since ' + since + '. ' : '') + 'Calls cannot start.',
          tab: 'callers', params: { seat: c.seat_id }, link: 'Open caller',
        });
      }
    });
    (sm.script_ends || []).forEach((e) => {
      const step = e.step_label || String(e.step || '').replace(/[_-]+/g, ' ');
      out.push({
        key: 'script-' + e.script_id,
        text: e.script_name + ': ' + Math.round(Number(e.share) * 100) + '% of picked-up calls end at the ' + step + ' step.',
        detail: 'Last 7 days, ' + plural(e.picked_up, 'call', 'calls') + ' picked up.',
        tab: 'reports', params: { script: e.script_id }, link: 'Open report',
      });
    });
    (sm.callers || []).forEach((c) => {
      if (c.now && c.now.status === 'idle' && Number(c.now.idle_minutes) >= IDLE_ALERT_MIN) {
        out.push({
          key: 'idle-' + c.seat_id,
          text: c.label + ' has made no calls for ' + minutes(c.now.idle_minutes) + '.',
          detail: '',
          tab: 'callers', params: { seat: c.seat_id }, link: 'Open caller',
        });
      }
    });
    return out;
  }

  // '173 of 240 leads called · ends 31 Oct' and the bar's percent.
  function campaignProgress(c) {
    const total = Number(c.leads_total) || 0;
    const called = Number(c.leads_called) || 0;
    const end = c.end_date ? 'ends ' + S.formatDate(c.end_date, { year: false }) : 'no end date';
    return {
      pct: percent(called, total) || 0,
      text: S.count(called) + ' of ' + S.count(total) + ' leads called · ' + end + (c.status === 'paused' ? ' · paused' : ''),
    };
  }

  const helpers = { REFRESH_MS, IDLE_ALERT_MIN, DAYS, duration, minutes, percent, changeText, statusInfo, resultsText,
    attentionItems, campaignProgress };
  if (typeof module !== 'undefined' && module.exports) { module.exports = helpers; return; }

  // ---------- the tab (browser only) ----------

  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);

  let ctx = null;
  let box = null;
  let timer = null;
  let seq = 0;
  let lastLoad = 0;
  let summary = null;

  const cell = (text, cls, label) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || '', 'data-label': label || null });

  function build() {
    box.appendChild(el('div', { className: 'tab-head' }, [
      el('h1', { id: 'home-title', text: 'Today' }),
      el('p', { className: 'muted', text: 'Live numbers from all callers. Updates every minute.' }),
    ]));
    box.appendChild(el('form', { id: 'home-filters', className: 'row home-filters' }, [
      el('label', null, ['Day', el('select', { id: 'home-day' }, DAYS.map((d) => el('option', { value: d[0], text: d[1] })))]),
      el('label', null, ['Campaign', el('select', { id: 'home-campaign' }, [el('option', { value: '', text: 'All campaigns' })])]),
      el('button', { type: 'button', id: 'home-refresh', text: 'Refresh now' }),
    ]));
    box.appendChild(el('p', { id: 'home-msg', className: 'msg', role: 'status' }));
    box.appendChild(el('div', { id: 'home-tiles', className: 'home-tiles' }));

    box.appendChild(el('div', { className: 'panel', id: 'home-now' }, [
      el('div', { className: 'row between' }, [
        el('h2', { text: 'Callers right now' }),
        el('a', { href: S.buildHash('callers'), text: 'All callers' }),
      ]),
      el('div', { className: 'scroll' }, [el('table', { className: 'stack' }, [
        el('thead', null, [el('tr', null, [['Caller'], ['Campaign'], ['Calls', 'num'], ['Target', 'num'], ['Talk', 'num'], ['Results'], ['Status']]
          .map((c) => el('th', { text: c[0], className: c[1] || '' })))]),
        el('tbody', { id: 'home-callers-body' }),
      ])]),
      el('p', { id: 'home-callers-empty', className: 'muted', hidden: true, text: 'No callers yet. Add them on the Callers tab.' }),
    ]));

    box.appendChild(el('div', { className: 'home-split' }, [
      el('div', { className: 'panel', id: 'home-attention' }, [
        el('h2', { text: 'Needs your attention' }),
        el('ul', { id: 'home-attention-list', className: 'plain home-attention-list' }),
        el('p', { id: 'home-attention-empty', className: 'muted', hidden: true, text: 'Nothing needs you right now.' }),
      ]),
      el('div', { className: 'panel', id: 'home-campaigns' }, [
        el('h2', { text: 'Campaigns' }),
        el('ul', { id: 'home-campaigns-list', className: 'plain home-campaigns-list' }),
        el('p', { id: 'home-campaigns-empty', className: 'muted', hidden: true, text: 'No running campaigns.' }),
      ]),
    ]));
    box.appendChild(el('p', { id: 'home-updated', className: 'muted small' }));
  }

  function wire() {
    $('home-day').addEventListener('change', () => load());
    $('home-campaign').addEventListener('change', () => load());
    $('home-refresh').addEventListener('click', () => load());
    $('home-filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });
    document.addEventListener('visibilitychange', onVisibility);
    timer = setInterval(tick, REFRESH_MS);
  }

  const visible = () => !!box && !box.hidden && !document.hidden;

  // Every minute: reload only while the tab and the page are visible.
  function tick() { if (visible()) load(); }
  function onVisibility() { if (visible() && Date.now() - lastLoad >= REFRESH_MS) load(); }

  async function load() {
    if (!ctx) return;
    const mine = ++seq;
    const day = $('home-day').value || 'today';
    const campaign = $('home-campaign').value || null;
    if (!summary) say('home-msg', 'Loading...');
    try {
      const data = await ctx.rpc('admin_home_summary', { p_day: day, p_campaign: campaign });
      if (mine !== seq || !ctx) return;
      lastLoad = Date.now();
      summary = data || {};
      render(day);
      say('home-msg', '');
    } catch (err) {
      if (mine !== seq || !ctx) return;
      if (ctx.isMissing(err)) say('home-msg', 'Home numbers are not available yet. Ask your Vector contact to update the database.', false);
      else say('home-msg', 'Could not load the numbers: ' + err.message, true);
    }
  }

  function render(day) {
    $('home-title').textContent = (DAYS.find((d) => d[0] === day) || DAYS[0])[1];
    fillCampaigns(summary.campaign_choices || []);
    renderTiles(day);
    renderCallers();
    renderAttention();
    renderProgress();
    $('home-updated').textContent = 'Updated ' + S.formatTime(new Date()) +
      (summary.time_zone ? '. Days are counted in ' + summary.time_zone + '.' : '.');
  }

  function fillCampaigns(list) {
    const sel = $('home-campaign');
    const keep = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    list.forEach((c) => sel.appendChild(el('option', { value: c.id, text: c.name + (c.status === 'closed' ? ' (closed)' : '') })));
    sel.value = list.some((c) => c.id === keep) ? keep : '';
  }

  function tile(label, value, sub, extra) {
    return el('div', { className: 'home-tile' }, [
      el('div', { className: 'home-tile-label', text: label }),
      el('div', { className: 'home-tile-value', text: value }),
      sub ? el('div', { className: 'home-tile-sub', text: sub }) : null,
      extra ? el('div', { className: 'money-note', text: extra }) : null,
    ]);
  }

  function renderTiles(day) {
    const t = summary.tiles || {};
    const wrap = $('home-tiles');
    wrap.textContent = '';
    const picked = percent(t.picked_up, t.calls);
    wrap.appendChild(tile('Calls made', S.count(t.calls || 0), changeText(t.calls, t.calls_before, day)));
    wrap.appendChild(tile('Picked up', picked === null ? '—' : picked + '%',
      S.count(t.picked_up || 0) + ' of ' + S.count(t.calls || 0) + ' calls'));
    wrap.appendChild(tile('Talk time', duration(t.talk_seconds),
      Number(t.picked_up) > 0 ? duration(Number(t.talk_seconds) / Number(t.picked_up)) + ' per call picked up' : ''));
    if (t.has_sales) {
      wrap.appendChild(tile('Sales: joined', S.count(t.joined || 0), S.count(t.interested || 0) + ' more interested'));
    }
    if (t.has_fees) {
      // ₹ only when both the server and the shell say this admin may see money.
      const money = ctx.canSeeMoney && t.paid_amount !== null && t.paid_amount !== undefined;
      if (money) {
        wrap.appendChild(tile('Fees collected', S.rupees(t.paid_amount),
          S.rupees(t.promised_amount || 0) + ' promised', S.REPORTED_BY_CALLER));
      } else {
        wrap.appendChild(tile('Fees: paid', plural(t.paid_calls || 0, 'call', 'calls'),
          plural(t.promised_calls || 0, 'promise', 'promises'), S.REPORTED_BY_CALLER));
      }
    }
  }

  function renderCallers() {
    const body = $('home-callers-body');
    body.textContent = '';
    const list = summary.callers || [];
    $('home-callers-empty').hidden = list.length > 0;
    list.forEach((c) => {
      const st = statusInfo(c.now);
      body.appendChild(el('tr', null, [
        el('td', { 'data-label': 'Caller' }, [el('a', { href: S.buildHash('callers', { seat: c.seat_id }), text: c.label })]),
        cell((c.campaigns || []).join(', ') || '—', '', 'Campaign'),
        cell(S.count(c.calls || 0), 'num', 'Calls'),
        cell(c.target ? S.count(c.target) : '—', 'num', 'Target'),
        cell(duration(c.talk_seconds), 'num', 'Talk'),
        cell(resultsText(c.results), '', 'Results'),
        el('td', { 'data-label': 'Status' }, [el('span', { className: 'home-status ' + st.level, text: st.text })]),
      ]));
    });
  }

  function renderAttention() {
    const list = $('home-attention-list');
    list.textContent = '';
    const items = attentionItems(summary, { canSeeMoney: ctx.canSeeMoney });
    $('home-attention-empty').hidden = items.length > 0;
    items.forEach((it) => {
      list.appendChild(el('li', { className: 'home-alert', 'data-key': it.key }, [
        el('div', null, [
          el('strong', { text: it.text }),
          it.detail ? el('span', { className: 'muted', text: ' ' + it.detail }) : null,
        ]),
        el('button', { type: 'button', text: it.link, onClick: () => ctx.navigate(it.tab, it.params) }),
      ]));
    });
  }

  function renderProgress() {
    const list = $('home-campaigns-list');
    list.textContent = '';
    const camps = summary.campaigns || [];
    $('home-campaigns-empty').hidden = camps.length > 0;
    camps.forEach((c) => {
      const p = campaignProgress(c);
      const fill = el('div', { className: 'home-bar-fill' });
      fill.style.width = Math.min(100, p.pct) + '%';   // a DOM property, allowed by the page's CSP
      list.appendChild(el('li', { className: 'home-campaign' }, [
        el('div', { className: 'row between' }, [el('strong', { text: c.name }), el('span', { text: p.pct + '%' })]),
        el('div', { className: 'home-bar', role: 'img', 'aria-label': p.pct + '% of leads called' }, [fill]),
        el('div', { className: 'muted small', text: p.text }),
      ]));
    });
  }

  S.registerTab({
    id: 'home',
    label: 'Home',
    mount(container, c) {
      ctx = c;
      box = container;
      summary = null;
      lastLoad = 0;
      build();
      wire();
      load();
    },
    // Opening the tab again after a while reloads at once instead of waiting for the next minute.
    show() { if (ctx && lastLoad && Date.now() - lastLoad >= REFRESH_MS) load(); },
    unmount() {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisibility);
      seq++;
      ctx = null;
      box = null;
      summary = null;
    },
  });
})();
