-- Tests for 20261024100023_admin_home_settings.sql: caller presence, the Home summary (tiles, callers right
-- now, needs attention, campaign progress, money hidden for managers), the Callers list, institute settings,
-- and the admin activity log. Run after every migration on a scratch database with supabase/tests/stub_auth.sql.
-- The last line prints passed and failed counts: expect failed = 0.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;

-- ---------- fixed ids ----------
\set inst_i 'b1111111-0000-0000-0000-000000000001'
\set inst_j 'b2222222-0000-0000-0000-000000000002'
\set u_o 'e9000000-0000-0000-0000-000000000001'
\set u_m 'e9000000-0000-0000-0000-000000000002'
\set u_a 'e9000000-0000-0000-0000-000000000003'
\set u_b 'e9000000-0000-0000-0000-000000000004'
\set u_c 'e9000000-0000-0000-0000-000000000005'
\set u_x 'e9000000-0000-0000-0000-000000000006'
\set u_n 'e9000000-0000-0000-0000-000000000007'
\set s_o 'e1000000-0000-0000-0000-000000000001'
\set s_m 'e1000000-0000-0000-0000-000000000002'
\set s_a 'e1000000-0000-0000-0000-000000000003'
\set s_b 'e1000000-0000-0000-0000-000000000004'
\set s_c 'e1000000-0000-0000-0000-000000000005'
\set s_x 'e2000000-0000-0000-0000-000000000006'
\set k_f 'e3000000-0000-0000-0000-000000000001'
\set k_s 'e3000000-0000-0000-0000-000000000002'
\set k_j 'e3000000-0000-0000-0000-000000000003'
\set sc  'e5000000-0000-0000-0000-000000000001'

-- A time zone where it is about noon now, so "today" and "50 minutes ago" are the same day whenever this runs.
-- Etc/GMT-N is N hours ahead of UTC (the sign is reversed in these names).
select case when k = 0 then 'UTC' when k > 0 then 'Etc/GMT-' || k else 'Etc/GMT+' || (-k) end as tz
from (select (((12 - extract(hour from now() at time zone 'UTC')::int) + 11) % 24 + 24) % 24 - 11 as k) x \gset

-- ---------- fixtures (as the table owner) ----------
-- Inst I (trial, 3 days left): owner O, manager M (no money), callers A, B, C. A fees and a sales campaign.
-- Inst J: owner X and a campaign of its own.
reset role;
insert into auth.users (id, email) values
 (:'u_o', 'o@h.test'), (:'u_m', 'm@h.test'), (:'u_a', 'a@h.test'), (:'u_b', 'b@h.test'),
 (:'u_c', 'c@h.test'), (:'u_x', 'x@h.test'), (:'u_n', 'nobody@h.test');
insert into institutes (id, name, status, seat_limit, trial_ends_at, time_zone) values
 (:'inst_i', 'Inst I', 'trial', 10, now() + interval '2 days 3 hours', :'tz'),
 (:'inst_j', 'Inst J', 'active', 10, null, :'tz');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_m', :'inst_i', :'u_m', 'Manager', 'admin', 'manager', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Caller A', 'rep', null, 'active'),
 (:'s_b', :'inst_i', :'u_b', 'Caller B', 'rep', null, 'active'),
 (:'s_c', :'inst_i', :'u_c', 'Caller C', 'rep', null, 'active'),
 (:'s_x', :'inst_j', :'u_x', 'Owner J', 'admin', 'owner', 'active');
insert into rep_targets (seat_id, institute_id, metric, daily_target) values (:'s_a', :'inst_i', 'calls', 40);
insert into campaigns (id, institute_id, name, call_type_id, status, end_date) values
 (:'k_f', :'inst_i', 'Oct fees', (select id from call_types where key = 'fees' and institute_id is null), 'running', current_date + 7),
 (:'k_s', :'inst_i', 'Sales', (select id from call_types where key = 'sales' and institute_id is null), 'running', null),
 (:'k_j', :'inst_j', 'J fees', (select id from call_types where key = 'fees' and institute_id is null), 'running', null);
insert into campaign_members (campaign_id, seat_id, institute_id) values
 (:'k_f', :'s_a', :'inst_i'), (:'k_s', :'s_a', :'inst_i'), (:'k_s', :'s_b', :'inst_i'), (:'k_f', :'s_c', :'inst_i');
