/* Public home page: the demo card, the pricing calculator, tabs, and sign-in / free trial.
   Sign-in is an emailed link (no password). A new login starts a trial only through start_trial_institute;
   an existing invite is claimed with claim_my_invite. Nothing here is inline, so the page's CSP holds. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var cfg = window.VECTOR_CONFIG || {};
  var NAME_KEY = 'vca-trial-institute';          // the institute name typed before the link is sent (this tab only)
  // A magic link returns with the session in the URL hash. Read it before the client clears it.
  var fromLink = /access_token=|type=magiclink|error_code=/.test(location.hash);
  var client = (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;
  var busy = false;
  var routing = false;

  function $(id) { return document.getElementById(id); }
  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- tabs (the how-it-works steps and the sign-in / trial switch) ---------- */
  all('[data-tabs]').forEach(function (list) {
    var tabs = all('[role="tab"]', list);
    var scope = list.parentElement;
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      });
      all('[data-panel]', scope).forEach(function (p) { p.hidden = p.id !== tab.getAttribute('aria-controls'); });
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t, false); });
      t.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });
  });

  /* ---------- demo card in the hero ---------- */
  var demo = { calls: 0, connected: 0, callbacks: 0 };
  var CONNECTED = { answered: true, interested: true, won: true };
  all('[data-outcome]').forEach(function (b) {
    b.addEventListener('click', function () {
      all('[data-outcome]').forEach(function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
      demo.calls += 1;
      if (CONNECTED[b.getAttribute('data-outcome')]) demo.connected += 1;
      if (b.getAttribute('data-outcome') === 'callback') demo.callbacks += 1;
      $('cntCalls').textContent = demo.calls;
      $('cntConnected').textContent = demo.connected;
      $('cntCallbacks').textContent = demo.callbacks;
      $('demoLead').textContent = 'Lead ' + (14 + demo.calls) + ' of 60';
    });
  });

  /* ---------- pricing calculator (rupees per seat per month) ---------- */
  var PRICE = { seat: { monthly: 399, yearly: 199 }, addon: { monthly: 499, yearly: 299 } };
  var billing = 'monthly';
  var range = $('seatRange');
  var num = $('seatNum');
  var addon = $('addon');

  function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
  function seatCount() {
    var v = parseInt(num.value, 10);
    if (!isFinite(v) || v < 1) v = 1;
    if (v > 200) v = 200;
    return v;
  }
  function render() {
    var n = seatCount();
    var period = billing;
    var seatRate = PRICE.seat[period];
    var addRate = addon.checked ? PRICE.addon[period] : 0;
    var perMonth = n * (seatRate + addRate);
    $('total').textContent = inr(perMonth);
    $('rowSeat').textContent = inr(seatRate) + ' × ' + n + (n === 1 ? ' seat' : ' seats');
    $('rowAddon').textContent = addon.checked ? inr(addRate) + ' × ' + n + (n === 1 ? ' seat' : ' seats') : 'Not included';
    $('rowYearLabel').textContent = billing === 'yearly' ? 'Billed yearly' : 'Billed monthly';
    $('rowYear').textContent = billing === 'yearly' ? inr(perMonth * 12) + ' a year' : inr(perMonth) + ' a month';
  }
  all('[data-billing]').forEach(function (b) {
    b.addEventListener('click', function () {
      billing = b.getAttribute('data-billing');
      all('[data-billing]').forEach(function (o) { o.setAttribute('aria-checked', o === b ? 'true' : 'false'); });
      render();
    });
  });
  range.addEventListener('input', function () { num.value = range.value; render(); });
  num.addEventListener('input', function () {
    var v = seatCount();
    range.value = v;
    render();
  });
  addon.addEventListener('change', render);
  render();

  /* ---------- sign-in and trial ---------- */
  function show(id) {
    ['stateSignedOut', 'stateSent', 'stateChecking', 'stateNoSeat', 'stateReady', 'stateError'].forEach(function (s) {
      $(s).hidden = s !== id;
    });
  }
  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.setAttribute('data-kind', kind || '');
  }
  function setBusy(form, on) {
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = on;
  }
  function emailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function nameOk(v) { return v.length >= 2 && v.length <= 120; }
  function friendly(err) {
    var m = (err && err.message) || '';
    if (/signup|not allowed|not found/i.test(m)) {
      return 'No Vector account for this email. Ask your institute admin to invite you, or start a free trial.';
    }
    if (/rate|too many|seconds/i.test(m)) return 'Too many emails were sent. Wait a minute and try again.';
    if (!client) return 'Sign-in is not set up on this site yet.';
    return m || 'Something went wrong. Please try again.';
  }
  function readName() {
    try { return sessionStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
  }
  function writeName(v) {
    try { sessionStorage.setItem(NAME_KEY, v); } catch (e) { /* private window: the field is simply not remembered */ }
  }
  function clearName() {
    try { sessionStorage.removeItem(NAME_KEY); } catch (e) { /* nothing to clear */ }
  }

  function bindSignIn(form, create, withName) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var msg = $('authMsg');
      var email = form.elements.email.value.trim();
      var name = withName ? form.elements.institute.value.trim() : '';
      if (withName && !nameOk(name)) return setMsg(msg, 'Institute name must be 2 to 120 characters.', 'error');
      if (!emailOk(email)) return setMsg(msg, 'Enter a valid email address.', 'error');
      if (!client) return setMsg(msg, friendly(null), 'error');
      busy = true;
      setBusy(form, true);
      setMsg(msg, '', '');
      client.auth.signInWithOtp({
        email: email,
        options: { shouldCreateUser: create, emailRedirectTo: location.origin + location.pathname }
      }).then(function (res) {
        if (res.error) throw res.error;
        if (name) writeName(name);
        $('sentTo').textContent = email;
        show('stateSent');
      }).catch(function (err) {
        setMsg(msg, friendly(err), 'error');
      }).then(function () {
        busy = false;
        setBusy(form, false);
      });
    });
  }
  bindSignIn($('form-trial'), true, true);
  bindSignIn($('form-signin'), false, false);

  function trialText(st) {
    if (!st.trial_ends_at) return '';
    var d = new Date(st.trial_ends_at);
    return ' Trial until ' + d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) +
      ', up to ' + st.seat_limit + ' seats.';
  }

  function rpc(name, args) {
    return client.rpc(name, args || {}).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  // The seat for this login: an active seat, or an invite for this email that is claimed now.
  function findSeat() {
    return rpc('my_trial_status').then(function (st) {
      if (st) return st;
      return rpc('claim_my_invite').then(function () {
        return rpc('my_trial_status');
      }, function () {
        return null;   // no invitation for this email: the person may start a trial below
      });
    });
  }

  function showReady(st, session, redirect) {
    var target = st.role === 'admin' ? 'admin.html' : 'app.html';
    if (redirect) { location.replace(target); return; }
    $('openLink').setAttribute('href', target);
    $('whoami').textContent = session.user.email + ' · ' + st.institute_name;
    $('readyText').textContent = (st.role === 'admin'
      ? 'You are the admin of this institute.'
      : 'You have a rep seat on this login.') + trialText(st);
    show('stateReady');
  }

  function route(session, redirect) {
    if (routing || !session) return;
    routing = true;
    show('stateChecking');
    findSeat().then(function (st) {
      if (st) return showReady(st, session, redirect);
      $('form-name').elements.institute.value = readName();
      setMsg($('noSeatMsg'), '', '');
      show('stateNoSeat');
    }).catch(function (err) {
      $('errorMsg').textContent = friendly(err);
      show('stateError');
    }).then(function () {
      routing = false;
    });
  }

  $('form-name').addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;
    var form = e.currentTarget;
    var name = form.elements.institute.value.trim();
    var msg = $('noSeatMsg');
    if (!nameOk(name)) return setMsg(msg, 'Institute name must be 2 to 120 characters.', 'error');
    busy = true;
    setBusy(form, true);
    rpc('start_trial_institute', { p_name: name }).then(function () {
      clearName();
      return client.auth.getSession();
    }).then(function (res) {
      busy = false;
      setBusy(form, false);
      route(res.data.session, true);
    }).catch(function (err) {
      busy = false;
      setBusy(form, false);
      setMsg(msg, friendly(err), 'error');
    });
  });

  function signOut() {
    var done = function () { location.replace(location.pathname); };
    if (!client) return done();
    client.auth.signOut().then(done, done);
  }
  $('signOutBtn1').addEventListener('click', signOut);
  $('signOutBtn2').addEventListener('click', signOut);
  $('againBtn').addEventListener('click', function () { show('stateSignedOut'); });
  $('retryBtn').addEventListener('click', function () {
    if (!client) return show('stateError');
    client.auth.getSession().then(function (res) {
      if (res.data.session) route(res.data.session, false);
      else show('stateSignedOut');
    });
  });

  if (!client) {
    $('errorMsg').textContent = 'Sign-in is not set up on this site yet.';
    show('stateError');
  } else {
    client.auth.onAuthStateChange(function (event, session) {
      if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        route(session, fromLink);
      } else if (event === 'SIGNED_OUT') {
        show('stateSignedOut');
      }
    });
  }

  /* ---------- reveal on scroll (only when motion is allowed; content is visible without JS) ---------- */
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.15 });
    all('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    all('.reveal').forEach(function (el) { el.classList.add('in'); });
  }
})();
