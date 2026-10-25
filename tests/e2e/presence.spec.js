// "Callers right now" on the admin Home tab follows the caller's real call (js/presence.js, report_presence with
// the call state, 20261025190000_presence_call_state.sql): "On a call · m:ss" while the paired phone dials or
// the line is in use, "Wrap-up" after it hangs up until the result is saved, then "Ready"; "On a call
// (unconfirmed)" when no phone is paired and only the page says a call is going on.
// Fake backend only ("// presence" block of tests/e2e/fake-backend.js). The phone is a stand-in inside the page
// (PhoneLink.request answers ping, dial, status, result and hangup from window.__phone); no phone is contacted.
const { test, expect, env, isFake, intoWorkspace, pointAtTestStack } = require('./fixtures');

test.beforeEach(() => { test.skip(!isFake(), 'presence is worked out by the fake backend'); });

const RESULTS = [
  { key: 'paid', label: 'Paid', needs_date: false, needs_amount: true, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: true, common: false },
  { key: 'no_answer', label: 'No answer', needs_date: false, needs_amount: false, needs_reason: false, needs_rating: false, reason_choices: null, counts_as_good: false, common: true },
];
const SCRIPT = [
  { id: 'hello', start: true, stage: 0, say: ['Namaste, am I speaking with {name}?'], opts: [{ label: 'Yes', to: 'fee' }, { label: 'No', to: 'bye' }] },
  { id: 'fee', stage: 4, say: ['The fee is due on 31 October.'], opts: [{ label: 'Gave a date', to: 'bye' }] },
  { id: 'bye', title: 'Thank them' },
];

function campaign(backend) {
  const seat = env().seats.rep2;
  backend.db.features = ['scripts'];
  backend.db.callerScripts.s1 = { id: 's1', version: 1, steps: SCRIPT };
  backend.addCampaign({
    name: 'Presence fees', type_key: 'fees', type_label: 'Fees collection', script_id: 's1', daily_target: 20,
    members: [seat], results: RESULTS,
    leads: [{ name: 'Sunita Sharma', phone: '+919876543210', amount_due: 18000, assigned_seat_id: seat }],
  });
}

/* A phone stand-in: PhoneLink.request is answered in the page. The test moves the call on with setPhone(). */
async function standInPhone(page) {
  await page.addInitScript(() => {
    window.__phone = { phase: 'IDLE', session: 'e2e-presence-1', offhookWallMs: 0, endWallMs: 0 };
    let real;
    Object.defineProperty(window, 'PhoneLink', {
      configurable: true,
      get: () => real,
      set: (v) => {
        real = v;
        v.request = async (op) => {
          const P = window.__phone;
          if (op === 'dial') { P.phase = 'REQUESTED'; return { ok: true, session: P.session, dialWallMs: Date.now() }; }
          if (op === 'status') return { found: true, phase: P.phase, offhookWallMs: P.offhookWallMs, endWallMs: P.endWallMs };
          if (op === 'result') return { pending: false, answered: true, connectedSeconds: 70 };
          if (op === 'hangup') { P.phase = 'ENDED'; P.endWallMs = Date.now(); return { ok: true }; }
          return { ok: true };
        };
      },
    });
  });
}
const setPhone = (page, patch) => page.evaluate((p) => Object.assign(window.__phone, p), patch);

async function adminHome(browser, backend) {
  const ctx = await browser.newContext();
  const admin = await ctx.newPage();
  await pointAtTestStack(admin, backend);
  await admin.goto('/admin.html');
  await admin.locator('#gate-email').fill(env().users.admin.email);
  await admin.locator('#gate-password').fill(env().password);
  await admin.locator('#gate-submit').click();
  await expect(admin.locator('#app')).toBeVisible();
  await expect(admin.locator('#home-callers-body')).toContainText('Rep 2');
  return { admin, ctx };
}

const lastState = (backend) => {
  const seat = env().seats.rep2;
  const mine = backend.db.presenceReports.filter((r) => r.seat_id === seat);
  return mine.length ? mine[mine.length - 1].call_state : null;
};

