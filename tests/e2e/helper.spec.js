// The helper column follows the step the call has reached, answers open in place, and / searches every answer.
const { test, expect, intoWorkspace } = require('./fixtures');

test('helper questions follow the call, open in place, and / search finds any answer', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await intoWorkspace(page, 'rep1');
  const help = page.locator('#help-col');
  await expect(help.locator('#help-title')).toHaveText('They may ask now');
  await expect(help.getByRole('button', { name: 'What is Vector 2.0?' })).toBeVisible();

  // Intro call: right person, has 2 minutes, works in IT, knows Python, interested -> Timings.
  for (const k of ['yes', 'yes', 'yes', 'yes', 'yes']) await page.locator('#ans-' + k).click();
  await expect(page.locator('#rail [aria-current="step"]')).toHaveText('Timings');
  const rec = help.getByRole('button', { name: 'When will I get the recording?' });
  await expect(rec).toBeVisible();

  // The answer opens under the question; the call card stays on the same step.
  await rec.click();
  await expect(help).toContainText('Within 24 hours of each class');
  await expect(page.locator('#stage')).toContainText('Now, the timings');

  // / jumps to the search; typing "emi" finds the answer and lights up matching buttons.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(page.locator('#help-search')).toBeFocused();
  await page.keyboard.type('emi');
  await expect(help.locator('#help-title')).toHaveText('Answers for “emi”');
  await expect(help.getByRole('button', { name: 'Is there an EMI?' })).toBeVisible();
  await expect(page.locator('#chips-worry').getByRole('button', { name: 'Can I pay in instalments?' })).toHaveClass(/match/);
  await page.keyboard.press('Enter');
  await expect(help).toContainText('you can pay in two parts');
  await page.screenshot({ path: test.info().outputPath('search.png') });

  // Esc clears the search and the column shows this step's questions again.
  await page.locator('#help-search').focus();
  await page.keyboard.press('Escape');
  await expect(help.locator('#help-title')).toHaveText('They may ask now');
  await expect(rec).toBeVisible();
  // Typing 1 in the search box types a 1; it does not answer the script.
  await page.keyboard.press('/');
  await page.keyboard.type('1');
  await expect(page.locator('#rail [aria-current="step"]')).toHaveText('Timings');
});
