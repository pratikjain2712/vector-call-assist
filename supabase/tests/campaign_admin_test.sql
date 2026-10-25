-- Tests for 20261024100020_campaign_admin.sql: creating and changing campaigns, lead upload, callers,
-- sharing leads (equal parts and "whoever is free next"), moving leads, the campaign list and detail, and
-- the money rule on the detail. Run with supabase/tests/run.sh. Expect failed = 0 on the last line.
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
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
-- Like fails, and the error text must contain want.
create or replace function pg_temp.fails_with(name text, sql text, want text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, position(want in sqlerrm) > 0, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;
grant execute on function pg_temp.ok(text, text), pg_temp.fails(text, text), pg_temp.fails_with(text, text, text),
  pg_temp.val_is(text, text, text) to authenticated, anon;

-- ---------- fixed ids ----------
\set inst_i 'c1000000-0000-0000-0000-000000000001'
\set inst_j 'c2000000-0000-0000-0000-000000000002'
\set u_o 'c3000000-0000-0000-0000-000000000001'
\set u_m 'c3000000-0000-0000-0000-000000000002'
\set u_a 'c3000000-0000-0000-0000-000000000003'
\set u_b 'c3000000-0000-0000-0000-000000000004'
\set u_c 'c3000000-0000-0000-0000-000000000005'
\set u_r 'c3000000-0000-0000-0000-000000000006'
\set u_x 'c3000000-0000-0000-0000-000000000007'
\set u_y 'c3000000-0000-0000-0000-000000000008'
\set s_o 'c4000000-0000-0000-0000-000000000001'
\set s_m 'c4000000-0000-0000-0000-000000000002'
\set s_a 'c4000000-0000-0000-0000-000000000003'
\set s_b 'c4000000-0000-0000-0000-000000000004'
\set s_c 'c4000000-0000-0000-0000-000000000005'
\set s_r 'c4000000-0000-0000-0000-000000000006'
\set s_x 'c4000000-0000-0000-0000-000000000007'
\set s_y 'c4000000-0000-0000-0000-000000000008'
\set sc_live 'c5000000-0000-0000-0000-000000000001'
\set sc_draft 'c5000000-0000-0000-0000-000000000002'
\set sc_j 'c5000000-0000-0000-0000-000000000003'

-- ---------- fixtures (as the table owner) ----------
-- Inst I (active, no add-ons yet): owner O, manager M (no money access), callers A, B, C, revoked caller R.
-- Inst J: owner X, caller Y. Scripts in I: "Fees v3" (live), "Draft" (no live version). Script in J (live).
reset role;
insert into auth.users (id, email) values
 (:'u_o', 'o@i.test'), (:'u_m', 'm@i.test'), (:'u_a', 'a@i.test'), (:'u_b', 'b@i.test'), (:'u_c', 'c@i.test'),
 (:'u_r', 'r@i.test'), (:'u_x', 'x@j.test'), (:'u_y', 'y@j.test');
insert into institutes (id, name, status) values (:'inst_i', 'Inst I', 'active'), (:'inst_j', 'Inst J', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'owner', 'active'),
 (:'s_m', :'inst_i', :'u_m', 'Manager', 'admin', 'manager', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Asha', 'rep', null, 'active'),
 (:'s_b', :'inst_i', :'u_b', 'Bina', 'rep', null, 'active'),
 (:'s_c', :'inst_i', :'u_c', 'Chetan', 'rep', null, 'active'),
 (:'s_r', :'inst_i', :'u_r', 'Revoked', 'rep', null, 'revoked'),
 (:'s_x', :'inst_j', :'u_x', 'Owner J', 'admin', 'owner', 'active'),
 (:'s_y', :'inst_j', :'u_y', 'Yash', 'rep', null, 'active');
insert into scripts (id, institute_id, name) values
 (:'sc_live', :'inst_i', 'Fees v3'), (:'sc_draft', :'inst_i', 'Draft script'), (:'sc_j', :'inst_j', 'J script');
insert into script_versions (script_id, institute_id, version, steps, published) values
 (:'sc_live', :'inst_i', 1, '[]', true), (:'sc_draft', :'inst_i', 1, '[]', false), (:'sc_j', :'inst_j', 1, '[]', true);

-- ---------- who may create ----------
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.fails_with('a caller cannot create a campaign', $q$select admin_create_campaign('Mine', (select id from call_types where key='fees'))$q$, 'only an admin');
select pg_temp.fails('a caller cannot list campaigns for admins', $q$select count(*) from admin_campaign_list()$q$);
reset role;
select pg_temp.as_user(null);
set role anon;
select pg_temp.fails('anon cannot create a campaign', $q$select admin_create_campaign('Mine', (select id from call_types where key='fees'))$q$);
reset role;

-- ---------- create ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('the owner creates "Nov fees"', $q$select admin_create_campaign('  Nov fees  ', (select id from call_types where key='fees'), null, '2026-11-01', '2026-11-20', 40, 'equal', false)$q$);
select pg_temp.val_is('a new campaign is a draft with a trimmed name', $q$select status || ' ' || name || ' ' || daily_target from campaigns where name='Nov fees'$q$, 'draft Nov fees 40');
select pg_temp.fails_with('a blank name is refused', $q$select admin_create_campaign('  ', (select id from call_types where key='fees'))$q$, 'campaign name');
select pg_temp.fails_with('an unknown call type is refused', $q$select admin_create_campaign('X', gen_random_uuid())$q$, 'pick a call type');
select pg_temp.fails_with('end before start is refused', $q$select admin_create_campaign('X', (select id from call_types where key='fees'), null, '2026-11-02', '2026-11-01')$q$, 'end date');
select pg_temp.fails_with('a daily target of 0 is refused', $q$select admin_create_campaign('X', (select id from call_types where key='fees'), null, null, null, 0)$q$, 'daily target');
select pg_temp.fails_with('an unknown share mode is refused', $q$select admin_create_campaign('X', (select id from call_types where key='fees'), null, null, null, null, 'random')$q$, 'share leads');
select pg_temp.fails_with('a script needs the Scripts add-on', format($q$select admin_create_campaign('X', (select id from call_types where key='fees'), %L)$q$, :'sc_live'), 'add Scripts');
reset role;
update institutes set features = array['scripts'] where id = :'inst_i';
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('with Scripts, a live script can be used', format($q$select admin_create_campaign('Sales Nov', (select id from call_types where key='sales'), %L, null, null, null, 'next_free', false)$q$, :'sc_live'));
select pg_temp.fails_with('a script without a live version is refused', format($q$select admin_create_campaign('X', (select id from call_types where key='fees'), %L)$q$, :'sc_draft'), 'no live version');
select pg_temp.fails_with('a script of another institute is refused', format($q$select admin_create_campaign('X', (select id from call_types where key='fees'), %L)$q$, :'sc_j'), 'script not found');
reset role;
select pg_temp.as_user(:'u_m');
set role authenticated;
select pg_temp.ok('a manager can create a campaign too', $q$select admin_create_campaign('Manager test', (select id from call_types where key='event'))$q$);
reset role;
select pg_temp.val_is('audit: 3 campaigns created in inst I', format($q$select count(*)::text from audit_log where institute_id=%L and action='campaign.created'$q$, :'inst_i'), '3');

select id as k_fees from campaigns where name = 'Nov fees' \gset
select id as k_sales from campaigns where name = 'Sales Nov' \gset
select id as k_mgr from campaigns where name = 'Manager test' \gset

-- ---------- another institute ----------
select pg_temp.as_user(:'u_x');
set role authenticated;
select pg_temp.fails_with('another institute cannot change the campaign', format($q$select admin_update_campaign(%L, 'Mine now')$q$, :'k_fees'), 'campaign not found');
select pg_temp.fails_with('another institute cannot add leads', format($q$select * from admin_add_leads(%L, '[{"name":"X","phone":"9000000001"}]')$q$, :'k_fees'), 'campaign not found');
select pg_temp.fails_with('another institute cannot read the detail', format($q$select admin_campaign_detail(%L)$q$, :'k_fees'), 'campaign not found');
select pg_temp.val_is('another institute lists none of them', $q$select count(*)::text from admin_campaign_list()$q$, '0');
reset role;

-- ---------- leads ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('upload: 6 good rows, 2 bad numbers, 1 repeat, 2 other skipped', format($q$select added||' '||bad_numbers||' '||repeats||' '||other_skipped from admin_add_leads(%L, $j$[
  {"name":"Asha Rao","phone":"098765 43210","amount_due":"12000","extra":{"Student":"Ravi","Class":"10"}},
  {"name":"Arun","phone":"+91 98765-43211","amount_due":8000.5},
  {"name":"Bina","phone":"919876543212","amount_due":null},
  {"name":"Chitra","phone":"9876543213"},
  {"name":"Dev","phone":"9876543214","extra":null},
  {"name":"Esha","phone":"9876543215","amount_due":""},
  {"name":"Bad","phone":"12345"},
  {"name":"Missing","phone":""},
  {"name":"Repeat","phone":"9876543210"},
  {"name":"   ","phone":"9876543216"},
  {"name":"Comma","phone":"9876543217","amount_due":"12,000"}
]$j$)$q$, :'k_fees'), '6 2 1 2');
select pg_temp.val_is('a repeat already in the campaign is counted and skipped', format($q$select added||' '||repeats from admin_add_leads(%L, '[{"name":"Asha again","phone":"9876543210"}]')$q$, :'k_fees'), '0 1');
select pg_temp.fails_with('a money column sent as an extra field refuses the whole upload', format($q$select * from admin_add_leads(%L, '[{"name":"X","phone":"9000000001","extra":{"Fee balance":"500"}}]')$q$, :'k_fees'), 'Amount due');
select pg_temp.fails_with('leads must be a list', format($q$select * from admin_add_leads(%L, '{"name":"X"}')$q$, :'k_fees'), 'must be a list');
select pg_temp.fails('the admin cannot read amount_due directly', format($q$select amount_due from leads where campaign_id=%L$q$, :'k_fees'));
select pg_temp.val_is('no lead is assigned while the campaign has no callers', format($q$select count(*)::text from leads where campaign_id=%L and assigned_seat_id is not null$q$, :'k_fees'), '0');
reset role;
select pg_temp.val_is('phones are stored as +91 and the amount is kept', $q$select phone || ' ' || amount_due from leads where name='Asha Rao'$q$, '+919876543210 12000.00');
select pg_temp.val_is('extra fields are kept', $q$select extra->>'Student' from leads where name='Asha Rao'$q$, 'Ravi');
select pg_temp.val_is('consent: call yes, WhatsApp no on upload', $q$select consent_call::text || ' ' || consent_whatsapp::text from leads where name='Arun'$q$, 'true false');
select pg_temp.val_is('audit: leads.added with the count', format($q$select target from audit_log where action='leads.added' and target like %L$q$, :'k_fees' || '%'), :'k_fees' || ':6');

-- ---------- callers and equal shares ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.fails_with('a campaign cannot start without callers', format($q$select admin_update_campaign(%L, p_status => 'running')$q$, :'k_fees'), 'at least one caller');
select pg_temp.fails_with('a seat of another institute cannot be a caller', format($q$select admin_set_campaign_members(%L, array[%L]::uuid[])$q$, :'k_fees', :'s_y'), 'not an active seat');
select pg_temp.fails_with('a revoked seat cannot be a caller', format($q$select admin_set_campaign_members(%L, array[%L]::uuid[])$q$, :'k_fees', :'s_r'), 'not an active seat');
select pg_temp.val_is('two callers are set', format($q$select admin_set_campaign_members(%L, array[%L, %L, %L]::uuid[])::text$q$, :'k_fees', :'s_a', :'s_b', :'s_a'), '2');
select pg_temp.val_is('equal parts: 3 leads each', format($q$select string_agg(n::text, ',' order by n) from (select count(*) n from leads where campaign_id=%L group by assigned_seat_id) x$q$, :'k_fees'), '3,3');
select pg_temp.ok('the campaign starts', format($q$select admin_update_campaign(%L, p_status => 'running')$q$, :'k_fees'));
select pg_temp.val_is('it is running', format($q$select status from campaigns where id=%L$q$, :'k_fees'), 'running');
select pg_temp.val_is('4 more leads are shared at once', format($q$select added::text from admin_add_leads(%L, '[{"name":"F","phone":"9000000011"},{"name":"G","phone":"9000000012"},{"name":"H","phone":"9000000013"},{"name":"I","phone":"9000000014"}]')$q$, :'k_fees'), '4');
select pg_temp.val_is('equal parts after adding: 5 each', format($q$select string_agg(n::text, ',' order by n) from (select count(*) n from leads where campaign_id=%L group by assigned_seat_id) x$q$, :'k_fees'), '5,5');
reset role;
-- Asha has called 2 of her leads (a callback and a promise); they stay hers when Chetan joins.
update leads set status = 'callback', next_call_at = now() - interval '1 hour'
  where id = (select id from leads where campaign_id = :'k_fees' and assigned_seat_id = :'s_a' order by created_at limit 1);
update leads set status = 'promised', promised_date = current_date
  where id = (select id from leads where campaign_id = :'k_fees' and assigned_seat_id = :'s_a' and status = 'new' order by created_at limit 1);
select id as l_cb from leads where campaign_id = :'k_fees' and status = 'callback' \gset
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('Chetan joins', format($q$select admin_set_campaign_members(%L, array[%L, %L, %L]::uuid[])$q$, :'k_fees', :'s_a', :'s_b', :'s_c'));
select pg_temp.val_is('10 open leads over 3 callers: 3, 3, 4', format($q$select string_agg(n::text, ',' order by n) from (select count(*) n from leads where campaign_id=%L group by assigned_seat_id) x$q$, :'k_fees'), '3,3,4');
select pg_temp.val_is('Asha keeps her callback', format($q$select assigned_seat_id::text from leads where id=%L$q$, :'l_cb'), :'s_a');
select pg_temp.val_is('Asha keeps her promise', format($q$select assigned_seat_id::text from leads where campaign_id=%L and status='promised'$q$, :'k_fees'), :'s_a');
select pg_temp.ok('Bina leaves', format($q$select admin_set_campaign_members(%L, array[%L, %L]::uuid[])$q$, :'k_fees', :'s_a', :'s_c'));
select pg_temp.val_is('Bina''s leads are shared between Asha and Chetan: 5, 5', format($q$select string_agg(n::text, ',' order by n) from (select count(*) n from leads where campaign_id=%L group by assigned_seat_id) x$q$, :'k_fees'), '5,5');
select pg_temp.val_is('Bina holds no lead of the campaign', format($q$select count(*)::text from leads where campaign_id=%L and assigned_seat_id=%L$q$, :'k_fees', :'s_b'), '0');
select pg_temp.val_is('audit: members set 3 times', format($q$select count(*)::text from audit_log where action='campaign.members_set' and target like %L$q$, :'k_fees' || '%'), '3');

-- ---------- status changes ----------
select pg_temp.fails_with('a draft cannot be paused', format($q$select admin_update_campaign(%L, p_status => 'paused')$q$, :'k_mgr'), 'only a running');
select pg_temp.fails_with('a draft cannot start without leads', format($q$select admin_set_campaign_members(%L, array[%L]::uuid[]); select admin_update_campaign(%L, p_status => 'running')$q$, :'k_mgr', :'s_a', :'k_mgr'), 'add leads');
select pg_temp.fails_with('an unknown status is refused', format($q$select admin_update_campaign(%L, p_status => 'done')$q$, :'k_fees'), 'status must be');
select pg_temp.ok('pause', format($q$select admin_update_campaign(%L, p_status => 'paused')$q$, :'k_fees'));
select pg_temp.ok('resume', format($q$select admin_update_campaign(%L, p_status => 'running')$q$, :'k_fees'));
select pg_temp.fails_with('the call type cannot change once running', format($q$select admin_update_campaign(%L, p_call_type => (select id from call_types where key='sales'))$q$, :'k_fees'), 'only change while the campaign is a draft');
select pg_temp.ok('rename, new dates, no target', format($q$select admin_update_campaign(%L, 'Nov fees - Class 10', p_end => '2026-11-30', p_daily_target => 0)$q$, :'k_fees'));
select pg_temp.val_is('the changes are saved', format($q$select name || ' ' || end_date || ' ' || coalesce(daily_target::text, 'none') from campaigns where id=%L$q$, :'k_fees'), 'Nov fees - Class 10 2026-11-30 none');
select pg_temp.fails_with('end before start is refused on change', format($q$select admin_update_campaign(%L, p_end => '2026-10-01')$q$, :'k_fees'), 'end date');
select pg_temp.ok('the call type of a draft can change', format($q$select admin_update_campaign(%L, p_call_type => (select id from call_types where key='feedback'))$q$, :'k_mgr'));
select pg_temp.ok('the script can be cleared', format($q$select admin_update_campaign(%L, p_clear_script => true)$q$, :'k_sales'));
select pg_temp.val_is('the script is cleared', format($q$select coalesce(script_id::text, 'none') from campaigns where id=%L$q$, :'k_sales'), 'none');
select pg_temp.ok('the script is set again', format($q$select admin_update_campaign(%L, p_script => %L)$q$, :'k_sales', :'sc_live'));
reset role;
select pg_temp.val_is('audit: paused and running logged', format($q$select string_agg(action, ',' order by id) from audit_log where target=%L and action in ('campaign.paused','campaign.running')$q$, :'k_fees'), 'campaign.running,campaign.paused,campaign.running');

-- ---------- list and detail ----------
-- A saved call for one of Chetan's leads, as Chetan.
select id as l_called from leads where campaign_id = :'k_fees' and assigned_seat_id = :'s_c' order by created_at limit 1 \gset
select pg_temp.as_user(:'u_c');
set role authenticated;
select pg_temp.ok('Chetan saves a call with a result', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, lead_id, result_key, amount, dialled_at) values (%L,%L,'k1',%L,'paid',5000,now())$q$, :'inst_i', :'s_c', :'l_called'));
reset role;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('the list shows called/total for Nov fees: 3 / 10', format($q$select leads_called || ' / ' || leads_total from admin_campaign_list() where id=%L$q$, :'k_fees'), '3 / 10');
select pg_temp.val_is('the list names the callers', format($q$select (select string_agg(x->>'label', ', ') from jsonb_array_elements(callers) x) from admin_campaign_list() where id=%L$q$, :'k_fees'), 'Asha, Chetan');
select pg_temp.val_is('the list names the type and script', format($q$select call_type_key || ' ' || script_name from admin_campaign_list() where id=%L$q$, :'k_sales'), 'sales Fees v3');
select pg_temp.val_is('running campaigns come first', $q$select status from admin_campaign_list() limit 1$q$, 'running');
select pg_temp.val_is('detail: lead counts', format($q$select (d->'leads'->>'total') || ' ' || (d->'leads'->>'callback') || ' ' || (d->'leads'->>'promised') from admin_campaign_detail(%L) d$q$, :'k_fees'), '10 1 1');
select pg_temp.val_is('detail: one call today, result Paid', format($q$select (d->>'calls_today') || ' ' || (d->'results'->0->>'label') from admin_campaign_detail(%L) d$q$, :'k_fees'), '1 Paid');
select pg_temp.val_is('detail: Chetan has 1 call today', format($q$select x->>'calls_today' from admin_campaign_detail(%L) d, jsonb_array_elements(d->'callers') x where x->>'label'='Chetan'$q$, :'k_fees'), '1');
select pg_temp.val_is('detail: the owner sees the amount due total', format($q$select d->>'amount_due_total' from admin_campaign_detail(%L) d$q$, :'k_fees'), '20000.50');
select pg_temp.val_is('detail: live script version', format($q$select d->>'script_live_version' from admin_campaign_detail(%L) d$q$, :'k_sales'), '1');
reset role;
select pg_temp.as_user(:'u_m');
set role authenticated;
select pg_temp.val_is('detail: a manager without money access gets no amount', format($q$select coalesce(d->>'amount_due_total', 'null') || ' ' || (d->>'money_hidden') from admin_campaign_detail(%L) d$q$, :'k_fees'), 'null true');
reset role;
update institutes set hide_money = true where id = :'inst_i';
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('detail: hide money hides it from the owner too', format($q$select coalesce(d->>'amount_due_total', 'null') from admin_campaign_detail(%L) d$q$, :'k_fees'), 'null');
reset role;
update institutes set hide_money = false where id = :'inst_i';

