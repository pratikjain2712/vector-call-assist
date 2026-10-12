'use strict';
/* Admin page (web/admin.html), for Vector 2.0. Shows one institute's team activity, results by
   outcome and seat list, and runs the seat actions. The admin signs in by emailed link, like cloud.js.
   Reports are read with admin_* RPCs (supabase/migrations/0004_admin_views.sql), checked by the database.
   Seat changes (invite, reassign, revoke, reset pairing) go through the seat-admin Edge Function
   (supabase/functions/seat-admin), which checks them again on the server. Only counts and timings are
   shown; the database holds no lead names or numbers.
   The pure helpers below are also loaded by tests/web/admin.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------
  const OUTCOMES = ['answered', 'no_answer', 'busy', 'callback', 'interested', 'not_interested', 'won', 'dropped_network', 'other'];
  const TEAM_HEADERS = ['Rep', 'Day', 'Calls', 'Connected calls', 'Connect rate (%)', 'Talk time (s)', 'Last call'];
  const MAX_DAYS = 400;
  const FORMULA_START = /^[=+\-@\t\r]/;   // cells starting with these could run as formulas in a spreadsheet
  const PHONE_LIKE = /^\+?[0-9][0-9 ()\-.]*$/; // phone numbers may start with + and are left alone
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

  // 'YYYY-MM-DD' to a local-midnight Date, or null when it is not a real calendar date.
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]) - 1, day = Number(m[3]);
    const d = new Date(y, mo, day);
    return d.getFullYear() === y && d.getMonth() === mo && d.getDate() === day ? d : null;
  }

  // The last n calendar days ending on `now`, both ends included, as local 'YYYY-MM-DD' dates.
  function lastNDays(now, n) {
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - (n - 1));
    return { from: ymd(from), to: ymd(to) };
  }

  // An inclusive date range to the [from, to) instants the RPCs take: local midnight of the first
  // day, and local midnight of the day after the last one.
  function rangeToTimestamps(fromYmd, toYmd) {
    const a = parseYmd(fromYmd);
    const b = parseYmd(toYmd);
    if (!a || !b) throw new Error('Pick both dates.');
    if (b < a) throw new Error('The to date is before the from date.');
    const days = Math.round((b - a) / 86400000) + 1; // round() absorbs the 23 and 25 hour days
    if (days > MAX_DAYS) throw new Error('Choose a range of ' + MAX_DAYS + ' days or less.');
    const end = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
    return { from: a.toISOString(), to: end.toISOString() };
  }

  // Formula guard: a text cell starting with = + - @ (or a tab or CR) gets a leading apostrophe,
  // unless it looks like a phone number. Numbers are never changed.
  function guardCell(v) {
    if (typeof v !== 'string') return v;
    return FORMULA_START.test(v) && !PHONE_LIKE.test(v) ? "'" + v : v;
  }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(guardCell(v));
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(headers, rows) {
    return [headers].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function rateToPercent(rate) {
    if (rate === null || rate === undefined || rate === '') return '';
    return Math.round(Number(rate) * 1000) / 10;   // one decimal place
  }

  function teamCsvRows(rows) {
    return rows.map((r) => [
      r.label, r.day, r.calls, r.connected_calls, rateToPercent(r.connect_rate), r.talk_seconds, r.last_activity,
    ]);
  }

  // Results by outcome: one entry per rep with a count for each outcome and a total, sorted by label.
  function pivotOutcomes(rows) {
    const byRep = new Map();
    rows.forEach((r) => {
      if (!byRep.has(r.seat_id)) byRep.set(r.seat_id, { seat_id: r.seat_id, label: r.label, counts: {}, total: 0 });
      const rep = byRep.get(r.seat_id);
      const n = Number(r.outcome_count) || 0;
      rep.counts[r.outcome] = (rep.counts[r.outcome] || 0) + n;
      rep.total += n;
    });
    return Array.from(byRep.values()).sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  // Pairing health for one row of admin_seat_list.
  function pairingHealth(seat) {
    if (seat.status === 'revoked') return { level: 'none', text: 'Revoked' };
    if (seat.status === 'invited') return { level: 'none', text: 'Invite not claimed' };
    return seat.has_phone ? { level: 'ok', text: 'Phone paired' } : { level: 'warn', text: 'No phone paired' };
  }

  const helpers = {
    OUTCOMES, TEAM_HEADERS, MAX_DAYS, ymd, parseYmd, lastNDays, rangeToTimestamps,
    guardCell, csvCell, toCsv, rateToPercent, teamCsvRows, pivotOutcomes, pairingHealth, EMAIL,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;   // loaded by a test, not by the page
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initPage(helpers));
  else initPage(helpers);

  // ---------- page ----------
  function initPage(H) {
    const cfg = window.VECTOR_CONFIG || {};
    const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
    const $ = (id) => document.getElementById(id);
    const SECTIONS = ['off', 'gate', 'notadmin', 'app'];

    let client = null;
    let mySeat = null;      // my active seat row (admins only)
    let team = [];
    let outcomes = [];
    let seats = [];
    let pending = null;     // the action waiting for the in-page confirmation
    let loadSeq = 0;
    let claimedFor = null;  // user id whose invitation was tried this sign-in (cleared on sign-out)
    let currentEmail = null;

    const show = (section) => SECTIONS.forEach((s) => { $(s).hidden = s !== section; });
    const say = (id, text, isError) => {
      const node = $(id);
      node.textContent = text || '';
      node.classList.toggle('error', !!isError);
    };

    // Builds an element from text and child nodes only: no HTML strings, so names from the database are never parsed as markup.
    function el(tag, props, children) {
      const node = document.createElement(tag);
      Object.keys(props || {}).forEach((k) => {
        if (k === 'text') node.textContent = props[k];
        else if (k === 'className') node.className = props[k];
        else if (k === 'onClick') node.addEventListener('click', props[k]);
        else node.setAttribute(k, props[k]);
      });
      (children || []).forEach((c) => node.appendChild(c));
      return node;
    }
    const cell = (text, cls) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || '' });
    const button = (text, onClick, cls) => el('button', { type: 'button', text, onClick, className: cls || '' });

    async function rpc(name, args) {
      const { data, error } = await client.rpc(name, args);
      if (error) {
        const err = new Error(error.message);
        err.code = error.code;   // lets team tools tell a missing function from other failures
        throw err;
      }
      return data;
    }

    // Seat changes go through the seat-admin Edge Function with the admin's own access token.
    async function seatAction(body) {
      const { data } = await client.auth.getSession();
      const token = data && data.session ? data.session.access_token : '';
      if (!token) throw new Error('Sign in again.');
      let res;
      try {
        res = await fetch(cfg.supabaseUrl.replace(/\/+$/, '') + '/functions/v1/seat-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: cfg.supabaseAnonKey },
          body: JSON.stringify(body),
        });
      } catch (err) { throw new Error('No connection. Try again.'); }
      let out = {};
      try { out = await res.json(); } catch (err) { out = {}; }
      if (!res.ok) throw new Error(out.error || 'The seat change did not go through. Try again.');
      return out;
    }

    // An invited person links their login to the seat invited for their email, once per sign-in. "No invitation"
    // is ignored; a network failure is tried again on the next sign-in event.
    async function claimInvite(userId) {
      if (claimedFor === userId) return;
      try {
        const { error } = await client.rpc('claim_my_invite');
        if (error && !error.code) return;
      } catch (err) { return; }
      claimedFor = userId;
    }

    function init() {
      if (!enabled) { $('signout').hidden = true; show('off'); return; }
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      // Supabase advises against calling the client inside this callback, so the work runs just after it.
      client.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
      $('gate-form').addEventListener('submit', sendLink);
      $('signout').addEventListener('click', () => { client.auth.signOut(); });
      $('range-form').addEventListener('submit', (e) => { e.preventDefault(); load(); });
      $('range-last7').addEventListener('click', () => {
        const d = H.lastNDays(new Date(), 7);
        $('from').value = d.from;
        $('to').value = d.to;
        load();
      });
      $('csv').addEventListener('click', downloadCsv);
      $('invite-form').addEventListener('submit', (e) => { e.preventDefault(); reviewInvite(); });
      $('confirm-go').addEventListener('click', runPending);
      $('confirm-cancel').addEventListener('click', cancelPending);
      show('gate');
    }

    async function sendLink(e) {
      e.preventDefault();
      const email = $('gate-email').value.trim();
      if (!H.EMAIL.test(email)) { say('gate-msg', 'Enter your work email address.', true); return; }
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
      });
      say('gate-msg', error ? error.message : 'Check your email for the sign-in link.', !!error);
    }

    async function onSession(session) {
      mySeat = null;
      if (!session) { claimedFor = null; currentEmail = null; show('gate'); return; }
      currentEmail = session.user.email || null;
      $('who').textContent = session.user.email || '';
      await claimInvite(session.user.id);
      let data;
      try { data = await rpc('my_active_seat'); } catch (err) {
        say('gate-msg', 'Could not check your seat: ' + err.message, true);
        show('gate');
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || !row.id || row.role !== 'admin') { show('notadmin'); return; }
      mySeat = row;
      show('app');
      const d = H.lastNDays(new Date(), 7);
      $('from').value = d.from;
      $('to').value = d.to;
      await load();
    }

    async function load() {
      if (!mySeat) return;
      const seq = ++loadSeq;
      let range;
      try { range = H.rangeToTimestamps($('from').value, $('to').value); } catch (err) {
        say('range-msg', err.message, true);
        return;
      }
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const inst = mySeat.institute_id;
      say('range-msg', 'Loading...');
      try {
        const [t, o, s] = await Promise.all([
          rpc('admin_team_activity', { p_institute: inst, p_from: range.from, p_to: range.to, p_tz: tz }),
          rpc('admin_results_by_outcome', { p_institute: inst, p_from: range.from, p_to: range.to }),
          rpc('admin_seat_list', { p_institute: inst }),
        ]);
        if (seq !== loadSeq) return;   // a newer load has started since
        team = t || [];
        outcomes = o || [];
        seats = s || [];
        render();
        say('range-msg', 'Showing ' + $('from').value + ' to ' + $('to').value + ', days in ' + tz + '.');
        document.dispatchEvent(new CustomEvent('vector-admin:loaded'));
      } catch (err) {
        if (seq === loadSeq) say('range-msg', 'Could not load: ' + err.message, true);
      }
    }

    function render() { renderTeam(); renderOutcomes(); renderSeats(); }

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

    function renderOutcomes() {
      const head = $('outcome-head');
      const body = $('outcome-body');
      head.textContent = '';
      body.textContent = '';
      head.appendChild(el('th', { text: 'Rep' }));
      H.OUTCOMES.forEach((o) => head.appendChild(el('th', { text: o.replace(/_/g, ' '), className: 'num' })));
      head.appendChild(el('th', { text: 'Total', className: 'num' }));
      const reps = H.pivotOutcomes(outcomes);
      $('outcome-empty').hidden = reps.length > 0;
      reps.forEach((rep) => {
        const cells = [cell(rep.label)];
        H.OUTCOMES.forEach((o) => cells.push(cell(rep.counts[o] || 0, 'num')));
        cells.push(cell(rep.total, 'num'));
        body.appendChild(el('tr', null, cells));
      });
    }

    function renderSeats() {
      const body = $('seat-body');
      body.textContent = '';
      $('seat-empty').hidden = seats.length > 0;
      seats.forEach((s) => {
        const health = H.pairingHealth(s);
        const kinds = (s.device_kinds || []).join(', ') || 'none';
        body.appendChild(el('tr', null, [
          cell(s.label),
          cell(s.role),
          cell(s.status),
          cell(kinds),
          cell(health.text, 'health ' + health.level),
          cell(s.last_call_at ? new Date(s.last_call_at).toLocaleString() : 'No calls yet'),
          el('td', null, [seatActions(s)]),
        ]));
      });
    }

    function seatActions(s) {
      const box = el('div', { className: 'actions' });
      if (s.seat_id === mySeat.id) { box.appendChild(el('span', { text: 'This is you', className: 'muted' })); return box; }
      if (s.status === 'revoked') { box.appendChild(el('span', { text: 'Revoked', className: 'muted' })); return box; }
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
      if (!H.EMAIL.test(mail)) { say('invite-msg', 'Enter a valid email address.', true); return; }
      if (!label) { say('invite-msg', 'Give the seat a label, such as Rep 4.', true); return; }
      say('invite-msg', '');
      askConfirm({
        title: 'Add an invited seat',
        text: 'Add seat "' + label + '" as ' + role + ' for ' + mail + '. The person claims it by signing in with that email. It uses one of the institute\'s seats.',
        button: 'Add seat',
        run: () => seatAction({ action: 'invite', institute: mySeat.institute_id, email: mail, label: label, role: role }),
        done: (out) => 'Seat "' + label + '" added for ' + mail + '.' +
          (out.email_sent === false ? ' They already have an account: they sign in with that email.' : ''),
        after: () => $('invite-form').reset(),
      });
    }

    function askReassign(s) {
      if (s.seat_id === mySeat.id) return;   // the server refuses this too
      askConfirm({
        title: 'Reassign seat "' + s.label + '"',
        text: 'The current holder\'s phone and laptop are unpaired and their access ends. Enter the new person\'s email. They claim the seat by signing in with it.',
        email: { label: 'New person\'s email', value: '' },
        button: 'Reassign',
        danger: true,
        run: (mail) => seatAction({ action: 'reassign', seat: s.seat_id, email: mail }),
        done: (out) => 'Seat "' + s.label + '" reassigned.' + (out.note ? ' ' + out.note : ''),
      });
    }

    function askRevoke(s) {
      if (s.seat_id === mySeat.id) return;   // the server refuses this too
      askConfirm({
        title: 'Revoke seat "' + s.label + '"',
        text: 'Its devices are unpaired and the person loses access. The seat stays in the list as revoked.',
        button: 'Revoke',
        danger: true,
        run: () => seatAction({ action: 'revoke', seat: s.seat_id }),
        done: 'Seat "' + s.label + '" revoked.',
      });
    }

    function askReset(s, kind) {
      askConfirm({
        title: 'Reset ' + kind + ' for "' + s.label + '"',
        text: 'The ' + kind + ' is unpaired. The seat can then pair a new ' + kind + ' from its own login.',
        button: 'Reset ' + kind,
        danger: true,
        run: () => seatAction({ action: 'reset_pairing', seat: s.seat_id, kind: kind }),
        done: 'The ' + kind + ' for "' + s.label + '" is unpaired.',
      });
    }

    function askConfirm(job) {
      pending = job;
      $('confirm-title').textContent = job.title;
      $('confirm-text').textContent = job.text;
      $('confirm-email-field').hidden = !job.email;
      if (job.email) {
        $('confirm-email-label').textContent = job.email.label;
        $('confirm-email').value = job.email.value || '';
      }
      const go = $('confirm-go');
      go.textContent = job.button;
      go.className = job.danger ? 'danger' : '';
      say('confirm-msg', '');
      $('confirm').hidden = false;
      $('confirm').scrollIntoView({ block: 'nearest' });
      go.focus();
    }

    function cancelPending() {
      pending = null;
      $('confirm').hidden = true;
      say('confirm-msg', '');
    }

    async function runPending() {
      const job = pending;
      if (!job) return;
      let mail = null;
      if (job.email) {
        mail = $('confirm-email').value.trim();
        if (!H.EMAIL.test(mail)) { say('confirm-msg', 'Enter a valid email address.', true); return; }
      }
      const go = $('confirm-go');
      go.disabled = true;
      try {
        const out = (await job.run(mail)) || {};
        pending = null;
        $('confirm').hidden = true;
        if (job.after) job.after();
        say('status', typeof job.done === 'function' ? job.done(out) : job.done);
        await load();
      } catch (err) {
        say('confirm-msg', err.message, true);
      } finally {
        go.disabled = false;
      }
    }

    // ----- CSV download of the team activity table -----

    function downloadCsv() {
      if (!team.length) { say('range-msg', 'No calls in this range, so nothing to download.', true); return; }
      const csv = H.toCsv(H.TEAM_HEADERS, H.teamCsvRows(team));
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vector-team-activity-' + $('from').value + '-to-' + $('to').value + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // Shared with js/admin-team.js: the client, the signed-in admin and the in-page confirmation.
    window.VectorAdmin = {
      rpc,
      client: () => client,
      session: () => ({ email: currentEmail, instituteId: mySeat ? mySeat.institute_id : null }),
      seats: () => seats.slice(),
      confirm: askConfirm,
    };
    document.dispatchEvent(new CustomEvent('vector-admin:ready'));

    init();
  }
})();
