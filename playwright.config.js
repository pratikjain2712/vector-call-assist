// End-to-end tests (tests/e2e) against the LOCAL Supabase stack only (`npx supabase start`).
// The site is served from web/ on 127.0.0.1:8123; tests/e2e/fixtures.js points it at the local stack.
// Never run these against the live project: global-setup deletes and recreates its test data.
const { defineConfig, devices } = require('@playwright/test');

// PW_PORT lets two checkouts run their tests at the same time without sharing a server.
const PORT = process.env.PW_PORT || '8123';

module.exports = defineConfig({
  testDir: 'tests/e2e',
  globalSetup: require.resolve('./tests/e2e/global-setup.js'),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // list: results in the terminal. html: playwright-report/index.html (open with npx playwright show-report).
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    // Kept for every test, pass or fail, and shown in the HTML report: a step-by-step trace,
    // a screenshot at the end of each test, and a video of the whole test.
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
  webServer: {
    command: `python -m http.server ${PORT} --bind 127.0.0.1 --directory web`,
    url: `http://127.0.0.1:${PORT}/app.html`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
