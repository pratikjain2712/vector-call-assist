'use strict';
/* Scripts tab of the admin app (web/admin.html): the list of scripts (type, live version, campaigns that use it,
   calls and good results in the last 90 days, last change, Edit · Report), two ways to start a script (from the
   shared template library, or by hand) and the script editor (web/js/script-editor.js).
   Phase A.2: the template library lives in the database (script_templates, migration
   20261025140000_template_library.sql) and is kept by the Vector team. "Start from a template" opens it with
   filters (purpose, class, board, language), a preview of steps and pushback answers, and "Use this template",
   which starts a new institute script with the template's call type and its "Check this" marks.
   Institutes no longer make scripts with AI. The AI script maker moved to the "Library" view, which only
   platform admins (is_platform_admin) see: there the Vector team drafts with AI (the ai-script-draft Edge
   Function), edits, and publishes templates (platform_upsert_template) and common answers
   (platform_upsert_common_answer).
   Routes: #scripts (list), #scripts?edit=<script id> (editor), #scripts?new=blank|template (editor with a new
   script), #scripts?library=1 (Library view, platform admins only).
   Scripts are a paid add-on (my_features: 'scripts'). Without it the list is read-only with "Add Scripts to use
   this"; the server refuses saving anyway.
   Reads: admin_list_scripts, admin_list_call_types, my_features, list_script_templates, is_platform_admin;
   Library view: admin_ai_usage and the common_answers table. A database without the library functions falls
   back to the built-in templates (web/js/script-templates.js).
   The pure helpers at the top are also loaded by tests/web/admin-scripts.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------

  // "58%" of calls with a good result, or "—" when there were no calls.
  function goodRate(calls, good) {
    const c = Number(calls) || 0;
    if (c <= 0) return '—';
    return Math.round((100 * (Number(good) || 0)) / c) + '%';
  }

  // The campaigns that use a script, open ones first: "Oct fees, Nov fees (closed)", or "Not used".
  function usedInText(list) {
    const rows = Array.isArray(list) ? list : [];
    if (!rows.length) return 'Not used';
    return rows.map((c) => String(c.name || '') + (c.status === 'closed' ? ' (closed)' : c.status === 'draft' ? ' (draft)' : '')).join(', ');
  }

  // "v3", or "Draft" when nothing is published.
  const liveText = (row) => (row && row.live_version ? 'v' + row.live_version : 'Draft');

  // "3 of 20 AI drafts used this month", or '' when usage is unknown.
  function usageText(u) {
    if (!u || u.used === undefined || u.used === null || !u.monthly_limit) return '';
    return u.used + ' of ' + u.monthly_limit + ' AI drafts used this month';
  }
  const usageLeft = (u) => (u && u.monthly_limit ? Math.max(0, u.monthly_limit - (Number(u.used) || 0)) : null);

  // The AI form, checked before it is sent (the server checks again). Returns the problem in plain English or ''.
  function briefProblem(b) {
    if (!b || !b.call_type) return 'Choose the call type.';
    if (!b.audience) return 'Say who you call.';
    if (!b.purpose || !b.purpose.trim()) return 'Write what the call is for.';
    if (b.purpose.length > 600) return 'Keep "What is the call for?" to 600 characters.';
    if ((b.facts || '').length > 1500) return 'Keep the facts to 1500 characters.';
    if ((b.never_say || '').length > 600) return 'Keep "Never say" to 600 characters.';
    return '';
  }

  // The easy-to-read score as a short badge: { text, tone } with tone easy | ok | hard.
  function scoreBadge(score) {
    if (!score || typeof score.score !== 'number') return null;
    const tone = score.score >= 75 ? 'easy' : score.score >= 55 ? 'ok' : 'hard';
    return { text: score.label + ' (' + score.score + '/100)', tone };
  }

  // ----- template library (Phase A.2) -----

  const BOARDS = ['CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other'];
  const CLASSES = ['6th', '7th', '8th', '9th', '10th', '11th', '12th'];
  const TEMPLATE_LANGUAGES = [['en', 'English'], ['hinglish', 'Hinglish'], ['hindi', 'Hindi']];
  const languageLabel = (code) => (TEMPLATE_LANGUAGES.find((l) => l[0] === code) || [null, code || ''])[1];

  // The list_script_templates arguments from the filter form: blank fields are null (any).
  function templateArgs(f) {
    const v = (x) => { const s = String(x === undefined || x === null ? '' : x).trim(); return s || null; };
    const x = f || {};
    return { p_call_type: v(x.callType), p_class_label: v(x.classLabel), p_board: v(x.board), p_language: v(x.language) };
  }

  // "All classes · All boards", or "9th, 10th · CBSE".
  function templateTags(row) {
    const r = row || {};
    const classes = Array.isArray(r.class_labels) && r.class_labels.length ? r.class_labels.join(', ') : 'All classes';
    const boards = Array.isArray(r.boards) && r.boards.length ? r.boards.join(', ') : 'All boards';
    return classes + ' · ' + boards;
  }

  // "10 steps · 6 pushback answers · 4 facts to fill in".
  function templateSize(row) {
    const r = row || {};
    const n = (Array.isArray(r.steps) ? r.steps : []).length;
    const p = (Array.isArray(r.pushbacks) ? r.pushbacks : []).length;
    const marks = Number(r.check_marks) || 0;
    return n + ' step' + (n === 1 ? '' : 's') + ' · ' + p + ' pushback answer' + (p === 1 ? '' : 's') +
      (marks ? ' · ' + marks + ' fact' + (marks === 1 ? '' : 's') + ' to fill in' : '');
  }

  // The built-in templates (web/js/script-templates.js) in the shape of list_script_templates rows, for a
  // database without the library. They have no class or board tags and are in English.
  function localTemplates(list) {
    return (list || []).map((t) => ({
      key: t.key, name: t.name, call_type: t.call_type, call_type_label: null, audience: t.audience || null, about: t.about,
      class_labels: [], boards: [], language: 'en', steps: t.steps, pushbacks: t.pushbacks || [], version: 1, active: true,
      check_marks: (t.steps || []).concat(t.pushbacks || []).filter((x) => x && Array.isArray(x.check) && x.check.length).length,
    }));
  }
  // The same filters, in the browser, for the built-in templates.
  function filterLocal(rows, args) {
    const a = args || {};
    return (rows || []).filter((r) => (!a.p_call_type || r.call_type === a.p_call_type) && (!a.p_language || r.language === a.p_language));
  }

  // A comma or line separated list: trimmed, blanks and repeats dropped. "8th, 9th\n9th" -> ['8th', '9th'].
  function splitList(text) {
    const out = [];
    String(text || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).forEach((s) => { if (!out.includes(s)) out.push(s); });
    return out;
  }

  // What stops a template from going into the library, in plain English. "Check this" marks are allowed: the
  // institute fills them in. resultKeys: the results of the template's call type.
  function libraryProblems(script, resultKeys, M) {
    if (!script || !Array.isArray(script.steps)) return ['The steps must be a list.'];
    return M.validateScript(script, { resultKeys }).filter((p) => !/^Check this \(/.test(p));
  }

  // Reads a JSON list typed in the Library form: { value } or { error }.
  function readJsonList(text, what) {
    const s = String(text || '').trim();
    if (!s) return { value: [] };
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? { value: v } : { error: what + ' must be a JSON list: [ … ].' };
    } catch (err) { return { error: what + ' is not valid JSON: ' + err.message }; }
  }

  const pure = { goodRate, usedInText, liveText, usageText, usageLeft, briefProblem, scoreBadge, BOARDS, CLASSES,
    languageLabel, templateArgs, templateTags, templateSize, localTemplates, filterLocal, splitList, libraryProblems, readJsonList };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ---------- browser ----------

  const S = window.VectorAdminShared;
  const E = window.VectorScriptEditor;
  const M = window.ScriptModel;
  const TPL = window.ScriptTemplates;
  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const AUDIENCES = ['Parents', 'Students', 'Working people'];
  const LANGUAGES = [['simple_english', 'Simple English'], ['hinglish', 'Hinglish'], ['hindi', 'Hindi']];
  const COMMON_RESULTS = [['', 'None'], ['call_back_later', 'Call back later'], ['do_not_call', 'Do not call again'],
    ['wrong_number', 'Wrong number'], ['busy', 'Busy'], ['no_answer', 'No answer']];

  let ctx = null;
  let rows = [];            // admin_list_scripts
  let types = [];           // admin_list_call_types
  let features = null;      // my_features(); null when unknown (the server still checks)
  let usage = null;         // admin_ai_usage row
  let draft = null;         // { script, checks, brief } of the last AI draft
  let pendingNew = false;   // the editor holds a new script started from this tab (template)
  let busy = false;
  let ready = null;         // the first load, so show() can wait for it
  let platformAdmin = false;   // is_platform_admin(): the Vector team sees the Library view
  let templates = [];       // list_script_templates rows on show
  let libraryMissing = false;  // the database has no list_script_templates yet
  let tplSeq = 0;
  let libRows = [];         // every template, for the Library view
  let answers = [];         // every common answer, for the Library view

  const hasFeature = (f) => !features || features.indexOf(f) >= 0;
  const typeById = (id) => types.find((t) => t.id === id) || null;
  const typeByKey = (key) => types.find((t) => t.key === key) || null;

  // The browser's own "Leave site?" question while the editor has unsaved changes.
  function onLeave(e) {
    if (!E.hasUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  }

  // ---------- data ----------

  async function load() {
    const [list, t, f, pa] = await Promise.all([
      ctx.rpc('admin_list_scripts').catch((err) => { say('scripts-msg', 'Could not load scripts: ' + err.message, true); return []; }),
      ctx.rpc('admin_list_call_types').catch(() => []),
      ctx.rpc('my_features').catch(() => null),
      ctx.rpc('is_platform_admin').catch(() => false),
    ]);
    rows = Array.isArray(list) ? list : [];
    types = Array.isArray(t) ? t : [];
    features = Array.isArray(f) ? f : null;
    platformAdmin = pa === true || (Array.isArray(pa) && pa[0] === true);
    E.setCallTypes(types);
    renderList();
    renderAddOn();
    fillTypeSelects();
    $('scripts-library-open').hidden = !platformAdmin;
    if (platformAdmin) {
      usage = await ctx.rpc('admin_ai_usage').then((u) => (Array.isArray(u) ? u[0] || null : u)).catch(() => null);
      fillAiForm();
      renderUsage();
    }
  }

  async function reloadList() {
    try {
      rows = (await ctx.rpc('admin_list_scripts')) || [];
      say('scripts-msg', '');
    } catch (err) { say('scripts-msg', 'Could not load scripts: ' + err.message, true); }
    renderList();
  }

  // ---------- views ----------

  function showView(name) {
    $('scripts-list-view').hidden = name !== 'list';
    $('scripts-library-view').hidden = name !== 'library';
    $('scripts-editor-view').hidden = name !== 'editor';
    $('scripts-unsaved').hidden = !(name !== 'editor' && E.hasUnsaved());
  }

  // Shows the view the address asks for. Errors go to the tab's message line (the shell does not wait for this).
  function show(params) {
    route(params || {}).catch((err) => say('scripts-msg', err.message, true));
  }

  async function route(p) {
    if (ready) await ready;
    if (!ctx) return;
    if (p.edit && hasFeature('scripts')) {
      let row = rows.find((r) => r.id === p.edit);
      if (!row) { await reloadList(); row = rows.find((r) => r.id === p.edit); }
      if (row && await E.open(row)) { pendingNew = false; showView('editor'); return; }
      if (!row) say('scripts-msg', 'That script was not found.', true);
    } else if (p.new && hasFeature('scripts')) {
      if (p.new === 'blank' && !pendingNew) {
        if (E.startNew(null)) { showView('editor'); return; }
      } else if (pendingNew) { showView('editor'); return; }
    } else if (p.library || p.ai) {
      if (platformAdmin) {
        showView('library');
        loadLibrary();
        return;
      }
      say('scripts-msg', 'The script library is kept by the Vector team. Start from a template, or write a script by hand.');
    }
    showView('list');
  }

  // ---------- list ----------

  function renderAddOn() {
    const on = hasFeature('scripts');
    $('scripts-addon').hidden = on;
    ['scripts-template', 'new-script'].forEach((id) => { $(id).disabled = !on; });
  }

  function renderList() {
    const body = $('scripts-body');
    body.textContent = '';
    $('scripts-empty').hidden = rows.length > 0;
    $('scripts-table').hidden = rows.length === 0;
    const canEdit = hasFeature('scripts');
    rows.forEach((r) => {
      const t = typeById(r.call_type_id);
      const actions = [];
      if (canEdit) actions.push(el('button', { type: 'button', className: 'linkish', text: 'Edit', 'aria-label': 'Edit ' + r.name,
        onClick: () => ctx.navigate('scripts', { edit: r.id }) }));
      if (r.live_version_id) {
        if (actions.length) actions.push(el('span', { className: 'muted', 'aria-hidden': 'true', text: ' · ' }));
        actions.push(el('button', { type: 'button', className: 'linkish', text: 'Report', 'aria-label': 'Report for ' + r.name,
          onClick: () => ctx.navigate('reports', { script: r.id, version: r.live_version_id }) }));
      }
      const name = el('td', { 'data-label': 'Script', className: 'name' }, [el('span', { text: r.name })]);
      if (r.check_marks > 0) name.appendChild(el('span', { className: 'to-check', text: r.check_marks + ' to check' }));
      body.appendChild(el('tr', null, [
        name,
        el('td', { 'data-label': 'Type', text: r.call_type_label || (t ? t.label : 'No type') }),
        el('td', { 'data-label': 'Live version', className: r.live_version ? '' : 'muted', text: liveText(r) }),
        el('td', { 'data-label': 'Used in', className: (r.used_in || []).length ? '' : 'muted', text: usedInText(r.used_in) }),
        el('td', { 'data-label': 'Calls (90 days)', className: 'num', text: r.calls ? S.count(r.calls) : '—' }),
        el('td', { 'data-label': 'Good result', className: 'num', text: goodRate(r.calls, r.good_calls) }),
        el('td', { 'data-label': 'Changed', text: S.formatDate(r.changed_at, { year: false }) }),
        el('td', { 'data-label': '', className: 'row-actions' }, actions),
      ]));
    });
  }

  // ---------- template library (institutes) ----------

  function toggleTemplates() {
    const panel = $('scripts-templates');
    panel.hidden = !panel.hidden;
    $('scripts-template').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) { loadTemplates(); $('tpl-type').focus(); }
  }

  // The purpose, language and board selects; the purpose list is the built-in call types.
  function fillTypeSelects() {
    [['tpl-type', 'All purposes'], ['lib-type', null]].forEach(([id, any]) => {
      const sel = $(id);
      if (!sel) return;
      const keep = sel.value;
      sel.textContent = '';
      if (any) sel.appendChild(el('option', { value: '', text: any }));
      types.filter((t) => t.built_in !== false && t.active !== false).forEach((t) => sel.appendChild(el('option', { value: t.key, text: t.label })));
      if (keep && Array.from(sel.options).some((o) => o.value === keep)) sel.value = keep;
    });
  }

  const filterForm = () => ({ callType: $('tpl-type').value, classLabel: $('tpl-class').value, board: $('tpl-board').value, language: $('tpl-language').value });

  async function loadTemplates() {
    const my = ++tplSeq;
    const args = templateArgs(filterForm());
    say('tpl-msg', 'Loading templates…');
    let list;
    try {
      list = libraryMissing ? null : await ctx.rpc('list_script_templates', args);
    } catch (err) {
      if (!ctx.isMissing(err)) { if (my === tplSeq) say('tpl-msg', 'Could not load the template library: ' + err.message, true); return; }
      libraryMissing = true;
    }
    if (my !== tplSeq || !ctx) return;
    if (libraryMissing) {
      list = filterLocal(localTemplates(TPL.TEMPLATES), args);
      say('tpl-msg', 'Showing the built-in templates. The shared library needs the database update.');
    } else say('tpl-msg', '');
    templates = Array.isArray(list) ? list : [];
    renderTemplates();
  }

  function renderTemplates() {
    const grid = $('tpl-results');
    grid.textContent = '';
    $('tpl-count').textContent = templates.length === 1 ? '1 template' : templates.length + ' templates';
    $('tpl-none').hidden = templates.length > 0;
    templates.forEach((t, i) => {
      const t2 = typeByKey(t.call_type);
      const previewId = 'tpl-preview-' + i;
      const preview = el('div', { id: previewId, className: 'tpl-preview', hidden: true });
      const previewBtn = el('button', { type: 'button', className: 'linkish', text: 'Preview', 'aria-expanded': 'false',
        'aria-controls': previewId, 'aria-label': 'Preview ' + t.name });
      previewBtn.addEventListener('click', () => {
        const open = preview.hidden;
        if (open && !preview.firstChild) fillPreview(preview, t);
        preview.hidden = !open;
        previewBtn.setAttribute('aria-expanded', String(open));
        previewBtn.textContent = open ? 'Hide preview' : 'Preview';
      });
      grid.appendChild(el('article', { className: 'tpl', 'data-key': t.key, 'aria-label': t.name }, [
        el('h3', { text: t.name }),
        el('p', { className: 'tpl-tags' }, [
          el('span', { className: 'pill', text: t.call_type_label || (t2 ? t2.label : t.call_type) }),
          el('span', { className: 'pill', text: languageLabel(t.language) }),
          el('span', { className: 'muted small', text: templateTags(t) }),
        ]),
        el('p', { text: t.about || '' }),
        t.audience ? el('p', { className: 'muted small', text: 'For: ' + t.audience }) : null,
        el('p', { className: 'muted small', text: templateSize(t) }),
        el('div', { className: 'tpl-actions' }, [
          previewBtn,
          el('button', { type: 'button', className: 'primary', text: 'Use this template', 'data-template': t.key,
            'aria-label': 'Use the ' + t.name + ' template', onClick: () => useTemplate(t) }),
        ]),
        preview,
      ]));
    });
  }

  // Steps (what to say, the choices or the result) and pushback answers, with the facts to fill in.
  function fillPreview(box, t) {
    const type = typeByKey(t.call_type);
    const resultLabel = (key) => { const r = type && (type.results || []).find((x) => x.key === key); return r ? r.label : key; };
    const steps = el('ol', { className: 'tpl-steps' });
    (t.steps || []).forEach((st) => {
      const li = el('li', null, [el('strong', { text: st.title || st.id })]);
      (st.say || []).forEach((line) => li.appendChild(el('div', { text: line })));
      if (st.opts && st.opts.length) li.appendChild(el('div', { className: 'muted small', text: 'Choices: ' + st.opts.map((o) => o.label).join(' · ') }));
      else if (st.result) li.appendChild(el('div', { className: 'muted small', text: 'Ends with: ' + resultLabel(st.result) }));
      (st.check || []).forEach((c) => li.appendChild(el('div', { className: 'tpl-check', text: 'Fill in: ' + c })));
      steps.appendChild(li);
    });
    box.appendChild(el('h4', { text: 'Steps' }));
    box.appendChild(steps);
    if ((t.pushbacks || []).length) {
      box.appendChild(el('h4', { text: 'Pushback answers' }));
      box.appendChild(el('ul', { className: 'plain pb-chips' }, t.pushbacks.map((p) => el('li', null, [
        el('span', { className: 'pb-label', text: '"' + p.label + '"' }),
        el('span', { className: 'pb-answer', text: p.answer }),
        ...(p.check || []).map((c) => el('span', { className: 'tpl-check', text: 'Fill in: ' + c })),
      ]))));
    }
  }

  function useTemplate(t) {
    if (!t) return;
    if (!typeByKey(t.call_type)) { say('tpl-msg', 'This template\'s call type is not available in your institute.', true); return; }
    const script = { name: t.name, call_type: t.call_type, steps: JSON.parse(JSON.stringify(t.steps || [])), pushbacks: JSON.parse(JSON.stringify(t.pushbacks || [])) };
    if (!E.startNew(script, 'Started from the "' + t.name + '" template. Add your own facts where it says "Check this", then save.')) return;
    pendingNew = true;
    $('scripts-templates').hidden = true;
    $('scripts-template').setAttribute('aria-expanded', 'false');
    ctx.navigate('scripts', { new: 'template' });
  }

  function buildTemplates() {
    const field = (label, input) => el('label', { className: 'fld' }, [el('span', { text: label }), input]);
    const classInput = el('input', { id: 'tpl-class', type: 'text', maxlength: '20', list: 'tpl-class-list', placeholder: 'Any class', autocomplete: 'off' });
    const panel = el('section', { className: 'panel', id: 'scripts-templates', hidden: true, 'aria-labelledby': 'scripts-templates-title' }, [
      el('h2', { id: 'scripts-templates-title', text: 'Start from a template' }),
      el('p', { className: 'muted small', text: 'Ready scripts from the Vector team for fees, admissions, sales and more. You add your own facts (fees, dates, address) where it says "Check this" before callers use it.' }),
      el('form', { id: 'tpl-filters', className: 'tpl-filters', 'aria-label': 'Filter templates' }, [
        field('Purpose', el('select', { id: 'tpl-type' })),
        field('Class', classInput),
        el('datalist', { id: 'tpl-class-list' }, CLASSES.map((c) => el('option', { value: c }))),
        field('Board', el('select', { id: 'tpl-board' }, [el('option', { value: '', text: 'Any board' })].concat(BOARDS.map((b) => el('option', { value: b, text: b }))))),
        field('Language', el('select', { id: 'tpl-language' }, [el('option', { value: '', text: 'Any language' })]
          .concat(TEMPLATE_LANGUAGES.slice(0, 2).map(([v, t]) => el('option', { value: v, text: t }))))),
      ]),
      el('p', { id: 'tpl-count', className: 'muted small', role: 'status', 'aria-live': 'polite' }),
      el('p', { id: 'tpl-msg', className: 'msg', role: 'status' }),
      el('div', { className: 'tpl-grid', id: 'tpl-results' }),
      el('p', { id: 'tpl-none', className: 'muted', hidden: true, text: 'No template fits these filters. Try "All purposes" or "Any language", or write a script by hand.' }),
    ]);
    return panel;
  }

  // ---------- Library view (platform admins): templates, common answers and the AI script maker ----------

  async function loadLibrary() {
    say('lib-msg', 'Loading the library…');
    try {
      const [list, ans] = await Promise.all([
        ctx.rpc('list_script_templates', { p_include_inactive: true }),
        ctx.client.from('common_answers').select('key, label, answer, fallback, result, checks, tags, active').order('label'),
      ]);
      libRows = Array.isArray(list) ? list : [];
      if (ans.error) throw new Error(ans.error.message);
      answers = ans.data || [];
      say('lib-msg', '');
    } catch (err) {
      say('lib-msg', 'Could not load the library: ' + err.message, true);
    }
    renderLibrary();
    renderAnswers();
  }

  function renderLibrary() {
    const body = $('lib-body');
    body.textContent = '';
    libRows.forEach((t) => {
      body.appendChild(el('tr', { className: t.active ? '' : 'muted' }, [
        el('td', { 'data-label': 'Template', className: 'name', text: t.name }),
        el('td', { 'data-label': 'Purpose', text: t.call_type_label || t.call_type }),
        el('td', { 'data-label': 'Language', text: languageLabel(t.language) }),
        el('td', { 'data-label': 'For', text: templateTags(t) }),
        el('td', { 'data-label': 'Version', className: 'num', text: 'v' + t.version }),
        el('td', { 'data-label': 'Shown', text: t.active ? 'Yes' : 'No' }),
        el('td', { 'data-label': '', className: 'row-actions' }, [el('button', { type: 'button', className: 'linkish', text: 'Edit',
          'aria-label': 'Edit template ' + t.name, onClick: () => fillLibraryForm(t) })]),
      ]));
    });
    $('lib-count').textContent = libRows.length + ' template' + (libRows.length === 1 ? '' : 's') + ' in the library';
  }

  // Fills the template form from a library row, an AI draft or nothing (a new template).
  function fillLibraryForm(t) {
    const x = t || {};
    $('lib-key').value = x.key || '';
    $('lib-key').readOnly = !!x.version;
    $('lib-name').value = x.name || '';
    if (x.call_type) $('lib-type').value = x.call_type;
    $('lib-language').value = x.language || 'en';
    $('lib-audience').value = x.audience || '';
    $('lib-about').value = x.about || '';
    $('lib-classes').value = (x.class_labels || []).join(', ');
    document.querySelectorAll('input.lib-board').forEach((b) => { b.checked = (x.boards || []).includes(b.value); });
    $('lib-active').checked = x.active !== false;
    $('lib-steps').value = JSON.stringify(x.steps || [], null, 2);
    $('lib-pushbacks').value = JSON.stringify(x.pushbacks || [], null, 2);
    $('lib-form-title').textContent = x.version ? 'Edit template: ' + x.name + ' (v' + x.version + ')' : 'New template';
    say('lib-form-msg', '');
    checkLibraryForm();
    $('lib-form').scrollIntoView({ block: 'start' });
    $('lib-name').focus();
  }

  // The form as a template, or { error }.
  function readLibraryForm() {
    const steps = readJsonList($('lib-steps').value, 'Steps');
    if (steps.error) return { error: steps.error };
    const pbs = readJsonList($('lib-pushbacks').value, 'Pushback answers');
    if (pbs.error) return { error: pbs.error };
    return {
      key: $('lib-key').value.trim().toLowerCase(), name: $('lib-name').value.trim(), call_type: $('lib-type').value,
      language: $('lib-language').value, audience: $('lib-audience').value.trim(), about: $('lib-about').value.trim(),
      class_labels: splitList($('lib-classes').value),
      boards: Array.from(document.querySelectorAll('input.lib-board:checked')).map((b) => b.value),
      active: $('lib-active').checked, steps: steps.value, pushbacks: pbs.value,
    };
  }

  function checkLibraryForm() {
    const f = readLibraryForm();
    const list = $('lib-problems');
    list.textContent = '';
    let problems;
    if (f.error) problems = [f.error];
    else {
      const t = typeByKey(f.call_type);
      problems = libraryProblems(f, t ? (t.results || []).map((r) => r.key) : null, M);
      const marks = M.checkMarks(f).length;
      $('lib-marks').textContent = marks ? marks + ' "Check this" mark' + (marks === 1 ? '' : 's') + ' for institutes to fill in.' : 'No "Check this" marks.';
    }
    problems.forEach((p) => list.appendChild(el('li', { text: p })));
    $('lib-problems-box').hidden = !problems.length;
    return problems;
  }

  async function publishTemplate(e) {
    e.preventDefault();
    if (busy) return;
    const f = readLibraryForm();
    if (f.error) { say('lib-form-msg', f.error, true); return; }
    if (!/^[a-z][a-z0-9_]{1,59}$/.test(f.key)) { say('lib-form-msg', 'The key is 2 to 60 lowercase letters, numbers or _, such as fees_reminder_polite.', true); return; }
    if (!f.name) { say('lib-form-msg', 'Give the template a name.', true); return; }
    if (checkLibraryForm().length) { say('lib-form-msg', 'Fix the problems listed above first.', true); return; }
    busy = true;
    say('lib-form-msg', 'Publishing…');
    try {
      const v = await ctx.rpc('platform_upsert_template', {
        p_key: f.key, p_name: f.name, p_call_type: f.call_type, p_steps: f.steps, p_pushbacks: f.pushbacks,
        p_audience: f.audience || null, p_about: f.about || null, p_class_labels: f.class_labels, p_boards: f.boards,
        p_language: f.language, p_active: f.active,
      });
      busy = false;
      say('lib-form-msg', 'Published "' + f.name + '" to the library as v' + (Array.isArray(v) ? v[0] : v) + '. Institutes see it now.');
      $('lib-key').readOnly = true;
      await loadLibrary();
    } catch (err) {
      busy = false;
      say('lib-form-msg', err.message, true);
    }
  }

  function renderAnswers() {
    const body = $('ans-body');
    body.textContent = '';
    answers.forEach((a) => {
      body.appendChild(el('tr', { className: a.active ? '' : 'muted' }, [
        el('td', { 'data-label': 'Question', className: 'name', text: a.label }),
        el('td', { 'data-label': 'Answer', text: a.answer }),
        el('td', { 'data-label': 'Institute fills in', text: (a.checks || []).length ? (a.checks || []).join(' ') : '—' }),
        el('td', { 'data-label': '', className: 'row-actions' }, [el('button', { type: 'button', className: 'linkish', text: 'Edit',
          'aria-label': 'Edit answer ' + a.label, onClick: () => fillAnswerForm(a) })]),
      ]));
    });
  }

  function fillAnswerForm(a) {
    const x = a || {};
    $('ans-key').value = x.key || '';
    $('ans-key').readOnly = !!x.key;
    $('ans-label').value = x.label || '';
    $('ans-answer').value = x.answer || '';
    $('ans-fallback').value = x.fallback || '';
    $('ans-result').value = x.result || '';
    $('ans-checks').value = (x.checks || []).join('\n');
    $('ans-tags').value = (x.tags || []).join(', ');
    $('ans-active').checked = x.active !== false;
    say('ans-msg', '');
    $('ans-label').focus();
  }

  async function saveAnswer(e) {
    e.preventDefault();
    if (busy) return;
    const key = $('ans-key').value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,59}$/.test(key)) { say('ans-msg', 'The key is 2 to 60 lowercase letters, numbers or _.', true); return; }
    if (!$('ans-label').value.trim() || !$('ans-answer').value.trim()) { say('ans-msg', 'Write the question and the answer.', true); return; }
    busy = true;
    try {
      await ctx.rpc('platform_upsert_common_answer', {
        p_key: key, p_label: $('ans-label').value.trim(), p_answer: $('ans-answer').value.trim(),
        p_fallback: $('ans-fallback').value.trim() || null, p_result: $('ans-result').value || null,
        p_checks: $('ans-checks').value.split('\n').map((s) => s.trim()).filter(Boolean),
        p_tags: splitList($('ans-tags').value), p_active: $('ans-active').checked,
      });
      busy = false;
      say('ans-msg', 'Saved "' + $('ans-label').value.trim() + '". Every script gets it now.');
      $('ans-key').readOnly = true;
      await loadLibrary();
    } catch (err) {
      busy = false;
      say('ans-msg', err.message, true);
    }
  }

  // ----- the AI script maker (inside the Library view) -----

  function fillAiForm() {
    const sel = $('ai-type');
    const keep = sel.value;
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: 'Choose a type' }));
    types.filter((t) => t.active !== false).forEach((t) => sel.appendChild(el('option', { value: t.key, text: t.label })));
    sel.value = keep || (typeByKey('fees') ? 'fees' : '');
    const ai = hasFeature('ai_drafts');
    $('ai-addon').hidden = ai;
    $('ai-form').querySelectorAll('input, select, textarea, button').forEach((n) => { n.disabled = !ai; });
  }

  function renderUsage() {
    $('ai-usage').textContent = usageText(usage);
    const left = usageLeft(usage);
    $('ai-make').disabled = busy || left === 0 || !hasFeature('ai_drafts');
    if (left === 0) say('ai-msg', 'All AI drafts for this month are used.');
  }

  function briefFromForm() {
    return {
      call_type: $('ai-type').value,
      audience: $('ai-audience').value,
      language: $('ai-language').value,
      purpose: $('ai-purpose').value.trim(),
      facts: $('ai-facts').value.trim(),
      never_say: $('ai-never').value.trim(),
    };
  }

  // Calls the ai-script-draft Edge Function with the signed-in person's own access token.
  async function aiCall(body) {
    const cfg = window.VECTOR_CONFIG || {};
    const { data } = await ctx.client.auth.getSession();
    const token = data && data.session ? data.session.access_token : '';
    if (!token) throw new Error('Sign in again.');
    let res;
    try {
      res = await fetch(String(cfg.supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1/ai-script-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: cfg.supabaseAnonKey },
        body: JSON.stringify(body),
      });
    } catch (err) { throw new Error('No connection. Try again.'); }
    let out = {};
    try { out = await res.json(); } catch (err) { out = {}; }
    if (!res.ok) {
      const e = new Error(out.error || 'The AI script maker did not answer. Try again.');
      e.code = out.code;
      throw e;
    }
    return out;
  }

  function setBusy(on, text) {
    busy = on;
    ['ai-make', 'ai-open', 'ai-simpler', 'ai-again'].forEach((id) => { if ($(id)) $(id).disabled = on; });
    document.querySelectorAll('#ai-steps button').forEach((b) => { b.disabled = on; });
    $('scripts-library-view').setAttribute('aria-busy', on ? 'true' : 'false');
    if (text !== undefined) say('ai-msg', text);
    if (!on) renderUsage();
  }

  async function makeDraft(e) {
    if (e) e.preventDefault();
    if (busy) return;
    const brief = briefFromForm();
    const problem = briefProblem(brief);
    if (problem) { say('ai-msg', problem, true); return; }
    setBusy(true, 'Writing the draft. This can take up to a minute.');
    try {
      const out = await aiCall({ action: 'draft', brief });
      draft = { script: out.script, checks: out.checks, brief };
      if (out.usage) usage = out.usage;
      renderDraft();
      setBusy(false, 'Draft ready. Read every line before it goes into the library.');
      $('ai-draft-title').focus();
    } catch (err) {
      if (err.code === 'limit') usage = Object.assign({}, usage || {}, { used: (usage && usage.monthly_limit) || 20 });
      setBusy(false, err.message);
      $('ai-msg').classList.add('error');
    }
  }

  async function makeSimpler(target) {
    if (busy || !draft) return;
    setBusy(true, target ? 'Making this line simpler…' : 'Making the whole script simpler…');
    try {
      const out = await aiCall({ action: 'simplify', brief: draft.brief, script: draft.script, target: target || null });
      draft = { script: out.script, checks: out.checks, brief: draft.brief };
      if (out.usage) usage = out.usage;
      renderDraft();
      setBusy(false, target ? 'Line made simpler.' : 'Script made simpler.');
    } catch (err) {
      setBusy(false, err.message);
      $('ai-msg').classList.add('error');
    }
  }

  // The AI draft goes into the template form, to edit and publish to the library.
  function draftToLibrary() {
    if (!draft) return;
    const s = draft.script;
    const lang = draft.brief.language === 'hinglish' ? 'hinglish' : draft.brief.language === 'hindi' ? 'hindi' : 'en';
    fillLibraryForm({ key: '', name: s.name, call_type: s.call_type, language: lang, audience: draft.brief.audience,
      about: draft.brief.purpose, steps: s.steps, pushbacks: s.pushbacks || [] });
    $('lib-key').value = String(s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    say('lib-form-msg', 'Draft copied here. Check every line, give it a key, then publish.');
  }

  function renderDraft() {
    const box = $('ai-draft');
    box.hidden = !draft;
    if (!draft) return;
    const s = draft.script;
    const c = draft.checks || {};
    const t = typeByKey(s.call_type);
    const resultLabel = (key) => { const r = t && (t.results || []).find((x) => x.key === key); return r ? r.label : key; };
    $('ai-draft-title').textContent = 'Draft: ' + s.name;
    const badge = scoreBadge(c.score);
    $('ai-score').hidden = !badge;
    if (badge) { $('ai-score').textContent = badge.text; $('ai-score').className = 'score score-' + badge.tone; }

    const marks = M.checkMarks(s);
    const checkBox = $('ai-checks');
    checkBox.textContent = '';
    checkBox.hidden = !marks.length && !(c.problems && c.problems.length);
    if (marks.length) {
      checkBox.appendChild(el('h4', { text: marks.length + ' "Check this" mark' + (marks.length === 1 ? '' : 's') }));
      checkBox.appendChild(el('ul', null, marks.map((m) => el('li', null, [
        el('strong', { text: (m.where === 'step' ? m.name : '"' + m.name + '"') + ': ' }), document.createTextNode(m.text),
      ]))));
    }
    if (c.problems && c.problems.length) {
      checkBox.appendChild(el('h4', { text: 'Fix before publishing' }));
      checkBox.appendChild(el('ul', null, c.problems.map((p) => el('li', { text: p }))));
    }

    const steps = $('ai-steps');
    steps.textContent = '';
    (s.steps || []).forEach((st) => {
      const li = el('li', null, [el('strong', { text: st.title || st.id })]);
      (st.say || []).forEach((line, j) => li.appendChild(el('div', { className: 'say-line' }, [
        el('span', { text: line }),
        el('button', { type: 'button', className: 'linkish small', text: 'Simpler', 'aria-label': 'Make this line simpler: ' + line,
          onClick: () => makeSimpler({ step: st.id, line: j }) }),
      ])));
      if (st.opts && st.opts.length) li.appendChild(el('div', { className: 'muted small', text: 'Choices: ' + st.opts.map((o) => o.label).join(' · ') }));
      else if (st.result) li.appendChild(el('div', { className: 'muted small', text: 'Ends with: ' + resultLabel(st.result) }));
      steps.appendChild(li);
    });

    const pbs = $('ai-pushbacks');
    pbs.textContent = '';
    (s.pushbacks || []).forEach((p, i) => pbs.appendChild(el('li', { className: 'pb-chip' }, [
      el('span', { className: 'pb-label', text: '"' + p.label + '"' }),
      el('span', { className: 'pb-answer', text: p.answer }),
      el('button', { type: 'button', className: 'linkish small', text: 'Simpler', 'aria-label': 'Make this answer simpler: ' + p.answer,
        onClick: () => makeSimpler({ pushback: i }) }),
    ])));
    $('ai-pushbacks-head').hidden = !(s.pushbacks || []).length;
  }

  // ---------- building the tab ----------

  function buildLibraryView() {
    const btn = (id, text, cls, extra) => el('button', Object.assign({ id, type: 'button', text, className: cls || '' }, extra || {}));
    const field = (label, input, cls) => el('label', { className: 'fld' + (cls ? ' ' + cls : '') }, [el('span', { text: label }), input]);
    const select = (id, opts) => el('select', { id }, opts.map(([v, t]) => el('option', { value: v, text: t })));
    const head = (cols) => el('thead', null, [el('tr', null, cols.map(([h, c]) => el('th', { text: h, className: c || '', scope: 'col' })))]);

    return el('div', { id: 'scripts-library-view', className: 'view', hidden: true }, [
      el('div', { className: 'row wrap between' }, [
        btn('lib-back', '← All scripts'),
        el('span', { className: 'pill tone-accent', text: 'Vector team only' }),
      ]),
      el('div', { className: 'tab-head' }, [
        el('h2', { text: 'Template library' }),
        el('p', { className: 'muted', text: 'Every institute picks from these templates and common answers. A change reaches institutes at once; scripts they already made stay as they are.' }),
      ]),
      el('p', { id: 'lib-msg', className: 'msg', role: 'status' }),

      el('section', { className: 'panel', 'aria-labelledby': 'lib-list-title' }, [
        el('div', { className: 'row wrap between' }, [
          el('h3', { id: 'lib-list-title', text: 'Templates' }),
          btn('lib-new', 'New template'),
        ]),
        el('p', { id: 'lib-count', className: 'muted small' }),
        el('div', { className: 'scroll' }, [el('table', { className: 'stack', id: 'lib-table' }, [
          head([['Template'], ['Purpose'], ['Language'], ['For'], ['Version', 'num'], ['Shown'], ['']]),
          el('tbody', { id: 'lib-body' }),
        ])]),
      ]),

      // The AI script maker: a first draft for the team, never sent to institutes as it is.
      el('section', { className: 'panel ai-grid', 'aria-label': 'AI script maker' }, [
        el('form', { id: 'ai-form', className: 'ai-form', novalidate: 'novalidate' }, [
          el('h3', { text: 'Draft a template with AI' }),
          el('p', { className: 'muted small', text: 'A first draft in simple words. A person on the team reads, fixes and owns every line before it goes into the library.' }),
          el('p', { id: 'ai-addon', className: 'addon-note', hidden: true, text: 'AI drafts are not on for this seat\'s institute.' }),
          el('div', { className: 'ai-row' }, [
            field('Call type', el('select', { id: 'ai-type' })),
            field('Who you call', select('ai-audience', AUDIENCES.map((a) => [a, a]))),
            field('Language', select('ai-language', LANGUAGES)),
          ]),
          field('What is the call for?', el('textarea', { id: 'ai-purpose', rows: '3', maxlength: '600',
            placeholder: 'For example: remind parents that the second term fee is due, and get a date when they will pay.' })),
          field('Facts the caller can use', el('textarea', { id: 'ai-facts', rows: '3', maxlength: '1500',
            placeholder: 'Leave real amounts and dates out: institutes fill them in where it says "Check this".' })),
          field('Never say', el('textarea', { id: 'ai-never', rows: '2', maxlength: '600', placeholder: 'For example: Do not threaten. Do not talk about the child\'s results.' })),
          el('div', { className: 'row wrap ai-actions' }, [
            el('button', { id: 'ai-make', type: 'submit', text: 'Make draft' }),
            el('span', { id: 'ai-usage', className: 'muted small' }),
          ]),
          el('p', { id: 'ai-msg', className: 'msg', role: 'status', 'aria-live': 'polite' }),
        ]),
        el('div', { id: 'ai-draft', className: 'ai-draft', hidden: true }, [
          el('div', { className: 'row between' }, [
            el('h3', { id: 'ai-draft-title', tabindex: '-1' }),
            el('span', { id: 'ai-score', className: 'score' }),
          ]),
          el('div', { id: 'ai-checks', className: 'problems', hidden: true }),
          el('h4', { text: 'Steps' }),
          el('ol', { id: 'ai-steps', className: 'ai-steps' }),
          el('h4', { id: 'ai-pushbacks-head', text: 'Pushback answers' }),
          el('ul', { id: 'ai-pushbacks', className: 'plain pb-chips' }),
          el('div', { className: 'row wrap' }, [
            btn('ai-open', 'Edit as a template', 'primary'),
            btn('ai-simpler', 'Make simpler'),
            btn('ai-again', 'Try again'),
          ]),
        ]),
      ]),

      el('form', { id: 'lib-form', className: 'panel lib-form', novalidate: 'novalidate', 'aria-labelledby': 'lib-form-title' }, [
        el('h3', { id: 'lib-form-title', text: 'New template' }),
        el('div', { className: 'lib-grid' }, [
          field('Key (never changes)', el('input', { id: 'lib-key', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'fees_reminder_polite' })),
          field('Name', el('input', { id: 'lib-name', type: 'text', maxlength: '120' })),
          field('Purpose (call type)', el('select', { id: 'lib-type' })),
          field('Language', select('lib-language', TEMPLATE_LANGUAGES)),
          field('Who it is for', el('input', { id: 'lib-audience', type: 'text', maxlength: '200' })),
          field('Classes (comma between; empty = every class)', el('input', { id: 'lib-classes', type: 'text', maxlength: '200', placeholder: '9th, 10th' })),
        ]),
        field('About', el('textarea', { id: 'lib-about', rows: '2', maxlength: '600' })),
        el('fieldset', { className: 'checks' }, [el('legend', { text: 'Boards (none ticked = every board)' })].concat(BOARDS.map((b) =>
          el('label', { className: 'check' }, [el('input', { type: 'checkbox', className: 'lib-board', value: b }), b])))),
        el('label', { className: 'check' }, [el('input', { type: 'checkbox', id: 'lib-active', checked: true }), 'Show to institutes']),
        field('Steps (JSON, script editor format)', el('textarea', { id: 'lib-steps', rows: '12', spellcheck: 'false', className: 'code' })),
        field('Pushback answers (JSON)', el('textarea', { id: 'lib-pushbacks', rows: '6', spellcheck: 'false', className: 'code' })),
        el('p', { id: 'lib-marks', className: 'muted small' }),
        el('div', { id: 'lib-problems-box', className: 'problems', hidden: true }, [
          el('h4', { text: 'Fix before publishing' }),
          el('ul', { id: 'lib-problems' }),
        ]),
        el('div', { className: 'row wrap' }, [
          el('button', { type: 'submit', id: 'lib-publish', className: 'primary', text: 'Publish to library' }),
        ]),
        el('p', { id: 'lib-form-msg', className: 'msg', role: 'status', 'aria-live': 'polite' }),
      ]),

      el('section', { className: 'panel', 'aria-labelledby': 'ans-title' }, [
        el('h3', { id: 'ans-title', text: 'Common answers' }),
        el('p', { className: 'muted small', text: 'Every script gets these in answer search and the helper column. An answer with "Institute fills in" shows on calls only after the institute adds its facts in Settings.' }),
        el('div', { className: 'scroll' }, [el('table', { className: 'stack', id: 'ans-table' }, [
          head([['Question'], ['Answer'], ['Institute fills in'], ['']]),
          el('tbody', { id: 'ans-body' }),
        ])]),
        el('form', { id: 'ans-form', className: 'subform', novalidate: 'novalidate' }, [
          el('h4', { text: 'Add or change an answer' }),
          el('div', { className: 'lib-grid' }, [
            field('Key (never changes)', el('input', { id: 'ans-key', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'where_number' })),
            field('Question the person asks', el('input', { id: 'ans-label', type: 'text', maxlength: '80' })),
            field('Saves the result', select('ans-result', COMMON_RESULTS)),
            field('Tags (comma between)', el('input', { id: 'ans-tags', type: 'text', maxlength: '200', placeholder: 'all, privacy' })),
          ]),
          field('Answer', el('textarea', { id: 'ans-answer', rows: '2', maxlength: '600' })),
          field('Fallback (when a placeholder has no value)', el('textarea', { id: 'ans-fallback', rows: '2', maxlength: '600' })),
          field('Institute fills in (one per line)', el('textarea', { id: 'ans-checks', rows: '2', maxlength: '600' })),
          el('label', { className: 'check' }, [el('input', { type: 'checkbox', id: 'ans-active', checked: true }), 'Show on calls']),
          el('div', { className: 'row wrap' }, [
            el('button', { type: 'submit', text: 'Save answer' }),
            el('button', { type: 'button', id: 'ans-new', text: 'New answer' }),
          ]),
          el('p', { id: 'ans-msg', className: 'msg', role: 'status', 'aria-live': 'polite' }),
        ]),
      ]),
    ]);
  }

  function build(box) {
    const btn = (id, text, cls, extra) => el('button', Object.assign({ id, type: 'button', text, className: cls || '' }, extra || {}));

    // List view
    box.appendChild(el('div', { id: 'scripts-list-view', className: 'view' }, [
      el('div', { className: 'tab-head scripts-head' }, [
        el('div', null, [
          el('h1', { text: 'Scripts' }),
          el('p', { className: 'muted', text: 'Each script has a type. The type decides the result buttons callers see. Callers see a script only after you publish it.' }),
        ]),
        el('div', { className: 'start-row' }, [
          btn('scripts-template', 'Start from a template', 'primary', { 'aria-expanded': 'false', 'aria-controls': 'scripts-templates' }),
          btn('new-script', 'Write by hand'),
          btn('scripts-library-open', 'Library', '', { hidden: true, title: 'Vector team: templates, common answers and AI drafts' }),
        ]),
      ]),
      el('p', { id: 'scripts-addon', className: 'addon-note', hidden: true, text: 'Scripts is not in your plan, so you can only look at your scripts. Add Scripts to use this.' }),
      el('p', { id: 'scripts-msg', className: 'msg', role: 'status' }),
      buildTemplates(),
      el('section', { className: 'panel', 'aria-label': 'Your scripts' }, [
        el('div', { className: 'scroll' }, [el('table', { id: 'scripts-table', className: 'stack' }, [
          el('thead', null, [el('tr', null, [
            ['Script'], ['Type'], ['Live version'], ['Used in'], ['Calls', 'num'], ['Good result', 'num'], ['Changed'], [''],
          ].map(([h, c]) => el('th', { text: h, className: c || '', scope: 'col' })))]),
          el('tbody', { id: 'scripts-body' }),
        ])]),
        el('p', { id: 'scripts-empty', className: 'muted', hidden: true, text: 'No scripts yet. Start from a template or write one by hand. Need a script that is not in the library? Ask the Vector team.' }),
        el('p', { className: 'muted small', text: 'Calls and good results are for the last 90 days.' }),
      ]),
    ]));

    box.appendChild(buildLibraryView());

    // Editor view
    const editorBox = el('div', { id: 'scripts-editor-view', className: 'view', hidden: true });
    box.appendChild(editorBox);
    box.insertBefore(el('p', { id: 'scripts-unsaved', className: 'addon-note', hidden: true }, [
      document.createTextNode('You have unsaved changes in the editor. '),
      el('button', { type: 'button', className: 'linkish', text: 'Go back to the editor', onClick: () => showView('editor') }),
    ]), box.firstChild);
    return editorBox;
  }

  function wire() {
    $('scripts-template').addEventListener('click', toggleTemplates);
    $('tpl-filters').addEventListener('submit', (e) => { e.preventDefault(); loadTemplates(); });
    ['tpl-type', 'tpl-board', 'tpl-language'].forEach((id) => $(id).addEventListener('change', loadTemplates));
    $('tpl-class').addEventListener('change', loadTemplates);
    $('new-script').addEventListener('click', () => {
      if (!E.startNew(null)) return;
      pendingNew = true;
      ctx.navigate('scripts', { new: 'blank' });
    });
    $('scripts-library-open').addEventListener('click', () => ctx.navigate('scripts', { library: 1 }));
    $('lib-back').addEventListener('click', () => ctx.navigate('scripts'));
    $('lib-new').addEventListener('click', () => fillLibraryForm(null));
    $('lib-form').addEventListener('submit', publishTemplate);
    ['lib-steps', 'lib-pushbacks', 'lib-type'].forEach((id) => $(id).addEventListener('change', checkLibraryForm));
    $('ans-form').addEventListener('submit', saveAnswer);
    $('ans-new').addEventListener('click', () => fillAnswerForm(null));
    $('ai-form').addEventListener('submit', makeDraft);
    $('ai-open').addEventListener('click', draftToLibrary);
    $('ai-simpler').addEventListener('click', () => makeSimpler(null));
    $('ai-again').addEventListener('click', () => makeDraft(null));
  }

  S.registerTab({
    id: 'scripts',
    label: 'Scripts',
    mount(box, c) {
      ctx = c;
      window.addEventListener('beforeunload', onLeave);
      const editorBox = build(box);
      E.mount(editorBox, c, {
        onBack: () => ctx.navigate('scripts'),
        onSaved: (id) => {
          pendingNew = false;
          // The address now names the saved script, so a reload or a shared link opens it.
          history.replaceState(null, '', location.pathname + location.search + S.buildHash('scripts', { edit: id }));
          reloadList();
        },
      });
      wire();
      ready = load();
    },
    show,
    unmount() {
      window.removeEventListener('beforeunload', onLeave);
      E.unmount();
      ctx = null; rows = []; types = []; features = null; usage = null; draft = null; pendingNew = false; busy = false; ready = null;
      platformAdmin = false; templates = []; libraryMissing = false; tplSeq++; libRows = []; answers = [];
    },
  });
})();
