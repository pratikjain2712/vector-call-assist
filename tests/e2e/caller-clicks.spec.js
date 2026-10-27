// Fewer taps for callers: one-tap results with Undo, number keys, the amount due filled in, quick dates and
// call back times, reasons and WhatsApp consent as buttons, the script's ending picking its result, the Call
// button focused after a save, the remembered "send from the institute's WhatsApp" tick, and the lock screen.
// Every user action (a click or a key press) is counted in the page: No answer is 1, Paid 2, a promise 3.
// Fake backend only (tests/e2e/fake-backend.js). Set CALLER_SHOTS=<folder> to also save screenshots there.
const path = require('node:path');
const { test, expect, env, isFake, intoWorkspace } = require('./fixtures');

const RESULTS = [
  { key: 'paid', label: 'Paid', needs_date: false, needs_amount: true, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: true, common: false },
  { key: 'will_pay_on', label: 'Will pay on date', needs_date: true, needs_amount: true, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: true, common: false },
  { key: 'refused', label: 'Refused', needs_date: false, needs_amount: false, needs_reason: true, needs_rating: false, reason_choices: ['Fee too high', 'Left the school', 'Other'], counts_as_good: false, common: false },
  { key: 'no_answer', label: 'No answer', needs_date: false, needs_amount: false, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: false, common: true },
  { key: 'call_back_later', label: 'Call back later', needs_date: true, needs_amount: false, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: false, common: true },
  { key: 'do_not_call', label: 'Do not call again', needs_date: false, needs_amount: false, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: false, common: true },
];
// The ending "Paid" names its result, so the script picks Paid when the call gets there.
const SCRIPT = [
  { id: 'hello', start: true, stage: 0, say: ['Namaste, am I speaking with {name}?'], opts: [{ label: 'Yes', to: 'fee' }, { label: 'No', to: 'bye' }] },
  { id: 'fee', stage: 4, say: ['The fee of {amount_due} is due. Can you pay today?'], opts: [{ label: 'Paid now', to: 'paid' }, { label: 'Later', to: 'bye' }] },
  { id: 'paid', title: 'Paid', result: 'paid' },
  { id: 'bye', title: 'Thank them' },
];
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const indiaDay = (ms) => new Date(ms + 330 * 60e3).toISOString().slice(0, 10);
const SHOTS = process.env.CALLER_SHOTS || '';

function campaign(backend, scripts) {
  const seat = env().seats.rep2;
  backend.db.features = scripts ? ['scripts'] : [];
  backend.db.callerScripts.s1 = { id: 's1', version: 1, steps: SCRIPT };
  return backend.addCampaign({
    name: 'Oct fees – Class 10', type_key: 'fees', type_label: 'Fees collection', script_id: 's1', daily_target: 40,
    members: [seat], results: RESULTS,
    leads: [
      { name: 'Sunita Sharma', phone: '+919876543210', amount_due: 18000, assigned_seat_id: seat, created_at: ago(400) },
      { name: 'Kavita Rao', phone: '+919876543211', amount_due: 9000, assigned_seat_id: seat, created_at: ago(300) },
      { name: 'Meena Iyer', phone: '+919876543212', amount_due: 5000, assigned_seat_id: seat, created_at: ago(200) },
      { name: 'Ravi Kumar', phone: '+919876543213', amount_due: 7500, assigned_seat_id: seat, created_at: ago(100) },
    ],
  });
}

/* A paired phone that answers in the page, so the Call button is on and enabled. Nothing is dialled. */
async function standInPhone(page) {
  await page.addInitScript(() => {
    let real;
    Object.defineProperty(window, 'PhoneLink', {
      configurable: true,
      get: () => real,
      set: (v) => { real = v; v.request = async (op) => (op === 'status' ? { found: false } : { ok: true }); },
    });
  });
}

