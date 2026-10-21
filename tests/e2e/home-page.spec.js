// The home page (index.html): loads cleanly on a laptop and a phone, the loss report reacts, and the
// Sign in tab signs an admin in with a password and sends them to the admin page.
const { test, expect, env } = require('./fixtures');

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}

test('home page loads on a laptop with the hero and no script errors', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#heroTitle')).toBeVisible();
  await expect(page.locator('#account')).toBeAttached();
  await page.waitForTimeout(1500);   // let the 3D scene start
  expect(errors, errors.join('\n')).toEqual([]);
});

test('home page fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#heroTitle')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the example loss report switches version and explains a bar', async ({ page }) => {
  await page.goto('/');
  const report = page.locator('#lossExplorer');
  await report.scrollIntoViewIfNeeded();
  await expect(page.locator('#lossSummary')).toContainText('40 of every 100 calls');
  await report.locator('[data-ver="2"]').click();
  await expect(page.locator('#lossSummary')).toContainText('32 of every 100 calls');
  // The steps view is the call blueprint (PR #6): one loss marker per step.
  await report.locator('.bp-mark[aria-label^="Offer:"]').click();
  await expect(page.locator('#lossDetail')).toContainText('Suggested change');
});

test('the Sign in tab signs an admin in with a password and opens the admin page', async ({ page }) => {
  await page.goto('/');
  await page.locator('#acc-signin').click();
  const form = page.locator('#form-signin');
  await form.locator('input[name="email"]').fill(env().users.admin.email);
  await form.locator('input[name="password"]').fill(env().password);
  await expect(form.locator('button[type="submit"]')).toHaveText('Sign in');
  await form.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/admin\.html$/);
});
