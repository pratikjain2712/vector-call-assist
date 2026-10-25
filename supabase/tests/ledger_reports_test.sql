-- Tests for 20261025150000_ledger_reports.sql: Reports, Home and Insights numbers from the fee ledger.
-- admin_fees_ledger (due now, collected by mode and day, promised and broken promises checked against the
-- ledger), admin_promises_ledger (ledger state per promise), admin_home_ledger (collected today, promises due
-- today not paid, follow-ups returned to the pool today), money rules, roles and institutes.
-- Run with supabase/tests/run.sh. Expect failed = 0 on the last line.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid, mail text default null) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''), 'email', mail)::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
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
-- Today in India plus n days.
create or replace function pg_temp.d(n int) returns date language sql as $$
  select (now() at time zone 'Asia/Kolkata')::date + n $$;
grant execute on function pg_temp.ok(text, text), pg_temp.fails_with(text, text, text),
  pg_temp.val_is(text, text, text), pg_temp.d(int) to authenticated, anon;

-- ---------- fixed ids ----------
\set inst_i 'f1000000-0000-0000-0000-000000000001'
\set inst_j 'f2000000-0000-0000-0000-000000000002'
\set u_o  'f3000000-0000-0000-0000-000000000001'
\set u_m  'f3000000-0000-0000-0000-000000000002'
\set u_m2 'f3000000-0000-0000-0000-000000000003'
\set u_ac 'f3000000-0000-0000-0000-000000000004'
\set u_a  'f3000000-0000-0000-0000-000000000005'
\set u_b  'f3000000-0000-0000-0000-000000000006'
\set u_x  'f3000000-0000-0000-0000-000000000007'
\set s_o  'f4000000-0000-0000-0000-000000000001'
\set s_m  'f4000000-0000-0000-0000-000000000002'
\set s_m2 'f4000000-0000-0000-0000-000000000003'
\set s_ac 'f4000000-0000-0000-0000-000000000004'
\set s_a  'f4000000-0000-0000-0000-000000000005'
\set s_b  'f4000000-0000-0000-0000-000000000006'
\set s_x  'f4000000-0000-0000-0000-000000000007'
\set k_fee 'f5000000-0000-0000-0000-000000000001'
\set k_two 'f5000000-0000-0000-0000-000000000002'
\set k_j   'f5000000-0000-0000-0000-000000000003'
\set st1 'f6000000-0000-0000-0000-000000000001'
\set st2 'f6000000-0000-0000-0000-000000000002'
\set st3 'f6000000-0000-0000-0000-000000000003'
\set st4 'f6000000-0000-0000-0000-000000000004'
\set st5 'f6000000-0000-0000-0000-000000000005'
\set l1 'f7000000-0000-0000-0000-000000000001'
\set l2 'f7000000-0000-0000-0000-000000000002'
\set l3 'f7000000-0000-0000-0000-000000000003'
\set l4 'f7000000-0000-0000-0000-000000000004'
\set l5 'f7000000-0000-0000-0000-000000000005'
\set l6 'f7000000-0000-0000-0000-000000000006'
\set p3 'f8000000-0000-0000-0000-000000000003'

-- ---------- fixtures ----------
-- Inst I: owner O, manager M (no money), manager M2 (money), accounts AC, callers A and B. Inst J: owner X.
reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_o', 'o@i.test', now()), (:'u_m', 'm@i.test', now()), (:'u_m2', 'm2@i.test', now()), (:'u_ac', 'ac@i.test', now()),
 (:'u_a', 'a@i.test', now()), (:'u_b', 'b@i.test', now()), (:'u_x', 'x@j.test', now());
