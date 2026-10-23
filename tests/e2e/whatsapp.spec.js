// WhatsApp (Sprint 12): the Settings panel (js/admin/settings-whatsapp.js) and the caller helper
// (js/whatsapp-client.js), against the fake backend (Meta is never called; the Edge Functions are faked in
// tests/e2e/fake-backend.js). The Settings tab mounts the panel itself in <section id="settings-whatsapp">,
// with the shell's context (its confirm dialog asks before a disconnect).
const { test, expect, env, signInOnApp } = require('./fixtures');

test.skip(({ backend }) => !backend, 'needs the fake backend (the Edge Functions are not deployed on the local stack)');

async function adminSignIn(page) {
  await page.goto('/admin.html#settings');
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#tab-link-settings')).toHaveAttribute('aria-current', 'page');
}

// The Settings tab mounts the panel (settings.js -> VectorSettingsWhatsApp.mount); wait until it has loaded.
async function mountPanel(page) {
  await expect(page.locator('#settings-whatsapp #wa-connection')).toBeVisible();
}

test('an owner connects WhatsApp, writes a message from a starter and submits it for approval', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await adminSignIn(page);
  await mountPanel(page);
  const panel = page.locator('#settings-whatsapp');

  // Not connected: the Meta steps and the connect form.
  await expect(panel.locator('#wa-connection')).toContainText('Not connected');
  await expect(panel.locator('.wa-steps li')).toHaveCount(5);
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.locator('#wa-connect-msg')).toContainText('phone number ID');
  await panel.getByLabel('Phone number ID').fill('1234567890');
  await panel.getByLabel('WhatsApp Business Account ID').fill('5550001');
  await panel.getByLabel('Display name').fill('E2E Academy');
  await panel.getByLabel('Access token').fill('EAAtesttokenvalue1234567890');
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.locator('#wa-connection')).toContainText('Connected');
  await expect(panel.locator('#wa-connection')).toContainText('E2E Academy · +91 98765 00000');
  await expect(panel.getByLabel('Access token')).toHaveCount(0);   // the token is never shown again
  expect(backend.whatsapp.account.phone_number_id).toBe('1234567890');

  // A starter becomes a draft, then goes to Meta.
  await panel.getByRole('button', { name: 'Start from: Promise due' }).click();
  await expect(panel.getByLabel('Name', { exact: true })).toHaveValue('Promise due');
  await expect(panel.locator('#wa-t-preview')).toContainText('Hello Asha, as discussed, your payment of ₹6,000 is due on 25 Oct 2026.');
  await expect(panel.locator('#wa-t-blanks select')).toHaveCount(4);
  await panel.getByRole('button', { name: 'Save' }).first().click();
  const row = panel.locator('#wa-template-table tbody tr').filter({ hasText: 'Promise due' });
  await expect(row).toContainText('Not sent for approval');
  await expect(row).toContainText('Fees collection: Will pay on date');
  await row.getByRole('button', { name: 'Submit Promise due for approval' }).click();
  await expect(row).toContainText('Waiting for Meta');
  await expect(panel.locator('#wa-templates-msg')).toContainText('sent for approval');
  await panel.getByRole('button', { name: 'Check approval status' }).click();
  await expect(row).toContainText('Approved');

  // A message with a gap in its blanks is refused before saving.
  await panel.getByRole('button', { name: 'New message' }).click();
  await panel.getByLabel('Name', { exact: true }).fill('Broken');
  await panel.getByLabel('Message', { exact: true }).fill('Hello {{1}}, pay {{3}} today.');
  await panel.getByRole('button', { name: 'Save' }).first().click();
  await expect(panel.locator('#wa-t-msg')).toContainText('in order');
  await panel.getByRole('button', { name: 'Cancel' }).click();

  // This month and the weekly brief.
  await expect(panel.locator('#wa-sent .wa-num')).toHaveText('0');
  await expect(panel.locator('#wa-cost')).toContainText('Estimated cost: ₹0.00');
  await panel.getByLabel('Send me the weekly brief on WhatsApp every Monday').check();
  await panel.getByLabel('Your WhatsApp number').fill('98765 11111');
  await panel.locator('#wa-brief-save').click();
  await expect(panel.locator('#wa-brief-msg')).toContainText('on Mondays');
  expect(backend.whatsapp.brief).toBe('+919876511111');

  // Disconnect.
  await panel.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.locator('#confirm')).toContainText('Disconnect WhatsApp?');   // the shell asks first
  await page.locator('#confirm-go').click();
  await expect(panel.locator('#wa-connection')).toContainText('Not connected');
  expect(errors).toEqual([]);
});

test('the WhatsApp panel fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await adminSignIn(page);
  await mountPanel(page);
  await page.locator('#settings-whatsapp').getByRole('button', { name: 'Start from: Fees reminder' }).click();
  await expect(page.locator('#wa-t-body')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('whatsapp-375.png'), fullPage: true });
});

test('a caller sends an approved message after a call; no consent is refused', async ({ page, backend }) => {
  backend.whatsapp.account = { phone_number_id: '1234567890', waba_id: '5550001', display_name: 'E2E', status: 'connected' };
  backend.whatsapp.templates.push({ id: 't-1', key: 'promise_due', label: 'Promise due', call_type_key: 'fees', result_key: 'will_pay_on',
    category: 'utility', language: 'en', body: 'Hi {{1}}, pay {{2}} on {{3}}. Thanks.', param_sources: ['lead_name', 'promised_amount', 'promised_date'], meta_status: 'approved' });
  await signInOnApp(page, 'rep1');
  await page.addScriptTag({ url: '/js/whatsapp-client.js' });
  const out = await page.evaluate(async (leads) => {
    const cfg = window.VECTOR_CONFIG;
    const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    await client.auth.getSession();
    const W = window.VectorWhatsApp;
    const list = await W.loadTemplates(client);
    const offer = W.forResult(list, 'fees', 'will_pay_on').map((t) => t.key);
    const yes = await W.sendAfterCall(client, leads.yes, 'promise_due');
    const no = await W.sendAfterCall(client, leads.no, 'promise_due');
    return { offer, yes, no };
  }, backend.WA_LEADS);
  expect(out.offer).toEqual(['promise_due']);
  expect(out.yes.ok).toBe(true);
  expect(out.no).toEqual({ ok: false, error: 'This person has not agreed to WhatsApp messages.' });
  expect(backend.whatsapp.messages).toHaveLength(1);
});
