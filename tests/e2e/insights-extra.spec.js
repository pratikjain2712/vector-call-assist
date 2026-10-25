// Weekly brief and script test cards (web/js/admin/insights-extra.js) and practice mode (web/practice.html).
// The cards are mounted here the way the Insights tab mounts them, with a small ctx built in the page (the
// shell's own ctx is private). Fake backend only: the local stack has no campaign or script test seeded.
const { test, expect, env, isFake } = require('./fixtures');

// Signs in on the Team tab: Today holds the Insights cards itself, so it stays unmounted here and the cards this
// test mounts are the only ones on the page.
async function adminSignIn(page) {
  await page.goto('/admin.html#team');
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#tab-link-team')).toHaveAttribute('aria-current', 'page');
}

// Mounts both cards in a box styled like the Insights tab. Confirmations are kept in window.__ixJobs so the
// test can run them (the shell's confirmation box belongs to the shell).
async function mountCards(page, campaignId) {
  await page.evaluate((campaign) => {
    const S = window.VectorAdminShared;
    const cfg = window.VECTOR_CONFIG;
    const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true } });
    const rpc = async (name, args) => {
      const { data, error } = await client.rpc(name, args);
      if (error) { const e = new Error(error.message); e.code = error.code; throw e; }
      return data;
    };
    window.__ixJobs = [];
    const ctx = { client, rpc, isMissing: () => false, helpers: S, canSeeMoney: false,
      confirm: (job) => window.__ixJobs.push(job), status: () => {} };
    document.querySelectorAll('#panels > section').forEach((s) => { s.hidden = true; });
    const box = S.el('section', { id: 'ix-host', className: 'tab-panel tab-insights' });
    document.getElementById('panels').appendChild(box);
    window.VectorInsightsExtra.mountWeeklyBrief(box, ctx, { campaignId: campaign });
    window.VectorInsightsExtra.mountScriptTest(box, ctx, { campaignId: campaign });
  }, campaignId);
}
async function runLastJob(page) {
  return page.evaluate(async () => {
    const job = window.__ixJobs.pop();
    await job.run();
    if (job.reload) await job.reload();
    return { title: job.title, text: job.text, button: job.button };
  });
}
const CAMPAIGN = '7e570000-0000-4000-8000-000000000001';