insert into institutes (id, name, status, seat_limit) values (:'inst_i', 'Inst I', 'active', 20), (:'inst_j', 'Inst J', 'active', 5);
insert into seats (id, institute_id, user_id, label, role, status) values (:'s_o', :'inst_i', :'u_o', 'Owner', 'admin', 'active');
insert into seats (id, institute_id, user_id, label, role, admin_kind, can_see_money, status) values
 (:'s_m',  :'inst_i', :'u_m',  'Manager', 'admin', 'manager', false, 'active'),
 (:'s_m2', :'inst_i', :'u_m2', 'Manager money', 'admin', 'manager', true, 'active'),
 (:'s_x',  :'inst_j', :'u_x',  'Owner J', 'admin', 'owner', false, 'active');
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_ac', :'inst_i', :'u_ac', 'Accounts', 'accounts', 'active'),
 (:'s_a',  :'inst_i', :'u_a',  'Caller A', 'rep', 'active'),
 (:'s_b',  :'inst_i', :'u_b',  'Caller B', 'rep', 'active');

-- Students: fees of 10,000 due 10 days ago (S4: 3,000 due in 30 days).
insert into students (id, institute_id, name, class_label, board) values
 (:'st1', :'inst_i', 'Riya', '8th', 'CBSE'), (:'st2', :'inst_i', 'Kabir', '8th', 'CBSE'),
 (:'st3', :'inst_i', 'Meera', '8th', 'CBSE'), (:'st4', :'inst_i', 'Dev', '8th', 'CBSE'), (:'st5', :'inst_i', 'Arjun', '8th', 'CBSE');
insert into fee_items (institute_id, student_id, head, amount, due_date) values
 (:'inst_i', :'st1', 'Term 1', 10000, pg_temp.d(-10)), (:'inst_i', :'st2', 'Term 1', 10000, pg_temp.d(-10)),
 (:'inst_i', :'st3', 'Term 1', 10000, pg_temp.d(-10)), (:'inst_i', :'st5', 'Term 1', 10000, pg_temp.d(-10)),
 (:'inst_i', :'st4', 'Term 2', 3000, pg_temp.d(30));

-- A fees campaign K (and a second fees campaign K2 for the campaign filter); Inst J has its own.
insert into campaigns (id, institute_id, name, call_type_id, status, open_to_all) values
 (:'k_fee', :'inst_i', 'Oct fees', (select id from call_types where key='fees' and institute_id is null), 'running', false),
 (:'k_two', :'inst_i', 'Nov fees', (select id from call_types where key='fees' and institute_id is null), 'running', false),
 (:'k_j',   :'inst_j', 'J fees',   (select id from call_types where key='fees' and institute_id is null), 'running', false);
insert into leads (id, institute_id, campaign_id, name, phone, amount_due, student_id, assigned_seat_id) values
 (:'l1', :'inst_i', :'k_fee', 'Mr Shah',   '9800000001', 10000, :'st1', :'s_a'),
 (:'l2', :'inst_i', :'k_fee', 'Mrs Mehta', '9800000002', 10000, :'st2', :'s_a'),
 (:'l3', :'inst_i', :'k_fee', 'Mr Iyer',   '9800000003', 10000, :'st3', :'s_b'),
 (:'l4', :'inst_i', :'k_fee', 'Mrs Khan',  '9800000004', 8000,  null,   :'s_b'),
 (:'l5', :'inst_i', :'k_fee', 'Mr Arora',  '9800000005', 10000, :'st5', :'s_a'),
 (:'l6', :'inst_i', :'k_two', 'Mr Rao',    '9800000006', 10000, null,   :'s_a');