test('Home follows the phone: on a call with its time, wrap-up after hanging up, ready after the save', async ({ page, backend, browser }) => {
  campaign(backend);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await standInPhone(page);
  await intoWorkspace(page, 'rep2');
  await expect(page.locator('#camp-lead')).toContainText('Sunita Sharma');
  const { admin, ctx } = await adminHome(browser, backend);
  const status = admin.locator('#home-callers-body tr', { hasText: 'Rep 2' }).locator('.home-status');

  // Dial through the phone: reported at once as dialling.
  await expect(page.locator('#call-laptop')).toBeEnabled();
  await page.locator('#call-laptop').click();
  await expect.poll(() => lastState(backend)).toBe('dialling');

  // The lead picks up (the line went into use 65 seconds ago): "On a call · 1:05", and Home ticks it on.
  await setPhone(page, { phase: 'OFFHOOK', offhookWallMs: Date.now() - 65000 });
  await expect.poll(() => lastState(backend)).toBe('connected');
  await admin.locator('#home-refresh').click();
  await expect(status).toHaveText(/^On a call · 1:0\d$/);
  const first = await status.textContent();
  await expect(status).not.toHaveText(first, { timeout: 4000 });   // the timer runs between refreshes
  await expect(status).toHaveText(/^On a call · 1:\d\d$/);

  // Hang up: wrap-up while the result is being saved.
  await setPhone(page, { phase: 'ENDED', endWallMs: Date.now() });
  await expect.poll(() => lastState(backend)).toBe('wrapup');
  await admin.locator('#home-refresh').click();
  await expect(status).toHaveText(/^Wrap-up · 0:0\d$/);

  // Save the result: ready.
  await page.locator('#res-no_answer').click();
  await page.locator('#res-save').click();
  await expect.poll(() => lastState(backend)).toBe('none');
  await admin.locator('#home-refresh').click();
  await expect(status).toHaveText('Ready');

  // Every change was reported, in order, and at most one report per 2 seconds (from the dial on: the reload
  // in intoWorkspace opens the page twice, and each page reports once when it opens).
  const mine = backend.db.presenceReports.filter((r) => r.seat_id === env().seats.rep2);
  const fromDial = mine.slice(mine.findIndex((r) => r.call_state === 'dialling'));
  expect(fromDial.map((r) => r.call_state).filter((s, i, a) => s !== a[i - 1])).toEqual(['dialling', 'connected', 'wrapup', 'none']);
  fromDial.slice(1).forEach((r, i) => expect(r.at - fromDial[i].at).toBeGreaterThanOrEqual(1800));
  expect(errors).toEqual([]);
  await ctx.close();
});

test('no phone paired: a call the page starts shows as unconfirmed', async ({ page, backend, browser }) => {
  campaign(backend);
  await standInPhone(page);
  await intoWorkspace(page, 'rep2');
  await expect(page.locator('#camp-lead')).toContainText('Sunita Sharma');
  // The phone is not paired (forgotten after the page opened); the call starts with the first answer on the
  // script, as "Call on this device" does on a phone.
  await page.evaluate(() => { window.PhoneLink.isPaired = () => false; });
  await page.locator('#ans-yes').click();
  await expect.poll(() => lastState(backend)).toBe('unconfirmed');
  const report = backend.db.presenceReports.filter((r) => r.seat_id === env().seats.rep2).pop();
  expect(report.phone_ok).toBe(true);
  const { admin, ctx } = await adminHome(browser, backend);
  await expect(admin.locator('#home-callers-body tr', { hasText: 'Rep 2' }).locator('.home-status')).toHaveText(/^On a call \(unconfirmed\) · 0:\d\d$/);
  // The Callers tab says the same in words.
  await admin.goto('/admin.html#callers');
  await expect(admin.locator('#tab-callers')).toContainText('On a call (unconfirmed)');
  await ctx.close();
});
