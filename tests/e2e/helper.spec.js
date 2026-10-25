// The helper column follows the step the call has reached, answers open in place, and / searches every answer.
const { test, expect, env, isFake, intoWorkspace } = require('./fixtures');

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

// A campaign or published script brings its own pushback answers ({label, answer}); the column searches those.
const FEES_SCRIPT = [
  { id: 'hello', start: true, stage: 0, say: ['Namaste, am I speaking with {name}?'], opts: [{ label: 'Yes', to: 'fee' }, { label: 'No', to: 'bye' }] },
  { id: 'fee', title: 'The fee', stage: 4, say: ['The fee is due on 31 October. When can you pay it?'], tip: 'Ask for a date, not a yes.', opts: [{ label: 'Gave a date', to: 'bye' }] },
  { id: 'bye', title: 'Thank them' },
];
const FEES_PUSHBACKS = [
  { label: 'Who is calling?', answer: 'This is {me} from the school office, about the Class 10 fees.' },
  { label: 'Can I pay late?', answer: 'You can pay by 10 November without a late fine. After that the school adds ₹200.' },
  { label: 'Can I pay in parts?', answer: 'Yes, half now and half by 30 November. I will note it.' },
];

test('campaign script: / searches its pushback answers, Enter opens the top one, and the column fits beside the call', async ({ page, backend }) => {
  test.skip(!isFake(), 'campaign data is set up in the fake backend only');
  await page.setViewportSize({ width: 1600, height: 1000 });
  const seat = env().seats.rep2;
  backend.db.features = ['scripts'];
  backend.db.callerScripts.s1 = { id: 's1', version: 2, steps: FEES_SCRIPT, pushbacks: FEES_PUSHBACKS };
  backend.addCampaign({ name: 'Oct fees', type_key: 'fees', type_label: 'Fees collection', script_id: 's1', members: [seat],
    results: [{ key: 'paid', label: 'Paid', needs_date: false, needs_amount: false, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: true, common: false }],
    leads: [{ name: 'Sunita Sharma', phone: '+919876543210', amount_due: 18000, assigned_seat_id: seat }] });
  await intoWorkspace(page, 'rep2');

  await expect(page.locator('#stage')).toContainText('Namaste, am I speaking with');
  const help = page.locator('#help-col');
  await expect(help).toBeVisible();
  await expect(help.locator('#help-title')).toHaveText('They may ask now');
  await expect(help.getByRole('button', { name: 'Who is calling?' })).toBeVisible();
  // 1400px and wider: waiting leads | lead card and script | helper column, side by side, no sideways scroll.
  const [queue, main, col] = await Promise.all(['#queue-panel', '.workmain', '#help-col'].map((s) => page.locator(s).boundingBox()));
  expect(queue.x + queue.width).toBeLessThanOrEqual(main.x);
  expect(main.x + main.width).toBeLessThanOrEqual(col.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // At the fee step the fee answers come first.
  await page.locator('#ans-yes').click();
  await expect(page.locator('#stage')).toContainText('The fee is due on 31 October');
  await expect(help.locator('.help-q').first()).toHaveText(/Can I pay/);

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(page.locator('#help-search')).toBeFocused();
  await page.keyboard.type('late');
  await expect(help.locator('#help-title')).toHaveText('Answers for “late”');
  await expect(help.locator('.help-q').first()).toHaveText('Can I pay late?');
  await page.keyboard.press('Enter');
  await expect(help).toContainText('without a late fine');
  await page.screenshot({ path: test.info().outputPath('campaign-search.png') });
  // The step's tip is searchable too, as a hint.
  await page.locator('#help-search').fill('date');
  await expect(help.getByRole('button', { name: 'Tip: The fee' })).toBeVisible();
  await page.locator('#help-search').press('Escape');
  await expect(help.locator('#help-title')).toHaveText('They may ask now');

  // Narrower: the column moves under the lead card and still fits.
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(help).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('campaign-1200.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(help).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('published script in sheet mode: the column shows its pushbacks and / search opens one', async ({ page, backend }) => {
  test.skip(!isFake(), 'the pushbacks are set up in the fake backend only');
  await page.setViewportSize({ width: 1600, height: 1000 });
  backend.db.publishedPushbacks = [
    { label: 'Is there an offer?', answer: 'Yes, E2E offer: 10% off this week.' },
    { label: 'Is it a good time?', answer: 'It takes two minutes, I promise.' },
  ];
  await intoWorkspace(page, 'rep3');
  await expect(page.locator('#stage')).toContainText('E2E script: hello');
  const help = page.locator('#help-col');
  await expect(help).toBeVisible();
  await expect(page.locator('#obj-section')).toBeHidden();
  // The step asks if this is a good time, so that answer comes first.
  await expect(help.locator('.help-q').first()).toHaveText('Is it a good time?');
  const [col, main] = await Promise.all(['#help-col', '.workmain'].map((s) => page.locator(s).boundingBox()));
  expect(col.x + col.width).toBeLessThanOrEqual(main.x);

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+k');
  await expect(page.locator('#help-search')).toBeFocused();
  await page.keyboard.type('discount');
  await expect(help.locator('.help-q').first()).toHaveText('Is there an offer?');
  await page.keyboard.press('Enter');
  await expect(help).toContainText('10% off this week');
  await page.screenshot({ path: test.info().outputPath('published-search.png') });
  // Arrow down moves to the question buttons; Esc goes back to the search.
  await page.keyboard.press('ArrowDown');
  await expect(help.locator('.help-q').first()).toBeFocused();
});
