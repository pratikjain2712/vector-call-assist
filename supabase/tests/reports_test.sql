-- Tests for 20261024100024_reports.sql: the Fees collection report, promises due, "Send these back to
-- callers" and the sales funnel. Admin seat and institute checks, money only with can_see_money, latest
-- corrections, campaign and caller filters. Run after every migration on a scratch database with
-- supabase/tests/stub_auth.sql. The last line prints passed and failed counts: expect failed = 0.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid, mail text) returns void language sql as $$
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
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;

-- ---------- fixed ids ----------
\set inst_i 'a1111111-0000-0000-0000-000000000001'
\set inst_j 'a2222222-0000-0000-0000-000000000002'
\set u_o  'c9000000-0000-0000-0000-000000000001'
\set u_m  'c9000000-0000-0000-0000-000000000002'
\set u_m2 'c9000000-0000-0000-0000-000000000003'
\set u_a  'c9000000-0000-0000-0000-000000000004'
\set u_b  'c9000000-0000-0000-0000-000000000005'
\set u_x  'c9000000-0000-0000-0000-000000000006'
\set s_o  'd1000000-0000-0000-0000-000000000001'
\set s_m  'd1000000-0000-0000-0000-000000000002'
\set s_m2 'd1000000-0000-0000-0000-000000000003'
\set s_a  'd1000000-0000-0000-0000-000000000004'
\set s_b  'd1000000-0000-0000-0000-000000000005'
\set s_x  'd2000000-0000-0000-0000-000000000006'
\set kf   'd3000000-0000-0000-0000-000000000001'
\set ks   'd3000000-0000-0000-0000-000000000002'
\set kj   'd3000000-0000-0000-0000-000000000003'
\set sc1  'd5000000-0000-0000-0000-000000000001'
\set sc2  'd5000000-0000-0000-0000-000000000002'
\set l1   'd4000000-0000-0000-0000-000000000001'
\set l2   'd4000000-0000-0000-0000-000000000002'
\set l3   'd4000000-0000-0000-0000-000000000003'
\set l4   'd4000000-0000-0000-0000-000000000004'
\set l5   'd4000000-0000-0000-0000-000000000005'
\set l6   'd4000000-0000-0000-0000-000000000006'
\set lj   'd4000000-0000-0000-0000-000000000009'
\set o_r  'd6000000-0000-0000-0000-000000000001'
\set o_s  'd6000000-0000-0000-0000-000000000002'

-- ---------- fixtures (as the table owner) ----------
-- Inst I: owner O, managers M (no money) and M2 (money), callers A and B. Inst J: owner X.
-- Fees campaign kf. Leads (today = UTC date):
--   l1 A due 10000, promised 4000 two days ago (late)   l2 A due 5000, promised 5000 today
--   l3 B due 8000, promised 3000 in 3 days              l4 B due 7000, done (paid 7000 after a call)
--   l5 B due 2000, promised 1000 in 10 days             l6 A no amount, promised yesterday but do not call
-- Paid calls in range: B paid 7000 on l4; A paid part 1000 on l1; A paid 500 on l2, corrected to Refused.
-- Sales campaign ks uses script sc1 (v1, pitch marked on step 3); script sc2 has no pitch mark.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'owner@i.test', now()), (:'u_m', 'm@i.test', now()), (:'u_m2', 'm2@i.test', now()),
 (:'u_a', 'a@i.test', now()), (:'u_b', 'b@i.test', now()), (:'u_x', 'owner@j.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 10), (:'inst_j', 'Inst J', 'active', 10);
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, can_see_money, status) values
 (:'s_m',  :'inst_i', :'u_m',  'Manager', 'admin', 'manager', false, 'active'),
 (:'s_m2', :'inst_i', :'u_m2', 'Manager 2', 'admin', 'manager', true, 'active'),
 (:'s_a',  :'inst_i', :'u_a',  'Caller A', 'rep', null, false, 'active'),
 (:'s_b',  :'inst_i', :'u_b',  'Caller B', 'rep', null, false, 'active'),
 (:'s_x',  :'inst_j', :'u_x',  'Owner J', 'admin', 'owner', false, 'active');
