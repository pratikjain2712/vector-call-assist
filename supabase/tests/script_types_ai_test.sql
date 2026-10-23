-- Tests for 20261024100022_script_types_ai.sql: script types, ending results, pushback answers, "Check this"
-- marks blocking publishing, the Scripts add-on on saving, campaigns using only a live script of their type,
-- the Scripts tab list, and the AI request log with its monthly limit. Run after every migration on a scratch
-- database with supabase/tests/stub_auth.sql. The last line prints passed and failed counts: expect failed = 0.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid, mail text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''), 'email', mail)::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon, service_role;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
-- Fails, and the error message contains want (so the right check refused it).
create or replace function pg_temp.fails_with(name text, sql text, want text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, position(want in sqlerrm) > 0, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;

-- A fees script: open -> (Yes) paid ending, (Later) promise ending, (Stop) do-not-call ending.
create or replace function pg_temp.steps(paid_result text, mark boolean) returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('id', 'open', 'start', true, 'say', jsonb_build_array('Hello {name}.'),
      'opts', jsonb_build_array(jsonb_build_object('label', 'Yes', 'to', 'paid'),
                                jsonb_build_object('label', 'Later', 'to', 'later'),
                                jsonb_build_object('label', 'Stop', 'to', 'stop')))
      || case when mark then jsonb_build_object('check', jsonb_build_array('Is the fee ₹18,000?')) else '{}'::jsonb end,
    jsonb_build_object('id', 'paid', 'title', 'Paid', 'say', jsonb_build_array('Thank you.'), 'opts', '[]'::jsonb)
      || case when paid_result is null then '{}'::jsonb else jsonb_build_object('result', paid_result) end,
    jsonb_build_object('id', 'later', 'title', 'Will pay later', 'say', jsonb_build_array('Thank you.'), 'result', 'will_pay_on'),
    jsonb_build_object('id', 'stop', 'title', 'Do not call', 'say', jsonb_build_array('Sorry to trouble you.'), 'result', 'do_not_call'))
$$;
create or replace function pg_temp.pbs() returns jsonb language sql immutable as $$
  select '[{"label":"We already paid","answer":"Thank you. I will check with the office."}]'::jsonb
$$;

\set inst_p 'a2200000-0000-0000-0000-000000000001'
\set inst_q 'a2200000-0000-0000-0000-000000000002'
\set u_o 'b2200000-0000-0000-0000-000000000001'
\set u_r 'b2200000-0000-0000-0000-000000000002'
\set u_q 'b2200000-0000-0000-0000-000000000003'
\set s_o 'c2200000-0000-0000-0000-000000000001'
\set s_r 'c2200000-0000-0000-0000-000000000002'
\set s_q 'c2200000-0000-0000-0000-000000000003'
\set t_q 'd2200000-0000-0000-0000-000000000001'
\set sc_legacy 'e2200000-0000-0000-0000-000000000001'

-- ---------- fixtures ----------
-- Inst P (active, Scripts and AI drafts): owner O, caller R. Inst Q (active, no add-ons): owner Q, own type t_q.
-- sc_legacy: a script of P saved before 0022 (no type) with a published version.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'owner@p.test', now()), (:'u_r', 'r@p.test', now()), (:'u_q', 'owner@q.test', now());
insert into institutes (id, name, status) values (:'inst_p', 'Inst P', 'active'), (:'inst_q', 'Inst Q', 'active');
update institutes set features = array['scripts', 'ai_drafts'] where id = :'inst_p';
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_o', :'inst_p', :'u_o', 'Owner', 'admin', 'owner', 'active'),
 (:'s_r', :'inst_p', :'u_r', 'Caller R', 'rep', null, 'active'),
 (:'s_q', :'inst_q', :'u_q', 'Owner Q', 'admin', 'owner', 'active');
insert into call_types (id, institute_id, key, label) values (:'t_q', :'inst_q', 'q_only', 'Q only');
insert into scripts (id, institute_id, name) values (:'sc_legacy', :'inst_p', 'Old script');
insert into script_versions (script_id, institute_id, version, steps, published)
  values (:'sc_legacy', :'inst_p', 1, pg_temp.steps('paid', false), true);
select id as t_fees from call_types where key = 'fees' and institute_id is null \gset
select id as t_sales from call_types where key = 'sales' and institute_id is null \gset

