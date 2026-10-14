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

test('home page: trial uses the emailed link; password sign-in is for existing accounts only', () => {
  assert.match(js, /signInWithOtp/);
  assert.match(js, /shouldCreateUser: create/);
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(code, /signInWithPassword/, 'existing accounts can sign in with a password');
  assert.match(code, /if \(!create && password\)/, 'the password path never runs for the trial form');
  assert.doesNotMatch(code, /auth\.signUp/, 'the home page never creates an account with a password');
  const rpcs = [...js.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]);
  const allowed = ['my_trial_status', 'claim_my_invite', 'start_trial_institute'];
  assert.ok(rpcs.length > 0);
  for (const r of rpcs) assert.ok(allowed.includes(r), 'unexpected rpc: ' + r);
});

test('home page: the 3D scripts use an exact three.js release and both canvases exist', () => {
  const m = scene.match(/cdn\.jsdelivr\.net\/npm\/three@(\d+\.\d+\.\d+)\//);
  assert.ok(m, 'three.js import must name an exact version on jsdelivr');
  assert.match(scene, /WIDE \? await import\(/, 'three.js loads only on wide screens');
  assert.match(html, /<script type="module" src="js\/scene\.js">/);
  assert.match(html, /<canvas id="heroScene"/);
  assert.match(html, /<canvas id="seatScene"/);
  assert.match(html, /<canvas id="demoScene"/);
  // Without 3D the hero card still shows what the lead said and the answer, as plain HTML.
  assert.match(html, /id="saidChips"/, 'the objection chips must stay in the page');
  assert.match(html, /id="answerText"/, 'the answer must stay in the page as text');
});

test('home page: the calculator owns the seat label, so it updates without 3D', () => {
  // The label once lived in scene.js only, which phones never load, so it stayed at its placeholder.
  assert.match(js, /\$\('seatLabel'\)\.textContent = plural\(n\)/, 'home.js must write the seat label');
  assert.doesNotMatch(scene, /seatLabel/, 'scene.js must not write the seat label');
  assert.match(html, /id="seatLabel"[^>]*>5 seats · Business</, 'placeholder matches the default of 5 seats');
  for (const b of ['Starter', 'Team', 'Business']) assert.match(html, new RegExp('data-bundle="' + b + '"'), 'plan ' + b);
});

test('home page: the seat grid shows only when 3D runs', () => {
  const css = read(path.join('css', 'home.css'));
  assert.match(css, /#seatScene \{[^}]*display: none;/);
  assert.match(css, /\.has-3d #seatScene \{ display: block; \}/);
});

test('home page: the call blueprint is built with DOM calls, not HTML strings', () => {
  assert.match(html, /id="lossBlueprint"/);
  assert.match(js, /createElementNS\(NS, tag\)/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('home page: calculator and seat scene share the vca:seats event; seat label exists', () => {
  assert.match(js, /new CustomEvent\('vca:seats'/);
  assert.match(scene, /addEventListener\('vca:seats'/);
  assert.match(html, /id="seatLabel"/);
});

test('home page: hero chips, menu button, demo phone and timeline wire to elements that exist', () => {
  for (const id of ['saidChips', 'answerText', 'navCta', 'demoScene', 'dialBtn', 'hangBtn', 'timeline']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing id ' + id);
  }
  assert.match(js, /getElementById\('timeline'\)|\$\('timeline'\)/);
  // The hero and the 3D scenes talk through these events; both sides must use the same names.
  for (const ev of ['vca:objection', 'vca:demo']) {
    assert.match(js, new RegExp("CustomEvent\\('" + ev + "'"), 'home.js never sends ' + ev);
    assert.match(scene, new RegExp("addEventListener\\('" + ev + "'"), 'scene.js never listens for ' + ev);
  }
  for (const ev of ['vca:pick', 'vca:grab']) {
    assert.match(scene, new RegExp("CustomEvent\\('" + ev + "'"), 'scene.js never sends ' + ev);
    assert.match(js, new RegExp("addEventListener\\('" + ev + "'"), 'home.js never listens for ' + ev);
  }
  // Every chip has an answer, and every section's menu-button text is set.
  for (const m of html.matchAll(/data-obj="([a-z]+)"/g)) {
    if (/id="saidChips"/.test(html)) assert.match(js, new RegExp('\\b' + m[1] + ':\\s'), 'no answer for chip ' + m[1]);
  }
  assert.ok((html.match(/data-cta="/g) || []).length >= 6, 'sections carry data-cta');
});