-- Fees leads: one promised for today (₹5,000), one called, one new.
insert into leads (institute_id, campaign_id, name, phone, amount_due, promised_amount, promised_date, status, assigned_seat_id) values
 (:'inst_i', :'k_f', 'P1', '9876500001', 12000, 5000, (now() at time zone :'tz')::date, 'promised', :'s_a'),
 (:'inst_i', :'k_f', 'P2', '9876500002', 8000, null, null, 'done', :'s_a'),
 (:'inst_i', :'k_f', 'P3', '9876500003', 8000, null, null, 'new', :'s_c');
-- A published script whose step "fees" is where many picked-up calls end.
insert into scripts (id, institute_id, name) values (:'sc', :'inst_i', 'Sales v7');
insert into script_versions (script_id, institute_id, version, steps, published) values
 (:'sc', :'inst_i', 1, '[{"id":"hello","title":"Opening"},{"id":"fees","title":"Fees"},{"id":"close","title":"Close"}]', true);

-- Calls today (A): 2 paid fees calls (₹2,000 + ₹3,000), 1 promise (₹5,000), 1 no answer; (B): 10 sales calls
-- with the script, 5 ending at "fees" without a good result, 3 joined at "close", 2 interested at "close".
-- C: one call 50 minutes ago. Yesterday: 3 calls by A, at the same time of day.
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key, amount, promised_date, dialled_at, connected_seconds) values
 (:'inst_i', :'s_a', 'a-1', :'k_f', 'paid', 2000, null, now() - interval '20 minutes', 120),
 (:'inst_i', :'s_a', 'a-2', :'k_f', 'paid_part', 3000, null, now() - interval '18 minutes', 60),
 (:'inst_i', :'s_a', 'a-3', :'k_f', 'will_pay_on', 5000, current_date, now() - interval '16 minutes', 90),
 (:'inst_i', :'s_a', 'a-4', :'k_f', 'no_answer', null, null, now() - interval '14 minutes', 0),
 (:'inst_i', :'s_c', 'c-1', :'k_f', 'no_answer', null, null, now() - interval '50 minutes', 0),
 (:'inst_i', :'s_a', 'y-1', :'k_f', 'no_answer', null, null, now() - interval '1 day 30 minutes', 0),
 (:'inst_i', :'s_a', 'y-2', :'k_f', 'no_answer', null, null, now() - interval '1 day 40 minutes', 0),
 (:'inst_i', :'s_a', 'y-3', :'k_f', 'no_answer', null, null, now() - interval '1 day 50 minutes', 0);
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key, result_reason, script_id, reached_step, dialled_at, connected_seconds)
select :'inst_i', :'s_b', 'b-' || g, :'k_s',
       case when g <= 5 then 'not_interested' when g <= 8 then 'joined' else 'interested' end,
       case when g <= 5 then 'fees' end,
       :'sc', case when g <= 5 then 'fees' else 'close' end,
       now() - make_interval(mins => 30 - g), 100
from generate_series(1, 10) g;
-- A correction: B's call b-10 was really "joined" (counts once, with the corrected result).
insert into call_outcomes (institute_id, seat_id, client_record_id, corrects_id, campaign_id, result_key, script_id, reached_step, dialled_at, connected_seconds)
select :'inst_i', :'s_b', 'b-10-fix', id, :'k_s', 'joined', :'sc', 'close', dialled_at, 100
from call_outcomes where client_record_id = 'b-10';
-- Inst J: one call, never seen by inst I.
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, outcome, dialled_at) values
 (:'inst_j', :'s_x', 'x-1', :'k_j', 'answered', now());

-- ---------- presence ----------
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.ok('a caller reports being on a call', $q$select report_presence(true, true)$q$);
select pg_temp.as_user(:'u_b');
select pg_temp.ok('a caller reports the phone offline', $q$select report_presence(false, false)$q$);
select pg_temp.as_user(:'u_n');
select pg_temp.fails('a login without a seat cannot report presence', $q$select report_presence(false, true)$q$);
select pg_temp.as_user(:'u_a');
select pg_temp.fails('the browser cannot read presence rows', $q$select count(*) from seat_presence$q$);
select pg_temp.fails('a caller cannot read the home summary', $q$select admin_home_summary('today', null)$q$);
select pg_temp.fails('a caller cannot read the callers list', format($q$select count(*) from admin_callers(%L)$q$, :'inst_i'));
select pg_temp.fails('a caller cannot read the activity log', $q$select count(*) from admin_audit_log(25, 0)$q$);
select pg_temp.fails('a caller cannot read institute settings', $q$select admin_institute_settings()$q$);
reset role;
select pg_temp.val_is('presence keeps the phone offline time', format($q$select (phone_offline_since is not null)::text from seat_presence where seat_id = %L$q$, :'s_b'), 'true');