-- ---------- saving typed scripts ----------
select pg_temp.as_user(:'u_o', 'owner@p.test');
set role authenticated;
select pg_temp.ok('admin saves a typed draft with pushbacks',
  format($q$select admin_save_script(null, 'Fees reminder', %L, pg_temp.steps('paid', true), pg_temp.pbs(), '', false)$q$, :'t_fees'));
reset role;
select id as sc_fees from scripts where name = 'Fees reminder' \gset
set role authenticated;
select pg_temp.val_is('the script has the fees type', format($q$select call_type_id::text from scripts where id=%L$q$, :'sc_fees'), :'t_fees');
select pg_temp.val_is('the version keeps the pushbacks', format($q$select pushbacks->0->>'label' from script_versions where script_id=%L$q$, :'sc_fees'), 'We already paid');
select pg_temp.val_is('the draft keeps its "Check this" mark', format($q$select steps->0->'check'->>0 from script_versions where script_id=%L$q$, :'sc_fees'), 'Is the fee ₹18,000?');
select pg_temp.fails_with('a "Check this" mark blocks publishing',
  format($q$select admin_save_script(%L, 'Fees reminder', null, pg_temp.steps('paid', true), null, 'go', true)$q$, :'sc_fees'), 'Check this');
select pg_temp.fails_with('a mark on a pushback blocks publishing too',
  format($q$select admin_save_script(%L, 'Fees reminder', null, pg_temp.steps('paid', false), '[{"label":"Late fee?","answer":"It is ₹500.","check":["Is the late fee ₹500?"]}]', 'go', true)$q$, :'sc_fees'), 'Check this');
select pg_temp.fails_with('an ending without a result blocks publishing',
  format($q$select admin_save_script(%L, 'Fees reminder', null, pg_temp.steps(null, false), null, 'go', true)$q$, :'sc_fees'), 'not linked to a result');
select pg_temp.fails_with('an ending with a result of another type blocks publishing',
  format($q$select admin_save_script(%L, 'Fees reminder', null, pg_temp.steps('joined', false), null, 'go', true)$q$, :'sc_fees'), 'not a result of this call type');
select pg_temp.ok('a clean script publishes',
  format($q$select admin_save_script(%L, 'Fees reminder', null, pg_temp.steps('paid', false), null, 'first live', true)$q$, :'sc_fees'));
select pg_temp.val_is('null pushbacks keep the latest version''s', format($q$select pushbacks->0->>'label' from script_versions where script_id=%L and published$q$, :'sc_fees'), 'We already paid');
select pg_temp.val_is('the result is v2 and live', format($q$select version::text from script_versions where script_id=%L and published$q$, :'sc_fees'), '2');
select pg_temp.fails('the pushbacks of a published version cannot change',
  format($q$update script_versions set pushbacks='[]' where script_id=%L and published$q$, :'sc_fees'));
select pg_temp.ok('admin_save_script returns the ids',
  format($q$select (admin_save_script(%L, 'Fees reminder', null, pg_temp.steps('paid', false), pg_temp.pbs(), '', false)->>'version')::int = 3$q$, :'sc_fees'));
select pg_temp.fails_with('publishing an untyped script is refused',
  $q$select admin_save_script(null, 'No type', null, pg_temp.steps('paid', false), null, '', true)$q$, 'choose the call type');
select pg_temp.ok('an untyped draft is fine', $q$select admin_save_script(null, 'No type', null, pg_temp.steps('paid', false), null, '', false)$q$);
select pg_temp.fails_with('a type of another institute is refused',
  format($q$select admin_save_script(null, 'Q type', %L, pg_temp.steps('paid', false), null, '', false)$q$, :'t_q'), 'not available');

-- pushback shape
select pg_temp.fails_with('pushbacks must be a list', $q$select admin_save_script(null, 'P1', null, '[]', '{"a":1}', '', false)$q$, 'must be a list');
select pg_temp.fails_with('a pushback needs an answer', $q$select admin_save_script(null, 'P2', null, '[]', '[{"label":"Too costly"}]', '', false)$q$, 'needs an answer');
select pg_temp.fails_with('a pushback needs a label', $q$select admin_save_script(null, 'P3', null, '[]', '[{"label":"  ","answer":"x"}]', '', false)$q$, 'label of 1 to 60');
select pg_temp.fails_with('two pushbacks with one label are refused', $q$select admin_save_script(null, 'P4', null, '[]', '[{"label":"No time","answer":"a"},{"label":"no time","answer":"b"}]', '', false)$q$, 'two pushbacks');
select pg_temp.fails('13 pushbacks are refused',
  $q$select admin_save_script(null, 'P5', null, '[]', (select jsonb_agg(jsonb_build_object('label','L'||g,'answer','A')) from generate_series(1,13) g), '', false)$q$);

