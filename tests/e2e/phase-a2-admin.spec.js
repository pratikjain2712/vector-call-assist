// Phase A.2: admin. The shared template library in the Scripts tab (filters, preview, "Use this template"), the
// Library view for the Vector team only, open campaigns with class and board tags, "Back to pool" and the
// Accounts role on the Callers tab, and the common answers card in Settings. Uses the fake backend
// (tests/e2e/fake-backend.js, block "Phase A.2: admin"), which reads supabase/templates/*.json like the
// migration's seed.
const crypto = require('node:crypto');
const { test, expect, env, isFake } = require('./fixtures');

async function signInAdmin(page, hash) {
  await page.goto('/admin.html' + hash);
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
}

test.beforeEach(() => { test.skip(!isFake(), 'uses the fake backend'); });

test('an owner filters the template library by Fees and Hinglish, previews one and uses it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signInAdmin(page, '#scripts');
  await expect(page.locator('#tab-link-scripts')).toHaveAttribute('aria-current', 'page');
  await page.locator('#scripts-template').click();
  await expect(page.locator('#scripts-templates')).toBeVisible();
  await expect(page.locator('#tpl-count')).toHaveText('26 templates');

  await page.locator('#tpl-type').selectOption('fees');
  await expect(page.locator('#tpl-count')).toHaveText('9 templates');
  await page.locator('#tpl-language').selectOption('hinglish');
  await expect(page.locator('#tpl-count')).toHaveText('2 templates');
  await page.locator('#tpl-board').selectOption('CBSE');
  await page.locator('#tpl-class').fill('8th');
  await page.locator('#tpl-class').press('Enter');
  await expect(page.locator('#tpl-count')).toHaveText('2 templates');   // untagged templates suit every class and board

  const card = page.locator('#tpl-results article[data-key="fees_reminder_polite_hinglish"]');
  await expect(card).toContainText('Fees collection');
  await expect(card).toContainText('Hinglish');
  await expect(card).toContainText('All classes · All boards');
  const preview = card.getByRole('button', { name: 'Preview Fee reminder before the due date (Hinglish)' });
  await preview.click();
  await expect(preview).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.tpl-preview')).toContainText('Steps');
  await expect(card.locator('.tpl-preview')).toContainText('Pushback answers');
  await expect(card.locator('.tpl-preview .tpl-check').first()).toContainText('Fill in:');

  await card.getByRole('button', { name: 'Use the Fee reminder before the due date (Hinglish) template' }).click();
  await expect(page).toHaveURL(/#scripts\?new=template$/);
  await expect(page.locator('#script-name')).toHaveValue('Fee reminder before the due date (Hinglish)');
  await expect(page.locator('#script-type option:checked')).toHaveText('Fees collection');
  await expect(page.locator('#problem-list')).toContainText('Check this');
  expect(errors).toEqual([]);
});

test('the Library view is for the Vector team: an owner does not see it, a platform admin does', async ({ page, backend }) => {
  await signInAdmin(page, '#scripts?library=1');
  await expect(page.locator('#scripts-list-view')).toBeVisible();
  await expect(page.locator('#scripts-library-view')).toBeHidden();
  await expect(page.locator('#scripts-library-open')).toBeHidden();
  await expect(page.locator('#scripts-msg')).toContainText('kept by the Vector team');
  await expect(page.getByRole('button', { name: 'Make with AI' })).toHaveCount(0);

  backend.db.platformAdmins.push(env().users.admin.id);
  await page.reload();
  await expect(page.locator('#scripts-library-view')).toBeVisible();
  await expect(page.locator('#lib-count')).toHaveText('26 templates in the library');
  await expect(page.locator('#ans-body tr')).toHaveCount(21);
  // Change a common answer for every institute.
  await page.getByRole('button', { name: 'Edit answer How long will this take?' }).click();
  await expect(page.locator('#ans-key')).toHaveValue('how_long');
  await page.locator('#ans-answer').fill('Just two minutes.');
  await page.locator('#ans-form button[type="submit"]').click();
  await expect(page.locator('#ans-msg')).toContainText('Saved "How long will this take?"');
  expect(backend.db.commonAnswers.find((a) => a.key === 'how_long').answer).toBe('Just two minutes.');
  // Edit a template and switch it off for institutes.
  await page.getByRole('button', { name: 'Edit template Overdue fee reminder', exact: true }).click();
  await expect(page.locator('#lib-key')).toHaveValue('fees_overdue');
  await page.locator('#lib-active').uncheck();
  await page.locator('#lib-publish').click();
  await expect(page.locator('#lib-form-msg')).toContainText('as v1');
  expect(backend.db.templates.find((t) => t.key === 'fees_overdue').active).toBe(false);
});

