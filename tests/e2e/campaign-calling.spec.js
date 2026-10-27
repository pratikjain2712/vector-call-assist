// Phase A: caller. A caller on a fees campaign: "Calling for", the waiting leads (call backs and promises first),
// the lead card with the amount due and the last call, the campaign's script with step times, the result buttons,
// "Send on WhatsApp", "Save and call next", and a result saved offline that uploads once the connection is back.
// Fake backend only: the campaign data is set up in tests/e2e/fake-backend.js (addCampaign).
const { test, expect, env, isFake, intoWorkspace } = require('./fixtures');

const FEES_RESULTS = [
  { key: 'paid', label: 'Paid', needs_date: false, needs_amount: true, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: true, common: false },
  { key: 'will_pay_on', label: 'Will pay on date', needs_date: true, needs_amount: true, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: true, common: false },
  { key: 'refused', label: 'Refused', needs_date: false, needs_amount: false, needs_reason: true, needs_rating: false, reason_choices: null, counts_as_good: false, common: false },
  { key: 'no_answer', label: 'No answer', needs_date: false, needs_amount: false, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: false, common: true },
  { key: 'call_back_later', label: 'Call back later', needs_date: true, needs_amount: false, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: false, common: true },
  { key: 'do_not_call', label: 'Do not call again', needs_date: false, needs_amount: false, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: false, common: true },
];
const SCRIPT = [
  { id: 'hello', start: true, stage: 0, say: ['Namaste, am I speaking with {name}?'], opts: [{ label: 'Yes', to: 'fee' }, { label: 'No', to: 'bye' }] },
  { id: 'fee', stage: 4, say: ['The fee is due on 31 October. When can you pay it?'], opts: [{ label: 'Gave a date', to: 'bye' }] },
  { id: 'bye', title: 'Thank them' },
];
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const inDays = (d) => { const t = new Date(Date.now() + d * 864e5 + 330 * 60e3); return t.toISOString().slice(0, 10); };

function feesCampaign(backend, extra) {
  const seat = env().seats.rep2;
  backend.db.features = ['scripts'];
  backend.db.callerScripts.s1 = { id: 's1', version: 2, steps: SCRIPT };
  return backend.addCampaign(Object.assign({
    name: 'Oct fees – Class 10', type_key: 'fees', type_label: 'Fees collection', script_id: 's1', daily_target: 40,
    members: [seat], results: FEES_RESULTS,
    leads: [
      { name: 'Sunita Sharma', phone: '+919876543210', extra: { student: 'Ravi Sharma', class: '10-A' }, amount_due: 18000, assigned_seat_id: seat, created_at: ago(3000) },
      { name: 'Kavita Rao', phone: '+919876543211', extra: { student: 'Anu Rao' }, amount_due: 9000, assigned_seat_id: seat, status: 'callback', next_call_at: ago(60),
        calls: 1, last_called_at: ago(1440), last_result_key: 'call_back_later', last_note: 'Call back after salary' },
      { name: 'Meena Iyer', phone: '+919876543212', amount_due: 5000, assigned_seat_id: seat, created_at: ago(100) },
    ],
  }, extra));
}

test.beforeEach(() => { test.skip(!isFake(), 'campaign data is set up in the fake backend only'); });

