'use strict';
/* Campaigns tab of the admin app (web/admin.html): the campaign list, one campaign's page (progress, pause,
   resume, close, callers, add more leads) and "New campaign" in 4 steps, as in the mockup: 1 details, 2 script,
   3 leads, 4 who can call; then Save as draft or Start campaign (docs/phase-a-plan.md, Sprint 8).
   Phase A.2 (open campaigns): step 4 is "All callers" (the default: every caller takes the next free lead, no
   members needed) or "Only these callers"; step 1 has Class and Board chips (tags callers filter by); the list
   shows the tags; the campaign page shows who can call, the tags and "Return follow-ups to the pool after N
   hours" (release_after_hours), all changeable through admin_update_campaign's new arguments.
   Routes: #campaigns (list), #campaigns?id=<campaign> (one campaign), #campaigns?new=1 (New campaign).
   Reads: admin_campaign_list, admin_campaign_detail, admin_list_call_types, admin_seat_list, my_features, and
   the institute's scripts with their live version (table read, as the Scripts tab does).
   Writes (all checked on the server, supabase/migrations/20261024100020_campaign_admin.sql): admin_create_campaign,
   admin_update_campaign, admin_add_leads, admin_set_campaign_members, admin_share_leads.
   Add row (js/admin/add-row.js): "Import from Excel" or "+ Add lead" (one person, admin_add_leads with one row
   and the consent keys of 20261026100000_add_row.sql) on a list's page; "Import from Excel" or "+ Add by hand"
   (a small table) in step 3; a ready Excel template for the lead sheet. The list's extra fields come from a REST
   read of a few of its leads' extra (never a money column).
   Lead sheets: .xlsx through the same XLSX library as the caller app (loaded the first time it is needed),
   .csv through LeadUpload.parseCsv; phone checks through ImportCheck (js/lead-upload.js, js/import-check.js).
   Money: counts only, except the campaign's total amount due when the server says this admin may see money.
   The pure helpers at the top are also loaded by tests/web/campaigns.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------

  const STATUS = { draft: 'Not started', running: 'Running', paused: 'Paused', closed: 'Closed' };
  const statusLabel = (s) => STATUS[s] || String(s || '');
  const SHARE = { equal: 'Equal parts', next_free: 'One by one, whoever is free next' };

  // The colour of a type's pill: fees amber, sales blue, follow-up green, the rest grey (CSS class names).
  function typeTone(key) {
    if (key === 'fees' || key === 'renewal') return 'tone-warn';
    if (key === 'sales' || key === 'admission') return 'tone-accent';
    if (key === 'follow_up' || key === 'event') return 'tone-ok';
    return 'tone-plain';
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ymdParts(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) } : null;
  }
  const dayMonth = (p) => p.d + ' ' + MONTHS[p.m];

  // Dates as in the mockup: '15 – 31 Oct', '1 Oct – 11 Nov', 'From 10 Oct', 'Until 20 Nov', 'No dates'.
  // The year is shown when the two dates are in different years.
  function dateRange(start, end) {
    const a = ymdParts(start), b = ymdParts(end);
    if (!a && !b) return 'No dates';
    if (a && !b) return 'From ' + dayMonth(a);
    if (!a && b) return 'Until ' + dayMonth(b);
    if (a.y !== b.y) return dayMonth(a) + ' ' + a.y + ' – ' + dayMonth(b) + ' ' + b.y;
    if (a.m === b.m) return (a.d === b.d ? '' : a.d + ' – ') + dayMonth(b);
    return dayMonth(a) + ' – ' + dayMonth(b);
  }

  // Called share as a whole percent for the progress bar (0 when there are no leads).
  function percent(part, total) {
    const t = Number(total) || 0;
    if (t <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((Number(part) || 0) * 100 / t)));
  }

  // The buttons a campaign offers for its status: [{ status, label, danger }].
  function statusActions(status) {
    if (status === 'draft') return [{ status: 'running', label: 'Start calling' }, { status: 'closed', label: 'Close', danger: true }];
    if (status === 'running') return [{ status: 'paused', label: 'Pause' }, { status: 'closed', label: 'Close', danger: true }];
    if (status === 'paused') return [{ status: 'running', label: 'Resume' }, { status: 'closed', label: 'Close', danger: true }];
    return [];
  }

  // A script's live version, or null: the published one of script_versions.
  function liveVersion(script) {
    const v = ((script && script.script_versions) || []).filter((x) => x && x.published);
    return v.length ? v[0] : null;
  }

  // On since scripts.call_type_id exists (0022): only live scripts of the campaign's type, or untyped scripts
  // saved before types, are offered. The server checks the same in campaign_check_script (0030) and the
  // campaigns_check_script trigger (0022).
  const SCRIPT_TYPE_FILTER = true;

  // The scripts step 2 offers: live scripts only, of the chosen type when the filter is on, by name.
  function scriptChoices(scripts, typeId, filterOn) {
    return (scripts || [])
      .filter((s) => liveVersion(s))
      .filter((s) => !filterOn || !s.call_type_id || s.call_type_id === typeId)
      .map((s) => ({ id: s.id, name: s.name, version: liveVersion(s).version, steps: liveVersion(s).steps || [] }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  // What a save does, in order, from the form: the step list for the page and the check before it starts.
  // f: { name, typeId, start, end, target, leads (ready rows), seats (ids), share, start: bool }.
  // Returns an error text, or '' when the form can be saved.
  function formProblem(f, starting) {
    if (!String(f.name || '').trim()) return 'Give the calling list a name.';
    if (String(f.name).trim().length > 120) return 'Keep the name under 120 characters.';
    if (!f.typeId) return 'Pick a type.';
    if (f.startDate && f.endDate && f.endDate < f.startDate) return 'The end date is before the start date.';
    if (f.target !== '' && f.target !== null && f.target !== undefined) {
      const n = Number(f.target);
      if (!Number.isInteger(n) || n < 1 || n > 10000) return 'The daily target is a number of calls from 1 to 10,000.';
    }
    if (f.moneyInExtra && f.moneyInExtra.length) return 'Column "' + f.moneyInExtra[0] + '" has money in it. Match it to Amount due or untick it.';
    if (f.classLabel && String(f.classLabel).trim().length > 20) return 'Keep the class to 20 characters.';
    if (starting) {
      if (!f.leadCount) return 'Add a lead sheet before you start.';
      // An open campaign (all callers, Phase A.2) starts without anyone picked.
      if (f.openToAll !== true && !f.seatCount) return 'Pick at least one caller before you start.';
    }
    return '';
  }

  // ----- Phase A.2: open campaigns and class / board tags -----
  const CLASSES = ['6th', '7th', '8th', '9th', '10th', '11th', '12th'];
  const BOARDS = ['CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other'];

  // The class from the chips: a chip value, the typed class for "Other class", or '' (no tag).
  function classFromChoice(choice, typed) {
    if (choice === 'custom') return String(typed || '').trim();
    return CLASSES.includes(choice) ? choice : '';
  }

  // "8th · CBSE", "8th", "CBSE" or '' for a campaign without tags.
  function tagsText(c) {
    const x = c || {};
    return [x.class_label, x.board].filter((v) => v && String(v).trim()).join(' · ');
  }

  // "All callers" or "Only chosen callers". An old campaign without the column was for its members only.
  const whoCanCall = (c) => (c && c.open_to_all === true ? 'All callers' : 'Only chosen callers');

  // "Return follow-ups to the pool after N hours": a whole number from 1 to 720, or a problem.
  function releaseProblem(v) {
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 720 ? '' : 'Hours before follow-ups go to other callers: a whole number from 1 to 720.';
  }

  // "220 leads added. 12 bad numbers and 8 repeats skipped." from admin_add_leads counts.
  function addedText(c) {
    const x = c || {};
    const n = Number(x.added) || 0;
    const parts = [];
    if (x.bad_numbers) parts.push(x.bad_numbers + ' bad number' + (x.bad_numbers === 1 ? '' : 's'));
    if (x.repeats) parts.push(x.repeats + ' repeat' + (x.repeats === 1 ? '' : 's'));
    if (x.other_skipped) parts.push(x.other_skipped + ' other row' + (x.other_skipped === 1 ? '' : 's'));
    return n + ' lead' + (n === 1 ? '' : 's') + ' added.' + (parts.length ? ' ' + parts.join(', ') + ' skipped.' : '');
  }

  const pure = { statusLabel, typeTone, dateRange, percent, statusActions, liveVersion, scriptChoices, formProblem,
    addedText, SCRIPT_TYPE_FILTER, CLASSES, BOARDS, classFromChoice, tagsText, whoCanCall, releaseProblem };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ---------- browser ----------

  const S = window.VectorAdminShared;
  const LU = window.LeadUpload;
  const AR = window.VectorAddRow;   // "+ Add lead", "+ Add by hand" and the Excel template (js/admin/add-row.js)
  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const CHUNK = 1000;   // leads per admin_add_leads call (the server takes up to 5000)
  // The same file as app.html's cdnjs copy (same SRI hash), from jsDelivr, which the admin page's CSP allows.
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const XLSX_SRI = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';

  let ctx = null;
  let box = null;
  let campaigns = [];
  let types = [];          // active call types
  let scripts = [];        // the institute's scripts with versions
  let seats = [];          // active seats of the institute
  let features = null;     // my_features(), null until loaded
  let current = null;      // detail of the open campaign
  let seq = 0;             // newest load wins
  let busy = false;
  let pickers = {};        // lead pickers by prefix: { sheet, map, built }
  let xlsxLoading = null;

  const NOT_YET = 'Not available yet: the database needs the calling lists update.';
  const cell = (text, cls, label) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || '', 'data-label': label || null });
  const head = (cols) => el('thead', null, [el('tr', null, cols.map((c) => el('th', { text: c[0], className: c[1] || '' })))]);
  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const button = (text, onClick, cls, id) => el('button', { type: 'button', text, onClick, className: cls || '', id: id || null });
  const hasScripts = () => !features || features.indexOf('scripts') >= 0;

  async function rpc(name, args) {
    try { return await ctx.rpc(name, args); } catch (err) {
      if (ctx.isMissing(err)) throw new Error(NOT_YET);
      throw err;
    }
  }
  const rows = (data) => (Array.isArray(data) ? data : data ? [data] : []);

  // ---------- page ----------

  function build() {
    box.appendChild(el('div', { className: 'tab-head camp-head' }, [
      el('div', null, [
        el('h2', { text: 'Calling lists' }),
        el('p', { className: 'muted', text: 'A calling list is the people to call, the call script and who calls them.' }),
      ]),
      el('a', { href: S.buildHash('calling', { new: '1' }), id: 'camp-new', className: 'button-link primary', text: '+ New calling list' }),
    ]));

    box.appendChild(el('section', { className: 'panel', id: 'camp-list', 'aria-label': 'All calling lists' }, [
      msg('camp-list-msg'),
      el('div', { className: 'scroll' }, [el('table', { className: 'stack' }, [
        head([['Calling list'], ['Type'], ['Call script'], ['Called', 'num'], ['Callers'], ['Dates'], ['Status'], ['']]),
        el('tbody', { id: 'camp-body' }),
      ])]),
      el('p', { id: 'camp-empty', className: 'muted', hidden: true, text: 'No calling lists yet. Start one with New calling list.' }),
    ]));

    box.appendChild(el('section', { className: 'panel', id: 'camp-detail', hidden: true, 'aria-labelledby': 'camp-d-name' }));
    // Autopilot: the one-screen New calling list (fees from the ledger), filled in by the planner.
    box.appendChild(el('section', { className: 'panel', id: 'camp-quick', hidden: true, 'aria-labelledby': 'camp-q-title' }, [
      el('p', { className: 'back' }, [el('a', { href: S.buildHash('calling'), text: '← All calling lists' })]),
      el('h2', { id: 'camp-q-title', text: 'New calling list' }),
      el('div', { id: 'camp-q-body' }),
      el('p', { className: 'small camp-q-other' }, [el('a', { href: S.buildHash('calling', { new: '1', full: '1' }), id: 'camp-q-other',
        text: 'Another kind of list (from a sheet or by hand)' })]),
    ]));
    box.appendChild(buildWizard());
  }

  // ---------- list ----------

  async function loadList() {
    const my = ++seq;
    say('camp-list-msg', 'Loading…');
    try {
      const data = rows(await rpc('admin_campaign_list'));
      if (my !== seq || !ctx) return;
      campaigns = data;
      say('camp-list-msg', '');
      renderList();
    } catch (err) {
      if (my !== seq || !ctx) return;
      say('camp-list-msg', err.message === NOT_YET ? NOT_YET : 'Could not load calling lists: ' + err.message, err.message !== NOT_YET);
    }
  }

  function typePill(key, label) {
    return el('span', { className: 'pill ' + typeTone(key), text: label || key || '' });
  }

  function progress(called, total) {
    const p = percent(called, total);
    return el('div', { className: 'progress' }, [
      el('span', { className: 'progress-text', text: S.count(called || 0) + ' / ' + S.count(total || 0) }),
      el('div', { className: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(p),
        'aria-label': p + '% called' }, [el('div', { className: 'bar-fill', 'data-pct': String(p) })]),
    ]);
  }
  // CSP forbids inline styles in markup, but the CSSOM is fine: set the bar width after building it.
  function sizeBars(root) {
    root.querySelectorAll('.bar-fill[data-pct]').forEach((b) => { b.style.width = b.getAttribute('data-pct') + '%'; });
  }

  function renderList() {
    const body = $('camp-body');
    body.textContent = '';
    campaigns.forEach((c) => {
      const open = c.open_to_all === true;
      const callers = open ? 'All callers' : rows(c.callers).map((x) => x.label).join(', ');
      const td = (node, label, cls) => el('td', { 'data-label': label, className: cls || '' }, [node]);
      const tags = tagsText(c);
      body.appendChild(el('tr', null, [
        el('td', { 'data-label': 'Calling list', className: 'camp-name' }, [
          el('span', { text: c.name }),
          tags ? el('span', { className: 'tag', text: tags }) : null,
        ]),
        td(typePill(c.call_type_key, c.call_type_label), 'Type'),
        cell(c.script_name || 'No call script', '', 'Call script'),
        td(progress(c.leads_called, c.leads_total), 'Called', 'num'),
        cell(callers || 'No callers yet', callers ? '' : 'muted', 'Callers'),
        cell(dateRange(c.start_date, c.end_date), '', 'Dates'),
        el('td', { 'data-label': 'Status' }, [el('span', { className: 'status st-' + c.status, text: statusLabel(c.status) })]),
        el('td', { 'data-label': '' }, [el('a', { href: S.buildHash('calling', { id: c.id }), text: 'Open',
          'aria-label': 'Open ' + c.name })]),
      ]));
    });
    sizeBars(body);
    $('camp-empty').hidden = campaigns.length > 0;
  }

  // ---------- one campaign ----------

  async function loadDetail(id) {
    const my = ++seq;
    const pane = $('camp-detail');
    pane.textContent = '';
    pane.appendChild(msg('camp-d-msg'));
    say('camp-d-msg', 'Loading…');
    try {
      const [d] = await Promise.all([rpc('admin_campaign_detail', { p_campaign: id }), ensureSeats()]);
      if (my !== seq || !ctx) return;
      current = Array.isArray(d) ? d[0] : d;
      if (!current) throw new Error('calling list not found');
      renderDetail();
    } catch (err) {
      if (my !== seq || !ctx) return;
      current = null;
      pane.textContent = '';
      pane.appendChild(el('p', null, [el('a', { href: S.buildHash('calling'), text: '← All calling lists' })]));
      pane.appendChild(el('p', { className: 'msg error', text: /not found/i.test(err.message) ? 'This calling list was not found.' : 'Could not open the calling list: ' + err.message }));
    }
  }

  function fact(label, value) {
    return el('div', { className: 'fact' }, [el('dt', { text: label }), el('dd', { text: value })]);
  }
  // A fact, a field or a chip group shown only with "Show advanced options" on (simple mode hides it).
  const advFact = (label, value) => { const f = fact(label, value); f.classList.add('adv'); return f; };
  const advanced = (node) => { node.classList.add('adv'); return node; };
  let wizardSeq = 0;
  function stat(label, value, cls) {
    return el('div', { className: 'stat ' + (cls || '') }, [el('span', { className: 'stat-n', text: S.count(value || 0) }), el('span', { className: 'stat-l', text: label })]);
  }

  function renderDetail() {
    const c = current;
    const pane = $('camp-detail');
    pane.textContent = '';
    const leads = c.leads || {};
    const closed = c.status === 'closed';

    pane.appendChild(el('p', { className: 'back' }, [el('a', { href: S.buildHash('calling'), text: '← All calling lists' })]));
    pane.appendChild(el('div', { className: 'row between d-head' }, [
      el('h2', { id: 'camp-d-name', text: c.name }),
      el('span', { className: 'status st-' + c.status, id: 'camp-d-status', text: statusLabel(c.status) }),
    ]));
    pane.appendChild(el('dl', { className: 'facts' }, [
      el('div', { className: 'fact' }, [el('dt', { text: 'Type' }), el('dd', null, [typePill(c.call_type_key, c.call_type_label)])]),
      fact('Script', c.script_name ? c.script_name + (c.script_live_version ? ' v' + c.script_live_version + ' (live)' : '') : 'No script'),
      fact('Dates', dateRange(c.start_date, c.end_date)),
      advFact('Daily target', c.daily_target ? S.count(c.daily_target) + ' calls' : 'None'),
      advFact('Share leads', SHARE[c.share_mode] || c.share_mode),
      fact('Who can call', whoCanCall(c)),
      fact('Class and board', tagsText(c) || 'Any'),
      advFact('Follow-ups go to other callers', 'After ' + S.count(c.release_after_hours || 24) + ' working hours without a call'),
    ]));

    pane.appendChild(el('h3', { text: 'Progress' }));
    const prog = progress(leads.called, leads.total);
    prog.id = 'camp-d-progress';
    pane.appendChild(prog);
    const stats = [
      stat('calls today', c.calls_today),
      stat('to call', leads.open),
      stat('call backs', leads.callback),
      stat('promises', leads.promised),
      stat('done', leads.done),
      stat('wrong numbers', leads.wrong_number),
      stat('do not call', leads.do_not_call),
    ];
    if (leads.unassigned) stats.push(stat(c.share_mode === 'next_free' ? 'waiting for a free caller' : 'without a caller', leads.unassigned, leads.unassigned && c.share_mode !== 'next_free' ? 'warn' : ''));
    pane.appendChild(el('div', { className: 'stats', id: 'camp-d-stats' }, stats));
    // Money: the total due of the sheet, only when the server says this admin may see money.
    if (ctx.canSeeMoney && !c.money_hidden && c.amount_due_total !== null && c.amount_due_total !== undefined) {
      pane.appendChild(el('p', { className: 'small', id: 'camp-d-money' }, ['Amount due on the lead list: ', el('strong', { text: S.rupees(c.amount_due_total) })]));
    }
    const results = rows(c.results);
    if (results.length) {
      pane.appendChild(el('h3', { text: 'Results so far' }));
      pane.appendChild(el('ul', { className: 'plain results' }, results.map((r) => el('li', null, [
        el('span', { text: r.label }), el('span', { className: 'num', text: S.count(r.count) }),
      ]))));
    }

    // Status buttons.
    const actions = statusActions(c.status);
    if (actions.length) {
      pane.appendChild(el('div', { className: 'actions d-actions' }, actions.map((a) =>
        button(a.label, () => askStatus(a), a.danger ? 'danger' : (a.status === 'running' ? 'primary' : ''), 'camp-d-' + (a.status === 'running' ? (c.status === 'draft' ? 'start' : 'resume') : a.status === 'paused' ? 'pause' : 'close')))));
    } else {
      pane.appendChild(el('p', { className: 'muted', text: 'This calling list is closed. Its results stay in Reports.' }));
    }
    pane.appendChild(msg('camp-d-msg'));

    // Callers.
    pane.appendChild(el('h3', { text: 'Callers' }));
    const callers = rows(c.callers);
    if (callers.length) {
      pane.appendChild(el('div', { className: 'scroll' }, [el('table', { className: 'stack' }, [
        head([['Caller'], ['Leads', 'num'], ['To call', 'num'], ['Called', 'num'], ['Calls today', 'num']]),
        el('tbody', { id: 'camp-d-callers' }, callers.map((m) => el('tr', null, [
          cell(m.label + (m.status && m.status !== 'active' ? ' (' + m.status + ')' : '') + (m.member === false && c.open_to_all !== true ? ' (not on the list)' : ''), '', 'Caller'),
          cell(S.count(m.leads), 'num', 'Leads'), cell(S.count(m.open), 'num', 'To call'),
          cell(S.count(m.called), 'num', 'Called'), cell(S.count(m.calls_today), 'num', 'Calls today'),
        ]))),
      ])]));
    } else {
      pane.appendChild(el('p', { className: 'muted', text: 'No callers yet.' }));
    }
    if (c.open_to_all === true) {
      pane.appendChild(el('p', { className: 'muted small', id: 'camp-d-open-note', text: 'Every caller can work this list. A caller who stops calling for ' +
        S.count(c.release_after_hours || 24) + ' working hours has their due follow-ups given to other callers.' }));
    } else if (!closed) pane.appendChild(buildCallerEditor(c, callers));
    const people = el('details', { className: 'camp-people', id: 'camp-people' }, [el('summary', { text: 'People on this list' })]);
    pane.appendChild(people);
    loadPeople(c, people);
    if (!closed) pane.appendChild(buildMoreLeads());
    if (!closed) pane.appendChild(buildDetailsEditor(c));
    sizeBars(pane);
  }

  function askStatus(a) {
    const c = current;
    const texts = {
      running: c.status === 'draft' ? 'Callers see this list and start calling.' : 'Callers can call this list again.',
      paused: 'Callers stop getting people from this list until you resume it. Nothing is lost.',
      closed: 'Callers stop calling this list for good. A closed list cannot be opened again. Results stay in Reports.',
    };
    ctx.confirm({
      title: a.label + ': ' + c.name,
      text: texts[a.status],
      button: a.label,
      danger: !!a.danger,
      run: () => rpc('admin_update_campaign', { p_campaign: c.id, p_status: a.status }),
      done: c.name + ': ' + statusLabel(a.status).toLowerCase() + '.',
      reload: () => loadDetail(c.id),
    });
  }

  // Callers and how leads are shared, for a campaign that is not closed.
  function buildCallerEditor(c, callers) {
    const on = new Set(callers.map((m) => m.seat_id));
    const form = el('form', { className: 'subform', id: 'camp-d-callers-form' }, [
      el('h4', { text: 'Change callers' }),
      seatChecks('camp-d-seat', on),
      el('label', { className: 'adv' }, ['Share leads', shareSelect('camp-d-share', c.share_mode, null)]),
      el('div', { className: 'row' }, [el('button', { type: 'submit', text: 'Save callers' })]),
      msg('camp-d-callers-msg'),
    ]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const ids = checkedSeats('camp-d-seat');
      const mode = $('camp-d-share').value;
      if (!ids.length && c.status === 'running') { say('camp-d-callers-msg', 'A running calling list needs at least one caller. Pause it first.', true); return; }
      busy = true;
      say('camp-d-callers-msg', 'Saving…');
      try {
        await rpc('admin_set_campaign_members', { p_campaign: c.id, p_seats: ids });
        if (ids.length || mode === 'next_free') await rpc('admin_share_leads', { p_campaign: c.id, p_mode: mode });
        ctx.status('Callers saved for ' + c.name + '.');
        busy = false;
        await loadDetail(c.id);
      } catch (err) {
        busy = false;
        say('camp-d-callers-msg', err.message, true);
      }
    });
    return form;
  }

  // "Add more people" on a calling list: "Import from Excel" (a lead sheet, as before) or "+ Add lead" (one person
  // by hand, admin_add_leads with one row), side by side (js/admin/add-row.js). The open one stays open when the
  // page reloads after an add.
  let detailMode = 'excel';
  let detailModeFor = null;
  let oneNote = null;      // { text, ok }: said under "+ Add lead" after the page reloads
  let listKeys = null;     // the extra fields of the open list's leads (null until read)
  let listKeysFor = null;

  // The extra fields the open list's leads already have (a REST read of a few leads' extra; admins may read them).
  async function loadListKeys(c) {
    if (listKeysFor === c.id && listKeys) return listKeys;
    let keys = [];
    try {
      const { data, error } = await ctx.client.from('leads').select('extra').eq('campaign_id', c.id).limit(50);
      if (!error) keys = AR.extraKeysOf(rows(data));
    } catch (err) { keys = []; }
    if (!current || current.id !== c.id) return keys;
    listKeys = keys;
    listKeysFor = c.id;
    return keys;
  }

  function buildMoreLeads() {
    const c = current;
    if (detailModeFor !== c.id) { detailMode = 'excel'; detailModeFor = c.id; oneNote = null; }
    const template = AR.templateButton(el, say, 'camp-d-template',
      () => AR.leadTemplate({ typeKey: c.call_type_key, money: ctx.canSeeMoney, extras: listKeysFor === c.id ? listKeys : [] }),
      'vector-' + String(c.name || 'calling-list').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-template.xlsx', 'camp-d-leads-msg');
    const form = el('form', { className: 'addrow-pane', id: 'camp-d-leads-form', hidden: detailMode !== 'excel' }, [
      leadPicker('camp-d-leads'),
      el('p', { className: 'addrow-template-row' }, [template]),
      el('div', { className: 'row' }, [el('button', { type: 'submit', text: 'Add leads' })]),
      msg('camp-d-leads-msg'),
    ]);
    const one = el('div', { className: 'addrow-pane', id: 'camp-d-one', hidden: detailMode !== 'one' }, [
      el('div', { id: 'camp-d-one-body' }),
      el('p', { id: 'camp-d-one-result', className: 'msg', role: 'status' }),
    ]);
    const sw = AR.modeSwitch(el, 'Add people to this calling list', [
      { key: 'excel', label: 'Import from Excel', id: 'camp-d-mode-excel', controls: 'camp-d-leads-form' },
      { key: 'one', label: '+ Add lead', id: 'camp-d-mode-one', controls: 'camp-d-one' },
    ], detailMode, (key) => {
      detailMode = key;
      form.hidden = key !== 'excel';
      one.hidden = key !== 'one';
      if (key === 'one') fillOneLead(c, true);
    });
    const wrap = el('div', { className: 'subform', id: 'camp-d-more' }, [el('h4', { text: 'Add more people' }), sw.node, form, one]);
    if (oneNote) { const r = one.querySelector('#camp-d-one-result'); r.textContent = oneNote.text; r.classList.toggle('error', !oneNote.ok); oneNote = null; }
    if (detailMode === 'one') setTimeout(() => fillOneLead(c, false), 0);
    else loadListKeys(c);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const built = pickerResult('camp-d-leads');
      if (!built || !built.rows.length) { say('camp-d-leads-msg', 'Choose a sheet with at least one good row.', true); return; }
      const money = LU.moneyInExtra(pickers['camp-d-leads'].sheet.header, pickers['camp-d-leads'].map.extra);
      if (money.length) { say('camp-d-leads-msg', 'Column "' + money[0] + '" has money in it. Match it to Amount due or untick it.', true); return; }
      busy = true;
      say('camp-d-leads-msg', 'Adding…');
      try {
        const id = current.id;
        const total = await sendLeads(id, built.rows, (done) => say('camp-d-leads-msg', 'Adding… ' + S.count(done) + ' of ' + S.count(built.rows.length)));
        busy = false;
        ctx.status(addedText(total));
        await loadDetail(id);
      } catch (err) {
        busy = false;
        say('camp-d-leads-msg', 'Not all leads were added: ' + err.message, true);
      }
    });
    return wrap;
  }

  // The "+ Add lead" form: name, phone, the list's extra fields, amount due (fees lists, money access only), where
  // the number came from, and consent to calls and WhatsApp.
  async function fillOneLead(c, focus) {
    const body = $('camp-d-one-body');
    if (!body || body.childNodes.length) { if (focus && $('camp-d-one-name')) $('camp-d-one-name').focus(); return; }
    const known = await loadListKeys(c);
    if (!current || current.id !== c.id || !$('camp-d-one-body') || $('camp-d-one-body').childNodes.length) return;
    const fields = AR.leadFields(c.call_type_key, known);
    const amount = AR.amountAllowed(c.call_type_key, ctx.canSeeMoney);
    const input = (id, props) => el('input', Object.assign({ id, type: 'text', autocomplete: 'off' }, props || {}));
    const form = el('form', { id: 'camp-d-one-form', className: 'addrow-form', novalidate: 'novalidate' }, [
      el('div', { className: 'addrow-grid' }, [
        el('label', null, ['Name (needed)', input('camp-d-one-name', { maxlength: '120', 'aria-required': 'true' })]),
        el('label', null, ['Phone (needed)', input('camp-d-one-phone', { type: 'tel', inputmode: 'tel', maxlength: '20', placeholder: '98765 43210', 'aria-required': 'true' })]),
      ].concat(fields.map((k, i) => el('label', null, [k, input('camp-d-one-x' + i, { maxlength: '300', 'data-key': k })])),
        amount ? [el('label', null, ['Amount due (₹)', input('camp-d-one-amount', { inputmode: 'decimal' })])] : [],
        [el('label', { className: 'addrow-wide' }, ['Where we got the number', input('camp-d-one-source', { maxlength: '300', placeholder: 'the enquiry form on our website' })])])),
      el('div', { className: 'addrow-checks' }, [
        el('label', { className: 'check' }, [el('input', { type: 'checkbox', id: 'camp-d-one-call', checked: true }), ' Agreed to get calls']),
        el('label', { className: 'check' }, [el('input', { type: 'checkbox', id: 'camp-d-one-wa' }), ' Agreed to WhatsApp messages']),
      ]),
      el('div', { className: 'row' }, [el('button', { type: 'submit', id: 'camp-d-one-save', text: 'Add lead' })]),
    ]);
    form.addEventListener('submit', (e) => { e.preventDefault(); addOneLead(c, fields, amount); });
    body.appendChild(form);
    if (focus) $('camp-d-one-name').focus();
  }

  async function addOneLead(c, fields, amount) {
    if (busy) return;
    const extra = {};
    fields.forEach((k, i) => { extra[k] = $('camp-d-one-x' + i).value; });
    const one = AR.leadRow({
      name: $('camp-d-one-name').value, phone: $('camp-d-one-phone').value, extra, amount: amount ? $('camp-d-one-amount').value : '',
      source: $('camp-d-one-source').value, consent_call: $('camp-d-one-call').checked, consent_whatsapp: $('camp-d-one-wa').checked,
    }, { amount });
    const result = $('camp-d-one-result');
    if (one.problem) {
      say(result, one.problem.text, true);
      const f = { name: 'camp-d-one-name', phone: 'camp-d-one-phone', amount: 'camp-d-one-amount' }[one.problem.field];
      if (f && $(f)) { $(f).setAttribute('aria-invalid', 'true'); $(f).focus(); }
      return;
    }
    busy = true;
    $('camp-d-one-save').disabled = true;
    say(result, 'Adding…');
    try {
      const counts = await rpc('admin_add_leads', { p_campaign: c.id, p_rows: [one.row] });
      busy = false;
      const out = AR.oneLeadText(counts, one.row.name, c.name);
      if (!out.ok) {
        say(result, out.text, true);
        $('camp-d-one-save').disabled = false;
        if (/phone|number/.test(out.text)) $('camp-d-one-phone').focus();
        return;
      }
      oneNote = { text: out.text + ' Add the next one, or go back to the list.', ok: true };
      ctx.status(out.text);
      await loadDetail(c.id);
      if ($('camp-d-one-name')) $('camp-d-one-name').focus();
    } catch (err) {
      busy = false;
      if ($('camp-d-one-save')) $('camp-d-one-save').disabled = false;
      say(result, 'Not added: ' + err.message, true);
    }
  }

  function buildDetailsEditor(c) {
    const form = el('form', { className: 'subform', id: 'camp-d-edit' }, [
      el('h4', { text: 'Change details' }),
      el('label', null, ['Name', el('input', { id: 'camp-d-name-in', type: 'text', maxlength: '120', value: c.name, required: true })]),
      el('div', { className: 'row' }, [
        el('label', null, ['Start', el('input', { id: 'camp-d-startdate', type: 'date', value: c.start_date || '' })]),
        el('label', null, ['End', el('input', { id: 'camp-d-enddate', type: 'date', value: c.end_date || '' })]),
        el('label', { className: 'adv' }, ['Daily target (calls)', el('input', { id: 'camp-d-target', type: 'number', min: '1', max: '10000', step: '1',
          inputmode: 'numeric', value: c.daily_target ? String(c.daily_target) : '' })]),
      ]),
      el('div', { className: 'row' }, [
        el('label', null, ['Who can call', el('select', { id: 'camp-d-open' }, [
          el('option', { value: 'all', text: 'All callers' }),
          el('option', { value: 'some', text: 'Only chosen callers' }),
        ])]),
        el('label', null, ['Class', el('input', { id: 'camp-d-class', type: 'text', maxlength: '20', list: 'camp-class-list', value: c.class_label || '', placeholder: 'Any' })]),
        el('label', { className: 'adv' }, ['Board', el('select', { id: 'camp-d-board' }, [el('option', { value: '', text: 'Any' })]
          .concat(BOARDS.map((b) => el('option', { value: b, text: b }))))]),
      ]),
      el('datalist', { id: 'camp-class-list' }, CLASSES.map((x) => el('option', { value: x }))),
      el('label', { className: 'adv' }, ['Give follow-ups to other callers after (working hours without a call)',
        el('input', { id: 'camp-d-release', type: 'number', min: '1', max: '720', step: '1', inputmode: 'numeric', value: String(c.release_after_hours || 24) })]),
      el('p', { className: 'muted small adv', text: 'Call backs and promises stay with the caller who spoke to the parent. If that caller makes no call in this list for this many working hours (Sundays not counted), their due follow-ups go to other callers.' }),
      el('div', { className: 'row' }, [el('button', { type: 'submit', text: 'Save details' })]),
      msg('camp-d-edit-msg'),
    ]);
    form.querySelector('#camp-d-open').value = c.open_to_all === true ? 'all' : 'some';
    form.querySelector('#camp-d-board').value = c.board || '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const f = { name: $('camp-d-name-in').value, typeId: c.call_type_id, startDate: $('camp-d-startdate').value, endDate: $('camp-d-enddate').value, target: $('camp-d-target').value,
        classLabel: $('camp-d-class').value.trim() };
      const release = $('camp-d-release').value.trim();
      const problem = formProblem(f, false) || releaseProblem(release);
      if (problem) { say('camp-d-edit-msg', problem, true); return; }
      busy = true;
      try {
        const clearDates = !f.startDate && !f.endDate;
        await rpc('admin_update_campaign', {
          p_campaign: c.id, p_name: f.name.trim(),
          p_start: f.startDate || null, p_end: f.endDate || null, p_clear_dates: clearDates,
          p_daily_target: f.target === '' ? 0 : Number(f.target),
          p_open_to_all: $('camp-d-open').value === 'all', p_class_label: f.classLabel, p_board: $('camp-d-board').value,
          p_release_after_hours: release === '' ? null : Number(release),
        });
        busy = false;
        ctx.status('Details saved for ' + f.name.trim() + '.');
        await loadDetail(c.id);
      } catch (err) {
        busy = false;
        say('camp-d-edit-msg', err.message, true);
      }
    });
    return form;
  }

  // ---------- shared form parts ----------

  // A checkbox per active seat: callers first, then admins (an admin can call too).
  function seatChecks(prefix, on) {
    const list = seats.slice().sort((a, b) => (a.role === 'admin') - (b.role === 'admin') || String(a.label).localeCompare(String(b.label)));
    const wrap = el('fieldset', { className: 'checks', id: prefix + 's' }, [el('legend', { text: 'Who calls' })]);
    if (!list.length) wrap.appendChild(el('p', { className: 'muted small', text: 'Nobody on your team yet. Add people on the Team tab.' }));
    list.forEach((s) => {
      wrap.appendChild(el('label', { className: 'check' }, [
        el('input', { type: 'checkbox', className: prefix, value: s.seat_id, checked: on.has(s.seat_id) }),
        s.label + (s.role === 'admin' ? ' (admin)' : ''),
      ]));
    });
    return wrap;
  }
  const checkedSeats = (prefix) => Array.from(document.querySelectorAll('input.' + prefix + ':checked')).map((i) => i.value);

  function shareSelect(id, value, leadCount) {
    const sel = el('select', { id }, [
      el('option', { value: 'equal', text: LU.equalText(leadCount, null) }),
      el('option', { value: 'next_free', text: SHARE.next_free }),
    ]);
    sel.value = value || 'equal';
    return sel;
  }

  async function ensureSeats() {
    if (seats.length) return;
    try {
      const data = rows(await rpc('admin_seat_list', { p_institute: ctx.institute.id }));
      seats = data.filter((s) => s.status === 'active' && s.role !== 'accounts');   // Accounts seats make no calls
    } catch (err) { seats = []; }
  }

  // ---------- lead sheet picker (step 3, and "Add more leads") ----------

  function leadPicker(prefix) {
    pickers[prefix] = { sheet: null, map: null, built: null, file: '' };
    const input = el('input', { type: 'file', id: prefix + '-file', accept: '.xlsx,.xls,.csv', className: 'file-input' });
    input.addEventListener('change', () => { if (input.files && input.files[0]) readFile(prefix, input.files[0]); });
    return el('div', { className: 'picker', id: prefix }, [
      el('label', { className: 'drop', for: prefix + '-file' }, [
        el('span', { className: 'drop-title', id: prefix + '-name', text: 'Choose an Excel or CSV file' }),
        el('span', { className: 'muted small', text: 'First row: column names. One person per row.' }),
        input,
      ]),
      el('div', { id: prefix + '-map', className: 'map', hidden: true }),
      el('p', { id: prefix + '-skip', className: 'msg skip', role: 'status' }),
    ]);
  }

  // The XLSX library (the same file and hash as the caller app), loaded the first time a sheet is opened.
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = XLSX_URL;
      s.integrity = XLSX_SRI;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('no reader')));
      s.onerror = () => { xlsxLoading = null; s.remove(); reject(new Error('no reader')); };
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }

  async function readFile(prefix, file) {
    const p = pickers[prefix];
    say(prefix + '-skip', 'Reading ' + file.name + '…');
    try {
      let aoa;
      if (/\.csv$/i.test(file.name)) aoa = LU.parseCsv(await file.text());   // CSV stays text: 09876543210 keeps its 0
      else {
        let X;
        try { X = await loadXlsx(); } catch (err) {
          say(prefix + '-skip', 'The spreadsheet reader did not load. Check your internet connection, or save the sheet as .csv.', true);
          return;
        }
        const wb = X.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', raw: true, cellDates: true });
        aoa = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
      }
      if (!pickers[prefix] || pickers[prefix] !== p) return;   // the form was rebuilt meanwhile
      const sheet = LU.tidy(aoa);
      if (!sheet.rows.length) { say(prefix + '-skip', 'That sheet has no rows under the header row.', true); return; }
      p.sheet = sheet;
      p.file = file.name;
      p.map = LU.guessColumns(sheet.header);
      $(prefix + '-name').textContent = file.name + ' · ' + S.count(sheet.rows.length) + ' row' + (sheet.rows.length === 1 ? '' : 's');
      renderMap(prefix);
    } catch (err) {
      say(prefix + '-skip', 'Could not read that file. Use an .xlsx or .csv file with a header row.', true);
    }
  }

  function colSelect(id, header, value, noneText) {
    const sel = el('select', { id }, [el('option', { value: '-1', text: noneText })].concat(
      header.map((h, i) => el('option', { value: String(i), text: h }))));
    sel.value = String(value);
    return sel;
  }

  // Column matching: name, phone and amount due, then a tick per other column to keep as an extra field.
  function renderMap(prefix) {
    const p = pickers[prefix];
    const box2 = $(prefix + '-map');
    box2.textContent = '';
    const h = p.sheet.header;
    const nameSel = colSelect(prefix + '-col-name', h, p.map.name, 'Pick a column');
    const phoneSel = colSelect(prefix + '-col-phone', h, p.map.phone, 'Pick a column');
    const amountSel = colSelect(prefix + '-col-amount', h, p.map.amount, 'No amount');
    box2.appendChild(el('div', { className: 'map-grid' }, [
      el('label', null, ['Name', nameSel]),
      el('label', null, ['Phone', phoneSel]),
      el('label', null, ['Amount due', amountSel]),
    ]));
    const others = el('fieldset', { className: 'checks extra', id: prefix + '-extra' }, [el('legend', { text: 'Other columns to keep (shown to the caller)' })]);
    h.forEach((name, i) => {
      if (i === p.map.name || i === p.map.phone || i === p.map.amount) return;
      const money = LU.looksLikeMoney(name);
      const box3 = el('input', { type: 'checkbox', value: String(i), checked: !money && p.map.extra.indexOf(i) >= 0, disabled: money });
      box3.addEventListener('change', () => {
        p.map.extra = Array.from(others.querySelectorAll('input:checked')).map((x) => Number(x.value));
        recount(prefix);
      });
      others.appendChild(el('label', { className: 'check' }, [box3, name + (money ? ' (money: use it as Amount due)' : '')]));
    });
    if (others.querySelectorAll('input').length) box2.appendChild(others);
    const onCol = () => {
      p.map.name = Number(nameSel.value);
      p.map.phone = Number(phoneSel.value);
      p.map.amount = Number(amountSel.value);
      p.map.extra = p.map.extra.filter((i) => i !== p.map.name && i !== p.map.phone && i !== p.map.amount);
      renderMap(prefix);
    };
    [nameSel, phoneSel, amountSel].forEach((s) => s.addEventListener('change', onCol));
    box2.hidden = false;
    recount(prefix);
  }

  function recount(prefix) {
    const p = pickers[prefix];
    if (!p.sheet) return;
    if (p.map.name < 0 || p.map.phone < 0) {
      p.built = null;
      say(prefix + '-skip', 'Pick the name and phone columns.', true);
      return;
    }
    p.built = LU.buildLeads(p.sheet, p.map);
    const skip = LU.skipText(p.built.counts);
    const ready = p.built.counts.ready;
    say(prefix + '-skip', S.count(ready) + ' lead' + (ready === 1 ? '' : 's') + ' ready.' + (skip ? ' ' + skip + '.' : ''), false);
    $(prefix + '-skip').classList.toggle('warn', !!skip);
    if (prefix === 'camp-w-leads') syncShareText();
  }
  const pickerResult = (prefix) => (pickers[prefix] ? pickers[prefix].built : null);

  async function sendLeads(campaignId, list, onProgress) {
    let total = {};
    let done = 0;
    for (const part of LU.chunk(list, CHUNK)) {
      const out = await rpc('admin_add_leads', { p_campaign: campaignId, p_rows: part });
      total = LU.addCounts(total, out);
      done += part.length;
      if (onProgress) onProgress(done);
    }
    return total;
  }

  // ---------- New calling list, step 3: "Import from Excel" or "+ Add by hand" ----------

  let wizMode = 'excel';
  // The hand table: its extra columns (from the call type), whether it has Amount due, and the rows typed so far.
  let hand = { cols: [], amount: false, rows: [] };
  const blankHandRow = () => ({ name: '', phone: '', extra: {}, amount: '' });
  const wizTypeKey = () => { const sel = $('camp-w-type'); const t = sel ? types.find((x) => x.id === sel.value) : null; return t ? t.key : ''; };

  function leadsStep() {
    wizMode = 'excel';
    hand = { cols: AR.leadFields(wizTypeKey(), []), amount: AR.amountAllowed(wizTypeKey(), ctx.canSeeMoney), rows: [blankHandRow()] };
    const excel = el('div', { id: 'camp-w-excel', className: 'addrow-pane' }, [
      leadPicker('camp-w-leads'),
      el('p', { className: 'addrow-template-row' }, [AR.templateButton(el, say, 'camp-w-template',
        () => AR.leadTemplate({ typeKey: wizTypeKey(), money: ctx.canSeeMoney }),
        'vector-calling-list-template' + (wizTypeKey() ? '-' + wizTypeKey().replace(/_/g, '-') : '') + '.xlsx', 'camp-w-template-msg')]),
      msg('camp-w-template-msg'),
    ]);
    const byHand = el('div', { id: 'camp-w-hand-pane', className: 'addrow-pane', hidden: true }, [
      el('p', { className: 'muted small', text: 'Type a few people here: name and a 10-digit mobile number. Empty rows are left out.' }),
      el('div', { id: 'camp-w-hand-box' }),
      el('button', { type: 'button', id: 'camp-w-hand-add', text: '+ Add row' }),
      el('p', { id: 'camp-w-hand-msg', className: 'msg', role: 'status' }),
    ]);
    const sw = AR.modeSwitch(el, 'How to add leads', [
      { key: 'excel', label: 'Import from Excel', id: 'camp-w-mode-excel', controls: 'camp-w-excel' },
      { key: 'hand', label: '+ Add by hand', id: 'camp-w-mode-hand', controls: 'camp-w-hand-pane' },
    ], 'excel', (key) => {
      wizMode = key;
      excel.hidden = key !== 'excel';
      byHand.hidden = key !== 'hand';
      const card = $('camp-w-step3');
      if (card) card.classList.toggle('addrow-by-hand', key === 'hand');
      if (key === 'hand') { renderHand(); const first = $('camp-w-hand-name-0'); if (first) first.focus(); }
      syncShareText();
    });
    byHand.querySelector('#camp-w-hand-add').addEventListener('click', () => {
      readHand();
      if (hand.rows.length >= AR.MAX_HAND_ROWS) { say('camp-w-hand-msg', 'At most ' + AR.MAX_HAND_ROWS + ' rows by hand. Use Import from Excel for more.', true); return; }
      hand.rows.push(blankHandRow());
      renderHand();
      $('camp-w-hand-name-' + (hand.rows.length - 1)).focus();
    });
    return [sw.node, excel, byHand];
  }

  // The rows as typed (the table is the source while it is on the page).
  function readHand() {
    const body = $('camp-w-hand-body');
    if (!body) return;
    hand.rows = Array.from(body.querySelectorAll('tr')).map((tr, i) => {
      const v = (id) => { const n = $(id); return n ? n.value : ''; };
      const extra = {};
      hand.cols.forEach((k, j) => { extra[k] = v('camp-w-hand-x' + j + '-' + i); });
      return { name: v('camp-w-hand-name-' + i), phone: v('camp-w-hand-phone-' + i), extra, amount: hand.amount ? v('camp-w-hand-amount-' + i) : '' };
    });
  }

  // The type changed: its usual columns. What was typed in Name, Phone and a column that stays is kept.
  function syncHandColumns() {
    readHand();
    hand.cols = AR.leadFields(wizTypeKey(), []);
    hand.amount = AR.amountAllowed(wizTypeKey(), ctx.canSeeMoney);
    if (wizMode === 'hand') renderHand();
  }

  function renderHand() {
    const box2 = $('camp-w-hand-box');
    if (!box2) return;
    box2.textContent = '';
    if (!hand.rows.length) hand.rows.push(blankHandRow());
    const cols = [['name', 'Name'], ['phone', 'Phone']].concat(hand.cols.map((k, j) => ['x' + j, k]), hand.amount ? [['amount', 'Amount due (₹)']] : []);
    const valueOf = (r, key, j) => (key === 'name' ? r.name : key === 'phone' ? r.phone : key === 'amount' ? r.amount : (r.extra || {})[hand.cols[j]] || '');
    const body = el('tbody', { id: 'camp-w-hand-body' }, hand.rows.map((r, i) => {
      const cells = cols.map(([key, label], c) => {
        const j = c - 2;
        const props = { id: 'camp-w-hand-' + key + '-' + i, type: key === 'phone' ? 'tel' : 'text', autocomplete: 'off', value: valueOf(r, key, j),
          'aria-label': label + ', row ' + (i + 1) };
        if (key === 'phone') { props.inputmode = 'tel'; props.maxlength = '20'; }
        if (key === 'amount') props.inputmode = 'decimal';
        return el('td', { 'data-label': label }, [el('input', props)]);
      });
      const remove = el('button', { type: 'button', className: 'addrow-remove', text: 'Remove', 'aria-label': 'Remove row ' + (i + 1), disabled: hand.rows.length < 2 });
      remove.addEventListener('click', () => {
        readHand();
        hand.rows.splice(i, 1);
        renderHand();
        $('camp-w-hand-add').focus();
      });
      return el('tr', null, cells.concat([el('td', { 'data-label': '', className: 'addrow-row-actions' }, [remove])]));
    }));
    box2.appendChild(el('table', { className: 'stack addrow-hand', id: 'camp-w-hand' }, [
      el('thead', null, [el('tr', null, cols.map((x) => el('th', { text: x[1] })).concat([el('th', { text: '' })]))]),
      body,
    ]));
    body.addEventListener('input', () => { say('camp-w-hand-msg', ''); syncShareText(); });
  }

  // The leads typed by hand, checked: { built: { rows, counts: { ready } }, problem } (problem: the first one).
  function handResult() {
    readHand();
    const h = AR.handRows(hand.rows, { amount: hand.amount });
    return { built: { rows: h.rows, counts: { ready: h.rows.length } }, problem: h.problems[0] || null };
  }

  // ---------- New campaign ----------

  function buildWizard() {
    return el('section', { className: 'panel', id: 'camp-wizard', hidden: true, 'aria-labelledby': 'camp-w-title' }, [
      el('p', { className: 'back' }, [el('a', { href: S.buildHash('calling'), text: '← All calling lists' })]),
      el('h2', { id: 'camp-w-title', text: 'New calling list' }),
      el('form', { id: 'camp-w-form', novalidate: 'novalidate' }, [
        el('div', { className: 'steps', id: 'camp-w-steps' }),
        el('div', { className: 'row end' }, [
          el('button', { type: 'button', id: 'camp-w-draft', text: 'Save, start later' }),
          el('button', { type: 'submit', id: 'camp-w-start', text: 'Start calling' }),
        ]),
        msg('camp-w-msg'),
      ]),
    ]);
  }

  // A row of chip-like radio buttons: options [[value, label]]; the first is picked. Each input gets the id
  // <name>-<value or 'any'>.
  function chipGroup(name, legend, options) {
    return el('fieldset', { className: 'chips', id: name + '-chips' }, [el('legend', { text: legend })].concat(options.map(([v, t], i) =>
      el('label', { className: 'chip' }, [
        el('input', { type: 'radio', name, value: v, id: name + '-' + (v ? v.toLowerCase() : 'any'), checked: i === 0 }),
        el('span', { text: t }),
      ]))));
  }
  const picked = (name) => { const i = document.querySelector('input[name="' + name + '"]:checked'); return i ? i.value : ''; };

  function step(n, title, children) {
    return el('fieldset', { className: 'step', id: 'camp-w-step' + n }, [el('legend', { text: n + ' · ' + title })].concat(children));
  }

  async function openWizard() {
    const my = ++wizardSeq;   // the form is built once, by the last call (the view can be shown twice while loading)
    const steps = $('camp-w-steps');
    steps.textContent = '';
    pickers = {};
    say('camp-w-msg', 'Loading…');
    await Promise.all([loadTypes(), loadScripts(), ensureSeats(), loadFeatures()]);
    if (!ctx || my !== wizardSeq) return;
    steps.textContent = '';
    say('camp-w-msg', '');

    const typeSel = el('select', { id: 'camp-w-type', required: true }, types.map((t) => el('option', { value: t.id, text: t.label })));
    const fees = types.find((t) => t.key === 'fees');
    if (fees) typeSel.value = fees.id;
    steps.appendChild(step(1, 'Details', [
      el('label', null, ['Name', el('input', { id: 'camp-w-name', type: 'text', maxlength: '120', placeholder: 'Nov fees – Class 10', required: true })]),
      el('label', null, ['Type', typeSel]),
      el('div', { className: 'row two' }, [
        el('label', null, ['Start', el('input', { id: 'camp-w-startdate', type: 'date' })]),
        el('label', null, ['End', el('input', { id: 'camp-w-enddate', type: 'date' })]),
      ]),
      chipGroup('camp-w-class', 'Class (callers pick calling lists by class)', [['', 'Any']].concat(CLASSES.map((x) => [x, x]), [['custom', 'Other class']])),
      el('label', { id: 'camp-w-class-other-field', hidden: true }, ['Other class', el('input', { id: 'camp-w-class-other', type: 'text', maxlength: '20', placeholder: 'Nursery, LKG, B.Com 1st year' })]),
      advanced(chipGroup('camp-w-board', 'Board', [['', 'Any']].concat(BOARDS.map((b) => [b, b])))),
    ]));
    steps.querySelectorAll('input[name="camp-w-class"]').forEach((i) => i.addEventListener('change', () => {
      const custom = $('camp-w-class-custom').checked;
      $('camp-w-class-other-field').hidden = !custom;
      if (custom) $('camp-w-class-other').focus();
    }));

    const scriptSel = el('select', { id: 'camp-w-script' });
    const scriptLabel = el('span', { id: 'camp-w-script-label', text: 'Script' });
    const previewBtn = button('Preview script', () => togglePreview(), 'linkish', 'camp-w-preview-btn');
    previewBtn.setAttribute('aria-expanded', 'false');
    previewBtn.setAttribute('aria-controls', 'camp-w-preview');
    steps.appendChild(step(2, 'Call script', hasScripts() ? [
      el('label', null, [scriptLabel, scriptSel]),
      el('p', { className: 'muted small', text: 'Callers always get the live version. A new version starts on their next call, never in the middle of one.' }),
      previewBtn,
      el('ol', { id: 'camp-w-preview', className: 'preview', hidden: true }),
    ] : [
      el('p', { className: 'muted small', id: 'camp-w-noscripts', text: 'Add Scripts to use a guided script. Without it, callers use the result buttons only.' }),
    ]));
    typeSel.addEventListener('change', fillScripts);
    typeSel.addEventListener('change', syncHandColumns);
    scriptSel.addEventListener('change', () => { if (!$('camp-w-preview').hidden) renderPreview(); });
    if (hasScripts()) fillScripts();

    steps.appendChild(step(3, 'Leads', leadsStep()));

    const target = el('input', { id: 'camp-w-target', type: 'number', min: '1', max: '10000', step: '1', inputmode: 'numeric', placeholder: '40' });
    steps.appendChild(step(4, 'Who can call', [
      el('div', { className: 'who', role: 'radiogroup', 'aria-label': 'Who can call' }, [
        el('label', { className: 'check' }, [el('input', { type: 'radio', name: 'camp-w-who', id: 'camp-w-who-all', value: 'all', checked: true }),
          el('span', null, [el('strong', { text: 'All callers' }), el('span', { className: 'muted small', text: ' Every caller sees this list and takes the next person. Nothing to set up.' })])]),
        el('label', { className: 'check' }, [el('input', { type: 'radio', name: 'camp-w-who', id: 'camp-w-who-some', value: 'some' }),
          el('span', null, [el('strong', { text: 'Only these callers' }), el('span', { className: 'muted small', text: ' Pick who works on it.' })])]),
      ]),
      el('div', { id: 'camp-w-some', hidden: true }, [
        seatChecks('camp-w-seat', new Set()),
        el('label', { className: 'adv' }, ['Share leads', shareSelect('camp-w-share', 'equal', null)]),
      ]),
      el('label', { className: 'adv' }, ['Daily target (calls a day, all callers)', target]),
      el('p', { className: 'muted small adv', id: 'camp-w-target-hint' }),
    ]));
    steps.querySelectorAll('input[name="camp-w-who"]').forEach((i) => i.addEventListener('change', () => {
      $('camp-w-some').hidden = !$('camp-w-who-some').checked;
      syncShareText();
    }));
    steps.querySelectorAll('input.camp-w-seat').forEach((i) => i.addEventListener('change', syncShareText));
    target.addEventListener('input', syncShareText);
    syncShareText();
    $('camp-w-name').focus();
  }

  function fillScripts() {
    const sel = $('camp-w-script');
    if (!sel) return;
    const typeId = $('camp-w-type').value;
    const t = types.find((x) => x.id === typeId);
    const list = scriptChoices(scripts, typeId, SCRIPT_TYPE_FILTER);
    sel.textContent = '';
    sel.appendChild(el('option', { value: '', text: 'No script' }));
    list.forEach((s) => sel.appendChild(el('option', { value: s.id, text: s.name + ' v' + s.version + ' (live)' })));
    if (list.length) sel.value = list[0].id;
    $('camp-w-script-label').textContent = SCRIPT_TYPE_FILTER && t ? 'Script (' + t.label.toLowerCase() + ' scripts only)' : 'Script (live scripts only)';
    if (!$('camp-w-preview').hidden) renderPreview();
  }

  function togglePreview() {
    const box2 = $('camp-w-preview');
    box2.hidden = !box2.hidden;
    $('camp-w-preview-btn').setAttribute('aria-expanded', String(!box2.hidden));
    if (!box2.hidden) renderPreview();
  }

  function renderPreview() {
    const box2 = $('camp-w-preview');
    box2.textContent = '';
    const s = scriptChoices(scripts, $('camp-w-type').value, SCRIPT_TYPE_FILTER).find((x) => x.id === $('camp-w-script').value);
    if (!s) { box2.appendChild(el('li', { className: 'muted', text: 'No script picked.' })); return; }
    (s.steps || []).forEach((st) => {
      const say1 = Array.isArray(st.say) ? st.say.join(' ') : '';
      box2.appendChild(el('li', null, [
        el('strong', { text: st.title || st.id || '' }),
        say1 ? el('span', { text: ' ' + say1 }) : null,
      ]));
    });
    if (!box2.children.length) box2.appendChild(el('li', { className: 'muted', text: 'This script has no steps yet.' }));
  }

  function syncShareText() {
    const sel = $('camp-w-share');
    if (!sel) return;
    let n = 0;
    if (wizMode === 'hand') { readHand(); n = AR.handRows(hand.rows, { amount: hand.amount }).counts.ready; }
    else if (pickerResult('camp-w-leads')) n = pickerResult('camp-w-leads').counts.ready;
    const open = $('camp-w-who-all') && $('camp-w-who-all').checked;
    const callers = open ? 0 : checkedSeats('camp-w-seat').length;
    sel.options[0].textContent = LU.equalText(n, callers);
    const t = Number($('camp-w-target').value);
    $('camp-w-target-hint').textContent = t > 0 && callers > 1 ? 'About ' + S.count(Math.ceil(t / callers)) + ' a day for each caller.' : '';
  }

  async function loadTypes() {
    try {
      types = rows(await rpc('admin_list_call_types')).filter((t) => t.active !== false);
    } catch (err) { types = []; }
  }
  async function loadScripts() {
    try {
      const cols = 'id, name' + (SCRIPT_TYPE_FILTER ? ', call_type_id' : '') + ', script_versions(version, steps, published)';
      const { data, error } = await ctx.client.from('scripts').select(cols).eq('institute_id', ctx.institute.id);
      scripts = error ? [] : rows(data);
    } catch (err) { scripts = []; }
  }
  async function loadFeatures() {
    try {
      const f = await rpc('my_features');
      features = Array.isArray(f) ? f.filter((x) => typeof x === 'string') : [];
    } catch (err) { features = null; }   // an older database: the server still checks
  }

  // Save as draft (start false) or Start campaign (start true): create, add leads, set callers, share,
  // then start. A failure after the campaign exists opens it, so the admin can finish there.
  async function saveWizard(start) {
    if (busy) return;
    const byHand = wizMode === 'hand';
    let built = pickerResult('camp-w-leads');
    const p = pickers['camp-w-leads'];
    if (byHand) {
      const h = handResult();
      if (h.problem) {
        say('camp-w-msg', h.problem.text, true);
        const input = $('camp-w-hand-' + (h.problem.field === 'extra' ? 'name' : h.problem.field) + '-' + (h.problem.row - 1));
        if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
        return;
      }
      built = h.built;
    }
    const f = {
      name: $('camp-w-name').value, typeId: $('camp-w-type').value,
      startDate: $('camp-w-startdate').value, endDate: $('camp-w-enddate').value, target: $('camp-w-target').value,
      leadCount: built ? built.counts.ready : 0, seatCount: checkedSeats('camp-w-seat').length,
      moneyInExtra: !byHand && p && p.sheet && p.map ? LU.moneyInExtra(p.sheet.header, p.map.extra) : [],
      openToAll: $('camp-w-who-all').checked,
      classLabel: classFromChoice(picked('camp-w-class'), $('camp-w-class-other').value),
      board: picked('camp-w-board'),
    };
    if (picked('camp-w-class') === 'custom' && !f.classLabel) { say('camp-w-msg', 'Type the class, or pick one.', true); return; }
    const problem = formProblem(f, start);
    if (problem) { say('camp-w-msg', problem, true); return; }
    const scriptSel = $('camp-w-script');
    const seatIds = f.openToAll ? [] : checkedSeats('camp-w-seat');
    const mode = f.openToAll ? null : $('camp-w-share').value;
    busy = true;
    $('camp-w-draft').disabled = true;
    $('camp-w-start').disabled = true;
    say('camp-w-msg', 'Saving…');
    let id = null;
    const notes = [];
    try {
      id = await rpc('admin_create_campaign', {
        p_name: f.name.trim(), p_call_type: f.typeId, p_script: scriptSel && scriptSel.value ? scriptSel.value : null,
        p_start: f.startDate || null, p_end: f.endDate || null,
        p_daily_target: f.target === '' ? null : Number(f.target), p_share_mode: mode,
        p_open_to_all: f.openToAll, p_class_label: f.classLabel || null, p_board: f.board || null,
      });
      if (Array.isArray(id)) id = id[0];
      if (built && built.rows.length) {
        const counts = await sendLeads(id, built.rows, (done) => say('camp-w-msg', 'Adding leads… ' + S.count(done) + ' of ' + S.count(built.rows.length)));
        notes.push(addedText(counts));
      }
      if (seatIds.length) {
        await rpc('admin_set_campaign_members', { p_campaign: id, p_seats: seatIds });
        await rpc('admin_share_leads', { p_campaign: id, p_mode: mode });
      }
      if (start) await rpc('admin_update_campaign', { p_campaign: id, p_status: 'running' });
      busy = false;
      ctx.status((start ? 'Calling list started: ' : 'Saved, not started yet: ') + f.name.trim() + '. ' + notes.join(' '));
      ctx.navigate('calling', { id });
    } catch (err) {
      busy = false;
      $('camp-w-draft').disabled = false;
      $('camp-w-start').disabled = false;
      if (!id) { say('camp-w-msg', err.message, true); return; }
      ctx.status('The calling list was saved but not started, and this step failed: ' + err.message + ' Finish it here.', true);
      ctx.navigate('calling', { id });
    }
  }

  // ---------- routes ----------

  // The one-screen list is for fees from the ledger: someone who can see money, a database with the planner.
  let quickMissing = false;
  const quickOn = () => !!window.VectorAutopilot && !!ctx.canSeeMoney && !quickMissing;

  function showView(params) {
    const p = params || {};
    const view = p.new ? (p.full || !quickOn() ? 'new' : 'quick') : p.id ? 'detail' : 'list';
    $('camp-list').hidden = view !== 'list';
    $('camp-new').hidden = view !== 'list';
    $('camp-detail').hidden = view !== 'detail';
    $('camp-wizard').hidden = view !== 'new';
    $('camp-quick').hidden = view !== 'quick';
    if (view === 'list') { current = null; loadList(); }
    else if (view === 'detail') loadDetail(p.id);
    else if (view === 'quick') openQuick();
    else openWizard();
  }

  function openQuick() {
    const host = $('camp-q-body');
    host.textContent = '';
    window.VectorAutopilot.newList(host, ctx, {
      classes: CLASSES, boards: BOARDS,
      // "Change everything" (or a database without the planner): the full form.
      onAdvanced: (isMissing) => {
        if (isMissing) { quickMissing = true; $('camp-quick').hidden = true; $('camp-wizard').hidden = false; openWizard(); return; }
        ctx.navigate('calling', { new: '1', full: '1' });
      },
      onDone: (out) => {
        const r = (out && out.result) || {};
        ctx.status((r.text || 'Calling list started.') + ' Undo is on Today for 24 hours.');
        ctx.navigate('calling', r.campaign_id ? { id: r.campaign_id } : {});
      },
    });
  }

  // ---------- one list's people, with the filter bar ----------
  async function loadPeople(c, host) {
    const FB = window.VectorFilterBar;
    if (!FB) return;
    let data = null;
    try {
      const res = await ctx.client.from('leads').select('id, name, phone, status, next_call_at, promised_date, assigned_seat_id, extra')
        .eq('campaign_id', c.id).order('created_at').limit(3000);
      if (res.error) throw res.error;
      data = rows(res.data);
    } catch (err) { host.hidden = true; return; }
    if (!current || current.id !== c.id) return;
    const today = S.ymd(new Date());
    const seatName = new Map(rows(c.callers).map((m) => [m.seat_id, m.label]));
    const classOf = (l) => (l.extra && (l.extra.class || l.extra.Class)) || '';
    const STATUS_WORD = { new: 'To call', callback: 'Call back', promised: 'Promised', done: 'Done', wrong_number: 'Wrong number', do_not_call: 'Do not call' };
    const missed = (l) => l.status === 'promised' && l.promised_date && l.promised_date < today;
    const body = el('tbody', { id: 'camp-p-body' });
    const more = el('p', { className: 'muted small', id: 'camp-p-more' });
    host.querySelector('summary').textContent = 'People on this list (' + S.count(data.length) + ')';
    const barHost = el('div');
    host.appendChild(barHost);
    host.appendChild(el('div', { className: 'scroll' }, [el('table', { className: 'stack' }, [
      head([['Name'], ['Phone'], ['Class'], ['Status'], ['Caller']]), body])]));
    host.appendChild(more);
    FB.create(barHost, {
      id: 'camp-fbar', placeholder: 'Search name or phone',
      searchText: (l) => l.name + ' ' + l.phone + ' ' + ((l.extra && l.extra.student) || ''),
      chips: [
        { key: 'tocall', label: 'To call', test: (l) => l.status === 'new' },
        { key: 'callback', label: 'Call back', test: (l) => l.status === 'callback' },
        { key: 'missed', label: 'Promise missed', test: missed },
        { key: 'done', label: 'Done', test: (l) => ['done', 'wrong_number', 'do_not_call'].includes(l.status) },
      ],
      classOf,
      actions: [{ label: 'Download', run: (list) => S.download(['Name,Phone,Class,Status'].concat(list.map((l) =>
        ['"' + String(l.name).replace(/"/g, '""') + '"', l.phone, '"' + classOf(l) + '"', STATUS_WORD[l.status] || l.status].join(','))).join('\n'),
        'calling-list.csv') }],
      onChange: (list) => {
        body.textContent = '';
        list.slice(0, 200).forEach((l) => body.appendChild(el('tr', null, [
          cell(l.name, '', 'Name'), cell(l.phone, '', 'Phone'), cell(classOf(l), '', 'Class'),
          cell((missed(l) ? 'Promise missed' : STATUS_WORD[l.status] || l.status) + (l.promised_date && l.status === 'promised' ? ' · ' + S.formatDate(l.promised_date, { year: false }) : ''), missed(l) ? 'warn-text' : '', 'Status'),
          cell(seatName.get(l.assigned_seat_id) || (l.assigned_seat_id ? 'A caller' : 'Waiting'), '', 'Caller'),
        ])));
        more.textContent = list.length > 200 ? 'Showing 200 of ' + S.count(list.length) + '. Search or pick a filter to see others.' : '';
      },
    }).setRows(data);
  }

  S.registerTab({
    id: 'campaigns',
    label: 'Calling lists',
    part: true,   // shown inside Calling (js/admin/calling.js)
    mount(container, c) {
      ctx = c;
      box = container;
      build();
      $('camp-w-form').addEventListener('submit', (e) => { e.preventDefault(); saveWizard(true); });
      $('camp-w-draft').addEventListener('click', () => saveWizard(false));
    },
    show(params) { if (ctx) showView(params); },
    unmount() {
      ctx = null; box = null; campaigns = []; types = []; scripts = []; seats = []; features = null;
      current = null; pickers = {}; busy = false; seq++;
      detailMode = 'excel'; detailModeFor = null; oneNote = null; listKeys = null; listKeysFor = null; wizMode = 'excel'; quickMissing = false;
    },
  });
})();
