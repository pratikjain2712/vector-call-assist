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

  // Phase A: whatsapp
  // WhatsApp, in memory: the RPCs of 20261024100027_whatsapp.sql and the whatsapp-admin / whatsapp-send Edge
  // Functions (Meta is never called). Two leads of Rep 1: WA_LEADS.yes agreed to WhatsApp, WA_LEADS.no did not.
  const WA_LEADS = { yes: 'aaaaaaaa-0000-4000-8000-000000000001', no: 'aaaaaaaa-0000-4000-8000-000000000002' };
  const wa = { account: null, templates: [], messages: [], brief: null };
  const waLead = (id) => ({ [WA_LEADS.yes]: { consent: true }, [WA_LEADS.no]: { consent: false } })[id] || null;
  const waAdmin = (u) => { const s = u && seatOf(u.id); return s && s.role === 'admin' ? s : null; };
  const waOverview = (s) => {
    const sent = wa.messages.filter((m) => m.status === 'sent');
    return {
      institute_id: s.institute_id, is_owner: true,
      account: wa.account,
      templates: wa.templates.map((t) => ({ ...t, sent_this_month: sent.filter((m) => m.template_key === t.key).length })),
      month: { sent: sent.length, delivered: 0, read: 0, failed: 0, replies: 0, stops: 0, utility: sent.length, marketing: 0,
        cost_inr: Math.round(sent.length * 0.115 * 1000) / 1000, money_hidden: false },
      rates: { utility: 0.115, marketing: 0.86 },
      brief: wa.brief ? { on: true, phone: wa.brief } : { on: false, phone: null },
    };
  };
  Object.assign(RPC, {
    admin_whatsapp_overview: (u) => { const s = waAdmin(u); return s ? json(200, waOverview(s)) : pgErr(403, '42501', 'only an admin of this institute can see WhatsApp settings'); },
    admin_whatsapp_save_template: (u, a) => {
      if (!waAdmin(u)) return pgErr(403, '42501', 'only an admin can change WhatsApp templates');
      const old = a.p_id && wa.templates.find((t) => t.id === a.p_id);
      if (old) { Object.assign(old, { label: a.p_label, body: a.p_body, category: a.p_category, language: a.p_language, call_type_key: a.p_call_type_key, result_key: a.p_result_key, param_sources: a.p_param_sources }); return json(200, old.id); }
      const key = a.p_key || String(a.p_label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (wa.templates.some((t) => t.key === key)) return pgErr(400, '22023', 'a template with this short name already exists');
      const t = { id: crypto.randomUUID(), key, label: a.p_label, body: a.p_body, category: a.p_category, language: a.p_language,
        call_type_key: a.p_call_type_key, result_key: a.p_result_key, param_sources: a.p_param_sources, meta_name: 'vec_' + key, meta_status: 'draft', meta_reason: null };
      wa.templates.push(t);
      return json(200, t.id);
    },
    admin_whatsapp_delete_template: (u, a) => { if (!waAdmin(u)) return pgErr(403, '42501', 'not allowed'); wa.templates = wa.templates.filter((t) => t.id !== a.p_id); return json(200, null); },
    admin_whatsapp_brief: (u, a) => {
      if (!waAdmin(u)) return pgErr(403, '42501', 'only an owner can get the weekly brief on WhatsApp');
      const d = String(a.p_phone || '').replace(/[^0-9]/g, '').replace(/^(91|0)(?=[0-9]{10}$)/, '');
      if (a.p_on && !/^[0-9]{10}$/.test(d)) return pgErr(400, '22023', 'enter a 10-digit Indian mobile number');
      wa.brief = a.p_on ? '+91' + d : null;
      return json(200, null);
    },
    my_whatsapp_templates: (u) => json(200, u && seatOf(u.id) && wa.account ? wa.templates.filter((t) => t.meta_status === 'approved') : []),
  });
  if (!RPC.admin_list_call_types) {
    RPC.admin_list_call_types = (u) => (waAdmin(u) ? json(200, [{ id: 'ct-fees', key: 'fees', label: 'Fees collection', sort_order: 20, active: true, built_in: true,
      results: [{ key: 'paid', label: 'Paid', common: false }, { key: 'will_pay_on', label: 'Will pay on date', common: false }] }]) : pgErr(403, '42501', 'admin only'));
  }
  function waFunction(u, name, body) {
    if (!u) return json(401, { error: 'Sign in first.' });
    if (name === 'whatsapp-admin') {
      if (!waAdmin(u)) return json(403, { error: 'Only an admin can do that.' });
      if (body.action === 'connect') {
        if (!body.access_token && !wa.account) return json(400, { error: 'Paste the access token.' });
        wa.account = { phone_number_id: body.phone_number_id, waba_id: body.waba_id, display_name: body.display_name,
          display_phone: '+91 98765 00000', status: 'connected', token_source: 'stored', last_error: null };
        return json(200, { ok: true, display_phone: '+91 98765 00000', verified_name: body.display_name, warning: null });
      }
      if (body.action === 'disconnect') { if (wa.account) wa.account.status = 'disconnected'; return json(200, { ok: true }); }
      if (body.action === 'submit_template') {
        const t = wa.templates.find((x) => x.id === body.template_id);
        if (!t) return json(400, { error: 'Template not found.' });
        t.meta_status = 'pending';
        return json(200, { ok: true, status: 'pending', note: null });
      }
      if (body.action === 'refresh_templates') { wa.templates.forEach((t) => { if (t.meta_status === 'pending') t.meta_status = 'approved'; }); return json(200, { ok: true, updated: 1 }); }
      return json(400, { error: 'Unknown action.' });
    }
    if (name === 'whatsapp-send') {
      const s = seatOf(u.id);
      const lead = waLead(body.lead_id);
      if (!s || !lead || s.id !== world.seats.rep1) return json(403, { error: 'This lead is not assigned to you.' });
      if (!lead.consent) return json(400, { error: 'This person has not agreed to WhatsApp messages.' });
      const t = wa.templates.find((x) => x.key === body.template_key && x.meta_status === 'approved');
      if (!t || !wa.account || wa.account.status !== 'connected') return json(400, { error: 'This message is not approved by WhatsApp yet.' });
      const m = { id: crypto.randomUUID(), lead_id: body.lead_id, template_key: t.key, status: 'sent', params: body.params || null };
      wa.messages.push(m);
      return json(200, { ok: true, message_id: m.id });
    }
    return json(404, { error: 'no such function' });
  }
  // end Phase A: whatsapp

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
    // Phase A: whatsapp
    if (p.startsWith('/functions/v1/whatsapp-') && method === 'POST') return send(waFunction(u, p.slice('/functions/v1/'.length), body));
    // end Phase A: whatsapp
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
    // Phase A: whatsapp
    whatsapp: wa,
    WA_LEADS,
    // end Phase A: whatsapp
  };
}

module.exports = { createFakeBackend };
