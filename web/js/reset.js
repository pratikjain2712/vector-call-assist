/* Password reset (reset.html), for reps and admins.
   - Opened from the emailed reset link: Supabase signs the person in for recovery (PASSWORD_RECOVERY) and the
     page asks for a new password.
   - Opened while signed in: the page lets the person change their password directly, no email.
   - Opened with no session: the page asks for an email and sends a reset link that comes back here.
   The reset link only returns here if reset.html is in Supabase's allowed redirect URLs
   (Authentication > URL Configuration). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const SECTIONS = ['checking', 'request', 'choose', 'done', 'off'];
  const cfg = window.VECTOR_CONFIG || {};

  function show(id) { SECTIONS.forEach((s) => { $(s).hidden = s !== id; }); }
  function say(id, text, isError) {
    const n = $(id);
    n.textContent = text || '';
    n.classList.toggle('error', !!isError);
  }
  function friendly(error) {
    const m = (error && error.message) || '';
    if (/rate limit|too many|security purposes/i.test(m)) return 'Too many emails were sent. Wait a few minutes and try again.';
    if (/should be different|same password/i.test(m)) return 'Choose a password different from your current one.';
    if (/weak|at least|characters/i.test(m)) return 'That password is too short or too simple. Use at least 8 characters.';
    if (/session|expired|jwt/i.test(m)) return 'This link has expired. Request a new reset link.';
    return m || 'Something went wrong. Try again.';
  }

  if (!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient)) { show('off'); return; }
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // Read the address before supabase-js tidies it: a recovery link carries type=recovery, a dead one an error.
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(location.search);
  const linkError = hash.get('error_description') || query.get('error_description');
  const isRecoveryLink = hash.get('type') === 'recovery' || query.get('type') === 'recovery';

  let decided = false;
  function chooseFor(email, recovery) {
    decided = true;
    $('choose-who').textContent = (recovery ? 'Resetting the password for ' : 'Signed in as ') + (email || 'your account') + '.';
    show('choose');
    $('new-password').focus();
  }
  function askForEmail(note) {
    decided = true;
    say('request-note', note || '', true);
    show('request');
  }

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' && session) chooseFor(session.user.email, true);
  });

  (async () => {
    if (linkError) {
      askForEmail('This reset link has expired or was already used. Request a new one below.');
      history.replaceState(null, '', location.pathname);
      return;
    }
    const { data } = await client.auth.getSession();
    if (decided) return;
    if (data.session) { chooseFor(data.session.user.email, isRecoveryLink); return; }
    if (isRecoveryLink) {
      // The recovery event can arrive a moment after load; wait briefly before giving up on the link.
      setTimeout(() => { if (!decided) askForEmail('This reset link could not be used. Request a new one below.'); }, 3000);
      return;
    }
    askForEmail('');
  })();

  $('request-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('request-email').value.trim();
    if (!EMAIL.test(email)) { say('request-msg', 'Enter your work email address.', true); return; }
    const btn = $('request-submit');
    btn.disabled = true;
    say('request-msg', '');
    try {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (error) throw error;
      // Same answer whether or not the email has an account, so the page does not reveal who has one.
      say('request-msg', 'If ' + email + ' has a Vector account, a reset link is on its way. Open it on this device.');
    } catch (err) {
      say('request-msg', friendly(err), true);
    } finally {
      btn.disabled = false;
    }
  });

  $('choose-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('new-password').value, b = $('new-password-2').value;
    if (a.length < 8) { say('choose-msg', 'Use at least 8 characters.', true); return; }
    if (a !== b) { say('choose-msg', 'The two passwords do not match.', true); return; }
    const btn = $('choose-submit');
    btn.disabled = true;
    say('choose-msg', '');
    try {
      const { error } = await client.auth.updateUser({ password: a });
      if (error) throw error;
      $('new-password').value = '';
      $('new-password-2').value = '';
      show('done');
    } catch (err) {
      say('choose-msg', friendly(err), true);
    } finally {
      btn.disabled = false;
    }
  });
})();
