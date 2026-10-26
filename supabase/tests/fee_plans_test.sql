-- Tests for 20261026110000_fee_plans_discounts.sql: fee plans by class (idempotent apply, optional fees,
-- plan changes, removed fees, fees cancelled by hand, undo, new students), discounts in balances and in fees
-- leads' amount_due, who may do what, money rules, and the day closing sheet. Run with supabase/tests/run.sh.
-- Expect failed = 0 on the last line.
\set ON_ERROR_STOP 0
set timezone = 'Asia/Kolkata';
create or replace function pg_temp.as_user(u uuid, mail text default null) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''), 'email', mail)::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
create temp table v (k text primary key, val text);
grant all on v to authenticated, anon;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
create or replace function pg_temp.fails_with(name text, sql text, want text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, position(want in sqlerrm) > 0, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare x text; begin execute sql into x;
  insert into results values (name, x is not distinct from want, 'got '||coalesce(x,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;
-- Keeps a value (an id from an answer) for later tests: pg_temp.keep('k', sql).
create or replace function pg_temp.keep(key text, sql text) returns void language plpgsql as $$
declare x text; begin execute sql into x; insert into v values (key, x) on conflict (k) do update set val = excluded.val;
exception when others then insert into results values ('keep ' || key, false, sqlerrm); end $$;
create or replace function pg_temp.g(key text) returns text language sql as $$ select val from v where k = key $$;
create or replace function pg_temp.d(n int) returns text language sql as $$
  select ((now() at time zone 'Asia/Kolkata')::date + n)::text $$;
-- val_is run as the table owner (to look at amount columns the browser cannot read), then back to the caller's role.
create or replace function pg_temp.db_is(name text, sql text, want text) returns void language plpgsql as $$
declare x text; r text := current_user;
begin reset role; execute sql into x; execute format('set role %I', r);
  insert into results values (name, x is not distinct from want, 'got '||coalesce(x,'null')||', want '||coalesce(want,'null'));
exception when others then execute format('set role %I', r); insert into results values (name, false, sqlerrm); end $$;
grant execute on function pg_temp.db_is(text, text, text), pg_temp.ok(text, text), pg_temp.fails(text, text), pg_temp.fails_with(text, text, text),
  pg_temp.val_is(text, text, text), pg_temp.keep(text, text), pg_temp.g(text), pg_temp.d(int) to authenticated, anon;

\set inst_i 'f1000000-0000-0000-0000-000000000001'
\set inst_j 'f2000000-0000-0000-0000-000000000002'
\set u_o  'f3000000-0000-0000-0000-000000000001'
\set u_m  'f3000000-0000-0000-0000-000000000002'
\set u_m2 'f3000000-0000-0000-0000-000000000003'
\set u_ac 'f3000000-0000-0000-0000-000000000004'
\set u_a  'f3000000-0000-0000-0000-000000000005'
\set u_x  'f3000000-0000-0000-0000-000000000007'
\set s_o  'f4000000-0000-0000-0000-000000000001'
\set s_m  'f4000000-0000-0000-0000-000000000002'
\set s_m2 'f4000000-0000-0000-0000-000000000003'
\set s_ac 'f4000000-0000-0000-0000-000000000004'
\set s_a  'f4000000-0000-0000-0000-000000000005'
\set s_x  'f4000000-0000-0000-0000-000000000007'
\set st1 'f5000000-0000-0000-0000-000000000001'
\set st2 'f5000000-0000-0000-0000-000000000002'
\set st3 'f5000000-0000-0000-0000-000000000003'
\set st4 'f5000000-0000-0000-0000-000000000004'
\set st5 'f5000000-0000-0000-0000-000000000005'
\set k_fee 'f6000000-0000-0000-0000-000000000001'
\set l_2 'f7000000-0000-0000-0000-000000000002'

-- ---------- fixtures ----------
-- Inst I: owner O, manager M (no money), manager M2 (money), accounts AC, caller A. Inst J: owner X.
-- Class 8 (CBSE): S1 (bus; already has "Term 1 tuition" 10,000 from an import), S2, S3, S4 (left).
-- Class 9: S5. A running fees campaign with a lead for S2's parent.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@i.test', now()), (:'u_m', 'm@i.test', now()), (:'u_m2', 'm2@i.test', now()), (:'u_ac', 'ac@i.test', now()),
 (:'u_a', 'a@i.test', now()), (:'u_x', 'x@j.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 20), (:'inst_j', 'Inst J', 'active', 5);
insert into seats (id, institute_id, user_id, label, role, status) values (:'s_o', :'inst_i', :'u_o', 'Anita (owner)', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, can_see_money, status) values
 (:'s_m',  :'inst_i', :'u_m',  'Manager', 'admin', 'manager', false, 'active'),
 (:'s_m2', :'inst_i', :'u_m2', 'Manager money', 'admin', 'manager', true, 'active'),
 (:'s_x',  :'inst_j', :'u_x',  'Owner J', 'admin', 'owner', false, 'active');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_ac', :'inst_i', :'u_ac', 'Kavita', 'accounts', 'active'),
 (:'s_a',  :'inst_i', :'u_a',  'Caller A', 'rep', 'active');
insert into students (id, institute_id, admission_no, name, class_label, section, board, academic_year, parent_name, phone, status, uses_bus, source) values
 (:'st1', :'inst_i', 'A1', 'Asha', '8th', 'A', 'CBSE', '2026-27', 'Mr A', '9800000001', 'active', true, 'import'),
 (:'st2', :'inst_i', 'A2', 'Bala', '8th', 'A', 'CBSE', '2026-27', 'Mrs B', '9800000002', 'active', false, 'import'),
 (:'st3', :'inst_i', 'A3', 'Chirag', '8TH', 'B', 'CBSE', null, 'Mr C', '9800000003', 'active', false, 'import'),
 (:'st4', :'inst_i', 'A4', 'Dina', '8th', 'B', 'CBSE', '2026-27', 'Mr D', '9800000004', 'left', false, 'import'),
 (:'st5', :'inst_i', 'A5', 'Esha', '9th', 'A', 'ICSE', '2026-27', 'Mr E', '9800000005', 'active', false, 'import');
insert into fee_items (institute_id, student_id, head, amount, due_date, academic_year)
  values (:'inst_i', :'st1', 'Term 1 Tuition', 10000, (now() at time zone 'Asia/Kolkata')::date - 30, '2026-27');
insert into campaigns (id, institute_id, name, call_type_id, status) values
 (:'k_fee', :'inst_i', 'Fees Class 8', (select id from call_types where key='fees' and institute_id is null), 'running');
insert into leads (id, institute_id, campaign_id, name, phone, amount_due, student_id) values
 (:'l_2', :'inst_i', :'k_fee', 'Mrs B', '9800000002', 0, :'st2');

-- ---------- making a plan: who may ----------
create temp table plan8 (j jsonb);
grant all on plan8 to authenticated;
insert into plan8 values (jsonb_build_object('academic_year', '2026-27', 'class_label', '8th', 'board', 'cbse', 'items', jsonb_build_array(
  jsonb_build_object('head', 'Term 1 tuition', 'amount', '10,000', 'due_date', pg_temp.d(-30)),
  jsonb_build_object('head', 'Term 2 tuition', 'amount', 12000, 'due_date', pg_temp.d(30)),
  jsonb_build_object('head', 'Bus fee', 'amount', 3000, 'due_date', pg_temp.d(-10), 'who', 'bus'),
  jsonb_build_object('head', 'Lab kit', 'amount', 500, 'due_date', pg_temp.d(-1), 'who', 'chosen')),
  'rules', jsonb_build_array(jsonb_build_object('reason', 'sibling', 'percent', 10, 'heads', jsonb_build_array('Term 1 tuition', 'term 2 tuition')))));

select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.fails_with('a caller cannot make a fee plan', $q$select fee_plan_save(null, (select j from plan8))$q$, 'only accounts or an owner');
select pg_temp.fails('a caller cannot list fee plans', $q$select fee_plans_list()$q$);
select pg_temp.fails('a caller cannot read the day closing', format($q$select ledger_day_closing(%L)$q$, :'inst_i'));
reset role;
select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.fails_with('a manager (even with money) cannot make a fee plan', $q$select fee_plan_save(null, (select j from plan8))$q$, 'only accounts or an owner');
reset role;

select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.fails_with('a plan needs fees', $q$select fee_plan_save(null, '{"academic_year":"2026-27","class_label":"8th","items":[]}')$q$, '1 to 30 fees');
select pg_temp.fails_with('a plan needs a year like 2026-27', $q$select fee_plan_save(null, '{"academic_year":"2026","class_label":"8th","items":[{"head":"T","amount":1,"due_date":"2026-11-01"}]}')$q$, 'academic year');
select pg_temp.fails_with('a fee twice in a plan is refused', $q$select fee_plan_save(null, '{"academic_year":"2026-27","class_label":"7th","items":[{"head":"T1","amount":1,"due_date":"2026-11-01"},{"head":"t1 ","amount":2,"due_date":"2026-11-01"}]}')$q$, 'twice');
select pg_temp.fails_with('a rule on a fee not in the plan is refused', $q$select fee_plan_save(null, '{"academic_year":"2026-27","class_label":"7th","items":[{"head":"T1","amount":1,"due_date":"2026-11-01"}],"rules":[{"reason":"merit","percent":5,"heads":["Bus"]}]}')$q$, 'not in the plan');
select pg_temp.keep('plan8', $q$select fee_plan_save(null, (select j from plan8))::text$q$);
select pg_temp.val_is('Accounts made the Class 8 plan', $q$select count(*)::text from fee_plans where class_label = '8th' and board = 'CBSE'$q$, '1');
select pg_temp.fails_with('a second plan for the same class and year is refused', $q$select fee_plan_save(null, (select j from plan8))$q$, 'already a fee plan');
select pg_temp.val_is('the browser cannot read plan amounts', $q$select has_column_privilege('authenticated','public.fee_plan_items','amount','SELECT')::text$q$, 'false');
reset role;
select pg_temp.val_is('audit: fee_plan.created', format($q$select count(*)::text from audit_log where action = 'fee_plan.created' and target = %L$q$, pg_temp.g('plan8')), '1');
select pg_temp.keep('it_t1', $q$select id::text from fee_plan_items where head = 'Term 1 tuition'$q$);
select pg_temp.keep('it_t2', $q$select id::text from fee_plan_items where head = 'Term 2 tuition'$q$);
select pg_temp.keep('it_bus', $q$select id::text from fee_plan_items where head = 'Bus fee'$q$);
select pg_temp.keep('it_lab', $q$select id::text from fee_plan_items where head = 'Lab kit'$q$);
select pg_temp.keep('rule_sib', $q$select id::text from fee_plan_rules where reason = 'sibling'$q$);

select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.fails_with('another institute''s owner cannot see the plan', format($q$select fee_plan_preview(%L)$q$, pg_temp.g('plan8')), 'not found');
select pg_temp.fails_with('another institute''s owner cannot apply it', format($q$select fee_plan_apply(%L)$q$, pg_temp.g('plan8')), 'not found');
select pg_temp.val_is('another institute sees no plans', $q$select jsonb_array_length(fee_plans_list())::text$q$, '0');
select pg_temp.val_is('another institute reads no plan rows', $q$select count(*)::text from fee_plans$q$, '0');
reset role;

-- ---------- preview ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('preview: 3 active students of Class 8 (any case, the left one and Class 9 left out)',
  format($q$select (fee_plan_preview(%L)->>'students')$q$, pg_temp.g('plan8')), '3');
select pg_temp.val_is('preview: Term 1 is missing for 2, already there for 1 (same name, amount and date)',
  format($q$select i->>'missing' || ':' || (i->>'same') from jsonb_array_elements(fee_plan_preview(%L)->'items') i where i->>'head' = 'Term 1 tuition'$q$, pg_temp.g('plan8')), '2:1');
select pg_temp.val_is('preview: the bus fee is ticked for the 1 bus student',
  format($q$select i->>'ticked' from jsonb_array_elements(fee_plan_preview(%L)->'items') i where i->>'head' = 'Bus fee'$q$, pg_temp.g('plan8')), '1');
select pg_temp.val_is('preview: the "chosen" fee is ticked for nobody',
  format($q$select i->>'ticked' from jsonb_array_elements(fee_plan_preview(%L)->'items') i where i->>'head' = 'Lab kit'$q$, pg_temp.g('plan8')), '0');
select pg_temp.val_is('preview: a row per student with each fee''s state',
  format($q$select r->'items'->>%L from jsonb_array_elements(fee_plan_preview(%L)->'rows') r where r->>'student_id' = %L$q$, pg_temp.g('it_t1'), pg_temp.g('plan8'), :'st1'), 'same');
select pg_temp.val_is('plans list: 5 fees to add now (optional ones left out) for 3 students',
  $q$select (p->'pending'->>'add') || ':' || (p->'pending'->>'students') from jsonb_array_elements(fee_plans_list()) p$q$, '5:3');
reset role;
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('a manager without money sees the preview with no amounts',
  format($q$select coalesce(i->>'amount', 'hidden') || ':' || (fee_plan_preview(%L)->>'money_hidden') from jsonb_array_elements(fee_plan_preview(%L)->'items') i limit 1$q$, pg_temp.g('plan8'), pg_temp.g('plan8')), 'hidden:true');
select pg_temp.fails_with('a manager cannot apply a plan', format($q$select fee_plan_apply(%L)$q$, pg_temp.g('plan8')), 'not found');
reset role;

-- ---------- apply ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.keep('apply1', format($q$select fee_plan_apply(%L, jsonb_build_object(%L, jsonb_build_array(%L)), jsonb_build_object(%L, jsonb_build_array(%L)))::text$q$,
  pg_temp.g('plan8'), pg_temp.g('it_lab'), :'st2', pg_temp.g('rule_sib'), :'st3'));
select pg_temp.val_is('apply: 7 fees added (Term 1 ×2, Term 2 ×3, bus ×1, lab kit ×1), 1 linked, 1 discount',
  $q$select (val::jsonb->>'added') || ':' || (val::jsonb->>'linked') || ':' || (val::jsonb->>'discounts') || ':' || (val::jsonb->>'changed') from v where k = 'apply1'$q$, '7:1:1:0');
select pg_temp.val_is('apply can be undone (it only added)', $q$select val::jsonb->>'can_undo' from v where k = 'apply1'$q$, 'true');
select pg_temp.val_is('S1: Term 1 (linked), Term 2 and the bus fee = 25,000',
  format($q$select total_fees::text from accounts_students('{"search":"Asha"}')$q$), '25000.00');
select pg_temp.val_is('S1 is not charged Term 1 twice', format($q$select count(*)::text from fee_items where student_id = %L and lower(head) = 'term 1 tuition' and not is_void$q$, :'st1'), '1');
select pg_temp.val_is('S1''s imported Term 1 is now linked to the plan', format($q$select (plan_item_id = %L)::text from fee_items where student_id = %L and lower(head) = 'term 1 tuition'$q$, pg_temp.g('it_t1'), :'st1'), 'true');
select pg_temp.val_is('S2 (lab kit ticked): 10,000 + 12,000 + 500', format($q$select total_fees::text from accounts_students('{"search":"Bala"}')$q$), '22500.00');
select pg_temp.val_is('S3 (sibling 10%% on tuition): 22,000 − 2,200 = 19,800 total, 9,000 due now',
  format($q$select total_fees || ':' || balance_due_now from accounts_students('{"search":"Chirag"}')$q$), '19800.00:9000.00');
select pg_temp.db_is('S3''s sibling discount: two lines of 1,000 and 1,200, approved by the person who applied',
  format($q$select string_agg(amount::text || '/' || approved_by, ',' order by amount) from discounts where student_id = %L$q$, :'st3'), '1000.00/Kavita,1200.00/Kavita');
select pg_temp.val_is('the left student got nothing', format($q$select count(*)::text from fee_items where student_id = %L$q$, :'st4'), '0');
select pg_temp.val_is('the Class 9 student got nothing', format($q$select count(*)::text from fee_items where student_id = %L$q$, :'st5'), '0');
select pg_temp.db_is('S2''s fees lead: amount_due = the balance due now (10,500)', format($q$select amount_due::text from leads where id = %L$q$, :'l_2'), '10500.00');
-- again
select pg_temp.keep('apply2', format($q$select fee_plan_apply(%L, jsonb_build_object(%L, jsonb_build_array(%L)), jsonb_build_object(%L, jsonb_build_array(%L)))::text$q$,
  pg_temp.g('plan8'), pg_temp.g('it_lab'), :'st2', pg_temp.g('rule_sib'), :'st3'));
select pg_temp.val_is('applying again adds nothing (no fee, no link, no discount)',
  $q$select (val::jsonb->>'added') || ':' || (val::jsonb->>'linked') || ':' || (val::jsonb->>'discounts') || ':' || (val::jsonb->>'can_undo') from v where k = 'apply2'$q$, '0:0:0:false');
select pg_temp.val_is('and nothing doubled', $q$select count(*)::text from fee_items where not is_void$q$, '8');
select pg_temp.val_is('plans list: nothing pending', $q$select (p->'pending'->>'add') || ':' || (p->'pending'->>'change') from jsonb_array_elements(fee_plans_list()) p$q$, '0:0');
reset role;
select pg_temp.val_is('audit: fee_plan.applied twice', $q$select count(*)::text from audit_log where action = 'fee_plan.applied'$q$, '2');

-- ---------- discounts ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.fails('a caller cannot give a discount', format($q$select accounts_give_discount(%L, '{"kind":"amount","value":100,"whole_year":true,"reason":"merit"}')$q$, :'st2'));
reset role;
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.fails('a manager without money cannot give a discount', format($q$select accounts_give_discount(%L, '{"kind":"amount","value":100,"whole_year":true,"reason":"merit"}')$q$, :'st2'));
reset role;
select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.fails('another institute cannot give a discount', format($q$select accounts_give_discount(%L, '{"kind":"amount","value":100,"whole_year":true,"reason":"merit"}')$q$, :'st2'));
reset role;
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.fails_with('a percent over 100 is refused', format($q$select accounts_give_discount(%L, '{"kind":"percent","value":120,"whole_year":true,"reason":"merit"}')$q$, :'st2'), 'at most 100');
select pg_temp.fails_with('"Other" needs a note', format($q$select accounts_give_discount(%L, '{"kind":"amount","value":100,"whole_year":true,"reason":"other"}')$q$, :'st2'), 'what the discount is for');
select pg_temp.fails_with('more than the fees is refused', format($q$select accounts_give_discount(%L, '{"kind":"amount","value":99999,"whole_year":true,"reason":"merit"}')$q$, :'st2'), 'more than what is left');
select pg_temp.fails_with('a fee of another student is refused', format($q$select accounts_give_discount(%L, jsonb_build_object('kind','amount','value',100,'reason','merit','fee_items',jsonb_build_array((select id from fee_items where student_id = %L limit 1))))$q$, :'st2', :'st1'), 'not one of this student');
select pg_temp.keep('g_whole', format($q$select (accounts_give_discount(%L, '{"kind":"amount","value":"1,000","whole_year":true,"reason":"financial_help"}')->>'grant_id')$q$, :'st2'));
select pg_temp.db_is('a whole-year ₹1,000 is split over the 3 fees by what is left (444.44 + 22.22 + 533.34)',
  format($q$select string_agg(d.amount::text, '+' order by fi.due_date) from discounts d join fee_items fi on fi.id = d.fee_item_id where d.grant_id = %L$q$, pg_temp.g('g_whole')), '444.44+22.22+533.34');
select pg_temp.db_is('approved by defaults to the signed-in person', format($q$select distinct approved_by from discounts where grant_id = %L$q$, pg_temp.g('g_whole')), 'Kavita');
select pg_temp.val_is('S2 balance: 22,500 − 1,000 = 21,500 for the year; due now 10,500 − 466.66',
  $q$select balance_total || ':' || balance_due_now from accounts_students('{"search":"Bala"}')$q$, '21500.00:10033.34');
select pg_temp.db_is('S2''s lead follows the discount', format($q$select amount_due::text from leads where id = %L$q$, :'l_2'), '10033.34');
select pg_temp.val_is('the student page shows the discount with its fees and reason',
  format($q$select (d->>'reason_label') || ':' || (d->>'amount') || ':' || jsonb_array_length(d->'fees') from jsonb_array_elements(accounts_student_detail(%L)->'discounts') d$q$, :'st2'), 'Financial help:1000.00:3');
select pg_temp.val_is('the student page balance has the discount total', format($q$select accounts_student_detail(%L)->'balance'->>'discounts'$q$, :'st2'), '1000.00');
select pg_temp.keep('g_pct', format($q$select (accounts_give_discount(%L, jsonb_build_object('kind','percent','value',50,'reason','staff_child','approved_by','Principal','fee_items',jsonb_build_array((select id from fee_items where student_id = %L and head = 'Lab kit'))))->>'grant_id')$q$, :'st2', :'st2'));
select pg_temp.db_is('50%% of the lab kit, approved by the principal',
  format($q$select amount || ':' || approved_by from discounts where grant_id = %L$q$, pg_temp.g('g_pct')), '250.00:Principal');
select pg_temp.fails_with('removing needs a reason', format($q$select accounts_remove_discount(%L, ' ')$q$, pg_temp.g('g_whole')), 'reason');
select pg_temp.val_is('removing the whole-year discount removes its 3 lines', format($q$select accounts_remove_discount(%L, 'Given by mistake')::text$q$, pg_temp.g('g_whole')), '3');
select pg_temp.fails_with('and only once', format($q$select accounts_remove_discount(%L, 'again')$q$, pg_temp.g('g_whole')), 'already removed');
select pg_temp.val_is('S2 balance back up (only the 250 lab kit discount left)', $q$select balance_total::text from accounts_students('{"search":"Bala"}')$q$, '22250.00');
select pg_temp.db_is('S2''s lead goes back up too', format($q$select amount_due::text from leads where id = %L$q$, :'l_2'), '10250.00');
select pg_temp.val_is('the removed discount stays in the history with its reason',
  format($q$select (d->>'is_removed') || ':' || (d->>'removed_reason') || ':' || (d->>'removed_by_label') from jsonb_array_elements(accounts_student_detail(%L)->'discounts') d where d->>'grant_id' = %L$q$, :'st2', pg_temp.g('g_whole')), 'true:Given by mistake:Kavita');
select pg_temp.val_is('the browser cannot read discount amounts', $q$select has_column_privilege('authenticated','public.discounts','amount','SELECT')::text$q$, 'false');
select pg_temp.val_is('the browser cannot write discounts', $q$select has_table_privilege('authenticated','public.discounts','INSERT')::text$q$, 'false');
reset role;
select pg_temp.fails_with('a discount row cannot be changed, even by the table owner', format($q$update discounts set amount = 1 where grant_id = %L$q$, pg_temp.g('g_pct')), 'cannot be changed');
select pg_temp.val_is('audit: discount.given twice, discount.removed once',
  $q$select (count(*) filter (where action = 'discount.given'))::text || ':' || (count(*) filter (where action = 'discount.removed')) from audit_log$q$, '2:1');
select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.fails_with('no discount for a student with no fees', format($q$select accounts_give_discount(%L, '{"kind":"amount","value":100,"whole_year":true,"reason":"merit"}')$q$, :'st5'), 'no fees');
select pg_temp.ok('a manager who can see money gives a merit discount', format($q$select accounts_give_discount(%L, '{"kind":"amount","value":100,"whole_year":true,"reason":"merit"}')$q$, :'st1'));
select pg_temp.val_is('the manager reads amounts', format($q$select accounts_student_detail(%L)->'balance'->>'discounts'$q$, :'st1'), '100.00');
reset role;
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('a manager without money sees the discount, not its amount',
  format($q$select (d->>'reason_label') || ':' || coalesce(d->>'amount', 'hidden') from jsonb_array_elements(accounts_student_detail(%L)->'discounts') d$q$, :'st1'), 'Merit:hidden');
reset role;

-- ---------- the plan changes ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.ok('Term 2 goes up to 13,000 and the lab kit leaves the plan', format($q$select fee_plan_save(%L, jsonb_build_object(
  'academic_year','2026-27','class_label','8th','board','CBSE','items', jsonb_build_array(
    jsonb_build_object('id',%L,'head','Term 1 tuition','amount',10000,'due_date',pg_temp.d(-30)),
    jsonb_build_object('id',%L,'head','Term 2 tuition','amount',13000,'due_date',pg_temp.d(30)),
    jsonb_build_object('id',%L,'head','Bus fee','amount',3000,'due_date',pg_temp.d(-10),'who','bus')),
  'rules', jsonb_build_array(jsonb_build_object('id',%L,'reason','sibling','percent',10,'heads',jsonb_build_array('Term 1 tuition','Term 2 tuition')))))$q$,
  pg_temp.g('plan8'), pg_temp.g('it_t1'), pg_temp.g('it_t2'), pg_temp.g('it_bus'), pg_temp.g('rule_sib')));
select pg_temp.val_is('preview: Term 2 to change for 3 students', format($q$select i->>'change' from jsonb_array_elements(fee_plan_preview(%L)->'items') i where i->>'head' = 'Term 2 tuition'$q$, pg_temp.g('plan8')), '3');
select pg_temp.val_is('preview: the lab kit to cancel for 1 student', format($q$select (r->>'head') || ':' || (r->>'students') from jsonb_array_elements(fee_plan_preview(%L)->'removed') r$q$, pg_temp.g('plan8')), 'Lab kit:1');
select pg_temp.val_is('plans list: apply the change to 3 students', $q$select (p->'pending'->>'change') || ':' || (p->'pending'->>'remove') || ':' || (p->'pending'->>'students') from jsonb_array_elements(fee_plans_list()) p$q$, '3:1:3');
select pg_temp.keep('apply3', format($q$select fee_plan_apply(%L)::text$q$, pg_temp.g('plan8')));
select pg_temp.val_is('apply: 3 changed, 1 removed, nothing added, no undo',
  $q$select (val::jsonb->>'changed') || ':' || (val::jsonb->>'removed') || ':' || (val::jsonb->>'added') || ':' || (val::jsonb->>'can_undo') from v where k = 'apply3'$q$, '3:1:0:false');
select pg_temp.db_is('the old Term 2 is cancelled, not edited', format($q$select string_agg(amount::text || ':' || is_void, ',' order by amount) from fee_items where student_id = %L and head = 'Term 2 tuition'$q$, :'st3'), '12000.00:true,13000.00:false');
select pg_temp.db_is('S3''s sibling discount moves to the new Term 2 (10%% of 13,000)', format($q$select sum(d.amount)::text from discounts d join fee_items fi on fi.id = d.fee_item_id where d.student_id = %L and not d.is_removed and not fi.is_void and fi.head = 'Term 2 tuition'$q$, :'st3'), '1300.00');
select pg_temp.val_is('S3: 10,000 + 13,000 − 2,300', $q$select total_fees::text from accounts_students('{"search":"Chirag"}')$q$, '20700.00');
select pg_temp.val_is('S2: lab kit cancelled (and its discount no longer counts), Term 2 13,000', $q$select total_fees::text from accounts_students('{"search":"Bala"}')$q$, '23000.00');
select pg_temp.db_is('S2''s lead: due now is Term 1 only (10,000)', format($q$select amount_due::text from leads where id = %L$q$, :'l_2'), '10000.00');
select pg_temp.val_is('applying again changes nothing', format($q$select (r->>'added') || ':' || (r->>'changed') || ':' || (r->>'removed') from fee_plan_apply(%L) r$q$, pg_temp.g('plan8')), '0:0:0');
-- a fee cancelled by hand for one student is not added again
select pg_temp.ok('Accounts cancels S1''s bus fee by hand', format($q$select accounts_void_fee_item((select id from fee_items where student_id = %L and head = 'Bus fee' and not is_void), 'Stopped using the bus')$q$, :'st1'));
select pg_temp.val_is('preview: the bus fee shows as cancelled for 1', format($q$select i->>'cancelled' from jsonb_array_elements(fee_plan_preview(%L)->'items') i where i->>'head' = 'Bus fee'$q$, pg_temp.g('plan8')), '1');
select pg_temp.val_is('apply does not add it back', format($q$select r->>'added' from fee_plan_apply(%L) r$q$, pg_temp.g('plan8')), '0');
reset role;

-- ---------- undo, new students, import, delete ----------
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.keep('plan9', $q$select fee_plan_save(null, jsonb_build_object('academic_year','2026-27','class_label','9th','items', jsonb_build_array(
  jsonb_build_object('head','Annual fee','amount',20000,'due_date',pg_temp.d(-5)))))::text$q$);
select pg_temp.keep('apply9', format($q$select fee_plan_apply(%L)->>'apply_id'$q$, pg_temp.g('plan9')));
select pg_temp.val_is('the owner applied the Class 9 plan: S5 owes 20,000', $q$select balance_due_now::text from accounts_students('{"search":"Esha"}')$q$, '20000.00');
select pg_temp.val_is('undo cancels what it added', format($q$select fee_plan_undo(%L)->>'fees_cancelled'$q$, pg_temp.g('apply9')), '1');
select pg_temp.val_is('S5 owes nothing after the undo', $q$select balance_due_now::text from accounts_students('{"search":"Esha"}')$q$, '0.00');
select pg_temp.fails_with('an undo runs once', format($q$select fee_plan_undo(%L)$q$, pg_temp.g('apply9')), 'already undone');
select pg_temp.fails_with('a change that edited fees cannot be undone', format($q$select fee_plan_undo((select val::jsonb->>'apply_id' from v where k = 'apply3')::uuid)$q$), 'cannot be undone');
select pg_temp.val_is('after an undo, applying again adds it again', format($q$select r->>'added' from fee_plan_apply(%L) r$q$, pg_temp.g('plan9')), '1');
select pg_temp.fails_with('a used plan cannot be deleted', format($q$select fee_plan_delete(%L)$q$, pg_temp.g('plan9')), 'already used');
select pg_temp.keep('plan7', $q$select fee_plan_save(null, '{"academic_year":"2026-27","class_label":"7th","items":[{"head":"T1","amount":1,"due_date":"2026-11-01"}]}')::text$q$);
select pg_temp.ok('an unused plan can be deleted', format($q$select fee_plan_delete(%L)$q$, pg_temp.g('plan7')));
-- a new student of Class 8
select pg_temp.keep('st_new', $q$select accounts_save_student(null, '{"name":"Farah","class_label":"8th","board":"CBSE","academic_year":"2026-27","phone":"9800000009"}')::text$q$);
select pg_temp.val_is('a new Class 8 student gets the plan''s fees (not the bus fee, not used yet)',
  format($q$select (r->>'added') || ':' || (r->'heads')::text from fee_plan_apply_student(%L) r$q$, pg_temp.g('st_new')), '2:["Term 1 tuition", "Term 2 tuition"]');
select pg_temp.val_is('and only once', format($q$select r->>'added' from fee_plan_apply_student(%L) r$q$, pg_temp.g('st_new')), '0');
select pg_temp.ok('the student starts using the bus', format($q$select accounts_set_uses_bus(%L, true)$q$, pg_temp.g('st_new')));
select pg_temp.val_is('then the bus fee is added', format($q$select r->'heads'->>0 from fee_plan_apply_student(%L) r$q$, pg_temp.g('st_new')), 'Bus fee');
-- an import with plans
select pg_temp.val_is('an import with plans: the new Class 8 student gets 2 plan fees, the updated one nothing',
  $q$select (r->>'added') || ':' || (r->>'updated') || ':' || (r->>'plan_fee_items_added') from accounts_import_students('[{"admission_no":"A9","name":"Gita","class_label":"8th","board":"CBSE","academic_year":"2026-27","phone":"9800000010"},{"admission_no":"A1","name":"Asha","class_label":"8th"}]'::jsonb, true) r$q$, '1:1:2');
select pg_temp.val_is('an import without plans adds no plan fees',
  $q$select (r->>'added') || ':' || (r->>'plan_fee_items_added') from accounts_import_students('[{"admission_no":"A10","name":"Hari","class_label":"8th","board":"CBSE","phone":"9800000011"}]'::jsonb, false) r$q$, '1:0');
select pg_temp.val_is('the old one-argument import still works', $q$select r->>'added' from accounts_import_students('[{"admission_no":"A11","name":"Ira","class_label":"8th"}]'::jsonb) r$q$, '1');
reset role;

-- ---------- day closing ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.ok('cash 1,000 for S1', format($q$select accounts_record_payment(%L, 1000, null, 'cash', 'Rcpt 11')$q$, :'st1'));
select pg_temp.ok('UPI 2,000 for S2', format($q$select accounts_record_payment(%L, 2000, null, 'upi', '512345678901')$q$, :'st2'));
select pg_temp.ok('cheque 3,000 for S3', format($q$select accounts_record_payment(%L, 3000, null, 'cheque', 'Chq 004512')$q$, :'st3'));
select pg_temp.keep('pay_wrong', format($q$select accounts_record_payment(%L, 500, null, 'cash')::text$q$, :'st3'));
select pg_temp.ok('the 500 cash was typed twice: reversed', format($q$select accounts_reverse_payment(%L, 'Typed twice')$q$, pg_temp.g('pay_wrong')));
select pg_temp.ok('yesterday''s UPI 700 (not today)', format($q$select accounts_record_payment(%L, 700, (%L)::date, 'upi', '512345678999')$q$, :'st1', pg_temp.d(-1)));
reset role;
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.ok('the owner takes cash 400 for S5', format($q$select accounts_record_payment(%L, 400, null, 'cash')$q$, :'st5'));
reset role;
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('today: 4 payments for 6,400 (the reversed one left out)',
  format($q$select (j->'totals'->>'payments') || ':' || (j->'totals'->>'amount') from ledger_day_closing(%L) j$q$, :'inst_i'), '4:6400.00');
select pg_temp.val_is('by mode: cash 1,400, UPI 2,000, cheque 3,000, card 0, bank 0, other 0',
  format($q$select string_agg((m->>'mode') || '=' || (m->>'amount'), ',') from jsonb_array_elements((select ledger_day_closing(%L)->'by_mode')) m$q$, :'inst_i'),
  'cash=1400.00,upi=2000.00,cheque=3000.00,card=0,bank=0,other=0');
select pg_temp.val_is('by person: Kavita 3 for 6,000, the owner 1 for 400',
  format($q$select string_agg((p->>'label') || '=' || (p->>'payments') || '/' || (p->>'amount'), ',') from jsonb_array_elements((select ledger_day_closing(%L)->'by_person')) p$q$, :'inst_i'),
  'Kavita=3/6000.00,Anita (owner)=1/400.00');
select pg_temp.val_is('the cheque is listed for the bank', format($q$select (c->>'reference') || ':' || (c->>'amount') || ':' || (c->>'student') from jsonb_array_elements((select ledger_day_closing(%L)->'cheques')) c$q$, :'inst_i'), 'Chq 004512:3000.00:Chirag');
select pg_temp.val_is('the reversal is shown with its reason', format($q$select (r->>'reason') || ':' || (r->>'amount') from jsonb_array_elements((select ledger_day_closing(%L)->'reversals')) r$q$, :'inst_i'), 'Typed twice:500.00');
select pg_temp.val_is('the payment list has 5 lines, the reversed one marked', format($q$select jsonb_array_length(j->'payments') || ':' || (select count(*) from jsonb_array_elements(j->'payments') p where (p->>'reversed')::boolean) from ledger_day_closing(%L) j$q$, :'inst_i'), '5:1');
select pg_temp.val_is('the day total is what "Collected today" counts', format($q$select ((ledger_day_closing(%L)->'totals'->>'amount')::numeric = (ledger_collected(%L, (%L)::date, (%L)::date)->>'total')::numeric)::text$q$, :'inst_i', :'inst_i', pg_temp.d(0), pg_temp.d(0)), 'true');
select pg_temp.val_is('yesterday: the UPI 700', format($q$select (j->'totals'->>'payments') || ':' || (j->'totals'->>'amount') from ledger_day_closing(%L, (%L)::date) j$q$, :'inst_i', pg_temp.d(-1)), '1:700.00');
reset role;
update institutes set hide_money = true where id = :'inst_i';
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('Accounts sees amounts even with "hide money"', format($q$select ledger_day_closing(%L)->'totals'->>'amount'$q$, :'inst_i'), '6400.00');
reset role;
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.val_is('the owner with "hide money": counts, no amounts', format($q$select (j->'totals'->>'payments') || ':' || coalesce(j->'totals'->>'amount', 'hidden') || ':' || (j->>'money_hidden') from ledger_day_closing(%L) j$q$, :'inst_i'), '4:hidden:true');
select pg_temp.fails_with('no Excel with money then', format($q$select log_money_export(%L, 'day_closing', 5)$q$, :'inst_i'), 'cannot export money');
reset role;
update institutes set hide_money = false where id = :'inst_i';
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('a manager without money: counts, no amounts', format($q$select (j->'totals'->>'payments') || ':' || coalesce(j->'totals'->>'amount', 'hidden') || ':' || coalesce((j->'payments'->0->>'amount'), 'hidden') from ledger_day_closing(%L) j$q$, :'inst_i'), '4:hidden:hidden');
reset role;
select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.fails('another institute cannot read the day closing', format($q$select ledger_day_closing(%L)$q$, :'inst_i'));
reset role;
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.ok('Accounts logs the day closing Excel', format($q$select log_money_export(%L, 'day_closing', 9)$q$, :'inst_i'));
reset role;

-- ---------- balances: fees − discounts − payments, leads = balance ----------
select pg_temp.val_is('every student: balance_total = fees − live discounts − paid',
  $q$select count(*)::text from students s cross join lateral student_balance_rows(s.institute_id, s.id) b
     where b.balance_total <> (select coalesce(sum(amount), 0) from fee_items where student_id = s.id and not is_void)
       - (select coalesce(sum(d.amount), 0) from discounts d join fee_items fi on fi.id = d.fee_item_id where d.student_id = s.id and not d.is_removed and not fi.is_void)
       - (select coalesce(sum(case when reverses_id is null then amount else -amount end), 0) from payments where student_id = s.id)$q$, '0');
select pg_temp.val_is('S2''s lead = the balance due now after the UPI payment', format($q$select (l.amount_due = greatest(b.balance_due_now, 0))::text from leads l cross join lateral student_balance_rows(l.institute_id, l.student_id) b where l.id = %L$q$, :'l_2'), 'true');
select pg_temp.fails_with('fee_items guard: a link cannot be changed', format($q$update fee_items set plan_item_id = null where student_id = %L and plan_item_id is not null$q$, :'st1'), 'cannot be changed');

-- ---------- grants ----------
select pg_temp.val_is('anon cannot apply plans', $q$select has_function_privilege('anon','public.fee_plan_apply(uuid,jsonb,jsonb)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot read the day closing', $q$select has_function_privilege('anon','public.ledger_day_closing(uuid,date)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('nobody runs fee_plan_apply_core from the browser', $q$select has_function_privilege('authenticated','public.fee_plan_apply_core(uuid,public.seats,uuid,jsonb,jsonb,boolean)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('nobody runs discount_give_rows from the browser', $q$select has_function_privilege('authenticated','public.discount_give_rows(uuid,uuid[],text,numeric,text,text,text,text,uuid,uuid,uuid,uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('nobody runs student_balance_rows from the browser', $q$select has_function_privilege('authenticated','public.student_balance_rows(uuid,uuid,date)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('no browser INSERT on fee plans', $q$select has_table_privilege('authenticated','public.fee_plans','INSERT')::text$q$, 'false');
select pg_temp.val_is('RLS is on for every new table', $q$select count(*)::text from pg_class where relname in ('fee_plans','fee_plan_items','fee_plan_rules','fee_plan_applies','discounts') and relrowsecurity$q$, '5');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
