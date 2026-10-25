-- Tests for open campaigns in 20261025130000_ledger_open_campaigns.sql: open_to_all and the class / board
-- tags, admin_create_campaign / admin_update_campaign with the new arguments, my_campaigns for non-members,
-- next_free_lead / my_call_queue / save_call_result / campaign_script_version on open and restricted
-- campaigns, restricting a campaign, and members leaving an open campaign. Run with supabase/tests/run.sh.
-- Expect failed = 0 on the last line.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''))::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
create temp table ids (k text primary key, id uuid);
grant all on ids to authenticated, anon;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
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
\set inst_i 'f1000000-0000-0000-0000-000000000001'
\set inst_j 'f2000000-0000-0000-0000-000000000002'
\set u_o 'f3000000-0000-0000-0000-000000000001'
\set u_a 'f3000000-0000-0000-0000-000000000002'
\set u_b 'f3000000-0000-0000-0000-000000000003'
\set u_c 'f3000000-0000-0000-0000-000000000004'
\set u_y 'f3000000-0000-0000-0000-000000000005'
\set s_o 'f4000000-0000-0000-0000-000000000001'
\set s_a 'f4000000-0000-0000-0000-000000000002'
\set s_b 'f4000000-0000-0000-0000-000000000003'
\set s_c 'f4000000-0000-0000-0000-000000000004'
\set s_y 'f4000000-0000-0000-0000-000000000005'

-- ---------- fixtures ----------
-- Inst I: owner O, callers A, B, C. Inst J: caller Y (and an owner).
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@i.test', now()), (:'u_a', 'a@i.test', now()), (:'u_b', 'b@i.test', now()), (:'u_c', 'c@i.test', now()),
 (:'u_y', 'y@j.test', now());
insert into institutes (id, name, status) values (:'inst_i', 'Inst I', 'active'), (:'inst_j', 'Inst J', 'active');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Asha', 'rep', 'active'),
 (:'s_b', :'inst_i', :'u_b', 'Bina', 'rep', 'active'),
 (:'s_c', :'inst_i', :'u_c', 'Chetan', 'rep', 'active'),
 (:'s_y', :'inst_j', :'u_y', 'Yash', 'rep', 'active');

select pg_temp.val_is('a campaign without open_to_all is open (existing campaigns too)',
  format($q$with i as (insert into campaigns (institute_id, name, call_type_id) values (%L, 'Old', (select id from call_types where key='sales' and institute_id is null)) returning open_to_all) select open_to_all::text from i$q$, :'inst_i'), 'true');
select pg_temp.fails('an unknown board is refused on the table', format($q$insert into campaigns (institute_id, name, call_type_id, board) values (%L, 'X', (select id from call_types where key='sales' and institute_id is null), 'cbse')$q$, :'inst_i'));

-- ---------- admin: create and change ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('owner creates an open fees campaign with tags', $q$insert into ids select 'open', admin_create_campaign('8th CBSE fees', (select id from call_types where key='fees'), p_class_label => ' 8th ', p_board => 'cbse')$q$);
select pg_temp.val_is('defaults: open to all, next_free, tags normalised', $q$select open_to_all||':'||share_mode||':'||class_label||':'||board from campaigns where id=(select id from ids where k='open')$q$, 'true:next_free:8th:CBSE');
select pg_temp.ok('owner creates a restricted sales campaign', $q$insert into ids select 'restr', admin_create_campaign('Sales team', (select id from call_types where key='sales'), p_open_to_all => false)$q$);
select pg_temp.val_is('restricted defaults to equal sharing', $q$select open_to_all||':'||share_mode from campaigns where id=(select id from ids where k='restr')$q$, 'false:equal');
select pg_temp.ok('an old-style call (7 arguments by position) still works', $q$select admin_create_campaign('Positional', (select id from call_types where key='event'), null, null, null, 10, 'equal')$q$);
select pg_temp.fails_with('an unknown board is refused', $q$select admin_create_campaign('X', (select id from call_types where key='fees'), p_board => 'Kerala')$q$, 'board must be');
select pg_temp.fails_with('a long class is refused', $q$select admin_create_campaign('X', (select id from call_types where key='fees'), p_class_label => repeat('x', 21))$q$, 'class must be');
select pg_temp.val_is('leads added to the open campaign', $q$select added::text from admin_add_leads((select id from ids where k='open'), '[{"name":"P1","phone":"9000000001"},{"name":"P2","phone":"9000000002"},{"name":"P3","phone":"9000000003"},{"name":"P4","phone":"9000000004"}]')$q$, '4');
select pg_temp.val_is('leads added to the restricted campaign', $q$select added::text from admin_add_leads((select id from ids where k='restr'), '[{"name":"R1","phone":"9100000001"}]')$q$, '1');
select pg_temp.ok('an open campaign starts without members', $q$select admin_update_campaign((select id from ids where k='open'), p_status => 'running')$q$);
select pg_temp.fails_with('a restricted campaign still needs a caller', $q$select admin_update_campaign((select id from ids where k='restr'), p_status => 'running')$q$, 'at least one caller');
select pg_temp.ok('Asha joins the restricted campaign', format($q$select admin_set_campaign_members((select id from ids where k='restr'), array[%L]::uuid[])$q$, :'s_a'));
select pg_temp.ok('and it starts', $q$select admin_update_campaign((select id from ids where k='restr'), p_status => 'running')$q$);
select pg_temp.ok('tags change: class cleared, board ICSE', $q$select admin_update_campaign((select id from ids where k='restr'), p_class_label => '', p_board => 'icse')$q$);
select pg_temp.val_is('tags after the change', $q$select coalesce(class_label,'none')||':'||board from campaigns where id=(select id from ids where k='restr')$q$, 'none:ICSE');
select pg_temp.ok('a null tag keeps the value', $q$select admin_update_campaign((select id from ids where k='restr'), p_name => 'Sales team ICSE')$q$);
select pg_temp.val_is('board kept', $q$select board from campaigns where id=(select id from ids where k='restr')$q$, 'ICSE');
select pg_temp.val_is('admin_campaign_list has the new columns', $q$select open_to_all||':'||class_label||':'||board from admin_campaign_list() where id=(select id from ids where k='open')$q$, 'true:8th:CBSE');
reset role;
insert into ids select 'p1', id from leads where name = 'P1';