insert into scripts (id, institute_id, name) values (:'sc1', :'inst_i', 'Sales v1'), (:'sc2', :'inst_i', 'Old sales');
insert into script_versions (script_id, institute_id, version, published, steps) values
 (:'sc1', :'inst_i', 1, true, '[{"id":"open","start":true},{"id":"ask"},{"id":"offer","pitch":true},{"id":"yes"},{"id":"no"}]'),
 (:'sc2', :'inst_i', 1, true, '[{"id":"a","start":true},{"id":"b"},{"id":"c"},{"id":"d"},{"id":"e"}]');
insert into campaigns (id, institute_id, name, call_type_id, status, script_id) values
 (:'kf', :'inst_i', 'Oct fees', (select id from call_types where key='fees' and institute_id is null), 'running', null),
 (:'ks', :'inst_i', 'Course sales', (select id from call_types where key='sales' and institute_id is null), 'running', :'sc1'),
 (:'kj', :'inst_j', 'J fees', (select id from call_types where key='fees' and institute_id is null), 'running', null);
insert into leads (id, institute_id, campaign_id, name, phone, extra, amount_due, promised_amount, promised_date, status, do_not_call, assigned_seat_id) values
 (:'l1', :'inst_i', :'kf', 'Parent One',   '9876500001', '{"Student":"Ravi","Class":"10-A"}', 10000, 4000, (now() at time zone 'UTC')::date - 2, 'promised', false, :'s_a'),
 (:'l2', :'inst_i', :'kf', 'Parent Two',   '9876500002', '{}', 5000, 5000, (now() at time zone 'UTC')::date, 'promised', false, :'s_a'),
 (:'l3', :'inst_i', :'kf', 'Parent Three', '9876500003', '{}', 8000, 3000, (now() at time zone 'UTC')::date + 3, 'promised', false, :'s_b'),
 (:'l4', :'inst_i', :'kf', 'Parent Four',  '9876500004', '{}', 7000, null, null, 'done', false, :'s_b'),
 (:'l5', :'inst_i', :'kf', 'Parent Five',  '9876500005', '{}', 2000, 1000, (now() at time zone 'UTC')::date + 10, 'promised', false, :'s_b'),
 (:'l6', :'inst_i', :'kf', 'Parent Six',   '9876500006', '{}', null, null, (now() at time zone 'UTC')::date - 1, 'promised', true, :'s_a'),
 (:'lj', :'inst_j', :'kj', 'Parent J',     '9876500009', '{}', 9000, 9000, (now() at time zone 'UTC')::date, 'promised', false, :'s_x');

-- Fees calls.
insert into call_outcomes (id, institute_id, seat_id, client_record_id, campaign_id, lead_id, result_key, amount, result_reason, dialled_at) values
 (gen_random_uuid(), :'inst_i', :'s_b', 'f-1', :'kf', :'l4', 'paid', 7000, null, now() - interval '1 hour'),
 (gen_random_uuid(), :'inst_i', :'s_a', 'f-2', :'kf', :'l1', 'paid_part', 1000, null, now() - interval '1 hour'),
 (:'o_r', :'inst_i', :'s_a', 'f-3', :'kf', :'l2', 'paid', 500, null, now() - interval '1 hour'),
 (gen_random_uuid(), :'inst_i', :'s_a', 'f-4', :'kf', :'l1', 'paid', 99999, null, now() - interval '10 days'),
 (gen_random_uuid(), :'inst_j', :'s_x', 'f-5', :'kj', :'lj', 'paid', 9000, null, now() - interval '1 hour');
insert into call_outcomes (institute_id, seat_id, client_record_id, corrects_id, campaign_id, lead_id, result_key, result_reason, dialled_at) values
 (:'inst_i', :'s_a', 'f-3c', :'o_r', :'kf', :'l2', 'refused', 'Wrong amount', now() - interval '1 hour');

