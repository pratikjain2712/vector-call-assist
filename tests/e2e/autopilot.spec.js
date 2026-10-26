// Vector Autopilot on the fake backend (docs/autopilot-plan.md, phase 1): Today's numbers, Needs your OK cards,
// Confirm with focus callers and Undo, Change, Not now, role filtering, the one-screen New calling list, Settings >
// Autopilot, and the filter bar on a calling list's people and on Team. Unit tests: tests/web/autopilot.test.js;
// database rules: supabase/tests/autopilot_test.sql.
const { test, expect, env, isFake } = require('./fixtures');

test.beforeEach(async ({ backend }) => {
  test.skip(!isFake(), 'uses the fake backend');
  backend.autopilot.enable();
});

async function signIn(page, email, hash) {
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(email || env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#app')).toBeVisible();
}
const setRole = (backend, role, money) => {
  const s = backend.db.seats.find((x) => x.id === env().seats.admin);
  s.access_role = role;
  s.can_see_money = !!money;
  backend.db.reports.money = !!money;
};
const feesCard = (page) => page.locator('#today-ok-list li[data-kind="fees_due_list"]');

test('owner: three numbers, cards, Confirm creates the list with focus callers, Undo removes it', async ({ page, backend }) => {
  setRole(backend, 'owner', true);
  await signIn(page);
  await expect(page.locator('#today-numbers .ap-num')).toHaveCount(3);
  await expect(page.locator('#today-numbers')).toContainText('82%');
  await expect(page.locator('#today-numbers')).toContainText('₹31.2L of ₹38L due');
  await expect(page.locator('#ap-set-goals')).toBeVisible();   // no goals yet
  await expect(feesCard(page)).toContainText('Start "Term 2 fees – Class 8 State Board"');
  await expect(feesCard(page)).toContainText('₹4.8L due');
  await expect(page.locator('#today-ok-list li[data-kind="missed_promises"]')).toBeVisible();
  await expect(page.locator('#today-did-list')).toContainText('Put 64 waiting enquiries first');
  await expect(page.locator('#today-details')).not.toHaveAttribute('open', '');   // the old panels, closed
  expect(backend.db.autopilot.runs).toBe(1);   // planned once on open (no plan yet)

  await feesCard(page).locator('.ap-confirm').click();
  await expect(feesCard(page)).toContainText('Created "Term 2 fees – Class 8 State Board": 40 parents');
  const made = backend.db.campaigns.find((c) => c.name === 'Term 2 fees – Class 8 State Board');
  expect(made).toBeTruthy();
  expect(made.focus_seats).toEqual([env().seats.rep1, env().seats.rep2]);
  expect(made.open_to_all).toBe(true);

  await feesCard(page).locator('.ap-undo').click();
  await expect(feesCard(page)).toContainText('Undone. Removed "Term 2 fees – Class 8 State Board"');
  expect(backend.db.campaigns.some((c) => c.name === 'Term 2 fees – Class 8 State Board')).toBe(false);
});

test('Change shows every default and sends only what changed', async ({ page, backend }) => {
  setRole(backend, 'owner', true);
  await signIn(page);
  const c = feesCard(page);
  await c.locator('.ap-change-btn').click();
  const form = c.locator('.ap-setup');
  await expect(form.locator('input[type="text"]')).toHaveValue('Term 2 fees – Class 8 State Board');
  await expect(form).toContainText('40 parents of Class 8 State Board who owe fees due');
  await expect(form.locator('select').nth(1)).toHaveValue('19');   // 7–9 pm
  await expect(form.locator('input[type="number"]')).toHaveValue('4');
  await expect(form.locator('.ap-caller input:checked')).toHaveCount(2);
  await form.locator('.ap-caller', { hasText: 'Rep 2' }).locator('input').uncheck();
  await expect(form).toContainText('about 4 each');
  await c.locator('.ap-confirm').click();
  await expect(c).toContainText('Rep 1 calling');
  const sent = backend.db.autopilot.log.find((l) => l[0] === 'accept_suggestion')[1];
  expect(sent.p_overrides).toEqual({ callers: [env().seats.rep1] });
  expect(backend.db.campaigns.find((x) => x.name.startsWith('Term 2 fees')).focus_seats).toEqual([env().seats.rep1]);
});

test('Not now hides a card; a manager without money sees no fees card; Accounts sees no Today', async ({ page, backend }) => {
  setRole(backend, 'owner', true);
  await signIn(page);
  await page.locator('#today-ok-list li[data-kind="missed_promises"] .ap-later').click();
  await expect(page.locator('#today-ok-list li[data-kind="missed_promises"]')).toHaveCount(0);
  expect(backend.db.autopilot.cards.find((x) => x.kind === 'missed_promises').status).toBe('snoozed');
  await page.locator('#signout').click();

  setRole(backend, 'manager', false);
  backend.db.autopilot.cards.find((x) => x.kind === 'missed_promises').status = 'new';
  await signIn(page);
  await expect(page.locator('#today-ok-list li[data-kind="missed_promises"]')).toBeVisible();
  await expect(feesCard(page)).toHaveCount(0);
  await expect(page.locator('#today-ok-list li[data-kind="setup_gaps"]')).toHaveCount(0);
  await expect(page.locator('#today-numbers')).not.toContainText('₹');
  await expect(page.locator('#today-numbers')).toContainText('80 of 100 parents paid');
  await expect(page.locator('#ap-set-goals')).toHaveCount(0);   // goals are the owner's
  await page.locator('#signout').click();

  setRole(backend, 'owner', false);
  const { email } = backend.fees.addAccounts();
  await signIn(page, email, '#today');
  expect(await page.locator('#tabs a').allTextContents()).toEqual(['Fees']);
  await expect(page.locator('#today-ok')).toHaveCount(0);
});

test('one-screen New calling list: planned, Confirm, Undo on Today', async ({ page, backend }) => {
  setRole(backend, 'owner', true);
  await signIn(page, null, '#calling');
  await page.locator('#camp-new').click();
  await expect(page.locator('#camp-quick')).toBeVisible();
  await page.locator('#ap-new-class').selectOption('8th');
  await expect(page.locator('#ap-new-name')).toHaveValue('Term 2 fees – Class 8 State Board');
  await expect(page.locator('#ap-new-who')).toContainText('40 parents');
  await page.locator('#ap-new-confirm').click();
  await expect(page.locator('#status')).toContainText('Created "Term 2 fees – Class 8 State Board"');
  await expect(page.locator('#camp-detail')).toBeVisible();
  expect(backend.db.autopilot.log.some((l) => l[0] === 'autopilot_create_list')).toBe(true);

  // The people on the list, with the filter bar's counts.
  await page.locator('#camp-people > summary').click();
  await expect(page.locator('#camp-fbar [data-chip=""] .fbar-n')).toHaveText('40');
  await expect(page.locator('#camp-fbar [data-chip="tocall"] .fbar-n')).toHaveText('40');
  await expect(page.locator('#camp-fbar [data-chip="done"] .fbar-n')).toHaveText('0');
  await page.locator('#camp-fbar-q').fill('Parent 12');
  await expect(page.locator('#camp-p-body tr')).toHaveCount(1);
  await expect(page.locator('#camp-fbar [data-chip="tocall"] .fbar-n')).toHaveText('1');

  // "Change everything" still opens the full form.
  await page.goto('/admin.html#calling?new=1');
  await page.locator('#ap-new-advanced').click();
  await expect(page.locator('#camp-w-name')).toBeVisible();

  await page.goto('/admin.html#today');
  const line = page.locator('#today-did-list li[data-kind="new_list"]');
  await expect(line).toContainText('You ·');
  await line.locator('.ap-undo').click();
  await expect(line).toContainText('Undone');
  expect(backend.db.campaigns.some((c) => c.name === 'Term 2 fees – Class 8 State Board')).toBe(false);
});

test('Settings > Autopilot: switches, pause and goals', async ({ page, backend }) => {
  setRole(backend, 'owner', true);
  await signIn(page, null, '#settings');
  await expect(page.locator('#ap-sw-lists')).toBeChecked();
  await page.locator('#ap-sw-lists').uncheck();
  await expect(page.locator('#ap-settings-msg')).toHaveText('Saved.');
  expect(backend.db.autopilot.modes.fees_due_list).toBe('ask');
  await page.locator('#ap-sw-pause').check();
  await expect(page.locator('#ap-settings-msg')).toContainText('paused');
  expect(backend.db.autopilot.paused).toBe(true);
  await page.locator('#ap-goal-fees').fill('85');
  await page.locator('#ap-goal-adm').fill('40');
  await page.locator('#ap-goals-save').click();
  await expect(page.locator('#ap-settings-msg')).toContainText('Goals saved');
  await page.goto('/admin.html#today');
  await expect(page.locator('#today-numbers')).toContainText('10 of 40');
  await expect(page.locator('#ap-set-goals')).toHaveCount(0);
});

test('Team: the filter bar counts people', async ({ page, backend }) => {
  setRole(backend, 'owner', true);
  await signIn(page, null, '#team');
  await expect(page.locator('#team-fbar [data-chip="callers"] .fbar-n')).toHaveText('2');
  await page.locator('#team-fbar [data-chip="callers"]').click();
  await expect(page.locator('#seat-body tr')).toHaveCount(2);
  await page.locator('#team-fbar-q').fill('Rep 1');
  await expect(page.locator('#seat-body tr')).toHaveCount(1);
});
