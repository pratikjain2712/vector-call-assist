-- Loss insights: suggestions, version comparison, and access. Run on a scratch database after 0001 to 0010.
\set ON_ERROR_STOP 1
begin;
insert into public.institutes (id, name) values ('11111111-1111-1111-1111-111111111111', 'Test Institute');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@test.local'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'rep@test.local');
insert into public.seats (id, institute_id, user_id, label, role, status) values
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Admin', 'admin', 'active'),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'Rep', 'rep', 'active');
insert into public.scripts (id, institute_id, name) values ('33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Main');
insert into public.script_versions (id, script_id, institute_id, version, steps, published) values
  ('44444444-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1, '[]', false),
  ('44444444-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 2, '[]', true);

-- v1: 10 calls, 2 lost.
insert into public.call_outcomes (institute_id, seat_id, client_record_id, script_id, script_version, script_step, stage_reached, objection, outcome, loss_reason, dialled_at)
select '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000002', 'v1-' || g,
       '33333333-0000-0000-0000-000000000001', 1, 'end_lost', 'Pitch', null,
       case when g <= 2 then 'not_interested' else 'won' end, null, '2026-10-05 10:00+05:30'
from generate_series(1, 10) g;

-- v2: 12 calls. 6 lost at Pitch with "Too expensive" (4 of them price), 6 won.
insert into public.call_outcomes (institute_id, seat_id, client_record_id, script_id, script_version, script_step, stage_reached, objection, outcome, loss_reason, dialled_at)
select '11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000002', 'v2-' || g,
       '33333333-0000-0000-0000-000000000001', 2, 'end_lost',
       case when g <= 6 then 'Pitch' else 'Close' end,
       case when g <= 4 then 'Too expensive' else null end,
       case when g <= 6 then 'not_interested' else 'won' end,
       case when g <= 4 then 'price' when g <= 6 then null else null end,
       '2026-10-12 10:00+05:30'
from generate_series(1, 12) g;

-- Admin: insights for v2 against v1.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}', true);
do $$
declare d jsonb; s jsonb; ok_stage boolean; ok_obj boolean; ok_ver boolean; ok_price boolean;
begin
  d := public.admin_loss_insights('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000002',
                                  '2026-10-01', '2026-11-01');
  assert (d ->> 'calls')::int = 12, 'calls for v2';
  assert (d ->> 'lost')::int = 6, 'lost for v2';
  assert (d ->> 'enough_calls')::boolean, 'enough calls';
  assert (d ->> 'previous_lost')::int = 2, 'v1 lost';
  s := d -> 'suggestions';
  select exists (select 1 from jsonb_array_elements(s) x where x ->> 'key' = 'stage:Pitch') into ok_stage;
  select exists (select 1 from jsonb_array_elements(s) x where x ->> 'key' = 'objection:Too expensive') into ok_obj;
  select exists (select 1 from jsonb_array_elements(s) x where x ->> 'key' = 'version:2') into ok_ver;
  select exists (select 1 from jsonb_array_elements(s) x where x ->> 'key' = 'reason:price') into ok_price;
  assert ok_stage, 'stage suggestion';
  assert ok_obj, 'objection suggestion';
  assert ok_ver, 'version suggestion (v1 20% to v2 50%)';
  assert ok_price, 'price suggestion';
  raise notice 'insights ok';
end $$;

-- Admin approves the stage suggestion; the decision comes back on the next read.
select public.admin_decide_suggestion('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000002', 'stage:Pitch', 'approved');
do $$
declare d jsonb; dec text;
begin
  d := public.admin_loss_insights('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000002', '2026-10-01', '2026-11-01');
  select e ->> 'decision' into dec from jsonb_array_elements(d -> 'suggestions') e where e ->> 'key' = 'stage:Pitch';
  assert dec = 'approved', 'decision kept';
  raise notice 'decision ok';
end $$;

-- A rep cannot read the insights or decide suggestions.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000002', true);
do $$
declare caught boolean := false;
begin
  begin
    perform public.admin_loss_insights('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000002', '2026-10-01', '2026-11-01');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'rep blocked from insights';
  caught := false;
  begin
    perform public.admin_decide_suggestion('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000002', 'stage:Pitch', 'rejected');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'rep blocked from deciding';
  raise notice 'access ok';
end $$;
reset role;
rollback;
select 'loss insights test passed' as result;