-- Sales calls (in range unless said).
insert into call_outcomes (id, institute_id, seat_id, client_record_id, campaign_id, script_id, script_version, outcome, result_key, result_reason, reached_step, script_step, connected_seconds, dialled_at) values
 (gen_random_uuid(), :'inst_i', :'s_a', 's-1', :'ks', :'sc1', 1, 'no_answer', null, null, null, null, 0, now() - interval '2 hours'),
 (gen_random_uuid(), :'inst_i', :'s_b', 's-2', :'ks', :'sc1', 1, 'busy', null, null, null, null, 0, now() - interval '2 hours'),
 (gen_random_uuid(), :'inst_i', :'s_a', 's-3', :'ks', :'sc1', 1, null, 'not_interested', 'Price', 'ask', null, 40, now() - interval '2 hours'),
 (gen_random_uuid(), :'inst_i', :'s_a', 's-4', :'ks', :'sc1', 1, null, 'not_interested', 'Price', 'offer', null, 90, now() - interval '2 hours'),
 (:'o_s', :'inst_i', :'s_a', 's-5', :'ks', :'sc1', 1, 'callback', null, null, 'yes', null, 120, now() - interval '2 hours'),
 (gen_random_uuid(), :'inst_i', :'s_b', 's-6', :'ks', :'sc1', 1, null, 'joined', null, 'yes', null, 200, now() - interval '2 hours'),
 (gen_random_uuid(), :'inst_i', :'s_a', 's-7', null, :'sc2', 1, 'answered', null, null, null, 'd', 60, now() - interval '2 hours'),
 (gen_random_uuid(), :'inst_i', :'s_b', 's-8', :'ks', null, null, 'answered', null, null, null, null, 30, now() - interval '2 hours'),
 (gen_random_uuid(), :'inst_i', :'s_b', 's-9', :'ks', :'sc1', 1, 'won', null, null, 'yes', null, 30, now() - interval '20 days');
insert into call_outcomes (institute_id, seat_id, client_record_id, corrects_id, campaign_id, outcome, dialled_at) values
 (:'inst_i', :'s_a', 's-5c', :'o_s', :'ks', 'interested', now() - interval '2 hours');