test.describe('insights extra', () => {
  test.skip(() => !isFake(), 'needs the fake backend (no campaigns are seeded on the local stack)');

  test('weekly brief and script test: winner, keep testing, use for everyone, start again', async ({ page, backend }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await adminSignIn(page);
    await mountCards(page, CAMPAIGN);

    const lines = page.locator('#ix-brief-lines li');
    await expect(lines).toHaveCount(4);
    await expect(lines.first()).toContainText('E2E fees: 40 of 82 leads');
    await expect(page.locator('#ix-brief-title')).toHaveText('This week in 4 lines');

    await expect(page.locator('#ix-test-heading')).toHaveText('v6 vs v7');
    await expect(page.locator('#ix-arm-a')).toContainText('v6 · 102 picked-up calls');
    await expect(page.locator('#ix-arm-a')).toContainText('9');
    await expect(page.locator('#ix-arm-b')).toContainText('26');
    await expect(page.locator('#ix-arm-b')).toContainText(/Winner, \d+% sure/);
    await expect(page.locator('#ix-test-verdict')).toContainText('v7 gets more good results');
    await expect(page.locator('#ix-test-body')).toContainText('Average call: v6 6m 50s, v7 5m 40s.');
    await expect(page.locator('#ix-test-body')).toContainText('Change in v7: Shorter pitch');

    // Keep testing hides the suggestion and offers both versions.
    await page.locator('#ix-keep').click();
    await expect(page.locator('#ix-test-msg')).toContainText('The test keeps running');
    await expect(page.locator('#ix-use-a')).toHaveText('Use v6 for everyone');
    await expect(page.locator('#ix-use-b')).toHaveText('Use v7 for everyone');

    await page.locator('#ix-use-b').click();
    const job = await runLastJob(page);
    expect(job.title).toBe('Use v7 for everyone?');
    expect(backend.db.ix.log.find((l) => l[0] === 'admin_end_script_test')[1]).toEqual({ p_test: '7e570000-0000-4000-8000-0000000000aa', p_winner: 7 });
    await expect(page.locator('#ix-test-last')).toContainText('v7 was chosen for everyone.');

    // A new test: v7 (now in use) against v6.
    await expect(page.locator('#ix-test-a')).toHaveValue('7');
    await expect(page.locator('#ix-test-b')).toHaveValue('6');
    await page.locator('#ix-test-start').click();
    const start = await runLastJob(page);
    expect(start.text).toContain('Half of the leads in "E2E fees" will hear v7 and half v6');
    await expect(page.locator('#ix-test-heading')).toHaveText('v7 vs v6');
    await expect(page.locator('#ix-test-verdict')).toContainText('Not sure yet. Each version needs 50 picked-up calls');
    await page.locator('#ix-stop').click();
    const stop = await runLastJob(page);
    expect(stop.title).toBe('Stop the script test?');
    expect(backend.db.ix.log.filter((l) => l[0] === 'admin_end_script_test').pop()[1].p_winner).toBeNull();
    await expect(page.locator('#ix-test-last')).toContainText('Stopped without a winner.');
    expect(errors).toEqual([]);
  });

  test('script test without the Scripts add-on, at phone width in dark mode', async ({ page, backend }) => {
    backend.db.ix.features[env().institutes.a] = [];
    await page.setViewportSize({ width: 375, height: 740 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await adminSignIn(page);
    await mountCards(page, CAMPAIGN);
    await expect(page.locator('#ix-test-body')).toContainText('Script tests are part of Scripts, an extra (paid). Add Scripts to use this.');
    await expect(page.locator('#ix-brief-lines li')).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Dark mode: the brief turns into a soft panel, not the dark card.
    const bg = await page.locator('.ix-brief').evaluate((n) => getComputedStyle(n).backgroundColor);
    expect(bg).not.toBe('rgb(14, 22, 40)');
  });

  test('a caller practises a script: pretend lead, step timer, summary, nothing saved as a call', async ({ page, backend }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto('/practice.html');
    await expect(page.locator('.pr-banner')).toContainText('Nothing is dialled and nothing is saved as a call.');
    await page.locator('#gate-email').fill(env().users.rep3.email);
    await page.locator('#gate-password').fill(env().password);
    await expect(page.locator('#gate-submit')).toHaveText('Sign in');
    await page.locator('#gate-submit').click();

    await expect(page.locator('#pick')).toBeVisible();
    await expect(page.locator('#pick-list')).toContainText('E2E script (v1)');
    await expect(page.locator('#pick-list')).toContainText('E2E Admin asked you to practise this: "Slow down at the offer"');
    await page.getByRole('button', { name: 'Practise E2E script' }).click();

    await expect(page.locator('#walk')).toBeVisible();
    await expect(page.locator('#lead-name')).toHaveText('Priya Sharma');
    await expect(page.locator('#walk-say')).toContainText('E2E script: hello Priya Sharma, is this a good time?');
    await expect(page.locator('#walk-step')).toBeFocused();
    await expect(page.locator('#walk-back')).toBeDisabled();
    await expect(page.locator('#clock-step')).toHaveText(/^0:0\d$/);
    await page.waitForTimeout(1100);
    await expect(page.locator('#clock-total')).not.toHaveText('0:00');

    await page.locator('#walk-opts').getByRole('button', { name: 'Yes' }).click();
    await expect(page.locator('#walk-say')).toContainText('here is the offer');
    await page.locator('#walk-back').click();
    await expect(page.locator('#walk-say')).toContainText('hello Priya Sharma');
    await page.locator('#walk-opts').getByRole('button', { name: 'Yes' }).click();
    await page.locator('#walk-opts').getByRole('button', { name: 'Yes' }).click();
    await expect(page.locator('#walk-step')).toHaveText('Keen to join');
    await expect(page.locator('#walk-count')).toContainText('Last step');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.locator('#walk-finish').click();

    await expect(page.locator('#summary')).toBeVisible();
    await expect(page.locator('#summary-total')).toContainText('You finished "E2E script" in');
    await expect(page.locator('#summary-end')).toHaveText('The call ended at: Keen to join.');
    await expect(page.locator('#summary-body tr')).toHaveCount(3);
    await expect(page.locator('#summary-msg')).toHaveText('Saved. Your admin can see that you practised this.');
    const done = backend.db.ix.log.find((l) => l[0] === 'my_practice_done')[1];
    expect(done.p_assignment).toBe('a0000000-0000-4000-8000-0000000000p1');
    expect(done.p_seconds).toBeGreaterThanOrEqual(1);
    expect(backend.rowsFor(env().seats.rep3)).toEqual([]);
    expect(backend.db.log.some((l) => l.includes('call_outcomes'))).toBe(false);

    await page.locator('#summary-other').click();
    await expect(page.locator('#pick-list')).toContainText('Practised 1 time.');
    expect(errors).toEqual([]);
  });

  test('practice opens straight on a linked script, and says when the add-on is missing', async ({ page, backend }) => {
    await page.goto('/practice.html?script=' + env().scriptId);
    await page.locator('#gate-email').fill(env().users.rep3.email);
    await page.locator('#gate-password').fill(env().password);
    await page.locator('#gate-submit').click();
    await expect(page.locator('#walk')).toBeVisible();
    await page.locator('#walk-stop').click();
    await expect(page.locator('#pick')).toBeVisible();

    backend.db.ix.features[env().institutes.b] = [];
    await page.goto('/practice.html');
    await expect(page.locator('#addon')).toBeVisible();
    await expect(page.locator('#addon')).toContainText('Practice mode comes with the Scripts add-on');
  });
});
