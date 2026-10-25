-- Tests for 20261024100026_insights_extra.sql: script A/B test, weekly brief, practice mode.
-- Run after every migration on a scratch database with supabase/tests/stub_auth.sql.
-- The last line prints passed and failed counts: expect failed = 0.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text, ''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text, ''))::text, false);
  select null::void;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon, service_role;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
create or replace function pg_temp.fails_with(name text, sql text, msg text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected "' || msg || '", succeeded');
exception when others then insert into results values (name, sqlerrm like '%' || msg || '%', sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;

-- ---------- fixed ids ----------
\set inst_i 'c1000000-0000-0000-0000-000000000001'
\set inst_j 'c1000000-0000-0000-0000-000000000002'
\set u_o 'c2000000-0000-0000-0000-000000000001'
\set u_m 'c2000000-0000-0000-0000-000000000002'
\set u_a 'c2000000-0000-0000-0000-000000000003'
\set u_b 'c2000000-0000-0000-0000-000000000004'
\set u_x 'c2000000-0000-0000-0000-000000000005'
\set u_c 'c2000000-0000-0000-0000-000000000006'
\set s_o 'c3000000-0000-0000-0000-000000000001'
\set s_m 'c3000000-0000-0000-0000-000000000002'
\set s_a 'c3000000-0000-0000-0000-000000000003'
\set s_b 'c3000000-0000-0000-0000-000000000004'
\set s_x 'c3000000-0000-0000-0000-000000000005'
\set s_c 'c3000000-0000-0000-0000-000000000006'
\set sc1 'c4000000-0000-0000-0000-000000000001'
\set sc2 'c4000000-0000-0000-0000-000000000002'
\set sc_j 'c4000000-0000-0000-0000-000000000003'
\set k_fees 'c5000000-0000-0000-0000-000000000001'
\set k_sales 'c5000000-0000-0000-0000-000000000002'
\set k_j 'c5000000-0000-0000-0000-000000000003'
\set k_draft 'c5000000-0000-0000-0000-000000000004'

-- ---------- fixtures (as the table owner) ----------
-- Inst I (active, Scripts add-on): owner O, manager M (no money), callers A and B.
-- Inst J (active, no add-on): owner X, caller C.
-- "Script one" (I): v1 published, v2 draft. "Script two" (I): draft only. "J script": v1 published.
-- Campaigns: Fees Oct (I, fees, running, Script one, A and B, ends in 10 days), Sales Oct (I, sales, running,
-- no script, A), Draft (I, draft, Script one, A), J Fees (J, fees, running, J script, C).
reset role;
insert into auth.users (id, email) values
 (:'u_o', 'owner@i.test'), (:'u_m', 'manager@i.test'), (:'u_a', 'a@i.test'), (:'u_b', 'b@i.test'),
 (:'u_x', 'owner@j.test'), (:'u_c', 'c@j.test');
insert into institutes (id, name, status) values (:'inst_i', 'Inst I', 'active'), (:'inst_j', 'Inst J', 'active');
update institutes set features = array['scripts'] where id = :'inst_i';
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'owner', 'active'),
 (:'s_m', :'inst_i', :'u_m', 'Manager', 'admin', 'manager', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Caller A', 'rep', null, 'active'),
 (:'s_b', :'inst_i', :'u_b', 'Caller B', 'rep', null, 'active'),
 (:'s_x', :'inst_j', :'u_x', 'Owner J', 'admin', 'owner', 'active'),
 (:'s_c', :'inst_j', :'u_c', 'Caller C', 'rep', null, 'active');
insert into scripts (id, institute_id, name) values
 (:'sc1', :'inst_i', 'Script one'), (:'sc2', :'inst_i', 'Script two'), (:'sc_j', :'inst_j', 'J script');
insert into script_versions (script_id, institute_id, version, steps, change_note, published) values
 (:'sc1', :'inst_i', 1, '[{"id":"open","start":true,"say":["Hi {name}, v1"],"opts":[{"label":"Next","to":"fees"}]},{"id":"fees","title":"Fee step","say":["The fee is due."]}]', '', true),
 (:'sc1', :'inst_i', 2, '[{"id":"open","start":true,"say":["Hi {name}, v2"],"opts":[{"label":"Next","to":"fees"}]},{"id":"fees","title":"Fee step","say":["The fee is due soon."]}]', 'Shorter opening', false),
 (:'sc2', :'inst_i', 1, '[{"id":"open","start":true,"say":["Draft"]}]', '', false),
 (:'sc_j', :'inst_j', 1, '[{"id":"open","start":true,"say":["J"]}]', '', true);
-- The draft v2 has its own pushback answer (20261025120000: they come with the version's steps).
update script_versions set pushbacks = '[{"label":"Can I pay late?","answer":"Yes, by the 10th."}]' where script_id = :'sc1' and version = 2;
select (now() at time zone 'Asia/Kolkata')::date + 10 as endd,
       (now() at time zone 'Asia/Kolkata')::date
         - case extract(isodow from (now() at time zone 'Asia/Kolkata')::date)::int when 1 then 3 when 7 then 2 else 1 end
         as drecent \gset
insert into campaigns (id, institute_id, name, call_type_id, status, script_id, end_date) values
 (:'k_fees', :'inst_i', 'Fees Oct', (select id from call_types where key = 'fees' and institute_id is null), 'running', :'sc1', :'endd'),
 (:'k_sales', :'inst_i', 'Sales Oct', (select id from call_types where key = 'sales' and institute_id is null), 'running', null, null),
 (:'k_draft', :'inst_i', 'Draft', (select id from call_types where key = 'fees' and institute_id is null), 'draft', :'sc1', null),
 (:'k_j', :'inst_j', 'J Fees', (select id from call_types where key = 'fees' and institute_id is null), 'running', :'sc_j', null);
insert into campaign_members (campaign_id, seat_id, institute_id) values
 (:'k_fees', :'s_a', :'inst_i'), (:'k_fees', :'s_b', :'inst_i'), (:'k_sales', :'s_a', :'inst_i'),
 (:'k_draft', :'s_a', :'inst_i'), (:'k_j', :'s_c', :'inst_j');

-- Brief data in Fees Oct. drecent is the last weekday before today (always within the last 7 days).
-- p1..p20 (A): paid ₹10,000 on drecent 7:30 pm, script v2.            talked, good, last 7 days
-- n1..n20 (B): no answer on drecent 11:15 am, script v2.               not talked
-- w1..w20 (A): will pay on date, 21 days before drecent, 7:30 pm, v1;  w1..w10 promise 3 days away, w11..w20 12 days
-- w1..w8 paid later (14 days before drecent, 7:45 pm, v1) and done; w11..w13 done; the rest still "promised".
-- r1..r12 (A): refused, 21 days before drecent, v1, step fees; r13..r22: refused on drecent, v2, step fees.
insert into leads (institute_id, campaign_id, name, phone, amount_due, assigned_seat_id)
  select :'inst_i'::uuid, :'k_fees'::uuid, 'p' || i, '+91900000' || lpad(i::text, 4, '0'), 10000::numeric, :'s_a'::uuid from generate_series(1, 20) i
  union all
  select :'inst_i', :'k_fees', 'n' || i, '+91910000' || lpad(i::text, 4, '0'), 10000, :'s_b' from generate_series(1, 20) i
  union all
  select :'inst_i', :'k_fees', 'w' || i, '+91920000' || lpad(i::text, 4, '0'), 10000, :'s_a' from generate_series(1, 20) i
  union all
  select :'inst_i', :'k_fees', 'r' || i, '+91930000' || lpad(i::text, 4, '0'), null, :'s_a' from generate_series(1, 22) i;
create temp table lk as select id, name, left(name, 1) as kind, substr(name, 2)::int as i from leads where campaign_id = :'k_fees';
insert into call_outcomes (institute_id, seat_id, client_record_id, lead_id, result_key, amount, promised_date,
                           result_reason, script_id, script_version, script_step, dialled_at, connected_seconds)
  select :'inst_i'::uuid, :'s_a'::uuid, 'p' || i, id, 'paid', 10000::numeric, null::date, null::text, :'sc1', 2, 'fees',
         (:'drecent'::date + time '19:30') at time zone 'Asia/Kolkata', 120 from lk where kind = 'p'
  union all
  select :'inst_i', :'s_b', 'n' || i, id, 'no_answer', null, null, null, :'sc1', 2, 'open',
         (:'drecent'::date + time '11:15') at time zone 'Asia/Kolkata', 0 from lk where kind = 'n'
  union all
  select :'inst_i', :'s_a', 'w' || i, id, 'will_pay_on', 10000,
         :'drecent'::date - 21 + case when i <= 10 then 3 else 12 end, null, :'sc1', 1, 'fees',
         (:'drecent'::date - 21 + time '19:30') at time zone 'Asia/Kolkata', 200 from lk where kind = 'w'
  union all
  select :'inst_i', :'s_a', 'wl' || i, id, 'paid', 10000, null, null, :'sc1', 1, 'fees',
         (:'drecent'::date - 14 + time '19:45') at time zone 'Asia/Kolkata', 90 from lk where kind = 'w' and i <= 8
  union all
  select :'inst_i', :'s_a', 'r' || i, id, 'refused', null, null, 'Too costly', :'sc1', case when i <= 12 then 1 else 2 end, 'fees',
         (case when i <= 12 then :'drecent'::date - 21 else :'drecent'::date end + time '19:30') at time zone 'Asia/Kolkata', 60
    from lk where kind = 'r';
update leads l set status = 'done' from lk where lk.id = l.id and lk.kind = 'w' and (lk.i <= 8 or lk.i between 11 and 13);
update leads l set status = 'promised', promised_date = :'drecent'::date - 21 + case when lk.i <= 10 then 3 else 12 end
  from lk where lk.id = l.id and lk.kind = 'w' and lk.i in (9, 10, 14, 15, 16, 17, 18, 19, 20);
select count(*) as calls_before_test from call_outcomes \gset

-- ---------- formatting helpers ----------
select pg_temp.val_is('ix_count groups the Indian way', $q$select ix_count(4320000)$q$, '43,20,000');
select pg_temp.val_is('ix_count small', $q$select ix_count(999)$q$, '999');
select pg_temp.val_is('ix_rupees_short lakhs', $q$select ix_rupees_short(4320000)$q$, '₹43.2L');
select pg_temp.val_is('ix_rupees_short crores', $q$select ix_rupees_short(15000000)$q$, '₹1.5Cr');
select pg_temp.val_is('ix_rupees_short under a lakh', $q$select ix_rupees_short(38500)$q$, '₹38,500');
select pg_temp.val_is('ix_rupees_short drops .0', $q$select ix_rupees_short(600000)$q$, '₹6L');
select pg_temp.val_is('ix_hour_range evening', $q$select ix_hour_range(19)$q$, '7–9 pm');
select pg_temp.val_is('ix_hour_range across noon', $q$select ix_hour_range(11)$q$, '11 am–1 pm');

-- ---------- weekly brief ----------
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('brief has 4 lines', $q$select array_length(admin_weekly_brief(), 1)::text$q$, '4');
select pg_temp.val_is('owner forecast in rupees, reported by callers',
  format($q$select (admin_weekly_brief())[1]$q$),
  'Fees Oct: at this speed you will collect ₹5.7L of ₹6L by ' || to_char(:'endd'::date, 'FMDD Mon') || ' (₹2.8L so far, reported by callers).');
select pg_temp.val_is('best hours and a caller''s usual hour', $q$select (admin_weekly_brief())[2]$q$,
  'People pick up most on weekdays 6–8 pm (100%). Caller B calls mostly at 11 am (100% of their calls).');
select pg_temp.val_is('broken promises and the 7-day rule', $q$select (admin_weekly_brief())[3]$q$,
  '9 people broke a promise. People who promised more than 7 days away kept it 30% of the time (within 7 days: 80%). Ask for a date within 7 days.');
select pg_temp.val_is('script version change', $q$select (admin_weekly_brief())[4]$q$,
  'Script one: v2 gets 3 fewer good results per 100 picked-up calls than v1. Most calls without a good result end at "Fee step".');
select pg_temp.val_is('brief for one campaign', format($q$select (admin_weekly_brief(%L))[4]$q$, :'k_fees'),
  'Script one: v2 gets 3 fewer good results per 100 picked-up calls than v1. Most calls without a good result end at "Fee step".');
select pg_temp.val_is('campaign without calls', format($q$select (admin_weekly_brief(%L))[1]$q$, :'k_sales'),
  'Sales Oct: not enough calls yet to forecast (0 of 50).');
select pg_temp.val_is('campaign without calls: hours', format($q$select (admin_weekly_brief(%L))[2]$q$, :'k_sales'),
  'Not enough calls in the last 4 weeks to find the best hours to call (0 of 50).');
select pg_temp.val_is('campaign without calls: promises', format($q$select (admin_weekly_brief(%L))[3]$q$, :'k_sales'),
  'No promises have come due yet.');
select pg_temp.val_is('campaign without a script', format($q$select (admin_weekly_brief(%L))[4]$q$, :'k_sales'),
  'No calls with a script in the last 4 weeks, so there is no script change to compare.');
select pg_temp.fails_with('another institute''s campaign', format($q$select admin_weekly_brief(%L)$q$, :'k_j'), 'campaign not found');
select pg_temp.as_user(:'u_m');
select pg_temp.val_is('manager without money gets counts', $q$select (admin_weekly_brief())[1]$q$,
  'Fees Oct: 40 of 82 leads have a good result so far. At this speed it will be 69 by ' || to_char(:'endd'::date, 'FMDD Mon') || '.');
select pg_temp.val_is('no rupee sign for a manager', $q$select (array_to_string(admin_weekly_brief(), ' ') like '%₹%')::text$q$, 'false');
select pg_temp.as_user(:'u_a');
select pg_temp.fails_with('a caller cannot read the brief', $q$select admin_weekly_brief()$q$, 'only an admin');
select pg_temp.fails('the browser cannot call weekly_brief_lines', format($q$select weekly_brief_lines(%L, null, true)$q$, :'inst_i'));
select pg_temp.fails('the browser cannot list recipients', $q$select * from weekly_brief_recipients()$q$);
select pg_temp.fails('the browser cannot call ix_campaign_calls',
  format($q$select count(*) from ix_campaign_calls(%L, null, '-infinity', 'infinity')$q$, :'inst_i'));
select pg_temp.as_user(:'u_x');
select pg_temp.val_is('no add-on: script line asks for Scripts', $q$select (admin_weekly_brief())[4]$q$,
  'Add Scripts to see how each script version does.');
select pg_temp.val_is('J forecast without calls', $q$select (admin_weekly_brief())[1]$q$,
  'J Fees: not enough calls yet to forecast (0 of 50).');
reset role;
update institutes set hide_money = true where id = :'inst_i';
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('hide money: owner gets counts', $q$select (array_to_string(admin_weekly_brief(), ' ') like '%₹%')::text$q$, 'false');
reset role;
update institutes set hide_money = false where id = :'inst_i';
set role service_role;
select pg_temp.as_user(null);
select pg_temp.val_is('server: counts-only lines', format($q$select (weekly_brief_lines(%L))[1]$q$, :'inst_i'),
  'Fees Oct: 40 of 82 leads have a good result so far. At this speed it will be 69 by ' || to_char(:'endd'::date, 'FMDD Mon') || '.');
select pg_temp.val_is('server: script line checks the add-on without a login', format($q$select (weekly_brief_lines(%L))[4] like 'Script one:%%'$q$, :'inst_i'), 'true');
select pg_temp.val_is('server: owners to email', $q$select string_agg(institute_name || '=' || array_to_string(emails, ','), ';' order by institute_name) from weekly_brief_recipients()$q$,
  'Inst I=owner@i.test;Inst J=owner@j.test');
select pg_temp.fails_with('server: campaign must be in the institute', format($q$select weekly_brief_lines(%L, %L)$q$, :'inst_i', :'k_j'), 'campaign not found');
reset role;

-- ---------- script A/B test ----------
insert into leads (institute_id, campaign_id, name, phone, assigned_seat_id)
  select :'inst_i', :'k_fees', 't' || i, '+91940000' || lpad(i::text, 4, '0'), case when i <= 6 then :'s_a'::uuid else :'s_b'::uuid end
  from generate_series(1, 7) i;
insert into leads (institute_id, campaign_id, name, phone, assigned_seat_id) values
  (:'inst_j', :'k_j', 'j1', '+919500000001', :'s_c');
select id as t1 from leads where name = 't1' \gset
select id as t2 from leads where name = 't2' \gset
select id as t3 from leads where name = 't3' \gset
select id as t4 from leads where name = 't4' \gset
select id as t5 from leads where name = 't5' \gset
select id as t6 from leads where name = 't6' \gset
select id as t7 from leads where name = 't7' \gset
select id as j1 from leads where name = 'j1' \gset

set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.val_is('no test: the published version', format($q$select version || ':' || (test_id is null) from campaign_script_version(%L, %L)$q$, :'k_fees', :'t1'), '1:true');
select pg_temp.val_is('no lead: the published version', format($q$select version::text from campaign_script_version(%L)$q$, :'k_fees'), '1');
select pg_temp.val_is('steps come with it', format($q$select steps->0->'say'->>0 from campaign_script_version(%L)$q$, :'k_fees'), 'Hi {name}, v1');
select pg_temp.val_is('pushbacks come with it (none on v1)', format($q$select pushbacks::text from campaign_script_version(%L)$q$, :'k_fees'), '[]');
select pg_temp.val_is('no script on the campaign: no rows', format($q$select count(*)::text from campaign_script_version(%L)$q$, :'k_sales'), '0');
select pg_temp.fails_with('a caller cannot use a draft campaign', format($q$select * from campaign_script_version(%L)$q$, :'k_draft'), 'campaign not found');
select pg_temp.fails_with('a caller cannot ask for another caller''s lead', format($q$select * from campaign_script_version(%L, %L)$q$, :'k_fees', :'t7'), 'lead not found');
select pg_temp.fails_with('a caller cannot start a test', format($q$select admin_start_script_test(%L, 1, 2)$q$, :'k_fees'), 'campaign not found');
select pg_temp.as_user(:'u_c');
select pg_temp.fails_with('another institute''s campaign', format($q$select * from campaign_script_version(%L)$q$, :'k_fees'), 'campaign not found');
select pg_temp.val_is('no add-on: no script rows', format($q$select count(*)::text from campaign_script_version(%L, %L)$q$, :'k_j', :'j1'), '0');
select pg_temp.as_user(:'u_x');
select pg_temp.fails_with('no add-on: no test', format($q$select admin_start_script_test(%L, 1, 2)$q$, :'k_j'), 'Scripts add-on');
select pg_temp.fails_with('no add-on: no test card', format($q$select admin_script_test(%L)$q$, :'k_j'), 'Scripts add-on');
select pg_temp.fails_with('other institute cannot start a test', format($q$select admin_start_script_test(%L, 1, 2)$q$, :'k_fees'), 'campaign not found');
select pg_temp.as_user(:'u_m');
select pg_temp.fails_with('two different versions', format($q$select admin_start_script_test(%L, 1, 1)$q$, :'k_fees'), 'two different versions');
select pg_temp.fails_with('versions must exist', format($q$select admin_start_script_test(%L, 1, 9)$q$, :'k_fees'), 'version was not found');
select pg_temp.fails_with('campaign needs a script', format($q$select admin_start_script_test(%L, 1, 2)$q$, :'k_sales'), 'choose a script');
select pg_temp.val_is('test card before a test', format($q$select jsonb_typeof(admin_script_test(%L)->'test') = 'null' and jsonb_array_length(admin_script_test(%L)->'versions') = 2$q$, :'k_fees', :'k_fees'), 'true');
select pg_temp.ok('a manager starts a test of v1 against v2', format($q$select admin_start_script_test(%L, 1, 2)$q$, :'k_fees'));
select pg_temp.fails_with('one running test per campaign', format($q$select admin_start_script_test(%L, 2, 1)$q$, :'k_fees'), 'already running');

select pg_temp.as_user(:'u_a');
select pg_temp.val_is('first lead hears A', format($q$select arm || ':v' || version from campaign_script_version(%L, %L)$q$, :'k_fees', :'t1'), 'a:v1');
select pg_temp.val_is('second lead hears B', format($q$select arm || ':v' || version from campaign_script_version(%L, %L)$q$, :'k_fees', :'t2'), 'b:v2');
select pg_temp.val_is('draft version steps reach the caller', format($q$select steps->0->'say'->>0 from campaign_script_version(%L, %L)$q$, :'k_fees', :'t2'), 'Hi {name}, v2');
select pg_temp.val_is('and the pushbacks of that version', format($q$select pushbacks->0->>'label' from campaign_script_version(%L, %L)$q$, :'k_fees', :'t2'), 'Can I pay late?');
select pg_temp.val_is('the same lead keeps its version', format($q$select arm || ':v' || version from campaign_script_version(%L, %L)$q$, :'k_fees', :'t1'), 'a:v1');
select pg_temp.ok('more leads', format($q$select (select arm from campaign_script_version(%1$L, %2$L)) || (select arm from campaign_script_version(%1$L, %3$L)) || (select arm from campaign_script_version(%1$L, %4$L)) || (select arm from campaign_script_version(%1$L, %5$L))$q$, :'k_fees', :'t3', :'t4', :'t5', :'t6'));
select pg_temp.val_is('no lead: still the published version', format($q$select version || ':' || (test_id is null) from campaign_script_version(%L)$q$, :'k_fees'), '1:true');
select pg_temp.fails('the browser cannot read test tables', $q$select count(*) from script_test_leads$q$);
select pg_temp.fails('the browser cannot write tests', format($q$insert into script_tests (institute_id, campaign_id, script_id, version_a, version_b) values (%L, %L, %L, 1, 2)$q$, :'inst_i', :'k_sales', :'sc1'));
reset role;
select pg_temp.val_is('split 50/50', $q$select string_agg(arm, '' order by l.name) from script_test_leads a join leads l on l.id = a.lead_id$q$, 'ababab');

-- Calls in the test (now): t1 paid, t3 no answer, t5 paid (A = v1); t2 refused then corrected to paid, t4 paid,
-- t6 refused (B = v2).
insert into call_outcomes (id, institute_id, seat_id, client_record_id, lead_id, result_key, amount, result_reason,
                           script_id, script_version, dialled_at, connected_seconds)
select case when name = 't2' then 'c6000000-0000-0000-0000-000000000002'::uuid else gen_random_uuid() end,
       :'inst_i', :'s_a', 'ab-' || name, id,
       case name when 't1' then 'paid' when 't3' then 'no_answer' when 't5' then 'paid'
                 when 't2' then 'refused' when 't4' then 'paid' else 'refused' end,
       case when name in ('t1', 't5', 't4') then 5000 end,
       case when name in ('t2', 't6') then 'No' end,
       :'sc1', case when name in ('t1', 't3', 't5') then 1 else 2 end,
       now(), case name when 't1' then 300 when 't3' then 0 when 't5' then 100 else 120 end
from leads where name in ('t1', 't2', 't3', 't4', 't5', 't6');
insert into call_outcomes (institute_id, seat_id, client_record_id, corrects_id, lead_id, result_key, amount, outcome,
                           script_id, script_version, dialled_at, connected_seconds)
  values (:'inst_i', :'s_a', 'ab-t2-fix', 'c6000000-0000-0000-0000-000000000002', :'t2', 'paid', 5000, 'won', :'sc1', 2, now(), 120);

set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('arm A counts', format($q$select (a->>'version') || ' ' || (a->>'calls') || ' ' || (a->>'picked_up') || ' ' || (a->>'good') || ' ' || (a->>'avg_seconds') from jsonb_array_elements(admin_script_test(%L)->'test'->'arms') a where a->>'arm' = 'a'$q$, :'k_fees'), '1 3 2 2 200');
select pg_temp.val_is('arm B counts (correction applied)', format($q$select (a->>'version') || ' ' || (a->>'calls') || ' ' || (a->>'picked_up') || ' ' || (a->>'good') || ' ' || (a->>'avg_seconds') from jsonb_array_elements(admin_script_test(%L)->'test'->'arms') a where a->>'arm' = 'b'$q$, :'k_fees'), '2 3 3 2 120');
select pg_temp.val_is('change note of B', format($q$select a->>'change_note' from jsonb_array_elements(admin_script_test(%L)->'test'->'arms') a where a->>'arm' = 'b'$q$, :'k_fees'), 'Shorter opening');
select pg_temp.val_is('test card: running, 6 leads', format($q$select (admin_script_test(%1$L)->'test'->>'status') || ' ' || (admin_script_test(%1$L)->'test'->>'leads')$q$, :'k_fees'), 'running 6');
select pg_temp.val_is('no money in the test card', format($q$select (admin_script_test(%L)::text ~ 'amount|5000\.|"5000"| 5000')::text$q$, :'k_fees'), 'false');
reset role;
select id as test1 from script_tests limit 1 \gset
set role authenticated;
select pg_temp.fails_with('winner must be in the test', format($q$select admin_end_script_test(%L, 7)$q$, :'test1'), 'one of the two');
select pg_temp.as_user(:'u_a');
select pg_temp.fails_with('a caller cannot end a test', format($q$select admin_end_script_test(%L, 2)$q$, :'test1'), 'test not found');
select pg_temp.as_user(:'u_x');
select pg_temp.fails_with('other institute cannot end a test', format($q$select admin_end_script_test(%L, 2)$q$, :'test1'), 'test not found');
select pg_temp.as_user(:'u_o');
select pg_temp.ok('use v2 for everyone', format($q$select admin_end_script_test(%L, 2)$q$, :'test1'));
select pg_temp.fails_with('a test ends once', format($q$select admin_end_script_test(%L, 1)$q$, :'test1'), 'already ended');
select pg_temp.as_user(:'u_a');
select pg_temp.val_is('v2 is now published for everyone', format($q$select version || ':' || (test_id is null) from campaign_script_version(%L, %L)$q$, :'k_fees', :'t1'), '2:true');
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('ended test with winner', format($q$select (admin_script_test(%1$L)->'test'->>'status') || ' ' || (admin_script_test(%1$L)->'test'->>'winner')$q$, :'k_fees'), 'ended 2');
select pg_temp.ok('a new test can start', format($q$select admin_start_script_test(%L, 2, 1)$q$, :'k_fees'));
reset role;
select id as test2 from script_tests where status = 'running' \gset
set role authenticated;
select pg_temp.as_user(:'u_b');
select pg_temp.val_is('new test: B''s lead hears A (v2)', format($q$select arm || ':v' || version from campaign_script_version(%L, %L)$q$, :'k_fees', :'t7'), 'a:v2');
select pg_temp.as_user(:'u_a');
select pg_temp.val_is('new test: next lead hears B (v1)', format($q$select arm || ':v' || version from campaign_script_version(%L, %L)$q$, :'k_fees', :'t1'), 'b:v1');
select pg_temp.as_user(:'u_o');
select pg_temp.ok('stop without a winner', format($q$select admin_end_script_test(%L)$q$, :'test2'));
reset role;
select pg_temp.val_is('stopping keeps the published version', format($q$select string_agg(version || ':' || published, ',' order by version) from script_versions where script_id = %L$q$, :'sc1'), '1:false,2:true');
-- A running test whose draft version is deleted falls back to the published version.
insert into script_versions (script_id, institute_id, version, steps, change_note, published)
  values (:'sc1', :'inst_i', 3, '[{"id":"open","start":true,"say":["v3"]}]', 'Draft three', false);
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.ok('test v2 against draft v3', format($q$select admin_start_script_test(%L, 2, 3)$q$, :'k_fees'));
select pg_temp.as_user(:'u_a');
select pg_temp.val_is('first lead: v2', format($q$select arm || ':v' || version from campaign_script_version(%L, %L)$q$, :'k_fees', :'t1'), 'a:v2');
select pg_temp.val_is('second lead: draft v3', format($q$select arm || ':v' || version from campaign_script_version(%L, %L)$q$, :'k_fees', :'t2'), 'b:v3');
reset role;
delete from script_versions where script_id = :'sc1' and version = 3;
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.val_is('deleted draft: back to the published version', format($q$select version || ':' || (test_id is null) from campaign_script_version(%L, %L)$q$, :'k_fees', :'t2'), '2:true');
reset role;
update script_tests set status = 'ended', ended_at = now() where status = 'running';
select pg_temp.val_is('audit rows', $q$select string_agg(action, ',' order by id) from audit_log where action like 'script%'$q$,
  'script_test.started,script.published,script_test.ended,script_test.started,script_test.ended,script_test.started');

-- ---------- practice mode ----------
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.fails_with('a caller cannot assign practice', format($q$select admin_assign_practice(%L, %L)$q$, :'s_a', :'sc1'), 'seat not found');
select pg_temp.val_is('published scripts to practise, none assigned', $q$select string_agg(script_name || ':' || version || ':' || (assignment_id is null), ',') from my_practice()$q$, 'Script one:2:true');
select pg_temp.as_user(:'u_x');
select pg_temp.fails_with('other institute cannot assign', format($q$select admin_assign_practice(%L, %L)$q$, :'s_a', :'sc1'), 'seat not found');
select pg_temp.fails_with('no add-on: no practice requests', format($q$select admin_assign_practice(%L, %L)$q$, :'s_c', :'sc_j'), 'Scripts add-on');
select pg_temp.as_user(:'u_c');
select pg_temp.fails_with('no add-on: no practice', $q$select * from my_practice()$q$, 'Scripts add-on');
select pg_temp.as_user(:'u_m');
select pg_temp.fails_with('script must be published', format($q$select admin_assign_practice(%L, %L)$q$, :'s_a', :'sc2'), 'publish this script');
select pg_temp.fails_with('script must be in the institute', format($q$select admin_assign_practice(%L, %L)$q$, :'s_a', :'sc_j'), 'script not found');
select pg_temp.fails_with('note length', format($q$select admin_assign_practice(%L, %L, repeat('x', 301))$q$, :'s_a', :'sc1'), '300 characters');
select pg_temp.ok('manager sends A to practise', format($q$select admin_assign_practice(%L, %L, 'Slow down at the fee step')$q$, :'s_a', :'sc1'));
select pg_temp.ok('asking again refreshes', format($q$select admin_assign_practice(%L, %L, 'Again please')$q$, :'s_a', :'sc1'));
select pg_temp.val_is('admin list', $q$select string_agg(seat_label || ':' || script_name || ':' || note || ':' || times_done, ',') from admin_list_practice()$q$, 'Caller A:Script one:Again please:0');
select pg_temp.as_user(:'u_a');
select pg_temp.val_is('caller sees the request with steps', $q$select note || ':' || assigned_by || ':' || (steps->0->>'id') || ':' || (done_at is null) from my_practice() where assignment_id is not null$q$, 'Again please:Manager:open:true');
select pg_temp.as_user(:'u_b');
select pg_temp.val_is('another caller sees no request', $q$select count(*)::text from my_practice() where assignment_id is not null$q$, '0');
reset role;
select id as pa from practice_assignments limit 1 \gset
set role authenticated;
select pg_temp.fails_with('only the own request can be marked done', format($q$select my_practice_done(%L, 60)$q$, :'pa'), 'practice not found');
select pg_temp.as_user(:'u_a');
select pg_temp.fails_with('time must be sensible', format($q$select my_practice_done(%L, -5)$q$, :'pa'), 'between 0 and 86400');
select pg_temp.ok('caller finishes practice', format($q$select my_practice_done(%L, 95)$q$, :'pa'));
select pg_temp.val_is('marked done', $q$select times_done || ':' || (done_at is not null) from my_practice() where assignment_id is not null$q$, '1:true');
select pg_temp.fails('the browser cannot read practice requests', $q$select count(*) from practice_assignments$q$);
select pg_temp.fails('the browser cannot write practice requests', format($q$insert into practice_assignments (institute_id, seat_id, script_id) values (%L, %L, %L)$q$, :'inst_i', :'s_b', :'sc1'));
reset role;
select pg_temp.val_is('practice never writes calls', $q$select (count(*) - 6 - 1)::text from call_outcomes$q$, :'calls_before_test');
select pg_temp.val_is('practice audit', $q$select count(*)::text from audit_log where action = 'practice.assigned'$q$, '2');

select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
