'use strict';
/* Admin script editor (web/script-editor.html), for Vector 2.0. Lists the institute's scripts, edits one
   script's steps as a form, checks them with ScriptModel (script-model.js), walks them in test mode, saves
   drafts and publishes versions, shows version history and runs a per-version report.
   Writes go through admin_save_script_version and reads through admin_script_report
   (supabase/migrations/20261011100007_scripts.sql). The database checks the admin role on every call.
   Nothing here reaches a rep until a version is published. */
(function () {
  const M = window.ScriptModel;
  const cfg = window.VECTOR_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
  const $ = (id) => document.getElementById(id);
  const SECTIONS = ['off', 'gate', 'notadmin', 'app'];
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const STEP_SEL = '#steps fieldset.step';
  const TEST_MESSAGES = {
    end: 'Reached an end card.',
    unfinished: 'Pick the choice the rep hears back.',
    loop: 'This route loops back to a step it already passed.',
    invalid_choice: 'That choice is no longer on this step. Undo the last choice.',
    no_start: 'Mark a step as the start to test the script.',
  };

  let client = null;
  let mySeat = null;
  let activeUser = null;
  let scripts = [];                                   // { id, name }
  let versions = [];                                  // { id, version, steps, change_note, published, created_at }
  let work = { scriptId: null, name: '', steps: [] }; // the editor's working copy
  let dirty = false;
  let testChoices = null;                             // array while test mode is open, else null

  // ---------- small helpers ----------

  const show = (section) => SECTIONS.forEach((s) => { $(s).hidden = s !== section; });
  function say(id, text, isError) {
    const node = $(id);
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
  }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const pretty = (s) => String(s).replace(/_/g, ' ');
  const pct = (share) => (share == null ? '' : (Math.round(Number(share) * 1000) / 10) + '%');
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

  // Builds an element from text and child nodes only: no HTML strings, so names from the database are never parsed as markup.
  function el(tag, props, kids) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else if (k === 'onClick') node.addEventListener('click', v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = !!v;
      else if (k === 'disabled') node.disabled = !!v;
      else node.setAttribute(k, v);
    });
    (kids || []).forEach((c) => node.appendChild(c));
    return node;
  }
  const cell = (text, cls) => el('td', { text: text == null ? '' : String(text), className: cls || '' });
  const labelled = (text, input) => el('label', { className: 'field' }, [el('span', { text }), input]);

  // Asks before a change would throw away unsaved edits.
  function guardDirty(action) {
    if (dirty && !window.confirm('You have unsaved changes. Leave without saving?')) return;
    action();
  }

  function setBusy(on) {
    ['save-draft', 'publish-open', 'publish-go'].forEach((id) => { $(id).disabled = on; });
  }

  // ---------- startup and sign-in (the same email link as admin.html) ----------

  function init() {
    if (!enabled) { $('signout').hidden = true; show('off'); return; }
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    // Supabase advises against calling the client inside this callback, so the work runs just after it.
    client.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
    $('gate-form').addEventListener('submit', sendLink);
    $('signout').addEventListener('click', () => { client.auth.signOut(); });

    $('new-script').addEventListener('click', () => guardDirty(newScript));
    $('script-name').addEventListener('input', () => { work.name = $('script-name').value; markDirty(); });
    $('add-step').addEventListener('click', addStep);
    $('steps').addEventListener('input', onStepsEdit);
    $('steps').addEventListener('change', onStepsEdit);
    $('steps').addEventListener('click', onStepsClick);
    $('save-draft').addEventListener('click', () => saveVersion(false, ''));
    $('publish-open').addEventListener('click', openPublish);
    $('publish-cancel').addEventListener('click', () => { $('publish-box').hidden = true; });
    $('publish-go').addEventListener('click', () => saveVersion(true, $('publish-note').value.trim()));
    $('test-toggle').addEventListener('click', openTest);
    $('test-close').addEventListener('click', closeTest);
    $('test-back').addEventListener('click', () => { if (testChoices && testChoices.length) { testChoices.pop(); renderTest(); } });
    $('test-restart').addEventListener('click', () => { testChoices = []; renderTest(); });
    $('diff-go').addEventListener('click', compareVersions);
    $('report-form').addEventListener('submit', (e) => { e.preventDefault(); runReport(); });

    const d = lastDays(7);
    $('report-from').value = d.from;
    $('report-to').value = d.to;
    show('gate');
  }

  async function sendLink(e) {
    e.preventDefault();
    const email = $('gate-email').value.trim();
    if (!EMAIL.test(email)) { say('gate-msg', 'Enter your work email address.', true); return; }
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
    });
    say('gate-msg', error ? error.message : 'Check your email for the sign-in link.', !!error);
  }

  async function onSession(session) {
    if (!session) {
      activeUser = null;
      mySeat = null;
      scripts = []; versions = []; work = { scriptId: null, name: '', steps: [] }; dirty = false;
      show('gate');
      return;
    }
    // A token refresh fires the same event again. Keep the editor as it is.
    if (session.user.id === activeUser && mySeat) return;
    activeUser = session.user.id;
    $('who').textContent = session.user.email || '';

    const { data, error } = await client.rpc('my_active_seat');
    if (error) { say('gate-msg', 'Could not check your seat: ' + error.message, true); show('gate'); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.id || row.role !== 'admin') { show('notadmin'); return; }
    mySeat = row;
    show('app');
    await loadScripts();
    newScript();
  }

  // ---------- scripts and versions ----------

  async function loadScripts() {
    const { data, error } = await client.from('scripts').select('id, name').order('name');
    if (error) { say('list-msg', 'Could not load scripts: ' + error.message, true); return; }
    scripts = data || [];
    say('list-msg', '');
    renderList();
  }

  function renderList() {
    const ul = $('script-list');
    ul.textContent = '';
    $('list-empty').hidden = scripts.length > 0;
    scripts.forEach((s) => ul.appendChild(el('li', null, [
      el('button', {
        type: 'button', text: s.name, className: s.id === work.scriptId ? 'current' : '',
        onClick: () => guardDirty(() => openScript(s.id)),
      }),
    ])));
  }

  async function loadVersions(scriptId) {
    const { data, error } = await client.from('script_versions')
      .select('id, version, steps, change_note, published, created_at')
      .eq('script_id', scriptId)
      .order('version', { ascending: false });
    if (error) throw new Error(error.message);
    versions = data || [];
  }

  async function openScript(id) {
    const script = scripts.find((s) => s.id === id);
    if (!script) return;
    try {
      await loadVersions(id);
    } catch (err) { say('list-msg', 'Could not load versions: ' + err.message, true); return; }
    work = { scriptId: id, name: script.name, steps: clone(versions[0] ? versions[0].steps : []) };
    dirty = false;
    closeTest();
    renderList();
    renderEditor();
    renderHistory();
    fillSelects();
    $('history-panel').hidden = false;
    $('report-panel').hidden = false;
    say('editor-msg', '');
  }

  function newScript() {
    work = { scriptId: null, name: '', steps: [] };
    versions = [];
    dirty = false;
    closeTest();
    renderList();
    renderEditor();
    renderHistory();
    fillSelects();
    $('history-panel').hidden = true;
    $('report-panel').hidden = true;
    say('editor-msg', '');
  }

  // ---------- editor form ----------

  function markDirty() {
    dirty = true;
    updateStateLine();
  }

  function updateStateLine() {
    let text = work.scriptId ? '' : 'Not saved yet';
    if (work.scriptId) {
      const pub = versions.find((v) => v.published);
      const latest = versions[0];
      text = pub ? 'Published: v' + pub.version : 'Nothing published';
      if (latest) text += ' · Latest: v' + latest.version + (latest.published ? '' : ' (draft)');
    }
    if (dirty) text += (text ? ' · ' : '') + 'Unsaved changes';
    $('state-line').textContent = text;
  }

  function renderEditor() {
    $('editor-title').textContent = work.scriptId ? 'Edit script' : 'New script';
    $('script-name').value = work.name || '';
    renderSteps();
    runValidation();
    $('publish-box').hidden = true;
    updateStateLine();
  }

  function stepFieldsets() { return Array.from(document.querySelectorAll(STEP_SEL)); }
  const fieldIn = (scope, name) => scope.querySelector('[data-field="' + name + '"]');

  // Reads the form into work.steps, in the saved format. Empty title, tip and start are left out.
  function readSteps() {
    work.steps = stepFieldsets().map((fs) => {
      const step = { id: fieldIn(fs, 'id').value.trim() };
      const title = fieldIn(fs, 'title').value.trim();
      if (title) step.title = title;
      if (fieldIn(fs, 'start').checked) step.start = true;
      step.say = M.splitLines(fieldIn(fs, 'say').value);
      const tip = fieldIn(fs, 'tip').value.trim();
      if (tip) step.tip = tip;
      step.opts = Array.from(fs.querySelectorAll('.opt')).map((row) => ({
        label: fieldIn(row, 'label').value.trim(),
        to: fieldIn(row, 'to').value.trim(),
      }));
      return step;
    });
    return work.steps;
  }

  function runValidation() {
    const problems = M.validateSteps(readSteps());
    const list = $('problem-list');
    list.textContent = '';
    problems.forEach((p) => list.appendChild(el('li', { text: p })));
    $('problems').hidden = problems.length === 0;
    return problems;
  }

  function renderSteps() {
    const box = $('steps');
    box.textContent = '';
    work.steps.forEach((s, i) => box.appendChild(stepCard(s, i)));
    if (!work.steps.length) box.appendChild(el('p', { className: 'muted', text: 'No steps yet. Add the first step.' }));
    const ids = $('step-ids');
    ids.textContent = '';
    work.steps.forEach((s) => { if (s && s.id) ids.appendChild(el('option', { value: s.id })); });
  }

  function stepCard(s, i) {
    const opts = Array.isArray(s.opts) ? s.opts : [];
    return el('fieldset', { className: 'step' }, [
      el('legend', { text: 'Step ' + (i + 1) }),
      el('div', { className: 'grid2' }, [
        labelled('Step id', el('input', { type: 'text', 'data-field': 'id', value: s.id || '', maxlength: '40', autocomplete: 'off' })),
        labelled('Title', el('input', { type: 'text', 'data-field': 'title', value: s.title || '', maxlength: '120', autocomplete: 'off' })),
      ]),
      el('label', { className: 'check' }, [
        el('input', { type: 'checkbox', 'data-field': 'start', checked: !!s.start }),
        el('span', { text: 'Start step (a call begins here)' }),
      ]),
      labelled('What the rep says (one line each)', el('textarea', {
        'data-field': 'say', rows: '3', value: (Array.isArray(s.say) ? s.say : []).join('\n'),
      })),
      labelled('Tip for the rep (optional)', el('input', { type: 'text', 'data-field': 'tip', value: s.tip || '', maxlength: '300' })),
      el('p', { className: 'muted', text: opts.length ? 'Options' : 'No options: this step is an end card.' }),
      el('div', { className: 'opts' }, opts.map((o) => el('div', { className: 'opt' }, [
        labelled('Option label', el('input', { type: 'text', 'data-field': 'label', value: o.label || '', maxlength: '80' })),
        labelled('Goes to step id', el('input', { type: 'text', 'data-field': 'to', value: o.to || '', list: 'step-ids', maxlength: '40', autocomplete: 'off' })),
        el('button', { type: 'button', 'data-action': 'del-opt', className: 'danger', text: 'Remove option' }),
      ]))),
      el('div', { className: 'row wrap' }, [
        el('button', { type: 'button', 'data-action': 'add-opt', text: 'Add option' }),
        el('button', { type: 'button', 'data-action': 'del-step', className: 'danger', text: 'Remove step' }),
      ]),
    ]);
  }

  // Typing changes the working copy and the checks, without redrawing the form (which would move the cursor).
  function onStepsEdit() {
    readSteps();
    markDirty();
    runValidation();
    if (testChoices) renderTest();
  }

  function onStepsClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    readSteps();
    const fs = btn.closest(STEP_SEL);
    const i = stepFieldsets().indexOf(fs);
    const action = btn.getAttribute('data-action');
    if (action === 'del-step') {
      work.steps.splice(i, 1);
    } else if (action === 'add-opt') {
      work.steps[i].opts.push({ label: '', to: '' });
    } else if (action === 'del-opt') {
      const j = Array.from(fs.querySelectorAll('.opt')).indexOf(btn.closest('.opt'));
      work.steps[i].opts.splice(j, 1);
    }
    renderSteps();
    markDirty();
    runValidation();
    if (testChoices) renderTest();
  }

  function addStep() {
    readSteps();
    const used = new Set(work.steps.map((s) => s.id));
    let n = work.steps.length + 1;
    let id = 'step-' + n;
    while (used.has(id)) { n += 1; id = 'step-' + n; }
    const step = { id, say: [], opts: [] };
    if (work.steps.length === 0) step.start = true;
    work.steps.push(step);
    renderSteps();
    markDirty();
    runValidation();
  }

  // ---------- saving ----------

  function openPublish() {
    const problems = runValidation();
    if (!$('script-name').value.trim()) { say('editor-msg', 'Enter a name for the script.', true); return; }
    if (problems.length) { say('editor-msg', 'Fix the problems listed above before publishing.', true); return; }
    $('publish-box').hidden = false;
    $('publish-note').focus();
  }

  // publish=false saves a draft. publish=true makes the new version the one reps use, and needs a change note.
  async function saveVersion(publish, note) {
    const name = $('script-name').value.trim();
    work.name = name;
    const steps = readSteps();
    const problems = runValidation();
    if (!name) { say('editor-msg', 'Enter a name for the script.', true); return; }
    if (name.length > 120) { say('editor-msg', 'The name is longer than 120 characters.', true); return; }
    if (note.length > M.MAX_CHANGE_NOTE) { say('editor-msg', 'The change note is longer than 500 characters.', true); return; }
    if (publish && problems.length) { say('editor-msg', 'Fix the problems listed above before publishing.', true); return; }
    if (publish && !note) { say('editor-msg', 'Write a change note for this version.', true); return; }

    setBusy(true);
    try {
      const { data: versionId, error } = await client.rpc('admin_save_script_version', {
        p_script: work.scriptId, p_name: name, p_steps: steps, p_change_note: note, p_publish: publish,
      });
      if (error) throw new Error(error.message);
      if (!work.scriptId) {
        const { data: row, error: rowError } = await client.from('script_versions').select('script_id').eq('id', versionId).single();
        if (rowError) throw new Error(rowError.message);
        work.scriptId = row.script_id;
      }
      await loadScripts();
      await loadVersions(work.scriptId);
      dirty = false;
      $('publish-note').value = '';
      renderList();
      renderEditor();
      renderHistory();
      fillSelects();
      $('history-panel').hidden = false;
      $('report-panel').hidden = false;
      let msg = publish ? 'Published this version.' : 'Draft saved.';
      if (problems.length) {
        msg += ' It has ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') + ' and cannot be published until they are fixed.';
      }
      say('editor-msg', msg);
    } catch (err) {
      say('editor-msg', 'Could not save: ' + err.message, true);
    } finally {
      setBusy(false);
    }
  }

  // ---------- test mode ----------

  function openTest() {
    testChoices = [];
    $('test-panel').hidden = false;
    renderTest();
  }

  function closeTest() {
    testChoices = null;
    $('test-panel').hidden = true;
  }

  function renderTest() {
    if (!testChoices) return;
    const steps = readSteps();
    const res = M.testRun(steps, testChoices);
    const lines = $('test-lines');
    lines.textContent = '';
    M.renderPreview(steps, res.path).forEach((l) => lines.appendChild(el('li', { text: l })));

    const choices = $('test-choices');
    choices.textContent = '';
    if (res.status === 'unfinished') {
      res.options.forEach((label) => choices.appendChild(el('button', {
        type: 'button', text: label, onClick: () => { testChoices.push(label); renderTest(); },
      })));
    }
    let msg = TEST_MESSAGES[res.status] || '';
    if (res.status === 'dead_end') {
      msg = 'This route leads to a step that does not exist' + (res.missing ? ': "' + res.missing + '".' : '.');
    }
    say('test-status', msg, res.status !== 'end' && res.status !== 'unfinished');
    $('test-back').disabled = !testChoices.length;
  }

  // ---------- history ----------

  function renderHistory() {
    const body = $('history-body');
    body.textContent = '';
    $('history-empty').hidden = versions.length > 0;
    versions.forEach((v) => body.appendChild(el('tr', null, [
      cell('v' + v.version),
      el('td', null, [el('span', {
        text: v.published ? 'Published' : 'Draft', className: v.published ? 'published-tag' : '',
      })]),
      cell(new Date(v.created_at).toLocaleString()),
      cell(v.change_note || ''),
      el('td', null, [el('button', { type: 'button', text: 'Load into editor', onClick: () => guardDirty(() => loadVersion(v.version)) })]),
    ])));
  }

  // Copies an old version into the editor. It is not saved until the admin saves it.
  function loadVersion(n) {
    const v = versions.find((x) => x.version === n);
    if (!v) return;
    work.steps = clone(v.steps);
    dirty = true;
    renderEditor();
    say('editor-msg', 'Loaded v' + n + ' into the editor. Save to make it a new version.');
  }

  function fillSelects() {
    const diffA = $('diff-a');
    const diffB = $('diff-b');
    const report = $('report-version');
    [diffA, diffB, report].forEach((s) => { s.textContent = ''; });
    versions.forEach((v) => {
      const label = 'v' + v.version + (v.published ? ' (published)' : ' (draft)');
      diffA.appendChild(el('option', { value: String(v.version), text: label }));
      diffB.appendChild(el('option', { value: String(v.version), text: label }));
      report.appendChild(el('option', { value: v.id, text: label }));
    });
    if (versions.length >= 2) diffA.value = String(versions[1].version);
    if (versions.length) diffB.value = String(versions[0].version);
    const pub = versions.find((v) => v.published) || versions[0];
    if (pub) report.value = pub.id;
    compareVersions();
  }

  function diffLine(label, ids) {
    return el('p', null, [el('strong', { text: label + ': ' }), document.createTextNode(ids.length ? ids.join(', ') : 'none')]);
  }

  function compareVersions() {
    const out = $('diff-out');
    out.textContent = '';
    const a = versions.find((v) => String(v.version) === $('diff-a').value);
    const b = versions.find((v) => String(v.version) === $('diff-b').value);
    if (!a || !b) return;
    const d = M.diffVersions(a.steps, b.steps);
    if (!d.added.length && !d.removed.length && !d.changed.length) {
      out.appendChild(el('p', { className: 'muted', text: 'v' + a.version + ' and v' + b.version + ' have the same steps.' }));
      return;
    }
    out.appendChild(diffLine('Added (in v' + b.version + ', not in v' + a.version + ')', d.added));
    out.appendChild(diffLine('Removed (in v' + a.version + ', not in v' + b.version + ')', d.removed));
    out.appendChild(diffLine('Changed (in both, different)', d.changed));
  }

  // ---------- report ----------

  async function runReport() {
    const v = versions.find((x) => x.id === $('report-version').value);
    if (!v || !mySeat) { say('report-msg', 'Pick a version.', true); return; }
    let range;
    try {
      range = M.reportRange($('report-from').value, $('report-to').value);
    } catch (err) { say('report-msg', err.message, true); return; }

    say('report-msg', 'Loading...');
    $('report-out').textContent = '';
    const { data, error } = await client.rpc('admin_script_report', {
      p_institute: mySeat.institute_id, p_script_version_id: v.id, p_from: range.from, p_to: range.to,
    });
    if (error) { say('report-msg', 'Could not load the report: ' + error.message, true); return; }
    say('report-msg', 'Showing v' + v.version + ', ' + $('report-from').value + ' to ' + $('report-to').value + '.');
    renderReport(data || {});
    loadInsights(v, range);
  }

  // ---------- insights: why calls are lost, and suggested changes the admin approves ----------

  const REASON_LABEL = {
    price: 'Price', timing: 'Timing', already_enrolled: 'Already enrolled', no_need: 'No need',
    wrong_person: 'Wrong person', other: 'Other', not_recorded: 'Not recorded',
  };
  const stageLabel = (s) => (s === 'not_recorded' ? '(not recorded)' : s);

  async function loadInsights(v, range) {
    const out = $('insights-out');
    out.textContent = '';
    const { data, error } = await client.rpc('admin_loss_insights', {
      p_institute: mySeat.institute_id, p_script_version_id: v.id, p_from: range.from, p_to: range.to,
    });
    if (error) { out.appendChild(el('p', { className: 'msg', text: 'Could not load insights: ' + error.message })); return; }
    renderInsights(data || {}, v, range);
  }

  function renderInsights(d, v, range) {
    const out = $('insights-out');
    out.textContent = '';
    out.appendChild(el('h2', { text: 'What went wrong on lost calls' }));
    if (!d.calls) { out.appendChild(el('p', { className: 'muted', text: 'No calls for this version in the range.' })); return; }
    const rate = d.lost_rate == null ? '' : ' (' + pct(d.lost_rate) + ')';
    let line = d.lost + ' of ' + d.calls + ' calls lost' + rate + ' on v' + d.version + '.';
    if (d.previous_version != null && d.previous_calls) {
      line += ' v' + d.previous_version + ' lost ' + pct(d.previous_lost_rate) + ' of ' + d.previous_calls + ' calls.';
    }
    out.appendChild(el('p', { text: line }));
    if (!d.enough_calls) out.appendChild(el('p', { className: 'muted', text: 'Suggestions appear after 10 calls on this version.' }));
    out.appendChild(reportTable('Lost calls by reason', ['Reason', 'Calls'],
      (d.reasons || []).map((r) => [REASON_LABEL[r.reason] || r.reason, r.calls])));
    out.appendChild(reportTable('Where lost calls ended', ['Stage', 'Calls'],
      (d.stages || []).map((r) => [stageLabel(r.stage), r.calls])));
    out.appendChild(reportTable('Objections on lost calls', ['Objection', 'Calls'],
      (d.objections || []).map((r) => [r.objection, r.calls])));

    const block = el('div', { className: 'report-block' }, [el('h3', { text: 'Suggested changes' })]);
    const sugg = d.suggestions || [];
    if (!sugg.length) block.appendChild(el('p', { className: 'muted', text: 'No single change stands out yet.' }));
    sugg.forEach((s) => {
      const row = el('div', { className: 'suggestion' }, [el('p', { text: s.text })]);
      if (s.decision) {
        const when = s.decided_at ? ' on ' + new Date(s.decided_at).toLocaleDateString() : '';
        row.appendChild(el('p', { className: 'muted', text: pretty(s.decision) + when + '. Change the script in the editor, then publish a new version.' }));
      }
      const approve = el('button', { type: 'button', text: s.decision === 'approved' ? 'Approved' : 'Approve' });
      const reject = el('button', { type: 'button', text: s.decision === 'rejected' ? 'Rejected' : 'Reject' });
      approve.addEventListener('click', () => decideSuggestion(v, s.key, 'approved', range, s.text));
      reject.addEventListener('click', () => decideSuggestion(v, s.key, 'rejected', range, s.text));
      row.appendChild(el('div', { className: 'suggestion-actions' }, [approve, reject]));
      block.appendChild(row);
    });
    out.appendChild(block);
  }

  async function decideSuggestion(v, key, decision, range, note) {
    const { error } = await client.rpc('admin_decide_suggestion', {
      p_institute: mySeat.institute_id, p_script_version_id: v.id, p_target_key: key, p_decision: decision, p_note: note,
    });
    if (error) { say('report-msg', 'Could not save the decision: ' + error.message, true); return; }
    loadInsights(v, range);
  }

  function renderReport(d) {
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

  function reportTable(caption, headers, rows) {
    const block = el('div', { className: 'scroll report-block' }, [el('h3', { text: caption })]);
    block.appendChild(el('table', null, [
      el('thead', null, [el('tr', null, headers.map((h, i) => el('th', { text: h, className: i ? 'num' : '' })))]),
      el('tbody', null, rows.map((r) => el('tr', null, r.map((c, i) => cell(c, i ? 'num' : ''))))),
    ]));
    if (!rows.length) block.appendChild(el('p', { className: 'muted', text: 'None.' }));
    return block;
  }

  function lastDays(n) {
    const now = new Date();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (n - 1));
    return { from: ymd(from), to: ymd(to) };
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
