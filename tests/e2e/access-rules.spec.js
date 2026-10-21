// Row-level security, checked as real signed-in users against the local stack (no browser needed).
const { test, expect, env, userDb } = require('./fixtures');

// Row-level security lives in Postgres, so this needs the real local stack, not the fake backend.
test.skip(() => require('./fixtures').isFake(), 'needs the local Supabase stack (npx supabase start)');

test('reps see only their own calls; admin reports are admin-only and per institute', async () => {
  const rep1 = await userDb('rep1');
  const id = 'e2e-rls-' + Date.now();
  const ins = await rep1.from('call_outcomes').insert({
    institute_id: env().institutes.a, seat_id: env().seats.rep1, client_record_id: id, outcome: 'callback',
  });
  expect(ins.error).toBeNull();

  // Rep 1 cannot write a row for another seat.
  const forged = await rep1.from('call_outcomes').insert({
    institute_id: env().institutes.a, seat_id: env().seats.rep2, client_record_id: id + '-x', outcome: 'won',
  });
  expect(forged.error).not.toBeNull();

  // Rep 2 (same institute) and Rep 3 (other institute) cannot read Rep 1's call.
  for (const who of ['rep2', 'rep3']) {
    const c = await userDb(who);
    const { data, error } = await c.from('call_outcomes').select('id').eq('client_record_id', id);
    expect(error).toBeNull();
    expect(data, who + ' must not see rep1 calls').toHaveLength(0);
  }

  const from = new Date(Date.now() - 86400000).toISOString(), to = new Date(Date.now() + 86400000).toISOString();
  const args = { p_institute: env().institutes.a, p_from: from, p_to: to };

  // A rep cannot run the admin report.
  const rep2 = await userDb('rep2');
  expect((await rep2.rpc('admin_team_activity', args)).error).not.toBeNull();

  // The admin can, and sees Rep 1's activity.
  const admin = await userDb('admin');
  const rep = await admin.rpc('admin_team_activity', args);
  expect(rep.error).toBeNull();
  expect(rep.data.map((r) => r.label)).toContain('Rep 1');

  // The admin of institute A cannot read institute B's report.
  const other = await admin.rpc('admin_team_activity', { ...args, p_institute: env().institutes.b });
  expect(other.error).not.toBeNull();
});
