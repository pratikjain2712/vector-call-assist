'use strict';
/* Vector Autopilot in the admin app (docs/autopilot-plan.md, phase 1). window.VectorAutopilot:
   - today(parts, ctx, opts): the top of Today: three numbers against the goals ("Set goals" when there are none),
     "Needs your OK" (at most 3 cards: title, why with the numbers, expected result, Confirm / Change / Not now;
     Change opens the one-screen setup with every default shown and editable; Confirm shows a line with Undo for
     24 hours) and "Vector did for you" (since yesterday, with Why and Undo). Asks for a new plan
     (autopilot_plan) when the last one is 15 minutes old. Reads my_suggestions and autopilot_numbers; writes
     accept_suggestion, undo_suggestion, dismiss_suggestion. Without these functions (an older database) it
     says so through opts.onMissing and draws nothing.
   - setupForm(container, ctx, plan, opts): the one-screen setup (who, script, callers, call hours, daily target,
     end date, WhatsApp), shared by Today's Change and Calling's New calling list.
   - newList(container, ctx, opts): Calling's one-screen New calling list for fees from the ledger, filled in by
     autopilot_list_defaults; Confirm runs autopilot_create_list (with Undo for 24 hours on Today).
   - settings(container, ctx): Settings > Autopilot: goals, the three switches and "Pause all automation"
     (autopilot_get_settings, autopilot_save_settings, autopilot_save_goals).
   Sizes and fonts are the app's own (admin.css); styles in css/admin-autopilot.css. */
