-- Admin guard tests for 20261011100005_admin_guard.sql. Run after migrations 0001 to 0005 on a
-- scratch database with the same stub auth layer as seat_functions_test.sql.
-- Expect: 11 passed, 0 failed.
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

-- Setup: one institute with two admins (owner and co-admin), one rep, and an outsider login.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 ('bbbbbbb1-0000-0000-0000-000000000001','owner@guard.test', now()),
 ('bbbbbbb1-0000-0000-0000-000000000002','admin2@guard.test', now()),
 ('bbbbbbb1-0000-0000-0000-000000000003','rep@guard.test', now()),
 ('bbbbbbb1-0000-0000-0000-000000000004','outsider@other.test', now());
insert into institutes (id, name, status, seat_limit) values
 ('bbbbbbb2-0000-0000-0000-000000000001','Guard Inst','active',5);
insert into seats (id, institute_id, user_id, label, role, status) values
 ('bbbbbbb3-0000-0000-0000-000000000001','bbbbbbb2-0000-0000-0000-000000000001','bbbbbbb1-0000-0000-0000-000000000001','Owner','admin','active'),
 ('bbbbbbb3-0000-0000-0000-000000000002','bbbbbbb2-0000-0000-0000-000000000001','bbbbbbb1-0000-0000-0000-000000000002','Admin 2','admin','active'),
 ('bbbbbbb3-0000-0000-0000-000000000003','bbbbbbb2-0000-0000-0000-000000000001','bbbbbbb1-0000-0000-0000-000000000003','Rep 1','rep','active'),
 ('bbbbbbb3-0000-0000-0000-000000000004','bbbbbbb2-0000-0000-0000-000000000001',NULL,'Rep 2','rep','invited');
insert into devices (seat_id, kind, fingerprint) values
 ('bbbbbbb3-0000-0000-0000-000000000003','phone','fp-guard-rep1-000000001');

-- 1. Owner (admin) revokes a rep: allowed; the rep's device is unpaired.
select pg_temp.as_user('bbbbbbb1-0000-0000-0000-000000000001','owner@guard.test');
set role authenticated;
select pg_temp.ok('admin revokes a rep', $q$select revoke_seat('bbbbbbb3-0000-0000-0000-000000000003')$q$);
reset role;
select pg_temp.rows_is('revoking a rep unpairs its devices',
  $q$select count(*) from devices where seat_id='bbbbbbb3-0000-0000-0000-000000000003' and revoked_at is null$q$, 0);

-- 2. Owner cannot revoke their own seat.
select pg_temp.as_user('bbbbbbb1-0000-0000-0000-000000000001','owner@guard.test');
set role authenticated;
select pg_temp.fails('admin cannot revoke own seat', $q$select revoke_seat('bbbbbbb3-0000-0000-0000-000000000001')$q$);
-- 3. Owner cannot revoke another admin's seat.
select pg_temp.fails('admin cannot revoke another admin', $q$select revoke_seat('bbbbbbb3-0000-0000-0000-000000000002')$q$);
-- 4. Owner cannot reassign another admin's seat.
select pg_temp.fails('admin cannot reassign another admin', $q$select reassign_seat('bbbbbbb3-0000-0000-0000-000000000002', 'new@guard.test')$q$);
-- 5. Owner cannot reassign their own seat.
select pg_temp.fails('admin cannot reassign own seat', $q$select reassign_seat('bbbbbbb3-0000-0000-0000-000000000001', 'new@guard.test')$q$);
reset role;
select pg_temp.rows_is('admin seats are unchanged after refused calls',
  $q$select count(*) from seats where role='admin' and status='active' and user_id is not null$q$, 2);

-- 6. A rep cannot revoke anyone.
select pg_temp.as_user('bbbbbbb1-0000-0000-0000-000000000003','rep@guard.test');
set role authenticated;
select pg_temp.fails('rep cannot revoke an admin seat', $q$select revoke_seat('bbbbbbb3-0000-0000-0000-000000000001')$q$);
reset role;

-- 7. An outsider cannot revoke a seat in this institute.
select pg_temp.as_user('bbbbbbb1-0000-0000-0000-000000000004','outsider@other.test');
set role authenticated;
select pg_temp.fails('outsider cannot revoke', $q$select revoke_seat('bbbbbbb3-0000-0000-0000-000000000002')$q$);
reset role;

-- 8. Owner can still reassign a rep seat (behaviour unchanged).
select pg_temp.as_user('bbbbbbb1-0000-0000-0000-000000000001','owner@guard.test');
set role authenticated;
select pg_temp.ok('admin reassigns a rep', $q$select reassign_seat('bbbbbbb3-0000-0000-0000-000000000004', 'newrep@guard.test')$q$);
reset role;

-- 9. Audit log has the allowed actions only.
select pg_temp.rows_is('audit log has only the allowed revoke and reassign entries',
  $q$select count(*) from audit_log where action in ('seat.revoked','seat.reassigned') and institute_id='bbbbbbb2-0000-0000-0000-000000000001'$q$, 2);

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
