// Phase A.2: Reports, Home and Insights read money received from the fee ledger (migration 20261025150000 and
// promises_vs_payments), with what callers reported kept apart. Fake backend only: the numbers come from the
// "Phase A.2: reports" block of tests/e2e/fake-backend.js (the SQL is tested in
// supabase/tests/ledger_reports_test.sql). Also: the fallback when the institute has no fee ledger yet.
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { test, expect, env, isFake } = require('./fixtures');

const SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const INSIGHTS_FEES = '0e000000-0000-4000-8000-000000000001';   // the running fees campaign of fake-insights.js

test.beforeEach(async ({ page }) => {
  test.skip(!isFake(), 'uses the fake backend\'s ledger data');
  await page.route(SHEETJS, (route) => route.fulfill({
    contentType: 'application/javascript',
    headers: { 'access-control-allow-origin': '*' },
    body: fs.readFileSync(path.join(__dirname, '..', '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')),
  }));
});

async function signIn(page, hash) {
  await page.goto('/admin.html' + hash);
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#app')).toBeVisible();
  // An old #reports?report=fees link opens the collection report inside Fees; these tests look at the last 7 days.
  if (/report=fees/.test(hash)) {
    await expect(page).toHaveURL(/#fees\/report$/);
    await page.locator('#rp-dates').selectOption('last7');
  }
}

async function downloadExcel(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#rp-excel').click()]);
  const wb = XLSX.read(fs.readFileSync(await download.path()), { type: 'buffer' });
  const sheets = {};
  wb.SheetNames.forEach((n) => { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }); });
  return sheets;
}

test('Fees collection: collected by mode and by day from the ledger, with a table view and keyboard tooltips', async ({ page, backend }) => {
  backend.db.reports.money = true;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, '#reports?report=fees');
  await expect(page.locator('#rp-fees-source')).toContainText('what the fees office recorded (Paid (office))');
  const modes = page.locator('#rp-fees-modes li');
  await expect(modes).toHaveCount(3);
  await expect(modes.nth(0)).toContainText('UPI');
  await expect(modes.nth(1)).toContainText('Cash');
  await expect(modes.nth(2)).toContainText('Bank transfer');
  await expect(modes.nth(2)).toContainText('₹10,000');

  // Collected by day: one bar per day of the last 7 days, the same numbers as a table.
  const bars = page.locator('#rp-fees-days .bar-row');
  await expect(bars).toHaveCount(7);
  await bars.first().focus();
  await page.keyboard.press('End');
  await expect(page.locator('#rp-fees-days .chart-tip')).toContainText('₹1,000');
  await page.locator('#rp-fees-days .chart-toggle').click();
  await expect(page.locator('#rp-fees-days .chart-table table')).toBeVisible();
  await expect(page.locator('#rp-fees-days .chart-table tbody tr')).toHaveCount(7);
  await expect(page.locator('#rp-fees-days .chart-table')).toContainText('₹10,000');

  // A caller filter (an advanced option) says that ledger numbers cover every caller.
  await expect(page.locator('#rp-fees-seat-note')).toBeHidden();
  await page.locator('#account-toggle').click();
  await page.locator('#account-advanced').check();
  await page.locator('#account-toggle').click();
  await page.locator('#rp-caller').selectOption({ label: 'Rep 1' });
  await expect(page.locator('#rp-fees-seat-note')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Fees collection without money access: the ledger in counts, the chart and the Ledger sheet with no ₹', async ({ page, backend }) => {
  await signIn(page, '#reports?report=fees');
  await expect(page.locator('#rp-fees-modes li').first()).toContainText('2 payments');
  await expect(page.locator('#rp-fees-days .bar-row').last()).toContainText('1');
  expect(await page.locator('#rp-fees').innerText()).not.toContain('₹');
  const sheets = await downloadExcel(page);
  expect(Object.keys(sheets)).toContain('Ledger');
  expect(JSON.stringify(sheets)).not.toContain('₹');
  expect(backend.db.reports.exports).toEqual([]);
});

