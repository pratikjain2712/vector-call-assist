-- Tests for 20261025190000_presence_call_state.sql: the call state the caller screen reports (dialling,
-- connected, wrap-up, unconfirmed), the old two-argument report_presence, and what Home and Callers show from it
-- (home_seat_status through admin_home_summary and admin_callers). Run after every migration on a scratch
-- database with supabase/tests/stub_auth.sql. The last line prints passed and failed counts: expect failed = 0.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
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

\set inst 'b7777777-0000-0000-0000-000000000001'
\set u_o  'e7000000-0000-0000-0000-000000000001'
\set u_a  'e7000000-0000-0000-0000-000000000002'
\set u_b  'e7000000-0000-0000-0000-000000000003'
\set s_o  'e7100000-0000-0000-0000-000000000001'
\set s_a  'e7100000-0000-0000-0000-000000000002'
\set s_b  'e7100000-0000-0000-0000-000000000003'

-- A time zone where it is about noon now, so "today" holds the last few minutes whenever this runs.
select case when k = 0 then 'UTC' when k > 0 then 'Etc/GMT-' || k else 'Etc/GMT+' || (-k) end as tz
from (select (((12 - extract(hour from now() at time zone 'UTC')::int) + 11) % 24 + 24) % 24 - 11 as k) x \gset

reset role;
insert into auth.users (id, email) values (:'u_o', 'o@p.test'), (:'u_a', 'a@p.test'), (:'u_b', 'b@p.test');
insert into institutes (id, name, status, seat_limit, time_zone) values (:'inst', 'Inst P', 'active', 10, :'tz');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst', :'u_o', 'Owner', 'admin', 'active'),
 (:'s_a', :'inst', :'u_a', 'Caller A', 'rep', 'active'),
 (:'s_b', :'inst', :'u_b', 'Caller B', 'rep', 'active');

-- Home's "now" for a caller, read as the owner. Each test reads it afresh.
create or replace function pg_temp.now_of(label text) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform set_config('request.jwt.claim.sub', 'e7000000-0000-0000-0000-000000000001', false);
  select c->'now' into j from jsonb_array_elements(admin_home_summary('today', null)->'callers') c where c->>'label' = label;
  return j;
end $$;
grant execute on function pg_temp.now_of(text) to authenticated;
create or replace function pg_temp.row_of(s uuid) returns public.seat_presence language sql security definer as $$
  select * from public.seat_presence where seat_id = s;
$$;

-- ---------- the old two-argument call still works ----------
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.ok('old page: report_presence(true, true)', $q$select report_presence(true, true)$q$);
select pg_temp.val_is('old page: on a call, unconfirmed', $q$select (n->>'status') || '/' || (n->>'call_state') || '/' || (n->>'confirmed') from pg_temp.now_of('Caller A') n$q$, 'on_call/unconfirmed/false');
select pg_temp.as_user(:'u_a');
select pg_temp.ok('old page: named arguments (as PostgREST sends them)', $q$select report_presence(p_on_call => false, p_phone_ok => true)$q$);
select pg_temp.val_is('old page: no call is ready (the screen just opened)', $q$select n->>'status' from pg_temp.now_of('Caller A') n$q$, 'ready');

-- ---------- dialling and connected (confirmed by the phone) ----------
select pg_temp.as_user(:'u_a');
select pg_temp.ok('dialling with a start 2 minutes ago',
  $q$select report_presence(p_on_call => true, p_phone_ok => true, p_call_state => 'dialling', p_call_started_at => now() - interval '2 minutes')$q$);
select pg_temp.val_is('dialling: on a call, confirmed', $q$select (n->>'status') || '/' || (n->>'call_state') || '/' || (n->>'confirmed') from pg_temp.now_of('Caller A') n$q$, 'on_call/dialling/true');
select pg_temp.val_is('dialling: seconds from the start', $q$select ((n->>'seconds')::int between 115 and 130)::text from pg_temp.now_of('Caller A') n$q$, 'true');
reset role;
update seat_presence set state_at = now() - interval '20 seconds' where seat_id = :'s_a';
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.ok('connected without a start', $q$select report_presence(true, true, 'connected', null)$q$);
select pg_temp.val_is('connected keeps the call''s start', $q$select ((n->>'seconds')::int between 115 and 130)::text || (n->>'call_state') from pg_temp.now_of('Caller A') n$q$, 'trueconnected');
reset role;
select pg_temp.val_is('connected: the state change time moved', format($q$select (state_at > now() - interval '5 seconds')::text from seat_presence where seat_id = %L$q$, :'s_a'), 'true');
update seat_presence set state_at = now() - interval '30 seconds' where seat_id = :'s_a';
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.ok('the minute heartbeat, same state', $q$select report_presence(true, true, 'connected', now() - interval '2 minutes')$q$);
reset role;
select pg_temp.val_is('the same state keeps its change time', format($q$select (state_at < now() - interval '25 seconds')::text from seat_presence where seat_id = %L$q$, :'s_a'), 'true');
select pg_temp.val_is('on_call is kept for older readers', format($q$select on_call::text from seat_presence where seat_id = %L$q$, :'s_a'), 'true');

