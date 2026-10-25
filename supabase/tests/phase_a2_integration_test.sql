-- Tests for 20261025180000_phase_a2_integration.sql: {due_date} in my_call_queue (campaign fees_due_by, else the
-- student's oldest unpaid fee item), accounts seats left out of the callers in admin_callers and
-- admin_home_summary, open campaigns in the Home caller list, and common answers in the library's order.
-- Run with supabase/tests/run.sh. Expect failed = 0 on the last line.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''))::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails_with(name text, sql text, want text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, position(want in sqlerrm) > 0, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;
grant execute on function pg_temp.ok(text, text), pg_temp.fails_with(text, text, text), pg_temp.val_is(text, text, text)
  to authenticated, anon;

\set inst_i 'a7100000-0000-0000-0000-000000000001'
\set u_o 'a7300000-0000-0000-0000-000000000001'
\set u_ac 'a7300000-0000-0000-0000-000000000002'
\set u_a 'a7300000-0000-0000-0000-000000000003'
\set u_b 'a7300000-0000-0000-0000-000000000004'
\set s_o 'a7400000-0000-0000-0000-000000000001'
\set s_ac 'a7400000-0000-0000-0000-000000000002'
\set s_a 'a7400000-0000-0000-0000-000000000003'
\set s_b 'a7400000-0000-0000-0000-000000000004'
\set st_1 'a7500000-0000-0000-0000-000000000001'
\set st_2 'a7500000-0000-0000-0000-000000000002'
\set k_led 'a7600000-0000-0000-0000-000000000001'
\set k_due 'a7600000-0000-0000-0000-000000000002'
\set k_rst 'a7600000-0000-0000-0000-000000000003'

reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@i.test', now()), (:'u_ac', 'ac@i.test', now()), (:'u_a', 'a@i.test', now()), (:'u_b', 'b@i.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 20);
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o',  :'inst_i', :'u_o',  'Owner', 'admin', 'active'),
 (:'s_ac', :'inst_i', :'u_ac', 'Kavita (Accounts)', 'accounts', 'active'),
 (:'s_a',  :'inst_i', :'u_a',  'Asha', 'rep', 'active'),
 (:'s_b',  :'inst_i', :'u_b',  'Bina', 'rep', 'active');

-- Student 1: Term 1 (10,000, due 60 days ago) and Term 2 (8,000, due 10 days ago); 10,000 paid, then a
-- 2,000 payment reversed. The oldest unpaid item is Term 2. Student 2: one item fully paid.
insert into students (id, institute_id, name, class_label, board, parent_name, phone) values
 (:'st_1', :'inst_i', 'Aarav', '8th', 'CBSE', 'Sunita', '+919800000001'),
 (:'st_2', :'inst_i', 'Diya', '8th', 'CBSE', 'Ravi', '+919800000002');
insert into fee_items (institute_id, student_id, head, amount, due_date) values
 (:'inst_i', :'st_1', 'Term 1', 10000, current_date - 60),
 (:'inst_i', :'st_1', 'Term 2', 8000, current_date - 10),
 (:'inst_i', :'st_2', 'Term 1', 5000, current_date - 30);
insert into payments (institute_id, student_id, amount, paid_on, mode) values
 (:'inst_i', :'st_1', 10000, current_date - 50, 'cash'),
 (:'inst_i', :'st_2', 5000, current_date - 20, 'upi');
insert into payments (id, institute_id, student_id, amount, paid_on, mode) values
 ('a7700000-0000-0000-0000-000000000001', :'inst_i', :'st_1', 2000, current_date - 5, 'upi');
insert into payments (institute_id, student_id, amount, paid_on, mode, reverses_id) values
 (:'inst_i', :'st_1', 2000, current_date - 4, 'upi', 'a7700000-0000-0000-0000-000000000001');

