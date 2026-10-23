-- Tests for 20261024100021_caller_screen.sql: the caller's lead money when money is hidden, the caller's queue
-- (my_call_queue) and saving a campaign call (save_call_result). Run after every migration on a scratch
-- database with supabase/tests/stub_auth.sql. The last line prints passed and failed counts: expect failed = 0.
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
create or replace function pg_temp.fails_with(name text, sql text, want text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected an error, succeeded');
exception when others then insert into results values (name, sqlerrm ilike '%' || want || '%', sqlerrm); end $$;
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
\set s_o 'e1000000-0000-0000-0000-000000000001'
\set s_m 'e1000000-0000-0000-0000-000000000002'
\set s_a 'e1000000-0000-0000-0000-000000000003'
\set s_b 'e1000000-0000-0000-0000-000000000004'
\set s_c 'e1000000-0000-0000-0000-000000000005'
\set s_x 'e2000000-0000-0000-0000-000000000006'
\set k_fee 'e3000000-0000-0000-0000-000000000001'
\set k_sal 'e3000000-0000-0000-0000-000000000002'
\set k_drf 'e3000000-0000-0000-0000-000000000003'
\set l_new   'e4000000-0000-0000-0000-000000000001'
\set l_due   'e4000000-0000-0000-0000-000000000002'
\set l_later 'e4000000-0000-0000-0000-000000000003'
\set l_done  'e4000000-0000-0000-0000-000000000004'
\set l_dnc   'e4000000-0000-0000-0000-000000000005'
\set l_nocon 'e4000000-0000-0000-0000-000000000006'
\set l_b     'e4000000-0000-0000-0000-000000000007'
\set l_sal   'e4000000-0000-0000-0000-000000000008'
\set l_new2  'e4000000-0000-0000-0000-000000000009'
\set l_drf   'e4000000-0000-0000-0000-000000000010'

-- ---------- fixtures (as the table owner) ----------
-- Inst I: owner O, manager M (no money), callers A and B (on the fees campaign) and C (on no campaign).
-- Inst J: owner X. Fees campaign (running) and sales campaign (paused) for A; a draft campaign for A.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@i.test', now()), (:'u_m', 'm@i.test', now()), (:'u_a', 'a@i.test', now()),
 (:'u_b', 'b@i.test', now()), (:'u_c', 'c@i.test', now()), (:'u_x', 'x@j.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 10), (:'inst_j', 'Inst J', 'active', 10);
insert into seats (id, institute_id, user_id, label, role, status) values (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_m', :'inst_i', :'u_m', 'Manager', 'admin', 'manager', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Caller A', 'rep', null, 'active'),
 (:'s_b', :'inst_i', :'u_b', 'Caller B', 'rep', null, 'active'),
 (:'s_c', :'inst_i', :'u_c', 'Caller C', 'rep', null, 'active'),
 (:'s_x', :'inst_j', :'u_x', 'Owner J', 'admin', 'owner', 'active');
insert into campaigns (id, institute_id, name, call_type_id, status, daily_target) values
 (:'k_fee', :'inst_i', 'Oct fees', (select id from call_types where key='fees' and institute_id is null), 'running', 40),
 (:'k_sal', :'inst_i', 'Sales', (select id from call_types where key='sales' and institute_id is null), 'paused', null),
 (:'k_drf', :'inst_i', 'Draft', (select id from call_types where key='sales' and institute_id is null), 'draft', null);
insert into campaign_members (campaign_id, seat_id, institute_id) values
 (:'k_fee', :'s_a', :'inst_i'), (:'k_fee', :'s_b', :'inst_i'), (:'k_sal', :'s_a', :'inst_i'), (:'k_drf', :'s_a', :'inst_i');
insert into leads (id, institute_id, campaign_id, name, phone, extra, amount_due, assigned_seat_id, status, next_call_at, created_at) values
 (:'l_new',   :'inst_i', :'k_fee', 'New One',   '9000000001', '{"student":"Ravi","class":"10-A"}', 18000, :'s_a', 'new', null, now() - interval '3 days'),
 (:'l_due',   :'inst_i', :'k_fee', 'Due Now',   '9000000002', '{}', 9000, :'s_a', 'callback', now() - interval '1 hour', now()),
 (:'l_later', :'inst_i', :'k_fee', 'Due Later', '9000000003', '{}', 5000, :'s_a', 'callback', now() + interval '1 day', now()),
 (:'l_done',  :'inst_i', :'k_fee', 'Done',      '9000000004', '{}', 0, :'s_a', 'done', null, now()),
 (:'l_dnc',   :'inst_i', :'k_fee', 'No Calls',  '9000000005', '{}', 100, :'s_a', 'new', null, now()),
 (:'l_nocon', :'inst_i', :'k_fee', 'No Consent','9000000006', '{}', 100, :'s_a', 'new', null, now()),
 (:'l_b',     :'inst_i', :'k_fee', 'B Lead',    '9000000007', '{}', 7000, :'s_b', 'new', null, now()),
 (:'l_new2',  :'inst_i', :'k_fee', 'New Two',   '9000000009', '{}', 3000, :'s_a', 'new', null, now() - interval '1 day'),
 (:'l_sal',   :'inst_i', :'k_sal', 'Sales Lead','9000000008', '{}', null, :'s_a', 'new', null, now()),
 (:'l_drf',   :'inst_i', :'k_drf', 'Draft Lead','9000000010', '{}', null, :'s_a', 'new', null, now());
update leads set do_not_call = true where id = :'l_dnc';
update leads set consent_call = false where id = :'l_nocon';
-- Yesterday B called l_due and left a note (the lead has since moved to A).
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, lead_id, result_key, promised_date, dialled_at, note)
values (:'inst_i', :'s_b', 'b-old', :'k_fee', :'l_due', 'call_back_later', current_date, now() - interval '1 day', 'Call after salary');
update institutes set hide_money = true where id = :'inst_i';

-- ---------- lead money when money is hidden ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('hidden money: the caller on the lead sees the amount due', format($q$select amount_due::int::text from lead_money(%L)$q$, :'l_new'), '18000');
select pg_temp.val_is('hidden money: the caller''s money is not marked hidden', format($q$select money_hidden::text from lead_money(%L)$q$, :'l_new'), 'false');
select pg_temp.fails('hidden money: the caller cannot read another caller''s lead money', format($q$select * from lead_money(%L)$q$, :'l_b'));
reset role;
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.val_is('hidden money: the owner gets the lead money hidden', format($q$select money_hidden::text from lead_money(%L)$q$, :'l_new'), 'true');
select pg_temp.val_is('hidden money: the owner gets no amount', format($q$select coalesce(amount_due::text,'null') from lead_money(%L)$q$, :'l_new'), 'null');
reset role;
update institutes set hide_money = false where id = :'inst_i';
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('a manager without money still gets it hidden', format($q$select money_hidden::text from lead_money(%L)$q$, :'l_new'), 'true');
reset role;

-- ---------- my_call_queue ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('queue: due call back first, then new leads oldest first, then later call backs',
  format($q$select string_agg(x->>'name', ',' order by n) from jsonb_array_elements(my_call_queue(%L)->'leads') with ordinality t(x, n)$q$, :'k_fee'),
  'Due Now,New One,New Two,Due Later');
select pg_temp.val_is('queue: done, do-not-call, no-consent and other callers'' leads are left out',
  format($q$select jsonb_array_length(my_call_queue(%L)->'leads')::text$q$, :'k_fee'), '4');
select pg_temp.val_is('queue: the last call note comes from the earlier caller',
  format($q$select x->>'last_note' from jsonb_array_elements(my_call_queue(%L)->'leads') x where x->>'name'='Due Now'$q$, :'k_fee'), 'Call after salary');
select pg_temp.val_is('queue: the last result key is there',
  format($q$select x->>'last_result_key' from jsonb_array_elements(my_call_queue(%L)->'leads') x where x->>'name'='Due Now'$q$, :'k_fee'), 'call_back_later');
select pg_temp.val_is('queue: the call count is there',
  format($q$select x->>'calls' from jsonb_array_elements(my_call_queue(%L)->'leads') x where x->>'name'='Due Now'$q$, :'k_fee'), '1');
select pg_temp.val_is('queue: extra fields are there',
  format($q$select x->'extra'->>'student' from jsonb_array_elements(my_call_queue(%L)->'leads') x where x->>'name'='New One'$q$, :'k_fee'), 'Ravi');
select pg_temp.val_is('queue: no money in the queue',
  format($q$select (my_call_queue(%L)::text ~ '18000')::text$q$, :'k_fee'), 'false');
select pg_temp.val_is('queue: the daily target', format($q$select my_call_queue(%L)->>'daily_target'$q$, :'k_fee'), '40');
select pg_temp.val_is('queue: no calls of mine today yet', format($q$select my_call_queue(%L)->>'my_calls_today'$q$, :'k_fee'), '0');
select pg_temp.val_is('queue: share mode', format($q$select my_call_queue(%L)->>'share_mode'$q$, :'k_fee'), 'equal');
select pg_temp.val_is('queue: a paused campaign still has a queue', format($q$select my_call_queue(%L)->>'status'$q$, :'k_sal'), 'paused');
select pg_temp.fails_with('queue: a draft campaign is refused', format($q$select my_call_queue(%L)$q$, :'k_drf'), 'campaign not found');
reset role;
select pg_temp.as_user(:'u_c', 'c@i.test');
set role authenticated;
select pg_temp.fails_with('queue: a caller not on the campaign is refused', format($q$select my_call_queue(%L)$q$, :'k_fee'), 'campaign not found');
reset role;
select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.fails('queue: another institute is refused', format($q$select my_call_queue(%L)$q$, :'k_fee'));
reset role;

-- ---------- save_call_result ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
-- A promise with a date and an amount.
select pg_temp.ok('save: will pay on a date', format($q$select save_call_result('a-1', %L, 'will_pay_on', p_promised_date => current_date + 5, p_amount => 18000,
  p_note => 'Will pay after salary', p_step_times => '{"hello": 12, "fee": 40}', p_reached_step => 'fee', p_script_step => 'fee', p_consent_whatsapp => true)$q$, :'l_new'));
select pg_temp.val_is('save: the promise sets the lead to promised', format($q$select status from leads where id=%L$q$, :'l_new'), 'promised');
select pg_temp.val_is('save: the promise date is on the lead', format($q$select (promised_date = current_date + 5)::text from leads where id=%L$q$, :'l_new'), 'true');
select pg_temp.val_is('save: the next call is on the promise date', format($q$select ((next_call_at at time zone 'Asia/Kolkata')::date = current_date + 5)::text from leads where id=%L$q$, :'l_new'), 'true');
select pg_temp.val_is('save: the promised amount reads back through lead_money', format($q$select promised_amount::int::text from lead_money(%L)$q$, :'l_new'), '18000');
select pg_temp.val_is('save: WhatsApp consent is recorded', format($q$select consent_whatsapp::text from leads where id=%L$q$, :'l_new'), 'true');
select pg_temp.val_is('save: the call keeps its step times', $q$select step_times->>'fee' from call_outcomes where client_record_id='a-1'$q$, '40');
select pg_temp.val_is('save: the call keeps the furthest step', $q$select reached_step from call_outcomes where client_record_id='a-1'$q$, 'fee');
select pg_temp.val_is('save: the old outcome column is filled', $q$select outcome from call_outcomes where client_record_id='a-1'$q$, 'interested');
select pg_temp.val_is('save: the campaign is filled from the lead', $q$select campaign_id::text from call_outcomes where client_record_id='a-1'$q$, 'e3000000-0000-0000-0000-000000000001');
select pg_temp.val_is('save: the note is kept', $q$select note from call_outcomes where client_record_id='a-1'$q$, 'Will pay after salary');
select pg_temp.fails('save: the caller cannot read the amount back', $q$select amount from call_outcomes where client_record_id='a-1'$q$);
select pg_temp.val_is('save: a repeat of the same record is not saved twice', format($q$select save_call_result('a-1', %L, 'paid', p_amount => 1)->>'duplicate'$q$, :'l_new'), 'true');
select pg_temp.val_is('save: the repeat did not change the lead', format($q$select status from leads where id=%L$q$, :'l_new'), 'promised');
select pg_temp.val_is('save: my calls today now counts it', format($q$select my_call_queue(%L)->>'my_calls_today'$q$, :'k_fee'), '1');
-- Common results.
select pg_temp.ok('save: no answer', format($q$select save_call_result('a-2', %L, 'no_answer')$q$, :'l_new2'));
select pg_temp.val_is('save: no answer turns a new lead into a call back', format($q$select status from leads where id=%L$q$, :'l_new2'), 'callback');
select pg_temp.val_is('save: no answer tries again in about 2 hours', format($q$select (next_call_at between now() + interval '119 minutes' and now() + interval '121 minutes')::text from leads where id=%L$q$, :'l_new2'), 'true');
select pg_temp.ok('save: call back later with a time', format($q$select save_call_result('a-3', %L, 'call_back_later', p_promised_date => current_date + 1, p_next_call_at => now() + interval '1 day 2 hours', p_dialled_at => now() + interval '1 second')$q$, :'l_new2'));
select pg_temp.val_is('save: call back later sets a call back', format($q$select status from leads where id=%L$q$, :'l_new2'), 'callback');
select pg_temp.val_is('save: call back later uses the time given', format($q$select (next_call_at > now() + interval '1 day 1 hour')::text from leads where id=%L$q$, :'l_new2'), 'true');
select pg_temp.fails_with('save: call back later needs a date', format($q$select save_call_result('a-4', %L, 'call_back_later')$q$, :'l_new2'), 'needs a date');
select pg_temp.fails_with('save: paid needs an amount', format($q$select save_call_result('a-5', %L, 'paid')$q$, :'l_new2'), 'needs an amount');
select pg_temp.fails_with('save: refused needs a reason', format($q$select save_call_result('a-6', %L, 'refused', p_reason => '  ')$q$, :'l_new2'), 'needs a reason');
select pg_temp.fails_with('save: a sales result is refused on a fees lead', format($q$select save_call_result('a-7', %L, 'joined')$q$, :'l_new2'), 'is not a result');
select pg_temp.val_is('save: a refused save leaves no row', $q$select count(*)::text from call_outcomes where client_record_id in ('a-4','a-5','a-6','a-7')$q$, '0');
select pg_temp.fails_with('save: a rating out of range is refused', format($q$select save_call_result('a-8', %L, 'busy', p_rating => 9)$q$, :'l_new2'), 'rating');
select pg_temp.ok('save: paid with an amount', format($q$select save_call_result('a-9', %L, 'paid', p_amount => 9000, p_promised_date => current_date, p_dialled_at => now() + interval '2 seconds')$q$, :'l_due'));
select pg_temp.val_is('save: paid is done', format($q$select status from leads where id=%L$q$, :'l_due'), 'done');
select pg_temp.val_is('save: paid clears the next call', format($q$select coalesce(next_call_at::text, 'null') from leads where id=%L$q$, :'l_due'), 'null');
select pg_temp.ok('save: wrong number', format($q$select save_call_result('a-10', %L, 'wrong_number')$q$, :'l_later'));
select pg_temp.val_is('save: wrong number marks the lead', format($q$select status from leads where id=%L$q$, :'l_later'), 'wrong_number');
select pg_temp.ok('save: do not call', format($q$select save_call_result('a-11', %L, 'do_not_call', p_dialled_at => now() + interval '3 seconds')$q$, :'l_new2'));
select pg_temp.val_is('save: do not call marks the lead', format($q$select do_not_call::text || '/' || status from leads where id=%L$q$, :'l_new2'), 'true/do_not_call');
select pg_temp.ok('save: a later call on a do-not-call lead is kept', format($q$select save_call_result('a-12', %L, 'no_answer', p_dialled_at => now() + interval '4 seconds')$q$, :'l_new2'));
select pg_temp.val_is('save: but the lead stays do not call', format($q$select do_not_call::text || '/' || status from leads where id=%L$q$, :'l_new2'), 'true/do_not_call');
-- Sales (a paused campaign): a result without a date that means "call back".
select pg_temp.ok('save: will think', format($q$select save_call_result('a-13', %L, 'will_think')$q$, :'l_sal'));
select pg_temp.val_is('save: will think calls back in 2 days', format($q$select status || '/' || ((next_call_at::date - current_date) between 1 and 3)::text from leads where id=%L$q$, :'l_sal'), 'callback/true');
select pg_temp.fails_with('save: a draft campaign''s lead is refused', format($q$select save_call_result('a-14', %L, 'joined')$q$, :'l_drf'), 'lead not found');
select pg_temp.fails('save: an empty record id is refused', format($q$select save_call_result('', %L, 'busy')$q$, :'l_new'));
reset role;

-- A lead moved to B while A was offline: A's call is kept, the lead is not changed.
update leads set assigned_seat_id = :'s_b' where id = :'l_new';
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.val_is('save: a call for a lead that moved to another caller is kept', format($q$select save_call_result('a-16', %L, 'busy', p_dialled_at => now() + interval '5 seconds')->>'lead_updated'$q$, :'l_new'), 'false');
reset role;
select pg_temp.val_is('save: the moved lead is unchanged', format($q$select status from leads where id=%L$q$, :'l_new'), 'promised');
select pg_temp.val_is('save: the moved lead''s call is stored', $q$select count(*)::text from call_outcomes where client_record_id='a-16'$q$, '1');

-- An older call synced late does not undo a newer one.
select pg_temp.as_user(:'u_b', 'b@i.test');
set role authenticated;
select pg_temp.ok('save: B saves paid now', format($q$select save_call_result('b-1', %L, 'paid', p_amount => 18000, p_dialled_at => now() + interval '10 seconds')$q$, :'l_new'));
select pg_temp.val_is('save: an older call synced late is kept but does not change the lead', format($q$select save_call_result('b-2', %L, 'no_answer', p_dialled_at => now() - interval '1 hour')->>'lead_updated'$q$, :'l_new'), 'false');
reset role;
select pg_temp.val_is('save: the lead keeps the newer result', format($q$select status from leads where id=%L$q$, :'l_new'), 'done');
select pg_temp.val_is('save: the amount is stored for reports', $q$select amount::int::text from call_outcomes where client_record_id='b-1'$q$, '18000');
select pg_temp.val_is('save: an amount on a result that takes none is dropped', $q$select coalesce(amount::text, 'null') from call_outcomes where client_record_id='a-2'$q$, 'null');

select pg_temp.as_user(:'u_c', 'c@i.test');
set role authenticated;
select pg_temp.fails_with('save: a caller not on the campaign is refused', format($q$select save_call_result('c-1', %L, 'busy')$q$, :'l_new'), 'lead not found');
reset role;
select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.fails_with('save: another institute is refused', format($q$select save_call_result('x-1', %L, 'busy')$q$, :'l_new'), 'lead not found');
reset role;
select pg_temp.as_user(null, '');
set role anon;
select pg_temp.fails('save: anon cannot save', format($q$select save_call_result('n-1', %L, 'busy')$q$, :'l_new'));
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot run save_call_result', $q$select has_function_privilege('anon','public.save_call_result(text,uuid,text,date,numeric,text,int,text,jsonb,text,text,text,int,timestamptz,int,text,timestamptz,boolean)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run my_call_queue', $q$select has_function_privilege('anon','public.my_call_queue(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated can read call_outcomes.note', $q$select has_column_privilege('authenticated','public.call_outcomes','note','SELECT')::text$q$, 'true');
select pg_temp.val_is('authenticated still cannot read call_outcomes.amount', $q$select has_column_privilege('authenticated','public.call_outcomes','amount','SELECT')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
