-- Tests for 20261024100013_money_rules.sql: roles (owner, manager, caller), "can see money", "hide money",
-- money columns read only through checked functions, and the money export audit. Run after every migration
-- on a scratch database with supabase/tests/stub_auth.sql. The last line prints passed and failed counts:
-- expect failed = 0.
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

-- ---------- fixed ids ----------
\set inst_i 'a1111111-0000-0000-0000-000000000001'
\set inst_j 'a2222222-0000-0000-0000-000000000002'
\set u_o  'c9000000-0000-0000-0000-000000000001'
\set u_m  'c9000000-0000-0000-0000-000000000002'
\set u_m2 'c9000000-0000-0000-0000-000000000003'
\set u_a  'c9000000-0000-0000-0000-000000000004'
\set u_b  'c9000000-0000-0000-0000-000000000005'
\set u_x  'c9000000-0000-0000-0000-000000000006'
\set s_o  'd1000000-0000-0000-0000-000000000001'
\set s_m  'd1000000-0000-0000-0000-000000000002'
\set s_m2 'd1000000-0000-0000-0000-000000000003'
\set s_a  'd1000000-0000-0000-0000-000000000004'
\set s_b  'd1000000-0000-0000-0000-000000000005'
\set s_x  'd2000000-0000-0000-0000-000000000006'
\set k_i  'd3000000-0000-0000-0000-000000000001'
\set l_a  'd4000000-0000-0000-0000-000000000001'
\set l_b  'd4000000-0000-0000-0000-000000000002'

-- ---------- fixtures (as the table owner) ----------
-- Inst I: owner O (inserted first, with no admin_kind: the trigger makes it the owner), managers M and M2
-- (admin_kind set), callers A and B. Inst J: owner X. One running fees campaign in I.
-- Lead la (A): due 12000, promised 5000. Lead lb (B): due 8000.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'owner@i.test', now()), (:'u_m', 'm@i.test', now()), (:'u_m2', 'm2@i.test', now()),
 (:'u_a', 'a@i.test', now()), (:'u_b', 'b@i.test', now()), (:'u_x', 'owner@j.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 10), (:'inst_j', 'Inst J', 'active', 10);
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_m',  :'inst_i', :'u_m',  'Manager', 'admin', 'manager', 'active'),
 (:'s_m2', :'inst_i', :'u_m2', 'Manager 2', 'admin', 'manager', 'active'),
 (:'s_a',  :'inst_i', :'u_a',  'Caller A', 'rep', null, 'active'),
 (:'s_b',  :'inst_i', :'u_b',  'Caller B', 'rep', null, 'active'),
 (:'s_x',  :'inst_j', :'u_x',  'Owner J', 'admin', 'owner', 'active');
insert into campaigns (id, institute_id, name, call_type_id, status) values
 (:'k_i', :'inst_i', 'Fees', (select id from call_types where key='fees' and institute_id is null), 'running');
insert into campaign_members (campaign_id, seat_id, institute_id) values (:'k_i', :'s_a', :'inst_i'), (:'k_i', :'s_b', :'inst_i');
insert into leads (id, institute_id, campaign_id, name, phone, amount_due, promised_amount, assigned_seat_id) values
 (:'l_a', :'inst_i', :'k_i', 'Asha', '9876543210', 12000, 5000, :'s_a'),
 (:'l_b', :'inst_i', :'k_i', 'Bina', '9876543211', 8000, null, :'s_b');
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, lead_id, result_key, amount) values
 (:'inst_i', :'s_a', 'a-1', :'k_i', :'l_a', 'paid', 2000),
 (:'inst_i', :'s_b', 'b-1', :'k_i', :'l_b', 'paid', 3000);

-- ---------- roles ----------
select pg_temp.val_is('the first admin seat of an institute becomes the owner', format($q$select access_role from seats where id=%L$q$, :'s_o'), 'owner');
select pg_temp.val_is('a manager seat reads as manager', format($q$select access_role from seats where id=%L$q$, :'s_m'), 'manager');
select pg_temp.val_is('a rep seat reads as caller', format($q$select access_role from seats where id=%L$q$, :'s_a'), 'caller');
select pg_temp.val_is('a caller seat never keeps an admin kind', format($q$with i as (insert into seats (institute_id, label, role, admin_kind, status) values (%L,'X','rep','owner','revoked') returning admin_kind) select coalesce(admin_kind,'null') from i$q$, :'inst_i'), 'null');
select pg_temp.val_is('a caller seat never keeps can_see_money', format($q$with u as (update seats set can_see_money=true where id=%L returning can_see_money) select can_see_money::text from u$q$, :'s_a'), 'false');
select pg_temp.fails('an unknown admin kind is refused', format($q$update seats set admin_kind='boss' where id=%L$q$, :'s_m'));

