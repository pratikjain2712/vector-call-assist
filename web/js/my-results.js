/* The rep's own results for the last 7 days: lost calls by reason and by stage, and the changes the team
   approved. Reads only this rep's calls, through the rep_loss_summary function. Hidden until the rep is
   signed in with an active seat. */
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

  function render(d) {
    body.textContent = '';
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

  async function load() {
    if (busy || !Cloud.enabled || !Cloud.hasSeat()) return;
    busy = true;
    try {
      var to = new Date(), from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      var res = await Cloud.rpc('rep_loss_summary', { p_from: from.toISOString(), p_to: to.toISOString() });
      if (res.error || !res.data) { box.hidden = true; return; }
      render(res.data);
      box.hidden = false;
    } catch (e) {
      box.hidden = true;
    } finally {
      busy = false;
    }
  }

  Cloud.onChange(load);
  setInterval(load, 60000);
  setTimeout(load, 1500);
})();
