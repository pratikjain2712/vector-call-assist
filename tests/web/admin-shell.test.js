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
test('five tabs, in order, whatever order they register in', () => {
  assert.deepStrictEqual(S.TAB_ORDER, ['today', 'fees', 'calling', 'team', 'settings']);
  const r = S.createRegistry();
  ['settings', 'team', 'today', 'calling', 'fees'].forEach((id) => r.register(tab(id)));
  assert.deepStrictEqual(r.list().map((t) => t.id), ['today', 'fees', 'calling', 'team', 'settings']);
});
test('a part or an extra tab goes after the five', () => {
  const r = S.createRegistry();
  r.register(tab('extra'));
  r.register(tab('reports', { part: true }));
  r.register(tab('today'));
  assert.deepStrictEqual(r.list().map((t) => t.id), ['today', 'extra', 'reports']);
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
  assert.deepStrictEqual(S.parseHash('#team'), { tab: 'team', sub: null, params: {} });
  assert.deepStrictEqual(S.parseHash('team'), { tab: 'team', sub: null, params: {} });
});
test('a tab hash with params', () => {
  assert.deepStrictEqual(S.parseHash('#today/reports?script=abc&version=v-1'), { tab: 'today', sub: 'reports', params: { script: 'abc', version: 'v-1' } });
});
test('a tab hash with a sub-view', () => {
  assert.deepStrictEqual(S.parseHash('#calling/scripts'), { tab: 'calling', sub: 'scripts', params: {} });
  assert.deepStrictEqual(S.parseHash('#fees/report?from=2026-10-01'), { tab: 'fees', sub: 'report', params: { from: '2026-10-01' } });
  assert.strictEqual(S.parseHash('#calling/scripts/x').tab, null);
  assert.strictEqual(S.buildHash('calling/scripts', { edit: 'a1' }), '#calling/scripts?edit=a1');
  assert.strictEqual(S.routeHash({ tab: 'today', sub: 'reports', params: { report: 'funnel' } }), '#today/reports?report=funnel');
  assert.strictEqual(S.routeHash({ tab: 'team', sub: null, params: {} }), '#team');
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
  assert.strictEqual(S.buildHash('today'), '#today');
  assert.strictEqual(S.buildHash('reports', { script: 'abc', version: '', x: null }), '#reports?script=abc');
  const params = { script: 'a b', version: '7&8' };
  assert.deepStrictEqual(S.parseHash(S.buildHash('reports', params)), { tab: 'reports', sub: null, params });
});
test('resolveTab keeps a known tab and falls back to Today', () => {
  const ids = ['today', 'team', 'calling'];
  assert.strictEqual(S.resolveTab({ tab: 'team' }, ids), 'team');
  assert.strictEqual(S.resolveTab({ tab: 'nope' }, ids), 'today');
  assert.strictEqual(S.resolveTab({ tab: null }, ids), 'today');
  assert.strictEqual(S.resolveTab({ tab: 'nope' }, ['fees']), 'fees');   // Accounts: Fees only
  assert.strictEqual(S.resolveTab({ tab: 'nope' }, []), null);
});

// ----- old links -----
test('old tab links go to their new place, with their params', () => {
  const go = (hash, opts) => { const r = S.redirectRoute(S.parseHash(hash), opts); return r ? S.routeHash(r) : null; };
  assert.strictEqual(go('#home'), '#today');
  assert.strictEqual(go('#insights'), '#today?more=1');
  assert.strictEqual(go('#insights?campaign=c1'), '#today?campaign=c1&more=1');
  assert.strictEqual(go('#campaigns'), '#calling');
  assert.strictEqual(go('#campaigns?id=c1'), '#calling?id=c1');
  assert.strictEqual(go('#campaigns?new=1'), '#calling?new=1');
  assert.strictEqual(go('#scripts'), '#calling/scripts');
  assert.strictEqual(go('#scripts?edit=s1'), '#calling/scripts?edit=s1');
  assert.strictEqual(go('#callers'), '#team');
  assert.strictEqual(go('#callers?seat=x1'), '#team?seat=x1');
  assert.strictEqual(go('#reports'), '#today/reports');
  assert.strictEqual(go('#reports?report=funnel'), '#today/reports?report=funnel');
  assert.strictEqual(go('#reports?script=s1&version=v1'), '#today/reports?script=s1&version=v1');
  assert.strictEqual(go('#reports?report=fees'), '#fees/report');
  assert.strictEqual(go('#reports', { accounts: true }), '#fees/report');
  ['#today', '#fees', '#calling/scripts', '#team?seat=x', '#settings', '', '#access_token=abc'].forEach((h) => assert.strictEqual(go(h), null, h));
});

