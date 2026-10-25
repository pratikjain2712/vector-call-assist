-- Tests for 20261024100012_call_types_campaigns_leads.sql (call types, campaigns, leads, campaign fields on
-- call_outcomes). Run after every migration on a scratch database with supabase/tests/stub_auth.sql.
-- The last line prints passed and failed counts: expect failed = 0.
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
\set inst_i '81111111-0000-0000-0000-000000000001'
\set inst_j '82222222-0000-0000-0000-000000000002'
\set u_o  'b8000000-0000-0000-0000-000000000001'
\set u_m  'b8000000-0000-0000-0000-000000000002'
\set u_a  'b8000000-0000-0000-0000-000000000003'
\set u_b  'b8000000-0000-0000-0000-000000000004'
\set u_x  'b8000000-0000-0000-0000-000000000005'
\set u_c  'b8000000-0000-0000-0000-000000000006'
\set u_n  'b8000000-0000-0000-0000-000000000007'
\set s_o  '91000000-0000-0000-0000-000000000001'
\set s_m  '91000000-0000-0000-0000-000000000002'
\set s_a  '91000000-0000-0000-0000-000000000003'
\set s_b  '91000000-0000-0000-0000-000000000004'
\set s_x  '92000000-0000-0000-0000-000000000005'
\set s_c  '92000000-0000-0000-0000-000000000006'
\set k_fees '93000000-0000-0000-0000-000000000001'
\set k_sales '93000000-0000-0000-0000-000000000002'
\set k_draft '93000000-0000-0000-0000-000000000003'
\set k_j '93000000-0000-0000-0000-000000000004'
\set l_a1 '94000000-0000-0000-0000-000000000001'
\set l_a2 '94000000-0000-0000-0000-000000000002'
\set l_b1 '94000000-0000-0000-0000-000000000003'
\set l_s1 '94000000-0000-0000-0000-000000000004'
\set l_j1 '94000000-0000-0000-0000-000000000005'
\set sc_j '95000000-0000-0000-0000-000000000001'

-- ---------- fixtures (as the table owner) ----------
-- Inst I: owner O, manager M, callers A and B. Inst J: owner X, caller C. u_n holds no seat.
-- Campaigns in I: "Fees Oct" (fees, running; A and B), "Sales Oct" (sales, running; A only),
--   "Draft" (fees, draft; A). Campaign in J: "J Fees" (fees, running; C).
-- Leads: a1, a2 (Fees Oct, A), b1 (Fees Oct, B), s1 (Sales Oct, A), j1 (J Fees, C).
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'owner@i.test', now()), (:'u_m', 'manager@i.test', now()),
 (:'u_a', 'a@i.test', now()), (:'u_b', 'b@i.test', now()),
 (:'u_x', 'owner@j.test', now()), (:'u_c', 'c@j.test', now()), (:'u_n', 'nobody@x.test', now());
