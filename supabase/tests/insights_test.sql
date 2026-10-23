-- Tests for 20261024100025_insights.sql: the Insights reports (forecast inputs, compare, best time, where
-- calls end, promises kept, coaching) and writes (call hours, apply plan, goal). Checks admin only, money
-- rules (counts only without money access), the Scripts add-on and corrections. Expect failed = 0.
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

\set inst_i 'e1000000-0000-0000-0000-000000000001'
\set inst_j 'e1000000-0000-0000-0000-000000000002'
\set u_o 'e2000000-0000-0000-0000-000000000001'
\set u_m 'e2000000-0000-0000-0000-000000000002'
\set u_a 'e2000000-0000-0000-0000-000000000003'
\set u_b 'e2000000-0000-0000-0000-000000000004'
\set u_x 'e2000000-0000-0000-0000-000000000005'
\set s_o 'e3000000-0000-0000-0000-000000000001'
\set s_m 'e3000000-0000-0000-0000-000000000002'
\set s_a 'e3000000-0000-0000-0000-000000000003'
\set s_b 'e3000000-0000-0000-0000-000000000004'
\set s_x 'e3000000-0000-0000-0000-000000000005'
\set k_f 'e4000000-0000-0000-0000-000000000001'
\set k_s 'e4000000-0000-0000-0000-000000000002'
\set k_j 'e4000000-0000-0000-0000-000000000003'
\set k_c 'e4000000-0000-0000-0000-000000000004'
\set scr 'e5000000-0000-0000-0000-000000000001'
\set l1 'e6000000-0000-0000-0000-000000000001'
\set l2 'e6000000-0000-0000-0000-000000000002'
\set l3 'e6000000-0000-0000-0000-000000000003'
\set l4 'e6000000-0000-0000-0000-000000000004'
\set l5 'e6000000-0000-0000-0000-000000000005'

-- ---------- fixtures (as the table owner) ----------
-- Inst I (paying, Scripts add-on): owner O, manager M (no money), callers A and B. Fees campaign F with a
-- 3-step script, sales campaign S, closed campaign C. Inst J (paying, no add-ons): owner X, campaign J.
insert into auth.users (id, email) values
 (:'u_o', 'o@i.test'), (:'u_m', 'm@i.test'), (:'u_a', 'a@i.test'), (:'u_b', 'b@i.test'), (:'u_x', 'x@j.test');
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 10), (:'inst_j', 'Inst J', 'active', 10);
update institutes set features = array['scripts'] where id = :'inst_i';
insert into seats (id, institute_id, user_id, label, role, status) values (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_m', :'inst_i', :'u_m', 'Manager', 'admin', 'manager', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Asha', 'rep', null, 'active'),
 (:'s_b', :'inst_i', :'u_b', 'Bilal', 'rep', null, 'active'),
 (:'s_x', :'inst_j', :'u_x', 'Owner J', 'admin', 'owner', 'active');
insert into scripts (id, institute_id, name) values (:'scr', :'inst_i', 'Fees script');
insert into script_versions (script_id, institute_id, version, steps, published) values
 (:'scr', :'inst_i', 1, '[{"id":"open","title":"Opening","start":true,"say":["Hi"],"opts":[{"label":"Ok","to":"fees"}]},
                         {"id":"fees","title":"Fees","say":["Fee"],"opts":[{"label":"Ok","to":"close"}]},
                         {"id":"close","title":"Close","say":["Bye"]}]', true);
insert into campaigns (id, institute_id, name, call_type_id, status, script_id, start_date, end_date) values
 (:'k_f', :'inst_i', 'Oct fees', (select id from call_types where key='fees' and institute_id is null), 'running', :'scr',
  current_date - 7, current_date + 7),
 (:'k_s', :'inst_i', 'Sales', (select id from call_types where key='sales' and institute_id is null), 'running', null,
  current_date - 3, current_date + 10),
 (:'k_c', :'inst_i', 'Old fees', (select id from call_types where key='fees' and institute_id is null), 'closed', null, null, null),
 (:'k_j', :'inst_j', 'J fees', (select id from call_types where key='fees' and institute_id is null), 'running', null, null, null);
