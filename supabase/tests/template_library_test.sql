-- Tests for the central template library in 20261025140000_template_library.sql: the seed, who reads and who
-- writes script_templates and common_answers, list_script_templates filters, platform_upsert_template /
-- platform_upsert_common_answer (platform admins only), institute fills (admin_fill_common_answer) and
-- my_common_answers. Run with supabase/tests/run.sh. Expect failed = 0 on the last line.
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
grant execute on function pg_temp.ok(text, text), pg_temp.fails_with(text, text, text), pg_temp.val_is(text, text, text) to authenticated, anon;

\set inst_i 'e1000000-0000-0000-0000-000000000001'
\set inst_j 'e2000000-0000-0000-0000-000000000002'
\set u_o 'e3000000-0000-0000-0000-000000000001'
\set u_m 'e3000000-0000-0000-0000-000000000002'
\set u_c 'e3000000-0000-0000-0000-000000000003'
\set u_j 'e3000000-0000-0000-0000-000000000004'
\set u_p 'e3000000-0000-0000-0000-000000000005'
\set u_n 'e3000000-0000-0000-0000-000000000006'

reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@i.test', now()), (:'u_m', 'm@i.test', now()), (:'u_c', 'c@i.test', now()),
 (:'u_j', 'j@j.test', now()), (:'u_p', 'p@vector.test', now()), (:'u_n', 'n@none.test', now());
insert into institutes (id, name, status) values (:'inst_i', 'Inst I', 'active'), (:'inst_j', 'Inst J', 'active');
insert into seats (institute_id, user_id, label, role, status) values
 (:'inst_i', :'u_o', 'Owner', 'admin', 'active'),
 (:'inst_i', :'u_m', 'Manager', 'admin', 'active'),
 (:'inst_i', :'u_c', 'Caller', 'rep', 'active'),
 (:'inst_j', :'u_j', 'Owner J', 'admin', 'active');
-- The platform admin has no seat: Vector staff.
insert into platform_admins (user_id, note) values (:'u_p', 'Vector team');

-- ---------- the seed ----------
select pg_temp.val_is('26 templates are seeded', 'select count(*)::text from script_templates', '26');
select pg_temp.val_is('21 common answers are seeded', 'select count(*)::text from common_answers', '21');
select pg_temp.val_is('every seeded template passes the template check',
  $q$select count(*)::text from script_templates where template_problem(call_type, steps, pushbacks) is not null$q$, '0');
select pg_temp.val_is('5 common answers need institute facts', $q$select count(*)::text from common_answers where cardinality(checks) > 0$q$, '5');
select pg_temp.val_is('a seeded answer keeps its result', $q$select result from common_answers where key = 'dnd'$q$, 'do_not_call');
select pg_temp.val_is('4 Hinglish templates', $q$select count(*)::text from script_templates where language = 'hinglish'$q$, '4');

-- ---------- reading ----------
select pg_temp.as_user(:'u_c');
set role authenticated;
select pg_temp.val_is('a caller is not a platform admin', 'select is_platform_admin()::text', 'false');
select pg_temp.val_is('a caller lists every active template', 'select count(*)::text from list_script_templates()', '26');
select pg_temp.val_is('a caller reads the table too', 'select count(*)::text from script_templates', '26');
select pg_temp.val_is('filter: fees + Hinglish', $q$select string_agg(key, ',' order by key) from list_script_templates(p_call_type => 'fees', p_language => 'hinglish')$q$,
  'fees_overdue_hinglish,fees_reminder_polite_hinglish');
select pg_temp.val_is('filter: untagged templates suit 8th CBSE', $q$select count(*)::text from list_script_templates(p_class_label => '8th', p_board => 'cbse')$q$, '26');
select pg_temp.val_is('a list row carries the type label and check marks',
  $q$select call_type_label || ':' || (check_marks > 0)::text from list_script_templates('fees') where key = 'fees_reminder_polite'$q$, 'Fees collection:true');
