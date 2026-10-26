'use strict';
/* Settings tab of the admin app (web/admin.html), owners only. Simple by default: "Show advanced options" (the
   switch at the top, also in the account menu), the institute's name and time zone, common answers and WhatsApp.
   With advanced options on (class "adv"): call result options (kinds of call and their result options: add a
   kind, add or remove an institute's own results), "Hide money everywhere", the plan (trial days left, seats,
   add-ons from my_features; AI drafts used for platform admins only), the terms they accepted, and the activity
   log. The password moved to the account menu (js/admin/shell.js).
   Reads: admin_list_call_types, admin_institute_settings (20261024100023; my_trial_status and my_features on an
   older database), admin_ai_usage (scripts feature; optional), my_terms_status, admin_audit_log. Writes:
   admin_upsert_call_type, admin_upsert_call_type_result, admin_set_institute, admin_set_hide_money. The database
   checks every call; the page only hides what a manager cannot do. Each section loads on its own, so one
   missing function leaves the others working.
   The WhatsApp section is filled by js/admin/settings-whatsapp.js (window.VectorSettingsWhatsApp: mount(section,
   ctx), unmount()); an ES module exporting mount (or a default function) also works. Missing: nothing is shown.
   Phase A.2: a "Common answers" card. Every script answers common questions on calls (my_common_answers,
   migration 20261025140000_template_library.sql); a few need the institute's own facts (address, office
   landline, website, fee range, discount policy). Owners and managers fill them in with
   admin_fill_common_answer; until then callers do not see that answer.
   The pure helpers below are also loaded by tests/web/admin-settings.test.js (Node, no DOM). */
