-- Admin report tests for 0004_admin_views.sql. Run after 0001 to 0004 on a fresh scratch database
-- with the same stub auth layer as access_test.sql. Every expected number is hand-counted in the
-- fixture comments below. The last result line prints passed and failed counts: expect failed = 0.
\set ON_ERROR_STOP 0
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
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;

\set rng_from '2026-10-05 00:00:00+00'
\set rng_to   '2026-10-12 00:00:00+00'

-- ---------- fixtures ----------
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 ('bbbbbbb2-0000-0000-0000-000000000001','admin@views.test', now()),
 ('bbbbbbb2-0000-0000-0000-000000000002','rep1@views.test', now()),
 ('bbbbbbb2-0000-0000-0000-000000000003','rep2@views.test', now()),
 ('bbbbbbb2-0000-0000-0000-000000000004','outsider@other.test', now()),
 ('bbbbbbb2-0000-0000-0000-000000000005','nobody@views.test', now());

-- Institute with an admin and four seats: Rep 1 and Rep 2 claimed, Rep 3 invited only, Rep 4 revoked.
select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000001','admin@views.test');
set role authenticated;
select pg_temp.ok('admin creates institute', $q$select create_institute('Views Inst', 6)$q$);
select pg_temp.ok('admin invites rep1', $q$select invite_seat((select id from institutes where name='Views Inst'),'rep1@views.test','Rep 1','rep')$q$);
select pg_temp.ok('admin invites rep2', $q$select invite_seat((select id from institutes where name='Views Inst'),'rep2@views.test','Rep 2','rep')$q$);
select pg_temp.ok('admin invites rep3 (never claimed)', $q$select invite_seat((select id from institutes where name='Views Inst'),'rep3@views.test','Rep 3','rep')$q$);
select pg_temp.ok('admin invites rep4 (then revoked)', $q$select invite_seat((select id from institutes where name='Views Inst'),'rep4@views.test','Rep 4','rep')$q$);
select pg_temp.ok('admin revokes rep4', $q$select revoke_seat((select id from seats where label='Rep 4'))$q$);
reset role;
select id as inst from institutes where name='Views Inst' \gset

-- Second institute, run by an outsider who is an admin there only.
select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000004','outsider@other.test');
set role authenticated;
select pg_temp.ok('outsider creates their own institute', $q$select create_institute('Views Other', 2)$q$);
reset role;
select id as other from institutes where name='Views Other' \gset

-- Reps claim their seats and pair devices.
select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000002','rep1@views.test');
set role authenticated;
select pg_temp.ok('rep1 claims seat', $q$select claim_my_invite()$q$);
reset role;
select id as seat_r1 from seats where institute_id = :'inst' and label='Rep 1' \gset
select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000003','rep2@views.test');
set role authenticated;
select pg_temp.ok('rep2 claims seat', $q$select claim_my_invite()$q$);
reset role;
select id as seat_r2 from seats where institute_id = :'inst' and label='Rep 2' \gset

select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000002','rep1@views.test');
set role authenticated;
select pg_temp.ok('rep1 pairs phone', format($q$select register_device(%L,'phone','fp-phone-views-0001')$q$, :'seat_r1'));
select pg_temp.ok('rep1 pairs laptop', format($q$select register_device(%L,'laptop','fp-laptop-views-001')$q$, :'seat_r1'));
reset role;
select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000003','rep2@views.test');
set role authenticated;
select pg_temp.ok('rep2 pairs laptop only', format($q$select register_device(%L,'laptop','fp-laptop-views-002')$q$, :'seat_r2'));
reset role;