select pg_temp.fails_with('an unknown board is refused', $q$select * from list_script_templates(p_board => 'Kerala')$q$, 'board must be');
select pg_temp.fails_with('a caller cannot write a template', $q$insert into script_templates (key, name, call_type, steps) values ('x_x', 'X', 'fees', '[]')$q$, 'permission denied');
select pg_temp.fails_with('a caller cannot change a template', $q$update script_templates set name = 'X'$q$, 'permission denied');
select pg_temp.val_is('include_inactive is ignored for non-platform admins', 'select count(*)::text from list_script_templates(p_include_inactive => true)', '26');

select pg_temp.as_user(:'u_n');
select pg_temp.fails_with('a login without a seat cannot list', 'select * from list_script_templates()', 'active seat');
select pg_temp.val_is('and reads no rows from the table', 'select count(*)::text from script_templates', '0');
select pg_temp.fails_with('nor common answers', 'select * from my_common_answers()', 'no active seat');
reset role;
set role anon;
select pg_temp.fails_with('anon cannot list', 'select * from list_script_templates()', 'permission denied');
reset role;

-- ---------- platform admins write ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.fails_with('an owner cannot upsert a template', $q$select platform_upsert_template('x_tpl', 'X', 'fees', (select steps from script_templates where key = 'fees_overdue'))$q$, 'only the Vector team');
select pg_temp.fails_with('an owner cannot upsert a common answer', $q$select platform_upsert_common_answer('x_ans', 'X?', 'Y.')$q$, 'only the Vector team');

select pg_temp.as_user(:'u_p');
select pg_temp.val_is('the platform admin is one', 'select is_platform_admin()::text', 'true');
select pg_temp.val_is('the platform admin lists without a seat', 'select count(*)::text from list_script_templates()', '26');
select pg_temp.val_is('a new template with class and board tags is version 1',
  $q$select platform_upsert_template('fees_class9_cbse', 'Class 9 CBSE fees', 'fees', (select steps from script_templates where key = 'fees_overdue'),
     (select pushbacks from script_templates where key = 'fees_overdue'), 'Parents of 9th', 'For 9th CBSE', array[' 9th ', '9th'], array['cbse'])::text$q$, '1');
select pg_temp.val_is('tags are tidied', $q$select array_to_string(class_labels, ',') || '|' || array_to_string(boards, ',') from script_templates where key = 'fees_class9_cbse'$q$, '9th|CBSE');
select pg_temp.val_is('the same content keeps the version',
  $q$select platform_upsert_template('fees_class9_cbse', 'Class 9 CBSE fees', 'fees', (select steps from script_templates where key = 'fees_overdue'),
     (select pushbacks from script_templates where key = 'fees_overdue'), 'Parents of 9th', 'About changed', array['9th'], array['CBSE'])::text$q$, '1');
select pg_temp.val_is('new steps raise the version',
  $q$select platform_upsert_template('fees_class9_cbse', 'Class 9 CBSE fees', 'fees', (select steps from script_templates where key = 'fees_reminder_polite'),
     '[]', null, null, array['9th'], array['CBSE'])::text$q$, '2');
select pg_temp.fails_with('a call type that is not built in is refused',
  $q$select platform_upsert_template('bad_tpl', 'Bad', 'gym', (select steps from script_templates where key = 'fees_overdue'))$q$, 'built-in type');
select pg_temp.fails_with('an ending with a result of another type is refused',
  $q$select platform_upsert_template('bad_tpl', 'Bad', 'sales', (select steps from script_templates where key = 'fees_overdue'))$q$, 'not a result of this call type');
select pg_temp.fails_with('a bad board is refused',
  $q$select platform_upsert_template('bad_tpl', 'Bad', 'fees', (select steps from script_templates where key = 'fees_overdue'), '[]', null, null, '{}', array['Kerala'])$q$, 'board must be');
select pg_temp.fails_with('a bad key is refused',
  $q$select platform_upsert_template('Bad Key', 'Bad', 'fees', (select steps from script_templates where key = 'fees_overdue'))$q$, 'the key is');
