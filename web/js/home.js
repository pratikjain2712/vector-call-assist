/* Public home page: hero motion, tilt and magnetic buttons, the call console demo, the pricing calculator,
   tabs, and sign-in / free trial. A new trial signs in with an emailed link; existing accounts can also use a password. A new login starts a trial only
   through start_trial_institute; an existing invite is claimed with claim_my_invite. Nothing here is inline,
   so the page's CSP holds. The 3D scene (scene.js) listens for the 'vca:seats' event from the calculator. */
(function () {
  'use strict';

  document.documentElement.classList.add('js');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;

  var cfg = window.VECTOR_CONFIG || {};
  var NAME_KEY = 'vca-trial-institute';   // the institute name typed before the link is sent (this tab only)
  // A magic link returns with the session in the URL hash. Read it before the client clears it.
  var fromLink = /access_token=|type=magiclink|error_code=/.test(location.hash);
  var client = (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
    : null;
  var busy = false;
  var routing = false;

  function $(id) { return document.getElementById(id); }
  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- header state ---------- */
  var top = $('top');
  function onScroll() { top.classList.toggle('scrolled', window.scrollY > 24); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- hero title: split into words that rise in turn ---------- */
  (function splitTitle() {
    var h = $('heroTitle');
    if (!h || reduce) return;
    var parts = [{ t: 'Close more calls.' }, { t: 'Know why the rest were lost.', hot: true }];
    h.textContent = '';
    var i = 0;
    parts.forEach(function (part) {
      part.t.split(' ').forEach(function (word, n, arr) {
        var span = document.createElement('span');
        span.className = 'w' + (part.hot ? ' hot' : '');
        span.style.setProperty('--i', i++);
        span.textContent = word;
        h.appendChild(span);
        if (n < arr.length - 1) h.appendChild(document.createTextNode(' '));
      });
      h.appendChild(document.createTextNode(' '));
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { all('.w', h).forEach(function (w) { w.classList.add('in'); }); });
    });
  })();

  /* ---------- counters ---------- */
  function countUp(el) {
    var to = parseInt(el.getAttribute('data-count'), 10) || 0;
    if (reduce || to === 0) { el.textContent = to; return; }
    var t0 = null, dur = 1300;
    function tick(now) {
      if (t0 === null) t0 = now;
      var p = Math.min(1, (now - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(to * eased);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  if ('IntersectionObserver' in window) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { countUp(en.target); cio.unobserve(en.target); }
      });
    }, { threshold: 0.6 });
    all('[data-count]').forEach(function (el) { cio.observe(el); });
  } else {
    all('[data-count]').forEach(function (el) { el.textContent = el.getAttribute('data-count'); });
  }

  /* ---------- tilt and magnetic buttons (fine pointers only) ---------- */
  if (fine && !reduce) {
    all('[data-tilt]').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        card.style.setProperty('--rx', ((0.5 - y) * 12).toFixed(2) + 'deg');
        card.style.setProperty('--ry', ((x - 0.5) * 14).toFixed(2) + 'deg');
        card.style.setProperty('--gx', (x * 100).toFixed(1) + '%');
        card.style.setProperty('--gy', (y * 100).toFixed(1) + '%');
      });
      card.addEventListener('pointerleave', function () {
        card.style.setProperty('--rx', '0deg');
        card.style.setProperty('--ry', '0deg');
      });
    });
    all('.magnetic').forEach(function (b) {
      b.addEventListener('pointermove', function (e) {
        var r = b.getBoundingClientRect();
        var x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
        b.style.transform = 'translate(' + (x * 0.22).toFixed(1) + 'px,' + (y * 0.3).toFixed(1) + 'px)';
      });
      b.addEventListener('pointerleave', function () { b.style.transform = ''; });
    });
  }

  /* ---------- tabs (how-it-works steps and the sign-in / trial switch) ---------- */
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

  /* ---------- call console demo ---------- */
  (function console() {
    var leads = [
      { name: 'Riya S.', batch: 'List A', status: null },
      { name: 'Arjun M.', batch: 'List B', status: null },
      { name: 'Neha K.', batch: 'List A', status: null },
      { name: 'Vikram P.', batch: 'List C', status: null }
    ];
    var LINES = [
      { text: 'Hi, this is Anita from the team. Is this a good time for two minutes about the offer you asked about?', note: 'Say who you are and why you are calling, in one breath.' },
      { text: 'Which offer were you looking at, and what would you like to know first?', note: 'Ask one open question, then wait.' },
      { text: 'We have a free demo class on Saturday. Shall I reserve a seat for you?', note: 'Make one clear offer. Do not stack three.' },
      { text: 'Thank you for your time. I will note this down and you will hear from us.', note: 'Close warmly. Log the outcome on the right.' }
    ];
    var OBJ = {
      price: 'Ask what budget they had in mind. Mention the yearly fee is split into three instalments.',
      later: 'Ask a time that suits them and set a callback for that time.',
      joined: 'Ask what they are using to prepare, then offer the mock test as a next step.'
    };
    var li = 0, sel = 0, calls = 0, connected = 0, callbacks = 0, won = 0;
    var timerId = null, secs = 0;
    var line = $('scriptLine'), note = $('scriptNote');
    var stepEls = all('#steps span');

    function paintLeads() {
      all('.lead').forEach(function (b, i) {
        var L = leads[i];
        b.setAttribute('aria-pressed', i === sel ? 'true' : 'false');
        b.classList.toggle('done', !!L.status);
        b.querySelector('small').textContent = L.batch + ' · ' + (L.status ? L.status.replace('_', ' ') : 'not called');
      });
    }
    function paintLine(dir) {
      var next = Math.max(0, Math.min(LINES.length - 1, li + dir));
      if (next === li && dir !== 0) return;
      line.classList.add('swap');
      setTimeout(function () {
        li = next;
        line.textContent = LINES[li].text;
        note.textContent = LINES[li].note;
        stepEls.forEach(function (s, i) { s.classList.toggle('on', i === li); });
        line.classList.remove('swap');
      }, reduce ? 0 : 180);
    }
    $('nextLine').addEventListener('click', function () { paintLine(1); });
    $('prevLine').addEventListener('click', function () { paintLine(-1); });
    note.textContent = LINES[0].note;

    all('.lead').forEach(function (b, i) {
      b.addEventListener('click', function () { sel = i; paintLeads(); });
    });

    all('#objections .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        var on = c.getAttribute('aria-pressed') !== 'true';
        all('#objections .chip').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
        note.textContent = on ? OBJ[c.getAttribute('data-obj')] : LINES[li].note;
      });
    });

    function fmt(n) { var m = Math.floor(n / 60), s = n % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
    $('dialBtn').addEventListener('click', function () {
      secs = 0;
      $('timer').textContent = '00:00';
      $('dialBtn').disabled = true;
      $('hangBtn').disabled = false;
      timerId = setInterval(function () { secs += 1; $('timer').textContent = fmt(secs); }, 1000);
    });
    $('hangBtn').addEventListener('click', function () {
      clearInterval(timerId);
      $('hangBtn').disabled = true;
      $('dialBtn').disabled = false;
    });

    var LABEL = { answered: 'Answered', no_answer: 'No answer', callback: 'Callback', won: 'Won' };
    all('[data-outcome]').forEach(function (b) {
      b.addEventListener('click', function () {
        var o = b.getAttribute('data-outcome');
        var L = leads[sel];
        L.status = o;
        calls += 1;
        if (o === 'answered' || o === 'won') connected += 1;
        if (o === 'callback') callbacks += 1;
        if (o === 'won') won += 1;
        paintLeads();
        var pct = calls ? Math.round((connected / calls) * 100) : 0;
        $('pctConn').textContent = pct + '%';
        $('barConn').style.width = pct + '%';
        $('cntCb').textContent = callbacks;
        $('barCb').style.width = Math.min(100, callbacks * 25) + '%';
        $('cntWon').textContent = won;
        $('barWon').style.width = Math.min(100, won * 25) + '%';
        var item = document.createElement('li');
        item.textContent = L.name + ' → ' + LABEL[o] + ' · ' + fmt(secs);
        $('log').insertBefore(item, $('log').firstChild);
        while ($('log').children.length > 4) $('log').removeChild($('log').lastChild);
        if (timerId) { clearInterval(timerId); timerId = null; $('hangBtn').disabled = true; $('dialBtn').disabled = false; }
      });
    });
    paintLeads();
  })();

  /* ---------- pricing calculator (rupees per seat per month) ---------- */
  (function pricing() {
    var PRICE = { seat: { monthly: 499, yearly: 399 }, addon: { monthly: 249, yearly: 199 } };
    var MAX_VOLUME = 40;
    var billing = 'yearly';
    var range = $('seatRange'), num = $('seatNum'), addon = $('addon'), total = $('total');
    var shown = 0, anim = null;

    function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
    function plural(n) { return n + (n === 1 ? ' seat' : ' seats'); }
    function seatCount() {
      var v = parseInt(num.value, 10);
      if (!isFinite(v) || v < 1) v = 1;
      if (v > 200) v = 200;
      return v;
    }
    /* Bundles by seat count. Volume: 3 seats 15% off, 5 seats 25% off, then 5% more for each seat after 5, up to 40%. */
    function bundleName(n) { return n >= 5 ? 'Business' : n >= 3 ? 'Team' : 'Starter'; }
    function volumePct(n) {
      var base = n >= 5 ? 25 : n >= 3 ? 15 : 0;
      var extra = n > 5 ? (n - 5) * 5 : 0;
      return Math.min(MAX_VOLUME, base + extra);
    }
    function tween(to) {
      if (anim) cancelAnimationFrame(anim);
      if (reduce) { shown = to; total.textContent = inr(to); return; }
      var from = shown, t0 = null, dur = 520;
      function tick(now) {
        if (t0 === null) t0 = now;
        var p = Math.min(1, (now - t0) / dur);
        var e = 1 - Math.pow(1 - p, 3);
        shown = from + (to - from) * e;
        total.textContent = inr(shown);
        if (p < 1) anim = requestAnimationFrame(tick); else { shown = to; anim = null; }
      }
      anim = requestAnimationFrame(tick);
    }
    function nudgeText(n, vol, yearly) {
      var s;
      if (n < 3) s = 'Add ' + (3 - n) + (3 - n === 1 ? ' more seat' : ' more seats') + ' to unlock 15% off every seat.';
      else if (n < 5) s = 'Add ' + (5 - n) + ' more to unlock 25% off every seat.';
      else if (vol < MAX_VOLUME) s = 'Each seat after 5 adds 5% off. You are at ' + vol + '% off.';
      else s = 'You are at the 40% maximum on every seat.';
      if (!yearly) s += ' Yearly billing saves 20% on every seat.';
      return s;
    }
    function render() {
      var n = seatCount();
      var yearly = billing === 'yearly';
      var vol = volumePct(n);
      var seatBase = yearly ? PRICE.seat.yearly : PRICE.seat.monthly;
      var addBase = addon.checked ? (yearly ? PRICE.addon.yearly : PRICE.addon.monthly) : 0;
      var unit = (seatBase + addBase) * (1 - vol / 100);
      var perMonth = n * unit;

      tween(perMonth);
      $('nudge').textContent = nudgeText(n, vol, yearly);
      $('rowBundle').textContent = bundleName(n) + ' bundle';
      $('rowSeat').textContent = inr(seatBase) + ' × ' + plural(n);
      $('rowVol').textContent = vol ? '−' + vol + '%' : 'None yet';
      $('rowAddon').textContent = addon.checked ? inr(addBase) + ' × ' + plural(n) : 'Not included';
      $('rowYearLabel').textContent = yearly ? 'Billed yearly' : 'Billed monthly';
      $('rowYear').textContent = yearly ? inr(perMonth * 12) + ' a year' : inr(perMonth) + ' a month';
      // The chai line follows the real number: a cup of chai is about ₹10 to ₹15, so it is only claimed when true.
      var perDay = Math.max(1, Math.round(unit / 30));
      $('rowDay').textContent = 'about ₹' + perDay + ' a day' +
        (perDay <= 10 ? ', less than a cup of chai ☕' : perDay <= 15 ? ', about a cup of chai ☕' : '');

      /* Anchor: the same seats on monthly billing for a year, against yearly billing. */
      var addM = addon.checked ? PRICE.addon.monthly : 0, addY = addon.checked ? PRICE.addon.yearly : 0;
      var monthlyYear = n * (PRICE.seat.monthly + addM) * (1 - vol / 100) * 12;
      var yearlyYear = n * (PRICE.seat.yearly + addY) * (1 - vol / 100) * 12;
      $('anchorLine').textContent = 'Monthly billing for a year would be ' + inr(monthlyYear) + '. Yearly saves you ' + inr(monthlyYear - yearlyYear) + ' a year.';

      document.dispatchEvent(new CustomEvent('vca:seats', { detail: { count: n, addon: addon.checked } }));
    }
    all('[data-billing]').forEach(function (b) {
      b.addEventListener('click', function () {
        billing = b.getAttribute('data-billing');
        all('[data-billing]').forEach(function (o) { o.setAttribute('aria-checked', o === b ? 'true' : 'false'); });
        $('billing').classList.toggle('yearly', billing === 'yearly');
        render();
      });
    });
    range.addEventListener('input', function () { num.value = range.value; render(); });
    num.addEventListener('input', function () { range.value = seatCount(); render(); });
    addon.addEventListener('change', render);
    render();
  })();

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
    if (!client) return 'Sign-in is not set up on this site yet.';
    if (/signup|not allowed|not found/i.test(m)) {
      return 'No Vector account for this email. Ask your admin to invite you, or start a free trial.';
    }
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) return 'This account is not confirmed yet. Ask your admin, or leave the password empty for a sign-in link.';
    if (/rate|too many|seconds/i.test(m)) return 'Too many attempts or emails. Wait a few minutes and try again.';
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
      if (withName && !nameOk(name)) return setMsg(msg, 'Company name must be 2 to 120 characters.', 'error');
      if (!emailOk(email)) return setMsg(msg, 'Enter a valid email address.', 'error');
      if (!client) return setMsg(msg, friendly(null), 'error');
      busy = true;
      setBusy(form, true);
      setMsg(msg, '', '');
      // Sign-in tab with a password: sign in at once, no email. The session handler then routes by role.
      var password = form.elements.password ? form.elements.password.value : '';
      if (!create && password) {
        client.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
          if (res.error) throw res.error;
          form.elements.password.value = '';
        }).catch(function (err) {
          setMsg(msg, friendly(err), 'error');
        }).then(function () {
          busy = false;
          setBusy(form, false);
          labelSignIn(form);
        });
        return;
      }
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
  // The sign-in button says "Sign in" when a password is typed, otherwise "Email me a sign-in link".
  function labelSignIn(form) {
    var btn = form.querySelector('[data-label-password]');
    if (!btn || !form.elements.password) return;
    btn.textContent = form.elements.password.value ? btn.getAttribute('data-label-password') : btn.getAttribute('data-label-link');
  }
  bindSignIn($('form-trial'), true, true);
  bindSignIn($('form-signin'), false, false);
  if ($('form-signin').elements.password) {
    $('form-signin').elements.password.addEventListener('input', function () { labelSignIn($('form-signin')); });
  }

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
      ? 'You are the admin of this account.'
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
    if (!nameOk(name)) return setMsg(msg, 'Company name must be 2 to 120 characters.', 'error');
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

  /* ---------- reveal on scroll (content is visible without JS) ---------- */
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    all('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    all('.reveal').forEach(function (el) { el.classList.add('in'); });
  }
  /* ---------- how it works: the timeline fills and steps light up as you scroll ---------- */
  (function timeline() {
    var tl = $('timeline');
    if (!tl) return;
    var steps = all('.tstep', tl);
    function update() {
      var r = tl.getBoundingClientRect();
      var vh = window.innerHeight || 1;
      var p = Math.min(1, Math.max(0, (vh * 0.8 - r.top) / (r.height + vh * 0.3)));
      tl.style.setProperty('--p', p.toFixed(3));
      steps.forEach(function (el, i) {
        el.classList.toggle('lit', p >= (i + 0.5) / steps.length);
      });
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  })();
})();