test('a fees call: queue order, lead card, script step times, result fields, WhatsApp and save and call next', async ({ page, backend }) => {
  const c = feesCampaign(backend);
  await intoWorkspace(page, 'rep2');

  await expect(page.locator('#camp-bar')).toBeVisible();
  await expect(page.locator('#camp-pick')).toContainText('Oct fees – Class 10');
  await expect(page.locator('#camp-today')).toContainText('of 40');
  // The lead sheet is put away; the waiting list is beside the card: the call back first, then new leads oldest first.
  await expect(page.locator('#sheet-section')).toBeHidden();
  await expect(page.locator('#queue-panel .leadrow strong')).toHaveText(['Kavita Rao', 'Sunita Sharma', 'Meena Iyer']);
  await expect(page.locator('#queue-title')).toHaveText('Waiting leads (3)');

  // The lead card: the call back is on the call, with its fields, the amount due and the last call.
  const card = page.locator('#camp-lead');
  await expect(card).toContainText('Kavita Rao');
  await expect(card).toContainText('Student: Anu Rao');
  await expect(card).toContainText('Amount due: ₹9,000');
  await expect(card).toContainText('Call back after salary');

  // Move to Sunita from the list: the campaign's script fills in her name.
  await page.locator('#queue-panel .leadrow', { hasText: 'Sunita Sharma' }).click();
  await expect(card).toContainText('Amount due: ₹18,000');
  await expect(card).toContainText('Class: 10-A');
  await expect(page.locator('#stage')).toContainText('Namaste, am I speaking with Sunita Sharma?');
  await page.waitForTimeout(1100);
  await page.locator('#ans-yes').click();
  await expect(page.locator('#stage')).toContainText('The fee is due on 31 October');
  // Mid-call, the caller cannot move to another lead or campaign.
  await expect(page.locator('#camp-pick')).toBeDisabled();
  await page.waitForTimeout(1100);

  // Result: Will pay on a date needs a date and an amount; the amount due is filled in already.
  await page.locator('#res-will_pay_on').click();
  await expect(page.locator('#res-will_pay_on')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#res-amount')).toHaveValue('18,000');
  await page.locator('#res-save').click();
  await expect(page.locator('#res-msg')).toHaveText('Pick the date.');
  await page.locator('#res-date').fill(inDays(4));
  await page.locator('#res-note').fill('Will pay by UPI after salary');
  await page.locator('#res-wa-yes').click();
  await expect(page.locator('#res-wa-yes')).toHaveAttribute('aria-pressed', 'true');
  const wa = page.locator('#res-wa-send');
  await expect(wa).toBeVisible();
  const href = await wa.getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
  expect(decodeURIComponent(href)).toContain('you will pay ₹18,000 on');
  await expect(page.locator('#res-wa-hint')).toBeHidden();

  await page.locator('#res-save').click();
  await expect(page.locator('#sheet-msg')).toContainText('Saved: Will pay on date for Sunita Sharma.');
  // The next lead is on the card; Sunita moved down to "Later", as a promise.
  await expect(card).toContainText('Kavita Rao');
  await expect(page.locator('#queue-panel .leadrow strong')).toHaveText(['Kavita Rao', 'Meena Iyer', 'Sunita Sharma']);
  await expect(page.locator('#queue-panel .leadrow', { hasText: 'Sunita Sharma' })).toContainText('Promise on');
  await expect(page.locator('#queue-title')).toHaveText('Waiting leads (2)');

  await expect.poll(() => backend.db.saved.length).toBe(1);
  const row = backend.db.saved[0];
  expect(row.p_result_key).toBe('will_pay_on');
  expect(row.p_amount).toBe(18000);
  expect(row.p_promised_date).toBe(inDays(4));
  expect(row.p_note).toBe('Will pay by UPI after salary');
  expect(row.p_consent_whatsapp).toBe(true);
  expect(row.p_script_id).toBe('s1');
  expect(row.p_script_version).toBe(2);
  expect(row.p_reached_step).toBe('fee');
  expect(row.p_script_step).toBe('fee');
  expect(Object.keys(row.p_step_times).sort()).toEqual(['fee', 'hello']);
  expect(row.p_step_times.hello).toBeGreaterThanOrEqual(1);
  expect(row.p_step_times.fee).toBeGreaterThanOrEqual(1);
  expect(backend.db.leads.find((l) => l.name === 'Sunita Sharma').status).toBe('promised');
  expect(row.campaign_id).toBe(c.id);
});

test('a result saved offline stays on the device and uploads when the connection is back', async ({ page, backend }) => {
  feesCampaign(backend);
  await intoWorkspace(page, 'rep2');
  await expect(page.locator('#camp-lead')).toContainText('Kavita Rao');

  backend.db.offline = true;
  await page.locator('#res-no_answer').click();   // one tap: saved at once, with an Undo
  await expect(page.locator('#camp-undo')).toContainText('Saved: No answer for Kavita Rao.');
  await expect(page.locator('#queue-panel .outboxline')).toContainText('1 result(s) saved on this device');
  // The lead moved on at once, offline.
  await expect(page.locator('#camp-lead')).toContainText('Sunita Sharma');
  expect(backend.db.saved.length).toBe(0);

  // A reload while offline keeps the result (IndexedDB).
  await page.reload();
  await expect(page.locator('#queue-panel .outboxline')).toContainText('1 result(s) saved on this device');

  backend.db.offline = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => backend.db.saved.length).toBe(1);
  expect(backend.db.saved[0].p_result_key).toBe('no_answer');
  await expect(page.locator('#queue-panel .outboxline')).toHaveCount(0);
  // Sent once only, whatever the retries.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(500);
  expect(backend.db.saved.length).toBe(1);
});

test('without the Scripts add-on there are no script steps; the lead sheet is still one pick away', async ({ page, backend }) => {
  feesCampaign(backend);
  backend.db.features = [];
  await intoWorkspace(page, 'rep2');
  await expect(page.locator('#stage')).toContainText('Guided scripts are part of the Scripts add-on');
  await expect(page.locator('#rail')).toBeHidden();
  await expect(page.locator('#res-paid')).toBeVisible();

  // Refused needs a reason; do not call hides WhatsApp.
  await page.locator('#res-refused').click();
  await expect(page.locator('#res-wa-send')).toBeVisible();
  await page.locator('#res-refused').click();   // tapped again: unpicked
  // Do not call asks for nothing else: one tap saves it. Undo brings the lead back before anything is sent.
  await page.locator('#res-do_not_call').click();
  await expect(page.locator('#camp-lead')).toContainText('Sunita Sharma');
  await expect(page.locator('#camp-undo')).toContainText('Saved: Do not call again for Kavita Rao.');
  await page.locator('#camp-undo-btn').click();
  await expect(page.locator('#camp-lead')).toContainText('Kavita Rao');
  await expect(page.locator('#camp-undo')).toBeHidden();
  await expect(page.locator('#sheet-msg')).toContainText('Undone: Kavita Rao is back on the card.');
  await expect(page.locator('#queue-panel .outboxline')).toHaveCount(0);
  expect(backend.db.saved.length).toBe(0);

  // My lead sheet: the old page is back.
  await page.locator('#camp-pick').click();   // Phase A.2: the campaign picker
  await page.locator('#camp-sheet').click();
  await expect(page.locator('#sheet-section')).toBeVisible();
  await expect(page.locator('#queue-panel')).toBeHidden();
  await expect(page.locator('#lead-name')).toBeVisible();
  await expect(page.locator('#stage')).toContainText('Hello, am I speaking with');
});

