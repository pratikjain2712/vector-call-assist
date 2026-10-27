// Fees basics on the fake backend (tests/e2e/fake-backend.js, block "fees basics"; the SQL itself is tested in
// supabase/tests/fee_plans_test.sql): a Class 8 fee plan made in three steps and applied (preview, then counts),
// applying again adds nothing, a sibling discount on a student (balance and receipt), Today's collection with its
// totals, Print and Excel, and the screens at 390px. With FEES_SHOTS=<folder> it also saves screenshots.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, env, isFake } = require('./fixtures');

const SHOTS = process.env.FEES_SHOTS || '';
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

test.beforeEach(async ({ page }) => {
  test.skip(!isFake(), 'uses the fake backend\'s ledger data');
  await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
});

async function signIn(page, email, hash) {
  const vp = page.viewportSize();
  if (!vp || vp.width > 700) await page.setViewportSize({ width: 1440, height: 900 });   // the wide screens at 1440
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
}

const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// Two more Class 8 students next to Aarav (who already has Term 1 and Term 2 from an import): Bala uses the bus.
function classEight(backend) {
  const F = backend.fees;
  const inst = F.aarav.institute_id;
  const bala = F.newStudent(inst, { admission_no: 'A111', name: 'Bala Iyer', class_label: '8', section: 'B', board: 'CBSE', academic_year: '2026-27',
    parent_name: 'Lata Iyer', phone: '+919876500021', uses_bus: true });
  const chirag = F.newStudent(inst, { admission_no: 'A112', name: 'Chirag Rao', class_label: '8', section: 'A', board: 'CBSE', academic_year: '2026-27',
    parent_name: 'Mohan Rao', phone: '+919876500022' });
  return { bala, chirag };
}

async function fillFee(page, i, head, amount, due, who) {
  await page.locator('#fp-fee-' + i + '-head').fill(head);
  await page.locator('#fp-fee-' + i + '-amount').fill(amount);
  await page.locator('#fp-fee-' + i + '-due').fill(due);
  if (who) await page.locator('#fp-fee-' + i + '-who').selectOption(who);
}

