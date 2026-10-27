// Phase A.2: the Fees tab and the Accounts role, on the fake backend (tests/e2e/fake-backend.js, block
// "Phase A.2: fees"; the ledger SQL itself is tested in supabase/tests/ledger_test.sql). An Accounts seat sees
// only Fees (with its collection report), records a UPI payment from the student's page (the Collect screen), sees
// the balance drop, prints a receipt, reverses the payment, imports a small CSV and calls the parents with dues.
const { test, expect, env, isFake } = require('./fixtures');

test.beforeEach(async ({ page }) => {
  test.skip(!isFake(), 'uses the fake backend\'s ledger data');
  // window.print opens the browser's print dialog; count the calls instead.
  await page.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
});

async function signIn(page, email, hash) {
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
}

test('Accounts: only Fees; a UPI payment, its receipt, its reversal, an import and a fees calling list', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { email } = backend.fees.addAccounts();
  await signIn(page, email);

  // Only Fees, and it opens first. The password is in the account menu.
  await expect(page.locator('#tab-link-fees')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#tabs a')).toHaveCount(1);
  for (const id of ['today', 'calling', 'team', 'settings', 'home', 'reports', 'callers']) await expect(page.locator('#tab-link-' + id)).toHaveCount(0);
  await page.locator('#account-toggle').click();
  await expect(page.locator('#account-password')).toHaveAttribute('href', 'reset.html');
  await expect(page.locator('#account-password')).toHaveText('Change your password');
  await page.locator('#account-toggle').click();

  // Summary and list: Aarav owes 7,000 now; Diya has paid.
  await expect(page.locator('#fees-card-due')).toContainText('₹7,000');
  await expect(page.locator('#fees-card-due')).toContainText('1 student');
  await expect(page.locator('#fees-card-due')).toContainText('minus paid (office)');
  // Kiran left the school: his payments this week count in Collected (the fees office recorded them).
  await expect(page.locator('#fees-card-collected')).toContainText('Collected this month');
  // Accounts starts with "Only with dues" on.
  await expect(page.locator('#fees-f-due')).toBeChecked();
  await expect(page.locator('#fees-body tr')).toHaveCount(1);
  await page.locator('#fees-f-due').uncheck();
  await expect(page.locator('#fees-body tr')).toHaveCount(2);
  await expect(page.locator('#fees-foot')).toContainText('₹37,000');   // total fees 22,000 + 15,000
  await page.locator('#fees-f-search').fill('meena');
  await expect(page.locator('#fees-body tr')).toHaveCount(1);
  await expect(page.locator('#fees-body')).toContainText('Aarav Shah');

  // The student page.
  await page.locator('#fees-body a', { hasText: 'Aarav Shah' }).click();
  await expect(page).toHaveURL(/#fees\?student=/);
  await expect(page.locator('#fs-name')).toHaveText('Aarav Shah');
  await expect(page.locator('#fs-due')).toContainText('₹7,000');
  await expect(page.locator('#fs-calls')).toContainText('Will pay on date');
  await expect(page.locator('#fs-calls')).toContainText('parent said');

  // "Collect fee" opens the one payment form (Collect) for Aarav; a UPI payment needs a reference.
  await page.locator('#fs-collect').click();
  await expect(page).toHaveURL(/#fees\/collect\?student=.*&from=student$/);
  await expect(page.locator('#collect-amount')).toHaveValue('7000');
  await expect(page.locator('#collect-back')).toHaveText('← Student');
  await page.locator('#collect-amount').fill('2,000');
  await page.locator('.collect-mode[data-mode="upi"]').click();
  await expect(page.locator('#collect-save')).toBeDisabled();   // nothing recorded without a reference
  await page.locator('#collect-ref').fill('UTR998877665544');
  await page.locator('#collect-ref').press('Enter');
  await expect(page.locator('#collect-done')).toContainText('₹2,000 received from Aarav Shah · UPI');
  await expect(page.locator('#collect-next')).toHaveText('Next student');
  await expect(page.locator('#collect-q')).toBeFocused();
  const paid = backend.db.fees.payments.find((p) => p.reference === 'UTR998877665544');
  await page.locator('#collect-back').click();
  await expect(page.locator('#fs-due')).toContainText('₹5,000');
  expect(paid).toMatchObject({ amount: 2000, mode: 'upi' });
  const receipt = 'R-' + paid.id.replace(/-/g, '').slice(0, 8).toUpperCase();

  // Its receipt, printed.
  await page.getByRole('button', { name: 'Receipt ' + receipt }).click();
  await expect(page.locator('#fees-receipt')).toBeVisible();
  await expect(page.locator('#fees-r-inst')).toHaveText('E2E Institute A');
  await expect(page.locator('#fees-r-no')).toHaveText(receipt);
  await expect(page.locator('#fees-r-student')).toHaveText('Aarav Shah');
  await expect(page.locator('#fees-r-amount')).toHaveText('₹2,000');
  await expect(page.locator('#fees-r-words')).toHaveText('Rupees Two Thousand Only');
  await expect(page.locator('#fees-r-mode')).toHaveText('UPI');
  await expect(page.locator('#fees-r-ref')).toHaveText('UTR998877665544');
  await page.locator('#fees-r-print').click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  await expect(page.locator('body')).not.toHaveClass(/fees-printing/);   // only while the print runs
  await page.locator('#fees-r-close').click();
  await expect(page.locator('#fees-receipt')).toBeHidden();

  // Reverse it: the balance goes back up, and both lines stay.
  await page.getByRole('button', { name: 'Reverse ' + receipt }).click();
  await page.locator('#fs-rev-go').click();
  await expect(page.locator('#fs-rev-msg')).toContainText('reason');
  await page.locator('#fs-rev-reason').fill('Paid for another student');
  await page.locator('#fs-rev-go').click();
  await expect(page.locator('#fs-msg')).toContainText('reversed');
  await expect(page.locator('#fs-due')).toContainText('₹7,000');
  await expect(page.locator('#fs-pay-body')).toContainText('Reversal of ' + receipt + ': Paid for another student');
  await expect(page.locator('#fs-pay-body')).toContainText('Reversed (');
  expect(backend.db.fees.payments.filter((p) => p.reverses_id === paid.id)).toHaveLength(1);

  // Back to the list, then import three rows: one has an unknown board and is skipped.
  await page.locator('#fs-back').click();
  await expect(page.locator('#fees-list')).toBeVisible();
  await page.locator('#fees-f-search').fill('');
  await page.locator('#fees-import-open').click();
  const csv = [
    'Admission No,Student Name,Class,Section,Board,Father Name,Mobile,Academic Year,Tuition Fee,Tuition Due Date,Paid so far',
    'A201,Kabir Jain,8,B,CBSE,Rakesh Jain,98765 00011,2026-27,"18,000",01/04/2026,6000',
    'A202,Isha Nair,8,A,cbse,Suma Nair,9876500012,2026-27,18000,01/04/2026,',
    'A203,Tara Das,8,A,XYZ,,,2026-27,18000,01/04/2026,',
  ].join('\n');
  await page.locator('#fees-imp-file').setInputFiles({ name: 'students.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('#fees-imp-col-name')).toHaveValue('1');
  await expect(page.locator('#fees-imp-fee-amount-0')).toHaveValue('8');
  await expect(page.locator('#fees-imp-count')).toContainText('2 students ready; 1 row has a problem');
  await expect(page.locator('#fees-imp-problems')).toContainText('Row 4: Unknown board');
  await page.locator('#fees-imp-go').click();
  await expect(page.locator('#fees-imp-done')).toContainText('Added 2 students');
  await expect(page.locator('#fees-imp-done')).toContainText('2 fee items and 1 opening payment added');
  expect(backend.db.fees.lastImport[0]).toMatchObject({
    admission_no: 'A201', name: 'Kabir Jain', class_label: '8', section: 'B', board: 'CBSE', parent_name: 'Rakesh Jain',
    phone: '+919876500011', academic_year: '2026-27', paid_so_far: 6000,
    fees: [{ head: 'Tuition', amount: 18000, due_date: '2026-04-01', academic_year: '2026-27' }],
  });
  await expect(page.locator('#fees-body')).toContainText('Kabir Jain');

  // Call these parents: class 8 with dues, the live fees script, open to all callers; one line, then Start.
  await page.locator('#fees-f-classes button', { hasText: 'Class 8' }).click();
  await page.locator('#fees-f-due').check();
  await expect(page.locator('#fees-body tr')).toHaveCount(3);
  await expect(page.locator('#fees-call')).toHaveText('Call these 3 parents');
  await page.locator('#fees-call').click();
  await expect(page.locator('#fees-call-text')).toContainText('3 parents');
  await expect(page.locator('#fees-call-text')).toContainText('Script: Fees reminder');
  await page.locator('#fees-call-start').click();
  await expect(page.locator('#fees-call-made')).toContainText('started: 3 parents to call');
  await expect(page.locator('#fees-call-link')).toHaveCount(0);   // Accounts has no Calling tab
  const made = backend.db.officeClicks.lastList;
  expect(made.filters).toMatchObject({ class_label: '8' });
  expect(made.leads).toBe(3);   // Aarav, Kabir and Isha
  const camp = backend.db.campaigns.find((c) => c.id === made.id);
  expect(camp).toMatchObject({ status: 'running', open_to_all: true, script_id: backend.db.fees.scripts[0].id });

  // The collection report inside Fees: from the ledger, for every calling list and caller; Accounts gets no list
  // or caller filter (those lists are for owners and managers) and no error. Old #reports links come here too.
  await page.locator('#fees-view-report').click();
  await expect(page).toHaveURL(/#fees\/report$/);
  await expect(page.locator('#rp-fees-msg')).toContainText('Collected in these dates');
  await expect(page.locator('#rp-picker')).toBeHidden();
  await expect(page.locator('#rp-excel')).toBeVisible();
  await expect(page.locator('#rp-campaign')).toBeHidden();
  await expect(page.locator('#rp-caller')).toBeHidden();
  await expect(page.locator('#rp-msg')).toHaveText('');
  expect(errors).toEqual([]);
});

test('an owner on a phone: students as cards, Collect fee opens the Collect screen, nothing scrolls sideways', async ({ page, backend }) => {
  backend.db.reports.money = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, env().users.admin.email, '#fees');
  await expect(page.locator('#tab-link-fees')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#tab-link-today')).toBeVisible();
  await expect(page.locator('#fees-body tr')).toHaveCount(2);
  // A card: name, class and due now; the other columns are on the student's page.
  const aarav = page.locator('#fees-body tr', { hasText: 'Aarav Shah' });
  await expect(aarav.locator('td.fees-due')).toBeVisible();
  await expect(aarav.locator('td.fees-class')).toBeVisible();
  await expect(aarav.locator('td[data-label="Parent"]')).toBeHidden();
  await expect(aarav.locator('td[data-label="Total fees"]')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await aarav.getByRole('link', { name: 'Collect fee from Aarav Shah' }).click();
  await expect(page).toHaveURL(/#fees\/collect\?student=/);
  await expect(page.locator('#collect-pay')).toBeVisible();
  await expect(page.locator('#collect-amount')).toBeFocused();
  const form = await page.locator('#collect-pay').boundingBox();
  expect(form.x >= 0 && form.x + form.width <= 390).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a wide screen keeps the table, without the Collect fee column', async ({ page }) => {
  await signIn(page, env().users.admin.email, '#fees');
  await expect(page.locator('#fees-body tr')).toHaveCount(2);
  await expect(page.locator('#fees-body tr').first().locator('td[data-label="Parent"]')).toBeVisible();
  await expect(page.locator('#fees-body .fees-pay').first()).toBeHidden();
});