-- ---------- whoever is free next ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('3 leads for Sales Nov', format($q$select added::text from admin_add_leads(%L, '[{"name":"S1","phone":"9100000001"},{"name":"S2","phone":"9100000002"},{"name":"S3","phone":"9100000003"},{"name":"S4","phone":"9100000004"}]')$q$, :'k_sales'), '4');
select pg_temp.ok('Asha and Bina call Sales Nov', format($q$select admin_set_campaign_members(%L, array[%L, %L]::uuid[])$q$, :'k_sales', :'s_a', :'s_b'));
select pg_temp.val_is('next_free: the leads stay unassigned', format($q$select count(*)::text from leads where campaign_id=%L and assigned_seat_id is null$q$, :'k_sales'), '4');
select pg_temp.ok('Sales Nov starts', format($q$select admin_update_campaign(%L, p_status => 'running')$q$, :'k_sales'));
reset role;
update leads set consent_call = false where campaign_id = :'k_sales' and name = 'S1';
update leads set do_not_call = true where campaign_id = :'k_sales' and name = 'S2';
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.val_is('Asha gets the next lead (S3: S1 has no consent, S2 is do not call)', format($q$select name from next_free_lead(%L)$q$, :'k_sales'), 'S3');
select pg_temp.val_is('S3 is now Asha''s and she can read it', $q$select name from leads where name='S3'$q$, 'S3');
select pg_temp.val_is('asking again before calling gives S3 again', format($q$select name from next_free_lead(%L)$q$, :'k_sales'), 'S3');
select pg_temp.ok('Asha calls S3', format($q$insert into call_outcomes (institute_id, seat_id, client_record_id, lead_id, result_key) values (%L,%L,'s3',(select id from leads where name='S3'),'no_answer')$q$, :'inst_i', :'s_a'));
select pg_temp.val_is('then she gets S4', format($q$select name from next_free_lead(%L)$q$, :'k_sales'), 'S4');
reset role;
select pg_temp.as_user(:'u_b');
set role authenticated;
select pg_temp.val_is('Bina finds the pool empty', format($q$select count(*)::text from next_free_lead(%L)$q$, :'k_sales'), '0');
reset role;
select pg_temp.as_user(:'u_c');
set role authenticated;
select pg_temp.fails_with('Chetan is not on Sales Nov', format($q$select * from next_free_lead(%L)$q$, :'k_sales'), 'campaign not found');
reset role;
select pg_temp.as_user(:'u_y');
set role authenticated;
select pg_temp.fails_with('a caller of another institute gets nothing', format($q$select * from next_free_lead(%L)$q$, :'k_sales'), 'campaign not found');
reset role;
-- A callback in the pool that is due comes before new leads.
update leads set assigned_seat_id = null, status = 'callback', next_call_at = now() - interval '5 minutes' where name = 'S4';
update leads set consent_call = true where name = 'S1';
select pg_temp.as_user(:'u_b');
set role authenticated;
select pg_temp.val_is('a due callback in the pool comes first', format($q$select name from next_free_lead(%L)$q$, :'k_sales'), 'S4');
reset role;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('pause Sales Nov', format($q$select admin_update_campaign(%L, p_status => 'paused')$q$, :'k_sales'));
reset role;
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.fails_with('no next lead from a paused campaign', format($q$select * from next_free_lead(%L)$q$, :'k_sales'), 'not running');
reset role;

