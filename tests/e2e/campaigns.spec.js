// The Campaigns tab: New campaign in four steps with a CSV lead sheet (bad numbers and repeats are counted
// and skipped), the campaign page (progress, callers, pause and resume) and the list. Runs on the fake
// backend; on the local stack it runs against the real functions (20261024100020_campaign_admin.sql).
const { test, expect, env } = require('./fixtures');

const SHEET = [
  'Parent name,Mobile,Balance fee,Student name,Class',
  'Asha Rao,098765 43210,"12,000",Ravi,10',
  'Arun,+91 98765-43211,8000,Meena,10',
  'Bina,919876543212,,Kiran,9',
  'Bad number,12345,500,X,9',
  'Repeat,9876543210,500,Y,9',
  'Chitra,9876543213,4000,Om,10',
].join('\n');

async function signInAdmin(page, hash) {
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await expect(page.locator('#gate-submit')).toHaveText('Sign in');
  await page.locator('#gate-submit').click();
}

test('an admin starts a campaign from a lead sheet, then pauses and resumes it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signInAdmin(page, '#campaigns');
  await expect(page.locator('#tab-link-campaigns')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#camp-empty')).toBeVisible();

  await page.locator('#camp-new').click();
  await expect(page).toHaveURL(/#campaigns\?new=1$/);
  await expect(page.locator('#camp-w-step1 > legend')).toHaveText('1 · Details');
  await expect(page.locator('#camp-w-step4 > legend')).toHaveText('4 · Callers');

  // Starting needs a name, leads and a caller; the page says what is missing.
  await page.locator('#camp-w-start').click();
  await expect(page.locator('#camp-w-msg')).toHaveText('Give the campaign a name.');

  // 1 · Details: the type list comes from the call types (Fees collection is picked first).
  await page.locator('#camp-w-name').fill('E2E Nov fees');
  await expect(page.locator('#camp-w-type option:checked')).toHaveText('Fees collection');
  await page.locator('#camp-w-startdate').fill('2026-11-01');
  await page.locator('#camp-w-enddate').fill('2026-11-20');

  // 3 · Leads: the columns are matched from the headings, money goes to Amount due, never to extra fields.
  await page.locator('#camp-w-leads-file').setInputFiles({ name: 'class10.csv', mimeType: 'text/csv', buffer: Buffer.from(SHEET) });
  await expect(page.locator('#camp-w-leads-name')).toHaveText('class10.csv · 6 rows');
  await expect(page.locator('#camp-w-leads-col-name option:checked')).toHaveText('Parent name');
  await expect(page.locator('#camp-w-leads-col-phone option:checked')).toHaveText('Mobile');
  await expect(page.locator('#camp-w-leads-col-amount option:checked')).toHaveText('Balance fee');
  await expect(page.locator('#camp-w-leads-skip')).toHaveText('4 leads ready. 1 bad number and 1 repeat will be skipped.');
  await expect(page.locator('#camp-w-leads-extra')).toContainText('Student name');

  await page.locator('#camp-w-start').click();
  await expect(page.locator('#camp-w-msg')).toHaveText('Pick at least one caller before you start.');

  // 4 · Callers: equal parts shows how many each.
  await page.locator('#camp-w-seats label', { hasText: 'Rep 1' }).locator('input').check();
  await page.locator('#camp-w-seats label', { hasText: 'Rep 2' }).locator('input').check();
  await expect(page.locator('#camp-w-share option').first()).toHaveText('Equal parts (2 each)');
  await page.locator('#camp-w-target').fill('40');
  await expect(page.locator('#camp-w-target-hint')).toHaveText('About 20 a day for each caller.');

  await page.locator('#camp-w-start').click();
  await expect(page).toHaveURL(/#campaigns\?id=/);
  await expect(page.locator('#status')).toContainText('Campaign started: E2E Nov fees. 4 leads added.');
  await expect(page.locator('#camp-d-name')).toHaveText('E2E Nov fees');
  await expect(page.locator('#camp-d-status')).toHaveText('Running');
  await expect(page.locator('#camp-d-progress')).toContainText('0 / 4');
  await expect(page.locator('#camp-d-callers')).toContainText('Rep 1');
  await expect(page.locator('#camp-d-callers')).toContainText('Rep 2');
  // Money stays hidden for an admin the server does not allow (can_see_money is false here).
  await expect(page.locator('#camp-d-money')).toHaveCount(0);

  // Pause and resume go through the in-page confirmation.
  await page.locator('#camp-d-pause').click();
  await expect(page.locator('#confirm')).toBeVisible();
  await page.locator('#confirm-go').click();
  await expect(page.locator('#camp-d-status')).toHaveText('Paused');
  await page.locator('#camp-d-resume').click();
  await page.locator('#confirm-go').click();
  await expect(page.locator('#camp-d-status')).toHaveText('Running');

  // Add more leads on the campaign page.
  await page.locator('#camp-d-leads-file').setInputFiles({ name: 'more.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Phone\nDev,9000000011\nEsha,9000000012\n') });
  await expect(page.locator('#camp-d-leads-skip')).toHaveText('2 leads ready.');
  await page.locator('#camp-d-leads-form button[type="submit"]').click();
  await expect(page.locator('#camp-d-progress')).toContainText('0 / 6');

  // The list shows the campaign with its progress, callers and dates.
  await page.locator('#camp-detail .back a').click();
  await expect(page).toHaveURL(/#campaigns$/);
  const row = page.locator('#camp-body tr', { hasText: 'E2E Nov fees' });
  await expect(row).toContainText('Fees collection');
  await expect(row).toContainText('0 / 6');
  await expect(row).toContainText('Rep 1, Rep 2');
  await expect(row).toContainText('1 – 20 Nov');
  await expect(row).toContainText('Running');
  expect(errors).toEqual([]);
});

test('New campaign fits a phone screen and a draft can be saved without leads', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await signInAdmin(page, '#campaigns?new=1');
  await expect(page.locator('#camp-w-name')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.locator('#camp-w-name').fill('E2E draft');
  await page.locator('#camp-w-draft').click();
  await expect(page.locator('#camp-d-status')).toHaveText('Draft');
  await expect(page.locator('#camp-d-start')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  // Starting a draft without leads is refused by the server, and the message says why.
  await page.locator('#camp-d-start').click();
  await page.locator('#confirm-go').click();
  await expect(page.locator('#confirm-msg')).toContainText('caller');
});

test('an Excel lead sheet is read with the same reader as the caller app', async ({ page }) => {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Name', 'Phone', 'Amount due', 'Due date'],
    ['Asha', 9876543210, 12000, new Date(2026, 10, 5)],
    ['Arun', 919876543211, 8000, new Date(2026, 10, 6)],
    ['Short', 98765, 100, ''],
  ], { cellDates: true }), 'Leads');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  await signInAdmin(page, '#campaigns?new=1');
  await page.locator('#camp-w-leads-file').setInputFiles({ name: 'fees.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await expect(page.locator('#camp-w-leads-name')).toHaveText('fees.xlsx · 3 rows');
  await expect(page.locator('#camp-w-leads-col-amount option:checked')).toHaveText('Amount due');
  await expect(page.locator('#camp-w-leads-skip')).toHaveText('2 leads ready. 1 bad number will be skipped.');
  await expect(page.locator('#camp-w-leads-extra')).toContainText('Due date');
});