-- ---------- callers on an open campaign ----------
select pg_temp.as_user(:'u_b');
set role authenticated;
select pg_temp.val_is('a non-member sees the open campaign in my_campaigns, not the restricted one', $q$select string_agg(name, ',') from my_campaigns()$q$, '8th CBSE fees');
select pg_temp.val_is('my_campaigns: tags, type, open, not a member, pool waiting',
  $q$select call_type_key||':'||call_type_label||':'||class_label||':'||board||':'||open_to_all||':'||is_member||':'||share_mode||':'||pool_leads_due||':'||my_leads from my_campaigns()$q$,
  'fees:Fees collection:8th:CBSE:true:false:next_free:4:0');
select pg_temp.val_is('the campaigns table shows the open campaign only', $q$select string_agg(name, ',') from campaigns$q$, '8th CBSE fees');
select pg_temp.val_is('Bina takes a lead from the pool', $q$select name from next_free_lead((select id from campaigns where name='8th CBSE fees'))$q$, 'P1');
select pg_temp.val_is('asking again gives the same uncalled lead', $q$select name from next_free_lead((select id from campaigns where name='8th CBSE fees'))$q$, 'P1');
select pg_temp.val_is('Bina reads only her lead', $q$select string_agg(name, ',') from leads$q$, 'P1');
select pg_temp.val_is('her queue has it', $q$select (q->>'open_to_all')||':'||(q->'leads'->0->>'name') from my_call_queue((select id from campaigns where name='8th CBSE fees')) q$q$, 'true:P1');
select pg_temp.ok('Bina saves a result on her lead', $q$select save_call_result('b-1', (select id from leads where name='P1'), 'busy')$q$);
select pg_temp.val_is('the lead stays with Bina as a call back', $q$select status from leads where name='P1'$q$, 'callback');
select pg_temp.val_is('script version on an open campaign: allowed (no script, no rows)', $q$select count(*)::text from campaign_script_version((select id from campaigns where name='8th CBSE fees'))$q$, '0');
reset role;
select pg_temp.as_user(:'u_b');
set role authenticated;
select pg_temp.fails_with('a non-member cannot take a lead of a restricted campaign', $q$select * from next_free_lead((select id from ids where k='restr'))$q$, 'campaign not found');
select pg_temp.fails_with('a non-member cannot open the queue of a restricted campaign', $q$select my_call_queue((select id from ids where k='restr'))$q$, 'campaign not found');
select pg_temp.fails_with('a non-member cannot load the script of a restricted campaign', $q$select * from campaign_script_version((select id from ids where k='restr'))$q$, 'campaign not found');
reset role;

select pg_temp.as_user(:'u_c');
set role authenticated;
select pg_temp.val_is('Chetan gets a different lead', $q$select name from next_free_lead((select id from ids where k='open'))$q$, 'P2');
select pg_temp.as_user(:'u_c');
set role authenticated;
select pg_temp.fails_with('Chetan cannot save a result on Bina''s lead', $q$select save_call_result('c-1', (select id from ids where k='p1'), 'busy')$q$, 'lead not found');
reset role;

