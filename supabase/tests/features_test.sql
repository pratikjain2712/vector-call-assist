-- Tests for 20261024100014_features.sql: a trial has every add-on, a paying institute only what it bought,
-- outsiders get nothing and the browser cannot change the list. Expect failed = 0 on the last line.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;

insert into auth.users (id, email) values
 ('f1000000-0000-0000-0000-000000000001', 'trial@f.test'),
 ('f1000000-0000-0000-0000-000000000002', 'paid@f.test'),
 ('f1000000-0000-0000-0000-000000000003', 'nobody@f.test');
insert into institutes (id, name, status) values
 ('f2000000-0000-0000-0000-000000000001', 'Trial Inst', 'trial'),
 ('f2000000-0000-0000-0000-000000000002', 'Paid Inst', 'active');
update institutes set features = array['scripts'] where id = 'f2000000-0000-0000-0000-000000000002';
insert into seats (institute_id, user_id, label, role, status) values
 ('f2000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'Admin', 'admin', 'active'),
 ('f2000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000002', 'Rep', 'rep', 'active');

set role authenticated;
select pg_temp.as_user('f1000000-0000-0000-0000-000000000001');
select pg_temp.val_is('trial has scripts', $q$select has_feature('f2000000-0000-0000-0000-000000000001','scripts')::text$q$, 'true');
select pg_temp.val_is('trial has ai drafts', $q$select has_feature('f2000000-0000-0000-0000-000000000001','ai_drafts')::text$q$, 'true');
select pg_temp.val_is('trial my_features', $q$select my_features()::text$q$, '{scripts,ai_drafts}');
select pg_temp.val_is('no access to another institute', $q$select has_feature('f2000000-0000-0000-0000-000000000002','scripts')::text$q$, 'false');
select pg_temp.as_user('f1000000-0000-0000-0000-000000000002');
select pg_temp.val_is('paid has what it bought', $q$select has_feature('f2000000-0000-0000-0000-000000000002','scripts')::text$q$, 'true');
select pg_temp.val_is('paid lacks what it did not buy', $q$select has_feature('f2000000-0000-0000-0000-000000000002','ai_drafts')::text$q$, 'false');
select pg_temp.val_is('paid my_features', $q$select my_features()::text$q$, '{scripts}');
select pg_temp.fails('browser cannot add a feature', $q$update institutes set features = array['scripts','ai_drafts'] where id = 'f2000000-0000-0000-0000-000000000002'$q$);
select pg_temp.as_user('f1000000-0000-0000-0000-000000000003');
select pg_temp.val_is('no seat, no feature', $q$select has_feature('f2000000-0000-0000-0000-000000000001','scripts')::text$q$, 'false');
select pg_temp.val_is('no seat, no features', $q$select my_features()::text$q$, null);
reset role;
select pg_temp.fails('unknown feature refused', $q$update institutes set features = array['bogus'] where id = 'f2000000-0000-0000-0000-000000000002'$q$);

select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
