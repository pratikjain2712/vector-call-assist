'use strict';
/* Tests for the pure helpers in web/js/admin/shared.js: the tab registry, hash routes, rupee and date
   formatting and the escape helper. Also static checks on the admin app files (every tab registered and
   linked, no HTML strings, no inline scripts). No network and no DOM.
   Run: node --test tests/web/admin-shell.test.js
   Prints "admin-shell.test: N passed, M failed" and exits 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const S = require(path.join(root, 'web', 'js', 'admin', 'shared.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); }
}
const tab = (id, extra) => Object.assign({ id, label: id.charAt(0).toUpperCase() + id.slice(1), mount() {} }, extra || {});

// ----- registry -----
test('tabs come out in the mockup order, whatever order they register in', () => {
  const r = S.createRegistry();
  ['settings', 'reports', 'home', 'callers', 'scripts', 'campaigns', 'insights'].forEach((id) => r.register(tab(id)));
  assert.deepStrictEqual(r.list().map((t) => t.id), ['home', 'insights', 'campaigns', 'scripts', 'callers', 'reports', 'settings']);
});
test('an extra tab goes after the seven', () => {
  const r = S.createRegistry();
  r.register(tab('extra'));
  r.register(tab('reports'));
  r.register(tab('home'));
  assert.deepStrictEqual(r.list().map((t) => t.id), ['home', 'reports', 'extra']);
});
test('get finds a tab by id and gives null for an unknown one', () => {
  const r = S.createRegistry();
  r.register(tab('home'));
  assert.strictEqual(r.get('home').label, 'Home');
  assert.strictEqual(r.get('nope'), null);
});
test('a tab registered twice is refused', () => {
  const r = S.createRegistry();
  r.register(tab('home'));
  assert.throws(() => r.register(tab('home')), /twice/);
});
test('a tab without an id, label or mount is refused', () => {
  const r = S.createRegistry();
  assert.throws(() => r.register({ label: 'X', mount() {} }), /id/);
  assert.throws(() => r.register({ id: 'Home!', label: 'X', mount() {} }), /id/);
  assert.throws(() => r.register({ id: 'x', mount() {} }), /label/);
  assert.throws(() => r.register({ id: 'x', label: 'X' }), /mount/);
});
test('list returns a copy', () => {
  const r = S.createRegistry();
  r.register(tab('home'));
  r.list().pop();
  assert.strictEqual(r.list().length, 1);
});

// ----- routes -----
test('a plain tab hash', () => {
  assert.deepStrictEqual(S.parseHash('#callers'), { tab: 'callers', params: {} });
  assert.deepStrictEqual(S.parseHash('callers'), { tab: 'callers', params: {} });
});
test('a tab hash with params', () => {
  assert.deepStrictEqual(S.parseHash('#reports?script=abc&version=v-1'), { tab: 'reports', params: { script: 'abc', version: 'v-1' } });
});
test('params are decoded', () => {
  assert.deepStrictEqual(S.parseHash('#reports?q=a%20b%26c').params, { q: 'a b&c' });
});
test('empty and sign-in link hashes are not tab routes', () => {
  assert.strictEqual(S.parseHash('').tab, null);
  assert.strictEqual(S.parseHash('#').tab, null);
  assert.strictEqual(S.parseHash(undefined).tab, null);
  assert.strictEqual(S.parseHash('#access_token=abc&refresh_token=def').tab, null);
  assert.strictEqual(S.parseHash('#error=access_denied&error_description=x').tab, null);
});
test('buildHash leaves out empty params and round-trips through parseHash', () => {
  assert.strictEqual(S.buildHash('home'), '#home');
  assert.strictEqual(S.buildHash('reports', { script: 'abc', version: '', x: null }), '#reports?script=abc');
  const params = { script: 'a b', version: '7&8' };
  assert.deepStrictEqual(S.parseHash(S.buildHash('reports', params)), { tab: 'reports', params });
});
test('resolveTab keeps a known tab and falls back to home', () => {
  const ids = ['home', 'callers', 'reports'];
  assert.strictEqual(S.resolveTab({ tab: 'callers' }, ids), 'callers');
  assert.strictEqual(S.resolveTab({ tab: 'nope' }, ids), 'home');
  assert.strictEqual(S.resolveTab({ tab: null }, ids), 'home');
  assert.strictEqual(S.resolveTab({ tab: 'nope' }, ['callers']), 'callers');
  assert.strictEqual(S.resolveTab({ tab: 'nope' }, []), null);
});

// ----- roles -----
test('admin roles: admin, owner and manager; not rep or caller', () => {
  ['admin', 'owner', 'manager'].forEach((r) => assert.ok(S.isAdminRole(r), r));
  ['rep', 'caller', '', null, undefined, 'Admin'].forEach((r) => assert.ok(!S.isAdminRole(r), String(r)));
});

// ----- money -----
test('rupees use Indian grouping', () => {
  assert.strictEqual(S.rupees(4320000), '₹43,20,000');
  assert.strictEqual(S.rupees(38500), '₹38,500');
  assert.strictEqual(S.rupees(999), '₹999');
  assert.strictEqual(S.rupees(1000), '₹1,000');
  assert.strictEqual(S.rupees(100000), '₹1,00,000');
  assert.strictEqual(S.rupees(123456789), '₹12,34,56,789');
  assert.strictEqual(S.rupees(0), '₹0');
});
test('rupees round paise, keep the sign, and give empty text for no amount', () => {
  assert.strictEqual(S.rupees(1499.5), '₹1,500');
  assert.strictEqual(S.rupees('2500'), '₹2,500');
  assert.strictEqual(S.rupees(-150000), '-₹1,50,000');
  assert.strictEqual(S.rupees(null), '');
  assert.strictEqual(S.rupees(undefined), '');
  assert.strictEqual(S.rupees(''), '');
  assert.strictEqual(S.rupees('abc'), '');
});
test('short rupees in lakhs and crores', () => {
  assert.strictEqual(S.rupeesShort(3120000), '₹31.2L');
  assert.strictEqual(S.rupeesShort(100000), '₹1L');
  assert.strictEqual(S.rupeesShort(4320000), '₹43.2L');
  assert.strictEqual(S.rupeesShort(15000000), '₹1.5Cr');
  assert.strictEqual(S.rupeesShort(9996000), '₹1Cr');      // would read ₹100L
  assert.strictEqual(S.rupeesShort(38500), '₹38,500');     // under a lakh: the full amount
  assert.strictEqual(S.rupeesShort(-250000), '-₹2.5L');
  assert.strictEqual(S.rupeesShort(null), '');
});
test('counts use Indian grouping without ₹', () => {
  assert.strictEqual(S.count(120000), '1,20,000');
  assert.strictEqual(S.count(42), '42');
});
test('the paid-amount label', () => {
  assert.strictEqual(S.REPORTED_BY_CALLER, 'reported by caller');
});

// ----- dates -----
test('formatDate takes a day, a Date or a timestamp', () => {
  assert.strictEqual(S.formatDate('2026-10-24'), '24 Oct 2026');
  assert.strictEqual(S.formatDate(new Date(2026, 0, 5)), '5 Jan 2026');
  assert.strictEqual(S.formatDate('2026-10-24', { year: false }), '24 Oct');
  assert.strictEqual(S.formatDate(new Date(2026, 9, 24, 15, 5).toISOString()), '24 Oct 2026');
  assert.strictEqual(S.formatDate('2026-02-30'), '');
  assert.strictEqual(S.formatDate(null), '');
  assert.strictEqual(S.formatDate('not a date'), '');
});
test('formatTime and formatDateTime use am and pm', () => {
  assert.strictEqual(S.formatTime(new Date(2026, 9, 24, 15, 5)), '3:05 pm');
  assert.strictEqual(S.formatTime(new Date(2026, 9, 24, 0, 30)), '12:30 am');
  assert.strictEqual(S.formatTime(new Date(2026, 9, 24, 12, 0)), '12:00 pm');
  assert.strictEqual(S.formatDateTime(new Date(2026, 9, 24, 9, 7)), '24 Oct, 9:07 am');
  assert.strictEqual(S.formatDateTime(''), '');
});
test('lastNDays and ymd', () => {
  assert.deepStrictEqual(S.lastNDays(new Date(2026, 9, 3, 10), 7), { from: '2026-09-27', to: '2026-10-03' });
  assert.strictEqual(S.ymd(new Date(2026, 0, 9)), '2026-01-09');
});

// ----- text -----
test('escapeHtml escapes the five characters', () => {
  assert.strictEqual(S.escapeHtml('<a href="x">Tom & Jerry\'s</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.strictEqual(S.escapeHtml(null), '');
  assert.strictEqual(S.escapeHtml(5), '5');
});

// ----- static checks on the admin app files -----
const adminHtml = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
const adminDir = path.join(root, 'web', 'js', 'admin');
const moduleFiles = fs.readdirSync(adminDir).filter((f) => f.endsWith('.js'));
test('every tab has its module, its script tag and its stylesheet', () => {
  S.TAB_ORDER.forEach((id) => {
    assert.ok(moduleFiles.includes(id + '.js'), 'js/admin/' + id + '.js');
    assert.ok(adminHtml.includes('<script src="js/admin/' + id + '.js"></script>'), 'script tag for ' + id);
    assert.ok(adminHtml.includes('<link rel="stylesheet" href="css/admin-' + id + '.css">'), 'stylesheet for ' + id);
    assert.ok(fs.existsSync(path.join(root, 'web', 'css', 'admin-' + id + '.css')), 'css/admin-' + id + '.css');
    const src = fs.readFileSync(path.join(adminDir, id + '.js'), 'utf8');
    assert.ok(new RegExp("registerTab\\(\\{\\s*id: '" + id + "'").test(src), id + '.js registers tab ' + id);
  });
});
test('shared.js loads before the tabs and shell.js after them', () => {
  const at = (f) => adminHtml.indexOf('<script src="js/admin/' + f + '"></script>');
  assert.ok(at('shared.js') > -1 && at('shell.js') > -1);
  S.TAB_ORDER.forEach((id) => assert.ok(at('shared.js') < at(id + '.js') && at(id + '.js') < at('shell.js'), id));
  assert.ok(adminHtml.indexOf('js/script-editor.js') < at('scripts.js'), 'the editor loads before the Scripts tab');
});
test('the admin app builds its pages without HTML strings', () => {
  moduleFiles.concat(['../script-editor.js']).forEach((f) => {
    const src = fs.readFileSync(path.join(adminDir, f), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(src), f);
  });
});
test('the admin page and the script editor redirect have no inline script or style', () => {
  const redirect = fs.readFileSync(path.join(root, 'web', 'script-editor.html'), 'utf8');
  [adminHtml, redirect].forEach((html) => {
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), 'inline script tag');
    assert.ok(!/<style[\s>]/i.test(html), 'style tag');
    assert.ok(!/\sstyle\s*=/i.test(html), 'style attribute');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler');
  });
  assert.ok(/<meta http-equiv="refresh" content="0; url=admin\.html#scripts">/.test(redirect), 'script-editor.html sends people to the Scripts tab');
});
test('the admin page keeps a strict Content-Security-Policy', () => {
  const csp = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(adminHtml) || [])[1] || '';
  assert.ok(/script-src 'self' https:\/\/cdn\.jsdelivr\.net;/.test(csp), csp);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), csp);
  assert.ok(/object-src 'none'/.test(csp) && /form-action 'none'/.test(csp), csp);
});

console.log('admin-shell.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