-- Promises made on calls (Will pay on date), dated in the past.
insert into call_outcomes (institute_id, seat_id, client_record_id, campaign_id, lead_id, result_key, promised_date, amount, dialled_at) values
 (:'inst_i', :'s_a', 'p1', :'k_fee', :'l1', 'will_pay_on', pg_temp.d(-2), 5000, now() - interval '5 days'),
 (:'inst_i', :'s_a', 'p2', :'k_fee', :'l2', 'will_pay_on', pg_temp.d(-1), 6000, now() - interval '6 days'),
 (:'inst_i', :'s_b', 'p3', :'k_fee', :'l3', 'will_pay_on', pg_temp.d(0),  4000, now() - interval '1 day'),
 (:'inst_i', :'s_b', 'p4', :'k_fee', :'l4', 'will_pay_on', pg_temp.d(3),  7000, now() - interval '2 days'),
 (:'inst_i', :'s_a', 'p5', :'k_fee', :'l5', 'will_pay_on', pg_temp.d(-1), 3000, now() - interval '4 days'),
 (:'inst_i', :'s_a', 'p6', :'k_two', :'l6', 'will_pay_on', pg_temp.d(-3), 2000, now() - interval '4 days');

-- Ledger payments: Riya 5,000 UPI (covers her promise), Kabir 2,000 cash (part) plus a 1,000 opening import,
-- Meera 4,000 cash then reversed, Arjun 10,000 bank (closes his lead), Dev 1,000 UPI today (in advance).
insert into payments (institute_id, student_id, amount, paid_on, mode, reference, opening) values
 (:'inst_i', :'st1', 5000, pg_temp.d(-3), 'upi', 'UTR1', false),
 (:'inst_i', :'st2', 2000, pg_temp.d(-1), 'cash', null, false),
 (:'inst_i', :'st2', 1000, pg_temp.d(-20), 'other', null, true),
 (:'inst_i', :'st5', 10000, pg_temp.d(-2), 'bank', 'NEFT1', false),
 (:'inst_i', :'st4', 1000, pg_temp.d(0), 'upi', 'UTR4', false);
insert into payments (id, institute_id, student_id, amount, paid_on, mode) values (:'p3', :'inst_i', :'st3', 4000, pg_temp.d(-1), 'cash');
insert into payments (institute_id, student_id, amount, paid_on, mode, reverses_id, note) values
 (:'inst_i', :'st3', 4000, pg_temp.d(-1), 'cash', :'p3', 'Wrong student');

-- The lead states the caller screen and the ledger leave (set here so the test does not depend on triggers).
update leads set status = 'promised', promised_date = pg_temp.d(-2), promised_amount = 5000, amount_due = 5000 where id = :'l1';
update leads set status = 'promised', promised_date = pg_temp.d(-1), promised_amount = 6000, amount_due = 7000 where id = :'l2';
update leads set status = 'promised', promised_date = pg_temp.d(0),  promised_amount = 4000 where id = :'l3';
update leads set status = 'promised', promised_date = pg_temp.d(3),  promised_amount = 7000 where id = :'l4';
update leads set status = 'done', promised_date = pg_temp.d(-1), promised_amount = 3000, amount_due = 0, next_call_at = null where id = :'l5';
update leads set status = 'promised', promised_date = pg_temp.d(-3), promised_amount = 2000 where id = :'l6';

-- Follow-ups returned to the pool: two today (one in K2), one yesterday, one in Inst J.
insert into audit_log (institute_id, actor_id, action, target, created_at) values
 (:'inst_i', null, 'lead.released', :'l3' || ':' || :'s_b' || ':idle', now()),
 (:'inst_i', null, 'lead.released', :'l6' || ':' || :'s_a' || ':revoked', now()),
 (:'inst_i', null, 'lead.released', :'l2' || ':' || :'s_a' || ':idle', ((pg_temp.d(0) - 1)::timestamp at time zone 'Asia/Kolkata') + interval '1 hour'),
 (:'inst_j', null, 'lead.released', :'l1' || ':' || :'s_x' || ':idle', now());

