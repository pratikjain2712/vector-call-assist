// The admin app's Today, Team (Edit panel) and Settings tabs, on the fake backend (tests/e2e/fake-backend.js,
// "Phase A: admin" block). The local stack needs migration 20261024100023 and seeded campaigns, so these run in
// fake mode only. Money: the fake backend never returns amounts here, so no ₹ may appear on Today.
const { test, expect, env, isFake } = require('./fixtures');

test.skip(() => !isFake(), 'needs the fake backend (seeded campaigns, presence and the Phase A admin functions)');

async function signInAdmin(page, hash) {
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#app')).toBeVisible();
}

// "Show advanced options" from the account menu next to Sign out.
async function advanced(page, on) {
  await page.locator('#account-toggle').click();
  const box = page.locator('#account-advanced');
  if (on) await box.check(); else await box.uncheck();
  await page.locator('#account-toggle').click();
}

test('Today shows the day\'s numbers, callers right now and what needs attention', async ({ page, backend }) => {
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

  await expect(page.locator('#today-title')).toHaveText('Today');
  await expect(page.locator('#home-tiles')).toContainText('Calls made');
  await expect(page.locator('#home-tiles')).toContainText('Picked up');
  await expect(page.locator('#home-tiles')).toContainText('100%');
  // Phase A.2: money received comes from the fee ledger (Paid (office)); promises from calls, kept apart.
  await expect(page.locator('#home-fees-tile')).toContainText('Collected today');
  await expect(page.locator('#home-fees-tile')).toContainText('1 payment');
  await expect(page.locator('#home-fees-tile')).toContainText('Promised today: 0 promises');
  await expect(page.locator('#home-fees-tile')).toContainText('Paid (office)');
  await expect(page.locator('#home-callers-body')).toContainText('Rep 1');
  await expect(page.locator('#home-callers-body tr', { hasText: 'Rep 1' })).toContainText('Phone offline');
  await expect(page.locator('#home-callers-body tr', { hasText: 'Rep 2' })).toContainText('No calls for 50 min');
  const attention = page.locator('#home-attention-list');
  await expect(attention).toContainText('2 promises due today are not paid yet.');
  await expect(attention).toContainText('2 follow-ups went to other callers today.');
  await expect(attention).toContainText('Rep 1\'s phone is offline.');
  await expect(attention).toContainText('Rep 2 has made no calls for 50 min.');
  await expect(page.locator('#home-campaigns-list')).toContainText('Oct fees');
  // Money is hidden for this admin: counts only, no ₹ anywhere on Today.
  expect(await page.locator('#tab-home').innerText()).not.toContain('₹');

  // Simple by default: no day picker, no refresh button (it refreshes itself), no calling-list filter.
  await expect(page.locator('#home-day')).toHaveCount(0);
  await expect(page.locator('#home-refresh')).toHaveCount(0);
  await expect(page.locator('#home-campaign')).toBeHidden();
  // With advanced options the calling-list filter shows and asks the server again.
  await advanced(page, true);
  await expect(page.locator('#home-campaign')).toBeVisible();
  const asked = () => backend.db.log.filter((l) => l.endsWith('/rpc/admin_home_summary')).length;
  const before = asked();
  await page.locator('#home-campaign').selectOption({ label: 'Oct fees' });
  await expect(page.locator('#home-campaign')).not.toHaveValue('');
  await expect.poll(asked).toBeGreaterThan(before);
  await advanced(page, false);

  // "Open caller" goes to the Team tab with the Edit panel open for that person.
  await page.locator('#home-attention-list li', { hasText: 'Rep 1\'s phone' }).getByRole('button', { name: 'Open caller' }).click();
  await expect(page).toHaveURL(new RegExp('#team\\?seat=' + E.seats.rep1 + '$'));
  await expect(page.locator('#caller-edit')).toBeVisible();
  await expect(page.locator('#edit-title')).toHaveText('Edit: Rep 1');
  // The Team row shows the same status words as Today.
  await expect(page.locator('#seat-body tr', { hasText: 'Rep 1' })).toContainText('Phone offline');
  expect(errors).toEqual([]);
});

test('Today refreshes every minute while it is open', async ({ page, backend }) => {
  await page.clock.install();
  await signInAdmin(page);
  await expect(page.locator('#home-tiles')).toContainText('Calls made');
  const count = () => backend.db.log.filter((l) => l.endsWith('/rpc/admin_home_summary')).length;
  const before = count();
  await page.clock.fastForward(61000);
  await expect.poll(count).toBeGreaterThan(before);
  // On another tab, Today does not poll.
  await page.locator('#tab-link-settings').click();
  await expect(page.locator('#tab-settings')).toBeVisible();
  const atSwitch = count();
  await page.clock.fastForward(125000);
  await page.waitForTimeout(300);
  expect(count()).toBe(atSwitch);
});

