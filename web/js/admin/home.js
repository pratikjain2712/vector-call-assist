'use strict';
/* Home tab of the admin app (web/admin.html): the day's numbers, callers right now, what needs attention and
   campaign progress (docs/phase-a-plan.md, Sprint 10, and "From the mockup review").
   Reads admin_home_summary(p_day, p_campaign) (migration 20261024100023), which checks the admin and counts
   days in the institute's time zone, and admin_home_ledger(p_day, p_campaign) (20261025150000, Phase A.2): money
   collected in the fee ledger, promises due today not yet paid in the ledger, follow-ups returned to the pool
   today. Without the ledger function (or a ledger) the fees tile shows what callers reported, as before. Numbers refresh every 60 seconds while this tab is open and the
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

  const DAY_WORD = { today: 'today', yesterday: 'yesterday', week: 'this week' };

  // Whether admin_home_ledger says the institute keeps a fee ledger (then money received comes from it).
  const hasLedger = (led) => !!(led && led.has_ledger);

  // The fees tile. With a fee ledger: "Collected today (ledger)" from ledger payments, and "Promised today
  // (calls)" from the calls, kept apart. Without one: what callers reported, as before.
  // t: admin_home_summary tiles; led: admin_home_ledger (or null); money: ₹ may be shown.
  // Returns { label, value, sub, note } or null when there is nothing about fees to show.
  function feesTile(t, led, day, money) {
    const tt = t || {};
    const word = DAY_WORD[day] || 'today';
    if (hasLedger(led)) {
      const col = led.collected || {};
      const showMoney = money && col.amount !== null && col.amount !== undefined;
      const promisedMoney = money && tt.promised_amount !== null && tt.promised_amount !== undefined;
      return {
        label: 'Collected ' + word + ' (ledger)',
        value: showMoney ? S.rupees(col.amount) : plural(col.payments || 0, 'payment', 'payments'),
        sub: 'Promised ' + word + ' (calls): ' + (promisedMoney ? S.rupees(tt.promised_amount)
          : plural(tt.promised_calls || 0, 'promise', 'promises')),
        note: 'Collected is from the fee ledger. Promised is ' + S.REPORTED_BY_CALLER + '.',
      };
    }
    if (!tt.has_fees) return null;
    if (money && tt.paid_amount !== null && tt.paid_amount !== undefined) {
      return { label: 'Fees collected', value: S.rupees(tt.paid_amount), sub: S.rupees(tt.promised_amount || 0) + ' promised', note: S.REPORTED_BY_CALLER };
    }
    return { label: 'Fees: paid', value: plural(tt.paid_calls || 0, 'call', 'calls'),
      sub: plural(tt.promised_calls || 0, 'promise', 'promises'), note: S.REPORTED_BY_CALLER };
  }

  // Why follow-ups went back to the pool today: '2 callers idle, 1 caller removed'.
  function releasedDetail(rel) {
    const r = rel || {};
    const parts = [];
    if (Number(r.idle) > 0) parts.push(plural(r.idle, 'because the caller had not called for a day', 'because their callers had not called for a day'));
    if (Number(r.revoked) > 0 || Number(r.inactive) > 0) {
      parts.push(plural((Number(r.revoked) || 0) + (Number(r.inactive) || 0), 'because the caller was removed', 'because their callers were removed'));
    }
    if (Number(r.admin) > 0) parts.push(plural(r.admin, 'by an admin', 'by an admin'));
    return parts.length ? parts.join(', ') + '. Any caller can pick them up now.' : 'Any caller can pick them up now.';
  }

  // The "Needs your attention" list, in a fixed order: promises due today, follow-ups back in the pool today,
  // phones offline, script steps where many calls end, callers idle 45 min or more. Each item:
  // { key, text, detail, tab, params, link }.
  // opts.canSeeMoney: show the ₹ total of the promises (when the server sent one).
  // opts.ledger: admin_home_ledger. With a fee ledger, the promises item counts promises due today that are not
  // yet paid in the ledger (instead of every promise due today).
  function attentionItems(summary, opts) {
    const o = opts || {};
    const out = [];
    const sm = summary || {};
    const due = sm.promises_due_today || {};
    const led = o.ledger || null;
    if (hasLedger(led)) {
      const un = led.promises_due_unpaid || {};
      if (Number(un.count) > 0) {
        const amount = o.canSeeMoney && un.amount !== null && un.amount !== undefined ? S.rupees(un.amount) : '';
        out.push({
          key: 'promises',
          text: plural(un.count, 'promise due today is', 'promises due today are') + ' not yet paid in the ledger.',
          detail: amount ? amount + ' still to pay.' : '',
          tab: 'reports', params: { report: 'fees' }, link: 'See list',
        });
      }
    } else if (Number(due.count) > 0) {
      const amount = o.canSeeMoney && due.amount !== null && due.amount !== undefined ? S.rupees(due.amount) : '';
      out.push({
        key: 'promises',
        text: plural(due.count, 'fee promise is', 'fee promises are') + ' due today.',
        detail: amount ? amount + ' in total, ' + S.REPORTED_BY_CALLER + '.' : '',
        tab: 'reports', params: { report: 'fees' }, link: 'See list',
      });
    }
    const rel = led && led.released_today;
    if (rel && Number(rel.count) > 0) {
      out.push({
        key: 'released',
        text: plural(rel.count, 'follow-up', 'follow-ups') + ' returned to the pool today.',
        detail: releasedDetail(rel),
        tab: 'callers', params: null, link: 'See callers',
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
    attentionItems, campaignProgress, feesTile, releasedDetail };
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
  let ledger = null;    // admin_home_ledger (Phase A.2), null when the database does not have it

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
      // The ledger numbers never stop Home: a database without admin_home_ledger (or an error) shows the rest.
      const [data, led] = await Promise.all([
        ctx.rpc('admin_home_summary', { p_day: day, p_campaign: campaign }),
        ctx.rpc('admin_home_ledger', { p_day: day, p_campaign: campaign }).catch(() => null),
      ]);
      if (mine !== seq || !ctx) return;
      lastLoad = Date.now();
      summary = data || {};
      ledger = led && typeof led === 'object' ? led : null;
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
    // ₹ only when both the server and the shell say this admin may see money.
    const fees = feesTile(t, ledger, day, ctx.canSeeMoney);
    if (fees) {
      const node = tile(fees.label, fees.value, fees.sub, fees.note);
      node.id = 'home-fees-tile';
      wrap.appendChild(node);
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
    const items = attentionItems(summary, { canSeeMoney: ctx.canSeeMoney, ledger });
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
      ledger = null;
    },
  });
})();
