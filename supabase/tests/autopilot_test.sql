-- Tests for 20261026120000_autopilot_engine.sql: the five rules, idempotent planning, auto actions with Undo,
-- accept (with changes), dismiss and snooze, who sees which suggestions, money rules, settings and goals, the
-- three numbers, the one-screen list and grants. Run with supabase/tests/run.sh. Expect failed = 0 on the last line.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''))::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon, service_role;
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
  to authenticated, anon, service_role;
-- The newest suggestion of a kind (and status), for tests that run as a signed-in person (no table access).
create or replace function pg_temp.sid(k text, st text default null) returns uuid language sql security definer as $$
  select id from public.suggestions where kind = k and (st is null or status = st) order by created_at desc limit 1 $$;
create or replace function pg_temp.sstatus(k text) returns text language sql security definer as $$
  select status from public.suggestions where kind = k order by created_at desc limit 1 $$;
grant execute on function pg_temp.sid(text, text), pg_temp.sstatus(text) to authenticated;

\set inst 'ae000000-0000-0000-0000-000000000001'
\set inst2 'ae000000-0000-0000-0000-000000000002'
\set u_o 'ae100000-0000-0000-0000-000000000001'
\set u_m 'ae100000-0000-0000-0000-000000000002'
\set u_mm 'ae100000-0000-0000-0000-000000000003'
\set u_ac 'ae100000-0000-0000-0000-000000000004'
\set u_r1 'ae100000-0000-0000-0000-000000000005'
\set u_r2 'ae100000-0000-0000-0000-000000000006'
\set u_r3 'ae100000-0000-0000-0000-000000000007'
\set u_x 'ae100000-0000-0000-0000-000000000008'
\set s_o 'ae200000-0000-0000-0000-000000000001'
\set s_m 'ae200000-0000-0000-0000-000000000002'
\set s_mm 'ae200000-0000-0000-0000-000000000003'
\set s_ac 'ae200000-0000-0000-0000-000000000004'
\set s_r1 'ae200000-0000-0000-0000-000000000005'
\set s_r2 'ae200000-0000-0000-0000-000000000006'
\set s_r3 'ae200000-0000-0000-0000-000000000007'
\set s_x 'ae200000-0000-0000-0000-000000000008'
\set k_fees 'ae300000-0000-0000-0000-000000000001'
\set k_adm 'ae300000-0000-0000-0000-000000000002'

reset role;
insert into auth.users (id, email) values (:'u_o','o@ap.test'), (:'u_m','m@ap.test'), (:'u_mm','mm@ap.test'), (:'u_ac','ac@ap.test'),
  (:'u_r1','r1@ap.test'), (:'u_r2','r2@ap.test'), (:'u_r3','r3@ap.test'), (:'u_x','x@ap.test');
insert into institutes (id, name, status) values (:'inst', 'Autopilot Inst', 'active'), (:'inst2', 'Other Inst', 'active');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst', :'u_o', 'Owner', 'admin', 'active'),
 (:'s_m', :'inst', :'u_m', 'Manager', 'admin', 'active'),
 (:'s_mm', :'inst', :'u_mm', 'Money Manager', 'admin', 'active'),
 (:'s_ac', :'inst', :'u_ac', 'Accounts', 'accounts', 'active'),
 (:'s_r1', :'inst', :'u_r1', 'Ravi', 'rep', 'active'),
 (:'s_r2', :'inst', :'u_r2', 'Neha', 'rep', 'active'),
 (:'s_r3', :'inst', :'u_r3', 'Amit', 'rep', 'active'),
 (:'s_x', :'inst2', :'u_x', 'Other owner', 'admin', 'active');
update seats set can_see_money = true where id = :'s_mm';
-- Amit is busy: his daily target is already given to a focus list below; Ravi calls a lot.
insert into rep_targets (seat_id, institute_id, metric, daily_target) values (:'s_r3', :'inst', 'calls', 10);
-- (below: Oct fees asks Amit for 20 calls a day as its focus caller)