test('an owner creates an open campaign for class 8th and CBSE', async ({ page, backend }) => {
  await signInAdmin(page, '#campaigns?new=1');
  await expect(page.locator('#camp-w-name')).toBeVisible();
  await page.locator('#camp-w-name').fill('8th CBSE fees');
  await page.locator('label.chip', { hasText: '8th' }).click();
  await page.locator('#camp-w-board-chips label.chip', { hasText: 'CBSE' }).click();
  await expect(page.locator('#camp-w-class-8th')).toBeChecked();
  await expect(page.locator('#camp-w-board-cbse')).toBeChecked();
  await page.locator('#camp-w-leads-file').setInputFiles({ name: 'c8.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Phone\nAsha,9876543210\nArun,9876543211\n') });
  await expect(page.locator('#camp-w-leads-skip')).toHaveText('2 leads ready.');
  await expect(page.locator('#camp-w-step4 > legend')).toHaveText('4 · Who can call');
  await expect(page.locator('#camp-w-who-all')).toBeChecked();
  await expect(page.locator('#camp-w-some')).toBeHidden();
  await page.locator('#camp-w-start').click();

  await expect(page.locator('#camp-d-status')).toHaveText('Running');
  const c = backend.db.campaigns.find((x) => x.name === '8th CBSE fees');
  expect(c).toMatchObject({ open_to_all: true, class_label: '8th', board: 'CBSE', share_mode: 'next_free' });
  const facts = page.locator('#camp-detail dl.facts');
  await expect(facts).toContainText('All callers');
  await expect(facts).toContainText('8th · CBSE');
  await expect(facts).toContainText('After 24 working hours without a call');
  await expect(page.locator('#camp-d-open-note')).toContainText('Every caller can work this campaign');

  await page.locator('#camp-d-release').fill('48');
  await page.locator('#camp-d-edit button[type="submit"]').click();
  await expect(facts).toContainText('After 48 working hours without a call');
  expect(c.release_after_hours).toBe(48);

  await page.locator('#camp-detail .back a').click();
  const row = page.locator('#camp-body tr', { hasText: '8th CBSE fees' });
  await expect(row.locator('.tag')).toHaveText('8th · CBSE');
  await expect(row).toContainText('All callers');
});

