// A small in-memory stand-in for Supabase Auth and PostgREST, used when the local Supabase stack is not
// running. It answers only the calls the Vector pages make, with the same access rules as the migrations
// (reps insert rows for their own seat only; admin reports need an admin seat in that institute). The real
// pages and the real supabase-js talk to it over Playwright request routing; nothing leaves the machine.
// It cannot test row-level security in Postgres itself: tests/e2e/access-rules.spec.js needs the real stack.
const crypto = require('node:crypto');
const CampaignQueue = require('../../web/js/campaign-queue.js');   // Phase A: caller: the lead update after a result
const { createFakeInsights } = require('./fake-insights');   // Phase A: insights

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
  // Phase A: campaigns. A small stand-in for the campaign functions of 20261024100020_campaign_admin.sql:
  // the same inputs and answer shapes, the admin check and the counts; shares leads round-robin. No money
  // is kept except amount_due on leads, returned only as the detail's total (can_see_money is false here).
  const CALL_TYPES = [['fees', 'Fees collection'], ['sales', 'Sales'], ['follow_up', 'Follow-up / appointment']]
    .map(([key, label], i) => ({ id: crypto.randomUUID(), key, label, sort_order: (i + 1) * 10, active: true, built_in: true, results: [] }));
  // Any call type a page may be shown: this block's own list or the Scripts block's (whose admin_list_call_types
  // answers last). Read at request time, so the later block's list is set by then.
  const anyCallType = (id) => CALL_TYPES.find((x) => x.id === id) || (typeof SCRIPT_TYPES !== 'undefined' ? SCRIPT_TYPES.find((x) => x.id === id) : null)
    || (db.callTypes || []).find((x) => x.id === id);
  db.campaigns = [];
  db.members = [];
  db.leads = [];
  const adminSeat = (u) => { const s = u && seatOf(u.id); return s && s.role === 'admin' ? s : null; };
  const campaignOf = (u, id) => { const s = adminSeat(u); const c = db.campaigns.find((x) => x.id === id); return s && c && c.institute_id === s.institute_id ? c : null; };
  const notAdmin = () => pgErr(403, '42501', 'only an admin can manage campaigns');
  const notFound = () => pgErr(403, '42501', 'campaign not found');
  const isOpen = (l) => ['new', 'callback', 'promised'].includes(l.status);
  function shareRoundRobin(c) {
    const ids = db.members.filter((m) => m.campaign_id === c.id).map((m) => m.seat_id);
    if (!ids.length) return 0;
    let i = 0, n = 0;
    db.leads.filter((l) => l.campaign_id === c.id && isOpen(l) && (!l.assigned_seat_id || !ids.includes(l.assigned_seat_id)))
      .forEach((l) => { l.assigned_seat_id = ids[i++ % ids.length]; n++; });
    return n;
  }
  function campaignRow(c) {
    const leads = db.leads.filter((l) => l.campaign_id === c.id);
    const t = anyCallType(c.call_type_id) || {};
    const callers = db.members.filter((m) => m.campaign_id === c.id)
      .map((m) => db.seats.find((s) => s.id === m.seat_id)).filter(Boolean)
      .map((s) => ({ seat_id: s.id, label: s.label })).sort((a, b) => a.label.localeCompare(b.label));
    return { ...c, call_type_key: t.key, call_type_label: t.label, script_name: null,
      leads_total: leads.length, leads_called: leads.filter((l) => l.status !== 'new').length,
      leads_open: leads.filter(isOpen).length, leads_unassigned: leads.filter((l) => isOpen(l) && !l.assigned_seat_id).length, callers };
  }
  Object.assign(RPC, {
    my_features: (u) => json(200, u && seatOf(u.id) ? ['scripts', 'ai_drafts'] : null),
    admin_list_call_types: (u) => (adminSeat(u) ? json(200, CALL_TYPES) : pgErr(403, '42501', 'only an admin can manage call types')),
    // Integration: the Callers tab moves a caller's open leads (same rules as 20261024100020, in short).
    admin_move_leads: (u, a) => {
      const s = adminSeat(u);
      if (!s) return notAdmin();
      const from = db.seats.find((x) => x.id === a.p_from_seat && x.institute_id === s.institute_id);
      if (!from) return pgErr(403, '42501', 'caller not found');
      if (a.p_to_seat && a.p_to_seat === a.p_from_seat) return pgErr(400, '22023', 'pick a different caller to move the leads to');
      let n = 0;
      db.leads.filter((l) => l.assigned_seat_id === from.id && isOpen(l) && (!a.p_campaign || l.campaign_id === a.p_campaign)).forEach((l) => {
        const c = db.campaigns.find((x) => x.id === l.campaign_id);
        if (!c || c.status === 'closed' || c.institute_id !== s.institute_id) return;
        l.assigned_seat_id = a.p_to_seat || null;
        n++;
        if (a.p_to_seat && !db.members.some((m) => m.campaign_id === c.id && m.seat_id === a.p_to_seat)) db.members.push({ campaign_id: c.id, seat_id: a.p_to_seat });
      });
      return json(200, n);
    },
    admin_campaign_list: (u) => {
      const s = adminSeat(u);
      if (!s) return notAdmin();
      return json(200, db.campaigns.filter((c) => c.institute_id === s.institute_id).map(campaignRow));
    },
    admin_create_campaign: (u, a) => {
      const s = adminSeat(u);
      if (!s) return notAdmin();
      const name = String(a.p_name || '').trim();
      if (!name) return pgErr(400, '22023', 'campaign name must be 1 to 120 characters');
      if (!anyCallType(a.p_call_type)) return pgErr(400, '22023', 'pick a call type');
      const c = { id: crypto.randomUUID(), institute_id: s.institute_id, name, call_type_id: a.p_call_type, script_id: a.p_script || null,
        start_date: a.p_start || null, end_date: a.p_end || null, daily_target: a.p_daily_target || null,
        share_mode: a.p_share_mode || 'equal', status: 'draft', created_at: new Date().toISOString() };
      db.campaigns.push(c);
      return json(200, c.id);
    },
    admin_update_campaign: (u, a) => {
      if (!adminSeat(u)) return notAdmin();
      const c = campaignOf(u, a.p_campaign);
      if (!c) return notFound();
      if (c.status === 'closed') return pgErr(400, '22023', 'this campaign is closed and cannot be changed');
      if (a.p_status === 'running' && c.status === 'draft') {
        if (!db.members.some((m) => m.campaign_id === c.id)) return pgErr(400, '22023', 'add at least one caller before you start');
        if (!db.leads.some((l) => l.campaign_id === c.id)) return pgErr(400, '22023', 'add leads before you start');
      }
      if (a.p_status === 'paused' && c.status !== 'running') return pgErr(400, '22023', 'only a running campaign can be paused');
      if (a.p_name) c.name = String(a.p_name).trim();
      if (a.p_clear_dates) { c.start_date = null; c.end_date = null; }
      if (a.p_start) c.start_date = a.p_start;
      if (a.p_end) c.end_date = a.p_end;
      if (a.p_daily_target !== undefined && a.p_daily_target !== null) c.daily_target = a.p_daily_target || null;
      if (a.p_status) c.status = a.p_status;
      return json(200, null);
    },
    admin_add_leads: (u, a) => {
      if (!adminSeat(u)) return notAdmin();
      const c = campaignOf(u, a.p_campaign);
      if (!c) return notFound();
      const out = { added: 0, bad_numbers: 0, repeats: 0, other_skipped: 0 };
      for (const r of a.p_rows || []) {
        const d = String(r.phone || '').replace(/[\s-]+/g, '').replace(/^\+91/, '').replace(/^91(?=\d{10}$)/, '').replace(/^0/, '');
        if (!/^\d{10}$/.test(d)) { out.bad_numbers++; continue; }
        if (!String(r.name || '').trim()) { out.other_skipped++; continue; }
        if (db.leads.some((l) => l.campaign_id === c.id && l.phone === '+91' + d)) { out.repeats++; continue; }
        db.leads.push({ id: crypto.randomUUID(), campaign_id: c.id, institute_id: c.institute_id, name: r.name, phone: '+91' + d,
          extra: r.extra || {}, amount_due: r.amount_due, assigned_seat_id: null, status: 'new' });
        out.added++;
      }
      if (c.share_mode === 'equal') shareRoundRobin(c);
      return json(200, [out]);
    },
    admin_set_campaign_members: (u, a) => {
      if (!adminSeat(u)) return notAdmin();
      const c = campaignOf(u, a.p_campaign);
      if (!c) return notFound();
      const want = [...new Set(a.p_seats || [])];
      if (want.some((id) => !db.seats.some((s) => s.id === id && s.institute_id === c.institute_id && s.status === 'active'))) {
        return pgErr(400, '22023', 'a chosen caller is not an active seat of this institute');
      }
      db.members = db.members.filter((m) => m.campaign_id !== c.id).concat(want.map((seat_id) => ({ campaign_id: c.id, seat_id })));
      db.leads.filter((l) => l.campaign_id === c.id && l.assigned_seat_id && !want.includes(l.assigned_seat_id) && isOpen(l))
        .forEach((l) => { l.assigned_seat_id = null; });
      if (c.share_mode === 'equal') shareRoundRobin(c);
      return json(200, want.length);
    },
    admin_share_leads: (u, a) => {
      if (!adminSeat(u)) return notAdmin();
      const c = campaignOf(u, a.p_campaign);
      if (!c) return notFound();
      c.share_mode = a.p_mode;
      if (a.p_mode === 'equal') return json(200, shareRoundRobin(c));
      let n = 0;
      db.leads.filter((l) => l.campaign_id === c.id && l.status === 'new' && l.assigned_seat_id).forEach((l) => { l.assigned_seat_id = null; n++; });
      return json(200, n);
    },
    admin_campaign_detail: (u, a) => {
      if (!adminSeat(u)) return notAdmin();
      const c = campaignOf(u, a.p_campaign);
      if (!c) return notFound();
      const row = campaignRow(c);
      const leads = db.leads.filter((l) => l.campaign_id === c.id);
      const by = (st) => leads.filter((l) => l.status === st).length;
      return json(200, { ...c, call_type_key: row.call_type_key, call_type_label: row.call_type_label, script_name: null, script_live_version: null,
        leads: { total: leads.length, called: row.leads_called, open: row.leads_open, unassigned: row.leads_unassigned,
          new: by('new'), callback: by('callback'), promised: by('promised'), done: by('done'), wrong_number: by('wrong_number'), do_not_call: by('do_not_call') },
        calls_today: 0, results: [], amount_due_total: null, money_hidden: true,
        callers: row.callers.map((m) => {
          const mine = leads.filter((l) => l.assigned_seat_id === m.seat_id);
          return { ...m, status: 'active', leads: mine.length, open: mine.filter(isOpen).length, called: mine.filter((l) => l.status !== 'new').length, calls_today: 0 };
        }) });
    },
  });
  // /Phase A: campaigns

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
    if (!s || s.role !== 'admin') return json(200, []);
    // Its own sample campaign plus any campaign another block made (Campaigns tab, Home), as RLS would show them.
    const own = db.reports.campaigns.concat((db.campaigns || []).filter((c) => !db.reports.campaigns.some((x) => x.id === c.id)))
      .filter((c) => c.institute_id === s.institute_id).map((c) => ({ id: c.id, name: c.name, status: c.status }));
    return json(200, own);
  }
  // End of Phase A: reports.
  // Phase A.2: reports. The fee-ledger numbers of migration 20261025150000 (admin_fees_ledger,
  // admin_promises_ledger, admin_home_ledger) and promises_vs_payments (20261025130000) for institute A. Same
  // money rule as the block above: amounts only when db.reports.money is true. A test turns the ledger off with
  // db.ledgerReports.hasLedger = false (the pages then show what callers reported), sets the Home numbers in
  // db.ledgerReports.home, and links an Insights campaign to the ledger with db.ledgerReports.pvp[campaignId].
  db.ledgerReports = {
    hasLedger: true,
    home: { collected: { payments: 3, amount: 12500 }, promises_due_unpaid: { count: 2, amount: 9000 },
      released_today: { count: 0, idle: 0, inactive: 0, revoked: 0, admin: 0 } },
    pvp: {},
    // What the ledger shows for the sample promises (by parent name), and one promise the ledger closed.
    states: {
      'Parent Late': { ledger_state: 'part_paid', paid_amount: 4000, paid_on: null, paid_mode: null, lead_status: 'promised' },
      'Parent Today': { ledger_state: 'not_paid', paid_amount: 0, paid_on: null, paid_mode: null, lead_status: 'promised' },
      'Parent Later': { ledger_state: 'no_student', paid_amount: 0, paid_on: null, paid_mode: null, lead_status: 'promised' },
    },
    paid: { lead_id: crypto.randomUUID(), name: 'Parent Paid', extra: { Student: 'Meera', Class: '9-A' }, amount: 12000, days_late: 1,
      caller: 'Rep 2', ledger_state: 'paid', paid_amount: 12000, paid_on: 2, paid_mode: 'upi', lead_status: 'done' },
  };
  const ledgerMoney = (v) => (db.reports.money ? v : null);
  // admin_fees_ledger and admin_promises_ledger: owners, managers and accounts seats (can_read_ledger).
  const ledgerReader = (u, inst) => { const s = u && seatOf(u.id); return !!s && ['admin', 'accounts'].includes(s.role) && s.institute_id === inst; };
  Object.assign(RPC, {
    admin_fees_ledger: (u, a) => {
      if (!ledgerReader(u, a.p_institute)) return reportsDenied();
      if (!a.p_from || !a.p_to || a.p_from > a.p_to) return pgErr(400, '22023', 'the from date must be on or before the to date');
      const L = db.ledgerReports;
      const day = (n) => reportsDay(n);
      return json(200, {
        from: a.p_from, to: a.p_to, campaign_id: a.p_campaign || null, today: day(0), money_hidden: !db.reports.money,
        has_ledger: L.hasLedger, linked_leads: L.hasLedger ? 180 : 0,
        due_now: { students: 150, amount: ledgerMoney(2700000) },
        collected: { payments: 4, reversed: 1, total: ledgerMoney(18000),
          by_mode: [{ mode: 'bank', payments: 1, amount: ledgerMoney(10000) }, { mode: 'cash', payments: 1, amount: ledgerMoney(2000) },
            { mode: 'upi', payments: 2, amount: ledgerMoney(6000) }],
          by_day: [{ day: day(3), payments: 1, amount: ledgerMoney(5000) }, { day: day(2), payments: 1, amount: ledgerMoney(10000) },
            { day: day(1), payments: 1, amount: ledgerMoney(2000) }, { day: day(0), payments: 1, amount: ledgerMoney(1000) }] },
        promised: { leads: 2, amount: ledgerMoney(11000) },
        broken: { leads: 6, part_paid: 2, amount: ledgerMoney(54000) },
        promises_paid: { leads: 1 },
      });
    },
    admin_promises_ledger: (u, a) => {
      if (!ledgerReader(u, a.p_institute)) return reportsDenied();
      const L = db.ledgerReports;
      const rows = db.reports.promises.map((p) => Object.assign({}, p, L.states[p.name] || {})).concat([L.paid]);
      return json(200, rows.map((p) => ({ ...p, amount: ledgerMoney(p.amount), paid_amount: ledgerMoney(p.paid_amount),
        paid_on: typeof p.paid_on === 'number' ? reportsDay(p.paid_on) : p.paid_on, promised_date: reportsDay(p.days_late),
        promised_on: reportsDay(p.days_late + 5), student_id: p.ledger_state === 'no_student' ? null : crypto.randomUUID(),
        seat_id: null, campaign_id: reportsCampaign, campaign: 'Oct fees', next_call_at: null, money_hidden: !db.reports.money }))
        .sort((x, y) => (x.promised_date < y.promised_date ? -1 : x.promised_date > y.promised_date ? 1 : 0)));
    },
    admin_home_ledger: (u, a) => {
      const s = u && seatOf(u.id);
      if (!s || s.role !== 'admin') return pgErr(403, '42501', 'only an admin of this institute can see this');
      if (!['today', 'yesterday', 'week'].includes(a.p_day)) return pgErr(400, '22023', 'day must be today, yesterday or week');
      const L = db.ledgerReports;
      const h = L.home;
      return json(200, { day: a.p_day, from: reportsDay(0), to: reportsDay(0), money_hidden: !db.reports.money, has_ledger: L.hasLedger,
        collected: { payments: h.collected.payments, amount: ledgerMoney(h.collected.amount) },
        promises_due_unpaid: { count: h.promises_due_unpaid.count, amount: ledgerMoney(h.promises_due_unpaid.amount) },
        released_today: h.released_today });
    },
    promises_vs_payments: (u, a) => {
      const s = u && seatOf(u.id);
      if (!s || s.role !== 'admin') return pgErr(400, '42501', 'campaign not found');
      const p = db.ledgerReports.pvp[a.p_campaign];
      return json(200, p ? { ...p, campaign_id: a.p_campaign, money_hidden: !db.reports.money }
        : { campaign_id: a.p_campaign, grace_days: 2, promises: 0, kept: 0, part_paid: 0, broken: 0, waiting: 0, no_student: 0,
          promised_amount: null, paid_amount: null, money_hidden: true, rows: [] });
    },
  });
  // End of Phase A.2: reports.
  const ADMIN_EMPTY = ['admin_weekly_summary', 'admin_rep_progress', 'list_supervisor_notes'];
  // Simplify: a daily target from the Team tab's Edit panel (set_rep_target, 0004_admin_views.sql), kept in db.targets.
  db.targets = [];
  RPC.set_rep_target = (u, a) => {
    const s = u && seatOf(u.id);
    const x = db.seats.find((y) => y.id === a.p_seat);
    if (!s || s.role !== 'admin' || !x || x.institute_id !== s.institute_id) return pgErr(403, '42501', 'admin access needed');
    if (!['calls', 'connected_calls', 'talk_minutes'].includes(a.p_metric)) return pgErr(400, '22023', 'unknown metric');
    db.targets.push({ seat_id: a.p_seat, metric: a.p_metric, daily_target: a.p_daily_target });
    return json(200, null);
  };
  // Phase A: insights (canned answers in fake-insights.js)
  const insights = createFakeInsights(world, { requireAdmin, json, pgErr });
  Object.assign(RPC, insights.RPC);
  // /Phase A: insights

  // Phase A: scripts. The Scripts tab: typed scripts with pushbacks, the add-ons (db.features, all on by default,
  // like a trial), the AI usage and the ai-script-draft Edge Function (a canned draft from the fees template).
  // Same rules as 20261024100022_script_types_ai.sql, in short.
  const SCRIPT_TYPES = (() => {
    const common = [['no_answer', 'No answer'], ['busy', 'Busy'], ['wrong_number', 'Wrong number'], ['call_back_later', 'Call back later'], ['do_not_call', 'Do not call again']];
    const mk = (n, key, label, rs) => ({ id: '00000000-0000-4000-8000-00000000000' + n, key, label, sort_order: n * 10, active: true, built_in: true,
      results: rs.concat(common).map(([k, l, good]) => ({ key: k, label: l, counts_as_good: !!good })) });
    return [
      mk(1, 'sales', 'Sales', [['joined', 'Joined', 1], ['interested', 'Interested'], ['will_think', 'Will think'], ['not_interested', 'Not interested']]),
      mk(2, 'fees', 'Fees collection', [['paid', 'Paid', 1], ['will_pay_on', 'Will pay on date', 1], ['paid_part', 'Paid part', 1], ['already_paid', 'Says already paid'], ['refused', 'Refused']]),
      mk(4, 'admission', 'Admission enquiry', [['visit_booked', 'Visit booked', 1], ['form_sent', 'Form sent', 1], ['not_this_year', 'Not this year'], ['joined_elsewhere', 'Joined elsewhere']]),
    ];
  })();
  db.features = ['scripts', 'ai_drafts'];
  // Integration: one add-on list for every block. db.features is the default; db.ix.features[institute] (set by the
  // insights-extra tests) overrides it for one institute.
  const featuresOf = (inst) => (db.ix && db.ix.features && db.ix.features[inst]) || db.features;
  db.scripts = [];          // { id, institute_id, name, call_type_id, created_at }
  db.scriptVersions = [];   // { id, script_id, institute_id, version, steps, pushbacks, change_note, published, created_at }
  db.aiRequests = [];       // { institute_id, kind, ok }
  db.aiDraft = null;        // set by a test to change the canned draft
  const hasMarks = (list) => (list || []).some((x) => x && Array.isArray(x.check) && x.check.length > 0);
  const scriptRow = (sc) => {
    const vs = db.scriptVersions.filter((v) => v.script_id === sc.id).sort((a, b) => b.version - a.version);
    const live = vs.find((v) => v.published);
    const t = SCRIPT_TYPES.find((x) => x.id === sc.call_type_id);
    const latest = vs[0];
    return { id: sc.id, name: sc.name, call_type_id: sc.call_type_id || null, call_type_key: t ? t.key : null, call_type_label: t ? t.label : null,
      live_version: live ? live.version : null, live_version_id: live ? live.id : null, latest_version: latest ? latest.version : null,
      changed_at: latest ? latest.created_at : sc.created_at, used_in: [], calls: 0, good_calls: 0,
      check_marks: latest ? (latest.steps || []).filter((x) => x.check && x.check.length).length + (latest.pushbacks || []).filter((x) => x.check && x.check.length).length : 0 };
  };
  Object.assign(RPC, {
    my_features: (u) => { const s = u && seatOf(u.id); return json(200, s ? featuresOf(s.institute_id) : null); },
    admin_list_call_types: (u) => {
      const s = u && seatOf(u.id);
      if (!s || s.role !== 'admin') return pgErr(403, '42501', 'only an admin can manage call types');
      return json(200, SCRIPT_TYPES);
    },
    admin_list_scripts: (u) => {
      const s = u && seatOf(u.id);
      if (!s || s.role !== 'admin') return pgErr(403, '42501', 'only an admin can list scripts');
      return json(200, db.scripts.filter((x) => x.institute_id === s.institute_id).map(scriptRow).sort((a, b) => a.name.localeCompare(b.name)));
    },
    admin_ai_usage: (u) => {
      const s = u && seatOf(u.id);
      if (!s || s.role !== 'admin') return pgErr(403, '42501', 'only an admin can see AI usage');
      const used = db.aiRequests.filter((r) => r.institute_id === s.institute_id && r.kind === 'draft' && r.ok).length;
      return json(200, [{ used, monthly_limit: 20, month: new Date().toISOString().slice(0, 8) + '01', cost_usd: used * 0.0023 }]);
    },
    admin_save_script: (u, a) => {
      const s = u && seatOf(u.id);
      if (!s || s.role !== 'admin') return pgErr(403, '42501', 'only an admin can save scripts');
      if (!db.features.includes('scripts')) return pgErr(403, '42501', 'add Scripts to your plan to save scripts');
      let sc = a.p_script ? db.scripts.find((x) => x.id === a.p_script && x.institute_id === s.institute_id) : null;
      if (a.p_script && !sc) return pgErr(400, '22023', 'script not found');
      const typ = a.p_call_type || (sc && sc.call_type_id) || null;
      const t = SCRIPT_TYPES.find((x) => x.id === typ);
      if (a.p_publish) {
        if (!t) return pgErr(400, '22023', 'choose the call type before publishing');
        if (hasMarks(a.p_steps) || hasMarks(a.p_pushbacks)) return pgErr(400, '22023', 'the script still has "Check this" marks: check each one and remove it before publishing');
        const bad = (a.p_steps || []).find((x) => !(x.opts && x.opts.length) && !t.results.some((r) => r.key === x.result));
        if (bad) return pgErr(400, '22023', 'the ending "' + (bad.title || bad.id) + '" is not linked to a result');
      }
      const now = new Date().toISOString();
      if (!sc) { sc = { id: crypto.randomUUID(), institute_id: s.institute_id, created_at: now }; db.scripts.push(sc); }
      sc.name = a.p_name; sc.call_type_id = typ;
      const mine = db.scriptVersions.filter((v) => v.script_id === sc.id);
      const prev = mine.sort((x, y) => y.version - x.version)[0];
      if (a.p_publish) mine.forEach((v) => { v.published = false; });
      const v = { id: crypto.randomUUID(), script_id: sc.id, institute_id: s.institute_id, version: (prev ? prev.version : 0) + 1,
        steps: a.p_steps, pushbacks: a.p_pushbacks || (prev ? prev.pushbacks : []), change_note: a.p_change_note || '', published: !!a.p_publish, created_at: now };
      db.scriptVersions.push(v);
      return json(200, { script_id: sc.id, version_id: v.id, version: v.version });
    },
  });
  // The REST reads and the Edge Function of the Scripts tab. Returns null for any other request.
  function scriptsRoute(p, method, url, body, u, req) {
    if (p === '/rest/v1/script_versions' && method === 'GET') {
      const sid = (url.searchParams.get('script_id') || '').replace(/^eq\./, '');
      const s = u && seatOf(u.id);
      const rows = db.scriptVersions.filter((v) => v.script_id === sid && s && s.institute_id === v.institute_id && s.role === 'admin')
        .sort((a, b) => b.version - a.version);
      return json(200, rows);
    }
    if (p === '/functions/v1/ai-script-draft' && method === 'POST') {
      const s = u && seatOf(u.id);
      if (!s || s.role !== 'admin') return json(403, { error: 'Only an admin can use the AI script maker.' });
      if (!db.features.includes('ai_drafts')) return json(403, { error: 'Add AI drafts to your plan to use this.', code: 'no_feature' });
      const used = db.aiRequests.filter((r) => r.institute_id === s.institute_id && r.kind === 'draft' && r.ok).length;
      if (body.action === 'draft' && used >= 20) return json(429, { error: 'You have used all AI drafts for this month.', code: 'limit' });
      db.aiRequests.push({ institute_id: s.institute_id, kind: body.action, ok: true, brief: body.brief });
      let script;
      if (body.action === 'simplify') {
        script = JSON.parse(JSON.stringify(body.script));
        if (body.target && body.target.step) script.steps.find((x) => x.id === body.target.step).say[body.target.line] = 'Simpler: ' + body.target.step;
      } else {
        script = db.aiDraft || (() => {
          const t = require('../../web/js/script-templates.js').template('fees_reminder');
          t.steps.forEach((x) => delete x.check); t.pushbacks.forEach((x) => delete x.check);
          t.steps[1].say = ['This is {me} from the school office.', 'The fee of ₹18,000 is due on 31 Oct.'];
          t.steps[2].check = ['"₹9,000" is not in the facts you gave. Check it or remove it.'];
          return { name: 'Fees reminder Class 10', call_type: 'fees', steps: t.steps, pushbacks: t.pushbacks };
        })();
      }
      const n = db.aiRequests.filter((r) => r.institute_id === s.institute_id && r.kind === 'draft' && r.ok).length;
      return json(200, { script, model: 'claude-haiku-5-5', checks: { passed: true, failures: [], problems: [], marks: 1, score: { score: 96, label: 'Easy to read', long_lines: [] } },
        usage: { used: n, monthly_limit: 20 } });
    }
    return null;
  }
  // Phase A: scripts (end)
  // ---- Phase A: caller. Campaign calling (supabase/migrations/20261024100021_caller_screen.sql) ----
  // Empty unless a test calls addCampaign(), so every other test sees an institute without campaigns.
  // offline: save_call_result answers as if the network were down (the request is aborted).
  // db.campaigns and db.leads are shared with the campaigns block above; db.features with the scripts block.
  // db.callerScripts: scripts by id for the caller screen (the scripts block keeps db.scripts as a list).
  db.saved = []; db.callerScripts = {}; db.offline = false; db.presenceReports = [];
  // The published script of institute B (sheet mode): world.steps unless a test sets db.publishedSteps, and its pushbacks.
  db.publishedSteps = null; db.publishedPushbacks = [];
  // Members: addCampaign() campaigns carry c.members; campaigns made on the Campaigns tab use db.members.
  const membersOf = (c) => c.members || db.members.filter((m) => m.campaign_id === c.id).map((m) => m.seat_id);
  const memberOf = (u, c) => { const s = u && seatOf(u.id); return s && membersOf(c).includes(s.id) && ['running', 'paused'].includes(c.status) ? s : null; };
  const pgFail = (code, message) => pgErr(400, code, message);
  Object.assign(RPC, {
    my_campaigns: (u) => json(200, db.campaigns.filter((c) => memberOf(u, c)).map((c) => {
      const s = seatOf(u.id);
      const mine = db.leads.filter((l) => l.campaign_id === c.id && l.assigned_seat_id === s.id);
      return { campaign_id: c.id, name: c.name, status: c.status, call_type_key: c.type_key, call_type_label: c.type_label,
        script_id: c.script_id || null, start_date: null, end_date: null, daily_target: c.daily_target || null, call_hours: null,
        my_leads: mine.length, my_leads_due: mine.filter((l) => CampaignQueue.isDueNow(l, Date.now())).length, results: c.results || [] };
    })),
    my_call_queue: (u, a) => {
      const c = db.campaigns.find((x) => x.id === a.p_campaign);
      const s = c && memberOf(u, c);
      if (!s) return pgFail('42501', 'campaign not found');
      const today = (r) => new Date(r.saved_at).toDateString() === new Date().toDateString();
      return json(200, { campaign_id: c.id, status: c.status, share_mode: c.share_mode || 'equal', daily_target: c.daily_target || null,
        my_calls_today: db.saved.filter((r) => r.campaign_id === c.id && r.seat_id === s.id && today(r)).length,
        team_calls_today: db.saved.filter((r) => r.campaign_id === c.id && today(r)).length,
        leads: db.leads.filter((l) => l.campaign_id === c.id && l.assigned_seat_id === s.id && CampaignQueue.isOpen(l)) });
    },
    lead_money: (u, a) => {
      const l = db.leads.find((x) => x.id === a.p_lead);
      const s = u && seatOf(u.id);
      if (!l || !s || l.assigned_seat_id !== s.id) return pgFail('42501', 'lead not found');
      return json(200, [{ lead_id: l.id, amount_due: l.amount_due == null ? null : l.amount_due, promised_amount: l.promised_amount == null ? null : l.promised_amount, promised_date: l.promised_date || null, money_hidden: false }]);
    },
    next_free_lead: (u, a) => {
      const c = db.campaigns.find((x) => x.id === a.p_campaign);
      const s = c && memberOf(u, c);
      if (!s) return pgFail('42501', 'campaign not found');
      const l = db.leads.find((x) => x.campaign_id === c.id && !x.assigned_seat_id && CampaignQueue.isOpen(x));
      if (!l) return json(200, null);
      l.assigned_seat_id = s.id;
      return json(200, l.id);
    },
    // Integration: the campaign's script for a lead (20261024100026). c.scriptTest = { a: {version, steps},
    // b: {...} } runs a test: leads get A and B in turn, and keep theirs.
    campaign_script_version: (u, a) => {
      const c = db.campaigns.find((x) => x.id === a.p_campaign);
      const s = c && memberOf(u, c);
      if (!s) return pgFail('42501', 'campaign not found');
      const sc = c.script_id && db.callerScripts[c.script_id];
      if (!sc || !featuresOf(s.institute_id).includes('scripts')) return json(200, []);
      let arm = null, v = sc;
      if (c.scriptTest && a.p_lead) {
        const arms = c.scriptTest.arms = c.scriptTest.arms || {};
        arm = arms[a.p_lead] || (Object.keys(arms).length % 2 ? 'b' : 'a');
        arms[a.p_lead] = arm;
        v = c.scriptTest[arm];
      }
      return json(200, [{ script_id: sc.id, script_name: sc.name || 'Script', version: v.version, steps: v.steps, test_id: arm ? 'test-1' : null, arm, pushbacks: v.pushbacks || [] }]);
    },
    // Integration: presence for the admin Home tab (20261024100023), kept for tests.
    report_presence: (u, a) => {
      const s = u && seatOf(u.id);
      if (!s) return pgFail('42501', 'no active seat for this login');
      db.presenceReports.push({ seat_id: s.id, on_call: !!a.p_on_call, phone_ok: a.p_phone_ok !== false });
      return json(200, null);
    },
    save_call_result: (u, a) => {
      const s = u && seatOf(u.id);
      if (!s) return pgFail('42501', 'no active seat for this login');
      const dup = db.saved.find((r) => r.seat_id === s.id && r.p_client_record_id === a.p_client_record_id);
      if (dup) return json(200, { outcome_id: dup.id, duplicate: true, lead_updated: false });
      const l = db.leads.find((x) => x.id === a.p_lead);
      const c = l && db.campaigns.find((x) => x.id === l.campaign_id);
      if (!l || !c || !(l.assigned_seat_id === s.id || membersOf(c).includes(s.id))) return pgFail('42501', 'lead not found');
      const r = (c.results || []).find((x) => x.key === a.p_result_key);
      if (!r) return pgFail('23514', 'result ' + a.p_result_key + ' is not a result of this campaign\'s call type');
      if (r.needs_date && !a.p_promised_date) return pgFail('23514', r.label + ' needs a date');
      if (r.needs_amount && a.p_amount == null) return pgFail('23514', r.label + ' needs an amount');
      if (r.needs_reason && !String(a.p_reason || '').trim()) return pgFail('23514', r.label + ' needs a reason');
      const row = Object.assign({ id: crypto.randomUUID(), seat_id: s.id, campaign_id: c.id, saved_at: new Date().toISOString() }, a);
      db.saved.push(row);
      const updated = l.assigned_seat_id === s.id;
      if (updated) Object.assign(l, CampaignQueue.applyResult(l, r, { date: a.p_promised_date, nextCallAt: a.p_next_call_at ? Date.parse(a.p_next_call_at) : null,
        waConsent: a.p_consent_whatsapp, note: a.p_note }, Date.now()), r.needs_amount && r.needs_date ? { promised_amount: a.p_amount } : {});
      return json(200, { outcome_id: row.id, duplicate: false, lead_updated: updated, lead_status: updated ? l.status : null });
    },
  });
  /* A campaign for the given seats. results: the button list (my_campaigns shape); leads: lead rows (assigned_seat_id
     set, money in amount_due). Returns the campaign. */
  function addCampaign(c) {
    const full = Object.assign({ id: crypto.randomUUID(), status: 'running', members: [], results: [], share_mode: 'equal' }, c);
    db.campaigns.push(full);
    (c.leads || []).forEach((l) => db.leads.push(Object.assign({ id: crypto.randomUUID(), campaign_id: full.id, status: 'new', next_call_at: null,
      extra: {}, consent_whatsapp: false, created_at: new Date().toISOString(), calls: 0 }, l)));
    return full;
  }
  // ---- end Phase A: caller ----
  // Phase A.2: caller. Open campaigns (20261025130000_ledger_open_campaigns.sql): every active seat of the
  // institute may work a running or paused campaign with open_to_all; my_campaigns has the new columns
  // (call_type_id, share_mode, open_to_all, class_label, board, is_member, pool_leads_due); next_free_lead hands out
  // unassigned leads, due follow-ups first (oldest next_call_at), then new leads (oldest first); lead_ledger reads
  // db.ledger[student_id] = { balance_due_now, balance_total, last_payment_amount, last_payment_on, last_payment_mode }
  // for the caller of the lead only; my_common_answers answers db.commonAnswers, or is missing (PGRST202) when null.
  db.ledger = {}; db.commonAnswers = null;
  const a2Seat = (u, c) => {
    const s = u && seatOf(u.id);
    if (!s || !c || !['running', 'paused'].includes(c.status)) return null;
    if (membersOf(c).includes(s.id)) return s;
    return c.open_to_all === true && (!c.institute_id || c.institute_id === s.institute_id) ? s : null;
  };
  // The 0021 stand-ins check membership; for an open campaign the seat is counted as a member for that one call.
  const a2AsMember = (fn) => (u, a) => {
    const c = db.campaigns.find((x) => x.id === a.p_campaign);
    const s = a2Seat(u, c);
    if (!s || !Array.isArray(c.members) || c.members.includes(s.id)) return fn(u, a);
    c.members.push(s.id);
    try { return fn(u, a); } finally { c.members = c.members.filter((id) => id !== s.id); }
  };
  const a2Free = (c) => {
    const now = Date.now();
    const pool = db.leads.filter((l) => l.campaign_id === c.id && !l.assigned_seat_id && CampaignQueue.isDueNow(l, now));
    const t = (v) => (v ? Date.parse(v) : 0);
    const due = pool.filter((l) => l.next_call_at).sort((x, y) => t(x.next_call_at) - t(y.next_call_at));
    const fresh = pool.filter((l) => !l.next_call_at).sort((x, y) => t(x.created_at) - t(y.created_at));
    return due.concat(fresh);
  };
  const a2Base = { my_call_queue: RPC.my_call_queue, campaign_script_version: RPC.campaign_script_version };
  Object.assign(RPC, {
    my_campaigns: (u) => json(200, db.campaigns.filter((c) => a2Seat(u, c)).map((c) => {
      const s = seatOf(u.id);
      const mine = db.leads.filter((l) => l.campaign_id === c.id && l.assigned_seat_id === s.id);
      return { campaign_id: c.id, name: c.name, status: c.status, call_type_id: c.type_id || null, call_type_key: c.type_key, call_type_label: c.type_label,
        script_id: c.script_id || null, start_date: null, end_date: null, daily_target: c.daily_target || null, call_hours: null,
        share_mode: c.share_mode || 'equal', open_to_all: c.open_to_all === true, class_label: c.class_label || null, board: c.board || null,
        is_member: membersOf(c).includes(s.id), my_leads: mine.length, my_leads_due: mine.filter((l) => CampaignQueue.isDueNow(l, Date.now())).length,
        pool_leads_due: c.open_to_all === true || c.share_mode === 'next_free' ? a2Free(c).length : 0, results: c.results || [] };
    })),
    my_call_queue: a2AsMember((u, a) => {
      const res = a2Base.my_call_queue(u, a);
      const c = db.campaigns.find((x) => x.id === a.p_campaign);
      if (res.status !== 200 || !c) return res;
      const body = JSON.parse(res.body);
      // 20261025180000: the campaign's fees_due_by, and each lead's due_date (fees_due_by, else the test's lead.due_date).
      return json(200, Object.assign(body, { open_to_all: c.open_to_all === true, class_label: c.class_label || null, board: c.board || null,
        fees_due_by: c.fees_due_by || null,
        leads: body.leads.map((l) => {
          const row = db.leads.find((x) => x.id === l.id) || {};
          return Object.assign({ student_id: null }, l, { due_date: c.fees_due_by || row.due_date || null });
        }) }));
    }),
    campaign_script_version: a2AsMember((u, a) => a2Base.campaign_script_version(u, a)),
    next_free_lead: (u, a) => {
      const c = db.campaigns.find((x) => x.id === a.p_campaign);
      const s = a2Seat(u, c);
      if (!s) return pgFail('42501', 'campaign not found');
      const l = a2Free(c)[0];
      if (!l) return json(200, []);
      l.assigned_seat_id = s.id;
      return json(200, [{ lead_id: l.id, campaign_id: c.id, name: l.name, phone: l.phone, extra: l.extra, status: l.status, next_call_at: l.next_call_at, promised_date: l.promised_date || null }]);
    },
    lead_ledger: (u, a) => {
      const l = db.leads.find((x) => x.id === a.p_lead);
      const s = u && seatOf(u.id);
      if (!l || !s || l.assigned_seat_id !== s.id) return pgFail('42501', 'lead not found');
      const g = l.student_id ? db.ledger[l.student_id] || {} : null;
      return json(200, [{ lead_id: l.id, student_id: l.student_id || null, balance_due_now: g ? g.balance_due_now ?? null : null, balance_total: g ? g.balance_total ?? null : null,
        last_payment_amount: g ? g.last_payment_amount ?? null : null, last_payment_on: g ? g.last_payment_on || null : null, last_payment_mode: g ? g.last_payment_mode || null : null, money_hidden: false }]);
    },
    my_common_answers: (u) => {
      if (!db.commonAnswers) return pgErr(404, 'PGRST202', 'fake backend has no function my_common_answers');
      return u && seatOf(u.id) ? json(200, db.commonAnswers) : pgFail('42501', 'no active seat for this login');
    },
  });
  // ---- end Phase A.2: caller ----
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
    // Integration: the built-in types are the Scripts block's SCRIPT_TYPES (same ids, so the Campaigns, Scripts and
    // Settings tabs all see one list); the Settings tab adds the institute's own types here.
    const COMMON_KEYS = COMMON.map((r) => r.key);
    db.callTypes = SCRIPT_TYPES.map((t) => ({ id: t.id, key: t.key, label: t.label, sort_order: t.sort_order, active: true, built_in: true,
      own: t.results.filter((r) => !COMMON_KEYS.includes(r.key)).map((r) => ({ id: crypto.randomUUID(), key: r.key, label: r.label, common: false, built_in: true,
        needs_date: /_on$/.test(r.key), needs_amount: r.key === 'paid' || r.key === 'paid_part', counts_as_good: !!r.counts_as_good })) }));
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
          campaigns: x.role === 'accounts' ? [] : campaignsOf(x.id).map((c) => ({ id: c.id, name: c.name, status: c.status })),
          calls_today: callsToday(x.id), calls_target: null,
          // 20261025180000: an Accounts seat is not a caller (no campaigns, no "now" status).
          now_status: x.status === 'active' && x.role !== 'accounts' ? (db.presence[x.id] || { status: 'not_started' }) : null })));
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
    // Add only what no other block defines, except the call type functions: Settings adds and removes types, so
    // its versions replace the read-only lists of the Campaigns and Scripts blocks.
    const OWN = ['admin_list_call_types', 'admin_upsert_call_type', 'admin_upsert_call_type_result'];
    Object.keys(mine).forEach((k) => { if (!RPC[k] || OWN.includes(k)) RPC[k] = mine[k]; });
    // GET /rest/v1/campaigns for the Callers tab (admins read their institute's campaigns).
    function route(p, method, url, u) {
      if (p !== '/rest/v1/campaigns' || method !== 'GET') return null;
      if (!url.searchParams.get('institute_id')) return null;   // the Reports filter reads without it (reportsRoute)
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

  // Phase A.2: admin. The central template library and common answers (20261025140000_template_library.sql),
  // read from supabase/templates/*.json; institute fills of common answers; platform admins (db.platformAdmins:
  // user ids, empty unless a test adds one); open campaigns with class / board tags and "Return follow-ups to the
  // pool after N hours" (the new admin_create_campaign / admin_update_campaign arguments of
  // 20261025130000_ledger_open_campaigns.sql); "Back to pool" (admin_release_leads) and the Accounts role.
  // Same inputs, answer shapes and checks as the migrations, in short. Wraps the older blocks' functions.
  const phaseA2Admin = (() => {
    const fs = require('node:fs');
    const path = require('node:path');
    const readJson = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'templates', f), 'utf8'));
    db.templates = readJson('library.json').map((t) => ({ key: t.key, name: t.name, call_type: t.call_type, audience: t.audience || null,
      about: t.about || null, class_labels: (t.tags && t.tags.class_labels) || [], boards: (t.tags && t.tags.boards) || [],
      language: t.language || 'en', steps: t.steps, pushbacks: t.pushbacks || [], version: 1, active: true, updated_at: new Date().toISOString() }));
    db.commonAnswers = readJson('common_answers.json').map((a) => ({ key: a.key, label: a.label, answer: a.answer, fallback: a.fallback || null,
      result: a.result || null, checks: a.check || [], tags: a.tags || [], active: true, updated_at: new Date().toISOString() }));
    db.answerFills = {};        // institute id -> { answer key: text }
    db.platformAdmins = [];     // user ids of the Vector team
    const BOARDS = ['CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other'];
    const board = (v) => { const s = String(v || '').trim().replace(/\s+board$/i, '').toLowerCase(); return BOARDS.find((b) => b.toLowerCase() === s) || null; };
    const isPA = (u) => !!u && db.platformAdmins.includes(u.id);
    const seat = (u) => u && seatOf(u.id);
    const adminOf = (u) => { const s = seat(u); return s && s.role === 'admin' ? s : null; };
    const deny = (m) => pgErr(403, '42501', m);
    const bad = (m) => pgErr(400, '22023', m);
    const marks = (list) => (list || []).filter((x) => x && Array.isArray(x.check) && x.check.length).length;
    const typeOf = (key) => SCRIPT_TYPES.find((t) => t.key === key) || (db.callTypes || []).find((t) => t.key === key && t.built_in) || null;
    const body = (res) => { try { return JSON.parse(res.body); } catch (e) { return null; } };
    const prev = { create: RPC.admin_create_campaign, update: RPC.admin_update_campaign, role: RPC.admin_set_seat_role };

    Object.assign(RPC, {
      is_platform_admin: (u) => json(200, isPA(u)),
      list_script_templates: (u, a) => {
        if (!isPA(u) && !seat(u)) return deny('sign in with an active seat to see the template library');
        let b = null;
        if (a.p_board && String(a.p_board).trim()) { b = board(a.p_board); if (!b) return bad('board must be CBSE, ICSE, State, IB, IGCSE or Other'); }
        const cls = String(a.p_class_label || '').trim().toLowerCase();
        const all = !!a.p_include_inactive && isPA(u);
        const order = (k) => { const t = typeOf(k); return t ? t.sort_order : 10000; };
        return json(200, db.templates
          .filter((t) => (t.active || all) && (!a.p_call_type || t.call_type === a.p_call_type) && (!a.p_language || t.language === a.p_language)
            && (!cls || !t.class_labels.length || t.class_labels.some((c) => c.toLowerCase() === cls)) && (!b || !t.boards.length || t.boards.includes(b)))
          .sort((x, y) => order(x.call_type) - order(y.call_type) || x.name.localeCompare(y.name) || x.language.localeCompare(y.language))
          .map((t) => ({ ...t, call_type_label: (typeOf(t.call_type) || {}).label || null, check_marks: marks(t.steps) + marks(t.pushbacks) })));
      },
      my_common_answers: (u) => {
        const s = seat(u);
        if (!s) return deny('no active seat for this login');
        const fills = db.answerFills[s.institute_id] || {};
        // The library's own order (sort_order in the database: the most asked first). A test may set
        // db.commonAnswers to rows in the answer shape (check, filled) instead of the table shape (checks, active).
        return json(200, db.commonAnswers.filter((x) => x.active !== false).map((x) => {
          const fill = fills[x.key] || null;
          const checks = x.checks || x.check || [];
          return { key: x.key, label: x.label, answer: fill || x.answer, tags: x.tags || [], fallback: x.fallback || null, result: x.result || null,
            check: checks, filled: typeof x.filled === 'boolean' ? x.filled : !checks.length || !!fill };
        }));
      },
      admin_fill_common_answer: (u, a) => {
        const s = adminOf(u);
        if (!s) return deny('only an owner or manager can fill in common answers');
        const x = db.commonAnswers.find((y) => y.key === a.p_key && y.active);
        if (!x) return bad('that common answer was not found');
        if (!x.checks.length) return bad('this answer needs no facts from your institute');
        const text = String(a.p_answer || '').replace(/\s+/g, ' ').trim();
        const fills = db.answerFills[s.institute_id] = db.answerFills[s.institute_id] || {};
        if (!text) { delete fills[x.key]; return json(200, false); }
        if (text.length > 600) return bad('keep the answer to 600 characters');
        fills[x.key] = text;
        return json(200, true);
      },
      platform_upsert_template: (u, a) => {
        if (!isPA(u)) return deny('only the Vector team can change the template library');
        const key = String(a.p_key || '').trim().toLowerCase();
        if (!/^[a-z][a-z0-9_]{1,59}$/.test(key)) return bad('the key is 2 to 60 lowercase letters, numbers or _');
        if (!typeOf(a.p_call_type)) return bad('the call type must be a built-in type (sales, fees, admission …)');
        if (!Array.isArray(a.p_steps) || !a.p_steps.length || a.p_steps.length > 30) return bad('a template needs 1 to 30 steps');
        const boards = [];
        for (const x of a.p_boards || []) { const b = board(x); if (!b) return bad('board must be CBSE, ICSE, State, IB, IGCSE or Other'); if (!boards.includes(b)) boards.push(b); }
        const row = { key, name: String(a.p_name || '').trim(), call_type: a.p_call_type, audience: a.p_audience || null, about: a.p_about || null,
          class_labels: [...new Set((a.p_class_labels || []).map((c) => String(c).trim()).filter(Boolean))], boards, language: a.p_language || 'en',
          steps: a.p_steps, pushbacks: a.p_pushbacks || [], active: a.p_active !== false, updated_at: new Date().toISOString() };
        const old = db.templates.find((t) => t.key === key);
        if (!old) { db.templates.push({ ...row, version: 1 }); return json(200, 1); }
        const changed = JSON.stringify([old.steps, old.pushbacks, old.name, old.call_type, old.language]) !== JSON.stringify([row.steps, row.pushbacks, row.name, row.call_type, row.language]);
        Object.assign(old, row, { version: old.version + (changed ? 1 : 0) });
        return json(200, old.version);
      },
      platform_upsert_common_answer: (u, a) => {
        if (!isPA(u)) return deny('only the Vector team can change the template library');
        const key = String(a.p_key || '').trim().toLowerCase();
        if (!/^[a-z][a-z0-9_]{1,59}$/.test(key)) return bad('the key is 2 to 60 lowercase letters, numbers or _');
        if (!String(a.p_label || '').trim() || !String(a.p_answer || '').trim()) return bad('the label and the answer are needed');
        const row = { key, label: a.p_label.trim(), answer: a.p_answer.trim(), fallback: a.p_fallback || null, result: a.p_result || null,
          checks: (a.p_checks || []).filter(Boolean), tags: (a.p_tags || []).map((t) => String(t).toLowerCase()), active: a.p_active !== false, updated_at: new Date().toISOString() };
        const old = db.commonAnswers.find((x) => x.key === key);
        if (old) Object.assign(old, row); else db.commonAnswers.push(row);
        return json(200, null);
      },
      // Open campaigns: the new arguments. An open campaign shares "next free" and starts without members.
      admin_create_campaign: (u, a) => {
        if (a.p_board && !board(a.p_board)) return bad('board must be CBSE, ICSE, State, IB, IGCSE or Other');
        if (a.p_class_label && String(a.p_class_label).trim().length > 20) return bad('class must be 1 to 20 characters');
        const res = prev.create(u, a);
        if (res.status !== 200) return res;
        const c = db.campaigns.find((x) => x.id === body(res));
        const open = a.p_open_to_all !== false;
        Object.assign(c, { open_to_all: open, class_label: String(a.p_class_label || '').trim() || null, board: board(a.p_board),
          share_mode: a.p_share_mode || (open ? 'next_free' : 'equal'), release_after_hours: 24 });
        return res;
      },
      admin_update_campaign: (u, a) => {
        const s = adminOf(u);
        const c = s && db.campaigns.find((x) => x.id === a.p_campaign && x.institute_id === s.institute_id);
        if (!c) return prev.update(u, a);
        if (a.p_board && !board(a.p_board)) return bad('board must be CBSE, ICSE, State, IB, IGCSE or Other');
        if (a.p_release_after_hours !== undefined && a.p_release_after_hours !== null
          && !(Number.isInteger(a.p_release_after_hours) && a.p_release_after_hours >= 1 && a.p_release_after_hours <= 720)) {
          return bad('release after hours must be 1 to 720');
        }
        const open = a.p_open_to_all === undefined || a.p_open_to_all === null ? c.open_to_all === true : !!a.p_open_to_all;
        let startOpen = false;
        if (open && a.p_status === 'running' && c.status === 'draft' && c.status !== 'closed') {
          if (!db.leads.some((l) => l.campaign_id === c.id)) return bad('add leads before you start');
          startOpen = true;
        }
        const res = prev.update(u, startOpen ? { ...a, p_status: null } : a);
        if (res.status !== 200) return res;
        if (startOpen) c.status = 'running';
        if (a.p_open_to_all !== undefined && a.p_open_to_all !== null) c.open_to_all = !!a.p_open_to_all;
        if (a.p_class_label !== undefined && a.p_class_label !== null) c.class_label = String(a.p_class_label).trim() || null;
        if (a.p_board !== undefined && a.p_board !== null) c.board = board(a.p_board);
        if (a.p_release_after_hours) c.release_after_hours = a.p_release_after_hours;
        return res;
      },
      admin_release_leads: (u, a) => {
        const s = adminOf(u);
        if (!s) return deny('only an owner or manager can send leads back to the pool');
        const from = db.seats.find((x) => x.id === a.p_seat && x.institute_id === s.institute_id);
        if (!from) return deny('caller not found');
        let n = 0;
        db.leads.filter((l) => l.assigned_seat_id === from.id && isOpen(l) && !l.do_not_call && (!a.p_campaign || l.campaign_id === a.p_campaign)).forEach((l) => {
          const c = db.campaigns.find((x) => x.id === l.campaign_id);
          if (!c || c.status === 'closed' || c.institute_id !== s.institute_id) return;
          l.assigned_seat_id = null;
          n++;
        });
        return json(200, n);
      },
      admin_set_seat_role: (u, a) => {
        if (a.p_role !== 'accounts') return prev.role(u, a);
        const res = prev.role(u, { ...a, p_role: 'manager' });
        if (res.status !== 200) return res;
        const x = db.seats.find((y) => y.id === a.p_seat);
        Object.assign(x, { role: 'accounts', access_role: 'accounts', can_see_money: false });
        return res;
      },
    });

    // REST: the campaigns of the Callers tab with open_to_all, the common answers table (Library view) and the
    // count of a caller's open leads ("Back to pool"). Returns a full fulfill object, or null.
    function route(p, method, url, u, body) {
      const eq = (k) => (url.searchParams.get(k) || '').replace(/^eq\./, '');
      if (p === '/rest/v1/campaigns' && method === 'GET' && url.searchParams.get('institute_id')) {
        const s = adminOf(u);
        const inst = eq('institute_id');
        const not = (url.searchParams.get('status') || '').replace(/^neq\./, '');
        const rows = s && s.institute_id === inst ? db.campaigns.filter((c) => c.institute_id === inst && c.status !== not) : [];
        return json(200, rows.map((c) => ({ id: c.id, name: c.name, status: c.status, open_to_all: c.open_to_all === true })).sort((x, y) => x.name.localeCompare(y.name)));
      }
      // The seat-admin Edge Function's invite (supabase/functions/seat-admin, invite_seat): roles rep, admin
      // (a manager) and accounts (owners only), within the seat limit (10 here).
      if (p === '/functions/v1/seat-admin' && method === 'POST' && body && body.action === 'invite') {
        const s = adminOf(u);
        const role = { rep: 'rep', caller: 'rep', admin: 'admin', manager: 'admin', accounts: 'accounts' }[body.role];
        if (!s || s.institute_id !== body.institute) return json(403, { error: 'You are not allowed to do that.' });
        if (!role || !body.email || !body.label) return json(400, { error: 'Give the institute, a valid email, a label and a role.' });
        const owner = (s.access_role || 'owner') === 'owner';
        if (role === 'accounts' && !owner) return json(403, { error: 'Only an owner can add an Accounts seat.' });
        if (db.seats.filter((x) => x.institute_id === s.institute_id && x.status !== 'revoked').length >= 10) return json(400, { error: 'all 10 seats are in use' });
        const seat = { id: crypto.randomUUID(), institute_id: s.institute_id, user_id: null, label: body.label, role, status: 'invited',
          access_role: role === 'rep' ? 'caller' : role === 'admin' ? 'manager' : 'accounts', invite_email: String(body.email).toLowerCase() };
        db.seats.push(seat);
        return json(200, { ok: true, seat_id: seat.id, email_sent: true });
      }
      if (p === '/rest/v1/common_answers' && method === 'GET') {
        return json(200, isPA(u) || seat(u) ? db.commonAnswers.slice().sort((x, y) => x.label.localeCompare(y.label)) : []);
      }
      if (p === '/rest/v1/leads' && method === 'HEAD') {
        const s = adminOf(u);
        const statuses = (url.searchParams.get('status') || '').replace(/^in\.\(|\)$/g, '').split(',').filter(Boolean);
        const camps = (url.searchParams.get('campaign_id') || '').startsWith('in.')
          ? url.searchParams.get('campaign_id').replace(/^in\.\(|\)$/g, '').split(',').filter(Boolean) : null;
        const n = !s ? 0 : db.leads.filter((l) => l.institute_id === s.institute_id && l.assigned_seat_id === eq('assigned_seat_id')
          && (!statuses.length || statuses.includes(l.status)) && !l.do_not_call
          && (camps ? camps.includes(l.campaign_id) : !eq('campaign_id') || l.campaign_id === eq('campaign_id'))).length;
        return { status: 200, body: '', headers: { 'content-range': '*/' + n, 'access-control-expose-headers': 'content-range' } };
      }
      return null;
    }
    return { route };
  })();
  // /Phase A.2: admin

  // Phase A: insights-extra. Weekly brief, script test and practice (migration 20261024100026). State is in
  // db.ix so a test can change it (for example take the Scripts add-on away). Functions another block already
  // defines are kept.
  const IX_CAMPAIGN = '7e570000-0000-4000-8000-000000000001';
  db.ix = {
    features: {},   // per-institute overrides of db.features (see featuresOf in the scripts block)
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
  const ixHas = (s) => !!s && featuresOf(s.institute_id).includes('scripts');
  const ixAdmin = (u) => { const s = ixSeat(u); return s && s.role === 'admin' ? s : null; };
  const IX_RPC = {
    my_features: (u) => { const s = ixSeat(u); return json(200, s ? featuresOf(s.institute_id) : null); },
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
      // Integration: a campaign lead (caller block) counts too: assigned to this seat, with consent on the lead.
      const cl = (db.leads || []).find((x) => x.id === body.lead_id);
      const lead = cl ? (s && cl.assigned_seat_id === s.id ? { consent: cl.consent_whatsapp === true } : null)
        : (s && s.id === world.seats.rep1 ? waLead(body.lead_id) : null);
      if (!s || !lead) return json(403, { error: 'This lead is not assigned to you.' });
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

  // Phase A.2: fees. A stand-in for the ledger functions of 20261025130000_ledger_open_campaigns.sql (the SQL
  // itself is tested in supabase/tests/ledger_test.sql): students, fee items, payments and reversals, balances,
  // the import, fees campaigns from the ledger, ledger_collected and promises_vs_payments, with the same
  // answer shapes and the role rules (readers: admins and Accounts; writers: owners and Accounts). Accounts
  // always see money; admins follow db.reports.money. An Accounts login is added only by fees.addAccounts().
  const fees = (() => {
    const F = { students: [], items: [], payments: [], calls: [], scripts: [] };
    db.fees = F;
    const FEES_TYPE = CALL_TYPES.find((t) => t.key === 'fees');
    const dayOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const today = () => dayOf(new Date());
    const shift = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return dayOf(d); };
    const isAcc = (s) => !!s && s.role === 'accounts';
    const reader = (u) => { const s = u && seatOf(u.id); return s && (s.role === 'admin' || isAcc(s)) ? s : null; };
    const manager = (u) => { const s = reader(u); return s && (isAcc(s) || (s.access_role || 'owner') === 'owner') ? s : null; };
    const moneyFor = (s) => isAcc(s) || !!db.reports.money;
    const denied = () => pgErr(403, '42501', 'only accounts and owners can change the ledger');
    const notReader = () => pgErr(403, '42501', 'only accounts, owners and managers can see the ledger');
    const bad = (m) => pgErr(400, '22023', m);
    const amountOf = (v) => { const n = Number(String(v === null || v === undefined ? '' : v).replace(/[₹,\s]/g, '')); return Number.isFinite(n) ? n : NaN; };
    const studentOf = (s, id) => F.students.find((x) => x.id === id && x.institute_id === s.institute_id) || null;
    const live = (p) => !p.reverses_id && !F.payments.some((r) => r.reverses_id === p.id);
    function balance(st, asOf) {
      const at = asOf || today();
      const items = F.items.filter((f) => f.student_id === st.id && !f.is_void);
      const pays = F.payments.filter((p) => p.student_id === st.id);
      const paid = pays.filter((p) => !p.reverses_id).reduce((t, p) => t + p.amount, 0) - pays.filter((p) => p.reverses_id).reduce((t, p) => t + p.amount, 0);
      // fees basics: each fee net of its live discounts (20261026110000_fee_plans_discounts.sql)
      const net = (f) => f.amount - Math.min(f.amount, (F.discounts || []).filter((d) => d.fee_item_id === f.id && !d.is_removed).reduce((t, d) => t + d.amount, 0));
      const total = items.reduce((t, f) => t + net(f), 0);
      const due = items.filter((f) => f.due_date <= at).reduce((t, f) => t + net(f), 0);
      const last = pays.filter(live).sort((a, b) => (b.paid_on + b.created_at).localeCompare(a.paid_on + a.created_at))[0] || null;
      return { total_fees: total, total_due_to_date: due, paid, balance_due_now: due - paid, balance_total: total - paid,
        last_payment_amount: last ? last.amount : null, last_payment_on: last ? last.paid_on : null, last_payment_mode: last ? last.mode : null,
        discounts: items.reduce((t, f) => t + f.amount - net(f), 0) };
    }
    const hide = (b, money) => (money ? b : { ...b, total_fees: null, total_due_to_date: null, paid: null, balance_due_now: null, balance_total: null, last_payment_amount: null, discounts: null });
    // Open fees leads of the student follow the balance; nothing due closes them.
    function syncLeads(st) {
      (db.leads || []).filter((l) => l.student_id === st.id && ['new', 'callback', 'promised'].includes(l.status)).forEach((l) => {
        const c = db.campaigns.find((x) => x.id === l.campaign_id);
        const due = balance(st, c && c.fees_due_by && c.fees_due_by > today() ? c.fees_due_by : today()).balance_due_now;
        l.amount_due = Math.max(0, due);
        if (due <= 0) { l.status = 'done'; l.next_call_at = null; }
      });
    }
    const newStudent = (inst, x) => {
      const st = { id: crypto.randomUUID(), institute_id: inst, admission_no: null, name: '', class_label: null, section: null, board: null,
        academic_year: null, parent_name: null, phone: null, alt_phone: null, status: 'active', source: 'import', admission_lead_id: null,
        created_at: new Date().toISOString(), ...x };
      F.students.push(st);
      return st;
    };
    const addItem = (st, head, amount, due, year) => {
      const f = { id: crypto.randomUUID(), institute_id: st.institute_id, student_id: st.id, head, amount, due_date: due, academic_year: year || st.academic_year,
        is_void: false, void_reason: null, voided_at: null, created_at: new Date().toISOString() };
      F.items.push(f);
      return f;
    };
    const addPayment = (st, x) => {
      const p = { id: crypto.randomUUID(), institute_id: st.institute_id, student_id: st.id, reference: null, note: null, reverses_id: null, opening: false,
        recorded_by: null, created_at: new Date().toISOString(), ...x };
      F.payments.push(p);
      return p;
    };
    // Two students of institute A: Aarav owes 7,000 now (12,000 due, 5,000 paid in cash); Diya has paid everything.
    const instA = world.institutes.a;
    const aarav = newStudent(instA, { admission_no: 'A101', name: 'Aarav Shah', class_label: '8', section: 'A', board: 'CBSE', academic_year: '2026-27',
      parent_name: 'Meena Shah', phone: '+919876500001' });
    addItem(aarav, 'Term 1 tuition', 12000, shift(-30));
    addItem(aarav, 'Term 2 tuition', 10000, shift(40));
    addPayment(aarav, { amount: 5000, paid_on: shift(-20), mode: 'cash', recorded_by: world.seats.admin });
    const diya = newStudent(instA, { admission_no: 'A102', name: 'Diya Rao', class_label: '9', section: 'B', board: 'ICSE', academic_year: '2026-27',
      parent_name: 'Ravi Rao', phone: '+919876500002' });
    addItem(diya, 'Term 1 tuition', 15000, shift(-30));
    addPayment(diya, { amount: 15000, paid_on: shift(-25), mode: 'upi', reference: 'UTR000111', recorded_by: world.seats.admin });
    F.calls.push({ outcome_id: crypto.randomUUID(), student_id: aarav.id, at: new Date(Date.now() - 2 * 864e5).toISOString(), campaign_id: null,
      campaign_name: 'Fees October', lead_id: null, result_key: 'will_pay', result_label: 'Will pay on date', promised_date: shift(3),
      promised_amount: 7000, caller: 'Rep 1', corrects_id: null, note: 'Will pay after salary' });
    F.scripts.push({ id: crypto.randomUUID(), institute_id: instA, name: 'Fees reminder', call_type_id: FEES_TYPE.id, script_versions: [{ published: true }] });
    // Kiran left the school this week after paying: not in the list of active students and owes nothing, but the
    // payments of the last days count in "Collected" (UPI, bank, cash, and one cash payment reversed).
    const kiran = newStudent(instA, { admission_no: 'A103', name: 'Kiran Left', class_label: '10', section: 'A', board: 'CBSE', academic_year: '2026-27',
      parent_name: 'Sunil Left', phone: '+919876500003', status: 'left' });
    addItem(kiran, 'Term 1 tuition', 18000, shift(-30));
    addPayment(kiran, { amount: 5000, paid_on: shift(-3), mode: 'upi', reference: 'UTR000301', recorded_by: world.seats.admin });
    addPayment(kiran, { amount: 10000, paid_on: shift(-2), mode: 'bank', reference: 'UTR000302', recorded_by: world.seats.admin });
    addPayment(kiran, { amount: 2000, paid_on: shift(-1), mode: 'cash', recorded_by: world.seats.admin });
    const wrong = addPayment(kiran, { amount: 3000, paid_on: shift(-1), mode: 'cash', recorded_by: world.seats.admin });
    addPayment(kiran, { amount: 3000, paid_on: shift(-1), mode: 'cash', reverses_id: wrong.id, note: 'Entered twice', recorded_by: world.seats.admin });
    addPayment(kiran, { amount: 1000, paid_on: shift(0), mode: 'upi', reference: 'UTR000303', recorded_by: world.seats.admin });

    const studentRow = (st, money) => { const b = hide(balance(st), money); delete b.discounts; return { student_id: st.id, admission_no: st.admission_no, name: st.name, class_label: st.class_label, section: st.section,
      board: st.board, academic_year: st.academic_year, parent_name: st.parent_name, phone: st.phone, alt_phone: st.alt_phone, status: st.status,
      source: st.source, ...b, money_hidden: !money }; };
    const label = (seatId) => (db.seats.find((x) => x.id === seatId) || {}).label || null;

    const pvpReports = RPC.promises_vs_payments;
    Object.assign(RPC, {
      accounts_students: (u, a) => {
        const s = reader(u);
        if (!s) return notReader();
        const f = a.p_filters || {};
        const q = String(f.search || '').trim().toLowerCase();
        const qd = q.replace(/\D/g, '');
        const sts = f.status || 'active';
        const list = F.students.filter((st) => st.institute_id === s.institute_id
          && (sts === 'all' || st.status === sts)
          && (!f.class_label || String(st.class_label || '').toLowerCase() === String(f.class_label).toLowerCase())
          && (!f.board || st.board === f.board)
          && (!f.academic_year || st.academic_year === f.academic_year)
          && (!f.only_due || balance(st).balance_due_now > 0)
          && (!q || st.name.toLowerCase().includes(q) || String(st.admission_no || '').toLowerCase().startsWith(q)
            || String(st.parent_name || '').toLowerCase().includes(q) || (qd.length >= 4 && (String(st.phone || '').includes(qd) || String(st.alt_phone || '').includes(qd)))))
          .sort((x, y) => String(x.class_label).localeCompare(String(y.class_label), 'en', { numeric: true }) || String(x.section).localeCompare(String(y.section)) || x.name.localeCompare(y.name));
        const money = moneyFor(s);
        const off = Number(f.offset) || 0;
        return json(200, list.slice(off, off + (Number(f.limit) || 500)).map((st) => ({ ...studentRow(st, money), total_rows: list.length })));
      },
      accounts_student_detail: (u, a) => {
        const s = reader(u);
        const st = s && studentOf(s, a.p_student);
        if (!st) return pgErr(403, '42501', 'student not found');
        const money = moneyFor(s);
        const b = hide(balance(st), money);
        return json(200, {
          student: st, money_hidden: !money, balance: b,
          fee_items: F.items.filter((f) => f.student_id === st.id).sort((x, y) => x.due_date.localeCompare(y.due_date))
            .map((f) => ({ id: f.id, head: f.head, amount: money ? f.amount : null, due_date: f.due_date, academic_year: f.academic_year,
              is_void: f.is_void, void_reason: f.void_reason, voided_at: f.voided_at, created_at: f.created_at })),
          payments: F.payments.filter((p) => p.student_id === st.id).sort((x, y) => (y.paid_on + y.created_at).localeCompare(x.paid_on + x.created_at))
            .map((p) => ({ id: p.id, amount: money ? p.amount : null, paid_on: p.paid_on, mode: p.mode, reference: p.reference, note: p.note,
              recorded_by: p.recorded_by, recorded_by_label: label(p.recorded_by), created_at: p.created_at, reverses_id: p.reverses_id,
              reversed_by: (F.payments.find((r) => r.reverses_id === p.id) || {}).id || null })),
          calls: F.calls.filter((c) => c.student_id === st.id).map((c) => ({ ...c, promised_amount: money ? c.promised_amount : null })),
        });
      },
      accounts_record_payment: (u, a) => {
        const s = manager(u);
        if (!s) return denied();
        const st = studentOf(s, a.p_student);
        if (!st) return pgErr(403, '42501', 'student not found');
        const amount = Number(a.p_amount);
        if (!(amount > 0)) return bad('the amount must be more than 0');
        const mode = String(a.p_mode || '');
        if (!['upi', 'cash', 'cheque', 'card', 'bank', 'other'].includes(mode)) return bad('mode must be upi, cash, cheque, card, bank or other');
        const paidOn = a.p_paid_on || today();
        if (paidOn > today()) return bad('the payment date cannot be in the future');
        const ref = String(a.p_reference || '').trim() || null;
        if (['upi', 'bank', 'card'].includes(mode) && !ref) return bad('a ' + mode + ' payment needs a reference (UTR or transaction number)');
        if (ref && F.payments.some((p) => p.institute_id === s.institute_id && p.mode === mode && String(p.reference || '').toLowerCase() === ref.toLowerCase() && live(p))) {
          return pgErr(409, '23505', 'this reference is already recorded for another payment');
        }
        const p = addPayment(st, { amount, paid_on: paidOn, mode, reference: ref, note: a.p_note || null, recorded_by: s.id });
        syncLeads(st);
        return json(200, p.id);
      },
      accounts_reverse_payment: (u, a) => {
        const s = manager(u);
        if (!s) return denied();
        const p = F.payments.find((x) => x.id === a.p_payment && x.institute_id === s.institute_id);
        if (!p) return pgErr(403, '42501', 'payment not found');
        if (p.reverses_id) return bad('a reversal cannot be reversed');
        if (F.payments.some((r) => r.reverses_id === p.id)) return bad('this payment is already reversed');
        const reason = String(a.p_reason || '').trim();
        if (!reason || reason.length > 300) return bad('write the reason (1 to 300 characters)');
        const st = studentOf(s, p.student_id);
        const r = addPayment(st, { amount: p.amount, paid_on: p.paid_on, mode: p.mode, reference: p.reference, note: reason, reverses_id: p.id, recorded_by: s.id });
        syncLeads(st);
        return json(200, r.id);
      },
      accounts_add_fee_item: (u, a) => {
        const s = manager(u);
        if (!s) return denied();
        const st = studentOf(s, a.p_student);
        if (!st) return pgErr(403, '42501', 'student not found');
        if (!String(a.p_head || '').trim()) return bad('the fee needs a name');
        if (!(Number(a.p_amount) > 0)) return bad('the amount must be more than 0');
        if (!a.p_due_date) return bad('the fee needs a due date');
        const f = addItem(st, String(a.p_head).trim(), Number(a.p_amount), a.p_due_date, a.p_academic_year);
        syncLeads(st);
        return json(200, f.id);
      },
      accounts_void_fee_item: (u, a) => {
        const s = manager(u);
        if (!s) return denied();
        const f = F.items.find((x) => x.id === a.p_fee_item && x.institute_id === s.institute_id);
        if (!f) return pgErr(403, '42501', 'fee item not found');
        if (f.is_void) return bad('this fee item is already void');
        const reason = String(a.p_reason || '').trim();
        if (!reason) return bad('write the reason (1 to 300 characters)');
        Object.assign(f, { is_void: true, void_reason: reason, voided_at: new Date().toISOString(), voided_by: s.id });
        syncLeads(studentOf(s, f.student_id));
        return json(200, null);
      },
      accounts_import_students: (u, a) => {
        const s = manager(u);
        if (!s) return denied();
        const list = a.p_rows;
        if (!Array.isArray(list)) return bad('students must be a list');
        const out = { added: 0, updated: 0, skipped: 0, fee_items_added: 0, payments_added: 0, skipped_rows: [] };
        const seen = new Set();
        const BOARDS = { cbse: 'CBSE', icse: 'ICSE', state: 'State', 'state board': 'State', ib: 'IB', igcse: 'IGCSE', other: 'Other' };
        list.forEach((r, i) => {
          const skip = (reason) => { out.skipped_rows.push({ row: i + 1, reason }); };
          const name = String(r.name || '').trim();
          if (!name) return skip('no name');
          const adm = String(r.admission_no || '').trim() || null;
          if (adm && seen.has(adm.toLowerCase())) return skip('admission number twice in the file');
          const board = r.board ? BOARDS[String(r.board).trim().toLowerCase()] : null;
          if (r.board && !board) return skip('unknown board');
          if (r.phone && !/^\+91\d{10}$/.test(r.phone)) return skip('bad phone number');
          if (adm) seen.add(adm.toLowerCase());
          let st = adm ? F.students.find((x) => x.institute_id === s.institute_id && String(x.admission_no || '').toLowerCase() === adm.toLowerCase()) : null;
          const given = {};
          ['class_label', 'section', 'academic_year', 'parent_name', 'phone', 'alt_phone'].forEach((k) => { if (r[k]) given[k] = r[k]; });
          if (board) given.board = board;
          if (st) { Object.assign(st, { name }, given); out.updated++; } else { st = newStudent(s.institute_id, { admission_no: adm, name, ...given }); out.added++; }
          (r.fees || []).forEach((f) => {
            const amount = amountOf(f.amount);
            if (!F.items.some((x) => x.student_id === st.id && !x.is_void && x.head.toLowerCase() === String(f.head).toLowerCase() && x.amount === amount && x.due_date === f.due_date)) {
              addItem(st, f.head, amount, f.due_date, f.academic_year);
              out.fee_items_added++;
            }
          });
          const paid = amountOf(r.paid_so_far || 0);
          if (paid > 0 && !F.payments.some((p) => p.student_id === st.id && p.opening && live(p))) {
            addPayment(st, { amount: paid, paid_on: r.paid_on || today(), mode: 'other', note: 'Opening balance import', opening: true, recorded_by: s.id });
            out.payments_added++;
          }
          syncLeads(st);
        });
        out.skipped = out.skipped_rows.length;
        F.lastImport = list;
        return json(200, out);
      },
      accounts_create_fees_campaign: (u, a) => {
        const s = reader(u);
        if (!s || !(isAcc(s) || (s.access_role || 'owner') === 'owner' || (s.access_role === 'manager' && db.reports.money))) {
          return pgErr(403, '42501', 'only accounts, an owner or a manager who can see money can make a fees campaign from the ledger');
        }
        const name = String(a.p_name || '').trim();
        if (!name || name.length > 120) return bad('campaign name must be 1 to 120 characters');
        if (a.p_min_due === null || Number(a.p_min_due) < 0) return bad('minimum due must be 0 or more');
        const asOf = a.p_due_by && a.p_due_by > today() ? a.p_due_by : today();
        const open = a.p_open_to_all !== false;
        const c = { id: crypto.randomUUID(), institute_id: s.institute_id, name, call_type_id: FEES_TYPE.id, script_id: a.p_script || null,
          start_date: null, end_date: null, daily_target: null, share_mode: open ? 'next_free' : 'equal', status: 'draft', open_to_all: open,
          class_label: a.p_class_label || null, board: a.p_board || null, fees_due_by: a.p_due_by || null, created_at: new Date().toISOString() };
        db.campaigns.push(c);
        const due = F.students.filter((st) => st.institute_id === s.institute_id && st.status === 'active'
          && (!c.class_label || String(st.class_label).toLowerCase() === c.class_label.toLowerCase()) && (!c.board || st.board === c.board)
          && balance(st, asOf).balance_due_now > Number(a.p_min_due || 0) && st.phone);
        due.forEach((st) => db.leads.push({ id: crypto.randomUUID(), institute_id: s.institute_id, campaign_id: c.id, name: st.parent_name || st.name,
          phone: st.phone, status: 'new', assigned_seat_id: null, amount_due: balance(st, asOf).balance_due_now, student_id: st.id,
          extra: { student: st.name, class: st.class_label }, created_at: new Date().toISOString() }));
        if (a.p_start !== false && open && due.length) c.status = 'running';
        F.lastCampaign = { id: c.id, leads: due.length, args: a };
        return json(200, c.id);
      },
      ledger_collected: (u, a) => {
        const s = reader(u);
        if (!s || s.institute_id !== a.p_institute) return pgErr(403, '42501', 'only accounts, owners and managers can see collections');
        if (!a.p_from || !a.p_to || a.p_from > a.p_to) return bad('the from date must be on or before the to date');
        const money = moneyFor(s);
        const all = F.payments.filter((p) => p.institute_id === s.institute_id && !p.reverses_id && !p.opening && p.paid_on >= a.p_from && p.paid_on <= a.p_to);
        const ok = all.filter(live);
        const modes = {};
        ok.forEach((p) => { const m = modes[p.mode] || (modes[p.mode] = { mode: p.mode, payments: 0, amount: 0 }); m.payments++; m.amount += p.amount; });
        return json(200, { from: a.p_from, to: a.p_to, campaign_id: a.p_campaign || null, money_hidden: !money, payments: ok.length,
          reversed: all.length - ok.length, total: money ? ok.reduce((t, p) => t + p.amount, 0) : null,
          by_mode: Object.values(modes).sort((x, y) => x.mode.localeCompare(y.mode)).map((m) => ({ ...m, amount: money ? m.amount : null })), by_day: [] });
      },
      promises_vs_payments: (u, a) => {
        // The reports block (above) answers for the Insights campaigns a test links to the ledger
        // (db.ledgerReports.pvp) and for campaigns this block does not hold.
        if (db.ledgerReports && db.ledgerReports.pvp[a.p_campaign]) return pvpReports(u, a);
        const s = reader(u);
        const c = s && db.campaigns.find((x) => x.id === a.p_campaign && x.institute_id === s.institute_id);
        if (!c && s && s.role === 'admin') return pvpReports(u, a);
        if (!c) return pgErr(403, '42501', 'campaign not found');
        const money = moneyFor(s);
        const rows = F.calls.filter((x) => x.campaign_id === c.id && x.promised_date && x.promised_amount > 0).map((x) => {
          const from = x.at.slice(0, 10);
          const until = (() => { const d = new Date(x.promised_date + 'T00:00:00'); d.setDate(d.getDate() + 2); return dayOf(d); })();
          const paid = F.payments.filter((p) => p.student_id === x.student_id && live(p) && p.paid_on >= from && p.paid_on <= until).reduce((t, p) => t + p.amount, 0);
          const state = !x.student_id ? 'no_student' : paid >= x.promised_amount ? 'kept' : paid > 0 ? 'part_paid' : today() > until ? 'broken' : 'waiting';
          return { outcome_id: x.outcome_id, lead_id: x.lead_id, lead_name: x.lead_name || '', student_id: x.student_id, caller: x.caller, promised_on: from,
            promised_date: x.promised_date, promised_amount: money ? x.promised_amount : null, paid_amount: money ? paid : null, state };
        });
        const n = (st) => rows.filter((r) => r.state === st).length;
        return json(200, { campaign_id: c.id, grace_days: 2, money_hidden: !money, promises: rows.length, kept: n('kept'), part_paid: n('part_paid'),
          broken: n('broken'), waiting: n('waiting'), no_student: n('no_student'),
          promised_amount: money ? rows.filter((r) => r.state !== 'no_student').reduce((t, r) => t + r.promised_amount, 0) : null,
          paid_amount: money ? rows.reduce((t, r) => t + Math.min(r.paid_amount, r.promised_amount), 0) : null, rows });
      },
    });
    // Simplify (one number, one definition): admin_fees_ledger and admin_home_ledger count due now and collected
    // from this block's students and payments, as the real functions do (student_balance_rows, ledger_collected),
    // so the Fees tab, its collection report and Today show the same numbers. Promised and "Promised date missed"
    // stay the reports block's sample promises.
    function collectedIn(inst, from, to) {
      const all = F.payments.filter((p) => p.institute_id === inst && !p.reverses_id && !p.opening && p.paid_on >= from && p.paid_on <= to);
      const ok = all.filter(live);
      const group = (key) => {
        const m = {};
        ok.forEach((p) => { const g = m[p[key]] || (m[p[key]] = { [key === 'paid_on' ? 'day' : 'mode']: p[key], payments: 0, amount: 0 }); g.payments++; g.amount += p.amount; });
        return Object.values(m);
      };
      return { payments: ok.length, reversed: all.length - ok.length, total: ok.reduce((t, p) => t + p.amount, 0),
        by_mode: group('mode').sort((x, y) => x.mode.localeCompare(y.mode)), by_day: group('paid_on').sort((x, y) => x.day.localeCompare(y.day)) };
    }
    const feesLedgerReports = RPC.admin_fees_ledger;
    RPC.admin_fees_ledger = (u, a) => {
      const res = feesLedgerReports(u, a);
      if (res.status !== 200) return res;
      const s = reader(u);
      const money = moneyFor(s);
      const out = JSON.parse(res.body);
      const due = F.students.filter((st) => st.institute_id === a.p_institute && st.status === 'active').map((st) => balance(st).balance_due_now).filter((v) => v > 0);
      const col = collectedIn(a.p_institute, a.p_from, a.p_to);
      const m = (v) => (money ? v : null);
      out.money_hidden = !money;
      out.today = today();
      out.due_now = { students: due.length, amount: m(due.reduce((t, v) => t + v, 0)) };
      out.collected = { payments: col.payments, reversed: col.reversed, total: m(col.total),
        by_mode: col.by_mode.map((x) => ({ ...x, amount: m(x.amount) })), by_day: col.by_day.map((x) => ({ ...x, amount: m(x.amount) })) };
      ['promised', 'broken'].forEach((k) => { if (out[k] && !money) out[k].amount = null; });
      return json(200, out);
    };
    const homeLedgerReports = RPC.admin_home_ledger;
    RPC.admin_home_ledger = (u, a) => {
      const res = homeLedgerReports(u, a);
      if (res.status !== 200) return res;
      const s = seatOf(u.id);
      const out = JSON.parse(res.body);
      const col = collectedIn(s.institute_id, today(), today());
      out.collected = { payments: col.payments, amount: db.reports.money ? col.total : null };
      return json(200, out);
    };
    // can_see_money: Accounts always; everyone else as before.
    const moneyBefore = RPC.can_see_money;
    RPC.can_see_money = (u, a) => {
      const s = u && seatOf(u.id);
      if (isAcc(s) && s.institute_id === a.inst) return json(200, true);
      return moneyBefore(u, a);
    };
    // REST reads of the Fees tab: the fees call type, the fees campaigns it can read and the live scripts.
    function route(p, method, url, u) {
      if (method !== 'GET') return null;
      const s = reader(u);
      const eq = (k) => (url.searchParams.get(k) || '').replace(/^eq\./, '');
      if (p === '/rest/v1/call_types' && eq('key') === 'fees') return json(200, u ? [{ id: FEES_TYPE.id, key: 'fees' }] : []);
      if (p === '/rest/v1/campaigns' && url.searchParams.get('call_type_id')) {
        const states = (url.searchParams.get('status') || '').replace(/^in\.\(|\)$/g, '').split(',').filter(Boolean);
        return json(200, s ? db.campaigns.filter((c) => c.institute_id === s.institute_id && c.call_type_id === eq('call_type_id')
          && (!states.length || states.includes(c.status)) && (s.role === 'admin' || c.open_to_all))
          .map((c) => ({ id: c.id, name: c.name, status: c.status, call_type_id: c.call_type_id })) : []);
      }
      if (p === '/rest/v1/scripts' && (url.searchParams.get('select') || '') === 'id,name,call_type_id,script_versions(published)') {
        return json(200, s ? F.scripts.filter((x) => x.institute_id === eq('institute_id') && x.institute_id === s.institute_id)
          .map(({ id, name, call_type_id, script_versions }) => ({ id, name, call_type_id, script_versions })) : []);
      }
      return null;
    }
    return {
      route,
      aarav, diya, syncLeads, newStudent, addPayment, today,
      // An Accounts login for institute A: { email }. Its password is the world's.
      addAccounts() {
        const email = 'e2e-accounts' + world.users.admin.email.slice(world.users.admin.email.indexOf('@'));
        if (!db.users.some((x) => x.email === email)) {
          const id = crypto.randomUUID();
          db.users.push({ id, email, password: world.password });
          db.seats.push({ id: crypto.randomUUID(), institute_id: instA, label: 'Fees office', role: 'accounts', access_role: 'accounts',
            admin_kind: 'accounts', can_see_money: false, user_id: id, status: 'active' });
        }
        return { email };
      },
      balance,
    };
  })();
  // end Phase A.2: fees

  // add row
  // "+ Add student" and "+ Add lead" (js/admin/add-row.js): accounts_save_student of 20261025130000 (owners and
  // Accounts; add or edit; name needed, phones normalised, board checked, the same admission number refused with
  // 23505), admin_add_leads with the consent keys of 20261026100000_add_row.sql (kept on the lead), and the REST read
  // of a list's leads' extra fields (admins of the institute). Every admin_add_leads call is kept in db.addRow.leadCalls.
  const addRow = (() => {
    const A = { leadCalls: [], saved: [] };
    db.addRow = A;
    const F = db.fees;
    const BOARDS = { cbse: 'CBSE', icse: 'ICSE', state: 'State', 'state board': 'State', ib: 'IB', igcse: 'IGCSE', other: 'Other' };
    const normPhone = (v) => {
      let d = String(v || '').replace(/[\s-]+/g, '');
      if (d.startsWith('+91')) d = d.slice(3); else if (/^91\d{10}$/.test(d)) d = d.slice(2);
      if (d.startsWith('0')) d = d.slice(1);
      return /^\d{10}$/.test(d) ? '+91' + d : null;
    };
    RPC.accounts_save_student = (u, a) => {
      const s = u && seatOf(u.id);
      if (!s || !(s.role === 'accounts' || (s.role === 'admin' && (s.access_role || 'owner') === 'owner'))) {
        return pgErr(403, '42501', 'only accounts and owners can change the ledger');
      }
      const d = a.p_data || {};
      let st = a.p_student ? F.students.find((x) => x.id === a.p_student && x.institute_id === s.institute_id) : null;
      if (a.p_student && !st) return pgErr(403, '42501', 'student not found');
      const next = st ? { ...st } : { institute_id: s.institute_id, status: 'active' };
      for (const k of Object.keys(d)) {
        const v = String(d[k] === null || d[k] === undefined ? '' : d[k]).trim() || null;
        if (k === 'name') { if (!v) return pgErr(400, '22023', 'name is required'); next.name = v.slice(0, 120); }
        else if (['admission_no', 'class_label', 'section', 'parent_name'].includes(k)) next[k] = v;
        else if (k === 'board') { if (v && !BOARDS[v.toLowerCase()]) return pgErr(400, '22023', 'board must be CBSE, ICSE, State, IB, IGCSE or Other'); next.board = v ? BOARDS[v.toLowerCase()] : null; }
        else if (k === 'academic_year') { if (v && !/^\d{4}-\d{2}$/.test(v)) return pgErr(400, '22023', 'academic year must look like 2026-27'); next.academic_year = v; }
        else if (k === 'phone' || k === 'alt_phone') { const p = normPhone(v); if (v && !p) return pgErr(400, '22023', 'enter a 10-digit mobile number'); next[k] = p; }
      }
      if (!next.name) return pgErr(400, '22023', 'name is required');
      if (next.admission_no && F.students.some((x) => x.institute_id === s.institute_id && x.id !== (st && st.id)
        && String(x.admission_no || '').toLowerCase() === next.admission_no.toLowerCase())) {
        return pgErr(409, '23505', 'another student has this admission number');
      }
      if (st) Object.assign(st, next);
      else {
        st = { id: crypto.randomUUID(), admission_no: null, class_label: null, section: null, board: null, academic_year: null, parent_name: null,
          phone: null, alt_phone: null, admission_lead_id: null, created_at: new Date().toISOString(), ...next, source: 'manual' };
        F.students.push(st);
      }
      A.saved.push({ id: st.id, added: !a.p_student, data: d });
      return json(200, st.id);
    };
    const addLeadsBefore = RPC.admin_add_leads;
    RPC.admin_add_leads = (u, a) => {
      A.leadCalls.push({ campaign: a.p_campaign, rows: a.p_rows });
      const before = new Set(db.leads.map((l) => l.id));
      const res = addLeadsBefore(u, a);
      if (res.status === 200) {
        db.leads.filter((l) => !before.has(l.id)).forEach((l) => {
          const r = (a.p_rows || []).find((x) => normPhone(x.phone) === l.phone) || {};
          l.consent_call = r.consent_call !== false;
          l.consent_whatsapp = r.consent_whatsapp === true;
        });
      }
      return res;
    };
    function route(p, method, url, u) {
      if (p !== '/rest/v1/leads' || method !== 'GET') return null;
      const s = u && seatOf(u.id);
      const camp = (url.searchParams.get('campaign_id') || '').replace(/^eq\./, '');
      const limit = Number(url.searchParams.get('limit')) || 1000;
      if (!s || s.role !== 'admin') return json(200, []);
      return json(200, db.leads.filter((l) => l.campaign_id === camp && l.institute_id === s.institute_id).slice(0, limit).map((l) => ({ extra: l.extra || {} })));
    }
    return { route };
  })();
  // end add row

  // fees basics
  // Fee plans, discounts and the day closing (20261026110000_fee_plans_discounts.sql) on the fees block's students:
  // fee_plans_list / fee_plan_save / fee_plan_preview / fee_plan_apply / fee_plan_undo / fee_plan_apply_student,
  // accounts_set_uses_bus, accounts_import_students with p_apply_plans, accounts_give_discount /
  // accounts_remove_discount (discounts in db.fees.discounts lower the balance in the fees block), the discount
  // keys of accounts_student_detail, and ledger_day_closing. Same people as the SQL: Accounts and owners change
  // plans; owners, Accounts and managers who see money give discounts; readers read. Data in db.feesBasics.
  const feesBasics = (() => {
    const F = db.fees;
    F.discounts = [];
    const P = { plans: [], items: [], rules: [], applies: [], calls: [] };
    db.feesBasics = P;
    const LABELS = { sibling: 'Sibling', staff_child: 'Staff child', merit: 'Merit', financial_help: 'Financial help', other: 'Other' };
    const seat = (u) => u && seatOf(u.id);
    const isReader = (s) => !!s && (s.role === 'admin' || s.role === 'accounts');
    const isManager = (s) => !!s && (s.role === 'accounts' || (s.role === 'admin' && (s.access_role || 'owner') === 'owner'));
    const money = (s) => !!s && (s.role === 'accounts' || !!db.reports.money);
    const canDiscount = (s) => isManager(s) || (!!s && s.role === 'admin' && s.access_role === 'manager' && !!db.reports.money);
    const bad = (m) => pgErr(400, '22023', m);
    const notManager = () => pgErr(403, '42501', 'only accounts or an owner can change the fee ledger');
    const lc = (v) => String(v || '').trim().toLowerCase();
    const r2 = (n) => Math.round(n * 100) / 100;
    const left = (fi) => (fi.is_void ? 0 : Math.max(0, fi.amount - F.discounts.filter((d) => d.fee_item_id === fi.id && !d.is_removed).reduce((t, d) => t + d.amount, 0)));
    const label = (id) => (db.seats.find((x) => x.id === id) || {}).label || null;
    const studentsOf = (p) => F.students.filter((st) => st.institute_id === p.institute_id && st.status === 'active' && lc(st.class_label) === lc(p.class_label)
      && (!p.board || st.board === p.board) && (!p.section || lc(st.section) === lc(p.section)) && (!st.academic_year || st.academic_year === p.academic_year));
    const liveItems = (p) => P.items.filter((it) => it.plan_id === p.id && !it.removed_at).sort((a, b) => a.sort_order - b.sort_order);
    const undone = (fi) => fi.is_void && P.applies.some((a) => a.id === fi.plan_apply_id && a.undone_at);
    function rows(p, only) {
      const out = [];
      studentsOf(p).filter((st) => !only || st.id === only).forEach((st) => liveItems(p).forEach((it) => {
        const lk = F.items.filter((fi) => fi.student_id === st.id && fi.plan_item_id === it.id && !undone(fi))
          .sort((a, b) => (a.is_void - b.is_void) || b.created_at.localeCompare(a.created_at))[0];
        const hm = F.items.filter((fi) => fi.student_id === st.id && !fi.is_void && !fi.plan_item_id && lc(fi.head) === lc(it.head))
          .sort((a, b) => ((b.amount === it.amount && b.due_date === it.due_date) - (a.amount === it.amount && a.due_date === it.due_date)))[0];
        let state = 'missing';
        if (lk) state = lk.is_void ? 'cancelled' : (lk.head === it.head && lk.amount === it.amount && lk.due_date === it.due_date ? 'has' : 'change');
        else if (hm) state = hm.amount === it.amount && hm.due_date === it.due_date ? 'same' : 'other';
        out.push({ student: st, item: it, state, fee: lk || hm || null });
      }));
      return out;
    }
    const removedRows = (p) => P.items.filter((it) => it.plan_id === p.id && it.removed_at).flatMap((it) =>
      F.items.filter((fi) => fi.plan_item_id === it.id && !fi.is_void && (F.students.find((st) => st.id === fi.student_id) || {}).status === 'active').map((fi) => ({ item: it, fee: fi })));
    const planOf = (s, id, write) => {
      const p = P.plans.find((x) => x.id === id && s && x.institute_id === s.institute_id);
      return p && (write ? isManager(s) : isReader(s)) ? p : null;
    };
    const itemOut = (it, m) => ({ id: it.id, head: it.head, amount: m ? it.amount : null, due_date: it.due_date, who: it.who });
    const ruleOut = (ru) => ({ id: ru.id, reason: ru.reason, reason_label: LABELS[ru.reason], note: ru.note || null, percent: ru.percent, amount: null, heads: ru.heads });
    function giveRows(st, items, kind, value, extra) {
      const list = items.filter((fi) => left(fi) > 0).sort((a, b) => a.due_date.localeCompare(b.due_date));
      const lefts = r2(list.reduce((t, fi) => t + left(fi), 0));
      if (!list.length) return 0;
      if (kind === 'amount' && value > lefts) throw new Error('the discount is more than what is left to pay on these fees');
      let given = 0;
      list.forEach((fi, i) => {
        const l = left(fi);
        const a = kind === 'percent' ? Math.min(r2(fi.amount * value / 100), l) : i === list.length - 1 ? Math.min(r2(value - given), l) : Math.min(r2(value * l / lefts), l);
        if (a > 0) {
          F.discounts.push({ id: crypto.randomUUID(), institute_id: st.institute_id, student_id: st.id, fee_item_id: fi.id, amount: a,
            percent: kind === 'percent' ? value : null, is_removed: false, created_at: new Date().toISOString(), ...extra });
          given = r2(given + a);
        }
      });
      return given;
    }
    function applyCore(p, s, only, chosen, ruleTicks, remove) {
      const aid = crypto.randomUUID();
      const a = { id: aid, plan_id: p.id, undone_at: null, added: 0, linked: 0, changed: 0, removed: 0, discounts: 0 };
      P.applies.push(a);
      const touched = new Set();
      const add = (st, it) => {
        const fi = { id: crypto.randomUUID(), institute_id: p.institute_id, student_id: st.id, head: it.head, amount: it.amount, due_date: it.due_date,
          academic_year: p.academic_year, is_void: false, void_reason: null, voided_at: null, created_at: new Date().toISOString(), plan_item_id: it.id, plan_apply_id: aid };
        F.items.push(fi);
        return fi;
      };
      rows(p, only).forEach((r) => {
        if (r.state === 'same') { r.fee.plan_item_id = r.item.id; a.linked++; return; }
        if (r.state === 'missing') {
          const c = (chosen || {})[r.item.id];
          const ticked = r.item.who === 'all' || (c ? c.includes(r.student.id) : r.item.who === 'bus' && !!r.student.uses_bus);
          if (!ticked) return;
          add(r.student, r.item);
          if (r.item.who === 'bus') r.student.uses_bus = true;
          a.added++; touched.add(r.student);
          return;
        }
        if (r.state === 'change') {
          Object.assign(r.fee, { is_void: true, void_reason: 'The fee plan changed', voided_at: new Date().toISOString() });
          const nf = add(r.student, r.item);
          F.discounts.filter((d) => d.fee_item_id === r.fee.id && !d.is_removed).forEach((d) => {
            giveRows(r.student, [nf], d.percent ? 'percent' : 'amount', d.percent || Math.min(d.amount, nf.amount), { grant_id: d.grant_id, reason: d.reason, note: d.note,
              approved_by: d.approved_by, scope: d.scope, plan_rule_id: d.plan_rule_id, plan_apply_id: aid, created_by: s.id });
          });
          a.changed++; touched.add(r.student);
        }
      });
      if (remove) {
        removedRows(p).forEach((r) => {
          Object.assign(r.fee, { is_void: true, void_reason: 'Removed from the fee plan', voided_at: new Date().toISOString() });
          a.removed++; touched.add(F.students.find((st) => st.id === r.fee.student_id));
        });
      }
      P.rules.filter((ru) => ru.plan_id === p.id && !ru.removed_at).forEach((ru) => {
        ((ruleTicks || {})[ru.id] || []).forEach((sid) => {
          const st = studentsOf(p).find((x) => x.id === sid);
          if (!st || (only && sid !== only)) return;
          const items = F.items.filter((fi) => fi.student_id === sid && !fi.is_void && P.items.some((it) => it.id === fi.plan_item_id && it.plan_id === p.id && !it.removed_at
            && (ru.heads.length ? ru.heads.map(lc).includes(lc(it.head)) : it.who === 'all')) && !F.discounts.some((d) => d.fee_item_id === fi.id && d.plan_rule_id === ru.id && !d.is_removed));
          if (!items.length) return;
          if (giveRows(st, items, 'percent', ru.percent, { grant_id: crypto.randomUUID(), reason: ru.reason, note: ru.note || null, approved_by: s.label || 'Fees office',
            scope: 'fees', plan_rule_id: ru.id, plan_apply_id: aid, created_by: s.id }) > 0) { a.discounts++; touched.add(st); }
        });
      });
      touched.forEach((st) => fees.syncLeads(st));
      a.students = touched.size;
      return { apply_id: aid, plan_id: p.id, students: touched.size, added: a.added, linked: a.linked, changed: a.changed, removed: a.removed, discounts: a.discounts,
        leads_updated: 0, can_undo: !a.changed && !a.removed && a.added + a.discounts > 0 };
    }
    Object.assign(RPC, {
      fee_plans_list: (u) => {
        const s = seat(u);
        if (!isReader(s)) return pgErr(403, '42501', 'only accounts, owners and managers can see fee plans');
        const m = money(s);
        return json(200, P.plans.filter((p) => p.institute_id === s.institute_id).map((p) => {
          const rs = rows(p);
          const pendAll = rs.filter((r) => (r.state === 'missing' && r.item.who === 'all') || r.state === 'change');
          const removed = removedRows(p);
          return { id: p.id, academic_year: p.academic_year, class_label: p.class_label, board: p.board, section: p.section, auto_apply: p.auto_apply,
            money_hidden: !m, students: studentsOf(p).length, items: liveItems(p).map((it) => itemOut(it, m)),
            rules: P.rules.filter((ru) => ru.plan_id === p.id && !ru.removed_at).map(ruleOut),
            pending: { add: rs.filter((r) => r.state === 'missing' && r.item.who === 'all').length, change: rs.filter((r) => r.state === 'change').length,
              remove: removed.length, students: new Set(pendAll.map((r) => r.student.id).concat(removed.map((r) => r.fee.student_id))).size } };
        }));
      },
      fee_plan_save: (u, a) => {
        const s = seat(u);
        if (!isManager(s)) return notManager();
        const d = a.p_data || {};
        P.calls.push({ fn: 'fee_plan_save', args: a });
        let p = a.p_plan ? planOf(s, a.p_plan, true) : null;
        if (a.p_plan && !p) return pgErr(403, '42501', 'fee plan not found');
        const year = String(d.academic_year || '').trim();
        const cls = String(d.class_label || '').trim();
        if (!cls) return bad('pick the class');
        if (!/^\d{4}-\d{2}$/.test(year)) return bad('academic year must look like 2026-27');
        const board = d.board ? (String(d.board).toUpperCase() === 'STATE' ? 'State' : String(d.board).toUpperCase()) : null;
        if (P.plans.some((x) => x !== p && x.institute_id === s.institute_id && x.academic_year === year && lc(x.class_label) === lc(cls) && (x.board || '') === (board || '') && lc(x.section) === lc(d.section))) {
          return pgErr(409, '23505', 'there is already a fee plan for this class and year: open it and change it');
        }
        const items = Array.isArray(d.items) ? d.items : [];
        if (!items.length || items.length > 30) return bad('a fee plan needs 1 to 30 fees');
        for (const it of items) if (!String(it.head || '').trim() || !(Number(it.amount) > 0) || !it.due_date) return bad('each fee needs a name, an amount and a due date');
        if (!p) { p = { id: crypto.randomUUID(), institute_id: s.institute_id, created_at: new Date().toISOString() }; P.plans.push(p); }
        Object.assign(p, { academic_year: year, class_label: cls, board, section: String(d.section || '').trim() || null, auto_apply: d.auto_apply !== false });
        const keep = new Set(items.map((it) => it.id).filter(Boolean));
        P.items.filter((it) => it.plan_id === p.id && !it.removed_at && !keep.has(it.id)).forEach((it) => { it.removed_at = new Date().toISOString(); });
        items.forEach((x, i) => {
          let it = x.id && P.items.find((y) => y.id === x.id && y.plan_id === p.id && !y.removed_at);
          if (!it) { it = { id: crypto.randomUUID(), plan_id: p.id, removed_at: null }; P.items.push(it); }
          Object.assign(it, { head: String(x.head).trim(), amount: Number(x.amount), due_date: x.due_date, who: x.who || 'all', sort_order: i + 1 });
        });
        const keepR = new Set((d.rules || []).map((r) => r.id).filter(Boolean));
        P.rules.filter((ru) => ru.plan_id === p.id && !ru.removed_at && !keepR.has(ru.id)).forEach((ru) => { ru.removed_at = new Date().toISOString(); });
        (d.rules || []).forEach((x) => {
          let ru = x.id && P.rules.find((y) => y.id === x.id && y.plan_id === p.id && !y.removed_at);
          if (!ru) { ru = { id: crypto.randomUUID(), plan_id: p.id, removed_at: null }; P.rules.push(ru); }
          Object.assign(ru, { reason: x.reason, note: x.note || null, percent: Number(x.percent), heads: x.heads || [] });
        });
        return json(200, p.id);
      },
      fee_plan_preview: (u, a) => {
        const s = seat(u);
        const p = planOf(s, a.p_plan, false);
        if (!p) return pgErr(403, '42501', 'fee plan not found');
        const m = money(s);
        const rs = rows(p);
        const n = (it, st) => rs.filter((r) => r.item.id === it.id && r.state === st).length;
        return json(200, {
          plan: { id: p.id, academic_year: p.academic_year, class_label: p.class_label, board: p.board, section: p.section, auto_apply: p.auto_apply },
          money_hidden: !m, students: studentsOf(p).length,
          items: liveItems(p).map((it) => ({ ...itemOut(it, m), missing: n(it, 'missing'), same: n(it, 'same'), has: n(it, 'has'), change: n(it, 'change'),
            other: n(it, 'other'), cancelled: n(it, 'cancelled'),
            ticked: rs.filter((r) => r.item.id === it.id && r.state === 'missing' && (it.who === 'all' || (it.who === 'bus' && r.student.uses_bus))).length })),
          removed: Object.values(removedRows(p).reduce((o, r) => { (o[r.item.id] = o[r.item.id] || { id: r.item.id, head: r.item.head, students: 0 }).students++; return o; }, {})),
          rules: P.rules.filter((ru) => ru.plan_id === p.id && !ru.removed_at).map((ru) => ({ ...ruleOut(ru),
            given: new Set(F.discounts.filter((d) => d.plan_rule_id === ru.id && !d.is_removed).map((d) => d.student_id)).size })),
          rows: studentsOf(p).sort((x, y) => String(x.section).localeCompare(String(y.section)) || x.name.localeCompare(y.name)).map((st) => ({
            student_id: st.id, name: st.name, admission_no: st.admission_no, section: st.section, board: st.board, uses_bus: !!st.uses_bus,
            items: Object.fromEntries(rs.filter((r) => r.student.id === st.id).map((r) => [r.item.id, r.state])),
            rules: [...new Set(F.discounts.filter((d) => d.student_id === st.id && !d.is_removed && P.rules.some((ru) => ru.id === d.plan_rule_id && ru.plan_id === p.id)).map((d) => d.plan_rule_id))] })),
        });
      },
      fee_plan_apply: (u, a) => {
        const s = seat(u);
        const p = planOf(s, a.p_plan, true);
        if (!p) return pgErr(403, '42501', 'fee plan not found');
        P.calls.push({ fn: 'fee_plan_apply', args: a });
        return json(200, applyCore(p, s, null, a.p_chosen, a.p_rules, true));
      },
      fee_plan_undo: (u, a) => {
        const s = seat(u);
        const ap = P.applies.find((x) => x.id === a.p_apply);
        if (!isManager(s) || !ap) return pgErr(403, '42501', 'not found');
        if (ap.undone_at) return bad('this was already undone');
        if (ap.changed || ap.removed) return bad('this change cannot be undone: it changed fees students already had');
        ap.undone_at = new Date().toISOString();
        let nf = 0; let nd = 0;
        F.discounts.filter((d) => d.plan_apply_id === ap.id && !d.is_removed).forEach((d) => { Object.assign(d, { is_removed: true, removed_reason: 'Undo' }); nd++; });
        F.items.filter((fi) => fi.plan_apply_id === ap.id && !fi.is_void).forEach((fi) => { Object.assign(fi, { is_void: true, void_reason: 'Undo', voided_at: new Date().toISOString() }); nf++; });
        F.students.forEach((st) => fees.syncLeads(st));
        return json(200, { fees_cancelled: nf, discounts_removed: nd });
      },
      fee_plan_apply_student: (u, a) => {
        const s = seat(u);
        if (!isManager(s)) return notManager();
        const st = F.students.find((x) => x.id === a.p_student && x.institute_id === s.institute_id);
        if (!st) return pgErr(403, '42501', 'student not found');
        P.calls.push({ fn: 'fee_plan_apply_student', args: a });
        let added = 0; let plans = 0; const heads = [];
        P.plans.filter((p) => p.institute_id === s.institute_id && p.auto_apply && studentsOf(p).includes(st)).forEach((p) => {
          const res = applyCore(p, s, st.id, null, null, false);
          plans++; added += res.added;
          F.items.filter((fi) => fi.plan_apply_id === res.apply_id).forEach((fi) => heads.push(fi.head));
        });
        return json(200, { plans, added, heads });
      },
      accounts_set_uses_bus: (u, a) => {
        const s = seat(u);
        if (!isManager(s)) return notManager();
        const st = F.students.find((x) => x.id === a.p_student && x.institute_id === s.institute_id);
        if (!st) return pgErr(403, '42501', 'student not found');
        st.uses_bus = !!a.p_uses_bus;
        return json(200, null);
      },
      accounts_give_discount: (u, a) => {
        const s = seat(u);
        const st = s && F.students.find((x) => x.id === a.p_student && x.institute_id === s.institute_id);
        if (!st || !canDiscount(s)) return pgErr(403, '42501', 'student not found');
        const d = a.p_data || {};
        P.calls.push({ fn: 'accounts_give_discount', args: a });
        const v = Number(d.value);
        if (!['amount', 'percent'].includes(d.kind)) return bad('pick an amount or a percent');
        if (!(v > 0)) return bad('enter the discount');
        if (d.kind === 'percent' && v > 100) return bad('a percent discount can be at most 100');
        if (!LABELS[d.reason]) return bad('pick the reason');
        if (d.reason === 'other' && !String(d.note || '').trim()) return bad('write what the discount is for');
        const items = F.items.filter((fi) => fi.student_id === st.id && !fi.is_void && (d.whole_year || (d.fee_items || []).includes(fi.id)));
        if (!items.length) return bad('this student has no fees to give a discount on');
        const gid = crypto.randomUUID();
        let total;
        try {
          total = giveRows(st, items, d.kind, v, { grant_id: gid, reason: d.reason, note: d.note || null, approved_by: String(d.approved_by || '').trim() || s.label || 'Fees office',
            scope: d.whole_year ? 'year' : 'fees', plan_rule_id: null, plan_apply_id: null, created_by: s.id });
        } catch (err) { return bad(err.message); }
        fees.syncLeads(st);
        return json(200, { grant_id: gid, amount: total, fees: F.discounts.filter((x) => x.grant_id === gid).length });
      },
      accounts_remove_discount: (u, a) => {
        const s = seat(u);
        const rowsOf = F.discounts.filter((d) => d.grant_id === a.p_grant && s && d.institute_id === s.institute_id);
        if (!rowsOf.length || !canDiscount(s)) return pgErr(403, '42501', 'discount not found');
        if (rowsOf.every((d) => d.is_removed)) return bad('this discount is already removed');
        const why = String(a.p_reason || '').trim();
        if (!why) return bad('give a reason (up to 300 characters)');
        rowsOf.filter((d) => !d.is_removed).forEach((d) => Object.assign(d, { is_removed: true, removed_reason: why, removed_at: new Date().toISOString(), removed_by: s.id }));
        fees.syncLeads(F.students.find((st) => st.id === rowsOf[0].student_id));
        return json(200, rowsOf.length);
      },
      ledger_day_closing: (u, a) => {
        const s = seat(u);
        if (!isReader(s) || s.institute_id !== a.p_institute) return pgErr(403, '42501', 'only accounts, owners and managers can see collections');
        const m = money(s);
        const dy = a.p_day || fees.today();
        const am = (v) => (m ? v : null);
        const stOf = (id) => F.students.find((st) => st.id === id) || {};
        const pays = F.payments.filter((p) => p.institute_id === s.institute_id && p.paid_on === dy && !p.reverses_id && !p.opening)
          .map((p) => { const r = F.payments.find((x) => x.reverses_id === p.id); return { ...p, live: !r, rev: r ? r.note : null }; })
          .sort((x, y) => x.created_at.localeCompare(y.created_at));
        const live = pays.filter((p) => p.live);
        const sum = (list) => list.reduce((t, p) => t + p.amount, 0);
        const persons = {};
        live.forEach((p) => {
          const k = p.recorded_by || 'none';
          persons[k] = persons[k] || { seat_id: p.recorded_by, label: label(p.recorded_by) || 'Unknown', payments: 0, amount: 0 };
          persons[k].payments++; persons[k].amount += p.amount;
        });
        const revs = F.payments.filter((r) => r.institute_id === s.institute_id && r.reverses_id && !r.opening && (r.paid_on === dy || r.created_at.slice(0, 10) === dy));
        const cheq = live.filter((p) => p.mode === 'cheque');
        return json(200, {
          day: dy, today: fees.today(), money_hidden: !m,
          totals: { payments: live.length, amount: am(sum(live)), reversed: pays.length - live.length, reversed_amount: am(sum(pays.filter((p) => !p.live))),
            cheques: cheq.length, cheque_amount: am(sum(cheq)) },
          by_mode: ['cash', 'upi', 'cheque', 'card', 'bank', 'other'].map((md) => ({ mode: md, payments: live.filter((p) => p.mode === md).length, amount: am(sum(live.filter((p) => p.mode === md))) })),
          by_person: Object.values(persons).sort((x, y) => y.amount - x.amount).map((p) => ({ ...p, amount: am(p.amount) })),
          payments: pays.map((p) => { const st = stOf(p.student_id); return { id: p.id, at: p.created_at, student_id: p.student_id, student: st.name, class_label: st.class_label, section: st.section,
            admission_no: st.admission_no, amount: am(p.amount), mode: p.mode, reference: p.reference, note: p.note, recorded_by_label: label(p.recorded_by), reversed: !p.live, reversed_reason: p.rev }; }),
          cheques: cheq.map((p) => { const st = stOf(p.student_id); return { id: p.id, at: p.created_at, student_id: p.student_id, student: st.name, class_label: st.class_label, section: st.section,
            amount: am(p.amount), reference: p.reference, note: p.note, recorded_by_label: label(p.recorded_by) }; }),
          reversals: revs.map((r) => { const st = stOf(r.student_id); return { id: r.id, of_id: r.reverses_id, at: r.created_at, student_id: r.student_id, student: st.name, class_label: st.class_label,
            section: st.section, amount: am(r.amount), mode: r.mode, reason: r.note, recorded_by_label: label(r.recorded_by), paid_on: r.paid_on }; }),
        });
      },
    });
    // The student page: discounts, the discount total and each fee's discount.
    const detailBefore = RPC.accounts_student_detail;
    RPC.accounts_student_detail = (u, a) => {
      const res = detailBefore(u, a);
      if (res.status !== 200) return res;
      const s = seat(u);
      const m = money(s);
      const out = JSON.parse(res.body);
      const st = F.students.find((x) => x.id === a.p_student);
      out.can_discount = canDiscount(s);
      out.balance.discounts = m ? fees.balance(st).discounts : null;
      out.student.uses_bus = !!st.uses_bus;
      out.fee_items = out.fee_items.map((f) => {
        const fi = F.items.find((x) => x.id === f.id);
        return { ...f, plan_item_id: fi.plan_item_id || null, discount: m ? F.discounts.filter((d) => d.fee_item_id === f.id && !d.is_removed).reduce((t, d) => t + d.amount, 0) : null };
      });
      const groups = {};
      F.discounts.filter((d) => d.student_id === st.id).forEach((d) => { const k = d.grant_id + ':' + d.is_removed; (groups[k] = groups[k] || []).push(d); });
      out.discounts = Object.values(groups).map((g) => {
        const d = g[0];
        const fis = g.map((x) => F.items.find((fi) => fi.id === x.fee_item_id));
        return { grant_id: d.grant_id, reason: d.reason, reason_label: LABELS[d.reason], note: d.note, percent: d.percent, scope: d.scope, approved_by: d.approved_by,
          amount: m ? g.filter((x, i) => !fis[i].is_void).reduce((t, x) => t + x.amount, 0) : null,
          fees: g.map((x, i) => ({ fee_item_id: x.fee_item_id, head: fis[i].head, amount: m ? x.amount : null, fee_cancelled: fis[i].is_void })),
          plan_rule_id: d.plan_rule_id, created_at: d.created_at, created_by_label: label(d.created_by), is_removed: d.is_removed,
          removed_reason: d.removed_reason || null, removed_at: d.removed_at || null, removed_by_label: label(d.removed_by) };
      }).sort((x, y) => y.created_at.localeCompare(x.created_at));
      return json(200, out);
    };
    // The import with fee plans: new students of a class with a plan get its fees.
    const importBefore = RPC.accounts_import_students;
    RPC.accounts_import_students = (u, a) => {
      const before = new Set(F.students.map((st) => st.id));
      const res = importBefore(u, { p_rows: a.p_rows });
      if (res.status !== 200) return res;
      const out = JSON.parse(res.body);
      let n = 0;
      if (a.p_apply_plans) {
        const s = seat(u);
        F.students.filter((st) => !before.has(st.id)).forEach((st) => {
          P.plans.filter((p) => p.institute_id === s.institute_id && p.auto_apply && studentsOf(p).includes(st)).forEach((p) => { n += applyCore(p, s, st.id, null, null, false).added; });
        });
      }
      out.plan_fee_items_added = n;
      P.calls.push({ fn: 'accounts_import_students', args: a });
      return json(200, out);
    };
    return { P };
  })();
  // end fees basics

  // presence
  // The call state on the caller screen (20261025190000_presence_call_state.sql): report_presence with the call
  // state and its start (the old two-argument call still works), kept per seat in db.seatPresence, and Home's and
  // Callers' "now" worked out from it with the rules of home_seat_status. A status a test sets with
  // adminTabs.setPresence() still wins. Every report is also kept in db.presenceReports.
  const presence = (() => {
    db.seatPresence = {};   // seat id -> { seen_at, online_since, phone_ok, phone_offline_since, call_state, call_started_at, state_at }
    const STATES = ['none', 'dialling', 'connected', 'wrapup', 'unconfirmed'];
    const MIN = 60e3;
    RPC.report_presence = (u, a) => {
      const s = u && seatOf(u.id);
      if (!s) return pgFail('42501', 'no active seat for this login');
      const st = a.p_call_state == null ? (a.p_on_call ? 'unconfirmed' : 'none') : a.p_call_state;
      if (!STATES.includes(st)) return pgFail('22023', 'call state must be none, dialling, connected, wrapup or unconfirmed');
      const now = Date.now();
      const ok = a.p_phone_ok !== false;
      const live = ['dialling', 'connected', 'unconfirmed'].includes(st);
      let started = a.p_call_started_at ? Date.parse(a.p_call_started_at) : null;
      if (st === 'none' || !Number.isFinite(started)) started = null;
      else if (started > now) started = now;
      else if (started < now - 12 * 60 * MIN) started = null;
      const p = db.seatPresence[s.id];
      const fresh = !!p && p.seen_at >= now - 3 * MIN;
      db.seatPresence[s.id] = {
        seen_at: now,
        online_since: fresh ? p.online_since : now,
        phone_ok: ok,
        phone_offline_since: ok ? null : (fresh && !p.phone_ok && p.phone_offline_since ? p.phone_offline_since : now),
        call_state: st,
        call_started_at: st === 'none' ? null : started || (fresh && p.call_state !== 'none' && p.call_started_at) || (live ? now : null),
        state_at: fresh && p.call_state === st ? p.state_at : now,
      };
      db.presenceReports.push({ seat_id: s.id, on_call: live, phone_ok: ok, call_state: st, call_started_at: a.p_call_started_at || null, at: now });
      return json(200, null);
    };
    const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const lastCall = (seatId) => {
      const times = db.outcomes.filter((r) => !r.corrects_id && r.seat_id === seatId).map((r) => Date.parse(r.dialled_at || r.uploaded_at))
        .concat((db.saved || []).filter((r) => r.seat_id === seatId).map((r) => Date.parse(r.saved_at)))
        .filter((t) => t >= startOfToday());
      return times.length ? Math.max(...times) : null;
    };
    const iso = (t) => (t == null ? null : new Date(t).toISOString());
    const secs = (t) => (t == null ? null : Math.max(0, Math.floor((Date.now() - t) / 1000)));
    // home_seat_status, in short.
    function statusOf(seatId) {
      const p = db.seatPresence[seatId];
      const now = Date.now();
      const recent = !!p && p.seen_at >= now - 3 * MIN;
      const last = lastCall(seatId);
      if (recent && !p.phone_ok) return { status: 'phone_offline', since: iso(p.phone_offline_since || p.seen_at) };
      if (recent && ['dialling', 'connected', 'unconfirmed'].includes(p.call_state)) {
        const since = p.call_started_at || p.state_at || last;
        return { status: 'on_call', call_state: p.call_state, confirmed: p.call_state !== 'unconfirmed', since: iso(since), seconds: secs(since) };
      }
      if (recent && p.call_state === 'wrapup' && p.state_at >= now - 10 * MIN) {
        return { status: 'wrapup', call_state: 'wrapup', since: iso(p.state_at), seconds: secs(p.state_at) };
      }
      const ref = Math.max(last || 0, recent && p.online_since >= startOfToday() ? p.online_since : 0);
      if (!ref) return { status: 'not_started' };
      const mins = Math.floor((now - ref) / MIN);
      return mins >= 15 ? { status: 'idle', since: iso(ref), idle_minutes: mins } : { status: 'ready', since: iso(ref) };
    }
    // Home and Callers: a seat with presence rows and no status set by the test gets the worked-out one.
    const nowOf = (seatId, given) => (db.presence[seatId] || !db.seatPresence[seatId] ? given : statusOf(seatId));
    const wrap = (name, patch) => {
      const prev = RPC[name];
      RPC[name] = (u, a) => {
        const res = prev(u, a);
        if (res.status !== 200 || !res.body) return res;
        const body = JSON.parse(res.body);
        patch(body);
        return json(200, body);
      };
    };
    wrap('admin_home_summary', (b) => (b.callers || []).forEach((c) => { c.now = nowOf(c.seat_id, c.now); }));
    wrap('admin_callers', (rows) => rows.forEach((r) => { if (r.now_status) r.now_status = nowOf(r.seat_id, r.now_status); }));
    return { statusOf };
  })();
  // end presence

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
      if (name === 'save_call_result' && db.offline) return route.abort('internetdisconnected');   // Phase A: caller
      if (RPC[name]) return send(RPC[name](u, body));
      if (ADMIN_EMPTY.includes(name)) return send(json(200, []));
      return send(pgErr(404, 'PGRST202', 'fake backend has no function ' + name));
    }
    { const r = fees.route(p, method, url, u); if (r) return send(r); }   // Phase A.2: fees
    { const r = addRow.route(p, method, url, u); if (r) return send(r); }   // add row
    // Phase A: caller: one script by id (a campaign's script).
    if (p === '/rest/v1/scripts' && method === 'GET' && url.searchParams.get('id')) {
      const sc = db.callerScripts[(url.searchParams.get('id') || '').replace(/^eq\./, '')];
      return send(json(200, sc && u ? [{ id: sc.id, script_versions: [{ version: sc.version, steps: sc.steps, pushbacks: sc.pushbacks || [], published: true }] }] : []));
    }
    if (p === '/rest/v1/scripts' && method === 'GET') {
      const inst = (url.searchParams.get('institute_id') || '').replace(/^eq\./, '');
      const scripts = inst === world.institutes.b && u ? [{ id: world.scriptId, script_versions: [{ version: 1, steps: db.publishedSteps || world.steps, pushbacks: db.publishedPushbacks, published: true }] }] : [];
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
    // Phase A.2: admin. The AI script maker is for the Vector team only; the library's REST reads.
    if (p === '/functions/v1/ai-script-draft' && method === 'POST' && !(u && db.platformAdmins.includes(u.id))) {
      return send(json(403, { error: 'The AI script maker is for the Vector team. Pick a ready script from the template library.', code: 'not_platform_admin' }));
    }
    { const r = phaseA2Admin.route(p, method, url, u, body); if (r) return route.fulfill({ ...r, headers: { 'access-control-allow-origin': '*', ...(r.headers || {}) } }); }
    // /Phase A.2: admin
    // Phase A: scripts
    const scriptsOut = scriptsRoute(p, method, url, body, u, req);
    if (scriptsOut) return send(scriptsOut);
    // Phase A: scripts (end)
    // Phase A: admin
    { const r = adminTabs.route(p, method, url, u); if (r) return send(r); }
    // /Phase A: admin
    const reportsRes = reportsRoute(p, method, u);   // Phase A: reports
    if (reportsRes) return send(reportsRes);
    return send(pgErr(404, 'PGRST000', 'fake backend has no route for ' + method + ' ' + p));
  }

  return {
    db,
    async attach(page, origin) { await page.route(origin + '/**', handle); },
    rowsFor: (seatId) => db.outcomes.filter((r) => r.seat_id === seatId),
    addOutcome: (row) => db.outcomes.push({ id: crypto.randomUUID(), uploaded_at: new Date().toISOString(), corrects_id: null, ...row }),
    insights,   // Phase A: insights
    passwordOf: (who) => (db.users.find((x) => x.email === world.users[who].email) || {}).password,
    addCampaign,   // Phase A: caller
    adminTabs,   // Phase A: admin (addCampaign, setPresence, setPromisesDue)
    // Phase A: whatsapp
    whatsapp: wa,
    WA_LEADS,
    // end Phase A: whatsapp
    fees,   // Phase A.2: fees (addAccounts, aarav, diya, balance; data in db.fees)
    feesBasics,   // fees basics (plans, applies, calls in db.feesBasics; discounts in db.fees.discounts)
    presence,   // presence (statusOf; reports in db.presenceReports, rows in db.seatPresence)
  };
}

module.exports = { createFakeBackend };