insert into campaign_members (campaign_id, seat_id, institute_id) values
 (:'k_f', :'s_a', :'inst_i'), (:'k_f', :'s_b', :'inst_i'), (:'k_s', :'s_a', :'inst_i');
insert into leads (id, institute_id, campaign_id, name, phone, amount_due, assigned_seat_id) values
 (:'l1', :'inst_i', :'k_f', 'P1', '9000000001', 10000, :'s_a'),
 (:'l2', :'inst_i', :'k_f', 'P2', '9000000002', 20000, :'s_a'),
 (:'l3', :'inst_i', :'k_f', 'P3', '9000000003', 30000, :'s_b'),
 (:'l4', :'inst_i', :'k_f', 'P4', '9000000004', 40000, :'s_b'),
 (:'l5', :'inst_i', :'k_s', 'S1', '9000000005', null, :'s_a');
-- Fees calls (UTC; tests read with p_tz 'UTC'):
--  l1: promise 6 days ago for 2 days ago (4 days away), paid 3 days ago (kept); 5000 promised, 5000 paid
--  l2: promise 6 days ago for 4 days ago (2 days away), never paid (broken)
--  l3: no answer, then paid 9000 yesterday at 19:00 (evening)
--  l4: promise today for 20 days ahead (waiting), 12000
--  plus a B call to l3 that is a correction chain: busy corrected to no_answer
insert into call_outcomes (id, institute_id, seat_id, client_record_id, campaign_id, lead_id, result_key, promised_date, amount,
                           dialled_at, connected_seconds, reached_step, step_times) values
 ('e7000000-0000-0000-0000-000000000001', :'inst_i', :'s_a', 'f1', :'k_f', :'l1', 'will_pay_on', current_date - 2, 5000,
  (current_date - 6)::timestamp at time zone 'UTC' + interval '11 hours', 120, 'fees', '{"open":20,"fees":60}'),
 ('e7000000-0000-0000-0000-000000000002', :'inst_i', :'s_a', 'f2', :'k_f', :'l1', 'paid', null, 5000,
  (current_date - 3)::timestamp at time zone 'UTC' + interval '11 hours', 60, 'close', '{"open":10,"fees":30,"close":5}'),
 ('e7000000-0000-0000-0000-000000000003', :'inst_i', :'s_a', 'f3', :'k_f', :'l2', 'will_pay_on', current_date - 4, 7000,
  (current_date - 6)::timestamp at time zone 'UTC' + interval '12 hours', 90, 'fees', '{"open":40,"fees":50}'),
 ('e7000000-0000-0000-0000-000000000004', :'inst_i', :'s_b', 'f4', :'k_f', :'l3', 'no_answer', null, null,
  (current_date - 2)::timestamp at time zone 'UTC' + interval '11 hours', 0, null, null),
 ('e7000000-0000-0000-0000-000000000005', :'inst_i', :'s_b', 'f5', :'k_f', :'l3', 'paid', null, 9000,
  (current_date - 1)::timestamp at time zone 'UTC' + interval '19 hours', 80, 'close', '{"fees":20,"close":10}'),
 ('e7000000-0000-0000-0000-000000000006', :'inst_i', :'s_b', 'f6', :'k_f', :'l4', 'will_pay_on', current_date + 20, 12000,
  (current_date)::timestamp at time zone 'UTC' + interval '1 hours', 70, 'fees', '{"open":15,"fees":25}'),
 ('e7000000-0000-0000-0000-000000000007', :'inst_i', :'s_b', 'f7', :'k_f', :'l3', 'busy', null, null,
  (current_date - 2)::timestamp at time zone 'UTC' + interval '12 hours', 0, null, null);