// ----- who gets which tab -----
test('role tab sets: owner five, manager three (Fees with money), Accounts Fees only', () => {
  assert.deepStrictEqual(S.tabsFor({ role: 'admin', access_role: 'owner' }, true), ['today', 'fees', 'calling', 'team', 'settings']);
  assert.deepStrictEqual(S.tabsFor({ role: 'admin' }, false), ['today', 'fees', 'calling', 'team', 'settings']);   // seats from before roles
  assert.deepStrictEqual(S.tabsFor({ role: 'admin', access_role: 'manager' }, false), ['today', 'calling', 'team']);
  assert.deepStrictEqual(S.tabsFor({ role: 'admin', access_role: 'manager' }, true), ['today', 'fees', 'calling', 'team']);
  assert.deepStrictEqual(S.tabsFor({ role: 'accounts', access_role: 'accounts' }, true), ['fees']);
  assert.deepStrictEqual(S.tabsFor({ role: 'admin', admin_kind: 'accounts' }, true), ['fees']);
  assert.strictEqual(S.seatKind({ role: 'admin', admin_kind: 'manager' }), 'manager');
});

// ----- simple and advanced -----
test('advanced options are off by default, remembered per login, and survive storage that throws', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
  const store = mem();
  assert.strictEqual(S.readAdvanced(store, 'a@x.in'), false);
  assert.strictEqual(S.writeAdvanced(store, 'A@x.in', true), true);
  assert.strictEqual(S.readAdvanced(store, 'a@x.in'), true);
  assert.strictEqual(S.readAdvanced(store, 'b@x.in'), false);   // another login on the same browser
  assert.ok(store.m.has('vector-admin-advanced:a@x.in'));
  S.writeAdvanced(store, 'a@x.in', false);
  assert.strictEqual(S.readAdvanced(store, 'a@x.in'), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.strictEqual(S.readAdvanced(broken, 'a@x.in'), false);
  assert.strictEqual(S.writeAdvanced(broken, 'a@x.in', true), false);
  assert.strictEqual(S.readAdvanced(null, 'a@x.in'), false);
});

