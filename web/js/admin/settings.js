'use strict';
/* Settings tab of the admin app (web/admin.html). Today: the signed-in admin's password (moved from the old
   admin page). Still to build (docs/phase-a-plan.md, Sprint 10): call types, money switches, plan and AI usage,
   WhatsApp usage. Keep the password panel when filling this tab; styles go in web/css/admin-settings.css. */
(function () {
  const S = window.VectorAdminShared;
  const el = S.el;
  const say = S.say;

  let ctx = null;

  // A reset link to the signed-in admin's own email. reset.html asks for the new password.
  async function sendReset() {
    const email = ctx && ctx.email;
    if (!email) { say('reset-msg', 'Sign in again to send a reset link.', true); return; }
    const btn = document.getElementById('reset-send');
    btn.disabled = true;
    try {
      const { error } = await ctx.client.auth.resetPasswordForEmail(email, {
        redirectTo: new URL('reset.html', location.href).href,
      });
      if (error) throw error;
      say('reset-msg', 'Reset link requested for ' + email + '. Check that inbox for the link.');
    } catch (err) {
      say('reset-msg', 'Could not send the reset link: ' + (err && err.message ? err.message : 'try again.'), true);
    } finally {
      btn.disabled = false;
    }
  }

  S.registerTab({
    id: 'settings',
    label: 'Settings',
    mount(box, c) {
      ctx = c;
      box.appendChild(el('div', { className: 'tab-head' }, [el('h1', { text: 'Settings' })]));
      box.appendChild(el('div', { className: 'panel', id: 'login' }, [
        el('h2', { text: 'Your password' }),
        el('p', { className: 'muted', text: 'Change it now while you are signed in, or email yourself a reset link.' }),
        el('div', { className: 'row' }, [
          el('a', { className: 'button-link', href: 'reset.html', text: 'Change your password' }),
          el('button', { type: 'button', id: 'reset-send', text: 'Email me a reset link', onClick: sendReset }),
        ]),
        el('p', { id: 'reset-msg', className: 'msg', role: 'status' }),
      ]));
      box.appendChild(el('div', { className: 'panel soon' }, [
        el('p', { text: 'Here you will set up call types, who can see fee amounts, your plan, and WhatsApp.' }),
        el('p', { className: 'muted', text: 'Coming soon.' }),
      ]));
    },
    unmount() { ctx = null; },
  });
})();