select pg_temp.fails_with('no steps is refused', $q$select platform_upsert_template('bad_tpl', 'Bad', 'fees', '[]')$q$, '1 to 30 steps');
select pg_temp.ok('a template can be switched off',
  $q$select platform_upsert_template('fees_polite_off', 'Off', 'fees', (select steps from script_templates where key = 'fees_overdue'), '[]', p_active => false)$q$);
select pg_temp.val_is('the platform admin sees inactive templates when asked', 'select count(*)::text from list_script_templates(p_include_inactive => true)', '28');

select pg_temp.as_user(:'u_c');
select pg_temp.val_is('a caller sees the new active template, not the inactive one', 'select count(*)::text from list_script_templates()', '27');
select pg_temp.val_is('class 8th does not get the 9th CBSE template', $q$select count(*)::text from list_script_templates(p_class_label => '8th') where key = 'fees_class9_cbse'$q$, '0');
select pg_temp.val_is('class 9th CBSE gets it', $q$select count(*)::text from list_script_templates(p_class_label => '9TH', p_board => 'CBSE') where key = 'fees_class9_cbse'$q$, '1');
select pg_temp.val_is('ICSE does not get it', $q$select count(*)::text from list_script_templates(p_board => 'ICSE') where key = 'fees_class9_cbse'$q$, '0');

select pg_temp.as_user(:'u_p');
select pg_temp.ok('the platform admin adds a common answer',
  $q$select platform_upsert_common_answer('timings', 'What are the class timings?', 'Let me tell you the timings.', null, null, array['Add your batch timings.'], array['all', 'Time'])$q$);
select pg_temp.val_is('tags are lower case', $q$select array_to_string(tags, ',') from common_answers where key = 'timings'$q$, 'all,time');
select pg_temp.ok('and changes one', $q$select platform_upsert_common_answer('how_long', 'How long will this take?', 'Two minutes only.')$q$);
select pg_temp.val_is('the change is saved', $q$select answer from common_answers where key = 'how_long'$q$, 'Two minutes only.');
select pg_temp.fails_with('a result that is not common is refused', $q$select platform_upsert_common_answer('x_ans', 'X?', 'Y.', null, 'paid')$q$, 'common result');

-- ---------- institute fills and my_common_answers ----------
select pg_temp.as_user(:'u_c');
select pg_temp.val_is('a caller gets every active answer', 'select count(*)::text from my_common_answers()', '22');
select pg_temp.val_is('an answer with checks and no fill is not filled', $q$select filled::text from my_common_answers() where key = 'location'$q$, 'false');
select pg_temp.val_is('an answer without checks is filled', $q$select filled::text from my_common_answers() where key = 'who_are_you'$q$, 'true');
select pg_temp.fails_with('a caller cannot fill an answer', $q$select admin_fill_common_answer('location', 'We are at 12 MG Road.')$q$, 'owner or manager');

select pg_temp.as_user(:'u_m');
select pg_temp.val_is('a manager fills the address', $q$select admin_fill_common_answer('location', '  We are at 12 MG Road,   near City Mall. ')::text$q$, 'true');
select pg_temp.fails_with('an answer without checks cannot be filled', $q$select admin_fill_common_answer('who_are_you', 'Hello.')$q$, 'needs no facts');
select pg_temp.fails_with('an unknown answer is refused', $q$select admin_fill_common_answer('nope', 'Hello.')$q$, 'not found');
select pg_temp.fails_with('a long fill is refused', $q$select admin_fill_common_answer('fraud_check', repeat('a', 601))$q$, '600 characters');
select pg_temp.val_is('the fill writes the audit log', $q$select count(*)::text from audit_log where action = 'common_answer.filled' and target = 'location'$q$, '1');

select pg_temp.as_user(:'u_c');
select pg_temp.val_is('the caller now gets the institute answer',
  $q$select filled::text || '|' || answer from my_common_answers() where key = 'location'$q$,
  'true|We are at 12 MG Road, near City Mall.');
