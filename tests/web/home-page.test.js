// Checks on the public home page (web/index.html): no inline script or style attributes (the page's CSP
// forbids them), every local file it loads exists, the supabase-js pin matches the rep page, the sign-in code
// calls only the database functions from the trial migration, and the 3D scripts are pinned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, 'web', p), 'utf8');
const html = read('index.html');
const js = read(path.join('js', 'home.js'));
const scene = read(path.join('js', 'scene.js'));
const app = read('app.html');

test('home page: no inline script blocks and no style attributes', () => {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.strictEqual(inline.length, 0, 'inline <script> found');
  assert.doesNotMatch(html, /\sstyle=/, 'style attribute found');
});

test('home page: local files it loads exist', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"#?:]+)"/g)].map((m) => m[1]);
  const local = refs.filter((r) => !/^https?:/.test(r) && !r.startsWith('/') && !r.startsWith('data:'));
  for (const r of local) assert.ok(fs.existsSync(path.join(root, 'web', r)), 'missing file: ' + r);
  assert.ok(local.includes('js/home.js') && local.includes('css/home.css') && local.includes('js/config.js') && local.includes('js/scene.js'));
});

test('home page: supabase-js pinned with the same URL and integrity hash as the rep page', () => {
  const pick = (s) => (s.match(/<script src="(https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]+)" integrity="([^"]+)"/) || []).slice(1).join(' ');
  assert.ok(pick(html), 'supabase-js script tag missing on home page');
  assert.strictEqual(pick(html), pick(app));
});

test('home page: CSP for scripts matches the rep page', () => {
  const csp = (s) => (s.match(/script-src ([^;]+);/) || [])[1];
  assert.strictEqual(csp(html), csp(app));
});

test('home page: sign-in uses the emailed link and only the database calls from the trial migration', () => {
  assert.match(js, /signInWithOtp/);
  assert.match(js, /shouldCreateUser: create/);
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /password/i, 'no password sign-in on the home page');
  const rpcs = [...js.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]);
  const allowed = ['my_trial_status', 'claim_my_invite', 'start_trial_institute'];
  assert.ok(rpcs.length > 0);
  for (const r of rpcs) assert.ok(allowed.includes(r), 'unexpected rpc: ' + r);
});

test('home page: the 3D scripts use an exact three.js release and both canvases exist', () => {
  const m = scene.match(/from 'https:\/\/cdn\.jsdelivr\.net\/npm\/three@(\d+\.\d+\.\d+)\//);
  assert.ok(m, 'three.js import must name an exact version on jsdelivr');
  assert.match(html, /<script type="module" src="js\/scene\.js">/);
  assert.match(html, /<canvas id="heroScene"/);
  assert.match(html, /<canvas id="seatScene"/);
  assert.match(html, /<div class="fallback"/, 'static fallback for the hero must stay in the page');
});

test('home page: calculator and seat scene share the vca:seats event; seat label exists', () => {
  assert.match(js, /new CustomEvent\('vca:seats'/);
  assert.match(scene, /addEventListener\('vca:seats'/);
  assert.match(html, /id="seatLabel"/);
});

test('home page: product tabs and timeline wire to elements that exist', () => {
  for (const id of ['pt-phone', 'pp-phone', 'pt-laptop', 'pp-laptop', 'pt-admin', 'pp-admin', 'timeline']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing id ' + id);
  }
  assert.match(js, /getElementById\('timeline'\)|\$\('timeline'\)/);
});
