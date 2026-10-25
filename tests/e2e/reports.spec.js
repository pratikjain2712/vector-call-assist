// The Reports tab: Fees collection with and without money access (from the fee ledger, Phase A.2), "Send these
// back to callers", the sales funnel, and Excel downloads that follow the money rules. The fallback without a
// fee ledger and the ledger chart are in ledger-reports.spec.js. Fake backend only: the numbers come from
// tests/e2e/fake-backend.js (the SQL itself is tested in supabase/tests/reports_test.sql).
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { test, expect, env, isFake } = require('./fixtures');

// The Excel writer the page loads from jsDelivr, served from node_modules (same file, same integrity hash).
const SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

test.beforeEach(async ({ page }) => {
  test.skip(!isFake(), 'uses the fake backend\'s report data');
  await page.route(SHEETJS, (route) => route.fulfill({
    contentType: 'application/javascript',
    headers: { 'access-control-allow-origin': '*' },
    body: fs.readFileSync(path.join(__dirname, '..', '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')),
  }));
});

async function openReports(page, hash) {
  await page.goto('/admin.html' + (hash || '#reports'));
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#tab-link-reports')).toHaveAttribute('aria-current', 'page');
}

// Clicks "Download Excel" and reads the file back: { name, sheets: { sheetName: rows } }.
async function downloadExcel(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#rp-excel').click()]);
  const file = await download.path();
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const sheets = {};
  wb.SheetNames.forEach((n) => { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }); });
  return { name: download.suggestedFilename(), sheets };
}

test('a manager without money access sees counts only, and the Excel file has no ₹ columns', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openReports(page);
  await expect(page.locator('#rp-pick-fees')).toHaveAttribute('aria-pressed', 'true');
  const cards = page.locator('#fees-cards');
  await expect(cards).toContainText('Total due now');
  await expect(cards).toContainText('150 students · fee ledger');
  await expect(cards).toContainText('4 payments · fee ledger');
  await expect(cards).toContainText('Broken promises');
  await expect(cards).not.toContainText('₹');
  await expect(page.locator('#fees-reported')).toContainText('85 calls');
  await expect(page.locator('#fees-reported')).toContainText('reported by caller');
  await expect(page.locator('#fees-money-note')).toBeVisible();
  await expect(page.locator('#promise-head')).not.toContainText('Amount');
  await expect(page.locator('#promise-head')).toContainText('Fee ledger');
  await expect(page.locator('#promise-body tr')).toHaveCount(4);
  await expect(page.locator('#promise-body')).toContainText('Asha · 10-B');
  await expect(page.locator('#promise-body')).toContainText('2 days late');
  await expect(page.locator('#promise-body')).toContainText('Due today');
  await expect(page.locator('#promise-body')).toContainText('Not yet due');
  await expect(page.locator('#promise-body tr', { hasText: 'Asha · 10-B' })).toContainText('Partly paid');
  await expect(page.locator('#promise-body tr', { hasText: 'Parent Today' })).toContainText('Not paid');
  await expect(page.locator('#promise-body tr', { hasText: 'Parent Later' })).toContainText('Not in the fee ledger');
  await expect(page.locator('#promise-body tr', { hasText: 'Parent Paid' })).toContainText(/Paid on \d+ \w{3} by UPI/);
  await expect(page.locator('#promise-body')).not.toContainText('₹');

  const x = await downloadExcel(page);
  expect(x.name).toMatch(/^vector-fees-collection-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.xlsx$/);
  expect(Object.keys(x.sheets)).toEqual(['Fees collection', 'Promises due this week', 'Ledger']);
  expect(JSON.stringify(x.sheets)).not.toContain('₹');
  expect(x.sheets['Fees collection'][1]).toEqual(['Total due now (fee ledger, students)', 150]);
  expect(x.sheets.Ledger[1]).toEqual(['By mode', 'UPI', 2]);
  expect(backend.db.reports.exports).toEqual([]);   // nothing to log: no money left the server
  expect(errors).toEqual([]);
});

test('send these back to callers sends the promises due today or late', async ({ page, backend }) => {
  await openReports(page);
  await expect(page.locator('#promise-body tr')).toHaveCount(4);   // 3 open promises and 1 the ledger closed (not sent back)
  await page.locator('#fees-send').click();
  await expect(page.locator('#confirm')).toBeVisible();
  await expect(page.locator('#confirm-text')).toContainText('2 parents');
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toHaveText('2 parents sent back to callers.');
  const due = backend.db.reports.promises.filter((p) => p.days_late >= 0).map((p) => p.lead_id);
  expect(backend.db.reports.sentBack.sort()).toEqual(due.sort());
});