select pg_temp.val_is('the columns the caller page reads',
  $q$select array_to_string(proargnames, ',') from pg_proc where proname = 'my_common_answers'$q$,
  'key,label,answer,tags,fallback,result,check,filled');
select pg_temp.val_is('check holds the checks list', $q$select array_length("check", 1)::text from my_common_answers() where key = 'location'$q$, '1');
select pg_temp.val_is('the caller reads the own institute fill row', 'select count(*)::text from institute_answer_fills', '1');
select pg_temp.fails_with('the caller cannot write a fill directly', $q$insert into institute_answer_fills (institute_id, answer_key, answer) values ('e1000000-0000-0000-0000-000000000001', 'discount', 'x')$q$, 'permission denied');

select pg_temp.as_user(:'u_j');
select pg_temp.val_is('another institute does not see the fill', $q$select filled::text from my_common_answers() where key = 'location'$q$, 'false');
select pg_temp.val_is('nor its row', 'select count(*)::text from institute_answer_fills', '0');

select pg_temp.as_user(:'u_o');
select pg_temp.val_is('an owner clears the fill with an empty text', $q$select admin_fill_common_answer('location', '  ')::text$q$, 'false');
select pg_temp.val_is('the answer is not filled again and the global text is back', $q$select filled::text || '|' || answer from my_common_answers() where key = 'location'$q$,
  'false|Let me tell you the address. I can also send the location on WhatsApp.');

select pg_temp.as_user(:'u_p');
select pg_temp.ok('the platform admin switches an answer off', $q$select platform_upsert_common_answer('timings', 'What are the class timings?', 'Let me tell you the timings.', p_active => false)$q$);
select pg_temp.as_user(:'u_c');
select pg_temp.val_is('a switched-off answer is not returned', $q$select count(*)::text from my_common_answers() where key = 'timings'$q$, '0');

-- ---------- inviting an Accounts seat (Callers tab -> seat-admin -> invite_seat) ----------
reset role;
update institutes set seat_limit = 5 where id = :'inst_i';
create temp table inv (id uuid);
grant all on inv to authenticated;
select pg_temp.as_user(:'u_m');
set role authenticated;
select pg_temp.fails_with('a manager cannot invite an accounts seat', format($q$select invite_seat(%L, 'acc@i.test', 'Fees office', 'accounts')$q$, :'inst_i'), 'only an owner');
select pg_temp.ok('a manager invites a caller', format($q$select invite_seat(%L, 'rep9@i.test', 'Rep 9', 'rep')$q$, :'inst_i'));
select pg_temp.as_user(:'u_c');
select pg_temp.fails_with('a caller cannot invite', format($q$select invite_seat(%L, 'acc@i.test', 'Fees office', 'accounts')$q$, :'inst_i'), 'only an admin');
select pg_temp.as_user(:'u_o');
select pg_temp.ok('the owner invites an accounts seat', format($q$insert into inv select invite_seat(%L, 'Acc@I.test', 'Fees office', 'accounts')$q$, :'inst_i'));
select pg_temp.val_is('it is an accounts seat, invited',
  $q$select s.role || ':' || s.admin_kind || ':' || s.status || ':' || s.access_role || ':' || s.invite_email from seats s join inv on inv.id = s.id$q$,
  'accounts:accounts:invited:accounts:acc@i.test');
select pg_temp.fails_with('the seat limit holds for accounts seats too', format($q$select invite_seat(%L, 'acc2@i.test', 'Fees office 2', 'accounts')$q$, :'inst_i'), 'seats are in use');
select pg_temp.fails_with('an unknown role is refused', format($q$select invite_seat(%L, 'x@i.test', 'X', 'boss')$q$, :'inst_i'), 'role must be');

reset role;
select test, passed, detail from results where not passed;
select count(*) filter (where passed) || '|' || count(*) filter (where not passed) from results;