insert into call_outcomes (institute_id, seat_id, client_record_id, corrects_id, campaign_id, lead_id, result_key, outcome) values
 (:'inst_i', :'s_b', 'f7-fix', 'e7000000-0000-0000-0000-000000000007', :'k_f', :'l3', 'no_answer', 'no_answer');
-- Sales: one joined, one not interested.
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, lead_id, result_key, result_reason, dialled_at) values
 (:'inst_i', :'s_a', 's1', :'k_s', :'l5', 'joined', null, now() - interval '1 day'),
 (:'inst_i', :'s_a', 's2', :'k_s', :'l5', 'not_interested', 'Price', now() - interval '2 days');
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, result_key, dialled_at) values
 (:'inst_j', :'s_x', 'j1', :'k_j', 'no_answer', now());

-- ---------- owner: money allowed ----------
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('setup: owner sees money', format($q$select admin_insights_setup(%L)->>'money'$q$, :'inst_i'), 'true');
select pg_temp.val_is('setup: lists the institute''s 3 campaigns', format($q$select jsonb_array_length(admin_insights_setup(%L)->'campaigns')::text$q$, :'inst_i'), '3');
select pg_temp.val_is('setup: running campaigns first', format($q$select admin_insights_setup(%L)->'campaigns'->2->>'status'$q$, :'inst_i'), 'closed');
select pg_temp.val_is('setup: callers on the fees campaign', format($q$select c->>'callers' from jsonb_array_elements(admin_insights_setup(%L)->'campaigns') c where c->>'id' = %L$q$, :'inst_i', :'k_f'), '2');
select pg_temp.val_is('setup: the Scripts add-on', format($q$select (admin_insights_setup(%L)->'features')::text$q$, :'inst_i'), '["scripts"]');
select pg_temp.val_is('setup: practice mode not installed', format($q$select admin_insights_setup(%L)->>'practice_available'$q$, :'inst_i'), 'false');
select pg_temp.val_is('forecast: fees with money is in rupees', format($q$select admin_insights_forecast(%L,%L,'UTC')->>'kind'$q$, :'inst_i', :'k_f'), 'amount');
select pg_temp.val_is('forecast: corrections are not extra calls', format($q$select admin_insights_forecast(%L,%L,'UTC')->'stats'->>'calls'$q$, :'inst_i', :'k_f'), '7');
select pg_temp.val_is('forecast: picked up calls', format($q$select admin_insights_forecast(%L,%L,'UTC')->'stats'->>'picked'$q$, :'inst_i', :'k_f'), '5');
select pg_temp.val_is('forecast: paid so far (reported by caller)', format($q$select (admin_insights_forecast(%L,%L,'UTC')->'stats'->>'direct_value')::numeric::int::text$q$, :'inst_i', :'k_f'), '14000');
select pg_temp.val_is('forecast: target is 90%% of due', format($q$select (admin_insights_forecast(%L,%L,'UTC')->>'target')::numeric::int::text$q$, :'inst_i', :'k_f'), '90000');
select pg_temp.val_is('forecast: cap is the amount due', format($q$select (admin_insights_forecast(%L,%L,'UTC')->>'cap')::numeric::int::text$q$, :'inst_i', :'k_f'), '100000');
select pg_temp.val_is('forecast: promises judged and kept', format($q$select (admin_insights_forecast(%L,%L,'UTC')->'promises'->>'judged') || '/' || (admin_insights_forecast(%L,%L,'UTC')->'promises'->>'kept')$q$, :'inst_i', :'k_f', :'inst_i', :'k_f'), '2/1');
select pg_temp.val_is('forecast: broken promise value', format($q$select (admin_insights_forecast(%L,%L,'UTC')->'promises'->>'broken_value')::numeric::int::text$q$, :'inst_i', :'k_f'), '7000');
select pg_temp.val_is('forecast: open promise by date', format($q$select (admin_insights_forecast(%L,%L,'UTC')->'open_promises'->0->>'value')::numeric::int::text$q$, :'inst_i', :'k_f'), '12000');
select pg_temp.val_is('forecast: evening calls (7-9 pm)', format($q$select admin_insights_forecast(%L,%L,'UTC')->'stats'->>'evening_picked'$q$, :'inst_i', :'k_f'), '1');
select pg_temp.val_is('forecast: one day row per day from the start', format($q$select jsonb_array_length(admin_insights_forecast(%L,%L,'UTC')->'daily')::text$q$, :'inst_i', :'k_f'), '8');
select pg_temp.val_is('forecast: sales counts joinings', format($q$select admin_insights_forecast(%L,%L,'UTC')->>'kind' || ':' || (admin_insights_forecast(%L,%L,'UTC')->'stats'->>'direct_value')$q$, :'inst_i', :'k_s', :'inst_i', :'k_s'), 'count:1');
select pg_temp.val_is('forecast: sales has no target until a goal is set', format($q$select coalesce(admin_insights_forecast(%L,%L,'UTC')->>'target', 'none')$q$, :'inst_i', :'k_s'), 'none');
select pg_temp.fails('forecast: unknown time zone refused', format($q$select admin_insights_forecast(%L,%L,'Mars/Base')$q$, :'inst_i', :'k_f'));
select pg_temp.fails('forecast: a campaign of another institute is refused', format($q$select admin_insights_forecast(%L,%L,'UTC')$q$, :'inst_i', :'k_j'));