-- the older function keeps working, keeps the type and the pushbacks, and still respects marks
select pg_temp.ok('admin_save_script_version still saves', format($q$select admin_save_script_version(%L, 'Fees reminder', pg_temp.steps('paid', false), '', false)$q$, :'sc_fees'));
select pg_temp.val_is('the older function keeps the type', format($q$select call_type_id::text from scripts where id=%L$q$, :'sc_fees'), :'t_fees');
select pg_temp.val_is('the older function keeps the pushbacks', format($q$select pushbacks->0->>'label' from script_versions where script_id=%L order by version desc limit 1$q$, :'sc_fees'), 'We already paid');
select pg_temp.fails_with('the older function refuses to publish marks', format($q$select admin_save_script_version(%L, 'Old script', pg_temp.steps('paid', true), '', true)$q$, :'sc_legacy'), 'Check this');
select pg_temp.ok('the older function can still publish an untyped script', format($q$select admin_save_script_version(%L, 'Old script', pg_temp.steps('paid', false), 'v2', true)$q$, :'sc_legacy'));

-- ---------- who may save ----------
select pg_temp.as_user(:'u_r', 'r@p.test');
select pg_temp.fails_with('a caller cannot save', $q$select admin_save_script(null, 'Mine', null, '[]', null, '', false)$q$, 'only an admin');
select pg_temp.fails_with('a caller cannot list scripts', $q$select count(*) from admin_list_scripts()$q$, 'only an admin');
select pg_temp.as_user(:'u_q', 'owner@q.test');
select pg_temp.fails_with('without the Scripts add-on saving is refused', $q$select admin_save_script(null, 'Q script', null, '[]', null, '', false)$q$, 'add Scripts');
select pg_temp.fails_with('without the add-on the older function refuses too', $q$select admin_save_script_version(null, 'Q script', '[]', '', false)$q$, 'add Scripts');
select pg_temp.fails_with('another institute''s script cannot be saved', format($q$select admin_save_script(%L, 'X', null, '[]', null, '', false)$q$, :'sc_fees'), 'only an admin of this institute');
select pg_temp.val_is('the Q owner lists no scripts of P', $q$select count(*)::text from admin_list_scripts()$q$, '0');

-- ---------- campaigns use a live script of their type ----------
reset role;
select id as sc_untyped from scripts where name = 'No type' \gset
select pg_temp.ok('a fees campaign takes the live fees script',
  format($q$insert into campaigns (id, institute_id, name, call_type_id, script_id) values ('f2200000-0000-0000-0000-000000000001', %L, 'Oct fees', %L, %L)$q$, :'inst_p', :'t_fees', :'sc_fees'));
select pg_temp.fails_with('a sales campaign cannot take the fees script',
  format($q$insert into campaigns (institute_id, name, call_type_id, script_id) values (%L, 'Sales', %L, %L)$q$, :'inst_p', :'t_sales', :'sc_fees'), 'another call type');
select pg_temp.fails_with('changing the campaign type away from its script is refused',
  $q$update campaigns set call_type_id = (select id from call_types where key='sales' and institute_id is null) where id = 'f2200000-0000-0000-0000-000000000001'$q$, 'another call type');
select pg_temp.fails_with('a script without a live version is refused',
  format($q$insert into campaigns (institute_id, name, call_type_id, script_id) values (%L, 'Draft only', %L, %L)$q$, :'inst_p', :'t_fees', :'sc_untyped'), 'no live version');
select pg_temp.ok('an untyped live script (saved before types) is accepted for any type',
  format($q$insert into campaigns (institute_id, name, call_type_id, script_id) values (%L, 'Old sales', %L, %L)$q$, :'inst_p', :'t_sales', :'sc_legacy'));
select pg_temp.fails_with('a script used by a fees campaign cannot become a sales script',
  format($q$update scripts set call_type_id = %L where id = %L$q$, :'t_sales', :'sc_fees'), 'used in a campaign');
