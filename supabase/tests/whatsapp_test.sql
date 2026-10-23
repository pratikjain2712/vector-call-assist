-- Tests for 20261024100027_whatsapp.sql: WhatsApp accounts, templates, messages, consent, STOP, reminders,
-- the weekly brief, RLS and grants. Run after every migration on a scratch database with stub_auth.sql.
-- The last line prints passed and failed counts: expect failed = 0.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''))::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon, service_role;
create temp table keep (k text primary key, v text);
grant all on keep to authenticated, anon, service_role;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
create or replace function pg_temp.fails_with(name text, sql text, want text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected an error, succeeded');
exception when others then insert into results values (name, sqlerrm ilike '%' || want || '%', sqlerrm); end $$;
create or replace function pg_temp.rows_is(name text, sql text, want int) returns void language plpgsql as $$
declare n int; begin execute sql into n; insert into results values (name, n = want, 'got '||n||', want '||want);
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;

-- ---------- fixed ids ----------
\set inst_i 'a7111111-0000-0000-0000-000000000001'
\set inst_j 'a7222222-0000-0000-0000-000000000002'
\set u_o  'a7000000-0000-0000-0000-000000000001'
\set u_m  'a7000000-0000-0000-0000-000000000002'
\set u_a  'a7000000-0000-0000-0000-000000000003'
\set u_b  'a7000000-0000-0000-0000-000000000004'
\set u_x  'a7000000-0000-0000-0000-000000000005'
\set s_o  'a7100000-0000-0000-0000-000000000001'
\set s_m  'a7100000-0000-0000-0000-000000000002'
\set s_a  'a7100000-0000-0000-0000-000000000003'
\set s_b  'a7100000-0000-0000-0000-000000000004'
\set s_x  'a7100000-0000-0000-0000-000000000005'
\set k_fees 'a7300000-0000-0000-0000-000000000001'
\set l_1 'a7400000-0000-0000-0000-000000000001'
\set l_2 'a7400000-0000-0000-0000-000000000002'
\set l_3 'a7400000-0000-0000-0000-000000000003'
\set l_4 'a7400000-0000-0000-0000-000000000004'
\set l_5 'a7400000-0000-0000-0000-000000000005'
\set l_6 'a7400000-0000-0000-0000-000000000006'

-- ---------- fixtures (as the table owner) ----------
-- Inst I: owner O, manager M (no money access), callers A and B. Inst J: owner X.
-- Leads in "Fees Oct": l_1 (A, consent), l_2 (A, no consent), l_3 (B, consent), l_4 (A, consent, do not call),
-- l_5 (A, consent, promised tomorrow), l_6 (A, no consent, promised tomorrow).
reset role;
insert into auth.users (id, email) values
 (:'u_o', 'owner@wa.test'), (:'u_m', 'manager@wa.test'), (:'u_a', 'a@wa.test'), (:'u_b', 'b@wa.test'),
 (:'u_x', 'owner@wj.test');
insert into institutes (id, name, status) values (:'inst_i', 'Inst I', 'active'), (:'inst_j', 'Inst J', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, status) values
 (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'owner', 'active'),
 (:'s_m', :'inst_i', :'u_m', 'Manager', 'admin', 'manager', 'active'),
 (:'s_a', :'inst_i', :'u_a', 'Caller A', 'rep', null, 'active'),
 (:'s_b', :'inst_i', :'u_b', 'Caller B', 'rep', null, 'active'),
 (:'s_x', :'inst_j', :'u_x', 'Owner J', 'admin', 'owner', 'active');
insert into campaigns (id, institute_id, name, call_type_id, status) values
 (:'k_fees', :'inst_i', 'Fees Oct', (select id from call_types where key='fees' and institute_id is null), 'running');
insert into campaign_members (campaign_id, seat_id, institute_id) values
 (:'k_fees', :'s_a', :'inst_i'), (:'k_fees', :'s_b', :'inst_i');
insert into leads (id, institute_id, campaign_id, name, phone, amount_due, assigned_seat_id, consent_whatsapp,
                   do_not_call, status, promised_date, promised_amount) values
 (:'l_1', :'inst_i', :'k_fees', 'Asha', '9876500001', 12000, :'s_a', true, false, 'new', null, null),
 (:'l_2', :'inst_i', :'k_fees', 'Arun', '9876500002', 8000, :'s_a', false, false, 'new', null, null),
 (:'l_3', :'inst_i', :'k_fees', 'Bina', '9876500003', 5000, :'s_b', true, false, 'new', null, null),
 (:'l_4', :'inst_i', :'k_fees', 'Dev', '9876500004', 5000, :'s_a', true, true, 'new', null, null),
 (:'l_5', :'inst_i', :'k_fees', 'Esha', '9876500005', 9000, :'s_a', true, false, 'promised', current_date + 1, 4500),
 (:'l_6', :'inst_i', :'k_fees', 'Farid', '9876500006', 9000, :'s_a', false, false, 'promised', current_date + 1, 4500);

-- Supabase gives service_role every table; the stub roles do not have that default, so grant it here.
grant all on all tables in schema public to service_role;

-- ---------- helpers ----------
select pg_temp.val_is('utility rate is 0.115', $q$select wa_rate('utility')::text$q$, '0.115');
select pg_temp.val_is('marketing rate is 0.86', $q$select wa_rate('marketing')::text$q$, '0.86');
select pg_temp.val_is('two blanks in order', $q$select wa_body_params('Hi {{1}}, pay {{2}} today.')::text$q$, '2');
select pg_temp.val_is('a repeated blank counts once', $q$select wa_body_params('Hi {{1}}, {{1}} and {{2}}.')::text$q$, '2');
select pg_temp.val_is('a gap in the blanks is refused', $q$select wa_body_params('Hi {{1}}, pay {{3}} today.')::text$q$, '-1');
select pg_temp.val_is('a malformed blank is refused', $q$select wa_body_params('Hi {{ name }} today.')::text$q$, '-1');
select pg_temp.val_is('no blanks', $q$select wa_body_params('Hello there.')::text$q$, '0');

-- ---------- overview ----------
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('owner overview: not connected yet', $q$select (admin_whatsapp_overview()->'account')::text$q$, 'null');
select pg_temp.val_is('owner overview: is owner', $q$select (admin_whatsapp_overview()->>'is_owner')$q$, 'true');
select pg_temp.val_is('owner overview: cost 0 this month', $q$select (admin_whatsapp_overview()->'month'->>'cost_inr')$q$, '0');
select pg_temp.as_user(:'u_m');
select pg_temp.val_is('manager overview: is not owner', $q$select (admin_whatsapp_overview()->>'is_owner')$q$, 'false');
select pg_temp.val_is('manager without money access: cost hidden', $q$select (admin_whatsapp_overview()->'month'->>'cost_inr')$q$, null);
select pg_temp.val_is('manager without money access: money_hidden', $q$select (admin_whatsapp_overview()->'month'->>'money_hidden')$q$, 'true');
select pg_temp.as_user(:'u_a');
select pg_temp.fails('caller cannot open WhatsApp settings', $q$select admin_whatsapp_overview()$q$);
reset role;
select pg_temp.fails('anon cannot open WhatsApp settings', $q$set local role anon; select admin_whatsapp_overview()$q$);

-- ---------- templates ----------
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.fails('caller cannot add a template', $q$select admin_whatsapp_save_template(null, 'Fees', 'fees_reminder', 'fees', 'will_pay_on', 'en', 'utility', 'Hello {{1}}, your fee of {{2}} is due.', array['lead_name','amount_due'])$q$);
select pg_temp.as_user(:'u_m');
select pg_temp.ok('manager adds the fees reminder', $q$insert into keep select 'tpl_fees', admin_whatsapp_save_template(null, 'Fees reminder', 'fees_reminder', 'fees', 'will_pay_on', 'en', 'utility', 'Hello {{1}}, your fee of {{2}} is due. Thank you.', array['lead_name','amount_due'])::text$q$);
select pg_temp.fails_with('the same short name twice is refused', $q$select admin_whatsapp_save_template(null, 'Fees again', 'fees_reminder', null, null, 'en', 'utility', 'Hello there.', '{}')$q$, 'already exists');
select pg_temp.fails_with('a gap in the blanks is refused', $q$select admin_whatsapp_save_template(null, 'Bad', 'bad_one', null, null, 'en', 'utility', 'Hello {{1}}, pay {{3}} now.', array['lead_name','amount_due'])$q$, 'in order');
select pg_temp.fails_with('a filler for every blank', $q$select admin_whatsapp_save_template(null, 'Bad', 'bad_two', null, null, 'en', 'utility', 'Hello {{1}}, pay {{2}} now.', array['lead_name'])$q$, 'each blank');
select pg_temp.fails_with('a message cannot start with a blank', $q$select admin_whatsapp_save_template(null, 'Bad', 'bad_three', null, null, 'en', 'utility', '{{1}}, pay now please.', array['lead_name'])$q$, 'starts or ends');
select pg_temp.fails_with('an unknown filler is refused', $q$select admin_whatsapp_save_template(null, 'Bad', 'bad_four', null, null, 'en', 'utility', 'Hi {{1}} there.', array['bank_account'])$q$, 'unknown filler');
select pg_temp.fails_with('a call ending of another type is refused', $q$select admin_whatsapp_save_template(null, 'Bad', 'bad_five', 'fees', 'joined', 'en', 'utility', 'Hello there.', '{}')$q$, 'not a result');
select pg_temp.fails('a bad category is refused', $q$select admin_whatsapp_save_template(null, 'Bad', 'bad_six', null, null, 'en', 'promo', 'Hello there.', '{}')$q$);
select pg_temp.ok('owner adds promise due (utility)', $q$insert into keep select 'tpl_promise', admin_whatsapp_save_template(null, 'Promise due', 'promise_due', 'fees', 'will_pay_on', 'en', 'utility', 'Hello {{1}}, a reminder that you said you would pay {{2}} on {{3}}. Thank you.', array['lead_name','promised_amount','promised_date'])::text$q$);
select pg_temp.as_user(:'u_o');
select pg_temp.ok('owner adds the weekly brief', $q$insert into keep select 'tpl_brief', admin_whatsapp_save_template(null, 'Weekly brief', 'weekly_brief', null, null, 'en', 'utility', 'Your week for {{1}}: {{2}} More in Vector.', array['typed','typed'])::text$q$);
select pg_temp.val_is('a new template is a draft', $q$select meta_status from whatsapp_templates where key='fees_reminder'$q$, 'draft');
select pg_temp.val_is('the Meta name has our prefix', $q$select meta_name from whatsapp_templates where key='fees_reminder'$q$, 'vec_fees_reminder');
select pg_temp.fails('the browser cannot write templates directly', $q$update whatsapp_templates set meta_status='approved'$q$);
select pg_temp.fails('the browser cannot insert templates directly', $q$insert into whatsapp_templates (institute_id, key, label, body) values ('a7111111-0000-0000-0000-000000000001', 'sneaky', 'S', 'Hi')$q$);
select pg_temp.as_user(:'u_a');
select pg_temp.rows_is('a caller does not see draft templates', $q$select count(*)::int from whatsapp_templates$q$, 0);
select pg_temp.as_user(:'u_x');
select pg_temp.rows_is('another institute sees none of these templates', $q$select count(*)::int from whatsapp_templates$q$, 0);
select pg_temp.fails('another institute cannot delete them', $q$select admin_whatsapp_delete_template((select v::uuid from keep where k='tpl_fees'))$q$);

-- ---------- service-only functions ----------
select pg_temp.as_user(:'u_o');
select pg_temp.fails('the browser cannot connect a number directly', $q$select wa_connect('a7000000-0000-0000-0000-000000000001', '1234567890', '9876543210', 'Inst I', '+91 98765 00000', 'v1:aaaa:bbbb')$q$);
select pg_temp.fails('the browser cannot claim a send', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000003', 'a7400000-0000-0000-0000-000000000001', 'fees_reminder')$q$);
select pg_temp.fails('the browser cannot store a reply', $q$select wa_store_reply('1234567890', '919876500001', 'wamid.x', 'hi', false, now())$q$);
select pg_temp.fails('the browser cannot claim reminders', $q$select wa_claim_reminders(current_date)$q$);

reset role;
set role service_role;
select pg_temp.fails_with('a manager cannot connect', $q$select wa_connect('a7000000-0000-0000-0000-000000000002', '1234567890', '9876543210', 'Inst I', null, 'v1:aaaa:bbbb')$q$, 'only an owner');
select pg_temp.fails_with('connecting needs a token', $q$select wa_connect('a7000000-0000-0000-0000-000000000001', '1234567890', '9876543210', 'Inst I', null, null)$q$, 'access token');
select pg_temp.ok('the owner connects', $q$select wa_connect('a7000000-0000-0000-0000-000000000001', '1234567890', '9876543210', 'Inst I', '+91 98765 00000', 'v1:aaaa:bbbb')$q$);
select pg_temp.fails_with('the same number for another institute is refused', $q$select wa_connect('a7000000-0000-0000-0000-000000000005', '1234567890', '1111111111', 'Inst J', null, 'v1:cccc:dddd')$q$, 'another institute');
select pg_temp.val_is('admin context returns the encrypted token', $q$select wa_admin_context('a7000000-0000-0000-0000-000000000001')->>'token_cipher'$q$, 'v1:aaaa:bbbb');
select pg_temp.fails('a caller has no admin context', $q$select wa_admin_context('a7000000-0000-0000-0000-000000000003')$q$);
select pg_temp.val_is('approve the fees reminder', $q$select wa_template_status((select v::uuid from keep where k='tpl_fees'), null, null, '111222', 'APPROVED')::text$q$, '1');
select pg_temp.val_is('the webhook approves promise due by name', $q$select wa_template_status(null, '9876543210', 'vec_promise_due', null, 'APPROVED')::text$q$, '1');
select pg_temp.val_is('a name in another business account changes nothing', $q$select wa_template_status(null, '5555555555', 'vec_weekly_brief', null, 'APPROVED')::text$q$, '0');
select pg_temp.fails('an unknown status is refused', $q$select wa_template_status((select v::uuid from keep where k='tpl_fees'), null, null, null, 'MAYBE')$q$);
reset role;

set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.fails('the owner cannot read the token table', $q$select count(*) from whatsapp_secrets$q$);
select pg_temp.val_is('overview shows the connected number', $q$select admin_whatsapp_overview()->'account'->>'display_name'$q$, 'Inst I');
select pg_temp.val_is('overview never shows a token', $q$select (admin_whatsapp_overview()::text ilike '%v1:aaaa%')::text$q$, 'false');
select pg_temp.as_user(:'u_a');
select pg_temp.rows_is('a caller can send the 2 approved templates', $q$select count(*)::int from my_whatsapp_templates()$q$, 2);
select pg_temp.rows_is('a caller reads approved templates only', $q$select count(*)::int from whatsapp_templates$q$, 2);
select pg_temp.rows_is('a caller does not read the account', $q$select count(*)::int from whatsapp_accounts$q$, 0);
reset role;

-- ---------- sending after a call ----------
set role service_role;
select pg_temp.ok('caller A claims a send to their lead', $q$insert into keep select 'ctx1', wa_prepare_send('a7000000-0000-0000-0000-000000000003', 'a7400000-0000-0000-0000-000000000001', 'fees_reminder')::text$q$);
insert into keep select 'msg1', v::jsonb->>'message_id' from keep where k = 'ctx1';
select pg_temp.val_is('the send context has the lead number', $q$select v::jsonb->'lead'->>'phone' from keep where k='ctx1'$q$, '+919876500001');
select pg_temp.val_is('the send context has the encrypted token', $q$select v::jsonb->>'token_cipher' from keep where k='ctx1'$q$, 'v1:aaaa:bbbb');
select pg_temp.val_is('the send context has the caller name', $q$select v::jsonb->>'caller_name' from keep where k='ctx1'$q$, 'Caller A');
select pg_temp.fails_with('the same template twice a day is refused', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000003', 'a7400000-0000-0000-0000-000000000001', 'fees_reminder')$q$, 'already sent');
select pg_temp.fails_with('a lead of another caller is refused', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000003', 'a7400000-0000-0000-0000-000000000003', 'fees_reminder')$q$, 'not assigned');
select pg_temp.fails_with('a lead without WhatsApp consent is refused', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000003', 'a7400000-0000-0000-0000-000000000002', 'fees_reminder')$q$, 'not agreed');
select pg_temp.fails_with('a do-not-call lead is refused', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000003', 'a7400000-0000-0000-0000-000000000004', 'fees_reminder')$q$, 'not to be contacted');
select pg_temp.fails_with('a template not approved is refused', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000004', 'a7400000-0000-0000-0000-000000000003', 'weekly_brief')$q$, 'not approved');
select pg_temp.fails_with('an admin cannot send to a lead they do not hold', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000001', 'a7400000-0000-0000-0000-000000000001', 'fees_reminder')$q$, 'not assigned');
select pg_temp.val_is('the send context carries the amount due for the template', $q$select (wa_prepare_send('a7000000-0000-0000-0000-000000000004', 'a7400000-0000-0000-0000-000000000003', 'fees_reminder')->'lead'->>'amount_due')$q$, '5000.00');
select pg_temp.ok('mark the first send failed', $q$select wa_mark_message((select v::uuid from keep where k='msg1'), 'failed', null, 'Hello Asha, your fee of ₹… is due. Thank you.', 'number not on WhatsApp')$q$);
select pg_temp.val_is('a failed send can be tried again', $q$select (wa_prepare_send('a7000000-0000-0000-0000-000000000003', 'a7400000-0000-0000-0000-000000000001', 'fees_reminder')->>'message_id')$q$, (select v from keep where k='msg1'));
select pg_temp.ok('mark it sent', $q$select wa_mark_message((select v::uuid from keep where k='msg1'), 'sent', 'wamid.ONE', 'Hello Asha, your fee of ₹… is due. Thank you.')$q$);
select pg_temp.val_is('a sent utility message costs 0.115', $q$select cost_inr::text from whatsapp_messages where meta_message_id='wamid.ONE'$q$, '0.115');
select pg_temp.val_is('delivered', $q$select wa_status_update('wamid.ONE', 'delivered', now(), null)::text$q$, 'true');
select pg_temp.ok('a late "sent" does not go back', $q$select wa_status_update('wamid.ONE', 'sent', now(), null)$q$);
select pg_temp.val_is('still delivered', $q$select status from whatsapp_messages where meta_message_id='wamid.ONE'$q$, 'delivered');
select pg_temp.ok('read', $q$select wa_status_update('wamid.ONE', 'read', now(), null)$q$);
select pg_temp.ok('failed after read is ignored', $q$select wa_status_update('wamid.ONE', 'failed', now(), 'late')$q$);
select pg_temp.val_is('still read', $q$select status from whatsapp_messages where meta_message_id='wamid.ONE'$q$, 'read');
select pg_temp.val_is('an unknown message id is not ours', $q$select wa_status_update('wamid.NOPE', 'read', now(), null)::text$q$, 'false');
-- the second send (to Bina, by caller B) fails at Meta after being sent
select pg_temp.ok('mark the send to Bina sent', $q$select wa_mark_message((select id from whatsapp_messages where lead_id='a7400000-0000-0000-0000-000000000003'), 'sent', 'wamid.TWO', 'Hello Bina, your fee of ₹… is due. Thank you.')$q$);
select pg_temp.ok('Meta says it failed', $q$select wa_status_update('wamid.TWO', 'failed', now(), 'undeliverable')$q$);
select pg_temp.val_is('a failed message costs nothing', $q$select cost_inr::text from whatsapp_messages where meta_message_id='wamid.TWO'$q$, '0.000');
reset role;

-- ---------- who reads messages ----------
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.rows_is('caller A reads messages of their lead', $q$select count(*)::int from whatsapp_messages$q$, 1);
select pg_temp.fails('nobody in the browser reads the cost column', $q$select cost_inr from whatsapp_messages$q$);
select pg_temp.as_user(:'u_b');
select pg_temp.rows_is('caller B reads only their lead''s message', $q$select count(*)::int from whatsapp_messages where lead_id='a7400000-0000-0000-0000-000000000001'$q$, 0);
select pg_temp.as_user(:'u_m');
select pg_temp.rows_is('the manager reads every message', $q$select count(*)::int from whatsapp_messages$q$, 2);
select pg_temp.val_is('month counts: 1 sent (the failed one does not count)', $q$select admin_whatsapp_overview()->'month'->>'sent'$q$, '1');
select pg_temp.val_is('month counts: 1 failed', $q$select admin_whatsapp_overview()->'month'->>'failed'$q$, '1');
select pg_temp.val_is('manager: cost still hidden', $q$select admin_whatsapp_overview()->'month'->>'cost_inr'$q$, null);
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('owner: estimated cost this month', $q$select admin_whatsapp_overview()->'month'->>'cost_inr'$q$, '0.115');
select pg_temp.val_is('owner: template message count', $q$select t->>'sent_this_month' from jsonb_array_elements(admin_whatsapp_overview()->'templates') t where t->>'key'='fees_reminder'$q$, '1');
select pg_temp.val_is('stored bodies never hold an amount', $q$select count(*)::text from whatsapp_messages where body ~ '[0-9]{3,}'$q$, '0');
select pg_temp.as_user(:'u_x');
select pg_temp.rows_is('another institute reads none of these messages', $q$select count(*)::int from whatsapp_messages$q$, 0);
reset role;
-- hide money everywhere hides the cost from the owner too
update institutes set hide_money = true where id = :'inst_i';
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.val_is('hide money: owner sees no cost', $q$select admin_whatsapp_overview()->'month'->>'cost_inr'$q$, null);
reset role;
update institutes set hide_money = false where id = :'inst_i';

-- ---------- template changes ----------
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.ok('rename only', $q$select admin_whatsapp_save_template((select v::uuid from keep where k='tpl_fees'), 'Fee reminder', null, 'fees', 'will_pay_on', 'en', 'utility', 'Hello {{1}}, your fee of {{2}} is due. Thank you.', array['lead_name','amount_due'])$q$);
select pg_temp.val_is('a new name keeps the approval', $q$select meta_status from whatsapp_templates where key='fees_reminder'$q$, 'approved');
select pg_temp.ok('change the text', $q$select admin_whatsapp_save_template((select v::uuid from keep where k='tpl_fees'), 'Fee reminder', null, 'fees', 'will_pay_on', 'en', 'utility', 'Dear {{1}}, your fee of {{2}} is due. Thank you.', array['lead_name','amount_due'])$q$);
select pg_temp.val_is('new text needs approval again', $q$select meta_status from whatsapp_templates where key='fees_reminder'$q$, 'draft');
select pg_temp.val_is('the Meta template id is kept for the edit', $q$select meta_template_id from whatsapp_templates where key='fees_reminder'$q$, '111222');
reset role;

-- ---------- replies and STOP ----------
set role service_role;
select pg_temp.val_is('a reply is stored on the lead', $q$select wa_store_reply('1234567890', '919876500001', 'wamid.IN1', 'Ok, will pay Friday', false, now())->>'lead_id'$q$, 'a7400000-0000-0000-0000-000000000001');
select pg_temp.val_is('the same reply twice is stored once', $q$select wa_store_reply('1234567890', '919876500001', 'wamid.IN1', 'Ok, will pay Friday', false, now())->>'stored'$q$, 'false');
select pg_temp.val_is('STOP turns WhatsApp consent off', $q$select wa_store_reply('1234567890', '919876500001', 'wamid.IN2', 'STOP', true, now())->>'stopped'$q$, '1');
select pg_temp.val_is('the lead has no WhatsApp consent now', $q$select consent_whatsapp::text from leads where id='a7400000-0000-0000-0000-000000000001'$q$, 'false');
select pg_temp.val_is('a reply from an unknown sender is kept without a lead', $q$select (wa_store_reply('1234567890', '919000000000', 'wamid.IN3', 'Who is this?', false, now())->'lead_id')::text$q$, 'null');
select pg_temp.val_is('a reply to an unknown business number is not stored', $q$select wa_store_reply('999', '919876500001', 'wamid.IN4', 'hi', false, now())->>'stored'$q$, 'false');
select pg_temp.fails_with('after STOP nothing more is sent', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000003', 'a7400000-0000-0000-0000-000000000001', 'promise_due')$q$, 'not agreed');
reset role;
select pg_temp.rows_is('STOP is written to the audit log', $q$select count(*)::int from audit_log where action='whatsapp.stopped'$q$, 1);
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.rows_is('caller A sees the replies on their lead', $q$select count(*)::int from whatsapp_messages where direction='in'$q$, 2);
reset role;

-- ---------- reminders a day before the promised date ----------
set role service_role;
select pg_temp.ok('claim the reminders due', $q$insert into keep select 'rem' || row_number() over (), r::text from wa_claim_reminders(current_date) r$q$);
select pg_temp.rows_is('one reminder due (consent only)', $q$select count(*)::int from keep where k like 'rem%'$q$, 1);
select pg_temp.val_is('the reminder is for the promised lead', $q$select v::jsonb->'lead'->>'name' from keep where k='rem1'$q$, 'Esha');
select pg_temp.val_is('the reminder has the promised amount for the template', $q$select v::jsonb->'lead'->>'promised_amount' from keep where k='rem1'$q$, '4500.00');
select pg_temp.rows_is('the same reminder is never claimed twice', $q$select count(*)::int from wa_claim_reminders(current_date)$q$, 0);
select pg_temp.rows_is('nothing is due for another day', $q$select count(*)::int from wa_claim_reminders(current_date + 5)$q$, 0);
select pg_temp.ok('the reminder failed at Meta', $q$select wa_mark_message((select id from whatsapp_messages where kind='reminder'), 'failed', null, 'x', 'timeout')$q$);
select pg_temp.rows_is('a failed reminder is tried on the next run', $q$select count(*)::int from wa_claim_reminders(current_date)$q$, 1);
reset role;

-- ---------- weekly brief ----------
set role authenticated;
select pg_temp.as_user(:'u_m');
select pg_temp.fails('a manager cannot ask for the brief on WhatsApp', $q$select admin_whatsapp_brief(true, '9876511111')$q$);
select pg_temp.as_user(:'u_o');
select pg_temp.fails_with('a bad number is refused', $q$select admin_whatsapp_brief(true, '12345')$q$, '10-digit');
select pg_temp.ok('the owner asks for the brief', $q$select admin_whatsapp_brief(true, '98765 11111')$q$);
select pg_temp.val_is('overview shows the brief number', $q$select admin_whatsapp_overview()->'brief'->>'phone'$q$, '+919876511111');
reset role;
set role service_role;
select pg_temp.ok('approve the brief template', $q$select wa_template_status((select v::uuid from keep where k='tpl_brief'), null, null, '333444', 'APPROVED')$q$);
select pg_temp.val_is('without admin_weekly_brief the brief is off', $q$select wa_brief_available()::text$q$, 'false');
select pg_temp.rows_is('without admin_weekly_brief nothing is claimed', $q$select count(*)::int from wa_claim_briefs(current_date)$q$, 0);
reset role;
-- A stand-in for the Insights feature's admin_weekly_brief: admin only, like the real one.
create function public.admin_weekly_brief(p_campaign uuid) returns setof text language plpgsql security definer
set search_path = public as $$
declare inst uuid;
begin
  select institute_id into inst from campaigns where id = p_campaign;
  if not public.is_admin_of(inst) then raise exception 'admins only' using errcode = '42501'; end if;
  return next 'Calls: 120 this week.';
  return next 'Promises kept: 8 of 10.';
end $$;
select pg_temp.as_user(null);
set role service_role;
select pg_temp.val_is('the brief runs as the owner', $q$select jsonb_array_length(r->'lines')::text from wa_claim_briefs(current_date) r$q$, '2');
select pg_temp.rows_is('the brief goes once a week', $q$select count(*)::int from wa_claim_briefs(current_date)$q$, 0);
select pg_temp.val_is('the brief leaves no borrowed login behind', $q$select coalesce(auth.uid()::text, 'none')$q$, 'none');
reset role;
set role authenticated;
select pg_temp.as_user(:'u_o');
select pg_temp.ok('the owner turns the brief off', $q$select admin_whatsapp_brief(false)$q$);
select pg_temp.rows_is('no brief recipients left', $q$select count(*)::int from whatsapp_brief_recipients$q$, 0);
reset role;

-- ---------- disconnect ----------
set role service_role;
select pg_temp.fails('a manager cannot disconnect', $q$select wa_disconnect('a7000000-0000-0000-0000-000000000002')$q$);
select pg_temp.ok('the owner disconnects', $q$select wa_disconnect('a7000000-0000-0000-0000-000000000001')$q$);
reset role;
select pg_temp.rows_is('the token is deleted', $q$select count(*)::int from whatsapp_secrets$q$, 0);
set role authenticated;
select pg_temp.as_user(:'u_a');
select pg_temp.rows_is('no templates to send once disconnected', $q$select count(*)::int from my_whatsapp_templates()$q$, 0);
reset role;
set role service_role;
select pg_temp.fails_with('no sending once disconnected', $q$select wa_prepare_send('a7000000-0000-0000-0000-000000000004', 'a7400000-0000-0000-0000-000000000003', 'promise_due')$q$, 'not connected');
reset role;
select pg_temp.rows_is('connect, template and brief changes are audited', $q$select count(distinct action)::int from audit_log where action in ('whatsapp.connected','whatsapp.disconnected','whatsapp.template_added','whatsapp.template_changed','whatsapp.brief_on','whatsapp.brief_off')$q$, 6);

select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
