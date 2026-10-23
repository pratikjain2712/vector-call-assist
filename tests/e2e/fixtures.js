// Shared helpers for the e2e tests. Each page is pointed at the test backend (see global-setup.js):
// - js/config.js is replaced with the test URL and anon key (the real config.js is not touched);
// - the page's Content-Security-Policy connect-src also allows that origin, which is plain http on 127.0.0.1
//   (production allows only https://*.supabase.co);
// - in "fake" mode, requests to that origin are answered by tests/e2e/fake-backend.js.
const fs = require('node:fs');
const path = require('node:path');
const base = require('@playwright/test');
const { createFakeBackend } = require('./fake-backend');

// Read lazily: global-setup writes this file, and test files may be loaded before it runs.
let cached = null;
function env() {
  if (!cached) cached = JSON.parse(fs.readFileSync(path.join(__dirname, '.local-env.json'), 'utf8'));
  return cached;
}
const isFake = () => env().mode === 'fake';

async function pointAtTestStack(page, backend) {
  const ENV = env();
  const API_ORIGIN = new URL(ENV.url).origin;
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(API_ORIGIN)) throw new Error('e2e tests run against a local backend only');
  // Routes run newest first: the catch-all is added first so that the later, more specific routes win.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const res = await route.fetch();
    const body = (await res.text()).replace("connect-src 'self'", "connect-src 'self' " + API_ORIGIN);
    return route.fulfill({ response: res, body });
  });
  await page.route('**/js/config.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.VECTOR_CONFIG = ' + JSON.stringify({ supabaseUrl: ENV.url, supabaseAnonKey: ENV.anon }) + ';',
  }));
  // CDN libraries from node_modules instead of the network: same versions and files, so the pages'
  // integrity hashes still match, and the tests do not depend on the CDNs being reachable.
  const CDN = {
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js': '@supabase/supabase-js/dist/umd/supabase.js',
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js': 'jsqr/dist/jsQR.js',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js': 'xlsx/dist/xlsx.full.min.js',
    // Phase A: campaigns. The admin Campaigns tab loads the same file from jsDelivr (the admin page's CSP).
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js': 'xlsx/dist/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js': 'three/build/three.module.js',
  };
  for (const [url, file] of Object.entries(CDN)) {
    await page.route(url, (route) => route.fulfill({
      contentType: 'application/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: fs.readFileSync(path.join(__dirname, '..', '..', 'node_modules', file)),   // three's package exports hide build/
    }));
  }
  if (backend) await backend.attach(page, API_ORIGIN);
  // First-run walkthrough off; nothing else is preset.
  await page.addInitScript(() => { try { localStorage.setItem('vca2-onboarded', '1'); } catch (e) {} });
}

/* Pretends a phone was paired: a link key in the vault and a phone address. No phone is contacted. */
async function fakePairing(page) {
  await page.evaluate(async () => {
    await Vault.ready;
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    await Vault.set('link-key', key);
    localStorage.setItem('vca2-link', JSON.stringify({ host: '192.0.2.10:8765' }));
  });
}

/* Clients for the local stack (local mode only): service role, and signed in as a test user. */
function adminDb() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(env().url, env().service, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function userDb(who) {
  const { createClient } = require('@supabase/supabase-js');
  const c = createClient(env().url, env().anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: env().users[who].email, password: env().password });
  if (error) throw new Error('sign in ' + who + ': ' + error.message);
  return c;
}

/* The uploaded rows for one seat, oldest first, waiting until there are at least n. Works in both modes. */
async function uploadedRows(backend, seatId, n) {
  for (let i = 0; i < 40; i++) {
    let rows;
    if (backend) rows = backend.rowsFor(seatId);
    else {
      const { data, error } = await adminDb().from('call_outcomes').select('*').eq('seat_id', seatId).order('uploaded_at');
      if (error) throw error;
      rows = data;
    }
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('expected ' + n + ' uploaded rows for seat ' + seatId);
}

/* Signs in on app.html with email and password and waits until the sign-in screen is gone. */
async function signInOnApp(page, who, password) {
  await page.goto('/app.html');
  await page.locator('#signin-email').fill(env().users[who].email);
  await page.locator('#signin-password').fill(password || env().password);
  await base.expect(page.locator('#signin-send')).toHaveText('Sign in');
  await page.locator('#signin-send').click();
  await base.expect(page.locator('#signin')).toBeHidden();
}

/* Sign in, pretend a phone is paired, open the workspace and accept the terms if asked. */
async function intoWorkspace(page, who) {
  await signInOnApp(page, who);
  await fakePairing(page);
  await page.reload();
  await base.expect(page.locator('#app')).toBeVisible();
  const terms = page.locator('#terms-panel');
  await page.waitForTimeout(500);
  if (await terms.isVisible()) {
    await page.locator('#terms-accept').click();
    await base.expect(terms).toBeHidden();
  }
}

const test = base.test.extend({
  backend: async ({}, use) => { await use(isFake() ? createFakeBackend(env()) : null); },
  page: async ({ page, backend }, use) => { await pointAtTestStack(page, backend); await use(page); },
});

module.exports = { test, expect: base.expect, env, isFake, fakePairing, adminDb, userDb, uploadedRows, signInOnApp, intoWorkspace };