select pg_temp.val_is('summary: whole campaign', format($q$select calls||'/'||picked||'/'||good||'/'||promises_judged||'/'||promises_kept from admin_insights_summary(%L,%L,null,null,'UTC')$q$, :'inst_i', :'k_f'), '7/5/5/2/1');
select pg_temp.val_is('summary: a time window', format($q$select calls::text from admin_insights_summary(%L,%L,(current_date - 1)::timestamp at time zone 'UTC', (current_date + 1)::timestamp at time zone 'UTC','UTC')$q$, :'inst_i', :'k_f'), '2');
select pg_temp.val_is('best time: one row per day and hour with calls', format($q$select count(*)::text from admin_insights_best_time(%L,%L,null,'UTC')$q$, :'inst_i', :'k_f'), '7');
select pg_temp.val_is('best time: one caller', format($q$select sum(calls)::text from admin_insights_best_time(%L,%L,%L,'UTC')$q$, :'inst_i', :'k_f', :'s_a'), '3');
select pg_temp.val_is('call ends: in script order with titles', format($q$select string_agg(step_label||'='||calls, ',' order by step_order) from admin_insights_call_ends(%L,%L)$q$, :'inst_i', :'k_f'), 'Fees=3,Close=2');
select pg_temp.val_is('promises: by days away', format($q$select string_agg(bucket||':'||promises||'/'||kept||'/'||waiting, ',' order by bucket_order) from admin_insights_promises(%L,%L,'UTC')$q$, :'inst_i', :'k_f'), '1–3 days:1/0/0,4–7 days:1/1/0,8–14 days:0/0/0,15+ days:0/0/1');
select pg_temp.val_is('coaching: per caller', format($q$select string_agg(label||':'||calls||'/'||picked||'/'||good, ',' order by label) from admin_insights_coaching(%L,%L)$q$, :'inst_i', :'k_f'), 'Asha:3/3/3,Bilal:4/2/2');
select pg_temp.val_is('step coaching: team share passing the opening', format($q$select timed_calls||'/'||calls_with_step from admin_insights_step_coaching(%L,%L) where seat_id is null and step = 'open'$q$, :'inst_i', :'k_f'), '5/4');
select pg_temp.val_is('step coaching: average seconds per step per caller', format($q$select avg_seconds::text from admin_insights_step_coaching(%L,%L) where seat_id = %L and step = 'open'$q$, :'inst_i', :'k_f', :'s_a'), '23.3');

