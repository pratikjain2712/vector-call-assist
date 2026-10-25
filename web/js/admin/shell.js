'use strict';
/* Admin app shell (web/admin.html): sign-in gate, top bar (institute, the account menu, sign out), the tab bar
   and hash routes (#today, #calling/scripts, #team?seat=…, so a tab can be linked and the back button works).
   Five tabs at most (owner feedback: "too many options"): Today, Fees, Calling, Team, Settings, by role
   (VectorAdminShared.tabsFor): an owner all five; a manager Today, Calling, Team and Fees only with money access;
   Accounts Fees only. Old links (#home, #insights, #campaigns, #scripts, #callers, #reports) are sent to their
   new place without a new history entry (VectorAdminShared.redirectRoute).
   Each tab is a module in web/js/admin/<tab>.js that registered itself with VectorAdminShared.registerTab; the
   shell mounts a tab the first time it is opened and keeps it (hidden) after that, so typing in a tab is not
   lost on a switch. A module with part: true is a piece a tab shows inside itself (Today shows Home and Insights,
   Calling shows Calling lists, Call scripts and Reports, Fees shows the fees collection report):
   ctx.part(id, container) mounts it once (or moves it into that container), ctx.showPart(id, params, sub)
   passes the route on. Sign-out unmounts every tab and part.
   The account menu holds "Change your password", "Email me a reset link" and "Show advanced options" (simple by
   default, remembered per login in this browser: VectorAdminShared.startAdvanced).
   The admin signs in by password or emailed link, like cloud.js. Reports are read with admin_* RPCs, which
   the database checks. Seat changes go through the seat-admin Edge Function (supabase/functions/seat-admin).
   Money: ctx.canSeeMoney comes from the can_see_money RPC; a database without it (or any error) gives false,
   so ₹ stays hidden unless the server says yes. */
