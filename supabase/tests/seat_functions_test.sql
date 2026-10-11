-- Seat and invite function tests for 0002_seat_functions.sql. Run after 0001 on a scratch database
-- with the same stub auth layer as access_test.sql. Expect: 25 passed, 0 failed.
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

reset role;
insert into auth.users (id, email, email_confirmed_at) values
 ('aaaaaaa1-0000-0000-0000-000000000001','owner@inst.test', now()),
 ('aaaaaaa1-0000-0000-0000-000000000002','rep1@inst.test', now()),
 ('aaaaaaa1-0000-0000-0000-000000000004','outsider@other.test', now()),
 ('aaaaaaa1-0000-0000-0000-000000000005','unconfirmed@inst.test', null);

-- Owner creates an institute with 3 seats
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000001','owner@inst.test');
set role authenticated;
select pg_temp.ok('owner creates institute', $q$select create_institute('Inst One', 3)$q$);
reset role;
select id as inst from institutes where name='Inst One' \gset
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000001','owner@inst.test');
set role authenticated;
select pg_temp.ok('owner invites rep1', format($q$select invite_seat(%L,'rep1@inst.test','Rep 1','rep')$q$, :'inst'));
select pg_temp.ok('owner invites rep2', format($q$select invite_seat(%L,'rep2@inst.test','Rep 2','rep')$q$, :'inst'));
select pg_temp.fails('invite over seat limit is refused', format($q$select invite_seat(%L,'rep3@inst.test','Rep 3','rep')$q$, :'inst'));
select pg_temp.fails('invalid email refused', format($q$select invite_seat(%L,'not-an-email','Rep 4','rep')$q$, :'inst'));
select pg_temp.fails('bad role refused', format($q$select invite_seat(%L,'x@y.test','Rep 4','boss')$q$, :'inst'));
reset role;

-- rep1 claims the invite with the matching email
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000002','rep1@inst.test');
set role authenticated;
select pg_temp.ok('rep1 claims invite by email', $q$select claim_my_invite()$q$);
select pg_temp.fails('claiming twice refused', $q$select claim_my_invite()$q$);
reset role;

-- outsider cannot claim anything, cannot invite, cannot revoke
reset role;
select id as rep1seat from seats where label='Rep 1' \gset
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000004','outsider@other.test');
set role authenticated;
select pg_temp.fails('outsider has no invite to claim', $q$select claim_my_invite()$q$);
select pg_temp.fails('outsider cannot invite into institute', format($q$select invite_seat(%L,'z@z.test','Z','rep')$q$, :'inst'));
select pg_temp.fails('outsider cannot revoke seats', format($q$select revoke_seat(%L)$q$, :'rep1seat'));
reset role;

-- an unconfirmed login cannot claim an invite for its email, even with a matching address
insert into seats (institute_id, label, role, status, invite_email) select id, 'Rep 9', 'rep', 'invited', 'unconfirmed@inst.test' from institutes where name='Inst One';
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000005','unconfirmed@inst.test');
set role authenticated;
select pg_temp.fails('unconfirmed email cannot claim', $q$select claim_my_invite()$q$);
reset role;
update seats set status='revoked' where label='Rep 9';

-- rep1 (now active) cannot invite or revoke
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000002','rep1@inst.test');
set role authenticated;
select pg_temp.fails('rep cannot invite', format($q$select invite_seat(%L,'z@z.test','Z','rep')$q$, :'inst'));
select pg_temp.fails('rep cannot create devices for other seats', $q$select register_device((select id from seats where label='Rep 2'), 'phone', 'fp-0123456789abcdef')$q$);
reset role;

-- rep1 registers own phone and laptop; second phone refused
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000002','rep1@inst.test');
set role authenticated;
select pg_temp.ok('rep1 registers phone', $q$select register_device((select id from seats where label='Rep 1'), 'phone', 'fp-phone-0000000000001')$q$);
select pg_temp.ok('rep1 registers laptop', $q$select register_device((select id from seats where label='Rep 1'), 'laptop', 'fp-laptop-000000000001')$q$);
select pg_temp.fails('second phone for same seat refused', $q$select register_device((select id from seats where label='Rep 1'), 'phone', 'fp-phone-0000000000009')$q$);
reset role;

-- Owner resets rep1's phone, then rep1 can register a new one
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000001','owner@inst.test');
set role authenticated;
select pg_temp.ok('owner resets rep1 phone', $q$select reset_pairing((select id from seats where label='Rep 1'), 'phone')$q$);
reset role;
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000002','rep1@inst.test');
set role authenticated;
select pg_temp.ok('rep1 registers replacement phone', $q$select register_device((select id from seats where label='Rep 1'), 'phone', 'fp-phone-0000000000002')$q$);
reset role;

-- Owner revokes rep2 (invited, never claimed): seat becomes revoked, frees a slot
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000001','owner@inst.test');
set role authenticated;
select pg_temp.ok('owner revokes rep2 seat', $q$select revoke_seat((select id from seats where label='Rep 2'))$q$);
select pg_temp.ok('freed slot allows a new invite', format($q$select invite_seat(%L,'rep3@inst.test','Rep 3','rep')$q$, :'inst'));
-- Owner reassigns rep1 seat to a new email: old devices unpaired
select pg_temp.ok('owner reassigns rep1 seat', $q$select reassign_seat((select id from seats where label='Rep 1'), 'newrep@inst.test')$q$);
reset role;
select pg_temp.rows_is('reassign unpairs old devices', $q$select count(*) from devices d join seats s on s.id=d.seat_id where s.label='Rep 1' and d.revoked_at is null$q$, 0);

-- The old rep1 login can no longer write outcomes for that seat
select pg_temp.as_user('aaaaaaa1-0000-0000-0000-000000000002','rep1@inst.test');
set role authenticated;
select pg_temp.fails('old holder cannot write outcomes after reassign', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome) values (%L,(select id from seats where label='Rep 1'),'after-reassign','won')$q$, :'inst'));
reset role;

-- Audit trail records the important actions
select pg_temp.rows_is('audit log has 3 invites, claim, revoke, reassign, reset entries',
  $q$select count(*) from audit_log where action in ('seat.invited','seat.claimed','seat.revoked','seat.reassigned','pairing.reset')$q$, 7);

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
