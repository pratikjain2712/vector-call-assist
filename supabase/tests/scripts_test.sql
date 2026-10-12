-- Script tests for 20261011100007_scripts.sql. Run after migrations 0001 to 0005 and 0007 on a scratch
-- database with the same stub auth layer as seat_functions_test.sql. Expect: 41 passed, 0 failed.
--
-- Fixtures (hand-counted):
--   Institute One: admin owner, reps rep1 and rep2. Institute Two: other admin.
--   Script "Vector sales": v1 draft; v2 published, then replaced by v4; v3 draft.
--   Calls for v4, range 2026-10-05 to 2026-10-12 (8 calls):
--     c1 end_won (won), c2 end_details "Too expensive" (other), c3 end_details "Too expensive" (other),
--     c4 end_lost "Not interested" (not_interested), c5 end_noanswer (no_answer),
--     c6 end_callback "Will I get a job?" (callback), c7 end_details "Too expensive" (other,
--     corrected to interested), c8 end_details, no objection (other).
--     Expected: total 8; end_details 4 (share 0.5), end_won 1, end_lost 1, end_noanswer 1,
--     end_callback 1; objections Too expensive 3, Not interested 1, Will I get a job? 1;
--     outcomes other 3, won 1, not_interested 1, no_answer 1, callback 1, interested 1.
--   Not counted: c9 (v4, dialled 2026-10-01, outside the range), c10 (v3, one end_won call, so v3 total is 1),
--     cc1 (a correction of c7 that carries end_details and objection "Wrong" but is not an original call).
\set ON_ERROR_STOP 0
\set I1 'a1000000-0000-0000-0000-000000000001'
\set I2 'a1000000-0000-0000-0000-000000000002'
\set SA 'c1000000-0000-0000-0000-000000000001'
\set SR1 'c1000000-0000-0000-0000-000000000002'
\set SR2 'c1000000-0000-0000-0000-000000000003'
\set SO 'c1000000-0000-0000-0000-000000000004'
\set UA 'bbbbbbb1-0000-0000-0000-000000000001'
\set UR1 'bbbbbbb1-0000-0000-0000-000000000002'
\set UR2 'bbbbbbb1-0000-0000-0000-000000000003'
\set UO 'bbbbbbb1-0000-0000-0000-000000000004'