select pg_temp.ok('removing the script from a campaign is fine',
  $q$update campaigns set script_id = null where name = 'Old sales'$q$);

-- ---------- the Scripts tab list ----------
-- Calls with the fees script in the fees campaign: one Paid (good), one Says already paid (not good), one old
-- correction (not counted), one 100 days ago (not counted). One legacy call with outcome won on the old script.
insert into call_outcomes (institute_id, seat_id, client_record_id, script_id, script_version, campaign_id, result_key, amount, dialled_at)
  values (:'inst_p', :'s_r', 'l1', :'sc_fees', 2, 'f2200000-0000-0000-0000-000000000001', 'paid', 100, now() - interval '1 day'),
         (:'inst_p', :'s_r', 'l2', :'sc_fees', 2, 'f2200000-0000-0000-0000-000000000001', 'already_paid', null, now() - interval '2 days'),
         (:'inst_p', :'s_r', 'l4', :'sc_fees', 2, 'f2200000-0000-0000-0000-000000000001', 'paid', 100, now() - interval '100 days');
insert into call_outcomes (institute_id, seat_id, client_record_id, script_id, script_version, corrects_id, outcome, dialled_at)
  select :'inst_p', :'s_r', 'l3', :'sc_fees', 2, id, 'won', now() from call_outcomes where client_record_id = 'l2';
insert into call_outcomes (institute_id, seat_id, client_record_id, script_id, script_version, outcome, dialled_at)
  values (:'inst_p', :'s_r', 'l5', :'sc_legacy', 1, 'won', now());
select pg_temp.as_user(:'u_o', 'owner@p.test');
set role authenticated;
select pg_temp.val_is('the list has every script of P', $q$select string_agg(name, ',' order by name) from admin_list_scripts()$q$, 'Fees reminder,No type,Old script');
select pg_temp.val_is('type and versions of the fees script',
  $q$select call_type_key||' live v'||live_version||' latest v'||latest_version from admin_list_scripts() where name='Fees reminder'$q$, 'fees live v2 latest v4');
select pg_temp.val_is('the live version id points at the published version',
  $q$select (live_version_id = (select v.id from script_versions v join scripts s on s.id=v.script_id where s.name='Fees reminder' and v.published))::text from admin_list_scripts() where name='Fees reminder'$q$, 'true');
select pg_temp.val_is('used in names the campaign', $q$select used_in->0->>'name' from admin_list_scripts() where name='Fees reminder'$q$, 'Oct fees');
select pg_temp.val_is('calls in 90 days and good calls', $q$select calls||'/'||good_calls from admin_list_scripts() where name='Fees reminder'$q$, '2/1');
select pg_temp.val_is('an old won call counts as good', $q$select calls||'/'||good_calls from admin_list_scripts() where name='Old script'$q$, '1/1');
select pg_temp.val_is('a draft-only script has no live version', $q$select coalesce(live_version::text,'none')||' '||jsonb_array_length(used_in) from admin_list_scripts() where name='No type'$q$, 'none 0');
reset role;
select pg_temp.as_user(:'u_o', 'owner@p.test');
set role authenticated;
select pg_temp.ok('a marked draft', format($q$select admin_save_script(%L, 'Fees reminder', null, pg_temp.steps('paid', true), null, '', false)$q$, :'sc_fees'));
select pg_temp.val_is('the list counts marks on the latest version', $q$select check_marks::text from admin_list_scripts() where name='Fees reminder'$q$, '1');