-- ---------- Home as the owner ----------
set role authenticated;
select pg_temp.as_user(:'u_o');
create temp table h as select admin_home_summary('today', null) as j;
select pg_temp.val_is('home: calls today (corrections not counted twice)', $q$select j->'tiles'->>'calls' from h$q$, '15');
select pg_temp.val_is('home: calls at this time yesterday', $q$select j->'tiles'->>'calls_before' from h$q$, '3');
select pg_temp.val_is('home: picked up', $q$select j->'tiles'->>'picked_up' from h$q$, '13');
select pg_temp.val_is('home: talk seconds', $q$select j->'tiles'->>'talk_seconds' from h$q$, '1270');
select pg_temp.val_is('home: sales joined (with the correction)', $q$select j->'tiles'->>'joined' from h$q$, '4');
select pg_temp.val_is('home: sales interested', $q$select j->'tiles'->>'interested' from h$q$, '1');
select pg_temp.val_is('home: paid calls', $q$select j->'tiles'->>'paid_calls' from h$q$, '2');
select pg_temp.val_is('home: owner sees paid amount', $q$select (j->'tiles'->>'paid_amount')::numeric::int::text from h$q$, '5000');
select pg_temp.val_is('home: owner sees promised amount', $q$select (j->'tiles'->>'promised_amount')::numeric::int::text from h$q$, '5000');
select pg_temp.val_is('home: money not hidden for the owner', $q$select j->>'money_hidden' from h$q$, 'false');
select pg_temp.val_is('home: has sales and fees tiles', $q$select (j->'tiles'->>'has_sales') || (j->'tiles'->>'has_fees') from h$q$, 'truetrue');
select pg_temp.val_is('home: three callers listed', $q$select jsonb_array_length(j->'callers')::text from h$q$, '3');
select pg_temp.val_is('home: caller A is on a call', $q$select c->'now'->>'status' from h, jsonb_array_elements(j->'callers') c where c->>'label' = 'Caller A'$q$, 'on_call');
select pg_temp.val_is('home: caller A target', $q$select c->>'target' from h, jsonb_array_elements(j->'callers') c where c->>'label' = 'Caller A'$q$, '40');
select pg_temp.val_is('home: caller A on two campaigns', $q$select jsonb_array_length(c->'campaigns')::text from h, jsonb_array_elements(j->'callers') c where c->>'label' = 'Caller A'$q$, '2');
select pg_temp.val_is('home: caller A results (no common results)', $q$select c->'results'->0->>'label' from h, jsonb_array_elements(j->'callers') c where c->>'label' = 'Caller A'$q$, 'Paid');
select pg_temp.val_is('home: caller B phone offline', $q$select c->'now'->>'status' from h, jsonb_array_elements(j->'callers') c where c->>'label' = 'Caller B'$q$, 'phone_offline');
select pg_temp.val_is('home: caller B top result', $q$select c->'results'->0->>'label' || ':' || (c->'results'->0->>'count') from h, jsonb_array_elements(j->'callers') c where c->>'label' = 'Caller B'$q$, 'Not interested:5');
select pg_temp.val_is('home: caller C idle 45 min or more', $q$select ((c->'now'->>'idle_minutes')::int >= 45)::text || (c->'now'->>'status') from h, jsonb_array_elements(j->'callers') c where c->>'label' = 'Caller C'$q$, 'trueidle');
select pg_temp.val_is('home: promises due today', $q$select (j->'promises_due_today'->>'count') || ':' || ((j->'promises_due_today'->>'amount')::numeric::int) from h$q$, '1:5000');
select pg_temp.val_is('home: script step where calls end', $q$select (j->'script_ends'->0->>'step_label') || ':' || (j->'script_ends'->0->>'share') from h$q$, 'Fees:0.500');
select pg_temp.val_is('home: two running campaigns', $q$select jsonb_array_length(j->'campaigns')::text from h$q$, '2');
select pg_temp.val_is('home: fees campaign progress', $q$select (c->>'leads_called') || ' of ' || (c->>'leads_total') from h, jsonb_array_elements(j->'campaigns') c where c->>'name' = 'Oct fees'$q$, '2 of 3');
select pg_temp.val_is('home: campaign choices are this institute''s', $q$select jsonb_array_length(j->'campaign_choices')::text from h$q$, '2');
select pg_temp.val_is('home: one campaign only', format($q$select admin_home_summary('today', %L)->'tiles'->>'calls'$q$, :'k_f'), '5');
select pg_temp.val_is('home: one campaign, its callers only', format($q$select jsonb_array_length(admin_home_summary('today', %L)->'callers')::text$q$, :'k_f'), '2');
select pg_temp.val_is('home: one campaign, no script ends from another', format($q$select jsonb_array_length(admin_home_summary('today', %L)->'script_ends')::text$q$, :'k_f'), '0');
select pg_temp.val_is('home: yesterday', $q$select admin_home_summary('yesterday', null)->'tiles'->>'calls'$q$, '3');
select pg_temp.val_is('home: this week has today', $q$select ((admin_home_summary('week', null)->'tiles'->>'calls')::int >= 15)::text$q$, 'true');
select pg_temp.fails('home: an unknown day is refused', $q$select admin_home_summary('month', null)$q$);
select pg_temp.fails('home: another institute''s campaign is refused', format($q$select admin_home_summary('today', %L)$q$, :'k_j'));