// ----- one number, one definition -----
const LED = {
  from: '2026-10-01', to: '2026-10-25', today: '2026-10-25', money_hidden: false, has_ledger: true,
  due_now: { students: 187, amount: 2710500 }, collected: { payments: 4, reversed: 1, total: 18000, by_mode: [], by_day: [] },
  promised: { leads: 2, amount: 11000 }, broken: { leads: 14, part_paid: 2, amount: 54000 },
};
test('feeNumbers reads admin_fees_ledger in one shape', () => {
  const n = S.feeNumbers(LED);
  assert.deepStrictEqual([n.due.students, n.due.amount, n.collected.payments, n.collected.amount, n.promised.parents, n.missed.parents, n.missed.partPaid],
    [187, 2710500, 4, 18000, 2, 14, 2]);
  assert.strictEqual(n.money, true);
  const hidden = S.feeNumbers(Object.assign({}, LED, { money_hidden: true }));
  assert.deepStrictEqual([hidden.money, hidden.due.amount, hidden.collected.amount, hidden.promised.amount, hidden.missed.amount], [false, null, null, null, null]);
  assert.strictEqual(S.feeNumbers(null).due.students, 0);
});
test('feeCards: the same four cards everywhere, with the period in the label', () => {
  const cards = S.feeCards(S.feeNumbers(LED), 'this month');
  assert.deepStrictEqual(cards.map((c) => c.key), ['due', 'collected', 'promised', 'missed']);
  assert.deepStrictEqual(cards.map((c) => c.label), ['Due now', 'Collected this month', 'Promised, not paid yet', 'Promised date missed']);
  assert.deepStrictEqual(cards.map((c) => c.value), ['₹27,10,500', '₹18,000', '₹11,000', '14']);
  assert.match(cards[0].sub, /^187 students/);
  assert.match(cards[1].sub, /Paid \(office\)$/);
  assert.match(cards[2].sub, /parent said \(not paid yet\)/);
  assert.match(cards[3].sub, /₹54,000 still to pay · date passed, not paid · 2 partly paid/);
  const counts = S.feeCards(S.feeNumbers(Object.assign({}, LED, { money_hidden: true })), 'today');
  assert.deepStrictEqual(counts.map((c) => c.value), ['187 students', '4 payments', '2 parents', '14']);
  assert.strictEqual(counts[1].label, 'Collected today');
  assert.ok(!JSON.stringify(counts).includes('₹'));
});
test('periodText names the dates of a number', () => {
  assert.strictEqual(S.periodText('2026-10-25', '2026-10-25', '2026-10-25'), 'today');
  assert.strictEqual(S.periodText('2026-10-01', '2026-10-25', '2026-10-25'), 'this month');
  assert.strictEqual(S.periodText('2026-10-19', '2026-10-25', '2026-10-25'), 'in these dates (19 Oct – 25 Oct)');
  assert.strictEqual(S.periodText('', '2026-10-25', '2026-10-25'), '');
  assert.deepStrictEqual(S.monthToDate(new Date(2026, 9, 25, 15)), { from: '2026-10-01', to: '2026-10-25' });
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
test('the money labels: what the office recorded, and what a parent said', () => {
  assert.strictEqual(S.PAID_OFFICE, 'Paid (office)');
  assert.strictEqual(S.PARENT_SAID, 'Parent said (not paid yet)');
  assert.strictEqual(S.REPORTED_BY_CALLER, S.PARENT_SAID);
  assert.strictEqual(S.MISSED, 'Promised date missed');
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
const PARTS = ['home', 'insights', 'campaigns', 'scripts', 'reports'];
const fileOf = (id) => S.TAB_MODULE[id] || id;
test('every tab and part has its module, its script tag and its stylesheet', () => {
  S.TAB_ORDER.concat(PARTS).forEach((id) => {
    const f = fileOf(id);
    assert.ok(moduleFiles.includes(f + '.js'), 'js/admin/' + f + '.js');
    assert.ok(adminHtml.includes('<script src="js/admin/' + f + '.js"></script>'), 'script tag for ' + id);
    assert.ok(adminHtml.includes('<link rel="stylesheet" href="css/admin-' + f + '.css">'), 'stylesheet for ' + id);
    assert.ok(fs.existsSync(path.join(root, 'web', 'css', 'admin-' + f + '.css')), 'css/admin-' + f + '.css');
    const src = fs.readFileSync(path.join(adminDir, f + '.js'), 'utf8');
    assert.ok(new RegExp("registerTab\\(\\{\\s*id: '" + id + "'").test(src), f + '.js registers ' + id);
    // A part is shown inside a tab, never in the tab bar.
    assert.strictEqual(/part: true/.test(src), PARTS.includes(id), id + (PARTS.includes(id) ? ' is a part' : ' is a tab'));
  });
});
test('the Team tab is scoped .tab-team (its file is still callers)', () => {
  const css = fs.readFileSync(path.join(root, 'web', 'css', 'admin-callers.css'), 'utf8');
  assert.ok(!/\.tab-callers/.test(css) && /\.tab-team /.test(css));
});
test('shared.js loads before the tabs and shell.js after them', () => {
  const at = (f) => adminHtml.indexOf('<script src="js/admin/' + f + '"></script>');
  assert.ok(at('shared.js') > -1 && at('shell.js') > -1);
  S.TAB_ORDER.concat(PARTS).forEach((id) => assert.ok(at('shared.js') < at(fileOf(id) + '.js') && at(fileOf(id) + '.js') < at('shell.js'), id));
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
