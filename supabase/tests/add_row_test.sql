-- Tests for 20261026100000_add_row.sql: one lead added by hand (admin_add_leads with one row and the consent
-- keys), a few leads by hand, bad numbers and repeats, and the "+ Add student" flow of the Fees tab
-- (accounts_save_student, then accounts_add_fee_item and accounts_record_payment, then an edit).
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

\set inst_i 'ad000000-0000-0000-0000-000000000001'
\set u_o 'ad100000-0000-0000-0000-000000000001'
\set u_ac 'ad100000-0000-0000-0000-000000000002'
\set u_a 'ad100000-0000-0000-0000-000000000003'
\set s_o 'ad200000-0000-0000-0000-000000000001'
\set s_ac 'ad200000-0000-0000-0000-000000000002'
\set s_a 'ad200000-0000-0000-0000-000000000003'
\set k_fees 'ad300000-0000-0000-0000-000000000001'
\set k_closed 'ad300000-0000-0000-0000-000000000002'

reset role;
insert into auth.users (id, email) values (:'u_o', 'o@ar.test'), (:'u_ac', 'ac@ar.test'), (:'u_a', 'a@ar.test');
insert into institutes (id, name, status) values (:'inst_i', 'Add Row Inst', 'active');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active'),
 (:'s_ac', :'inst_i', :'u_ac', 'Accounts', 'accounts', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Asha', 'rep', 'active');
insert into campaigns (id, institute_id, name, call_type_id, status, open_to_all, share_mode) values
 (:'k_fees', :'inst_i', 'Nov fees', (select id from call_types where key='fees'), 'running', true, 'next_free'),
 (:'k_closed', :'inst_i', 'Old fees', (select id from call_types where key='fees'), 'closed', true, 'next_free');

-- ---------- one lead by hand ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('one lead with consent keys is added', format($q$select added||' '||bad_numbers||' '||repeats||' '||other_skipped from admin_add_leads(%L,
  '[{"name":"Meena Shah","phone":"098765 43210","amount_due":"7000","extra":{"Student":"Aarav","Class":"8","source":"a call to our office"},"consent_call":true,"consent_whatsapp":true}]')$q$, :'k_fees'), '1 0 0 0');
reset role;
select pg_temp.val_is('the lead keeps its phone, extra fields and amount', $q$select phone||'|'||(extra->>'Student')||'|'||(extra->>'source')||'|'||amount_due::int from leads where name='Meena Shah'$q$,
  '+919876543210|Aarav|a call to our office|7000');
select pg_temp.val_is('WhatsApp consent is saved', $q$select consent_call||' '||consent_whatsapp from leads where name='Meena Shah'$q$, 'true true');
select pg_temp.val_is('audit: leads.added for one lead', format($q$select count(*)::text from audit_log where action='leads.added' and target=%L$q$, :'k_fees' || ':1'), '1');
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('the same number again is a repeat', format($q$select added||' '||repeats from admin_add_leads(%L, '[{"name":"Meena again","phone":"+91 98765-43210"}]')$q$, :'k_fees'), '0 1');
select pg_temp.val_is('a short number is a bad number', format($q$select added||' '||bad_numbers from admin_add_leads(%L, '[{"name":"Short","phone":"98765"}]')$q$, :'k_fees'), '0 1');
select pg_temp.val_is('no consent keys: calls yes, WhatsApp no (as before)', format($q$select added::text from admin_add_leads(%L, '[{"name":"Ravi","phone":"9876543211"}]')$q$, :'k_fees'), '1');
select pg_temp.val_is('"no" text for calls is read', format($q$select added::text from admin_add_leads(%L, '[{"name":"No calls","phone":"9876543212","consent_call":"No","consent_whatsapp":"yes"}]')$q$, :'k_fees'), '1');
select pg_temp.val_is('a consent that is not yes or no skips the row', format($q$select added||' '||other_skipped from admin_add_leads(%L, '[{"name":"Odd","phone":"9876543213","consent_whatsapp":"maybe"}]')$q$, :'k_fees'), '0 1');
select pg_temp.fails_with('money in an extra field is still refused', format($q$select * from admin_add_leads(%L, '[{"name":"X","phone":"9000000001","extra":{"Fee balance":"500"}}]')$q$, :'k_fees'), 'Amount due');
select pg_temp.fails_with('a closed list takes no lead', format($q$select * from admin_add_leads(%L, '[{"name":"Z","phone":"9200000001"}]')$q$, :'k_closed'), 'closed');
-- Leads by hand in New calling list: two rows, a repeat inside the rows.
select pg_temp.val_is('two by hand, one repeated inside the rows', format($q$select added||' '||repeats from admin_add_leads(%L,
  '[{"name":"Hand 1","phone":"9111111111","extra":{"Course":"Data Analytics"}},{"name":"Hand 2","phone":"9111111112"},{"name":"Hand 1 again","phone":"9111111111"}]')$q$, :'k_fees'), '2 1');
reset role;
select pg_temp.val_is('defaults when the keys are missing', $q$select consent_call||' '||consent_whatsapp from leads where name='Ravi'$q$, 'true false');
select pg_temp.val_is('consent read from text', $q$select consent_call||' '||consent_whatsapp from leads where name='No calls'$q$, 'false true');
select pg_temp.val_is('sheet order kept', $q$select string_agg(name, ',' order by created_at) from leads where name like 'Hand%'$q$, 'Hand 1,Hand 2');

-- ---------- callers and Accounts cannot add leads ----------
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.fails_with('a caller cannot add a lead', format($q$select * from admin_add_leads(%L, '[{"name":"X","phone":"9000000002"}]')$q$, :'k_fees'), 'admin');
reset role;
select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.fails_with('Accounts cannot add a lead', format($q$select * from admin_add_leads(%L, '[{"name":"X","phone":"9000000002"}]')$q$, :'k_fees'), 'admin');

-- ---------- + Add student (Fees): save, a fee item, paid so far, then an edit ----------
select pg_temp.ok('Accounts adds a student by hand', $q$select accounts_save_student(null, '{"name":"Kabir Jain","admission_no":"A201","class_label":"8","section":"B","board":"cbse","academic_year":"2026-27","parent_name":"Rakesh Jain","phone":"98765 00011","alt_phone":""}')$q$);
reset role;
select pg_temp.val_is('the student is manual, phone and board normalised', $q$select source||'|'||phone||'|'||board||'|'||coalesce(alt_phone,'none') from students where admission_no='A201'$q$,
  'manual|+919876500011|CBSE|none');
select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.ok('a fee item for the new student', $q$select accounts_add_fee_item((select id from students where admission_no='A201'), 'Term 2 tuition', 18000, current_date + 10, null)$q$);
select pg_temp.ok('paid so far, with mode and reference', $q$select accounts_record_payment((select id from students where admission_no='A201'), 6000, current_date - 3, 'upi', 'UTR4455', 'Paid so far, added with the student')$q$);
select pg_temp.val_is('balance: 18000 fees, 6000 paid', $q$select total_fees::int||' '||paid::int||' '||balance_total::int from accounts_students('{"search":"Kabir"}')$q$, '18000 6000 12000');
select pg_temp.fails_with('the same admission number again is refused', $q$select accounts_save_student(null, '{"name":"Someone","admission_no":"a201"}')$q$, 'admission number');
select pg_temp.fails_with('a bad phone is refused', $q$select accounts_save_student(null, '{"name":"Someone","phone":"12345"}')$q$, '10-digit');
select pg_temp.fails_with('a name is required', $q$select accounts_save_student(null, '{"name":"  "}')$q$, 'name is required');
select pg_temp.ok('edit: new section, parent and alternate phone', $q$select accounts_save_student((select id from students where admission_no='A201'), '{"name":"Kabir Jain","admission_no":"A201","class_label":"8","section":"C","board":"CBSE","academic_year":"2026-27","parent_name":"Rakesh K Jain","phone":"9876500011","alt_phone":"+91 98765 00099"}')$q$);
reset role;
select pg_temp.val_is('the edit is saved', $q$select section||'|'||parent_name||'|'||alt_phone from students where admission_no='A201'$q$, 'C|Rakesh K Jain|+919876500099');
select pg_temp.val_is('audit: student.added and student.changed', $q$select count(*)::text from audit_log where action in ('student.added','student.changed') and target=(select id::text from students where admission_no='A201')$q$, '2');
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.fails_with('a caller cannot add a student', $q$select accounts_save_student(null, '{"name":"X"}')$q$, '');
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot run admin_add_leads', $q$select has_function_privilege('anon','public.admin_add_leads(uuid,jsonb)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated can run admin_add_leads', $q$select has_function_privilege('authenticated','public.admin_add_leads(uuid,jsonb)','EXECUTE')::text$q$, 'true');
select pg_temp.val_is('the consent helper is internal', $q$select has_function_privilege('authenticated','public.lead_row_consent(jsonb,text)','EXECUTE')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