-- ---------- share mode switches ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('switching Sales Nov to equal shares the pool (S1) and keeps called leads', format($q$select admin_share_leads(%L, 'equal')::text$q$, :'k_sales'), '1');
select pg_temp.val_is('the mode is saved', format($q$select share_mode from campaigns where id=%L$q$, :'k_sales'), 'equal');
select pg_temp.val_is('switching Nov fees to next_free returns the uncalled leads to the pool', format($q$select admin_share_leads(%L, 'next_free')::text$q$, :'k_fees'), '7');
select pg_temp.val_is('only the called leads stay assigned', format($q$select count(*)::text from leads where campaign_id=%L and assigned_seat_id is not null$q$, :'k_fees'), '3');
select pg_temp.val_is('back to equal: the 7 uncalled leads are shared again', format($q$select admin_share_leads(%L, 'equal')::text$q$, :'k_fees'), '7');
select pg_temp.val_is('10 open leads, 5 each', format($q$select string_agg(n::text, ',' order by n) from (select count(*) n from leads where campaign_id=%L group by assigned_seat_id) x$q$, :'k_fees'), '5,5');
select pg_temp.fails_with('equal needs a caller', format($q$select admin_set_campaign_members(%L, '{}'::uuid[]); select admin_share_leads(%L, 'equal')$q$, :'k_mgr', :'k_mgr'), 'at least one caller');
select pg_temp.fails_with('an unknown mode is refused', format($q$select admin_share_leads(%L, 'random')$q$, :'k_fees'), 'share leads');
reset role;