-- ---------- Home as a manager without money ----------
select pg_temp.as_user(:'u_m');
create temp table hm as select admin_home_summary('today', null) as j;
select pg_temp.val_is('manager: counts still shown', $q$select j->'tiles'->>'paid_calls' from hm$q$, '2');
select pg_temp.val_is('manager: paid amount hidden', $q$select coalesce(j->'tiles'->>'paid_amount', 'null') from hm$q$, 'null');
select pg_temp.val_is('manager: promised amount hidden', $q$select coalesce(j->'tiles'->>'promised_amount', 'null') from hm$q$, 'null');
select pg_temp.val_is('manager: promise total hidden, count shown', $q$select (j->'promises_due_today'->>'count') || ':' || coalesce(j->'promises_due_today'->>'amount', 'null') from hm$q$, '1:null');
select pg_temp.val_is('manager: money_hidden', $q$select j->>'money_hidden' from hm$q$, 'true');

-- Hide money everywhere hides it from the owner too.
select pg_temp.as_user(:'u_o');
select admin_set_hide_money(true);
select pg_temp.val_is('hide money: owner sees no amount', $q$select coalesce(admin_home_summary('today', null)->'tiles'->>'paid_amount', 'null')$q$, 'null');
select admin_set_hide_money(false);

-- Without the Scripts add-on there are no script step alerts.
reset role;
update institutes set status = 'active', features = '{}' where id = :'inst_i';
set role authenticated;
select pg_temp.val_is('no scripts add-on: no script step alerts', $q$select jsonb_array_length(admin_home_summary('today', null)->'script_ends')::text$q$, '0');
reset role;
update institutes set status = 'trial' where id = :'inst_i';
set role authenticated;

-- Another institute sees only its own numbers.
select pg_temp.as_user(:'u_x');
select pg_temp.val_is('other institute: its own calls only', $q$select admin_home_summary('today', null)->'tiles'->>'calls'$q$, '1');
select pg_temp.fails('other institute: cannot list our callers', format($q$select count(*) from admin_callers(%L)$q$, :'inst_i'));

-- ---------- Callers ----------
select pg_temp.as_user(:'u_m');
select pg_temp.val_is('callers: every seat listed', format($q$select count(*)::text from admin_callers(%L)$q$, :'inst_i'), '5');
select pg_temp.val_is('callers: roles', format($q$select string_agg(access_role, ',' order by label) from admin_callers(%L)$q$, :'inst_i'), 'caller,caller,caller,manager,owner');
select pg_temp.val_is('callers: campaigns of caller A', format($q$select jsonb_array_length(campaigns)::text from admin_callers(%L) where label = 'Caller A'$q$, :'inst_i'), '2');
select pg_temp.val_is('callers: calls today of caller A', format($q$select calls_today::text || '/' || calls_target from admin_callers(%L) where label = 'Caller A'$q$, :'inst_i'), '4/40');
select pg_temp.val_is('callers: now status', format($q$select now_status->>'status' from admin_callers(%L) where label = 'Caller B'$q$, :'inst_i'), 'phone_offline');

