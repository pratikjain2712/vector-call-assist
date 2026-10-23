'use strict';
/* WhatsApp panel of the Settings tab (Sprint 12). js/admin/settings.js gives it <section id="settings-whatsapp">
   and calls VectorSettingsWhatsApp.mount(box, ctx) (ctx is the shell's tab context), and unmount() on sign-out.
   What it shows:
   - the institute's WhatsApp Business number: connect (owner only, with the Meta steps from
     docs/whatsapp-setup.md), change, disconnect. The token is sent once to the whatsapp-admin Edge Function,
     stored encrypted there, and never shown again;
   - message templates per call-type ending (Fees reminder, Promise due, Course details, Weekly brief to start
     from), "Submit for approval" and Meta's status;
   - this month's messages and their estimated cost (Meta India rates, before GST). The cost is shown only to
     people who can see money (the server leaves it out otherwise);
   - the weekly brief on WhatsApp for the signed-in owner.
   Data: admin_whatsapp_overview, admin_whatsapp_save_template, admin_whatsapp_delete_template,
   admin_whatsapp_brief, admin_list_call_types (RPCs) and the whatsapp-admin Edge Function. Styles:
   css/admin-settings-whatsapp.css (added to the page by mount if it is not linked yet).
   The pure helpers at the top are also loaded by tests/web/settings-whatsapp.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------

  const SOURCES = [
    ['lead_name', 'Lead name'], ['amount_due', 'Amount due (₹)'], ['promised_amount', 'Promised amount (₹)'],
    ['promised_date', 'Promised date'], ['institute_name', 'Institute name'], ['caller_name', 'Caller name'],
    ['typed', 'Typed by the caller'],
  ];
  const LANGUAGES = [['en', 'English'], ['hi', 'Hindi']];
  const RATES = { utility: 0.115, marketing: 0.86 };

  // Templates to start from. Keys promise_due and weekly_brief are used by the automatic jobs.
  const STARTERS = [
    { key: 'fees_reminder', label: 'Fees reminder', call_type_key: 'fees', result_key: null, category: 'utility', language: 'en',
      body: 'Hello {{1}}, this is a reminder from {{2}} that the fee of {{3}} is due. Please pay at the earliest. Reply STOP to stop these messages.',
      param_sources: ['lead_name', 'institute_name', 'amount_due'] },
    { key: 'promise_due', label: 'Promise due', call_type_key: 'fees', result_key: 'will_pay_on', category: 'utility', language: 'en',
      body: 'Hello {{1}}, as discussed, your payment of {{2}} is due on {{3}}. Thank you, {{4}}. Reply STOP to stop these messages.',
      param_sources: ['lead_name', 'promised_amount', 'promised_date', 'institute_name'] },
    { key: 'course_details', label: 'Course details', call_type_key: 'sales', result_key: 'interested', category: 'marketing', language: 'en',
      body: 'Hello {{1}}, thank you for your time today. Here are the details from {{2}}: {{3}}. To join, reply here or call us. Reply STOP to stop these messages.',
      param_sources: ['lead_name', 'institute_name', 'typed'] },
    { key: 'weekly_brief', label: 'Weekly brief', call_type_key: null, result_key: null, category: 'utility', language: 'en',
      body: 'Your Vector week for {{1}}: {{2}} Open Vector for details.',
      param_sources: ['typed', 'typed'] },
  ];

  // The number of {{n}} blanks when numbered 1 … n with no gap, -1 otherwise (same rule as the server).
  function countBlanks(body) {
    const s = String(body || '');
    if (/\{\{(?![0-9]{1,2}\}\})/.test(s)) return -1;
    const nums = Array.from(new Set((s.match(/\{\{([0-9]{1,2})\}\}/g) || []).map((m) => Number(m.slice(2, -2))))).sort((a, b) => a - b);
    if (!nums.length) return 0;
    return nums[0] === 1 && nums[nums.length - 1] === nums.length ? nums.length : -1;
  }

  // A plain-English problem with a template form, or '' when it can be saved.
  function checkTemplate(t) {
    const label = String((t && t.label) || '').trim();
    const body = String((t && t.body) || '').trim();
    if (!label) return 'Give the template a name.';
    if (label.length > 60) return 'The name can be 60 characters at most.';
    if (!body) return 'Write the message.';
    if (body.length > 1024) return 'The message can be 1024 characters at most.';
    const n = countBlanks(body);
    if (n < 0) return 'Number the blanks {{1}}, {{2}} … in order, with no gaps.';
    if (n > 10) return 'Use 10 blanks at most.';
    const src = (t.param_sources || []).slice(0, n);
    if (src.length !== n || src.some((s) => !SOURCES.some((x) => x[0] === s))) return 'Choose what fills each blank.';
    if (n && (/^\{\{[0-9]+\}\}/.test(body) || /\{\{[0-9]+\}\}[.!?]?$/.test(body))) {
      return 'WhatsApp does not accept a message that starts or ends with a blank. Add a few words.';
    }
    return '';
  }

  // A problem with the connect form, or ''. A token may be left empty to keep the stored one.
  function checkConnect(f, hasToken) {
    if (!/^[0-9]{5,30}$/.test(String(f.phone_number_id || '').trim())) return 'Enter the phone number ID (digits only).';
    if (!/^[0-9]{5,30}$/.test(String(f.waba_id || '').trim())) return 'Enter the WhatsApp Business Account ID (digits only).';
    const name = String(f.display_name || '').trim();
    if (!name || name.length > 80) return 'Enter the display name (up to 80 characters).';
    const tok = String(f.access_token || '').trim();
    if (!tok && !hasToken) return 'Paste the access token.';
    if (tok && !/^[A-Za-z0-9_\-.|]{20,2000}$/.test(tok)) return 'The access token does not look right. Copy it again from Meta.';
    return '';
  }

  // Meta's approval status in plain words.
  function statusLabel(t) {
    const s = t && t.meta_status;
    if (s === 'approved') return 'Approved';
    if (s === 'pending') return 'Waiting for Meta';
    if (s === 'rejected') return 'Rejected' + (t.meta_reason ? ': ' + t.meta_reason : '');
    if (s === 'paused') return 'Paused by Meta';
    if (s === 'disabled') return 'Turned off by Meta';
    return 'Not sent for approval';
  }

  // ₹ with paise for small amounts ('₹0.35'), whole rupees with Indian grouping from ₹1,000.
  function costText(n, rupees) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    if (v < 1000) return '₹' + v.toFixed(2);
    return rupees(v);
  }

  // The "Used after" choices from admin_list_call_types: any call, any ending of a type, or one ending.
  // value is 'type|result' ('' = any call; 'fees|' = any fees call).
  function endingOptions(callTypes) {
    const out = [{ value: '', label: 'Any call' }];
    (callTypes || []).filter((t) => t && t.active !== false).forEach((t) => {
      out.push({ value: t.key + '|', label: t.label + ': any ending' });
      (t.results || []).filter((r) => !r.common).forEach((r) => out.push({ value: t.key + '|' + r.key, label: t.label + ': ' + r.label }));
    });
    return out;
  }
  function endingValue(t) {
    if (!t || !t.call_type_key) return '';
    return t.call_type_key + '|' + (t.result_key || '');
  }
  function endingLabel(t, callTypes) {
    const v = endingValue(t);
    const hit = endingOptions(callTypes).find((o) => o.value === v);
    if (hit) return hit.label;
    return v ? v.replace('|', ': ') : 'Any call';
  }

  // ---------- the panel (browser only) ----------

  let ctx = null;
  let box = null;
  let state = null;   // { data: overview, callTypes, editing, connectOpen }

  const S = () => window.VectorAdminShared;
  const el = (...a) => S().el(...a);

  function ensureStyles() {
    if (document.querySelector('link[href$="css/admin-settings-whatsapp.css"]')) return;
    document.head.appendChild(el('link', { rel: 'stylesheet', href: 'css/admin-settings-whatsapp.css' }));
  }

  // The whatsapp-admin Edge Function, with the admin's own login. Throws an Error with a sentence to show.
  async function adminAction(body) {
    let data;
    let error;
    try {
      ({ data, error } = await ctx.client.functions.invoke('whatsapp-admin', { body }));
    } catch (e) {
      throw new Error('No connection. Try again.');
    }
    if (!error && data && data.ok) return data;
    let text = data && data.error ? String(data.error) : '';
    if (error && error.context && typeof error.context.json === 'function') {
      try { const b = await error.context.json(); if (b && b.error) text = String(b.error); } catch (e) { /* keep the default */ }
    }
    throw new Error(text || 'That did not go through. Try again.');
  }

  function say(id, text, isError) { S().say(box.querySelector('#' + id), text, isError); }

  async function load() {
    try {
      const data = await ctx.rpc('admin_whatsapp_overview');
      let callTypes = [];
      try { callTypes = (await ctx.rpc('admin_list_call_types')) || []; } catch (e) { callTypes = []; }
      state.data = data || {};
      state.callTypes = callTypes;
      draw();
    } catch (err) {
      box.textContent = '';
      box.appendChild(el('div', { className: 'panel wa' }, [
        el('h2', { text: 'WhatsApp' }),
        el('p', { className: 'msg error', role: 'status',
          text: ctx.isMissing(err) ? 'WhatsApp is not set up on this server yet.' : 'Could not load WhatsApp settings: ' + err.message }),
      ]));
    }
  }

  function draw() {
    box.textContent = '';
    box.appendChild(connectionPanel());
    box.appendChild(monthPanel());
    box.appendChild(templatesPanel());
    if (state.data.is_owner) box.appendChild(briefPanel());
  }

  // ----- connection -----

  const STEPS = [
    'Verify your business in Meta Business Manager (Security Centre). Have your GST or registration papers and website ready.',
    'In Meta for Developers, create a Business app and add WhatsApp to it.',
    'Add a phone number that is not used on the WhatsApp app, and get its display name approved.',
    'Create a System User with full control of the WhatsApp account and make a permanent access token with whatsapp_business_messaging and whatsapp_business_management.',
    'Copy the phone number ID and the WhatsApp Business Account ID from WhatsApp > API Setup, and paste them below with the token.',
  ];

  function connectionPanel() {
    const d = state.data;
    const acc = d.account;
    const panel = el('div', { className: 'panel wa', id: 'wa-connection' }, [el('h2', { text: 'WhatsApp number' })]);
    if (acc && acc.status === 'connected') {
      panel.appendChild(el('p', { className: 'wa-status' }, [
        el('span', { className: 'wa-pill ok', text: 'Connected' }),
        ' ' + acc.display_name + (acc.display_phone ? ' · ' + acc.display_phone : ''),
      ]));
    } else if (acc && acc.status === 'error') {
      panel.appendChild(el('p', { className: 'wa-status' }, [
        el('span', { className: 'wa-pill bad', text: 'Needs attention' }),
        ' ' + (acc.last_error || 'WhatsApp stopped accepting messages. Connect again.'),
      ]));
    } else {
      panel.appendChild(el('p', { className: 'muted', text: 'Not connected. Connect your institute\'s WhatsApp Business number to send follow-ups and payment reminders after calls.' }));
    }
    if (!d.is_owner) {
      panel.appendChild(el('p', { className: 'muted small', text: 'Only an owner can connect or change the number.' }));
      return panel;
    }
    const connected = acc && acc.status === 'connected';
    if (connected && !state.connectOpen) {
      panel.appendChild(el('div', { className: 'row' }, [
        el('button', { type: 'button', id: 'wa-change', text: 'Change number or token', onClick: () => { state.connectOpen = true; draw(); focus('wa-phone-id'); } }),
        el('button', { type: 'button', id: 'wa-disconnect', className: 'danger', text: 'Disconnect', onClick: askDisconnect }),
      ]));
      panel.appendChild(el('p', { id: 'wa-connect-msg', className: 'msg', role: 'status' }));
      return panel;
    }
    const steps = el('ol', { className: 'wa-steps' }, STEPS.map((s) => el('li', { text: s })));
    panel.appendChild(el('details', { className: 'wa-help', open: acc ? null : 'open' }, [
      el('summary', { text: 'What you need from Meta (takes a few days the first time)' }), steps,
      el('p', { className: 'muted small', text: 'Messages you send are charged by Meta to the business account: about ₹0.12 for a reminder and ₹0.86 for an offer, plus GST.' }),
    ]));
    const form = el('form', { id: 'wa-connect-form', className: 'wa-form', novalidate: 'novalidate' }, [
      field('Phone number ID', el('input', { id: 'wa-phone-id', inputmode: 'numeric', autocomplete: 'off', value: acc ? acc.phone_number_id : '' })),
      field('WhatsApp Business Account ID', el('input', { id: 'wa-waba-id', inputmode: 'numeric', autocomplete: 'off', value: acc ? acc.waba_id : '' })),
      field('Display name', el('input', { id: 'wa-display-name', maxlength: '80', autocomplete: 'organization', value: acc ? acc.display_name : '' })),
      field(acc ? 'Access token (leave empty to keep the saved one)' : 'Access token',
        el('input', { id: 'wa-token', type: 'password', autocomplete: 'off', spellcheck: 'false' })),
      el('p', { className: 'muted small', text: 'The token is kept encrypted on the server. Nobody can read it back, including you.' }),
      el('div', { className: 'row' }, [
        el('button', { type: 'submit', id: 'wa-connect', text: acc ? 'Save and check' : 'Connect' }),
        connected ? el('button', { type: 'button', text: 'Cancel', onClick: () => { state.connectOpen = false; draw(); } }) : null,
      ]),
      el('p', { id: 'wa-connect-msg', className: 'msg', role: 'status' }),
    ]);
    form.addEventListener('submit', submitConnect);
    panel.appendChild(form);
    return panel;
  }

  // A labelled input. A hint goes under it, linked with aria-describedby (so the label stays short).
  function field(label, input, hint) {
    const lab = el('label', {}, [label, input]);
    if (!hint) return lab;
    const id = (input.id || 'wa-field') + '-hint';
    input.setAttribute('aria-describedby', id);
    return el('div', { className: 'wa-field' }, [lab, el('p', { id, className: 'muted small wa-hint', text: hint })]);
  }
  function focus(id) { const n = box.querySelector('#' + id); if (n) n.focus(); }
  const val = (id) => { const n = box.querySelector('#' + id); return n ? n.value : ''; };

  async function submitConnect(e) {
    e.preventDefault();
    const f = { phone_number_id: val('wa-phone-id').trim(), waba_id: val('wa-waba-id').trim(),
      display_name: val('wa-display-name').trim(), access_token: val('wa-token').trim() };
    const hasToken = !!(state.data.account && state.data.account.status !== 'disconnected');
    const problem = checkConnect(f, hasToken);
    if (problem) { say('wa-connect-msg', problem, true); return; }
    const btn = box.querySelector('#wa-connect');
    btn.disabled = true;
    say('wa-connect-msg', 'Checking with WhatsApp…');
    try {
      const body = { action: 'connect', phone_number_id: f.phone_number_id, waba_id: f.waba_id, display_name: f.display_name };
      if (f.access_token) body.access_token = f.access_token;
      const out = await adminAction(body);
      box.querySelector('#wa-token').value = '';
      state.connectOpen = false;
      await load();
      say('wa-connect-msg', out.warning || 'Connected' + (out.display_phone ? ': ' + out.display_phone : '') + '.', !!out.warning);
    } catch (err) {
      say('wa-connect-msg', err.message, true);
      btn.disabled = false;
    }
  }

  function askDisconnect() {
    ctx.confirm({
      title: 'Disconnect WhatsApp?',
      text: 'No more messages or reminders will go out, and the saved token is deleted. You can connect again later.',
      button: 'Disconnect',
      danger: true,
      run: () => adminAction({ action: 'disconnect' }),
      done: 'WhatsApp is disconnected.',
      reload: load,
    });
  }

  // ----- this month -----

  function monthPanel() {
    const m = state.data.month || {};
    const n = (k) => S().count(Number(m[k]) || 0) || '0';
    const tile = (label, value, id) => el('div', { className: 'wa-tile', id }, [
      el('div', { className: 'wa-num', text: value }), el('div', { className: 'muted small', text: label }),
    ]);
    const tiles = el('div', { className: 'wa-tiles' }, [
      tile('Sent', n('sent'), 'wa-sent'), tile('Delivered', n('delivered')), tile('Read', n('read')),
      tile('Replies', n('replies')), tile('Asked to stop', n('stops')), tile('Not delivered', n('failed')),
    ]);
    const rates = state.data.rates || RATES;
    const cost = m.money_hidden || m.cost_inr === null || m.cost_inr === undefined
      ? el('p', { id: 'wa-cost', className: 'muted', text: 'Estimated cost is shown only to people who can see money.' })
      : el('p', { id: 'wa-cost' }, [
        el('strong', { text: 'Estimated cost: ' + costText(m.cost_inr, S().rupees) }),
        ' before GST (' + n('utility') + ' reminders at ₹' + rates.utility + ', ' + n('marketing') + ' offers at ₹' + rates.marketing + ').',
      ]);
    return el('div', { className: 'panel wa', id: 'wa-month' }, [
      el('h2', { text: 'WhatsApp this month' }), tiles, cost,
      el('p', { className: 'muted small', text: 'Meta\'s India prices. The real bill comes from Meta and can differ.' }),
    ]);
  }

  // ----- templates -----

  function templatesPanel() {
    const list = state.data.templates || [];
    const connected = !!(state.data.account && state.data.account.status === 'connected');
    const panel = el('div', { className: 'panel wa', id: 'wa-templates' }, [
      el('h2', { text: 'Messages (templates)' }),
      el('p', { className: 'muted', text: 'WhatsApp only lets a business start a chat with a message Meta has approved. Write it here, then submit it. Callers see approved messages after a call.' }),
    ]);
    if (list.length) {
      const rows = list.map((t) => el('tr', {}, [
        el('td', { 'data-label': 'Name' }, [el('strong', { text: t.label }), el('div', { className: 'muted small wa-body', text: t.body })]),
        el('td', { 'data-label': 'Used after', text: endingLabel(t, state.callTypes) }),
        el('td', { 'data-label': 'Kind', text: t.category === 'marketing' ? 'Offer (marketing)' : 'Reminder (utility)' }),
        el('td', { 'data-label': 'Status' }, [el('span', { className: 'wa-pill ' + pillClass(t.meta_status), text: statusLabel(t) })]),
        el('td', { 'data-label': 'Sent this month', className: 'num', text: S().count(Number(t.sent_this_month) || 0) || '0' }),
        el('td', { 'data-label': 'Actions' }, [el('div', { className: 'actions' }, [
          el('button', { type: 'button', text: 'Edit', 'aria-label': 'Edit ' + t.label, onClick: () => openEditor(t) }),
          t.meta_status === 'draft' || t.meta_status === 'rejected'
            ? el('button', { type: 'button', className: 'primary', text: 'Submit for approval', 'aria-label': 'Submit ' + t.label + ' for approval',
              disabled: !connected, onClick: (e) => submitTemplate(t, e.currentTarget) })
            : null,
          el('button', { type: 'button', className: 'danger', text: 'Delete', 'aria-label': 'Delete ' + t.label, onClick: () => askDelete(t) }),
        ])]),
      ]));
      panel.appendChild(el('div', { className: 'scroll' }, [el('table', { className: 'stack', id: 'wa-template-table' }, [
        el('thead', {}, [el('tr', {}, ['Name', 'Used after', 'Kind', 'Status', 'Sent this month', ''].map((h, i) =>
          el('th', { scope: 'col', className: i === 4 ? 'num' : null, text: h })))]),
        el('tbody', {}, rows),
      ])]));
    } else {
      panel.appendChild(el('p', { className: 'muted', text: 'No messages yet. Start from one below.' }));
    }
    const have = new Set(list.map((t) => t.key));
    const starters = STARTERS.filter((s) => !have.has(s.key));
    panel.appendChild(el('div', { className: 'row wa-add' }, [
      el('button', { type: 'button', id: 'wa-new', text: 'New message', onClick: () => openEditor(null) }),
    ].concat(starters.map((s) => el('button', { type: 'button', text: 'Start from: ' + s.label, onClick: () => openEditor(Object.assign({ starter: true }, s)) })),
      connected && list.some((t) => t.meta_status === 'pending')
        ? [el('button', { type: 'button', id: 'wa-refresh', text: 'Check approval status', onClick: (e) => refreshStatus(e.currentTarget) })]
        : [])));
    if (!connected) panel.appendChild(el('p', { className: 'muted small', text: 'Connect your WhatsApp number to submit messages for approval.' }));
    panel.appendChild(el('p', { id: 'wa-templates-msg', className: 'msg', role: 'status' }));
    if (state.editing) panel.appendChild(editor());
    return panel;
  }

  function pillClass(s) {
    if (s === 'approved') return 'ok';
    if (s === 'rejected' || s === 'disabled' || s === 'paused') return 'bad';
    if (s === 'pending') return 'wait';
    return '';
  }

  function openEditor(t) {
    state.editing = t
      ? { id: t.starter ? null : t.id, key: t.key, label: t.label, call_type_key: t.call_type_key, result_key: t.result_key,
        language: t.language || 'en', category: t.category || 'utility', body: t.body, param_sources: (t.param_sources || []).slice(),
        approved: t.meta_status && t.meta_status !== 'draft' }
      : { id: null, key: '', label: '', call_type_key: null, result_key: null, language: 'en', category: 'utility', body: '', param_sources: [] };
    draw();
    focus('wa-t-label');
  }

  // Reads the editor into state.editing (so a redraw keeps what was typed).
  function readEditor() {
    const t = state.editing;
    t.label = val('wa-t-label');
    t.body = val('wa-t-body');
    t.language = val('wa-t-language') || 'en';
    t.category = val('wa-t-category') || 'utility';
    const ending = val('wa-t-ending');
    const [type, result] = ending ? ending.split('|') : ['', ''];
    t.call_type_key = type || null;
    t.result_key = result || null;
    const n = Math.max(0, countBlanks(t.body));
    const src = [];
    for (let i = 1; i <= n; i++) {
      const sel = box.querySelector('#wa-t-src-' + i);
      src.push(sel ? sel.value : (t.param_sources[i - 1] || ''));
    }
    t.param_sources = src;
    return t;
  }

  function editor() {
    const t = state.editing;
    const n = countBlanks(t.body);
    const options = endingOptions(state.callTypes);
    const select = (id, items, current) => el('select', { id }, items.map(([v, l]) => el('option', { value: v, text: l, selected: v === current ? 'selected' : null })));
    const ending = el('select', { id: 'wa-t-ending' }, options.map((o) =>
      el('option', { value: o.value, text: o.label, selected: o.value === endingValue(t) ? 'selected' : null })));
    const blanks = el('div', { className: 'wa-blanks', id: 'wa-t-blanks' });
    for (let i = 1; i <= Math.max(0, n); i++) {
      blanks.appendChild(field('{{' + i + '}} is filled with', select('wa-t-src-' + i,
        [['', 'Choose…']].concat(SOURCES), t.param_sources[i - 1] || '')));
    }
    const preview = el('p', { className: 'wa-preview', id: 'wa-t-preview', 'aria-live': 'polite' });
    const form = el('form', { id: 'wa-template-form', className: 'wa-form wa-editor', novalidate: 'novalidate' }, [
      el('h3', { text: t.id ? 'Edit message' : 'New message' }),
      t.approved ? el('p', { className: 'muted small', text: 'Changing the text, language or kind sends it back for approval.' }) : null,
      field('Name', el('input', { id: 'wa-t-label', maxlength: '60', value: t.label })),
      field('Used after', ending),
      el('div', { className: 'row' }, [
        field('Language', select('wa-t-language', LANGUAGES, t.language)),
        field('Kind', select('wa-t-category', [['utility', 'Reminder or update (₹' + RATES.utility + ')'], ['marketing', 'Offer or course promotion (₹' + RATES.marketing + ')']], t.category)),
      ]),
      field('Message', el('textarea', { id: 'wa-t-body', maxlength: '1024', rows: '4', value: t.body }),
        'Write {{1}}, {{2}} … where the name, amount or date goes. End with "Reply STOP to stop these messages."'),
      blanks,
      el('div', {}, [el('div', { className: 'muted small', text: 'Preview' }), preview]),
      el('div', { className: 'row' }, [
        el('button', { type: 'submit', id: 'wa-t-save', text: 'Save' }),
        el('button', { type: 'button', text: 'Cancel', onClick: () => { state.editing = null; draw(); } }),
      ]),
      el('p', { id: 'wa-t-msg', className: 'msg', role: 'status' }),
    ]);
    form.addEventListener('submit', saveTemplate);
    // Typing in the message redraws the blanks only when their number changes, so focus stays in the box.
    form.addEventListener('input', (e) => {
      const before = Math.max(0, countBlanks(state.editing.body));
      readEditor();
      if (e.target && e.target.id === 'wa-t-body' && Math.max(0, countBlanks(state.editing.body)) !== before) redrawBlanks();
      drawPreview();
    });
    form.addEventListener('change', () => { readEditor(); drawPreview(); });
    setTimeout(drawPreview, 0);
    return form;
  }

  function redrawBlanks() {
    const t = state.editing;
    const wrap = box.querySelector('#wa-t-blanks');
    if (!wrap) return;
    wrap.textContent = '';
    const n = Math.max(0, countBlanks(t.body));
    for (let i = 1; i <= n; i++) {
      const sel = el('select', { id: 'wa-t-src-' + i }, [['', 'Choose…']].concat(SOURCES).map(([v, l]) =>
        el('option', { value: v, text: l, selected: v === (t.param_sources[i - 1] || '') ? 'selected' : null })));
      wrap.appendChild(field('{{' + i + '}} is filled with', sel));
    }
  }

  function drawPreview() {
    const node = box && box.querySelector('#wa-t-preview');
    if (!node || !state.editing) return;
    const t = state.editing;
    const sample = { lead_name: 'Asha', amount_due: '₹12,000', promised_amount: '₹6,000', promised_date: '25 Oct 2026',
      institute_name: (state.data.account && state.data.account.display_name) || 'Your Institute', caller_name: 'Priya', typed: '…' };
    node.textContent = String(t.body || '').replace(/\{\{([0-9]{1,2})\}\}/g, (m, k) => {
      const src = t.param_sources[Number(k) - 1];
      return src ? sample[src] : m;
    }) || '—';
  }

  async function saveTemplate(e) {
    e.preventDefault();
    const t = readEditor();
    const problem = checkTemplate(t);
    if (problem) { say('wa-t-msg', problem, true); return; }
    const btn = box.querySelector('#wa-t-save');
    btn.disabled = true;
    try {
      await ctx.rpc('admin_whatsapp_save_template', {
        p_id: t.id, p_label: t.label.trim(), p_key: t.id ? null : (t.key || null), p_call_type_key: t.call_type_key,
        p_result_key: t.result_key, p_language: t.language, p_category: t.category, p_body: t.body.trim(),
        p_param_sources: t.param_sources,
      });
      state.editing = null;
      await load();
      say('wa-templates-msg', 'Saved. Submit it for approval when it is ready.');
    } catch (err) {
      say('wa-t-msg', err.message, true);
      btn.disabled = false;
    }
  }

  async function submitTemplate(t, btn) {
    btn.disabled = true;
    say('wa-templates-msg', 'Sending "' + t.label + '" to Meta…');
    try {
      const out = await adminAction({ action: 'submit_template', template_id: t.id });
      await load();
      say('wa-templates-msg', '"' + t.label + '" was sent for approval. Meta usually answers within a day.' + (out.note ? ' ' + out.note : ''));
    } catch (err) {
      say('wa-templates-msg', err.message, true);
      btn.disabled = false;
    }
  }

  async function refreshStatus(btn) {
    btn.disabled = true;
    try {
      await adminAction({ action: 'refresh_templates' });
      await load();
      say('wa-templates-msg', 'Approval status checked.');
    } catch (err) {
      say('wa-templates-msg', err.message, true);
      btn.disabled = false;
    }
  }

  function askDelete(t) {
    ctx.confirm({
      title: 'Delete "' + t.label + '"?',
      text: 'Callers will not see this message any more. Messages already sent stay in the log.',
      button: 'Delete',
      danger: true,
      run: () => ctx.rpc('admin_whatsapp_delete_template', { p_id: t.id }),
      done: 'Message deleted.',
      reload: load,
    });
  }

  // ----- weekly brief (owner) -----

  function briefPanel() {
    const b = state.data.brief || {};
    const hasTemplate = (state.data.templates || []).some((t) => t.key === 'weekly_brief' && t.meta_status === 'approved');
    const form = el('form', { id: 'wa-brief-form', className: 'wa-form', novalidate: 'novalidate' }, [
      el('label', { className: 'wa-check' }, [
        el('input', { type: 'checkbox', id: 'wa-brief-on', checked: !!b.on }),
        'Send me the weekly brief on WhatsApp every Monday',
      ]),
      field('Your WhatsApp number', el('input', { id: 'wa-brief-phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel',
        value: b.phone ? String(b.phone).replace(/^\+91/, '') : '' })),
      hasTemplate ? null : el('p', { className: 'muted small', text: 'This needs the "Weekly brief" message, approved by Meta.' }),
      el('div', { className: 'row' }, [el('button', { type: 'submit', id: 'wa-brief-save', text: 'Save' })]),
      el('p', { id: 'wa-brief-msg', className: 'msg', role: 'status' }),
    ]);
    form.addEventListener('submit', saveBrief);
    return el('div', { className: 'panel wa', id: 'wa-brief' }, [el('h2', { text: 'Weekly brief on WhatsApp' }), form]);
  }

  async function saveBrief(e) {
    e.preventDefault();
    const on = box.querySelector('#wa-brief-on').checked;
    const phone = val('wa-brief-phone').trim();
    if (on && !/^(\+?91)?[\s-]*0?[0-9][0-9\s-]{8,12}$/.test(phone)) { say('wa-brief-msg', 'Enter your 10-digit mobile number.', true); return; }
    const btn = box.querySelector('#wa-brief-save');
    btn.disabled = true;
    try {
      await ctx.rpc('admin_whatsapp_brief', { p_on: on, p_phone: on ? phone : null });
      await load();
      say('wa-brief-msg', on ? 'You will get the brief on WhatsApp on Mondays.' : 'The WhatsApp brief is off.');
    } catch (err) {
      say('wa-brief-msg', err.message, true);
      btn.disabled = false;
    }
  }

  function mount(container, c) {
    ctx = c;
    box = container;
    state = { data: {}, callTypes: [], editing: null, connectOpen: false };
    box.classList.add('wa-settings');
    ensureStyles();
    box.textContent = '';
    box.appendChild(el('p', { className: 'muted', text: 'Loading WhatsApp settings…' }));
    return load();
  }

  function unmount() {
    if (box) box.textContent = '';
    ctx = null;
    box = null;
    state = null;
  }

  const api = { SOURCES, LANGUAGES, RATES, STARTERS, countBlanks, checkTemplate, checkConnect, statusLabel, costText,
    endingOptions, endingValue, endingLabel, mount, unmount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VectorSettingsWhatsApp = api;
})();