create or replace function pg_temp.as_user(u uuid, mail text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''), 'email', mail)::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
create or replace function pg_temp.rows_is(name text, sql text, want int) returns void language plpgsql as $$
declare n int; begin execute sql into n; insert into results values (name, n = want, 'got '||n||', want '||want);
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.text_is(name text, sql text, want text) returns void language plpgsql as $$
declare t text; begin execute sql into t;
  insert into results values (name, t is not distinct from want, 'got '||coalesce(t,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.is_true(name text, sql text) returns void language plpgsql as $$
declare b boolean; begin execute sql into b; insert into results values (name, coalesce(b, false), 'expected true');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.affects_none(name text, sql text) returns void language plpgsql as $$
declare n int; begin execute sql; get diagnostics n = row_count;
  insert into results values (name, n = 0, 'rows changed: '||n);
exception when others then insert into results values (name, true, 'denied: '||sqlerrm); end $$;
create or replace function pg_temp.steps_ok() returns jsonb language sql immutable as $$
  select '[{"id":"open","title":"Opening","start":true,"say":["Hi {name}, {me} here."],"tip":"Smile first.","opts":[{"label":"Yes","to":"won"},{"label":"No","to":"lost"}]},{"id":"won","title":"Enrolled","say":["Welcome aboard."],"opts":[]},{"id":"lost","title":"Not now","say":["Thanks for your time."],"opts":[]}]'::jsonb
$$;
create or replace function pg_temp.rep(p_inst uuid, p_ver uuid) returns jsonb language sql as $$
  select admin_script_report(p_inst, p_ver, '2026-10-05 00:00:00+00', '2026-10-12 00:00:00+00')
$$;

-- ---------- fixtures ----------
reset role;
insert into auth.users (id, email, email_confirmed_at) values
  (:'UA', 'owner@sc.test', now()), (:'UR1', 'rep1@sc.test', now()),
  (:'UR2', 'rep2@sc.test', now()), (:'UO', 'other@sc.test', now());
insert into institutes (id, name, status, seat_limit) values
  (:'I1', 'Scripts One', 'active', 5), (:'I2', 'Scripts Two', 'active', 5);
insert into seats (id, institute_id, user_id, label, role, status) values
  (:'SA', :'I1', :'UA', 'Admin', 'admin', 'active'),
  (:'SR1', :'I1', :'UR1', 'Rep 1', 'rep', 'active'),
  (:'SR2', :'I1', :'UR2', 'Rep 2', 'rep', 'active'),
  (:'SO', :'I2', :'UO', 'Other admin', 'admin', 'active');

-- ---------- admin: versions ----------
select pg_temp.as_user(:'UA'::uuid, 'owner@sc.test');
set role authenticated;
select pg_temp.ok('admin creates a script as draft v1',
  $q$select admin_save_script_version(null, 'Vector sales', pg_temp.steps_ok(), 'first draft', false)$q$);
reset role;
select id as script from scripts where name = 'Vector sales' \gset
select pg_temp.as_user(:'UA'::uuid, 'owner@sc.test');
set role authenticated;

select pg_temp.ok('admin publishes v2',
  format($q$select admin_save_script_version(%L, 'Vector sales', pg_temp.steps_ok(), 'published first', true)$q$, :'script'));
select pg_temp.text_is('after publishing v2, v2 is the only published version',
  format($q$select string_agg(version::text, ',') from script_versions where script_id = %L and published$q$, :'script'), '2');
select pg_temp.ok('admin saves draft v3',
  format($q$select admin_save_script_version(%L, 'Vector sales', pg_temp.steps_ok(), 'draft three', false)$q$, :'script'));
select pg_temp.text_is('a draft save leaves v2 published',
  format($q$select string_agg(version::text, ',') from script_versions where script_id = %L and published$q$, :'script'), '2');
select pg_temp.ok('admin publishes v4',
  format($q$select admin_save_script_version(%L, 'Vector sales', pg_temp.steps_ok(), 'published four', true)$q$, :'script'));
select pg_temp.text_is('publishing v4 unpublishes v2: v4 is the only published version',
  format($q$select string_agg(version::text, ',') from script_versions where script_id = %L and published$q$, :'script'), '4');
select pg_temp.text_is('versions are numbered 1 to 4 in order',
  format($q$select string_agg(version::text, ',' order by version) from script_versions where script_id = %L$q$, :'script'), '1,2,3,4');

select pg_temp.fails('a change note over 500 characters is refused',
  format($q$select admin_save_script_version(%L, 'Vector sales', pg_temp.steps_ok(), repeat('x', 501), false)$q$, :'script'));
select pg_temp.fails('steps that are not a list are refused',
  format($q$select admin_save_script_version(%L, 'Vector sales', '{"not":"a list"}'::jsonb, '', false)$q$, :'script'));
select pg_temp.fails('an empty name is refused',
  $q$select admin_save_script_version(null, '   ', pg_temp.steps_ok(), '', false)$q$);
select pg_temp.text_is('refused saves leave four versions',
  format($q$select string_agg(version::text, ',' order by version) from script_versions where script_id = %L$q$, :'script'), '1,2,3,4');
select pg_temp.rows_is('admin reads all four versions',
  format($q$select count(*) from script_versions where script_id = %L$q$, :'script'), 4);
select pg_temp.fails('a published version cannot be edited',
  format($q$update script_versions set steps = '[]'::jsonb where script_id = %L and version = 4$q$, :'script'));
select pg_temp.fails('a published version cannot be deleted',
  format($q$delete from script_versions where script_id = %L and version = 4$q$, :'script'));
reset role;
select id as v3 from script_versions where script_id = :'script' and version = 3 \gset
select id as v4 from script_versions where script_id = :'script' and version = 4 \gset

-- ---------- rep: writes refused, reads published only ----------
select pg_temp.as_user(:'UR1'::uuid, 'rep1@sc.test');
set role authenticated;
select pg_temp.fails('a rep cannot save a version',
  format($q$select admin_save_script_version(%L, 'Vector sales', pg_temp.steps_ok(), '', true)$q$, :'script'));
select pg_temp.fails('a rep cannot insert a version directly',
  format($q$insert into script_versions (script_id, institute_id, version, steps, published) values (%L, %L, 9, '[]'::jsonb, true)$q$, :'script', :'I1'));
select pg_temp.affects_none('a rep cannot publish a draft by update',
  format($q$update script_versions set published = true where script_id = %L and version = 3$q$, :'script'));
select pg_temp.affects_none('a rep cannot delete versions',
  format($q$delete from script_versions where script_id = %L$q$, :'script'));
select pg_temp.text_is('a rep reads only the published version',
  format($q$select string_agg(version::text, ',' order by version) from script_versions where script_id = %L$q$, :'script'), '4');
select pg_temp.rows_is('a rep reads the script name once it has a published version',
  format($q$select count(*) from scripts where id = %L$q$, :'script'), 1);
select pg_temp.fails('a rep cannot run the report',
  format($q$select pg_temp.rep(%L, %L)$q$, :'I1', :'v4'));

-- ---------- admin of another institute: sees nothing, writes nothing ----------
select pg_temp.as_user(:'UO'::uuid, 'other@sc.test');
set role authenticated;
select pg_temp.rows_is('an admin of another institute sees no versions',
  format($q$select count(*) from script_versions where script_id = %L$q$, :'script'), 0);
select pg_temp.rows_is('an admin of another institute sees no scripts',
  format($q$select count(*) from scripts where id = %L$q$, :'script'), 0);
select pg_temp.fails('an admin of another institute cannot save to the script',
  format($q$select admin_save_script_version(%L, 'Vector sales', pg_temp.steps_ok(), '', true)$q$, :'script'));
select pg_temp.fails('an admin of another institute cannot run the report for this institute',
  format($q$select pg_temp.rep(%L, %L)$q$, :'I1', :'v4'));
select pg_temp.fails('a version of another institute is not found under its institute',
  format($q$select pg_temp.rep(%L, %L)$q$, :'I2', :'v4'));

-- ---------- report fixtures (superuser, so the rows are exactly as written) ----------
reset role;
insert into call_outcomes (id, institute_id, seat_id, client_record_id, corrects_id, script_id, script_version,
                           script_step, objection, outcome, dialled_at, connected_seconds) values
  ('60000000-0000-0000-0000-000000000001', :'I1', :'SR1', 'lead-001', null, :'script', 4, 'end_won', null, 'won', '2026-10-08 10:00:00+00', 120),
  ('60000000-0000-0000-0000-000000000002', :'I1', :'SR1', 'lead-002', null, :'script', 4, 'end_details', 'Too expensive', 'other', '2026-10-08 11:00:00+00', 60),
  ('60000000-0000-0000-0000-000000000003', :'I1', :'SR2', 'lead-003', null, :'script', 4, 'end_details', 'Too expensive', 'other', '2026-10-08 12:00:00+00', 0),
  ('60000000-0000-0000-0000-000000000004', :'I1', :'SR1', 'lead-004', null, :'script', 4, 'end_lost', 'Not interested', 'not_interested', '2026-10-09 09:00:00+00', 30),
  ('60000000-0000-0000-0000-000000000005', :'I1', :'SR2', 'lead-005', null, :'script', 4, 'end_noanswer', null, 'no_answer', '2026-10-09 10:00:00+00', 0),
  ('60000000-0000-0000-0000-000000000006', :'I1', :'SR2', 'lead-006', null, :'script', 4, 'end_callback', 'Will I get a job?', 'callback', '2026-10-09 11:00:00+00', 45),
  ('60000000-0000-0000-0000-000000000007', :'I1', :'SR1', 'lead-007', null, :'script', 4, 'end_details', 'Too expensive', 'other', '2026-10-10 09:00:00+00', 90),
  ('60000000-0000-0000-0000-000000000008', :'I1', :'SR2', 'lead-008', null, :'script', 4, 'end_details', null, 'other', '2026-10-10 10:00:00+00', 200),
  ('60000000-0000-0000-0000-000000000009', :'I1', :'SR1', 'lead-009', null, :'script', 4, 'end_won', null, 'won', '2026-10-01 10:00:00+00', 300),
  ('60000000-0000-0000-0000-000000000010', :'I1', :'SR2', 'lead-010', null, :'script', 3, 'end_won', null, 'won', '2026-10-08 13:00:00+00', 150),
  ('60000000-0000-0000-0000-000000000011', :'I1', :'SR1', 'lead-007-fix', '60000000-0000-0000-0000-000000000007', :'script', 4, 'end_details', 'Wrong', 'interested', null, 90);

-- ---------- admin: report ----------
select pg_temp.as_user(:'UA'::uuid, 'owner@sc.test');
set role authenticated;
select pg_temp.is_true('report: 8 original calls for v4 in the range',
  format($q$select (pg_temp.rep(%L, %L)->>'total_calls')::int = 8$q$, :'I1', :'v4'));
select pg_temp.is_true('report: 4 calls ended on end_details',
  format($q$select (x->>'calls')::int = 4 from jsonb_array_elements(pg_temp.rep(%L, %L)->'steps') x where x->>'step' = 'end_details'$q$, :'I1', :'v4'));
select pg_temp.is_true('report: end_details share is 0.5',
  format($q$select (x->>'share')::numeric = 0.5 from jsonb_array_elements(pg_temp.rep(%L, %L)->'steps') x where x->>'step' = 'end_details'$q$, :'I1', :'v4'));
select pg_temp.is_true('report: end_won reached by 1 call (outside-range and v3 calls excluded)',
  format($q$select (x->>'calls')::int = 1 from jsonb_array_elements(pg_temp.rep(%L, %L)->'steps') x where x->>'step' = 'end_won'$q$, :'I1', :'v4'));
select pg_temp.is_true('report: step counts add up to the total',
  format($q$select (select sum((x->>'calls')::int) from jsonb_array_elements(pg_temp.rep(%L, %L)->'steps') x) = 8$q$, :'I1', :'v4'));
select pg_temp.is_true('report: "Too expensive" raised by 3 calls',
  format($q$select (x->>'calls')::int = 3 from jsonb_array_elements(pg_temp.rep(%L, %L)->'objections') x where x->>'objection' = 'Too expensive'$q$, :'I1', :'v4'));
select pg_temp.is_true('report: "Not interested" raised once',
  format($q$select (x->>'calls')::int = 1 from jsonb_array_elements(pg_temp.rep(%L, %L)->'objections') x where x->>'objection' = 'Not interested'$q$, :'I1', :'v4'));
select pg_temp.is_true('report: a correction row is not counted as an objection',
  format($q$select not exists (select 1 from jsonb_array_elements(pg_temp.rep(%L, %L)->'objections') x where x->>'objection' = 'Wrong')$q$, :'I1', :'v4'));
select pg_temp.is_true('report: outcome "other" counted 3 times',
  format($q$select (x->>'calls')::int = 3 from jsonb_array_elements(pg_temp.rep(%L, %L)->'outcomes') x where x->>'outcome' = 'other'$q$, :'I1', :'v4'));
select pg_temp.is_true('report: outcome "interested" comes from the correction of c7',
  format($q$select (x->>'calls')::int = 1 from jsonb_array_elements(pg_temp.rep(%L, %L)->'outcomes') x where x->>'outcome' = 'interested'$q$, :'I1', :'v4'));
select pg_temp.is_true('report: outcome "not_interested" counted once (c4 only)',
  format($q$select (x->>'calls')::int = 1 from jsonb_array_elements(pg_temp.rep(%L, %L)->'outcomes') x where x->>'outcome' = 'not_interested'$q$, :'I1', :'v4'));
select pg_temp.is_true('report: v3 has 1 call (c10 only; c9 is outside the range)',
  format($q$select (pg_temp.rep(%L, %L)->>'total_calls')::int = 1$q$, :'I1', :'v3'));
select pg_temp.is_true('report: names the script and version',
  format($q$select (pg_temp.rep(%L, %L)->>'version')::int = 4 and pg_temp.rep(%L, %L)->>'script_name' = 'Vector sales'$q$, :'I1', :'v4', :'I1', :'v4'));
select pg_temp.fails('a report with the from time after the to time is refused',
  format($q$select admin_script_report(%L, %L, '2026-10-12 00:00:00+00', '2026-10-05 00:00:00+00')$q$, :'I1', :'v4'));

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