test('Callers: "Back to pool" says how many leads go back, and the role select has Accounts', async ({ page, backend }) => {
  const rep1 = env().seatInfo.rep1;
  const campaign = { id: crypto.randomUUID(), institute_id: env().institutes.a, name: 'Open fees', call_type_id: null, status: 'running',
    open_to_all: true, share_mode: 'next_free', created_at: new Date().toISOString() };
  backend.db.campaigns.push(campaign);
  ['new', 'callback', 'done'].forEach((status, i) => backend.db.leads.push({ id: crypto.randomUUID(), campaign_id: campaign.id,
    institute_id: campaign.institute_id, name: 'Lead ' + i, phone: '+9198765432' + (10 + i), extra: {}, assigned_seat_id: rep1.id, status }));
  // A lead still open in a closed campaign is not sent back, so it is not counted either.
  const closed = { id: crypto.randomUUID(), institute_id: env().institutes.a, name: 'September fees', call_type_id: null, status: 'closed',
    open_to_all: true, share_mode: 'next_free', created_at: new Date().toISOString() };
  backend.db.campaigns.push(closed);
  backend.db.leads.push({ id: crypto.randomUUID(), campaign_id: closed.id, institute_id: closed.institute_id, name: 'Old lead', phone: '+919876543299',
    extra: {}, assigned_seat_id: rep1.id, status: 'callback' });

  await signInAdmin(page, '#callers');
  await expect(page.locator('#invite-note')).toContainText('This is the only step');

  // Invite an Accounts seat: the role choice is Caller / Manager / Accounts.
  await expect(page.locator('#invite-role option')).toHaveText(['Caller', 'Manager', 'Accounts']);
  await page.locator('#invite-email').fill('fees.office@e2e.example.com');
  await page.locator('#invite-label').fill('Fees office');
  await page.locator('#invite-role').selectOption('accounts');
  await expect(page.locator('#invite-role-help')).toContainText('An accounts seat records fee payments');
  await page.locator('#invite-form button[type="submit"]').click();
  await expect(page.locator('#confirm-text')).toContainText('as accounts for fees.office@e2e.example.com');
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toContainText('Seat "Fees office" added for fees.office@e2e.example.com.');
  expect(backend.db.seats.find((s) => s.label === 'Fees office')).toMatchObject({ role: 'accounts', status: 'invited', invite_email: 'fees.office@e2e.example.com' });
  await expect(page.locator('#seat-body')).toContainText('Fees office');
  await page.getByRole('button', { name: 'Back to pool: leads of Rep 1' }).click();
  await expect(page.locator('#confirm')).toBeVisible();
  await expect(page.locator('#confirm-text')).toContainText('2 leads not finished yet of "Rep 1"');
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toHaveText('2 leads of "Rep 1" back in the pool.');
  expect(backend.db.leads.filter((l) => l.campaign_id === campaign.id && l.assigned_seat_id === rep1.id).map((l) => l.status)).toEqual(['done']);
  expect(backend.db.leads.find((l) => l.name === 'Old lead').assigned_seat_id).toBe(rep1.id);

  // The role select has Accounts, with its one-line explanation.
  await page.locator('#seat-body tr[data-seat="' + rep1.id + '"]').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#edit-role option[value="accounts"]')).toHaveText('Accounts');
  await expect(page.locator('#edit-role-accounts')).toContainText('records fee payments');
  // An open campaign needs no membership: only campaigns for chosen callers are listed.
  await expect(page.locator('#edit-campaign-list')).not.toContainText('Open fees');
  await page.locator('#edit-role').selectOption('accounts');
  await page.locator('#edit-role-save').click();
  await expect(page.locator('#confirm-text')).toContainText('records fee payments');
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toHaveText('"Rep 1" is now accounts.');
  expect(backend.db.seats.find((s) => s.id === rep1.id).role).toBe('accounts');

  // An Accounts seat stays in the seats list with its role, but is not a caller: no "now" status, no Back to pool,
  // no campaigns or leads to move, and nobody can move leads to it.
  const row = page.locator('#seat-body tr[data-seat="' + rep1.id + '"]');
  await expect(row).toContainText('Accounts');
  await expect(row.locator('td').nth(4)).toHaveText('');
  await expect(row).toContainText('No phone needed');
  await expect(row).not.toContainText('No calls yet');
  await expect(row.getByRole('button', { name: 'Back to pool: leads of Rep 1' })).toHaveCount(0);
  await expect(page.locator('#edit-campaigns')).toBeHidden();
  await expect(page.locator('#edit-move')).toBeHidden();
  await expect(page.locator('#edit-release')).toBeHidden();
  await page.locator('#seat-body tr[data-seat="' + env().seatInfo.rep2.id + '"]').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#edit-move')).toBeVisible();
  await expect(page.locator('#move-to option')).not.toContainText(['Rep 1']);
  await expect(page.locator('#move-to')).not.toContainText('Rep 1');
});

test('Settings: the owner fills in the common answers that need institute facts', async ({ page, backend }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signInAdmin(page, '#settings');
  const card = page.locator('#settings-answers');
  await expect(card.locator('li.answer')).toHaveCount(5);
  await expect(page.locator('#answers-count')).toHaveText('0 of 5 filled in');
  const loc = card.locator('li.answer[data-key="location"]');
  await expect(loc).toContainText('Not filled in yet');
  await loc.locator('textarea').fill('We are at 12 MG Road, near City Mall.');
  await loc.getByRole('button', { name: 'Save the answer to: Where is the institute?' }).click();
  await expect(page.locator('#status')).toContainText('Saved the answer to "Where is the institute?"');
  await expect(page.locator('#answers-count')).toHaveText('1 of 5 filled in');
  await expect(card.locator('li.answer[data-key="location"]')).toContainText('Filled in');
  expect(backend.db.answerFills[env().institutes.a].location).toBe('We are at 12 MG Road, near City Mall.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
