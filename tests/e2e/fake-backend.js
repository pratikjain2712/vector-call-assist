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
  // Phase A: admin. Home, Callers and Settings (20261024100023_admin_home_settings.sql and the 0012/0013 call type,
  // role and money functions): the same inputs, answer shapes, admin and owner checks. No money is kept, so
  // amounts are always null (money hidden). Functions another block already defines are left as they are.
  const adminTabs = (() => {
    db.campaigns = db.campaigns || [];
    db.members = db.members || [];
    db.audit = [];
    db.presence = {};              // seat id -> { status, since, idle_minutes }
    db.promisesDue = 0;            // leads promised for today (Home "Needs your attention")
    db.institute = { name: 'E2E Institute A', time_zone: 'Asia/Kolkata', hide_money: false, status: 'trial', trial_days_left: 4, seat_limit: 10 };
    const COMMON = [['no_answer', 'No answer'], ['busy', 'Busy'], ['wrong_number', 'Wrong number'], ['call_back_later', 'Call back later'], ['do_not_call', 'Do not call again']]
      .map(([key, label], i) => ({ id: crypto.randomUUID(), key, label, common: true, built_in: true, sort_order: 900 + i * 10 }));
    db.callTypes = [['fees', 'Fees collection', [['paid', 'Paid', 'amount'], ['will_pay_on', 'Will pay on date', 'date']]],
      ['sales', 'Sales', [['joined', 'Joined'], ['interested', 'Interested']]]]
      .map(([key, label, results], i) => ({ id: crypto.randomUUID(), key, label, sort_order: (i + 1) * 10, active: true, built_in: true,
        own: results.map(([k, l, need]) => ({ id: crypto.randomUUID(), key: k, label: l, common: false, built_in: true,
          needs_date: need === 'date', needs_amount: need === 'amount', counts_as_good: k !== 'interested' })) }));
    const roleOf = (s) => s.access_role || (s.role === 'admin' ? 'owner' : 'caller');
    const admin = (u) => { const s = u && seatOf(u.id); return s && s.role === 'admin' ? s : null; };
    const owner = (u) => { const s = admin(u); return s && roleOf(s) === 'owner' ? s : null; };
    const deny = (m) => pgErr(403, '42501', m || 'only an admin of this institute can see this');
    const audit = (u, action, target) => db.audit.push({ id: db.audit.length + 1, created_at: new Date().toISOString(), action, target, actor: u.id });
    const seatLabel = (id) => (db.seats.find((s) => s.id === id) || {}).label || null;
    const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const callsToday = (seatId) => db.outcomes.filter((r) => !r.corrects_id && r.seat_id === seatId &&
      new Date(r.dialled_at || r.uploaded_at).getTime() >= startOfDay()).length;
    const campaignsOf = (seatId) => db.members.filter((m) => m.seat_id === seatId)
      .map((m) => db.campaigns.find((c) => c.id === m.campaign_id)).filter((c) => c && c.status !== 'closed');
    const typeRows = () => db.callTypes.map((t) => ({ id: t.id, key: t.key, label: t.label, sort_order: t.sort_order, active: t.active,
      built_in: t.built_in, results: t.own.filter((r) => r.active !== false).concat(COMMON) }));
    const mine = {
      my_features: (u) => json(200, u && seatOf(u.id) ? ['scripts', 'ai_drafts'] : null),
      admin_home_summary: (u, a) => {
        const s = admin(u);
        if (!s) return deny();
        if (!['today', 'yesterday', 'week'].includes(a.p_day)) return pgErr(400, '22023', 'day must be today, yesterday or week');
        const eff = effective(s.institute_id).filter((e) => a.p_day !== 'today' || new Date(e.root.dialled_at || e.root.uploaded_at).getTime() >= startOfDay());
        const picked = eff.filter((e) => (e.connected_seconds || 0) > 0);
        const people = db.seats.filter((x) => x.institute_id === s.institute_id && x.status === 'active' && x.role === 'rep');
        return json(200, {
          day: a.p_day, time_zone: db.institute.time_zone, money_hidden: true, scripts_feature: true, generated_at: new Date().toISOString(),
          tiles: { calls: eff.length, calls_before: 0, picked_up: picked.length, talk_seconds: picked.reduce((n, e) => n + e.connected_seconds, 0),
            has_sales: false, joined: 0, interested: 0, has_fees: true, paid_calls: 0, promised_calls: 0, paid_amount: null, promised_amount: null },
          callers: people.map((x) => ({ seat_id: x.id, label: x.label, campaigns: campaignsOf(x.id).map((c) => c.name),
            calls: eff.filter((e) => e.root.seat_id === x.id).length, picked_up: 0, talk_seconds: 0, target: null, results: [],
            now: db.presence[x.id] || { status: 'not_started' } })),
          promises_due_today: { count: db.promisesDue, amount: null },
          script_ends: [],
          campaigns: db.campaigns.filter((c) => c.institute_id === s.institute_id && ['running', 'paused'].includes(c.status))
            .map((c) => ({ id: c.id, name: c.name, status: c.status, end_date: c.end_date || null,
              leads_total: (db.leads || []).filter((l) => l.campaign_id === c.id).length,
              leads_called: (db.leads || []).filter((l) => l.campaign_id === c.id && l.status !== 'new').length })),
          campaign_choices: db.campaigns.filter((c) => c.institute_id === s.institute_id && c.status !== 'draft')
            .map((c) => ({ id: c.id, name: c.name, status: c.status })),
        });
      },
      admin_callers: (u, a) => {
        const s = admin(u);
        if (!s || s.institute_id !== a.p_institute) return deny();
        return json(200, db.seats.filter((x) => x.institute_id === a.p_institute).map((x) => ({
          seat_id: x.id, label: x.label, access_role: roleOf(x), can_see_money: !!x.can_see_money, status: x.status,
          campaigns: campaignsOf(x.id).map((c) => ({ id: c.id, name: c.name, status: c.status })),
          calls_today: callsToday(x.id), calls_target: null, now_status: x.status === 'active' ? (db.presence[x.id] || { status: 'not_started' }) : null })));
      },
      admin_set_seat_role: (u, a) => {
        if (!owner(u)) return deny('only an owner of this institute can change roles');
        const x = db.seats.find((y) => y.id === a.p_seat);
        if (!x) return pgErr(400, '22023', 'seat not found');
        if (x.user_id === u.id) return deny('you cannot change your own role');
        x.access_role = a.p_role;
        x.role = a.p_role === 'caller' ? 'rep' : 'admin';
        if (a.p_role !== 'manager') x.can_see_money = false;
        audit(u, 'seat.role_set', x.id + ':' + a.p_role);
        return json(200, null);
      },
      admin_set_money_access: (u, a) => {
        if (!owner(u)) return deny('only an owner of this institute can change money access');
        const x = db.seats.find((y) => y.id === a.p_seat);
        if (!x || roleOf(x) !== 'manager') return pgErr(400, '22023', 'money access is set for manager seats only');
        x.can_see_money = !!a.p_allowed;
        audit(u, a.p_allowed ? 'money.access_given' : 'money.access_removed', x.id);
        return json(200, null);
      },
      admin_set_hide_money: (u, a) => {
        if (!owner(u)) return deny('only an owner can hide or show money');
        db.institute.hide_money = !!a.p_hide;
        audit(u, a.p_hide ? 'money.hidden' : 'money.shown', seatOf(u.id).institute_id);
        return json(200, null);
      },
      admin_institute_settings: (u) => {
        const s = admin(u);
        if (!s) return deny();
        return json(200, { ...db.institute, institute_id: s.institute_id, features: ['scripts', 'ai_drafts'], is_owner: roleOf(s) === 'owner',
          access_role: roleOf(s), seats_used: db.seats.filter((x) => x.institute_id === s.institute_id && x.status !== 'revoked').length });
      },
      admin_set_institute: (u, a) => {
        if (!owner(u)) return deny('only an owner can change the institute name or time zone');
        const name = String(a.p_name || '').trim();
        if (a.p_name && (name.length < 2 || name.length > 120)) return pgErr(400, '22023', 'institute name must be 2 to 120 characters');
        if (name) db.institute.name = name;
        if (a.p_time_zone) db.institute.time_zone = a.p_time_zone;
        audit(u, 'institute.changed', 'name,time_zone');
        return json(200, null);
      },
      admin_audit_log: (u, a) => {
        const s = admin(u);
        if (!s) return deny();
        const rows = db.audit.slice().reverse();
        const uuid = /^[0-9a-f-]{36}/;
        return json(200, rows.slice(a.p_offset, a.p_offset + a.p_limit).map((r) => {
          const tid = uuid.test(r.target || '') ? r.target.slice(0, 36) : null;
          return { id: r.id, created_at: r.created_at, action: r.action, target: r.target,
            actor_label: (db.seats.find((x) => x.user_id === r.actor) || {}).label || null,
            target_label: tid ? seatLabel(tid) || (tid === s.institute_id ? db.institute.name : null) : null,
            target_rest: tid ? r.target.slice(36) || null : null, total_rows: rows.length };
        }));
      },
      admin_list_call_types: (u) => (admin(u) ? json(200, typeRows()) : deny('only an admin can manage call types')),
      admin_upsert_call_type: (u, a) => {
        if (!admin(u)) return deny('only an admin can manage call types');
        const label = String(a.p_label || '').trim();
        if (!label) return pgErr(400, '22023', 'label must be 1 to 60 characters');
        if (a.p_id) {
          const t = db.callTypes.find((x) => x.id === a.p_id && !x.built_in);
          if (!t) return pgErr(400, '22023', 'built-in call types cannot be changed');
          t.label = label;
          if (a.p_active !== undefined && a.p_active !== null) t.active = !!a.p_active;
          audit(u, 'call_type.changed', t.id);
          return json(200, t.id);
        }
        const t = { id: crypto.randomUUID(), key: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label, sort_order: 500, active: true, built_in: false, own: [] };
        db.callTypes.push(t);
        audit(u, 'call_type.added', t.id);
        return json(200, t.id);
      },
      admin_upsert_call_type_result: (u, a) => {
        if (!admin(u)) return deny('only an admin can manage call types');
        if (a.p_id) {
          const r = db.callTypes.flatMap((t) => t.own).find((x) => x.id === a.p_id && !x.built_in);
          if (!r) return pgErr(400, '22023', 'built-in results cannot be changed');
          if (a.p_active === false) r.active = false;
          audit(u, 'call_type_result.changed', r.id);
          return json(200, r.id);
        }
        const t = db.callTypes.find((x) => x.id === a.p_call_type);
        if (!t) return pgErr(400, '22023', 'call type not found');
        const r = { id: crypto.randomUUID(), key: String(a.p_label).toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: a.p_label, common: false, built_in: false,
          needs_date: !!a.p_needs_date, needs_amount: !!a.p_needs_amount, needs_reason: !!a.p_needs_reason, counts_as_good: !!a.p_counts_as_good, active: true };
        t.own.push(r);
        audit(u, 'call_type_result.added', r.id);
        return json(200, r.id);
      },
      admin_set_campaign_members: (u, a) => {
        const s = admin(u);
        const c = db.campaigns.find((x) => x.id === a.p_campaign);
        if (!s || !c || c.institute_id !== s.institute_id) return deny('campaign not found');
        db.members = db.members.filter((m) => m.campaign_id !== c.id).concat([...new Set(a.p_seats || [])].map((seat_id) => ({ campaign_id: c.id, seat_id })));
        audit(u, 'campaign.members_set', c.id);
        return json(200, db.members.filter((m) => m.campaign_id === c.id).length);
      },
    };
    Object.keys(mine).forEach((k) => { if (!RPC[k]) RPC[k] = mine[k]; });
    // GET /rest/v1/campaigns for the Callers tab (admins read their institute's campaigns).
    function route(p, method, url, u) {
      if (p !== '/rest/v1/campaigns' || method !== 'GET') return null;
      const s = admin(u);
      const inst = (url.searchParams.get('institute_id') || '').replace(/^eq\./, '');
      const not = (url.searchParams.get('status') || '').replace(/^neq\./, '');
      const rows = s && s.institute_id === inst ? db.campaigns.filter((c) => c.institute_id === inst && c.status !== not) : [];
      return json(200, rows.map((c) => ({ id: c.id, name: c.name, status: c.status })).sort((x, y) => x.name.localeCompare(y.name)));
    }
    return {
      route,
      addCampaign: (inst, name, status) => { const c = { id: crypto.randomUUID(), institute_id: inst, name, status: status || 'running', end_date: null }; db.campaigns.push(c); return c.id; },
      setPresence: (seatId, now) => { db.presence[seatId] = now; },
      setPromisesDue: (n) => { db.promisesDue = n; },
    };
  })();
  // /Phase A: admin
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
    // Phase A: admin
    { const r = adminTabs.route(p, method, url, u); if (r) return send(r); }
    // /Phase A: admin
    return send(pgErr(404, 'PGRST000', 'fake backend has no route for ' + method + ' ' + p));
  }

  return {
    db,
    async attach(page, origin) { await page.route(origin + '/**', handle); },
    rowsFor: (seatId) => db.outcomes.filter((r) => r.seat_id === seatId),
    addOutcome: (row) => db.outcomes.push({ id: crypto.randomUUID(), uploaded_at: new Date().toISOString(), corrects_id: null, ...row }),
    passwordOf: (who) => (db.users.find((x) => x.email === world.users[who].email) || {}).password,
    adminTabs,   // Phase A: admin (addCampaign, setPresence, setPromisesDue)
  };
}

module.exports = { createFakeBackend };
