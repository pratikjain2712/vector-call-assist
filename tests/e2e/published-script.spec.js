// A rep in institute B, which has a published script, walks that script instead of the built-in one,
// and the uploaded call records the script id and version.
const { test, expect, env, uploadedRows, intoWorkspace } = require('./fixtures');

test('the published script drives the call and the call records its id and version', async ({ page, backend }) => {
  await intoWorkspace(page, 'rep3');

  await expect(page.locator('#stage')).toContainText('E2E script: hello');
  await page.locator('#ans-yes').click();
  await expect(page.locator('#stage')).toContainText('E2E script: here is the offer.');
  await page.locator('#ans-yes').click();
  await expect(page.locator('#stage')).toContainText('Keen to join');

  const row = (await uploadedRows(backend, env().seats.rep3, 1))[0];
  expect(row.script_id).toBe(env().scriptId);
  expect(row.script_version).toBe(1);
  expect(row.script_step).toBe('keen');
  expect(row.institute_id).toBe(env().institutes.b);
});
