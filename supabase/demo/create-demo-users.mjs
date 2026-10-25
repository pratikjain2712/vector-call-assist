#!/usr/bin/env node
// Creates (or updates) the 8 demo logins of "Sunrise Coaching Academy (Demo)" with one shared password.
// Run it before demo_seed.sql, which finds these users by email. Safe to run again: an existing user gets the
// password set again and is marked confirmed; nothing else changes.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... DEMO_PASSWORD=... \
//     node supabase/demo/create-demo-users.mjs
//
// The service role key and the password are never printed. Details: docs/demo.md.
import { createClient } from '@supabase/supabase-js';

export const DEMO_USERS = [
  { email: 'owner.sunrise@example.com', name: 'Anita Sharma', role: 'Owner (sees money)' },
  { email: 'manager.sunrise@example.com', name: 'Rahul Verma', role: 'Manager (no money)' },
  { email: 'ravi.sunrise@example.com', name: 'Ravi', role: 'Caller' },
  { email: 'priya.sunrise@example.com', name: 'Priya', role: 'Caller' },
  { email: 'neha.sunrise@example.com', name: 'Neha', role: 'Caller' },
  { email: 'amit.sunrise@example.com', name: 'Amit', role: 'Caller' },
  { email: 'sana.sunrise@example.com', name: 'Sana', role: 'Caller' },
  { email: 'accounts.sunrise@example.com', name: 'Kavita Joshi', role: 'Accounts (fees office)' },
];

function fail(message) {
  console.error('create-demo-users: ' + message);
  process.exit(1);
}

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const password = process.env.DEMO_PASSWORD || '';
if (!/^https?:\/\/\S+$/.test(url)) fail('set SUPABASE_URL (Project settings > API > Project URL).');
if (!key) fail('set SUPABASE_SERVICE_ROLE_KEY (Project settings > API keys > service_role / secret key).');
if (password.length < 10) fail('set DEMO_PASSWORD to a password of at least 10 characters.');

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

// Every user of the project, page by page, keyed by lower-case email.
async function existingUsers() {
  const byEmail = new Map();
  for (let page = 1; page < 1000; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) fail('could not list users: ' + error.message);
    const users = (data && data.users) || [];
    users.forEach((u) => { if (u.email) byEmail.set(u.email.toLowerCase(), u); });
    if (users.length < 1000) break;
  }
  return byEmail;
}

const users = await existingUsers();
for (const u of DEMO_USERS) {
  const meta = { full_name: u.name, demo: true };
  const found = users.get(u.email);
  if (found) {
    const { error } = await db.auth.admin.updateUserById(found.id, {
      password, email_confirm: true, user_metadata: { ...(found.user_metadata || {}), ...meta },
    });
    if (error) fail('could not update ' + u.email + ': ' + error.message);
    console.log('updated  ' + u.email.padEnd(30) + u.name + ' · ' + u.role);
  } else {
    const { error } = await db.auth.admin.createUser({
      email: u.email, password, email_confirm: true, user_metadata: meta,
    });
    if (error) fail('could not create ' + u.email + ': ' + error.message);
    console.log('created  ' + u.email.padEnd(30) + u.name + ' · ' + u.role);
  }
}
console.log('All ' + DEMO_USERS.length + ' demo logins use the DEMO_PASSWORD you set. Next: load demo_seed.sql.');
