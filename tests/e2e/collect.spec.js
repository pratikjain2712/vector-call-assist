// Centres and Collect fee on the fake backend (tests/e2e/fake-backend.js, block "centres collect"; the SQL is
// tested in supabase/tests/centres_batches_test.sql). Accounts limited to Andheri sees nothing of Borivali and
// collects a fee in 4 actions, with Undo and the search ready for the next parent; the owner does the same from
// Today; Pending dues opens the form filled in; the owner's centre switch filters every tab; the phone bar for
// Accounts at 390px. With COLLECT_SHOTS=<folder> it also saves screenshots at 1440 and 390.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, env, isFake } = require('./fixtures');

const SHOTS = process.env.COLLECT_SHOTS || '';
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

test.beforeEach(async ({ page }) => {
  test.skip(!isFake(), 'uses the fake backend\'s centres and ledger');
  await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
});

async function signIn(page, email, width) {
  await page.setViewportSize(width ? { width, height: 844 } : { width: 1440, height: 900 });
  await page.goto('/admin.html');
  await page.locator('#gate-email').fill(email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
}

// Accounts limited to Andheri (and the fake backend's centres turned on).
function andheriAccounts(backend) {
  const ids = backend.centres.enable();
  const { email } = backend.fees.addAccounts();
  backend.centres.limit(email, [ids.andheri]);
  return { ids, email };
}

test('Accounts limited to Andheri: only Andheri, a fee in 4 actions, Undo, the next parent ready', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { ids, email } = andheriAccounts(backend);
  await signIn(page, email);
  await expect(page.locator('#tab-link-fees')).toHaveAttribute('aria-current', 'page');

  // Nothing to switch: the one centre is plain text, and the list has no Borivali student.
  await expect(page.locator('#centre-fixed')).toHaveText('Andheri');
  await expect(page.locator('#centre-switch')).toHaveCount(0);
  await expect(page.locator('#fees-body')).toContainText('Riya Bhosale');
  await expect(page.locator('#fees-body')).not.toContainText('Diya Rao');
  await expect(page.locator('#fees-body')).not.toContainText('Sana Khan');

  // The payment, counting what the person does.
  let actions = 0;
  await page.locator('#fees-collect-open').click(); actions++;                       // 1. Collect fee
  await expect(page).toHaveURL(/#fees\/collect$/);
  await expect(page.locator('#collect-q')).toBeFocused();
  await expect(page.locator('#collect-me')).toContainText('By you today ₹0');
  await page.locator('#collect-q').pressSequentially('sana');
  await expect(page.locator('#collect-msg')).toContainText('No student matches');     // Borivali is not found
  await page.locator('#collect-q').fill('riya'); actions++;                           // 2. type the name
  const hit = page.locator('#collect-results .collect-hit').first();
  await expect(hit).toContainText('Riya Bhosale');
  await expect(hit).toContainText('Class 10-A · CBSE · 10th CBSE A');
  await expect(hit).toContainText('Parent Sunita Bhosale');
  await expect(hit).toContainText('Due ₹6,000');
  await expect(page.locator('#collect-add')).toHaveText('+ Add student');
  await shot(page, 'collect-search-1440');
  await hit.click(); actions++;                                                        // 3. pick the student
  await expect(page.locator('#collect-amount')).toBeFocused();
  await expect(page.locator('#collect-amount')).toHaveValue('6000');
  await expect(page.locator('#collect-chips')).toContainText('Full ₹6,000');
  await expect(page.locator('#collect-chips')).toContainText('Term 1 tuition ₹4,000');
  await expect(page.locator('#collect-chips')).toContainText('Exam fee ₹2,000');
  await expect(page.locator('.collect-mode[aria-checked="true"]')).toHaveText('Cash');   // most used mode in the fake: cash
  await expect(page.locator('#collect-ref-wrap')).toBeHidden();
  await expect(page.locator('#collect-save')).toHaveText('Save ₹6,000');
  await shot(page, 'collect-picked-1440');
  await page.locator('#collect-save').click(); actions++;                             // 4. Save
  await expect(page.locator('#collect-done')).toContainText('₹6,000 received from Riya Bhosale · Cash · Receipt R-');
  expect(actions).toBeLessThanOrEqual(4);
  // Ready for the next parent: the search box empty and focused.
  await expect(page.locator('#collect-q')).toBeFocused();
  await expect(page.locator('#collect-q')).toHaveValue('');
  await expect(page.locator('#collect-me')).toContainText('By you today ₹6,000');
  await shot(page, 'collect-saved-1440');
  const paid = backend.db.fees.payments.filter((p) => p.student_id === ids.riya && !p.reverses_id);
  expect(paid.map((p) => [p.amount, p.mode])).toEqual([[6000, 'cash']]);

  // Receipt opens and goes back to Collect.
  await page.locator('#collect-receipt').click();
  await expect(page.locator('#fees-r-amount')).toHaveText('₹6,000');
  await page.locator('#fees-r-close').click();
  await expect(page.locator('#collect-receipt')).toBeFocused();

  // Undo reverses it with "Entered by mistake".
  await page.locator('#collect-undo').click();
  await expect(page.locator('#collect-done')).toContainText('Undone: ₹6,000 from Riya Bhosale was reversed ("Entered by mistake")');
  const rev = backend.db.fees.payments.find((p) => p.reverses_id === paid[0].id);
  expect(rev && rev.note).toBe('Entered by mistake');
  await expect(page.locator('#collect-q')).toBeFocused();
  await expect(page.locator('#collect-me')).toContainText('By you today ₹0');

  // UPI needs the UTR; Enter saves.
  await page.locator('#collect-q').fill('riya');
  await page.locator('#collect-q').press('Enter');
  await expect(page.locator('#collect-amount')).toBeFocused();
  await page.locator('.collect-mode[data-mode="upi"]').click();
  await expect(page.locator('#collect-ref-label')).toHaveText('UTR (UPI reference)');
  await expect(page.locator('#collect-save')).toBeDisabled();
  await page.locator('#collect-chips .collect-chip', { hasText: 'Exam fee' }).click();
  await expect(page.locator('#collect-save')).toHaveText('Save ₹2,000');
  await page.locator('#collect-ref').fill('UTR000111');   // Diya's UTR (Borivali): already recorded
  await page.locator('#collect-ref').press('Enter');
  await expect(page.locator('#collect-msg')).toContainText('this UPI reference is already recorded');
  await page.locator('#collect-ref').fill('512345678901');
  await page.locator('#collect-ref').press('Enter');
  await expect(page.locator('#collect-done')).toContainText('₹2,000 received from Riya Bhosale · UPI');

  expect(errors).toEqual([]);
});

test('owner: Collect fee from Today in 4 actions; Pending dues opens the form filled in', async ({ page, backend }) => {
  backend.db.reports.money = true;
  const ids = backend.centres.enable();
  await signIn(page, env().users.admin.email);
  await expect(page.locator('#today-collect')).toBeVisible();
  await expect(page.locator('#today-me')).toContainText(/^By you today ₹[\d,]+ · this month ₹[\d,]+$/);
  let actions = 0;
  await page.locator('#today-collect').click(); actions++;
  await expect(page.locator('#collect-q')).toBeFocused();
  await page.locator('#collect-q').fill('sana'); actions++;
  await page.locator('#collect-results .collect-hit').first().click(); actions++;
  await expect(page.locator('#collect-amount')).toHaveValue('3000');
  await page.locator('#collect-amount').press('Enter'); actions++;
  await expect(page.locator('#collect-done')).toContainText('₹3,000 received from Sana Khan');
  expect(actions).toBeLessThanOrEqual(4);
  expect(backend.db.fees.payments.some((p) => p.student_id === ids.sana && p.amount === 3000)).toBe(true);

  // Pending dues: most due first, each with Collect.
  await page.goto('/admin.html#fees/pending');
  await expect(page.locator('#pending-title')).toBeVisible();
  const first = page.locator('#pending-list .pending-row').first();
  await expect(first).toContainText('Aarav Shah');
  await expect(first).toContainText('₹7,000');
  await expect(page.locator('#pending-list .pending-row', { hasText: 'Riya Bhosale' })).toContainText('₹6,000');
  await expect(page.locator('#pending-total')).toContainText('students');
  await shot(page, 'pending-1440');
  await page.locator('.pending-sort[data-sort="date"]').click();
  await expect(page.locator('.pending-sort[data-sort="date"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#pending-list .pending-row', { hasText: 'Riya Bhosale' }).locator('.pending-collect').click();
  await expect(page).toHaveURL(/#fees\/collect\?student=/);
  await expect(page.locator('#collect-who')).toHaveText('Riya Bhosale');
  await expect(page.locator('#collect-amount')).toHaveValue('6000');
  await expect(page.locator('#collect-amount')).toBeFocused();
});

test('owner switches centre: every tab asks for that centre, and it is remembered', async ({ page, backend }) => {
  backend.db.reports.money = true;
  const ids = backend.centres.enable();
  await signIn(page, env().users.admin.email);
  const sw = page.locator('#centre-switch');
  await expect(sw).toBeVisible();
  await expect(sw.locator('option')).toHaveText(['All centres', 'Andheri', 'Borivali']);
  await shot(page, 'header-switcher-1440');
  const calls = () => backend.db.centres.calls;
  const askedFor = (name, centre) => calls().some((c) => c.name === name && (c.args.p_centre === centre || (c.args.p_filters || {}).centre_id === centre));

  await sw.selectOption({ label: 'Borivali' });
  await expect(page.locator('#status')).toHaveText('Showing Borivali.');
  await expect.poll(() => askedFor('admin_home_summary', ids.borivali)).toBe(true);    // Today
  await expect.poll(() => askedFor('my_suggestions', ids.borivali) || askedFor('admin_home_ledger', ids.borivali)).toBe(true);

  await page.locator('#tab-link-fees').click();                                          // Fees
  await expect(page.locator('#fees-body')).toContainText('Sana Khan');
  await expect(page.locator('#fees-body')).not.toContainText('Riya Bhosale');
  await expect(page.locator('#fees-body')).not.toContainText('Aarav Shah');
  await expect.poll(() => askedFor('accounts_students', ids.borivali)).toBe(true);
  await expect.poll(() => askedFor('admin_fees_ledger', ids.borivali)).toBe(true);
  // The batch picker shows the Borivali batches and batches of every centre.
  await expect(page.locator('#fees-f-batch option')).toHaveText(['All batches', '8th SB Evening', '10th CBSE A']);

  await page.locator('#tab-link-calling').click();                                       // Calling
  await expect.poll(() => askedFor('admin_campaign_list', ids.borivali)).toBe(true);
  await page.locator('#tab-link-team').click();                                          // Team
  await expect.poll(() => askedFor('admin_callers', ids.borivali)).toBe(true);
  await page.goto('/admin.html#fees/collect');                                           // Collect searches in the centre
  await page.locator('#collect-q').fill('riya');
  await expect(page.locator('#collect-msg')).toContainText('No student matches');
  await expect.poll(() => calls().some((c) => c.name === 'collect_search' && c.args.p_centre === ids.borivali)).toBe(true);

  // Remembered on this browser.
  await page.reload();
  await expect(page.locator('#centre-switch')).toHaveValue(ids.borivali);
  await page.locator('#centre-switch').selectOption('');
  await expect(page.locator('#status')).toHaveText('Showing every centre.');

  // Settings > Centres and batches (shown: the institute has centres).
  await page.goto('/admin.html#settings');
  await expect(page.locator('#settings-centres')).toBeVisible();
  await expect(page.locator('#cb-centres')).toContainText('Andheri (AND)');
  await expect(page.locator('#cb-batches')).toContainText('8th SB Morning');
  await shot(page, 'settings-centres-1440');
  await page.locator('#cb-centre-name').fill('Thane');
  await page.locator('#cb-add-centre button[type="submit"]').click();
  await expect(page.locator('#cb-centres')).toContainText('Thane');
});

test('Accounts on a phone (390px): Students · Collect · Pending at the bottom, Collect in the middle', async ({ page, backend }) => {
  const { email } = andheriAccounts(backend);
  await signIn(page, email, 390);
  const bar = page.locator('#quickbar');
  await expect(bar).toBeVisible();
  await expect(bar.locator('a')).toHaveText(['Students', 'Collect', 'Pending']);
  await expect(page.locator('#tabs')).toBeHidden();
  const box = await bar.boundingBox();
  expect(Math.round(box.y + box.height)).toBe(844);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(wide).toBeLessThanOrEqual(390);
  await page.locator('#quick-collect').click();
  await expect(page.locator('#quick-collect')).toHaveAttribute('aria-current', 'page');
  await page.locator('#collect-q').fill('riya');
  await shot(page, 'collect-search-390');
  await page.locator('#collect-results .collect-hit').first().click();
  await expect(page.locator('#collect-amount')).toHaveValue('6000');
  await shot(page, 'collect-picked-390');
  await page.locator('#collect-save').click();
  await expect(page.locator('#collect-done')).toContainText('₹6,000 received');
  await shot(page, 'collect-saved-390');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#quick-pending').click();
  await expect(page.locator('#pending-list .pending-row').first()).toBeVisible();
  await shot(page, 'pending-390');
  await page.locator('#quick-students').click();
  await expect(page.locator('#fees-body')).toContainText('Aarav Shah');
});

test('owner on a phone: the header switcher and Settings > Centres fit at 390px', async ({ page, backend }) => {
  backend.db.reports.money = true;
  backend.centres.enable();
  await signIn(page, env().users.admin.email, 390);
  await expect(page.locator('#centre-switch')).toBeVisible();
  await shot(page, 'header-switcher-390');
  await page.goto('/admin.html#settings');
  await expect(page.locator('#settings-centres')).toBeVisible();
  await shot(page, 'settings-centres-390');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('an institute without centres: no switcher, no centre fields; Collect still works', async ({ page, backend }) => {
  backend.db.reports.money = true;
  await signIn(page, env().users.admin.email);
  await expect(page.locator('#tab-link-today')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#centre-pick')).toBeHidden();
  await page.locator('#tab-link-fees').click();
  await expect(page.locator('#fees-f-batch')).toHaveCount(0);
  await page.locator('#fees-add-open').click();
  await expect(page.locator('#fsa-centre')).toHaveCount(0);
  await page.locator('#fees-collect-open').click();
  await page.locator('#collect-q').fill('aarav');
  await page.locator('#collect-results .collect-hit').first().click();
  await expect(page.locator('#collect-amount')).toHaveValue('7000');
  await page.locator('#collect-save').click();
  await expect(page.locator('#collect-done')).toContainText('₹7,000 received from Aarav Shah');
});