-- Outcomes, written directly as the table owner (the browser path is tested in seat_functions_test).
-- Rep 1, 2026-10-06 (UTC): A 10:00 answered 120s; B 11:00 no_answer 0s, later corrected by C to
--   answered 45s; D 12:00 callback 30s.                        -> 3 calls, 3 connected, 195 talk s.
-- Rep 1, 2026-10-07: E 09:00 won 300s; F 09:30 busy, no time.  -> 2 calls, 1 connected, 300 talk s.
-- Rep 1, 2026-10-04: G answered 999s, outside the range.        -> excluded everywhere.
-- Rep 2, 2026-10-06: H 14:00 not_interested 0s, corrected by H1 to callback 0s, corrected by H2 to
--   won 90s (a correction of a correction); J 15:00 answered 60s. -> 2 calls, 2 connected, 150 talk s.
insert into call_outcomes (id, institute_id, seat_id, client_record_id, corrects_id, outcome, dialled_at, connected_seconds) values
 ('c0000000-0000-0000-0000-000000000001', :'inst', :'seat_r1', 'r1-A', null, 'answered', '2026-10-06 10:00+00', 120),
 ('c0000000-0000-0000-0000-000000000002', :'inst', :'seat_r1', 'r1-B', null, 'no_answer', '2026-10-06 11:00+00', 0),
 ('c0000000-0000-0000-0000-000000000003', :'inst', :'seat_r1', 'r1-D', null, 'callback', '2026-10-06 12:00+00', 30),
 ('c0000000-0000-0000-0000-000000000004', :'inst', :'seat_r1', 'r1-E', null, 'won', '2026-10-07 09:00+00', 300),
 ('c0000000-0000-0000-0000-000000000005', :'inst', :'seat_r1', 'r1-F', null, 'busy', '2026-10-07 09:30+00', null),
 ('c0000000-0000-0000-0000-000000000006', :'inst', :'seat_r1', 'r1-G', null, 'answered', '2026-10-04 10:00+00', 999),
 ('c0000000-0000-0000-0000-000000000007', :'inst', :'seat_r1', 'r1-B-fix', 'c0000000-0000-0000-0000-000000000002', 'answered', null, 45),
 ('c0000000-0000-0000-0000-000000000008', :'inst', :'seat_r2', 'r2-H', null, 'not_interested', '2026-10-06 14:00+00', 0),
 ('c0000000-0000-0000-0000-000000000009', :'inst', :'seat_r2', 'r2-J', null, 'answered', '2026-10-06 15:00+00', 60),
 ('c0000000-0000-0000-0000-00000000000a', :'inst', :'seat_r2', 'r2-H-fix1', 'c0000000-0000-0000-0000-000000000008', 'callback', null, 0),
 ('c0000000-0000-0000-0000-00000000000b', :'inst', :'seat_r2', 'r2-H-fix2', 'c0000000-0000-0000-0000-00000000000a', 'won', null, 90);

