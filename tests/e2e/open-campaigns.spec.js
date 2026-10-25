// Phase A.2: caller. Open campaigns on the caller page: the campaign picker (grouped by purpose, filtered by class
// and board, "N waiting"), a lead from the pool (next_free_lead) with its source and ledger, placeholders filled
// in the script and in the common answers, and "Save as …" on a common answer.
// Fake backend only: the data is set up in tests/e2e/fake-backend.js (addCampaign, db.ledger, db.commonAnswers).
const { test, expect, env, isFake, intoWorkspace } = require('./fixtures');

const R = (key, label, extra) => Object.assign({ key, label, needs_date: false, needs_amount: false, needs_reason: false, needs_rating: false,
  reason_choices: null, counts_as_good: false, common: false }, extra);
const FEES_RESULTS = [
  R('paid', 'Paid', { needs_amount: true, counts_as_good: true }),
  R('will_pay_on', 'Will pay on date', { needs_date: true, needs_amount: true, counts_as_good: true }),
  R('no_answer', 'No answer', { common: true }),
  R('call_back_later', 'Call back later', { needs_date: true, common: true }),
  R('do_not_call', 'Do not call again', { common: true }),
];
const SCRIPT = [
  { id: 'hello', start: true, stage: 0, say: ['Hello, am I speaking with {name}?',
    'This is {me} from {institute}. I am calling about {student}\'s fee of {amount_due}, due by {due_date}.'], opts: [{ label: 'Yes', to: 'bye' }] },
  { id: 'bye', title: 'Thank them' },
];
const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();

function setUp(backend) {
  const seat = env().seats.rep2;
  backend.db.features = ['scripts'];
  backend.db.callerScripts.fees8 = { id: 'fees8', version: 1, steps: SCRIPT };
  backend.db.ledger.st1 = { balance_due_now: 12000, balance_total: 30000, last_payment_amount: 6000, last_payment_on: '2026-10-02', last_payment_mode: 'upi' };
  const open = { open_to_all: true, share_mode: 'next_free', members: [] };
  backend.addCampaign(Object.assign({ name: 'Spoken English leads', type_key: 'sales', type_label: 'Sales', results: FEES_RESULTS }, open));
  const fees8 = backend.addCampaign(Object.assign({
    name: 'Term 2 fees', type_key: 'fees', type_label: 'Fees collection', class_label: '8th', board: 'CBSE', script_id: 'fees8', results: FEES_RESULTS,
    leads: [
      { name: 'Sunita Sharma', phone: '+919876543210', student_id: 'st1', amount_due: 18000, created_at: ago(9),
        extra: { student: 'Aarav', source: 'the enquiry form on our website', enquiry_date: '2026-10-12' } },
      { name: 'Kavita Rao', phone: '+919876543211', amount_due: 9000, created_at: ago(1), extra: { student: 'Anu' } },
    ],
  }, open));
  backend.addCampaign(Object.assign({ name: 'Term 2 fees', type_key: 'fees', type_label: 'Fees collection', class_label: '10th', board: 'CBSE', results: FEES_RESULTS,
    leads: [{ name: 'Meena Iyer', phone: '+919876543212', created_at: ago(2) }] }, open));
  backend.addCampaign(Object.assign({ name: 'Admissions 2027', type_key: 'admission', type_label: 'Admission enquiry', class_label: '8th', results: FEES_RESULTS }, open));
  // Restricted to other callers: not offered.
  backend.addCampaign({ name: 'Members only', type_key: 'fees', type_label: 'Fees collection', results: FEES_RESULTS, members: ['someone-else'] });
  return fees8;
}

test.beforeEach(() => { test.skip(!isFake(), 'campaign data is set up in the fake backend only'); });