-- writes
select pg_temp.ok('set call hours', format($q$select admin_set_call_hours(%L, '{"tz":"Asia/Kolkata","days":{"mon":[18,19,20],"sat":[10,11]},"source":"insights"}')$q$, :'k_f'));
select pg_temp.val_is('call hours saved', format($q$select call_hours->'days'->>'mon' from campaigns where id = %L$q$, :'k_f'), '[18, 19, 20]');
select pg_temp.fails('call hours: hour 24 refused', format($q$select admin_set_call_hours(%L, '{"days":{"mon":[24]}}')$q$, :'k_f'));
select pg_temp.fails('call hours: unknown day refused', format($q$select admin_set_call_hours(%L, '{"days":{"funday":[10]}}')$q$, :'k_f'));
select pg_temp.fails('call hours: repeated hour refused', format($q$select admin_set_call_hours(%L, '{"days":{"mon":[10,10]}}')$q$, :'k_f'));
select pg_temp.fails('call hours: other keys refused', format($q$select admin_set_call_hours(%L, '{"days":{},"bank":"x"}')$q$, :'k_f'));
select pg_temp.ok('call hours: null clears', format($q$select admin_set_call_hours(%L, null)$q$, :'k_s'));
select pg_temp.ok('apply plan', format($q$select admin_apply_insights_plan(%L, 3, 40, 0.5, 120, '{"days":{"tue":[19,20]}}')$q$, :'k_f'));
select pg_temp.val_is('apply plan sets the daily target', format($q$select daily_target::text from campaigns where id = %L$q$, :'k_f'), '120');
select pg_temp.val_is('apply plan keeps the callers note', format($q$select insights_plan->>'callers' from campaigns where id = %L$q$, :'k_f'), '3');
select pg_temp.val_is('apply plan sets call hours', format($q$select call_hours->'days'->>'tue' from campaigns where id = %L$q$, :'k_f'), '[19, 20]');
select pg_temp.ok('apply plan without hours keeps them', format($q$select admin_apply_insights_plan(%L, 2, 50, 0.3, 100, null)$q$, :'k_f'));
select pg_temp.val_is('hours kept', format($q$select call_hours->'days'->>'tue' from campaigns where id = %L$q$, :'k_f'), '[19, 20]');
select pg_temp.fails('apply plan: 0 callers refused', format($q$select admin_apply_insights_plan(%L, 0, 40, 0.5, 120, null)$q$, :'k_f'));
select pg_temp.fails('apply plan: evening share over 1 refused', format($q$select admin_apply_insights_plan(%L, 2, 40, 1.5, 120, null)$q$, :'k_f'));
select pg_temp.fails('apply plan: a closed campaign refused', format($q$select admin_apply_insights_plan(%L, 2, 40, 0.5, 120, null)$q$, :'k_c'));
select pg_temp.fails('apply plan: another institute refused', format($q$select admin_apply_insights_plan(%L, 2, 40, 0.5, 120, null)$q$, :'k_j'));
select pg_temp.ok('set a sales goal', format($q$select admin_set_campaign_goal(%L, 25)$q$, :'k_s'));
select pg_temp.val_is('the goal becomes the target', format($q$select admin_insights_forecast(%L,%L,'UTC')->>'target'$q$, :'inst_i', :'k_s'), '25');
select pg_temp.fails('goal 0 refused', format($q$select admin_set_campaign_goal(%L, 0)$q$, :'k_s'));
reset role;
select pg_temp.val_is('writes are audited', format($q$select string_agg(action, ',' order by id) from audit_log where institute_id = %L and action like 'campaign.%%'$q$, :'inst_i'),
  'campaign.call_hours_set,campaign.call_hours_set,campaign.plan_applied,campaign.plan_applied,campaign.goal_set');