select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.ok('owner invites an admin', format($q$select invite_seat(%L,'new.admin@i.test','New admin','admin')$q$, :'inst_i'));
select pg_temp.val_is('an invited admin becomes a manager', $q$select access_role from seats where invite_email='new.admin@i.test'$q$, 'manager');
select pg_temp.val_is('my_trial_status: owner role stays admin', $q$select my_trial_status()->>'role'$q$, 'admin');
select pg_temp.val_is('my_trial_status: owner access role', $q$select my_trial_status()->>'access_role'$q$, 'owner');
select pg_temp.val_is('my_trial_status: owner can see money', $q$select my_trial_status()->>'can_see_money'$q$, 'true');
reset role;

select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('a manager is still an admin for the old functions', format($q$select is_admin_of(%L)::text$q$, :'inst_i'), 'true');
select pg_temp.rows_is('a manager reads the seat list (5 seats, the revoked one and the invited admin)', format($q$select count(*)::int from admin_seat_list(%L)$q$, :'inst_i'), 7);
select pg_temp.val_is('a manager is not an owner', format($q$select is_owner_of(%L)::text$q$, :'inst_i'), 'false');
select pg_temp.val_is('my_trial_status: manager access role', $q$select my_trial_status()->>'access_role'$q$, 'manager');
select pg_temp.val_is('my_trial_status: manager cannot see money', $q$select my_trial_status()->>'can_see_money'$q$, 'false');
reset role;

-- ---------- can_see_money and the money access switch ----------
select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.val_is('owner can see money', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'true');
select pg_temp.ok('owner gives Manager 2 money access', format($q$select admin_set_money_access(%L, true)$q$, :'s_m2'));
select pg_temp.fails('money access cannot be given to a caller', format($q$select admin_set_money_access(%L, true)$q$, :'s_a'));
select pg_temp.fails('money access is not set on an owner seat', format($q$select admin_set_money_access(%L, true)$q$, :'s_o'));
select pg_temp.fails('owner cannot set money access in another institute', format($q$select admin_set_money_access(%L, true)$q$, :'s_x'));
select pg_temp.val_is('owner of inst I cannot see inst J money', format($q$select can_see_money(%L)::text$q$, :'inst_j'), 'false');
reset role;

select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('manager without money access cannot see money', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'false');
select pg_temp.fails('a manager cannot give itself money access', format($q$select admin_set_money_access(%L, true)$q$, :'s_m'));
select pg_temp.fails('a manager cannot hide money', $q$select admin_set_hide_money(true)$q$);
select pg_temp.fails('a manager cannot change roles', format($q$select admin_set_seat_role(%L, 'manager')$q$, :'s_a'));
reset role;

select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.val_is('manager with money access can see money', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'true');
reset role;

select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('a caller cannot see money totals', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'false');
select pg_temp.fails('a caller cannot give money access', format($q$select admin_set_money_access(%L, true)$q$, :'s_m'));
select pg_temp.fails('a caller cannot hide money', $q$select admin_set_hide_money(true)$q$);
reset role;

