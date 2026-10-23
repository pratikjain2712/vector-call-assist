'use strict';
/* Reports tab of the admin app (web/admin.html): results by outcome for a date range, the team activity CSV,
   the weekly summary (with its CSV), and script results: where calls of one script version ended and what went
   wrong on lost calls, with suggested changes the admin approves or rejects. Moved here from the old admin page
   and from the script editor's report panel.
   Reads: admin_results_by_outcome, admin_team_activity, admin_weekly_summary, admin_script_report,
   admin_loss_insights; write: admin_decide_suggestion. The database checks the admin role on every call.
   Linkable: #reports?script=<script id>&version=<version id> opens script results for that version.
   No money here yet; Fees reports must follow the money rules (ctx.canSeeMoney). */
(function () {
  const S = window.VectorAdminShared;
  const A = window.VectorAdminHelpers;
  const T = window.VectorAdminTeamHelpers;
  const M = window.ScriptModel;
  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const REASON_LABEL = {
    price: 'Price', timing: 'Timing', already_enrolled: 'Already enrolled', no_need: 'No need',
    wrong_person: 'Wrong person', other: 'Other', not_recorded: 'Not recorded',
  };

  let ctx = null;
  let outcomes = [];
  let weeklyRows = [];
  let scripts = [];       // { id, name }
  let versions = [];      // { id, version, published } of the picked script
  let loadSeq = 0;
  let weekSeq = 0;
  let scriptSeq = 0;

  const cell = (text, cls, label) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || '', 'data-label': label || null });
  const field = (text, input) => el('label', null, [text + ' ', input]);
  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const pretty = (s) => String(s).replace(/_/g, ' ');
  const pct = (share) => (share == null ? '' : (Math.round(Number(share) * 1000) / 10) + '%');
  const stageLabel = (s) => (s === 'not_recorded' ? '(not recorded)' : s);

  async function rpc(name, args) {
    try { return await ctx.rpc(name, args); } catch (err) {
      if (ctx.isMissing(err)) throw new Error(T.NOT_YET);
      throw err;
    }
  }
  function report(id, err, prefix) {
    if (err && err.message === T.NOT_YET) say(id, T.NOT_YET, false);
    else say(id, (prefix || '') + (err && err.message ? err.message : 'Try again.'), true);
  }

  // ---------- page ----------

  function build(box) {
    box.appendChild(el('div', { className: 'tab-head' }, [
      el('h1', { text: 'Reports' }),
      el('p', { className: 'muted', text: 'Results of your calls. Download them to open in Excel.' }),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'results' }, [
      el('div', { className: 'row between' }, [
        el('h2', { text: 'Results by outcome' }),
        el('button', { type: 'button', id: 'csv', text: 'Download team activity (CSV)' }),
      ]),
      el('form', { id: 'results-form', className: 'row' }, [
        field('From', el('input', { id: 'results-from', type: 'date', required: true })),
        field('To', el('input', { id: 'results-to', type: 'date', required: true })),
        el('button', { type: 'submit', text: 'Show' }),
        el('button', { type: 'button', id: 'results-last7', text: 'Last 7 days' }),
      ]),
      msg('results-msg'),
      el('div', { className: 'scroll' }, [el('table', null, [
        el('thead', null, [el('tr', { id: 'outcome-head' })]),
        el('tbody', { id: 'outcome-body' }),
      ])]),
      el('p', { id: 'outcome-empty', className: 'muted', hidden: true, text: 'No outcomes in this range.' }),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'weekly' }, [
      el('div', { className: 'row between' }, [
        el('h2', { text: 'Weekly summary' }),
        el('button', { type: 'button', id: 'week-csv', text: 'Download CSV' }),
      ]),
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

    box.appendChild(el('div', { className: 'panel', id: 'script-results' }, [
      el('h2', { text: 'Script results' }),
      el('p', { className: 'muted', text: 'Where calls ended for one version of a script, and why calls were lost.' }),
      el('form', { id: 'sr-form', className: 'row wrap' }, [
        field('Script', el('select', { id: 'sr-script' })),
        field('Version', el('select', { id: 'sr-version' })),
        field('From', el('input', { id: 'sr-from', type: 'date', required: true })),
        field('To', el('input', { id: 'sr-to', type: 'date', required: true })),
        el('button', { type: 'submit', text: 'Run report' }),
      ]),
      msg('sr-msg'),
      el('div', { id: 'report-out' }),
      el('div', { id: 'insights-out', className: 'insights', 'aria-live': 'polite' }),
    ]));
  }

  function wire() {
    $('results-form').addEventListener('submit', (e) => { e.preventDefault(); loadResults(); });
    $('results-last7').addEventListener('click', () => {
      const d = A.lastNDays(new Date(), 7);
      $('results-from').value = d.from;
      $('results-to').value = d.to;
      loadResults();
    });
    $('csv').addEventListener('click', downloadTeamCsv);
    $('week-form').addEventListener('submit', (e) => { e.preventDefault(); loadWeek(); });
    $('week-start').addEventListener('change', snapWeek);
    $('week-csv').addEventListener('click', downloadWeekCsv);
    $('sr-script').addEventListener('change', () => pickScript($('sr-script').value));
    $('sr-form').addEventListener('submit', (e) => { e.preventDefault(); runScriptReport(); });
  }

  // ---------- results by outcome and the team activity CSV ----------

  function range(idFrom, idTo, msgId) {
    try { return A.rangeToTimestamps($(idFrom).value, $(idTo).value); } catch (err) {
      say(msgId, err.message, true);
      return null;
    }
  }

  async function loadResults() {
    const r = range('results-from', 'results-to', 'results-msg');
    if (!r) return;
    const seq = ++loadSeq;
    say('results-msg', 'Loading...');
    try {
      const o = await ctx.rpc('admin_results_by_outcome', { p_institute: ctx.institute.id, p_from: r.from, p_to: r.to });
      if (seq !== loadSeq) return;
      outcomes = o || [];
      renderOutcomes();
      say('results-msg', 'Showing ' + $('results-from').value + ' to ' + $('results-to').value + '.');
    } catch (err) {
      if (seq === loadSeq) say('results-msg', 'Could not load: ' + err.message, true);
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

  // Loads the team activity of the chosen range and downloads it, one row per rep and day.
  async function downloadTeamCsv() {
    const r = range('results-from', 'results-to', 'results-msg');
    if (!r) return;
    const btn = $('csv');
    btn.disabled = true;
    try {
      const team = (await ctx.rpc('admin_team_activity', { p_institute: ctx.institute.id, p_from: r.from, p_to: r.to, p_tz: ctx.tz })) || [];
      if (!team.length) { say('results-msg', 'No calls in this range, so nothing to download.', true); return; }
      S.download(A.toCsv(A.TEAM_HEADERS, A.teamCsvRows(team)),
        'vector-team-activity-' + $('results-from').value + '-to-' + $('results-to').value + '.csv');
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
    const seq = ++weekSeq;
    say('week-msg', 'Loading...');
    try {
      const rows = (await rpc('admin_weekly_summary', { p_institute: ctx.institute.id, p_week_start: start, p_tz: ctx.tz })) || [];
      if (seq !== weekSeq) return;
      weeklyRows = rows;
      renderWeek();
      say('week-msg', 'Week starting Monday ' + start + ', days in ' + ctx.tz + '.');
    } catch (err) {
      if (seq !== weekSeq) return;
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

  // ---------- script results: where calls ended, and why calls were lost ----------

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
    const seq = ++scriptSeq;
    versions = [];
    const sel = $('sr-version');
    sel.textContent = '';
    $('report-out').textContent = '';
    $('insights-out').textContent = '';
    if (!scriptId) return;
    const { data, error } = await ctx.client.from('script_versions')
      .select('id, version, published')
      .eq('script_id', scriptId)
      .order('version', { ascending: false });
    if (seq !== scriptSeq) return;
    if (error) { say('sr-msg', 'Could not load versions: ' + error.message, true); return; }
    versions = data || [];
    versions.forEach((v) => sel.appendChild(el('option', {
      value: v.id, text: 'v' + v.version + (v.published ? ' (published)' : ' (draft)'),
    })));
    const pick = versions.find((v) => v.id === wantVersion) || versions.find((v) => v.published) || versions[0];
    if (pick) sel.value = pick.id;
    say('sr-msg', '');
  }

  async function runScriptReport() {
    const v = versions.find((x) => x.id === $('sr-version').value);
    if (!v) { say('sr-msg', 'Pick a script and a version.', true); return; }
    let r;
    try {
      r = M.reportRange($('sr-from').value, $('sr-to').value);
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
    say('sr-msg', 'Showing v' + v.version + ', ' + $('sr-from').value + ' to ' + $('sr-to').value + '.');
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
      (d.reasons || []).map((x) => [REASON_LABEL[x.reason] || x.reason, x.calls])));
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
        const when = s.decided_at ? ' on ' + new Date(s.decided_at).toLocaleDateString() : '';
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

  let scriptsReady = null;   // the first load of the script list, so a link waits for it

  S.registerTab({
    id: 'reports',
    label: 'Reports',
    mount(box, c) {
      ctx = c;
      build(box);
      wire();
      const d = A.lastNDays(new Date(), 7);
      $('results-from').value = d.from;
      $('results-to').value = d.to;
      $('sr-from').value = d.from;
      $('sr-to').value = d.to;
      $('week-start').value = T.weekStart(new Date());
      loadResults();
      scriptsReady = loadScripts();
    },
    show(params) {
      if (!params || !params.script) return;
      const mine = ctx;
      scriptsReady.then(() => { if (ctx === mine) openFromLink(params); });
    },
    unmount() {
      ctx = null;
      outcomes = []; weeklyRows = []; scripts = []; versions = [];
      loadSeq++; weekSeq++; scriptSeq++;
      scriptsReady = null;
    },
  });
})();
