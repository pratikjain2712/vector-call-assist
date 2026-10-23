// A small in-memory stand-in for Supabase Auth and PostgREST, used when the local Supabase stack is not
// running. It answers only the calls the Vector pages make, with the same access rules as the migrations
// (reps insert rows for their own seat only; admin reports need an admin seat in that institute). The real
// pages and the real supabase-js talk to it over Playwright request routing; nothing leaves the machine.
// It cannot test row-level security in Postgres itself: tests/e2e/access-rules.spec.js needs the real stack.
const crypto = require('node:crypto');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(user) {
  const now = Math.floor(Date.now() / 1000);
  return b64url({ alg: 'HS256', typ: 'JWT' }) + '.' +
    b64url({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 }) + '.fake';
}

function createFakeBackend(world) {
  const db = {
    users: Object.values(world.users).map((u) => ({ id: u.id, email: u.email, password: world.password })),
    seats: Object.entries(world.seatInfo).map(([who, s]) => ({ ...s, user_id: world.users[who].id, status: 'active' })),
    outcomes: [],
    terms: [],
    log: [],
  };
  const tokens = new Map();   // access token -> user id

  const userById = (id) => db.users.find((u) => u.id === id);
  const seatOf = (uid) => db.seats.find((s) => s.user_id === uid && s.status === 'active') || null;
  const authUser = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
    email_confirmed_at: new Date(0).toISOString(), app_metadata: { provider: 'email' }, user_metadata: {} });
  function session(u) {
    const token = jwt(u);
    tokens.set(token, u.id);
    return { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'refresh-' + u.id, user: authUser(u) };
  }
  function caller(req) {
    const h = req.headers()['authorization'] || '';
    const uid = tokens.get(h.replace(/^Bearer\s+/i, ''));
    return uid ? userById(uid) : null;
  }
  const json = (status, body) => ({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
  const pgErr = (status, code, message) => json(status, { code, message, details: null, hint: null });
  function requireAdmin(u, inst) {
    const s = u && seatOf(u.id);
    return s && s.role === 'admin' && s.institute_id === inst;
  }
  const inRange = (r, from, to) => { const t = new Date(r.dialled_at || r.uploaded_at).getTime(); return t >= new Date(from).getTime() && t < new Date(to).getTime(); };

  // Effective rows: the latest correction of each original call, like admin_effective_outcomes.
  function effective(inst) {
    const roots = db.outcomes.filter((r) => r.institute_id === inst && !r.corrects_id);
    return roots.map((root) => {
      let cur = root;
      for (;;) { const next = db.outcomes.find((r) => r.corrects_id === cur.id); if (!next) break; cur = next; }
      return { ...cur, root };
    });
  }

  const RPC = {
    my_active_seat: (u) => json(200, u ? seatOf(u.id) : null),
    claim_my_invite: () => json(200, null),
    // Like my_trial_status (0009): the caller's institute and role, or null without an active seat.
    my_trial_status: (u) => {
      const s = u && seatOf(u.id);
      if (!s) return json(200, null);
      const name = s.institute_id === world.institutes.a ? 'E2E Institute A' : 'E2E Institute B';
      return json(200, { institute_id: s.institute_id, institute_name: name, status: 'active', seat_limit: 10, trial_ends_at: null, role: s.role });
    },
    my_terms_status: (u, a) => json(200, db.terms.filter((t) => t.user_id === (u && u.id) && t.institute_id === a.p_institute)
      .map((t) => ({ terms_version: t.terms_version, accepted_at: t.accepted_at }))),
    accept_terms: (u, a) => {
      if (!u || !seatOf(u.id)) return pgErr(400, 'P0001', 'this login holds no active seat in that institute');
      if (!db.terms.some((t) => t.user_id === u.id && t.terms_version === a.p_version)) {
        db.terms.push({ user_id: u.id, institute_id: a.p_institute, terms_version: a.p_version, accepted_at: new Date().toISOString() });
      }
      return json(200, null);
    },
    rep_loss_summary: (u) => {
      const s = u && seatOf(u.id);
      if (!s) return pgErr(403, '42501', 'no active seat for this login');
      return json(200, { calls: 0, lost: 0, reasons: [], stages: [], approved_changes: [] });
    },
    admin_team_activity: (u, a) => {
      if (!requireAdmin(u, a.p_institute)) return pgErr(400, 'P0001', 'admin access needed');
      const groups = new Map();
      for (const e of effective(a.p_institute).filter((e) => inRange(e.root, a.p_from, a.p_to))) {
        const day = new Date(e.root.dialled_at || e.root.uploaded_at).toISOString().slice(0, 10);
        const key = e.root.seat_id + '|' + day;
        const g = groups.get(key) || { seat_id: e.root.seat_id, label: (db.seats.find((s) => s.id === e.root.seat_id) || {}).label,
          day, calls: 0, connected_calls: 0, connect_rate: 0, talk_seconds: 0, last_activity: null };
        g.calls++;
        if ((e.connected_seconds || 0) > 0) { g.connected_calls++; g.talk_seconds += e.connected_seconds; }
        g.connect_rate = g.connected_calls / g.calls;
        g.last_activity = e.root.dialled_at || e.root.uploaded_at;
        groups.set(key, g);
      }
      return json(200, [...groups.values()]);
    },
    admin_results_by_outcome: (u, a) => {
      if (!requireAdmin(u, a.p_institute)) return pgErr(400, 'P0001', 'admin access needed');
      const c = new Map();
      for (const e of effective(a.p_institute).filter((e) => inRange(e.root, a.p_from, a.p_to))) {
        const key = e.root.seat_id + '|' + e.outcome;
        const g = c.get(key) || { seat_id: e.root.seat_id, label: (db.seats.find((s) => s.id === e.root.seat_id) || {}).label, outcome: e.outcome, outcome_count: 0 };
        g.outcome_count++;
        c.set(key, g);
      }
      return json(200, [...c.values()]);
    },
    admin_seat_list: (u, a) => {
      if (!requireAdmin(u, a.p_institute)) return pgErr(400, 'P0001', 'admin access needed');
      return json(200, db.seats.filter((s) => s.institute_id === a.p_institute).map((s) => ({
        seat_id: s.id, label: s.label, role: s.role, status: s.status, device_kinds: [], last_call_at: null, has_phone: false })));
    },
  };
  const ADMIN_EMPTY = ['admin_weekly_summary', 'admin_rep_progress', 'list_supervisor_notes'];

  // Phase A: insights-extra. Weekly brief, script test and practice (migration 20261024100026). State is in
  // db.ix so a test can change it (for example take the Scripts add-on away). Functions another block already
  // defines are kept.
  const IX_CAMPAIGN = '7e570000-0000-4000-8000-000000000001';
  db.ix = {
    features: { [world.institutes.a]: ['scripts', 'ai_drafts'], [world.institutes.b]: ['scripts', 'ai_drafts'] },
    brief: [
      'E2E fees: 40 of 82 leads have a good result so far. At this speed it will be 69 by 3 Nov.',
      'People pick up most on weekdays 7–9 pm (68%). Rep 1 calls mostly at 11 am (31% of their calls).',
      '9 people broke a promise. People who promised more than 7 days away kept it 30% of the time (within 7 days: 80%). Ask for a date within 7 days.',
      'E2E script: v7 gets 16 more good results per 100 picked-up calls than v6.',
    ],
    campaign: { id: IX_CAMPAIGN, name: 'E2E fees', status: 'running', script_id: world.scriptId, script_name: 'E2E script' },
    versions: [
      { version: 7, published: false, change_note: 'Shorter pitch', created_at: '2026-10-20T10:00:00Z' },
      { version: 6, published: true, change_note: '', created_at: '2026-10-01T10:00:00Z' },
    ],
    test: { id: '7e570000-0000-4000-8000-0000000000aa', status: 'running', version_a: 6, version_b: 7, winner: null,
      started_at: '2026-10-10T04:30:00Z', ended_at: null, same_script: true, leads: 198, arms: [
        { arm: 'a', version: 6, calls: 140, picked_up: 102, good: 9, avg_seconds: 410, change_note: '' },
        { arm: 'b', version: 7, calls: 131, picked_up: 96, good: 25, avg_seconds: 340, change_note: 'Shorter pitch' }] },
    log: [],   // [name, args] of every write
  };
  const ixSeat = (u) => (u && seatOf(u.id)) || null;
  const ixHas = (s) => !!s && (db.ix.features[s.institute_id] || []).includes('scripts');
  const ixAdmin = (u) => { const s = ixSeat(u); return s && s.role === 'admin' ? s : null; };
  const IX_RPC = {
    my_features: (u) => { const s = ixSeat(u); return json(200, s ? (db.ix.features[s.institute_id] || []) : null); },
    admin_weekly_brief: (u) => (ixAdmin(u) ? json(200, db.ix.brief) : pgErr(403, '42501', 'only an admin can see the weekly brief')),
    admin_script_test: (u, a) => {
      const s = ixAdmin(u);
      if (!s || a.p_campaign !== IX_CAMPAIGN) return pgErr(403, '42501', 'campaign not found');
      if (!ixHas(s)) return pgErr(403, '42501', 'Script tests are part of the Scripts add-on');
      return json(200, { campaign: db.ix.campaign, versions: db.ix.versions, test: db.ix.test });
    },
    admin_start_script_test: (u, a) => {
      const s = ixAdmin(u);
      if (!s || a.p_campaign !== IX_CAMPAIGN) return pgErr(403, '42501', 'campaign not found');
      if (db.ix.test && db.ix.test.status === 'running') return pgErr(400, '22023', 'a test is already running on this campaign; stop it first');
      db.ix.log.push(['admin_start_script_test', a]);
      db.ix.test = { id: crypto.randomUUID(), status: 'running', version_a: a.p_version_a, version_b: a.p_version_b, winner: null,
        started_at: new Date().toISOString(), ended_at: null, same_script: true, leads: 0, arms: [] };
      return json(200, db.ix.test.id);
    },
    admin_end_script_test: (u, a) => {
      const t = db.ix.test;
      if (!ixAdmin(u) || !t || t.id !== a.p_test) return pgErr(403, '42501', 'test not found');
      if (t.status !== 'running') return pgErr(400, '22023', 'this test has already ended');
      db.ix.log.push(['admin_end_script_test', a]);
      if (a.p_winner) db.ix.versions.forEach((v) => { v.published = v.version === a.p_winner; });
      Object.assign(t, { status: 'ended', winner: a.p_winner || null, ended_at: new Date().toISOString() });
      return json(200, null);
    },
    my_practice: (u) => {
      const s = ixSeat(u);
      if (!s) return pgErr(403, '42501', 'no active seat for this login');
      if (!ixHas(s)) return pgErr(403, '42501', 'Practice is part of the Scripts add-on');
      const done = db.ix.log.filter((l) => l[0] === 'my_practice_done');
      return json(200, [{ assignment_id: 'a0000000-0000-4000-8000-0000000000p1', script_id: world.scriptId, script_name: 'E2E script',
        version: 1, steps: world.steps, note: 'Slow down at the offer', assigned_at: '2026-10-22T05:00:00Z', assigned_by: 'E2E Admin',
        done_at: done.length ? new Date().toISOString() : null, times_done: done.length }]);
    },
    my_practice_done: (u, a) => {
      if (!ixSeat(u)) return pgErr(403, '42501', 'no active seat for this login');
      db.ix.log.push(['my_practice_done', a]);
      return json(200, null);
    },
  };
  Object.keys(IX_RPC).forEach((k) => { if (!RPC[k]) RPC[k] = IX_RPC[k]; });
  // /Phase A: insights-extra

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname, method = req.method();
    const body = (() => { try { return req.postDataJSON() || {}; } catch (e) { return {}; } })();
    db.log.push(method + ' ' + p);
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const send = (r) => route.fulfill({ ...r, headers: { 'access-control-allow-origin': '*' } });

    // ---- Auth (GoTrue) ----
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = db.users.find((x) => x.email === String(body.email || '').toLowerCase() && x.password === body.password);
      return send(u ? json(200, session(u)) : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 400, msg: 'Invalid login credentials' }));
    }
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const u = userById(String(body.refresh_token || '').replace(/^refresh-/, ''));
      return send(u ? json(200, session(u)) : json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' }));
    }
    if (p === '/auth/v1/user' && method === 'GET') {
      const u = caller(req);
      return send(u ? json(200, authUser(u)) : json(401, { code: 401, msg: 'invalid JWT' }));
    }
    if (p === '/auth/v1/user' && method === 'PUT') {
      const u = caller(req);
      if (!u) return send(json(401, { code: 401, msg: 'Auth session missing!' }));
      if (body.password) {
        if (String(body.password).length < 6) return send(json(422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' }));
        u.password = body.password;
      }
      return send(json(200, authUser(u)));
    }
    if (p === '/auth/v1/logout') return send({ status: 204, body: '' });
    if (p === '/auth/v1/otp' || p === '/auth/v1/recover') return send(json(200, {}));

    // ---- PostgREST ----
    const u = caller(req);
    if (p.startsWith('/rest/v1/rpc/')) {
      const name = p.slice('/rest/v1/rpc/'.length);
      if (RPC[name]) return send(RPC[name](u, body));
      if (ADMIN_EMPTY.includes(name)) return send(json(200, []));
      return send(pgErr(404, 'PGRST202', 'fake backend has no function ' + name));
    }
    if (p === '/rest/v1/scripts' && method === 'GET') {
      const inst = (url.searchParams.get('institute_id') || '').replace(/^eq\./, '');
      const scripts = inst === world.institutes.b && u ? [{ id: world.scriptId, script_versions: [{ version: 1, steps: world.steps, published: true }] }] : [];
      return send(json(200, scripts));
    }
    if (p === '/rest/v1/call_outcomes' && method === 'POST') {
      if (!u) return send(pgErr(401, '42501', 'permission denied for table call_outcomes'));
      const rows = Array.isArray(body) ? body : [body];
      for (const r of rows) {
        const s = seatOf(u.id);
        if (!s || r.seat_id !== s.id || r.institute_id !== s.institute_id) {
          return send(pgErr(403, '42501', 'new row violates row-level security policy for table "call_outcomes"'));
        }
        const dup = db.outcomes.some((x) => x.seat_id === r.seat_id && x.client_record_id === r.client_record_id);
        if (!dup) db.outcomes.push({ id: r.id || crypto.randomUUID(), uploaded_at: new Date().toISOString(), corrects_id: null, ...r });
      }
      return send({ status: 201, body: '' });
    }
    if (p === '/rest/v1/call_outcomes' && method === 'GET') {
      return send(json(200, u ? db.outcomes.filter((r) => { const s = seatOf(u.id); return s && r.seat_id === s.id; }) : []));
    }
    return send(pgErr(404, 'PGRST000', 'fake backend has no route for ' + method + ' ' + p));
  }

  return {
    db,
    async attach(page, origin) { await page.route(origin + '/**', handle); },
    rowsFor: (seatId) => db.outcomes.filter((r) => r.seat_id === seatId),
    addOutcome: (row) => db.outcomes.push({ id: crypto.randomUUID(), uploaded_at: new Date().toISOString(), corrects_id: null, ...row }),
    passwordOf: (who) => (db.users.find((x) => x.email === world.users[who].email) || {}).password,
  };
}

module.exports = { createFakeBackend };
