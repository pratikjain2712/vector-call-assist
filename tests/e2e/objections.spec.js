// The worry list answers course questions (Gen-AI, Azure, cloud) and Back returns to the script step.
const { test, expect, intoWorkspace } = require('./fixtures');

test('course questions in the worry list show their answer, and Back returns to the call', async ({ page }) => {
  await intoWorkspace(page, 'rep1');
  const worries = page.locator('#chips-worry');
  for (const chip of ['What is Gen-AI?', 'Do you teach Azure?', 'What do you cover in cloud?']) {
    await expect(worries.getByRole('button', { name: chip, exact: true })).toBeVisible();
  }

  await worries.getByRole('button', { name: 'Do you teach Azure?', exact: true }).click();
  await expect(page.locator('#stage')).toContainText('Everyone learns both AWS Bedrock and Azure AI');
  await page.locator('#back').click();
  await expect(page.locator('#stage')).toContainText('Hello, am I speaking with');
});
