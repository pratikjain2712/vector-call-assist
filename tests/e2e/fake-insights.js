// The Insights RPCs (migration 20261024100025_insights.sql) for the in-memory fake backend (fake-backend.js).
// Canned answers for institute A: one running fees campaign with enough calls for a forecast, and an earlier
// fees campaign to compare with. Shapes match the SQL functions; the numbers are made up but consistent.
// Writes (call hours, plan, goal, notes) are kept in `writes` so tests can check what the page sent.
const DAY = 864e5;
const ymd = (d) => d.toISOString().slice(0, 10);

function createFakeInsights(world, { requireAdmin, json, pgErr }) {
  const inst = world.institutes.a;
  const rep1 = world.seats.rep1, rep2 = world.seats.rep2;
  const today = new Date();
  const day = (n) => ymd(new Date(today.getTime() + n * DAY));
  const fees = { id: '0e000000-0000-4000-8000-000000000001', name: 'Oct fees – Class 10', status: 'running', call_type_key: 'fees',
    call_type_label: 'Fees collection', start_date: day(-9), end_date: day(7), daily_target: 60, call_hours: null, goal: null,
    plan: null, script_id: '0e000000-0000-4000-8000-0000000000aa', callers: 2, calls: 420, leads: 300 };
  const older = { id: '0e000000-0000-4000-8000-000000000002', name: 'Sept fees – Class 9', status: 'closed', call_type_key: 'fees',
    call_type_label: 'Fees collection', start_date: day(-40), end_date: day(-20), daily_target: 50, call_hours: null, goal: null,
    plan: null, script_id: null, callers: 2, calls: 600, leads: 280 };
  const campaigns = [fees, older];
  const writes = [];
  const state = { features: ['scripts'], money: true, practice: false };

  const daily = [];
  for (let i = 9; i >= 0; i--) daily.push({ day: day(-i), calls: 42, callers: 2, value: 144000 });
  const forecast = () => ({
    campaign_id: fees.id, name: fees.name, status: fees.status, call_type_key: 'fees',
    kind: state.money ? 'amount' : 'count', money_hidden: !state.money,
    today: day(0), start_date: fees.start_date, end_date: fees.end_date, daily_target: fees.daily_target,
    goal: null, plan: fees.plan, call_hours: fees.call_hours, callers: 2, leads: 300,
    cap: state.money ? 4320000 : 300, target: state.money ? 3888000 : 270,
    stats: { calls: 420, picked: 210, good: 90, direct_value: state.money ? 1440000 : 60, promises_made: 30,
      promise_value_made: state.money ? 360000 : 30, evening_calls: 120, evening_picked: 84 },
    promises: { judged: 20, kept: 12, broken: 8, broken_value: state.money ? 96000 : 8 },
    open_promises: [{ date: day(2), value: state.money ? 60000 : 5 }],
    daily: daily.map((r) => ({ ...r, value: state.money ? r.value : 6 })),
    hours: [],
  });
  const heat = [];
  for (let dow = 1; dow <= 7; dow++) {
    for (const hour of [10, 12, 14, 16, 18, 19, 20]) {
      const rate = hour >= 19 && dow <= 5 ? 0.7 : dow >= 6 && hour <= 12 ? 0.6 : 0.3;
      heat.push({ dow, hour, calls: 10, picked: Math.round(10 * rate) });
    }
  }
  const coaching = [
    { seat_id: rep1, label: 'Rep 1', calls: 220, picked: 120, good: 40, talk_seconds: 9000 },
    { seat_id: rep2, label: 'Rep 2', calls: 200, picked: 90, good: 14, talk_seconds: 7000 },
  ];
  const steps = [
    { seat_id: null, label: null, step: 'open', step_label: 'Opening', step_order: 1, timed_calls: 200, calls_with_step: 200, avg_seconds: 25 },
    { seat_id: null, label: null, step: 'ask', step_label: 'Questions', step_order: 2, timed_calls: 200, calls_with_step: 160, avg_seconds: 40 },
    { seat_id: null, label: null, step: 'fees', step_label: 'Fees', step_order: 3, timed_calls: 200, calls_with_step: 120, avg_seconds: 50 },
    { seat_id: rep1, label: 'Rep 1', step: 'open', step_label: 'Opening', step_order: 1, timed_calls: 110, calls_with_step: 110, avg_seconds: 22 },
    { seat_id: rep1, label: 'Rep 1', step: 'ask', step_label: 'Questions', step_order: 2, timed_calls: 110, calls_with_step: 100, avg_seconds: 40 },
    { seat_id: rep1, label: 'Rep 1', step: 'fees', step_label: 'Fees', step_order: 3, timed_calls: 110, calls_with_step: 90, avg_seconds: 48 },
    { seat_id: rep2, label: 'Rep 2', step: 'fees', step_label: 'Fees', step_order: 3, timed_calls: 90, calls_with_step: 30, avg_seconds: 55 },
    { seat_id: rep2, label: 'Rep 2', step: 'open', step_label: 'Opening', step_order: 1, timed_calls: 90, calls_with_step: 90, avg_seconds: 28 },
    { seat_id: rep2, label: 'Rep 2', step: 'ask', step_label: 'Questions', step_order: 2, timed_calls: 90, calls_with_step: 40, avg_seconds: 38 },
  ];
  const known = (id) => campaigns.find((c) => c.id === id);
  const guard = (u, a, fn) => {
    if (!requireAdmin(u, a.p_institute)) return pgErr(400, '42501', 'only an admin of this institute can view these reports');
    if (a.p_campaign !== undefined && !known(a.p_campaign)) return pgErr(400, '22023', 'campaign not found in this institute');
    return fn();
  };
  const guardWrite = (u, a, what, fn) => {
    if (!requireAdmin(u, inst) || !known(a.p_campaign)) return pgErr(400, '42501', 'campaign not found');
    writes.push({ what, args: a });
    fn();
    return json(200, null);
  };

  const RPC = {
    admin_insights_setup: (u, a) => guard(u, a, () => json(200, { money: state.money, features: state.features,
      practice_available: state.practice, campaigns })),
    admin_insights_forecast: (u, a) => guard(u, a, () => json(200, a.p_campaign === fees.id ? forecast()
      : { ...forecast(), campaign_id: older.id, end_date: older.end_date, today: day(0) })),
    admin_insights_summary: (u, a) => guard(u, a, () => json(200, [a.p_from && new Date(a.p_from) < new Date(today.getTime() - 10 * DAY)
      ? { calls: 120, picked: 50, good: 18, active_days: 5, callers: 2, promises_judged: 8, promises_kept: 4, talk_seconds: 4000 }
      : { calls: 290, picked: 150, good: 66, active_days: 7, callers: 2, promises_judged: 12, promises_kept: 8, talk_seconds: 9000 }])),
    admin_insights_best_time: (u, a) => guard(u, a, () => json(200, heat)),
    admin_insights_call_ends: (u, a) => guard(u, a, () => (state.features.includes('scripts')
      ? json(200, [{ step: 'open', step_label: 'Opening', step_order: 1, calls: 20 }, { step: 'ask', step_label: 'Questions', step_order: 2, calls: 25 },
        { step: 'fees', step_label: 'Fees', step_order: 3, calls: 84 }, { step: 'close', step_label: 'Close', step_order: 4, calls: 81 }])
      : pgErr(400, '42501', 'this needs the Scripts add-on'))),
    admin_insights_promises: (u, a) => guard(u, a, () => json(200, [
      { bucket: '1–3 days', bucket_order: 1, promises: 10, kept: 8, waiting: 1 }, { bucket: '4–7 days', bucket_order: 2, promises: 6, kept: 4, waiting: 0 },
      { bucket: '8–14 days', bucket_order: 3, promises: 3, kept: 1, waiting: 0 }, { bucket: '15+ days', bucket_order: 4, promises: 3, kept: 0, waiting: 2 }])),
    admin_insights_coaching: (u, a) => guard(u, a, () => json(200, coaching)),
    admin_insights_step_coaching: (u, a) => guard(u, a, () => (state.features.includes('scripts') ? json(200, steps)
      : pgErr(400, '42501', 'this needs the Scripts add-on'))),
    admin_set_call_hours: (u, a) => guardWrite(u, a, 'call_hours', () => { known(a.p_campaign).call_hours = a.p_call_hours; }),
    admin_apply_insights_plan: (u, a) => guardWrite(u, a, 'plan', () => { known(a.p_campaign).daily_target = a.p_daily_target; }),
    admin_set_campaign_goal: (u, a) => guardWrite(u, a, 'goal', () => { known(a.p_campaign).goal = a.p_goal; }),
    add_supervisor_note: (u, a) => {
      if (!requireAdmin(u, inst)) return pgErr(400, 'P0001', 'only an admin of this institute can add supervisor notes');
      writes.push({ what: 'note', args: a });
      return json(200, '0e000000-0000-4000-8000-00000000beef');
    },
  };
  return { RPC, writes, state, campaigns };
}

module.exports = { createFakeInsights };
