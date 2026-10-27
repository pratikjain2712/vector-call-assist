-- Tests for 20261027100000_centres_batches.sql: centres and batches, a person limited to some centres (in the
-- functions and in RLS), the p_centre / p_batch filters, the Collect fee functions (search, student, pending,
-- collected_by_me), import and add with a centre, Autopilot per centre, and an institute without centres
-- that behaves as before. Run with supabase/tests/run.sh. Expect failed = 0 on the last line.
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
create or replace function pg_temp.d(n int) returns text language sql as $$
  select ((now() at time zone 'Asia/Kolkata')::date + n)::text $$;
grant execute on function pg_temp.ok(text, text), pg_temp.fails_with(text, text, text), pg_temp.val_is(text, text, text),
  pg_temp.keep(text, text), pg_temp.g(text), pg_temp.d(int) to authenticated, anon;

\set inst_i 'c1000000-0000-0000-0000-000000000001'
\set inst_j 'c2000000-0000-0000-0000-000000000002'
\set u_o  'c3000000-0000-0000-0000-000000000001'
\set u_ac 'c3000000-0000-0000-0000-000000000002'
\set u_mb 'c3000000-0000-0000-0000-000000000003'
\set u_r  'c3000000-0000-0000-0000-000000000004'
\set u_x  'c3000000-0000-0000-0000-000000000005'
\set u_xa 'c3000000-0000-0000-0000-000000000006'
\set s_o  'c4000000-0000-0000-0000-000000000001'
\set s_ac 'c4000000-0000-0000-0000-000000000002'
\set s_mb 'c4000000-0000-0000-0000-000000000003'
\set s_r  'c4000000-0000-0000-0000-000000000004'
\set s_x  'c4000000-0000-0000-0000-000000000005'
\set s_xa 'c4000000-0000-0000-0000-000000000006'
\set st1 'c5000000-0000-0000-0000-000000000001'
\set st2 'c5000000-0000-0000-0000-000000000002'
\set st3 'c5000000-0000-0000-0000-000000000003'
\set st4 'c5000000-0000-0000-0000-000000000004'
\set stj 'c5000000-0000-0000-0000-000000000009'