test('an owner edits a person: calling lists, role and money access', async ({ page, backend }) => {
  const E = env();
  const k1 = backend.adminTabs.addCampaign(E.institutes.a, 'Oct fees', 'running');
  backend.adminTabs.addCampaign(E.institutes.a, 'Sales', 'running');
  await signInAdmin(page, '#team');
  const row = page.locator('#seat-body tr', { hasText: 'Rep 1' });
  await expect(row).toContainText('Caller');
  await expect(row).toContainText('Not calling today');   // the hint under the name
  await row.getByRole('button', { name: 'Edit Rep 1' }).click();
  await expect(page.locator('#edit-title')).toHaveText('Edit: Rep 1');

  // Calling lists for chosen callers only are an advanced option: tick one and save.
  await expect(page.locator('#edit-campaigns')).toBeHidden();
  await advanced(page, true);
  await page.locator('#edit-campaign-list').getByLabel('Oct fees').check();
  await page.locator('#edit-campaign-save').click();
  await expect(page.locator('#edit-campaign-msg')).toContainText('Calling lists saved for Rep 1.');
  expect(backend.db.members).toContainEqual({ campaign_id: k1, seat_id: E.seats.rep1 });
  await advanced(page, false);

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

test('Team: one table of people, with targets and notes columns only in advanced mode, and a daily target', async ({ page, backend }) => {
  await signInAdmin(page, '#team');
  const head = page.locator('#team-table thead');
  await expect(head).toContainText('Today\'s calls');
  await expect(head.getByText('Targets')).toBeHidden();
  await expect(head.getByText('Notes today')).toBeHidden();
  await advanced(page, true);
  await expect(head.getByText('Targets')).toBeVisible();
  await expect(head.getByText('Notes today')).toBeVisible();
  await advanced(page, false);
  // Edit: a calls target for the day, after a confirmation.
  await page.locator('#seat-body tr', { hasText: 'Rep 2' }).getByRole('button', { name: 'Edit Rep 2' }).click();
  await page.locator('#edit-target-calls').fill('40');
  await page.locator('#edit-target-save').click();
  await expect(page.locator('#confirm')).toContainText('40 calls a day');
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toContainText('Target saved for "Rep 2": 40 calls a day.');
  // The plain words: no seats, pairing or pool.
  const text = await page.locator('#tab-team').innerText();
  expect(text).not.toMatch(/\b(seat|seats|pairing|pool|campaigns?)\b/i);   // (the test people are called Rep 1 and Rep 2)
  await expect(page.locator('#release-go')).toHaveText('Give their calls to others');
});

// Integration: "Give their calls to one person" uses the campaigns feature's admin_move_leads; the new caller
// joins the calling list.
test('an owner moves a caller\'s open calls to another caller', async ({ page, backend }) => {
  const E = env();
  const k1 = backend.adminTabs.addCampaign(E.institutes.a, 'Oct fees', 'running');
  backend.db.members.push({ campaign_id: k1, seat_id: E.seats.rep1 });
  ['Lead A', 'Lead B'].forEach((name, i) => backend.db.leads.push({ id: 'cccccccc-0000-4000-8000-00000000000' + (i + 1), campaign_id: k1,
    institute_id: E.institutes.a, name, phone: '+9198765000' + (10 + i), status: i ? 'callback' : 'new', assigned_seat_id: E.seats.rep1 }));
  backend.db.leads.push({ id: 'cccccccc-0000-4000-8000-000000000003', campaign_id: k1, institute_id: E.institutes.a, name: 'Lead C',
    phone: '+919876500012', status: 'done', assigned_seat_id: E.seats.rep1 });
  await signInAdmin(page, '#callers');   // an old link still opens Team
  await advanced(page, true);
  const row = page.locator('#seat-body tr', { hasText: 'Rep 1' });
  await row.getByRole('button', { name: 'Edit Rep 1' }).click();
  await page.locator('#move-to').selectOption({ label: 'Rep 2' });
  await page.locator('#move-campaign').selectOption({ label: 'Oct fees' });
  await page.locator('#move-go').click();
  await expect(page.locator('#confirm')).toContainText('go to "Rep 2"');
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toContainText('2 people moved from "Rep 1".');
  const owner = (n) => backend.db.leads.find((l) => l.name === n).assigned_seat_id;
  expect([owner('Lead A'), owner('Lead B'), owner('Lead C')]).toEqual([E.seats.rep2, E.seats.rep2, E.seats.rep1]);
  expect(backend.db.members).toContainEqual({ campaign_id: k1, seat_id: E.seats.rep2 });
});

test('Settings: simple by default; advanced shows call result options, money, plan and the activity log', async ({ page, backend }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signInAdmin(page, '#settings');
  // The password is in the account menu next to Sign out, not in Settings.
  await expect(page.locator('#login')).toHaveCount(0);
  await page.locator('#account-toggle').click();
  await expect(page.locator('#account-password')).toHaveAttribute('href', 'reset.html');
  await expect(page.locator('#account-reset')).toBeVisible();
  await page.locator('#account-reset').click();
  await expect(page.locator('#account-msg')).toContainText('Reset link sent to ' + env().users.admin.email);
  await page.locator('#account-toggle').click();

  // Simple: institute, common answers and WhatsApp; the advanced sections are hidden.
  await expect(page.locator('#settings-institute')).toBeVisible();
  await expect(page.locator('#settings-answers')).toBeVisible();
  for (const id of ['settings-call-types', 'settings-money', 'settings-plan', 'settings-terms', 'settings-log']) {
    await expect(page.locator('#' + id)).toBeHidden();
  }
  await page.locator('#settings-advanced-switch').check();
  for (const id of ['settings-call-types', 'settings-money', 'settings-plan', 'settings-terms', 'settings-log']) {
    await expect(page.locator('#' + id)).toBeVisible();
  }
  await expect(page.locator('#account-advanced')).toBeChecked();   // the two switches agree

  // Call result options: kinds of call with their options, and the common options line.
  await expect(page.locator('#settings-call-types h2')).toHaveText('Call result options');
  await expect(page.locator('#ct-list')).toContainText('Fees collection');
  await expect(page.locator('#ct-list')).toContainText('Will pay on date (date)');
  await expect(page.locator('#ct-common')).toContainText('No answer');
  await page.locator('#ct-label').fill('Parent meeting');
  await page.getByRole('button', { name: 'Add kind of call' }).click();
  await expect(page.locator('#ct-add-msg')).toContainText('"Parent meeting" added.');
  await expect(page.locator('#ct-list')).toContainText('Parent meeting');
  await expect(page.locator('#ctr-type option:checked')).toHaveText('Parent meeting');
  await page.locator('#ctr-label').fill('Meeting booked');
  await page.locator('#ctr-date').check();
  await page.locator('#ctr-good').check();
  await page.getByRole('button', { name: 'Add option' }).click();
  await expect(page.locator('#ctr-msg')).toContainText('Option "Meeting booked" added to Parent meeting.');
  await expect(page.locator('#ct-list li.ct-type', { hasText: 'Parent meeting' })).toContainText('Meeting booked (date)');
  // An institute's own option can be removed; built-in ones cannot.
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

  // Plan: trial days and the extras; WhatsApp section is there for its own module.
  await expect(page.locator('#plan-text')).toHaveText('Trial: 4 days left · 3 of 10 team members');
  await expect(page.locator('#plan-features')).toContainText('Scripts: On');
  // The AI script maker is the Vector team's: an institute sees no AI drafts count.
  await expect(page.locator('#plan-ai')).toHaveText('');
  await expect(page.locator('body')).not.toContainText('AI drafts used');
  await expect(page.locator('#settings-whatsapp')).toHaveCount(1);

  // The Vector team (platform admin) still sees the AI drafts count. Advanced stays on after a reload.
  backend.db.platformAdmins.push(env().users.admin.id);
  await page.reload();
  await expect(page.locator('#settings-plan')).toBeVisible();
  await expect(page.locator('#plan-ai')).toHaveText('0 of 20 AI drafts used this month.');
  backend.db.platformAdmins.length = 0;

  // The activity log, newest first, in plain English.
  await page.reload();
  await expect(page.locator('#log-body tr').first()).toContainText('Turned on "Hide money everywhere"');
  await expect(page.locator('#log-body')).toContainText('Changed the institute');
  await expect(page.locator('#log-body')).toContainText('Added a kind of call');
  await expect(page.locator('#log-older')).toBeDisabled();

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  expect(errors).toEqual([]);
});

test('a manager gets Today, Calling and Team, and no owner-only controls', async ({ page, backend }) => {
  // Make the admin a manager: no Settings or Fees tab (no money access), no role or money switch on Team.
  backend.db.seats.find((s) => s.id === env().seats.admin).access_role = 'manager';
  await signInAdmin(page, '#settings');
  await expect(page).toHaveURL(/#today$/);   // a tab the manager does not have opens Today
  await expect(page.locator('#tabs a')).toHaveText(['Today', 'Calling', 'Team']);
  await expect(page.locator('#today-checklist')).toBeHidden();   // the getting-started card is for owners
  await page.locator('#tab-link-team').click();
  await page.locator('#seat-body tr', { hasText: 'Rep 1' }).getByRole('button', { name: 'Edit Rep 1' }).click();
  await expect(page.locator('#caller-edit')).toBeVisible();
  await expect(page.locator('#edit-owner')).toBeHidden();
  await expect(page.locator('#edit-release')).toBeVisible();
  await expect(page.locator('#edit-move')).toBeHidden();   // advanced
  await advanced(page, true);
  await expect(page.locator('#edit-move')).toBeVisible();
});
