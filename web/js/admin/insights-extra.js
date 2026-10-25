'use strict';
/* Two cards for the Insights tab (js/admin/insights.js mounts them): the weekly brief and the script test.
   Not a tab of its own: the Insights module calls
     const brief = VectorInsightsExtra.mountWeeklyBrief(box, ctx, { campaignId });   brief.refresh(campaignId)
     const test  = VectorInsightsExtra.mountScriptTest(box, ctx, { campaignId });    test.setCampaign(campaignId)
   and handle.unmount() when the tab unmounts. Without a campaignId the script test shows its own campaign list.
   Server side (supabase/migrations/20261024100026_insights_extra.sql):
     admin_weekly_brief(p_campaign)   four plain lines; rupees only when the admin may see money
     admin_script_test(p_campaign)    the campaign's script versions and the running (or last) test with counts
     admin_start_script_test / admin_end_script_test   start; "Use vX for everyone" (publishes vX) or stop
   The script test is part of the Scripts add-on (my_features() has 'scripts'; a trial has everything).
   "How sure" is the chance that one version really gets more good results than the other (Bayesian, flat
   prior), worked out here from the counts. No winner is named before each version has MIN_CALLS picked-up
   calls. Styles: web/css/admin-insights-extra.css. The pure helpers are tested in
   tests/web/insights-extra.test.js (Node, no DOM). */
