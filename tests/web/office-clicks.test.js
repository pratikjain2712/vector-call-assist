'use strict';
/* Tests for the office-clicks helpers: who may record a payment (shared.js canCollect), the remembered choices
   (recall / remember), the common answers with blanks (settings.js), the New calling list's name
   (campaigns.js listName). Plus static checks: the pages build with el() only, every RPC they name exists in the
   migrations, and admin.html loads css/admin-office.css.
   Run: node --test tests/web/office-clicks.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const S = require(path.join(root, 'web', 'js', 'admin', 'shared.js'));
const ST = require(path.join(root, 'web', 'js', 'admin', 'settings.js'));
const CA = require(path.join(root, 'web', 'js', 'admin', 'campaigns.js'));

test('canCollect: owners, Accounts and managers who can see money', () => {
  assert.strictEqual(S.canCollect({ role: 'admin' }, false), true);
  assert.strictEqual(S.canCollect({ role: 'accounts' }, true), true);
  assert.strictEqual(S.canCollect({ role: 'admin', access_role: 'manager' }, true), true);
  assert.strictEqual(S.canCollect({ role: 'admin', access_role: 'manager' }, false), false);
  assert.strictEqual(S.canCollect({ role: 'admin', admin_kind: 'manager' }, false), false);
});

test('recall and remember: per login, JSON, and a fallback when storage is missing or throws', () => {
  const mem = new Map();
  global.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  assert.strictEqual(S.recall('k', 'A@x.in', 'none'), 'none');
  assert.strictEqual(S.remember('k', 'A@x.in', { a: 1 }), true);
  assert.deepStrictEqual(S.recall('k', 'a@x.in', null), { a: 1 });   // the login, any case
  assert.strictEqual(S.recall('k', 'b@x.in', 'none'), 'none');       // another login
  global.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.strictEqual(S.recall('k', 'a@x.in', 'none'), 'none');
  assert.strictEqual(S.remember('k', 'a@x.in', 1), false);
  delete global.localStorage;
  assert.strictEqual(S.recall('k', 'a@x.in', 7), 7);
});

test('common answers: the box starts with blanks; Save all skips a box with a blank or left as it started', () => {
  const loc = { key: 'location', filled: false, answer: 'Let me tell you the address.' };
  const start = ST.startText(loc, 'Let me tell you the address.');
  assert.strictEqual(start, 'We are at ____, near ____. I can also send the location on WhatsApp.');
  assert.ok(ST.hasBlank(start));
  assert.strictEqual(ST.answerAction(loc, start, start), 'skip');
  assert.strictEqual(ST.answerAction(loc, 'We are at 12 MG Road, near ____.', start), 'blank');
  assert.strictEqual(ST.answerAction(loc, 'We are at 12 MG Road, near City Mall.', start), 'save');
  assert.strictEqual(ST.answerAction(loc, '', start), 'skip');
  // An answer with no ready wording: the standard answer and one blank at the end.
  assert.strictEqual(ST.startText({ key: 'new_one', filled: false, answer: 'Call us.' }, 'Call us.'), 'Call us. ____');
  // A filled answer: kept, cleared when emptied, saved when changed.
  const done = { key: 'location', filled: true, answer: 'We are at 12 MG Road.' };
  assert.strictEqual(ST.startText(done, 'x'), 'We are at 12 MG Road.');
  assert.strictEqual(ST.answerAction(done, 'We are at 12 MG Road.', 'We are at 12 MG Road.'), 'skip');
  assert.strictEqual(ST.answerAction(done, '  ', 'We are at 12 MG Road.'), 'clear');
  assert.strictEqual(ST.answerAction(done, 'We are at 14 MG Road.', 'We are at 12 MG Road.'), 'save');
});

test('a new calling list is named type · class · month', () => {
  const nov = new Date(2026, 10, 3);
  assert.strictEqual(CA.listName('Fees collection', '10th', nov), 'Fees collection · Class 10 · Nov');
  assert.strictEqual(CA.listName('Sales', '', nov), 'Sales · Nov');
  assert.strictEqual(CA.listName('Admission', 'LKG', nov), 'Admission · LKG · Nov');
});

test('the changed pages build with el() only, name RPCs that exist, and admin.html loads the stylesheet', () => {
  const sql = fs.readdirSync(path.join(root, 'supabase', 'migrations')).map((f) => fs.readFileSync(path.join(root, 'supabase', 'migrations', f), 'utf8')).join('\n');
  ['fees.js', 'fees-basics.js', 'callers.js', 'settings.js', 'campaigns.js', 'reports.js', 'collect.js', 'today.js'].forEach((f) => {
    const src = fs.readFileSync(path.join(root, 'web', 'js', 'admin', f), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src), f + ' uses no HTML strings');
    [...src.matchAll(/rpc\('([a-z_]+)'/g)].map((m) => m[1]).forEach((n) => {
      assert.ok(new RegExp('function public\\.' + n + '\\(').test(sql), f + ': ' + n + ' is in the migrations');
    });
  });
  const html = fs.readFileSync(path.join(root, 'web', 'admin.html'), 'utf8');
  assert.ok(html.indexOf('href="css/admin-office.css"') > html.indexOf('href="css/admin-collect.css"'));
  assert.ok(!/style=/.test(fs.readFileSync(path.join(root, 'web', 'js', 'admin', 'fees.js'), 'utf8')), 'no inline styles');
});