-- ---------- AI requests: reserve, finish, limit ----------
reset role;
set role service_role;
select pg_temp.ok('the server reserves a draft', format($q$select ai_reserve_request(%L, %L, 'draft')$q$, :'inst_p', :'s_o'));
select pg_temp.ok('the server finishes it', $q$select ai_finish_request((select max(id) from ai_requests), 'claude-haiku-5-5', 1, 6000, 9000, 0, 5200, 0.0052, true)$q$);
select pg_temp.val_is('the row holds tokens and cost', $q$select model||' '||input_tokens||' '||output_tokens||' '||cache_write_tokens||' '||cost_usd||' '||ok from ai_requests order by id desc limit 1$q$, 'claude-haiku-5-5 6000 9000 5200 0.005200 true');
select pg_temp.ok('a finished row is not changed again', $q$select ai_finish_request((select max(id) from ai_requests), 'x', 1, 1, 1, 1, 1, 9, false)$q$);
select pg_temp.val_is('still ok', $q$select ok::text from ai_requests order by id desc limit 1$q$, 'true');
select pg_temp.fails_with('a seat of another institute is refused', format($q$select ai_reserve_request(%L, %L, 'draft')$q$, :'inst_p', :'s_q'), 'seat not found');
select pg_temp.fails_with('an unknown kind is refused', format($q$select ai_reserve_request(%L, %L, 'chat')$q$, :'inst_p', :'s_o'), 'unknown');
select pg_temp.ok('19 more drafts are reserved', format($q$select count(ai_reserve_request(%L, %L, 'draft')) from generate_series(1, 19)$q$, :'inst_p', :'s_o'));
select pg_temp.fails_with('the 21st draft this month is refused', format($q$select ai_reserve_request(%L, %L, 'draft')$q$, :'inst_p', :'s_o'), 'limit reached');
select pg_temp.ok('Make simpler has its own limit', format($q$select ai_reserve_request(%L, %L, 'simplify')$q$, :'inst_p', :'s_o'));
select pg_temp.ok('a failed request is finished as not ok', $q$select ai_finish_request((select max(id) from ai_requests where kind='draft'), 'claude-haiku-5-5', 2, 100, 0, 0, 0, 0.0001, false)$q$);
select pg_temp.ok('a failed draft does not count: one more is allowed', format($q$select ai_reserve_request(%L, %L, 'draft')$q$, :'inst_p', :'s_o'));
reset role;
update ai_requests set created_at = now() - interval '11 minutes' where id = (select max(id) from ai_requests where kind='draft');
set role service_role;
select pg_temp.ok('a request left running for over 10 minutes stops counting', format($q$select ai_reserve_request(%L, %L, 'draft')$q$, :'inst_p', :'s_o'));
reset role;
update ai_requests set created_at = now() - interval '40 days' where kind = 'draft' and ok;
set role service_role;
select pg_temp.ok('last month''s drafts do not count', format($q$select ai_reserve_request(%L, %L, 'draft')$q$, :'inst_p', :'s_o'));

-- ---------- AI requests: who reads and writes ----------
reset role;
select pg_temp.as_user(:'u_o', 'owner@p.test');
set role authenticated;
select pg_temp.fails('the browser cannot reserve', format($q$select ai_reserve_request(%L, %L, 'draft')$q$, :'inst_p', :'s_o'));
select pg_temp.fails('the browser cannot finish', $q$select ai_finish_request(1, 'x', 1, 1, 1, 1, 1, 0, true)$q$);
select pg_temp.fails('the browser cannot insert a request row', format($q$insert into ai_requests (institute_id, kind) values (%L, 'draft')$q$, :'inst_p'));
select pg_temp.fails('the browser cannot change a request row', $q$update ai_requests set ok = false$q$);
select pg_temp.val_is('the admin reads the institute''s requests', $q$select (count(*) > 20)::text from ai_requests$q$, 'true');
select pg_temp.val_is('usage: drafts used this month and the limit',
  $q$select used||' of '||monthly_limit from admin_ai_usage()$q$, '20 of 20');
select pg_temp.val_is('usage: the month starts on the first', $q$select extract(day from month)::text from admin_ai_usage()$q$, '1');
select pg_temp.val_is('usage: the month''s cost leaves out last month', $q$select cost_usd::text from admin_ai_usage()$q$, '0.0001');
select pg_temp.as_user(:'u_r', 'r@p.test');
select pg_temp.val_is('a caller reads no request rows', $q$select count(*)::text from ai_requests$q$, '0');
select pg_temp.fails_with('a caller cannot see AI usage', $q$select * from admin_ai_usage()$q$, 'only an admin');
select pg_temp.as_user(:'u_q', 'owner@q.test');
select pg_temp.val_is('another institute reads no request rows', $q$select count(*)::text from ai_requests$q$, '0');
select pg_temp.val_is('another institute has its own usage', $q$select used||' of '||monthly_limit from admin_ai_usage()$q$, '0 of 20');
reset role;
set role anon;
select pg_temp.fails('anon cannot see AI usage', $q$select * from admin_ai_usage()$q$);
select pg_temp.fails('anon cannot save scripts', $q$select admin_save_script(null, 'x', null, '[]', null, '', false)$q$);
reset role;

select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