(function () {
  const S = window.VectorAdminShared;
  const M = window.VectorAutopilotModel;
  const el = S.el;
  const say = S.say;

  const missing = (ctx, err) => !!(ctx && ctx.isMissing && ctx.isMissing(err));
  const one = (data) => (Array.isArray(data) ? data[0] : data);
  const linkButton = (text, onClick, id) => el('button', { type: 'button', className: 'linkish', text, onClick, id: id || null });

  // ---------- the institute's live scripts (for the Script choice) ----------
  let scriptCache = null;
  async function liveScripts(ctx) {
    if (scriptCache && scriptCache.inst === ctx.institute.id) return scriptCache.rows;
    let rows = [];
    try {
      const { data, error } = await ctx.client.from('scripts').select('id, name, call_type_id, script_versions(version, published)')
        .eq('institute_id', ctx.institute.id);
      if (!error && Array.isArray(data)) rows = data.filter((s) => (s.script_versions || []).some((v) => v.published));
    } catch (err) { rows = []; }
    scriptCache = { inst: ctx.institute.id, rows };
    return rows;
  }

  // ---------- the one-screen setup ----------
  // plan: a suggestion's plan (or autopilot_list_defaults). opts: { prefix, kind, money }.
  // Returns { node, read(), problem() }: read() gives the form values for M.overrides.
  function setupForm(container, ctx, plan, opts) {
    const o = opts || {};
    const p = plan || {};
    const pre = o.prefix || 'ap-set';
    const kind = o.kind || 'fees_due_list';
    const listKind = kind === 'fees_due_list' || kind === 'new_list';
    const dl = el('dl', { className: 'ap-setup', id: pre });
    const row = (label, node, cls) => { dl.appendChild(el('div', { className: 'ap-row' + (cls ? ' ' + cls : '') }, [el('dt', { text: label }), el('dd', null, [node])])); };
    const f = {};

    if (listKind) {
      f.name = el('input', { type: 'text', id: pre + '-name', maxlength: '120', value: p.name || '' });
      row('Name', f.name);
      const who = M.classText(p.class_label, p.board);
      const whoText = S.count(p.parents || 0) + ' parent' + (Number(p.parents) === 1 ? '' : 's') + (who ? ' of ' + who : '') +
        (p.due_by ? ' who owe fees due ' + M.shortDate(p.due_by) : ' who owe fees') +
        (o.money && p.amount !== undefined && p.amount !== null ? ' (' + M.rupeesShort(p.amount) + ')' : '');
      row('Who', el('span', { id: pre + '-who', text: whoText }));
      f.script = el('select', { id: pre + '-script' }, [el('option', { value: p.script_id || '', text: p.script_name || 'No script' })]);
      row('Script', f.script);
      if (!p.script_id && p.template_name) {
        f.script.appendChild(el('option', { value: '', text: 'No script' }));
        f.script.options[0].textContent = 'No script yet (template: ' + p.template_name + ')';
      }
      liveScripts(ctx).then((rows) => {
        const keep = f.script.value;
        rows.filter((s) => !s.call_type_id || !p.call_type_id || s.call_type_id === p.call_type_id).forEach((s) => {
          if (![...f.script.options].some((x) => x.value === s.id)) f.script.appendChild(el('option', { value: s.id, text: s.name }));
        });
        if (![...f.script.options].some((x) => x.value === '')) f.script.appendChild(el('option', { value: '', text: 'No script' }));
        f.script.value = keep;
      });
    }

    const callerKey = kind === 'list_behind_pace' ? 'add_callers' : 'callers';
    const options = Array.isArray(p.caller_options) ? p.caller_options : [];
    const picked = new Set(Array.isArray(p[callerKey]) ? p[callerKey] : []);
    if (kind !== 'missed_promises' && kind !== 'setup_gaps') {
      const box = el('div', { className: 'ap-callers', id: pre + '-callers', role: 'group', 'aria-label': 'Focus callers' });
      options.forEach((c) => {
        const input = el('input', { type: 'checkbox', value: c.seat_id, checked: picked.has(c.seat_id), 'data-seat': c.seat_id });
        box.appendChild(el('label', { className: 'ap-caller', title: 'Score ' + c.score + ' · ' + (c.spare > 0 ? c.spare + ' calls a day free' : 'no free time') },
          [input, el('span', { text: c.label })]));
      });
      if (!options.length) box.appendChild(el('span', { className: 'muted', text: 'All callers' }));
      f.callers = box;
      row(kind === 'list_behind_pace' ? 'Add callers' : 'Callers', box);
      if (listKind) dl.appendChild(el('p', { className: 'muted small ap-note', text: 'They see this list first. Every caller can still call it.' }));
    }

    if (listKind || kind === 'list_behind_pace') {
      f.hour = el('select', { id: pre + '-hour' }, M.HOUR_CHOICES.map((c) => el('option', { value: c.value, text: c.label })));
      const h = p.hour === null || p.hour === undefined ? '' : String(p.hour);
      if (h && ![...f.hour.options].some((x) => x.value === h)) f.hour.appendChild(el('option', { value: h, text: M.hourRange(Number(h)) }));
      f.hour.value = h;
      row('Call hours', f.hour);
      f.target = el('input', { type: 'number', id: pre + '-target', min: '1', max: '10000', step: '1', inputmode: 'numeric',
        value: p.daily_target === null || p.daily_target === undefined ? '' : String(p.daily_target) });
      f.targetHint = el('span', { className: 'muted small', id: pre + '-target-hint' });
      row('Calls a day', el('span', { className: 'ap-inline' }, [f.target, f.targetHint]));
    }
    if (listKind) {
      f.end = el('input', { type: 'date', id: pre + '-end', value: p.end_date || '' });
      row('Ends', f.end);
      f.wa = el('input', { type: 'checkbox', id: pre + '-wa', checked: !!p.whatsapp, disabled: !p.whatsapp_available });
      row('WhatsApp', el('label', { className: 'check' }, [f.wa, el('span', { text: p.whatsapp_available ? 'Remind parents who agreed' : 'Not connected yet' })]));
    }

    const ids = () => (f.callers ? [...f.callers.querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value) : undefined);
    function syncHint() {
      if (!f.targetHint) return;
      const n = (ids() || []).length + (kind === 'list_behind_pace' ? 0 : 0);
      const t = Number(f.target.value);
      f.targetHint.textContent = t > 0 && n > 0 ? 'about ' + S.count(Math.ceil(t / n)) + ' each' : '';
    }
    if (f.callers) f.callers.addEventListener('change', syncHint);
    if (f.target) f.target.addEventListener('input', syncHint);
    syncHint();
    container.appendChild(dl);

    return {
      node: dl,
      read() {
        const out = {};
        if (f.name) out.name = f.name.value;
        if (f.callers && options.length) out[callerKey] = ids();
        if (f.script) out.script_id = f.script.value || null;
        if (f.hour) out.hour = f.hour.value;
        if (f.target) out.daily_target = f.target.value;
        if (f.end) out.end_date = f.end.value;
        if (f.wa) out.whatsapp = f.wa.checked;
        return out;
      },
      problem() {
        const v = this.read();
        return M.setupProblem({ name: v.name, daily_target: v.daily_target, end_date: v.end_date, today: p.start_date });
      },
    };
  }

  // ---------- Today ----------
  // parts: { numbers, ok, did } containers. opts: { onMissing(), skipKinds() }.
  function today(parts, ctx, opts) {
    const o = opts || {};
    let seq = 0;
    let last = null;
    let nums = null;
    let planning = false;

    async function load(force) {
      const mine = ++seq;
      let data;
      try { data = one(await ctx.rpc('my_suggestions')); } catch (err) {
        if (missing(ctx, err)) { if (o.onMissing) o.onMissing(); return; }
        say(parts.msg, 'Could not load what needs your OK: ' + err.message, true);
        return;
      }
      if (mine !== seq) return;
      last = data || {};
      // A new plan when the last one is 15 minutes old (or never ran). Idempotent on the server.
      if (!planning && (force || M.needsPlan(last.last_run_at))) {
        planning = true;
        try {
          await ctx.rpc('autopilot_plan', { p_institute: ctx.institute.id });
          data = one(await ctx.rpc('my_suggestions'));
          if (mine !== seq) return;
          last = data || {};
        } catch (err) { /* the cards already loaded stay */ } finally { planning = false; }
      }
      try { nums = one(await ctx.rpc('autopilot_numbers')); } catch (err) { nums = null; }
      if (mine !== seq) return;
      say(parts.msg, '');
      render();
    }

    function render() {
      renderNumbers();
      renderCards();
      renderFeed();
    }

    function renderNumbers() {
      const box = parts.numbers;
      box.textContent = '';
      if (!nums) { box.hidden = true; return; }
      box.hidden = false;
      const grid = el('div', { className: 'ap-nums' });
      M.numberTiles(nums, ctx.canSeeMoney).forEach((t) => {
        const state = M.tileState(t);
        const tile = el('div', { className: 'ap-num', 'data-key': t.key }, [
          el('div', { className: 'ap-num-label', text: t.label }),
          el('div', { className: 'ap-num-value', text: t.value }),
          el('div', { className: 'ap-num-sub', text: t.sub }),
        ]);
        if (t.goal !== null && t.pct !== null && t.key === 'fees') {
          const bar = el('div', { className: 'ap-bar', role: 'img', 'aria-label': t.pct + '% of ' + t.goal + '% goal' }, [el('div', { className: 'ap-bar-fill' }), el('div', { className: 'ap-bar-goal' })]);
          bar.firstChild.style.width = Math.min(100, t.pct) + '%';
          bar.lastChild.style.left = Math.min(100, t.goal) + '%';
          tile.appendChild(bar);
          tile.appendChild(el('div', { className: 'ap-num-goal ' + (state === 'on track' ? 'ok' : 'warn'), text: 'Goal ' + t.goal + '% · ' + state }));
        }
        grid.appendChild(tile);
      });
      box.appendChild(grid);
      if (!nums.goals_set && S.seatKind(ctx.seat) === 'owner') {
        box.appendChild(el('p', { className: 'ap-setgoals small' }, [el('a', { href: '#settings?autopilot=1', id: 'ap-set-goals', text: 'Set goals' }),
          el('span', { className: 'muted', text: ' to see these against your targets.' })]));
      }
    }

    function renderCards() {
      const list = parts.ok.querySelector('.ap-cards');
      const skip = typeof o.skipKinds === 'function' ? o.skipKinds() : [];
      const cards = M.visibleCards((last && last.cards) || [], { max: 3, skip });
      list.textContent = '';
      parts.ok.querySelector('.ap-count').textContent = cards.length ? String(cards.length) : '';
      parts.ok.querySelector('.ap-empty').hidden = cards.length > 0;
      if (last && last.paused) parts.ok.querySelector('.ap-empty').textContent = 'Automation is paused. Nothing needs your OK.';
      cards.forEach((c) => list.appendChild(card(c)));
    }

    function card(c) {
      const acts = M.actionsFor(c);
      const li = el('li', { className: 'ap-card', 'data-kind': c.kind, 'data-id': c.id });
      const body = el('div', { className: 'ap-card-body' }, [
        el('div', { className: 'ap-card-title', text: c.title }),
        el('p', { className: 'ap-why', text: M.whyText(c, ctx.canSeeMoney) }),
        M.impactText(c) ? el('p', { className: 'ap-impact', text: M.impactText(c) }) : null,
      ]);
      const change = el('div', { className: 'ap-change', hidden: true });
      let form = null;
      const msg = el('p', { className: 'msg', role: 'status' });
      const confirm = el('button', { type: 'button', className: 'primary ap-confirm', text: acts.confirm });
      const changeBtn = acts.change ? el('button', { type: 'button', className: 'ap-change-btn', text: 'Change', 'aria-expanded': 'false' }) : null;
      const later = el('button', { type: 'button', className: 'linkish ap-later', text: 'Not now' });
      li.appendChild(body);
      li.appendChild(change);
      li.appendChild(el('div', { className: 'ap-acts' }, [confirm, changeBtn, later]));
      li.appendChild(msg);

      if (changeBtn) changeBtn.addEventListener('click', () => {
        const open = change.hidden;
        change.hidden = !open;
        changeBtn.setAttribute('aria-expanded', String(open));
        if (open && !form) form = setupForm(change, ctx, c.plan, { prefix: 'ap-set-' + c.id.slice(0, 8), kind: c.kind, money: ctx.canSeeMoney });
      });
      confirm.addEventListener('click', async () => {
        if (c.kind === 'setup_gaps') { location.hash = (c.plan && c.plan.link) || '#settings'; return; }
        let ov = {};
        if (form && !change.hidden) {
          const problem = form.problem();
          if (problem) { say(msg, problem, true); return; }
          ov = M.overrides(c.plan, form.read());
        }
        confirm.disabled = true;
        say(msg, 'Working…');
        try {
          const out = one(await ctx.rpc('accept_suggestion', { p_id: c.id, p_overrides: ov }));
          done(li, out, (out && out.result && out.result.text) || 'Done.');
        } catch (err) {
          confirm.disabled = false;
          say(msg, err.message, true);
        }
      });
      later.addEventListener('click', async () => {
        later.disabled = true;
        try {
          await ctx.rpc('dismiss_suggestion', { p_id: c.id, p_snooze_days: 1 });
          li.remove();
          if (last) last.cards = (last.cards || []).filter((x) => x.id !== c.id);
          renderCards();
        } catch (err) { later.disabled = false; say(msg, err.message, true); }
      });
      return li;
    }

    // A confirmed card becomes one line: what was done, and Undo for 24 hours.
    function done(li, out, text) {
      li.textContent = '';
      li.classList.add('ap-done');
      const line = el('p', { className: 'ap-done-line' }, [el('span', { className: 'ap-tick', 'aria-hidden': 'true', text: '✓ ' }), el('span', { text })]);
      li.appendChild(line);
      if (out && out.can_undo) {
        const undo = linkButton('Undo', null, 'ap-undo-' + String(out.id).slice(0, 8));
        undo.classList.add('ap-undo');
        undo.addEventListener('click', () => doUndo(out.id, line, undo));
        line.appendChild(el('span', { text: ' ' }));
        line.appendChild(undo);
      }
    }

    async function doUndo(id, line, btn) {
      btn.disabled = true;
      try {
        const out = one(await ctx.rpc('undo_suggestion', { p_id: id }));
        line.textContent = '';
        line.appendChild(el('span', { className: 'muted', text: 'Undone. ' + ((out && out.text) || '') }));
      } catch (err) {
        btn.disabled = false;
        line.appendChild(el('span', { className: 'msg error', text: ' ' + err.message }));
      }
    }

    function renderFeed() {
      const items = ((last && last.feed) || []);
      parts.did.hidden = !items.length;
      const list = parts.did.querySelector('.ap-feed');
      list.textContent = '';
      items.slice(0, 6).forEach((it) => {
        const text = (it.result && it.result.text) || it.title;
        const why = String((it.why && it.why.text) || '');
        const whyP = el('p', { className: 'ap-feed-why muted small', hidden: true, text: why });
        const line = el('div', { className: 'ap-feed-line' }, [
          el('span', { className: 'ap-feed-text', text }),
          el('span', { className: 'ap-feed-when muted small', text: (it.by === 'you' ? 'You · ' : '') + M.whenText(it.done_at) }),
        ]);
        const acts = el('span', { className: 'ap-feed-acts' });
        if (why) {
          const b = linkButton('Why', () => { whyP.hidden = !whyP.hidden; b.setAttribute('aria-expanded', String(!whyP.hidden)); });
          b.setAttribute('aria-expanded', 'false');
          acts.appendChild(b);
        }
        if (it.can_undo) {
          const u = linkButton('Undo');
          u.classList.add('ap-undo');
          u.addEventListener('click', () => doUndo(it.id, line, u));
          acts.appendChild(u);
        }
        line.appendChild(acts);
        list.appendChild(el('li', { className: 'ap-feed-item', 'data-kind': it.kind }, [line, whyP]));
      });
    }

    return { load, render };
  }

  // ---------- Calling: one-screen New calling list ----------
  // opts: { classes, boards, onAdvanced(), onDone(out) }
  function newList(container, ctx, opts) {
    const o = opts || {};
    const head = el('div', { className: 'ap-new-pick row' }, [
      el('label', null, ['Class', el('select', { id: 'ap-new-class' }, [el('option', { value: '', text: 'All classes' })].concat((o.classes || []).map((c) => el('option', { value: c, text: c }))))]),
      el('label', null, ['Board', el('select', { id: 'ap-new-board' }, [el('option', { value: '', text: 'Any board' })].concat((o.boards || []).map((b) => el('option', { value: b, text: b }))))]),
      el('label', null, ['Fees due by', el('input', { type: 'date', id: 'ap-new-due' })]),
    ]);
    const body = el('div', { id: 'ap-new-body' });
    const msg = el('p', { className: 'msg', id: 'ap-new-msg', role: 'status' });
    const go = el('button', { type: 'button', className: 'primary', id: 'ap-new-confirm', text: 'Confirm' });
    const adv = linkButton('Change everything', () => o.onAdvanced && o.onAdvanced(), 'ap-new-advanced');
    container.appendChild(el('p', { className: 'muted small', text: 'Parents who owe fees, from the Fees tab. Vector fills in the rest; check it and confirm.' }));
    container.appendChild(head);
    container.appendChild(body);
    container.appendChild(el('div', { className: 'row ap-new-acts' }, [go, adv]));
    container.appendChild(msg);
    let plan = null;
    let form = null;
    let seq = 0;

    async function load() {
      const mine = ++seq;
      say(msg, 'Working out the plan…');
      go.disabled = true;
      try {
        const p = one(await ctx.rpc('autopilot_list_defaults', { p_call_type: 'fees', p_class_label: container.querySelector('#ap-new-class').value || null,
          p_board: container.querySelector('#ap-new-board').value || null, p_due_by: container.querySelector('#ap-new-due').value || null }));
        if (mine !== seq) return;
        plan = p || {};
        if (!container.querySelector('#ap-new-due').value && plan.due_by) container.querySelector('#ap-new-due').value = plan.due_by;
        body.textContent = '';
        form = setupForm(body, ctx, plan, { prefix: 'ap-new', kind: 'new_list', money: ctx.canSeeMoney });
        go.disabled = !(Number(plan.parents) > 0);
        say(msg, Number(plan.parents) > 0 ? '' : 'Nobody owes fees for that class and date.');
      } catch (err) {
        if (mine !== seq) return;
        if (missing(ctx, err)) { if (o.onAdvanced) o.onAdvanced(true); return; }
        say(msg, err.message, true);
      }
    }
    head.addEventListener('change', load);
    go.addEventListener('click', async () => {
      if (!plan || !form) return;
      const problem = form.problem();
      if (problem) { say(msg, problem, true); return; }
      const v = form.read();
      const send = Object.assign({}, plan, {
        name: String(v.name || '').trim(), callers: v.callers || plan.callers || [], script_id: v.script_id || null,
        hour: v.hour === '' ? null : Number(v.hour), daily_target: v.daily_target === '' ? null : Number(v.daily_target),
        end_date: v.end_date || plan.end_date, whatsapp: !!v.whatsapp,
      });
      delete send.caller_options;
      go.disabled = true;
      say(msg, 'Starting…');
      try {
        const out = one(await ctx.rpc('autopilot_create_list', { p_plan: send }));
        if (o.onDone) o.onDone(out);
      } catch (err) { go.disabled = false; say(msg, err.message, true); }
    });
    load();
    return { reload: load };
  }

  // ---------- Settings > Autopilot ----------
  function settings(container, ctx) {
    const msg = el('p', { className: 'msg', id: 'ap-settings-msg', role: 'status' });
    const sw = (id, text, help) => el('label', { className: 'switch ap-switch' }, [el('input', { type: 'checkbox', id, role: 'switch' }),
      el('span', null, [el('span', { text }), help ? el('span', { className: 'muted small ap-switch-help', text: help }) : null])]);
    const goals = el('form', { id: 'ap-goals', className: 'row wrap' }, [
      el('label', null, ['Fees collected by the due date (%)', el('input', { type: 'number', id: 'ap-goal-fees', min: '1', max: '100', step: '1', placeholder: '90' })]),
      el('label', null, ['Admissions this season', el('input', { type: 'number', id: 'ap-goal-adm', min: '1', max: '100000', step: '1', placeholder: '40' })]),
      el('button', { type: 'submit', id: 'ap-goals-save', text: 'Save goals' }),
    ]);
    container.appendChild(el('h2', { text: 'Autopilot' }));
    container.appendChild(el('p', { className: 'muted small', text: 'What Vector does for you. Everything it does shows on Today with Undo. Money, discounts and deleting always ask first.' }));
    const switches = el('div', { className: 'ap-switches' }, [
      sw('ap-sw-lists', 'Create calling lists for me', 'A week before fees are due.'),
      sw('ap-sw-reminders', 'Send reminders to parents who agreed', 'Missed promises go first; one WhatsApp reminder.'),
      sw('ap-sw-balance', 'Balance work between callers', 'Waiting enquiries and slow lists get free callers.'),
      sw('ap-sw-pause', 'Pause all automation', null),
    ]);
    container.appendChild(switches);
    container.appendChild(el('h3', { text: 'Goals' }));
    container.appendChild(goals);
    container.appendChild(msg);
    const $ = (id) => container.querySelector('#' + id);
    let owner = false;

    function fill(st) {
      const s = st || {};
      owner = !!s.is_owner;
      $('ap-sw-lists').checked = !!(s.toggles && s.toggles.lists);
      $('ap-sw-reminders').checked = !!(s.toggles && s.toggles.reminders);
      $('ap-sw-balance').checked = !!(s.toggles && s.toggles.balance);
      $('ap-sw-pause').checked = !!s.paused;
      const g = s.goals || {};
      $('ap-goal-fees').value = g.fees_pct || '';
      $('ap-goal-adm').value = g.admissions_target || '';
      container.querySelectorAll('input, button').forEach((x) => { x.disabled = !owner; });
      if (!owner) say(msg, 'Only the owner can change these.');
    }
    async function load() {
      try { fill(one(await ctx.rpc('autopilot_get_settings'))); } catch (err) {
        if (missing(ctx, err)) { container.hidden = true; return; }
        say(msg, 'Could not load Autopilot: ' + err.message, true);
      }
    }
    const MODES = {
      'ap-sw-lists': (on) => ({ fees_due_list: on ? 'auto' : 'ask' }),
      'ap-sw-reminders': (on) => ({ missed_promises: on ? 'auto' : 'ask' }),
      'ap-sw-balance': (on) => ({ enquiries_uncalled: on ? 'auto' : 'ask', list_behind_pace: on ? 'auto' : 'ask' }),
    };
    switches.addEventListener('change', async (e) => {
      const id = e.target && e.target.id;
      if (!owner || !id) return;
      const args = id === 'ap-sw-pause' ? { p_paused: e.target.checked } : { p_modes: MODES[id](e.target.checked) };
      try {
        fill(one(await ctx.rpc('autopilot_save_settings', args)));
        say(msg, id === 'ap-sw-pause' ? (e.target.checked ? 'Automation paused. Vector only asks.' : 'Automation is on again.') : 'Saved.');
      } catch (err) { e.target.checked = !e.target.checked; say(msg, err.message, true); }
    });
    goals.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fees = $('ap-goal-fees').value, adm = $('ap-goal-adm').value;
      try {
        fill(one(await ctx.rpc('autopilot_save_goals', { p_fees_pct: fees ? Number(fees) : null, p_admissions_target: adm ? Number(adm) : null })));
        say(msg, 'Goals saved. Today shows your numbers against them.');
      } catch (err) { say(msg, err.message, true); }
    });
    load();
    return { load };
  }

  window.VectorAutopilot = { setupForm, today, newList, settings, liveScripts };
})();
