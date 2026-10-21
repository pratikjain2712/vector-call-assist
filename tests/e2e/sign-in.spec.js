// Sign-in on the call guide (app.html) with email and password, against the local stack.
const { test, expect, env, signInOnApp } = require('./fixtures');

test('a wrong password is refused with a clear message', async ({ page }) => {
  await page.goto('/app.html');
  await page.locator('#signin-email').fill(env().users.rep1.email);
  await page.locator('#signin-password').fill('definitely-not-the-password');
  await page.locator('#signin-send').click();
  await expect(page.locator('#signin-msg')).toHaveText('Wrong email or password.');
  await expect(page.locator('#signin')).toBeVisible();
});

test('with the password empty the button offers an emailed link', async ({ page }) => {
  await page.goto('/app.html');
  await expect(page.locator('#signin-send')).toHaveText('Email me a sign-in link');
  await page.locator('#signin-password').fill('x');
  await expect(page.locator('#signin-send')).toHaveText('Sign in');
});

test('an account without a seat is told it has no active seat', async ({ page }) => {
  await page.goto('/app.html');
  await page.locator('#signin-email').fill(env().users.noseat.email);
  await page.locator('#signin-password').fill(env().password);
  await page.locator('#signin-send').click();
  await expect(page.locator('#signin-title')).toHaveText('No active seat');
});

test('a rep with a seat signs in, accepts the terms and reaches the pairing screen', async ({ page }) => {
  await signInOnApp(page, 'rep2');
  // No phone is paired in this browser, so the pairing screen comes next.
  await expect(page.locator('#gate')).toBeVisible();
  expect(await page.evaluate(() => Cloud.info().status)).toBe('ready');
});
