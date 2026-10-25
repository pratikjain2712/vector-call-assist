// The admin app's Home, Callers (Edit caller) and Settings tabs, on the fake backend (tests/e2e/fake-backend.js,
// "Phase A: admin" block). The local stack needs migration 20261024100023 and seeded campaigns, so these run in
// fake mode only. Money: the fake backend never returns amounts, so no ₹ may appear on Home.
const { test, expect, env, isFake } = require('./fixtures');

test.skip(() => !isFake(), 'needs the fake backend (seeded campaigns, presence and the Phase A admin functions)');

async function signInAdmin(page, hash) {
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#app')).toBeVisible();
}

test('Home shows the day\'s numbers, callers right now and what needs attention', async ({ page, backend }) => {
  const E = env();
  const A = backend.adminTabs;
  A.addCampaign(E.institutes.a, 'Oct fees', 'running');
  A.setPresence(E.seats.rep1, { status: 'phone_offline', since: new Date().toISOString() });
  A.setPresence(E.seats.rep2, { status: 'idle', idle_minutes: 50, since: new Date().toISOString() });
  A.setPromisesDue(2);
  backend.db.ledgerReports.home.released_today = { count: 2, idle: 2, inactive: 0, revoked: 0, admin: 0 };   // Phase A.2
  backend.addOutcome({ institute_id: E.institutes.a, seat_id: E.seats.rep1, client_record_id: 'home-1', outcome: 'interested',
    dialled_at: new Date().toISOString(), connected_seconds: 300 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signInAdmin(page);

  await expect(page.locator('#home-title')).toHaveText('Today');
  await expect(page.locator('#home-tiles')).toContainText('Calls made');
  await expect(page.locator('#home-tiles')).toContainText('Picked up');
  await expect(page.locator('#home-tiles')).toContainText('100%');
  await expect(page.locator('#home-tiles')).toContainText('reported by caller');
  // Phase A.2: money received comes from the fee ledger; promises from calls, kept apart.
  await expect(page.locator('#home-fees-tile')).toContainText('Collected today (ledger)');
  await expect(page.locator('#home-fees-tile')).toContainText('3 payments');
  await expect(page.locator('#home-fees-tile')).toContainText('Promised today (calls): 0 promises');
  await expect(page.locator('#home-callers-body')).toContainText('Rep 1');
  await expect(page.locator('#home-callers-body tr', { hasText: 'Rep 1' })).toContainText('Phone offline');
  await expect(page.locator('#home-callers-body tr', { hasText: 'Rep 2' })).toContainText('No calls for 50 min');
  const attention = page.locator('#home-attention-list');
  await expect(attention).toContainText('2 promises due today are not yet paid in the ledger.');
  await expect(attention).toContainText('2 follow-ups returned to the pool today.');
  await expect(attention).toContainText('Rep 1\'s phone is offline.');
  await expect(attention).toContainText('Rep 2 has made no calls for 50 min.');
  await expect(page.locator('#home-campaigns-list')).toContainText('Oct fees');
  // Money is hidden for this admin: counts only, no ₹ anywhere on Home.
  expect(await page.locator('#tab-home').innerText()).not.toContain('₹');

  // The day filter changes the title and asks the server again.
  await page.locator('#home-day').selectOption('yesterday');
  await expect(page.locator('#home-title')).toHaveText('Yesterday');
  await page.locator('#home-campaign').selectOption({ label: 'Oct fees' });
  await expect(page.locator('#home-campaign')).not.toHaveValue('');

  // "Open caller" goes to the Callers tab with Edit caller open for that seat.
  await page.locator('#home-attention-list li', { hasText: 'Rep 1\'s phone' }).getByRole('button', { name: 'Open caller' }).click();
  await expect(page).toHaveURL(new RegExp('#callers\\?seat=' + E.seats.rep1 + '$'));
  await expect(page.locator('#caller-edit')).toBeVisible();
  await expect(page.locator('#edit-title')).toHaveText('Edit caller: Rep 1');
  expect(errors).toEqual([]);
});

test('Home refreshes every minute while it is open', async ({ page, backend }) => {
  await page.clock.install();
  await signInAdmin(page);
  await expect(page.locator('#home-tiles')).toContainText('Calls made');
  const count = () => backend.db.log.filter((l) => l.endsWith('/rpc/admin_home_summary')).length;
  const before = count();
  await page.clock.fastForward(61000);
  await expect.poll(count).toBeGreaterThan(before);
  // On another tab, Home does not poll.
  await page.locator('#tab-link-settings').click();
  await expect(page.locator('#tab-settings')).toBeVisible();
  const atSwitch = count();
  await page.clock.fastForward(125000);
  await page.waitForTimeout(300);
  expect(count()).toBe(atSwitch);
});

test('an owner edits a caller: campaigns, role and money access', async ({ page, backend }) => {
  const E = env();
  const k1 = backend.adminTabs.addCampaign(E.institutes.a, 'Oct fees', 'running');
  backend.adminTabs.addCampaign(E.institutes.a, 'Sales', 'running');
  await signInAdmin(page, '#callers');
  const row = page.locator('#seat-body tr', { hasText: 'Rep 1' });
  await expect(row).toContainText('Caller');
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#edit-title')).toHaveText('Edit caller: Rep 1');

  // Campaigns: tick one and save.
  await page.locator('#edit-campaign-list').getByLabel('Oct fees').check();
  await page.locator('#edit-campaign-save').click();
  await expect(page.locator('#edit-campaign-msg')).toContainText('Campaigns saved for Rep 1.');
  expect(backend.db.members).toContainEqual({ campaign_id: k1, seat_id: E.seats.rep1 });
  await expect(row).toContainText('Oct fees');

  // Role: make Rep 1 a manager (asks first), then allow money.
  await expect(page.locator('#edit-money-field')).toBeHidden();
  await page.locator('#edit-role').selectOption('manager');
  await page.locator('#edit-role-save').click();
  await expect(page.locator('#confirm')).toBeVisible();
  await page.locator('#confirm-go').click();
  await expect(row).toContainText('Manager');
  await expect(page.locator('#edit-money-field')).toBeVisible();
  await page.locator('#edit-money').click();
  await expect(page.locator('#confirm')).toBeVisible();
  await expect(page.locator('#edit-money')).not.toBeChecked();   // only after the confirmation
  await page.locator('#confirm-go').click();
  await expect(row).toContainText('Manager · sees money');
  await expect(page.locator('#edit-money')).toBeChecked();

  // Escape closes the panel.
  await page.locator('#caller-edit').press('Escape');
  await expect(page.locator('#caller-edit')).toBeHidden();
});

// Integration: "Move leads" uses the campaigns feature's admin_move_leads; the new caller joins the campaign.
test('an owner moves a caller\'s open leads to another caller', async ({ page, backend }) => {
  const E = env();
  const k1 = backend.adminTabs.addCampaign(E.institutes.a, 'Oct fees', 'running');
  backend.db.members.push({ campaign_id: k1, seat_id: E.seats.rep1 });
  ['Lead A', 'Lead B'].forEach((name, i) => backend.db.leads.push({ id: 'cccccccc-0000-4000-8000-00000000000' + (i + 1), campaign_id: k1,
    institute_id: E.institutes.a, name, phone: '+9198765000' + (10 + i), status: i ? 'callback' : 'new', assigned_seat_id: E.seats.rep1 }));
  backend.db.leads.push({ id: 'cccccccc-0000-4000-8000-000000000003', campaign_id: k1, institute_id: E.institutes.a, name: 'Lead C',
    phone: '+919876500012', status: 'done', assigned_seat_id: E.seats.rep1 });
  await signInAdmin(page, '#callers');
  const row = page.locator('#seat-body tr', { hasText: 'Rep 1' });
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#move-to').selectOption({ label: 'Rep 2' });
  await page.locator('#move-campaign').selectOption({ label: 'Oct fees' });
  await page.locator('#move-go').click();
  await expect(page.locator('#confirm')).toContainText('go to "Rep 2"');
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toContainText('2 leads moved from "Rep 1".');
  const owner = (n) => backend.db.leads.find((l) => l.name === n).assigned_seat_id;
  expect([owner('Lead A'), owner('Lead B'), owner('Lead C')]).toEqual([E.seats.rep2, E.seats.rep2, E.seats.rep1]);
  expect(backend.db.members).toContainEqual({ campaign_id: k1, seat_id: E.seats.rep2 });
});

test('Settings: call types, institute, money switch, plan and the activity log', async ({ page, backend }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signInAdmin(page, '#settings');
  // The password panel stays.
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#reset-send')).toBeVisible();

  // Call types with their buttons, and the common buttons line.
  await expect(page.locator('#ct-list')).toContainText('Fees collection');
  await expect(page.locator('#ct-list')).toContainText('Will pay on date (date)');
  await expect(page.locator('#ct-common')).toContainText('No answer');
  await page.locator('#ct-label').fill('Parent meeting');
  await page.getByRole('button', { name: 'Add call type' }).click();
  await expect(page.locator('#ct-add-msg')).toContainText('Call type "Parent meeting" added.');
  await expect(page.locator('#ct-list')).toContainText('Parent meeting');
  await expect(page.locator('#ctr-type option:checked')).toHaveText('Parent meeting');
  await page.locator('#ctr-label').fill('Meeting booked');
  await page.locator('#ctr-date').check();
  await page.locator('#ctr-good').check();
  await page.getByRole('button', { name: 'Add button' }).click();
  await expect(page.locator('#ctr-msg')).toContainText('Button "Meeting booked" added to Parent meeting.');
  await expect(page.locator('#ct-list li.ct-type', { hasText: 'Parent meeting' })).toContainText('Meeting booked (date)');
  // An institute's own button can be removed; built-in ones cannot.
  await expect(page.locator('#ct-list li.ct-type', { hasText: 'Fees collection' }).locator('.ct-remove')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove button Meeting booked from Parent meeting' }).click();
  await page.locator('#confirm-go').click();
  await expect(page.locator('#ct-list li.ct-type', { hasText: 'Parent meeting' })).not.toContainText('Meeting booked');

  // Institute name and time zone.
  await expect(page.locator('#inst-tz')).toHaveValue('Asia/Kolkata');
  await page.locator('#inst-name').fill('E2E Institute Renamed');
  await page.locator('#inst-save').click();
  await expect(page.locator('#inst-msg')).toContainText('Saved.');
  await expect(page.locator('#institute')).toHaveText('E2E Institute Renamed');

  // Hide money everywhere asks first.
  await page.locator('#hide-money').click();
  await page.locator('#confirm-go').click();
  await expect(page.locator('#hide-money')).toBeChecked();
  expect(backend.db.institute.hide_money).toBe(true);

  // Plan: trial days and the add-ons; WhatsApp section is there for its own module.
  await expect(page.locator('#plan-text')).toHaveText('Trial: 4 days left · 3 of 10 seats used');
  await expect(page.locator('#plan-features')).toContainText('Scripts: On');
  // The AI script maker is the Vector team's: an institute sees no AI drafts count.
  await expect(page.locator('#plan-features')).toContainText('Scripts: On');
  await expect(page.locator('#plan-ai')).toHaveText('');
  await expect(page.locator('body')).not.toContainText('AI drafts used');
  await expect(page.locator('#settings-whatsapp')).toHaveCount(1);

  // The Vector team (platform admin) still sees the AI drafts count.
  backend.db.platformAdmins.push(env().users.admin.id);
  await page.reload();
  await expect(page.locator('#plan-ai')).toHaveText('0 of 20 AI drafts used this month.');
  backend.db.platformAdmins.length = 0;

  // The activity log, newest first, in plain English.
  await page.reload();
  await expect(page.locator('#log-body tr').first()).toContainText('Turned on "Hide money everywhere"');
  await expect(page.locator('#log-body')).toContainText('Changed the institute');
  await expect(page.locator('#log-body')).toContainText('Added a call type');
  await expect(page.locator('#log-older')).toBeDisabled();

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  expect(errors).toEqual([]);
});

test('a manager sees no owner-only controls', async ({ page, backend }) => {
  // Make the admin a manager: owner-only parts (role, money switch, institute name) are hidden.
  backend.db.seats.find((s) => s.id === env().seats.admin).access_role = 'manager';
  await signInAdmin(page, '#settings');
  await expect(page.locator('#hide-money-field')).toBeHidden();
  await expect(page.locator('#hide-money-state')).toContainText('Only an owner can change this.');
  await expect(page.locator('#inst-save')).toBeHidden();
  await expect(page.locator('#inst-note')).toBeVisible();
  await page.locator('#tab-link-callers').click();
  await page.locator('#seat-body tr', { hasText: 'Rep 1' }).getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#caller-edit')).toBeVisible();
  await expect(page.locator('#edit-owner')).toBeHidden();
  await expect(page.locator('#edit-move')).toBeVisible();
});