-- ---------- move leads ----------
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.fails('a caller cannot move leads', format($q$select admin_move_leads(%L, %L)$q$, :'s_a', :'s_b'));
reset role;
select pg_temp.as_user(:'u_x');
set role authenticated;
select pg_temp.fails_with('another institute cannot move them', format($q$select admin_move_leads(%L, %L)$q$, :'s_a', :'s_x'), 'caller not found');
reset role;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.fails_with('not to a seat of another institute', format($q$select admin_move_leads(%L, %L)$q$, :'s_a', :'s_y'), 'not an active seat');
select pg_temp.fails_with('not to the same seat', format($q$select admin_move_leads(%L, %L)$q$, :'s_a', :'s_a'), 'different caller');
select pg_temp.val_is('Asha''s 5 open Nov fees leads move to Bina', format($q$select admin_move_leads(%L, %L, %L)::text$q$, :'s_a', :'s_b', :'k_fees'), '5');
select pg_temp.val_is('Bina is now on Nov fees', format($q$select count(*)::text from campaign_members where campaign_id=%L and seat_id=%L$q$, :'k_fees', :'s_b'), '1');
select pg_temp.val_is('Asha keeps her Sales Nov leads (S3 and S1)', format($q$select count(*)::text from leads where campaign_id=%L and assigned_seat_id=%L$q$, :'k_sales', :'s_a'), '2');
select pg_temp.val_is('all campaigns: Bina''s 6 open leads (5 Nov fees, 1 Sales Nov) go back to the pool', format($q$select admin_move_leads(%L, null)::text$q$, :'s_b'), '6');
select pg_temp.val_is('audit: leads.moved to the pool', format($q$select target from audit_log where action='leads.moved' order by id desc limit 1$q$), :'s_b' || ':pool:6');
reset role;