-- Class 8 State: 5 students owe Term 2 (due in 5 days); one has no phone; a sixth has paid.
insert into students (id, institute_id, name, class_label, board, parent_name, phone, status, source)
select ('ae400000-0000-0000-0000-00000000000' || i)::uuid, :'inst', 'Kid ' || i, '8th', 'State', 'Parent ' || i,
       case when i = 5 then null else '+9199990810' || lpad(i::text, 2, '0') end, 'active', 'import'
from generate_series(1, 6) i;
insert into fee_items (institute_id, student_id, head, amount, due_date)
select :'inst', id, 'Term 2 tuition', 10000, (now() at time zone 'Asia/Kolkata')::date + 5 from students where institute_id = :'inst';
insert into payments (institute_id, student_id, amount, paid_on, mode, reference)
  values (:'inst', 'ae400000-0000-0000-0000-000000000006', 10000, (now() at time zone 'Asia/Kolkata')::date, 'cash', null);

-- A fees list with 4 missed promises (no student) and an admission list with 6 enquiries waiting in the pool for 2 days.
insert into campaigns (id, institute_id, name, call_type_id, status, open_to_all, share_mode, created_at) values
 (:'k_fees', :'inst', 'Oct fees', (select id from call_types where key='fees' and institute_id is null), 'running', true, 'next_free', now() - interval '10 days'),
 (:'k_adm', :'inst', 'Enquiries', (select id from call_types where key='admission' and institute_id is null), 'running', true, 'next_free', now() - interval '3 days');
insert into leads (institute_id, campaign_id, name, phone, status, promised_date, promised_amount, next_call_at, assigned_seat_id)
select :'inst', :'k_fees', 'Promise ' || i, '+9199990820' || lpad(i::text, 2, '0'), 'promised', (now() at time zone 'Asia/Kolkata')::date - i,
       5000, now() - make_interval(days => i), :'s_r1'
from generate_series(1, 4) i;
insert into leads (institute_id, campaign_id, name, phone, status, created_at)
select :'inst', :'k_adm', 'Enquiry ' || i, '+9199990830' || lpad(i::text, 2, '0'), 'new', now() - interval '2 days' + i * interval '1 second'
from generate_series(1, 6) i;
update campaigns set focus_seats = array[:'s_r3'::uuid], daily_target = 20 where id = :'k_fees';

-- ---------- who may plan ----------
select pg_temp.as_user(:'u_r1');
set role authenticated;
select pg_temp.fails_with('a caller cannot run the planner', format($q$select autopilot_plan(%L)$q$, :'inst'), 'only an owner or manager');
select pg_temp.fails_with('a caller cannot read suggestions', $q$select my_suggestions()$q$, 'only an owner or manager');
reset role;
select pg_temp.as_user(:'u_x');
set role authenticated;
select pg_temp.fails_with('another institute''s owner cannot plan here', format($q$select autopilot_plan(%L)$q$, :'inst'), 'only an owner or manager');
reset role;
select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.fails_with('Accounts cannot run the planner', format($q$select autopilot_plan(%L)$q$, :'inst'), 'only an owner or manager');
reset role;

-- ---------- defaults: auto for lists, reminders and balancing; one planning run ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('defaults: lists, reminders and balance are on', $q$select (autopilot_get_settings()->'toggles')::text$q$,
  '{"lists": true, "balance": true, "reminders": true}');