-- ---------- admin sees their institute ----------
select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000001','admin@views.test');
set role authenticated;
select pg_temp.ok('admin reads team activity', format($q$select * from admin_team_activity(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'));
select pg_temp.ok('admin reads results by outcome', format($q$select * from admin_results_by_outcome(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'));
select pg_temp.ok('admin reads seat list', format($q$select * from admin_seat_list(%L)$q$, :'inst'));

select pg_temp.val_is('team activity has 3 rep-days', format($q$select count(*)::text from admin_team_activity(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'), '3');
select pg_temp.val_is('Rep 1 on 10-06: 3 calls', format($q$select calls::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-06'$q$, :'inst', :'rng_from', :'rng_to'), '3');
select pg_temp.val_is('Rep 1 on 10-06: 3 connected (correction used)', format($q$select connected_calls::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-06'$q$, :'inst', :'rng_from', :'rng_to'), '3');
select pg_temp.val_is('Rep 1 on 10-06: connect rate 1', format($q$select (connect_rate = 1)::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-06'$q$, :'inst', :'rng_from', :'rng_to'), 'true');
select pg_temp.val_is('Rep 1 on 10-06: talk 195 s (corrected 45 counted)', format($q$select talk_seconds::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-06'$q$, :'inst', :'rng_from', :'rng_to'), '195');
select pg_temp.val_is('Rep 1 on 10-06: last call 12:00', format($q$select (last_activity = '2026-10-06 12:00:00+00'::timestamptz)::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-06'$q$, :'inst', :'rng_from', :'rng_to'), 'true');
select pg_temp.val_is('Rep 1 on 10-07: 2 calls', format($q$select calls::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-07'$q$, :'inst', :'rng_from', :'rng_to'), '2');
select pg_temp.val_is('Rep 1 on 10-07: 1 connected', format($q$select connected_calls::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-07'$q$, :'inst', :'rng_from', :'rng_to'), '1');
select pg_temp.val_is('Rep 1 on 10-07: connect rate 0.5', format($q$select (connect_rate = 0.5)::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-07'$q$, :'inst', :'rng_from', :'rng_to'), 'true');
select pg_temp.val_is('Rep 1 on 10-07: talk 300 s', format($q$select talk_seconds::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-07'$q$, :'inst', :'rng_from', :'rng_to'), '300');
select pg_temp.val_is('Rep 1 on 10-07: last call 09:30', format($q$select (last_activity = '2026-10-07 09:30:00+00'::timestamptz)::text from admin_team_activity(%L,%L,%L) where label='Rep 1' and day='2026-10-07'$q$, :'inst', :'rng_from', :'rng_to'), 'true');
select pg_temp.val_is('Rep 2 on 10-06: 2 connected after two corrections', format($q$select connected_calls::text from admin_team_activity(%L,%L,%L) where label='Rep 2' and day='2026-10-06'$q$, :'inst', :'rng_from', :'rng_to'), '2');
select pg_temp.val_is('Rep 2 on 10-06: talk 150 s (90 from the last correction)', format($q$select talk_seconds::text from admin_team_activity(%L,%L,%L) where label='Rep 2' and day='2026-10-06'$q$, :'inst', :'rng_from', :'rng_to'), '150');
select pg_temp.val_is('range total is 7 calls (10-04 call excluded)', format($q$select sum(calls)::text from admin_team_activity(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'), '7');
select pg_temp.ok('time zone argument accepted', format($q$select * from admin_team_activity(%L,%L,%L,'Asia/Kolkata')$q$, :'inst', :'rng_from', :'rng_to'));
select pg_temp.fails('unknown time zone refused', format($q$select * from admin_team_activity(%L,%L,%L,'Mars/Olympus')$q$, :'inst', :'rng_from', :'rng_to'));
select pg_temp.fails('from after to refused', format($q$select * from admin_team_activity(%L,%L,%L)$q$, :'inst', :'rng_to', :'rng_from'));
select pg_temp.fails('range over 400 days refused', format($q$select * from admin_results_by_outcome(%L,'2020-01-01 00:00+00','2026-10-12 00:00+00')$q$, :'inst'));

select pg_temp.val_is('results: Rep 1 answered 2 (B corrected to answered)', format($q$select outcome_count::text from admin_results_by_outcome(%L,%L,%L) where label='Rep 1' and outcome='answered'$q$, :'inst', :'rng_from', :'rng_to'), '2');
select pg_temp.val_is('results: Rep 1 has no no_answer (corrected away)', format($q$select count(*)::text from admin_results_by_outcome(%L,%L,%L) where label='Rep 1' and outcome='no_answer'$q$, :'inst', :'rng_from', :'rng_to'), '0');
select pg_temp.val_is('results: Rep 2 won 1 (end of correction chain)', format($q$select outcome_count::text from admin_results_by_outcome(%L,%L,%L) where label='Rep 2' and outcome='won'$q$, :'inst', :'rng_from', :'rng_to'), '1');
select pg_temp.val_is('results: 7 outcomes in total', format($q$select sum(outcome_count)::text from admin_results_by_outcome(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'), '7');
select pg_temp.val_is('results: 6 rep-outcome rows', format($q$select count(*)::text from admin_results_by_outcome(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'), '6');

select pg_temp.val_is('seat list: 5 seats (admin, rep 1 to 4)', format($q$select count(*)::text from admin_seat_list(%L)$q$, :'inst'), '5');
select pg_temp.val_is('seat list: Rep 1 has a phone', format($q$select has_phone::text from admin_seat_list(%L) where label='Rep 1'$q$, :'inst'), 'true');
select pg_temp.val_is('seat list: Rep 1 device kinds', format($q$select array_to_string(device_kinds, ',') from admin_seat_list(%L) where label='Rep 1'$q$, :'inst'), 'laptop,phone');
select pg_temp.val_is('seat list: Rep 1 last call 10-07 09:30', format($q$select (last_call_at = '2026-10-07 09:30:00+00'::timestamptz)::text from admin_seat_list(%L) where label='Rep 1'$q$, :'inst'), 'true');
select pg_temp.val_is('seat list: Rep 2 has no phone', format($q$select has_phone::text from admin_seat_list(%L) where label='Rep 2'$q$, :'inst'), 'false');
select pg_temp.val_is('seat list: Rep 2 device kinds', format($q$select array_to_string(device_kinds, ',') from admin_seat_list(%L) where label='Rep 2'$q$, :'inst'), 'laptop');
select pg_temp.val_is('seat list: Rep 3 still invited', format($q$select status from admin_seat_list(%L) where label='Rep 3'$q$, :'inst'), 'invited');
select pg_temp.val_is('seat list: Rep 3 has no call time', format($q$select (last_call_at is null)::text from admin_seat_list(%L) where label='Rep 3'$q$, :'inst'), 'true');
select pg_temp.val_is('seat list: Rep 4 revoked', format($q$select status from admin_seat_list(%L) where label='Rep 4'$q$, :'inst'), 'revoked');
reset role;

-- ---------- a rep gets an error ----------
select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000002','rep1@views.test');
set role authenticated;
select pg_temp.fails('rep cannot read team activity', format($q$select * from admin_team_activity(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'));
select pg_temp.fails('rep cannot read results by outcome', format($q$select * from admin_results_by_outcome(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'));
select pg_temp.fails('rep cannot read seat list', format($q$select * from admin_seat_list(%L)$q$, :'inst'));
reset role;

-- ---------- an outsider gets an error ----------
select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000004','outsider@other.test');
set role authenticated;
select pg_temp.fails('admin of another institute cannot read team activity', format($q$select * from admin_team_activity(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'));
select pg_temp.fails('admin of another institute cannot read results', format($q$select * from admin_results_by_outcome(%L,%L,%L)$q$, :'inst', :'rng_from', :'rng_to'));
select pg_temp.fails('admin of another institute cannot read seat list', format($q$select * from admin_seat_list(%L)$q$, :'inst'));
select pg_temp.ok('own institute seat list reads fine', format($q$select * from admin_seat_list(%L)$q$, :'other'));
select pg_temp.val_is('own institute has no calls', format($q$select count(*)::text from admin_team_activity(%L,%L,%L)$q$, :'other', :'rng_from', :'rng_to'), '0');
reset role;

select pg_temp.as_user('bbbbbbb2-0000-0000-0000-000000000005','nobody@views.test');
set role authenticated;
select pg_temp.fails('login with no seat cannot read seat list', format($q$select * from admin_seat_list(%L)$q$, :'inst'));
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot execute admin_team_activity', $q$select has_function_privilege('anon','public.admin_team_activity(uuid,timestamptz,timestamptz,text)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot execute admin_results_by_outcome', $q$select has_function_privilege('anon','public.admin_results_by_outcome(uuid,timestamptz,timestamptz)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot execute admin_seat_list', $q$select has_function_privilege('anon','public.admin_seat_list(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated can execute admin_seat_list', $q$select has_function_privilege('authenticated','public.admin_seat_list(uuid)','EXECUTE')::text$q$, 'true');
select pg_temp.val_is('authenticated cannot call the unchecked helper', $q$select has_function_privilege('authenticated','public.admin_effective_outcomes(uuid,timestamptz,timestamptz)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot call admin_require directly', $q$select has_function_privilege('authenticated','public.admin_require(uuid)','EXECUTE')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
