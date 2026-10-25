'use strict';
/* Insights tab of the admin app (web/admin.html), Phase A (docs/phase-a-plan.md, Sprint 11): per campaign, the
   forecast with "What closes the gap" and "Apply plan", What-if sliders, compare (last 7 days or an earlier
   campaign), best time to call with "Set call hours", where calls end, promises kept and caller coaching.
   The weekly brief and the script test come from js/admin/insights-extra.js (another module, loaded when it
   exists) into #insights-brief and #insights-abtest.
   Reads: admin_insights_setup, admin_insights_forecast, admin_insights_summary, admin_insights_best_time,
   admin_insights_call_ends, admin_insights_promises, admin_insights_coaching, admin_insights_step_coaching, and
   promises_vs_payments (Phase A.2: "Are promises kept?" is measured against the fee ledger when the campaign has
   leads linked to students, else on what callers reported).
   Writes: admin_apply_insights_plan, admin_set_call_hours, admin_set_campaign_goal, add_supervisor_note and,
   when the database has it, admin_assign_practice. The database checks the admin role on every call.
   Money: ₹ only when the server allows it (the forecast says kind 'amount'); otherwise counts. Paid amounts are
   "reported by caller". Where calls end and step coaching need the Scripts add-on.
   The maths is in js/insights-model.js; the charts in js/charts.js. Linkable: #insights?campaign=<id>. */