(function () {
  const S = (typeof window !== 'undefined' && window.VectorAdminShared) || require('./shared.js');

  // ---------- pure helpers ----------

  const LOG_PAGE = 25;
  const AI_LIMIT = 20;   // drafts a month per institute (docs/phase-a-plan.md, decision 2), when the server does not say
  const TIME_ZONES = [
    ['Asia/Kolkata', 'India (IST)'], ['Asia/Kathmandu', 'Nepal'], ['Asia/Dhaka', 'Bangladesh'],
    ['Asia/Dubai', 'UAE and Oman'], ['Asia/Riyadh', 'Saudi Arabia'], ['Asia/Singapore', 'Singapore'],
    ['Europe/London', 'UK'], ['America/New_York', 'US East'], ['UTC', 'UTC'],
  ];
  const FEATURES = [
    { key: 'scripts', name: 'Scripts', on: 'Guided scripts, the script editor, script reports and where calls end.',
      off: 'Add Scripts to use guided scripts, the script editor, script reports and where calls end.' },
    { key: 'ai_drafts', name: 'Script library', on: 'Ready scripts for fees, admissions and sales calls, updated by our team, plus new scripts on request.',
      off: 'Add Scripts to use the ready script library.' },
  ];

  // The time zone choices, with the institute's own zone added when it is not in the short list.
  function zoneChoices(current) {
    const list = TIME_ZONES.slice();
    if (current && !list.some((z) => z[0] === current)) list.push([current, current]);
    return list;
  }

  // 'Trial: 3 days left · 5 of 10 seats used', 'Paid plan · 5 of 10 seats used' …
  function planText(st) {
    const s = st || {};
    const seats = s.seat_limit !== undefined && s.seat_limit !== null
      ? ' · ' + S.count(s.seats_used || 0) + ' of ' + S.count(s.seat_limit) + ' team members' : '';
    if (s.status === 'trial') {
      const d = s.trial_days_left;
      if (d === null || d === undefined) return 'Trial' + seats;
      if (Number(d) <= 0) return 'Trial ended' + seats;
      return 'Trial: ' + d + ' day' + (Number(d) === 1 ? '' : 's') + ' left' + seats;
    }
    if (s.status === 'active') return 'Paid plan' + seats;
    if (s.status === 'grace') return 'Payment due' + seats;
    if (s.status === 'suspended') return 'Paused: payment needed' + seats;
    if (s.status === 'cancelled') return 'Cancelled' + seats;
    return seats.replace(/^ · /, '');
  }

  // The add-ons and whether the institute has them: [{ key, name, on, note }].
  function featureRows(features) {
    const have = new Set(Array.isArray(features) ? features : []);
    return FEATURES.map((f) => ({ key: f.key, name: f.name, on: have.has(f.key), note: have.has(f.key) ? f.on : f.off }));
  }

  // admin_ai_usage() as '3 of 20 AI drafts used this month'. Takes a row, a one-row list or a number.
  function aiUsageText(data) {
    let u = Array.isArray(data) ? data[0] : data;
    if (typeof u === 'number') u = { used: u };
    if (!u || typeof u !== 'object') return '';
    const used = Number(u.used ?? u.drafts_used ?? u.count ?? 0) || 0;
    const limit = Number(u.limit ?? u.monthly_limit ?? u.drafts_limit ?? AI_LIMIT) || AI_LIMIT;
    return S.count(used) + ' of ' + S.count(limit) + ' AI drafts used this month';
  }

  // What a result button asks the caller for: 'date, amount' or ''.
  function resultNeeds(r) {
    const n = [];
    if (r.needs_date) n.push('date');
    if (r.needs_amount) n.push('amount');
    if (r.needs_reason) n.push('reason');
    if (r.needs_rating) n.push('rating');
    return n.join(', ');
  }

  // A label for a call type or result: trimmed, 1 to 60 characters. { ok, text, error }.
  function checkLabel(raw, what) {
    const t = String(raw === null || raw === undefined ? '' : raw).trim().replace(/\s+/g, ' ');
    if (!t) return { ok: false, error: 'Type a name for the ' + what + '.' };
    if (Array.from(t).length > 60) return { ok: false, error: 'Keep the name to 60 characters.' };
    return { ok: true, text: t };
  }

  const ROLE_WORDS = { owner: 'owner', manager: 'manager', caller: 'caller' };
  const ACTIONS = {
    'institute.created': 'Created the institute',
    'institute.trial_started': 'Started the free trial',
    'institute.changed': 'Changed the institute settings',
    'seat.invited': 'Added a person to the team',
    'seat.claimed': 'Joined the team',
    'seat.reassigned': 'Gave a place to someone else',
    'seat.revoked': 'Removed a person from the team',
    'seat.role_set': 'Changed a role',
    'pairing.reset': 'Signed out a phone or laptop',
    'device.registered': 'Paired a phone or laptop',
    'rep_target.set': 'Set a daily target',
    'supervisor_note.added': 'Added a note for a caller',
    'money.access_given': 'Allowed a manager to see money',
    'money.access_removed': 'Stopped a manager seeing money',
    'money.hidden': 'Turned on "Hide money everywhere"',
    'money.shown': 'Turned off "Hide money everywhere"',
    'money.exported': 'Downloaded a file with money',
    'call_type.added': 'Added a kind of call',
    'call_type.changed': 'Changed a kind of call',
    'call_type_result.added': 'Added a result option',
    'call_type_result.changed': 'Changed a result option',
    'script.draft_saved': 'Saved a call script (not ready)',
    'script.published': 'Made a call script ready for callers',
    'campaign.created': 'Made a calling list',
    'campaign.changed': 'Changed a calling list',
    'campaign.running': 'Started a calling list',
    'campaign.paused': 'Paused a calling list',
    'campaign.closed': 'Closed a calling list',
    'campaign.members_set': 'Changed the callers of a calling list',
    'leads.added': 'Added people to call',
    'leads.moved': 'Moved calls to another caller',
    'leads.shared': 'Shared calls among callers',
  };

  // One activity log row in plain English, such as 'Changed a role: Ravi to manager'.
  function actionText(row) {
    const r = row || {};
    const action = String(r.action || '');
    let text = ACTIONS[action];
    if (!text) {
      const words = action.replace(/[._]+/g, ' ').trim();
      text = words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Something changed';
    }
    const rest = String(r.target_rest || '').replace(/^:/, '');
    if (action === 'seat.role_set' && r.target_label) return text + ': ' + r.target_label + ' to ' + (ROLE_WORDS[rest] || rest);
    if (action === 'money.exported') {
      const m = /^([a-z0-9_]+):(\d+)$/.exec(String(r.target || ''));
      return m ? text + ' (' + m[1].replace(/_/g, ' ') + ', ' + S.count(m[2]) + ' rows)' : text;
    }
    if (action === 'institute.changed' && r.target && !r.target_label) {
      const parts = String(r.target).split(',').map((p) => ({ name: 'name', time_zone: 'time zone' }[p] || p));
      return 'Changed the institute ' + parts.join(' and ');
    }
    return r.target_label ? text + ': ' + r.target_label : text;
  }

  // Phase A.2: the common answers that need the institute's facts (my_common_answers rows with a "check" list).
  const answersToFill = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => Array.isArray(r.check) && r.check.length > 0);
  // '2 of 5 filled in'.
  function fillSummary(rows) {
    const list = answersToFill(rows);
    return list.filter((r) => r.filled).length + ' of ' + list.length + ' filled in';
  }

  const pure = { LOG_PAGE, AI_LIMIT, TIME_ZONES, FEATURES, zoneChoices, planText, featureRows, aiUsageText, resultNeeds,
    checkLabel, actionText, answersToFill, fillSummary };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ---------- the tab (browser only) ----------

  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);

  let ctx = null;
  let types = [];
  let inst = null;        // admin_institute_settings
  let logOffset = 0;
  let logSeq = 0;
  let waModule = null;    // settings-whatsapp.js, once loaded
  let standard = new Map();   // common answer key -> the standard wording (Phase A.2)

  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const isOwner = () => !!(inst ? inst.is_owner
    : ctx.seat.access_role ? ctx.seat.access_role === 'owner' : ctx.seat.role === 'admin');

  async function rpc(name, args) {
    try { return await ctx.rpc(name, args); } catch (err) {
      if (ctx.isMissing(err)) { const e = new Error('not available yet'); e.missing = true; throw e; }
      throw err;
    }
  }
  function report(id, err, prefix) {
    if (err && err.missing) say(id, 'This is not available yet.');
    else say(id, (prefix || '') + (err && err.message ? err.message : 'Try again.'), true);
  }

  // The switch follows "Show advanced options" when it changes elsewhere (the account menu).
  function syncAdvanced(e) {
    const sw = document.getElementById('settings-advanced-switch');
    if (sw) sw.checked = !!(e && e.detail && e.detail.on);
  }

  // ---------- page ----------

  function check(id, text) {
    return el('label', { className: 'check' }, [el('input', { type: 'checkbox', id }), el('span', { text })]);
  }

  function build(box) {
    box.appendChild(el('div', { className: 'tab-head' }, [el('h1', { text: 'Settings' })]));

    // Simple by default: "Show advanced options" shows the rarely used sections (call result options, money,
    // plan, terms, activity log) and the extra fields on other tabs. Per login, in this browser only.
    box.appendChild(el('div', { className: 'panel', id: 'settings-advanced' }, [
      el('label', { className: 'switch' }, [
        el('input', { type: 'checkbox', id: 'settings-advanced-switch', role: 'switch', checked: S.isAdvanced() }),
        el('span', { text: 'Show advanced options' }),
      ]),
      el('p', { className: 'muted small', text: 'Off: only what you need every day. On: also call result options, money, plan, terms, the activity log, and extra fields in Calling and Team. Remembered on this browser.' }),
    ]));

    box.appendChild(el('div', { className: 'panel adv', id: 'settings-call-types' }, [
      el('h2', { text: 'Call result options' }),
      el('p', { id: 'ct-common', className: 'muted' }),
      msg('ct-msg'),
      el('ul', { id: 'ct-list', className: 'plain ct-list' }),
      el('h3', { text: 'Add a result option' }),
      el('form', { id: 'ctr-form', className: 'row wrap' }, [
        el('label', null, ['Kind of call', el('select', { id: 'ctr-type' })]),
        el('label', null, ['Option name', el('input', { id: 'ctr-label', type: 'text', maxlength: '60', placeholder: 'Asked for brochure', required: true })]),
        el('fieldset', { className: 'ct-flags' }, [
          el('legend', { text: 'The caller must give' }),
          check('ctr-date', 'A date'), check('ctr-amount', 'An amount (₹)'), check('ctr-reason', 'A reason'),
        ]),
        check('ctr-good', 'Counts as a good result'),
        el('button', { type: 'submit', text: 'Add option' }),
      ]),
      msg('ctr-msg'),
      el('h3', { text: 'Add a kind of call' }),
      el('p', { className: 'muted small', text: 'Every new kind gets the five common options. Add its own options above after you add it.' }),
      el('form', { id: 'ct-form', className: 'row wrap' }, [
        el('label', null, ['Name', el('input', { id: 'ct-label', type: 'text', maxlength: '60', placeholder: 'Parent meeting', required: true })]),
        el('button', { type: 'submit', text: 'Add kind of call' }),
      ]),
      msg('ct-add-msg'),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'settings-institute' }, [
      el('h2', { text: 'Institute' }),
      el('form', { id: 'inst-form', className: 'row wrap' }, [
        el('label', null, ['Name', el('input', { id: 'inst-name', type: 'text', maxlength: '120', autocomplete: 'organization' })]),
        el('label', null, ['Time zone', el('select', { id: 'inst-tz' })]),
        el('button', { type: 'submit', id: 'inst-save', text: 'Save' }),
      ]),
      el('p', { id: 'inst-note', className: 'muted small', hidden: true, text: 'Only an owner can change these.' }),
      msg('inst-msg'),
    ]));

    // Autopilot (js/admin/autopilot.js): goals, the three switches and "Pause all automation".
    box.appendChild(el('section', { className: 'panel', id: 'settings-autopilot', 'aria-label': 'Autopilot' }));

    box.appendChild(el('div', { className: 'panel', id: 'settings-answers' }, [
      el('div', { className: 'row between' }, [
        el('h2', { text: 'Common answers' }),
        el('span', { id: 'answers-count', className: 'muted small' }),
      ]),
      el('p', { className: 'muted small', text: 'Every script answers common questions on calls, such as "Where did you get my number?". These need your institute\'s facts. Callers see an answer only after you fill it in.' }),
      msg('answers-msg'),
      el('ul', { id: 'answers-list', className: 'plain answers-list' }),
    ]));

    box.appendChild(el('div', { className: 'panel adv', id: 'settings-money' }, [
      el('h2', { text: 'Money' }),
      el('label', { className: 'switch', id: 'hide-money-field' }, [
        el('input', { type: 'checkbox', id: 'hide-money', role: 'switch' }),
        el('span', { text: 'Hide money everywhere' }),
      ]),
      el('p', { className: 'muted small', text: 'When on, nobody sees ₹ amounts: screens, reports and downloads show counts only. Callers still see the amount due of the one lead on their call.' }),
      el('p', { id: 'hide-money-state', className: 'muted', hidden: true }),
      msg('money-msg'),
    ]));

    box.appendChild(el('div', { className: 'panel adv', id: 'settings-plan' }, [
      el('h2', { text: 'Plan' }),
      el('p', { id: 'plan-text', className: 'plan-text' }),
      el('ul', { id: 'plan-features', className: 'plain' }),
      el('p', { id: 'plan-ai', className: 'muted' }),
      msg('plan-msg'),
    ]));

    // Filled by js/admin/settings-whatsapp.js (the WhatsApp feature), when it exists.
    box.appendChild(el('section', { id: 'settings-whatsapp', 'aria-label': 'WhatsApp' }));

    box.appendChild(el('div', { className: 'panel adv', id: 'settings-terms' }, [
      el('h2', { text: 'Terms you accepted' }),
      el('ul', { id: 'terms-list', className: 'plain' }),
      msg('terms-msg'),
    ]));

    box.appendChild(el('div', { className: 'panel adv', id: 'settings-log' }, [
      el('h2', { text: 'Activity log' }),
      el('p', { className: 'muted small', text: 'What owners and managers changed, newest first.' }),
      el('div', { className: 'scroll' }, [el('table', { className: 'stack' }, [
        el('thead', null, [el('tr', null, ['When', 'Who', 'What'].map((h) => el('th', { text: h })))]),
        el('tbody', { id: 'log-body' }),
      ])]),
      el('p', { id: 'log-empty', className: 'muted', hidden: true, text: 'Nothing yet.' }),
      el('div', { className: 'row log-pager' }, [
        el('button', { type: 'button', id: 'log-newer', text: 'Newer', disabled: true }),
        el('span', { id: 'log-page', className: 'muted small' }),
        el('button', { type: 'button', id: 'log-older', text: 'Older', disabled: true }),
      ]),
      msg('log-msg'),
    ]));
  }

  function wire() {
    $('ct-form').addEventListener('submit', (e) => { e.preventDefault(); addType(); });
    $('ctr-form').addEventListener('submit', (e) => { e.preventDefault(); addResult(); });
    $('inst-form').addEventListener('submit', (e) => { e.preventDefault(); saveInstitute(); });
    $('hide-money').addEventListener('change', askHideMoney);
    $('settings-advanced-switch').addEventListener('change', () => S.setAdvanced($('settings-advanced-switch').checked));
    document.addEventListener('vector:advanced', syncAdvanced);
    $('log-newer').addEventListener('click', () => loadLog(Math.max(0, logOffset - LOG_PAGE)));
    $('log-older').addEventListener('click', () => loadLog(logOffset + LOG_PAGE));
  }

  // ---------- call types ----------

  async function loadTypes(selectId) {
    try {
      types = (await rpc('admin_list_call_types')) || [];
      renderTypes(selectId);
      say('ct-msg', '');
    } catch (err) {
      types = [];
      renderTypes();
      report('ct-msg', err, 'Could not load call types: ');
    }
  }

  function renderTypes(selectId) {
    const list = $('ct-list');
    list.textContent = '';
    const common = [];
    types.forEach((t) => (t.results || []).forEach((r) => { if (r.common && !common.includes(r.label)) common.push(r.label); }));
    $('ct-common').textContent = common.length ? 'Every kind of call has these: ' + common.join(' · ') + '.' : '';
    types.forEach((t) => {
      const own = (t.results || []).filter((r) => !r.common);
      const chips = el('ul', { className: 'ct-results' });
      own.forEach((r) => {
        const needs = resultNeeds(r);
        const li = el('li', { className: 'ct-chip' + (r.counts_as_good ? ' good' : '') }, [
          el('span', { text: r.label + (needs ? ' (' + needs + ')' : '') }),
        ]);
        if (!r.built_in) {
          li.appendChild(el('button', { type: 'button', className: 'ct-remove', text: '×', 'aria-label': 'Remove button ' + r.label + ' from ' + t.label,
            onClick: () => askRemoveResult(t, r) }));
        }
        chips.appendChild(li);
      });
      if (!own.length) chips.appendChild(el('li', { className: 'muted small', text: 'Only the common options so far.' }));
      const headBits = [el('h3', { text: t.label })];
      if (t.built_in) headBits.push(el('span', { className: 'ct-tag', text: 'Built in' }));
      if (!t.active) headBits.push(el('span', { className: 'ct-tag off', text: 'Off' }));
      if (!t.built_in) {
        headBits.push(el('button', { type: 'button', className: 'ct-toggle', text: t.active ? 'Turn off' : 'Turn on',
          onClick: () => askToggleType(t) }));
      }
      list.appendChild(el('li', { className: 'ct-type', 'data-key': t.key }, [el('div', { className: 'ct-head' }, headBits), chips]));
    });
    const sel = $('ctr-type');
    const keep = selectId || sel.value;
    sel.textContent = '';
    types.filter((t) => t.active).forEach((t) => sel.appendChild(el('option', { value: t.id, text: t.label })));
    if (keep && types.some((t) => t.id === keep)) sel.value = keep;
  }

  async function addType() {
    const c = checkLabel($('ct-label').value, 'call type');
    if (!c.ok) { say('ct-add-msg', c.error, true); return; }
    try {
      const id = await rpc('admin_upsert_call_type', { p_id: null, p_label: c.text });
      $('ct-label').value = '';
      say('ct-add-msg', '"' + c.text + '" added. Add its result options above.');
      await loadTypes(typeof id === 'string' ? id : null);
    } catch (err) { report('ct-add-msg', err, 'Could not add the call type: '); }
  }

  async function addResult() {
    const typeId = $('ctr-type').value;
    if (!typeId) { say('ctr-msg', 'Pick a call type.', true); return; }
    const c = checkLabel($('ctr-label').value, 'button');
    if (!c.ok) { say('ctr-msg', c.error, true); return; }
    const t = types.find((x) => x.id === typeId);
    try {
      await rpc('admin_upsert_call_type_result', {
        p_id: null, p_call_type: typeId, p_label: c.text,
        p_needs_date: $('ctr-date').checked, p_needs_amount: $('ctr-amount').checked,
        p_needs_reason: $('ctr-reason').checked, p_counts_as_good: $('ctr-good').checked,
      });
      $('ctr-form').reset();
      $('ctr-type').value = typeId;
      say('ctr-msg', 'Option "' + c.text + '" added to ' + (t ? t.label : 'that kind of call') + '. Callers see it on their next call.');
      await loadTypes(typeId);
    } catch (err) { report('ctr-msg', err, 'Could not add the button: '); }
  }

  function askToggleType(t) {
    ctx.confirm({
      title: (t.active ? 'Turn off "' : 'Turn on "') + t.label + '"',
      text: t.active ? 'New calling lists cannot use it. Calling lists that use it now keep working.'
        : 'New calling lists can use it again.',
      button: t.active ? 'Turn off' : 'Turn on',
      run: () => rpc('admin_upsert_call_type', { p_id: t.id, p_label: t.label, p_active: !t.active }),
      done: '"' + t.label + '" is ' + (t.active ? 'off.' : 'on.'),
      reload: () => loadTypes(),
    });
  }

  function askRemoveResult(t, r) {
    ctx.confirm({
      title: 'Remove "' + r.label + '" from ' + t.label,
      text: 'Callers no longer see this option. Calls already saved with it keep it in the reports.',
      button: 'Remove',
      danger: true,
      run: () => rpc('admin_upsert_call_type_result', {
        // Null flags keep their value on a change (the defaults would set them to false).
        p_id: r.id, p_call_type: null, p_label: r.label, p_needs_date: null, p_needs_amount: null, p_needs_reason: null,
        p_needs_rating: null, p_counts_as_good: null, p_reason_choices: r.reason_choices || null, p_active: false,
      }),
      done: '"' + r.label + '" removed from ' + t.label + '.',
      reload: () => loadTypes(),
    });
  }

  // ---------- institute, money and plan ----------

  // admin_institute_settings, or the same facts from my_trial_status and my_features on an older database.
  async function loadInstitute() {
    try {
      inst = (await rpc('admin_institute_settings')) || {};
    } catch (err) {
      if (!err.missing) { report('inst-msg', err, 'Could not load the institute: '); }
      inst = null;
      try {
        const t = await ctx.rpc('my_trial_status');
        const row = (Array.isArray(t) ? t[0] : t) || {};
        let features = null;
        try { features = await ctx.rpc('my_features'); } catch (e) { features = null; }
        const left = row.trial_ends_at ? Math.max(0, Math.ceil((new Date(row.trial_ends_at) - Date.now()) / 86400000)) : null;
        inst = { name: row.institute_name, status: row.status, trial_days_left: left, seat_limit: row.seat_limit,
          seats_used: undefined, hide_money: !!row.hide_money, features: features || [], time_zone: null,
          is_owner: row.access_role ? row.access_role === 'owner' : row.role === 'admin', fallback: true };
      } catch (e) { inst = null; }
    }
    renderInstitute();
    renderMoney();
    renderPlan();
  }

  function renderInstitute() {
    const owner = isOwner();
    $('inst-name').value = (inst && inst.name) || (ctx.institute && ctx.institute.name) || '';
    const sel = $('inst-tz');
    sel.textContent = '';
    const zone = (inst && inst.time_zone) || '';
    zoneChoices(zone || 'Asia/Kolkata').forEach((z) => sel.appendChild(el('option', { value: z[0], text: z[1] })));
    sel.value = zone || 'Asia/Kolkata';
    const canSave = owner && inst && !inst.fallback;
    $('inst-name').disabled = !canSave;
    sel.disabled = !canSave;
    $('inst-save').hidden = !canSave;
    $('inst-note').hidden = owner;
  }

  async function saveInstitute() {
    const name = $('inst-name').value.trim();
    if (name.length < 2 || name.length > 120) { say('inst-msg', 'The name needs 2 to 120 characters.', true); return; }
    const btn = $('inst-save');
    btn.disabled = true;
    try {
      await rpc('admin_set_institute', { p_name: name, p_time_zone: $('inst-tz').value });
      say('inst-msg', 'Saved. Home counts days in this time zone.');
      const top = document.getElementById('institute');
      if (top) { top.textContent = name; top.hidden = false; }
      await loadInstitute();
    } catch (err) {
      report('inst-msg', err, 'Could not save: ');
    } finally {
      btn.disabled = false;
    }
  }

  function renderMoney() {
    const hidden = !!(inst && inst.hide_money);
    const owner = isOwner();
    $('hide-money').checked = hidden;
    $('hide-money-field').hidden = !owner || !inst;
    $('hide-money-state').hidden = owner && !!inst;
    $('hide-money-state').textContent = !inst ? '' : hidden
      ? 'Money is hidden everywhere. Only an owner can change this.'
      : 'Money is shown to owners and to managers allowed to see it. Only an owner can change this.';
  }

  function askHideMoney() {
    const hide = $('hide-money').checked;
    $('hide-money').checked = !hide;   // stays as it was until confirmed
    ctx.confirm({
      title: hide ? 'Hide money everywhere' : 'Show money again',
      text: hide ? 'Nobody will see ₹ amounts, owners included. Reports and downloads show counts only.'
        : 'Owners, and managers you allowed, will see ₹ amounts again.',
      button: hide ? 'Hide money' : 'Show money',
      run: () => rpc('admin_set_hide_money', { p_hide: hide }),
      done: (hide ? 'Money is hidden.' : 'Money is shown again.') + ' Reload the page to update every tab.',
      reload: loadInstitute,
    });
  }

  // ---------- common answers (Phase A.2) ----------

  async function loadAnswers() {
    try {
      const [rows, global] = await Promise.all([
        rpc('my_common_answers'),
        // The standard wording, shown next to the institute's own answer.
        ctx.client.from('common_answers').select('key, answer').then((r) => (r && !r.error ? r.data || [] : [])).catch(() => []),
      ]);
      if (!ctx) return;
      standard = new Map(global.map((g) => [g.key, g.answer]));
      renderAnswers(rows || []);
      say('answers-msg', '');
    } catch (err) {
      if (!ctx) return;
      renderAnswers([]);
      report('answers-msg', err, 'Could not load common answers: ');
    }
  }

  function renderAnswers(rows) {
    const list = $('answers-list');
    list.textContent = '';
    const todo = answersToFill(rows);
    $('answers-count').textContent = todo.length ? fillSummary(rows) : '';
    todo.forEach((r) => {
      const id = 'answer-fill-' + r.key;
      const box = el('textarea', { id, rows: '3', maxlength: '600', 'aria-describedby': id + '-hint',
        placeholder: 'The whole answer, with your facts' });
      box.value = r.filled ? r.answer : '';
      const std = standard.get(r.key) || (r.filled ? '' : r.answer);
      const state = el('span', { className: 'pill ' + (r.filled ? 'pill-ok' : 'pill-warn'), text: r.filled ? 'Filled in' : 'Not filled in yet' });
      const save = el('button', { type: 'button', text: 'Save', 'aria-label': 'Save the answer to: ' + r.label });
      const rowMsg = el('p', { className: 'msg', role: 'status', id: id + '-msg' });
      save.addEventListener('click', () => saveAnswer(r, box, save, rowMsg));
      list.appendChild(el('li', { className: 'answer', 'data-key': r.key }, [
        el('div', { className: 'row between' }, [el('strong', { text: r.label }), state]),
        std ? el('p', { className: 'muted small', text: 'Standard answer: ' + std }) : null,
        el('label', { for: id, text: 'Your answer (callers say this)' }),
        box,
        el('p', { className: 'muted small', id: id + '-hint', text: (r.check || []).join(' ') + ' Leave it empty to stop callers using this answer.' }),
        el('div', { className: 'row' }, [save]),
        rowMsg,
      ]));
    });
    if (!todo.length) list.appendChild(el('li', { className: 'muted', text: 'No answer needs your facts.' }));
  }

  async function saveAnswer(r, box, btn, rowMsg) {
    btn.disabled = true;
    try {
      const saved = await rpc('admin_fill_common_answer', { p_key: r.key, p_answer: box.value });
      ctx.status(saved ? 'Saved the answer to "' + r.label + '". Callers see it now.' : 'Cleared the answer to "' + r.label + '". Callers no longer see it.');
      await loadAnswers();
    } catch (err) {
      report(rowMsg, err, 'Not saved: ');
    } finally {
      btn.disabled = false;
    }
  }

  function renderPlan() {
    $('plan-text').textContent = inst ? planText(inst) : '';
    const list = $('plan-features');
    list.textContent = '';
    if (!inst) { say('plan-msg', 'Could not load your plan.', true); return; }
    say('plan-msg', '');
    featureRows(inst.features).forEach((f) => {
      list.appendChild(el('li', { 'data-feature': f.key }, [
        el('strong', { text: f.name + ': ' }),
        el('span', { className: f.on ? 'plan-on' : 'plan-off', text: f.on ? 'On' : 'Not in your plan' }),
        el('div', { className: 'muted small', text: f.note }),
      ]));
    });
  }

  // AI drafts used this month, from the scripts feature's admin_ai_usage() (optional). Phase A.2: the AI script
  // maker is the Vector team's tool (the Library view), so only platform admins (is_platform_admin) see the count;
  // institutes get the ready script library and see nothing about AI here.
  async function loadAiUsage() {
    const mine = ctx;
    $('plan-ai').textContent = '';
    let platform = false;
    try { platform = (await ctx.rpc('is_platform_admin')) === true; } catch (err) { platform = false; }
    if (ctx !== mine || !platform) return;
    try {
      const text = aiUsageText(await ctx.rpc('admin_ai_usage'));
      if (ctx !== mine) return;
      $('plan-ai').textContent = text ? text + '.' : '';
    } catch (err) {
      $('plan-ai').textContent = ctx.isMissing(err) ? 'AI draft use shows here once the AI script maker is set up.' : '';
    }
  }

  // ---------- WhatsApp (another module) ----------

  async function loadWhatsapp() {
    const section = $('settings-whatsapp');
    try {
      // settings-whatsapp.js is a classic script (admin.html loads it) that sets window.VectorSettingsWhatsApp;
      // an ES module with mount/default export is still accepted.
      const mod = window.VectorSettingsWhatsApp || await import(new URL('js/admin/settings-whatsapp.js', document.baseURI).href);
      const mount = mod && (typeof mod.mount === 'function' ? mod.mount : mod.default);
      if (typeof mount !== 'function' || !ctx || !section.isConnected) return;
      waModule = mod;
      await mount(section, ctx);
    } catch (err) { /* not built yet, or it failed: the section stays empty */ }
  }

  // ---------- terms and activity log ----------

  async function loadTerms() {
    const list = $('terms-list');
    try {
      const rows = (await rpc('my_terms_status', { p_institute: ctx.institute.id })) || [];
      list.textContent = '';
      rows.forEach((t) => list.appendChild(el('li', {
        text: 'Version ' + t.terms_version + (t.accepted_at ? ', accepted on ' + S.formatDate(t.accepted_at) : ''),
      })));
      say('terms-msg', rows.length ? '' : 'No terms accepted on this login yet.');
    } catch (err) { report('terms-msg', err, 'Could not load: '); }
  }

  async function loadLog(offset) {
    const mine = ++logSeq;
    try {
      const rows = (await rpc('admin_audit_log', { p_limit: LOG_PAGE, p_offset: offset })) || [];
      if (mine !== logSeq || !ctx) return;
      logOffset = offset;
      const total = rows.length ? Number(rows[0].total_rows) || rows.length : offset;
      const body = $('log-body');
      body.textContent = '';
      rows.forEach((r) => body.appendChild(el('tr', null, [
        el('td', { 'data-label': 'When', text: S.formatDateTime(r.created_at) }),
        el('td', { 'data-label': 'Who', text: r.actor_label || 'Vector' }),
        el('td', { 'data-label': 'What', text: actionText(r) }),
      ])));
      $('log-empty').hidden = rows.length > 0;
      $('log-newer').disabled = offset <= 0;
      $('log-older').disabled = offset + rows.length >= total;
      $('log-page').textContent = rows.length ? (offset + 1) + '–' + (offset + rows.length) + ' of ' + S.count(total) : '';
      say('log-msg', '');
    } catch (err) {
      if (mine === logSeq) report('log-msg', err, 'Could not load the log: ');
    }
  }

  S.registerTab({
    id: 'settings',
    label: 'Settings',
    mount(box, c) {
      ctx = c;
      logOffset = 0;
      build(box);
      wire();
      loadTypes();
      loadInstitute();
      loadAnswers();
      loadAiUsage();
      loadTerms();
      loadLog(0);
      loadWhatsapp();
      if (window.VectorAutopilot) window.VectorAutopilot.settings($('settings-autopilot'), ctx);
      else $('settings-autopilot').hidden = true;
    },
    // #settings?autopilot=1 (Today's "Set goals") goes to the Autopilot panel.
    show(params) {
      if (params && params.autopilot && $('settings-autopilot')) {
        setTimeout(() => { const g = $('ap-goal-fees'); $('settings-autopilot').scrollIntoView({ block: 'start' }); if (g && !g.disabled) g.focus({ preventScroll: true }); }, 0);
      }
    },
    unmount() {
      try { if (waModule && typeof waModule.unmount === 'function') waModule.unmount(); } catch (err) { /* cleared anyway */ }
      waModule = null;
      document.removeEventListener('vector:advanced', syncAdvanced);
      ctx = null;
      types = [];
      inst = null;
      logSeq++;
    },
  });
})();