select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.val_is('a member sees both campaigns, member flag on the restricted one', $q$select string_agg(name||'='||is_member, ',' order by name) from my_campaigns()$q$, '8th CBSE fees=false,Sales team ICSE=true');
select pg_temp.val_is('Asha takes P3 from the open campaign', $q$select name from next_free_lead((select id from campaigns where name='8th CBSE fees'))$q$, 'P3');
reset role;

select pg_temp.as_user(:'u_y');
set role authenticated;
select pg_temp.fails_with('a caller of another institute cannot take a lead', $q$select * from next_free_lead((select id from ids where k='open'))$q$, 'campaign not found');
select pg_temp.val_is('a caller of another institute sees no campaigns', $q$select count(*)::text from my_campaigns()$q$, '0');
reset role;

-- ---------- admin: members, sharing, restricting ----------
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('detail lists every seat holding leads, member or not', $q$select string_agg((x->>'label')||'='||(x->>'member'), ',' order by x->>'label') from jsonb_array_elements(admin_campaign_detail((select id from ids where k='open'))->'callers') x$q$, 'Asha=false,Bina=false,Chetan=false');
select pg_temp.ok('Asha becomes a member of the open campaign', format($q$select admin_set_campaign_members((select id from ids where k='open'), array[%L]::uuid[])$q$, :'s_a'));
select pg_temp.ok('and leaves again', $q$select admin_set_campaign_members((select id from ids where k='open'), '{}'::uuid[])$q$);
select pg_temp.val_is('leaving an open campaign keeps the leads', format($q$select count(*)::text from leads where campaign_id=(select id from ids where k='open') and assigned_seat_id=%L$q$, :'s_a'), '1');
select pg_temp.ok('next_free sharing in the open campaign', $q$select admin_share_leads((select id from ids where k='open'), 'next_free')$q$);
select pg_temp.val_is('called leads stay with non-members; uncalled ones go back', $q$select string_agg(name || '=' || coalesce((select label from seats s where s.id = l.assigned_seat_id), 'pool'), ',' order by name) from leads l where campaign_id=(select id from ids where k='open')$q$, 'P1=Bina,P2=pool,P3=pool,P4=pool');
select pg_temp.ok('Chetan joins; the campaign is restricted', format($q$select admin_set_campaign_members((select id from ids where k='open'), array[%L]::uuid[]); select admin_update_campaign((select id from ids where k='open'), p_open_to_all => false)$q$, :'s_c'));
select pg_temp.val_is('restricting puts non-members'' open leads back in the pool', $q$select coalesce((select label from seats s where s.id = l.assigned_seat_id), 'pool') from leads l where name='P1'$q$, 'pool');
select pg_temp.val_is('audit: campaign.restricted', $q$select count(*)::text from audit_log where action='campaign.restricted'$q$, '1');
reset role;
select pg_temp.as_user(:'u_b');
set role authenticated;
select pg_temp.val_is('Bina no longer sees the restricted campaign', $q$select count(*)::text from my_campaigns()$q$, '0');
select pg_temp.fails_with('and cannot take its leads', $q$select * from next_free_lead((select id from ids where k='open'))$q$, 'campaign not found');
select pg_temp.val_is('and no longer reads its leads', $q$select count(*)::text from leads$q$, '0');
reset role;
select pg_temp.as_user(:'u_c');
set role authenticated;
select pg_temp.val_is('the member Chetan takes from the pool (P1 is a call back, not due yet)', $q$select name from next_free_lead((select id from campaigns where name='8th CBSE fees'))$q$, 'P2');
reset role;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('opened again and paused', $q$select admin_update_campaign((select id from ids where k='open'), p_open_to_all => true, p_status => 'paused')$q$);
select pg_temp.val_is('audit: campaign.opened', $q$select count(*)::text from audit_log where action='campaign.opened'$q$, '1');
reset role;
select pg_temp.as_user(:'u_b');
set role authenticated;
select pg_temp.val_is('a paused open campaign is listed', $q$select status from my_campaigns()$q$, 'paused');
select pg_temp.fails_with('but hands out no leads', $q$select * from next_free_lead((select campaign_id from my_campaigns()))$q$, 'not running');
reset role;

