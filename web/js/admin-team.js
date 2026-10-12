'use strict';
/* Admin page, team tools (web/admin.html): weekly summary, rep progress with a not-calling list, daily
   targets, supervisor notes and a password reset for the signed-in admin. js/admin.js owns the Supabase
   client, the signed-in admin and the in-page confirmation, and shares them as window.VectorAdmin.
   Every call is an RPC with the admin's own session: admin_weekly_summary, admin_rep_progress,
   set_rep_target, list_supervisor_notes, add_supervisor_note. A function the database does not have yet
   shows "not available yet". Only counts, timings and the notes the supervisors wrote are shown.
   The pure helpers below are also loaded by tests/web/admin-team.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------
  const NOT_YET = 'not available yet';
  const NOTE_MAX = 1000;
  const TARGET_MAX = 100000;
  const FORMULA_START = /^[=+\-@\t\r]/;   // same guard as js/admin.js
  const PHONE_LIKE = /^\+?[0-9][0-9 ()\-.]*$/;
  // The three daily targets: the metric name the database takes, the words shown, and the field of the rep progress row.
  const TARGETS = [
    { metric: 'calls', name: 'calls', field: 'calls_target' },
    { metric: 'connected_calls', name: 'connected calls', field: 'connected_target' },
    { metric: 'talk_minutes', name: 'talk minutes', field: 'talk_target' },
  ];

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

  // The Monday on or before a date (a 'YYYY-MM-DD' string or a Date), as 'YYYY-MM-DD'; null for a bad date.
  function weekStart(input) {
    const d = input instanceof Date
      ? new Date(input.getFullYear(), input.getMonth(), input.getDate())
      : parseYmd(input);
    if (!d) return null;
    const back = (d.getDay() + 6) % 7;   // getDay() is 0 for Sunday, so Monday gives 0 and Sunday gives 6
    return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
  }

  // The width of a progress bar in whole percent, 0 to 100. A missing or zero target gives 0.
  function barPercent(value, target) {
    const v = Number(value), t = Number(target);
    if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((v / t) * 100)));
  }

  // The real percentage of the target, so 150 means 150%. null when there is no target.
  function percentOfTarget(value, target) {
    const v = Number(value), t = Number(target);
    if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;
    return Math.round((v / t) * 100);
  }

  // A note as the database will see it: trimmed, and no more than 1000 characters (code points, as the database counts).
  function noteCheck(text) {
    const t = String(text === null || text === undefined ? '' : text).trim();
    const length = Array.from(t).length;
    if (!length) return { ok: false, length: 0, error: 'Write a note first.' };
    if (length > NOTE_MAX) return { ok: false, length, error: 'Notes can be up to ' + NOTE_MAX + ' characters. This one has ' + length + '.' };
    return { ok: true, length, text: t };
  }

  // A typed daily target. Blank means leave it as it is (value null). Otherwise a whole number from 0 to TARGET_MAX.
  function parseTarget(raw) {
    const s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (s === '') return { ok: true, value: null };
    if (!/^\d+$/.test(s)) return { ok: false, error: 'Targets are whole numbers, such as 20.' };
    const n = Number(s);
    if (n > TARGET_MAX) return { ok: false, error: 'Targets can be up to ' + TARGET_MAX + '.' };
    return { ok: true, value: n };
  }

  // Formula guard, the same as js/admin.js: a text cell starting with = + - @ (or a tab or CR) gets a leading apostrophe,
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

  // Columns of the weekly summary: every field of the first row except ids, in the order the database returns them.
  function summaryColumns(rows) {
    if (!rows || !rows.length) return [];
    return Object.keys(rows[0]).filter((k) => !/(^|_)id$/.test(k));
  }

  // A column name as a heading: connected_calls becomes "Connected calls".
  function headerText(key) {
    const s = String(key).replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Rep seats with no calls on the chosen day, sorted by label. Rows marked as admins are left out.
  function notCalling(rows) {
    return (rows || [])
      .filter((r) => (r.role === undefined || r.role === 'rep') && Number(r.calls || 0) === 0)
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }

  // Active rep seats from admin_seat_list rows.
  function repSeats(seats) {
    return (seats || []).filter((s) => s.role === 'rep' && s.status === 'active');
  }

  // Talk seconds as minutes with one decimal place.
  function talkMinutes(seconds) {
    return Math.round((Number(seconds) || 0) / 6) / 10;
  }

  const helpers = {
    NOT_YET, NOTE_MAX, TARGET_MAX, TARGETS, ymd, parseYmd, weekStart, barPercent, percentOfTarget, noteCheck,
    parseTarget, guardCell, csvCell, toCsv, summaryColumns, headerText, notCalling, repSeats, talkMinutes,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;   // loaded by a test, not by the page

  // The page starts once js/admin.js has made window.VectorAdmin (it does so at DOMContentLoaded).
  if (window.VectorAdmin) initPage(helpers);
  else document.addEventListener('vector-admin:ready', () => initPage(helpers), { once: true });

  // ---------- page ----------
  function initPage(H) {
    const A = window.VectorAdmin;
    const $ = (id) => document.getElementById(id);
    let progressRows = [];
    let weeklyRows = [];
    let progressSeq = 0;
    let weekSeq = 0;
    let notesSeq = 0;
    let repsSig = null;
    let targetInputs = new Map();   // seat id -> { calls, connected_calls, talk_minutes } inputs
    let busy = false;

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
    const cell = (text, cls, label) => el('td', { text: text === null || text === undefined ? '' : String(text), className: cls || '', 'data-label': label || '' });
    const button = (text, onClick, cls) => el('button', { type: 'button', text, onClick, className: cls || '' });

    // Calls the RPC through the page's client. A missing function becomes the plain "not available yet" message.
    async function rpc(name, args) {
      try { return await A.rpc(name, args); } catch (err) {
        if (isMissing(err)) throw new Error(NOT_YET);
        throw err;
      }
    }
    function isMissing(err) {
      const m = String((err && err.message) || '');
      return !!err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function|function .* does not exist/i.test(m));
    }
    // Shows a load or save failure in a panel: the plain message when the function is missing, otherwise the error text.
    function report(id, err, prefix) {
      if (err && err.message === NOT_YET) say(id, NOT_YET, false);
      else say(id, (prefix || '') + (err && err.message ? err.message : 'Try again.'), true);
    }
    function context() {
      const s = A.session();
      return { institute: s.instituteId, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
    }
    const reps = () => H.repSeats(A.seats());

    function download(text, name) {
      const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ----- weekly summary -----

    function snapWeek() {
      const start = H.weekStart($('week-start').value);
      if (start) $('week-start').value = start;
      return start;
    }

    async function loadWeek() {
      const start = snapWeek();
      if (!start) { say('week-msg', 'Pick a date in the week you want.', true); return; }
      const seq = ++weekSeq;
      const c = context();
      say('week-msg', 'Loading...');
      try {
        const rows = (await rpc('admin_weekly_summary', { p_institute: c.institute, p_week_start: start, p_tz: c.tz })) || [];
        if (seq !== weekSeq) return;
        weeklyRows = rows;
        renderWeek();
        say('week-msg', 'Week starting Monday ' + start + ', days in ' + c.tz + '.');
      } catch (err) {
        if (seq !== weekSeq) return;
        weeklyRows = [];
        renderWeek();
        report('week-msg', err, 'Could not load: ');
      }
    }

    function renderWeek() {
      const head = $('week-head');
      const body = $('week-body');
      head.textContent = '';
      body.textContent = '';
      const cols = H.summaryColumns(weeklyRows);
      $('week-table').hidden = cols.length === 0;
      $('week-empty').hidden = weeklyRows.length > 0;
      head.appendChild(el('tr', null, cols.map((k) => el('th', {
        text: H.headerText(k),
        className: typeof weeklyRows[0][k] === 'number' ? 'num' : '',
      }))));
      weeklyRows.forEach((r) => {
        body.appendChild(el('tr', null, cols.map((k) => cell(r[k], typeof r[k] === 'number' ? 'num' : '', H.headerText(k)))));
      });
    }

    function downloadWeekCsv() {
      if (!weeklyRows.length) { say('week-msg', 'No activity in this week, so nothing to download.', true); return; }
      const cols = H.summaryColumns(weeklyRows);
      const csv = H.toCsv(cols.map(H.headerText), weeklyRows.map((r) => cols.map((k) => r[k])));
      download(csv, 'vector-weekly-summary-' + $('week-start').value + '.csv');
    }

    // ----- rep progress and not calling -----

    async function loadProgress() {
      const day = $('progress-day').value;
      if (!H.parseYmd(day)) { say('progress-msg', 'Pick a day.', true); return; }
      const seq = ++progressSeq;
      const c = context();
      say('progress-msg', 'Loading...');
      try {
        const rows = (await rpc('admin_rep_progress', { p_institute: c.institute, p_day: day, p_tz: c.tz })) || [];
        if (seq !== progressSeq) return;
        progressRows = rows;
        renderProgress();
        setTargetPlaceholders();
        say('progress-msg', 'Showing ' + day + ' in ' + c.tz + '.');
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
        fill.style.width = H.barPercent(v, t) + '%';
        td.appendChild(el('div', { className: 'bar', role: 'img', 'aria-label': H.percentOfTarget(v, t) + '% of target' }, [fill]));
        td.appendChild(el('div', { text: H.percentOfTarget(v, t) + '% of target', className: 'muted small' }));
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
      const idle = H.notCalling(progressRows);
      idle.forEach((r) => list.appendChild(el('li', { text: r.label })));
      $('idle-text').textContent = !progressRows.length ? '' :
        idle.length ? idle.length + ' rep seat' + (idle.length === 1 ? ' has' : 's have') + ' no calls on this day.'
          : 'Every rep seat made at least one call on this day.';
    }

    // ----- daily targets -----

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
            type: 'number', min: '0', max: String(H.TARGET_MAX), step: '1', inputmode: 'numeric',
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
        const r = H.parseTarget(inputs[f.metric].value);
        if (!r.ok) { say('target-msg', r.error + ' (' + f.name + ', ' + s.label + ')', true); return; }
        if (r.value !== null) changes.push({ metric: f.metric, name: f.name, value: r.value });
      }
      if (!changes.length) { say('target-msg', 'Type a target in at least one box for ' + s.label + '.', true); return; }
      say('target-msg', '');
      const list = changes.map((c) => c.name + ' ' + c.value).join(', ');
      A.confirm({
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
      });
    }

    // ----- supervisor notes -----

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
      if (!H.parseYmd(day)) { say('notes-msg', 'Pick a day.', true); return; }
      const seq = ++notesSeq;
      const c = context();
      say('notes-msg', 'Loading...');
      try {
        const rows = (await rpc('list_supervisor_notes', { p_institute: c.institute, p_seat: seat, p_from: day, p_to: day })) || [];
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
      const r = H.noteCheck($('note-text').value);
      const typed = Array.from($('note-text').value.trim()).length;
      $('note-count').textContent = typed + ' of ' + H.NOTE_MAX + ' characters';
      $('note-count').classList.toggle('error', typed > H.NOTE_MAX);
      $('note-add').disabled = busy || !r.ok;
    }

    async function addNote(e) {
      e.preventDefault();
      const seat = $('notes-rep').value;
      const day = $('notes-day').value;
      if (!seat) { say('note-msg', 'There are no active reps to add a note for.', true); return; }
      if (!H.parseYmd(day)) { say('note-msg', 'Pick a day.', true); return; }
      const r = H.noteCheck($('note-text').value);
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

    // ----- password reset for the signed-in admin -----

    async function sendReset() {
      const email = A.session().email;
      if (!email) { say('reset-msg', 'Sign in again to send a reset link.', true); return; }
      const btn = $('reset-send');
      btn.disabled = true;
      try {
        const { error } = await A.client().auth.resetPasswordForEmail(email, {
          redirectTo: new URL('reset.html', location.href).href,   // reset.html asks for the new password
        });
        if (error) throw error;
        say('reset-msg', 'Reset link requested for ' + email + '. Check that inbox for the link.');
      } catch (err) {
        say('reset-msg', 'Could not send the reset link: ' + (err && err.message ? err.message : 'try again.'), true);
      } finally {
        btn.disabled = false;
      }
    }

    // ----- wiring -----

    // admin.js calls this after each load of the team data, which can change the rep list.
    function onLoaded() {
      fillRepSelect($('notes-rep'));
      renderTargetRows();
      setTargetPlaceholders();
    }

    function init() {
      const today = new Date();
      $('progress-day').value = H.ymd(today);
      $('notes-day').value = H.ymd(today);
      $('week-start').value = H.weekStart(today);
      $('progress-form').addEventListener('submit', (e) => { e.preventDefault(); loadProgress(); });
      $('week-form').addEventListener('submit', (e) => { e.preventDefault(); loadWeek(); });
      $('week-start').addEventListener('change', snapWeek);
      $('week-csv').addEventListener('click', downloadWeekCsv);
      $('notes-form').addEventListener('submit', (e) => { e.preventDefault(); loadNotes(); });
      $('note-form').addEventListener('submit', addNote);
      $('note-text').addEventListener('input', updateNoteCount);
      $('reset-send').addEventListener('click', sendReset);
      document.addEventListener('vector-admin:loaded', onLoaded);
      updateNoteCount();
      onLoaded();
    }

    init();
  }
})();