-- An open ledger campaign without a due-by date, one with fees_due_by, and a restricted one with Asha only.
insert into campaigns (id, institute_id, name, call_type_id, status, open_to_all, share_mode, class_label, board, fees_due_by) values
 (:'k_led', :'inst_i', 'Ledger fees', (select id from call_types where key='fees' and institute_id is null), 'running', true, 'next_free', '8th', 'CBSE', null),
 (:'k_due', :'inst_i', 'Fees by date', (select id from call_types where key='fees' and institute_id is null), 'running', true, 'next_free', null, null, current_date + 15),
 (:'k_rst', :'inst_i', 'Restricted', (select id from call_types where key='sales' and institute_id is null), 'running', false, 'equal', null, null, null);
insert into campaign_members (institute_id, campaign_id, seat_id) values (:'inst_i', :'k_rst', :'s_a');
insert into leads (institute_id, campaign_id, name, phone, student_id, assigned_seat_id, amount_due, extra) values
 (:'inst_i', :'k_led', 'Sunita', '9800000001', :'st_1', :'s_a', 8000, '{"student": "Aarav"}'),
 (:'inst_i', :'k_led', 'Ravi', '9800000002', :'st_2', :'s_a', 0, '{"student": "Diya"}'),
 (:'inst_i', :'k_led', 'Walk-in', '9800000003', null, :'s_a', null, '{}'),
 (:'inst_i', :'k_due', 'Sunita again', '9800000004', :'st_1', :'s_a', 8000, '{}');

-- ---------- 1. {due_date} ----------
select pg_temp.val_is('oldest unpaid fee item: Term 2 (a reversed payment does not count)',
  format($q$select student_next_due_date(%L)::text$q$, :'st_1'), (current_date - 10)::text);
select pg_temp.val_is('nothing unpaid: no due date', format($q$select coalesce(student_next_due_date(%L)::text, 'none')$q$, :'st_2'), 'none');
select pg_temp.val_is('the browser cannot call student_next_due_date',
  $q$select has_function_privilege('authenticated', 'public.student_next_due_date(uuid)', 'execute')::text$q$, 'false');

select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.val_is('queue of a ledger campaign without fees_due_by: no campaign date',
  format($q$select coalesce(q->>'fees_due_by', 'none') from my_call_queue(%L) q$q$, :'k_led'), 'none');
select pg_temp.val_is('a ledger lead gets the oldest unpaid due date',
  format($q$select l->>'due_date' from my_call_queue(%L) q, jsonb_array_elements(q->'leads') l where l->>'name' = 'Sunita'$q$, :'k_led'), (current_date - 10)::text);
select pg_temp.val_is('a paid-up student: no due date',
  format($q$select coalesce(l->>'due_date', 'none') from my_call_queue(%L) q, jsonb_array_elements(q->'leads') l where l->>'name' = 'Ravi'$q$, :'k_led'), 'none');
select pg_temp.val_is('a lead without a student: no due date',
  format($q$select coalesce(l->>'due_date', 'none') from my_call_queue(%L) q, jsonb_array_elements(q->'leads') l where l->>'name' = 'Walk-in'$q$, :'k_led'), 'none');
select pg_temp.val_is('a campaign with fees_due_by gives it, at the top and on the lead',
  format($q$select (q->>'fees_due_by')||'|'||(q->'leads'->0->>'due_date') from my_call_queue(%L) q$q$, :'k_due'),
  (current_date + 15)::text || '|' || (current_date + 15)::text);
select pg_temp.val_is('the queue keeps its other keys',
  format($q$select string_agg(k, ',' order by k) from my_call_queue(%L) q, jsonb_object_keys(q) k$q$, :'k_led'),
  'board,campaign_id,class_label,daily_target,fees_due_by,leads,my_calls_today,open_to_all,share_mode,status,team_calls_today');
select pg_temp.val_is('each lead keeps its keys and adds due_date',
  format($q$select string_agg(k, ',' order by k) from my_call_queue(%L) q, jsonb_object_keys(q->'leads'->0) k$q$, :'k_led'),
  'calls,consent_whatsapp,created_at,due_date,extra,id,last_called_at,last_note,last_result_key,name,next_call_at,phone,promised_date,status,student_id');
