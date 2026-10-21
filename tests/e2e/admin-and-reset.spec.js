// The admin page shows the team's activity after a password sign-in, and reset.html changes a password.
const { test, expect, env, isFake, userDb, signInOnApp } = require('./fixtures');

test('admin signs in with a password and sees the team activity', async ({ page, backend }) => {
  // Make sure Rep 1 has at least one call today (in local mode, uploaded with Rep 1's own session).
  const row = {
    institute_id: env().institutes.a, seat_id: env().seats.rep1, client_record_id: 'e2e-admin-' + Date.now(),
    outcome: 'interested', dialled_at: new Date().toISOString(), connected_seconds: 42,
  };
  if (backend) backend.addOutcome(row);
  else expect((await (await userDb('rep1')).from('call_outcomes').insert(row)).error).toBeNull();

  await page.goto('/admin.html');
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await expect(page.locator('#gate-submit')).toHaveText('Sign in');
  await page.locator('#gate-submit').click();
  await expect(page.locator('#team-body')).toContainText('Rep 1');
});

test('a signed-in user changes their password on reset.html', async ({ page, backend }) => {
  const NEW_PASSWORD = 'E2e-new-password-2';
  // The reset user has no seat: sign-in still works and leaves a session, which is all reset.html needs.
  await signInOnApp(page, 'reset').catch(() => {});
  await page.goto('/reset.html');
  await expect(page.locator('#choose')).toBeVisible();
  await expect(page.locator('#choose-who')).toContainText(env().users.reset.email);

  await page.locator('#new-password').fill('short');
  await page.locator('#new-password-2').fill('short');
  await page.locator('#choose-submit').click();
  // The browser blocks a too-short password before the page sees it (minlength="8" on the fields).
  expect(await page.locator('#new-password').evaluate((el) => el.validity.tooShort)).toBe(true);
  await expect(page.locator('#done')).toBeHidden();

  await page.locator('#new-password').fill(NEW_PASSWORD);
  await page.locator('#new-password-2').fill(NEW_PASSWORD);
  await page.locator('#choose-submit').click();
  await expect(page.locator('#done')).toBeVisible();

  // The new password is what the backend now holds: it works and the old one no longer does.
  if (backend) {
    expect(backend.passwordOf('reset')).toBe(NEW_PASSWORD);
  } else {
    const { createClient } = require('@supabase/supabase-js');
    const c = createClient(env().url, env().anon, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await c.auth.signInWithPassword({ email: env().users.reset.email, password: NEW_PASSWORD })).error).toBeNull();
    expect((await c.auth.signInWithPassword({ email: env().users.reset.email, password: env().password })).error).not.toBeNull();
  }
});
