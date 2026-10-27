// Office clicks on the fake backend (tests/e2e/fake-backend.js, blocks "Phase A.2: fees" and "office clicks";
// the SQL is tested in supabase/tests/caller_centre_scope_test.sql). Each test counts what the person does
// (a click, a typed box, a key) for one everyday job and checks it stays at or under the new count:
//   record a payment from a student's page, give a discount, add a student (and the next one), change a
//   caller's target, call the parents with dues; plus a manager who can see money collecting a fee, and
//   "Away today" with Undo.
const { test, expect, env, isFake } = require('./fixtures');

test.beforeEach(async ({ page }) => {
  test.skip(!isFake(), 'uses the fake backend');
  await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
});

async function signIn(page, email, hash, width) {
  if (width) await page.setViewportSize({ width, height: 844 });
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(email || env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#app')).toBeVisible();
}
const noErrors = (page) => { const errors = []; page.on('pageerror', (e) => errors.push(e.message)); return errors; };

test('record a payment from the student\'s page: 2 actions (was 4), the mode remembered, Print receipt and Next student', async ({ page, backend }) => {
  const errors = noErrors(page);
  const { email } = backend.fees.addAccounts();
  await signIn(page, email, '#fees?student=' + backend.fees.aarav.id);
  await expect(page.locator('#fs-name')).toHaveText('Aarav Shah');
  await expect(page.locator('#fs-pay')).toHaveCount(0);   // one payment form in the app: Collect
  let actions = 0;
  await page.locator('#fs-collect').click(); actions++;                                   // 1. Collect fee
  await expect(page.locator('#collect-amount')).toHaveValue('7000');                      // the balance due now
  await expect(page.locator('#collect-amount')).toBeFocused();
  await page.locator('#collect-save').click(); actions++;                                 // 2. Save ₹7,000 (cash)
  await expect(page.locator('#collect-done')).toContainText('₹7,000 received from Aarav Shah · Cash');
  expect(actions).toBeLessThanOrEqual(2);
  await expect(page.locator('#collect-receipt')).toHaveText('Print receipt');
  await expect(page.locator('#collect-next')).toHaveText('Next student');
  await expect(page.locator('#collect-q')).toBeFocused();                                 // ready for the next parent
  await page.locator('#collect-receipt').click();
  await page.locator('#fees-r-print').click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);

  // The next payment by UPI: UPI is remembered for this login; Enter in the reference saves.
  await page.goto('/admin.html#fees/collect?student=' + backend.fees.diya.id);
  await page.locator('#collect-amount').fill('500');
  await page.locator('.collect-mode[data-mode="upi"]').click();
  await page.locator('#collect-ref').fill('UTR1234567890');
  await page.locator('#collect-ref').press('Enter');
  await expect(page.locator('#collect-done')).toContainText('₹500 received from Diya');
  await page.goto('/admin.html#fees/collect?student=' + backend.fees.aarav.id);
  await expect(page.locator('.collect-mode[aria-checked="true"]')).toHaveText('UPI');      // last mode of this login
  expect(errors).toEqual([]);
});

test('give a discount: 3 actions on one screen (was 5), the reason remembered', async ({ page, backend }) => {
  const errors = noErrors(page);
  const { email } = backend.fees.addAccounts();
  await signIn(page, email, '#fees?student=' + backend.fees.aarav.id);
  await expect(page.locator('#fs-name')).toHaveText('Aarav Shah');
  let actions = 0;
  await page.locator('#fs-disc-open').click(); actions++;                                 // 1. Give a discount
  await page.locator('#fd-value').fill('1000'); actions++;                                // 2. 1000 (₹, whole year, Sibling)
  await expect(page.locator('#fd-check')).toHaveText('The discount is ₹1,000. Aarav Shah\'s fees left for the year go from ₹17,000 to ₹16,000.');
  await page.locator('#fd-next').click(); actions++;                                      // 3. Give the discount
  await expect(page.locator('#fs-msg')).toHaveText('Discount of ₹1,000 given to Aarav Shah.');
  expect(actions).toBeLessThanOrEqual(3);

  // Merit this time; the next discount starts with Merit.
  await page.locator('#fs-disc-open').click();
  await page.locator('#fd-reason-merit').click();
  await page.locator('#fd-kind-percent').click();
  await page.locator('#fd-value').fill('5');
  await page.locator('#fd-value').press('Enter');
  await expect(page.locator('#fs-msg')).toContainText('given to Aarav Shah');
  await page.locator('#fs-disc-open').click();
  await expect(page.locator('#fd-reason-merit')).toHaveAttribute('aria-checked', 'true');
  // "Only some fees" opens the ticks.
  await expect(page.locator('#fd-fees')).toBeHidden();
  await page.locator('#fd-on-some').click();
  await expect(page.locator('#fd-fees')).toBeVisible();
  expect(errors).toEqual([]);
});