test('a Class 8 fee plan in three steps: preview, apply, counts; applying again adds nothing', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { bala, chirag } = classEight(backend);
  const { email } = backend.fees.addAccounts();
  await signIn(page, email);
  await expect(page.locator('#tab-link-fees')).toHaveAttribute('aria-current', 'page');

  await page.locator('#fees-view-plans').click();
  await expect(page).toHaveURL(/#fees\/plans$/);
  await expect(page.locator('#fp-empty')).toContainText('No fee plan yet');
  await shot(page, 'fee-plan-empty-1440');
  await page.locator('#fp-new').click();

  // Step 1 of 3: class and year.
  await expect(page.locator('#fp-edit .fb-step-no')).toHaveText('Step 1 of 3');
  await page.locator('#fp-next').click();
  await expect(page.locator('#fp-form-msg')).toHaveText('Write the class. For example: 8');
  await page.locator('#fp-class').fill('8');
  await page.locator('#fp-year').fill('2026-27');
  await page.locator('#fp-more summary').click();   // board: a rare option
  await page.locator('#fp-board').selectOption('CBSE');
  await expect(page.locator('#fp-auto')).toBeChecked();
  await shot(page, 'fee-plan-step1-1440');
  await page.locator('#fp-next').click();

  // Step 2 of 3: the fees (Term 1 and Term 2 are filled in, amounts empty), a bus fee and a sibling discount.
  await expect(page.locator('#fp-edit .fb-step-no')).toHaveText('Step 2 of 3');
  await expect(page.locator('#fp-fee-0-head')).toHaveValue('Term 1 tuition');
  await expect(page.locator('#fp-fee-1-head')).toHaveValue('Term 2 tuition');
  await page.locator('#fp-save').click();
  await expect(page.locator('#fp-form-msg')).toContainText('Write the amount of Term 1 tuition in rupees');
  await fillFee(page, 0, 'Term 1 tuition', '12,000', shift(-30));
  await fillFee(page, 1, 'Term 2 tuition', '10000', shift(40));
  await page.locator('#fp-fee-add').click();
  await fillFee(page, 2, 'Bus fee', '4000', shift(-10), 'bus');
  await page.locator('#fp-more2 summary').click();
  await page.locator('#fp-rule-add').click();
  await expect(page.locator('#fp-rule-0-percent')).toHaveValue('10');
  await shot(page, 'fee-plan-step2-1440');
  await page.locator('#fp-save').click();

  // Step 3 of 3: the preview in words, ticks for the bus fee (Bala uses the bus) and the sibling discount.
  await expect(page.locator('#fp-preview .fb-step-no')).toHaveText('Step 3 of 3');
  await expect(page.locator('#fp-saved')).toHaveText('Fee plan saved.');
  await expect(page.locator('#fp-sentence')).toHaveText('This will add 5 fees (₹48,000 in all) for 2 students in Class 8 (CBSE). Continue?');
  await expect(page.locator('#fp-pv-items')).toContainText('Term 1 tuition · ₹12,000');
  await expect(page.locator('#fp-pv-items')).toContainText('add for 2 students · 1 already has it');
  const busCol = backend.db.feesBasics.items.find((it) => it.head === 'Bus fee').id;
  const ruleCol = backend.db.feesBasics.rules[0].id;
  await expect(page.locator('#fp-ticks tr[data-student="' + bala.id + '"] input[data-col="' + busCol + '"]')).toBeChecked();
  await expect(page.locator('#fp-ticks tr[data-student="' + chirag.id + '"] input[data-col="' + busCol + '"]')).not.toBeChecked();
  await page.locator('#fp-ticks tr[data-student="' + chirag.id + '"] input[data-col="' + ruleCol + '"]').check();
  await expect(page.locator('#fp-sentence')).toHaveText('This will add 5 fees (₹48,000 in all) for 2 students in Class 8 (CBSE). It will also give 1 discount. Continue?');
  await shot(page, 'fee-plan-preview-1440');
  await page.locator('#fp-go').click();
  await expect(page.locator('#fp-done')).toHaveText('Done. 5 fees added, 1 discount given for 2 students. Balances and calling lists are updated.');
  await expect(page.locator('#fp-undo')).toBeVisible();
  await shot(page, 'fee-plan-done-1440');
  const F = backend.db.fees;
  expect(F.items.filter((f) => f.student_id === bala.id && !f.is_void).map((f) => f.head).sort()).toEqual(['Bus fee', 'Term 1 tuition', 'Term 2 tuition']);
  expect(F.items.filter((f) => f.student_id === backend.fees.aarav.id && !f.is_void)).toHaveLength(2);   // linked, not charged twice
  expect(F.discounts.filter((d) => d.student_id === chirag.id).map((d) => d.amount).sort()).toEqual([1000, 1200]);
  const call = backend.db.feesBasics.calls.find((c) => c.fn === 'fee_plan_apply');
  expect(call.args.p_chosen[busCol]).toEqual([bala.id]);
  expect(call.args.p_rules[ruleCol]).toEqual([chirag.id]);

  // Back to the plans: everyone has the fees; applying again shows "Nothing to add" and adds nothing.
  await page.locator('#fp-back-list').click();
  const card = page.locator('.fb-plan').first();
  await expect(card).toContainText('Class 8 (CBSE) · 2026-27');
  await expect(card).toContainText('3 students');
  await expect(card).toContainText('Every student of Class 8 (CBSE) has these fees.');
  await shot(page, 'fee-plan-list-1440');
  const before = F.items.length;
  await card.getByRole('button', { name: 'Apply to all students in Class 8' }).click();
  await expect(page.locator('#fp-sentence')).toHaveText('Every student in Class 8 (CBSE) already has these fees. Nothing to add.');
  await expect(page.locator('#fp-go')).toBeDisabled();
  expect(F.items.length).toBe(before);

  // Changing Term 2 to 11,000: "apply the change to 3 students".
  await page.locator('#fp-pv-back').click();
  await card.getByRole('button', { name: 'Change the fees' }).click();
  await page.locator('#fp-next').click();
  await page.locator('#fp-fee-1-amount').fill('11000');
  await page.locator('#fp-save').click();
  await expect(page.locator('#fp-sentence')).toHaveText('This will change Term 2 tuition to ₹11,000 for 3 students in Class 8 (CBSE). Continue?');
  await page.locator('#fp-pv-back').click();
  await expect(page.locator('.fb-plan').first().locator('.fb-callout')).toHaveText('The plan changed. Apply the change to 3 students.');
  expect(errors).toEqual([]);
});