-- ---------- manager without money: counts only ----------
set role authenticated;
select pg_temp.as_user(:'u_m');
select pg_temp.val_is('manager: setup says no money', format($q$select admin_insights_setup(%L)->>'money'$q$, :'inst_i'), 'false');
select pg_temp.val_is('manager: fees forecast in counts', format($q$select admin_insights_forecast(%L,%L,'UTC')->>'kind' || ':' || (admin_insights_forecast(%L,%L,'UTC')->>'money_hidden')$q$, :'inst_i', :'k_f', :'inst_i', :'k_f'), 'count:true');
select pg_temp.val_is('manager: payments counted, not summed', format($q$select admin_insights_forecast(%L,%L,'UTC')->'stats'->>'direct_value'$q$, :'inst_i', :'k_f'), '2');
select pg_temp.val_is('manager: broken promises counted', format($q$select admin_insights_forecast(%L,%L,'UTC')->'promises'->>'broken_value'$q$, :'inst_i', :'k_f'), '1');
select pg_temp.val_is('manager: target is 90%% of leads', format($q$select admin_insights_forecast(%L,%L,'UTC')->>'target'$q$, :'inst_i', :'k_f'), '4');
select pg_temp.val_is('manager: no amount anywhere in the forecast', format($q$select (admin_insights_forecast(%L,%L,'UTC')::text ~ '(14000|12000|7000|100000|90000)')::text$q$, :'inst_i', :'k_f'), 'false');
reset role;
update institutes set hide_money = true where id = :'inst_i';
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('hide money: owner gets counts too', format($q$select admin_insights_forecast(%L,%L,'UTC')->>'kind'$q$, :'inst_i', :'k_f'), 'count');
reset role;
update institutes set hide_money = false where id = :'inst_i';

-- ---------- callers, outsiders and the add-on ----------
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.fails('caller: no insights setup', format($q$select admin_insights_setup(%L)$q$, :'inst_i'));
select pg_temp.fails('caller: no forecast', format($q$select admin_insights_forecast(%L,%L,'UTC')$q$, :'inst_i', :'k_f'));
select pg_temp.fails('caller: no coaching', format($q$select * from admin_insights_coaching(%L,%L)$q$, :'inst_i', :'k_f'));
select pg_temp.fails('caller: cannot set call hours', format($q$select admin_set_call_hours(%L, null)$q$, :'k_f'));
select pg_temp.fails('caller: cannot apply a plan', format($q$select admin_apply_insights_plan(%L, 2, 40, 0.5, 120, null)$q$, :'k_f'));
select pg_temp.fails('caller: cannot run internal helpers', format($q$select * from insights_calls(%L,%L)$q$, :'inst_i', :'k_f'));
select pg_temp.as_user(:'u_x');
select pg_temp.fails('other institute: no forecast', format($q$select admin_insights_forecast(%L,%L,'UTC')$q$, :'inst_i', :'k_f'));
select pg_temp.fails('other institute: no best time', format($q$select * from admin_insights_best_time(%L,%L,null,'UTC')$q$, :'inst_i', :'k_f'));
select pg_temp.fails('no Scripts add-on: no call ends', format($q$select * from admin_insights_call_ends(%L,%L)$q$, :'inst_j', :'k_j'));
select pg_temp.fails('no Scripts add-on: no step coaching', format($q$select * from admin_insights_step_coaching(%L,%L)$q$, :'inst_j', :'k_j'));
select pg_temp.val_is('no Scripts add-on: other cards work', format($q$select calls::text from admin_insights_coaching(%L,%L)$q$, :'inst_j', :'k_j'), '1');
select pg_temp.val_is('no Scripts add-on: features empty', format($q$select (admin_insights_setup(%L)->'features')::text$q$, :'inst_j'), '[]');
select pg_temp.as_user(null);
select pg_temp.fails('signed out: nothing', format($q$select admin_insights_setup(%L)$q$, :'inst_i'));
reset role;
set role anon;
select pg_temp.fails('anon cannot run reports', format($q$select admin_insights_setup(%L)$q$, :'inst_i'));
reset role;

select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