-- ---------- closing ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('close Nov fees', format($q$select admin_update_campaign(%L, p_status => 'closed')$q$, :'k_fees'));
select pg_temp.fails_with('a closed campaign cannot reopen', format($q$select admin_update_campaign(%L, p_status => 'running')$q$, :'k_fees'), 'closed');
select pg_temp.fails_with('a closed campaign takes no more leads', format($q$select * from admin_add_leads(%L, '[{"name":"Z","phone":"9200000001"}]')$q$, :'k_fees'), 'closed');
select pg_temp.fails_with('a closed campaign keeps its callers', format($q$select admin_set_campaign_members(%L, '{}'::uuid[])$q$, :'k_fees'), 'closed');
select pg_temp.fails_with('leads of a closed campaign are not moved', format($q$select admin_move_leads(%L, %L, %L)$q$, :'s_c', :'s_a', :'k_fees'), 'closed');
select pg_temp.val_is('moving all of Chetan''s leads skips the closed campaign', format($q$select admin_move_leads(%L, %L)::text$q$, :'s_c', :'s_a'), '0');
reset role;

-- ---------- a big sheet ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('a new campaign for a big sheet', $q$select admin_create_campaign('Big', (select id from call_types where key='sales'))$q$);
select pg_temp.val_is('5000 leads in one call (with 1 repeat at the end)', $q$select added || ' ' || repeats from admin_add_leads((select id from campaigns where name='Big'),
  (select jsonb_agg(jsonb_build_object('name', 'Lead ' || i, 'phone', (8000000000 + least(i, 4999))::text)) from generate_series(1, 5000) i))$q$, '4999 1');
select pg_temp.fails_with('more than 5000 at a time is refused', $q$select * from admin_add_leads((select id from campaigns where name='Big'),
  (select jsonb_agg(jsonb_build_object('name', 'X', 'phone', '9000000001')) from generate_series(1, 5001)))$q$, 'at most 5000');
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot run admin_add_leads', $q$select has_function_privilege('anon','public.admin_add_leads(uuid,jsonb)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run next_free_lead', $q$select has_function_privilege('anon','public.next_free_lead(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated can run admin_move_leads', $q$select has_function_privilege('authenticated','public.admin_move_leads(uuid,uuid,uuid)','EXECUTE')::text$q$, 'true');
select pg_temp.val_is('authenticated cannot run the share helper', $q$select has_function_privilege('authenticated','public.campaign_share_equal(uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot run the admin check helper', $q$select has_function_privilege('authenticated','public.campaign_for_admin(uuid)','EXECUTE')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
