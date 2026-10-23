'use strict';
/* Scripts tab of the admin app (web/admin.html), as in the mockup: the list of scripts (type, live version,
   campaigns that use it, calls and good results in the last 90 days, last change, Edit · Report), three ways to
   start a script (from a template, by hand, with AI), the "Make a script with AI" form and its draft view, and
   the script editor (web/js/script-editor.js), which was its own page before.
   Routes: #scripts (list), #scripts?edit=<script id> (editor), #scripts?new=blank|template|draft (editor with a
   new script), #scripts?ai=1 (AI script maker).
   Scripts are a paid add-on (my_features: 'scripts', and 'ai_drafts' for the AI script maker; a trial has both).
   Without it the list is read-only with "Add Scripts to use this"; the server refuses saving anyway.
   Reads: admin_list_scripts, admin_list_call_types, my_features, admin_ai_usage (supabase/migrations/
   20261024100022_script_types_ai.sql). AI drafts: the ai-script-draft Edge Function with the admin's own token;
   the Anthropic key stays on the server. The editor keeps its working copy while other views and tabs are open;
   leaving the page with unsaved changes asks first.
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

  const pure = { goodRate, usedInText, liveText, usageText, usageLeft, briefProblem, scoreBadge };
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

  let ctx = null;
  let rows = [];            // admin_list_scripts
  let types = [];           // admin_list_call_types
  let features = null;      // my_features(); null when unknown (the server still checks)
  let usage = null;         // admin_ai_usage row
  let draft = null;         // { script, checks, brief } of the last AI draft
  let pendingNew = false;   // the editor holds a new script started from this tab (template or draft)
  let busy = false;
  let ready = null;         // the first load, so show() can wait for it

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
    const [list, t, f, u] = await Promise.all([
      ctx.rpc('admin_list_scripts').catch((err) => { say('scripts-msg', 'Could not load scripts: ' + err.message, true); return []; }),
      ctx.rpc('admin_list_call_types').catch(() => []),
      ctx.rpc('my_features').catch(() => null),
      ctx.rpc('admin_ai_usage').catch(() => null),
    ]);
    rows = Array.isArray(list) ? list : [];
    types = Array.isArray(t) ? t : [];
    features = Array.isArray(f) ? f : null;
    usage = Array.isArray(u) ? u[0] || null : u;
    E.setCallTypes(types);
    renderList();
    renderAddOn();
    fillAiForm();
    renderUsage();
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
    $('scripts-ai-view').hidden = name !== 'ai';
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
    } else if (p.ai) {
      showView('ai');
      return;
    }
    showView('list');
  }

  // ---------- list ----------

  function renderAddOn() {
    const on = hasFeature('scripts');
    $('scripts-addon').hidden = on;
    ['scripts-template', 'new-script', 'scripts-ai'].forEach((id) => { $(id).disabled = !on; });
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

  function toggleTemplates() {
    const panel = $('scripts-templates');
    panel.hidden = !panel.hidden;
    $('scripts-template').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) { const b = panel.querySelector('button'); if (b) b.focus(); }
  }

  function useTemplate(key) {
    const t = TPL.template(key);
    if (!t) return;
    if (!E.startNew(t, 'Started from the "' + t.name + '" template. Add your own facts where it says "Check this", then save.')) return;
    pendingNew = true;
    $('scripts-templates').hidden = true;
    $('scripts-template').setAttribute('aria-expanded', 'false');
    ctx.navigate('scripts', { new: 'template' });
  }

  function buildTemplates() {
    return el('section', { className: 'panel', id: 'scripts-templates', hidden: true, 'aria-labelledby': 'scripts-templates-title' }, [
      el('h2', { id: 'scripts-templates-title', text: 'Start from a template' }),
      el('p', { className: 'muted small', text: 'A ready script in simple English. You add your own facts (fees, dates, course details) before callers use it.' }),
      el('div', { className: 'tpl-grid' }, TPL.TEMPLATES.map((t) => el('div', { className: 'tpl' }, [
        el('h3', { text: t.name }),
        el('p', { text: t.about }),
        el('p', { className: 'muted small', text: t.steps.length + ' steps · ' + t.pushbacks.length + ' pushback answers' }),
        el('button', { type: 'button', className: 'primary', text: 'Use this template', 'data-template': t.key,
          'aria-label': 'Use the ' + t.name + ' template', onClick: () => useTemplate(t.key) }),
      ]))),
    ]);
  }

  // ---------- AI script maker ----------

  function fillAiForm() {
    const sel = $('ai-type');
    const keep = sel.value;
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: 'Choose a type' }));
    types.filter((t) => t.active !== false).forEach((t) => sel.appendChild(el('option', { value: t.key, text: t.label })));
    sel.value = keep || (typeByKey('fees') ? 'fees' : '');
    const ai = hasFeature('ai_drafts') && hasFeature('scripts');
    $('ai-addon').hidden = ai;
    $('ai-form').querySelectorAll('input, select, textarea, button').forEach((n) => { n.disabled = !ai; });
  }

  function renderUsage() {
    $('ai-usage').textContent = usageText(usage);
    const left = usageLeft(usage);
    $('ai-make').disabled = busy || left === 0 || !(hasFeature('ai_drafts') && hasFeature('scripts'));
    if (left === 0) say('ai-msg', 'You have used all AI drafts for this month. You can still start from a template or write by hand.');
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

  // Calls the ai-script-draft Edge Function with the admin's own access token.
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
    $('scripts-ai-view').setAttribute('aria-busy', on ? 'true' : 'false');
    if (text !== undefined) say('ai-msg', text);
    if (!on) renderUsage();
  }

  async function makeDraft(e) {
    if (e) e.preventDefault();
    if (busy) return;
    const brief = briefFromForm();
    const problem = briefProblem(brief);
    if (problem) { say('ai-msg', problem, true); return; }
    setBusy(true, 'Writing your draft. This can take up to a minute.');
    try {
      const out = await aiCall({ action: 'draft', brief });
      draft = { script: out.script, checks: out.checks, brief };
      if (out.usage) usage = out.usage;
      renderDraft();
      setBusy(false, 'Draft ready. Read every line before you use it.');
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

  function openDraft() {
    if (!draft) return;
    if (!E.startNew(draft.script, 'Made with AI. Check every line and each "Check this" mark, then save.')) return;
    pendingNew = true;
    ctx.navigate('scripts', { new: 'draft' });
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
      checkBox.appendChild(el('h4', { text: 'Check ' + marks.length + ' thing' + (marks.length === 1 ? '' : 's') + ' before you publish' }));
      checkBox.appendChild(el('ul', null, marks.map((m) => el('li', null, [
        el('strong', { text: (m.where === 'step' ? m.name : '"' + m.name + '"') + ': ' }), document.createTextNode(m.text),
      ]))));
    }
    if (c.problems && c.problems.length) {
      checkBox.appendChild(el('h4', { text: 'Fix in the editor' }));
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

  function build(box) {
    const btn = (id, text, cls, extra) => el('button', Object.assign({ id, type: 'button', text, className: cls || '' }, extra || {}));
    const field = (label, input) => el('label', { className: 'fld' }, [el('span', { text: label }), input]);
    const select = (id, opts) => el('select', { id }, opts.map(([v, t]) => el('option', { value: v, text: t })));

    // List view
    box.appendChild(el('div', { id: 'scripts-list-view', className: 'view' }, [
      el('div', { className: 'tab-head scripts-head' }, [
        el('div', null, [
          el('h1', { text: 'Scripts' }),
          el('p', { className: 'muted', text: 'Each script has a type. The type decides the result buttons callers see. Callers see a script only after you publish it.' }),
        ]),
        el('div', { className: 'start-row' }, [
          btn('scripts-template', 'Start from a template', '', { 'aria-expanded': 'false', 'aria-controls': 'scripts-templates' }),
          btn('new-script', 'Write by hand'),
          btn('scripts-ai', 'Make with AI', 'primary'),
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
        el('p', { id: 'scripts-empty', className: 'muted', hidden: true, text: 'No scripts yet. Start from a template, write one by hand or make one with AI.' }),
        el('p', { className: 'muted small', text: 'Calls and good results are for the last 90 days.' }),
      ]),
    ]));

    // AI view
    box.appendChild(el('div', { id: 'scripts-ai-view', className: 'view', hidden: true }, [
      el('div', null, [btn('ai-back', '← All scripts')]),
      el('section', { className: 'panel ai-grid' }, [
        el('form', { id: 'ai-form', className: 'ai-form', novalidate: 'novalidate' }, [
          el('h2', { text: 'Make a script with AI' }),
          el('p', { className: 'muted small', text: 'Tell us about the call. We write a draft in simple words. You check it, change it and publish it.' }),
          el('p', { id: 'ai-addon', className: 'addon-note', hidden: true, text: 'The AI script maker is not in your plan. Add AI drafts to use this.' }),
          el('div', { className: 'ai-row' }, [
            field('Call type', el('select', { id: 'ai-type' })),
            field('Who you call', select('ai-audience', AUDIENCES.map((a) => [a, a]))),
            field('Language', select('ai-language', LANGUAGES)),
          ]),
          field('What is the call for?', el('textarea', { id: 'ai-purpose', rows: '3', maxlength: '600',
            placeholder: 'For example: remind parents of Class 10 that the second term fee is due, and get a date when they will pay.' })),
          field('Facts the caller can use', el('textarea', { id: 'ai-facts', rows: '3', maxlength: '1500',
            placeholder: 'For example: Fee ₹18,000. Due 31 Oct. Pay by UPI, card or at the office.' })),
          el('p', { className: 'muted small', text: 'The AI uses only these facts. Any other number or date in the draft gets a "Check this" mark.' }),
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
            btn('ai-open', 'Open in editor', 'primary'),
            btn('ai-simpler', 'Make simpler'),
            btn('ai-again', 'Try again'),
          ]),
          el('p', { className: 'muted small', text: '"Try again" makes a new draft and counts as one of this month\'s drafts.' }),
        ]),
      ]),
    ]));

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
    $('new-script').addEventListener('click', () => {
      if (!E.startNew(null)) return;
      pendingNew = true;
      ctx.navigate('scripts', { new: 'blank' });
    });
    $('scripts-ai').addEventListener('click', () => ctx.navigate('scripts', { ai: 1 }));
    $('ai-back').addEventListener('click', () => ctx.navigate('scripts'));
    $('ai-form').addEventListener('submit', makeDraft);
    $('ai-open').addEventListener('click', openDraft);
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
    },
  });
})();