test('an admin with money access sees ₹, and the money export is logged before the file is made', async ({ page, backend }) => {
  backend.db.reports.money = true;
  await openReports(page);
  const cards = page.locator('#fees-cards');
  await expect(cards).toContainText('₹27,00,000');
  await expect(cards).toContainText('₹18,000');
  await expect(cards).toContainText('₹11,000');
  await expect(page.locator('#fees-modes')).toContainText('UPI');
  await expect(page.locator('#fees-modes')).toContainText('₹6,000');
  await expect(page.locator('#fees-reported')).toContainText('85 calls as paid in these dates (₹14,40,000), reported by caller');
  await expect(page.locator('#fees-money-note')).toBeHidden();
  await expect(page.locator('#promise-head')).toContainText('Amount');
  await expect(page.locator('#promise-body')).toContainText('₹18,000');
  await expect(page.locator('#promise-body tr', { hasText: 'Asha · 10-B' })).toContainText('Partly paid (₹4,000)');

  const x = await downloadExcel(page);
  // 4 promises, 5 summary lines, 3 modes and 4 days with payments.
  expect(backend.db.reports.exports).toEqual([{ what: 'fees_report', rows: 16 }]);
  expect(x.sheets['Fees collection'][0]).toEqual(['Measure', 'Count', 'Amount (₹)']);
  expect(x.sheets['Fees collection'][1]).toEqual(['Total due now (fee ledger, students)', 150, 2700000]);
  expect(x.sheets['Fees collection'][5]).toEqual(['Paid after a call (reported by caller, calls)', 85, 1440000]);
  expect(x.sheets['Promises due this week'][0]).toContain('Promised amount (₹)');
  expect(x.sheets['Promises due this week'][0]).toContain('In the fee ledger');
  expect(x.sheets.Ledger[0]).toEqual(['Collected', 'Mode or day', 'Payments', 'Amount (₹)']);
  expect(x.sheets.Ledger[1]).toEqual(['By mode', 'UPI', 2, 6000]);
});

test('the sales funnel shows each step, the biggest drop and a note on the pitch step', async ({ page }) => {
  await openReports(page, '#reports?report=funnel');
  await expect(page.locator('#rp-pick-funnel')).toHaveAttribute('aria-pressed', 'true');
  const list = page.locator('#funnel-list li');
  await expect(list).toHaveCount(5);
  await expect(list.nth(2)).toContainText('Heard the pitch');
  await expect(list.nth(2)).toContainText('78 (41%)');
  await expect(page.locator('#funnel-notes')).toContainText('Biggest drop: between "Called" and "Picked up"');
  await expect(page.locator('#funnel-notes')).toContainText('Top reason given on lost calls: Price');
  await expect(page.locator('#funnel-notes')).toContainText('middle step');
  await expect(page.locator('#rp-fees')).toBeHidden();

  const x = await downloadExcel(page);
  expect(Object.keys(x.sheets)).toEqual(['Sales funnel']);
  expect(x.sheets['Sales funnel'][1]).toEqual(['Called', 189, 100]);
});

test('the report picker works by keyboard, the filters list campaigns and callers, and CSV still downloads', async ({ page, backend }) => {
  backend.addOutcome({ institute_id: env().institutes.a, seat_id: env().seats.rep1, client_record_id: 'e2e-rp-' + Date.now(),
    outcome: 'won', dialled_at: new Date().toISOString(), connected_seconds: 30 });
  await openReports(page);
  await expect(page.locator('#rp-campaign option')).toContainText(['All campaigns', 'Oct fees']);
  await expect(page.locator('#rp-caller option')).toContainText(['All callers', 'E2E Admin', 'Rep 1', 'Rep 2']);
  await page.locator('#rp-pick-results').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#outcome-body')).toContainText('Rep 1');

  // A caller filter narrows the results table.
  await page.locator('#rp-caller').selectOption({ label: 'Rep 2' });
  await expect(page.locator('#outcome-empty')).toBeVisible();
  await page.locator('#rp-caller').selectOption('');
  await expect(page.locator('#outcome-body')).toContainText('Rep 1');

  const [csv] = await Promise.all([page.waitForEvent('download'), page.locator('#csv').click()]);
  expect(csv.suggestedFilename()).toMatch(/^vector-team-activity-.*\.csv$/);
  const x = await downloadExcel(page);
  expect(Object.keys(x.sheets)).toEqual(['Results by outcome', 'Team activity']);
  expect(x.sheets['Results by outcome'][1][0]).toBe('Rep 1');
});

test('the Reports tab fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await openReports(page);
  await expect(page.locator('#fees-cards')).toContainText('Total due');
  await expect(page.locator('#fees-days .bar-row')).toHaveCount(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const id of ['fees', 'funnel', 'results', 'lost', 'weekly']) {
    await page.locator('#rp-pick-' + id).click();
    await expect(page.locator('#rp-pick-' + id)).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  }
});
