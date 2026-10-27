'use strict';
/* Centres and batches in the admin app (migration 20261027100000_centres_batches.sql).
   - The centre switcher in the top bar: "All centres ▾", or the person's one centre as plain text. Remembered per
     login in this browser (try/catch: a private window just starts at "All centres"). Shown only when the
     institute has an active centre (centres_list().has_centres), so an institute without centres sees nothing new.
   - withCentre(name, args, centre): the arguments of an RPC with the picked centre added. shell.js runs every
     ctx.rpc through it, so every tab (Today, Fees, Calling, Team, Reports, Autopilot) gets the centre without
     code of its own. The database has a second function of each name with p_centre (all the old arguments
     needed), so the missing ones are filled in with their defaults here. "All centres" sends the old call.
   - batchesFor / batchOptions: the batch picker where lists show students.
   The pure helpers are also loaded by tests/web/centres.test.js (Node, no DOM). */
(function (root) {
  const STORE_KEY = 'vector-admin-centre';

  // RPC name -> the arguments the centre version needs besides p_centre (filled with DEFAULTS or null).
  const CENTRE_RPCS = {
    admin_fees_ledger: ['p_institute', 'p_from', 'p_to', 'p_campaign', 'p_seat'],
    admin_promises_ledger: ['p_institute', 'p_campaign', 'p_seat', 'p_days'],
    admin_home_ledger: ['p_day', 'p_campaign'],
    admin_home_summary: ['p_day', 'p_campaign'],
    autopilot_numbers: [],
    my_suggestions: [],
    admin_campaign_list: [],
    admin_callers: ['p_institute'],
    ledger_day_closing: ['p_institute', 'p_day'],
    ledger_collected: ['p_institute', 'p_from', 'p_to'],
    accounts_create_fees_campaign: ['p_name', 'p_class_label', 'p_board', 'p_due_by', 'p_min_due', 'p_script', 'p_open_to_all', 'p_start'],
    admin_add_leads: ['p_campaign', 'p_rows'],
  };
  const DEFAULTS = { p_days: 7, p_day: 'today', p_min_due: 0, p_open_to_all: true, p_start: true };

  // The arguments with the centre. Unchanged when no centre is picked, for an RPC without a centre, or when the
  // caller already chose p_centre. accounts_students takes it in p_filters.centre_id.
  function withCentre(name, args, centre) {
    if (!centre) return args;
    if (name === 'accounts_students') {
      const a = Object.assign({}, args || {});
      a.p_filters = Object.assign({}, a.p_filters || {});
      if (!a.p_filters.centre_id) a.p_filters.centre_id = centre;
      return a;
    }
    const keys = CENTRE_RPCS[name];
    if (!keys) return args;
    const a = Object.assign({}, args || {});
    if (Object.prototype.hasOwnProperty.call(a, 'p_centre')) return a;
    keys.forEach((k) => { if (a[k] === undefined) a[k] = Object.prototype.hasOwnProperty.call(DEFAULTS, k) ? DEFAULTS[k] : null; });
    a.p_centre = centre;
    return a;
  }

  // centres_list() in one shape: { has, centres (active, in order), all (every centre), batches (active),
  // mine (the person's centre ids, or null = every centre) }.
  function normalise(data) {
    const d = data || {};
    const all = Array.isArray(d.centres) ? d.centres : [];
    const mine = Array.isArray(d.my_centre_ids) && d.my_centre_ids.length ? d.my_centre_ids.map(String) : null;
    return {
      has: !!d.has_centres && all.some((c) => c.active),
      all,
      centres: all.filter((c) => c.active && (!mine || mine.includes(String(c.id)))),
      batches: (Array.isArray(d.batches) ? d.batches : []).filter((b) => b.active),
      allBatches: Array.isArray(d.batches) ? d.batches : [],
      mine,
    };
  }

  // The switcher: [{ value, label }] ('' = all the person may see), or one fixed centre for a person limited
  // to one. Returns { fixed: centre or null, options }.
  function switchOptions(info) {
    const x = info || normalise(null);
    if (!x.has) return { fixed: null, options: [] };
    if (x.mine && x.centres.length === 1) return { fixed: x.centres[0], options: [] };
    const options = [{ value: '', label: x.mine ? 'All my centres' : 'All centres' }]
      .concat(x.centres.map((c) => ({ value: String(c.id), label: c.name })));
    return { fixed: null, options };
  }

  // The centre to start with: the remembered one when the person may still pick it, else the fixed one, else ''.
  const keyFor = (who) => STORE_KEY + (who ? ':' + String(who).toLowerCase() : '');
  function readCentre(store, who, info) {
    const sw = switchOptions(info);
    if (sw.fixed) return String(sw.fixed.id);
    let v = '';
    try { v = (store && store.getItem(keyFor(who))) || ''; } catch (err) { v = ''; }
    return sw.options.some((o) => o.value === v) ? v : '';
  }
  function writeCentre(store, who, id) {
    try {
      if (!store) return false;
      if (id) store.setItem(keyFor(who), String(id)); else store.removeItem(keyFor(who));
      return true;
    } catch (err) { return false; }
  }

  // Active batches of a centre ('' or null = every centre): the centre's batches and batches of every centre.
  function batchesFor(batches, centre) {
    return (batches || []).filter((b) => b.active !== false && (!centre || !b.centre_id || String(b.centre_id) === String(centre)))
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true }));
  }

  const centreName = (info, id) => {
    const c = ((info && info.all) || []).find((x) => String(x.id) === String(id));
    return c ? c.name : '';
  };

  // ---------- browser: the switcher in the top bar ----------
  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v === undefined || v === null) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else if (k === 'value') node.value = v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  // Draws the switcher into host. current: the picked id ('' = all); onPick(id) when the person switches.
  function mountSwitch(host, info, current, onPick) {
    host.textContent = '';
    const sw = switchOptions(info);
    if (!info || !info.has) { host.hidden = true; return; }
    host.hidden = false;
    if (sw.fixed) {
      host.appendChild(el('span', { className: 'centre-fixed', id: 'centre-fixed', title: 'Your centre' }, [sw.fixed.name]));
      return;
    }
    const sel = el('select', { id: 'centre-switch', 'aria-label': 'Centre: switch to see another centre' });
    sw.options.forEach((o) => sel.appendChild(el('option', { value: o.value, text: o.label })));
    sel.value = current || '';
    sel.addEventListener('change', () => onPick(sel.value));
    host.appendChild(sel);
  }

  // A batch picker (select) for a list of students: hidden when the centre has no batches. onChange(id).
  function batchPicker(id, info, centre, value, onChange) {
    const list = batchesFor(info && info.batches, centre);
    const sel = el('select', { id, 'aria-label': 'Batch' }, [el('option', { value: '', text: 'All batches' })]
      .concat(list.map((b) => el('option', { value: String(b.id), text: b.name }))));
    sel.value = list.some((b) => String(b.id) === String(value)) ? String(value) : '';
    sel.hidden = list.length === 0;
    if (onChange) sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  // ---------- browser: Settings > Centres and batches ----------
  // Owner: add, rename and turn off centres; add and change batches. Without centres the section is an
  // advanced option (shown with "Show advanced options"), so an institute with one place sees nothing new.
  const BOARDS = ['CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other'];
  function settings(section, ctx) {
    const $ = (id) => document.getElementById(id);
    const say = (id, text, bad) => { const n = $(id); if (n) { n.textContent = text || ''; n.classList.toggle('error', !!bad); } };
    let info = null;
    section.textContent = '';
    section.appendChild(el('h2', { text: 'Centres and batches' }));
    section.appendChild(el('p', { className: 'muted small', text: 'Your branches (centres) and batches. Staff who work in some centres only see those: Team → Edit → Works in.' }));
    section.appendChild(el('ul', { id: 'cb-centres', className: 'plain cb-list' }));
    const addC = el('form', { id: 'cb-add-centre', className: 'row wrap' }, [
      el('label', null, ['New centre', el('input', { id: 'cb-centre-name', type: 'text', maxlength: '60', placeholder: 'Andheri', required: 'required' })]),
      el('label', null, ['Short code', el('input', { id: 'cb-centre-code', type: 'text', maxlength: '8', placeholder: 'AND' })]),
      el('button', { type: 'submit', text: 'Add centre' }),
    ]);
    section.appendChild(addC);
    section.appendChild(el('p', { id: 'cb-centre-msg', className: 'msg', role: 'status' }));
    section.appendChild(el('h3', { text: 'Batches' }));
    section.appendChild(el('ul', { id: 'cb-batches', className: 'plain cb-list' }));
    const centreSel = el('select', { id: 'cb-batch-centre' });
    const boardSel = el('select', { id: 'cb-batch-board' }, [el('option', { value: '', text: 'Any board' })].concat(BOARDS.map((x) => el('option', { value: x, text: x }))));
    const addB = el('form', { id: 'cb-add-batch', className: 'row wrap' }, [
      el('label', null, ['New batch', el('input', { id: 'cb-batch-name', type: 'text', maxlength: '60', placeholder: '8th SB Morning', required: 'required' })]),
      el('label', null, ['Centre', centreSel]),
      el('label', null, ['Class', el('input', { id: 'cb-batch-class', type: 'text', maxlength: '20', placeholder: '8th' })]),
      el('label', null, ['Board', boardSel]),
      el('label', null, ['Timing', el('input', { id: 'cb-batch-timing', type: 'text', maxlength: '60', placeholder: '7–9 am' })]),
      el('button', { type: 'submit', text: 'Add batch' }),
    ]);
    section.appendChild(addB);
    section.appendChild(el('p', { id: 'cb-batch-msg', className: 'msg', role: 'status' }));

    const owner = (ctx.seat && (ctx.seat.admin_kind === 'owner' || (ctx.seat.role === 'admin' && !ctx.seat.admin_kind)));
    addC.hidden = !owner;
    addB.hidden = !owner;

    async function load() {
      try { info = normalise(await ctx.rpc('centres_list')); } catch (err) {
        if (ctx.isMissing && ctx.isMissing(err)) { section.hidden = true; return; }   // an older database
        say('cb-centre-msg', 'Could not load the centres: ' + err.message, true);
        return;
      }
      section.classList.toggle('adv', !info.has);
      draw();
    }
    function draw() {
      const list = $('cb-centres');
      list.textContent = '';
      if (!info.all.length) list.appendChild(el('li', { className: 'muted', text: 'No centres yet. One place? You need none.' }));
      info.all.forEach((c) => {
        const name = el('span', { className: 'cb-name' + (c.active ? '' : ' muted') },
          [c.name + (c.short_code ? ' (' + c.short_code + ')' : '') + (c.active ? '' : ' · off')]);
        const count = el('span', { className: 'muted small', text: c.students === null || c.students === undefined ? '' : c.students + ' students' });
        const row = el('li', { className: 'cb-row', 'data-centre': String(c.id) }, [name, count]);
        if (owner) {
          const ren = el('button', { type: 'button', className: 'linkish', text: 'Rename' });
          ren.addEventListener('click', () => renameRow(row, c));
          const tog = el('button', { type: 'button', className: 'linkish', text: c.active ? 'Turn off' : 'Turn on' });
          tog.addEventListener('click', () => saveCentre(c.id, c.name, c.short_code, !c.active));
          row.appendChild(el('span', { className: 'cb-acts' }, [ren, tog]));
        }
        list.appendChild(row);
      });
      centreSel.textContent = '';
      centreSel.appendChild(el('option', { value: '', text: 'Every centre' }));
      info.all.filter((c) => c.active).forEach((c) => centreSel.appendChild(el('option', { value: String(c.id), text: c.name })));
      const bl = $('cb-batches');
      bl.textContent = '';
      if (!info.allBatches.length) bl.appendChild(el('li', { className: 'muted', text: 'No batches yet.' }));
      info.allBatches.forEach((b) => {
        const where = b.centre_id ? centreName(info, b.centre_id) : 'Every centre';
        const row = el('li', { className: 'cb-row', 'data-batch': String(b.id) }, [
          el('span', { className: 'cb-name' + (b.active ? '' : ' muted'), text: b.name + (b.active ? '' : ' · off') }),
          el('span', { className: 'muted small', text: [where, b.class_label, b.board, b.timing,
            b.students === null || b.students === undefined ? '' : b.students + ' students'].filter(Boolean).join(' · ') }),
        ]);
        if (owner) {
          const tog = el('button', { type: 'button', className: 'linkish', text: b.active ? 'Turn off' : 'Turn on' });
          tog.addEventListener('click', () => saveBatch(b.id, { active: !b.active }));
          row.appendChild(el('span', { className: 'cb-acts' }, [tog]));
        }
        bl.appendChild(row);
      });
    }
    function renameRow(row, c) {
      row.textContent = '';
      const inp = el('input', { type: 'text', maxlength: '60', value: c.name, 'aria-label': 'New name of ' + c.name });
      const ok = el('button', { type: 'button', text: 'Save' });
      const no = el('button', { type: 'button', className: 'linkish', text: 'Cancel' });
      ok.addEventListener('click', () => saveCentre(c.id, inp.value, c.short_code, c.active));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } if (e.key === 'Escape') draw(); });
      no.addEventListener('click', draw);
      row.appendChild(el('span', { className: 'row' }, [inp, ok, no]));
      inp.focus();
    }
    async function saveCentre(id, name, code, active) {
      try {
        await ctx.rpc('admin_save_centre', { p_id: id || null, p_name: name, p_short_code: code || null, p_active: active });
        say('cb-centre-msg', id ? 'Saved. Sign in again (or reload) to see it in the centre switcher.' : 'Centre added. Reload the page to see the centre switcher at the top.');
        await load();
      } catch (err) { say('cb-centre-msg', 'Not saved: ' + err.message, true); }
    }
    async function saveBatch(id, data) {
      try {
        await ctx.rpc('admin_save_batch', { p_id: id || null, p_data: data });
        say('cb-batch-msg', id ? 'Saved.' : 'Batch added.');
        await load();
      } catch (err) { say('cb-batch-msg', 'Not saved: ' + err.message, true); }
    }
    addC.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('cb-centre-name').value.trim();
      if (!name) { say('cb-centre-msg', 'Write the centre\'s name.', true); return; }
      await saveCentre(null, name, $('cb-centre-code').value.trim(), true);
      if (!$('cb-centre-msg').classList.contains('error')) { $('cb-centre-name').value = ''; $('cb-centre-code').value = ''; }
    });
    addB.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('cb-batch-name').value.trim();
      if (!name) { say('cb-batch-msg', 'Write the batch\'s name.', true); return; }
      await saveBatch(null, { name, centre_id: centreSel.value || '', class_label: $('cb-batch-class').value, board: boardSel.value,
        timing: $('cb-batch-timing').value });
      if (!$('cb-batch-msg').classList.contains('error')) ['cb-batch-name', 'cb-batch-class', 'cb-batch-timing'].forEach((x) => { $(x).value = ''; });
    });
    load();
  }

  const api = { STORE_KEY, CENTRE_RPCS, DEFAULTS, withCentre, normalise, switchOptions, keyFor, readCentre, writeCentre,
    batchesFor, centreName, mountSwitch, batchPicker, settings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VectorCentres = api;
})(typeof window !== 'undefined' ? window : globalThis);