reset role;
select pg_temp.as_user(:'u_b');
set role authenticated;
select pg_temp.fails_with('a non-member still cannot open a restricted queue', format($q$select my_call_queue(%L)$q$, :'k_rst'), 'campaign not found');
select pg_temp.val_is('a caller still sees only own leads in an open queue',
  format($q$select jsonb_array_length(q->'leads')::text from my_call_queue(%L) q$q$, :'k_led'), '0');
reset role;
select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.fails_with('an accounts seat has no call queue', format($q$select my_call_queue(%L)$q$, :'k_rst'), 'campaign not found');
reset role;

-- ---------- 2. Accounts seats are not callers ----------
-- The accounts seat has the page open (presence), yet is not shown as a caller.
insert into seat_presence (institute_id, seat_id, seen_at, phone_ok, on_call, online_since) values (:'inst_i', :'s_ac', now(), true, false, now());
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('admin_callers keeps the accounts seat with its role',
  format($q$select access_role from admin_callers(%L) where seat_id = %L$q$, :'inst_i', :'s_ac'), 'accounts');
select pg_temp.val_is('the accounts seat has no now status, target or campaigns',
  format($q$select coalesce(now_status::text, 'none')||':'||coalesce(calls_target::text, 'none')||':'||campaigns::text from admin_callers(%L) where seat_id = %L$q$, :'inst_i', :'s_ac'),
  'none:none:[]');
select pg_temp.val_is('callers still have their now status and campaigns',
  format($q$select (now_status->>'status')||':'||campaigns::text from admin_callers(%L) where seat_id = %L$q$, :'inst_i', :'s_a'),
  'not_started:[{"id": "a7600000-0000-0000-0000-000000000003", "name": "Restricted", "status": "running"}]');
select pg_temp.val_is('admin_callers lists every seat',
  format($q$select count(*)::text from admin_callers(%L)$q$, :'inst_i'), '4');
select pg_temp.val_is('Home lists the callers only, never the accounts seat',
  $q$select string_agg(c->>'label', ',' order by c->>'label') from jsonb_array_elements(admin_home_summary('today')->'callers') c$q$, 'Asha,Bina');
select pg_temp.val_is('Home with an open campaign lists every caller',
  format($q$select string_agg(c->>'label', ',' order by c->>'label') from jsonb_array_elements(admin_home_summary('today', %L)->'callers') c$q$, :'k_led'), 'Asha,Bina');
select pg_temp.val_is('Home with a restricted campaign lists its members',
  format($q$select string_agg(c->>'label', ',' order by c->>'label') from jsonb_array_elements(admin_home_summary('today', %L)->'callers') c$q$, :'k_rst'), 'Asha');
select pg_temp.val_is('Home keeps its keys',
  $q$select string_agg(k, ',' order by k) from jsonb_object_keys(admin_home_summary('today')) k$q$,
  'callers,campaign_choices,campaigns,day,from,generated_at,money_hidden,promises_due_today,script_ends,scripts_feature,tiles,time_zone,to');
reset role;
select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.fails_with('an accounts seat cannot read Home', $q$select admin_home_summary('today')$q$, 'only an admin');
select pg_temp.fails_with('an accounts seat cannot read admin_callers', format($q$select * from admin_callers(%L)$q$, :'inst_i'), '');
reset role;

-- ---------- 3. Common answers in the library's order ----------
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.val_is('"Where did you get my number?" comes first',
  $q$select label from my_common_answers() limit 1$q$, 'Where did you get my number?');
select pg_temp.val_is('then "I never gave you my number"',
  $q$select label from my_common_answers() offset 1 limit 1$q$, 'I never gave you my number');
select pg_temp.val_is('all 21 answers', $q$select count(*)::text from my_common_answers()$q$, '21');
reset role;
select pg_temp.val_is('every seeded answer has its place', $q$select count(*)::text from common_answers where sort_order = 1000$q$, '0');
select pg_temp.ok('the Vector team adds an answer', $q$insert into common_answers (key, label, answer, tags) values ('zz_new', 'A new one', 'Yes.', array['all'])$q$);
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.val_is('a new answer goes last', $q$select key from my_common_answers() offset 21 limit 1$q$, 'zz_new');
reset role;

select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