insert into institutes (id, name, status) values (:'inst_i', 'Inst I', 'active'), (:'inst_j', 'Inst J', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'owner', 'active'),
 (:'s_m', :'inst_i', :'u_m', 'Manager', 'admin', 'manager', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Caller A', 'rep', null, 'active'),
 (:'s_b', :'inst_i', :'u_b', 'Caller B', 'rep', null, 'active'),
 (:'s_x', :'inst_j', :'u_x', 'Owner J', 'admin', 'owner', 'active'),
 (:'s_c', :'inst_j', :'u_c', 'Caller C', 'rep', null, 'active');
insert into scripts (id, institute_id, name) values (:'sc_j', :'inst_j', 'J script');
insert into campaigns (id, institute_id, name, call_type_id, status, open_to_all) values
 (:'k_fees', :'inst_i', 'Fees Oct', (select id from call_types where key='fees' and institute_id is null), 'running', false),
 (:'k_sales', :'inst_i', 'Sales Oct', (select id from call_types where key='sales' and institute_id is null), 'running', false),
 (:'k_draft', :'inst_i', 'Draft', (select id from call_types where key='fees' and institute_id is null), 'draft', false),
 (:'k_j', :'inst_j', 'J Fees', (select id from call_types where key='fees' and institute_id is null), 'running', false);
insert into campaign_members (campaign_id, seat_id, institute_id) values
 (:'k_fees', :'s_a', :'inst_i'), (:'k_fees', :'s_b', :'inst_i'), (:'k_sales', :'s_a', :'inst_i'),
 (:'k_draft', :'s_a', :'inst_i'), (:'k_j', :'s_c', :'inst_j');
insert into leads (id, institute_id, campaign_id, name, phone, extra, amount_due, assigned_seat_id) values
 (:'l_a1', :'inst_i', :'k_fees', 'Asha', '098765 43210', '{"student":"Ravi","class":"9"}', 12000, :'s_a'),
 (:'l_a2', :'inst_i', :'k_fees', 'Arun', '+91 98765-43211', '{}', 8000, :'s_a'),
 (:'l_b1', :'inst_i', :'k_fees', 'Bina', '919876543212', '{}', 5000, :'s_b'),
 (:'l_s1', :'inst_i', :'k_sales', 'Sunil', '9876543213', '{}', null, :'s_a'),
 (:'l_j1', :'inst_j', :'k_j', 'Jaya', '9876543214', '{}', 7000, :'s_c');

-- ---------- seed ----------
select pg_temp.rows_is('8 built-in call types are seeded', $q$select count(*)::int from call_types where institute_id is null$q$, 8);
select pg_temp.rows_is('5 common results are seeded', $q$select count(*)::int from call_type_results where call_type_id is null$q$, 5);
select pg_temp.rows_is('sales has 4 results of its own', $q$select count(*)::int from call_type_results r join call_types t on t.id=r.call_type_id where t.key='sales'$q$, 4);
select pg_temp.rows_is('fees has 5 results of its own', $q$select count(*)::int from call_type_results r join call_types t on t.id=r.call_type_id where t.key='fees'$q$, 5);
select pg_temp.val_is('Will pay on date needs a date and an amount', $q$select (needs_date and needs_amount)::text from call_type_results where key='will_pay_on'$q$, 'true');
select pg_temp.val_is('Call back later needs a date', $q$select needs_date::text from call_type_results where key='call_back_later'$q$, 'true');
select pg_temp.val_is('Absence reason has 3 choices', $q$select cardinality(reason_choices)::text from call_type_results where key='reason_given'$q$, '3');
select pg_temp.val_is('Rating given needs a rating', $q$select needs_rating::text from call_type_results where key='rated'$q$, 'true');
select pg_temp.rows_is('every built-in type has at least 2 results of its own', $q$select count(*)::int from call_types t where t.institute_id is null and (select count(*) from call_type_results r where r.call_type_id=t.id) < 2$q$, 0);

-- ---------- fixtures check ----------
select pg_temp.val_is('phone with a 0 and a space is stored as +91', format($q$select phone from leads where id=%L$q$, :'l_a1'), '+919876543210');
select pg_temp.val_is('phone with +91 and a hyphen is stored as +91', format($q$select phone from leads where id=%L$q$, :'l_a2'), '+919876543211');
select pg_temp.val_is('phone with 91 and 10 digits is stored as +91', format($q$select phone from leads where id=%L$q$, :'l_b1'), '+919876543212');
select pg_temp.val_is('normalise_phone refuses 9 digits', $q$select coalesce(normalise_phone('987654321'), 'null')$q$, 'null');
select pg_temp.fails('a lead with a bad phone is refused', format($q$insert into leads (institute_id, campaign_id, name, phone) values (%L,%L,'X','12345')$q$, :'inst_i', :'k_fees'));
select pg_temp.fails('the same number twice in one campaign is refused', format($q$insert into leads (institute_id, campaign_id, name, phone) values (%L,%L,'X','09876543210')$q$, :'inst_i', :'k_fees'));
select pg_temp.ok('the same number in another campaign is fine', format($q$insert into leads (institute_id, campaign_id, name, phone) values (%L,%L,'X','09876543210')$q$, :'inst_i', :'k_draft'));
select pg_temp.fails('a money key in extra fields is refused (Fee due)', format($q$insert into leads (institute_id, campaign_id, name, phone, extra) values (%L,%L,'X','9000000001','{"Fee due":"500"}')$q$, :'inst_i', :'k_fees'));
select pg_temp.fails('a money key in extra fields is refused (amount_paid)', format($q$insert into leads (institute_id, campaign_id, name, phone, extra) values (%L,%L,'X','9000000002','{"amount_paid":"500"}')$q$, :'inst_i', :'k_fees'));
select pg_temp.ok('feedback and due_date keys are not money', format($q$insert into leads (institute_id, campaign_id, name, phone, extra) values (%L,%L,'X','9000000003','{"feedback":"ok","due_date":"2026-11-01"}')$q$, :'inst_i', :'k_fees'));
select pg_temp.fails('a lead cannot point at a campaign of another institute', format($q$insert into leads (institute_id, campaign_id, name, phone) values (%L,%L,'X','9000000004')$q$, :'inst_i', :'k_j'));
select pg_temp.fails('a lead cannot be assigned to a seat of another institute', format($q$insert into leads (institute_id, campaign_id, name, phone, assigned_seat_id) values (%L,%L,'X','9000000005',%L)$q$, :'inst_i', :'k_fees', :'s_c'));
select pg_temp.fails('a campaign cannot use a script of another institute', format($q$insert into campaigns (institute_id, name, call_type_id, script_id) values (%L,'X',(select id from call_types where key='fees' and institute_id is null),%L)$q$, :'inst_i', :'sc_j'));
select pg_temp.fails('a member seat must be in the campaign institute', format($q$insert into campaign_members (campaign_id, seat_id, institute_id) values (%L,%L,%L)$q$, :'k_fees', :'s_c', :'inst_i'));
select pg_temp.fails('campaign end before start is refused', format($q$insert into campaigns (institute_id, name, call_type_id, start_date, end_date) values (%L,'X',(select id from call_types where key='fees' and institute_id is null),'2026-11-02','2026-11-01')$q$, :'inst_i'));
select pg_temp.fails('unknown campaign status is refused', format($q$update campaigns set status='done' where id=%L$q$, :'k_fees'));

-- ---------- call types: reading ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.rows_is('caller reads the 8 built-in types', $q$select count(*)::int from call_types$q$, 8);
select pg_temp.rows_is('caller reads the 32 built-in results', $q$select count(*)::int from call_type_results$q$, 32);
select pg_temp.fails('caller cannot list call types for admins', $q$select count(*) from admin_list_call_types()$q$);
select pg_temp.fails('caller cannot add a call type', $q$select admin_upsert_call_type(null, 'Mine')$q$);
select pg_temp.fails('caller cannot insert a call type directly', $q$insert into call_types (key, label) values ('mine', 'Mine')$q$);
reset role;

select pg_temp.as_user(:'u_n', 'nobody@x.test');
set role authenticated;
select pg_temp.rows_is('login without a seat reads no call types', $q$select count(*)::int from call_types$q$, 0);
reset role;

-- ---------- call types: admin writes ----------
select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.rows_is('admin lists the 8 built-in types', $q$select count(*)::int from admin_list_call_types()$q$, 8);
select pg_temp.val_is('fees lists 5 own and 5 common results', $q$select jsonb_array_length(results)::text from admin_list_call_types() where key='fees'$q$, '10');
select pg_temp.val_is('common results come last', $q$select (results->-1->>'key') from admin_list_call_types() where key='fees'$q$, 'do_not_call');
select pg_temp.ok('admin adds a type "Fee follow-up"', $q$select admin_upsert_call_type(null, 'Fee follow-up')$q$);
select pg_temp.val_is('the key comes from the label', $q$select key from call_types where label='Fee follow-up'$q$, 'fee_follow_up');
select pg_temp.rows_is('admin now lists 9 types', $q$select count(*)::int from admin_list_call_types()$q$, 9);
select pg_temp.val_is('the new type has the 5 common results', $q$select jsonb_array_length(results)::text from admin_list_call_types() where key='fee_follow_up'$q$, '5');
select pg_temp.fails('a type with a built-in key is refused', $q$select admin_upsert_call_type(null, 'My sales', 'sales')$q$);
select pg_temp.fails('a bad key is refused', $q$select admin_upsert_call_type(null, 'X', '9bad')$q$);
select pg_temp.fails('a built-in type cannot be changed', $q$select admin_upsert_call_type((select id from call_types where key='sales'), 'Selling')$q$);
select pg_temp.ok('admin renames its own type', $q$select admin_upsert_call_type((select id from call_types where key='fee_follow_up'), 'Fee chase')$q$);
select pg_temp.val_is('rename keeps the key', $q$select key from call_types where label='Fee chase'$q$, 'fee_follow_up');
select pg_temp.ok('admin adds "Paid by cheque" to built-in fees', $q$select admin_upsert_call_type_result(null, (select id from call_types where key='fees' and institute_id is null), 'Paid by cheque', null, false, true, false, false, true)$q$);
select pg_temp.val_is('the added result is the institute''s, needs an amount, counts as good', $q$select (institute_id is not null and needs_amount and counts_as_good and legacy_outcome='won')::text from call_type_results where key='paid_by_cheque'$q$, 'true');
select pg_temp.fails('a result key used by the type is refused', $q$select admin_upsert_call_type_result(null, (select id from call_types where key='fees' and institute_id is null), 'Paid', 'paid')$q$);
select pg_temp.fails('a result key used by a common result is refused', $q$select admin_upsert_call_type_result(null, (select id from call_types where key='fees' and institute_id is null), 'Busy now', 'busy')$q$);
select pg_temp.fails('a built-in result cannot be changed', $q$select admin_upsert_call_type_result((select id from call_type_results where key='paid'), null, 'Paid up')$q$);
select pg_temp.fails('a common result cannot be changed', $q$select admin_upsert_call_type_result((select id from call_type_results where key='busy'), null, 'Engaged')$q$);
select pg_temp.ok('admin turns its own result off', $q$select admin_upsert_call_type_result((select id from call_type_results where key='paid_by_cheque'), null, 'Paid by cheque', null, null, null, null, null, null, null, null, false)$q$);
select pg_temp.val_is('a result turned off is not listed', $q$select jsonb_array_length(results)::text from admin_list_call_types() where key='fees'$q$, '10');
select pg_temp.ok('admin turns it back on', $q$select admin_upsert_call_type_result((select id from call_type_results where key='paid_by_cheque'), null, 'Paid by cheque', null, null, null, null, null, null, null, null, true)$q$);
select pg_temp.val_is('fees now lists 11 results', $q$select jsonb_array_length(results)::text from admin_list_call_types() where key='fees'$q$, '11');
reset role;

select pg_temp.as_user(:'u_m', 'manager@i.test');
set role authenticated;
select pg_temp.rows_is('a manager also manages call types', $q$select count(*)::int from admin_list_call_types()$q$, 9);
reset role;

select id as t_own from call_types where key='fee_follow_up' \gset
select pg_temp.as_user(:'u_x', 'owner@j.test');
set role authenticated;
select pg_temp.rows_is('another institute does not see the new type', $q$select count(*)::int from admin_list_call_types()$q$, 8);
select pg_temp.val_is('another institute does not see the added result', $q$select jsonb_array_length(results)::text from admin_list_call_types() where key='fees'$q$, '10');
select pg_temp.rows_is('another institute cannot read the added rows directly', $q$select count(*)::int from call_type_results where key='paid_by_cheque'$q$, 0);
select pg_temp.fails('another institute cannot change the type', format($q$select admin_upsert_call_type(%L, 'Mine now')$q$, :'t_own'));
select pg_temp.ok('another institute can use the same key for its own type', $q$select admin_upsert_call_type(null, 'Fee follow-up')$q$);
reset role;
select pg_temp.rows_is('audit log: 5 call type changes in inst I', format($q$select count(*)::int from audit_log where institute_id=%L and action like 'call_type%%'$q$, :'inst_i'), 5);

-- ---------- campaigns ----------
select pg_temp.fails('a campaign cannot use another institute''s call type', format($q$insert into campaigns (institute_id, name, call_type_id) values (%L,'X',(select id from call_types where key='fee_follow_up' and institute_id=%L))$q$, :'inst_j', :'inst_i'));
select pg_temp.ok('a campaign can use its own institute''s call type', format($q$insert into campaigns (institute_id, name, call_type_id) values (%L,'Chase',(select id from call_types where key='fee_follow_up' and institute_id=%L))$q$, :'inst_i', :'inst_i'));

select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.rows_is('caller A sees its 2 running campaigns, not the draft', $q$select count(*)::int from campaigns$q$, 2);
select pg_temp.rows_is('caller A sees its own 3 memberships', $q$select count(*)::int from campaign_members$q$, 3);
select pg_temp.rows_is('my_campaigns lists 2 campaigns for A', $q$select count(*)::int from my_campaigns()$q$, 2);
select pg_temp.val_is('A has 2 leads in Fees Oct', $q$select my_leads::text from my_campaigns() where name='Fees Oct'$q$, '2');
select pg_temp.val_is('both are due now', $q$select my_leads_due::text from my_campaigns() where name='Fees Oct'$q$, '2');
select pg_temp.val_is('Fees Oct buttons: 5 fees + Paid by cheque + 5 common', $q$select jsonb_array_length(results)::text from my_campaigns() where name='Fees Oct'$q$, '11');
select pg_temp.val_is('Fees Oct type key', $q$select call_type_key from my_campaigns() where name='Fees Oct'$q$, 'fees');
select pg_temp.fails('caller cannot create a campaign directly', format($q$insert into campaigns (institute_id, name, call_type_id) values (%L,'Mine',(select id from call_types where key='fees'))$q$, :'inst_i'));
select pg_temp.fails('caller cannot add itself to a campaign', format($q$insert into campaign_members (campaign_id, seat_id, institute_id) values (%L,%L,%L)$q$, :'k_draft', :'s_a', :'inst_i'));
reset role;

select pg_temp.as_user(:'u_b', 'b@i.test');
set role authenticated;
select pg_temp.rows_is('caller B sees only Fees Oct', $q$select count(*)::int from campaigns$q$, 1);
select pg_temp.rows_is('my_campaigns lists 1 campaign for B', $q$select count(*)::int from my_campaigns()$q$, 1);
reset role;

select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.rows_is('admin sees all 4 campaigns of inst I', $q$select count(*)::int from campaigns$q$, 4);
select pg_temp.rows_is('admin sees all 4 memberships of inst I', $q$select count(*)::int from campaign_members$q$, 4);
reset role;

select pg_temp.as_user(:'u_n', 'nobody@x.test');
set role authenticated;
select pg_temp.fails('my_campaigns needs an active seat', $q$select count(*) from my_campaigns()$q$);
reset role;

-- ---------- leads: who sees and changes what ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.rows_is('caller A sees its 3 leads only', $q$select count(*)::int from leads$q$, 3);
select pg_temp.rows_is('caller A cannot see caller B''s lead', format($q$select count(*)::int from leads where id=%L$q$, :'l_b1'), 0);
select pg_temp.val_is('caller A reads the extra fields of its lead', format($q$select extra->>'student' from leads where id=%L$q$, :'l_a1'), 'Ravi');
select pg_temp.ok('caller A marks its lead for a call back', format($q$update leads set status='callback', next_call_at=now()+interval '1 day' where id=%L$q$, :'l_a1'));
select pg_temp.val_is('the change is saved', format($q$select status from leads where id=%L$q$, :'l_a1'), 'callback');
select pg_temp.val_is('a lead due tomorrow is not due now', $q$select my_leads_due::text from my_campaigns() where name='Fees Oct'$q$, '1');
select pg_temp.rows_is('caller A cannot change caller B''s lead (no row updated)', format($q$with u as (update leads set status='done' where id=%L returning 1) select count(*)::int from u$q$, :'l_b1'), 0);
select pg_temp.fails('caller A cannot rename a lead', format($q$update leads set name='Changed' where id=%L$q$, :'l_a1'));
select pg_temp.fails('caller A cannot move a lead to itself', format($q$update leads set assigned_seat_id=%L where id=%L$q$, :'s_a', :'l_b1'));
select pg_temp.fails('caller A cannot change a number', format($q$update leads set phone='9999999999' where id=%L$q$, :'l_a1'));
select pg_temp.fails('caller A cannot add a lead', format($q$insert into leads (institute_id, campaign_id, name, phone, assigned_seat_id) values (%L,%L,'New','9111111111',%L)$q$, :'inst_i', :'k_fees', :'s_a'));
select pg_temp.fails('caller A cannot delete a lead', format($q$delete from leads where id=%L$q$, :'l_a2'));
select pg_temp.fails('caller A cannot select every column (select * hits money)', $q$select count(*) from (select * from leads) x$q$);
select pg_temp.ok('caller A marks do not call', format($q$update leads set do_not_call=true where id=%L$q$, :'l_a2'));
select pg_temp.val_is('do not call sets the status', format($q$select status from leads where id=%L$q$, :'l_a2'), 'do_not_call');
select pg_temp.fails('caller A cannot undo do not call', format($q$update leads set do_not_call=false where id=%L$q$, :'l_a2'));
reset role;

select pg_temp.as_user(:'u_b', 'b@i.test');
set role authenticated;
select pg_temp.rows_is('caller B sees its 1 lead only', $q$select count(*)::int from leads$q$, 1);
reset role;

select pg_temp.as_user(:'u_c', 'c@j.test');
set role authenticated;
select pg_temp.rows_is('caller C of another institute sees only its own lead', $q$select count(*)::int from leads$q$, 1);
reset role;

select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.rows_is('admin sees the 6 leads of inst I', $q$select count(*)::int from leads$q$, 6);
select pg_temp.ok('admin undoes do not call', format($q$update leads set do_not_call=false, status='new' where id=%L$q$, :'l_a2'));
select pg_temp.val_is('the lead is back to new', format($q$select status from leads where id=%L$q$, :'l_a2'), 'new');
reset role;

select pg_temp.as_user(:'u_x', 'owner@j.test');
set role authenticated;
select pg_temp.rows_is('admin of another institute sees none of inst I''s leads', format($q$select count(*)::int from leads where institute_id=%L$q$, :'inst_i'), 0);
reset role;

-- A revoked seat loses its leads at once.
update seats set status='revoked' where id=:'s_b';
select pg_temp.as_user(:'u_b', 'b@i.test');
set role authenticated;
select pg_temp.rows_is('a revoked caller sees no leads', $q$select count(*)::int from leads$q$, 0);
reset role;
update seats set status='active' where id=:'s_b';

-- ---------- call outcomes with campaign fields ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.ok('old-style outcome with no campaign still saves', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome, connected_seconds) values (%L,%L,'old-1','answered',60)$q$, :'inst_i', :'s_a'));
select pg_temp.ok('upload retry (on conflict do nothing) still works', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome) values (%L,%L,'old-1','answered') on conflict (seat_id, client_record_id) do nothing$q$, :'inst_i', :'s_a'));
select pg_temp.ok('Paid with an amount saves', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, lead_id, result_key, amount, connected_seconds, step_times, reached_step) values (%L,%L,'new-1',%L,'paid',12000,90,'{"open":5,"pitch":40}','pitch')$q$, :'inst_i', :'s_a', :'l_a1'));
select pg_temp.val_is('the campaign is filled from the lead', $q$select campaign_id::text from call_outcomes where client_record_id='new-1'$q$, :'k_fees');
select pg_temp.val_is('the old outcome is filled from the result (won)', $q$select outcome from call_outcomes where client_record_id='new-1'$q$, 'won');
select pg_temp.fails('Paid without an amount is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key) values (%L,%L,'new-2',%L,'paid')$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.fails('Will pay on date without a date is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key, amount) values (%L,%L,'new-3',%L,'will_pay_on',500)$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.ok('Will pay on date with date and amount saves', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key, amount, promised_date) values (%L,%L,'new-4',%L,'will_pay_on',500,'2026-11-01')$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.fails('Refused without a reason is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key) values (%L,%L,'new-5',%L,'refused')$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.fails('a sales result on a fees campaign is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key) values (%L,%L,'new-6',%L,'joined')$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.ok('a common result saves on any campaign', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key) values (%L,%L,'new-7',%L,'no_answer')$q$, :'inst_i', :'s_a', :'k_sales'));
select pg_temp.val_is('No answer maps to the old no_answer outcome', $q$select outcome from call_outcomes where client_record_id='new-7'$q$, 'no_answer');
select pg_temp.ok('the institute''s own result saves', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key, amount) values (%L,%L,'new-8',%L,'paid_by_cheque',300)$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.fails('a result without a campaign is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, result_key) values (%L,%L,'new-9','no_answer')$q$, :'inst_i', :'s_a'));
select pg_temp.fails('an unknown result key is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key) values (%L,%L,'new-10',%L,'teleported')$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.fails('a lead from another campaign is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, lead_id, result_key) values (%L,%L,'new-11',%L,%L,'no_answer')$q$, :'inst_i', :'s_a', :'k_sales', :'l_a1'));
select pg_temp.fails('a lead from another institute is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, lead_id) values (%L,%L,'new-12',%L)$q$, :'inst_i', :'s_a', :'l_j1'));
select pg_temp.fails('a campaign from another institute is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, outcome) values (%L,%L,'new-13',%L,'answered')$q$, :'inst_i', :'s_a', :'k_j'));
select pg_temp.fails('a rating of 6 is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome, rating) values (%L,%L,'new-14','answered',6)$q$, :'inst_i', :'s_a'));
select pg_temp.fails('step times must be an object', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, outcome, step_times) values (%L,%L,'new-15','answered','[1,2]')$q$, :'inst_i', :'s_a'));
select pg_temp.fails('a negative amount is refused', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key, amount) values (%L,%L,'new-16',%L,'paid',-1)$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.ok('a correction with a result saves', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, corrects_id, campaign_id, result_key, amount) values (%L,%L,'new-1-fix',(select id from call_outcomes where client_record_id='new-1'),%L,'paid_part',6000)$q$, :'inst_i', :'s_a', :'k_fees'));
select pg_temp.ok('a lead on a caller''s outcome may be one they no longer hold (offline sync)', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, lead_id, outcome) values (%L,%L,'new-17',%L,'busy')$q$, :'inst_i', :'s_a', :'l_b1'));
select pg_temp.rows_is('caller A counts its own outcomes', $q$select count(*)::int from call_outcomes$q$, 7);
select pg_temp.val_is('caller A reads the result key and date of its outcome', $q$select result_key || ' ' || promised_date from call_outcomes where client_record_id='new-4'$q$, 'will_pay_on 2026-11-01');
select pg_temp.val_is('caller A reads the step times and step reached', $q$select (step_times->>'pitch') || ' ' || reached_step from call_outcomes where client_record_id='new-1'$q$, '40 pitch');
reset role;