(function () {
  const S = window.VectorAdminShared;
  const M = window.InsightsModel;
  const C = window.VectorCharts;
  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const NOT_YET = 'Insights needs the latest database update. Ask the person who looks after Vector to apply it.';
  const PROMISE_TYPES = ['fees', 'renewal'];
  // insights-extra.js sits next to this file. Resolved now, while this script is the one running.
  const EXTRA_URL = (() => {
    try { return new URL('insights-extra.js', document.currentScript.src).href; } catch (err) { return null; }
  })();

  let ctx = null;
  let box = null;
  let setup = null;        // admin_insights_setup
  let campaign = null;     // the picked campaign (from setup.campaigns)
  let fc = null;           // admin_insights_forecast
  let base = null;         // InsightsModel.baseline(fc)
  let plan = null;         // What-if slider values
  let grid = null;         // the best-time grid shown
  let coachRows = [];
  let loadSeq = 0;
  let extras = null;       // the insights-extra module, once loaded

  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const button = (text, onClick, cls, id) => el('button', { type: 'button', text, onClick, className: cls || '', id: id || null });
  const pct = M.pctText;
  const hasScripts = () => !!(setup && (setup.features || []).includes('scripts'));
  const dayText = (d) => S.formatDate(d, { year: false });

  async function rpc(name, args) {
    try { return await ctx.rpc(name, args); } catch (err) {
      if (ctx.isMissing(err)) throw new Error(NOT_YET);
      throw err;
    }
  }
  function report(id, err) {
    say(id, err && err.message === NOT_YET ? NOT_YET : 'Could not load: ' + ((err && err.message) || 'Try again.'), err && err.message !== NOT_YET);
  }

  // Values in the forecast's unit: ₹ (short form) or a count with its name.
  function fmt(v) {
    if (!base) return '';
    if (base.kind === 'amount') return S.rupeesShort(v);
    return S.count(Math.round(v)) + ' ' + M.unitLabel(base.typeKey, base.kind);
  }
  const fmtShort = (v) => (base && base.kind === 'amount' ? S.rupeesShort(v) : S.count(Math.round(v)));

  // ---------- page ----------

  // Inside Today: the weekly brief and the forecast ("What closes the gap", "Apply plan") are open; everything else
  // (what-if, compare, best time, where calls end, promises kept, coaching, script test) is under "More analysis",
  // closed until the person opens it (#today?more=1 opens it, the old #insights link does too).
  function build() {
    box.appendChild(el('div', { className: 'row between ins-head' }, [
      el('h2', { id: 'ins-title', text: 'This week' }),
      el('div', { className: 'row ins-filters' }, [
        el('label', null, ['Calling list', el('select', { id: 'ins-campaign' })]),
      ]),
    ]));
    box.appendChild(msg('ins-msg'));
    box.appendChild(el('section', { id: 'insights-brief', className: 'ins-extra', 'aria-label': 'This week in 4 lines' }));
    box.appendChild(el('div', { id: 'ins-empty', className: 'panel soon', hidden: true }, [
      el('p', { text: 'No calling lists yet. Start one in Calling; the forecast shows here once calls come in.' }),
    ]));
    const body = el('div', { id: 'ins-body', className: 'ins-body', hidden: true });
    body.appendChild(el('section', { className: 'panel', id: 'ins-forecast', 'aria-labelledby': 'ins-forecast-title' }, [
      el('h2', { id: 'ins-forecast-title', text: 'Forecast' }), el('div', { id: 'ins-forecast-out' }), msg('ins-forecast-msg'),
    ]));
    const more = el('details', { id: 'ins-more', className: 'panel ins-more' }, [
      el('summary', { id: 'ins-more-toggle', text: 'More analysis' }),
      el('p', { className: 'muted small', text: 'What-if, comparisons, best time to call, where calls end, promises kept, coaching and script tests.' }),
    ]);
    more.appendChild(el('div', { className: 'ins-grid ins-grid-wide' }, [
      el('section', { className: 'panel', id: 'ins-whatif', 'aria-labelledby': 'ins-whatif-title' }, [
        el('h2', { id: 'ins-whatif-title', text: 'What if…' }),
        el('p', { className: 'muted small', text: 'Move the sliders. The forecast updates.' }),
        el('div', { id: 'ins-whatif-out' }), msg('ins-whatif-msg'),
      ]),
      el('section', { className: 'panel', id: 'ins-compare-panel', 'aria-labelledby': 'ins-compare-title' }, [
        el('div', { className: 'row between' }, [
          el('h2', { id: 'ins-compare-title', text: 'Compare' }),
          el('label', { className: 'ins-inline' }, ['With', el('select', { id: 'ins-compare' })]),
        ]),
        el('div', { id: 'ins-compare-out' }), msg('ins-compare-msg'),
      ]),
    ]));
    // The heatmap gets the wider column: 14 hours of cells need about 560px before they scroll.
    more.appendChild(el('div', { className: 'ins-grid ins-grid-wide' }, [
      el('section', { className: 'panel', id: 'ins-besttime', 'aria-labelledby': 'ins-besttime-title' }, [
        el('div', { className: 'row between' }, [
          el('h2', { id: 'ins-besttime-title', text: 'Best time to call: pickup rate' }),
          el('label', { className: 'ins-inline' }, ['Caller', el('select', { id: 'ins-heat-seat' })]),
        ]),
        el('div', { id: 'ins-besttime-out' }), msg('ins-besttime-msg'),
      ]),
      el('section', { className: 'panel', id: 'ins-ends', 'aria-labelledby': 'ins-ends-title' }, [
        el('h2', { id: 'ins-ends-title', text: 'Where calls end in the script' }), el('div', { id: 'ins-ends-out' }), msg('ins-ends-msg'),
      ]),
    ]));
    more.appendChild(el('div', { className: 'ins-grid' }, [
      el('section', { className: 'panel', id: 'ins-promises', 'aria-labelledby': 'ins-promises-title' }, [
        el('h2', { id: 'ins-promises-title', text: 'Are promises kept?' }), el('div', { id: 'ins-promises-out' }), msg('ins-promises-msg'),
      ]),
      el('section', { className: 'panel', id: 'ins-coaching', 'aria-labelledby': 'ins-coaching-title' }, [
        el('h2', { id: 'ins-coaching-title', text: 'Caller coaching' }), el('div', { id: 'ins-coaching-out' }), msg('ins-coaching-msg'),
      ]),
    ]));
    more.appendChild(el('section', { id: 'insights-abtest', className: 'ins-extra', 'aria-label': 'Script test' }));
    body.appendChild(more);
    box.appendChild(body);

    $('ins-campaign').addEventListener('change', () => pickCampaign($('ins-campaign').value, true));
    $('ins-compare').addEventListener('change', loadCompare);
    $('ins-heat-seat').addEventListener('change', loadBestTime);
  }

  // ---------- the other agent's cards (weekly brief, script test) ----------

  // insights-extra.js (window.VectorInsightsExtra, loaded by admin.html before this file) gives
  // mountWeeklyBrief(box, ctx, { campaignId }) -> { refresh(id), unmount } and
  // mountScriptTest(box, ctx, { campaignId }) -> { setCampaign(id), refresh, unmount }. Mounted once, after the
  // campaigns are loaded, on this tab's campaign (so the script test shows no picker of its own). Their ctx is
  // the shell's plus ctx.insights: campaign(), features(), money(), tab. A campaign change fires
  // 'insights:campaign' on the tab ({ detail: { campaign } }) and is passed on to both cards. A missing file is fine.
  let extraCards = [];
  function extraApi() {
    if (window.VectorInsightsExtra) return Promise.resolve(window.VectorInsightsExtra);
    if (!EXTRA_URL) return Promise.resolve(null);
    // Not on the page: load it once (it is a classic script that sets window.VectorInsightsExtra).
    return new Promise((resolve) => {
      const tag = document.createElement('script');
      tag.src = EXTRA_URL;
      tag.onload = () => resolve(window.VectorInsightsExtra || null);
      tag.onerror = () => resolve(null);
      document.head.appendChild(tag);
    });
  }
  function loadExtras() {
    if (extras) return;
    extras = 'loading';
    extraApi().then((mod) => {
      if (!box || !mod) { extras = null; return; }
      extras = mod;
      const x = Object.assign({}, ctx, { insights: {
        campaign: () => campaign,
        features: () => (setup && setup.features) || [],
        money: () => !!(setup && setup.money),
        tab: box,
      } });
      const opts = { campaignId: campaign ? campaign.id : null };
      const cards = [];
      if (typeof mod.mountWeeklyBrief === 'function') {
        try { cards.push({ card: mod.mountWeeklyBrief($('insights-brief'), x, opts), set: 'refresh' }); } catch (err) { /* that card only */ }
      }
      // Without a campaign the script test shows its own picker (it then has nothing to follow).
      if (typeof mod.mountScriptTest === 'function' && campaign) {
        try { cards.push({ card: mod.mountScriptTest($('insights-abtest'), x, opts), set: 'setCampaign' }); } catch (err) { /* that card only */ }
      }
      extraCards = cards.filter((c) => c.card);
      box.addEventListener('insights:campaign', (e) => {
        const id = e.detail && e.detail.campaign ? e.detail.campaign.id : null;
        extraCards.forEach((c) => { try { if (typeof c.card[c.set] === 'function') c.card[c.set](id); } catch (err) { /* that card only */ } });
      });
    }).catch(() => { extras = null; });
  }

  // ---------- setup and campaign ----------

  async function loadSetup(wanted) {
    say('ins-msg', 'Loading...');
    try {
      setup = await rpc('admin_insights_setup', { p_institute: ctx.institute.id });
    } catch (err) {
      report('ins-msg', err);
      return;
    }
    say('ins-msg', '');
    const list = (setup && setup.campaigns) || [];
    $('ins-empty').hidden = list.length > 0;
    $('ins-body').hidden = list.length === 0;
    const sel = $('ins-campaign');
    sel.textContent = '';
    list.forEach((c) => sel.appendChild(el('option', { value: c.id, text: c.name + (c.status !== 'running' ? ' (' + c.status + ')' : '') })));
    if (!list.length) { loadExtras(); return; }
    const first = list.find((c) => c.id === wanted) || list[0];
    sel.value = first.id;
    pickCampaign(first.id, false);
    loadExtras();   // after the first campaign is picked, so ctx.insights.campaign() has one
  }

  function pickCampaign(id, fromUser) {
    campaign = ((setup && setup.campaigns) || []).find((c) => c.id === id) || null;
    if (!campaign) return;
    if (fromUser) history.replaceState(null, '', location.pathname + location.search + S.buildHash('today', { campaign: id, more: $('ins-more').open ? '1' : null }));
    fillCompare();
    if (box) box.dispatchEvent(new CustomEvent('insights:campaign', { detail: { campaign } }));
    loadCampaign();
  }

  function fillCompare() {
    const sel = $('ins-compare');
    const keep = sel.value;
    sel.textContent = '';
    sel.appendChild(el('option', { value: 'last7', text: 'Last 7 days' }));
    (setup.campaigns || []).filter((c) => c.id !== campaign.id && c.call_type_key === campaign.call_type_key)
      .forEach((c) => sel.appendChild(el('option', { value: 'c:' + c.id, text: c.name })));
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'last7';
  }

  async function loadCampaign() {
    const seq = ++loadSeq;
    ['ins-forecast-out', 'ins-whatif-out', 'ins-besttime-out', 'ins-ends-out', 'ins-promises-out', 'ins-coaching-out', 'ins-compare-out']
      .forEach((id) => { $(id).classList.add('loading'); });
    const args = { p_institute: ctx.institute.id, p_campaign: campaign.id };
    // Coaching first: the caller list of the heatmap comes from it.
    await Promise.all([loadForecast(seq, args), loadCoaching(seq, args).then(() => fillSeats())]);
    if (seq !== loadSeq) return;
    await Promise.all([loadBestTime(), loadEnds(seq, args), loadPromises(seq, args), loadCompare()]);
  }

  const done = (id) => $(id).classList.remove('loading');

  // ---------- forecast and what-if ----------

  async function loadForecast(seq, args) {
    say('ins-forecast-msg', '');
    try {
      const data = await rpc('admin_insights_forecast', Object.assign({ p_tz: ctx.tz }, args));
      if (seq !== loadSeq) return;
      fc = data;
      base = M.baseline(data);
      plan = M.defaultPlan(base);
      renderForecast();
      renderWhatIf();
    } catch (err) {
      if (seq !== loadSeq) return;
      fc = null; base = null;
      $('ins-forecast-out').textContent = '';
      $('ins-whatif-out').textContent = '';
      report('ins-forecast-msg', err);
    } finally {
      if (seq === loadSeq) { done('ins-forecast-out'); done('ins-whatif-out'); }
    }
  }

  function forecastTitle() {
    const by = base.endDate ? ' by ' + dayText(base.endDate) : '';
    if (base.kind === 'amount') return 'Forecast: fees collected' + by;
    return 'Forecast: ' + M.unitLabel(base.typeKey, base.kind) + by;
  }

  function renderForecast() {
    const out = $('ins-forecast-out');
    out.textContent = '';
    $('ins-forecast-title').textContent = forecastTitle();
    const f = M.forecast(base, M.defaultPlan(base));
    out.appendChild(el('p', { className: 'muted small', text: 'Based on pace, pickup rate and promises kept. The range shows likely low to high.' }));
    const soFar = base.kind === 'amount'
      ? 'Paid so far: ' + S.rupees(base.current) + ' (' + S.REPORTED_BY_CALLER + ')'
      : 'So far: ' + fmt(base.current);
    if (fc.money_hidden) out.appendChild(el('p', { className: 'money-note', text: 'Money is hidden for you, so this counts payments instead of amounts.' }));

    if (f.reason === 'no_end') {
      out.appendChild(el('p', { text: soFar + '.' }));
      out.appendChild(el('p', { className: 'muted', text: 'Set an end date on the calling list to see a forecast.' }));
      return;
    }
    if (f.reason === 'no_data') {
      out.appendChild(el('p', { text: soFar + '.' }));
      out.appendChild(el('p', { className: 'ins-note', text: 'Not enough data yet: ' + S.count(base.calls) + ' of ' + M.MIN_CALLS +
        ' calls made. The forecast starts after ' + M.MIN_CALLS + ' calls.' }));
      return;
    }
    const pctOf = f.pct !== null ? ' · ' + pct(f.pct) + ' of target' : '';
    out.appendChild(el('div', { className: 'ins-hero' }, [
      el('div', { className: 'ins-big', text: fmt(f.likely) }),
      el('div', { className: 'muted small', text: 'likely (' + fmt(f.low) + ' – ' + fmt(f.high) + ')' + pctOf }),
      el('div', { className: 'small', text: soFar }),
    ]));

    const target = base.target;
    const targetLabel = !target ? null : base.typeKey !== 'fees' ? 'Target: ' + fmt(target)
      : base.kind === 'amount' ? 'Target: 90% of due (' + fmt(target) + ')' : 'Target: 90% of leads pay (' + fmt(target) + ')';
    const past = M.pastPath(base);
    const rows = past.map((p) => [dayText(p.day), fmt(p.value), '']).concat(f.path.slice(1).map((p) => [dayText(p.day), '', fmt(p.value)]));
    out.appendChild(C.forecastChart({
      past, future: f.path, low: f.low, high: f.high, target, targetLabel,
      start: base.startDate, end: base.endDate, today: base.today, dayIndex: M.dayNumber,
      fmt, fmtShort, dayText,
      pastLabel: base.kind === 'amount' ? 'Collected' : 'So far',
      label: (base.kind === 'amount' ? 'Fees collected' : 'Results') + ' so far: ' + fmt(base.current) + ' on ' + dayText(base.today) +
        '. Forecast about ' + fmt(f.likely) + ' by ' + dayText(base.endDate) + ', likely ' + fmt(f.low) + ' to ' + fmt(f.high) + '.' +
        (targetLabel ? ' ' + targetLabel + '.' : ''),
      table: { caption: 'Range by the end date: ' + fmt(f.low) + ' – ' + fmt(f.high) + (targetLabel ? '. ' + targetLabel : ''),
        head: ['Day', base.kind === 'amount' ? 'Collected' : 'So far', 'Likely'], rows, num: [1, 2] },
    }));

    if (!target && base.typeKey !== 'fees') out.appendChild(goalForm());
    else if (target) out.appendChild(gapBox(f));
  }

  // A goal for campaigns that are not fees, so the forecast has a target.
  function goalForm() {
    const input = el('input', { id: 'ins-goal', type: 'number', min: '1', max: '1000000', step: '1', inputmode: 'numeric' });
    const form = el('form', { className: 'row ins-goal' }, [
      el('label', null, ['Goal: ' + M.unitLabel(base.typeKey, base.kind) + ' by the end date', input]),
      el('button', { type: 'submit', text: 'Save goal' }),
    ]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < 1) { say('ins-forecast-msg', 'Enter a whole number, 1 or more.', true); return; }
      try {
        await rpc('admin_set_campaign_goal', { p_campaign: campaign.id, p_goal: n });
        campaign.goal = n;
        say('ins-forecast-msg', 'Goal saved.');
        loadForecast(loadSeq, { p_institute: ctx.institute.id, p_campaign: campaign.id });
      } catch (err) { say('ins-forecast-msg', err.message, true); }
    });
    return form;
  }

  function suggestionText(s) {
    if (s.id === 'broken') return 'Call the ' + S.count(s.count) + ' broken promise' + (s.count === 1 ? '' : 's') + ' first';
    if (s.id === 'evening') return 'Make ' + pct(s.share) + ' of calls at 7–9 pm (pickup ' + pct(s.pickupEvening) + ', other hours ' + pct(s.pickupDay) + ')';
    if (s.id === 'calls') return 'Add ' + S.count(s.extraCalls) + ' calls a day' + (s.reaches ? ' (reaches the target)' : '');
    return 'Add a caller (' + s.callers + ' in all)';
  }

  // "Short by …" and "What closes the gap", with a Try button that moves the What-if sliders.
  function gapBox(f) {
    const wrap = el('div', { className: 'ins-gap' });
    if (f.gap <= 0) {
      wrap.classList.add('ok');
      wrap.appendChild(el('p', { text: 'On track: likely to reach the target' + (f.reachDate ? ' on ' + dayText(f.reachDate) : '') + '.' }));
      return wrap;
    }
    wrap.appendChild(el('p', null, [el('strong', { text: 'Short by ' + fmt(f.gap) + '.' }), ' What closes the gap:']));
    const list = M.gapSuggestions(base, M.defaultPlan(base));
    if (!list.length) {
      wrap.appendChild(el('p', { className: 'muted small', text: 'No change we can measure closes it. Check the target and the end date.' }));
      return wrap;
    }
    wrap.appendChild(el('ul', { className: 'ins-gap-list' }, list.map((s) => el('li', null, [
      el('span', { text: suggestionText(s) }),
      el('span', { className: 'ins-gain', text: '+' + fmt(s.gain) }),
      s.plan ? button('Try', () => { plan = Object.assign({}, s.plan); renderWhatIf(); $('ins-whatif').scrollIntoView({ block: 'nearest' }); }, 'ins-try') : null,
    ]))));
    wrap.appendChild(el('p', { className: 'muted small', text: 'Try moves the What-if sliders. Apply plan saves them on the calling list.' }));
    return wrap;
  }

  function slider(id, label, value, min, max, stepVal, onInput, valueText) {
    const input = el('input', { id, type: 'range', min: String(min), max: String(max), step: String(stepVal), value: String(value) });
    const out = el('output', { for: id, text: valueText(value) });
    input.setAttribute('aria-valuetext', valueText(value));
    input.addEventListener('input', () => {
      onInput(Number(input.value));
      out.textContent = valueText(Number(input.value));
      input.setAttribute('aria-valuetext', out.textContent);
      renderWhatIfResult();
    });
    return el('label', { className: 'ins-slider' }, [el('span', null, [label + ': ', out]), input]);
  }

  function renderWhatIf() {
    const out = $('ins-whatif-out');
    out.textContent = '';
    if (!base) return;
    const f0 = M.forecast(base);
    if (!f0.ok) {
      out.appendChild(el('p', { className: 'muted', text: f0.reason === 'no_end'
        ? 'What-if needs an end date on the calling list.' : 'What-if starts after ' + M.MIN_CALLS + ' calls.' }));
      return;
    }
    const maxCallers = Math.max(10, base.callers * 2);
    const maxPer = Math.max(80, Math.ceil(base.perCaller * 2 / 10) * 10);
    out.appendChild(slider('ins-wi-callers', 'Callers on this list', plan.callers, 1, maxCallers, 1,
      (v) => { plan.callers = v; }, (v) => (v === base.callers ? String(v) : base.callers + ' → ' + v)));
    out.appendChild(slider('ins-wi-per', 'Calls per caller per day', Math.round(plan.perCaller), 1, maxPer, 1,
      (v) => { plan.perCaller = v; }, (v) => String(v)));
    const eve = slider('ins-wi-evening', 'Evening calls (7–9 pm)', Math.round(plan.eveningShare * 100), 0, 100, 5,
      (v) => { plan.eveningShare = v / 100; }, (v) => v + '%');
    out.appendChild(eve);
    if (!base.eveningKnown) out.appendChild(el('p', { className: 'muted small', text: 'Not enough evening calls yet to tell if evenings pick up more.' }));
    out.appendChild(el('div', { id: 'ins-wi-result', className: 'ins-result', 'aria-live': 'polite' }));
    out.appendChild(el('div', { className: 'actions' }, [
      button('Apply plan', applyPlan, 'primary', 'ins-apply'),
      button('Reset', () => { plan = M.defaultPlan(base); renderWhatIf(); }),
    ]));
    if (campaign.plan && campaign.plan.applied_at) {
      out.appendChild(el('p', { className: 'muted small', text: 'Last plan applied ' + S.formatDateTime(campaign.plan.applied_at) + ': ' +
        campaign.plan.callers + ' callers × ' + campaign.plan.calls_per_caller + ' calls a day.' }));
    }
    renderWhatIfResult();
  }

  function renderWhatIfResult() {
    const box2 = $('ins-wi-result');
    if (!box2) return;
    const f = M.forecast(base, plan);
    box2.textContent = '';
    box2.appendChild(el('div', { className: 'muted small', text: 'New forecast' }));
    box2.appendChild(el('div', { className: 'ins-big', text: fmt(f.likely) + (f.pct !== null ? ' · ' + pct(f.pct) : '') }));
    let when = 'No target set.';
    if (base.target) {
      if (f.reachDate && f.reachesBeforeEnd) when = 'Reaches target on ' + dayText(f.reachDate) + '.';
      else if (f.reachDate) when = 'Does not reach the target by ' + dayText(base.endDate) + ' (would on ' + dayText(f.reachDate) + ').';
      else when = 'Does not reach the target by ' + dayText(base.endDate) + '.';
    }
    box2.appendChild(el('div', { className: 'small', text: when }));
    box2.appendChild(el('div', { className: 'muted small', text: S.count(Math.round(M.paceFor(base, plan))) + ' calls a day for the calling list.' }));
  }

  // Saves the What-if values: callers (a note), the daily target and, when evening calls go up and the best-time
  // card has enough data, its call hours.
  function applyPlan() {
    const callers = Math.round(plan.callers);
    const per = Math.max(1, Math.round(plan.perCaller));
    const daily = Math.max(1, Math.min(10000, callers * per));
    const hours = plan.eveningShare > base.eveningShare + 0.04 && grid ? M.callHoursFromGrid(grid, ctx.tz) : null;
    ctx.confirm({
      title: 'Apply this plan to ' + campaign.name + '?',
      text: 'Daily target: ' + S.count(daily) + ' calls (' + callers + ' callers × ' + per + ' calls). ' +
        (hours ? 'Call hours: ' + M.callHoursText(hours) + '. ' : 'Call hours stay as they are. ') +
        'The number of callers is saved as a note; add people to the list in Calling.',
      button: 'Apply plan',
      run: () => rpc('admin_apply_insights_plan', { p_campaign: campaign.id, p_callers: callers, p_calls_per_caller: per,
        p_evening_share: Math.round(plan.eveningShare * 100) / 100, p_daily_target: daily, p_call_hours: hours }),
      done: 'Plan applied to ' + campaign.name + '.',
      after: () => {
        campaign.daily_target = daily;
        campaign.plan = { callers, calls_per_caller: per, evening_share: plan.eveningShare, applied_at: new Date().toISOString() };
        if (hours) campaign.call_hours = hours;
        renderWhatIf();
        renderBestTimeTip();
      },
    });
  }

  // ---------- compare ----------

  async function loadCompare() {
    if (!campaign) return;
    const out = $('ins-compare-out');
    const v = $('ins-compare').value || 'last7';
    say('ins-compare-msg', '');
    const seq = loadSeq;
    const call = (camp, from, to) => rpc('admin_insights_summary', { p_institute: ctx.institute.id, p_campaign: camp,
      p_from: from, p_to: to, p_tz: ctx.tz }).then((r) => (Array.isArray(r) ? r[0] : r) || {});
    try {
      let a, b, la, lb;
      if (v === 'last7') {
        const now = new Date();
        const d7 = new Date(now.getTime() - 7 * 864e5), d14 = new Date(now.getTime() - 14 * 864e5);
        [a, b] = await Promise.all([call(campaign.id, d7.toISOString(), now.toISOString()), call(campaign.id, d14.toISOString(), d7.toISOString())]);
        la = 'Last 7 days'; lb = 'The 7 days before';
      } else {
        const other = (setup.campaigns || []).find((c) => 'c:' + c.id === v);
        if (!other) return;
        [a, b] = await Promise.all([call(campaign.id, null, null), call(other.id, null, null)]);
        la = campaign.name; lb = other.name;
      }
      if (seq !== loadSeq) return;
      out.textContent = '';
      const rows = M.compare(a, b);
      const show = (r, val) => (val === null ? '–' : r.unit === 'pct' ? pct(val) : String(Math.round(val * 10) / 10));
      const change = (r) => {
        if (r.delta === null) return '–';
        const d = r.unit === 'pct' ? Math.round(r.delta * 100) : Math.round(r.delta * 10) / 10;
        if (d === 0) return 'same';
        return (d > 0 ? '▲ +' : '▼ ') + d + (r.unit === 'pct' ? ' points' : '');
      };
      out.appendChild(el('div', { className: 'scroll' }, [el('table', { className: 'stack ins-compare' }, [
        el('thead', null, [el('tr', null, [el('th', { text: '' }), el('th', { text: la, className: 'num' }), el('th', { text: lb, className: 'num' }), el('th', { text: 'Change', className: 'num' })])]),
        el('tbody', null, rows.map((r) => el('tr', null, [
          el('th', { scope: 'row', text: r.label }),
          el('td', { className: 'num', 'data-label': la, text: show(r, r.a) }),
          el('td', { className: 'num', 'data-label': lb, text: show(r, r.b) }),
          el('td', { className: 'num ' + (r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''), 'data-label': 'Change', text: change(r) }),
        ]))),
      ])]));
      out.appendChild(el('p', { className: 'muted small', text: S.count(Number(a.calls) || 0) + ' calls against ' + S.count(Number(b.calls) || 0) + '.' }));
    } catch (err) {
      if (seq === loadSeq) report('ins-compare-msg', err);
    } finally {
      if (seq === loadSeq) done('ins-compare-out');
    }
  }

  // ---------- best time to call ----------

  function fillSeats() {
    const sel = $('ins-heat-seat');
    const keep = sel.value;
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: 'All callers' }));
    coachRows.forEach((r) => sel.appendChild(el('option', { value: r.seat_id, text: r.label })));
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
  }

  async function loadBestTime() {
    if (!campaign) return;
    const seq = loadSeq;
    const out = $('ins-besttime-out');
    say('ins-besttime-msg', '');
    try {
      const seat = $('ins-heat-seat').value || null;
      const rows = (await rpc('admin_insights_best_time', { p_institute: ctx.institute.id, p_campaign: campaign.id, p_seat: seat, p_tz: ctx.tz })) || [];
      if (seq !== loadSeq) return;
      out.textContent = '';
      grid = M.heatGrid(rows);
      if (!grid.total) { grid = null; out.appendChild(el('p', { className: 'muted', text: 'No calls yet.' })); return; }
      const rates = grid.cells().filter((c) => c.rate !== null).map((c) => c.rate);
      const lo = rates.length ? Math.min(...rates) : 0, hi = rates.length ? Math.max(...rates) : 1;
      out.appendChild(el('p', { className: 'muted small', text: 'From ' + S.count(grid.total) + ' calls. Stronger colour = more people pick up. Times are ' + ctx.tz + '.' }));
      const cols = grid.hours.map((hr) => M.hourText(hr).replace(' ', ''));
      const table = { head: ['Day'].concat(cols), num: grid.hours.map((_, i) => i + 1),
        rows: grid.days.map((d) => [M.dayName(d)].concat(grid.hours.map((hr) => { const c = grid.cell(d, hr); return c.calls ? (c.rate === null ? c.calls + ' calls' : pct(c.rate)) : ''; }))) };
      out.appendChild(C.heatmap({
        rows: grid.days.map(M.dayName), cols, label: 'Pickup rate by day and hour', table, low: pct(lo), high: pct(hi),
        cell: (ri, ci) => {
          const c = grid.cell(grid.days[ri], grid.hours[ci]);
          const where = M.dayName(c.dow) + ' ' + M.hourText(c.hour);
          if (c.rate === null) return { level: null, text: '', tip: [c.calls ? 'Too few calls' : 'No calls', where + ': ' + c.calls + ' calls'] };
          return { level: M.level(c.rate, lo, hi), text: pct(c.rate), tip: [pct(c.rate) + ' picked up', where + ': ' + c.calls + ' calls'] };
        },
      }));
      out.appendChild(el('div', { id: 'ins-besttime-tip' }));
      renderBestTimeTip();
    } catch (err) {
      if (seq === loadSeq) { out.textContent = ''; grid = null; report('ins-besttime-msg', err); }
    } finally {
      if (seq === loadSeq) done('ins-besttime-out');
    }
  }

  function renderBestTimeTip() {
    const tipBox = $('ins-besttime-tip');
    if (!tipBox || !grid) return;
    tipBox.textContent = '';
    const tip = M.heatTip(grid);
    const hours = M.callHoursFromGrid(grid, ctx.tz);
    tipBox.appendChild(el('p', { className: 'small' }, [el('strong', { text: 'Tip: ' }),
      tip || 'Not enough calls in any hour yet (5 or more an hour are needed).']));
    tipBox.appendChild(el('p', { className: 'muted small', text: 'Call hours now: ' + M.callHoursText(campaign.call_hours) + '.' }));
    if (hours) {
      tipBox.appendChild(el('div', { className: 'actions' }, [button('Set call hours', () => setCallHours(hours), '', 'ins-set-hours')]));
    }
  }

  function setCallHours(hours) {
    ctx.confirm({
      title: 'Set call hours for ' + campaign.name + '?',
      text: 'Callers will be asked to call at: ' + M.callHoursText(hours) + '. These are the hours where pickup is at or above the average' +
        ($('ins-heat-seat').value ? ' for this caller' : '') + '.',
      button: 'Set call hours',
      run: () => rpc('admin_set_call_hours', { p_campaign: campaign.id, p_call_hours: hours }),
      done: 'Call hours saved.',
      after: () => { campaign.call_hours = hours; renderBestTimeTip(); },
    });
  }

  // ---------- where calls end ----------

  function addOn(out, text) {
    out.appendChild(el('div', { className: 'ins-addon' }, [
      el('p', null, [el('strong', { text: 'Add Scripts to use this. ' }), text]),
    ]));
  }

  async function loadEnds(seq, args) {
    const out = $('ins-ends-out');
    say('ins-ends-msg', '');
    try {
      out.textContent = '';
      if (!hasScripts()) { addOn(out, 'See the script step where calls end, and fix that step.'); return; }
      if (!campaign.script_id) { out.appendChild(el('p', { className: 'muted', text: 'This calling list has no call script.' })); return; }
      const rows = (await rpc('admin_insights_call_ends', args)) || [];
      if (seq !== loadSeq) return;
      const r = M.callEnds(rows);
      if (!r.total) { out.appendChild(el('p', { className: 'muted', text: 'No picked-up calls yet.' })); return; }
      out.appendChild(el('p', { className: 'muted small', text: S.count(r.total) + ' calls picked up. The share of calls that ended at each step.' }));
      out.appendChild(C.barChart({
        label: 'Where calls end, by script step', max: 1,
        rows: r.rows.map((x) => ({ label: x.label, value: x.share, text: pct(x.share), strong: x === r.top,
          tip: [pct(x.share) + ' of calls', x.label + ': ' + S.count(x.calls) + ' calls'] })),
        table: { head: ['Step', 'Calls', 'Share'], num: [1, 2], rows: r.rows.map((x) => [x.label, S.count(x.calls), pct(x.share)]) },
      }));
      if (r.top && r.top.share >= 0.25 && r.top.step) {
        out.appendChild(el('p', { className: 'small' }, [el('strong', { text: 'Tip: ' }),
          'Most calls end at the ' + r.top.label + ' step (' + pct(r.top.share) + '). Look at what callers say there.']));
      }
    } catch (err) {
      if (seq === loadSeq) report('ins-ends-msg', err);
    } finally {
      if (seq === loadSeq) done('ins-ends-out');
    }
  }

  // ---------- promises ----------

  async function loadPromises(seq, args) {
    const out = $('ins-promises-out');
    say('ins-promises-msg', '');
    try {
      out.textContent = '';
      if (!PROMISE_TYPES.includes(campaign.call_type_key)) {
        out.appendChild(el('p', { className: 'muted', text: 'Promises are tracked on fees and renewal calling lists.' }));
        return;
      }
      // Phase A.2: when the campaign's leads are linked to the fee ledger, a promise is kept when the payment is in
      // the ledger (promises_vs_payments). Otherwise, as before, when a later call reported it paid.
      let pvp = null;
      try { pvp = await ctx.rpc('promises_vs_payments', { p_campaign: campaign.id }); } catch (err) { pvp = null; }
      if (seq !== loadSeq) return;
      const lp = M.ledgerPromises(pvp);
      const rows = lp ? lp.buckets : (await rpc('admin_insights_promises', Object.assign({ p_tz: ctx.tz }, args))) || [];
      if (seq !== loadSeq) return;
      const r = M.promiseBuckets(rows);
      const method = el('p', { className: 'ins-method small', id: 'ins-promises-method', 'data-method': lp ? 'ledger' : 'calls' });
      if (lp) {
        method.textContent = 'Measured against Paid (office): a promise is kept when the fees office records the payment by ' +
          (Number(pvp.grace_days) || 2) + ' days after the promised date. ' + S.count(lp.kept) + ' kept, ' +
          S.count(lp.partPaid) + ' partly paid, ' + S.count(lp.broken) + ' broken, ' + S.count(lp.waiting) + ' still waiting.' +
          (lp.noStudent ? ' ' + S.count(lp.noStudent) + ' promises are not linked to a student, so they are not counted.' : '');
      } else {
        method.textContent = 'Measured on what callers reported: a promise is kept when a later call says it was ' +
          (campaign.call_type_key === 'fees' ? 'paid' : 'renewed') + '. This calling list has nobody linked to a student in Fees.';
      }
      out.appendChild(method);
      out.appendChild(el('p', { className: 'muted small', text: (campaign.call_type_key === 'fees' ? 'Paid' : 'Renewed') +
        ' by the promised date, by how far away the date was. ' + S.count(r.judged) + ' promises with the date passed.' }));
      if (!r.judged) { out.appendChild(el('p', { className: 'muted', text: 'No promise dates have passed yet.' })); return; }
      out.appendChild(C.barChart({
        label: 'Promises kept by days away', max: 1,
        rows: r.rows.map((x) => ({ label: x.bucket, value: x.rate, text: x.rate === null ? '–' : pct(x.rate),
          tip: [x.rate === null ? 'No promises' : pct(x.rate) + ' kept', x.bucket + ': ' + x.kept + ' of ' + x.promises + (x.waiting ? ', ' + x.waiting + ' waiting' : '')] })),
        table: { head: ['Days away', 'Promises', 'Kept', 'Share kept', 'Date still ahead'], num: [1, 2, 3, 4],
          rows: r.rows.map((x) => [x.bucket, x.promises, x.kept, x.rate === null ? '–' : pct(x.rate), x.waiting]) },
      }));
      out.appendChild(el('p', { className: 'small' }, [el('strong', { text: 'Tip: ' }),
        r.tip || 'Ask callers to get a date within 7 days. The script can suggest "Can you pay by Friday?"']));
    } catch (err) {
      if (seq === loadSeq) report('ins-promises-msg', err);
    } finally {
      if (seq === loadSeq) done('ins-promises-out');
    }
  }

  // ---------- coaching ----------

  async function loadCoaching(seq, args) {
    const out = $('ins-coaching-out');
    say('ins-coaching-msg', '');
    try {
      const [rows, steps] = await Promise.all([
        rpc('admin_insights_coaching', args),
        hasScripts() ? rpc('admin_insights_step_coaching', args).catch(() => []) : Promise.resolve(null),
      ]);
      if (seq !== loadSeq) return;
      coachRows = rows || [];
      out.textContent = '';
      const c = M.coaching(coachRows);
      if (!c.rows.length) { out.appendChild(el('p', { className: 'muted', text: 'No callers on this list yet.' })); return; }
      out.appendChild(el('p', { className: 'muted small', text: 'Good results per 100 picked-up calls. Line = team average' + (c.team !== null ? ' (' + c.team + ')' : '') + '.' }));
      const max = Math.max(10, c.team || 0, ...c.rows.map((r) => r.per100 || 0));
      out.appendChild(C.barChart({
        label: 'Good results per 100 picked-up calls, by caller', max, mark: c.team !== null ? { value: c.team, label: 'Team average' } : null,
        rows: c.rows.map((r) => ({ label: r.label, value: r.per100, text: r.per100 === null ? 'few calls' : String(r.per100),
          tip: [r.per100 === null ? 'Fewer than ' + c.minPicked + ' picked-up calls' : r.per100 + ' per 100', r.label + ': ' + r.good + ' good of ' + r.picked + ' picked up, ' + r.calls + ' calls'] })),
        table: { head: ['Caller', 'Calls', 'Picked up', 'Good', 'Per 100 picked up'], num: [1, 2, 3, 4],
          rows: c.rows.map((r) => [r.label, r.calls, r.picked, r.good, r.per100 === null ? '–' : r.per100]) },
      }));
      if (steps === null) {
        addOn(out, 'See steps each caller skips and the time they spend on each step.');
        return;
      }
      const tips = M.stepTips(steps || []);
      const tipList = el('div', { className: 'ins-tips' });
      tips.forEach((t) => tipList.appendChild(coachTip(t)));
      if (tips.length) out.appendChild(tipList);
      const team = M.teamSteps(steps || []).filter((s) => s.secs !== null);
      if (team.length) {
        out.appendChild(el('h3', { className: 'ins-sub', text: 'Time per step (team average)' }));
        const maxSecs = Math.max(...team.map((s) => s.secs), 1);
        out.appendChild(C.barChart({
          label: 'Average time per script step for the team', max: maxSecs,
          rows: team.map((s) => ({ label: s.stepLabel, value: s.secs, text: M.durationText(s.secs),
            tip: [M.durationText(s.secs), s.stepLabel + ': reached in ' + pct(s.passShare) + ' of timed calls'] })),
          table: { head: ['Step', 'Average time', 'Reached in'], num: [1, 2], rows: team.map((s) => [s.stepLabel, M.durationText(s.secs), pct(s.passShare)]) },
        }));
      } else if (!tips.length) {
        out.appendChild(el('p', { className: 'muted small', text: 'Step times show here once callers use the script on calls.' }));
      }
    } catch (err) {
      if (seq === loadSeq) { coachRows = []; out.textContent = ''; report('ins-coaching-msg', err); }
    } finally {
      if (seq === loadSeq) done('ins-coaching-out');
    }
  }

  // One coaching tip with "Add a note" and, when practice mode exists, "Send to practice mode".
  function coachTip(t) {
    const card = el('div', { className: 'ins-tip' }, [el('p', { text: t.text + (t.kind === 'skip'
      ? ' Callers who pass this step usually get more good results.' : ' People may hang up before the next step.') })]);
    const actions = el('div', { className: 'actions' });
    actions.appendChild(button('Add a note for ' + t.label, () => noteForm(card, t)));
    if (setup.practice_available && campaign.script_id) {
      actions.appendChild(button('Send ' + t.label + ' to practice mode', () => ctx.confirm({
        title: 'Send ' + t.label + ' to practice mode?',
        text: t.label + ' will be asked to walk the ' + campaign.name + ' script with a pretend lead. Nothing is dialled or counted.',
        button: 'Send to practice',
        run: () => rpc('admin_assign_practice', { p_seat: t.seatId, p_script: campaign.script_id }),
        done: t.label + ' will see practice mode next time they open Vector.',
      })));
    }
    card.appendChild(actions);
    return card;
  }

  function noteForm(card, t) {
    if (card.querySelector('form')) { card.querySelector('textarea').focus(); return; }
    const id = 'ins-note-' + t.seatId;
    const area = el('textarea', { id, maxlength: '1000', rows: '3' });
    area.value = t.text;
    const status = el('p', { className: 'msg', role: 'status' });
    const form = el('form', { className: 'ins-note-form' }, [
      el('label', { for: id, text: 'Note for ' + t.label + ' (today)' }), area,
      el('div', { className: 'actions' }, [el('button', { type: 'submit', className: 'primary', text: 'Save note' }), button('Cancel', () => form.remove())]),
      status,
    ]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = area.value.trim();
      if (!text) { say(status, 'Write a note first.', true); return; }
      try {
        await rpc('add_supervisor_note', { p_seat: t.seatId, p_day: S.ymd(new Date()), p_note: text });
        form.remove();
        ctx.status('Note saved for ' + t.label + '. It shows on the Callers tab.');
      } catch (err) { say(status, err.message, true); }
    });
    card.appendChild(form);
    area.focus();
  }

  S.registerTab({
    id: 'insights',
    label: 'Insights',
    part: true,   // shown inside Today (js/admin/today.js)
    mount(container, c) {
      ctx = c;
      box = container;
      build();
    },
    show(params) {
      if (params && params.more === '1') $('ins-more').open = true;
      const wanted = params && params.campaign;
      if (!setup) { loadSetup(wanted); return; }
      if (wanted && (!campaign || campaign.id !== wanted) && (setup.campaigns || []).some((x) => x.id === wanted)) {
        $('ins-campaign').value = wanted;
        pickCampaign(wanted, false);
      }
    },
    unmount() {
      loadSeq++;
      ctx = null; box = null; setup = null; campaign = null; fc = null; base = null; plan = null; grid = null;
      extraCards.forEach((c) => { try { if (typeof c.card.unmount === 'function') c.card.unmount(); } catch (err) { /* gone anyway */ } });
      coachRows = []; extras = null; extraCards = [];
    },
  });
})();
