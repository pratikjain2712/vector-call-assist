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
  // Phase A: campaigns. A small stand-in for the campaign functions of 20261024100020_campaign_admin.sql:
  // the same inputs and answer shapes, the admin check and the counts; shares leads round-robin. No money
  // is kept except amount_due on leads, returned only as the detail's total (can_see_money is false here).
  const CALL_TYPES = [['fees', 'Fees collection'], ['sales', 'Sales'], ['follow_up', 'Follow-up / appointment']]
    .map(([key, label], i) => ({ id: crypto.randomUUID(), key, label, sort_order: (i + 1) * 10, active: true, built_in: true, results: [] }));
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
    const t = CALL_TYPES.find((x) => x.id === c.call_type_id) || {};
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
      if (!CALL_TYPES.some((t) => t.id === a.p_call_type)) return pgErr(400, '22023', 'pick a call type');
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
  const ADMIN_EMPTY = ['admin_weekly_summary', 'admin_rep_progress', 'list_supervisor_notes'];

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
    my_features: (u) => json(200, u && seatOf(u.id) ? db.features : null),
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
    // Phase A: scripts
    const scriptsOut = scriptsRoute(p, method, url, body, u, req);
    if (scriptsOut) return send(scriptsOut);
    // Phase A: scripts (end)
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
