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

  function renderSeats() {
    const body = $('seat-body');
    body.textContent = '';
    live = [];
    const list = seats.filter((s) => s.status !== 'revoked' || S.isAdvanced());
    $('seat-empty').hidden = list.length > 0;
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
      if (s.seat_id !== ctx.seat.id && s.status !== 'revoked' && !(role === 'owner' && !iAmOwner())) {
        const b = button('Edit', () => openEdit(s.seat_id));
        b.setAttribute('aria-label', 'Edit ' + s.label);
        actions.appendChild(b);
      }
      body.appendChild(el('tr', { 'data-seat': s.seat_id }, [
        name,
        cell(roleLabel(s) + (role === 'manager' && s.can_see_money ? ' · sees money' : ''), '', 'Role'),
        cell(acc ? '—' : target ? S.count(calls) + ' of ' + S.count(target) : S.count(calls), 'num', 'Today\'s calls'),
        el('td', { 'data-label': 'Status' }, [status]),
        cell(caller ? targets || 'None' : '', 'adv', 'Targets'),
        el('td', { 'data-label': 'Notes today', className: 'adv team-notes', 'data-notes': s.seat_id }),
        actions,
      ]));
    });
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

  // ----- every change opens the in-page confirmation first -----

  function reviewInvite() {
    const mail = $('invite-email').value.trim();
    const label = $('invite-label').value.trim();
    const role = $('invite-role').value;
    const r = INVITE_ROLES.find((x) => x.value === role) || INVITE_ROLES[0];
    if (!label) { say('invite-msg', 'Type their name, such as Priya.', true); return; }
    if (!A.EMAIL.test(mail)) { say('invite-msg', 'Enter a valid email address.', true); return; }
    if (role === 'accounts' && !iAmOwner()) { say('invite-msg', 'Only an owner can add an Accounts person.', true); return; }
    say('invite-msg', '');
    ctx.confirm({
      title: 'Add ' + label,
      text: 'Add "' + label + '" as ' + r.label.toLowerCase() + ' with ' + mail + ': ' + inviteRoleHelp(role) + ' They join by signing in with that email. It uses one of your institute\'s places.',
      button: 'Add person',
      run: () => ctx.seatAction({ action: 'invite', institute: ctx.institute.id, email: mail, label: label, role: role }),
      done: (out) => '"' + label + '" added with ' + mail + '.' +
        (out.email_sent === false ? ' They already have an account: they sign in with that email.' : ''),
      after: () => { $('invite-form').reset(); $('team-invite').hidden = true; },
      reload: load,
    });
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
    ctx.confirm({
      title: 'Give "' + s.label + '"\'s calls to others',
      text: releaseText(s.label, count, camp ? camp.name : null),
      button: 'Give their calls to others',
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
    ctx.confirm({
      title: 'Daily target for "' + s.label + '"',
      text: 'New daily target: ' + list + ' a day. 0 means no target.',
      button: 'Save target',
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
      editing = null; wantSeat = null; extrasDone = false; live = [];
      loadSeq++; notesSeq++;
      busy = false;
    },
  });
})();