(function () {
  const S = window.VectorAdminShared;
  const H = window.VectorAdminHelpers || {};
  const cfg = window.VECTOR_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
  const $ = (id) => document.getElementById(id);
  const SECTIONS = ['off', 'gate', 'notadmin', 'app'];
  const EMAIL = H.EMAIL || /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const TITLE = 'Vector admin';

  let client = null;
  let mySeat = null;         // my active seat row (admins and Accounts)
  let ctx = null;            // what every tab gets; made again for each sign-in
  let activeUser = null;
  let claimedFor = null;     // user id whose invitation was tried this sign-in (cleared on sign-out)
  let pending = null;        // the action waiting for the in-page confirmation
  let current = null;        // id of the open tab
  let userNavigated = false; // true after a click on a tab, so focus moves to the new tab (not on first load)
  const mounted = new Map(); // tab or part id -> its container, once mounted

  const show = (section) => SECTIONS.forEach((s) => { $(s).hidden = s !== section; });

  const isAccountsSeat = (seat) => S.seatKind(seat) === 'accounts';
  const mayUseAdmin = (seat) => S.isAdminRole(seat.role) || isAccountsSeat(seat);
  // The tabs of this person, in order: the role's tabs (tabsFor) that are registered, minus a tab that hides itself.
  function shownTabs() {
    if (!ctx) return [];
    return S.tabsFor(ctx.seat, ctx.canSeeMoney).map((id) => S.tab(id))
      .filter((t) => t && !t.part && (typeof t.visible !== 'function' || t.visible(ctx)));
  }
  const say = S.say;

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) {
      const err = new Error(error.message);
      err.code = error.code;   // lets a tab tell a missing function from other failures
      throw err;
    }
    return data;
  }

  // A function the database does not have yet (an older migration level).
  function isMissing(err) {
    const m = String((err && err.message) || '');
    return !!err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function|function .* does not exist/i.test(m));
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
    if (!res.ok) throw new Error(out.error || 'The change did not go through. Try again.');
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

  // ---------- startup and sign-in ----------

  function init() {
    window.addEventListener('hashchange', route);
    if (!enabled) { $('signout').hidden = true; show('off'); return; }
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    // Supabase advises against calling the client inside this callback, so the work runs just after it.
    client.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
    $('gate-form').addEventListener('submit', sendLink);
    $('gate-password').addEventListener('input', syncGateButton);
    $('signout').addEventListener('click', () => { client.auth.signOut(); });
    $('account-reset').addEventListener('click', sendReset);
    $('account-advanced').addEventListener('change', () => S.setAdvanced($('account-advanced').checked));
    document.addEventListener('vector:advanced', (e) => { $('account-advanced').checked = !!(e.detail && e.detail.on); });
    $('account').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('account').open = false; $('account-toggle').focus(); } });
    document.addEventListener('click', (e) => { if ($('account').open && !$('account').contains(e.target)) $('account').open = false; });
    $('confirm-go').addEventListener('click', runPending);
    $('confirm-cancel').addEventListener('click', cancelPending);
    $('confirm').addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelPending(); });
    $('tabs').addEventListener('click', (e) => { if (e.target.closest('a[data-tab]')) userNavigated = true; });
    show('gate');
  }

  function gateMessage(error) {
    const m = (error && error.message) || '';
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) return 'This account is not confirmed yet. Confirm it in Supabase, or use a sign-in link.';
    if (/signup|not allowed|not found/i.test(m)) return 'This email has no Vector account.';
    if (/rate limit|too many|security purposes/i.test(m)) return 'Too many attempts or sign-in emails. Wait a few minutes and try again.';
    return m || 'Sign-in failed. Try again.';
  }
  function syncGateButton() {
    $('gate-submit').textContent = $('gate-password').value ? 'Sign in' : 'Send sign-in link';
  }

  async function sendLink(e) {
    e.preventDefault();
    const email = $('gate-email').value.trim();
    if (!EMAIL.test(email)) { say('gate-msg', 'Enter your work email address.', true); return; }
    // With a password: sign in at once (no email). Without: email a sign-in link.
    const password = $('gate-password').value;
    if (password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      $('gate-password').value = '';
      syncGateButton();
      if (error) say('gate-msg', gateMessage(error), true);
      return;
    }
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
    });
    say('gate-msg', error ? gateMessage(error) : 'Check your email for the sign-in link.', !!error);
  }

  // A reset link to the signed-in person's own email (the account menu). reset.html asks for the new password.
  async function sendReset() {
    const email = ctx && ctx.email;
    if (!email) { say('account-msg', 'Sign in again to send a reset link.', true); return; }
    const btn = $('account-reset');
    btn.disabled = true;
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: new URL('reset.html', location.href).href });
      if (error) throw error;
      say('account-msg', 'Reset link sent to ' + email + '.');
    } catch (err) {
      say('account-msg', 'Could not send the reset link: ' + (err && err.message ? err.message : 'try again.'), true);
    } finally {
      btn.disabled = false;
    }
  }

  async function onSession(session) {
    if (!session) {
      activeUser = null;
      claimedFor = null;
      signedOut();
      show('gate');
      return;
    }
    // A token refresh fires the same event again. Keep the tabs as they are.
    if (session.user.id === activeUser && mySeat) return;
    signedOut();
    activeUser = session.user.id;
    $('who').textContent = session.user.email || '';
    await claimInvite(session.user.id);
    let data;
    try { data = await rpc('my_active_seat'); } catch (err) {
      say('gate-msg', 'Could not check your access: ' + err.message, true);
      show('gate');
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.id || !mayUseAdmin(row)) { show('notadmin'); return; }
    mySeat = row;
    const [institute, canSeeMoney] = await Promise.all([loadInstitute(row), loadMoneyAccess(row)]);
    ctx = makeContext(session.user.email || null, institute, canSeeMoney);
    $('institute').textContent = institute.name || '';
    $('institute').hidden = !institute.name;
    $('account').hidden = false;
    S.startAdvanced(session.user.email || session.user.id);
    $('account-advanced').checked = S.isAdvanced();
    drawTabs();
    show('app');
    route();
  }

  // The institute's name for the top bar, from my_trial_status. A failure only leaves the name out.
  async function loadInstitute(seat) {
    const inst = { id: seat.institute_id, name: '' };
    try {
      const data = await rpc('my_trial_status');
      const t = Array.isArray(data) ? data[0] : data;
      if (t && t.institute_name) inst.name = String(t.institute_name);
    } catch (err) { /* the name is only shown, nothing depends on it */ }
    return inst;
  }

  // Whether this admin may see ₹ amounts. Only the server decides; anything but a clear true is false.
  async function loadMoneyAccess(seat) {
    try {
      const data = await rpc('can_see_money', { inst: seat.institute_id });
      const v = Array.isArray(data) ? data[0] : data;
      return v === true || (v && v.can_see_money === true);
    } catch (err) {
      return false;
    }
  }

  function makeContext(email, institute, canSeeMoney) {
    return Object.freeze({
      client,
      rpc,
      isMissing,
      seatAction,
      email,
      seat: Object.freeze(Object.assign({}, mySeat)),
      institute: Object.freeze(institute),
      canSeeMoney: !!canSeeMoney,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      confirm: askConfirm,
      status: (text, isError) => say('status', text, isError),
      navigate,
      route: () => S.parseHash(location.hash),
      tabIds: () => shownTabs().map((t) => t.id),
      part: mountPart,
      showPart,
      helpers: S,
    });
  }

  // Unmounts every tab and part and clears the app, for a sign-out or a different login.
  function signedOut() {
    mounted.forEach((box, id) => {
      const def = S.tab(id);
      try { if (def && typeof def.unmount === 'function') def.unmount(); } catch (err) { /* the box is cleared anyway */ }
      box.remove();
    });
    mounted.clear();
    current = null;
    mySeat = null;
    ctx = null;
    pending = null;
    $('confirm').hidden = true;
    $('tabs').hidden = true;
    $('tabs').textContent = '';
    $('who').textContent = '';
    $('institute').textContent = '';
    $('account').hidden = true;
    $('account').open = false;
    say('account-msg', '');
    say('status', '');
    document.title = TITLE;
  }

  // ---------- tabs, parts and routes ----------

  function drawTabs() {
    const nav = $('tabs');
    nav.textContent = '';
    const list = shownTabs();
    nav.setAttribute('data-count', String(list.length));
    document.body.classList.toggle('one-tab', list.length < 2);
    list.forEach((t) => {
      nav.appendChild(S.el('a', { href: S.buildHash(t.id), 'data-tab': t.id, id: 'tab-link-' + t.id, text: t.label }));
    });
    nav.hidden = false;
  }

  // Opens a tab from code, such as a "See results" button. Adds a history entry, so Back returns. An old tab id
  // ('campaigns', 'reports' …) goes straight to its new place. tabId may name a sub-view: 'calling/scripts'.
  function navigate(tabId, params) {
    const parsed = S.parseHash('#' + tabId);
    const r = { tab: parsed.tab, sub: parsed.sub, params: params || {} };
    const moved = S.redirectRoute(r, { accounts: ctx && isAccountsSeat(ctx.seat) });
    const hash = S.routeHash(moved || r);
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  // A part (a module with part: true) inside a tab's container: mounted the first time, moved there after.
  // Returns the part's box, or null when there is no such part.
  function mountPart(id, container) {
    const def = S.tab(id);
    if (!def || !ctx) return null;
    let box = mounted.get(id);
    if (!box) {
      box = S.el('div', { id: 'tab-' + id, className: 'part tab-' + id });
      container.appendChild(box);
      mounted.set(id, box);
      try { def.mount(box, ctx); } catch (err) {
        box.textContent = '';
        box.appendChild(S.el('p', { className: 'msg error', text: 'This part could not open: ' + err.message }));
      }
    } else if (box.parentNode !== container) {
      container.appendChild(box);
    }
    box.hidden = false;
    return box;
  }
  function showPart(id, params, sub) {
    const def = S.tab(id);
    if (!def || typeof def.show !== 'function' || !mounted.has(id)) return;
    try { def.show(params || {}, sub || null); } catch (err) { say('status', err.message, true); }
  }

  // Shows the tab named in the address (mounting it the first time), or the first tab for anything else.
  function route() {
    if (!ctx) return;
    let r = S.parseHash(location.hash);
    const moved = S.redirectRoute(r, { accounts: isAccountsSeat(ctx.seat) });
    if (moved) {
      // An old link: rewrite the address to the new place, without a new history entry.
      r = moved;
      history.replaceState(null, '', location.pathname + location.search + S.routeHash(r));
    }
    const ids = shownTabs().map((t) => t.id);
    const id = S.resolveTab(r, ids);
    if (!id) return;
    if (r.tab !== id) {
      // An unknown tab, an empty address or a sign-in link's leftovers: show the first tab without a history entry.
      history.replaceState(null, '', location.pathname + location.search + S.buildHash(id));
      r = { tab: id, sub: null, params: {} };
    }
    const def = S.tab(id);
    let box = mounted.get(id);
    if (!box) {
      box = S.el('section', { id: 'tab-' + id, className: 'tab-panel tab-' + id, 'aria-labelledby': 'tab-link-' + id, tabindex: '-1' });
      $('panels').appendChild(box);
      mounted.set(id, box);
      try {
        def.mount(box, ctx);
      } catch (err) {
        box.textContent = '';
        box.appendChild(S.el('p', { className: 'msg error', text: 'This tab could not open: ' + err.message }));
      }
    }
    // Tabs are the sections in #panels; parts live inside a tab and show with it.
    Array.from($('panels').children).forEach((b) => { if (b.classList.contains('tab-panel')) b.hidden = b !== box; });
    document.querySelectorAll('#tabs a[data-tab]').forEach((a) => {
      if (a.getAttribute('data-tab') === id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.title = def.label + ' · ' + TITLE;
    if (current !== id) say('status', '');
    current = id;
    if (typeof def.show === 'function') {
      try { def.show(r.params || {}, r.sub || null); } catch (err) { say('status', err.message, true); }
    }
    if (userNavigated) {
      userNavigated = false;
      box.focus({ preventScroll: true });
    }
  }

  // ---------- the in-page confirmation, shared by every tab ----------
  // job: { title, text, button, danger, email: { label, value }, run(mail), done (text or fn(out)), after(), reload() }

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
    go.className = job.danger ? 'danger' : 'primary';
    say('confirm-msg', '');
    $('confirm').hidden = false;
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
      if (!EMAIL.test(mail)) { say('confirm-msg', 'Enter a valid email address.', true); return; }
    }
    const go = $('confirm-go');
    go.disabled = true;
    try {
      const out = (await job.run(mail)) || {};
      pending = null;
      $('confirm').hidden = true;
      if (job.after) job.after();
      say('status', typeof job.done === 'function' ? job.done(out) : job.done);
      if (job.reload) await job.reload();
    } catch (err) {
      say('confirm-msg', err.message, true);
    } finally {
      go.disabled = false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
