-- Tests for 20261027110000_caller_centre_scope.sql: a caller limited to some centres gets only those centres'
-- calls (next_free_lead, my_call_queue, my_campaigns, sharing, admin_set_seat_centres); managers who can see
-- money record payments (and undo only their own, within 10 minutes); "Call these N parents" (fees_call_plan,
-- fees_call_start); "Away today" with Undo (admin_away_today, admin_undo_away).
-- Run with supabase/tests/run.sh. Expect failed = 0 on the last line.
\set ON_ERROR_STOP 0
set timezone = 'Asia/Kolkata';
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''))::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
create temp table v (k text primary key, val text);
grant all on v to authenticated, anon;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails_with(name text, sql text, want text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, position(want in sqlerrm) > 0, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare x text; begin execute sql into x;
  insert into results values (name, x is not distinct from want, 'got '||coalesce(x,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.keep(key text, sql text) returns void language plpgsql as $$
declare x text; begin execute sql into x; insert into v values (key, x) on conflict (k) do update set val = excluded.val;
exception when others then insert into results values ('keep ' || key, false, sqlerrm); end $$;
create or replace function pg_temp.g(key text) returns text language sql as $$ select val from v where k = key $$;
grant execute on function pg_temp.ok(text, text), pg_temp.fails_with(text, text, text), pg_temp.val_is(text, text, text),
  pg_temp.keep(text, text), pg_temp.g(text) to authenticated, anon;

\set inst 'd1000000-0000-0000-0000-000000000001'
\set cA   'd2000000-0000-0000-0000-00000000000a'
\set cB   'd2000000-0000-0000-0000-00000000000b'
\set u_o  'd3000000-0000-0000-0000-000000000001'
\set u_ra 'd3000000-0000-0000-0000-000000000002'
\set u_r2 'd3000000-0000-0000-0000-000000000003'
\set u_mm 'd3000000-0000-0000-0000-000000000004'
\set u_mn 'd3000000-0000-0000-0000-000000000005'
\set u_ma 'd3000000-0000-0000-0000-000000000006'
\set u_ac 'd3000000-0000-0000-0000-000000000007'
\set s_o  'd4000000-0000-0000-0000-000000000001'
\set s_ra 'd4000000-0000-0000-0000-000000000002'
\set s_r2 'd4000000-0000-0000-0000-000000000003'
\set s_mm 'd4000000-0000-0000-0000-000000000004'
\set s_mn 'd4000000-0000-0000-0000-000000000005'
\set s_ma 'd4000000-0000-0000-0000-000000000006'
\set s_ac 'd4000000-0000-0000-0000-000000000007'
\set k1   'd5000000-0000-0000-0000-000000000001'
\set kB   'd5000000-0000-0000-0000-000000000002'
\set k3   'd5000000-0000-0000-0000-000000000003'
\set lA   'd6000000-0000-0000-0000-00000000000a'
\set lB   'd6000000-0000-0000-0000-00000000000b'
\set lN   'd6000000-0000-0000-0000-00000000000c'
\set lB2  'd6000000-0000-0000-0000-00000000000d'
\set stA  'd7000000-0000-0000-0000-00000000000a'
\set stA2 'd7000000-0000-0000-0000-0000000000a2'
\set stB  'd7000000-0000-0000-0000-00000000000b'

-- ---------- fixtures ----------
-- Owner O; caller RA limited to Andheri; caller R2 (every centre); manager MM with money; manager MN without
-- money; manager MA with money limited to Andheri; Accounts AC.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@k.test', now()), (:'u_ra', 'ra@k.test', now()), (:'u_r2', 'r2@k.test', now()), (:'u_mm', 'mm@k.test', now()),
 (:'u_mn', 'mn@k.test', now()), (:'u_ma', 'ma@k.test', now()), (:'u_ac', 'ac@k.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst', 'Inst K', 'active', 20);
insert into centres (id, institute_id, name, short_code) values (:'cA', :'inst', 'Andheri', 'AND'), (:'cB', :'inst', 'Borivali', 'BOR');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst', :'u_o', 'Owner', 'admin', 'active'),
 (:'s_ra', :'inst', :'u_ra', 'Ravi', 'rep', 'active'),
 (:'s_r2', :'inst', :'u_r2', 'Priya', 'rep', 'active'),
 (:'s_ac', :'inst', :'u_ac', 'Kavita', 'accounts', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, can_see_money, status) values
 (:'s_mm', :'inst', :'u_mm', 'Manager Money', 'admin', 'manager', true, 'active'),
 (:'s_mn', :'inst', :'u_mn', 'Manager Plain', 'admin', 'manager', false, 'active'),
 (:'s_ma', :'inst', :'u_ma', 'Manager Andheri', 'admin', 'manager', true, 'active');
update seats set centre_ids = array[:'cA']::uuid[] where id in (:'s_ra', :'s_ma');

-- An open list for every centre with a lead in Andheri, one in Borivali and one with no centre; a list for
-- Borivali only.
insert into campaigns (id, institute_id, name, call_type_id, status, open_to_all, share_mode) values
 (:'k1', :'inst', 'Every centre', (select id from call_types where key = 'fees' and institute_id is null), 'running', true, 'next_free'),
 (:'kB', :'inst', 'Borivali only', (select id from call_types where key = 'fees' and institute_id is null), 'running', true, 'next_free');
update campaigns set centre_id = :'cB' where id = :'kB';
insert into leads (id, institute_id, campaign_id, name, phone, status, centre_id, created_at) values
 (:'lB', :'inst', :'k1', 'Parent B', '+919100000002', 'new', :'cB', now() - interval '3 days'),
 (:'lA', :'inst', :'k1', 'Parent A', '+919100000001', 'new', :'cA', now() - interval '2 days'),
 (:'lN', :'inst', :'k1', 'Parent N', '+919100000003', 'new', null, now() - interval '1 days'),
 (:'lB2', :'inst', :'kB', 'Parent B2', '+919100000004', 'new', null, now() - interval '1 days');

-- ---------- 1. a caller limited to Andheri ----------
select pg_temp.as_user(:'u_ra');
set role authenticated;
select pg_temp.val_is('my_campaigns: the Borivali list is not shown', $q$select string_agg(name, ',' order by name) from my_campaigns()$q$, 'Every centre');
select pg_temp.val_is('my_campaigns: the pool counts Andheri and no-centre leads only', $q$select pool_leads_due::text from my_campaigns() where name = 'Every centre'$q$, '2');
select pg_temp.val_is('next_free_lead skips the older Borivali lead: Andheri first', format($q$select lead_id::text from next_free_lead(%L)$q$, :'k1'), :'lA');
select pg_temp.val_is('then the lead with no centre', format($q$select lead_id::text from next_free_lead(%L)$q$, :'k1'), :'lA');
reset role;
update leads set status = 'callback', next_call_at = now() + interval '1 day' where id = :'lA';
select pg_temp.as_user(:'u_ra');
set role authenticated;
select pg_temp.val_is('the shared lead comes next', format($q$select lead_id::text from next_free_lead(%L)$q$, :'k1'), :'lN');
reset role;
update leads set status = 'callback', next_call_at = now() + interval '1 day' where id = :'lN';
select pg_temp.as_user(:'u_ra');
set role authenticated;
select pg_temp.val_is('then nothing: the Borivali lead is never given', format($q$select count(*)::text from next_free_lead(%L)$q$, :'k1'), '0');
select pg_temp.fails_with('a Borivali list cannot be worked', format($q$select * from next_free_lead(%L)$q$, :'kB'), 'campaign not found');
select pg_temp.fails_with('nor its queue opened', format($q$select my_call_queue(%L)$q$, :'kB'), 'campaign not found');
reset role;
update leads set assigned_seat_id = :'s_ra' where id = :'lB';   -- given by hand before the limit
select pg_temp.as_user(:'u_ra');
set role authenticated;
select pg_temp.val_is('my_call_queue leaves out a Borivali lead held by the caller', format($q$select string_agg(x ->> 'name', ',' order by x ->> 'name') from jsonb_array_elements(my_call_queue(%L) -> 'leads') x$q$, :'k1'), 'Parent A,Parent N');
select pg_temp.val_is('my_campaigns: my leads count leaves it out too', $q$select my_leads::text from my_campaigns() where name = 'Every centre'$q$, '2');
reset role;
select pg_temp.as_user(:'u_r2');
set role authenticated;
select pg_temp.val_is('a caller of every centre sees both lists', $q$select count(*)::text from my_campaigns()$q$, '2');
reset role;

-- Changing the caller's centres sends their open leads outside them back to the pool.
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('the owner sets Ravi to Andheri again', format($q$select admin_set_seat_centres(%L, array[%L]::uuid[])$q$, :'s_ra', :'cA'));
reset role;
select pg_temp.val_is('the Borivali lead went back to the pool', format($q$select coalesce(assigned_seat_id::text, 'pool') from leads where id = %L$q$, :'lB'), 'pool');
select pg_temp.val_is('the Andheri lead stays with Ravi', format($q$select (assigned_seat_id = %L)::text from leads where id = %L$q$, :'s_ra', :'lA'), 'true');

-- Equal share of a list for chosen callers: Ravi (Andheri) and Priya (every centre); Borivali goes to Priya.
insert into campaigns (id, institute_id, name, call_type_id, status, open_to_all, share_mode) values
 (:'k3', :'inst', 'Chosen', (select id from call_types where key = 'fees' and institute_id is null), 'running', false, 'equal');
insert into campaign_members (institute_id, campaign_id, seat_id) values (:'inst', :'k3', :'s_ra'), (:'inst', :'k3', :'s_r2');
insert into leads (institute_id, campaign_id, name, phone, status, centre_id)
  select :'inst', :'k3', 'Bor ' || g, '+91920000000' || g, 'new', :'cB' from generate_series(1, 4) g;
insert into leads (institute_id, campaign_id, name, phone, status, centre_id)
  select :'inst', :'k3', 'And ' || g, '+91930000000' || g, 'new', :'cA' from generate_series(1, 4) g;
select pg_temp.ok('share the list equally', format($q$select campaign_share_equal(%L)$q$, :'k3'));
select pg_temp.val_is('no Borivali lead with Ravi after sharing', format($q$select count(*)::text from leads where campaign_id = %L and centre_id = %L and assigned_seat_id = %L$q$, :'k3', :'cB', :'s_ra'), '0');
select pg_temp.val_is('every lead has a caller', format($q$select count(*)::text from leads where campaign_id = %L and assigned_seat_id is null$q$, :'k3'), '0');
select pg_temp.val_is('the share stays equal: 4 each', format($q$select string_agg(n::text, ',') from (select count(*) n from leads where campaign_id = %L group by assigned_seat_id) x$q$, :'k3'), '4,4');
select pg_temp.val_is('Ravi got Andheri leads', format($q$select (count(*) > 0)::text from leads where campaign_id = %L and assigned_seat_id = %L$q$, :'k3', :'s_ra'), 'true');
update leads set assigned_seat_id = :'s_ra' where campaign_id = :'k3' and name = 'Bor 1';
select pg_temp.ok('share next free', format($q$select campaign_share_next_free(%L)$q$, :'k3'));
select pg_temp.val_is('next free: a Borivali lead held by Ravi goes back to the pool', format($q$select coalesce(assigned_seat_id::text, 'pool') from leads where campaign_id = %L and name = 'Bor 1'$q$, :'k3'), 'pool');

-- ---------- 2. payments by managers who can see money ----------
insert into students (id, institute_id, name, class_label, section, board, parent_name, phone, status, source, centre_id) values
 (:'stA', :'inst', 'Riya', '8', 'A', 'State', 'Sunita', '+919800000001', 'active', 'import', :'cA'),
 (:'stA2', :'inst', 'Aman', '8', 'B', 'State', 'Mr Rao', '+919800000002', 'active', 'import', :'cA'),
 (:'stB', :'inst', 'Bhavna', '8', 'A', 'State', 'Mr Shah', '+919800000003', 'active', 'import', :'cB');
insert into fee_items (institute_id, student_id, head, amount, due_date) values
 (:'inst', :'stA', 'Term 1', 4000, current_date - 10), (:'inst', :'stA2', 'Term 1', 3000, current_date - 10),
 (:'inst', :'stB', 'Term 1', 5000, current_date - 10);

select pg_temp.as_user(:'u_mm');
set role authenticated;
select pg_temp.keep('pm', format($q$select accounts_record_payment(%L, 1000, null, 'cash')::text$q$, :'stA'));
select pg_temp.val_is('a manager who can see money records a payment', format($q$select (recorded_by = %L)::text from payments where id = %L$q$, :'s_mm', pg_temp.g('pm')), 'true');
select pg_temp.val_is('collected_by_me: can_collect for that manager', $q$select collected_by_me() ->> 'can_collect'$q$, 'true');
select pg_temp.ok('the manager undoes their own payment', format($q$select accounts_reverse_payment(%L, 'Entered by mistake')$q$, pg_temp.g('pm')));
reset role;
select pg_temp.val_is('audit: payment.recorded and payment.reversed by the manager', format($q$select count(*)::text from audit_log where actor_id = %L and action in ('payment.recorded', 'payment.reversed')$q$, :'u_mm'), '2');
insert into payments (id, institute_id, student_id, amount, paid_on, mode, recorded_by, created_at) values
 ('d8000000-0000-0000-0000-000000000001', :'inst', :'stA', 500, current_date, 'cash', :'s_o', now()),
 ('d8000000-0000-0000-0000-000000000002', :'inst', :'stA', 600, current_date, 'cash', :'s_mm', now() - interval '1 hour');
select pg_temp.as_user(:'u_mm');
set role authenticated;
select pg_temp.fails_with('the manager cannot reverse the owner''s payment', $q$select accounts_reverse_payment('d8000000-0000-0000-0000-000000000001', 'x')$q$, 'only their own payment');
select pg_temp.fails_with('nor their own after 10 minutes', $q$select accounts_reverse_payment('d8000000-0000-0000-0000-000000000002', 'x')$q$, 'within 10 minutes');
reset role;

select pg_temp.as_user(:'u_mn');
set role authenticated;
select pg_temp.fails_with('a manager without money access is refused', format($q$select accounts_record_payment(%L, 100, null, 'cash')$q$, :'stA'), 'who can see money');
select pg_temp.val_is('collected_by_me: no can_collect without money', $q$select collected_by_me() ->> 'can_collect'$q$, 'false');
select pg_temp.fails_with('nor can they reverse a payment', $q$select accounts_reverse_payment('d8000000-0000-0000-0000-000000000001', 'x')$q$, 'payment not found');
reset role;

select pg_temp.as_user(:'u_ma');
set role authenticated;
select pg_temp.fails_with('a manager limited to Andheri is refused on a Borivali student', format($q$select accounts_record_payment(%L, 100, null, 'cash')$q$, :'stB'), 'student not found');
select pg_temp.ok('and records one for an Andheri student', format($q$select accounts_record_payment(%L, 100, null, 'upi', 'UTR77')$q$, :'stA'));
reset role;

select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.ok('Accounts still reverses anyone''s payment', $q$select accounts_reverse_payment('d8000000-0000-0000-0000-000000000002', 'wrong student')$q$);
reset role;

-- ---------- 3. Call these N parents ----------
select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.val_is('the plan: Class 8 with dues, every centre', $q$select (fees_call_plan('{"class_label":"8"}') ->> 'parents')$q$, '3');
select pg_temp.val_is('section A only', $q$select (fees_call_plan('{"class_label":"8","section":"A"}') ->> 'parents')$q$, '2');
select pg_temp.val_is('centre Andheri, section A', format($q$select (fees_call_plan(jsonb_build_object('class_label', '8', 'section', 'A', 'centre_id', %L)) ->> 'parents')$q$, :'cA'), '1');
select pg_temp.val_is('the name says class, section and centre', format($q$select (fees_call_plan(jsonb_build_object('class_label', '8', 'section', 'A', 'centre_id', %L)) ->> 'name') like 'Fees · Class 8-A · Andheri · %%'$q$, :'cA'), 'true');
select pg_temp.val_is('the plan has the amount (Accounts sees money)', $q$select (fees_call_plan('{"class_label":"8","section":"B"}') ->> 'amount')::numeric::int::text$q$, '3000');
select pg_temp.keep('fc', format($q$select fees_call_start(jsonb_build_object('class_label', '8', 'centre_id', %L)) ->> 'campaign_id'$q$, :'cA'));
reset role;
select pg_temp.val_is('the list runs, open to all, for Andheri, with 2 parents', format($q$select status || ':' || open_to_all || ':' || (centre_id = %L) || ':' || (select count(*) from leads l where l.campaign_id = c.id) from campaigns c where id = %L$q$, :'cA', pg_temp.g('fc')), 'running:true:true:2');
select pg_temp.val_is('each lead has the student and the due', format($q$select string_agg(extra ->> 'student' || '=' || amount_due::int, ',' order by name) from leads where campaign_id = %L$q$, pg_temp.g('fc')), 'Aman=3000,Riya=3400');
select pg_temp.val_is('audit: fees_campaign.from_ledger', format($q$select count(*)::text from audit_log where action = 'fees_campaign.from_ledger' and target like %L$q$, pg_temp.g('fc') || ':2:%'), '1');
select pg_temp.as_user(:'u_mn');
set role authenticated;
select pg_temp.fails_with('a manager without money cannot make it', $q$select fees_call_plan('{}')$q$, 'who can see money');
reset role;
select pg_temp.as_user(:'u_ra');
set role authenticated;
select pg_temp.fails_with('a caller cannot make it', $q$select fees_call_start('{}')$q$, 'who can see money');
reset role;
select pg_temp.as_user(:'u_ma');
set role authenticated;
select pg_temp.fails_with('a manager limited to Andheri cannot plan Borivali', format($q$select fees_call_plan(jsonb_build_object('centre_id', %L))$q$, :'cB'), 'only your own centres');
select pg_temp.val_is('and without a centre sees only Andheri parents', $q$select (fees_call_plan('{"class_label":"8"}') ->> 'parents')$q$, '2');
select pg_temp.fails_with('nobody to call: refused', $q$select fees_call_start('{"class_label":"12"}')$q$, 'nobody with dues');
reset role;

-- ---------- 4. Away today, with Undo ----------
update leads set assigned_seat_id = :'s_r2' where id in (:'lB', :'lB2');
select pg_temp.as_user(:'u_ra');
set role authenticated;
select pg_temp.fails_with('a caller cannot send someone away', format($q$select admin_away_today(%L)$q$, :'s_r2'), 'caller not found');
reset role;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.keep('away', format($q$select admin_away_today(%L)::text$q$, :'s_r2'));
select pg_temp.val_is('away: Priya''s open leads are in the pool', format($q$select (%L::jsonb ->> 'released')$q$, pg_temp.g('away')), '2');
reset role;
select pg_temp.val_is('the lead has no caller now', format($q$select coalesce(assigned_seat_id::text, 'pool') from leads where id = %L$q$, :'lB'), 'pool');
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('Undo gives them back', format($q$select admin_undo_away(%L, array(select jsonb_array_elements_text(%L::jsonb -> 'lead_ids'))::uuid[])::text$q$, :'s_r2', pg_temp.g('away')), '2');
select pg_temp.val_is('Undo of a lead someone took meanwhile does nothing', format($q$select admin_undo_away(%L, array[%L]::uuid[])::text$q$, :'s_r2', :'lA'), '0');
reset role;
select pg_temp.val_is('the lead is Priya''s again', format($q$select (assigned_seat_id = %L)::text from leads where id = %L$q$, :'s_r2', :'lB'), 'true');
select pg_temp.val_is('audit: lead.released :away and lead.returned', $q$select count(*) filter (where action = 'lead.released' and target like '%:away') || ':' || count(*) filter (where action = 'lead.returned') from audit_log$q$, '2:2');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