-- ---------- fixtures ----------
-- Inst I: owner O, Accounts AC (to be limited to Andheri), manager MB with money (to be limited to Borivali),
-- caller R. Inst J (no centres): owner X and Accounts XA, one student.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@i.test', now()), (:'u_ac', 'ac@i.test', now()), (:'u_mb', 'mb@i.test', now()), (:'u_r', 'r@i.test', now()),
 (:'u_x', 'x@j.test', now()), (:'u_xa', 'xa@j.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 20), (:'inst_j', 'Inst J', 'active', 5);
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active'),
 (:'s_x', :'inst_j', :'u_x', 'Owner J', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, can_see_money, status) values
 (:'s_mb', :'inst_i', :'u_mb', 'Manager B', 'admin', 'manager', true, 'active');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_ac', :'inst_i', :'u_ac', 'Kavita', 'accounts', 'active'),
 (:'s_r',  :'inst_i', :'u_r',  'Ravi', 'rep', 'active'),
 (:'s_xa', :'inst_j', :'u_xa', 'Accounts J', 'accounts', 'active');

-- ---------- centres and batches: who may change them ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.fails_with('Accounts cannot add a centre', $q$select admin_save_centre(null, 'Andheri', 'AND')$q$, 'only the owner');
select pg_temp.val_is('no centres yet: has_centres false', $q$select (centres_list() ->> 'has_centres')$q$, 'false');
reset role;
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.keep('cA', $q$select admin_save_centre(null, 'Andheri', 'and')::text$q$);
select pg_temp.keep('cB', $q$select admin_save_centre(null, 'Borivali', 'BOR')::text$q$);
select pg_temp.fails_with('a second centre with the same name is refused', $q$select admin_save_centre(null, 'ANDHERI')$q$, 'already exists');
select pg_temp.fails_with('a bad short code is refused', $q$select admin_save_centre(null, 'Thane', 'TH-1')$q$, 'short code');
select pg_temp.val_is('the short code is kept in capitals', format($q$select short_code from centres where id = %L$q$, pg_temp.g('cA')), 'AND');
select pg_temp.keep('bM', format($q$select admin_save_batch(null, jsonb_build_object('name', '8th SB Morning', 'centre_id', %L, 'class_label', '8th', 'board', 'state board', 'academic_year', '2026-27', 'timing', '7–9 am'))::text$q$, pg_temp.g('cA')));
select pg_temp.keep('bE', format($q$select admin_save_batch(null, jsonb_build_object('name', '8th SB Evening', 'centre_id', 'Borivali', 'class_label', '8th', 'board', 'State'))::text$q$));
select pg_temp.keep('bAll', $q$select admin_save_batch(null, '{"name":"10th CBSE A","class_label":"10th","board":"CBSE"}')::text$q$);
select pg_temp.val_is('a batch takes a centre by name and the board as stored', format($q$select (centre_id = %L and board = 'State')::text from batches where id = %L$q$, pg_temp.g('cB'), pg_temp.g('bE')), 'true');
select pg_temp.fails_with('the same batch name twice in a centre is refused', format($q$select admin_save_batch(null, jsonb_build_object('name', '8th sb morning', 'centre_id', %L))$q$, pg_temp.g('cA')), 'already exists');
select pg_temp.ok('the same batch name in another centre is fine', format($q$select admin_save_batch(null, jsonb_build_object('name', '8th SB Morning', 'centre_id', %L))$q$, pg_temp.g('cB')));
select pg_temp.val_is('centres_list: 2 centres, 4 batches, has_centres', $q$select (jsonb_array_length(centres_list() -> 'centres') || ':' || jsonb_array_length(centres_list() -> 'batches') || ':' || (centres_list() ->> 'has_centres'))$q$, '2:4:true');
select pg_temp.fails_with('an owner seat cannot be limited to a centre', format($q$select admin_set_seat_centres(%L, array[%L]::uuid[])$q$, :'s_o', pg_temp.g('cA')), 'every centre');
select pg_temp.ok('Kavita (Accounts) works in Andheri only', format($q$select admin_set_seat_centres(%L, array[%L]::uuid[])$q$, :'s_ac', pg_temp.g('cA')));
select pg_temp.ok('the manager works in Borivali only', format($q$select admin_set_seat_centres(%L, array[%L]::uuid[])$q$, :'s_mb', pg_temp.g('cB')));
select pg_temp.fails_with('a centre of another institute is refused', format($q$select admin_set_seat_centres(%L, array[%L]::uuid[])$q$, :'s_r', :'inst_j'), 'centre not found');
reset role;
select pg_temp.val_is('audit: seat.centres_set', $q$select count(*)::text from audit_log where action = 'seat.centres_set'$q$, '2');
select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.val_is('another institute does not see the centres (RLS)', $q$select count(*)::text from centres$q$, '0');
select pg_temp.fails_with('another institute cannot change a centre', format($q$select admin_save_centre(%L, 'Mine')$q$, pg_temp.g('cA')), 'centre not found');
reset role;

-- ---------- students in centres ----------
-- S1 Andheri, morning batch: 4,000 + 2,000 due, 5,000 later. S2 Andheri, all paid. S3 Borivali owes 4,000.
-- S4 no centre owes 1,000. A payment for S3.
insert into students (id, institute_id, admission_no, name, class_label, section, board, academic_year, parent_name, phone, status, source, centre_id, batch_id) values
 (:'st1', :'inst_i', 'A1', 'Riya Bhosale', '8th', 'A', 'State', '2026-27', 'Sunita Bhosale', '9800000001', 'active', 'import', null, null),
 (:'st2', :'inst_i', 'A2', 'Aman Rao', '8th', 'A', 'State', '2026-27', 'Mr Rao', '9800000002', 'active', 'import', null, null),
 (:'st3', :'inst_i', 'B1', 'Bhavna Shah', '8th', 'B', 'State', '2026-27', 'Mr Shah', '9800000003', 'active', 'import', null, null),
 (:'st4', :'inst_i', 'X1', 'Zoya Khan', '9th', 'A', 'CBSE', '2026-27', 'Mrs Khan', '9800000004', 'active', 'import', null, null);
update students set centre_id = (select val::uuid from v where k = 'cA'), batch_id = (select val::uuid from v where k = 'bM') where id = :'st1';
update students set centre_id = (select val::uuid from v where k = 'cA') where id = :'st2';
update students set centre_id = (select val::uuid from v where k = 'cB') where id = :'st3';
insert into fee_items (institute_id, student_id, head, amount, due_date, academic_year) values
 (:'inst_i', :'st1', 'Term 1 tuition', 4000, (now() at time zone 'Asia/Kolkata')::date - 40, '2026-27'),
 (:'inst_i', :'st1', 'Exam fee', 2000, (now() at time zone 'Asia/Kolkata')::date - 5, '2026-27'),
 (:'inst_i', :'st1', 'Term 2 tuition', 5000, (now() at time zone 'Asia/Kolkata')::date + 30, '2026-27'),
 (:'inst_i', :'st2', 'Term 1 tuition', 3000, (now() at time zone 'Asia/Kolkata')::date - 40, '2026-27'),
 (:'inst_i', :'st3', 'Term 1 tuition', 4000, (now() at time zone 'Asia/Kolkata')::date - 40, '2026-27'),
 (:'inst_i', :'st4', 'Term 1 tuition', 1000, (now() at time zone 'Asia/Kolkata')::date - 40, '2026-27');
insert into payments (institute_id, student_id, amount, paid_on, mode, recorded_by) values
 (:'inst_i', :'st2', 3000, (now() at time zone 'Asia/Kolkata')::date, 'cash', :'s_o');
insert into payments (id, institute_id, student_id, amount, paid_on, mode, reference, recorded_by) values
 ('c6000000-0000-0000-0000-000000000003', :'inst_i', :'st3', 500, (now() at time zone 'Asia/Kolkata')::date, 'upi', 'UTRB1', :'s_o');
select pg_temp.fails_with('a batch of another centre is refused on a student', format($q$update students set batch_id = %L where id = %L$q$, pg_temp.g('bE'), :'st1'), 'another centre');

-- ---------- Accounts limited to Andheri ----------
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('centres_list says which centres are mine', $q$select centres_list() -> 'my_centre_ids' ->> 0$q$, pg_temp.g('cA'));
select pg_temp.val_is('the students list: Andheri and students with no centre (not Borivali)', $q$select string_agg(admission_no, ',' order by admission_no) from accounts_students('{}')$q$, 'A1,A2,X1');
select pg_temp.val_is('RLS: students of Borivali are not readable', $q$select count(*)::text from students where admission_no = 'B1'$q$, '0');
select pg_temp.val_is('RLS: payments of Borivali students are not readable', $q$select count(*)::text from payments where reference = 'UTRB1'$q$, '0');
select pg_temp.val_is('RLS: fee items of Borivali students are not readable', format($q$select count(*)::text from fee_items where student_id = %L$q$, :'st3'), '0');
select pg_temp.fails_with('a Borivali student cannot be opened', format($q$select accounts_student_detail(%L)$q$, :'st3'), 'student not found');
select pg_temp.fails_with('no payment on a Borivali student', format($q$select accounts_record_payment(%L, 100, null, 'cash')$q$, :'st3'), 'student not found');
select pg_temp.fails_with('no reversal of a Borivali payment', $q$select accounts_reverse_payment('c6000000-0000-0000-0000-000000000003', 'test')$q$, 'payment not found');
select pg_temp.fails_with('asking for Borivali totals is refused', format($q$select admin_fees_ledger(%L, %L::date, %L::date, null, null, %L)$q$, :'inst_i', pg_temp.d(-30), pg_temp.d(0), pg_temp.g('cB')), 'only your own centres');
select pg_temp.val_is('collected today (all I may see): the Andheri cash, not the Borivali UPI', format($q$select (ledger_collected(%L, %L::date, %L::date) ->> 'total')$q$, :'inst_i', pg_temp.d(0), pg_temp.d(0)), '3000.00');
select pg_temp.val_is('the day closing leaves Borivali out', format($q$select (ledger_day_closing(%L) -> 'totals' ->> 'payments')$q$, :'inst_i'), '1');
select pg_temp.val_is('the day closing for Andheri', format($q$select (ledger_day_closing(%L, null, %L) -> 'totals' ->> 'payments')$q$, :'inst_i', pg_temp.g('cA')), '1');
select pg_temp.val_is('search finds no Borivali student', $q$select count(*)::text from collect_search('bhavna')$q$, '0');
select pg_temp.val_is('pending: Andheri and no-centre students with dues', $q$select string_agg(admission_no, ',' order by admission_no) from collect_pending()$q$, 'A1,X1');
select pg_temp.fails_with('pending for Borivali is refused', format($q$select * from collect_pending(%L)$q$, pg_temp.g('cB')), 'only your own centres');

-- Collect: search ranking, the student, a payment, collected by me.
select pg_temp.val_is('search: a word of the name ranks 2', $q$select string_agg(admission_no || ':' || rank, ',' order by rank, name) from collect_search('bhos')$q$, 'A1:2');
select pg_temp.val_is('search: the start of the name ranks 1', $q$select string_agg(admission_no || ':' || rank, ',' order by rank, name) from collect_search('riya')$q$, 'A1:1');
select pg_temp.val_is('search by parent name word', $q$select string_agg(admission_no, ',') from collect_search('sunita')$q$, 'A1');
select pg_temp.val_is('search: two words of name and parent', $q$select string_agg(admission_no || ':' || rank, ',') from collect_search('riya sunita')$q$, 'A1:3');
select pg_temp.val_is('search by admission no (exact) ranks 0', $q$select string_agg(admission_no || ':' || rank, ',') from collect_search('a1')$q$, 'A1:0');
select pg_temp.val_is('search by 4+ phone digits', $q$select string_agg(admission_no, ',') from collect_search('00004')$q$, 'X1');
select pg_temp.val_is('search shows due now and batch', $q$select due_now || ':' || batch_name || ':' || centre_name from collect_search('riya')$q$, '6000.00:8th SB Morning:Andheri');
select pg_temp.val_is('search: a % in the text matches nothing special', $q$select count(*)::text from collect_search('%')$q$, '0');
select pg_temp.val_is('empty search returns nothing', $q$select count(*)::text from collect_search('  ')$q$, '0');
select pg_temp.val_is('search within the morning batch', format($q$select string_agg(admission_no, ',') from collect_search('a', null, %L)$q$, pg_temp.g('bM')), 'A1');
select pg_temp.val_is('collect_student: due now 6,000 and two fees due plus one later', format($q$select (j ->> 'due_now') || ':' || jsonb_array_length(j -> 'unpaid') || ':' || (j -> 'unpaid' -> 0 ->> 'left') || ':' || (j -> 'unpaid' -> 2 ->> 'is_due') from collect_student(%L) j$q$, :'st1'), '6000.00:3:4000.00:false');
select pg_temp.ok('Kavita records 1,000 cash for Riya', format($q$select accounts_record_payment(%L, 1000, null, 'cash')$q$, :'st1'));
select pg_temp.val_is('the payment pays the oldest fee first', format($q$select (j -> 'unpaid' -> 0 ->> 'left') || ':' || (j -> 'unpaid' -> 1 ->> 'left') from collect_student(%L) j$q$, :'st1'), '3000.00:2000.00');
select pg_temp.val_is('collected by me: 1 today, 1,000', $q$select (j ->> 'today_payments') || ':' || (j ->> 'today_amount') || ':' || (j ->> 'month_payments') || ':' || (j ->> 'can_collect') from collected_by_me() j$q$, '1:1000.00:1:true');
select pg_temp.val_is('most used mode: cash (2 cash, 1 UPI)', $q$select collected_by_me() ->> 'top_mode'$q$, 'cash');
select pg_temp.keep('pay1', format($q$select id::text from payments where student_id = %L and recorded_by = %L and reverses_id is null$q$, :'st1', :'s_ac'));
select pg_temp.ok('Undo: reversed with "Entered by mistake"', format($q$select accounts_reverse_payment(%L, 'Entered by mistake')$q$, pg_temp.g('pay1')));
select pg_temp.val_is('after the undo collected by me is 0', $q$select (collected_by_me() ->> 'today_payments')$q$, '0');

-- Add and import with a centre.
select pg_temp.keep('new1', $q$select accounts_save_student(null, '{"name":"New Andheri","class_label":"8th"}')::text$q$);
select pg_temp.val_is('a new student of a person limited to one centre goes to that centre', format($q$select (centre_id = %L)::text from students where id = %L$q$, pg_temp.g('cA'), pg_temp.g('new1')), 'true');
select pg_temp.fails_with('Kavita cannot add a student to Borivali', $q$select accounts_save_student(null, '{"name":"Bad","centre":"Borivali"}')$q$, 'only to your own centres');
select pg_temp.keep('new2', $q$select accounts_save_student(null, '{"name":"With batch","batch":"8th SB Morning"}')::text$q$);
select pg_temp.val_is('a batch name sets the batch', format($q$select (batch_id = %L)::text from students where id = %L$q$, pg_temp.g('bM'), pg_temp.g('new2')), 'true');
select pg_temp.val_is('import: a Borivali row is skipped, the others go to Andheri', $q$select (j ->> 'added') || ':' || (j -> 'skipped_rows' -> 0 ->> 'row') || ':' || (j -> 'skipped_rows' -> 0 ->> 'reason') from accounts_import_students('[{"name":"Imp One","phone":"9811111111"},{"name":"Imp Two","centre":"BOR"},{"name":"Imp Three","centre":"Andheri","batch":"8th SB Morning","admission_no":"IMP3"}]') j$q$, '2:2:a centre you do not work in');
select pg_temp.val_is('imported students are in Andheri, one in the batch', format($q$select string_agg(name || '=' || coalesce((batch_id = %L)::text, 'none'), ',' order by name) from students where name like 'Imp %%' and centre_id = %L$q$, pg_temp.g('bM'), pg_temp.g('cA')), 'Imp One=none,Imp Three=true');
select pg_temp.val_is('import: updating a Borivali student by admission no is skipped', $q$select (accounts_import_students('[{"admission_no":"B1","name":"Hijack"}]') -> 'skipped_rows' -> 0 ->> 'reason')$q$, 'a student of another centre');
select pg_temp.val_is('import: an unknown centre is skipped with its name', $q$select (accounts_import_students('[{"name":"X","centre":"Pune"}]') -> 'skipped_rows' -> 0 ->> 'reason')$q$, 'unknown centre "Pune"');
reset role;

-- ---------- the owner: filters ----------
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.val_is('owner sees every student (no filter)', $q$select count(*)::text from accounts_students('{}') where admission_no in ('A1','A2','B1','X1')$q$, '4');
select pg_temp.val_is('owner: centre filter in accounts_students', format($q$select string_agg(admission_no, ',' order by admission_no) from accounts_students(jsonb_build_object('centre_id', %L)) where admission_no is not null and admission_no not like 'IMP%%'$q$, pg_temp.g('cB')), 'B1');
select pg_temp.val_is('owner: batch filter in accounts_students', format($q$select string_agg(name, ',' order by name) from accounts_students(jsonb_build_object('batch_id', %L))$q$, pg_temp.g('bM')), 'Imp Three,Riya Bhosale,With batch');
select pg_temp.val_is('due now, all centres: 3 students', format($q$select admin_fees_ledger(%L, %L::date, %L::date) -> 'due_now' ->> 'students'$q$, :'inst_i', pg_temp.d(-30), pg_temp.d(0)), '3');
select pg_temp.val_is('due now, Andheri: 1 student, 6,000', format($q$select (j -> 'due_now' ->> 'students') || ':' || (j -> 'due_now' ->> 'amount') from admin_fees_ledger(%L, %L::date, %L::date, null, null, %L) j$q$, :'inst_i', pg_temp.d(-30), pg_temp.d(0), pg_temp.g('cA')), '1:6000.00');
select pg_temp.val_is('due now, Borivali: 3,500', format($q$select (admin_fees_ledger(%L, %L::date, %L::date, null, null, %L) -> 'due_now' ->> 'amount')$q$, :'inst_i', pg_temp.d(-30), pg_temp.d(0), pg_temp.g('cB')), '3500.00');
select pg_temp.val_is('collected, Borivali: the UPI 500', format($q$select (admin_fees_ledger(%L, %L::date, %L::date, null, null, %L) -> 'collected' ->> 'total')$q$, :'inst_i', pg_temp.d(0), pg_temp.d(0), pg_temp.g('cB')), '500.00');
select pg_temp.val_is('the filter is gone after the call', format($q$select (admin_fees_ledger(%L, %L::date, %L::date, null, null, %L) is not null)::text || ':' || coalesce(current_setting('vector.centre', true), '')$q$, :'inst_i', pg_temp.d(0), pg_temp.d(0), pg_temp.g('cB')), 'true:');
select pg_temp.val_is('the old five-argument call is unchanged', format($q$select (admin_fees_ledger(%L, %L::date, %L::date, null, null) -> 'due_now' ->> 'students')$q$, :'inst_i', pg_temp.d(-30), pg_temp.d(0)), '3');
select pg_temp.fails_with('a centre of another institute is refused', format($q$select admin_fees_ledger(%L, %L::date, %L::date, null, null, %L)$q$, :'inst_i', pg_temp.d(0), pg_temp.d(0), :'inst_j'), 'centre not found');
select pg_temp.val_is('pending sorted by amount (owner, all centres)', $q$select string_agg(admission_no, ',' order by 1) from (select admission_no from collect_pending() limit 1) x$q$, 'A1');
select pg_temp.val_is('pending for Borivali, with the total due', format($q$select admission_no || ':' || total_due || ':' || total_rows from collect_pending(%L)$q$, pg_temp.g('cB')), 'B1:3500.00:1');
select pg_temp.val_is('pending by date: oldest unpaid fee date', format($q$select (oldest_due_date = %L::date)::text from collect_pending(null, null, 'date') where admission_no = 'X1'$q$, pg_temp.d(-40)), 'true');
select pg_temp.fails_with('pending sort must be amount or date', $q$select * from collect_pending(null, null, 'name')$q$, 'sort by amount or date');

-- Calling lists and leads follow the centre.
select pg_temp.keep('kA', format($q$select accounts_create_fees_campaign('Fees Andheri', '8th', null, null, 0, null, true, true, %L)::text$q$, pg_temp.g('cA')));
select pg_temp.keep('kAll', $q$select accounts_create_fees_campaign('Fees all')::text$q$);
select pg_temp.val_is('a list for Andheri has only Andheri students (Riya)', format($q$select string_agg(name, ',') from leads where campaign_id = %L$q$, pg_temp.g('kA')), 'Sunita Bhosale');
select pg_temp.val_is('the list carries the centre', format($q$select (centre_id = %L)::text from campaigns where id = %L$q$, pg_temp.g('cA'), pg_temp.g('kA')), 'true');
select pg_temp.val_is('leads copy their student''s centre', format($q$select count(*) filter (where centre_id is not null)::text || '/' || count(*) from leads where campaign_id = %L and student_id <> %L$q$, pg_temp.g('kAll'), :'st4'), '2/2');
select pg_temp.val_is('calling lists for Borivali: the all-centre list only', format($q$select string_agg(name, ',' order by name) from admin_campaign_list(%L)$q$, pg_temp.g('cB')), 'Fees all');
select pg_temp.val_is('calling lists for Andheri: both, with the centre column', format($q$select string_agg(name || '=' || coalesce((centre_id = %L)::text, 'all'), ',' order by name) from admin_campaign_list(%L)$q$, pg_temp.g('cA'), pg_temp.g('cA')), 'Fees Andheri=true,Fees all=all');
select pg_temp.val_is('team for Andheri: owner, Kavita and Ravi (all centres), not the Borivali manager', format($q$select string_agg(label, ',' order by label) from admin_callers(%L, %L)$q$, :'inst_i', pg_temp.g('cA')), 'Kavita,Owner,Ravi');
select pg_temp.ok('a list can be set to a centre', format($q$select admin_set_campaign_centre(%L, %L)$q$, pg_temp.g('kAll'), pg_temp.g('cB')));
select pg_temp.ok('and back to every centre', format($q$select admin_set_campaign_centre(%L, null)$q$, pg_temp.g('kAll')));
reset role;

-- ---------- a manager limited to Borivali ----------
select pg_temp.as_user(:'u_mb', 'mb@i.test');
set role authenticated;
select pg_temp.val_is('RLS: the Andheri list is not readable', format($q$select count(*)::text from campaigns where id = %L$q$, pg_temp.g('kA')), '0');
select pg_temp.val_is('RLS: leads of Andheri are not readable', format($q$select count(*)::text from leads where campaign_id = %L$q$, pg_temp.g('kA')), '0');
select pg_temp.val_is('RLS: leads of Borivali in the all-centre list are', format($q$select count(*)::text from leads where campaign_id = %L$q$, pg_temp.g('kAll')), '2');
select pg_temp.val_is('admin_campaign_list() leaves the Andheri list out', $q$select string_agg(name, ',') from admin_campaign_list()$q$, 'Fees all');
select pg_temp.val_is('admin_callers() leaves Kavita (Andheri) out', format($q$select string_agg(label, ',' order by label) from admin_callers(%L)$q$, :'inst_i'), 'Manager B,Owner,Ravi');
select pg_temp.fails_with('asking for Andheri lists is refused', format($q$select * from admin_campaign_list(%L)$q$, pg_temp.g('cA')), 'only your own centres');
select pg_temp.val_is('Fees due now for the manager: Borivali and no centre', format($q$select admin_fees_ledger(%L, %L::date, %L::date) -> 'due_now' ->> 'students'$q$, :'inst_i', pg_temp.d(-30), pg_temp.d(0)), '2');
reset role;

-- ---------- Autopilot per centre ----------
-- Term 2 of Class 8 State Board is due in 4 days for Riya (Andheri) and Bhavna (Borivali).
insert into fee_items (institute_id, student_id, head, amount, due_date, academic_year) values
 (:'inst_i', :'st3', 'Term 2 tuition', 5000, (now() at time zone 'Asia/Kolkata')::date + 4, '2026-27');
update fee_items set is_void = true, void_reason = 'moved' where student_id = :'st1' and head = 'Term 2 tuition';
insert into fee_items (institute_id, student_id, head, amount, due_date, academic_year) values
 (:'inst_i', :'st1', 'Term 2 tuition', 5000, (now() at time zone 'Asia/Kolkata')::date + 4, '2026-27');
update campaigns set status = 'closed' where institute_id = :'inst_i';
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.ok('the owner runs the plan', format($q$select autopilot_plan(%L)$q$, :'inst_i'));
reset role;
select pg_temp.val_is('one fees list per centre', $q$select string_agg(name, ' | ' order by name) from campaigns where name like 'Term 2 fees%'$q$, 'Term 2 fees – Class 8 State Board · Andheri | Term 2 fees – Class 8 State Board · Borivali');
select pg_temp.val_is('each list has its centre and only its students', $q$select string_agg(ce.name || ':' || (select string_agg(l.name, ',') from leads l where l.campaign_id = c.id), ' | ' order by ce.name) from campaigns c join centres ce on ce.id = c.centre_id where c.name like 'Term 2 fees%'$q$, 'Andheri:Sunita Bhosale | Borivali:Mr Shah');
select pg_temp.val_is('the suggestions carry the centre', $q$select count(*)::text from suggestions where kind = 'fees_due_list' and plan ? 'centre_id' and dedupe_key like 'fees_list:8th:state:%:%'$q$, '2');
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.val_is('Today for Andheri: the Andheri card only', format($q$select string_agg(c ->> 'title', ',') from jsonb_array_elements(my_suggestions(%L) -> 'feed') c where c ->> 'kind' = 'fees_due_list'$q$, pg_temp.g('cA')), 'Start "Term 2 fees – Class 8 State Board · Andheri"');
select pg_temp.val_is('Today for every centre: both', $q$select count(*)::text from jsonb_array_elements(my_suggestions() -> 'feed') c where c ->> 'kind' = 'fees_due_list'$q$, '2');
select pg_temp.ok('autopilot numbers for a centre', format($q$select autopilot_numbers(%L)$q$, pg_temp.g('cA')));
select pg_temp.ok('Today numbers for a centre', format($q$select admin_home_summary('today', null, %L)$q$, pg_temp.g('cA')));
select pg_temp.ok('Today ledger for a centre', format($q$select admin_home_ledger('today', null, %L)$q$, pg_temp.g('cA')));
select pg_temp.ok('promises for a centre', format($q$select * from admin_promises_ledger(%L, null, null, 7, %L)$q$, :'inst_i', pg_temp.g('cA')));
reset role;
select pg_temp.as_user(:'u_mb', 'mb@i.test');
set role authenticated;
select pg_temp.val_is('the Borivali manager does not see the Andheri card', $q$select string_agg(c -> 'plan' ->> 'centre_name', ',') from jsonb_array_elements(my_suggestions() -> 'feed') c where c ->> 'kind' = 'fees_due_list'$q$, 'Borivali');
reset role;

-- ---------- an institute without centres is as before ----------
insert into students (id, institute_id, admission_no, name, class_label, phone, status, source) values
 (:'stj', :'inst_j', 'J1', 'Jay', '8th', '9800000009', 'active', 'import');
insert into fee_items (institute_id, student_id, head, amount, due_date) values (:'inst_j', :'stj', 'Fees', 2000, (now() at time zone 'Asia/Kolkata')::date - 3);
select pg_temp.as_user(:'u_xa', 'xa@j.test');
set role authenticated;
select pg_temp.val_is('no centres: has_centres false', $q$select centres_list() ->> 'has_centres'$q$, 'false');
select pg_temp.val_is('no centres: the student is listed with no centre', $q$select name || ':' || coalesce(centre_id::text, 'none') || ':' || balance_due_now from accounts_students('{}')$q$, 'Jay:none:2000.00');
select pg_temp.val_is('no centres: search works', $q$select name || ':' || due_now from collect_search('ja')$q$, 'Jay:2000.00');
select pg_temp.ok('no centres: a payment', format($q$select accounts_record_payment(%L, 500, null, 'cash')$q$, :'stj'));
select pg_temp.keep('jai', $q$select accounts_save_student(null, '{"name":"Jai"}')::text$q$);
select pg_temp.val_is('no centres: the new student has no centre', format($q$select coalesce(centre_id::text, 'none') from students where id = %L$q$, pg_temp.g('jai')), 'none');
select pg_temp.val_is('no centres: collected by me', $q$select collected_by_me() ->> 'today_amount'$q$, '500.00');
reset role;
select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.val_is('no centres: due now the same with and without the new arguments',
  format($q$select ((admin_fees_ledger(%L, %L::date, %L::date) -> 'due_now') = (admin_fees_ledger(%L, %L::date, %L::date, null, null, null) -> 'due_now'))::text$q$,
         :'inst_j', pg_temp.d(-30), pg_temp.d(0), :'inst_j', pg_temp.d(-30), pg_temp.d(0)), 'true');
select pg_temp.fails_with('a caller-less owner cannot ask for another institute''s centre', format($q$select admin_fees_ledger(%L, %L::date, %L::date, null, null, %L)$q$, :'inst_j', pg_temp.d(0), pg_temp.d(0), pg_temp.g('cA')), 'centre not found');
reset role;
select pg_temp.as_user(:'u_r', 'r@i.test');
set role authenticated;
select pg_temp.fails_with('a caller cannot search students', $q$select * from collect_search('riya')$q$, 'only accounts');
select pg_temp.fails_with('a caller cannot read collected_by_me', $q$select collected_by_me()$q$, 'only accounts');
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot search', $q$select has_function_privilege('anon','public.collect_search(text,uuid,uuid,int)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('signed-in people can search (it checks the role)', $q$select has_function_privilege('authenticated','public.collect_search(text,uuid,uuid,int)','EXECUTE')::text$q$, 'true');
select pg_temp.val_is('anon cannot read collected_by_me', $q$select has_function_privilege('anon','public.collected_by_me()','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('the old admin_fees_ledger is still there', $q$select has_function_privilege('authenticated','public.admin_fees_ledger(uuid,date,date,uuid,uuid)','EXECUTE')::text$q$, 'true');
select pg_temp.val_is('the old my_suggestions is still there', $q$select has_function_privilege('authenticated','public.my_suggestions()','EXECUTE')::text$q$, 'true');
select pg_temp.val_is('nobody runs the base functions from the browser', $q$select has_function_privilege('authenticated','public.accounts_save_student__base(uuid,jsonb)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('nobody runs scope_push from the browser', $q$select has_function_privilege('authenticated','public.scope_push(uuid,uuid,uuid,boolean)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('no browser INSERT on centres', $q$select has_table_privilege('authenticated','public.centres','INSERT')::text$q$, 'false');
select pg_temp.val_is('RLS is on for centres and batches', $q$select count(*)::text from pg_class where relname in ('centres','batches') and relrowsecurity$q$, '2');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