-- ---------- Reports > Fees collection, owner (sees money) ----------
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.val_is('due now: students with a balance and the total (the ledger, opening import counted)',
  format($q$select (r->'due_now'->>'students')||':'||(r->'due_now'->>'amount') from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  '3:22000.00');
select pg_temp.val_is('collected: payments, total, reversed (opening import and reversed payment left out)',
  format($q$select (r->'collected'->>'payments')||':'||(r->'collected'->>'total')||':'||(r->'collected'->>'reversed') from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  '4:18000.00:1');
select pg_temp.val_is('collected by mode',
  format($q$select string_agg((x->>'mode')||'='||(x->>'payments')||'/'||(x->>'amount'), ',' order by x->>'mode') from admin_fees_ledger(%L, %L, %L) r, jsonb_array_elements(r->'collected'->'by_mode') x$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  'bank=1/10000.00,cash=1/2000.00,upi=2/6000.00');
select pg_temp.val_is('collected by day has one row per day with payments',
  format($q$select jsonb_array_length(r->'collected'->'by_day')::text from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  '4');
select pg_temp.val_is('promised and not yet paid: dated today or later, still to pay (no-student promise included)',
  format($q$select (r->'promised'->>'leads')||':'||(r->'promised'->>'amount') from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  '2:11000.00');
select pg_temp.val_is('broken: date passed and not covered by the ledger (part paid counts, paid does not)',
  format($q$select (r->'broken'->>'leads')||':'||(r->'broken'->>'part_paid')||':'||(r->'broken'->>'amount') from admin_fees_ledger(%L, %L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0), :'k_fee'),
  '1:1:4000.00');
select pg_temp.val_is('all fees campaigns: the other campaign''s late promise is broken too',
  format($q$select r->'broken'->>'leads' from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  '2');
select pg_temp.val_is('an open promise the ledger shows as paid',
  format($q$select r->'promises_paid'->>'leads' from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  '1');
select pg_temp.val_is('has_ledger and linked leads',
  format($q$select (r->>'has_ledger')||':'||(r->>'linked_leads') from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  'true:4');
select pg_temp.val_is('campaign filter: due now counts only the campaign''s students',
  format($q$select (r->'due_now'->>'students')||':'||(r->'due_now'->>'amount')||':'||(r->'collected'->>'payments') from admin_fees_ledger(%L, %L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0), :'k_fee'),
  '3:22000.00:3');
select pg_temp.val_is('caller filter: promises of caller B only',
  format($q$select (r->'promised'->>'leads')||':'||(r->'broken'->>'leads') from admin_fees_ledger(%L, %L, %L, null, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0), :'s_b'),
  '2:0');
select pg_temp.val_is('a narrower range collects less',
  format($q$select (r->'collected'->>'payments')||':'||(r->'collected'->>'total') from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(0), pg_temp.d(0)),
  '1:1000.00');
select pg_temp.fails_with('a range over 400 days is refused', format($q$select admin_fees_ledger(%L, %L, %L)$q$, :'inst_i', pg_temp.d(-500), pg_temp.d(0)), '400 days');
select pg_temp.fails_with('from after to is refused', format($q$select admin_fees_ledger(%L, %L, %L)$q$, :'inst_i', pg_temp.d(0), pg_temp.d(-1)), 'from date');
select pg_temp.fails_with('another institute''s campaign is refused', format($q$select admin_fees_ledger(%L, %L, %L, %L)$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0), :'k_j'), 'campaign not found');

-- ---------- promises due this week ----------
select pg_temp.val_is('promises due this week: order, lead status and ledger state',
  format($q$select string_agg(name||'/'||lead_status||'/'||ledger_state, ',' order by promised_date, name) from admin_promises_ledger(%L, %L) $q$, :'inst_i', :'k_fee'),
  'Mr Shah/promised/paid,Mr Arora/done/paid,Mrs Mehta/promised/part_paid,Mr Iyer/promised/not_paid,Mrs Khan/promised/no_student');
select pg_temp.val_is('a paid promise says when and how',
  format($q$select paid_on::text||':'||paid_mode||':'||paid_amount||':'||amount from admin_promises_ledger(%L, %L) where name='Mr Shah'$q$, :'inst_i', :'k_fee'),
  pg_temp.d(-3)::text || ':upi:5000.00:5000.00');
select pg_temp.val_is('a reversed payment does not count',
  format($q$select ledger_state||':'||coalesce(paid_on::text,'none') from admin_promises_ledger(%L, %L) where name='Mr Iyer'$q$, :'inst_i', :'k_fee'),
  'not_paid:none');
select pg_temp.val_is('days late and promised on',
  format($q$select days_late||':'||(promised_on = %L::date)::text from admin_promises_ledger(%L, %L) where name='Mrs Mehta'$q$, pg_temp.d(-6), :'inst_i', :'k_fee'),
  '1:true');
select pg_temp.val_is('one day ahead: the promise in 3 days is left out',
  format($q$select count(*)::text from admin_promises_ledger(%L, %L, null, 1)$q$, :'inst_i', :'k_fee'),
  '4');
select pg_temp.fails_with('days must be 1 to 31', format($q$select * from admin_promises_ledger(%L, null, null, 40)$q$, :'inst_i'), 'days must be');

-- ---------- Home ----------
select pg_temp.val_is('Home today: collected, promises due today not paid, follow-ups returned',
  $q$select (r->'collected'->>'payments')||':'||(r->'collected'->>'amount')||':'||(r->'promises_due_unpaid'->>'count')||':'||(r->'promises_due_unpaid'->>'amount')||':'||(r->'released_today'->>'count')||':'||(r->'released_today'->>'idle') from admin_home_ledger('today') r$q$,
  '1:1000.00:1:4000.00:2:1');
select pg_temp.val_is('Home yesterday: Kabir''s cash (the reversed payment left out)',
  $q$select (r->'collected'->>'payments')||':'||(r->'collected'->>'amount') from admin_home_ledger('yesterday') r$q$,
  '1:2000.00');
select pg_temp.val_is('Home with a campaign: released today in that campaign only',
  format($q$select (r->'released_today'->>'count')||':'||(r->'released_today'->>'revoked')||':'||(r->'promises_due_unpaid'->>'count') from admin_home_ledger('today', %L) r$q$, :'k_two'),
  '1:1:0');
select pg_temp.fails_with('Home: a bad day is refused', $q$select admin_home_ledger('month')$q$, 'day must be');
select pg_temp.fails_with('Home: another institute''s campaign is refused', format($q$select admin_home_ledger('today', %L)$q$, :'k_j'), 'campaign not found');
reset role;

-- ---------- money rules ----------
select pg_temp.as_user(:'u_m', 'm@i.test');
set role authenticated;
select pg_temp.val_is('manager without money: counts, no amounts',
  format($q$select (r->>'money_hidden')||':'||(r->'due_now'->>'students')||':'||coalesce(r->'due_now'->>'amount','null')||':'||(r->'collected'->>'payments')||':'||coalesce(r->'collected'->>'total','null')||':'||coalesce(r->'promised'->>'amount','null')||':'||coalesce(r->'broken'->>'amount','null') from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  'true:3:null:4:null:null:null');
select pg_temp.val_is('manager without money: by-mode amounts hidden',
  format($q$select count(*) filter (where x->>'amount' is not null)::text from admin_fees_ledger(%L, %L, %L) r, jsonb_array_elements(r->'collected'->'by_mode') x$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  '0');
select pg_temp.val_is('manager without money: promise rows keep the state, not the amounts',
  format($q$select ledger_state||':'||coalesce(amount::text,'null')||':'||coalesce(paid_amount::text,'null')||':'||money_hidden from admin_promises_ledger(%L, %L) where name='Mr Shah'$q$, :'inst_i', :'k_fee'),
  'paid:null:null:true');
select pg_temp.val_is('manager without money: Home counts only',
  $q$select (r->'collected'->>'payments')||':'||coalesce(r->'collected'->>'amount','null')||':'||coalesce(r->'promises_due_unpaid'->>'amount','null') from admin_home_ledger('today') r$q$,
  '1:null:null');
reset role;
select pg_temp.as_user(:'u_m2', 'm2@i.test');
set role authenticated;
select pg_temp.val_is('manager with money access sees amounts',
  format($q$select r->'collected'->>'total' from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  '18000.00');
reset role;
update institutes set hide_money = true where id = :'inst_i';
select pg_temp.as_user(:'u_o', 'o@i.test');
set role authenticated;
select pg_temp.val_is('hide money: the owner gets counts only',
  format($q$select (r->>'money_hidden')||':'||coalesce(r->'collected'->>'total','null')||':'||(r->'collected'->>'payments') from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  'true:null:4');
select pg_temp.val_is('hide money: Home amounts hidden',
  $q$select (r->>'money_hidden')||':'||coalesce(r->'collected'->>'amount','null') from admin_home_ledger('today') r$q$,
  'true:null');
reset role;
update institutes set hide_money = false where id = :'inst_i';

-- ---------- who may ask ----------
select pg_temp.as_user(:'u_a', 'a@i.test');
set role authenticated;
select pg_temp.fails_with('a caller cannot read the fees report', format($q$select admin_fees_ledger(%L, %L, %L)$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)), 'only owners, managers and accounts');
select pg_temp.fails_with('a caller cannot read promises', format($q$select * from admin_promises_ledger(%L)$q$, :'inst_i'), 'only owners, managers and accounts');
select pg_temp.fails_with('a caller cannot read Home', $q$select admin_home_ledger('today')$q$, 'only an admin');
reset role;
select pg_temp.as_user(:'u_ac', 'ac@i.test');
set role authenticated;
select pg_temp.val_is('accounts reads Fees collection, with money (hide_money does not apply)',
  format($q$select (r->>'money_hidden')||':'||(r->'collected'->>'total')||':'||(r->'due_now'->>'amount') from admin_fees_ledger(%L, %L, %L) r$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)),
  'false:18000.00:22000.00');
select pg_temp.val_is('accounts reads the promises due this week with amounts',
  format($q$select count(*)||':'||sum(amount) from admin_promises_ledger(%L, %L)$q$, :'inst_i', :'k_fee'),
  '5:25000.00');
select pg_temp.ok('accounts may log the Fees collection export', format($q$select log_money_export(%L, 'fees_report', 12)$q$, :'inst_i'));
select pg_temp.fails_with('accounts still cannot read the caller-reported admin report', format($q$select * from admin_fees_report(%L, now() - interval '7 days', now())$q$, :'inst_i'), 'only an admin');
select pg_temp.fails_with('accounts cannot read Home', $q$select admin_home_ledger('today')$q$, 'only an admin');
reset role;
select pg_temp.as_user(:'u_x', 'x@j.test');
set role authenticated;
select pg_temp.fails_with('another institute''s owner cannot read Inst I', format($q$select admin_fees_ledger(%L, %L, %L)$q$, :'inst_i', pg_temp.d(-7), pg_temp.d(0)), 'only owners, managers and accounts');
select pg_temp.fails_with('another institute''s owner cannot read Inst I promises', format($q$select * from admin_promises_ledger(%L)$q$, :'inst_i'), 'only owners, managers and accounts');
select pg_temp.val_is('Home of Inst J sees only its own release',
  $q$select (r->'released_today'->>'count')||':'||(r->>'has_ledger')||':'||(r->'collected'->>'payments') from admin_home_ledger('today') r$q$,
  '1:false:0');
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot run admin_fees_ledger', $q$select has_function_privilege('anon','public.admin_fees_ledger(uuid,date,date,uuid,uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot run admin_home_ledger', $q$select has_function_privilege('anon','public.admin_home_ledger(text,uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('the browser cannot run the internal promise rows', $q$select has_function_privilege('authenticated','public.report_fee_promise_rows(uuid,uuid,uuid)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('signed-in people can ask admin_promises_ledger (it checks the admin)', $q$select has_function_privilege('authenticated','public.admin_promises_ledger(uuid,uuid,uuid,int)','EXECUTE')::text$q$, 'true');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
