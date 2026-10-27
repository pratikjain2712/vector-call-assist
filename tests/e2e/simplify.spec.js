// The simpler admin app (owner feedback: "too overwhelming, too many options"), on the fake backend: the tabs each
// role gets, old links, simple and advanced mode, the getting-started checklist, one number for each fee figure
// on Today, Fees and its report, Call scripts' "+ New script", and a phone screen. Unit tests for the helpers are
// in tests/web/admin-shell.test.js and tests/web/admin-today.test.js.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, env, isFake } = require('./fixtures');

const SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const FEES_TYPE = '00000000-0000-4000-8000-000000000002';   // the fees call type of the fake's Scripts block

test.beforeEach(async ({ page }) => {
  test.skip(!isFake(), 'uses the fake backend');
  await page.route(SHEETJS, (route) => route.fulfill({
    contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' },
    body: fs.readFileSync(path.join(__dirname, '..', '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')),
  }));
});

async function signIn(page, email, hash) {
  await page.goto('/admin.html' + (hash || ''));
  await page.locator('#gate-email').fill(email || env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#app')).toBeVisible();
}
const tabNames = (page) => page.locator('#tabs a').allTextContents();
const setRole = (backend, role, money) => {
  const s = backend.db.seats.find((x) => x.id === env().seats.admin);
  s.access_role = role;
  s.can_see_money = !!money;
  backend.db.reports.money = !!money;
};

test('each role gets its tabs: owner five, manager three (four with money), Accounts Fees only', async ({ page, backend }) => {
  await signIn(page);
  expect(await tabNames(page)).toEqual(['Today', 'Fees', 'Calling', 'Team', 'Settings']);
  await page.locator('#signout').click();
  await expect(page.locator('#gate')).toBeVisible();

  setRole(backend, 'manager', false);
  await signIn(page);
  expect(await tabNames(page)).toEqual(['Today', 'Calling', 'Team']);
  await page.goto('/admin.html#fees');
  await expect(page).toHaveURL(/#today$/);   // no Fees without money access
  await page.locator('#signout').click();

  setRole(backend, 'manager', true);
  await signIn(page);
  expect(await tabNames(page)).toEqual(['Today', 'Fees', 'Calling', 'Team']);
  await page.locator('#signout').click();

  setRole(backend, 'owner', false);
  const { email } = backend.fees.addAccounts();
  await signIn(page, email, '#today');
  expect(await tabNames(page)).toEqual(['Fees']);
  await expect(page).toHaveURL(/#fees$/);
});

test('old links open their new place without an extra history entry', async ({ page }) => {
  await signIn(page);
  const cases = [
    ['#home', /#today$/, '#tab-today'],
    ['#insights', /#today\?more=1$/, '#ins-more[open]'],
    ['#campaigns', /#calling$/, '#calling-lists'],
    ['#scripts', /#calling\/scripts$/, '#calling-scripts'],
    ['#callers', /#team$/, '#tab-team'],
    ['#reports?report=funnel', /#today\/reports\?report=funnel$/, '#rp-funnel'],
    ['#reports?report=fees', /#fees\/report$/, '#rp-fees'],
  ];
  for (const [hash, url, shown] of cases) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await expect(page).toHaveURL(url);
    await expect(page.locator(shown)).toBeVisible();
  }
  // The address bar was rewritten in place: Back goes to the previous new-style address, never to an old one.
  await page.goBack();
  await expect(page).toHaveURL(/#today\/reports\?report=funnel$/);
});

test('simple by default; "Show advanced options" is remembered per login on this browser', async ({ page }) => {
  await signIn(page, null, '#calling?new=1');
  // The calling-list form: board, daily target and share fields are advanced.
  await expect(page.locator('#camp-w-name')).toBeVisible();
  await expect(page.locator('#camp-w-board-chips')).toBeHidden();
  await expect(page.locator('#camp-w-target')).toBeHidden();
  await page.locator('#account-toggle').click();
  await expect(page.locator('#account-advanced')).not.toBeChecked();
  await page.locator('#account-advanced').check();
  await expect(page.locator('#camp-w-board-chips')).toBeVisible();
  await expect(page.locator('#camp-w-target')).toBeVisible();
  // Remembered after a reload, for this login only.
  await page.reload();
  await expect(page.locator('#camp-w-board-chips')).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('vector-admin-advanced')))).toEqual(
    ['vector-admin-advanced:' + env().users.admin.email.toLowerCase()]);
  await page.locator('#account-toggle').click();
  await page.locator('#account-advanced').uncheck();
  await expect(page.locator('#camp-w-board-chips')).toBeHidden();
  await page.reload();
  await expect(page.locator('#camp-w-target')).toBeHidden();
});

test('a browser that blocks storage still works, in simple mode', async ({ page }) => {
  await page.addInitScript(() => {
    const deny = () => { throw new Error('storage blocked'); };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: deny });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page, null, '#settings');
  await expect(page.locator('#settings-call-types')).toBeHidden();
  await page.locator('#settings-advanced-switch').check();   // works for this page view
  await expect(page.locator('#settings-call-types')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the getting-started checklist follows real data, and Hide closes it', async ({ page, backend }) => {
  backend.db.ledgerReports.hasLedger = false;
  await signIn(page);
  const card = page.locator('#today-checklist');
  await expect(card).toBeVisible();
  const item = (k) => card.locator('li[data-key="' + k + '"]');
  await expect(item('students')).not.toHaveClass(/done/);
  await expect(item('answers')).toContainText('Fill common answers (0 of 5)');
  await expect(item('caller')).toHaveClass(/done/);   // Rep 1 and Rep 2
  await expect(item('list')).not.toHaveClass(/done/);
  await expect(item('whatsapp')).not.toHaveClass(/done/);
  // Import done, a calling list with a script running: those two are ticked after the next look at Today.
  backend.db.ledgerReports.hasLedger = true;
  const id = backend.adminTabs.addCampaign(env().institutes.a, 'Oct fees', 'running');
  Object.assign(backend.db.campaigns.find((c) => c.id === id), { call_type_id: FEES_TYPE, script_id: 's1' });
  await page.locator('#tab-link-team').click();
  await page.locator('#tab-link-today').click();
  await expect(item('students')).toHaveClass(/done/);
  await expect(item('students').getByRole('link')).toHaveCount(0);
  await expect(item('answers').getByRole('link', { name: /Fill in/ })).toHaveAttribute('href', '#settings');
  await card.getByRole('button', { name: 'Hide' }).click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(page.locator('#home-tiles')).toContainText('Calls made');
  await expect(card).toBeHidden();   // closed for good on this browser
});

test('one number, one definition: Today, the Fees cards and the collection report agree for the same dates', async ({ page, backend }) => {
  backend.db.reports.money = true;
  await signIn(page, null, '#fees');
  const fees = {};
  for (const k of ['due', 'collected', 'promised', 'missed']) {
    await expect(page.locator('#fees-card-' + k + ' .fees-card-value')).not.toHaveText('');
    fees[k] = { label: await page.locator('#fees-card-' + k + ' .fees-card-label').textContent(),
      value: await page.locator('#fees-card-' + k + ' .fees-card-value').textContent() };
  }
  expect(fees.collected.label).toBe('Collected this month');
  expect(fees.missed.label).toBe('Promised date missed');
  // The collection report opens on this month: the same four labels and values.
  await page.locator('#fees-view-report').click();
  await expect(page.locator('#rp-dates')).toHaveValue('month');
  for (const k of ['due', 'collected', 'promised', 'missed']) {
    const c = page.locator('#rp-fees-cards [data-card="' + k + '"]');
    await expect(c.locator('.card-label')).toHaveText(fees[k].label);
    await expect(c.locator('.card-value')).toHaveText(fees[k].value);
  }
  // Today's "Collected today" equals the report for today.
  await page.locator('#rp-dates').selectOption('today');
  await expect(page.locator('#rp-fees-cards [data-card="collected"] .card-label')).toHaveText('Collected today');
  const todayInReport = await page.locator('#rp-fees-cards [data-card="collected"] .card-value').textContent();
  await page.locator('#tab-link-today').click();
  await expect(page.locator('#home-fees-tile .home-tile-label')).toHaveText('Collected today');
  await expect(page.locator('#home-fees-tile .home-tile-value')).toHaveText(todayInReport);
  expect(todayInReport).toBe('₹1,000');
  // After a payment, all three move together.
  await page.locator('#tab-link-fees').click();
  await page.locator('#fees-view-students').click();
  await page.locator('#fees-body a', { hasText: 'Aarav Shah' }).click();
  await page.locator('#fs-collect').click();
  await page.locator('#collect-amount').fill('2000');
  await page.locator('.collect-mode[data-mode="cash"]').click();
  await page.locator('#collect-save').click();
  await expect(page.locator('#collect-done')).toContainText('₹2,000 received');
  await page.locator('#collect-back').click();
  await page.locator('#fs-back').click();
  await expect(page.locator('#fees-card-due .fees-card-value')).toHaveText('₹5,000');
  await page.locator('#fees-view-report').click();
  await page.locator('#rp-filters button[type="submit"]').click();
  await expect(page.locator('#rp-fees-cards [data-card="collected"] .card-value')).toHaveText('₹3,000');
  await expect(page.locator('#rp-fees-cards [data-card="due"] .card-value')).toHaveText('₹5,000');
});

test('Call scripts: own scripts first; "+ New script" suggests 6 for the institute\'s calls, then See all 26', async ({ page, backend }) => {
  const id = backend.adminTabs.addCampaign(env().institutes.a, 'Oct fees', 'running');
  backend.db.campaigns.find((c) => c.id === id).call_type_id = FEES_TYPE;
  await signIn(page, null, '#calling/scripts');
  await expect(page.locator('#scripts-templates')).toBeHidden();   // the library is not on the page until asked
  await expect(page.locator('#tpl-results article')).toHaveCount(0);
  await expect(page.locator('#scripts-answers-link')).toHaveAttribute('href', '#settings');
  await page.locator('#scripts-template').click();
  await expect(page.locator('#scripts-template')).toHaveText('+ New script');
  const cards = page.locator('#tpl-results article');
  await expect(cards).toHaveCount(6);
  await expect(page.locator('#tpl-count')).toHaveText('Suggested for your calling lists');
  for (const c of await cards.all()) await expect(c.locator('.pill').first()).toHaveText('Fees collection');
  await expect(page.locator('#tpl-filters')).toBeHidden();
  await page.locator('#tpl-all').click();
  await expect(cards).toHaveCount(26);
  await expect(page.locator('#tpl-filters')).toBeVisible();
  await expect(page.locator('#new-script')).toBeVisible();
  // No "Common answers" block in Call scripts for an institute: it lives in Settings.
  await expect(page.getByText('Add or change an answer')).toBeHidden();
});

test('Calling: Calling lists, Call scripts and Reports are views of one tab', async ({ page }) => {
  await signIn(page, null, '#calling');
  await expect(page.locator('#calling-view-lists')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#camp-new')).toHaveText('+ New calling list');
  await page.locator('#calling-view-scripts').click();
  await expect(page).toHaveURL(/#calling\/scripts$/);
  await page.locator('#calling-view-reports').click();
  await expect(page).toHaveURL(/#calling\/reports$/);
  await expect(page.locator('#rp-pick-results')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#rp-pick-fees')).toBeHidden();
  // The same report code also opens from Today.
  await page.locator('#tab-link-today').click();
  await page.locator('#today-reports-open').click();
  await expect(page.locator('#rp-pick-results')).toBeVisible();
  await page.locator('#today-reports-back').click();
  await expect(page.locator('#home-tiles')).toBeVisible();
});

for (const who of ['owner', 'manager', 'accounts']) {
  test(`a phone (390 px): every tab of the ${who} in reach and no page scrolls sideways`, async ({ page, backend }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let email = null;
    if (who === 'manager') setRole(backend, 'manager', false);
    if (who === 'accounts') email = backend.fees.addAccounts().email;
    await signIn(page, email);
    const ids = await page.locator('#tabs a').evaluateAll((as) => as.map((a) => a.getAttribute('data-tab')));
    expect(ids.length).toBe({ owner: 5, manager: 3, accounts: 1 }[who]);
    for (const id of ids) {
      if (ids.length > 1) {
        const box = await page.locator('#tab-link-' + id).boundingBox();
        expect(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, id + ' in view').toBe(true);
        await page.locator('#tab-link-' + id).click();
      }
      await expect(page.locator('#tab-' + id)).toBeVisible();
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), id).toBeLessThanOrEqual(390);
    }
    if (who === 'owner') {
      // Team on a phone: a card per person with its Edit button in reach.
      await page.locator('#tab-link-team').click();
      const edit = page.locator('#seat-body tr', { hasText: 'Rep 1' }).getByRole('button', { name: 'Edit Rep 1' });
      const b = await edit.boundingBox();
      expect(b.x >= 0 && b.x + b.width <= 390).toBe(true);
      await page.locator('#tab-link-calling').click();
      await page.locator('#calling-view-scripts').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    }
  });
}
