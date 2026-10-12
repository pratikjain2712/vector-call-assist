-- Terms-per-person tests for 20261011100008_terms_per_person.sql. Run after 0001 to 0008 on a fresh scratch
-- database with the same stub auth layer as team_tools_test.sql. Expect: 23 passed, 0 failed.
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
create or replace function pg_temp.rows_is(name text, sql text, want int) returns void language plpgsql as $$
declare n int; begin execute sql into n; insert into results values (name, n = want, 'got '||n||', want '||want);
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;

-- Runs in one transaction and rolls back at the end, so the audit_log rows it writes do not reach the
-- counts in seat_functions_test.sql, which run after it.
begin;

-- ---------- fixed ids ----------
\set inst '63333333-0000-0000-0000-000000000003'
\set u_adm 'b8000000-0000-0000-0000-000000000001'
\set u_a   'b8000000-0000-0000-0000-000000000002'
\set u_b   'b8000000-0000-0000-0000-000000000003'
\set s_adm '73000000-0000-0000-0000-000000000001'
\set s_rep '73000000-0000-0000-0000-000000000002'

-- ---------- fixtures (as the table owner) ----------
-- Inst: admin Adm; rep seat s_rep held by user A (active). Nobody else holds a seat.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_adm', 'admin@tpp.test', now()),
 (:'u_a',   'a@tpp.test', now()),
 (:'u_b',   'b@tpp.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst', 'Per Person Inst', 'active', 10);
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_adm', :'inst', :'u_adm', 'Admin', 'admin', 'active'),
 (:'s_rep', :'inst', :'u_a',   'Rep',   'rep',   'active');

-- ---------- user A accepts ----------
select pg_temp.as_user(:'u_a', 'a@tpp.test');
set role authenticated;
select pg_temp.ok('A accepts terms v1', format($q$select accept_terms(%L,'v1','hash-a-first-000000')$q$, :'inst'));
select pg_temp.ok('A accepts v1 again without error', format($q$select accept_terms(%L,'v1','hash-a-second-11111')$q$, :'inst'));
select pg_temp.rows_is('A my_terms_status shows v1 once', format($q$select count(*)::int from my_terms_status(%L)$q$, :'inst'), 1);
reset role;
select pg_temp.val_is('A has exactly one v1 row, keyed to A', format($q$select count(*)::text from accepted_terms where user_id=%L and terms_version='v1'$q$, :'u_a'), '1');

-- ---------- admin hands the seat to B ----------
select pg_temp.as_user(:'u_adm', 'admin@tpp.test');
set role authenticated;
select pg_temp.ok('admin reassigns the rep seat to b@tpp.test', format($q$select reassign_seat(%L,'b@tpp.test')$q$, :'s_rep'));
reset role;

-- ---------- user B claims the seat ----------
select pg_temp.as_user(:'u_b', 'b@tpp.test');
set role authenticated;
select pg_temp.ok('B claims the reassigned seat', $q$select claim_my_invite()$q$);
select pg_temp.rows_is('B my_terms_status shows nothing (A acceptance is not B)', format($q$select count(*)::int from my_terms_status(%L)$q$, :'inst'), 0);
select pg_temp.ok('B accepts terms v1 on the same seat', format($q$select accept_terms(%L,'v1','hash-b-first-000000')$q$, :'inst'));
select pg_temp.rows_is('B my_terms_status shows v1 once', format($q$select count(*)::int from my_terms_status(%L)$q$, :'inst'), 1);
select pg_temp.rows_is('B reads only its own acceptance on the seat', format($q$select count(*)::int from accepted_terms where seat_id=%L$q$, :'s_rep'), 1);
reset role;

-- ---------- rows after the reassignment ----------
select pg_temp.val_is('B has its own v1 row on the seat', format($q$select count(*)::text from accepted_terms where user_id=%L and seat_id=%L and terms_version='v1'$q$, :'u_b', :'s_rep'), '1');
select pg_temp.val_is('A row is still there after the reassignment', format($q$select count(*)::text from accepted_terms where user_id=%L and seat_id=%L and terms_version='v1' and text_hash='hash-a-first-000000'$q$, :'u_a', :'s_rep'), '1');
select pg_temp.val_is('the seat has two v1 acceptances in total', format($q$select count(*)::text from accepted_terms where seat_id=%L and terms_version='v1'$q$, :'s_rep'), '2');

-- ---------- B accepts again: idempotent ----------
select pg_temp.as_user(:'u_b', 'b@tpp.test');
set role authenticated;
select pg_temp.ok('B accepts v1 again without error', format($q$select accept_terms(%L,'v1','hash-b-second-22222')$q$, :'inst'));
reset role;
select pg_temp.val_is('idempotent: B still has one v1 row', format($q$select count(*)::text from accepted_terms where user_id=%L$q$, :'u_b'), '1');
select pg_temp.val_is('idempotent: B keeps the first hash', format($q$select text_hash from accepted_terms where user_id=%L$q$, :'u_b'), 'hash-b-first-000000');
select pg_temp.val_is('idempotent: A row unchanged after B repeats', format($q$select text_hash from accepted_terms where user_id=%L and terms_version='v1'$q$, :'u_a'), 'hash-a-first-000000');

-- ---------- A no longer holds the seat ----------
select pg_temp.as_user(:'u_a', 'a@tpp.test');
set role authenticated;
select pg_temp.fails('A cannot accept terms on a seat it no longer holds', format($q$select accept_terms(%L,'v2','hash-a-third-33333')$q$, :'inst'));
select pg_temp.rows_is('A my_terms_status is empty without an active seat', format($q$select count(*)::int from my_terms_status(%L)$q$, :'inst'), 0);
reset role;

-- ---------- admin reads both rows ----------
select pg_temp.as_user(:'u_adm', 'admin@tpp.test');
set role authenticated;
select pg_temp.rows_is('admin reads both acceptances for the institute', format($q$select count(*)::int from accepted_terms where institute_id=%L$q$, :'inst'), 2);
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot execute accept_terms', $q$select has_function_privilege('anon','public.accept_terms(uuid,text,text)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot execute my_terms_status', $q$select has_function_privilege('anon','public.my_terms_status(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated can execute my_terms_status', $q$select has_function_privilege('authenticated','public.my_terms_status(uuid)','EXECUTE')::text$q$, 'true');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;

rollback;
