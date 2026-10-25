'use strict';
/* Admin script editor, for Vector 2.0. Runs inside the Scripts tab of the admin app (web/admin.html):
   js/admin/scripts.js shows the list of scripts and calls VectorScriptEditor to open one, start a new one (by
   hand, from a template or from an AI draft) and come back. The old script-editor.html sends people there.
   Edits one script as a form: its call type, its steps (an ending names the result it saves, a key of the call
   type), its pushback answers ({label, answer}) and the "Check this" marks a template or the AI left on a step.
   Checks everything with ScriptModel (script-model.js), walks the script in test mode, saves drafts and
   publishes versions, and shows version history. A version's results are in the Reports tab.
   Writes go through admin_save_script (supabase/migrations/20261024100022_script_types_ai.sql). The database
   checks the admin role, the Scripts add-on and what publishing needs (a type, no marks, every ending linked).
   Nothing here reaches a caller until a version is published. */
(function () {
  const M = window.ScriptModel;
  const $ = (id) => document.getElementById(id);
  const STEP_SEL = '#steps fieldset.step';
  const PB_SEL = '#pushbacks fieldset.pushback';
  // The call page's progress rail (web/js/main.js STAGES), for "Part of the call".
  const STAGES = ['Opening', 'Discovery', 'Pitch', 'Timings', 'Fee', 'Close'];
  const TEST_MESSAGES = {
    end: 'Reached an end card.',
    unfinished: 'Pick the choice the caller hears back.',
    loop: 'This route loops back to a step it already passed.',
    invalid_choice: 'That choice is no longer on this step. Undo the last choice.',
    no_start: 'Mark a step as the start to test the script.',
  };

  let client = null;
  let ctx = null;                                     // the admin app's shared context (js/admin/shell.js)
  let hooks = {};                                     // { onBack(), onSaved(scriptId) } from the Scripts tab
  let callTypes = [];                                 // admin_list_call_types rows: { id, key, label, active, results }
  let versions = [];                                  // { id, version, steps, pushbacks, change_note, published, created_at }
  let work = blank();                                 // the editor's working copy
  let dirty = false;
  let testChoices = null;                             // array while test mode is open, else null

  function blank() { return { scriptId: null, name: '', callTypeId: null, steps: [], pushbacks: [] }; }

  // ---------- small helpers ----------

  function say(id, text, isError) {
    const node = $(id);
    if (!node) return;
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
  }
  const clone = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));

  // Builds an element from text and child nodes only: no HTML strings, so names from the database are never parsed as markup.
  function el(tag, props, kids) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v === undefined || v === null) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else if (k === 'onClick') node.addEventListener('click', v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked') node.checked = !!v;
      else if (k === 'disabled' || k === 'hidden' || k === 'selected') node[k] = !!v;
      else node.setAttribute(k, v);
    });
    (kids || []).forEach((c) => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }
  const cell = (text, cls) => el('td', { text: text == null ? '' : String(text), className: cls || '' });
  const labelled = (text, input) => el('label', { className: 'field' }, [el('span', { text }), input]);

  // Asks before a change would throw away unsaved edits.
  function guardDirty(action) {
    if (dirty && !window.confirm('You have unsaved changes. Leave without saving?')) return false;
    action();
    return true;
  }

  function setBusy(on) {
    ['save-draft', 'publish-open', 'publish-go'].forEach((id) => { $(id).disabled = on; });
  }

  const typeById = (id) => callTypes.find((t) => t.id === id) || null;
  const typeByKey = (key) => callTypes.find((t) => t.key === key) || null;
  const currentType = () => typeById(work.callTypeId);
  const resultKeys = () => { const t = currentType(); return t ? (t.results || []).map((r) => r.key) : null; };

  // ---------- the editor's page, built once per mount ----------

  function build(box) {
    const btn = (id, text, cls) => el('button', { id, type: 'button', text, className: cls || '' });
    const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
    box.appendChild(el('div', { className: 'editor-col' }, [
      el('section', { className: 'panel', id: 'editor-panel' }, [
        el('div', { className: 'row between' }, [
          el('div', { className: 'row' }, [
            btn('editor-back', '← All scripts'),
            el('h2', { id: 'editor-title', text: 'New script' }),
          ]),
          el('span', { id: 'state-line', className: 'muted' }),
        ]),
        el('div', { className: 'grid2' }, [
          el('label', { className: 'field' }, [document.createTextNode('Script name'),
            el('input', { id: 'script-name', type: 'text', maxlength: '120', autocomplete: 'off' })]),
          el('label', { className: 'field' }, [document.createTextNode('Kind of call (decides the result options)'),
            el('select', { id: 'script-type' })]),
        ]),
        el('div', { id: 'problems', className: 'problems', role: 'status', hidden: true }, [
          el('h3', { text: 'Fix these before it is ready for callers' }),
          el('ul', { id: 'problem-list' }),
        ]),
        el('div', { className: 'row between' }, [el('h3', { text: 'Steps' }), btn('add-step', 'Add step')]),
        el('div', { id: 'steps' }),
        el('datalist', { id: 'step-ids' }),
        el('div', { className: 'row between pb-head' }, [
          el('div', null, [
            el('h3', { text: 'Answers to objections' }),
            el('p', { className: 'muted small', text: 'Buttons a caller taps when the person pushes back, with what to say.' }),
          ]),
          btn('add-pushback', 'Add an answer to an objection'),
        ]),
        el('div', { id: 'pushbacks' }),
        el('div', { className: 'row wrap' }, [
          btn('test-toggle', 'Test mode'),
          btn('save-draft', 'Save (not ready yet)', 'primary'),
          btn('publish-open', 'Ready for callers'),
        ]),
        el('div', { id: 'publish-box', className: 'confirm', hidden: true }, [
          el('label', { className: 'field' }, [document.createTextNode('Change note (what changed, 500 characters at most)'),
            el('textarea', { id: 'publish-note', maxlength: '500', rows: '3' })]),
          el('div', { className: 'row wrap' }, [btn('publish-go', 'Make it ready for callers', 'primary'), btn('publish-cancel', 'Cancel')]),
        ]),
        msg('editor-msg'),
      ]),
      el('section', { className: 'panel', id: 'test-panel', hidden: true }, [
        el('div', { className: 'row between' }, [el('h2', { text: 'Test mode' }), btn('test-close', 'Close test')]),
        el('p', { className: 'muted', text: 'Walks the script as it is in the editor now. Nothing is saved.' }),
        el('div', { className: 'row wrap' }, [btn('test-back', 'Undo last choice'), btn('test-restart', 'Start over')]),
        el('ol', { id: 'test-lines', className: 'test-lines' }),
        el('div', { id: 'test-choices', className: 'row wrap' }),
        msg('test-status'),
      ]),
      el('section', { className: 'panel', id: 'history-panel', hidden: true }, [
        el('h2', { text: 'Version history' }),
        el('div', { className: 'scroll' }, [el('table', null, [
          el('thead', null, [el('tr', null, ['Version', 'Status', 'Saved', 'Change note', 'Actions'].map((h) => el('th', { text: h })))]),
          el('tbody', { id: 'history-body' }),
        ])]),
        el('p', { id: 'history-empty', className: 'muted', hidden: true, text: 'No versions yet.' }),
        el('div', { className: 'row wrap compare' }, [
          el('label', null, [document.createTextNode('From version'), el('select', { id: 'diff-a' })]),
          el('label', null, [document.createTextNode('To version'), el('select', { id: 'diff-b' })]),
          btn('diff-go', 'Compare'),
        ]),
        el('div', { id: 'diff-out', className: 'diff', 'aria-live': 'polite' }),
      ]),
    ]));
  }

  function wire() {
    $('editor-back').addEventListener('click', () => { if (hooks.onBack) hooks.onBack(); });
    $('script-name').addEventListener('input', () => { work.name = $('script-name').value; markDirty(); });
    $('script-type').addEventListener('change', onTypeChange);
    $('add-step').addEventListener('click', addStep);
    $('steps').addEventListener('input', onStepsEdit);
    $('steps').addEventListener('change', onStepsEdit);
    $('steps').addEventListener('click', onStepsClick);
    $('add-pushback').addEventListener('click', addPushback);
    $('pushbacks').addEventListener('input', onPushbacksEdit);
    $('pushbacks').addEventListener('click', onPushbacksClick);
    $('save-draft').addEventListener('click', () => saveVersion(false, ''));
    $('publish-open').addEventListener('click', openPublish);
    $('publish-cancel').addEventListener('click', () => { $('publish-box').hidden = true; });
    $('publish-go').addEventListener('click', () => saveVersion(true, $('publish-note').value.trim()));
    $('test-toggle').addEventListener('click', openTest);
    $('test-close').addEventListener('click', closeTest);
    $('test-back').addEventListener('click', () => { if (testChoices && testChoices.length) { testChoices.pop(); renderTest(); } });
    $('test-restart').addEventListener('click', () => { testChoices = []; renderTest(); });
    $('diff-go').addEventListener('click', compareVersions);
  }

  // Called by the Scripts tab the first time it opens, after the admin app has checked the admin seat.
  // opts: { onBack() when "All scripts" is clicked, onSaved(scriptId) after a save }.
  function mount(box, c, opts) {
    ctx = c;
    client = c.client;
    hooks = opts || {};
    build(box);
    wire();
    startNew(null);
  }

  // Called on sign-out: forget the working copy. The tab's box is removed by the admin app.
  function unmount() {
    ctx = null;
    client = null;
    hooks = {};
    callTypes = [];
    versions = []; work = blank(); dirty = false;
    testChoices = null;
  }

  // True while the editor has changes that are not saved.
  const hasUnsaved = () => dirty;

  // The institute's call types with their results (admin_list_call_types), from the Scripts tab.
  function setCallTypes(list) {
    callTypes = Array.isArray(list) ? list : [];
    if ($('script-type')) { fillTypes(); renderSteps(); runValidation(); }
  }

  // ---------- opening a script ----------

  async function loadVersions(scriptId) {
    const { data, error } = await client.from('script_versions')
      .select('id, version, steps, pushbacks, change_note, published, created_at')
      .eq('script_id', scriptId)
      .order('version', { ascending: false });
    if (error) throw new Error(error.message);
    versions = data || [];
  }

  // Opens a saved script: row is a row of admin_list_scripts ({ id, name, call_type_id }). Returns false when
  // the admin chose to keep unsaved changes, or the versions could not be loaded.
  async function open(row) {
    if (!row || !row.id) return false;
    if (dirty && work.scriptId !== row.id && !window.confirm('You have unsaved changes. Leave without saving?')) return false;
    if (!dirty || work.scriptId !== row.id) {
      try {
        await loadVersions(row.id);
      } catch (err) { say('editor-msg', 'Could not load versions: ' + err.message, true); return false; }
      const latest = versions[0] || {};
      work = { scriptId: row.id, name: row.name, callTypeId: row.call_type_id || null,
        steps: clone(latest.steps || []), pushbacks: clone(latest.pushbacks || []) };
      dirty = false;
    }
    closeTest();
    renderEditor();
    renderHistory();
    fillSelects();
    $('history-panel').hidden = false;
    say('editor-msg', '');
    return true;
  }

  // Starts a new, unsaved script: empty (script null), or from a template or an AI draft in the
  // script-model.js format ({ name, call_type, steps, pushbacks }). Returns false when the admin chose to keep
  // unsaved changes.
  function startNew(script, note) {
    if (dirty && !window.confirm('You have unsaved changes. Leave without saving?')) return false;
    const t = script && script.call_type ? typeByKey(script.call_type) : null;
    work = script ? { scriptId: null, name: script.name || '', callTypeId: t ? t.id : null,
      steps: clone(script.steps || []), pushbacks: clone(script.pushbacks || []) } : blank();
    versions = [];
    dirty = !!script;
    closeTest();
    renderEditor();
    renderHistory();
    fillSelects();
    $('history-panel').hidden = true;
    say('editor-msg', note || '');
    return true;
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
      text = pub ? 'Ready for callers (version ' + pub.version + ')' : 'Not ready for callers yet';
      if (latest && !latest.published) text += ' · Latest saved: version ' + latest.version + ', not ready';
    }
    if (dirty) text += (text ? ' · ' : '') + 'Unsaved changes';
    $('state-line').textContent = text;
  }

  function fillTypes() {
    const sel = $('script-type');
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: 'Choose a type' }));
    callTypes.filter((t) => t.active !== false || t.id === work.callTypeId).forEach((t) => {
      sel.appendChild(el('option', { value: t.id, text: t.label }));
    });
    sel.value = work.callTypeId || '';
  }

  function renderEditor() {
    $('editor-title').textContent = work.scriptId ? 'Edit script' : 'New script';
    $('script-name').value = work.name || '';
    fillTypes();
    renderSteps();
    renderPushbacks();
    runValidation();
    $('publish-box').hidden = true;
    updateStateLine();
  }

  function onTypeChange() {
    readAll();
    work.callTypeId = $('script-type').value || null;
    renderSteps();
    markDirty();
    runValidation();
  }

  function stepFieldsets() { return Array.from(document.querySelectorAll(STEP_SEL)); }
  function pushbackFieldsets() { return Array.from(document.querySelectorAll(PB_SEL)); }
  const fieldIn = (scope, name) => scope.querySelector('[data-field="' + name + '"]');
  const marksIn = (scope) => Array.from(scope.querySelectorAll(':scope > .marks [data-mark]')).map((li) => li.getAttribute('data-mark'));

  // Reads the form into work.steps, in the saved format. Empty title, tip, stage, result and marks are left out.
  function readSteps() {
    work.steps = stepFieldsets().map((fs) => {
      const step = { id: fieldIn(fs, 'id').value.trim() };
      const title = fieldIn(fs, 'title').value.trim();
      if (title) step.title = title;
      if (fieldIn(fs, 'start').checked) step.start = true;
      const stage = fieldIn(fs, 'stage').value;
      if (stage !== '') step.stage = Number(stage);
      step.say = M.splitLines(fieldIn(fs, 'say').value);
      const tip = fieldIn(fs, 'tip').value.trim();
      if (tip) step.tip = tip;
      step.opts = Array.from(fs.querySelectorAll('.opt')).map((row) => ({
        label: fieldIn(row, 'label').value.trim(),
        to: fieldIn(row, 'to').value.trim(),
      }));
      const result = fieldIn(fs, 'result');
      if (!step.opts.length && result && result.value) step.result = result.value;
      const marks = marksIn(fs);
      if (marks.length) step.check = marks;
      return step;
    });
    return work.steps;
  }

  function readPushbacks() {
    work.pushbacks = pushbackFieldsets().map((fs) => {
      const p = { label: fieldIn(fs, 'pb-label').value.trim(), answer: fieldIn(fs, 'pb-answer').value.trim() };
      const marks = marksIn(fs);
      if (marks.length) p.check = marks;
      return p;
    });
    return work.pushbacks;
  }

  function readAll() { readSteps(); readPushbacks(); }

  // Every problem that blocks publishing, including a missing type. Drafts can still be saved.
  function problemsNow() {
    const keys = resultKeys();
    const problems = M.validateScript({ steps: work.steps, pushbacks: work.pushbacks }, keys ? { resultKeys: keys } : undefined);
    if (!work.callTypeId) problems.unshift('Choose the call type.');
    return problems;
  }

  function runValidation() {
    readAll();
    const problems = problemsNow();
    const list = $('problem-list');
    list.textContent = '';
    problems.forEach((p) => list.appendChild(el('li', { text: p, className: p.startsWith('Check this') ? 'mark-line' : '' })));
    $('problems').hidden = problems.length === 0;
    return problems;
  }

  // The "Check this" marks of a step or pushback, each with a button that removes it once checked.
  function marksBox(marks) {
    if (!marks || !marks.length) return null;
    return el('div', { className: 'marks', role: 'group', 'aria-label': 'Check this' }, [
      el('ul', { className: 'plain' }, marks.map((m) => el('li', { 'data-mark': m }, [
        el('span', { className: 'mark-tag', text: 'Check this' }),
        el('span', { text: ' ' + m + ' ' }),
        el('button', { type: 'button', 'data-action': 'del-mark', text: 'Checked, remove', 'aria-label': 'Checked, remove the mark: ' + m }),
      ]))),
    ]);
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

  // The result select of an ending: the results of the script's call type.
  function resultSelect(s) {
    const t = currentType();
    const sel = el('select', { 'data-field': 'result', disabled: !t });
    sel.appendChild(el('option', { value: '', text: t ? 'Choose a result' : 'Choose the call type first' }));
    ((t && t.results) || []).forEach((r) => sel.appendChild(el('option', { value: r.key, text: r.label })));
    // Keep a result the type does not have (or a result while no type is chosen), so nothing is lost silently.
    if (s.result && !((t && t.results) || []).some((r) => r.key === s.result)) {
      sel.appendChild(el('option', { value: s.result, text: s.result + (t ? ' (not a result of this type)' : '') }));
    }
    sel.value = s.result || '';
    return sel;
  }

  function stageSelect(s) {
    const sel = el('select', { 'data-field': 'stage' });
    sel.appendChild(el('option', { value: '', text: 'Same as the step before' }));
    STAGES.forEach((name, i) => sel.appendChild(el('option', { value: String(i), text: name })));
    sel.value = Number.isInteger(s.stage) ? String(s.stage) : '';
    return sel;
  }

  function stepCard(s, i) {
    const opts = Array.isArray(s.opts) ? s.opts : [];
    const ending = opts.length === 0;
    return el('fieldset', { className: 'step' + (s.check && s.check.length ? ' has-marks' : '') }, [
      el('legend', { text: 'Step ' + (i + 1) + (s.title ? ': ' + s.title : '') }),
      marksBox(s.check),
      el('div', { className: 'grid2' }, [
        labelled('Step id', el('input', { type: 'text', 'data-field': 'id', value: s.id || '', maxlength: '40', autocomplete: 'off' })),
        labelled('Title', el('input', { type: 'text', 'data-field': 'title', value: s.title || '', maxlength: '120', autocomplete: 'off' })),
      ]),
      el('div', { className: 'grid2' }, [
        el('label', { className: 'check' }, [
          el('input', { type: 'checkbox', 'data-field': 'start', checked: !!s.start }),
          el('span', { text: 'Start step (a call begins here)' }),
        ]),
        labelled('Part of the call', stageSelect(s)),
      ]),
      labelled('What the caller says (one line each)', el('textarea', {
        'data-field': 'say', rows: '3', value: (Array.isArray(s.say) ? s.say : []).join('\n'),
      })),
      labelled('Tip for the caller (optional)', el('input', { type: 'text', 'data-field': 'tip', value: s.tip || '', maxlength: '300' })),
      ending ? labelled('This ending saves the result', resultSelect(s)) : null,
      el('p', { className: 'muted', text: ending ? 'No options: this step is an ending.' : 'Options (3 at most)' }),
      el('div', { className: 'opts' }, opts.map((o) => el('div', { className: 'opt' }, [
        labelled('Option label', el('input', { type: 'text', 'data-field': 'label', value: o.label || '', maxlength: '80' })),
        labelled('Goes to step id', el('input', { type: 'text', 'data-field': 'to', value: o.to || '', list: 'step-ids', maxlength: '40', autocomplete: 'off' })),
        el('button', { type: 'button', 'data-action': 'del-opt', className: 'danger', text: 'Remove option' }),
      ]))),
      el('div', { className: 'row wrap' }, [
        el('button', { type: 'button', 'data-action': 'add-opt', text: 'Add option', disabled: opts.length >= M.MAX_OPTS }),
        el('button', { type: 'button', 'data-action': 'del-step', className: 'danger', text: 'Remove step' }),
      ]),
    ]);
  }

  function renderPushbacks() {
    const box = $('pushbacks');
    box.textContent = '';
    work.pushbacks.forEach((p, i) => box.appendChild(el('fieldset', { className: 'pushback' + (p.check && p.check.length ? ' has-marks' : '') }, [
      el('legend', { text: 'Objection ' + (i + 1) }),
      marksBox(p.check),
      labelled('What the person says', el('input', { type: 'text', 'data-field': 'pb-label', value: p.label || '', maxlength: String(M.PUSHBACK_LABEL_MAX) })),
      labelled('What the caller answers', el('textarea', { 'data-field': 'pb-answer', rows: '2', maxlength: String(M.PUSHBACK_ANSWER_MAX), value: p.answer || '' })),
      el('button', { type: 'button', 'data-action': 'del-pb', className: 'danger', text: 'Remove this answer' }),
    ])));
    if (!work.pushbacks.length) box.appendChild(el('p', { className: 'muted', text: 'No answers to objections yet.' }));
    $('add-pushback').disabled = work.pushbacks.length >= M.MAX_PUSHBACKS;
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
      delete work.steps[i].result;
    } else if (action === 'del-opt') {
      const j = Array.from(fs.querySelectorAll('.opt')).indexOf(btn.closest('.opt'));
      work.steps[i].opts.splice(j, 1);
    } else if (action === 'del-mark') {
      const text = btn.closest('[data-mark]').getAttribute('data-mark');
      work.steps[i].check = (work.steps[i].check || []).filter((m) => m !== text);
      if (!work.steps[i].check.length) delete work.steps[i].check;
    }
    renderSteps();
    markDirty();
    runValidation();
    if (testChoices) renderTest();
    focusAfterRedraw(i, '#steps');
  }

  // After a redraw, keyboard focus goes back to the same card instead of the top of the page.
  function focusAfterRedraw(i, boxSel) {
    const cards = Array.from(document.querySelectorAll(boxSel + ' > fieldset'));
    const card = cards[Math.min(i, cards.length - 1)];
    const target = card && card.querySelector('input, textarea, select, button');
    if (target) target.focus({ preventScroll: true });
  }

  function onPushbacksEdit() {
    readPushbacks();
    markDirty();
    runValidation();
  }

  function onPushbacksClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    readAll();
    const i = pushbackFieldsets().indexOf(btn.closest(PB_SEL));
    const action = btn.getAttribute('data-action');
    if (action === 'del-pb') work.pushbacks.splice(i, 1);
    else if (action === 'del-mark') {
      const text = btn.closest('[data-mark]').getAttribute('data-mark');
      work.pushbacks[i].check = (work.pushbacks[i].check || []).filter((m) => m !== text);
      if (!work.pushbacks[i].check.length) delete work.pushbacks[i].check;
    }
    renderPushbacks();
    markDirty();
    runValidation();
    focusAfterRedraw(i, '#pushbacks');
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
    focusAfterRedraw(work.steps.length - 1, '#steps');
  }

  function addPushback() {
    readAll();
    if (work.pushbacks.length >= M.MAX_PUSHBACKS) return;
    work.pushbacks.push({ label: '', answer: '' });
    renderPushbacks();
    markDirty();
    runValidation();
    focusAfterRedraw(work.pushbacks.length - 1, '#pushbacks');
  }

  // ---------- saving ----------

  function openPublish() {
    const problems = runValidation();
    if (!$('script-name').value.trim()) { say('editor-msg', 'Enter a name for the script.', true); return; }
    if (problems.length) { say('editor-msg', 'Fix the problems listed above first. Then it can be ready for callers.', true); return; }
    $('publish-box').hidden = false;
    $('publish-note').focus();
  }

  // publish=false saves a draft. publish=true makes the new version the one callers use, and needs a change note.
  async function saveVersion(publish, note) {
    const name = $('script-name').value.trim();
    work.name = name;
    const problems = runValidation();
    if (!name) { say('editor-msg', 'Enter a name for the script.', true); return; }
    if (name.length > 120) { say('editor-msg', 'The name is longer than 120 characters.', true); return; }
    if (note.length > M.MAX_CHANGE_NOTE) { say('editor-msg', 'The change note is longer than 500 characters.', true); return; }
    if (publish && problems.length) { say('editor-msg', 'Fix the problems listed above first. Then it can be ready for callers.', true); return; }
    if (publish && !note) { say('editor-msg', 'Write a change note for this version.', true); return; }
    // The database checks the pushback list on every save, so a broken one cannot be saved even as a draft.
    const pbProblems = M.validatePushbacks(work.pushbacks).filter((p) => !p.startsWith('Check this'));
    if (pbProblems.length) { say('editor-msg', 'Fix the answers to objections first: ' + pbProblems[0], true); return; }

    setBusy(true);
    try {
      const { data, error } = await client.rpc('admin_save_script', {
        p_script: work.scriptId, p_name: name, p_call_type: work.callTypeId, p_steps: work.steps,
        p_pushbacks: work.pushbacks, p_change_note: note, p_publish: publish,
      });
      if (error) throw new Error(error.message);
      const out = Array.isArray(data) ? data[0] : data;
      work.scriptId = (out && out.script_id) || work.scriptId;
      await loadVersions(work.scriptId);
      dirty = false;
      $('publish-note').value = '';
      renderEditor();
      renderHistory();
      fillSelects();
      $('history-panel').hidden = false;
      let msg = publish ? 'Ready for callers. Calling lists with this script use this version now.' : 'Saved. Not ready for callers yet.';
      if (problems.length && !publish) {
        msg += ' It has ' + problems.length + ' thing' + (problems.length === 1 ? '' : 's') + ' to fix before it can be ready for callers.';
      }
      say('editor-msg', msg);
      if (hooks.onSaved) hooks.onSaved(work.scriptId);
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
    if ($('test-panel')) $('test-panel').hidden = true;
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
    if (res.status === 'end') {
      const last = steps.find((s) => s.id === res.path[res.path.length - 1]);
      const t = currentType();
      const r = last && last.result && t ? (t.results || []).find((x) => x.key === last.result) : null;
      if (r) msg += ' It saves "' + r.label + '".';
    }
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
        text: v.published ? 'Ready for callers' : 'Not ready', className: v.published ? 'published-tag' : '',
      })]),
      cell(new Date(v.created_at).toLocaleString()),
      cell(v.change_note || ''),
      el('td', null, [el('div', { className: 'actions' }, [
        el('button', { type: 'button', text: 'Load into editor', onClick: () => guardDirty(() => loadVersion(v.version)) }),
        el('button', { type: 'button', text: 'See results', onClick: () => ctx.navigate('calling/reports', { script: work.scriptId, version: v.id }) }),
      ])]),
    ])));
  }

  // Copies an old version into the editor. It is not saved until the admin saves it.
  function loadVersion(n) {
    const v = versions.find((x) => x.version === n);
    if (!v) return;
    work.steps = clone(v.steps || []);
    work.pushbacks = clone(v.pushbacks || []);
    dirty = true;
    renderEditor();
    say('editor-msg', 'Loaded v' + n + ' into the editor. Save to make it a new version.');
  }

  function fillSelects() {
    const diffA = $('diff-a');
    const diffB = $('diff-b');
    [diffA, diffB].forEach((s) => { s.textContent = ''; });
    versions.forEach((v) => {
      const label = 'Version ' + v.version + (v.published ? ' (ready for callers)' : ' (not ready)');
      diffA.appendChild(el('option', { value: String(v.version), text: label }));
      diffB.appendChild(el('option', { value: String(v.version), text: label }));
    });
    if (versions.length >= 2) diffA.value = String(versions[1].version);
    if (versions.length) diffB.value = String(versions[0].version);
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

  window.VectorScriptEditor = { mount, unmount, hasUnsaved, setCallTypes, open, startNew, currentScriptId: () => work.scriptId };
})();