/* Counts what the caller does: every trusted click and key press in the page. */
async function countActions(page) {
  await page.addInitScript(() => {
    window.__actions = 0;
    const count = (ev) => { if (ev.isTrusted) window.__actions += 1; };
    // A click made by Enter or Space on a focused button (detail 0) is the same action as that key press.
    document.addEventListener('click', (ev) => { if (ev.detail > 0) count(ev); }, true);
    document.addEventListener('keydown', count, true);
  });
}
const actions = (page) => page.evaluate(() => window.__actions);
/* A screenshot of the area the given elements cover together. */
async function shotOf(page, selectors, file) {
  const boxes = [];
  for (const s of selectors) boxes.push(await page.locator(s).boundingBox());
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.width)), b = Math.max(...boxes.map((q) => q.y + q.height));
  await page.screenshot({ path: path.join(SHOTS, file), clip: { x, y, width: r - x, height: b - y } });
}
const resetActions = (page) => page.evaluate(() => { window.__actions = 0; });

test.beforeEach(() => { test.skip(!isFake(), 'campaign data is set up in the fake backend only'); });

test('actions per result: No answer 1, Paid 2, a promise 3; the Call button is focused after each save', async ({ page, backend }) => {
  campaign(backend, false);
  await standInPhone(page);
  await countActions(page);
  await intoWorkspace(page, 'rep2');
  const card = page.locator('#camp-lead');
  await expect(card).toContainText('Sunita Sharma');
  await expect(card).toContainText('Amount due: ₹18,000');
  await expect(page.locator('#call-laptop')).toBeEnabled();

  // No answer: 1 action. Saved at once, the next lead is on the card, Undo shows for a few seconds.
  await resetActions(page);
  await page.locator('#res-no_answer').click();
  await expect(card).toContainText('Kavita Rao');
  await expect(page.locator('#camp-undo')).toContainText('Saved: No answer for Sunita Sharma.');
  await expect(page.locator('#call-laptop')).toBeFocused();
  expect(await actions(page)).toBe(1);
  if (SHOTS) await shotOf(page, ['#camp-lead', '#camp-undo'], 'undo-desktop.png');
  expect(backend.db.saved.length).toBe(0);   // held while Undo shows
  await expect.poll(() => backend.db.saved.length, { timeout: 15000 }).toBe(1);
  expect(backend.db.saved[0].p_result_key).toBe('no_answer');
  await expect(page.locator('#camp-undo')).toBeHidden();

  // Paid: 2 actions. The amount due is filled in.
  await resetActions(page);
  await page.locator('#res-paid').click();
  await expect(page.locator('#res-amount')).toHaveValue('9,000');
  await page.locator('#res-save').click();
  await expect(card).toContainText('Meena Iyer');
  await expect(page.locator('#call-laptop')).toBeFocused();
  expect(await actions(page)).toBe(2);
  await expect.poll(() => backend.db.saved.length).toBe(2);
  expect(backend.db.saved[1]).toMatchObject({ p_result_key: 'paid', p_amount: 9000 });

  // A promise: 3 actions. Tomorrow is one tap; the amount due is filled in.
  await resetActions(page);
  await page.locator('#res-will_pay_on').click();
  if (SHOTS) {
    await page.locator('#result-panel').screenshot({ path: path.join(SHOTS, 'result-promise-desktop.png') });
  }
  await page.locator('#res-q-tomorrow').click();
  await expect(page.locator('#res-q-tomorrow')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#res-save').click();
  await expect(card).toContainText('Ravi Kumar');
  await expect(page.locator('#call-laptop')).toBeFocused();
  expect(await actions(page)).toBe(3);
  await expect.poll(() => backend.db.saved.length).toBe(3);
  expect(backend.db.saved[2]).toMatchObject({ p_result_key: 'will_pay_on', p_amount: 5000, p_promised_date: indiaDay(Date.now() + 864e5) });
});

test('number keys pick results, Enter saves from a field, call back quick times, reasons as buttons, Undo', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  campaign(backend, false);
  await standInPhone(page);
  await countActions(page);
  await intoWorkspace(page, 'rep2');
  const card = page.locator('#camp-lead');
  await expect(card).toContainText('Sunita Sharma');
  // A small key on each result button: 1 to 6 in screen order.
  await expect(page.locator('#res-paid kbd')).toHaveText('1');
  await expect(page.locator('#res-no_answer kbd')).toHaveText('4');
  await expect(page.locator('#res-do_not_call kbd')).toHaveText('6');

  // Key 6: Do not call again is only picked (it stops a lead for good): Save has the focus and says so.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('6');
  await expect(page.locator('#res-do_not_call')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#res-msg')).toHaveText('This stops all calls to this lead. Press Save to confirm.');
  await expect(page.locator('#res-save')).toBeFocused();
  await expect(card).toContainText('Sunita Sharma');
  await page.keyboard.press('6');   // pressed again: unpicked
  await expect(page.locator('#res-do_not_call')).toHaveAttribute('aria-pressed', 'false');

  // Key 4: No answer, saved in one key press. Undo brings Sunita back, and nothing reaches the server.
  await resetActions(page);
  await page.keyboard.press('4');
  await expect(card).toContainText('Kavita Rao');
  expect(await actions(page)).toBe(1);
  await page.locator('#camp-undo-btn').click();
  await expect(card).toContainText('Sunita Sharma');
  await expect(page.locator('#res-paid')).toBeFocused();   // back on the result buttons, ready for the right one
  await page.waitForTimeout(11000);
  expect(backend.db.saved.length).toBe(0);

  // Key 5: call back later. "In 1 hr" fills the date and the time; Enter in the note saves.
  await page.keyboard.press('5');
  await expect(page.locator('#res-call_back_later')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#res-q-hour').click();
  const t0 = Date.now();
  await expect(page.locator('#res-date')).toHaveValue(indiaDay(t0 + 3600e3));
  await expect(page.locator('#res-time')).not.toHaveValue('');
  await page.locator('#res-note').fill('Driving, call in an hour');
  await page.locator('#res-note').press('Enter');
  await expect(card).toContainText('Kavita Rao');
  await expect.poll(() => backend.db.saved.length).toBe(1);
  const cb = backend.db.saved[0];
  expect(cb.p_result_key).toBe('call_back_later');
  expect(Math.abs(Date.parse(cb.p_next_call_at) - (t0 + 3600e3))).toBeLessThan(2 * 60e3);
  expect(cb.p_note).toBe('Driving, call in an hour');

  // Refused: the reasons are buttons, and WhatsApp consent is three buttons.
  await page.locator('#res-refused').click();
  await expect(page.locator('#res-reason button')).toHaveText(['Fee too high', 'Left the school', 'Other']);
  await expect(page.locator('#res-wa button')).toHaveText(['Not asked', 'Yes', 'No']);
  await page.locator('#res-reason button', { hasText: 'Left the school' }).click();
  await page.locator('#res-wa-no').click();
  await page.locator('#res-save').click();
  await expect.poll(() => backend.db.saved.length).toBe(2);
  expect(backend.db.saved[1]).toMatchObject({ p_result_key: 'refused', p_reason: 'Left the school', p_consent_whatsapp: false });

  // Do not call again: 2 actions, pick then Save (Enter on the focused Save). Sent at once, with no Undo hold.
  await expect(card).toContainText('Meena Iyer');
  await resetActions(page);
  await page.locator('#res-do_not_call').click();
  await expect(page.locator('#res-save')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).not.toContainText('Meena Iyer');
  expect(await actions(page)).toBe(2);
  await expect(page.locator('#camp-undo')).toBeHidden();
  await expect.poll(() => backend.db.saved.length, { timeout: 5000 }).toBe(3);
  expect(backend.db.saved[2].p_result_key).toBe('do_not_call');
  expect(errors).toEqual([]);
});

test('the script ending picks its result: the caller only confirms; keys 1 to 3 still answer the script', async ({ page, backend }) => {
  campaign(backend, true);
  await standInPhone(page);
  await intoWorkspace(page, 'rep2');
  await expect(page.locator('#stage')).toContainText('Namaste, am I speaking with Sunita Sharma?');
  await expect(page.locator('#result-panel')).toHaveClass(/keysoff/);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('1');   // Yes, on the script
  await expect(page.locator('#stage')).toContainText('The fee of ₹18,000 is due');
  await page.keyboard.press('1');   // Paid now
  await expect(page.locator('#stage')).toContainText('Script finished: Paid');
  await expect(page.locator('#stage')).toContainText('The result is picked below. Check it, then save.');
  await expect(page.locator('#res-paid')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#res-amount')).toHaveValue('18,000');
  await expect(page.locator('#res-save')).toBeFocused();
  await expect(page.locator('#result-panel')).not.toHaveClass(/keysoff/);
  // Back one step un-picks it; the ending picks it again.
  await page.locator('#back').click();
  await expect(page.locator('#res-paid')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#ans-yes').click();
  await expect(page.locator('#res-paid')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('#camp-lead')).toContainText('Kavita Rao');
  await expect.poll(() => backend.db.saved.length).toBe(1);
  expect(backend.db.saved[0]).toMatchObject({ p_result_key: 'paid', p_amount: 18000, p_script_step: 'paid' });
});

test('the institute WhatsApp tick is remembered for this caller', async ({ page, backend }) => {
  campaign(backend, false);
  backend.whatsapp.account = { phone_number_id: '1234567890', waba_id: '5550001', display_name: 'E2E', status: 'connected' };
  backend.whatsapp.templates.push({ id: 't-1', key: 'paid_thanks', label: 'Thanks for paying', call_type_key: 'fees', result_key: 'paid',
    category: 'utility', language: 'en', body: 'Hi {{1}}, thank you.', param_sources: ['lead_name'], meta_status: 'approved' });
  await intoWorkspace(page, 'rep2');
  await page.locator('#res-paid').click();
  await page.locator('#res-wa-yes').click();
  await expect(page.locator('#res-wa-app')).not.toBeChecked();
  await page.locator('#res-wa-app').check();
  await page.locator('#res-save').click();
  await expect(page.locator('#camp-lead')).toContainText('Kavita Rao');
  // The next lead, and after a reload: the tick is still on.
  await page.locator('#res-paid').click();
  await page.locator('#res-wa-yes').click();
  await expect(page.locator('#res-wa-app')).toBeChecked();
  await page.reload();
  await expect(page.locator('#camp-lead')).toContainText('Kavita Rao');
  await page.locator('#res-paid').click();
  await page.locator('#res-wa-yes').click();
  await expect(page.locator('#res-wa-app')).toBeChecked();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('vca2-wa-app:')).length)).toBe(1);
});

test('after 30 idle minutes the screen locks; only Continue opens it, and the caller stays signed in', async ({ page, backend }) => {
  campaign(backend, false);
  await intoWorkspace(page, 'rep2');
  await expect(page.locator('#camp-lead')).toContainText('Sunita Sharma');
  // The wall clock moves 36 minutes on (the lock counts wall-clock time, as after a laptop's sleep).
  await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 36 * 60e3; });
  const lock = page.locator('#still-there');
  await expect(lock).toBeVisible();
  await expect(lock).toContainText('Screen locked');
  await expect(lock).toContainText('you stay signed in');
  await expect(page.locator('#still-continue')).toBeFocused();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'lock-desktop.png') });
  // A key press does not open it, and no result is picked under it.
  await page.keyboard.press('4');
  await expect(lock).toBeVisible();
  await expect(page.locator('#camp-lead')).toContainText('Sunita Sharma');
  await page.waitForTimeout(1500);
  await expect(page.locator('#app')).toBeVisible();   // 36 minutes: still signed in
  await page.locator('#still-continue').click();
  await expect(lock).toBeHidden();
  await expect(page.locator('#signin')).toBeHidden();
});

test('screenshots at phone width: result area and lock screen', async ({ page, backend }) => {
  test.skip(!SHOTS, 'set CALLER_SHOTS to save screenshots');
  campaign(backend, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await intoWorkspace(page, 'rep2');
  await expect(page.locator('#camp-lead')).toContainText('Sunita Sharma');
  await page.locator('#res-no_answer').click();
  await expect(page.locator('#camp-undo')).toBeVisible();
  await shotOf(page, ['#camp-lead', '#camp-undo'], 'undo-phone.png');
  await page.locator('#res-call_back_later').click();
  await page.locator('#result-panel').screenshot({ path: path.join(SHOTS, 'result-callback-phone.png') });
  await page.locator('#res-will_pay_on').click();
  await page.locator('#result-panel').screenshot({ path: path.join(SHOTS, 'result-promise-phone.png') });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(wide).toBeLessThanOrEqual(390);
  await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 36 * 60e3; });
  await expect(page.locator('#still-there')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'lock-phone.png') });
});
