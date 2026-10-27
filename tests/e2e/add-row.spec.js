// Add row: "+ Add one" beside every Excel import (js/admin/add-row.js), on the fake backend (block "// add row" of
// tests/e2e/fake-backend.js; the SQL is tested in supabase/tests/add_row_test.sql).
// - Fees: Accounts adds a student with a fee and "paid so far" (duplicates are shown first), then edits it.
// - Calling: a new calling list with 2 leads typed by hand, then "+ Add lead" on its page (repeat and bad number).
// - The ready Excel templates of both imports, and the forms on a 390px phone.
const fs = require('node:fs');
const { test, expect, env, isFake } = require('./fixtures');

test.beforeEach(() => { test.skip(!isFake(), 'uses the fake backend\'s ledger and calling list data'); });

async function signIn(page, email, hash) {
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(email);
  await page.locator('#gate-password').fill(env().password);
  await expect(page.locator('#gate-submit')).toHaveText('Sign in');
  await page.locator('#gate-submit').click();
}
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// The headings and first row of a downloaded .xlsx, and its sheet names.
async function readDownload(download) {
  const XLSX = require('xlsx');
  const file = await download.path();
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  return { names: wb.SheetNames, headers: rows[0], example: rows[1], rows: rows.length };
}

test('Accounts adds a student with a fee and paid so far, sees duplicates first, then edits the student', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { email } = backend.fees.addAccounts();
  await signIn(page, email);
  await expect(page.locator('#fees-body tr')).toHaveCount(1);   // Accounts starts with "Only with dues"

  // Two buttons side by side: Import from Excel and + Add student.
  await expect(page.locator('#fees-import-open')).toHaveText('Import from Excel');
  await expect(page.locator('#fees-add-open')).toHaveText('+ Add student');
  await page.locator('#fees-add-open').click();
  await expect(page.locator('#fees-add-open')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#fees-add h2')).toHaveText('Add a student');
  await expect(page.locator('#fsa-name')).toBeFocused();
  await expect(page.locator('#fsa-adm')).toBeHidden();   // under "More"

  // Required fields and a bad phone are named, and the cursor goes there.
  await page.locator('#fsa-save').click();
  await expect(page.locator('#fsa-msg')).toHaveText('Write the student\'s name.');
  await expect(page.locator('#fsa-name')).toBeFocused();
  await page.locator('#fsa-name').fill('Aarav Shah');
  await page.locator('#fsa-phone').fill('12345');
  await page.locator('#fsa-save').click();
  await expect(page.locator('#fsa-msg')).toContainText('not a 10-digit mobile number');
  await expect(page.locator('#fsa-phone')).toBeFocused();

  // Duplicates before saving: the same name and phone asks first; the same admission number is refused.
  await page.locator('#fsa-phone').fill('98765 00001');
  await page.locator('#fsa-save').click();
  await expect(page.locator('#fsa-dups')).toContainText('This student may already be in the list');
  await expect(page.locator('#fsa-dups')).toContainText('Aarav Shah with the same phone is already in the list (class 8-A).');
  await expect(page.locator('#fsa-dups a')).toHaveText('Open Aarav Shah');
  await expect(page.locator('#fsa-anyway')).toBeVisible();
  await page.locator('#fsa-name').fill('Kabir Jain');
  await page.locator('#fsa-more summary').click();
  await page.locator('#fsa-adm').fill('a101');
  await page.locator('#fsa-save').click();
  await expect(page.locator('#fsa-dups')).toContainText('Admission number A101 is already Aarav Shah\'s.');
  await expect(page.locator('#fsa-anyway')).toHaveCount(0);
  await expect(page.locator('#fsa-msg')).toHaveText('Not saved: the admission number is already used.');
  expect(backend.db.addRow.saved).toHaveLength(0);

  // A new student: details, one fee, and paid so far by UPI (which needs its reference).
  await page.locator('#fsa-adm').fill('A301');
  await page.locator('#fsa-class').fill('8');
  await page.locator('#fsa-section').fill('B');
  await page.locator('#fsa-board').selectOption('CBSE');
  await page.locator('#fsa-year').fill('2026-27');
  await page.locator('#fsa-parent').fill('Rakesh Jain');
  await page.locator('#fsa-phone').fill('98765 00011');
  const fee = page.locator('#fsa-fees .addrow-fee').first();
  await fee.locator('[data-k="head"]').fill('Term 2 tuition');
  await fee.locator('[data-k="amount"]').fill('18,000');
  await page.locator('#fsa-save').click();
  await expect(page.locator('#fsa-msg')).toHaveText('Pick the due date of Term 2 tuition.');
  await fee.locator('[data-k="due_date"]').fill(day(20));
  await page.locator('#fsa-paid').fill('6000');
  await page.locator('#fsa-paid-on').fill(day(-3));
  await page.locator('#fsa-paid-mode').selectOption('upi');
  await page.locator('#fsa-save').click();
  await expect(page.locator('#fsa-msg')).toContainText('enter the reference');
  await page.locator('#fsa-paid-ref').fill('UTR4455');
  await page.locator('#fsa-save').click();

  // The student's page opens with the fee and the payment.
  await expect(page).toHaveURL(/#fees\?student=/);
  await expect(page.locator('#fs-name')).toHaveText('Kabir Jain');
  await expect(page.locator('#fs-msg')).toHaveText('Kabir Jain added with 1 fee. Paid so far ₹6,000 recorded.');
  await expect(page.locator('#fs-total')).toContainText('₹18,000');
  await expect(page.locator('#fs-paid')).toContainText('₹6,000');
  await expect(page.locator('#fs-fee-body')).toContainText('Term 2 tuition');
  await expect(page.locator('#fs-pay-body')).toContainText('UTR4455');
  const kabir = backend.db.fees.students.find((s) => s.name === 'Kabir Jain');
  expect(kabir).toMatchObject({ admission_no: 'A301', class_label: '8', section: 'B', board: 'CBSE', academic_year: '2026-27',
    parent_name: 'Rakesh Jain', phone: '+919876500011', alt_phone: null, source: 'manual' });
  expect(backend.db.fees.items.filter((f) => f.student_id === kabir.id)).toMatchObject([{ head: 'Term 2 tuition', amount: 18000, due_date: day(20), academic_year: '2026-27' }]);
  expect(backend.db.fees.payments.filter((p) => p.student_id === kabir.id)).toMatchObject([{ amount: 6000, paid_on: day(-3), mode: 'upi', reference: 'UTR4455' }]);

  // Edit details: the same form, filled in. A duplicate is shown before saving here too.
  await page.locator('#fs-edit-open').click();
  await expect(page.locator('#fs-edit-open')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#fse-name')).toHaveValue('Kabir Jain');
  await expect(page.locator('#fse-phone')).toHaveValue('+919876500011');
  await expect(page.locator('#fse-fees')).toHaveCount(0);   // fees and payments are changed in their own panels
  await page.locator('#fse-adm').fill('A102');
  await page.locator('#fse-save').click();
  await expect(page.locator('#fse-dups')).toContainText('Admission number A102 is already Diya Rao\'s.');
  await page.locator('#fse-adm').fill('A301');
  await page.locator('#fse-section').fill('C');
  await page.locator('#fse-alt').fill('+91 98765 00099');
  await page.locator('#fse-save').click();
  await expect(page.locator('#fs-msg')).toHaveText('Details saved.');
  await expect(page.locator('#fs-student, #fees-student').first()).toContainText('8-C · CBSE');
  await expect(page.locator('#fees-student')).toContainText('+919876500099');
  expect(kabir).toMatchObject({ section: 'C', alt_phone: '+919876500099', name: 'Kabir Jain' });
  expect(backend.db.addRow.saved.map((x) => x.added)).toEqual([true, false]);

  // Back on the list (with every student, not only those with dues), the new student is there.
  await page.locator('#fs-back').click();
  await page.locator('#fees-f-due').uncheck();
  await expect(page.locator('#fees-body')).toContainText('Kabir Jain');
  expect(errors).toEqual([]);
});

test('a new calling list with 2 leads by hand, then + Add lead on a fees list', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  backend.db.reports.money = true;   // this owner may see money, so a fees list offers Amount due
  await signIn(page, env().users.admin.email, '#calling?new=1');
  await page.locator('#camp-w-name').fill('E2E hand list');
  await expect(page.locator('#camp-w-type-fees')).toHaveAttribute('aria-checked', 'true');

  // Step 3: Import from Excel (picked) or + Add by hand.
  await expect(page.locator('#camp-w-mode-excel')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#camp-w-mode-hand').click();
  await expect(page.locator('#camp-w-mode-hand')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#camp-w-excel')).toBeHidden();
  await expect(page.locator('#camp-w-hand thead th')).toHaveText(['Name', 'Phone', 'Student', 'Class', 'Amount due (₹)', '']);
  await expect(page.locator('#camp-w-hand-body tr')).toHaveCount(1);
  await expect(page.locator('#camp-w-hand-body button', { hasText: 'Remove' })).toBeDisabled();   // at least one row
  await expect(page.locator('#camp-w-hand-name-0')).toBeFocused();
  await page.locator('#camp-w-hand-name-0').fill('Asha Rao');
  await page.locator('#camp-w-hand-phone-0').fill('098765 43210');
  await page.locator('#camp-w-hand-x0-0').fill('Ravi');
  await page.locator('#camp-w-hand-x1-0').fill('10');
  await page.locator('#camp-w-hand-amount-0').fill('12,000');
  await page.locator('#camp-w-hand-add').click();
  await expect(page.locator('#camp-w-hand-body tr')).toHaveCount(2);
  await expect(page.locator('#camp-w-hand-name-1')).toBeFocused();
  await expect(page.locator('#camp-w-hand-name-0')).toHaveValue('Asha Rao');   // kept when a row is added
  await page.locator('#camp-w-hand-name-1').fill('Arun');
  await page.locator('#camp-w-hand-phone-1').fill('12345');
  await page.locator('#camp-w-start').click();
  await expect(page.locator('#camp-w-msg')).toHaveText('Row 2: The phone is not a 10-digit mobile number.');
  await expect(page.locator('#camp-w-hand-phone-1')).toBeFocused();
  await page.locator('#camp-w-hand-phone-1').fill('9876543211');
  await page.locator('#camp-w-start').click();
  await expect(page).toHaveURL(/#calling\?id=/);
  await expect(page.locator('#status')).toContainText('Calling list started: E2E hand list. 2 leads added.');
  await expect(page.locator('#camp-d-progress')).toContainText('0 / 2');
  expect(backend.db.addRow.leadCalls[0].rows).toEqual([
    { name: 'Asha Rao', phone: '+919876543210', amount_due: 12000, extra: { Student: 'Ravi', Class: '10' } },
    { name: 'Arun', phone: '+919876543211', amount_due: null, extra: {} },
  ]);

  // The list's page: Import from Excel or + Add lead. The form has the list's own fields.
  await expect(page.locator('#camp-d-mode-excel')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#camp-d-mode-one')).toHaveText('+ Add lead');
  await page.locator('#camp-d-mode-one').click();
  await expect(page.locator('#camp-d-one-name')).toBeFocused();
  await expect(page.locator('#camp-d-leads-form')).toBeHidden();
  await expect(page.locator('#camp-d-one-form')).toContainText('Student');
  await expect(page.locator('#camp-d-one-form')).toContainText('Class');
  await expect(page.locator('#camp-d-one-amount')).toBeVisible();
  await expect(page.locator('#camp-d-one-call')).toBeChecked();
  await expect(page.locator('#camp-d-one-wa')).not.toBeChecked();

  // A bad number is caught here; a number already on the list is a repeat (the server says so).
  await page.locator('#camp-d-one-name').fill('Meena Shah');
  await page.locator('#camp-d-one-phone').fill('12345');
  await page.locator('#camp-d-one-save').click();
  await expect(page.locator('#camp-d-one-result')).toHaveText('The phone is not a 10-digit mobile number.');
  await page.locator('#camp-d-one-phone').fill('+91 98765 43210');
  await page.locator('#camp-d-one-save').click();
  await expect(page.locator('#camp-d-one-result')).toHaveText('Not added: this number is already on E2E hand list.');
  await page.locator('#camp-d-one-phone').fill('98765 43212');
  await page.locator('#camp-d-one-x0').fill('Diya');
  await page.locator('#camp-d-one-x1').fill('8');
  await page.locator('#camp-d-one-amount').fill('7,000');
  await page.locator('#camp-d-one-source').fill('a call to our office');
  await page.locator('#camp-d-one-wa').check();
  await page.locator('#camp-d-one-save').click();
  await expect(page.locator('#camp-d-one-result')).toContainText('Meena Shah added to E2E hand list.');
  await expect(page.locator('#camp-d-progress')).toContainText('0 / 3');
  await expect(page.locator('#camp-d-mode-one')).toHaveAttribute('aria-pressed', 'true');   // ready for the next one
  await expect(page.locator('#camp-d-one-name')).toHaveValue('');
  const meena = backend.db.leads.find((l) => l.name === 'Meena Shah');
  expect(meena).toMatchObject({ phone: '+919876543212', amount_due: 7000, consent_call: true, consent_whatsapp: true,
    extra: { Student: 'Diya', Class: '8', source: 'a call to our office' } });
  expect(backend.db.addRow.leadCalls.slice(1).map((c) => c.rows.length)).toEqual([1, 1]);   // one row per "+ Add lead"
  expect(errors).toEqual([]);
});

test('no amount without money access, and the lead form for a sales list', async ({ page, backend }) => {
  await signIn(page, env().users.admin.email, '#calling?new=1');
  await page.locator('#camp-w-name').fill('E2E course');
  await page.locator('#camp-w-type-sales').click();
  await page.locator('#camp-w-mode-hand').click();
  await expect(page.locator('#camp-w-hand thead th')).toHaveText(['Name', 'Phone', 'Course', '']);
  await page.locator('#camp-w-type-fees').click();
  await expect(page.locator('#camp-w-hand thead th')).toHaveText(['Name', 'Phone', 'Student', 'Class', '']);   // no money access: no Amount due
  await page.locator('#camp-w-hand-name-0').fill('Priya');
  await page.locator('#camp-w-hand-phone-0').fill('9000000021');
  await page.locator('#camp-w-draft').click();
  await expect(page.locator('#camp-d-status')).toHaveText('Not started');
  await page.locator('#camp-d-mode-one').click();
  await expect(page.locator('#camp-d-one-name')).toBeVisible();
  await expect(page.locator('#camp-d-one-amount')).toHaveCount(0);
  expect(backend.db.addRow.leadCalls[0].rows).toEqual([{ name: 'Priya', phone: '+919000000021', amount_due: null, extra: {} }]);
});

test('ready Excel templates for both imports', async ({ page, backend }) => {
  backend.db.reports.money = true;
  await signIn(page, env().users.admin.email, '#fees');
  await page.locator('#fees-import-open').click();
  let wait = page.waitForEvent('download');
  await page.locator('#fees-imp-template').click();
  let dl = await wait;
  expect(dl.suggestedFilename()).toBe('vector-students-and-fees-template.xlsx');
  let x = await readDownload(dl);
  expect(x.names).toEqual(['Students', 'How to fill']);
  expect(x.headers).toEqual(['Admission no', 'Student name', 'Class', 'Section', 'Board', 'Academic year', 'Parent name', 'Phone',
    'Alternate phone', 'Fee head 1', 'Amount 1', 'Due date 1', 'Fee head 2', 'Amount 2', 'Due date 2', 'Paid so far', 'Paid on']);
  expect(x.example.slice(0, 3)).toEqual(['A101', 'Aarav Shah', '8']);
  expect(x.rows).toBe(2);
  await expect(page.locator('#fees-imp-msg')).toContainText('Template downloaded');

  // The lead template of New calling list: the fees type, with Amount due for this owner.
  await page.goto('/admin.html#calling?new=1');
  await expect(page.locator('#camp-w-name')).toBeVisible();
  wait = page.waitForEvent('download');
  await page.locator('#camp-w-template').click();
  dl = await wait;
  expect(dl.suggestedFilename()).toBe('vector-calling-list-template-fees.xlsx');
  x = await readDownload(dl);
  expect(x.headers).toEqual(['Name', 'Phone', 'Student', 'Class', 'Amount due', 'Source']);
  expect(x.example).toEqual(['Meena Shah', '9876500001', 'Aarav', '8', 12000, 'the enquiry form on our website']);

  // The filled template goes straight back into the lead picker.
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([x.headers, x.example, ['Arun', '9876500002', 'Kiran', '9', 8000, 'our office']]), 'Leads');
  await page.locator('#camp-w-leads-file').setInputFiles({ name: 'filled.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) });
  await expect(page.locator('#camp-w-leads-col-amount option:checked')).toHaveText('Amount due');
  await expect(page.locator('#camp-w-leads-skip')).toHaveText('2 leads ready.');
});

test('on a 390px phone the add forms fit, with no sideways scroll', async ({ page, backend }) => {
  backend.db.reports.money = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, env().users.admin.email, '#fees');
  await expect(page.locator('#fees-body tr')).toHaveCount(2);
  const both = [await page.locator('#fees-import-open').boundingBox(), await page.locator('#fees-add-open').boundingBox()];
  expect(Math.abs(both[0].y - both[1].y)).toBeLessThan(2);   // side by side
  await page.locator('#fees-add-open').click();
  await expect(page.locator('#fsa-form')).toBeVisible();
  await page.locator('#fsa-more summary').click();
  await page.locator('#fsa-fee-add').click();
  const width = () => page.evaluate(() => document.documentElement.scrollWidth);
  expect(await width()).toBeLessThanOrEqual(390);
  for (const id of ['#fsa-name', '#fsa-phone', '#fsa-paid-ref', '#fsa-save']) {
    const b = await page.locator(id).boundingBox();
    expect(b.x >= 0 && b.x + b.width <= 390, id).toBe(true);
  }
  // The student page's Edit details.
  await page.locator('#fees-body a', { hasText: 'Aarav Shah' }).click();
  await page.locator('#fs-edit-open').click();
  await expect(page.locator('#fse-form')).toBeVisible();
  expect(await width()).toBeLessThanOrEqual(390);

  await page.goto('/admin.html#calling?new=1');
  await page.locator('#camp-w-mode-hand').click();
  await page.locator('#camp-w-hand-add').click();
  await expect(page.locator('#camp-w-hand-body tr')).toHaveCount(2);
  expect(await width()).toBeLessThanOrEqual(390);
  const cell = await page.locator('#camp-w-hand-amount-1').boundingBox();
  expect(cell.x >= 0 && cell.x + cell.width <= 390).toBe(true);
  await page.locator('#camp-w-name').fill('E2E phone list');
  await page.locator('#camp-w-hand-name-0').fill('Asha');
  await page.locator('#camp-w-hand-phone-0').fill('9876543210');
  await page.locator('#camp-w-draft').click();
  await expect(page.locator('#camp-d-status')).toHaveText('Not started');
  await page.locator('#camp-d-mode-one').click();
  await expect(page.locator('#camp-d-one-form')).toBeVisible();
  expect(await width()).toBeLessThanOrEqual(390);
  const save = await page.locator('#camp-d-one-save').boundingBox();
  expect(save.x >= 0 && save.x + save.width <= 390).toBe(true);
});
