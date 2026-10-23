// The Insights tab (js/admin/insights.js): forecast with "What closes the gap", What-if and Apply plan, best
// time to call with Set call hours, where calls end, promises, coaching notes, money hidden, the Scripts add-on,
// charts as tables, phone width and dark mode. Runs on the fake backend only (tests/e2e/fake-insights.js has
// the campaign data); the SQL itself is tested in supabase/tests/insights_test.sql.
const { test, expect, env, isFake } = require('./fixtures');

async function openInsights(page) {
  await page.goto('/admin.html#insights');
  await page.locator('#gate-email').fill(env().users.admin.email);
  await page.locator('#gate-password').fill(env().password);
  await page.locator('#gate-submit').click();
  await expect(page.locator('#tab-link-insights')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#ins-forecast .ins-big')).toBeVisible();
}

test.beforeEach(() => { test.skip(!isFake(), 'Insights e2e runs on the fake backend (campaign data is canned there)'); });

test('forecast, what-if, apply plan, call hours and a coaching note', async ({ page, backend }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openInsights(page);

  // Forecast in ₹ with the reported-by-caller label, a chart and the gap list.
  await expect(page.locator('#ins-forecast-title')).toContainText('Forecast: fees collected by');
  await expect(page.locator('#ins-forecast')).toContainText('reported by caller');
  await expect(page.locator('#ins-forecast .ins-big')).toContainText('₹');
  await expect(page.locator('#ins-forecast svg.chart-svg')).toBeVisible();
  await expect(page.locator('#ins-forecast .ins-gap')).toContainText('Short by');
  await expect(page.locator('#ins-forecast .ins-gap-list li')).not.toHaveCount(0);

  // Show as table, and back.
  const toggle = page.locator('#ins-forecast .chart-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#ins-forecast .chart-table table')).toBeVisible();
  await expect(page.locator('#ins-forecast svg.chart-svg')).toBeHidden();
  await toggle.click();
  await expect(page.locator('#ins-forecast svg.chart-svg')).toBeVisible();

  // Keyboard on the chart shows a tooltip.
  await page.locator('#ins-forecast svg.chart-svg').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#ins-forecast .chart-tip')).toBeVisible();

  // What-if: one more caller changes the new forecast.
  const result = page.locator('#ins-wi-result');
  const before = await result.textContent();
  await page.locator('#ins-wi-callers').fill('3');
  await expect(result).not.toHaveText(before);
  await expect(page.locator('#ins-whatif output[for="ins-wi-callers"]')).toHaveText('2 → 3');
  await expect(result).toContainText(/Reaches target on|Does not reach the target/);

  // Apply plan saves callers, the daily target and (evening share raised) call hours.
  await page.locator('#ins-wi-evening').fill('80');
  await page.locator('#ins-apply').click();
  await expect(page.locator('#confirm')).toBeVisible();
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toContainText('Plan applied');
  const planWrite = backend.insights.writes.find((w) => w.what === 'plan');
  expect(planWrite.args.p_callers).toBe(3);
  expect(planWrite.args.p_daily_target).toBe(3 * planWrite.args.p_calls_per_caller);
  expect(planWrite.args.p_call_hours.days.mon).toEqual([19, 20]);

  // Best time to call: heatmap with values in the cells, then Set call hours.
  await expect(page.locator('#ins-besttime .heat-cell').first()).toBeVisible();
  await expect(page.locator('#ins-besttime')).toContainText('Most people pick up on');
  await page.locator('#ins-set-hours').click();
  await page.locator('#confirm-go').click();
  await expect(page.locator('#status')).toContainText('Call hours saved');
  expect(backend.insights.writes.some((w) => w.what === 'call_hours' && w.args.p_call_hours.days.sat)).toBe(true);

  // Where calls end and promises.
  await expect(page.locator('#ins-ends')).toContainText('Fees');
  await expect(page.locator('#ins-ends')).toContainText('40%');
  await expect(page.locator('#ins-promises')).toContainText('1–3 days');

  // Coaching: Rep 2 skips the Questions step; add a note. Practice mode is not installed, so no button.
  const tip = page.locator('#ins-coaching .ins-tip', { hasText: 'Rep 2 skips the Questions step' });
  await expect(tip).toBeVisible();
  await expect(page.locator('#ins-coaching')).not.toContainText('practice mode');
  await tip.getByRole('button', { name: 'Add a note for Rep' }).click();
  await tip.getByRole('button', { name: 'Save note' }).click();
  await expect(page.locator('#status')).toContainText('Note saved for Rep 2');
  expect(backend.insights.writes.find((w) => w.what === 'note').args.p_seat).toBe(env().seats.rep2);

  // Compare with an earlier campaign.
  await page.locator('#ins-compare').selectOption({ label: 'Sept fees – Class 9' });
  await expect(page.locator('#ins-compare-out')).toContainText('Sept fees – Class 9');

  // The other agent's cards: the containers exist (empty without insights-extra.js).
  await expect(page.locator('#insights-brief')).toHaveCount(1);
  await expect(page.locator('#insights-abtest')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('money hidden: counts only, no ₹ anywhere on Insights', async ({ page, backend }) => {
  backend.insights.state.money = false;
  await openInsights(page);
  await expect(page.locator('#ins-forecast-title')).toContainText('Forecast: payments by');
  await expect(page.locator('#ins-forecast')).toContainText('Money is hidden');
  await expect(page.locator('#ins-coaching .bar-row').first()).toBeVisible();
  expect(await page.locator('#tab-insights').innerText()).not.toContain('₹');
});

test('without the Scripts add-on, script cards ask for it', async ({ page, backend }) => {
  backend.insights.state.features = [];
  await openInsights(page);
  await expect(page.locator('#ins-ends')).toContainText('Add Scripts to use this');
  await expect(page.locator('#ins-coaching')).toContainText('Add Scripts to use this');
  await expect(page.locator('#ins-coaching .bar-row').first()).toBeVisible();
});

test('Insights fits a phone and works in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 375, height: 800 });
  await openInsights(page);
  await expect(page.locator('#ins-coaching .bar-row').first()).toBeVisible();
  await expect(page.locator('#ins-besttime .heat-cell').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const bg = await page.locator('#ins-forecast').evaluate((n) => getComputedStyle(n).backgroundColor);
  expect(bg).toBe('rgb(23, 29, 43)');
});

// Integration: the Insights tab itself mounts the weekly brief and the script test (js/admin/insights-extra.js)
// on its picked campaign; the script test follows the tab's campaign picker and shows no picker of its own.
test('the tab shows the weekly brief and the script test of the picked campaign', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openInsights(page);
  await expect(page.locator('#insights-brief #ix-brief-title')).toHaveText('This week in 4 lines');
  await expect(page.locator('#insights-brief #ix-brief-lines li')).toHaveCount(4);
  await expect(page.locator('#insights-abtest #ix-test-title')).toHaveText('Script test');
  await expect(page.locator('#insights-abtest #ix-test-campaign')).toHaveCount(0);
  expect(errors).toEqual([]);
});