-- ---------- money columns are never read directly ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.fails('caller cannot read amount_due of its own lead directly', $q$select amount_due from leads$q$);
select pg_temp.fails('caller cannot read promised_amount directly', $q$select promised_amount from leads$q$);
select pg_temp.fails('caller cannot read amounts of its own outcomes', $q$select amount from call_outcomes$q$);
select pg_temp.fails('caller cannot sum amounts', $q$select sum(amount) from call_outcomes$q$);
select pg_temp.fails('caller cannot filter on an amount', $q$select count(*) from leads where amount_due > 100$q$);
select pg_temp.rows_is('caller still counts its own outcomes', $q$select count(*)::int from call_outcomes$q$, 1);
select pg_temp.val_is('caller reads the amount due of the lead it is on', format($q$select amount_due::int::text from lead_money(%L)$q$, :'l_a'), '12000');
select pg_temp.val_is('caller reads the promised amount of the lead it is on', format($q$select promised_amount::int::text from lead_money(%L)$q$, :'l_a'), '5000');
select pg_temp.val_is('caller money is not hidden', format($q$select money_hidden::text from lead_money(%L)$q$, :'l_a'), 'false');
select pg_temp.fails('caller A cannot read caller B''s lead money', format($q$select * from lead_money(%L)$q$, :'l_b'));
select pg_temp.ok('caller records a promised amount on its lead', format($q$update leads set promised_amount=6000, promised_date='2026-11-05', status='promised' where id=%L$q$, :'l_a'));
select pg_temp.val_is('the new promise reads back through lead_money', format($q$select promised_amount::int::text from lead_money(%L)$q$, :'l_a'), '6000');
select pg_temp.fails('caller cannot record a promise on another caller''s lead', format($q$select 1/(select count(*) from (update leads set promised_amount=1 where id=%L returning 1) u)$q$, :'l_b'));
select pg_temp.fails('caller cannot export money', format($q$select log_money_export(%L,'fees_report',10)$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.fails('manager without money cannot read amount_due directly', $q$select amount_due from leads$q$);
select pg_temp.fails('manager without money cannot read outcome amounts directly', $q$select amount from call_outcomes$q$);
select pg_temp.rows_is('manager still reads the leads (no money)', $q$select count(*)::int from leads$q$, 2);
select pg_temp.val_is('manager without money gets the lead money hidden', format($q$select money_hidden::text from lead_money(%L)$q$, :'l_a'), 'true');
select pg_temp.val_is('manager without money gets no amount', format($q$select coalesce(amount_due::text,'null') from lead_money(%L)$q$, :'l_a'), 'null');
select pg_temp.fails('manager without money cannot export money', format($q$select log_money_export(%L,'fees_report',10)$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.fails('even a manager with money cannot read amounts directly', $q$select amount from call_outcomes$q$);
select pg_temp.val_is('manager with money reads any lead''s money', format($q$select amount_due::int::text from lead_money(%L)$q$, :'l_b'), '8000');
select pg_temp.ok('manager with money exports money', format($q$select log_money_export(%L,'fees_report',2)$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.fails('even the owner cannot read amounts directly', $q$select promised_amount from leads$q$);
select pg_temp.val_is('owner reads lead money', format($q$select amount_due::int::text from lead_money(%L)$q$, :'l_a'), '12000');
select pg_temp.ok('owner exports money', format($q$select log_money_export(%L,'callers_excel',5)$q$, :'inst_i'));
select pg_temp.fails('an export name with spaces is refused', format($q$select log_money_export(%L,'fees report',5)$q$, :'inst_i'));
select pg_temp.fails('a negative row count is refused', format($q$select log_money_export(%L,'fees_report',-1)$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_x', 'owner@j.test');
set role authenticated;
select pg_temp.fails('owner of another institute cannot read inst I lead money', format($q$select * from lead_money(%L)$q$, :'l_a'));
select pg_temp.fails('owner of another institute cannot export inst I money', format($q$select log_money_export(%L,'fees_report',1)$q$, :'inst_i'));
reset role;

select pg_temp.rows_is('2 money exports are in the audit log', format($q$select count(*)::int from audit_log where institute_id=%L and action='money.exported'$q$, :'inst_i'), 2);
select pg_temp.val_is('the export audit row says what and how many', format($q$select target from audit_log where institute_id=%L and action='money.exported' order by id limit 1$q$, :'inst_i'), 'fees_report:2');

-- ---------- hide money everywhere ----------
select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.ok('owner hides money everywhere', $q$select admin_set_hide_money(true)$q$);
select pg_temp.val_is('hide money: owner cannot see money', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'false');
select pg_temp.val_is('hide money: owner gets lead money hidden', format($q$select money_hidden::text from lead_money(%L)$q$, :'l_a'), 'true');
select pg_temp.fails('hide money: owner cannot export money', format($q$select log_money_export(%L,'fees_report',1)$q$, :'inst_i'));
select pg_temp.val_is('hide money: my_trial_status says so', $q$select my_trial_status()->>'hide_money'$q$, 'true');
reset role;

select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.val_is('hide money: manager with money cannot see money', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'false');
reset role;

select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('hide money: caller gets its lead money hidden', format($q$select money_hidden::text from lead_money(%L)$q$, :'l_a'), 'true');
select pg_temp.val_is('hide money: caller gets no amount', format($q$select coalesce(amount_due::text,'null') from lead_money(%L)$q$, :'l_a'), 'null');
reset role;

select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.ok('owner shows money again', $q$select admin_set_hide_money(false)$q$);
select pg_temp.val_is('owner can see money again', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'true');
reset role;
select pg_temp.rows_is('hide and show are in the audit log', format($q$select count(*)::int from audit_log where institute_id=%L and action in ('money.hidden','money.shown')$q$, :'inst_i'), 2);
select pg_temp.rows_is('the money access change is in the audit log', format($q$select count(*)::int from audit_log where institute_id=%L and action='money.access_given'$q$, :'inst_i'), 1);

-- ---------- roles change ----------
select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.ok('owner makes caller B a manager', format($q$select admin_set_seat_role(%L, 'manager')$q$, :'s_b'));
select pg_temp.val_is('B is now a manager', format($q$select access_role from seats where id=%L$q$, :'s_b'), 'manager');
select pg_temp.ok('owner makes Manager 2 a caller', format($q$select admin_set_seat_role(%L, 'caller')$q$, :'s_m2'));
select pg_temp.val_is('a manager moved to caller loses money access', format($q$select (role || ' ' || can_see_money) from seats where id=%L$q$, :'s_m2'), 'rep false');
select pg_temp.fails('owner cannot change its own role', format($q$select admin_set_seat_role(%L, 'caller')$q$, :'s_o'));
select pg_temp.fails('an unknown role is refused', format($q$select admin_set_seat_role(%L, 'boss')$q$, :'s_a'));
select pg_temp.fails('owner cannot change a role in another institute', format($q$select admin_set_seat_role(%L, 'caller')$q$, :'s_x'));
select pg_temp.ok('owner makes Manager a second owner', format($q$select admin_set_seat_role(%L, 'owner')$q$, :'s_m'));
reset role;

select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('the second owner can see money', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'true');
reset role;

select pg_temp.as_user(:'u_b', 'b@i.test');
set role authenticated;
select pg_temp.rows_is('B as a manager reads every lead of the institute', $q$select count(*)::int from leads$q$, 2);
select pg_temp.val_is('B as a manager without money sees it hidden', format($q$select money_hidden::text from lead_money(%L)$q$, :'l_a'), 'true');
reset role;

select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.rows_is('Manager 2 as a caller sees no leads (none assigned)', $q$select count(*)::int from leads$q$, 0);
reset role;

-- ---------- a new trial makes its creator the owner ----------
insert into auth.users (id, email, email_confirmed_at) values ('c9000000-0000-0000-0000-0000000000f1', 'trial@t.test', now());
select pg_temp.as_user('c9000000-0000-0000-0000-0000000000f1', 'trial@t.test');
set role authenticated;
select pg_temp.ok('a new login starts a trial', $q$select start_trial_institute('Trial Inst')$q$);
select pg_temp.val_is('the trial creator is the owner', $q$select my_trial_status()->>'access_role'$q$, 'owner');
select pg_temp.val_is('the trial creator can see money', $q$select my_trial_status()->>'can_see_money'$q$, 'true');
reset role;

-- ---------- grants ----------
select pg_temp.val_is('authenticated has no SELECT on leads.amount_due', $q$select has_column_privilege('authenticated','public.leads','amount_due','SELECT')::text$q$, 'false');
select pg_temp.val_is('authenticated has no SELECT on leads.promised_amount', $q$select has_column_privilege('authenticated','public.leads','promised_amount','SELECT')::text$q$, 'false');
select pg_temp.val_is('authenticated has no SELECT on call_outcomes.amount', $q$select has_column_privilege('authenticated','public.call_outcomes','amount','SELECT')::text$q$, 'false');
select pg_temp.val_is('authenticated keeps SELECT on call_outcomes.outcome', $q$select has_column_privilege('authenticated','public.call_outcomes','outcome','SELECT')::text$q$, 'true');
select pg_temp.val_is('authenticated keeps INSERT on call_outcomes', $q$select has_table_privilege('authenticated','public.call_outcomes','INSERT')::text$q$, 'true');
select pg_temp.val_is('anon cannot run can_see_money', $q$select has_function_privilege('anon','public.can_see_money(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run lead_money', $q$select has_function_privilege('anon','public.lead_money(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run log_money_export', $q$select has_function_privilege('anon','public.log_money_export(uuid,text,int)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run admin_set_hide_money', $q$select has_function_privilege('anon','public.admin_set_hide_money(boolean)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot run the seat trigger function', $q$select has_function_privilege('authenticated','public.seats_admin_kind()','EXECUTE')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
