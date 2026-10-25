// The Scripts tab (web/js/admin/scripts.js and web/js/script-editor.js): the list, starting from a template of
// the shared library, "Check this" marks blocking publishing, ending results and pushbacks, the AI script maker
// (Phase A.2: on the Library view, for the Vector team only: draft, Make simpler, edit as a template, publish to
// the library) and the read-only list without the Scripts add-on. Uses the fake backend (the Edge Function
// cannot run in the local stack here).
const { test, expect, env, isFake } = require('./fixtures');

async function signInAdmin(page, hash) {
  await page.goto('/admin.html' + (hash || '#scripts'));
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#tab-link-scripts')).toHaveAttribute('aria-current', 'page');
}

test.beforeEach(() => { test.skip(!isFake(), 'uses the fake backend for the ai-script-draft Edge Function'); });

test('start from the fees template, clear the marks, link endings and publish', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signInAdmin(page);
  await expect(page.locator('#scripts-empty')).toBeVisible();
  await expect(page.locator('#scripts-template')).toBeEnabled();

  await page.locator('#scripts-template').click();
  await expect(page.locator('#scripts-template')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('button[data-template="fees_reminder_polite"]').click();
  await expect(page).toHaveURL(/#scripts\?new=template$/);
  await expect(page.locator('#scripts-editor-view')).toBeVisible();
  await expect(page.locator('#script-name')).toHaveValue('Fee reminder before the due date');
  await expect(page.locator('#script-type option:checked')).toHaveText('Fees collection');
  // Every ending names a result of the type.
  await expect(page.locator('#steps fieldset.step').nth(4).locator('[data-field="result"] option:checked')).toHaveText('Will pay on date');

  // The template's marks block publishing.
  await expect(page.locator('#problem-list')).toContainText('Check this (step "promise")');
  await page.locator('#publish-open').click();
  await expect(page.locator('#editor-msg')).toHaveText('Fix the problems listed above before publishing.');
  await expect(page.locator('#publish-box')).toBeHidden();

  // Clear each mark (one step and five pushbacks), then publish.
  const marks = page.locator('#scripts-editor-view button[data-action="del-mark"]');
  await expect(marks).toHaveCount(6);
  while (await marks.count()) await marks.first().click();
  await expect(page.locator('#problems')).toBeHidden();
  await page.locator('#publish-open').click();
  await page.locator('#publish-note').fill('First live version');
  await page.locator('#publish-go').click();
  await expect(page.locator('#editor-msg')).toContainText('Published');
  await expect(page).toHaveURL(/#scripts\?edit=/);

  const saved = backend.db.scriptVersions[0];
  expect(saved.published).toBe(true);
  expect(saved.pushbacks.map((p) => p.label)).toContain('Can I pay in parts?');
  expect(saved.steps.find((s) => s.id === 'stop').result).toBe('do_not_call');
  expect(saved.steps.find((s) => s.id === 'open').stage).toBe(0);

  await page.locator('#editor-back').click();
  await expect(page).toHaveURL(/#scripts$/);
  const row = page.locator('#scripts-body tr').first();
  await expect(row).toContainText('Fee reminder before the due date');
  await expect(row).toContainText('Fees collection');
  await expect(row).toContainText('v1');
  await expect(row).toContainText('Not used');
  await row.getByRole('button', { name: 'Edit Fee reminder before the due date' }).click();
  await expect(page.locator('#state-line')).toContainText('Live: v1');
  expect(errors).toEqual([]);
});

test('an ending must be linked to a result of the type, and a pushback needs an answer', async ({ page }) => {
  await signInAdmin(page);
  await page.locator('#new-script').click();
  await expect(page).toHaveURL(/#scripts\?new=blank$/);
  await page.locator('#script-name').fill('Hand made');
  await page.locator('#add-step').click();
  await page.locator('#steps [data-field="say"]').fill('Hello {name}.');
  await expect(page.locator('#problem-list')).toContainText('Choose the call type.');
  await page.locator('#script-type').selectOption({ label: 'Sales' });
  await expect(page.locator('#problem-list')).toContainText('The ending "step-1" is not linked to a result.');
  await page.locator('#steps [data-field="result"]').selectOption({ label: 'Do not call again' });
  await expect(page.locator('#problems')).toBeHidden();

  await page.locator('#add-pushback').click();
  await page.locator('#pushbacks [data-field="pb-label"]').fill('Too costly');
  await expect(page.locator('#problem-list')).toContainText('The pushback "Too costly" has no answer.');
  await page.locator('#save-draft').click();
  await expect(page.locator('#editor-msg')).toContainText('Fix the pushback answers first');
  await page.locator('#pushbacks [data-field="pb-answer"]').fill('Can I tell you what is included?');
  await page.locator('#save-draft').click();
  await expect(page.locator('#editor-msg')).toHaveText('Draft saved.');
});

test('the Vector team makes a template with AI, makes a line simpler and publishes it to the library', async ({ page, backend }) => {
  backend.db.platformAdmins.push(env().users.admin.id);
  await signInAdmin(page, '#scripts?library=1');
  await expect(page.locator('#scripts-library-view')).toBeVisible();
  await expect(page.locator('#ai-usage')).toHaveText('0 of 20 AI drafts used this month');
  await page.locator('#ai-make').click();
  await expect(page.locator('#ai-msg')).toHaveText('Write what the call is for.');

  await page.locator('#ai-type').selectOption('fees');
  await page.locator('#ai-purpose').fill('Remind parents of Class 10 that the second term fee is due.');
  await page.locator('#ai-facts').fill('Fee ₹18,000. Due 31 Oct.');
  await page.locator('#ai-never').fill('Do not threaten.');
  await page.locator('#ai-make').click();
  await expect(page.locator('#ai-draft-title')).toHaveText('Draft: Fees reminder Class 10');
  await expect(page.locator('#ai-score')).toContainText('Easy to read');
  await expect(page.locator('#ai-checks')).toContainText('1 "Check this" mark');
  await expect(page.locator('#ai-usage')).toHaveText('1 of 20 AI drafts used this month');
  expect(backend.db.aiRequests[0].brief).toMatchObject({ call_type: 'fees', audience: 'Parents', language: 'simple_english', facts: 'Fee ₹18,000. Due 31 Oct.' });

  await page.getByRole('button', { name: 'Make this line simpler: Hello, am I speaking with {name}?' }).click();
  await expect(page.locator('#ai-steps')).toContainText('Simpler: open');
  await expect(page.locator('#ai-msg')).toHaveText('Line made simpler.');

  // "Edit as a template" fills the library form; a "Check this" mark may stay (institutes fill it in).
  await page.locator('#ai-open').click();
  await expect(page.locator('#lib-name')).toHaveValue('Fees reminder Class 10');
  await expect(page.locator('#lib-key')).toHaveValue('fees_reminder_class_10');
  await expect(page.locator('#lib-type option:checked')).toHaveText('Fees collection');
  await expect(page.locator('#lib-steps')).toHaveValue(/is not in the facts you gave/);
  await expect(page.locator('#lib-marks')).toHaveText('1 "Check this" mark for institutes to fill in.');
  await page.locator('#lib-classes').fill('10th');
  await page.locator('input.lib-board[value="CBSE"]').check();
  await page.locator('#lib-publish').click();
  await expect(page.locator('#lib-form-msg')).toHaveText('Published "Fees reminder Class 10" to the library as v1. Institutes see it now.');
  const saved = backend.db.templates.find((t) => t.key === 'fees_reminder_class_10');
  expect(saved).toMatchObject({ call_type: 'fees', class_labels: ['10th'], boards: ['CBSE'], language: 'en', version: 1 });
  await expect(page.locator('#lib-body')).toContainText('Fees reminder Class 10');
});

test('without the Scripts add-on the list is read-only', async ({ page, backend }) => {
  backend.db.features = [];
  backend.db.scripts.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', institute_id: env().institutes.a, name: 'Old script', call_type_id: null, created_at: new Date().toISOString() });
  await signInAdmin(page);
  await expect(page.locator('#scripts-addon')).toBeVisible();
  await expect(page.locator('#scripts-addon')).toContainText('Add Scripts to use this.');
  await expect(page.locator('#new-script')).toBeDisabled();
  await expect(page.locator('#scripts-template')).toBeDisabled();
  await expect(page.locator('#scripts-library-open')).toBeHidden();
  await expect(page.locator('#scripts-body tr').first()).toContainText('Old script');
  await expect(page.locator('#scripts-body')).not.toContainText('Edit');
  // A typed link to the editor shows the list instead.
  await page.goto('/admin.html#scripts?edit=aaaaaaaa-0000-4000-8000-000000000001');
  await expect(page.locator('#scripts-list-view')).toBeVisible();
  await expect(page.locator('#scripts-editor-view')).toBeHidden();
});

test('the Scripts tab fits a phone screen', async ({ page, backend }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await signInAdmin(page);
  const noSideScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.locator('#scripts-template').click();
  await noSideScroll();
  await page.locator('button[data-template="course_sales_enquiry"]').click();
  await expect(page.locator('#scripts-editor-view')).toBeVisible();
  await noSideScroll();
  await page.locator('#editor-back').click();
  // The Library view (Vector team) fits too.
  backend.db.platformAdmins.push(env().users.admin.id);
  await page.reload();
  await page.locator('#scripts-library-open').click();
  await expect(page.locator('#scripts-library-view')).toBeVisible();
  await noSideScroll();
  // Keyboard: the form can be sent with the keyboard.
  await page.locator('#ai-purpose').fill('Invite students to the next batch.');
  await page.locator('#ai-make').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#ai-draft-title')).toBeVisible();
  await noSideScroll();
});