/* ---------- hero stage: the scroll position picks the chapter; the rail jumps to one ---------- */
(function heroStage() {
  var wrap = document.getElementById('hero');
  var stage = document.getElementById('stage');
  if (!wrap || !stage) return;
  var panels = Array.prototype.slice.call(stage.querySelectorAll('.slot .panel'));
  var btns = Array.prototype.slice.call(stage.querySelectorAll('.rail button'));
  var n = panels.length, current = -1, queued = false;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function scrollRange() { return Math.max(1, wrap.offsetHeight - window.innerHeight); }

  function setChapter(i) {
    if (i === current) return;
    current = i;
    panels.forEach(function (p, k) { p.classList.toggle('on', k === i); });
    btns.forEach(function (b, k) {
      if (k === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    document.dispatchEvent(new CustomEvent('vca:chapter', { detail: { index: i } }));
  }

  function update() {
    queued = false;
    var top = wrap.getBoundingClientRect().top;
    var p = Math.min(1, Math.max(0, -top / scrollRange()));
    setChapter(Math.min(n - 1, Math.floor(p * n)));
  }
  function schedule() {
    if (!queued) { queued = true; requestAnimationFrame(update); }
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      var i = Number(b.getAttribute('data-goto')) || 0;
      var y = wrap.offsetTop + scrollRange() * ((i + 0.5) / n);
      window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });
    });
  });

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  setChapter(0);
  update();
})();

