// Checks on the public home page (web/index.html): no inline script or style attributes (the page's CSP
// forbids them), every local file it links exists, the supabase-js pin matches the rep page, and the
// sign-in code uses only the calls the database provides.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, 'web', p), 'utf8');
const html = read('index.html');
const js = read(path.join('js', 'home.js'));
const app = read('app.html');

test('home page: no inline script blocks and no style attributes', () => {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.strictEqual(inline.length, 0, 'inline <script> found');
  assert.doesNotMatch(html, /\sstyle=/, 'style attribute found');
});

test('home page: local files it loads exist', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"#?:]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('data:'));
  const local = refs.filter((r) => !/^https?:/.test(r) && !r.startsWith('/'));
  for (const r of local) {
    assert.ok(fs.existsSync(path.join(root, 'web', r)), 'missing file: ' + r);
  }
  assert.ok(local.includes('js/home.js') && local.includes('css/home.css') && local.includes('js/config.js'));
});

test('home page: supabase-js pinned with the same URL and integrity hash as the rep page', () => {
  const pick = (s) => (s.match(/<script src="(https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]+)" integrity="([^"]+)"/) || []).slice(1).join(' ');
  assert.ok(pick(html), 'supabase-js script tag missing on home page');
  assert.strictEqual(pick(html), pick(app));
});

test('home page: links to the rep and admin pages point at files that exist', () => {
  assert.ok(html.includes('app.html') || js.includes('app.html'));
  assert.ok(js.includes("'admin.html'") && js.includes("'app.html'"));
  assert.ok(fs.existsSync(path.join(root, 'web', 'admin.html')));
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

test('home page: CSP on the page matches the rep page for scripts', () => {
  const csp = (s) => (s.match(/script-src ([^;]+);/) || [])[1];
  assert.strictEqual(csp(html), csp(app));
});

test('home page: the 3D scene is a module from a pinned three.js release, and sections set its mode', () => {
  const scene = read(path.join('js', 'scene.js'));
  const m = scene.match(/from 'https:\/\/cdn\.jsdelivr\.net\/npm\/three@(\d+\.\d+\.\d+)\//);
  assert.ok(m, 'three.js import must name an exact version on jsdelivr');
  assert.match(html, /<script type="module" src="js\/scene\.js">/);
  assert.match(html, /<canvas id="scene"/);
  for (const mode of ['hero', 'pair', 'seats']) assert.match(scene, new RegExp("\\b" + mode + ":\\s*\\{"));
  assert.match(html, /data-scene="seats"/);
});

test('home page: the calculator and the scene agree on the event name', () => {
  assert.match(js, /new CustomEvent\('vca:seats'/);
  assert.match(read(path.join('js', 'scene.js')), /addEventListener\('vca:seats'/);
});
