'use strict';
/* Team tab of the admin app (web/admin.html; the file keeps its old name, callers.js). One table of people: name,
   role, today's calls (of the daily target), what they are doing now (the same words and call timers as Today:
   "On a call · 1:05", "Wrap-up", "Phone offline"), with "Not calling today" and a short coaching hint under the
   name. Advanced options add the targets and today's notes columns. "+ Add person" invites by email.
   Each row's Edit panel: role and "Can see money" (owners only), daily target, notes for today, "Give their calls
   to others" (admin_release_leads), "Sign out their phone" (reset pairing) and Remove; advanced: calling lists
   for chosen callers only, give their calls to one person (admin_move_leads), sign out their laptop, give the
   place to someone else (reassign). #team?seat=<id> opens it (old #callers links are sent here).
   Reads: admin_seat_list, admin_callers, admin_rep_progress (today), list_supervisor_notes
   (20261024100023) and the campaigns table (admins read their institute's). Writes: set_rep_target,
   add_supervisor_note, admin_set_seat_role, admin_set_money_access, admin_set_campaign_members and
   admin_move_leads (campaign functions, 20261024100020), and seat changes through ctx.seatAction (the
   seat-admin Edge Function). The database checks the admin (or owner) on every call. A function the database
   does not have yet shows "not available yet".
   Phase A.2: adding a caller is the only step (invite by email; open campaigns need no membership, so the
   campaign ticks in "Edit caller" are for campaigns restricted to chosen callers only); "Back to pool" per
   caller (admin_release_leads, with a confirmation that says how many leads go back); the role select has
   "Accounts" (admin_set_seat_role 'accounts': records fee payments, sees the Fees tab only).
   Office clicks (20261027110000): each caller's row has the daily call target as a small box ("12 of [40]":
   type and press Enter, saved at once, no question) and "Away today" (admin_away_today: their open calls go
   to the others) with Undo (admin_undo_away) in the row. Adding a person, saving a target and "Give their
   calls to others" run at once; the role, money access and Remove still ask first.
   Only counts, timings and the notes the supervisors wrote are shown. No money on this tab.
   The pure helpers below are also loaded by tests/web/admin-callers.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------

  const ROLE_LABELS = { owner: 'Owner', manager: 'Manager', caller: 'Caller', accounts: 'Accounts' };

  // The role as shown: 'Owner', 'Manager' or 'Caller'. Old seats without access_role: an admin was an owner.
  function roleOf(seat) {
    const s = seat || {};
    if (ROLE_LABELS[s.access_role]) return s.access_role;
    if (s.role === 'accounts') return 'accounts';
    return s.role === 'admin' ? 'owner' : 'caller';
  }

  // What each role does, in one line (the role select and the confirmation).
  const ROLE_HELP = {
    owner: 'can do everything, including money settings and roles',
    manager: 'runs calling lists and the team, and sees money only if you allow it',
    caller: 'only makes calls',
    accounts: 'records fee payments and sees the Fees tab only; cannot change the team or calling lists',
  };

  // The confirmation text of "Give their calls to others": with the count when it is known.
  function releaseText(label, count, campaignName) {
    const where = campaignName ? ' in "' + campaignName + '"' : ' in every calling list that is not closed';
    const n = Number(count);
    const what = count !== null && count !== undefined && Number.isFinite(n)
      ? (n === 1 ? '1 person' : n + ' people') + ' not called yet'
      : 'Everyone not called yet';
    return what + ' of "' + label + '"' + where + ' go to the other callers, so anyone can call them. Call backs and promises keep their date and history.';
  }
  // The roles the invite form offers, as the seat-admin Edge Function takes them ('admin' becomes a manager:
  // an institute's first admin is its owner, every later one a manager). Accounts: owners only.
  const INVITE_ROLES = [
    { value: 'rep', label: 'Caller', role: 'caller' },
    { value: 'admin', label: 'Manager', role: 'manager' },
    { value: 'accounts', label: 'Accounts', role: 'accounts' },
  ];
  function inviteRoleHelp(value) {
    const r = INVITE_ROLES.find((x) => x.value === value) || INVITE_ROLES[0];
    return (r.role === 'accounts' ? 'An accounts person' : 'A ' + r.label.toLowerCase()) + ' ' + ROLE_HELP[r.role] + '.';
  }
  const releasedText = (label, n) => (Number(n) === 1 ? '1 person' : (Number(n) || 0) + ' people') + ' of "' + label + '" given to the other callers.';
  const roleLabel = (seat) => ROLE_LABELS[roleOf(seat)];

  // The member list of one campaign after switching one seat on or off, from the admin_callers rows.
  // Only active seats can be members (admin_set_campaign_members refuses others).
  function membersAfter(rows, campaignId, seatId, on) {
    const ids = (rows || [])
      .filter((r) => r.status === 'active' && (r.campaigns || []).some((c) => c.id === campaignId))
      .map((r) => r.seat_id)
      .filter((id) => id !== seatId);
    if (on) ids.push(seatId);
    return ids;
  }

  // Which campaigns changed between two lists of campaign ids: { added: [...], removed: [...] }.
  function campaignChanges(before, after) {
    const b = new Set(before || []);
    const a = new Set(after || []);
    return { added: [...a].filter((id) => !b.has(id)), removed: [...b].filter((id) => !a.has(id)) };
  }

  // What the seat is doing now, in a few words ('' when nothing is known). See home_seat_status (20261025190000).
  function nowText(now) {
    const st = now && now.status;
    if (st === 'on_call') return now.call_state === 'unconfirmed' || now.confirmed === false ? 'On a call (unconfirmed)' : 'On a call';
    if (st === 'wrapup') return 'Wrap-up';
    if (st === 'ready') return 'Ready';
    if (st === 'phone_offline') return 'Phone offline';
    if (st === 'idle') return 'No calls for ' + Math.round(Number(now.idle_minutes) || 0) + ' min';
    if (st === 'not_started') return 'No calls today';
    return '';
  }

  // A short coaching hint shown under a caller's name on the Team tab, from today's numbers, or ''.
  // p: { calls, target, connected, talkMinutes, now } (now: the admin_callers now_status).
  //   no calls today (and not on a call)        'Not calling today'
  //   10+ calls, under a quarter picked up       'Few calls picked up (3 of 14). Try calling at another time.'
  //   10+ picked up, under a minute per call      'Short calls (about 40 s each). Check how the call opens.'
  function personHint(p) {
    const x = p || {};
    const calls = Number(x.calls) || 0;
    const st = x.now && x.now.status;
    if (!calls) return st === 'on_call' || st === 'wrapup' ? '' : 'Not calling today';
    const picked = Number(x.connected);
    if (calls >= 10 && Number.isFinite(picked) && x.connected !== null && x.connected !== undefined && picked / calls < 0.25) {
      return 'Few calls picked up (' + picked + ' of ' + calls + '). Try calling at another time.';
    }
    const talk = Number(x.talkMinutes);
    if (picked >= 10 && Number.isFinite(talk) && talk * 60 / picked < 60) {
      return 'Short calls (about ' + Math.round(talk * 60 / picked) + ' s each). Check how the call opens.';
    }
    return '';
  }

  const pure = { ROLE_LABELS, ROLE_HELP, INVITE_ROLES, inviteRoleHelp, roleOf, roleLabel, membersAfter, campaignChanges, nowText, releaseText, releasedText, personHint };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ---------- the tab (browser only) ----------

  const S = window.VectorAdminShared;
  const A = window.VectorAdminHelpers;
  const T = window.VectorAdminTeamHelpers;
  const HOME = () => window.VectorAdminHome || null;   // statusInfo and the call timers of js/admin/home.js
  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const TARGETS = T.TARGETS;

  let ctx = null;
  let seats = [];
  let extras = new Map();         // seat id -> admin_callers row (role, campaigns, now, calls today, target)
  let extraRows = [];
  let progress = new Map();       // seat id -> admin_rep_progress row of today (calls, connected, talk, targets)
  let campaigns = [];             // calling lists that are not closed: { id, name, status, open_to_all }
  let editing = null;             // seat id open in the Edit panel
  let wantSeat = null;            // seat id asked for in the address (#team?seat=…), opened once loaded
  let extrasDone = false;         // the first load has finished
  let loadSeq = 0;
  let notesSeq = 0;
  let busy = false;
  let loadedAt = 0;               // when the statuses were loaded, for the running call timers
  let clockTimer = null;
  let live = [];                  // [{ span, now }] status cells with a running timer

  const cell = (text, cls, label) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || '', 'data-label': label || null });
  const button = (text, onClick, cls, id) => el('button', { type: 'button', text, onClick, className: cls || '', id: id || null });
  const field = (text, input, cls) => el('label', { className: cls || null }, [text + ' ', input]);
  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const today = () => T.ymd(new Date());

  // Calls the RPC. A missing function becomes the plain "not available yet" message.
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
    box.appendChild(el('div', { className: 'tab-head row between' }, [
      el('div', null, [
        el('h1', { text: 'Team' }),
        el('p', { className: 'muted', text: 'Everyone who uses Vector at your institute, and today\'s calls.' }),
      ]),
      button('+ Add person', toggleInvite, 'primary', 'team-add'),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'team-invite', hidden: true, 'aria-labelledby': 'team-invite-title' }, [
      el('h2', { id: 'team-invite-title', text: 'Add a person' }),
      el('form', { id: 'invite-form', className: 'row wrap' }, [
        field('Name', el('input', { id: 'invite-label', type: 'text', maxlength: '60', placeholder: 'Priya', required: true })),
        field('Work email', el('input', { id: 'invite-email', type: 'email', autocomplete: 'off', required: true })),
        field('Role', el('select', { id: 'invite-role', 'aria-describedby': 'invite-role-help' }, INVITE_ROLES.map((r) =>
          el('option', { value: r.value, text: r.label })))),
        el('button', { type: 'submit', text: 'Add person' }),
      ]),
      el('p', { className: 'muted small', id: 'invite-role-help', text: inviteRoleHelp('rep') }),
      el('p', { className: 'muted small', id: 'invite-note', text: 'This is the only step. They sign in with this email. A caller can call every open calling list at once.' }),
      msg('invite-msg'),
    ]));

    box.appendChild(el('section', { className: 'panel', id: 'team-people', 'aria-label': 'Team members' }, [
      msg('team-msg'),
      el('div', { className: 'scroll' }, [el('table', { className: 'stack team-table', id: 'team-table' }, [
        el('thead', null, [el('tr', null, [
          el('th', { text: 'Name' }), el('th', { text: 'Role' }),
          el('th', { className: 'num', text: 'Today\'s calls' }), el('th', { text: 'Status' }),
          el('th', { className: 'adv', text: 'Targets' }), el('th', { className: 'adv', text: 'Notes today' }),
          el('th', { text: '' }),
        ])]),
        el('tbody', { id: 'seat-body' }),
      ])]),
      el('p', { id: 'seat-empty', className: 'muted', hidden: true, text: 'Nobody yet. Add a person to start.' }),
      el('p', { className: 'muted small', text: 'Today\'s calls per person, counted since midnight. Updated when you open this tab.' }),
    ]));

    // The Edit panel: filled by openEdit() for one person.
    box.appendChild(el('div', { className: 'panel', id: 'caller-edit', hidden: true, tabindex: '-1', 'aria-labelledby': 'edit-title' }, [
      el('div', { className: 'row between' }, [
        el('h2', { id: 'edit-title', text: 'Edit' }),
        button('Close', closeEdit, '', 'edit-close'),
      ]),
      el('div', { id: 'edit-owner', className: 'edit-block' }, [
        el('h3', { text: 'Role' }),
        el('div', { className: 'row' }, [
          field('Role', el('select', { id: 'edit-role' }, [
            el('option', { value: 'owner', text: 'Owner' }),
            el('option', { value: 'manager', text: 'Manager' }),
            el('option', { value: 'caller', text: 'Caller' }),
            el('option', { value: 'accounts', text: 'Accounts' }),
          ])),
          button('Save role', askRole, '', 'edit-role-save'),
        ]),
        el('p', { className: 'muted small', id: 'edit-role-help' }),
        el('label', { id: 'edit-money-field', className: 'switch' }, [
          el('input', { type: 'checkbox', id: 'edit-money', role: 'switch' }),
          el('span', { text: 'Can see money (fee amounts and totals)' }),
        ]),
        msg('edit-role-msg'),
      ]),
      // Centres (only when the institute has centres): where this person works; none ticked = every centre.
      el('fieldset', { id: 'edit-centres', className: 'edit-block', hidden: true }, [
        el('legend', { text: 'Works in' }),
        el('p', { className: 'muted small', text: 'They see only the students, calling lists and money of the ticked centres. None ticked: every centre.' }),
        el('div', { id: 'edit-centre-list', className: 'edit-checks' }),
        el('div', { className: 'row' }, [button('Save centres', saveCentres, '', 'edit-centre-save')]),
        msg('edit-centre-msg'),
      ]),
      el('div', { id: 'edit-target', className: 'edit-block' }, [
        el('h3', { text: 'Daily target' }),
        el('div', { className: 'row' }, TARGETS.map((f, i) => field(i === 0 ? 'Calls a day' : f.name.charAt(0).toUpperCase() + f.name.slice(1) + ' a day',
          el('input', { id: 'edit-target-' + f.metric, type: 'number', min: '0', max: String(T.TARGET_MAX), step: '1', inputmode: 'numeric', className: 'target-input' }),
          i === 0 ? null : 'adv')).concat([button('Save target', askTargets, '', 'edit-target-save')])),
        el('p', { className: 'muted small', text: 'Blank keeps the target as it is. 0 means no target.' }),
        msg('edit-target-msg'),
      ]),
      el('div', { id: 'edit-notes', className: 'edit-block' }, [
        el('h3', { text: 'Notes for today' }),
        el('ul', { id: 'notes-list', className: 'plain' }),
        el('p', { id: 'notes-empty', className: 'muted small', hidden: true, text: 'No notes today.' }),
        el('form', { id: 'note-form', className: 'stackform' }, [
          el('label', null, ['Add a note', el('textarea', { id: 'note-text', rows: '2' })]),
          el('p', { id: 'note-count', className: 'muted small', text: '0 of 1000 characters' }),
          el('div', { className: 'row' }, [el('button', { type: 'submit', id: 'note-add', text: 'Add note' })]),
        ]),
        msg('note-msg'),
      ]),
      el('div', { id: 'edit-release', className: 'edit-block' }, [
        el('h3', { text: 'Give their calls to others' }),
        el('p', { className: 'muted small', text: 'For someone who is away: the people they still have to call go to the other callers.' }),
        el('div', { className: 'row' }, [
          field('Calling list', el('select', { id: 'release-campaign' }), 'adv'),
          button('Give their calls to others', () => { const s = seatById(editing); if (s) askRelease(s, $('release-campaign').value || null); }, '', 'release-go'),
        ]),
        msg('edit-release-msg'),
      ]),
      el('fieldset', { id: 'edit-campaigns', className: 'edit-block adv' }, [
        el('legend', { text: 'Calling lists for chosen callers only' }),
        el('p', { className: 'muted small', text: 'Calling lists open to all callers need nothing here: every caller can work them.' }),
        el('div', { id: 'edit-campaign-list', className: 'edit-checks' }),
        el('p', { id: 'edit-campaign-none', className: 'muted small', hidden: true, text: 'No calling list is limited to chosen callers.' }),
        el('div', { className: 'row' }, [button('Save calling lists', saveCampaigns, '', 'edit-campaign-save')]),
        msg('edit-campaign-msg'),
      ]),
      el('div', { id: 'edit-move', className: 'edit-block adv' }, [
        el('h3', { text: 'Give their calls to one person' }),
        el('p', { className: 'muted small', text: 'Moves the people not finished yet (new, call back, promised). Finished ones stay.' }),
        el('div', { className: 'row' }, [
          field('To', el('select', { id: 'move-to' })),
          field('Calling list', el('select', { id: 'move-campaign' })),
          button('Move', askMove, '', 'move-go'),
        ]),
        msg('move-msg'),
      ]),
      el('div', { id: 'edit-seat', className: 'edit-block' }, [
        el('h3', { text: 'Phone and access' }),
        el('div', { className: 'actions' }, [
          button('Sign out their phone', () => { const s = seatById(editing); if (s) askReset(s, 'phone'); }, '', 'edit-reset-phone'),
          button('Sign out their laptop', () => { const s = seatById(editing); if (s) askReset(s, 'laptop'); }, 'adv', 'edit-reset-laptop'),
          button('Give this place to someone else', () => { const s = seatById(editing); if (s) askReassign(s); }, 'adv', 'edit-reassign'),
          button('Remove', () => { const s = seatById(editing); if (s) askRevoke(s); }, 'danger', 'edit-remove'),
        ]),
      ]),
    ]));
  }

  function wire() {
    $('invite-form').addEventListener('submit', (e) => { e.preventDefault(); reviewInvite(); });
    $('invite-role').addEventListener('change', () => { $('invite-role-help').textContent = inviteRoleHelp($('invite-role').value); });
    $('note-form').addEventListener('submit', addNote);
    $('note-text').addEventListener('input', updateNoteCount);
    $('edit-money').addEventListener('change', askMoney);
    $('edit-role').addEventListener('change', () => { $('edit-role-help').textContent = roleHelpText($('edit-role').value); });
    $('caller-edit').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEdit(); });
    clockTimer = setInterval(tickClocks, 1000);
  }

  const roleHelpText = (role) => (role === 'accounts' ? 'Accounts ' : ROLE_LABELS[role] + 's ') + ROLE_HELP[role] + '.';

  function toggleInvite() {
    const p = $('team-invite');
    p.hidden = !p.hidden;
    $('team-add').setAttribute('aria-expanded', String(!p.hidden));
    if (!p.hidden) $('invite-label').focus();
  }

  // ---------- the people ----------

  // Seats, then roles, statuses, today's calls and targets (admin_callers), today's progress (connected calls and
  // talk, for the hints) and the calling lists. A database without the newer functions keeps the seat list.
  async function load() {
    const seq = ++loadSeq;
    const inst = ctx.institute.id;
    say('team-msg', 'Loading...');
    try {
      seats = (await ctx.rpc('admin_seat_list', { p_institute: inst })) || [];
    } catch (err) {
      if (seq === loadSeq) say('team-msg', 'Could not load your team: ' + err.message, true);
      return;
    }
    if (seq !== loadSeq || !ctx) return;
    const [rows, prog, camps] = await Promise.all([
      ctx.rpc('admin_callers', { p_institute: inst }).then((r) => r || [], (err) => ({ error: err })),
      ctx.rpc('admin_rep_progress', { p_institute: inst, p_day: today(), p_tz: ctx.tz }).then((r) => r || [], () => []),
      loadCampaigns(inst),
    ]);
    if (seq !== loadSeq || !ctx) return;
    if (rows && rows.error) {
      if (ctx.isMissing(rows.error)) say('team-msg', 'Roles and today\'s calls are ' + T.NOT_YET + '.');
      else say('team-msg', 'Could not load roles and today\'s calls: ' + rows.error.message, true);
      extraRows = [];
    } else {
      say('team-msg', '');
      extraRows = rows;
    }
    extras = new Map(extraRows.map((r) => [r.seat_id, r]));
    progress = new Map((prog || []).map((r) => [r.seat_id, r]));
    campaigns = camps;
    extrasDone = true;
    loadedAt = Date.now();
    renderSeats();
    if (wantSeat && seatById(wantSeat)) { const id = wantSeat; wantSeat = null; openEdit(id); }
    else if (editing) {
      const open = seatById(editing);
      if (open && open.status !== 'revoked') fillEdit(); else closeEdit();
    }
  }

  async function loadCampaigns(inst) {
    try {
      let { data, error } = await ctx.client.from('campaigns').select('id, name, status, open_to_all')
        .eq('institute_id', inst).neq('status', 'closed').order('name');
      if (error) {   // a database before open campaigns (A.2): every campaign is for its members
        ({ data, error } = await ctx.client.from('campaigns').select('id, name, status')
          .eq('institute_id', inst).neq('status', 'closed').order('name'));
      }
      if (error) throw new Error(error.message);
      return data || [];
    } catch (err) { return []; }
  }

  const seatById = (id) => seats.find((s) => s.seat_id === id) || null;
  // The seat row with what admin_callers adds (access_role, can_see_money, campaigns, now_status, calls today).
  const fullSeat = (s) => Object.assign({}, s, extras.get(s.seat_id) || {});
  // The signed-in admin is an owner (seats from before roles existed were owners).
  const iAmOwner = () => roleOf(ctx.seat) === 'owner';

  // What the person is doing now: the same words as Today ("On a call · 1:05", "Wrap-up · 0:12", "Phone offline"…).
  function statusOf(s, ticked) {
    const H = HOME();
    if (H && typeof H.statusInfo === 'function') return H.statusInfo(s.now_status, ticked);
    return { text: nowText(s.now_status) || 'No calls today', level: 'muted' };
  }

  // The filter bar (js/admin/filter-bar.js): search, Callers / Calling now / Not calling today, Download.
  let bar = null;
  const callsOf = (s) => {
    const p = progress.get(s.seat_id) || {};
    return s.calls_today !== undefined && s.calls_today !== null ? Number(s.calls_today) : Number(p.calls) || 0;
  };
  const calling = (s) => !!s.now_status && ['on_call', 'wrapup'].includes(s.now_status.status);
  function teamBar() {
    const FB = window.VectorFilterBar;
    if (!FB || bar) return bar;
    const host = el('div', { id: 'team-fbar-host' });
    $('team-people').insertBefore(host, $('team-people').querySelector('.scroll'));
    bar = FB.create(host, {
      id: 'team-fbar', placeholder: 'Search people',
      searchText: (s) => s.label + ' ' + roleLabel(s),
      chips: [
        { key: 'callers', label: 'Callers', test: (s) => roleOf(s) === 'caller' },
        { key: 'now', label: 'Calling now', test: (s) => roleOf(s) === 'caller' && calling(s) },
        { key: 'idle', label: 'Not calling today', test: (s) => roleOf(s) === 'caller' && s.status === 'active' && callsOf(s) === 0 },
      ],
      actions: [{ label: 'Download', run: (rows) => S.download(['Name,Role,Calls today'].concat(rows.map((s) =>
        ['"' + String(s.label).replace(/"/g, '""') + '"', roleLabel(s), callsOf(s)].join(','))).join('\n'), 'team.csv') }],
      onChange: (rows) => drawSeats(rows),
    });
    return bar;
  }

  function renderSeats() {
    const list = seats.filter((s) => s.status !== 'revoked' || S.isAdvanced()).map(fullSeat);
    $('seat-empty').hidden = list.length > 0;
    if (teamBar()) bar.setRows(list); else drawSeats(list);
  }

  function drawSeats(list) {
    const body = $('seat-body');
    body.textContent = '';
    live = [];
    list.forEach((row) => {
      const s = fullSeat(row);
      const role = roleOf(s);
      const acc = role === 'accounts';
      const caller = role === 'caller';
      const p = progress.get(s.seat_id) || {};
      const calls = s.calls_today !== undefined && s.calls_today !== null ? Number(s.calls_today) : Number(p.calls) || 0;
      const target = s.calls_target || p.calls_target || null;
      const hint = s.status === 'active' && caller ? personHint({ calls, target, connected: p.connected_calls, talkMinutes: p.talk_minutes, now: s.now_status }) : '';
      const name = el('td', { 'data-label': 'Name', className: 'team-name' }, [
        el('strong', { text: s.label }),
        s.seat_id === ctx.seat.id ? el('span', { className: 'muted small', text: ' (you)' }) : null,
        s.status === 'invited' ? el('div', { className: 'muted small', text: 'Invited, not signed in yet' }) : null,
        s.status === 'revoked' ? el('div', { className: 'muted small', text: 'Removed' }) : null,
        hint ? el('div', { className: 'team-hint', text: hint }) : null,
      ]);
      let status;
      if (acc) status = el('span', { className: 'home-status muted', text: 'No phone needed' });
      else if (s.status !== 'active') status = el('span', { className: 'home-status muted', text: s.status === 'invited' ? 'Not signed in yet' : 'Removed' });
      else {
        const st = statusOf(s);
        status = el('span', { className: 'home-status ' + st.level, text: st.text });
        const H = HOME();
        if (H && typeof H.ticks === 'function' && H.ticks(s.now_status)) live.push({ span: status, now: s.now_status });
      }
      const targets = TARGETS.map((f) => (Number(p[f.field]) > 0 ? S.count(p[f.field]) + ' ' + f.name : '')).filter(Boolean).join(', ');
      const actions = el('td', { 'data-label': '', className: 'row-actions' });
      if (caller && s.status === 'active') actions.appendChild(awayControl(s));
      if (s.seat_id !== ctx.seat.id && s.status !== 'revoked' && !(role === 'owner' && !iAmOwner())) {
        const b = button('Edit', () => openEdit(s.seat_id));
        b.setAttribute('aria-label', 'Edit ' + s.label);
        actions.appendChild(b);
      }
      const callsCell = caller && s.status === 'active'
        ? el('td', { 'data-label': 'Today\'s calls', className: 'num team-calls' }, [S.count(calls) + ' of ', targetBox(s, target)])
        : cell(acc ? '—' : target ? S.count(calls) + ' of ' + S.count(target) : S.count(calls), 'num', 'Today\'s calls');
      body.appendChild(el('tr', { 'data-seat': s.seat_id }, [
        name,
        cell(roleLabel(s) + (role === 'manager' && s.can_see_money ? ' · sees money' : ''), '', 'Role'),
        callsCell,
        el('td', { 'data-label': 'Status' }, [status]),
        cell(caller ? targets || 'None' : '', 'adv', 'Targets'),
        el('td', { 'data-label': 'Notes today', className: 'adv team-notes', 'data-notes': s.seat_id }),
        actions,
      ]));
    });
  }

  // The daily call target in the row: Enter saves it (set_rep_target, metric calls), Escape puts it back.
  function targetBox(s, target) {
    const box = el('input', { type: 'number', min: '0', max: String(T.TARGET_MAX), step: '1', inputmode: 'numeric', className: 'team-target',
      id: 'target-' + s.seat_id, value: target ? String(target) : '', placeholder: '–', title: 'Daily target: type and press Enter', 'aria-label': 'Daily call target for ' + s.label + ' (Enter saves)' });
    box.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { box.value = target ? String(target) : ''; return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const r = T.parseTarget(box.value === '' ? '0' : box.value);
      if (!r.ok) { ctx.status(r.error, true); return; }
      box.disabled = true;
      try {
        await rpc('set_rep_target', { p_seat: s.seat_id, p_metric: 'calls', p_daily_target: r.value });
        ctx.status(r.value ? 'Target saved for "' + s.label + '": ' + r.value + ' calls a day.' : 'No daily target for "' + s.label + '" now.');
        box.classList.add('saved');
        load();
      } catch (err) {
        box.disabled = false;
        report('status', err, 'Target not saved: ');
      }
    });
    return box;
  }

  // "Away today": their open calls go to the other callers at once; Undo gives back those nobody took yet.
  const away = new Map();   // seat id -> { ids, n } given away on this page
  function awayControl(s) {
    const wrap = el('span', { className: 'team-away', 'data-away': s.seat_id });
    const done = away.get(s.seat_id);
    if (done) {
      const undo = button('Undo', () => undoAway(s, undo), 'linkish', 'away-undo-' + s.seat_id);
      wrap.appendChild(el('span', { className: 'muted small', text: 'Away · ' + (done.n === 1 ? '1 call' : done.n + ' calls') + ' given to others ' }));
      wrap.appendChild(undo);
      return wrap;
    }
    const b = button('Away today', () => goAway(s, b), '', 'away-' + s.seat_id);
    b.setAttribute('aria-label', s.label + ' is away today: give their calls to others');
    wrap.appendChild(b);
    return wrap;
  }
  async function goAway(s, btn) {
    btn.disabled = true;
    try {
      const out = (await ctx.rpc('admin_away_today', { p_seat: s.seat_id })) || {};
      away.set(s.seat_id, { ids: out.lead_ids || [], n: Number(out.released) || 0 });
      ctx.status(releasedText(s.label, out.released));
      renderSeats();
    } catch (err) {
      btn.disabled = false;
      report('team-msg', err, 'Could not give their calls: ');
    }
  }
  async function undoAway(s, btn) {
    const done = away.get(s.seat_id);
    if (!done) return;
    btn.disabled = true;
    try {
      const n = Number(await ctx.rpc('admin_undo_away', { p_seat: s.seat_id, p_leads: done.ids })) || 0;
      away.delete(s.seat_id);
      ctx.status(n === done.n ? 'Undone: ' + s.label + ' has their calls back.' : 'Undone: ' + n + ' of ' + done.n + ' calls back with ' + s.label + ' (the others were already taken).');
      renderSeats();
    } catch (err) {
      btn.disabled = false;
      report('team-msg', err, 'Could not undo: ');
    }
  }

  // Every second: the call and wrap-up timers count on from the seconds the server sent.
  function tickClocks() {
    if (!live.length || !ctx) return;
    const H = HOME();
    if (!H) return;
    const extra = (Date.now() - loadedAt) / 1000;
    live.forEach((x) => { x.span.textContent = H.statusInfo(x.now, extra).text; });
  }

  // ----- the Edit panel -----

  function openEdit(id) {
    const s = seatById(id);
    if (!s || s.status === 'revoked' || s.seat_id === ctx.seat.id) return;
    editing = id;
    ['edit-campaign-msg', 'edit-role-msg', 'move-msg', 'edit-target-msg', 'note-msg'].forEach((m) => say(m, ''));
    fillEdit();
    $('caller-edit').hidden = false;
    $('caller-edit').focus();
    loadNotes();
  }

  function closeEdit() {
    editing = null;
    $('caller-edit').hidden = true;
  }

  // Fills the panel for the person being edited. Owner-only parts are hidden for managers.
  function fillEdit() {
    const s = fullSeat(seatById(editing));
    const role = roleOf(s);
    const owner = iAmOwner();
    const known = extras.has(s.seat_id);
    const caller = role === 'caller';
    const accounts = role === 'accounts';
    $('edit-title').textContent = 'Edit: ' + s.label;

    // Role and money: owners only.
    $('edit-owner').hidden = !owner || !known;
    $('edit-role').value = role;
    $('edit-role-help').textContent = roleHelpText(role);
    $('edit-money-field').hidden = role !== 'manager';
    $('edit-money').checked = !!s.can_see_money;

    fillCentres(s, role, owner);

    // Target and notes: callers.
    $('edit-target').hidden = !caller;
    const p = progress.get(s.seat_id) || {};
    TARGETS.forEach((f) => {
      const inp = $('edit-target-' + f.metric);
      inp.value = '';
      const cur = Number(p[f.field] || (f.metric === 'calls' ? s.calls_target : 0));
      inp.placeholder = cur > 0 ? 'now ' + cur : 'none';
    });
    $('edit-notes').hidden = accounts;

    // Calling lists for chosen callers only: one checkbox per such list. Only active seats can be members.
    const list = $('edit-campaign-list');
    list.textContent = '';
    const mine = new Set((s.campaigns || []).map((c) => c.id));
    const restricted = campaigns.filter((c) => c.open_to_all !== true);
    restricted.forEach((c) => {
      list.appendChild(el('label', { className: 'check' }, [
        el('input', { type: 'checkbox', value: c.id, checked: mine.has(c.id), disabled: s.status !== 'active' || !known }),
        el('span', { text: c.name + (c.status === 'draft' ? ' (not started)' : c.status === 'paused' ? ' (paused)' : '') }),
      ]));
    });
    $('edit-campaign-none').hidden = restricted.length > 0;
    $('edit-campaign-save').hidden = !restricted.length || s.status !== 'active' || !known;
    $('edit-campaigns').hidden = accounts;
    $('edit-move').hidden = accounts;

    // Give their calls to one person: another active caller, or the shared list.
    const to = $('move-to');
    to.textContent = '';
    seats.filter((x) => x.status === 'active' && x.seat_id !== s.seat_id && roleOf(fullSeat(x)) !== 'accounts')
      .forEach((x) => to.appendChild(el('option', { value: x.seat_id, text: x.label })));
    to.appendChild(el('option', { value: '', text: 'Nobody: the shared list' }));
    const camp = $('move-campaign');
    camp.textContent = '';
    camp.appendChild(el('option', { value: '', text: 'All calling lists' }));
    (s.campaigns || []).forEach((c) => camp.appendChild(el('option', { value: c.id, text: c.name })));
    const rel = $('release-campaign');
    rel.textContent = '';
    rel.appendChild(el('option', { value: '', text: 'All calling lists' }));
    campaigns.forEach((c) => rel.appendChild(el('option', { value: c.id, text: c.name })));
    $('edit-release').hidden = s.status !== 'active' || accounts;

    // Phone and access. Removing an owner is for owners only.
    const kinds = s.device_kinds || [];
    $('edit-reset-phone').hidden = !(s.status === 'active' && kinds.includes('phone'));
    $('edit-reset-laptop').hidden = !(s.status === 'active' && kinds.includes('laptop'));
    $('edit-remove').hidden = role === 'owner' && !owner;
    $('edit-reassign').hidden = role === 'owner' && !owner;
  }

  // Works in: the institute's centres, ticked from the seat's centre_ids (read from the seats table).
  let centreSeq = 0;
  async function fillCentres(s, role, owner) {
    const box = $('edit-centres');
    const on = !!ctx.centres && owner && role !== 'owner' && s.status === 'active';
    box.hidden = !on;
    say('edit-centre-msg', '');
    if (!on) return;
    const list = $('edit-centre-list');
    list.textContent = '';
    const n = ++centreSeq;
    let have = [];
    try {
      const { data, error } = await ctx.client.from('seats').select('id, centre_ids').eq('id', s.seat_id);
      if (error) throw new Error(error.message);
      have = ((data && data[0] && data[0].centre_ids) || []).map(String);
    } catch (err) { say('edit-centre-msg', 'Could not read their centres: ' + err.message, true); }
    if (n !== centreSeq || !ctx) return;
    ctx.centres.all.filter((c) => c.active || have.includes(String(c.id))).forEach((c) => {
      list.appendChild(el('label', { className: 'check' }, [
        el('input', { type: 'checkbox', value: String(c.id), checked: have.includes(String(c.id)) }),
        el('span', { text: c.name }),
      ]));
    });
  }

  async function saveCentres() {
    const s = fullSeat(seatById(editing));
    if (!s) return;
    const ids = Array.from(document.querySelectorAll('#edit-centre-list input:checked')).map((x) => x.value);
    const btn = $('edit-centre-save');
    btn.disabled = true;
    try {
      await rpc('admin_set_seat_centres', { p_seat: s.seat_id, p_centres: ids });
      const names = ctx.centres.all.filter((c) => ids.includes(String(c.id))).map((c) => c.name);
      say('edit-centre-msg', '"' + s.label + '" now works in ' + (names.length ? names.join(', ') : 'every centre') + '. It starts at their next sign-in.');
    } catch (err) {
      say('edit-centre-msg', 'Not saved: ' + err.message, true);
    } finally { btn.disabled = false; }
  }

  // ----- every change opens the in-page confirmation first -----

  function reviewInvite() {
    const mail = $('invite-email').value.trim();
    const label = $('invite-label').value.trim();
    const role = $('invite-role').value;
    const r = INVITE_ROLES.find((x) => x.value === role) || INVITE_ROLES[0];
    if (!label) { say('invite-msg', 'Type their name, such as Priya.', true); return; }
    if (!A.EMAIL.test(mail)) { say('invite-msg', 'Enter a valid email address.', true); return; }
    if (role === 'accounts' && !iAmOwner()) { say('invite-msg', 'Only an owner can add an Accounts person.', true); return; }
    say('invite-msg', 'Adding…');
    runNow('invite-msg', {
      run: () => ctx.seatAction({ action: 'invite', institute: ctx.institute.id, email: mail, label: label, role: role }),
      done: (out) => '"' + label + '" added as ' + r.label.toLowerCase() + ' with ' + mail + '.' +
        (out.email_sent === false ? ' They already have an account: they sign in with that email.' : ''),
      after: () => { $('invite-form').reset(); $('team-invite').hidden = true; say('invite-msg', ''); },
      reload: load,
    });
  }

  // A change that needs no question: runs it, says what happened in the status line, then reloads. A failure is
  // said in msgId.
  async function runNow(msgId, job) {
    try {
      const out = (await job.run()) || {};
      if (job.after) job.after();
      ctx.status(typeof job.done === 'function' ? job.done(out) : job.done);
      if (job.reload) await job.reload();
    } catch (err) {
      report(msgId, err, 'Not done: ');
    }
  }

  function askReassign(s) {
    if (s.seat_id === ctx.seat.id) return;   // the server refuses this too
    ctx.confirm({
      title: 'Give "' + s.label + '"\'s place to someone else',
      text: 'Their phone and laptop are signed out and their access ends. Enter the new person\'s email. They join by signing in with it.',
      email: { label: 'New person\'s email', value: '' },
      button: 'Give place',
      danger: true,
      run: (mail) => ctx.seatAction({ action: 'reassign', seat: s.seat_id, email: mail }),
      done: (out) => '"' + s.label + '"\'s place is given to someone else.' + (out.note ? ' ' + out.note : ''),
      reload: load,
    });
  }

  function askRevoke(s) {
    if (s.seat_id === ctx.seat.id) return;   // the server refuses this too
    ctx.confirm({
      title: 'Remove "' + s.label + '"',
      text: 'Their phone and laptop are signed out and they lose access. Their past calls stay in the reports.',
      button: 'Remove',
      danger: true,
      run: () => ctx.seatAction({ action: 'revoke', seat: s.seat_id }),
      done: '"' + s.label + '" removed.',
      after: closeEdit,
      reload: load,
    });
  }

  function askReset(s, kind) {
    ctx.confirm({
      title: 'Sign out ' + s.label + '\'s ' + kind,
      text: 'The ' + kind + ' is signed out of Vector. They can then connect a new ' + kind + ' from their own login.',
      button: 'Sign out ' + kind,
      danger: true,
      run: () => ctx.seatAction({ action: 'reset_pairing', seat: s.seat_id, kind: kind }),
      done: s.label + '\'s ' + kind + ' is signed out.',
      reload: load,
    });
  }

  // Saves the calling-list ticks: each changed list gets its new member list (admin_set_campaign_members).
  async function saveCampaigns() {
    const s = fullSeat(seatById(editing));
    const ticked = Array.from($('edit-campaign-list').querySelectorAll('input[type="checkbox"]'))
      .filter((b) => b.checked).map((b) => b.value);
    const change = campaignChanges((s.campaigns || []).map((c) => c.id), ticked);
    const all = change.added.map((id) => [id, true]).concat(change.removed.map((id) => [id, false]));
    if (!all.length) { say('edit-campaign-msg', 'Nothing changed.'); return; }
    const btn = $('edit-campaign-save');
    btn.disabled = true;
    let done = 0;
    try {
      for (const [id, on] of all) {
        await rpc('admin_set_campaign_members', { p_campaign: id, p_seats: membersAfter(extraRows, id, s.seat_id, on) });
        done++;
      }
      say('edit-campaign-msg', 'Calling lists saved for ' + s.label + '.' +
        (change.removed.length ? ' People not called yet from a list they left go to the other callers.' : ''));
    } catch (err) {
      report('edit-campaign-msg', err, done ? 'Saved ' + done + ' of ' + all.length + '. ' : 'Could not save: ');
    } finally {
      btn.disabled = false;
      load();
    }
  }

  function askRole() {
    const s = fullSeat(seatById(editing));
    const role = $('edit-role').value;
    if (role === roleOf(s)) { say('edit-role-msg', s.label + ' is already ' + ROLE_LABELS[role].toLowerCase() + '.'); return; }
    say('edit-role-msg', '');
    ctx.confirm({
      title: 'Make "' + s.label + '" ' + ROLE_LABELS[role].toLowerCase(),
      text: roleHelpText(role) + ' The change starts at their next sign-in or page load.',
      button: 'Change role',
      run: () => rpc('admin_set_seat_role', { p_seat: s.seat_id, p_role: role }),
      done: '"' + s.label + '" is now ' + ROLE_LABELS[role].toLowerCase() + '.',
      reload: load,
    });
  }

  function askMoney() {
    const s = fullSeat(seatById(editing));
    const allow = $('edit-money').checked;
    $('edit-money').checked = !allow;   // stays as it was until confirmed
    ctx.confirm({
      title: (allow ? 'Let "' : 'Stop "') + s.label + (allow ? '" see money' : '" seeing money'),
      text: allow ? 'They will see fee amounts, totals and money in downloads. Every money download is logged.'
        : 'They will see counts only, no ₹ amounts.',
      button: allow ? 'Allow' : 'Stop',
      danger: !allow,
      run: () => rpc('admin_set_money_access', { p_seat: s.seat_id, p_allowed: allow }),
      done: allow ? '"' + s.label + '" can now see money.' : '"' + s.label + '" no longer sees money.',
      reload: load,
    });
  }

  // "Give their calls to others": counts the person's open leads first (admins read their institute's leads),
  // then asks.
  async function askRelease(s, campaignId) {
    const camp = campaignId ? campaigns.find((c) => c.id === campaignId) : null;
    let count = null;
    try {
      // The same leads admin_release_leads sends back: open leads in lists that are not closed (the list of
      // calling lists holds exactly those). Without that list the count is left out.
      const open = campaignId ? [campaignId] : (extrasDone ? campaigns.map((c) => c.id) : null);
      if (open && !open.length) count = 0;
      else if (open) {
        const q = ctx.client.from('leads').select('id', { count: 'exact', head: true })
          .eq('assigned_seat_id', s.seat_id).in('status', ['new', 'callback', 'promised']).eq('do_not_call', false)
          .in('campaign_id', open);
        const { count: n, error } = await q;
        if (!error && typeof n === 'number') count = n;
      }
    } catch (err) { count = null; }
    if (!ctx) return;
    if (count === 0) {
      ctx.status('"' + s.label + '" has nobody waiting to be called' + (camp ? ' in "' + camp.name + '"' : '') + '. Nothing to give.');
      return;
    }
    runNow('edit-release-msg', {
      run: async () => {
        try {
          return { released: await ctx.rpc('admin_release_leads', { p_seat: s.seat_id, p_campaign: campaignId }) };
        } catch (err) {
          if (ctx.isMissing(err)) throw new Error('Giving calls to others is ' + T.NOT_YET + '.');
          throw err;
        }
      },
      done: (out) => releasedText(s.label, Array.isArray(out.released) ? out.released[0] : out.released),
      reload: load,
    });
  }

  function askMove() {
    const s = fullSeat(seatById(editing));
    const toId = $('move-to').value || null;
    const campId = $('move-campaign').value || null;
    const to = toId ? seatById(toId) : null;
    const camp = campId ? campaigns.find((c) => c.id === campId) : null;
    const where = camp ? ' in "' + camp.name + '"' : ' in every open calling list';
    ctx.confirm({
      title: 'Move "' + s.label + '"\'s calls',
      text: 'People not finished yet' + where + ' go to ' + (to ? '"' + to.label + '"' : 'the shared list') + '.' +
        (to ? ' ' + to.label + ' joins those calling lists if needed.' : ''),
      button: 'Move',
      run: async () => {
        try {
          return { moved: await ctx.rpc('admin_move_leads', { p_from_seat: s.seat_id, p_to_seat: toId, p_campaign: campId }) };
        } catch (err) {
          if (ctx.isMissing(err)) throw new Error('Moving calls is ' + T.NOT_YET + '.');
          throw err;
        }
      },
      done: (out) => S.count(Number(out.moved) || 0) + ' ' + (Number(out.moved) === 1 ? 'person' : 'people') + ' moved from "' + s.label + '".',
      reload: load,
    });
  }

  function askTargets() {
    const s = fullSeat(seatById(editing));
    const changes = [];
    for (const f of TARGETS) {
      const r = T.parseTarget($('edit-target-' + f.metric).value);
      if (!r.ok) { say('edit-target-msg', r.error + ' (' + f.name + ')', true); return; }
      if (r.value !== null) changes.push({ metric: f.metric, name: f.name, value: r.value });
    }
    if (!changes.length) { say('edit-target-msg', 'Type a number first.', true); return; }
    say('edit-target-msg', '');
    const list = changes.map((c) => c.value + ' ' + c.name).join(', ');
    runNow('edit-target-msg', {
      run: async () => {
        let saved = 0;
        for (const c of changes) {
          try {
            await rpc('set_rep_target', { p_seat: s.seat_id, p_metric: c.metric, p_daily_target: c.value });
          } catch (err) {
            if (saved) throw new Error('Saved ' + saved + ' of ' + changes.length + ' targets. ' + err.message);
            throw err;
          }
          saved++;
        }
      },
      done: 'Target saved for "' + s.label + '": ' + list + ' a day.',
      reload: load,
    });
  }

  // ----- notes (today, for the person being edited) -----

  async function loadNotes() {
    const seat = editing;
    if (!seat) return;
    const seq = ++notesSeq;
    try {
      const rows = (await rpc('list_supervisor_notes', { p_institute: ctx.institute.id, p_seat: seat, p_from: today(), p_to: today() })) || [];
      if (seq !== notesSeq) return;
      renderNotes(rows);
    } catch (err) {
      if (seq !== notesSeq) return;
      renderNotes([]);
      report('note-msg', err, 'Could not load the notes: ');
    }
  }

  function renderNotes(rows) {
    const list = $('notes-list');
    list.textContent = '';
    $('notes-empty').hidden = rows.length > 0;
    rows.forEach((n) => {
      list.appendChild(el('li', { className: 'note' }, [
        el('div', { text: n.created_at ? S.formatTime(n.created_at) : '', className: 'muted small' }),
        el('div', { text: String(n.note === null || n.note === undefined ? '' : n.note), className: 'note-text' }),
      ]));
    });
    const cellNotes = document.querySelector('#seat-body td[data-notes="' + editing + '"]');
    if (cellNotes) cellNotes.textContent = rows.length ? String(rows[rows.length - 1].note || '') : '';
  }

  function updateNoteCount() {
    const r = T.noteCheck($('note-text').value);
    const typed = Array.from($('note-text').value.trim()).length;
    $('note-count').textContent = typed + ' of ' + T.NOTE_MAX + ' characters';
    $('note-count').classList.toggle('error', typed > T.NOTE_MAX);
    $('note-add').disabled = busy || !r.ok;
  }

  async function addNote(e) {
    e.preventDefault();
    const seat = editing;
    if (!seat) return;
    const r = T.noteCheck($('note-text').value);
    if (!r.ok) { say('note-msg', r.error, true); return; }
    busy = true;
    updateNoteCount();
    try {
      await rpc('add_supervisor_note', { p_seat: seat, p_day: today(), p_note: r.text });
      $('note-text').value = '';
      say('note-msg', 'Note added.');
      await loadNotes();
    } catch (err) {
      report('note-msg', err, 'Could not add the note: ');
    } finally {
      busy = false;
      updateNoteCount();
    }
  }

  S.registerTab({
    id: 'team',
    label: 'Team',
    mount(box, c) {
      ctx = c;
      build(box);
      wire();
      updateNoteCount();
      load();
      document.addEventListener('vector:advanced', renderSeats);
    },
    // #team?seat=<id> (from Today) opens the Edit panel for that person once the team is loaded. Opening the tab
    // again loads today's numbers again.
    show(params) {
      if (!ctx) return;
      if (params && params.seat) {
        if (extrasDone && seatById(params.seat)) openEdit(params.seat);
        else wantSeat = params.seat;
      }
      if (extrasDone && Date.now() - loadedAt > 30000) load();
    },
    unmount() {
      if (clockTimer) clearInterval(clockTimer);
      clockTimer = null;
      document.removeEventListener('vector:advanced', renderSeats);
      ctx = null;
      seats = []; extras = new Map(); extraRows = []; progress = new Map(); campaigns = [];
      editing = null; wantSeat = null; extrasDone = false; live = []; bar = null;
      loadSeq++; notesSeq++;
      busy = false;
    },
  });
})();