-- ---------- back to the pool: idle callers' due follow-ups, revoked seats, admin ----------
-- "Follow-ups" (open, running): F1 promised to Asha, due an hour ago, Asha's last call in the campaign 4 days
-- ago; F2 call back of Bina, due, Bina called an hour ago; F3 call back of Chetan, due tomorrow, Chetan's
-- last call 4 days ago; F4 new, in the pool.
insert into campaigns (id, institute_id, name, call_type_id, status) values
 ('f5000000-0000-0000-0000-000000000001', :'inst_i', 'Follow-ups', (select id from call_types where key='fees' and institute_id is null), 'running');
insert into ids values ('fu', 'f5000000-0000-0000-0000-000000000001');
insert into leads (id, institute_id, campaign_id, name, phone, assigned_seat_id, status, next_call_at, promised_date, promised_amount, amount_due, created_at) values
 ('f6000000-0000-0000-0000-000000000001', :'inst_i', 'f5000000-0000-0000-0000-000000000001', 'F1', '9200000001', :'s_a', 'promised', now() - interval '1 hour', current_date - 1, 3000, 9000, now() - interval '10 days'),
 ('f6000000-0000-0000-0000-000000000002', :'inst_i', 'f5000000-0000-0000-0000-000000000001', 'F2', '9200000002', :'s_b', 'callback', now() - interval '1 hour', null, null, null, now() - interval '10 days'),
 ('f6000000-0000-0000-0000-000000000003', :'inst_i', 'f5000000-0000-0000-0000-000000000001', 'F3', '9200000003', :'s_c', 'callback', now() + interval '1 day', null, null, null, now() - interval '10 days'),
 ('f6000000-0000-0000-0000-000000000004', :'inst_i', 'f5000000-0000-0000-0000-000000000001', 'F4', '9200000004', null, 'new', null, null, null, null, now() - interval '20 days');
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, lead_id, result_key, promised_date, amount, dialled_at) values
 (:'inst_i', :'s_a', 'fu-a', 'f5000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000001', 'will_pay_on', current_date - 1, 3000, now() - interval '4 days'),
 (:'inst_i', :'s_b', 'fu-b', 'f5000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000002', 'busy', null, null, now() - interval '1 hour'),
 (:'inst_i', :'s_c', 'fu-c', 'f5000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000003', 'busy', null, null, now() - interval '4 days'),
 -- The owner's only call in the campaign: Saturday 24 Oct 2026, 10:00 India (for the Sunday rule).
 (:'inst_i', :'s_o', 'fu-o', 'f5000000-0000-0000-0000-000000000001', 'f6000000-0000-0000-0000-000000000004', 'busy', null, null, '2026-10-24 10:00+05:30');

select pg_temp.val_is('working hours skip Sunday: Sat 10:00 to Mon 09:00 is 23 h', $q$select working_hours_between('2026-10-24 10:00+05:30', '2026-10-26 09:00+05:30', 'Asia/Kolkata')::int::text$q$, '23');
select pg_temp.val_is('Sunday skipped: not idle on Monday 09:00 (23 working hours)', $q$select seat_idle_in_campaign((select id from ids where k='fu'), 'f4000000-0000-0000-0000-000000000001', '2026-10-26 09:00+05:30')::text$q$, 'false');
select pg_temp.val_is('Sunday skipped: idle on Monday 11:00 (25 working hours)', $q$select seat_idle_in_campaign((select id from ids where k='fu'), 'f4000000-0000-0000-0000-000000000001', '2026-10-26 11:00+05:30')::text$q$, 'true');
select pg_temp.val_is('idle by Wednesday 11:00', $q$select seat_idle_in_campaign((select id from ids where k='fu'), 'f4000000-0000-0000-0000-000000000001', '2026-10-28 11:00+05:30')::text$q$, 'true');
select pg_temp.val_is('a seat with no call in the campaign is idle', $q$select seat_idle_in_campaign((select id from ids where k='fu'), 'f4000000-0000-0000-0000-000000000005', now())::text$q$, 'true');

select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('the period changes per campaign (48 h)', $q$select admin_update_campaign((select id from ids where k='fu'), p_release_after_hours => 48)$q$);
select pg_temp.fails_with('the period must be 1 to 720 hours', $q$select admin_update_campaign((select id from ids where k='fu'), p_release_after_hours => 0)$q$, '720');
reset role;
select pg_temp.val_is('with 48 h, Monday 11:00 is not idle yet', $q$select seat_idle_in_campaign((select id from ids where k='fu'), 'f4000000-0000-0000-0000-000000000001', '2026-10-26 11:00+05:30')::text$q$, 'false');
update campaigns set release_after_hours = 24 where id = 'f5000000-0000-0000-0000-000000000001';

