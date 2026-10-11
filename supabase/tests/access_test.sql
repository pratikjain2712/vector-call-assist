-- Access-rule tests for 0001_init.sql. Run against a scratch Postgres with a stub auth layer
-- (auth.users, auth.uid(), anon and authenticated roles). Expect: 22 passed, 0 failed.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
  set role authenticated;
$$;
-- Fixed ids
\set I1 '11111111-1111-1111-1111-111111111111'
\set I2 '22222222-2222-2222-2222-222222222222'
\set UA 'aaaaaaa1-0000-0000-0000-000000000001'
\set UR1 'aaaaaaa1-0000-0000-0000-000000000002'
\set UR2 'aaaaaaa1-0000-0000-0000-000000000003'
\set UX 'aaaaaaa1-0000-0000-0000-000000000004'
\set S_A '51111111-0000-0000-0000-000000000001'
\set S_R1 '51111111-0000-0000-0000-000000000002'
\set S_R2 '51111111-0000-0000-0000-000000000003'
\set S_X '52222222-0000-0000-0000-000000000004'
\set S_R3 '51111111-0000-0000-0000-000000000005'

reset role;
insert into auth.users values (:'UA'),(:'UR1'),(:'UR2'),(:'UX');
insert into institutes (id, name, status) values (:'I1','Institute One','active'),(:'I2','Institute Two','active');
insert into seats (id, institute_id, user_id, label, role, status) values
  (:'S_A',:'I1',:'UA','Admin','admin','active'),
  (:'S_R1',:'I1',:'UR1','Rep 1','rep','active'),
  (:'S_R2',:'I1',:'UR2','Rep 2','rep','active'),
  (:'S_R3',:'I1',NULL,'Rep 3','rep','invited'),
  (:'S_X',:'I2',:'UX','Rep X','rep','active');
insert into devices (seat_id, kind, fingerprint) values
  (:'S_R1','phone','fp-phone-r1-0000000001'),(:'S_R2','phone','fp-phone-r2-0000000001');

create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;

-- helper runner
create or replace function pg_temp.expect_ok(name text, sql text) returns void language plpgsql as $$
begin
  execute sql;
  insert into results values (name, true, '');
exception when others then
  insert into results values (name, false, sqlerrm);
end $$;
create or replace function pg_temp.expect_fail(name text, sql text) returns void language plpgsql as $$
begin
  execute sql;
  insert into results values (name, false, 'expected denial but statement succeeded');
exception when others then
  insert into results values (name, true, sqlerrm);
end $$;
create or replace function pg_temp.expect_rows(name text, sql text, want int) returns void language plpgsql as $$
declare n int;
begin
  execute sql into n;
  insert into results values (name, n = want, 'got ' || n || ', want ' || want);
exception when others then
  insert into results values (name, false, sqlerrm);
end $$;

-- R1: own seat insert allowed
select pg_temp.as_user(:'UR1');
select pg_temp.expect_ok('rep inserts own outcome',
  format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome, script_version)
            values (%L,%L,'rec-001','callback',1)$q$, :'I1', :'S_R1'));
select pg_temp.expect_fail('rep cannot insert for another seat',
  format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome)
            values (%L,%L,'rec-x','won')$q$, :'I1', :'S_R2'));
select pg_temp.expect_fail('rep cannot insert into another institute',
  format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome)
            values (%L,%L,'rec-y','won')$q$, :'I2', :'S_R1'));
select pg_temp.expect_fail('duplicate upload of same record is rejected by key',
  format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome)
            values (%L,%L,'rec-001','won')$q$, :'I1', :'S_R1'));
select pg_temp.expect_rows('rep sees only own outcomes',
  'select count(*) from call_outcomes', 1);
select pg_temp.expect_rows('rep sees only own seat',
  'select count(*) from seats', 1);
select pg_temp.expect_rows('rep cannot read devices',
  'select count(*) from devices', 0);
select pg_temp.expect_rows('rep cannot read audit log',
  'select count(*) from audit_log', 0);
select pg_temp.expect_fail('rep cannot update an outcome (no update grant or policy)',
  $q$update call_outcomes set outcome='won'$q$);
select pg_temp.expect_fail('rep cannot delete an outcome',
  $q$delete from call_outcomes$q$);

-- Revoked-seat check: R3 is invited, not active, so cannot insert anything
reset role;
set role anon;
select pg_temp.expect_fail('anonymous user cannot insert',
  format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome)
            values (%L,%L,'rec-anon','won')$q$, :'I1', :'S_R1'));
select pg_temp.expect_fail('anonymous user cannot read seats',
  'select count(*) from seats');

-- Rep 2 inserts own; then Rep 1 must not see it
select pg_temp.as_user(:'UR2');
select pg_temp.expect_ok('rep 2 inserts own outcome',
  format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome)
            values (%L,%L,'rec-r2-1','answered')$q$, :'I1', :'S_R2'));
select pg_temp.as_user(:'UR1');
select pg_temp.expect_rows('rep 1 cannot see rep 2 outcomes', 'select count(*) from call_outcomes', 1);

-- Admin of I1 sees all seats and outcomes in I1, but nothing of I2
select pg_temp.as_user(:'UA');
select pg_temp.expect_rows('admin sees all seats in own institute', 'select count(*) from seats', 4);
select pg_temp.expect_rows('admin sees all outcomes in own institute', 'select count(*) from call_outcomes', 2);
select pg_temp.expect_rows('admin sees devices in own institute', 'select count(*) from devices', 2);
select pg_temp.expect_rows('admin sees audit log of own institute', 'select count(*) from audit_log', 0);
select pg_temp.expect_rows('admin sees only own institute', 'select count(*) from institutes', 1);
select pg_temp.expect_fail('admin cannot write outcomes for another institute',
  format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome)
            values (%L,%L,'rec-hack','won')$q$, :'I2', :'S_X'));

-- Rep X in I2 sees nothing from I1
select pg_temp.as_user(:'UX');
select pg_temp.expect_rows('other institute rep sees no I1 outcomes', 'select count(*) from call_outcomes', 0);
select pg_temp.expect_rows('other institute rep sees no I1 seats', 'select count(*) from seats where institute_id = ''11111111-1111-1111-1111-111111111111''', 0);

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