-- ---------- Fees collection: owner (money) ----------
select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.val_is('fees: leads with an amount due', format($q$select leads::text from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), '5');
select pg_temp.val_is('fees: total due', format($q$select total_due::int::text from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), '32000');
select pg_temp.val_is('fees: paid calls use the latest correction and the date range', format($q$select paid_calls||'/'||paid_leads from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), '2/2');
select pg_temp.val_is('fees: paid amount (reported by caller)', format($q$select paid_amount::int::text from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), '8000');
select pg_temp.val_is('fees: open promises (do not call left out)', format($q$select promised_leads||'/'||promised_amount::int from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), '4/13000');
select pg_temp.val_is('fees: promise date passed, not paid', format($q$select broken_promises::text from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), '1');
select pg_temp.val_is('fees: owner sees money', format($q$select money_hidden::text from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), 'false');
select pg_temp.val_is('fees: caller filter (Caller A)', format($q$select leads||'/'||total_due::int||'/'||paid_calls||'/'||paid_amount::int||'/'||promised_leads||'/'||broken_promises from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour', null, %L)$q$, :'inst_i', :'s_a'), '2/15000/1/1000/2/1');
select pg_temp.val_is('fees: campaign filter (a sales campaign has no fees)', format($q$select leads||'/'||paid_calls from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour', %L)$q$, :'inst_i', :'ks'), '0/0');
select pg_temp.val_is('fees: a wider range counts the older paid call', format($q$select paid_calls::text from admin_fees_report(%L, now() - interval '30 days', now() + interval '1 hour')$q$, :'inst_i'), '3');
select pg_temp.fails('fees: another institute''s campaign is refused', format($q$select * from admin_fees_report(%L, now() - interval '1 day', now(), %L)$q$, :'inst_i', :'kj'));
select pg_temp.fails('fees: another institute''s seat is refused', format($q$select * from admin_fees_report(%L, now() - interval '1 day', now(), null, %L)$q$, :'inst_i', :'s_x'));
select pg_temp.fails('fees: a bad range is refused', format($q$select * from admin_fees_report(%L, now(), now() - interval '1 day')$q$, :'inst_i'));
select pg_temp.fails('fees: an unknown time zone is refused', format($q$select * from admin_fees_report(%L, now() - interval '1 day', now(), null, null, 'Mars/Base')$q$, :'inst_i'));
select pg_temp.fails('fees: owner of I cannot read inst J', format($q$select * from admin_fees_report(%L, now() - interval '1 day', now())$q$, :'inst_j'));

-- ---------- promises due ----------
select pg_temp.val_is('promises: due this week, late ones first, do not call and later ones left out', format($q$select string_agg(name || ':' || days_late, ',' order by promised_date) from admin_promises_due(%L)$q$, :'inst_i'), 'Parent One:2,Parent Two:0,Parent Three:-3');
select pg_temp.val_is('promises: owner sees the promised amount', format($q$select amount::int::text from admin_promises_due(%L) where name='Parent One'$q$, :'inst_i'), '4000');
select pg_temp.val_is('promises: student and class come from extra', format($q$select extra->>'Student' || ' ' || (extra->>'Class') from admin_promises_due(%L) where name='Parent One'$q$, :'inst_i'), 'Ravi 10-A');
select pg_temp.val_is('promises: caller and campaign names', format($q$select caller || ' / ' || campaign from admin_promises_due(%L) where name='Parent Three'$q$, :'inst_i'), 'Caller B / Oct fees');
select pg_temp.val_is('promises: caller filter', format($q$select count(*)::text from admin_promises_due(%L, null, %L)$q$, :'inst_i', :'s_b'), '1');
select pg_temp.val_is('promises: 14 days takes the later promise too', format($q$select count(*)::text from admin_promises_due(%L, null, null, 'UTC', 14)$q$, :'inst_i'), '4');
select pg_temp.fails('promises: 0 days is refused', format($q$select * from admin_promises_due(%L, null, null, 'UTC', 0)$q$, :'inst_i'));
reset role;

-- ---------- money hidden: manager without money, and "Hide money everywhere" ----------
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('fees: a manager without money gets counts only', format($q$select leads||'/'||coalesce(total_due::text,'null')||'/'||coalesce(paid_amount::text,'null')||'/'||coalesce(promised_amount::text,'null')||'/'||money_hidden from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), '5/null/null/null/true');
select pg_temp.val_is('promises: a manager without money gets no amounts', format($q$select count(amount)||'/'||count(*)||'/'||bool_and(money_hidden) from admin_promises_due(%L)$q$, :'inst_i'), '0/3/true');
reset role;

select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.val_is('fees: a manager with money access sees money', format($q$select total_due::int::text from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), '32000');
reset role;

update institutes set hide_money = true where id = :'inst_i';
select pg_temp.as_user(:'u_o', 'owner@i.test');
set role authenticated;
select pg_temp.val_is('fees: hide money hides it from the owner too', format($q$select coalesce(total_due::text,'null')||'/'||money_hidden||'/'||paid_calls from admin_fees_report(%L, now() - interval '1 day', now() + interval '1 hour')$q$, :'inst_i'), 'null/true/2');
select pg_temp.val_is('promises: hide money hides amounts from the owner', format($q$select count(amount)::text from admin_promises_due(%L)$q$, :'inst_i'), '0');
reset role;
update institutes set hide_money = false where id = :'inst_i';

-- ---------- callers and other institutes ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.fails('a caller cannot run the fees report', format($q$select * from admin_fees_report(%L, now() - interval '1 day', now())$q$, :'inst_i'));
select pg_temp.fails('a caller cannot list promises', format($q$select * from admin_promises_due(%L)$q$, :'inst_i'));
select pg_temp.fails('a caller cannot send leads back', format($q$select admin_send_back_leads(%L, array[%L]::uuid[])$q$, :'inst_i', :'l1'));
select pg_temp.fails('a caller cannot run the sales funnel', format($q$select admin_sales_funnel(%L, now() - interval '1 day', now())$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_x', 'owner@j.test');
set role authenticated;
select pg_temp.fails('owner J cannot list inst I promises', format($q$select * from admin_promises_due(%L)$q$, :'inst_i'));
select pg_temp.fails('owner J cannot send inst I leads back', format($q$select admin_send_back_leads(%L, array[%L]::uuid[])$q$, :'inst_i', :'l3'));
select pg_temp.val_is('owner J sending inst I leads through its own institute changes nothing', format($q$select admin_send_back_leads(%L, array[%L]::uuid[])::text$q$, :'inst_j', :'l3'), '0');
reset role;

-- ---------- send back to callers ----------
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('send back: only open leads of this institute change', format($q$select admin_send_back_leads(%L, array[%L, %L, %L, %L]::uuid[])::text$q$, :'inst_i', :'l3', :'l4', :'l6', :'lj'), '1');
select pg_temp.fails('send back: an empty list is refused', format($q$select admin_send_back_leads(%L, array[]::uuid[])$q$, :'inst_i'));
reset role;
select pg_temp.val_is('send back: the lead is due now', format($q$select (next_call_at <= now())::text from leads where id=%L$q$, :'l3'), 'true');
select pg_temp.val_is('send back: a finished lead is not touched', format($q$select coalesce(next_call_at::text, 'null') from leads where id=%L$q$, :'l4'), 'null');
select pg_temp.val_is('send back: inst J lead is not touched', format($q$select coalesce(next_call_at::text, 'null') from leads where id=%L$q$, :'lj'), 'null');
select pg_temp.val_is('send back: written to the audit log', format($q$select target from audit_log where institute_id=%L and action='leads.sent_back'$q$, :'inst_i'), '1');

-- ---------- sales funnel ----------
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('funnel: all sales calls and calls with no campaign', format($q$select f->>'called' from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour') f$q$, :'inst_i'), '8');
select pg_temp.val_is('funnel: picked up', format($q$select f->>'picked_up' from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour') f$q$, :'inst_i'), '6');
select pg_temp.val_is('funnel: heard the pitch (marked step, middle step, old end step)', format($q$select f->>'heard_pitch' from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour') f$q$, :'inst_i'), '4');
select pg_temp.val_is('funnel: interested counts the corrected call', format($q$select f->>'interested' from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour') f$q$, :'inst_i'), '2');
select pg_temp.val_is('funnel: joined', format($q$select f->>'joined' from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour') f$q$, :'inst_i'), '1');
select pg_temp.val_is('funnel: picked-up calls with no step', format($q$select f->>'no_step' from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour') f$q$, :'inst_i'), '1');
select pg_temp.val_is('funnel: says when the pitch step was guessed', format($q$select f->>'pitch_guessed' from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour') f$q$, :'inst_i'), 'true');
select pg_temp.val_is('funnel: top loss reason', format($q$select (f->'top_reason'->>'reason') || ':' || (f->'top_reason'->>'calls') from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour') f$q$, :'inst_i'), 'Price:2');
select pg_temp.val_is('funnel: campaign filter', format($q$select (f->>'called') || '/' || (f->>'heard_pitch') || '/' || (f->>'pitch_guessed') from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour', %L) f$q$, :'inst_i', :'ks'), '7/3/false');
select pg_temp.val_is('funnel: caller filter', format($q$select (f->>'called') || '/' || (f->>'joined') from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour', null, %L) f$q$, :'inst_i', :'s_b'), '3/1');
select pg_temp.val_is('funnel: a picked campaign is used whatever its type', format($q$select f->>'called' from admin_sales_funnel(%L, now() - interval '1 day', now() + interval '1 hour', %L) f$q$, :'inst_i', :'kf'), '3');
select pg_temp.val_is('funnel: no calls gives zeros and no reason', format($q$select (f->>'called') || '/' || coalesce(f->>'top_reason', 'none') from admin_sales_funnel(%L, now() - interval '100 days', now() - interval '90 days') f$q$, :'inst_i'), '0/none');
select pg_temp.fails('funnel: a bad range is refused', format($q$select admin_sales_funnel(%L, now(), now() - interval '1 day')$q$, :'inst_i'));
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot run admin_fees_report', $q$select has_function_privilege('anon','public.admin_fees_report(uuid,timestamptz,timestamptz,uuid,uuid,text)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run admin_promises_due', $q$select has_function_privilege('anon','public.admin_promises_due(uuid,uuid,uuid,text,int)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run admin_send_back_leads', $q$select has_function_privilege('anon','public.admin_send_back_leads(uuid,uuid[])','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run admin_sales_funnel', $q$select has_function_privilege('anon','public.admin_sales_funnel(uuid,timestamptz,timestamptz,uuid,uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('signed-in users can run the reports', $q$select has_function_privilege('authenticated','public.admin_sales_funnel(uuid,timestamptz,timestamptz,uuid,uuid)','EXECUTE')::text$q$, 'true');
select pg_temp.val_is('the effective-calls helper is internal', $q$select has_function_privilege('authenticated','public.report_effective_calls(uuid,timestamptz,timestamptz)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('the campaign scope helper is internal', $q$select has_function_privilege('authenticated','public.report_campaigns(uuid,uuid,text)','EXECUTE')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