-- ---------- wrap-up ----------
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.ok('hang up: wrap-up', $q$select report_presence(false, true, 'wrapup', now() - interval '2 minutes')$q$);
select pg_temp.val_is('wrap-up shows', $q$select (n->>'status') || '/' || ((n->>'seconds')::int between 0 and 5)::text from pg_temp.now_of('Caller A') n$q$, 'wrapup/true');
reset role;
update seat_presence set state_at = now() - interval '40 seconds' where seat_id = :'s_a';
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.ok('wrap-up heartbeat', $q$select report_presence(false, true, 'wrapup', null)$q$);
select pg_temp.val_is('wrap-up counts from the hang-up', $q$select ((n->>'seconds')::int between 39 and 50)::text from pg_temp.now_of('Caller A') n$q$, 'true');
reset role;
update seat_presence set state_at = now() - interval '11 minutes' where seat_id = :'s_a';
select pg_temp.val_is('wrap-up ends after 10 minutes (normal rules)', $q$select n->>'status' from pg_temp.now_of('Caller A') n$q$, 'ready');

-- ---------- saved: ready ----------
insert into call_outcomes (institute_id, seat_id, client_record_id, outcome, dialled_at) values
 (:'inst', :'s_a', 'p-1', 'answered', now() - interval '3 minutes');
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.ok('saved: none', $q$select report_presence(false, true, 'none', null)$q$);
select pg_temp.val_is('saved: ready', $q$select n->>'status' from pg_temp.now_of('Caller A') n$q$, 'ready');
reset role;
select pg_temp.val_is('saved: no call start kept', format($q$select coalesce(call_started_at::text, 'null') from seat_presence where seat_id = %L$q$, :'s_a'), 'null');

-- ---------- unconfirmed, clocks, offline, stale ----------
set role authenticated;
select pg_temp.as_user(:'u_b');
select pg_temp.ok('unconfirmed with a start', $q$select report_presence(true, true, 'unconfirmed', now() - interval '1 minute')$q$);
select pg_temp.val_is('unconfirmed shows as an unconfirmed call', $q$select (n->>'status') || '/' || (n->>'confirmed') || '/' || ((n->>'seconds')::int between 55 and 70)::text from pg_temp.now_of('Caller B') n$q$, 'on_call/false/true');
select pg_temp.as_user(:'u_b');
select pg_temp.ok('a start in the future', $q$select report_presence(true, true, 'connected', now() + interval '1 hour')$q$);
select pg_temp.val_is('a start in the future counts from now', $q$select ((n->>'seconds')::int between 0 and 5)::text from pg_temp.now_of('Caller B') n$q$, 'true');
select pg_temp.as_user(:'u_b');
select pg_temp.ok('a start a day ago', $q$select report_presence(true, true, 'dialling', now() - interval '1 day')$q$);
select pg_temp.val_is('a start a day ago is not believed', $q$select ((n->>'seconds')::int < 3600)::text from pg_temp.now_of('Caller B') n$q$, 'true');
select pg_temp.as_user(:'u_b');
select pg_temp.fails('an unknown call state is refused', $q$select report_presence(true, true, 'ringing', null)$q$);
select pg_temp.as_user(:'u_b');
select pg_temp.ok('phone offline during a call', $q$select report_presence(true, false, 'unconfirmed', null)$q$);
select pg_temp.val_is('phone offline comes first', $q$select n->>'status' from pg_temp.now_of('Caller B') n$q$, 'phone_offline');
select pg_temp.as_user(:'u_b');
select pg_temp.ok('connected again', $q$select report_presence(true, true, 'connected', now() - interval '1 minute')$q$);
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('Callers tab: on a call', format($q$select now_status->>'status' || '/' || (now_status->>'call_state') from admin_callers(%L) where seat_id = %L$q$, :'inst', :'s_b'), 'on_call/connected');
reset role;
update seat_presence set seen_at = now() - interval '4 minutes' where seat_id = :'s_b';
select pg_temp.val_is('a screen not seen for 4 minutes is not on a call', $q$select n->>'status' from pg_temp.now_of('Caller B') n$q$, 'not_started');
select pg_temp.val_is('the browser cannot read presence rows', $q$select (has_table_privilege('authenticated', 'public.seat_presence', 'select'))::text$q$, 'false');

-- ---------- who may call it ----------
set role authenticated;
select pg_temp.as_user(null);
select pg_temp.fails('a login without a seat cannot report', $q$select report_presence(true, true, 'connected', now())$q$);
reset role;
set role anon;
select pg_temp.fails('anon: no presence (four arguments)', $q$select report_presence(true, true, 'connected', now())$q$);
select pg_temp.fails('anon: no presence (two arguments)', $q$select report_presence(false, true)$q$);
reset role;

select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
