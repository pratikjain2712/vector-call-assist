// A rep walks a call on the call guide and the result is uploaded under the right seat, with the loss reason
// and stage, and without the lead's name or number.
const { test, expect, env, uploadedRows, intoWorkspace } = require('./fixtures');

test('a lost call uploads its outcome, stage and loss reason, and no lead details', async ({ page, backend }) => {
  await intoWorkspace(page, 'rep1');
  await page.locator('#lead-name').fill('Asha Testlead');

  // Built-in script: right person, has time, agreed to talk, not seen the curriculum (no), student (no),
  // weak Python (no), will not do the Python lectures (no) -> not a fit.
  for (const k of ['yes', 'yes', 'yes', 'no', 'no', 'no', 'no']) await page.locator('#ans-' + k).click();
  await page.locator('#ans-next').click();
  await expect(page.locator('#stage')).toContainText('Not this time');

  // The upload happens as soon as the outcome is tapped.
  const first = (await uploadedRows(backend, env().seats.rep1, 1))[0];
  expect(first.outcome).toBe('not_interested');
  expect(first.script_step).toBe('end_lost');
  expect(first.stage_reached).toBe('Discovery');
  expect(first.institute_id).toBe(env().institutes.a);
  expect(first.loss_reason).toBeNull();

  // Picking a reason adds a correction row that points at the first one; the first row is not changed.
  await page.locator('#loss-price').click();
  const rows = await uploadedRows(backend, env().seats.rep1, 2);
  const correction = rows[rows.length - 1];
  expect(correction.loss_reason).toBe('price');
  expect(correction.corrects_id).toBe(first.id);

  // Lead names and numbers never leave the browser.
  expect(JSON.stringify(rows)).not.toContain('Asha');
});
