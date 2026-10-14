/* The rep's own results for the last 7 days: tips from the admin (my_coaching_tips, marked read with
   ack_coaching_tip), lost calls by reason and by stage and the changes the team approved (rep_loss_summary),
   and the team leaderboard (team_leaderboard, shown only while the admin allows it). Each part loads on its
   own; the panel stays hidden until the rep is signed in with an active seat and one part has loaded. */
(function () {
  'use strict';
  var box = document.getElementById('my-results');
  var body = document.getElementById('my-results-body');
  if (!box || !body || !window.Cloud) return;

  var REASON = {
    price: 'Price', timing: 'Timing', already_enrolled: 'Already enrolled', no_need: 'No need',
    wrong_person: 'Wrong person', other: 'Other', not_recorded: 'Reason not picked',
  };
  var STAGE = { Opening: 'Opening', Discovery: 'Discovery', Pitch: 'Pitch', Timings: 'Timings', Fee: 'Fee', Close: 'Close', not_recorded: 'Stage not recorded' };
  var busy = false;

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function list(title, rows) {
    var wrap = el('div', null, 'myr-block');
    wrap.appendChild(el('h3', title));
    if (!rows.length) { wrap.appendChild(el('p', 'None yet.', 'hint')); return wrap; }
    var ul = el('ul', null, 'myr-list');
    rows.forEach(function (r) { ul.appendChild(el('li', r.label + ': ' + r.calls)); });
    wrap.appendChild(ul);
    return wrap;
  }

  // Ranks leaderboard rows on won calls, then connected calls; ties share a rank.
  function ranked(rows) {
    var list = (rows || []).map(function (r) {
      return { label: String(r.label || ''), me: !!r.me, won: Number(r.won) || 0, connected: Number(r.connected) || 0, calls: Number(r.calls) || 0 };
    });
    list.sort(function (a, b) { return b.won - a.won || b.connected - a.connected || a.label.localeCompare(b.label); });
    var rank = 0, prev = null;
    list.forEach(function (r, i) {
      var key = r.won + '/' + r.connected;
      if (key !== prev) { rank = i + 1; prev = key; }
      r.rank = rank;
    });
    return list;
  }

  function renderTips(tips) {
    var wrap = el('div', null, 'myr-block myr-tips');
    wrap.appendChild(el('h3', 'Tips from your admin'));
    tips.forEach(function (t) {
      var item = el('div', null, 'myr-tip' + (t.seen_at ? '' : ' unread'));
      item.appendChild(el('p', t.rep_text));
      if (t.admin_note) item.appendChild(el('p', 'Note: ' + t.admin_note, 'hint'));
      var foot = el('p', null, 'hint');
      foot.appendChild(document.createTextNode(t.sent_at ? new Date(t.sent_at).toLocaleDateString() : ''));
      if (!t.seen_at) {
        var ok = el('button', 'Got it', 'myr-ack');
        ok.type = 'button';
        ok.addEventListener('click', async function () {
          ok.disabled = true;
          try {
            var res = await Cloud.rpc('ack_coaching_tip', { p_tip: t.id });
            if (res.error) { ok.disabled = false; return; }
            t.seen_at = new Date().toISOString();
            item.classList.remove('unread');
            ok.remove();
          } catch (e) { ok.disabled = false; }
        });
        foot.appendChild(document.createTextNode(' '));
        foot.appendChild(ok);
      }
      item.appendChild(foot);
      wrap.appendChild(item);
    });
    return wrap;
  }

  // The top five, plus the rep's own row when it is lower down.
  function renderBoard(rows) {
    var wrap = el('div', null, 'myr-block myr-board');
    wrap.appendChild(el('h3', 'Team leaderboard, last 7 days'));
    var list = ranked(rows);
    if (!list.length) { wrap.appendChild(el('p', 'No reps yet.', 'hint')); return wrap; }
    var shown = list.slice(0, 5);
    var mine = list.filter(function (r) { return r.me; })[0];
    if (mine && shown.indexOf(mine) < 0) shown.push(mine);
    var ol = el('ol', null, 'myr-rank');
    shown.forEach(function (r) {
      var li = el('li', null, r.me ? 'me' : '');
      li.appendChild(el('span', '#' + r.rank, 'myr-pos'));
      li.appendChild(el('span', r.me ? r.label + ' (you)' : r.label, 'myr-who'));
      li.appendChild(el('span', r.won + ' won · ' + r.connected + ' connected', 'myr-num'));
      ol.appendChild(li);
    });
    wrap.appendChild(ol);
    return wrap;
  }

  function render(d, tips, board) {
    body.textContent = '';
    if (tips && tips.length) body.appendChild(renderTips(tips));
    if (d) renderSummary(d);
    if (board && board.visible) body.appendChild(renderBoard(board.rows));
  }

  function renderSummary(d) {
    var total = Number(d.calls) || 0, lost = Number(d.lost) || 0;
    if (!total) { body.appendChild(el('p', 'No calls in the last 7 days yet.', 'hint')); return; }
    body.appendChild(el('p', total + (total === 1 ? ' call' : ' calls') + ', ' + lost + ' not interested.'));
    body.appendChild(list('Why calls were lost',
      (d.reasons || []).map(function (r) { return { label: REASON[r.reason] || r.reason, calls: r.calls }; })));
    body.appendChild(list('Where lost calls ended',
      (d.stages || []).map(function (r) { return { label: STAGE[r.stage] || r.stage, calls: r.calls }; })));
    var changes = d.approved_changes || [];
    var block = el('div', null, 'myr-block');
    block.appendChild(el('h3', 'What the team changed'));
    if (!changes.length) block.appendChild(el('p', 'No changes approved yet.', 'hint'));
    changes.forEach(function (c) {
      var when = c.decided_at ? new Date(c.decided_at).toLocaleDateString() : '';
      block.appendChild(el('p', c.note + (when ? ' (' + when + ')' : '')));
    });
    body.appendChild(block);
  }

  // One call; resolves to its data, or null when it fails or the database does not have it yet.
  async function get(name, args) {
    try {
      var res = await Cloud.rpc(name, args);
      return res.error ? null : res.data;
    } catch (e) { return null; }
  }

  async function load() {
    if (busy || !Cloud.enabled || !Cloud.hasSeat()) return;
    busy = true;
    try {
      var range = { p_from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), p_to: new Date().toISOString() };
      var got = await Promise.all([get('rep_loss_summary', range), get('my_coaching_tips', {}), get('team_leaderboard', range)]);
      var summary = got[0], tips = Array.isArray(got[1]) ? got[1] : [], board = got[2];
      if (!summary && !tips.length && !(board && board.visible)) { box.hidden = true; return; }
      render(summary, tips, board);
      box.hidden = false;
    } finally {
      busy = false;
    }
  }

  Cloud.onChange(load);
  setInterval(load, 60000);
  setTimeout(load, 1500);
})();