-- ---------- settings ----------
select pg_temp.val_is('settings: manager is not an owner', $q$select admin_institute_settings()->>'is_owner'$q$, 'false');
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('settings: owner', $q$select admin_institute_settings()->>'is_owner'$q$, 'true');
select pg_temp.val_is('settings: trial days left', $q$select admin_institute_settings()->>'trial_days_left'$q$, '3');
select pg_temp.val_is('settings: trial has every add-on', $q$select admin_institute_settings()->>'features'$q$, '["scripts", "ai_drafts"]');
select pg_temp.val_is('settings: seats used', $q$select admin_institute_settings()->>'seats_used'$q$, '5');
select pg_temp.ok('settings: owner renames and sets the time zone', $q$select admin_set_institute('Inst I New', 'Asia/Kolkata')$q$);
select pg_temp.val_is('settings: saved', $q$select (admin_institute_settings()->>'name') || '|' || (admin_institute_settings()->>'time_zone')$q$, 'Inst I New|Asia/Kolkata');
select pg_temp.ok('settings: nothing changed writes nothing', $q$select admin_set_institute('Inst I New', null)$q$);
select pg_temp.fails('settings: unknown time zone refused', $q$select admin_set_institute(null, 'Mars/Base')$q$);
select pg_temp.fails('settings: short name refused', $q$select admin_set_institute('X', null)$q$);
select pg_temp.fails('settings: the browser cannot set the time zone directly', format($q$update institutes set time_zone = 'UTC' where id = %L$q$, :'inst_i'));
select pg_temp.as_user(:'u_m');
select pg_temp.fails('settings: a manager cannot rename', $q$select admin_set_institute('Inst Manager', null)$q$);

-- ---------- activity log ----------
select pg_temp.as_user(:'u_o');
select admin_set_seat_role(:'s_b', 'manager');
select admin_set_money_access(:'s_b', true);
select pg_temp.val_is('log: newest first, with the seat label', $q$select action || '|' || target_label from admin_audit_log(25, 0) limit 1$q$, 'money.access_given|Caller B');
select pg_temp.val_is('log: the rest of the target', $q$select target_rest from admin_audit_log(25, 0) where action = 'seat.role_set'$q$, ':manager');
select pg_temp.val_is('log: who did it', $q$select actor_label from admin_audit_log(25, 0) limit 1$q$, 'Owner');
select pg_temp.val_is('log: total rows (hide, show, rename, role, money)', $q$select max(total_rows)::text from admin_audit_log(25, 0)$q$, '5');
select pg_temp.val_is('log: a page of 2', $q$select count(*)::text from admin_audit_log(2, 0)$q$, '2');
select pg_temp.val_is('log: the last page', $q$select count(*)::text from admin_audit_log(2, 4)$q$, '1');
select pg_temp.val_is('log: institute change target', $q$select target from admin_audit_log(25, 0) where action = 'institute.changed'$q$, 'name,time_zone');
select pg_temp.fails('log: a page of 0 is refused', $q$select count(*) from admin_audit_log(0, 0)$q$);
select pg_temp.fails('log: a page of 101 is refused', $q$select count(*) from admin_audit_log(101, 0)$q$);
select pg_temp.as_user(:'u_x');
select pg_temp.val_is('log: another institute sees none of ours', $q$select count(*)::text from admin_audit_log(25, 0)$q$, '0');
select pg_temp.as_user(:'u_m');
select pg_temp.val_is('log: a manager reads it', $q$select (count(*) > 0)::text from admin_audit_log(25, 0)$q$, 'true');

-- anon gets nothing.
reset role;
set role anon;
select pg_temp.fails('anon: no home summary', $q$select admin_home_summary('today', null)$q$);
select pg_temp.fails('anon: no presence', $q$select report_presence(false, true)$q$);
reset role;

select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
