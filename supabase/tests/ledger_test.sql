-- Tests for the fee ledger and the Accounts role in 20261025130000_ledger_open_campaigns.sql: accounts
-- permissions, RLS on students / fee items / payments, money rules (managers without money, hide_money),
-- import, balances with due dates, double-entry protection, reversals, fees campaigns from the ledger,
-- payments closing leads, admissions becoming students, and the two reports. Run with supabase/tests/run.sh.
-- Expect failed = 0 on the last line.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid, mail text default null) returns void language sql as $$
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
create or replace function pg_temp.fails_with(name text, sql text, want text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, position(want in sqlerrm) > 0, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;
-- Today in India and a day relative to it, as 'YYYY-MM-DD'.
create or replace function pg_temp.d(n int) returns text language sql as $$
  select ((now() at time zone 'Asia/Kolkata')::date + n)::text $$;
grant execute on function pg_temp.ok(text, text), pg_temp.fails(text, text), pg_temp.fails_with(text, text, text),
  pg_temp.val_is(text, text, text), pg_temp.d(int) to authenticated, anon;

-- ---------- fixed ids ----------
\set inst_i 'e1000000-0000-0000-0000-000000000001'
\set inst_j 'e2000000-0000-0000-0000-000000000002'
\set u_o  'e3000000-0000-0000-0000-000000000001'
\set u_m  'e3000000-0000-0000-0000-000000000002'
\set u_m2 'e3000000-0000-0000-0000-000000000003'
\set u_ac 'e3000000-0000-0000-0000-000000000004'
\set u_a  'e3000000-0000-0000-0000-000000000005'
\set u_b  'e3000000-0000-0000-0000-000000000006'
\set u_x  'e3000000-0000-0000-0000-000000000007'
\set s_o  'e4000000-0000-0000-0000-000000000001'
\set s_m  'e4000000-0000-0000-0000-000000000002'
\set s_m2 'e4000000-0000-0000-0000-000000000003'
\set s_ac 'e4000000-0000-0000-0000-000000000004'
\set s_a  'e4000000-0000-0000-0000-000000000005'
\set s_b  'e4000000-0000-0000-0000-000000000006'
\set s_x  'e4000000-0000-0000-0000-000000000007'
\set k_adm 'e5000000-0000-0000-0000-000000000001'
\set l_adm 'e6000000-0000-0000-0000-000000000001'

-- ---------- fixtures ----------
-- Inst I: owner O, manager M (no money), manager M2 (money), accounts AC, callers A and B. Inst J: owner X.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@i.test', now()), (:'u_m', 'm@i.test', now()), (:'u_m2', 'm2@i.test', now()), (:'u_ac', 'ac@i.test', now()),
 (:'u_a', 'a@i.test', now()), (:'u_b', 'b@i.test', now()), (:'u_x', 'x@j.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 20), (:'inst_j', 'Inst J', 'active', 5);
insert into seats (id, institute_id, user_id, label, role, status) values (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, can_see_money, status) values
 (:'s_m',  :'inst_i', :'u_m',  'Manager', 'admin', 'manager', false, 'active'),
 (:'s_m2', :'inst_i', :'u_m2', 'Manager money', 'admin', 'manager', true, 'active'),
 (:'s_x',  :'inst_j', :'u_x',  'Owner J', 'admin', 'owner', false, 'active');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_ac', :'inst_i', :'u_ac', 'Accounts', 'accounts', 'active'),
 (:'s_a',  :'inst_i', :'u_a',  'Caller A', 'rep', 'active'),
 (:'s_b',  :'inst_i', :'u_b',  'Caller B', 'rep', 'active');
-- An admission campaign with the institute's own "Admission confirmed" result, and one lead for caller A.
insert into call_type_results (call_type_id, institute_id, key, label, counts_as_good, legacy_outcome, sort_order)
  values ((select id from call_types where key='admission' and institute_id is null), :'inst_i', 'admission_done', 'Admission confirmed', true, 'won', 500);
insert into campaigns (id, institute_id, name, call_type_id, status) values
 (:'k_adm', :'inst_i', 'Admissions', (select id from call_types where key='admission' and institute_id is null), 'running');
insert into leads (id, institute_id, campaign_id, name, phone, extra, assigned_seat_id) values
 (:'l_adm', :'inst_i', :'k_adm', 'Mrs Rao', '9811111111', '{"Student name": "Anu", "Class": "5th", "Board": "cbse"}', :'s_a');

-- ---------- accounts role ----------
select pg_temp.val_is('an accounts seat gets admin_kind accounts', format($q$select admin_kind from seats where id=%L$q$, :'s_ac'), 'accounts');
select pg_temp.val_is('an accounts seat reads as access_role accounts', format($q$select access_role from seats where id=%L$q$, :'s_ac'), 'accounts');
select pg_temp.val_is('owner still reads as owner', format($q$select access_role from seats where id=%L$q$, :'s_o'), 'owner');
select pg_temp.val_is('caller still reads as caller', format($q$select access_role from seats where id=%L$q$, :'s_a'), 'caller');
select pg_temp.val_is('an admin seat never keeps admin_kind accounts', format($q$with i as (insert into seats (institute_id, label, role, admin_kind, status) values (%L,'Z','admin','accounts','revoked') returning admin_kind) select admin_kind from i$q$, :'inst_i'), 'manager');
select pg_temp.val_is('an accounts seat never keeps can_see_money', format($q$with u as (update seats set can_see_money=true where id=%L returning can_see_money) select can_see_money::text from u$q$, :'s_ac'), 'false');
select pg_temp.fails('admin_kind accounts on a caller seat is refused', format($q$update seats set role='rep', admin_kind='accounts' where id=%L returning (select 1/0 where false)$q$, :'s_ac'));

select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('accounts is not an admin', format($q$select is_admin_of(%L)::text$q$, :'inst_i'), 'false');
select pg_temp.val_is('accounts is accounts', format($q$select is_accounts_of(%L)::text$q$, :'inst_i'), 'true');
select pg_temp.val_is('accounts can see money', format($q$select can_see_money(%L)::text$q$, :'inst_i'), 'true');
select pg_temp.val_is('accounts can manage the ledger', format($q$select can_manage_ledger(%L)::text$q$, :'inst_i'), 'true');
select pg_temp.val_is('my_trial_status: accounts access role', $q$select my_trial_status()->>'access_role'$q$, 'accounts');
select pg_temp.val_is('my_trial_status: accounts can see money', $q$select my_trial_status()->>'can_see_money'$q$, 'true');
select pg_temp.fails('accounts cannot invite seats', format($q$select invite_seat(%L,'new@i.test','New','rep')$q$, :'inst_i'));
select pg_temp.fails('accounts cannot change roles', format($q$select admin_set_seat_role(%L,'manager')$q$, :'s_a'));
select pg_temp.fails('accounts cannot revoke seats', format($q$select revoke_seat(%L)$q$, :'s_a'));
select pg_temp.fails('accounts cannot create a normal campaign', $q$select admin_create_campaign('Mine', (select id from call_types where key='sales'))$q$);
select pg_temp.fails('accounts cannot change a campaign', format($q$select admin_update_campaign(%L, p_status => 'paused')$q$, :'k_adm'));
select pg_temp.fails('accounts cannot set campaign members', format($q$select admin_set_campaign_members(%L, array[%L]::uuid[])$q$, :'k_adm', :'s_a'));
select pg_temp.fails('accounts cannot manage call types', $q$select admin_upsert_call_type(null, 'Mine')$q$);
select pg_temp.fails('accounts cannot read the admin seat list', format($q$select * from admin_seat_list(%L)$q$, :'inst_i'));
select pg_temp.fails('accounts cannot set "creates a student"', $q$select admin_set_result_creates_student((select id from call_type_results where key='admission_done'), false)$q$);
reset role;

select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.fails_with('a manager cannot invite an accounts seat', format($q$select invite_seat(%L,'acc2@i.test','Acc 2','accounts')$q$, :'inst_i'), 'owner');
select pg_temp.fails('a manager cannot make a seat accounts', format($q$select admin_set_seat_role(%L,'accounts')$q$, :'s_b'));
reset role;

select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.ok('the owner invites an accounts seat', format($q$select invite_seat(%L,'acc2@i.test','Acc 2','accounts')$q$, :'inst_i'));
select pg_temp.val_is('the invited seat is accounts', $q$select access_role from seats where invite_email='acc2@i.test'$q$, 'accounts');
select pg_temp.ok('the owner makes caller B accounts', format($q$select admin_set_seat_role(%L,'accounts')$q$, :'s_b'));
select pg_temp.val_is('B is accounts', format($q$select access_role from seats where id=%L$q$, :'s_b'), 'accounts');
select pg_temp.ok('and back to caller', format($q$select admin_set_seat_role(%L,'caller')$q$, :'s_b'));
select pg_temp.val_is('B is a caller again', format($q$select access_role || ':' || coalesce(admin_kind,'null') from seats where id=%L$q$, :'s_b'), 'caller:null');
select pg_temp.val_is('audit: role set to accounts', format($q$select count(*)::text from audit_log where action='seat.role_set' and target=%L$q$, :'s_b' || ':accounts'), '1');
select pg_temp.fails_with('an unknown role is refused', format($q$select admin_set_seat_role(%L,'boss')$q$, :'s_b'), 'role must be');
reset role;

-- ---------- import ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('import: 4 added, 3 skipped, 5 fee items, 1 opening payment',
  format($q$select (r->>'added')||':'||(r->>'updated')||':'||(r->>'skipped')||':'||(r->>'fee_items_added')||':'||(r->>'payments_added')
            from accounts_import_students(%L::jsonb) r$q$, json_build_array(
    json_build_object('admission_no','ADM1','name','Riya Shah','class','8th','board','cbse','parent_name','Mr Shah','phone','98000 00001',
      'academic_year','2026-27','paid_so_far','4,000',
      'fees', json_build_array(json_build_object('head','Term 1','amount',10000,'due_date',pg_temp.d(-30)),
                               json_build_object('head','Term 2','amount','12000','due_date',pg_temp.d(30)))),
    json_build_object('admission_no','ADM2','name','Kabir','class_label','8th','board','CBSE','phone','9800000002',
      'fees', json_build_array(json_build_object('head','Term 1','amount',8000,'due_date',pg_temp.d(-5)))),
    json_build_object('admission_no','ADM3','name','Tara','class_label','8th','board','ICSE','phone','9800000003',
      'fees', json_build_array(json_build_object('head','Term 1','amount',5000,'due_date',pg_temp.d(-5)))),
    json_build_object('admission_no','ADM4','name','Dev Shah','class_label','8th','board','CBSE','phone','+919800000001',
      'fees', json_build_array(json_build_object('head','Term 1','amount',3000,'due_date',pg_temp.d(-1)))),
    json_build_object('admission_no','ADM5','name',''),
    json_build_object('admission_no','ADM6','name','Bad Phone','phone','12345'),
    json_build_object('admission_no','adm2','name','Kabir again')
  )::text), '4:0:3:5:1');
select pg_temp.val_is('import: skip reasons', format($q$select string_agg(x->>'reason', ', ' order by (x->>'row')::int)
    from accounts_import_students(%L::jsonb) r, jsonb_array_elements(r->'skipped_rows') x$q$,
  json_build_array(json_build_object('name',''), json_build_object('name','X','board','Kerala'),
                   json_build_object('name','Y','fees', json_build_array(json_build_object('head','T','amount',-5,'due_date',pg_temp.d(1)))))::text),
  'no name, unknown board, bad fee item');
select pg_temp.val_is('re-import updates by admission number, same fee not added twice, opening payment once',
  format($q$select (r->>'added')||':'||(r->>'updated')||':'||(r->>'fee_items_added')||':'||(r->>'payments_added') from accounts_import_students(%L::jsonb) r$q$,
  json_build_array(json_build_object('admission_no','adm2','name','Kabir Mehta','section','B',
                     'fees', json_build_array(json_build_object('head','term 1','amount',8000,'due_date',pg_temp.d(-5)))),
                   json_build_object('admission_no','ADM1','name','Riya Shah','paid_so_far',4000))::text), '0:2:0:0');
select pg_temp.val_is('the update kept the class and set the section', $q$select name||':'||class_label||':'||section from students where admission_no='ADM2'$q$, 'Kabir Mehta:8th:B');
select pg_temp.val_is('phones are normalised', $q$select phone from students where admission_no='ADM1'$q$, '+919800000001');
select pg_temp.val_is('board is normalised', $q$select board from students where admission_no='ADM1'$q$, 'CBSE');
select pg_temp.val_is('source is import', $q$select string_agg(distinct source, ',') from students$q$, 'import');

-- ---------- balances ----------
select pg_temp.val_is('Riya: total 22000, due to date 10000, paid 4000, due now 6000, total balance 18000',
  $q$select total_fees||':'||total_due_to_date||':'||paid||':'||balance_due_now||':'||balance_total from accounts_students('{"search":"riya"}')$q$,
  '22000.00:10000.00:4000.00:6000.00:18000.00');
select pg_temp.val_is('Riya: last payment is the opening import', $q$select last_payment_amount||':'||last_payment_mode from accounts_students('{"search":"ADM1"}')$q$, '4000.00:other');
select pg_temp.val_is('filter: 8th CBSE has 3 students', $q$select count(*)::text from accounts_students('{"class_label":"8TH","board":"cbse"}')$q$, '3');
select pg_temp.val_is('filter: only due', $q$select string_agg(name, ',' order by name) from accounts_students('{"only_due":true}')$q$, 'Dev Shah,Kabir Mehta,Riya Shah,Tara');
select pg_temp.val_is('search by phone digits', $q$select count(*)::text from accounts_students('{"search":"98000 00003"}')$q$, '1');
select pg_temp.val_is('total_rows', $q$select max(total_rows)::text from accounts_students('{"limit":2}')$q$, '4');

-- ---------- payments, double entry, reversal ----------
select pg_temp.ok('accounts records a UPI payment for Kabir', $q$select accounts_record_payment((select id from students where admission_no='ADM2'), 3000, null, 'upi', 'UTR001', 'Term 1 part')$q$);
select pg_temp.fails_with('the same UPI reference again is refused', $q$select accounts_record_payment((select id from students where admission_no='ADM3'), 3000, null, 'UPI', 'utr001')$q$, 'already recorded');
select pg_temp.ok('the same reference in cash is a different payment', $q$select accounts_record_payment((select id from students where admission_no='ADM3'), 100, null, 'cash', 'UTR001')$q$);
select pg_temp.fails_with('UPI needs a reference', $q$select accounts_record_payment((select id from students where admission_no='ADM2'), 10, null, 'upi', null)$q$, 'reference');
select pg_temp.fails_with('a future payment date is refused', format($q$select accounts_record_payment((select id from students where admission_no='ADM2'), 10, %L, 'cash')$q$, pg_temp.d(2)), 'future');
select pg_temp.fails_with('a zero amount is refused', $q$select accounts_record_payment((select id from students where admission_no='ADM2'), 0, null, 'cash')$q$, 'amount');
select pg_temp.fails_with('an unknown mode is refused', $q$select accounts_record_payment((select id from students where admission_no='ADM2'), 10, null, 'crypto')$q$, 'mode');
select pg_temp.val_is('Kabir due now 5000', $q$select balance_due_now::text from accounts_students('{"search":"ADM2"}')$q$, '5000.00');
select pg_temp.ok('accounts reverses the UPI payment', $q$select accounts_reverse_payment((select id from payments where reference='UTR001' and mode='upi'), 'Wrong student')$q$);
select pg_temp.val_is('reversal: Kabir due now back to 8000', $q$select balance_due_now::text from accounts_students('{"search":"ADM2"}')$q$, '8000.00');
select pg_temp.val_is('reversal is a new row with the same amount', $q$select count(*)::text from payments p join payments o on o.id = p.reverses_id where o.reference='UTR001' and o.mode='upi'$q$, '1');
select pg_temp.fails_with('a payment cannot be reversed twice', $q$select accounts_reverse_payment((select id from payments where reference='UTR001' and mode='upi'), 'Again')$q$, 'already reversed');
select pg_temp.fails_with('a reversal cannot be reversed', $q$select accounts_reverse_payment((select id from payments where reverses_id is not null limit 1), 'Undo')$q$, 'cannot be reversed');
select pg_temp.fails_with('a reversal needs a reason', $q$select accounts_reverse_payment((select id from payments where reference='UTR001' and mode='cash'), ' ')$q$, 'reason');
select pg_temp.ok('after the reversal the reference can be recorded again', $q$select accounts_record_payment((select id from students where admission_no='ADM2'), 3000, null, 'upi', 'UTR001')$q$);
select pg_temp.val_is('Kabir: paid 3000, due now 5000', $q$select paid||':'||balance_due_now from accounts_students('{"search":"ADM2"}')$q$, '3000.00:5000.00');
select pg_temp.val_is('Kabir: last payment is the live UPI one', $q$select last_payment_amount||':'||last_payment_mode from accounts_students('{"search":"ADM2"}')$q$, '3000.00:upi');
select pg_temp.fails('the browser cannot insert a payment', format($q$insert into payments (institute_id, student_id, amount, paid_on, mode) values (%L, (select id from students limit 1), 1, current_date, 'cash')$q$, :'inst_i'));
select pg_temp.fails('the browser cannot read payment amounts', $q$select amount from payments$q$);
select pg_temp.val_is('accounts reads payment rows (no amounts) of the institute', $q$select count(*)::text from payments$q$, '5');
select pg_temp.ok('fee item added', $q$select accounts_add_fee_item((select id from students where admission_no='ADM3'), 'Lab', 700, current_date + 100)$q$);
select pg_temp.ok('fee item voided', $q$select accounts_void_fee_item((select id from fee_items where head='Term 1' and student_id=(select id from students where admission_no='ADM3')), 'Scholarship')$q$);
select pg_temp.val_is('Tara: void item gone from the balance, future item not due yet', $q$select total_fees||':'||total_due_to_date||':'||balance_due_now from accounts_students('{"search":"ADM3"}')$q$, '700.00:0.00:-100.00');
select pg_temp.fails_with('a void item cannot be voided again', $q$select accounts_void_fee_item((select id from fee_items where is_void), 'Again')$q$, 'already void');
select pg_temp.ok('a student added by hand', $q$select accounts_save_student(null, '{"name":"Hand Made","class_label":"9th","board":"State board","phone":"9800000009"}')$q$);
select pg_temp.val_is('manual student', $q$select source||':'||board from students where name='Hand Made'$q$, 'manual:State');
select pg_temp.fails_with('a second student with the same admission no is refused', $q$select accounts_save_student(null, '{"name":"Dup","admission_no":"adm1"}')$q$, 'admission number');
reset role;

-- History cannot be rewritten, not even by the table owner.
select pg_temp.val_is('audit: students.imported', $q$select count(*)::text from audit_log where action='students.imported'$q$, '3');
select pg_temp.fails_with('a payment cannot be updated', $q$update payments set amount = 1$q$, 'cannot be changed');
select pg_temp.fails_with('a fee item amount cannot be updated', $q$update fee_items set amount = 1 where not is_void$q$, 'cannot be changed');
select pg_temp.fails_with('a void fee item cannot be un-voided', $q$update fee_items set is_void = false where is_void$q$, 'cannot be changed');

-- ---------- RLS and money for other people ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('a caller reads no students', $q$select count(*)::text from students$q$, '0');
select pg_temp.val_is('a caller reads no payments', $q$select count(*)::text from payments$q$, '0');
select pg_temp.val_is('a caller reads no fee items', $q$select count(*)::text from fee_items$q$, '0');
select pg_temp.fails('a caller cannot list students', $q$select * from accounts_students()$q$);
select pg_temp.fails('a caller cannot record a payment', $q$select accounts_record_payment((select id from students limit 1), 1, null, 'cash')$q$);
select pg_temp.fails('a caller cannot import', $q$select accounts_import_students('[]')$q$);
select pg_temp.fails('a caller cannot see collections', format($q$select ledger_collected(%L, current_date - 1, current_date)$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('manager without money: rows, no amounts', $q$select count(*)||':'||count(balance_due_now)||':'||bool_and(money_hidden) from accounts_students()$q$, '5:0:true');
select pg_temp.val_is('manager without money: last payment date still shown', $q$select (last_payment_on is not null)::text from accounts_students('{"search":"ADM2"}')$q$, 'true');
select pg_temp.val_is('manager without money: detail has no amounts', $q$select (d->'balance'->>'balance_due_now') is null and (d->'payments'->0->>'amount') is null and (d->>'money_hidden')::boolean from accounts_student_detail((select id from students where admission_no='ADM2')) d$q$, 'true');
select pg_temp.fails('a manager cannot record payments', $q$select accounts_record_payment((select id from students where admission_no='ADM2'), 1, null, 'cash')$q$);
select pg_temp.fails('a manager without money cannot make a fees campaign from the ledger', $q$select accounts_create_fees_campaign('X')$q$);
select pg_temp.val_is('manager without money: collections give counts only', format($q$select (r->>'payments')||':'||coalesce(r->>'total','null') from ledger_collected(%L, current_date - 40, current_date) r$q$, :'inst_i'), '2:null');
select pg_temp.val_is('manager reads student rows directly', $q$select count(*)::text from students$q$, '5');
reset role;

select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.val_is('manager with money sees amounts', $q$select balance_due_now::text from accounts_students('{"search":"ADM2"}')$q$, '5000.00');
reset role;

select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.ok('owner hides money everywhere', $q$select admin_set_hide_money(true)$q$);
select pg_temp.val_is('hide_money: owner sees no amounts', $q$select coalesce(balance_due_now::text, 'hidden') from accounts_students('{"search":"ADM2"}')$q$, 'hidden');
reset role;
select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.val_is('hide_money: manager with money sees no amounts', $q$select coalesce(balance_due_now::text, 'hidden') from accounts_students('{"search":"ADM2"}')$q$, 'hidden');
reset role;
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('hide_money: accounts still sees amounts', $q$select balance_due_now::text from accounts_students('{"search":"ADM2"}')$q$, '5000.00');
reset role;
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.ok('owner shows money again', $q$select admin_set_hide_money(false)$q$);
select pg_temp.ok('the owner can record a payment too', $q$select accounts_record_payment((select id from students where admission_no='ADM3'), 100, null, 'cash', null, 'Owner at the desk')$q$);
select pg_temp.ok('and reverse it', $q$select accounts_reverse_payment((select id from payments where note='Owner at the desk'), 'Test')$q$);
reset role;

select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.fails_with('another institute cannot read the student', $q$select accounts_student_detail((select id from students where admission_no='ADM1'))$q$, 'student not found');
select pg_temp.val_is('another institute lists no students', $q$select count(*)::text from accounts_students()$q$, '0');
select pg_temp.fails('another institute cannot record a payment', $q$select accounts_record_payment((select id from students where admission_no='ADM1'), 1, null, 'cash')$q$);
reset role;

-- ---------- fees campaign from the ledger ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.ok('accounts makes "8th CBSE fees" from the ledger', $q$select accounts_create_fees_campaign('8th CBSE fees', '8th', 'CBSE', null, 0)$q$);
select pg_temp.val_is('campaign: fees, open, next_free, running, tags',
  $q$select t.key||':'||c.open_to_all||':'||c.share_mode||':'||c.status||':'||c.class_label||':'||c.board from campaigns c join call_types t on t.id=c.call_type_id where c.name='8th CBSE fees'$q$,
  'fees:true:next_free:running:8th:CBSE');
select pg_temp.val_is('accounts does not read campaign leads directly', $q$select count(*)::text from leads$q$, '0');
reset role;
select pg_temp.val_is('one lead per due student; the sibling with the same phone is folded',
  $q$select count(*)::text from leads l join campaigns c on c.id=l.campaign_id where c.name='8th CBSE fees'$q$, '2');
select pg_temp.val_is('audit: from ledger with counts', $q$select split_part(target, ':', 2)||':'||split_part(target, ':', 3)||':'||split_part(target, ':', 4) from audit_log where action='fees_campaign.from_ledger'$q$, '2:0:1');
select pg_temp.val_is('lead amounts are the balances due now', $q$select string_agg(l.name||'='||l.amount_due, ',' order by l.name) from leads l join campaigns c on c.id=l.campaign_id where c.name='8th CBSE fees'$q$, 'Kabir Mehta=5000.00,Mr Shah=6000.00');
select pg_temp.val_is('leads carry the student and the extra fields', $q$select (l.student_id = s.id)::text||':'||(l.extra->>'student')||':'||(l.extra->>'admission_no') from leads l join students s on s.admission_no='ADM1' join campaigns c on c.id=l.campaign_id where c.name='8th CBSE fees' and l.name='Mr Shah'$q$, 'true:Riya Shah:ADM1');
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.ok('a restricted campaign due by a later date', format($q$select accounts_create_fees_campaign('Year fees', '8th', 'CBSE', %L, 5000, null, false)$q$, pg_temp.d(40)));
reset role;
select pg_temp.val_is('restricted: draft, equal, due-by saved', format($q$select status||':'||share_mode||':'||(fees_due_by = %L::date) from campaigns where name='Year fees'$q$, pg_temp.d(40)), 'draft:equal:true');
select pg_temp.val_is('due by a later date counts Term 2; min due 5000 leaves Kabir (exactly 5000) and Dev out', $q$select string_agg(l.name||'='||l.amount_due, ',' order by l.name) from leads l join campaigns c on c.id=l.campaign_id where c.name='Year fees'$q$, 'Mr Shah=18000.00');

-- Callers take the leads (open campaign, not members).
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('caller A takes the first lead in sheet order (class, section, name)', $q$select name from next_free_lead((select id from campaigns where name='8th CBSE fees'))$q$, 'Kabir Mehta');
select pg_temp.val_is('caller A sees only their lead of the campaign', $q$select count(*)::text from leads where campaign_id=(select id from campaigns where name='8th CBSE fees')$q$, '1');
select pg_temp.val_is('lead_ledger: the caller sees the balance and last payment of their lead', $q$select balance_due_now||':'||last_payment_mode||':'||money_hidden from lead_ledger((select id from leads where name='Kabir Mehta' and campaign_id=(select id from campaigns where name='8th CBSE fees')))$q$, '5000.00:upi:false');
select pg_temp.fails('lead_ledger: not for a lead of someone else', $q$select * from lead_ledger((select id from leads where name='Mr Shah' and campaign_id=(select id from campaigns where name='Year fees')))$q$);
reset role;
select pg_temp.as_user(:'u_b', 'b@i.test');
set role authenticated;
select pg_temp.val_is('caller B takes Riya''s lead', $q$select name from next_free_lead((select id from campaigns where name='8th CBSE fees'))$q$, 'Mr Shah');
select pg_temp.ok('caller B saves a promise of 5000 for tomorrow', format($q$select save_call_result('b-p1', (select id from leads where name='Mr Shah' and campaign_id=(select id from campaigns where name='8th CBSE fees')), 'will_pay_on', %L::date, 5000)$q$, pg_temp.d(1)));
reset role;

-- A payment updates the open leads and closes them when nothing is due.
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.ok('Riya pays 1000 in cash', $q$select accounts_record_payment((select id from students where admission_no='ADM1'), 1000, null, 'cash')$q$);
reset role;
select pg_temp.val_is('both of Riya''s leads now show the new balance', $q$select string_agg(c.name||'='||l.amount_due||':'||l.status, ',' order by c.name) from leads l join campaigns c on c.id=l.campaign_id where l.name='Mr Shah'$q$, '8th CBSE fees=5000.00:promised,Year fees=17000.00:new');
select pg_temp.as_user(:'u_b', 'b@i.test');
set role authenticated;
select pg_temp.val_is('lead_money of the caller follows the ledger', $q$select amount_due::text from lead_money((select id from leads where name='Mr Shah' and campaign_id=(select id from campaigns where name='8th CBSE fees')))$q$, '5000.00');
reset role;
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.ok('Riya pays 5000 by UPI', $q$select accounts_record_payment((select id from students where admission_no='ADM1'), 5000, null, 'upi', 'UTR777')$q$);
select pg_temp.ok('Kabir pays 5000 by bank', $q$select accounts_record_payment((select id from students where admission_no='ADM2'), 5000, null, 'bank', 'NEFT1')$q$);
reset role;
select pg_temp.val_is('nothing due now: the lead is done with no next call', $q$select l.status||':'||l.amount_due||':'||coalesce(l.next_call_at::text,'none') from leads l join campaigns c on c.id=l.campaign_id where c.name='8th CBSE fees' and l.name='Kabir Mehta'$q$, 'done:0.00:none');
select pg_temp.val_is('Riya''s fees lead is done as well', $q$select l.status from leads l join campaigns c on c.id=l.campaign_id where c.name='8th CBSE fees' and l.name='Mr Shah'$q$, 'done');
select pg_temp.val_is('the due-by campaign keeps calling for Term 2', $q$select l.status||':'||l.amount_due from leads l join campaigns c on c.id=l.campaign_id where c.name='Year fees' and l.name='Mr Shah'$q$, 'new:12000.00');
select pg_temp.val_is('the opening import is flagged', $q$select count(*)::text from payments where opening$q$, '1');
select pg_temp.val_is('audit: lead.closed_paid for each closed lead', $q$select count(*)::text from audit_log where action='lead.closed_paid'$q$, '2');
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('the closed lead leaves the caller''s queue', $q$select jsonb_array_length(my_call_queue((select id from campaigns where name='8th CBSE fees'))->'leads')::text$q$, '0');
reset role;

-- ---------- reports ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('promises vs payments: the promise is kept', $q$select (r->>'promises')||':'||(r->>'kept')||':'||(r->>'promised_amount')||':'||(r->>'paid_amount')||':'||(r->'rows'->0->>'state') from promises_vs_payments((select id from campaigns where name='8th CBSE fees')) r$q$, '1:1:5000.00:5000.00:kept');
select pg_temp.val_is('collected this week by mode (reversed payments and the opening import left out)', format($q$select string_agg((x->>'mode')||'='||(x->>'payments')||'/'||(x->>'amount'), ',' order by x->>'mode') from ledger_collected(%L, current_date - 7, current_date) r, jsonb_array_elements(r->'by_mode') x$q$, :'inst_i'), 'bank=1/5000.00,cash=2/1100.00,upi=2/8000.00');
select pg_temp.val_is('collected for one campaign', format($q$select (r->>'payments')||':'||(r->>'total')||':'||(r->>'reversed') from ledger_collected(%L, current_date - 40, current_date, (select id from campaigns where name='8th CBSE fees')) r$q$, :'inst_i'), '4:14000.00:1');
select pg_temp.fails_with('a report covers at most 400 days', format($q$select ledger_collected(%L, current_date - 500, current_date)$q$, :'inst_i'), '400 days');
select pg_temp.val_is('student detail: fee items, payments and calls', $q$select jsonb_array_length(d->'fee_items')||':'||jsonb_array_length(d->'payments')||':'||jsonb_array_length(d->'calls')||':'||(d->'calls'->0->>'result_key') from accounts_student_detail((select id from students where admission_no='ADM1')) d$q$, '2:3:1:will_pay_on');
reset role;
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('promises vs payments without money: counts only', $q$select (r->>'kept')||':'||coalesce(r->>'promised_amount','null')||':'||coalesce(r->'rows'->0->>'promised_amount','null') from promises_vs_payments((select id from campaigns where name='8th CBSE fees')) r$q$, '1:null:null');
reset role;

-- ---------- admission becomes a student ----------
select pg_temp.val_is('the institute''s admission_done result creates students by default', $q$select creates_student::text from call_type_results where key='admission_done'$q$, 'true');
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('saving Admission confirmed returns the new student', format($q$select (save_call_result('a-adm1', %L, 'admission_done')->>'student_id') is not null$q$, :'l_adm'), 'true');
select pg_temp.ok('saving it again does not add a second student', format($q$select save_call_result('a-adm2', %L, 'admission_done')$q$, :'l_adm'));
reset role;
select pg_temp.val_is('student from the admission: name, parent, class, board, phone, source', format($q$select name||':'||parent_name||':'||class_label||':'||board||':'||phone||':'||source from students where admission_lead_id=%L$q$, :'l_adm'), 'Anu:Mrs Rao:5th:CBSE:+919811111111:admission');
select pg_temp.val_is('one student per admission lead', format($q$select count(*)::text from students where admission_lead_id=%L$q$, :'l_adm'), '1');
select pg_temp.val_is('the lead points at its student', format($q$select (student_id is not null)::text from leads where id=%L$q$, :'l_adm'), 'true');
select pg_temp.val_is('audit: student.added_from_admission', $q$select count(*)::text from audit_log where action='student.added_from_admission'$q$, '1');
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.ok('the owner turns "creates a student" off', $q$select admin_set_result_creates_student((select id from call_type_results where key='admission_done'), false)$q$);
select pg_temp.fails('built-in results are not changed', $q$select admin_set_result_creates_student((select id from call_type_results where key='visit_booked' and institute_id is null), true)$q$);
reset role;
select pg_temp.val_is('creates_student is off', $q$select creates_student::text from call_type_results where key='admission_done'$q$, 'false');

-- ---------- grants ----------
select pg_temp.val_is('no browser SELECT on payments.amount', $q$select has_column_privilege('authenticated','public.payments','amount','SELECT')::text$q$, 'false');
select pg_temp.val_is('no browser SELECT on fee_items.amount', $q$select has_column_privilege('authenticated','public.fee_items','amount','SELECT')::text$q$, 'false');
select pg_temp.val_is('no browser INSERT on students', $q$select has_table_privilege('authenticated','public.students','INSERT')::text$q$, 'false');
select pg_temp.val_is('no browser UPDATE on payments', $q$select has_table_privilege('authenticated','public.payments','UPDATE')::text$q$, 'false');
select pg_temp.val_is('browser reads leads.student_id', $q$select has_column_privilege('authenticated','public.leads','student_id','SELECT')::text$q$, 'true');
select pg_temp.val_is('anon cannot record payments', $q$select has_function_privilege('anon','public.accounts_record_payment(uuid,numeric,date,text,text,text)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('nobody runs ledger_sync_student from the browser', $q$select has_function_privilege('authenticated','public.ledger_sync_student(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('nobody runs student_balance_rows from the browser', $q$select has_function_privilege('authenticated','public.student_balance_rows(uuid,uuid,date)','EXECUTE')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
