'use strict';
/* Practice mode (web/practice.html): a caller walks a published script with a pretend lead. Nothing is dialled
   and nothing is written to call_outcomes. The page shows a timer for the step on screen and a summary at the
   end (time on each step, the longest one).
   Data (supabase/migrations/20261024100026_insights_extra.sql):
     my_features()            the page needs 'scripts' (the Scripts add-on; a trial has everything)
     my_practice()            scripts the admin asked this caller to practise, then the other published scripts
     my_practice_done(id, s)  marks an asked-for practice as done, with the time taken
   Link: practice.html, or practice.html?script=<script id> to open one script straight away.
   Sign-in is shared with app.html (same site, same saved session). The pure helpers are tested in
   tests/web/practice.test.js (Node, no DOM). */
(function () {
  // ---------- pure helpers ----------

  // Made-up details for the pretend call. {name}, {me} … in a script line are filled from here.
  const PRETEND_LEAD = Object.freeze({
    name: 'Priya Sharma',
    student: 'Aarav Sharma',
    class: '10-A',
    amount: '₹18,000',
    amount_due: '₹18,000',
    fee: '₹18,000',
    due_date: '31 Oct',
    date: '31 Oct',
    course: 'the course',
    institute: 'our institute',
  });

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // '{name}' and '{ name }' become the lead's value; an unknown {word} is left as it is.
  function fillLine(text, values) {
    const vals = values || {};
    return String(text == null ? '' : text).replace(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g, (all, key) => {
      const v = vals[key] !== undefined ? vals[key] : vals[key.toLowerCase()];
      return v === undefined || v === null || v === '' ? all : String(v);
    });
  }

  function stepById(steps, id) {
    return (Array.isArray(steps) ? steps : []).find((s) => isObj(s) && s.id === id) || null;
  }

  // The step marked start (the first one, if several), else the first step.
  function startStep(steps) {
    const list = (Array.isArray(steps) ? steps : []).filter(isObj);
    return list.find((s) => s.start === true) || list[0] || null;
  }

  // Options that lead to a real step.
  function optionsOf(steps, step) {
    return (step && Array.isArray(step.opts) ? step.opts : [])
      .filter((o) => isObj(o) && typeof o.label === 'string' && o.label.trim() && stepById(steps, o.to));
  }

  const isEnd = (steps, step) => optionsOf(steps, step).length === 0;
  const stepName = (step) => (step && (String(step.title || '').trim() || String(step.id || ''))) || 'Step';

  // '0:07', '3:05', '1:02:03'.
  function formatClock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
  }

  // '3m 20s', '45 sec'.
  function formatSpoken(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return s + ' sec';
    const m = Math.floor(s / 60), r = s % 60;
    return r ? m + 'm ' + r + 's' : m + 'm';
  }

  // walk: [{ id, name, ms }] in the order the steps were shown. A step shown twice (after Back) adds up.
  // Returns { totalSeconds, steps: [{ id, name, seconds }], slowest } (slowest: null with fewer than 2 steps).
  function summarise(walk) {
    const order = [];
    const by = new Map();
    (walk || []).forEach((w) => {
      if (!by.has(w.id)) { by.set(w.id, { id: w.id, name: w.name, ms: 0 }); order.push(w.id); }
      by.get(w.id).ms += Math.max(0, Number(w.ms) || 0);
    });
    const steps = order.map((id) => { const x = by.get(id); return { id, name: x.name, seconds: Math.round(x.ms / 1000) }; });
    const totalSeconds = Math.round(order.reduce((t, id) => t + by.get(id).ms, 0) / 1000);
    let slowest = null;
    if (steps.length >= 2) {
      slowest = steps.reduce((a, b) => (b.seconds > a.seconds ? b : a));
      if (slowest.seconds === 0) slowest = null;
    }
    return { totalSeconds, steps, slowest };
  }

  const api = { PRETEND_LEAD, fillLine, stepById, startStep, optionsOf, isEnd, stepName, formatClock, formatSpoken, summarise };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.VectorPractice = api;

  // ---------- the page ----------

  const cfg = window.VECTOR_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
  const $ = (id) => document.getElementById(id);
  const SECTIONS = ['off', 'gate', 'noseat', 'addon', 'pick', 'walk', 'summary'];
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let client = null;
  let activeUser = null;
  let seat = null;
  let items = [];           // rows of my_practice()
  let current = null;       // the item being practised
  let values = PRETEND_LEAD;
  let path = [];            // ids of the steps shown, for Back
  let walk = [];            // [{ id, name, ms }]
  let stepStarted = 0;
  let walkStarted = 0;
  let timer = null;

  const show = (section) => SECTIONS.forEach((s) => { $(s).hidden = s !== section; });

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v === undefined || v === null) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'className') node.className = v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }
  function say(id, text, isError) {
    const node = $(id);
    node.textContent = text || '';
    node.classList.toggle('error', !!isError);
  }

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args || {});
    if (error) { const e = new Error(error.message); e.code = error.code; throw e; }
    return data;
  }
  const isMissing = (err) => !!err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(err.message || ''));

  function init() {
    if (!enabled) { show('off'); return; }
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    client.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
    $('gate-form').addEventListener('submit', signIn);
    $('gate-password').addEventListener('input', () => {
      $('gate-submit').textContent = $('gate-password').value ? 'Sign in' : 'Send sign-in link';
    });
    $('signout').addEventListener('click', () => { client.auth.signOut(); });
    $('walk-back').addEventListener('click', back);
    $('walk-stop').addEventListener('click', stopWalk);
    $('summary-again').addEventListener('click', () => begin(current));
    $('summary-other').addEventListener('click', () => { show('pick'); });
  }

  async function signIn(e) {
    e.preventDefault();
    const email = $('gate-email').value.trim();
    if (!EMAIL.test(email)) { say('gate-msg', 'Enter your work email address.', true); return; }
    const password = $('gate-password').value;
    if (password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      $('gate-password').value = '';
      if (error) say('gate-msg', /invalid login/i.test(error.message) ? 'Wrong email or password.' : error.message, true);
      return;
    }
    const { error } = await client.auth.signInWithOtp({
      email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname + location.search },
    });
    say('gate-msg', error ? error.message : 'Check your email for the sign-in link.', !!error);
  }

  async function onSession(session) {
    if (!session) {
      activeUser = null; seat = null; stopTimer();
      $('who').textContent = ''; $('signout').hidden = true;
      show('gate');
      return;
    }
    if (session.user.id === activeUser && seat) return;   // a token refresh
    activeUser = session.user.id;
    $('who').textContent = session.user.email || '';
    $('signout').hidden = false;
    try { await client.rpc('claim_my_invite'); } catch (err) { /* no invitation is the usual answer */ }
    try {
      const data = await rpc('my_active_seat');
      seat = Array.isArray(data) ? data[0] : data;
    } catch (err) { seat = null; }
    if (!seat || !seat.id) { seat = null; show('noseat'); return; }
    values = Object.assign({}, PRETEND_LEAD, { me: seat.label || 'me' });
    await loadList();
  }

  async function loadList() {
    try {
      const f = await rpc('my_features');
      if (Array.isArray(f) && !f.includes('scripts')) { show('addon'); return; }
    } catch (err) { /* an older server has no add-ons; my_practice below says what is wrong, if anything */ }
    say('pick-msg', 'Loading…');
    show('pick');
    try {
      items = (await rpc('my_practice')) || [];
    } catch (err) {
      if (/Scripts add-on/i.test(err.message)) { show('addon'); return; }
      say('pick-msg', isMissing(err) ? 'Practice is not set up on the server yet.' : 'Could not load scripts: ' + err.message, true);
      return;
    }
    drawList();
    const want = new URLSearchParams(location.search).get('script');
    const hit = want && items.find((x) => x.script_id === want);
    if (hit) begin(hit);
  }

  function drawList() {
    const list = $('pick-list');
    list.textContent = '';
    items.forEach((it) => {
      const asked = !!it.assignment_id;
      const notes = [];
      if (asked) notes.push((it.assigned_by ? it.assigned_by + ' asked you to practise this' : 'Your admin asked you to practise this')
        + (it.note ? ': "' + it.note + '"' : '.'));
      if (it.times_done) notes.push('Practised ' + it.times_done + (it.times_done === 1 ? ' time.' : ' times.'));
      const go = el('button', { type: 'button', className: asked && !it.done_at ? 'primary' : '', text: 'Practise' });
      go.setAttribute('aria-label', 'Practise ' + it.script_name);
      go.addEventListener('click', () => begin(it));
      list.appendChild(el('li', { className: 'pr-item' + (asked && !it.done_at ? ' asked' : '') }, [
        el('div', { className: 'pr-item-text' }, [
          el('span', { className: 'pr-item-name', text: it.script_name + ' (v' + it.version + ')' }),
          notes.length ? el('span', { className: 'pr-item-note', text: notes.join(' ') }) : null,
        ]),
        go,
      ]));
    });
    say('pick-msg', items.length ? '' : 'There is no published script to practise yet.');
  }

  // ---------- the walk ----------

  function begin(item) {
    if (!item) return;
    const first = startStep(item.steps);
    if (!first) { say('pick-msg', 'This script has no steps.', true); show('pick'); return; }
    current = item;
    path = [];
    walk = [];
    walkStarted = Date.now();
    $('lead-name').textContent = values.name;
    $('lead-line').textContent = 'Parent of ' + values.student + ' · Class ' + values.class;
    $('lead-due').textContent = 'Fee due: ' + values.amount + ' by ' + values.due_date;
    show('walk');
    goTo(first.id);
    startTimer();
  }

  // Closes the time of the step on screen.
  function closeStep() {
    if (!path.length) return;
    const step = stepById(current.steps, path[path.length - 1]);
    walk.push({ id: step.id, name: stepName(step), ms: Date.now() - stepStarted });
  }

  function goTo(id) {
    closeStep();
    path.push(id);
    stepStarted = Date.now();
    drawStep();
  }

  function back() {
    if (path.length < 2) return;
    closeStep();
    path.pop();
    stepStarted = Date.now();
    drawStep();
  }

  function drawStep() {
    const step = stepById(current.steps, path[path.length - 1]);
    const end = isEnd(current.steps, step);
    $('walk-count').textContent = 'Step ' + path.length + (end ? ' · Last step' : '') + ' · Read this aloud';
    $('walk-step').textContent = fillLine(stepName(step), values);
    const sayBox = $('walk-say');
    sayBox.textContent = '';
    (Array.isArray(step.say) ? step.say : []).forEach((line) => sayBox.appendChild(el('p', { text: fillLine(line, values) })));
    const tip = String(step.tip || '').trim();
    $('walk-tip').hidden = !tip;
    $('walk-tip').textContent = tip ? 'Tip: ' + fillLine(tip, values) : '';
    const opts = $('walk-opts');
    opts.textContent = '';
    if (end) {
      $('walk-ask').textContent = 'This is the end of the call.';
      const done = el('button', { type: 'button', className: 'primary', id: 'walk-finish', text: 'Finish practice' });
      done.addEventListener('click', finish);
      opts.appendChild(done);
    } else {
      $('walk-ask').textContent = 'What did they say?';
      optionsOf(current.steps, step).forEach((o) => {
        const b = el('button', { type: 'button', text: o.label.trim() });
        b.addEventListener('click', () => goTo(o.to));
        opts.appendChild(b);
      });
    }
    $('walk-back').disabled = path.length < 2;
    tick();
    $('walk-step').focus({ preventScroll: false });
  }

  function tick() {
    $('clock-step').textContent = formatClock((Date.now() - stepStarted) / 1000);
    $('clock-total').textContent = formatClock((Date.now() - walkStarted) / 1000);
  }
  function startTimer() { stopTimer(); timer = setInterval(tick, 1000); }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; }

  function stopWalk() {
    stopTimer();
    show('pick');
  }

  async function finish() {
    const lastStep = stepById(current.steps, path[path.length - 1]);
    closeStep();
    path = [];
    stopTimer();
    const sum = summarise(walk);
    $('summary-total').textContent = 'You finished "' + current.script_name + '" in ' + formatSpoken(sum.totalSeconds) + '.';
    $('summary-end').textContent = 'The call ended at: ' + fillLine(stepName(lastStep), values) + '.';
    const body = $('summary-body');
    body.textContent = '';
    sum.steps.forEach((s) => {
      const slow = sum.slowest && sum.slowest.id === s.id;
      body.appendChild(el('tr', {}, [
        el('td', { text: fillLine(s.name, values) }),
        el('td', { className: slow ? 'pr-slow' : '', text: formatSpoken(s.seconds) + (slow ? ' (longest)' : '') }),
      ]));
    });
    $('summary-tip').textContent = sum.slowest
      ? 'Longest step: ' + fillLine(sum.slowest.name, values) + ' (' + formatSpoken(sum.slowest.seconds) + '). Read it again until it feels easy.'
      : '';
    say('summary-msg', '');
    show('summary');
    $('summary-title').focus();
    if (current.assignment_id) {
      try {
        await rpc('my_practice_done', { p_assignment: current.assignment_id, p_seconds: Math.min(86400, sum.totalSeconds) });
        current.times_done = (current.times_done || 0) + 1;
        current.done_at = new Date().toISOString();
        drawList();
        say('summary-msg', 'Saved. Your admin can see that you practised this.');
      } catch (err) {
        say('summary-msg', 'Could not tell your admin that you practised: ' + err.message, true);
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
