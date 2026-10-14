-- Coaching suggestions, tips with before/after, and the leaderboard. Run on a scratch database after 0001 to 0012.
\set ON_ERROR_STOP 1
begin;
insert into public.institutes (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Test Institute'),
  ('11111111-2222-2222-2222-222222222222', 'Other Institute');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@test.local'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'ravi@test.local'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'meera@test.local'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'arjun@test.local'),
  ('aaaaaaaa-0000-0000-0000-000000000009', 'other-admin@test.local');
insert into public.seats (id, institute_id, user_id, label, role, status) values
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin', 'admin', 'active'),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'Ravi', 'rep', 'active'),
  ('22222222-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000003', 'Meera', 'rep', 'active'),
  ('22222222-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004', 'Arjun', 'rep', 'active'),
  ('22222222-0000-0000-0000-000000000009', '11111111-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000009', 'Other admin', 'admin', 'active');

-- Ravi, 20 calls: 8 lost at Fee on "Too expensive" (6 with no reason), 4 won, 6 connected.
insert into public.call_outcomes (institute_id, seat_id, client_record_id, stage_reached, objection, outcome, loss_reason, connected_seconds, dialled_at)
select '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000002', 'ravi-' || g,
       case when g <= 8 then 'Fee' else 'Close' end,
       case when g <= 8 then 'Too expensive' end,
       case when g <= 8 then 'not_interested' when g <= 12 then 'won' else 'no_answer' end,
       case when g <= 2 then 'price' end,
       case when g <= 6 then 60 else 0 end,
       '2026-10-06 11:00+05:30'
from generate_series(1, 20) g;
-- Meera, 20 calls: 2 lost at Pitch (price), 5 won, 15 connected.
insert into public.call_outcomes (institute_id, seat_id, client_record_id, stage_reached, objection, outcome, loss_reason, connected_seconds, dialled_at)
select '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000003', 'meera-' || g,
       case when g <= 2 then 'Pitch' else 'Close' end, null,
       case when g <= 2 then 'not_interested' when g <= 7 then 'won' else 'answered' end,
       case when g <= 2 then 'price' end,
       case when g <= 15 then 120 else 0 end,
       '2026-10-07 11:00+05:30'
from generate_series(1, 20) g;
-- Arjun, 20 calls: 1 lost at Fee (timing), 3 won, 16 connected.
insert into public.call_outcomes (institute_id, seat_id, client_record_id, stage_reached, objection, outcome, loss_reason, connected_seconds, dialled_at)
select '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000004', 'arjun-' || g,
       case when g <= 1 then 'Fee' else 'Close' end, null,
       case when g <= 1 then 'not_interested' when g <= 4 then 'won' else 'answered' end,
       case when g <= 1 then 'timing' end,
       case when g <= 16 then 90 else 0 end,
       '2026-10-08 11:00+05:30'
from generate_series(1, 20) g;

-- ---------- admin: suggestions ----------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
do $$
declare s jsonb; keys text[];
begin
  s := public.admin_coaching_suggestions('11111111-1111-1111-1111-111111111111', '2026-10-01', '2026-10-13');
  -- Ravi qualifies on four keys; only the two biggest gaps are shown: connect (61.7 vs 30) and the objection.
  assert jsonb_array_length(s) = 2, 'two suggestions, got ' || s::text;
  select array_agg(x ->> 'key' order by x ->> 'key') into keys from jsonb_array_elements(s) x;
  assert keys = array['connect', 'objection:Too expensive'], 'keys ' || keys::text;
  assert (select bool_and(x ->> 'label' = 'Ravi') from jsonb_array_elements(s) x), 'all for Ravi';
  assert (select (x ->> 'rep_value')::numeric from jsonb_array_elements(s) x where x ->> 'key' = 'connect') = 30.0, 'Ravi connect 30';
  assert (select (x ->> 'team_value')::numeric from jsonb_array_elements(s) x where x ->> 'key' = 'connect') = 61.7, 'team connect 61.7';
  assert (select x ->> 'better' from jsonb_array_elements(s) x where x ->> 'key' = 'connect') = 'higher', 'connect is higher-better';
  assert (select x ->> 'text' from jsonb_array_elements(s) x where x ->> 'key' = 'connect') like 'Ravi connects 30% of calls; the team connects 62%%', 'admin text';
  assert (select x -> 'sent_at' from jsonb_array_elements(s) x where x ->> 'key' = 'connect') = 'null'::jsonb, 'not sent yet';
  raise notice 'suggestions ok';
end $$;

-- A rep with too few calls of a kind gets nothing: Meera's 2 Pitch losses are under the minimum of 3.
do $$
declare s jsonb;
begin
  s := public.admin_coaching_suggestions('11111111-1111-1111-1111-111111111111', '2026-10-01', '2026-10-13');
  assert not exists (select 1 from jsonb_array_elements(s) x where x ->> 'label' in ('Meera', 'Arjun')), 'no tips for Meera or Arjun';
end $$;

-- ---------- admin: send a tip ----------
do $$
declare tid uuid; t record; caught boolean := false; s jsonb;
begin
  tid := public.admin_send_coaching_tip('22222222-0000-0000-0000-000000000002', 'connect', '2026-10-01', '2026-10-13', '  Call after 6pm.  ');
  assert tid is not null, 'tip id';
  select * into t from public.admin_coaching_tips('11111111-1111-1111-1111-111111111111') where id = tid;
  assert t.baseline = 30.0, 'baseline 30';
  assert t.team_baseline = 61.7, 'team baseline';
  assert t.rep_text like 'You connect 30% of your calls; the team connects 62%%', 'rep text: ' || t.rep_text;
  assert t.admin_note = 'Call after 6pm.', 'note trimmed';
  assert t.result = 'waiting', 'waiting before new calls';
  assert t.label = 'Ravi', 'label';

  -- The same tip cannot go twice in 7 days.
  begin
    perform public.admin_send_coaching_tip('22222222-0000-0000-0000-000000000002', 'connect', '2026-10-01', '2026-10-13');
  exception when unique_violation then caught := true; end;
  assert caught, 'duplicate blocked';

  -- Tips go to active reps only, and the key must be known.
  caught := false;
  begin
    perform public.admin_send_coaching_tip('22222222-0000-0000-0000-000000000001', 'connect', '2026-10-01', '2026-10-13');
  exception when invalid_parameter_value then caught := true; end;
  assert caught, 'not to an admin seat';
  caught := false;
  begin
    perform public.admin_send_coaching_tip('22222222-0000-0000-0000-000000000002', 'nonsense', '2026-10-01', '2026-10-13');
  exception when invalid_parameter_value then caught := true; end;
  assert caught, 'unknown key';

  -- The suggestion now shows when it was sent.
  s := public.admin_coaching_suggestions('11111111-1111-1111-1111-111111111111', '2026-10-01', '2026-10-13');
  assert (select x -> 'sent_at' from jsonb_array_elements(s) x where x ->> 'key' = 'connect') <> 'null'::jsonb, 'sent_at shown';
  raise notice 'send ok';
end $$;

-- ---------- rep: reads and acknowledges own tips ----------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000003', true);
do $$
declare n int; tid uuid;
begin
  -- Meera sees none of Ravi's tips and cannot mark them read.
  select count(*) into n from public.my_coaching_tips();
  assert n = 0, 'Meera has no tips';
end $$;
reset role;
select id as tip_id from public.coaching_tips limit 1 \gset
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000003', true);
select public.ack_coaching_tip(:'tip_id');
reset role;
do $$ begin assert (select seen_at from public.coaching_tips limit 1) is null, 'Meera cannot ack Ravi''s tip'; end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', true);
do $$
declare t record; caught boolean := false;
begin
  select * into t from public.my_coaching_tips();
  assert t.rep_text like 'You connect 30%%', 'Ravi sees his tip';
  assert t.seen_at is null, 'unread';
  perform public.ack_coaching_tip(t.id);
  select * into t from public.my_coaching_tips();
  assert t.seen_at is not null, 'read after ack';

  -- Reps cannot read suggestions, send tips or call the helpers.
  begin
    perform public.admin_coaching_suggestions('11111111-1111-1111-1111-111111111111', '2026-10-01', '2026-10-13');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'rep blocked from suggestions';
  caught := false;
  begin
    perform public.admin_send_coaching_tip('22222222-0000-0000-0000-000000000003', 'connect', '2026-10-01', '2026-10-13');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'rep blocked from sending';
  caught := false;
  begin
    perform public.coach_metric('11111111-1111-1111-1111-111111111111', null, 'connect', '2026-10-01', '2026-10-13');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'helpers not callable';
  raise notice 'rep tips ok';
end $$;

-- ---------- leaderboard ----------
do $$
declare b jsonb; r jsonb;
begin
  b := public.team_leaderboard('2026-10-01', '2026-10-13');
  assert (b ->> 'visible')::boolean, 'visible to reps by default';
  assert jsonb_array_length(b -> 'rows') = 3, 'three reps, admin not listed';
  select x into r from jsonb_array_elements(b -> 'rows') x where x ->> 'label' = 'Ravi';
  assert (r ->> 'me')::boolean, 'Ravi is me';
  assert (r ->> 'calls')::int = 20 and (r ->> 'connected')::int = 6 and (r ->> 'won')::int = 4 and (r ->> 'talk_minutes')::int = 6, 'Ravi figures ' || r::text;
  select x into r from jsonb_array_elements(b -> 'rows') x where x ->> 'label' = 'Meera';
  assert not (r ->> 'me')::boolean and (r ->> 'won')::int = 5 and (r ->> 'talk_minutes')::int = 30, 'Meera figures ' || r::text;
  raise notice 'leaderboard ok';
end $$;

-- A rep cannot turn the leaderboard off.
do $$
declare caught boolean := false;
begin
  begin
    perform public.admin_set_leaderboard_for_reps('11111111-1111-1111-1111-111111111111', false);
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'rep blocked from the switch';
end $$;

-- The admin turns it off: reps see nothing, the admin still sees it.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
select public.admin_set_leaderboard_for_reps('11111111-1111-1111-1111-111111111111', false);
do $$
declare b jsonb;
begin
  b := public.team_leaderboard('2026-10-01', '2026-10-13');
  assert (b ->> 'visible')::boolean and not (b ->> 'for_reps')::boolean, 'admin still sees it, switch off';
  assert jsonb_array_length(b -> 'rows') = 3, 'admin sees three reps';
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', true);
do $$
declare b jsonb;
begin
  b := public.team_leaderboard('2026-10-01', '2026-10-13');
  assert not (b ->> 'visible')::boolean and jsonb_array_length(b -> 'rows') = 0, 'hidden from reps';
  raise notice 'switch ok';
end $$;

-- ---------- an admin of another institute ----------
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000009', true);
do $$
declare caught boolean := false; n int;
begin
  begin
    perform public.admin_coaching_suggestions('11111111-1111-1111-1111-111111111111', '2026-10-01', '2026-10-13');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'other admin blocked from suggestions';
  caught := false;
  begin
    perform public.admin_send_coaching_tip('22222222-0000-0000-0000-000000000002', 'stage:Fee', '2026-10-01', '2026-10-13');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'other admin cannot send';
  caught := false;
  begin
    perform public.admin_coaching_tips('11111111-1111-1111-1111-111111111111');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'other admin cannot read tips';
  -- Their own leaderboard is empty: they have no reps.
  assert jsonb_array_length(public.team_leaderboard('2026-10-01', '2026-10-13') -> 'rows') = 0, 'other institute empty';
  raise notice 'isolation ok';
end $$;

-- ---------- before and after ----------
-- Ravi makes 12 more calls after the tip, 10 of them connected: 83% against a baseline of 30%.
reset role;
insert into public.call_outcomes (institute_id, seat_id, client_record_id, outcome, connected_seconds, dialled_at)
select '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000002', 'ravi-after-' || g,
       case when g <= 10 then 'answered' else 'no_answer' end,
       case when g <= 10 then 45 else 0 end, now()
from generate_series(1, 12) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
do $$
declare t record;
begin
  select * into t from public.admin_coaching_tips('11111111-1111-1111-1111-111111111111');
  assert t.after_calls = 12, 'calls since tip ' || t.after_calls;
  assert t.after_value = 83.3, 'after value ' || t.after_value;
  assert t.result = 'improved', 'improved, got ' || t.result;
  assert t.seen_at is not null, 'admin sees it was read';
  raise notice 'before/after ok';
end $$;
reset role;
rollback;
select 'coaching and leaderboard test passed' as result;