/* ---------- analytics example bars: widths come from data-w ---------- */
(function bars() {
  var els = document.querySelectorAll('[data-w]');
  Array.prototype.forEach.call(els, function (el) { el.style.width = el.getAttribute('data-w') + '%'; });
})();

/* ---------- analytics: an interactive example of the loss report ----------
   Example data only. Switch the grouping (step, reason, objection) and the script version; tap a bar to see
   what it means and, for the top causes, approve or reject the suggested change, as an admin does in the
   script editor. Nothing here is sent anywhere. */
(function lossExplorer() {
  var root = document.getElementById('lossExplorer');
  if (!root) return;
  var list = document.getElementById('lossBars');
  var summary = document.getElementById('lossSummary');
  var detail = document.getElementById('lossDetail');

  // Calls lost per 100 calls, for script v1 and v2. Steps and reasons add up to the lost total (40 and 32);
  // objections add up to less, because not every lost call has one.
  var DATA = {
    step: {
      unit: 'Calls lost at each step, out of every 100 calls.',
      rows: [
        { key: 'Greeting', v: [4, 4] },
        { key: 'Ask', v: [6, 6] },
        { key: 'Offer', v: [15, 8], tip: 'Most lost calls end at the offer line. Move the fee and payment options before the long offer details, so the lead hears the price with the reason for it.' },
        { key: 'Objection', v: [10, 9] },
        { key: 'Close', v: [5, 5] }
      ]
    },
    reason: {
      unit: 'Reasons reps picked on lost calls, out of every 100 calls.',
      rows: [
        { key: 'Price', v: [14, 8], tip: 'Price is the top recorded reason. Show the fee and the payment options earlier in the call.' },
        { key: 'Timing', v: [9, 9] },
        { key: 'No need', v: [7, 6] },
        { key: 'Already enrolled', v: [6, 6] },
        { key: 'Wrong person', v: [4, 3] }
      ]
    },
    objection: {
      unit: 'Objections heard on lost calls, out of every 100 calls.',
      rows: [
        { key: '"Too expensive"', v: [12, 6], tip: '"Too expensive" comes up in most lost calls. Give the rep one clear answer: the monthly payment option and what is included.' },
        { key: '"No time right now"', v: [8, 8] },
        { key: '"Need to ask family"', v: [7, 6] },
        { key: '"Is this a scam?"', v: [3, 2] }
      ]
    }
  };
  var TOTAL = [40, 32];
  var view = 'step', ver = 0, picked = null;
  var decisions = {};   // suggestion key -> 'approved' | 'rejected', for this page view only

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function topKey(rows) {
    var best = rows[0];
    rows.forEach(function (r) { if (r.v[ver] > best.v[ver]) best = r; });
    return best.key;
  }

  function draw() {
    var set = DATA[view], rows = set.rows;
    var max = 0;
    rows.forEach(function (r) { max = Math.max(max, r.v[0], r.v[1]); });
    var top = topKey(rows);

    summary.textContent = TOTAL[ver] + ' of every 100 calls are lost on script v' + (ver + 1) +
      (ver === 1 ? ', down from ' + TOTAL[0] + ' on v1.' : '. Switch to v2 to see the next version.');

    list.textContent = '';
    rows.forEach(function (r) {
      var li = el('li', r.key === top ? 'hot' : '');
      var b = el('button', 'bar-btn');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(picked === r.key));
      b.setAttribute('aria-label', r.key + ': ' + r.v[ver] + ' lost calls per 100' + (ver === 1 ? ', ' + r.v[0] + ' on v1' : ''));
      b.appendChild(el('span', 'bar-label', r.key));
      var track = el('span', 'track');
      var fill = el('span', 'fill');
      fill.style.width = Math.round(r.v[ver] / max * 100) + '%';
      track.appendChild(fill);
      b.appendChild(track);
      var num = el('b', null, String(r.v[ver]));
      b.appendChild(num);
      if (ver === 1 && r.v[1] !== r.v[0]) {
        var d = r.v[1] - r.v[0];
        num.appendChild(el('small', d < 0 ? 'delta down' : 'delta up', (d < 0 ? '−' : '+') + Math.abs(d)));
      }
      b.addEventListener('click', function () { picked = picked === r.key ? null : r.key; draw(); });
      li.appendChild(b);
      list.appendChild(li);
    });
    drawDetail();
  }

  function drawDetail() {
    var set = DATA[view];
    detail.textContent = '';
    var row = null;
    set.rows.forEach(function (r) { if (r.key === picked) row = r; });
    if (!row) {
      detail.appendChild(el('p', 'hint', set.unit + ' Tap a bar to see what to change.'));
      return;
    }
    var n = row.v[ver];
    var share = Math.round(n / TOTAL[ver] * 100);
    detail.appendChild(el('p', 'loss-head', row.key + ': ' + n + ' of ' + TOTAL[ver] + ' lost calls (' + share + '%) on script v' + (ver + 1) + '.'));
    // A top cause without a written suggestion gets a general one (e.g. Objection once the offer line is fixed on v2).
    var tip = row.tip || (row.key === topKey(set.rows)
      ? 'This is now the biggest cause on script v' + (ver + 1) + '. Review the lines for it next and add a clear answer to the script.'
      : null);
    if (!tip) {
      detail.appendChild(el('p', 'hint', 'Not a top cause on this version. Keep an eye on it as more calls come in.'));
      return;
    }
    var id = view + ':' + row.key + ':v' + (ver + 1);
    var box = el('div', 'suggest');
    box.appendChild(el('span', 'suggest-tag', 'Suggested change'));
    box.appendChild(el('p', null, tip));
    var state = decisions[id];
    if (state) {
      box.appendChild(el('p', 'suggest-done ' + state, state === 'approved'
        ? 'Approved. Make the change in the script editor and publish it; reps see it on their My results panel.'
        : 'Rejected. The script stays as it is, and the decision is kept with this version.'));
      var undo = el('button', 'btn btn-ghost btn-sm', 'Change decision');
      undo.type = 'button';
      undo.addEventListener('click', function () { delete decisions[id]; drawDetail(); });
      box.appendChild(undo);
    } else {
      var acts = el('div', 'suggest-actions');
      [['approved', 'Approve', 'btn btn-primary btn-sm'], ['rejected', 'Reject', 'btn btn-ghost btn-sm']].forEach(function (a) {
        var btn = el('button', a[2], a[1]);
        btn.type = 'button';
        btn.addEventListener('click', function () { decisions[id] = a[0]; drawDetail(); });
        acts.appendChild(btn);
      });
      box.appendChild(acts);
    }
    if (ver === 1 && row.v[1] < row.v[0]) {
      box.appendChild(el('p', 'hint', 'On v2 this fell from ' + row.v[0] + ' to ' + row.v[1] + ' lost calls per 100.'));
    }
    detail.appendChild(box);
  }

  function press(group, attr, value) {
    Array.prototype.forEach.call(root.querySelectorAll('[' + attr + ']'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value));
    });
  }
  Array.prototype.forEach.call(root.querySelectorAll('[data-view]'), function (b) {
    b.addEventListener('click', function () { view = b.getAttribute('data-view'); picked = null; press('view', 'data-view', view); draw(); });
  });
  Array.prototype.forEach.call(root.querySelectorAll('[data-ver]'), function (b) {
    b.addEventListener('click', function () { ver = Number(b.getAttribute('data-ver')) - 1; press('ver', 'data-ver', String(ver + 1)); draw(); });
  });

  draw();
})();
