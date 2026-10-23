'use strict';
/* Callers tab of the admin app (web/admin.html): team activity for a date range, rep progress with a
   not-calling list, daily targets, supervisor notes, and the seats (invite, reassign, revoke, reset pairing).
   Moved here from the old admin page (js/admin.js and js/admin-team.js keep the pure helpers).
   Sprint 10 adds, per seat: the role (Owner / Manager / Caller), the campaigns the seat is on (more than one is
   fine), what the caller is doing now, and an "Edit caller" panel: campaigns, role and "Can see money" (owners
   only), move leads to another caller, reset phone pairing and remove from seat. #callers?seat=<id> opens it.
   Reads: admin_team_activity, admin_seat_list, admin_rep_progress, list_supervisor_notes, admin_callers
   (20261024100023) and the campaigns table (admins read their institute's). Writes: set_rep_target,
   add_supervisor_note, admin_set_seat_role, admin_set_money_access, admin_set_campaign_members and
   admin_move_leads (campaign functions, 20261024100020), and seat changes through ctx.seatAction (the
   seat-admin Edge Function). The database checks the admin (or owner) on every call. A function the database
   does not have yet shows "not available yet".
   Only counts, timings and the notes the supervisors wrote are shown. No money on this tab.
   The pure helpers below are also loaded by tests/web/admin-callers.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------

  const ROLE_LABELS = { owner: 'Owner', manager: 'Manager', caller: 'Caller' };

  // The role as shown: 'Owner', 'Manager' or 'Caller'. Old seats without access_role: an admin was an owner.
  function roleOf(seat) {
    const s = seat || {};
    if (ROLE_LABELS[s.access_role]) return s.access_role;
    return s.role === 'admin' ? 'owner' : 'caller';
  }
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

  // What the seat is doing now, in a few words ('' when nothing is known).
  function nowText(now) {
    const st = now && now.status;
    if (st === 'on_call') return 'On a call';
    if (st === 'ready') return 'Ready';
    if (st === 'phone_offline') return 'Phone offline';
    if (st === 'idle') return 'No calls for ' + Math.round(Number(now.idle_minutes) || 0) + ' min';
    if (st === 'not_started') return 'No calls today';
    return '';
  }

  const pure = { ROLE_LABELS, roleOf, roleLabel, membersAfter, campaignChanges, nowText };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ---------- the tab (browser only) ----------

  const S = window.VectorAdminShared;
  const A = window.VectorAdminHelpers;
  const T = window.VectorAdminTeamHelpers;
  const el = S.el;
  const say = S.say;
  const $ = (id) => document.getElementById(id);
  const TARGETS = T.TARGETS;

  let ctx = null;
  let team = [];
  let seats = [];
  let progressRows = [];
  let loadSeq = 0;
  let progressSeq = 0;
  let notesSeq = 0;
  let repsSig = null;
  let targetInputs = new Map();   // seat id -> { calls, connected_calls, talk_minutes } inputs
  let busy = false;
  let extras = new Map();         // seat id -> admin_callers row (role, campaigns, now), when the database has it
  let extraRows = [];
  let campaigns = [];             // campaigns that are not closed: { id, name, status }
  let editing = null;             // seat id open in "Edit caller"
  let wantSeat = null;            // seat id asked for in the address (#callers?seat=…), opened once loaded
  let extrasDone = false;         // the first loadExtras() has finished

  const cell = (text, cls, label) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || '', 'data-label': label || null });
  const button = (text, onClick, cls) => el('button', { type: 'button', text, onClick, className: cls || '' });
  const field = (text, input) => el('label', null, [text + ' ', input]);
  const msg = (id) => el('p', { id, className: 'msg', role: 'status' });
  const head = (cols) => el('thead', null, [el('tr', null, cols.map((c) => el('th', { text: c[0], className: c[1] || '' })))]);

  // Calls the RPC. A missing function becomes the plain "not available yet" message.
  async function rpc(name, args) {
    try { return await ctx.rpc(name, args); } catch (err) {
      if (ctx.isMissing(err)) throw new Error(T.NOT_YET);
      throw err;
    }
  }
  // Shows a load or save failure in a panel: the plain message when the function is missing, otherwise the error text.
  function report(id, err, prefix) {
    if (err && err.message === T.NOT_YET) say(id, T.NOT_YET, false);
    else say(id, (prefix || '') + (err && err.message ? err.message : 'Try again.'), true);
  }
  const reps = () => T.repSeats(seats);

  // ---------- page ----------

  function build(box) {
    box.appendChild(el('div', { className: 'tab-head' }, [
      el('h1', { text: 'Callers' }),
      el('p', { className: 'muted', text: 'Who is calling, daily targets, notes and seats.' }),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'activity' }, [
      el('h2', { text: 'Team activity' }),
      el('form', { id: 'range-form', className: 'row' }, [
        field('From', el('input', { id: 'from', type: 'date', required: true })),
        field('To', el('input', { id: 'to', type: 'date', required: true })),
        el('button', { type: 'submit', text: 'Show' }),
        el('button', { type: 'button', id: 'range-last7', text: 'Last 7 days' }),
      ]),
      msg('range-msg'),
      el('div', { className: 'scroll' }, [el('table', null, [
        head([['Rep'], ['Day'], ['Calls', 'num'], ['Connected', 'num'], ['Connect rate', 'num'], ['Talk (s)', 'num'], ['Last call']]),
        el('tbody', { id: 'team-body' }),
      ])]),
      el('p', { id: 'team-empty', className: 'muted', hidden: true, text: 'No calls in this range.' }),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'progress' }, [
      el('h2', { text: 'Rep progress' }),
      el('form', { id: 'progress-form', className: 'row' }, [
        field('Day', el('input', { id: 'progress-day', type: 'date', required: true })),
        el('button', { type: 'submit', text: 'Show day' }),
      ]),
      msg('progress-msg'),
      el('div', { className: 'scroll' }, [el('table', { className: 'stack' }, [
        head([['Rep'], ['Calls', 'num'], ['Connected', 'num'], ['Talk (min)', 'num']]),
        el('tbody', { id: 'progress-body' }),
      ])]),
      el('p', { id: 'progress-empty', className: 'muted', hidden: true, text: 'No reps yet.' }),
      el('h3', { text: 'Not calling' }),
      el('p', { id: 'idle-text', className: 'muted' }),
      el('ul', { id: 'idle-list', className: 'plain' }),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'targets' }, [
      el('h2', { text: 'Daily targets' }),
      el('p', { className: 'muted', text: 'Type a number in any box to change that target; blank boxes keep their current target. A target of 0 means no target. Each save asks you to confirm.' }),
      el('div', { className: 'scroll' }, [el('table', { className: 'stack' }, [
        head([['Rep'], ['Calls'], ['Connected calls'], ['Talk minutes'], ['Save']]),
        el('tbody', { id: 'target-body' }),
      ])]),
      el('p', { id: 'target-empty', className: 'muted', hidden: true, text: 'No active reps yet.' }),
      msg('target-msg'),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'notes' }, [
      el('h2', { text: 'Supervisor notes' }),
      el('form', { id: 'notes-form', className: 'row wrap' }, [
        field('Rep', el('select', { id: 'notes-rep' })),
        field('Day', el('input', { id: 'notes-day', type: 'date', required: true })),
        el('button', { type: 'submit', text: 'Show notes' }),
      ]),
      msg('notes-msg'),
      el('ul', { id: 'notes-list', className: 'plain' }),
      el('p', { id: 'notes-empty', className: 'muted', hidden: true, text: 'No notes for this rep on this day.' }),
      el('form', { id: 'note-form', className: 'stackform' }, [
        el('label', null, ['Add a note for the rep and day above', el('textarea', { id: 'note-text', rows: '3' })]),
        el('p', { id: 'note-count', className: 'muted small', text: '0 of 1000 characters' }),
        el('div', { className: 'row' }, [el('button', { type: 'submit', id: 'note-add', text: 'Add note' })]),
      ]),
      msg('note-msg'),
    ]));

    box.appendChild(el('div', { className: 'panel', id: 'seats' }, [
      el('h2', { text: 'Seats' }),
      el('form', { id: 'invite-form', className: 'row wrap' }, [
        field('Work email', el('input', { id: 'invite-email', type: 'email', autocomplete: 'off', required: true })),
        field('Seat label', el('input', { id: 'invite-label', type: 'text', maxlength: '60', placeholder: 'Rep 4', required: true })),
        field('Role', el('select', { id: 'invite-role' }, [
          el('option', { value: 'rep', text: 'Rep' }),
          el('option', { value: 'admin', text: 'Admin' }),
        ])),
        el('button', { type: 'submit', text: 'Add seat' }),
      ]),
      msg('invite-msg'),
      el('div', { className: 'scroll' }, [el('table', null, [
        head([['Seat'], ['Role'], ['Campaigns'], ['Status'], ['Now'], ['Devices'], ['Pairing'], ['Last call'], ['Actions']]),
        el('tbody', { id: 'seat-body' }),
      ])]),
      el('p', { id: 'seat-empty', className: 'muted', hidden: true, text: 'No seats yet.' }),
      msg('seat-extra-msg'),
    ]));

    // "Edit caller": filled by openEdit() for one seat.
    box.appendChild(el('div', { className: 'panel', id: 'caller-edit', hidden: true, tabindex: '-1', 'aria-labelledby': 'edit-title' }, [
      el('div', { className: 'row between' }, [
        el('h2', { id: 'edit-title', text: 'Edit caller' }),
        el('button', { type: 'button', id: 'edit-close', text: 'Close' }),
      ]),
      el('fieldset', { id: 'edit-campaigns', className: 'edit-block' }, [
        el('legend', { text: 'Campaigns (can be more than one)' }),
        el('div', { id: 'edit-campaign-list', className: 'edit-checks' }),
        el('p', { id: 'edit-campaign-none', className: 'muted small', hidden: true, text: 'No open campaigns. Make one on the Campaigns tab.' }),
        el('div', { className: 'row' }, [el('button', { type: 'button', id: 'edit-campaign-save', text: 'Save campaigns' })]),
        msg('edit-campaign-msg'),
      ]),
      el('div', { id: 'edit-owner', className: 'edit-block' }, [
        el('h3', { text: 'Role' }),
        el('div', { className: 'row' }, [
          field('Role', el('select', { id: 'edit-role' }, [
            el('option', { value: 'owner', text: 'Owner' }),
            el('option', { value: 'manager', text: 'Manager' }),
            el('option', { value: 'caller', text: 'Caller' }),
          ])),
          el('button', { type: 'button', id: 'edit-role-save', text: 'Save role' }),
        ]),
        el('p', { className: 'muted small', text: 'Owners can do everything. Managers run campaigns and callers. Callers only make calls.' }),
        el('label', { id: 'edit-money-field', className: 'switch' }, [
          el('input', { type: 'checkbox', id: 'edit-money', role: 'switch' }),
          el('span', { text: 'Can see money (fee amounts and totals)' }),
        ]),
        msg('edit-role-msg'),
      ]),
      el('div', { id: 'edit-move', className: 'edit-block' }, [
        el('h3', { text: 'Move leads to another caller' }),
        el('p', { className: 'muted small', text: 'Moves leads not finished yet (new, call back, promised). Finished leads stay.' }),
        el('div', { className: 'row' }, [
          field('To', el('select', { id: 'move-to' })),
          field('Campaign', el('select', { id: 'move-campaign' })),
          el('button', { type: 'button', id: 'move-go', text: 'Move leads' }),
        ]),
        msg('move-msg'),
      ]),
      el('div', { id: 'edit-seat', className: 'edit-block' }, [
        el('h3', { text: 'Phone and seat' }),
        el('div', { className: 'actions' }, [
          el('button', { type: 'button', id: 'edit-reset-phone', text: 'Reset phone pairing' }),
          el('button', { type: 'button', id: 'edit-remove', className: 'danger', text: 'Remove from seat' }),
        ]),
      ]),
    ]));
  }

  function wire() {
    $('range-form').addEventListener('submit', (e) => { e.preventDefault(); load(); });
    $('range-last7').addEventListener('click', () => {
      const d = A.lastNDays(new Date(), 7);
      $('from').value = d.from;
      $('to').value = d.to;
      load();
    });
    $('invite-form').addEventListener('submit', (e) => { e.preventDefault(); reviewInvite(); });
    $('progress-form').addEventListener('submit', (e) => { e.preventDefault(); loadProgress(); });
    $('notes-form').addEventListener('submit', (e) => { e.preventDefault(); loadNotes(); });
    $('note-form').addEventListener('submit', addNote);
    $('note-text').addEventListener('input', updateNoteCount);
    $('edit-close').addEventListener('click', closeEdit);
    $('edit-campaign-save').addEventListener('click', saveCampaigns);
    $('edit-role-save').addEventListener('click', askRole);
    $('edit-money').addEventListener('change', askMoney);
    $('move-go').addEventListener('click', askMove);
    $('edit-reset-phone').addEventListener('click', () => { const s = seatById(editing); if (s) askReset(s, 'phone'); });
    $('edit-remove').addEventListener('click', () => { const s = seatById(editing); if (s) askRevoke(s); });
    $('caller-edit').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEdit(); });
  }

  // ---------- team activity and seats ----------

  async function load() {
    const seq = ++loadSeq;
    let range;
    try { range = A.rangeToTimestamps($('from').value, $('to').value); } catch (err) {
      say('range-msg', err.message, true);
      return;
    }
    const inst = ctx.institute.id;
    say('range-msg', 'Loading...');
    try {
      const [t, s] = await Promise.all([
        ctx.rpc('admin_team_activity', { p_institute: inst, p_from: range.from, p_to: range.to, p_tz: ctx.tz }),
        ctx.rpc('admin_seat_list', { p_institute: inst }),
      ]);
      if (seq !== loadSeq) return;   // a newer load has started since
      team = t || [];
      seats = s || [];
      renderTeam();
      renderSeats();
      onSeatsLoaded();
      say('range-msg', 'Showing ' + $('from').value + ' to ' + $('to').value + ', days in ' + ctx.tz + '.');
      await loadExtras(seq);
    } catch (err) {
      if (seq === loadSeq) say('range-msg', 'Could not load: ' + err.message, true);
    }
  }

  function renderTeam() {
    const body = $('team-body');
    body.textContent = '';
    $('team-empty').hidden = team.length > 0;
    team.forEach((r) => {
      body.appendChild(el('tr', null, [
        cell(r.label),
        cell(r.day),
        cell(r.calls, 'num'),
        cell(r.connected_calls, 'num'),
        cell(Math.round(Number(r.connect_rate) * 100) + '%', 'num'),
        cell(r.talk_seconds, 'num'),
        cell(r.last_activity ? new Date(r.last_activity).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''),
      ]));
    });
  }

  // Roles, campaigns and what each seat is doing now (admin_callers), and the open campaigns. A database
  // without these functions keeps the seat list as it was, with old role names.
  async function loadExtras(seq) {
    const inst = ctx.institute.id;
    let rows = null;
    let camps = [];
    try {
      rows = (await ctx.rpc('admin_callers', { p_institute: inst })) || [];
    } catch (err) {
      if (seq !== loadSeq) return;
      if (ctx.isMissing(err)) say('seat-extra-msg', 'Roles and campaigns per caller are ' + T.NOT_YET + '.');
      else say('seat-extra-msg', 'Could not load roles and campaigns: ' + err.message, true);
    }
    try {
      const { data, error } = await ctx.client.from('campaigns').select('id, name, status')
        .eq('institute_id', inst).neq('status', 'closed').order('name');
      if (error) throw new Error(error.message);
      camps = data || [];
    } catch (err) { camps = []; }
    if (seq !== loadSeq || !ctx) return;
    if (rows) say('seat-extra-msg', '');
    extraRows = rows || [];
    extras = new Map(extraRows.map((r) => [r.seat_id, r]));
    campaigns = camps;
    extrasDone = true;
    renderSeats();
    if (wantSeat && seatById(wantSeat)) { const id = wantSeat; wantSeat = null; openEdit(id); }
    else if (editing) {
      const open = seatById(editing);
      if (open && open.status !== 'revoked') fillEdit(); else closeEdit();
    }
  }

  const seatById = (id) => seats.find((s) => s.seat_id === id) || null;
  // The seat row with what admin_callers adds (access_role, can_see_money, campaigns, now_status).
  const fullSeat = (s) => Object.assign({}, s, extras.get(s.seat_id) || {});
  // The signed-in admin is an owner (seats from before roles existed were owners).
  const iAmOwner = () => roleOf(ctx.seat) === 'owner';

  function renderSeats() {
    const body = $('seat-body');
    body.textContent = '';
    $('seat-empty').hidden = seats.length > 0;
    seats.forEach((row) => {
      const s = fullSeat(row);
      const health = A.pairingHealth(s);
      const kinds = (s.device_kinds || []).join(', ') || 'none';
      const role = roleLabel(s) + (roleOf(s) === 'manager' && s.can_see_money ? ' · sees money' : '');
      const camps = (s.campaigns || []).map((c) => c.name).join(', ');
      body.appendChild(el('tr', { 'data-seat': s.seat_id }, [
        cell(s.label),
        cell(role),
        cell(extras.has(s.seat_id) ? camps || '—' : ''),
        cell(s.status),
        cell(nowText(s.now_status)),
        cell(kinds),
        cell(health.text, 'health ' + health.level),
        cell(s.last_call_at ? new Date(s.last_call_at).toLocaleString() : 'No calls yet'),
        el('td', null, [seatActions(s)]),
      ]));
    });
  }

  function seatActions(s) {
    const box = el('div', { className: 'actions' });
    if (s.seat_id === ctx.seat.id) { box.appendChild(el('span', { text: 'This is you', className: 'muted' })); return box; }
    if (s.status === 'revoked') { box.appendChild(el('span', { text: 'Revoked', className: 'muted' })); return box; }
    box.appendChild(button('Edit', () => openEdit(s.seat_id)));
    // Only an owner changes an owner's seat.
    if (roleOf(fullSeat(s)) === 'owner' && !iAmOwner()) return box;
    box.appendChild(button('Reassign', () => askReassign(s)));
    box.appendChild(button('Revoke', () => askRevoke(s), 'danger'));
    if (s.status === 'active') {
      const kinds = s.device_kinds || [];
      if (kinds.includes('phone')) box.appendChild(button('Reset phone', () => askReset(s, 'phone')));
      if (kinds.includes('laptop')) box.appendChild(button('Reset laptop', () => askReset(s, 'laptop')));
    }
    return box;
  }

  // ----- seat actions: every one opens the in-page confirmation first -----

  function reviewInvite() {
    const mail = $('invite-email').value.trim();
    const label = $('invite-label').value.trim();
    const role = $('invite-role').value;
    if (!A.EMAIL.test(mail)) { say('invite-msg', 'Enter a valid email address.', true); return; }
    if (!label) { say('invite-msg', 'Give the seat a label, such as Rep 4.', true); return; }
    say('invite-msg', '');
    ctx.confirm({
      title: 'Add an invited seat',
      text: 'Add seat "' + label + '" as ' + role + ' for ' + mail + '. The person claims it by signing in with that email. It uses one of the institute\'s seats.',
      button: 'Add seat',
      run: () => ctx.seatAction({ action: 'invite', institute: ctx.institute.id, email: mail, label: label, role: role }),
      done: (out) => 'Seat "' + label + '" added for ' + mail + '.' +
        (out.email_sent === false ? ' They already have an account: they sign in with that email.' : ''),
      after: () => $('invite-form').reset(),
      reload: load,
    });
  }

  function askReassign(s) {
    if (s.seat_id === ctx.seat.id) return;   // the server refuses this too
    ctx.confirm({
      title: 'Reassign seat "' + s.label + '"',
      text: 'The current holder\'s phone and laptop are unpaired and their access ends. Enter the new person\'s email. They claim the seat by signing in with it.',
      email: { label: 'New person\'s email', value: '' },
      button: 'Reassign',
      danger: true,
      run: (mail) => ctx.seatAction({ action: 'reassign', seat: s.seat_id, email: mail }),
      done: (out) => 'Seat "' + s.label + '" reassigned.' + (out.note ? ' ' + out.note : ''),
      reload: load,
    });
  }

  function askRevoke(s) {
    if (s.seat_id === ctx.seat.id) return;   // the server refuses this too
    ctx.confirm({
      title: 'Revoke seat "' + s.label + '"',
      text: 'Its devices are unpaired and the person loses access. The seat stays in the list as revoked.',
      button: 'Revoke',
      danger: true,
      run: () => ctx.seatAction({ action: 'revoke', seat: s.seat_id }),
      done: 'Seat "' + s.label + '" revoked.',
      reload: load,
    });
  }

  function askReset(s, kind) {
    ctx.confirm({
      title: 'Reset ' + kind + ' for "' + s.label + '"',
      text: 'The ' + kind + ' is unpaired. The seat can then pair a new ' + kind + ' from its own login.',
      button: 'Reset ' + kind,
      danger: true,
      run: () => ctx.seatAction({ action: 'reset_pairing', seat: s.seat_id, kind: kind }),
      done: 'The ' + kind + ' for "' + s.label + '" is unpaired.',
      reload: load,
    });
  }

  // ---------- edit caller ----------

  function openEdit(id) {
    const s = seatById(id);
    if (!s || s.status === 'revoked' || s.seat_id === ctx.seat.id) return;
    editing = id;
    ['edit-campaign-msg', 'edit-role-msg', 'move-msg'].forEach((m) => say(m, ''));
    fillEdit();
    $('caller-edit').hidden = false;
    $('caller-edit').focus();
  }

  function closeEdit() {
    editing = null;
    $('caller-edit').hidden = true;
  }

  // Fills the panel for the seat being edited. Owner-only parts are hidden for managers.
  function fillEdit() {
    const s = fullSeat(seatById(editing));
    const role = roleOf(s);
    const owner = iAmOwner();
    const known = extras.has(s.seat_id);
    $('edit-title').textContent = 'Edit caller: ' + s.label;

    // Campaigns: one checkbox per open campaign. Only active seats can be members.
    const list = $('edit-campaign-list');
    list.textContent = '';
    const mine = new Set((s.campaigns || []).map((c) => c.id));
    campaigns.forEach((c) => {
      list.appendChild(el('label', { className: 'check' }, [
        el('input', { type: 'checkbox', value: c.id, checked: mine.has(c.id), disabled: s.status !== 'active' || !known }),
        el('span', { text: c.name + (c.status === 'draft' ? ' (draft)' : c.status === 'paused' ? ' (paused)' : '') }),
      ]));
    });
    $('edit-campaign-none').hidden = campaigns.length > 0;
    $('edit-campaign-save').hidden = !campaigns.length || s.status !== 'active' || !known;

    // Role and money: owners only.
    $('edit-owner').hidden = !owner || !known;
    $('edit-role').value = role;
    $('edit-money-field').hidden = role !== 'manager';
    $('edit-money').checked = !!s.can_see_money;

    // Move leads: to another active caller, or back to the shared list.
    const to = $('move-to');
    to.textContent = '';
    seats.filter((x) => x.status === 'active' && x.seat_id !== s.seat_id)
      .forEach((x) => to.appendChild(el('option', { value: x.seat_id, text: x.label })));
    to.appendChild(el('option', { value: '', text: 'Nobody: back to the shared list' }));
    const camp = $('move-campaign');
    camp.textContent = '';
    camp.appendChild(el('option', { value: '', text: 'All campaigns' }));
    (s.campaigns || []).forEach((c) => camp.appendChild(el('option', { value: c.id, text: c.name })));

    // Phone and seat. Removing an owner is for owners only.
    $('edit-reset-phone').hidden = !(s.status === 'active' && (s.device_kinds || []).includes('phone'));
    $('edit-remove').hidden = role === 'owner' && !owner;
  }

  // Saves the campaign ticks: each changed campaign gets its new member list (admin_set_campaign_members).
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
      say('edit-campaign-msg', 'Campaigns saved for ' + s.label + '.' +
        (change.removed.length ? ' Leads not called yet from a campaign they left go back to the other callers.' : ''));
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
    const what = { owner: 'can do everything, including money settings and roles',
      manager: 'runs campaigns and callers, and sees money only if you allow it',
      caller: 'only makes calls' }[role];
    ctx.confirm({
      title: 'Make "' + s.label + '" ' + ROLE_LABELS[role].toLowerCase(),
      text: 'A ' + ROLE_LABELS[role].toLowerCase() + ' ' + what + '. The change starts at their next sign-in or page load.',
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

  function askMove() {
    const s = fullSeat(seatById(editing));
    const toId = $('move-to').value || null;
    const campId = $('move-campaign').value || null;
    const to = toId ? seatById(toId) : null;
    const camp = campId ? campaigns.find((c) => c.id === campId) : null;
    const where = camp ? ' in "' + camp.name + '"' : ' in every open campaign';
    ctx.confirm({
      title: 'Move leads of "' + s.label + '"',
      text: 'Leads not finished yet' + where + ' go to ' + (to ? '"' + to.label + '"' : 'the shared list') + '.' +
        (to ? ' ' + to.label + ' joins those campaigns if needed.' : ''),
      button: 'Move leads',
      run: async () => {
        try {
          return { moved: await ctx.rpc('admin_move_leads', { p_from_seat: s.seat_id, p_to_seat: toId, p_campaign: campId }) };
        } catch (err) {
          if (ctx.isMissing(err)) throw new Error('Moving leads is ' + T.NOT_YET + '.');
          throw err;
        }
      },
      done: (out) => S.count(Number(out.moved) || 0) + ' lead' + (Number(out.moved) === 1 ? '' : 's') + ' moved from "' + s.label + '".',
      reload: load,
    });
  }

  // ---------- rep progress and not calling ----------

  async function loadProgress() {
    const day = $('progress-day').value;
    if (!T.parseYmd(day)) { say('progress-msg', 'Pick a day.', true); return; }
    const seq = ++progressSeq;
    say('progress-msg', 'Loading...');
    try {
      const rows = (await rpc('admin_rep_progress', { p_institute: ctx.institute.id, p_day: day, p_tz: ctx.tz })) || [];
      if (seq !== progressSeq) return;
      progressRows = rows;
      renderProgress();
      setTargetPlaceholders();
      say('progress-msg', 'Showing ' + day + ' in ' + ctx.tz + '.');
    } catch (err) {
      if (seq !== progressSeq) return;
      progressRows = [];
      renderProgress();
      report('progress-msg', err, 'Could not load: ');
    }
  }

  // One figure with its target and a bar. The bar's width is set through the DOM property (allowed by the page's CSP).
  function progressCell(value, target, label) {
    const v = Number(value) || 0;
    const t = Number(target) || 0;
    const td = el('td', { className: 'num', 'data-label': label });
    td.appendChild(el('div', { text: t > 0 ? v + ' of ' + t : String(v) }));
    if (t > 0) {
      const fill = el('div', { className: 'bar-fill' + (v >= t ? ' met' : '') });
      fill.style.width = T.barPercent(v, t) + '%';
      td.appendChild(el('div', { className: 'bar', role: 'img', 'aria-label': T.percentOfTarget(v, t) + '% of target' }, [fill]));
      td.appendChild(el('div', { text: T.percentOfTarget(v, t) + '% of target', className: 'muted small' }));
    } else {
      td.appendChild(el('div', { text: 'no target', className: 'muted small' }));
    }
    return td;
  }

  function renderProgress() {
    const body = $('progress-body');
    body.textContent = '';
    $('progress-empty').hidden = progressRows.length > 0;
    progressRows.forEach((r) => {
      body.appendChild(el('tr', null, [
        cell(r.label, '', 'Rep'),
        progressCell(r.calls, r.calls_target, 'Calls'),
        progressCell(r.connected_calls, r.connected_target, 'Connected'),
        progressCell(Math.round(Number(r.talk_minutes) || 0), r.talk_target, 'Talk (min)'),
      ]));
    });
    const list = $('idle-list');
    list.textContent = '';
    const idle = T.notCalling(progressRows);
    idle.forEach((r) => list.appendChild(el('li', { text: r.label })));
    $('idle-text').textContent = !progressRows.length ? '' :
      idle.length ? idle.length + ' rep seat' + (idle.length === 1 ? ' has' : 's have') + ' no calls on this day.'
        : 'Every rep seat made at least one call on this day.';
  }

  // ---------- daily targets ----------

  // Rebuilds the rows only when the rep list changes, so typing in an open row is not lost on a reload.
  function renderTargetRows() {
    const list = reps();
    const sig = list.map((s) => s.seat_id + ':' + s.label).join('|');
    if (sig === repsSig) return;
    repsSig = sig;
    const body = $('target-body');
    body.textContent = '';
    targetInputs = new Map();
    $('target-empty').hidden = list.length > 0;
    list.forEach((s) => {
      const inputs = {};
      TARGETS.forEach((f) => {
        inputs[f.metric] = el('input', {
          type: 'number', min: '0', max: String(T.TARGET_MAX), step: '1', inputmode: 'numeric',
          className: 'target-input', placeholder: 'current', 'aria-label': f.name + ' target for ' + s.label,
        });
      });
      targetInputs.set(s.seat_id, inputs);
      body.appendChild(el('tr', null, [
        cell(s.label, '', 'Rep'),
        ...TARGETS.map((f) => el('td', { 'data-label': f.name }, [inputs[f.metric]])),
        el('td', { 'data-label': 'Save' }, [button('Save', () => askTargets(s))]),
      ]));
    });
  }

  // Shows the current target of each rep in the placeholder of its boxes (blank boxes keep it).
  function setTargetPlaceholders() {
    progressRows.forEach((r) => {
      const inputs = targetInputs.get(r.seat_id);
      if (!inputs) return;
      TARGETS.forEach((f) => {
        const cur = Number(r[f.field]);
        inputs[f.metric].placeholder = cur > 0 ? 'current ' + cur : 'none set';
      });
    });
  }

  function askTargets(s) {
    const inputs = targetInputs.get(s.seat_id);
    if (!inputs) return;
    const changes = [];
    for (const f of TARGETS) {
      const r = T.parseTarget(inputs[f.metric].value);
      if (!r.ok) { say('target-msg', r.error + ' (' + f.name + ', ' + s.label + ')', true); return; }
      if (r.value !== null) changes.push({ metric: f.metric, name: f.name, value: r.value });
    }
    if (!changes.length) { say('target-msg', 'Type a target in at least one box for ' + s.label + '.', true); return; }
    say('target-msg', '');
    const list = changes.map((c) => c.name + ' ' + c.value).join(', ');
    ctx.confirm({
      title: 'Set daily targets for "' + s.label + '"',
      text: 'New daily target: ' + list + '. Blank boxes keep their current target. A target of 0 means no target.',
      button: 'Save targets',
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
      done: 'Targets saved for "' + s.label + '": ' + list + '.',
      after: () => {
        changes.forEach((c) => { inputs[c.metric].value = ''; });
        if ($('progress-day').value) loadProgress();
      },
      reload: load,
    });
  }

  // ---------- supervisor notes ----------

  function fillRepSelect(sel) {
    const keep = sel.value;
    sel.textContent = '';
    reps().forEach((s) => sel.appendChild(el('option', { value: s.seat_id, text: s.label })));
    if (keep && Array.from(sel.options).some((o) => o.value === keep)) sel.value = keep;
  }

  async function loadNotes() {
    const seat = $('notes-rep').value;
    const day = $('notes-day').value;
    if (!seat) { say('notes-msg', 'There are no active reps to show notes for.', true); return; }
    if (!T.parseYmd(day)) { say('notes-msg', 'Pick a day.', true); return; }
    const seq = ++notesSeq;
    say('notes-msg', 'Loading...');
    try {
      const rows = (await rpc('list_supervisor_notes', { p_institute: ctx.institute.id, p_seat: seat, p_from: day, p_to: day })) || [];
      if (seq !== notesSeq) return;
      renderNotes(rows);
      say('notes-msg', '');
    } catch (err) {
      if (seq !== notesSeq) return;
      renderNotes([]);
      report('notes-msg', err, 'Could not load: ');
    }
  }

  function renderNotes(rows) {
    const list = $('notes-list');
    list.textContent = '';
    $('notes-empty').hidden = rows.length > 0;
    rows.forEach((n) => {
      const when = n.created_at ? new Date(n.created_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      list.appendChild(el('li', { className: 'note' }, [
        el('div', { text: when, className: 'muted small' }),
        el('div', { text: String(n.note === null || n.note === undefined ? '' : n.note), className: 'note-text' }),
      ]));
    });
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
    const seat = $('notes-rep').value;
    const day = $('notes-day').value;
    if (!seat) { say('note-msg', 'There are no active reps to add a note for.', true); return; }
    if (!T.parseYmd(day)) { say('note-msg', 'Pick a day.', true); return; }
    const r = T.noteCheck($('note-text').value);
    if (!r.ok) { say('note-msg', r.error, true); return; }
    busy = true;
    updateNoteCount();
    try {
      await rpc('add_supervisor_note', { p_seat: seat, p_day: day, p_note: r.text });
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

  // After each load of the seat list, which can change the rep list.
  function onSeatsLoaded() {
    fillRepSelect($('notes-rep'));
    renderTargetRows();
    setTargetPlaceholders();
  }

  S.registerTab({
    id: 'callers',
    label: 'Callers',
    mount(box, c) {
      ctx = c;
      build(box);
      wire();
      const today = new Date();
      const d = A.lastNDays(today, 7);
      $('from').value = d.from;
      $('to').value = d.to;
      $('progress-day').value = T.ymd(today);
      $('notes-day').value = T.ymd(today);
      updateNoteCount();
      load();
    },
    // #callers?seat=<id> (from Home) opens "Edit caller" for that seat once the seats are loaded.
    show(params) {
      if (!params || !params.seat || !ctx) return;
      if (extrasDone && seatById(params.seat)) openEdit(params.seat);
      else wantSeat = params.seat;
    },
    unmount() {
      ctx = null;
      team = []; seats = []; progressRows = [];
      extras = new Map(); extraRows = []; campaigns = []; editing = null; wantSeat = null; extrasDone = false;
      loadSeq++; progressSeq++; notesSeq++;
      repsSig = null;
      targetInputs = new Map();
      busy = false;
    },
  });
})();