select pg_temp.as_user(:'u_b');
set role authenticated;
select pg_temp.val_is('next_free_lead releases Asha''s stale promise and hands it out before new leads', $q$select name from next_free_lead((select id from ids where k='fu'))$q$, 'F1');
reset role;
select pg_temp.val_is('the released promise keeps its status, date and amounts', $q$select status||':'||(promised_date = current_date - 1)||':'||promised_amount||':'||amount_due from leads where name='F1'$q$, 'promised:true:3000.00:9000.00');
select pg_temp.val_is('and its call history', $q$select count(*)::text from call_outcomes where lead_id='f6000000-0000-0000-0000-000000000001' and seat_id='f4000000-0000-0000-0000-000000000002'$q$, '1');
select pg_temp.val_is('audit: lead.released for F1 (idle)', $q$select count(*)::text from audit_log where action='lead.released' and target='f6000000-0000-0000-0000-000000000001:f4000000-0000-0000-0000-000000000002:idle'$q$, '1');
select pg_temp.val_is('no release when the caller worked the campaign within the period (F2 stays with Bina)', $q$select (select label from seats where id=assigned_seat_id) from leads where name='F2'$q$, 'Bina');
select pg_temp.val_is('a follow-up that is not due stays (F3 with Chetan)', $q$select (select label from seats where id=assigned_seat_id) from leads where name='F3'$q$, 'Chetan');
select pg_temp.val_is('F4 is still in the pool', $q$select coalesce(assigned_seat_id::text, 'pool') from leads where name='F4'$q$, 'pool');
select pg_temp.val_is('restricted campaigns are not touched', $q$select release_stale_leads((select id from ids where k='restr'))::text$q$, '0');
select pg_temp.val_is('release_stale_leads is not for the browser', $q$select has_function_privilege('authenticated','public.release_stale_leads(uuid)','EXECUTE')::text$q$, 'false');

-- Revoking a seat releases its open leads in open campaigns at once.
insert into leads (institute_id, campaign_id, name, phone, assigned_seat_id, status) values
 (:'inst_i', 'f5000000-0000-0000-0000-000000000001', 'F5', '9200000005', :'s_c', 'new');
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.ok('the owner revokes Chetan', format($q$select revoke_seat(%L)$q$, :'s_c'));
reset role;
select pg_temp.val_is('Chetan''s open leads in Follow-ups are back in the pool', $q$select string_agg(name||'='||coalesce(assigned_seat_id::text, 'pool'), ',' order by name) from leads where name in ('F3','F5')$q$, 'F3=pool,F5=pool');
select pg_temp.val_is('the call back keeps its status', $q$select status from leads where name='F3'$q$, 'callback');
select pg_temp.val_is('audit: lead.released (revoked) for both', $q$select count(*)::text from audit_log where action='lead.released' and target like '%:f4000000-0000-0000-0000-000000000004:revoked' and split_part(target, ':', 1) in (select id::text from leads where name in ('F3','F5'))$q$, '2');

-- Admin "back to pool".
select pg_temp.as_user(:'u_a');
set role authenticated;
select pg_temp.fails_with('a caller cannot send leads back to the pool', format($q$select admin_release_leads(%L)$q$, :'s_b'), 'only an admin');
reset role;
select pg_temp.as_user(:'u_y');
set role authenticated;
select pg_temp.fails('another institute cannot either', format($q$select admin_release_leads(%L)$q$, :'s_b'));
reset role;
select pg_temp.as_user(:'u_o');
set role authenticated;
select pg_temp.val_is('the owner sends Bina''s Follow-ups leads back (F1, F2)', format($q$select admin_release_leads(%L, (select id from ids where k='fu'))::text$q$, :'s_b'), '2');
reset role;
select pg_temp.val_is('Bina holds no Follow-ups lead', $q$select count(*)::text from leads where campaign_id='f5000000-0000-0000-0000-000000000001' and assigned_seat_id='f4000000-0000-0000-0000-000000000003'$q$, '0');
select pg_temp.val_is('released leads keep their state', $q$select string_agg(name||'='||status, ',' order by name) from leads where name in ('F1','F2')$q$, 'F1=promised,F2=callback');
select pg_temp.val_is('audit: lead.released (admin)', $q$select count(*)::text from audit_log where action='lead.released' and target like '%:admin'$q$, '2');

-- ---------- grants ----------
select pg_temp.val_is('nobody runs campaign_seat_can_work from the browser', $q$select has_function_privilege('authenticated','public.campaign_seat_can_work(uuid,uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('the old 7-argument admin_create_campaign is gone', $q$select count(*)::text from pg_proc where proname='admin_create_campaign'$q$, '1');
select pg_temp.val_is('one admin_update_campaign', $q$select count(*)::text from pg_proc where proname='admin_update_campaign'$q$, '1');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