select pg_temp.val_is('first run: 3 auto actions (fees list, missed promises, enquiries)', format($q$select (autopilot_plan(%L)->>'auto_done')$q$, :'inst'), '3');
reset role;
select pg_temp.val_is('the fees list was created and is running', $q$select status||' '||class_label||' '||board||' '||(fees_due_by - (now() at time zone 'Asia/Kolkata')::date) from campaigns where name = 'Term 2 fees – Class 8 State Board'$q$, 'running 8th State 5');
select pg_temp.val_is('one lead per owing parent with a phone (4: one has no phone, one paid)', $q$select count(*)::text from leads l join campaigns c on c.id = l.campaign_id where c.name = 'Term 2 fees – Class 8 State Board'$q$, '4');
select pg_temp.val_is('focus callers: the top 2 with spare capacity (Amit has none)', $q$select (select string_agg(s.label, ',' order by s.label) from seats s where s.id = any(c.focus_seats)) from campaigns c where c.name = 'Term 2 fees – Class 8 State Board'$q$, 'Neha,Ravi');
select pg_temp.val_is('daily target = parents / working days to due + 7', $q$select (daily_target = ceil(4.0 / ap_working_days((now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date + 12)))::text from campaigns where name = 'Term 2 fees – Class 8 State Board'$q$, 'true');
select pg_temp.val_is('end date = due date + 7', $q$select (end_date - fees_due_by)::text from campaigns where name = 'Term 2 fees – Class 8 State Board'$q$, '7');
select pg_temp.val_is('missed promises moved to the top (due a month ago)', format($q$select count(*)::text from leads where campaign_id = %L and next_call_at < now() - interval '29 days'$q$, :'k_fees'), '4');
select pg_temp.val_is('waiting enquiries are due now', format($q$select count(*)::text from leads where campaign_id = %L and next_call_at <= now()$q$, :'k_adm'), '6');
select pg_temp.val_is('enquiries list got focus callers', format($q$select (cardinality(focus_seats) > 0)::text from campaigns where id = %L$q$, :'k_adm'), 'true');
select pg_temp.val_is('setup gaps is a card, not done (it can only ask)', $q$select status from suggestions where kind = 'setup_gaps'$q$, 'new');
select pg_temp.val_is('audit: autopilot.done x3', format($q$select count(*)::text from audit_log where institute_id = %L and action = 'autopilot.done'$q$, :'inst'), '3');
select pg_temp.val_is('the run is recorded', format($q$select (counts->>'auto_done') from automation_runs where institute_id = %L order by id desc limit 1$q$, :'inst'), '3');

-- ---------- idempotent ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('second run: nothing new, nothing done twice', format($q$select (r->>'new')||' '||(r->>'auto_done') from (select autopilot_plan(%L) r) x$q$, :'inst'), '0 0');
reset role;
select pg_temp.val_is('still one fees list', $q$select count(*)::text from campaigns where name like 'Term 2 fees%'$q$, '1');
select pg_temp.val_is('one open suggestion per key', format($q$select count(*)::text from suggestions where institute_id = %L and status in ('new','snoozed') group by dedupe_key order by 1 desc limit 1$q$, :'inst'), '1');
select pg_temp.fails_with('the open key is unique', format($q$insert into suggestions (institute_id, kind, dedupe_key, title) select institute_id, kind, dedupe_key, title from suggestions where institute_id = %L and status = 'new' limit 1$q$, :'inst'), 'duplicate key');

-- ---------- my_suggestions: role filtering and money ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('owner: the setup card', $q$select string_agg(c->>'kind', ',') from jsonb_array_elements(my_suggestions()->'cards') c$q$, 'setup_gaps');
select pg_temp.val_is('owner: Vector did 3 things', $q$select jsonb_array_length(my_suggestions()->'feed')::text$q$, '3');
select pg_temp.val_is('owner: feed items can be undone', $q$select bool_and((c->>'can_undo')::boolean)::text from jsonb_array_elements(my_suggestions()->'feed') c$q$, 'true');
select pg_temp.val_is('owner sees the promised amount', $q$select c->'why'->>'amount' from jsonb_array_elements(my_suggestions()->'feed') c where c->>'kind' = 'missed_promises'$q$, '20000.00');
reset role;
select pg_temp.as_user(:'u_m');
set role authenticated;
select pg_temp.val_is('manager: no setup card', $q$select jsonb_array_length(my_suggestions()->'cards')::text$q$, '0');
select pg_temp.val_is('manager without money: no fees list in the feed', $q$select string_agg(c->>'kind', ',' order by c->>'kind') from jsonb_array_elements(my_suggestions()->'feed') c$q$, 'enquiries_uncalled,missed_promises');
select pg_temp.val_is('manager without money: no amount anywhere', $q$select (my_suggestions()::text like '%amount"%')::text$q$, 'false');
reset role;
select pg_temp.as_user(:'u_mm');
set role authenticated;
select pg_temp.val_is('manager with money: the fees list too', $q$select jsonb_array_length(my_suggestions()->'feed')::text$q$, '3');
reset role;
select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.val_is('Accounts: no calling cards and no feed', $q$select jsonb_array_length(my_suggestions()->'cards') + jsonb_array_length(my_suggestions()->'feed') from (select 1) x$q$, '0');
select pg_temp.fails_with('Accounts cannot accept a calling suggestion', $q$select accept_suggestion(pg_temp.sid('setup_gaps'))$q$, 'suggestion not found');
reset role;

-- ---------- undo ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('undo the fees list (no calls yet): removed', $q$select undo_suggestion(pg_temp.sid('fees_due_list'))->>'text'$q$, 'Removed "Term 2 fees – Class 8 State Board" (no calls had been made).');
select pg_temp.fails_with('undo twice is refused', $q$select undo_suggestion(pg_temp.sid('fees_due_list'))$q$, 'cannot be undone');
select pg_temp.val_is('undo the missed promises: times put back', $q$select undo_suggestion(pg_temp.sid('missed_promises'))->>'text'$q$, 'Put 4 promises back where they were.');
reset role;
select pg_temp.val_is('the list is gone', $q$select count(*)::text from campaigns where name like 'Term 2 fees%'$q$, '0');
select pg_temp.val_is('promises are back at their old times', format($q$select count(*)::text from leads where campaign_id = %L and next_call_at > now() - interval '5 days'$q$, :'k_fees'), '4');
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('an undone key is not done again', format($q$select (autopilot_plan(%L)->>'auto_done')$q$, :'inst'), '0');
reset role;
select pg_temp.val_is('so there is still no fees list', $q$select count(*)::text from campaigns where name like 'Term 2 fees%'$q$, '0');
update suggestions set done_at = now() - interval '25 hours' where kind = 'enquiries_uncalled';
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.fails_with('undo after 24 hours is refused', $q$select undo_suggestion(pg_temp.sid('enquiries_uncalled'))$q$, '24 hours');
reset role;

-- ---------- ask mode: a card, Confirm with changes, Undo when calls were made ----------
select pg_temp.as_user(:'u_m');
set role authenticated;
select pg_temp.fails_with('a manager cannot change Autopilot', $q$select autopilot_save_settings(null, '{"fees_due_list":"ask"}')$q$, 'only the owner');
reset role;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.fails_with('a bad mode is refused', $q$select autopilot_save_settings(null, '{"fees_due_list":"maybe"}')$q$, 'modes are');
select pg_temp.fails_with('setup gaps cannot be automatic', $q$select autopilot_save_settings(null, '{"setup_gaps":"auto"}')$q$, 'modes are');
select pg_temp.ok('owner: fees lists ask first', $q$select autopilot_save_settings(null, '{"fees_due_list":"ask"}')$q$);
reset role;
-- New fees due: Class 9 CBSE, 3 students, due in 3 days.
insert into students (id, institute_id, name, class_label, board, phone, status, source)
select ('ae500000-0000-0000-0000-00000000000' || i)::uuid, :'inst', 'Nine ' || i, '9th', 'CBSE', '+91999908400' || i, 'active', 'import'
from generate_series(1, 3) i;
insert into fee_items (institute_id, student_id, head, amount, due_date)
select :'inst', id, 'Term 2 tuition', 8000, (now() at time zone 'Asia/Kolkata')::date + 3 from students where class_label = '9th';
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('ask: the new list is a card, not done', format($q$select (autopilot_plan(%L)->>'auto_done')$q$, :'inst'), '0');
select pg_temp.val_is('the card: title and why', $q$select (c->>'title')||' | '||(c->'why'->>'text') from jsonb_array_elements(my_suggestions()->'cards') c where c->>'kind' = 'fees_due_list'$q$,
  'Start "Term 2 fees – Class 9 CBSE" | Term 2 tuition is due in 3 days (' || to_char((now() at time zone 'Asia/Kolkata')::date + 3, 'FMDD Mon') || '). 3 parents of Class 9 CBSE still owe it.');
select pg_temp.val_is('the card has the plan filled in', $q$select (c->'plan'->>'parents')||' '||(c->'plan'->>'end_date')::date - (c->'plan'->>'due_by')::date||' '||jsonb_array_length(c->'plan'->'callers') from jsonb_array_elements(my_suggestions()->'cards') c where c->>'kind' = 'fees_due_list'$q$, '3 7 2');
select pg_temp.fails_with('a change that is not allowed is refused', $q$select accept_suggestion(pg_temp.sid('fees_due_list', 'new'), '{"status":"closed"}')$q$, 'changes can be');
select pg_temp.fails_with('a caller of another institute is refused', format($q$select accept_suggestion(pg_temp.sid('fees_due_list', 'new'), '{"callers":["%s"]}')$q$, :'s_x'), 'pick callers');
select pg_temp.val_is('Confirm with changes: name and one caller', format($q$select accept_suggestion(pg_temp.sid('fees_due_list', 'new'), '{"name":"Class 9 fees","callers":["%s"],"hour":18}')->>'status'$q$, :'s_r3'), 'accepted');
reset role;
select pg_temp.val_is('the list has the changes', format($q$select name||' '||(focus_seats = array[%L::uuid])::text||' '||(call_hours->'days'->>'mon') from campaigns where name = 'Class 9 fees'$q$, :'s_r3'), 'Class 9 fees true [18, 19]');
select pg_temp.val_is('audit: suggestion.accepted', $q$select count(*)::text from audit_log where action = 'suggestion.accepted'$q$, '1');
-- Amit sees it first in his picker, with his target.
select pg_temp.as_user(:'u_r3');
set role authenticated;
select pg_temp.val_is('focus list first in the caller''s picker with the target', $q$select name||' '||is_focus||' '||(focus_target is not null) from my_campaigns() limit 1$q$, 'Class 9 fees true true');
reset role;
select pg_temp.as_user(:'u_r1');
set role authenticated;
select pg_temp.val_is('other callers still see it (open to all), not as focus', $q$select is_focus::text from my_campaigns() where name = 'Class 9 fees'$q$, 'false');
reset role;
-- A call is made, then Undo: kept and paused.
insert into call_outcomes (institute_id, seat_id, client_record_id, outcome, dialled_at, campaign_id, lead_id)
select :'inst', :'s_r3', 'ap-call-1', 'no_answer', now(), c.id, (select id from leads where campaign_id = c.id limit 1) from campaigns c where c.name = 'Class 9 fees';
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('undo after a call: paused, not removed', $q$select undo_suggestion(pg_temp.sid('fees_due_list', 'accepted'))->>'text'$q$, 'Paused "Class 9 fees": calls were already made, so it was kept.');
reset role;
select pg_temp.val_is('the list is paused', $q$select status from campaigns where name = 'Class 9 fees'$q$, 'paused');

-- ---------- Not now ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.fails_with('snooze must be 1 to 30 days', $q$select dismiss_suggestion(pg_temp.sid('setup_gaps', 'new'), 40)$q$, 'snooze for');
select pg_temp.val_is('Not now: snoozed for 3 days', $q$select dismiss_suggestion(pg_temp.sid('setup_gaps', 'new'), 3)->>'status'$q$, 'snoozed');
select pg_temp.val_is('a snoozed card is not shown', $q$select count(*)::text from jsonb_array_elements(my_suggestions()->'cards') c where c->>'kind' = 'setup_gaps'$q$, '0');
select pg_temp.ok('plan again', format($q$select autopilot_plan(%L)$q$, :'inst'));
select pg_temp.val_is('still snoozed after a run', $q$select pg_temp.sstatus('setup_gaps')$q$, 'snoozed');
reset role;
update suggestions set snooze_until = now() - interval '1 minute' where kind = 'setup_gaps';
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('plan after the snooze', format($q$select autopilot_plan(%L)$q$, :'inst'));
select pg_temp.val_is('back after the snooze', $q$select pg_temp.sstatus('setup_gaps')$q$, 'new');
select pg_temp.val_is('dismissed for good', $q$select dismiss_suggestion(pg_temp.sid('setup_gaps', 'new'), null)->>'status'$q$, 'dismissed');
select pg_temp.ok('plan after dismiss', format($q$select autopilot_plan(%L)$q$, :'inst'));
select pg_temp.val_is('a dismissed card does not come back', $q$select pg_temp.sstatus('setup_gaps')$q$, 'dismissed');

-- ---------- pause ----------
select pg_temp.ok('pause all automation', $q$select autopilot_save_settings(true)$q$);
reset role;
insert into campaigns (id, institute_id, name, call_type_id, status, open_to_all, share_mode, created_at) values
 ('ae300000-0000-0000-0000-000000000003', :'inst', 'Walk-ins', (select id from call_types where key='admission' and institute_id is null), 'running', true, 'next_free', now() - interval '3 days');
insert into leads (institute_id, campaign_id, name, phone, status, created_at)
select :'inst', 'ae300000-0000-0000-0000-000000000003', 'Late enquiry ' || i, '+91999908500' || i, 'new', now() - interval '30 hours' from generate_series(1, 5) i;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('paused: nothing is done by itself', format($q$select (r->>'auto_done')||' '||(r->>'paused') from (select autopilot_plan(%L) r) x$q$, :'inst'), '0 true');
select pg_temp.val_is('paused: it still asks', $q$select count(*)::text from jsonb_array_elements(my_suggestions()->'cards') c where c->>'kind' = 'enquiries_uncalled'$q$, '1');
select pg_temp.val_is('audit: autopilot.paused', $q$select count(*)::text from audit_log where action = 'autopilot.paused'$q$, '1');
select pg_temp.ok('resume', $q$select autopilot_save_settings(false)$q$);

-- ---------- goals and numbers ----------
select pg_temp.fails_with('a fees goal over 100% is refused', $q$select autopilot_save_goals(120)$q$, 'fees goal');
select pg_temp.val_is('goals saved', $q$select (autopilot_save_goals(85, 40)->'goals'->>'fees_pct')$q$, '85');
reset role;
-- A Class 8 fee due yesterday for the numbers: one of 6 paid (the payment covers it).
insert into fee_items (institute_id, student_id, head, amount, due_date)
select :'inst', id, 'Term 1 tuition', 10000, (now() at time zone 'Asia/Kolkata')::date - 1 from students where id::text like 'ae400000%';
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('owner: fees % of due (₹) and the goal', $q$select (n->'fees'->>'pct')||' '||(n->'fees'->>'goal_pct')||' '||(n->'fees'->>'collected_amount') from (select autopilot_numbers() n) x$q$, '17 85 10000.00');
select pg_temp.val_is('admissions vs target', $q$select (n->'admissions'->>'confirmed')||' of '||(n->'admissions'->>'target') from (select autopilot_numbers() n) x$q$, '0 of 40');
select pg_temp.val_is('team today', $q$select (n->'team'->>'calls')||' '||(n->'team'->>'callers_total') from (select autopilot_numbers() n) x$q$, '1 3');
reset role;
select pg_temp.as_user(:'u_m');
set role authenticated;
select pg_temp.val_is('manager without money: no ₹ and no ₹ percent, parents instead', $q$select coalesce(n->'fees'->>'pct','null')||' '||coalesce(n->'fees'->>'due_amount','null')||' '||(n->'fees'->>'parents_pct') from (select autopilot_numbers() n) x$q$, 'null null 17');
select pg_temp.fails_with('a manager cannot set goals', $q$select autopilot_save_goals(80)$q$, 'only the owner');
reset role;
select pg_temp.as_user(:'u_ac');
set role authenticated;
select pg_temp.fails_with('Accounts get no Today numbers', $q$select autopilot_numbers()$q$, 'only an owner or manager');
reset role;

-- ---------- one-screen New calling list ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('defaults for Class 8 State: the planner fills it in', $q$select (d->>'name')||' | '||(d->>'parents')||' | '||jsonb_array_length(d->'callers') from (select autopilot_list_defaults('fees', '8th', 'State', (now() at time zone 'Asia/Kolkata')::date + 5) d) x$q$,
  'Term 2 fees – Class 8 State Board | 5 | 2');
reset role;
select pg_temp.as_user(:'u_m');
set role authenticated;
select pg_temp.val_is('defaults for a manager without money: no amount', $q$select (autopilot_list_defaults('fees', '8th', 'State', null) ? 'amount')::text$q$, 'false');
select pg_temp.fails_with('a manager without money cannot make a fees list', $q$select autopilot_create_list(autopilot_list_defaults('fees', '8th', 'State', null))$q$, 'can see money');
reset role;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('Confirm the one-screen list', $q$select (autopilot_create_list(autopilot_list_defaults('fees', '8th', 'State', null) || '{"name":"Manual Class 8"}')->>'can_undo')$q$, 'true');
select pg_temp.val_is('it shows in the feed as yours', $q$select c->>'by' from jsonb_array_elements(my_suggestions()->'feed') c where c->>'kind' = 'new_list'$q$, 'you');
select pg_temp.val_is('and it can be undone', $q$select undo_suggestion(pg_temp.sid('new_list'))->>'text'$q$, 'Removed "Manual Class 8" (no calls had been made).');
select pg_temp.val_is('caller scores for admins', $q$select count(*)::text from caller_scores('fees')$q$, '3');
reset role;

-- ---------- the system (service role) ----------
select pg_temp.as_user(null);
set role service_role;
select pg_temp.ok('the service role can plan', format($q$select autopilot_plan(%L)$q$, :'inst2'));
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot plan', $q$select has_function_privilege('anon','public.autopilot_plan(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot read suggestions', $q$select has_function_privilege('anon','public.my_suggestions()','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('rules are internal', $q$select has_function_privilege('authenticated','public.ap_rule_fees_due(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('execute is internal', $q$select has_function_privilege('authenticated','public.ap_execute(uuid,text,jsonb,uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('reminders are for the service role only', $q$select has_function_privilege('authenticated','public.autopilot_claim_reminders(int)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('the browser cannot read suggestions directly', $q$select has_table_privilege('authenticated','public.suggestions','SELECT')::text$q$, 'false');
select pg_temp.val_is('money stripping', $q$select ap_strip_money('{"a":1,"amount":5,"x":{"due_amount":3,"k":[{"amount":1,"b":2}]}}')::text$q$, '{"a": 1, "x": {"k": [{"b": 2}]}}');
select pg_temp.val_is('working days skip Sundays', $q$select ap_working_days('2026-10-26', '2026-11-01')::text$q$, '6');
select pg_temp.val_is('list name from the fee name', $q$select ap_list_name('Term 2 tuition', '8th', 'State', '2026-11-01')$q$, 'Term 2 fees – Class 8 State Board');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