test('the caller screen fits a 375px phone with no sideways scroll', async ({ page, backend }) => {
  feesCampaign(backend);
  await page.setViewportSize({ width: 375, height: 800 });
  await intoWorkspace(page, 'rep2');
  await expect(page.locator('#camp-lead')).toContainText('Kavita Rao');
  await page.locator('#res-will_pay_on').click();
  await expect(page.locator('#res-amount')).toBeVisible();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(wide).toBeLessThanOrEqual(375);
});

// Integration: a running script test gives each lead version A or B (campaign_script_version) and the version
// heard is saved with the result; the practice link (my_practice); WhatsApp from the institute's connected number
// after saving (js/whatsapp-client.js, whatsapp-send); presence for the admin Home tab (report_presence).
test('script test version per lead, practice link, WhatsApp from the institute number and presence', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const SCRIPT_B = [
    { id: 'hello', start: true, stage: 0, say: ['Good morning, is this {name}?'], opts: [{ label: 'Yes', to: 'fee' }, { label: 'No', to: 'bye' }] },
    { id: 'fee', stage: 4, say: ['A quick reminder: the fee is due on 31 October.'], opts: [{ label: 'Gave a date', to: 'bye' }] },
    { id: 'bye', title: 'Thank them' },
  ];
  feesCampaign(backend, { scriptTest: { a: { version: 2, steps: SCRIPT }, b: { version: 3, steps: SCRIPT_B } } });
  backend.whatsapp.account = { phone_number_id: '1234567890', waba_id: '5550001', display_name: 'E2E', status: 'connected' };
  backend.whatsapp.templates.push({ id: 't-1', key: 'promise_due', label: 'Promise due', call_type_key: 'fees', result_key: 'will_pay_on',
    category: 'utility', language: 'en', body: 'Hi {{1}}, pay {{2}} on {{3}}. Thanks.', param_sources: ['lead_name', 'promised_amount', 'promised_date'], meta_status: 'approved' });
  await intoWorkspace(page, 'rep2');

  // Practice: one script an admin asked for, linked straight to it.
  const practice = page.locator('#practice-link');
  await expect(practice).toHaveText('Practise (1 to do)');
  await expect(practice).toHaveAttribute('href', /^practice\.html\?script=/);

  // Kavita (first on the card) hears version A; Sunita, the next lead shown, hears version B.
  await expect(page.locator('#camp-lead')).toContainText('Kavita Rao');
  await expect(page.locator('#stage')).toContainText('Namaste, am I speaking with Kavita Rao?');
  await page.locator('#queue-panel .leadrow', { hasText: 'Sunita Sharma' }).click();
  await expect(page.locator('#stage')).toContainText('Good morning, is this Sunita Sharma?');
  await page.locator('#ans-yes').click();
  await expect(page.locator('#stage')).toContainText('A quick reminder');
  await expect.poll(() => backend.db.presenceReports.some((r) => r.on_call)).toBe(true);

  // Will pay on a date, consent yes: the institute's approved message is offered next to the wa.me link.
  await page.locator('#res-will_pay_on').click();
  await page.locator('#res-date').fill(inDays(3));
  await page.locator('#res-amount').fill('18000');
  await expect(page.locator('#res-wa-app-row')).toBeHidden();   // nobody has said yes yet
  await page.locator('#res-wa-yes').click();
  await expect(page.locator('#res-wa-send')).toBeVisible();
  await expect(page.locator('#res-wa-app-row')).toBeVisible();
  await expect(page.locator('#res-wa-app-row')).toContainText('After saving, send “Promise due” from the institute\'s WhatsApp');
  await page.locator('#res-wa-app').check();
  await page.locator('#res-save').click();

  await expect.poll(() => backend.db.saved.length).toBe(1);
  const row = backend.db.saved[0];
  expect(row.p_script_id).toBe('s1');
  expect(row.p_script_version).toBe(3);
  const sunita = backend.db.leads.find((l) => l.name === 'Sunita Sharma');
  await expect.poll(() => backend.whatsapp.messages.length).toBe(1);
  expect(backend.whatsapp.messages[0]).toMatchObject({ lead_id: sunita.id, template_key: 'promise_due' });
  await expect(page.locator('#sheet-msg')).toContainText('WhatsApp “Promise due” sent to Sunita Sharma.');
  expect(errors).toEqual([]);
});
