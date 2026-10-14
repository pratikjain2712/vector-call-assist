'use strict';
/* Admin page, coaching and leaderboard (web/admin.html). Both follow the date range at the top of the page:
   they reload whenever js/admin.js finishes a load ('vector-admin:loaded').
   - Coaching: admin_coaching_suggestions compares each rep with the whole team and returns at most two
     suggestions per rep. "Send to rep" calls admin_send_coaching_tip, which works out the figures and the
     rep's text in the database. admin_coaching_tips lists the tips sent, with the rep's figure since then.
   - Leaderboard: team_leaderboard returns each active rep's calls, connected calls, won calls and talk
     minutes; the ranking is done here. admin_set_leaderboard_for_reps turns it on or off for reps.
   Only labels, counts and the texts the database builds are shown. The pure helpers below are also loaded
   by tests/web/admin-coach.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------
  const NOT_YET = 'not available yet';
  const NOTE_MAX = 300;
  const METRICS = [
    { key: 'won', name: 'Won', unit: 'won' },
    { key: 'connected', name: 'Connected', unit: 'connected' },
    { key: 'calls', name: 'Calls', unit: 'calls' },
    { key: 'talk_minutes', name: 'Talk time', unit: 'min' },
  ];

  const pad2 = (n) => String(n).padStart(2, '0');

  // Inclusive 'YYYY-MM-DD' dates to the [from, to) instants the functions take, in local time.
  function rangeIso(fromYmd, toYmd) {
    const p = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return d.getMonth() === Number(m[2]) - 1 ? d : null;
    };
    const a = p(fromYmd), b = p(toYmd);
    if (!a || !b || b < a) return null;
    const end = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
    return { from: a.toISOString(), to: end.toISOString() };
  }

  // What a coaching key measures, in a few words.
  function keyLabel(key) {
    const k = String(key || '');
    if (k === 'connect') return 'Connect rate';
    if (k === 'reason_missing') return 'Loss reasons picked';
    if (k.indexOf('stage:') === 0) return 'Lost at the ' + k.slice(6) + ' step';
    if (k.indexOf('objection:') === 0) return 'Lost on "' + k.slice(10) + '"';
    return k;
  }

  // A figure for a key as the admin reads it. reason_missing is stored as "missing per 100 lost calls" and
  // shown as the share picked, so a higher number is better for both connect and reasons.
  function figure(key, value) {
    if (value === null || value === undefined || value === '') return '–';
    const v = Number(value);
    if (!isFinite(v)) return '–';
    if (key === 'connect') return Math.round(v) + '%';
    if (key === 'reason_missing') return Math.round(100 - v) + '% picked';
    return Math.round(v) + ' per 100 calls';
  }

  // The result of a sent tip as short text, and a class for its colour.
  function tipResult(row) {
    const r = row && row.result;
    const need = row && row.tip_key === 'reason_missing' ? 5 : 10;
    if (r === 'improved') return { text: 'Improved', cls: 'ok' };
    if (r === 'worse') return { text: 'Worse', cls: 'bad' };
    if (r === 'same') return { text: 'No change yet', cls: 'muted' };
    const n = Number(row && row.after_calls) || 0;
    return { text: 'Waiting: ' + Math.min(n, need) + ' of ' + need + (row && row.tip_key === 'reason_missing' ? ' lost calls' : ' calls'), cls: 'muted' };
  }

  // Leaderboard rows ranked on one metric, highest first, ties share a rank and are ordered by label.
  // Each row gets rank, value, pct (of the top value, for the bar) and top (rank 1 with a value above 0).
  function rankBoard(rows, metric) {
    const list = (Array.isArray(rows) ? rows : []).map((r) => ({
      label: String(r.label || ''), me: !!r.me, value: Math.max(0, Number(r[metric]) || 0),
    }));
    list.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
    const max = list.length ? list[0].value : 0;
    let rank = 0, prev = null;
    list.forEach((r, i) => {
      if (r.value !== prev) { rank = i + 1; prev = r.value; }
      r.rank = rank;
      r.pct = max > 0 ? Math.round((r.value / max) * 100) : 0;
      r.top = rank === 1 && r.value > 0;
    });
    return list;
  }

  function noteCheck(text) {
    const t = String(text || '').trim();
    if (t.length > NOTE_MAX) return { ok: false, text: t, error: 'A note is at most ' + NOTE_MAX + ' characters.' };
    return { ok: true, text: t };
  }

  function shortDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  const helpers = { NOT_YET, NOTE_MAX, METRICS, rangeIso, keyLabel, figure, tipResult, rankBoard, noteCheck, shortDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;   // loaded by a test, not by the page

  if (window.VectorAdmin) initPage(helpers);
  else document.addEventListener('vector-admin:ready', () => initPage(helpers), { once: true });

  // ---------- page ----------
  function initPage(H) {
    const A = window.VectorAdmin;
    const $ = (id) => document.getElementById(id);
    let suggestions = [];
    let tips = [];
    let boardRows = [];
    let boardForReps = true;
    let metric = 'won';
    let seq = 0;

    const say = (id, text, isError) => {
      const node = $(id);
      node.textContent = text || '';
      node.classList.toggle('error', !!isError);
    };
    // Builds an element from text and child nodes only: no HTML strings.
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

    function isMissing(err) {
      const m = String((err && err.message) || '');
      return !!err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function|function .* does not exist/i.test(m));
    }
    async function rpc(name, args) {
      try { return await A.rpc(name, args); } catch (err) {
        if (isMissing(err)) throw new Error(H.NOT_YET);
        throw err;
      }
    }
    function report(id, err, prefix) {
      if (err && err.message === H.NOT_YET) say(id, H.NOT_YET, false);
      else say(id, (prefix || '') + (err && err.message ? err.message : 'Try again.'), true);
    }
    const institute = () => A.session().instituteId;
    const range = () => H.rangeIso($('from').value, $('to').value);

    // ----- load both panels for the page's date range -----

    async function loadAll() {
      const r = range();
      if (!r || !institute()) return;
      const mine = ++seq;
      say('coach-msg', 'Loading...');
      say('board-msg', 'Loading...');
      const [s, t, b] = await Promise.allSettled([
        rpc('admin_coaching_suggestions', { p_institute: institute(), p_from: r.from, p_to: r.to }),
        rpc('admin_coaching_tips', { p_institute: institute() }),
        rpc('team_leaderboard', { p_from: r.from, p_to: r.to }),
      ]);
      if (mine !== seq) return;

      if (s.status === 'fulfilled') { suggestions = Array.isArray(s.value) ? s.value : []; say('coach-msg', ''); }
      else { suggestions = []; report('coach-msg', s.reason, 'Could not load suggestions: '); }
      if (t.status === 'fulfilled') tips = t.value || [];
      else { tips = []; if (s.status === 'fulfilled') report('coach-msg', t.reason, 'Could not load tips: '); }
      renderSuggestions();
      renderTips();

      if (b.status === 'fulfilled' && b.value) {
        boardRows = b.value.rows || [];
        boardForReps = b.value.for_reps !== false;
        say('board-msg', '');
      } else {
        boardRows = [];
        if (b.status === 'rejected') report('board-msg', b.reason, 'Could not load: ');
      }
      renderBoard();
    }

    // ----- coaching suggestions -----

    function renderSuggestions() {
      const list = $('coach-list');
      list.textContent = '';
      $('coach-empty').hidden = suggestions.length > 0 || $('coach-msg').classList.contains('error');
      suggestions.forEach((s) => {
        const note = el('input', { type: 'text', maxlength: String(H.NOTE_MAX), placeholder: 'Add a note for ' + s.label + ' (optional)', 'aria-label': 'Note for ' + s.label });
        const send = el('button', { type: 'button', text: s.sent_at ? 'Sent ' + H.shortDate(s.sent_at) : 'Send to ' + s.label });
        if (s.sent_at) { send.disabled = true; note.disabled = true; }
        const msg = el('p', { className: 'msg', role: 'status' });
        send.addEventListener('click', () => sendTip(s, note, send, msg));
        list.appendChild(el('li', { className: 'coach-item' }, [
          el('div', { className: 'coach-head' }, [
            el('strong', { text: s.label }),
            el('span', { className: 'tag', text: H.keyLabel(s.key) }),
          ]),
          el('p', { text: s.text }),
          el('p', { className: 'muted small', text: s.label + ': ' + H.figure(s.key, s.rep_value) + ' · team: ' + H.figure(s.key, s.team_value) + ' · ' + s.calls + (s.key === 'reason_missing' ? ' lost calls' : ' calls') }),
          el('div', { className: 'row coach-send' }, [note, send]),
          msg,
        ]));
      });
    }

    async function sendTip(s, noteInput, button, msg) {
      const r = range();
      const n = H.noteCheck(noteInput.value);
      if (!n.ok) { msg.textContent = n.error; msg.classList.add('error'); return; }
      if (!r) return;
      button.disabled = true;
      msg.classList.remove('error');
      msg.textContent = 'Sending...';
      try {
        await rpc('admin_send_coaching_tip', { p_seat: s.seat_id, p_key: s.key, p_from: r.from, p_to: r.to, p_note: n.text || null });
        msg.textContent = 'Sent. ' + s.label + ' will see it on their screen.';
        await loadAll();
      } catch (err) {
        button.disabled = false;
        msg.textContent = err && err.message === H.NOT_YET ? H.NOT_YET : 'Could not send: ' + (err && err.message ? err.message : 'try again.');
        msg.classList.add('error');
      }
    }

    // ----- tips sent, with before and after -----

    function renderTips() {
      const body = $('tips-body');
      body.textContent = '';
      $('tips-empty').hidden = tips.length > 0;
      tips.forEach((t) => {
        const res = H.tipResult(t);
        const tip = el('td', { 'data-label': 'Tip' }, [el('div', { text: H.keyLabel(t.tip_key) })]);
        if (t.admin_note) tip.appendChild(el('div', { className: 'muted small', text: 'Note: ' + t.admin_note }));
        body.appendChild(el('tr', null, [
          cell(t.label, '', 'Rep'),
          tip,
          cell(H.shortDate(t.sent_at), '', 'Sent'),
          cell(t.seen_at ? 'Yes' : 'Not yet', t.seen_at ? '' : 'muted', 'Read'),
          cell(H.figure(t.tip_key, t.baseline), 'num', 'Before'),
          cell(H.figure(t.tip_key, t.after_value), 'num', 'Since'),
          cell(res.text, 'result ' + res.cls, 'Result'),
        ]));
      });
    }

    // ----- leaderboard -----

    function renderBoard() {
      document.querySelectorAll('#board-metric button').forEach((b) => {
        b.setAttribute('aria-pressed', b.getAttribute('data-metric') === metric ? 'true' : 'false');
      });
      $('board-reps').checked = boardForReps;
      const list = $('board-list');
      list.textContent = '';
      const ranked = H.rankBoard(boardRows, metric);
      $('board-empty').hidden = ranked.length > 0;
      const unit = (H.METRICS.find((m) => m.key === metric) || H.METRICS[0]).unit;
      ranked.forEach((r) => {
        const fill = el('div', { className: 'bar-fill' + (r.top ? ' met' : '') });
        fill.style.width = r.pct + '%';
        const name = el('span', { className: 'board-name' }, [el('span', { text: r.label })]);
        if (r.top) name.appendChild(el('span', { className: 'tag top', text: 'Top' }));
        list.appendChild(el('li', { className: 'board-row' }, [
          el('span', { className: 'board-rank', text: '#' + r.rank }),
          name,
          el('div', { className: 'bar board-bar', role: 'img', 'aria-label': r.pct + '% of the top value' }, [fill]),
          el('span', { className: 'board-value', text: r.value + ' ' + unit }),
        ]));
      });
    }

    document.querySelectorAll('#board-metric button').forEach((b) => {
      b.addEventListener('click', () => { metric = b.getAttribute('data-metric'); renderBoard(); });
    });

    $('board-reps').addEventListener('change', async (e) => {
      const on = e.target.checked;
      e.target.disabled = true;
      say('board-msg', 'Saving...');
      try {
        await rpc('admin_set_leaderboard_for_reps', { p_institute: institute(), p_on: on });
        boardForReps = on;
        say('board-msg', on ? 'Reps can see the leaderboard.' : 'The leaderboard is hidden from reps. You still see it here.');
      } catch (err) {
        e.target.checked = !on;
        report('board-msg', err, 'Could not save: ');
      } finally {
        e.target.disabled = false;
      }
    });

    document.addEventListener('vector-admin:loaded', loadAll);
    loadAll();
  }
})();