test('a sibling discount: the balance drops, the receipt shows it, Remove keeps it in the history', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { email } = backend.fees.addAccounts();
  await signIn(page, email, '#fees?student=' + backend.fees.aarav.id);
  await expect(page.locator('#fs-name')).toHaveText('Aarav Shah');
  await expect(page.locator('#fs-due')).toContainText('₹7,000');
  await expect(page.locator('#fs-disc-empty')).toHaveText('No discount for this student.');

  // One screen: the amount, the reason (Sibling to start), the whole year, the check sentence, one button.
  await page.locator('#fs-disc-open').click();
  await expect(page.locator('#fd-value')).toBeFocused();
  await expect(page.locator('#fd-kind-amount')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#fd-next').click();
  await expect(page.locator('#fd-msg')).toContainText('Write the amount in rupees');
  await page.locator('#fd-value').fill('1000');
  await expect(page.locator('#fd-reason-sibling')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#fd-on')).toHaveText('On the whole year');
  await expect(page.locator('#fd-approved')).toHaveValue('Fees office');
  await expect(page.locator('#fd-check')).toHaveText('The discount is ₹1,000. Aarav Shah\'s fees left for the year go from ₹17,000 to ₹16,000.');
  await shot(page, 'discount-step3-1440');
  await page.locator('#fd-next').click();

  await expect(page.locator('#fs-msg')).toHaveText('Discount of ₹1,000 given to Aarav Shah.');
  await expect(page.locator('#fs-left')).toContainText('₹16,000');
  await expect(page.locator('#fs-total')).toContainText('after ₹1,000 discount');
  await expect(page.locator('#fs-due')).toContainText('₹6,454.55');   // Term 1's share (545.45) is due now
  await expect(page.locator('#fs-disc-body')).toContainText('Sibling · on the whole year');
  await expect(page.locator('#fs-disc-body')).toContainText('−₹1,000');
  await expect(page.locator('#fs-fee-body')).toContainText('−₹545.45');
  await expect(page.locator('#fs-disc-undo')).toBeVisible();
  await shot(page, 'student-discount-1440');

  // The receipt of the cash payment shows the year's account with the discount.
  const cash = backend.db.fees.payments.find((p) => p.student_id === backend.fees.aarav.id && p.mode === 'cash');
  await page.getByRole('button', { name: 'Receipt R-' + cash.id.replace(/-/g, '').slice(0, 8).toUpperCase() }).click();
  await expect(page.locator('#fees-r-fees')).toHaveText('₹22,000');
  await expect(page.locator('#fees-r-discount')).toHaveText('−₹1,000 (Sibling)');
  await expect(page.locator('#fees-r-paid')).toHaveText('₹5,000');
  await expect(page.locator('#fees-r-left')).toHaveText('₹16,000');
  await shot(page, 'receipt-discount-1440');
  await page.locator('#fees-r-close').click();

  // Remove it, with a reason: the balance goes back; the line stays, crossed out.
  await page.getByRole('button', { name: /^Remove the discount Sibling/ }).click();
  await page.locator('#fs-disc-rm-go').click();
  await expect(page.locator('#fs-disc-rm-msg')).toContainText('reason');
  await page.locator('#fs-disc-rm-reason').fill('Brother left the school');
  await page.locator('#fs-disc-rm-go').click();
  await expect(page.locator('#fs-msg')).toContainText('Discount removed');
  await expect(page.locator('#fs-due')).toContainText('₹7,000');
  await expect(page.locator('#fs-disc-body tr.void')).toContainText('Removed: Brother left the school');
  expect(backend.db.fees.discounts.every((d) => d.is_removed)).toBe(true);
  expect(errors).toEqual([]);
});

test('Today\'s collection: totals by mode and person, cheques, reversals, in words; Print and Excel', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  backend.db.reports.money = true;
  const F = backend.fees;
  const today = shift(0);
  const owner = backend.db.seats.find((s) => s.label === 'E2E Admin').id;
  const { email } = F.addAccounts();
  const acc = backend.db.seats.find((s) => s.label === 'Fees office').id;
  // Kiran already paid UPI 1,000 today (the fees block). Aarav: cash 2,000 and a cheque of 3,000 today; a cash 500 typed twice and reversed.
  F.addPayment(F.aarav, { amount: 2000, paid_on: today, mode: 'cash', recorded_by: acc, created_at: today + 'T04:00:00.000Z' });
  F.addPayment(F.aarav, { amount: 3000, paid_on: today, mode: 'cheque', reference: 'Chq 100200', recorded_by: owner, created_at: today + 'T05:00:00.000Z' });
  const wrong = F.addPayment(F.aarav, { amount: 500, paid_on: today, mode: 'cash', recorded_by: acc, created_at: today + 'T05:30:00.000Z' });
  F.addPayment(F.aarav, { amount: 500, paid_on: today, mode: 'cash', reverses_id: wrong.id, note: 'Typed twice', recorded_by: acc, created_at: today + 'T05:35:00.000Z' });
  await signIn(page, env().users.admin.email, '#fees');
  await expect(page.locator('#fees-today-open')).toBeVisible();
  await shot(page, 'fees-tab-1440');
  await page.locator('#fees-today-open').click();
  await expect(page).toHaveURL(/#fees\/today$/);
  await expect(page.locator('#dc-day')).toHaveValue(today);
  await expect(page.locator('#dc-total-value')).toHaveText('₹6,000');
  await expect(page.locator('#dc-words')).toHaveText('Rupees Six Thousand Only');
  await expect(page.locator('#dc-total')).toContainText('3 payments · 1 payment cancelled, not counted');
  await expect(page.locator('#dc-mode-cash')).toContainText('₹2,000');
  await expect(page.locator('#dc-mode-upi')).toContainText('₹1,000');
  await expect(page.locator('#dc-mode-cheque')).toContainText('₹3,000');
  await expect(page.locator('#dc-mode-card')).toContainText('₹0');
  await expect(page.locator('#dc-persons')).toContainText('E2E Admin');
  await expect(page.locator('#dc-persons')).toContainText('Fees office');
  await expect(page.locator('#dc-cheques')).toContainText('Chq 100200');
  await expect(page.locator('#dc-cheque-total')).toHaveText('1 cheque, ₹3,000 in all');
  await expect(page.locator('#dc-payments tbody tr')).toHaveCount(4);
  await expect(page.locator('#dc-payments tr.reversed')).toContainText('cancelled: Typed twice');
  await expect(page.locator('#dc-reversals')).toContainText('Typed twice');
  await shot(page, 'todays-collection-1440');

  await page.locator('#dc-print').click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  await expect(page.locator('body')).not.toHaveClass(/fees-printing-day/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#dc-excel').click()]);
  expect(download.suggestedFilename()).toBe('vector-collection-' + today + '.xlsx');
  expect(backend.db.reports.exports.some((x) => x.what === 'day_closing')).toBe(true);
  await expect(page.locator('#dc-msg')).toContainText('Saved vector-collection-');

  // Yesterday: Kiran's cash 2,000 and the reversed 3,000.
  await page.locator('#dc-day').fill(shift(-1));
  await page.locator('#dc-day').dispatchEvent('change');
  await expect(page.locator('#dc-total-value')).toHaveText('₹2,000');
  expect(errors).toEqual([]);
});

test('390px: fee plan, today\'s collection and the discount steps fit, buttons on screen, nothing scrolls sideways', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  backend.db.reports.money = true;
  classEight(backend);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, env().users.admin.email, '#fees');
  await expect(page.locator('#fees-today-open')).toBeVisible();
  const big = await page.locator('#fees-today-open').boundingBox();
  expect(big.x >= 0 && big.x + big.width <= 390).toBe(true);
  await shot(page, 'fees-tab-390');
  const noSideScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await noSideScroll();

  // A plan, made on the phone.
  await page.locator('#fees-view-plans').click();
  await page.locator('#fp-new').click();
  await page.locator('#fp-class').fill('8');
  await page.locator('#fp-year').fill('2026-27');
  await page.locator('#fp-more summary').click();
  await page.locator('#fp-board').selectOption('CBSE');
  await shot(page, 'fee-plan-step1-390');
  await noSideScroll();
  await page.locator('#fp-next').click();
  await fillFee(page, 0, 'Term 1 tuition', '12000', shift(-30));
  await fillFee(page, 1, 'Term 2 tuition', '10000', shift(40));
  await shot(page, 'fee-plan-step2-390');
  await noSideScroll();
  await page.locator('#fp-save').click();
  await expect(page.locator('#fp-sentence')).toHaveText('This will add 4 fees (₹44,000 in all) for 2 students in Class 8 (CBSE). Continue?');
  await shot(page, 'fee-plan-preview-390');
  await noSideScroll();
  for (const id of ['#fp-go', '#fp-pv-back']) {
    const b = await page.locator(id).boundingBox();
    expect(b.x >= 0 && b.x + b.width <= 390).toBe(true);
  }
  await page.locator('#fp-go').click();
  await expect(page.locator('#fp-done')).toContainText('Done. 4 fees added for 2 students.');
  await page.locator('#fp-back-list').click();
  await shot(page, 'fee-plan-list-390');
  await noSideScroll();

  // Today's collection.
  await page.locator('#fees-today-open').click();
  await expect(page.locator('#dc-total-value')).toHaveText('₹1,000');
  await shot(page, 'todays-collection-390');
  await noSideScroll();

  // The discount steps on a student.
  await page.goto('/admin.html#fees?student=' + backend.fees.aarav.id);
  await expect(page.locator('#fs-name')).toHaveText('Aarav Shah');
  await page.locator('#fs-disc-open').click();
  await page.locator('#fd-kind-percent').click();
  await page.locator('#fd-value').fill('10');
  await expect(page.locator('#fd-check')).toContainText('The discount is ₹2,200.');
  await shot(page, 'discount-step3-390');
  await noSideScroll();
  const next = await page.locator('#fd-next').boundingBox();
  expect(next.x >= 0 && next.x + next.width <= 390).toBe(true);
  await page.locator('#fd-next').click();
  await expect(page.locator('#fs-msg')).toHaveText('Discount of ₹2,200 given to Aarav Shah.');
  await shot(page, 'student-discount-390');
  await noSideScroll();
  expect(errors).toEqual([]);
});
