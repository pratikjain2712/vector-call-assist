// A rep walks a call on the call guide and the result is uploaded under the right seat, with the loss reason
// and stage, and without the lead's name or number.
const { test, expect, env, uploadedRows, intoWorkspace } = require('./fixtures');

test('a lost call uploads its outcome, stage and loss reason, and no lead details', async ({ page, backend }) => {
  await intoWorkspace(page, 'rep1');
  await page.locator('#lead-name').fill('Asha Testlead');
  await page.locator('#call-mode [data-mode="full"]').click();
  await expect(page.locator('#clock-aim')).toHaveText('aim 10 to 12 min');

  // Built-in script, full call: right person, has time, agreed to talk, not seen the curriculum (no), student (no),
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

test('the intro call is the default, books a full call, and the switch locks once a call starts', async ({ page, backend }) => {
  await intoWorkspace(page, 'rep1');
  await expect(page.locator('#call-mode [data-mode="intro"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#clock-aim')).toHaveText('aim 2 to 5 min');
  await expect(page.locator('#stage')).toContainText('Hello, am I speaking with');

  // Right person, has 2 minutes: the switch is locked mid-call.
  for (const k of ['yes', 'yes']) await page.locator('#ans-' + k).click();
  await expect(page.locator('#call-mode [data-mode="full"]')).toBeDisabled();
  // Works in IT, knows Python, sounds useful: each answer moves one stage on, through Timings to the Fee.
  for (const k of ['yes', 'yes', 'yes']) await page.locator('#ans-' + k).click();
  await expect(page.locator('#rail [aria-current="step"]')).toHaveText('Timings');
  await page.locator('#ans-yes').click();
  await expect(page.locator('#rail [aria-current="step"]')).toHaveText('Fee');
  // Wants to think about the fee, then gives a time for the full call.
  for (const k of ['maybe', 'yes']) await page.locator('#ans-' + k).click();
  await page.locator('#ans-next').click();
  await expect(page.locator('#stage')).toContainText('Follow-up booked');

  const [row] = await uploadedRows(backend, env().seats.rep1, 1);
  expect(row.outcome).toBe('interested');
  expect(row.script_step).toBe('end_followup');
});
