// Prepares the test world before the e2e tests run, in one of two modes:
// - "local": the local Supabase stack is running (`npx supabase start`). Its test data is deleted and
//   recreated with the local service key. Refuses to touch anything but 127.0.0.1/localhost.
// - "fake": no local stack. The tests use tests/e2e/fake-backend.js, an in-memory stand-in served by Playwright.
// Writes tests/e2e/.local-env.json (git-ignored) for the tests. Set E2E_MODE=fake to force the fake backend.
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EMAIL_DOMAIN, PASSWORD, STEPS, PEOPLE } = require('./world');

const PREFIX = 'E2E ';
const OUT = path.join(__dirname, '.local-env.json');

function localStack() {
  if (process.env.E2E_MODE === 'fake') return null;
  try {
    const raw = execSync('npx --yes supabase status -o json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    const s = JSON.parse(raw.slice(raw.indexOf('{')));
    const url = s.API_URL, anon = s.ANON_KEY || s.PUBLISHABLE_KEY, service = s.SERVICE_ROLE_KEY || s.SECRET_KEY;
    if (!url || !anon || !service) return null;
    const host = new URL(url).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('Refusing to seed a non-local Supabase: ' + url);
    return { url, anon, service };
  } catch (e) {
    if (/Refusing/.test(e.message)) throw e;
    return null;   // not running
  }
}

function fakeWorld() {
  const id = () => crypto.randomUUID();
  const institutes = { a: id(), b: id() };
  const users = {}, seats = {}, seatInfo = {};
  for (const [who, [name, label, role, inst]] of Object.entries(PEOPLE)) {
    users[who] = { id: id(), email: name + EMAIL_DOMAIN };
    if (label) {
      seats[who] = id();
      seatInfo[who] = { id: seats[who], institute_id: institutes[inst], label, role };
    }
  }
  return { mode: 'fake', url: 'http://127.0.0.1:54321', anon: 'fake-anon-key', service: null,
    password: PASSWORD, users, seats, seatInfo, institutes, scriptId: id(), steps: STEPS };
}

async function seedLocal(env) {
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(env.url, env.service, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = (res, what) => { if (res.error) throw new Error(what + ': ' + res.error.message); return res.data; };

  // Clean out the previous run: test institutes (cascades to seats, outcomes, scripts) and test users.
  must(await admin.from('institutes').delete().like('name', PREFIX + '%'), 'delete test institutes');
  for (let page = 1; page < 20; page++) {
    const { users } = must(await admin.auth.admin.listUsers({ page, perPage: 200 }), 'list users');
    for (const u of users) {
      if ((u.email || '').endsWith(EMAIL_DOMAIN)) must(await admin.auth.admin.deleteUser(u.id), 'delete user ' + u.email);
    }
    if (users.length < 200) break;
  }

  const institutes = {};
  for (const [key, name] of [['a', 'Institute A'], ['b', 'Institute B']]) {
    institutes[key] = must(await admin.from('institutes').insert({ name: PREFIX + name, status: 'active', seat_limit: 10 }).select('id').single(), name).id;
  }
  const users = {}, seats = {}, seatInfo = {};
  for (const [who, [name, label, role, inst]] of Object.entries(PEOPLE)) {
    const email = name + EMAIL_DOMAIN;
    const u = must(await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true }), 'create ' + email);
    users[who] = { id: u.user.id, email };
    if (label) {
      seats[who] = must(await admin.from('seats').insert({ institute_id: institutes[inst], user_id: u.user.id, label, role, status: 'active' }).select('id').single(), 'seat ' + label).id;
      seatInfo[who] = { id: seats[who], institute_id: institutes[inst], label, role };
    }
  }
  const script = must(await admin.from('scripts').insert({ institute_id: institutes.b, name: 'E2E script' }).select('id').single(), 'script');
  must(await admin.from('script_versions').insert({ script_id: script.id, institute_id: institutes.b, version: 1, steps: STEPS, change_note: 'E2E', published: true }), 'script version');
  return { mode: 'local', ...env, password: PASSWORD, users, seats, seatInfo, institutes, scriptId: script.id, steps: STEPS };
}

module.exports = async function globalSetup() {
  const env = localStack();
  const world = env ? await seedLocal(env) : fakeWorld();
  fs.writeFileSync(OUT, JSON.stringify(world, null, 2));
  console.log('e2e mode: ' + world.mode + (world.mode === 'fake' ? ' (no local Supabase running: in-memory fake backend; access-rules test skipped)' : ' (local Supabase stack)'));
};
