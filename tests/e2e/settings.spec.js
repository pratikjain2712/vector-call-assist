// Settings: the four text-size buttons change the page's text size and are remembered after a reload.
const { test, expect, intoWorkspace } = require('./fixtures');

test('the text size buttons resize the page and the choice is kept', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 1000 });
  await intoWorkspace(page, 'rep1');
  const rootPx = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const base = await rootPx();

  await page.locator('#settings-panel summary').click();
  const sizes = page.locator('#pref-size button');
  await expect(sizes).toHaveCount(4);
  await expect(page.locator('#pref-size [data-size="m"]')).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Extra large', exact: true }).click();
  await expect(page.locator('body')).toHaveClass(/text-xl/);
  expect(await rootPx()).toBeGreaterThan(base);
  await page.screenshot({ path: test.info().outputPath('extra-large.png') });

  await page.getByRole('button', { name: 'Small', exact: true }).click();
  expect(await rootPx()).toBeLessThan(base);

  await page.reload();
  await expect(page.locator('body')).toHaveClass(/text-s/);
  await expect(page.locator('#pref-size [data-size="s"]')).toHaveAttribute('aria-pressed', 'true');
});