test('a caller filters open campaigns by class 8th and Fees, gets a pool lead with source and balance, and answers "Where did you get my number?"', async ({ page, backend }) => {
  const fees8 = setUp(backend);
  await intoWorkspace(page, 'rep2');

  // The picker: every open campaign, grouped by purpose; the restricted one is not there.
  const pick = page.locator('#camp-pick');
  await expect(pick).toContainText('Spoken English leads');
  await pick.click();
  const picker = page.locator('#camp-picker');
  await expect(picker).toBeVisible();
  await expect(pick).toHaveAttribute('aria-expanded', 'true');
  await expect(picker.locator('h3')).toHaveText(['Fees (2)', 'Admissions (1)', 'Sales (1)']);
  await expect(picker).not.toContainText('Members only');

  // Filter: class 8th, then Fees.
  await picker.locator('.campchip[data-filter="class_label"][data-value="8th"]').click();
  await expect(picker.locator('h3')).toHaveText(['Fees (1)', 'Admissions (1)']);
  await picker.locator('.campchip[data-filter="purpose"][data-value="fees"]').click();
  await expect(picker.locator('.campchip[data-filter="purpose"][data-value="fees"]')).toHaveAttribute('aria-pressed', 'true');
  const items = picker.locator('.picklist .campitem');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('8th · CBSE · Fees collection');
  await expect(items.first()).toContainText('2 waiting');
  await expect(picker.locator('#camp-sheet')).toHaveText('My lead sheet (no campaign)');
  await items.first().click();
  await expect(picker).toBeHidden();
  await expect(pick).toContainText('Term 2 fees');
  await expect(pick).toContainText('8th · CBSE');

  // The pool hands out the oldest lead; the card shows where it came from and the ledger.
  const card = page.locator('#camp-lead');
  await expect(card).toContainText('Sunita Sharma');
  await expect(page.locator('#camp-source')).toHaveText('Source: the enquiry form on our website · 12 Oct');
  await expect(card).toContainText('Amount due: ₹18,000');
  await expect(card).toContainText('Balance due now: ₹12,000');
  await expect(card).toContainText('Last payment: ₹6,000 on 2 Oct by UPI');
  expect(backend.db.leads.find((l) => l.name === 'Sunita Sharma').assigned_seat_id).toBe(env().seats.rep2);

  // The campaign's script, placeholders filled; the missing due date is left out, never shown as {due_date}.
  const stage = page.locator('#stage');
  await expect(stage).toContainText('Hello, am I speaking with Sunita Sharma?');
  await expect(stage).toContainText('This is Pratik from E2E Institute A. I am calling about Aarav\'s fee of ₹18,000.');
  await expect(stage).not.toContainText('{');

  // Search "number": the common answer, filled with the lead's source and date.
  await page.locator('#help-search').fill('number');
  const help = page.locator('#help-col');
  await expect(help.locator('.help-q').first()).toHaveText('Where did you get my number?');
  await help.locator('.help-q').first().click();
  await expect(help.locator('.help-a')).toContainText('We got your number from the enquiry form on our website, on 12 October.');
  // Answers that need the institute's facts first stay hidden ("Which number can I call you back on?").
  await expect(help.locator('.help-q', { hasText: 'Which number can I call you back on?' })).toHaveCount(0);

  // "Do not call me again": one tap saves the result, and the next pool lead comes up.
  await page.locator('#help-search').fill('do not call');
  await help.locator('.help-q', { hasText: 'Do not call me again' }).click();
  await expect(page.locator('#help-save')).toHaveText('Save as Do not call again');
  await page.locator('#help-save').click();
  await expect(page.locator('#sheet-msg')).toHaveText('Saved: Do not call again for Sunita Sharma.');
  await expect.poll(() => backend.db.saved.length).toBe(1);
  expect(backend.db.saved[0].p_result_key).toBe('do_not_call');
  expect(backend.db.saved[0].campaign_id).toBe(fees8.id);
  await expect(card).toContainText('Kavita Rao');

  // The pick is remembered.
  await page.reload();
  await expect(page.locator('#camp-pick')).toContainText('Term 2 fees');
  await expect(page.locator('#camp-pick')).toContainText('8th · CBSE');
});

test('the picker closes with Escape, keeps "My lead sheet", and a call back answer asks for its date first', async ({ page, backend }) => {
  setUp(backend);
  await intoWorkspace(page, 'rep2');
  await page.locator('#camp-pick').click();
  await page.locator('#camp-picker .campitem', { hasText: '10th' }).click();
  await expect(page.locator('#camp-lead')).toContainText('Meena Iyer');
  // No source on this lead: the card says so, with the date it was added; no ledger without a student.
  await expect(page.locator('#camp-source')).toContainText('Source: not recorded · added');
  await expect(page.locator('#camp-lead')).not.toContainText('Balance due now');

  await page.locator('#help-search').fill('busy');
  await page.locator('#help-col .help-q', { hasText: 'I am busy, call later' }).click();
  await page.locator('#help-save').click();
  await expect(page.locator('#res-call_back_later')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#res-msg')).toHaveText('Fill this in, then save.');
  await expect(page.locator('#res-date')).toBeFocused();
  expect(backend.db.saved.length).toBe(0);

  await page.locator('#camp-pick').click();
  await expect(page.locator('#camp-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#camp-picker')).toBeHidden();
  await expect(page.locator('#camp-pick')).toBeFocused();
  await page.locator('#camp-pick').click();
  await page.locator('#camp-sheet').click();
  await expect(page.locator('#sheet-section')).toBeVisible();
  await expect(page.locator('#camp-pick')).toContainText('My lead sheet (no campaign)');
});

test('the institute\'s own common answers come from the database when it has them', async ({ page, backend }) => {
  setUp(backend);
  backend.db.commonAnswers = [
    { key: 'location', label: 'Where is the institute?', answer: '{institute} is near the City Bus Stand.', tags: ['all'], check: ['Add your address.'], filled: true },
    { key: 'fee_amount', label: 'How much is the fee?', answer: 'Let me tell you.', tags: ['all'], check: ['Fee list.'], filled: false },
  ];
  await intoWorkspace(page, 'rep2');
  await page.locator('#help-search').fill('institute');
  await page.locator('#help-col .help-q', { hasText: 'Where is the institute?' }).click();
  await expect(page.locator('#help-col .help-a')).toContainText('E2E Institute A is near the City Bus Stand.');
  await page.locator('#help-search').fill('fee');
  await expect(page.locator('#help-col .help-q', { hasText: 'How much is the fee?' })).toHaveCount(0);
});

for (const width of [1600, 1200, 390]) {
  test(`the picker and the lead card fit at ${width}px with no sideways scroll`, async ({ page, backend }) => {
    setUp(backend);
    await page.setViewportSize({ width, height: 900 });
    await intoWorkspace(page, 'rep2');
    await page.locator('#camp-pick').click();
    await expect(page.locator('#camp-picker .campitem').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator('#camp-picker .campitem', { hasText: '8th · CBSE' }).click();
    await expect(page.locator('#camp-source')).toBeVisible();
    await expect(page.locator('#camp-lead')).toContainText('Balance due now');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