test('Fees collection without a fee ledger shows what callers reported, as before', async ({ page, backend }) => {
  backend.db.ledgerReports.hasLedger = false;
  await signIn(page, '#reports?report=fees');
  const cards = page.locator('#rp-fees-cards');
  await expect(cards).toContainText('Total due');
  await expect(cards).toContainText('240');
  await expect(cards).toContainText('not in Paid (office) yet');
  await expect(page.locator('#rp-fees-source')).toContainText('No students in Fees yet');
  await expect(page.locator('#rp-fees-ledger')).toBeHidden();
  await expect(page.locator('#promise-head')).not.toContainText('Paid (office)');
  await expect(page.locator('#promise-body tr')).toHaveCount(3);
  const sheets = await downloadExcel(page);
  expect(Object.keys(sheets)).toEqual(['Fees collection', 'Promises due this week']);
  expect(sheets['Fees collection'][1]).toEqual(['Total due', 240]);
});

test('Today with money access: collected today (Paid (office)) and promises not paid yet', async ({ page, backend }) => {
  backend.db.reports.money = true;
  backend.db.ledgerReports.home.released_today = { count: 1, idle: 0, inactive: 0, revoked: 1, admin: 0 };
  await signIn(page, '');
  const tile = page.locator('#home-fees-tile');
  await expect(tile).toContainText('Collected today');
  await expect(tile).toContainText('₹1,000');   // Kiran's UPI payment today (fake backend)
  await expect(tile).toContainText('Paid (office)');
  const attention = page.locator('#home-attention-list');
  await expect(attention).toContainText('2 promises due today are not paid yet.');
  await expect(attention).toContainText('₹9,000 still to pay.');
  await expect(attention).toContainText('1 follow-up went to other callers today.');
  await expect(attention).toContainText('because the caller was removed');
  await attention.locator('li', { hasText: 'not paid yet' }).getByRole('button', { name: 'See list' }).click();
  await expect(page).toHaveURL(/#fees\/report$/);
  await expect(page.locator('#rp-fees')).toBeVisible();
  await expect(page.locator('#rp-pick-fees')).toHaveAttribute('aria-pressed', 'true');
});

test('Today without a fee ledger keeps the caller-reported tile and the old promise rule', async ({ page, backend }) => {
  backend.db.ledgerReports.hasLedger = false;
  backend.adminTabs.setPromisesDue(3);
  await signIn(page, '');
  await expect(page.locator('#home-fees-tile')).toContainText('Fees: paid');
  await expect(page.locator('#home-fees-tile')).toContainText('Parent said (not paid yet)');
  await expect(page.locator('#home-attention-list')).toContainText('3 fee promises are due today.');
  await expect(page.locator('#home-attention-list')).not.toContainText('went to other callers');
});

test('Insights: "Are promises kept?" says which method it uses', async ({ page, backend }) => {
  await signIn(page, '#insights');   // an old link: Today with More analysis open
  await expect(page).toHaveURL(/#today\?more=1$/);
  await expect(page.locator('#ins-more')).toHaveAttribute('open', '');
  const method = page.locator('#ins-promises-method');
  await expect(method).toHaveAttribute('data-method', 'calls');
  await expect(method).toContainText('Measured on what callers reported');

  backend.db.ledgerReports.pvp[INSIGHTS_FEES] = {
    grace_days: 2, promises: 5, kept: 2, part_paid: 1, broken: 1, waiting: 0, no_student: 1, promised_amount: null, paid_amount: null,
    rows: [
      { state: 'kept', promised_on: '2026-10-01', promised_date: '2026-10-03' },
      { state: 'kept', promised_on: '2026-10-01', promised_date: '2026-10-03' },
      { state: 'part_paid', promised_on: '2026-10-01', promised_date: '2026-10-06' },
      { state: 'broken', promised_on: '2026-10-01', promised_date: '2026-10-20' },
      { state: 'no_student', promised_on: '2026-10-01', promised_date: '2026-10-02' },
    ],
  };
  await page.reload();
  await expect(method).toHaveAttribute('data-method', 'ledger');
  await expect(method).toContainText('Measured against Paid (office)');
  await expect(method).toContainText('2 kept, 1 partly paid, 1 broken');
  await expect(method).toContainText('1 promises are not linked to a student');
  await expect(page.locator('#ins-promises')).toContainText('4 promises with the date passed');
  await page.locator('#ins-promises .chart-toggle').click();
  await expect(page.locator('#ins-promises .chart-table tbody tr').first()).toContainText('1–3 days');
  await expect(page.locator('#ins-promises .chart-table tbody tr').first()).toContainText('100%');
});
