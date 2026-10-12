/* Public home page: hero motion, tilt and magnetic buttons, the call console demo, the pricing calculator,
   tabs, and sign-in / free trial. Sign-in is an emailed link (no password). A new login starts a trial only
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
    var parts = [{ t: 'Every call,' }, { t: 'on script', hot: true }, { t: 'and counted.' }];
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
      { name: 'Riya S.', batch: 'Batch A', status: null },
      { name: 'Arjun M.', batch: 'Batch B', status: null },
      { name: 'Neha K.', batch: 'Batch A', status: null },
      { name: 'Vikram P.', batch: 'Batch C', status: null }
    ];
    var LINES = [
      { text: 'Hi, this is Anita from the institute. Is this a good time for two minutes about the batch you asked about?', note: 'Say who you are and why you are calling, in one breath.' },
      { text: 'Which batch were you looking at, and what would you like to prepare for first?', note: 'Ask one open question, then wait.' },
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
    var PRICE = { seat: { monthly: 399, yearly: 199 }, addon: { monthly: 499, yearly: 299 } };
    var billing = 'monthly';
    var range = $('seatRange'), num = $('seatNum'), addon = $('addon'), total = $('total');
    var shown = 3990, anim = null;

    function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
    function seatCount() {
      var v = parseInt(num.value, 10);
      if (!isFinite(v) || v < 1) v = 1;
      if (v > 200) v = 200;
      return v;
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
    function render() {
      var n = seatCount();
      var seatRate = PRICE.seat[billing];
      var addRate = addon.checked ? PRICE.addon[billing] : 0;
      var perMonth = n * (seatRate + addRate);
      tween(perMonth);
      $('rowSeat').textContent = inr(seatRate) + ' × ' + n + (n === 1 ? ' seat' : ' seats');
      $('rowAddon').textContent = addon.checked ? inr(addRate) + ' × ' + n + (n === 1 ? ' seat' : ' seats') : 'Not included';
      $('rowYearLabel').textContent = billing === 'yearly' ? 'Billed yearly' : 'Billed monthly';
      $('rowYear').textContent = billing === 'yearly' ? inr(perMonth * 12) + ' a year' : inr(perMonth) + ' a month';
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
      return 'No Vector account for this email. Ask your institute admin to invite you, or start a free trial.';
    }
    if (/rate|too many|seconds/i.test(m)) return 'Too many emails were sent. Wait a minute and try again.';
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
})();