(function () {
  const MIN_CALLS = 50;   // picked-up calls each version needs before a winner is named
  const SURE = 0.9;       // how sure we must be to name a winner

  // ---------- pure helpers ----------

  // log of the gamma function (Lanczos), for whole and fractional x > 0.
  const LANCZOS = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function logGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    const z = x - 1;
    let a = 0.99999999999980993;
    const t = z + 7.5;
    for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
  }
  const logBeta = (a, b) => logGamma(a) + logGamma(b) - logGamma(a + b);

  // The chance that version B's true rate is higher than A's, with good results out of picked-up calls and a
  // flat prior: Beta(1 + good, 1 + calls - good) for each. Exact sum (Evan Miller), fine for thousands of calls.
  function probBBeatsA(goodA, callsA, goodB, callsB) {
    const gA = Math.max(0, Math.floor(Number(goodA) || 0)), nA = Math.max(gA, Math.floor(Number(callsA) || 0));
    const gB = Math.max(0, Math.floor(Number(goodB) || 0)), nB = Math.max(gB, Math.floor(Number(callsB) || 0));
    const aA = 1 + gA, bA = 1 + nA - gA, aB = 1 + gB, bB = 1 + nB - gB;
    const base = logBeta(aA, bA);
    let total = 0;
    for (let i = 0; i < aB; i++) {
      total += Math.exp(logBeta(aA + i, bA + bB) - Math.log(bB + i) - logBeta(1 + i, bB) - base);
    }
    return Math.min(1, Math.max(0, total));
  }

  // Good results per 100 calls, whole number; null without calls.
  function per100(good, calls) {
    const n = Number(calls) || 0;
    return n > 0 ? Math.round((Number(good) || 0) * 100 / n) : null;
  }

  // A chance as a percent for people: never "100% sure" or "0% sure".
  function surePercent(p) {
    return Math.min(99, Math.max(1, Math.round((Number(p) || 0) * 100)));
  }

  // '5m 40s', '6m', '45 sec'. '' when unknown.
  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || seconds === '') return '';
    const s = Math.round(Number(seconds));
    if (!Number.isFinite(s) || s < 0) return '';
    if (s < 60) return s + ' sec';
    const m = Math.floor(s / 60), r = s % 60;
    return r ? m + 'm ' + r + 's' : m + 'm';
  }

  // What the two arms say so far. arm: { version, picked_up, good }.
  // state: 'need_more' (fewer than min picked-up calls on a version), 'winner' or 'no_winner'.
  function testVerdict(a, b, opts) {
    const min = (opts && opts.minCalls) || MIN_CALLS;
    const sure = (opts && opts.sure) || SURE;
    const nA = Number(a && a.picked_up) || 0, nB = Number(b && b.picked_up) || 0;
    const gA = Number(a && a.good) || 0, gB = Number(b && b.good) || 0;
    const pB = probBBeatsA(gA, nA, gB, nB);
    const out = {
      state: 'no_winner', winner: null, leader: pB >= 0.5 ? 'b' : 'a', sure: Math.max(pB, 1 - pB), probB: pB,
      per100A: per100(gA, nA), per100B: per100(gB, nB),
      needA: Math.max(0, min - nA), needB: Math.max(0, min - nB),
    };
    if (out.needA > 0 || out.needB > 0) out.state = 'need_more';
    else if (pB >= sure) { out.state = 'winner'; out.winner = 'b'; }
    else if (1 - pB >= sure) { out.state = 'winner'; out.winner = 'a'; }
    return out;
  }

  // The two versions to offer when starting a test: A = the published version (else the second newest),
  // B = the newest other version. versions: [{ version, published }], any order. null with fewer than two.
  function defaultPair(versions) {
    const list = (versions || []).map((v) => ({ version: Number(v.version), published: !!v.published }))
      .filter((v) => Number.isInteger(v.version)).sort((x, y) => y.version - x.version);
    if (list.length < 2) return null;
    const pub = list.find((v) => v.published);
    const a = pub ? pub.version : list[1].version;
    const b = list.find((v) => v.version !== a).version;
    return { a, b };
  }

  // ---------- weekly brief ----------

  function mountWeeklyBrief(box, ctx, opts) {
    const S = ctx.helpers;
    const el = S.el;
    let campaign = (opts && opts.campaignId) || null;
    let seq = 0;
    const list = el('ol', { className: 'ix-brief-lines', id: 'ix-brief-lines' });
    const msg = el('p', { className: 'ix-brief-msg', id: 'ix-brief-msg', role: 'status' });
    const root = el('section', { className: 'ix-brief', 'aria-labelledby': 'ix-brief-title' }, [
      el('h2', { className: 'ix-brief-title', id: 'ix-brief-title', text: 'This week in 4 lines' }),
      el('p', { className: 'ix-brief-sub', text: 'Owners also get this by email every Monday morning.' }),
      list,
      msg,
    ]);
    box.appendChild(root);

    async function refresh(campaignId) {
      if (campaignId !== undefined) campaign = campaignId || null;
      const my = ++seq;
      list.textContent = '';
      S.say(msg, 'Loading the weekly brief…');
      let lines;
      try {
        lines = await ctx.rpc('admin_weekly_brief', { p_campaign: campaign });
      } catch (err) {
        if (my !== seq) return;
        S.say(msg, ctx.isMissing(err) ? 'The weekly brief is not set up on the server yet.'
          : 'Could not load the weekly brief: ' + err.message, true);
        return;
      }
      if (my !== seq) return;
      const shown = (Array.isArray(lines) ? lines : []).filter((l) => typeof l === 'string' && l.trim());
      shown.forEach((l) => list.appendChild(el('li', { text: l })));
      S.say(msg, shown.length ? '' : 'Nothing to report yet.');
    }

    refresh();
    return {
      refresh,
      unmount() { seq++; root.remove(); },
    };
  }

  // ---------- script test ----------

  function mountScriptTest(box, ctx, opts) {
    const S = ctx.helpers;
    const el = S.el;
    const ownPicker = !(opts && opts.campaignId);
    let campaign = (opts && opts.campaignId) || null;
    let data = null;
    let keepTesting = false;   // "Keep testing" hides the winner suggestion until the next load
    let seq = 0;
    let allowed = null;        // the Scripts add-on: null = not checked yet

    const picker = el('select', { id: 'ix-test-campaign' });
    const body = el('div', { className: 'ix-test-body', id: 'ix-test-body' });
    const msg = el('p', { className: 'msg', id: 'ix-test-msg', role: 'status' });
    const root = el('section', { className: 'panel ix-test', 'aria-labelledby': 'ix-test-title' }, [
      el('h2', { id: 'ix-test-title', text: 'Script test' }),
      ownPicker ? el('label', { className: 'ix-test-pick' }, ['Campaign', picker]) : null,
      body,
      msg,
    ]);
    box.appendChild(root);
    picker.addEventListener('change', () => setCampaign(picker.value));

    const say = (text, isError) => S.say(msg, text, isError);
    const v = (n) => 'v' + n;

    async function checkFeature() {
      if (allowed !== null) return allowed;
      try {
        const f = await ctx.rpc('my_features');
        allowed = Array.isArray(f) && f.includes('scripts');
      } catch (err) {
        allowed = ctx.isMissing(err) ? true : null;   // an older server has no add-ons; let the server decide
        if (allowed === null) throw err;
      }
      return allowed;
    }

    async function loadCampaigns() {
      const { data: rows, error } = await ctx.client.from('campaigns')
        .select('id, name, status, script_id').neq('status', 'closed').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      picker.textContent = '';
      picker.appendChild(el('option', { value: '', text: rows && rows.length ? 'Choose a calling list' : 'No calling lists yet' }));
      (rows || []).forEach((c) => picker.appendChild(el('option', { value: c.id, text: c.name })));
      if (campaign) picker.value = campaign;
    }

    async function start() {
      const my = ++seq;
      body.textContent = '';
      say('Loading…');
      try {
        if (!(await checkFeature())) {
          if (my !== seq) return;
          say('');
          body.appendChild(el('p', { className: 'ix-addon', text: 'Script tests are part of Scripts, an extra (paid). Add Scripts to use this.' }));
          return;
        }
        if (ownPicker) await loadCampaigns();
      } catch (err) {
        if (my === seq) say('Could not load: ' + err.message, true);
        return;
      }
      if (my !== seq) return;
      await load();
    }

    async function load() {
      const my = ++seq;
      if (allowed === false) return;
      body.textContent = '';
      if (!campaign) { say(''); body.appendChild(el('p', { className: 'muted', text: 'Choose a calling list to see or start a script test.' })); return; }
      say('Loading…');
      let out;
      try {
        out = await ctx.rpc('admin_script_test', { p_campaign: campaign });
      } catch (err) {
        if (my !== seq) return;
        say(ctx.isMissing(err) ? 'Script tests are not set up on the server yet.' : 'Could not load the script test: ' + err.message, true);
        return;
      }
      if (my !== seq) return;
      data = out || {};
      say('');
      render();
    }

    function setCampaign(id) {
      campaign = id || null;
      keepTesting = false;
      if (ownPicker && picker.value !== (campaign || '')) picker.value = campaign || '';
      if (allowed === null) start(); else load();
    }

    function render() {
      body.textContent = '';
      const c = data.campaign || {};
      const test = data.test || null;
      if (!c.script_id) {
        body.appendChild(el('p', { text: 'This calling list has no call script. Choose one in Calling first.' }));
        return;
      }
      if (test && test.status === 'running') renderRunning(c, test);
      else renderStart(c, test);
    }

    function renderStart(c, last) {
      if (last) {
        const when = S.formatDate(last.ended_at, { year: false });
        body.appendChild(el('p', { className: 'muted', id: 'ix-test-last', text: 'Last test: ' + v(last.version_a) + ' vs ' + v(last.version_b)
          + (when ? ', ended ' + when : '') + '. '
          + (last.winner ? v(last.winner) + ' was chosen for everyone.' : 'Stopped without a winner.') }));
      }
      const versions = data.versions || [];
      const pair = defaultPair(versions);
      if (!pair) {
        body.appendChild(el('p', { text: 'The script "' + (c.script_name || '') + '" has only one version. Save a changed version in Scripts, then test it here.' }));
        return;
      }
      body.appendChild(el('p', { text: 'Try two versions of "' + (c.script_name || 'the script') + '". Half of the leads hear each one, so you can see which gets more good results.' }));
      const label = (x) => v(x.version) + (x.published ? ' (in use)' : '') + (x.change_note ? ': ' + x.change_note : '');
      const selA = el('select', { id: 'ix-test-a' });
      const selB = el('select', { id: 'ix-test-b' });
      versions.forEach((x) => {
        selA.appendChild(el('option', { value: String(x.version), text: label(x) }));
        selB.appendChild(el('option', { value: String(x.version), text: label(x) }));
      });
      selA.value = String(pair.a);
      selB.value = String(pair.b);
      const go = el('button', { type: 'button', className: 'primary', id: 'ix-test-start', text: 'Start test' });
      go.addEventListener('click', () => {
        const a = Number(selA.value), b = Number(selB.value);
        if (a === b) { say('Choose two different versions.', true); return; }
        ctx.confirm({
          title: 'Start a script test?',
          text: 'Half of the leads in "' + (c.name || '') + '" will hear ' + v(a) + ' and half ' + v(b) + ', until you choose one.',
          button: 'Start test',
          run: () => ctx.rpc('admin_start_script_test', { p_campaign: campaign, p_version_a: a, p_version_b: b }),
          done: 'Script test started.',
          reload: load,
        });
      });
      body.appendChild(el('div', { className: 'row ix-test-form' }, [
        el('label', {}, ['Version A', selA]),
        el('label', {}, ['Version B', selB]),
        go,
      ]));
    }

    function renderRunning(c, test) {
      const arms = test.arms || [];
      const a = arms.find((x) => x.arm === 'a') || { version: test.version_a, picked_up: 0, good: 0 };
      const b = arms.find((x) => x.arm === 'b') || { version: test.version_b, picked_up: 0, good: 0 };
      const verdict = testVerdict(a, b);
      body.appendChild(el('h3', { id: 'ix-test-heading', text: v(a.version) + ' vs ' + v(b.version) }));
      body.appendChild(el('p', { className: 'muted', text: 'Half of the leads hear each version. Started '
        + S.formatDate(test.started_at, { year: false }) + '.' }));
      if (test.same_script === false) {
        body.appendChild(el('p', { className: 'ix-warn', text: 'This calling list now uses another call script, so the test is paused. Stop it and start a new one.' }));
      }

      const card = (arm, key) => {
        const won = verdict.state === 'winner' && verdict.winner === key;
        const n = Number(arm.picked_up) || 0;
        const p = key === 'a' ? verdict.per100A : verdict.per100B;
        return el('div', { className: 'ix-arm' + (won ? ' win' : ''), id: 'ix-arm-' + key }, [
          el('div', { className: 'ix-arm-head', text: v(arm.version) + ' · ' + S.count(n) + ' picked-up ' + (n === 1 ? 'call' : 'calls') }),
          el('div', { className: 'ix-arm-big', text: p === null ? '–' : String(p) }),
          el('div', { className: 'ix-arm-sub', text: 'good results per 100 calls' }),
          won ? el('div', { className: 'ix-arm-win', text: '✓ Winner, ' + surePercent(verdict.sure) + '% sure' }) : null,
        ]);
      };
      body.appendChild(el('div', { className: 'ix-arms' }, [card(a, 'a'), card(b, 'b')]));

      let line;
      if (verdict.state === 'need_more') {
        const needs = [];
        if (verdict.needA) needs.push(v(a.version) + ' needs ' + verdict.needA + ' more');
        if (verdict.needB) needs.push(v(b.version) + ' needs ' + verdict.needB + ' more');
        line = 'Not sure yet. Each version needs ' + MIN_CALLS + ' picked-up calls (' + needs.join(', ') + ').';
      } else if (verdict.state === 'winner') {
        const w = verdict.winner === 'a' ? a : b;
        line = v(w.version) + ' gets more good results. We are ' + surePercent(verdict.sure) + '% sure.';
      } else {
        const l = verdict.leader === 'a' ? a : b;
        line = 'No clear winner yet: ' + surePercent(verdict.sure) + '% sure ' + v(l.version) + ' is better. Keep testing.';
      }
      body.appendChild(el('p', { className: 'ix-verdict', id: 'ix-test-verdict', text: line }));

      const lenA = formatDuration(a.avg_seconds), lenB = formatDuration(b.avg_seconds);
      if (lenA && lenB) {
        body.appendChild(el('p', { text: 'Average call: ' + v(a.version) + ' ' + lenA + ', ' + v(b.version) + ' ' + lenB + '.' }));
      }
      [a, b].forEach((x) => {
        if (x.change_note) body.appendChild(el('p', { className: 'muted', text: 'Change in ' + v(x.version) + ': ' + x.change_note }));
      });

      const useFor = (arm, primary) => {
        const btn = el('button', { type: 'button', className: primary ? 'primary' : '', id: 'ix-use-' + arm.arm,
          text: 'Use ' + v(arm.version) + ' for everyone' });
        btn.addEventListener('click', () => ctx.confirm({
          title: 'Use ' + v(arm.version) + ' for everyone?',
          text: v(arm.version) + ' becomes the version in use of "' + (c.script_name || 'this script')
            + '". Every calling list with this script uses it from the next call, and the test ends.',
          button: 'Use ' + v(arm.version) + ' for everyone',
          run: () => ctx.rpc('admin_end_script_test', { p_test: test.id, p_winner: Number(arm.version) }),
          done: v(arm.version) + ' is now used for everyone.',
          reload: load,
        }));
        return btn;
      };
      const actions = el('div', { className: 'row ix-test-actions' });
      if (verdict.state === 'winner' && !keepTesting) {
        actions.appendChild(useFor(verdict.winner === 'a' ? a : b, true));
        const keep = el('button', { type: 'button', id: 'ix-keep', text: 'Keep testing' });
        keep.addEventListener('click', () => { keepTesting = true; render(); say('The test keeps running. Check again in a few days.'); });
        actions.appendChild(keep);
      } else {
        actions.appendChild(useFor(a, false));
        actions.appendChild(useFor(b, false));
      }
      const stop = el('button', { type: 'button', className: 'ix-stop', id: 'ix-stop', text: 'Stop test' });
      stop.addEventListener('click', () => ctx.confirm({
        title: 'Stop the script test?',
        text: 'Every lead will hear the version in use again (' + versionInUse() + '). Nothing else changes.',
        button: 'Stop test',
        danger: true,
        run: () => ctx.rpc('admin_end_script_test', { p_test: test.id, p_winner: null }),
        done: 'Script test stopped.',
        reload: load,
      }));
      actions.appendChild(stop);
      body.appendChild(actions);
    }

    function versionInUse() {
      const pub = (data.versions || []).find((x) => x.published);
      return pub ? v(pub.version) : 'no version is in use';
    }

    start();
    return {
      setCampaign,
      refresh: load,
      unmount() { seq++; root.remove(); },
    };
  }

  const api = {
    MIN_CALLS, SURE, logGamma, probBBeatsA, per100, surePercent, formatDuration, testVerdict, defaultPair,
    // browser only
    mountWeeklyBrief, mountScriptTest,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VectorInsightsExtra = api;
})();