test('add a student: 7 actions (was 10), board and year from the fee plan, Save & add another keeps the class', async ({ page, backend }) => {
  const errors = noErrors(page);
  const { email } = backend.fees.addAccounts();
  await signIn(page, email);
  await expect(page.locator('#fees-body tr')).toHaveCount(1);
  let actions = 0;
  await page.locator('#fees-add-open').click(); actions++;                                // 1. + Add student
  await expect(page.locator('#fsa-name')).toBeFocused();
  await page.locator('#fsa-name').fill('Kabir Jain'); actions++;                          // 2. name
  await page.locator('#fsa-classes button', { hasText: 'Class 8' }).click(); actions++;   // 3. Class 8
  await expect(page.locator('#fsa-section')).toBeFocused();
  await page.locator('#fsa-section').fill('B'); actions++;                                // 4. section
  await page.locator('#fsa-parent').fill('Rakesh Jain'); actions++;                       // 5. parent
  await page.locator('#fsa-phone').fill('98765 00011'); actions++;                        // 6. phone
  await expect(page.locator('#fsa-adm')).toBeHidden();                                    // under More
  await page.locator('#fsa-again').click(); actions++;                                    // 7. Save & add another
  await expect(page.locator('#fsa-msg')).toContainText('Kabir Jain added');
  expect(actions).toBeLessThanOrEqual(7);
  const kabir = backend.db.fees.students.find((s) => s.name === 'Kabir Jain');
  expect(kabir).toMatchObject({ class_label: '8', section: 'B', parent_name: 'Rakesh Jain', phone: '+919876500011' });
  // The next student of the same class: class and section stay, the name box is ready.
  await expect(page.locator('#fsa-name')).toBeFocused();
  await expect(page.locator('#fsa-name')).toHaveValue('');
  await expect(page.locator('#fsa-class')).toHaveValue('8');
  await expect(page.locator('#fsa-section')).toHaveValue('B');
  await page.locator('#fsa-name').fill('Isha Nair');
  await page.locator('#fsa-phone').fill('98765 00012');
  await page.locator('#fsa-save').click();
  await expect(page).toHaveURL(/#fees\?student=/);
  await expect(page.locator('#fs-name')).toHaveText('Isha Nair');
  expect(backend.db.fees.students.find((s) => s.name === 'Isha Nair')).toMatchObject({ class_label: '8', section: 'B' });
  expect(errors).toEqual([]);
});

test('change a caller\'s daily target: 2 actions in the row (was 4), no question', async ({ page, backend }) => {
  const errors = noErrors(page);
  await signIn(page, null, '#team');
  const row = page.locator('#seat-body tr', { hasText: 'Rep 2' });
  const box = row.locator('input.team-target');
  await expect(box).toBeVisible();
  let actions = 0;
  await box.fill('35'); actions++;                                                         // 1. type 35
  await box.press('Enter'); actions++;                                                     // 2. Enter
  await expect(page.locator('#status')).toContainText('Target saved for "Rep 2": 35 calls a day.');
  await expect(page.locator('#confirm')).toBeHidden();
  expect(actions).toBeLessThanOrEqual(2);
  await expect(page.locator('#seat-body tr', { hasText: 'Rep 2' }).locator('input.team-target')).toHaveValue('35');
  expect(errors).toEqual([]);
});

test('Away today gives a caller\'s calls to the others at once, and Undo gives them back', async ({ page, backend }) => {
  const errors = noErrors(page);
  const E = env();
  const k1 = backend.adminTabs.addCampaign(E.institutes.a, 'Oct fees', 'running');
  ['Lead A', 'Lead B'].forEach((name, i) => backend.db.leads.push({ id: 'dddddddd-0000-4000-8000-00000000000' + (i + 1), campaign_id: k1,
    institute_id: E.institutes.a, name, phone: '+9198765001' + (10 + i), status: 'new', assigned_seat_id: E.seats.rep1 }));
  await signIn(page, null, '#team');
  await page.locator('#away-' + E.seats.rep1).click();
  await expect(page.locator('#confirm')).toBeHidden();
  await expect(page.locator('#status')).toHaveText('2 people of "Rep 1" given to the other callers.');
  expect(backend.db.leads.filter((l) => l.campaign_id === k1).map((l) => l.assigned_seat_id)).toEqual([null, null]);
  await expect(page.locator('[data-away="' + E.seats.rep1 + '"]')).toContainText('Away · 2 calls given to others');
  await page.locator('#away-undo-' + E.seats.rep1).click();
  await expect(page.locator('#status')).toContainText('Undone: Rep 1 has their calls back.');
  expect(backend.db.leads.filter((l) => l.campaign_id === k1).map((l) => l.assigned_seat_id)).toEqual([E.seats.rep1, E.seats.rep1]);
  expect(errors).toEqual([]);
});

test('call the parents with dues: 3 actions (was 5), the filters remembered', async ({ page, backend }) => {
  const errors = noErrors(page);
  const { email } = backend.fees.addAccounts();
  await signIn(page, email);
  await expect(page.locator('#fees-f-due')).toBeChecked();                                // Accounts: only with dues
  await expect(page.locator('#fees-body tr')).toHaveCount(1);
  let actions = 0;
  await page.locator('#fees-f-classes button', { hasText: 'Class 8' }).click(); actions++; // 1. Class 8
  await expect(page.locator('#fees-call')).toHaveText('Call these 1 parent');
  await page.locator('#fees-call').click(); actions++;                                    // 2. Call these parents
  await expect(page.locator('#fees-call-text')).toContainText('1 parent');
  await expect(page.locator('#fees-call-text')).toContainText('₹7,000 due');
  await page.locator('#fees-call-start').click(); actions++;                              // 3. Start calling
  await expect(page.locator('#fees-call-made')).toContainText('started: 1 parent to call');
  expect(actions).toBeLessThanOrEqual(3);
  expect(backend.db.officeClicks.lastList).toMatchObject({ leads: 1, filters: { class_label: '8' } });
  // The class and "only with dues" are remembered for this login.
  await page.reload();
  await expect(page.locator('#fees-f-classes button[aria-pressed="true"]')).toHaveText('Class 8');
  await expect(page.locator('#fees-f-due')).toBeChecked();
  expect(errors).toEqual([]);
});

test('a manager who can see money collects a fee from Today; without money access there is no Collect', async ({ page, backend }) => {
  const errors = noErrors(page);
  const s = backend.db.seats.find((x) => x.id === env().seats.admin);
  s.access_role = 'manager'; s.can_see_money = true; backend.db.reports.money = true;
  await signIn(page, null, '#today');
  await expect(page.locator('#today-collect')).toBeVisible();
  await page.locator('#today-collect').click();
  await page.locator('#collect-q').fill('aarav');
  await page.locator('#collect-results .collect-hit').first().click();
  await expect(page.locator('#collect-amount')).toHaveValue('7000');
  await page.locator('#collect-save').click();
  await expect(page.locator('#collect-done')).toContainText('₹7,000 received from Aarav Shah');
  const pay = backend.db.fees.payments.find((p) => p.amount === 7000 && !p.reverses_id);
  expect(pay.recorded_by).toBe(s.id);
  // Undo of their own payment works.
  await page.locator('#collect-undo').click();
  await expect(page.locator('#collect-done')).toContainText('Undone');
  // Without money access: no Fees tab and no Collect.
  await page.locator('#signout').click();
  s.can_see_money = false; backend.db.reports.money = false;
  await signIn(page, null, '#today');
  await expect(page.locator('#today-collect')).toBeHidden();
  await expect(page.locator('#tab-link-fees')).toHaveCount(0);
  expect(errors).toEqual([]);
});
