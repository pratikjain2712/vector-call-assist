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

  // Phase A: reports. Fees collection, promises due, send back and the sales funnel for institute A, with the
  // money rules of migration 20261024100024: amounts only when db.reports.money is true (a test sets it, like
  // can_see_money on the real database), and every money export logged in db.reports.exports.
  const reportsCampaign = crypto.randomUUID();
  db.reports = {
    money: false, exports: [], sentBack: [],
    campaigns: [{ id: reportsCampaign, institute_id: world.institutes.a, name: 'Oct fees', status: 'running' }],
    fees: { leads: 240, total_due: 4320000, paid_leads: 80, paid_calls: 85, paid_amount: 1440000, promised_leads: 50,
      promised_amount: 900000, broken_promises: 14 },
    promises: [
      { lead_id: crypto.randomUUID(), name: 'Parent Late', extra: { Student: 'Asha', Class: '10-B' }, amount: 9000, days_late: 2, caller: 'Rep 2' },
      { lead_id: crypto.randomUUID(), name: 'Parent Today', extra: { Student: 'Ravi', Class: '10-A' }, amount: 18000, days_late: 0, caller: 'Rep 1' },
      { lead_id: crypto.randomUUID(), name: 'Parent Later', extra: {}, amount: 18000, days_late: -2, caller: 'Rep 1' },
    ],
    funnel: { called: 189, picked_up: 117, heard_pitch: 78, interested: 36, joined: 23, no_step: 0, pitch_guessed: true,
      top_reason: { reason: 'price', calls: 12 } },
  };
  const reportsDay = (late) => { const d = new Date(); d.setDate(d.getDate() - late); return d.toISOString().slice(0, 10); };
  const reportsDenied = () => pgErr(400, '42501', 'only an admin of this institute can view these reports');
  Object.assign(RPC, {
    admin_fees_report: (u, a) => {
      if (!requireAdmin(u, a.p_institute)) return reportsDenied();
      const m = db.reports.money, f = db.reports.fees;
      return json(200, [{ ...f, total_due: m ? f.total_due : null, paid_amount: m ? f.paid_amount : null,
        promised_amount: m ? f.promised_amount : null, money_hidden: !m }]);
    },
    admin_promises_due: (u, a) => {
      if (!requireAdmin(u, a.p_institute)) return reportsDenied();
      return json(200, db.reports.promises.map((p) => ({ ...p, amount: db.reports.money ? p.amount : null, money_hidden: !db.reports.money,
        promised_date: reportsDay(p.days_late), seat_id: null, campaign_id: reportsCampaign, campaign: 'Oct fees', next_call_at: null })));
    },
    admin_send_back_leads: (u, a) => {
      if (!requireAdmin(u, a.p_institute)) return reportsDenied();
      db.reports.sentBack.push(...(a.p_leads || []));
      return json(200, (a.p_leads || []).length);
    },
    admin_sales_funnel: (u, a) => {
      if (!requireAdmin(u, a.p_institute)) return reportsDenied();
      return json(200, db.reports.funnel);
    },
    log_money_export: (u, a) => {
      if (!requireAdmin(u, a.p_institute) || !db.reports.money) return pgErr(400, '42501', 'you cannot export money for this institute');
      db.reports.exports.push({ what: a.p_what, rows: a.p_rows });
      return json(200, db.reports.exports.length);
    },
  });
  if (!RPC.can_see_money) RPC.can_see_money = (u, a) => json(200, !!(requireAdmin(u, a.inst) && db.reports.money));
  // The campaigns list for the report filters (admins read their institute's campaigns).
  function reportsRoute(p, method, u) {
    if (p !== '/rest/v1/campaigns' || method !== 'GET') return null;
    const s = u && seatOf(u.id);
    return json(200, s && s.role === 'admin' ? db.reports.campaigns.filter((c) => c.institute_id === s.institute_id) : []);
  }
  // End of Phase A: reports.

  const ADMIN_EMPTY = ['admin_weekly_summary', 'admin_rep_progress', 'list_supervisor_notes'];

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
    const reportsRes = reportsRoute(p, method, u);   // Phase A: reports
    if (reportsRes) return send(reportsRes);
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