select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.val_is('old reports count results by their old outcome (2 won: paid corrected to paid_part, paid by cheque)', format($q$select coalesce(sum(outcome_count) filter (where outcome='won'),0)::text from admin_results_by_outcome(%L,now()-interval '1 day',now()+interval '1 day')$q$, :'inst_i'), '2');
select pg_temp.val_is('old reports still count the old-style call', format($q$select coalesce(sum(outcome_count) filter (where outcome='answered'),0)::text from admin_results_by_outcome(%L,now()-interval '1 day',now()+interval '1 day')$q$, :'inst_i'), '1');
select pg_temp.val_is('team activity counts the 6 calls of caller A (a correction is not a call)', format($q$select sum(calls)::text from admin_team_activity(%L,now()-interval '1 day',now()+interval '1 day')$q$, :'inst_i'), '6');
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot read leads', $q$select has_table_privilege('anon','public.leads','SELECT')::text$q$, 'false');
select pg_temp.val_is('anon cannot read campaigns', $q$select has_table_privilege('anon','public.campaigns','SELECT')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot insert leads', $q$select has_table_privilege('authenticated','public.leads','INSERT')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot delete leads', $q$select has_table_privilege('authenticated','public.leads','DELETE')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot write campaigns', $q$select has_table_privilege('authenticated','public.campaigns','INSERT,UPDATE,DELETE')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot write call types', $q$select has_table_privilege('authenticated','public.call_types','INSERT,UPDATE,DELETE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run my_campaigns', $q$select has_function_privilege('anon','public.my_campaigns()','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run admin_upsert_call_type', $q$select has_function_privilege('anon','public.admin_upsert_call_type(uuid,text,text,int,boolean)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot run the internal results helper', $q$select has_function_privilege('authenticated','public.call_type_results_for(uuid,uuid)','EXECUTE')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
