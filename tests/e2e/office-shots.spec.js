// Screenshots of the screens office clicks changed, at 1440 and 390, on the fake backend. Only with
// OFFICE_SHOTS=<folder> (skipped otherwise): E2E_MODE=fake OFFICE_SHOTS=/tmp/shots npx playwright test office-shots
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, env, isFake } = require('./fixtures');

const SHOTS = process.env.OFFICE_SHOTS || '';
test.beforeEach(async ({ page }) => {
  test.skip(!isFake() || !SHOTS, 'screenshots only, with OFFICE_SHOTS');
  await page.addInitScript(() => { window.print = () => {}; });
});
async function shot(page, name, width) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '-' + width + '.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth), name + ' fits').toBeLessThanOrEqual(width);
}
async function signIn(page, email, hash, width) {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(email || env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#app')).toBeVisible();
}

for (const width of [1440, 390]) {
  test('fees screens at ' + width, async ({ page, backend }) => {
    backend.centres.enable();
    const { email } = backend.fees.addAccounts();
    await signIn(page, email, '#fees', width);
    await page.locator('#fees-f-classes button', { hasText: 'Class 8' }).click();
    await expect(page.locator('#fees-call')).toBeVisible();
    await page.locator('#fees-call').click();
    await expect(page.locator('#fees-call-start')).toBeVisible();
    await shot(page, 'fees-list-call', width);
    await page.locator('#fees-call-cancel').click();
    await page.locator('#fees-add-open').click();
    await expect(page.locator('#fsa-name')).toBeFocused();
    await page.locator('#fsa-classes button').first().click();
    await shot(page, 'add-student', width);
    await page.locator('#fsa-more summary').click();
    await shot(page, 'add-student-more', width);
    await page.locator('#fees-add-open').click();
    await page.locator('#fees-import-open').click();
    const csv = ['Admission No,Student Name,Class,Section,Board,Father Name,Mobile,Academic Year,Tuition Fee,Tuition Due Date,Paid so far',
      'A201,Kabir Jain,8,B,CBSE,Rakesh Jain,98765 00011,2026-27,"18,000",01/04/2026,6000'].join('\n');
    await page.locator('#fees-imp-file').setInputFiles({ name: 'students.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.locator('#fees-imp-matched')).toBeVisible();
    await shot(page, 'import-matched', width);

    await page.goto('/admin.html#fees?student=' + backend.fees.aarav.id);
    await expect(page.locator('#fs-name')).toHaveText('Aarav Shah');
    await shot(page, 'student', width);
    await page.locator('#fs-disc-open').click();
    await page.locator('#fd-value').fill('1000');
    await page.locator('#fd-panel').scrollIntoViewIfNeeded();
    await shot(page, 'discount', width);
    await page.locator('#fs-collect').click();
    await expect(page.locator('#collect-amount')).toBeFocused();
    await shot(page, 'collect-from-student', width);
    await page.locator('#collect-save').click();
    await expect(page.locator('#collect-done')).toBeVisible();
    await shot(page, 'collect-saved', width);
    await page.goto('/admin.html#fees/pending');
    await expect(page.locator('#pending-title')).toBeVisible();
    await shot(page, 'pending', width);
  });

  test('owner screens at ' + width, async ({ page, backend }) => {
    backend.db.reports.money = true;
    await signIn(page, null, '#team', width);
    await expect(page.locator('#seat-body tr', { hasText: 'Rep 1' })).toBeVisible();
    await shot(page, 'team', width);
    await page.goto('/admin.html#settings');
    await expect(page.locator('#answers-save')).toBeVisible();
    await page.locator('#settings-answers').scrollIntoViewIfNeeded();
    await shot(page, 'settings-answers', width);
    await page.goto('/admin.html#calling?new=1');
    await expect(page.locator('#camp-w-name')).toBeVisible();
    await shot(page, 'new-calling-list', width);
    await page.goto('/admin.html#today');
    await expect(page.locator('#today-collect')).toBeVisible();
    await shot(page, 'today', width);
  });
}
