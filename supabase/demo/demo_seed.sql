-- Demo institute "Sunrise Coaching Academy (Demo)" for sales demos. FAKE DATA ONLY: every name is made up and
-- every phone number is in the +91 9999xxxxxx block, which is used here as an obviously fake range. The one
-- exception is "Shronit" (+91 96197 07601) in Course sales: a real person who agreed to take a live call
-- during demos (Neha's first due call back). Never add other real numbers.
--
-- Run AFTER all migrations and AFTER create-demo-users.mjs (it finds the 8 demo logins by email):
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/demo/demo_seed.sql
-- or simply supabase/demo/reset-demo.sh (does both). Steps for the demo: docs/demo.md.
--
-- Idempotent: it first deletes the demo institute (fixed id below) and everything that hangs off it, then
-- builds it again in one transaction. It touches no other institute. Dates and times are relative to now() in
-- Asia/Kolkata, so "Today" on Home is the day you load it: load it on the morning of the demo (best 15–30
-- minutes before), after 10 am India time if you can, so today's calls fall in normal working hours.
--
-- The call history is a small simulation with a fixed random seed (same data every run, shifted to today):
-- callers work their queue day by day (due callbacks and promises first, then new leads), people pick up more
-- often at 7–9 pm, Ravi calls mostly around 11 am, promises made far away are kept less often (and Class 10-B
-- worse than 10-A), Priya often skips the Questions step, Amit's opening is long, Neha converts best, and in
-- the sales script test v7 does better than v6. Lead rows end in the state those calls leave them in (the same
-- mapping as save_call_result). Today's calls use fixed result counts so Home looks like the mockup.
--
-- Phase A.2: a fee ledger (Class 8 CBSE, Class 9 ICSE, Class 10 CBSE students with fee items, an opening
-- balance import, payments of the last 8 weeks by mode, a few reversals) that agrees with the calls: a parent
-- who said "paid" on a call has a payment within 0–2 days in most cases, a few "says already paid" have none
-- (for the office to check), and every fees lead carries its student and amount_due = the student's balance.
-- Every campaign is open to all callers and tagged by class and board; every lead has extra.source and
-- extra.source_date (docs/template-library.md, placeholders). An Accounts login (Kavita) records payments.

\set ON_ERROR_STOP on
\if :{?terms_version}
\else
  \set terms_version '2026-10-draft'
\endif
\if :{?terms_hash}
\else
  \set terms_hash '3732a16861029ea50ec162fa0c7dcb85885f3ccf4eec06682d80d89af8fe32d1'
\endif
\if :{?demo_seed}
\else
  \set demo_seed 0.2410
\endif

begin;

select set_config('demo.terms_version', :'terms_version', true) as _v,
       set_config('demo.terms_hash', :'terms_hash', true) as _h,
       set_config('demo.seed', :'demo_seed', true) as _s \gset

-- ---------- 1. the demo logins must exist ----------

create temp table demo_people (
  who      text primary key,
  email    text not null,
  label    text not null,
  role     text not null,          -- admin / rep / accounts
  kind     text,                   -- owner / manager / accounts / null
  seat     uuid not null,
  user_id  uuid
) on commit drop;

insert into demo_people (who, email, label, role, kind, seat) values
  ('owner',   'owner.sunrise@example.com',   'Anita Sharma', 'admin', 'owner',   '5a1e0000-0000-4000-8000-000000000101'),
  ('manager', 'manager.sunrise@example.com', 'Rahul Verma',  'admin', 'manager', '5a1e0000-0000-4000-8000-000000000102'),
  ('ravi',    'ravi.sunrise@example.com',    'Ravi',         'rep',   null,      '5a1e0000-0000-4000-8000-000000000103'),
  ('priya',   'priya.sunrise@example.com',   'Priya',        'rep',   null,      '5a1e0000-0000-4000-8000-000000000104'),
  ('neha',    'neha.sunrise@example.com',    'Neha',         'rep',   null,      '5a1e0000-0000-4000-8000-000000000105'),
  ('amit',    'amit.sunrise@example.com',    'Amit',         'rep',   null,      '5a1e0000-0000-4000-8000-000000000106'),
  ('sana',    'sana.sunrise@example.com',    'Sana',         'rep',   null,      '5a1e0000-0000-4000-8000-000000000107'),
  ('kavita',  'accounts.sunrise@example.com', 'Kavita Joshi', 'accounts', 'accounts', '5a1e0000-0000-4000-8000-000000000108');

update demo_people p set user_id = u.id from auth.users u where lower(u.email) = p.email;

do $$
declare
  missing text;
  busy    text;
begin
  select string_agg(email, ', ' order by email) into missing from demo_people where user_id is null;
  if missing is not null then
    raise exception 'Demo logins missing in auth.users: %. Run supabase/demo/create-demo-users.mjs first (docs/demo.md).', missing;
  end if;
  select string_agg(p.email, ', ' order by p.email) into busy
    from demo_people p join public.seats s on s.user_id = p.user_id and s.status = 'active'
    where s.institute_id <> '5a1e0000-0000-4000-8000-000000000001';
  if busy is not null then
    raise exception 'These demo logins already hold an active seat in another institute: %. Use them only for the demo.', busy;
  end if;
end $$;

-- ---------- 2. delete the old demo institute (only this one) ----------

-- Corrections point at the rows they correct (on delete restrict), and a published script version refuses
-- to be deleted, so both are undone first. Everything else goes with the institute (on delete cascade).
update public.call_outcomes set corrects_id = null
  where institute_id = '5a1e0000-0000-4000-8000-000000000001' and corrects_id is not null;
delete from public.call_outcomes where institute_id = '5a1e0000-0000-4000-8000-000000000001';
update public.script_versions set published = false
  where institute_id = '5a1e0000-0000-4000-8000-000000000001' and published;
delete from public.institutes where id = '5a1e0000-0000-4000-8000-000000000001';

-- ---------- 3. helpers for this load only (pg_temp: gone when the session ends) ----------

-- A time on day d, sec seconds after midnight India time.
create function pg_temp.ist(d date, sec int) returns timestamptz language sql immutable as $$
  select (d::timestamp + sec * interval '1 second') at time zone 'Asia/Kolkata'
$$;

-- 1-based index picked with the given weights.
create function pg_temp.pick(w numeric[]) returns int language plpgsql as $$
declare
  tot numeric := 0;
  acc numeric := 0;
  r   numeric;
  i   int;
begin
  for i in 1 .. array_length(w, 1) loop tot := tot + w[i]; end loop;
  r := random() * tot;
  for i in 1 .. array_length(w, 1) loop
    acc := acc + w[i];
    if r < acc then return i; end if;
  end loop;
  return array_length(w, 1);
end $$;

-- Chance that someone picks up at hour h (India) on ISO day dow: evenings are much better.
create function pg_temp.pick_p(h int, dow int) returns numeric language sql immutable as $$
  select case when h = 19 then case when dow >= 6 then 0.56 else 0.84 end
              when h = 20 then case when dow >= 6 then 0.50 else 0.72 end
              when h = 18 then 0.50
              when h = 13 then 0.33
              when h between 10 and 12 then case when dow >= 6 then 0.42 else 0.42 end
              else 0.38 end
$$;

-- Hours 10..20 each caller tends to call at (Ravi mostly around 11 am, Neha more in the evening).
create temp table demo_hours (who text primary key, w numeric[] not null) on commit drop;
insert into demo_hours values
  ('ravi',  array[8, 31, 10, 4, 6, 6, 6, 6, 5, 10, 8]),
  ('amit',  array[14, 13, 13, 8, 12, 11, 10, 8, 4, 5, 2]),
  ('priya', array[10, 12, 11, 6, 11, 11, 11, 10, 8, 6, 4]),
  ('neha',  array[6, 8, 8, 4, 8, 8, 9, 10, 12, 15, 12]),
  ('sana',  array[12, 12, 11, 6, 12, 12, 12, 11, 6, 4, 2]);

-- One call time on day d for a caller, from their usual hours.
create function pg_temp.call_time(p_who text, d date) returns timestamptz language plpgsql as $$
declare h int;
begin
  h := 9 + pg_temp.pick((select w from demo_hours where who = p_who));
  return pg_temp.ist(d, h * 3600 + floor(random() * 3540)::int);
end $$;

-- A date as a caller says it ({source_date}, {due_date}): "20 October", with the year when it is not this year.
create function pg_temp.say_date(d date) returns text language sql stable as $$
  select case when extract(year from d) = extract(year from now() at time zone 'Asia/Kolkata')
              then to_char(d, 'FMDD FMMonth') else to_char(d, 'FMDD FMMonth YYYY') end
$$;

-- Names for the made-up people.
create temp table demo_names (k text primary key, a text[] not null) on commit drop;
insert into demo_names values
  ('pf', array['Rakesh', 'Sunita', 'Manoj', 'Priti', 'Suresh', 'Kavita', 'Ajay', 'Meena', 'Vijay', 'Rekha',
               'Sanjay', 'Anjali', 'Deepak', 'Pooja', 'Rajesh', 'Neeta', 'Anil', 'Seema', 'Ashok', 'Geeta',
               'Mahesh', 'Shalini', 'Prakash', 'Usha', 'Ramesh', 'Vandana', 'Dinesh', 'Lata', 'Nitin', 'Swati',
               'Sachin', 'Rupali', 'Harish', 'Asha', 'Girish', 'Jyoti', 'Mukesh', 'Smita', 'Pankaj', 'Nisha', 'Alok']),
  ('sn', array['Sharma', 'Patel', 'Mehta', 'Iyer', 'Nair', 'Reddy', 'Gupta', 'Joshi', 'Kulkarni', 'Deshmukh',
               'Singh', 'Verma', 'Rao', 'Pillai', 'Shah', 'Desai', 'Chauhan', 'Bose', 'Das', 'Menon', 'Pandey',
               'Mishra', 'Kapoor', 'Malhotra', 'Agarwal', 'Jain', 'Shetty', 'Naik', 'Patil', 'Yadav', 'Khan']),
  ('kid', array['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ananya', 'Diya',
                'Aadhya', 'Saanvi', 'Myra', 'Kiara', 'Riya', 'Anika', 'Kabir', 'Rohan', 'Tanvi', 'Shreya',
                'Aryan', 'Dhruv', 'Meera', 'Nikhil', 'Pranav', 'Sneha', 'Ira', 'Yash', 'Om', 'Tara', 'Zoya']),
  ('adult', array['Rahul', 'Karan', 'Sneha', 'Pooja', 'Akash', 'Nidhi', 'Varun', 'Komal', 'Siddharth', 'Payal',
                  'Abhishek', 'Ritika', 'Gaurav', 'Neha', 'Rohit', 'Shruti', 'Manish', 'Divya', 'Kunal', 'Isha',
                  'Tushar', 'Megha', 'Harsh', 'Aditi', 'Vikas', 'Sakshi', 'Saurabh', 'Prachi', 'Ankit', 'Juhi', 'Imran']);

-- Payment mode, weighted like a school office: UPI most, then cash, cheque, bank transfer.
create function pg_temp.pay_mode() returns text language sql as $$
  select (array['upi', 'cash', 'cheque', 'bank'])[pg_temp.pick(array[58, 20, 12, 10])]
$$;

-- One ledger payment, with a made-up reference in the usual shape for its mode (UPI: 12-digit UTR; bank:
-- NEFT UTR; cheque: cheque number; cash: receipt number). Recorded by Kavita (accounts), now and then the owner.
create temp sequence demo_ref_seq;
create function pg_temp.add_payment(p_student uuid, p_amount numeric, p_paid_on date, p_mode text,
                                    p_note text, p_created timestamptz, p_by uuid default null)
returns uuid language plpgsql as $$
declare
  n   bigint := nextval('demo_ref_seq');
  ref text;
  pid uuid;
begin
  ref := case p_mode
           when 'upi' then '6' || to_char(p_paid_on, 'YDDD') || lpad(n::text, 7, '0')
           when 'bank' then 'NEFT SBIN' || to_char(p_paid_on, 'YYMMDD') || lpad(n::text, 6, '0')
           when 'cheque' then 'Cheque ' || lpad(((n * 7919) % 900000 + 100000)::text, 6, '0')
           when 'cash' then 'Receipt ' || lpad((1200 + n)::text, 5, '0') end;
  insert into public.payments (institute_id, student_id, amount, paid_on, mode, reference, note, recorded_by, created_at)
    values ('5a1e0000-0000-4000-8000-000000000001', p_student, p_amount, p_paid_on, p_mode, ref, p_note,
            coalesce(p_by, case when random() < 0.12 then '5a1e0000-0000-4000-8000-000000000101'::uuid
                                else '5a1e0000-0000-4000-8000-000000000108'::uuid end),
            p_created)
    returning id into pid;
  return pid;
end $$;

-- A reversal of a payment (same amount, date and mode, no reference; the reason is the note), like
-- accounts_reverse_payment, with its audit row.
create function pg_temp.reverse_payment(p_payment uuid, p_reason text, p_at timestamptz) returns uuid language plpgsql as $$
declare rid uuid;
begin
  insert into public.payments (institute_id, student_id, amount, paid_on, mode, note, recorded_by, reverses_id, opening, created_at)
    select p.institute_id, p.student_id, p.amount, p.paid_on, p.mode, p_reason, '5a1e0000-0000-4000-8000-000000000108',
           p.id, p.opening, p_at
    from public.payments p where p.id = p_payment
    returning id into rid;
  insert into public.audit_log (institute_id, actor_id, action, target, created_at)
    values ('5a1e0000-0000-4000-8000-000000000001', (select user_id from demo_people where who = 'kavita'),
            'payment.reversed', rid::text || ':' || p_payment::text, p_at);
  return rid;
end $$;

-- ---------- 4. the institute, people, devices, terms ----------
-- seat_limit 8 = the 8 demo seats: the institute is full, so nobody can send invite emails from the demo.

create temp table demo_ctx (k text primary key, v text) on commit drop;

do $$
declare
  inst   uuid := '5a1e0000-0000-4000-8000-000000000001';
  today  date := (now() at time zone 'Asia/Kolkata')::date;
  owner  uuid := (select user_id from demo_people where who = 'owner');
  p      record;
begin
  insert into demo_ctx values ('today', today::text);

  insert into public.institutes (id, name, status, seat_limit, features, time_zone, hide_money, trial_ends_at,
                                 created_by, created_at)
    values (inst, 'Sunrise Coaching Academy (Demo)', 'active', 8, array['scripts', 'ai_drafts'], 'Asia/Kolkata',
            false, null, owner, pg_temp.ist(today - 75, 11 * 3600));

  for p in select * from demo_people order by seat loop
    insert into public.seats (id, institute_id, user_id, label, role, status, admin_kind, can_see_money, created_at)
      values (p.seat, inst, p.user_id, p.label, p.role, 'active', p.kind, false,
              case when p.role = 'accounts' then pg_temp.ist(today - 60, 10 * 3600)   -- the fees office joined later
                   else pg_temp.ist(today - 75, 11 * 3600) + (p.seat::text > '5a1e0000-0000-4000-8000-000000000102')::int * interval '2 days' end);
    insert into public.profiles (id, full_name) values (p.user_id, p.label)
      on conflict (id) do update set full_name = excluded.full_name;
    -- Terms already accepted, so nobody is stopped by the terms panel.
    insert into public.accepted_terms (institute_id, seat_id, user_id, terms_version, text_hash, accepted_at)
      values (inst, p.seat, p.user_id, current_setting('demo.terms_version'), current_setting('demo.terms_hash'),
              pg_temp.ist(case when p.role = 'accounts' then today - 60 else today - 72 end, 10 * 3600 + floor(random() * 20000)::int));
    -- A laptop for everyone, and a paired phone for each caller (Callers tab: Phone connected).
    insert into public.devices (seat_id, kind, fingerprint, paired_at)
      values (p.seat, 'laptop', 'demo-laptop-' || replace(p.seat::text, '-', ''),
              pg_temp.ist(case when p.role = 'accounts' then today - 60 else today - 72 end, 12 * 3600));
    if p.role = 'rep' then
      insert into public.devices (seat_id, kind, fingerprint, paired_at)
        values (p.seat, 'phone', 'demo-phone-' || replace(p.seat::text, '-', ''), pg_temp.ist(today - 72, 12 * 3600 + 600));
    end if;
  end loop;

  -- Daily targets (Callers tab, Home "Target").
  insert into public.rep_targets (seat_id, institute_id, metric, daily_target)
  select dp.seat, inst, m.metric,
         case m.metric when 'calls' then case dp.who when 'sana' then 35 else 40 end
                       when 'connected_calls' then 24 else 90 end
  from demo_people dp cross join (values ('calls'), ('connected_calls'), ('talk_minutes')) m(metric)
  where dp.role = 'rep';
end $$;

-- ---------- 5. call type results this institute added ----------

insert into public.call_type_results (call_type_id, institute_id, key, label, needs_date, needs_amount, needs_reason,
                                      needs_rating, reason_choices, counts_as_good, legacy_outcome, sort_order, created_at)
select t.id, '5a1e0000-0000-4000-8000-000000000001', v.k, v.label, false, false, v.reason, false, v.choices, v.good,
       case when v.good then 'won' else 'other' end, 500, now() - interval '40 days'
from (values
  ('admission', 'admission_done', 'Admission confirmed', false, null::text[], true),
  ('fees',      'fee_concession', 'Asked for concession', true,
                array['Sibling discount', 'Single parent', 'Lost job', 'Other'], false)
) v(tkey, k, label, reason, choices, good)
join public.call_types t on t.key = v.tkey and t.institute_id is null;

-- ---------- 6. scripts (script-model.js format) ----------

create temp table demo_scripts (k text primary key, id uuid not null) on commit drop;
insert into demo_scripts values
  ('fees',      '5a1e0000-0000-4000-8000-000000000301'),
  ('sales',     '5a1e0000-0000-4000-8000-000000000302'),
  ('admission', '5a1e0000-0000-4000-8000-000000000303'),
  ('late_fee',  '5a1e0000-0000-4000-8000-000000000304'),
  -- Phase A.2: made from the central template library (supabase/templates/library.json), check marks filled in.
  ('overdue10', '5a1e0000-0000-4000-8000-000000000305'),
  ('polite8',   '5a1e0000-0000-4000-8000-000000000306'),
  ('adm9',      '5a1e0000-0000-4000-8000-000000000307');

do $$
declare
  inst   uuid := '5a1e0000-0000-4000-8000-000000000001';
  today  date := (now() at time zone 'Asia/Kolkata')::date;
  owner  uuid := '5a1e0000-0000-4000-8000-000000000101';
  mgr    uuid := '5a1e0000-0000-4000-8000-000000000102';
  t_fees uuid := (select id from public.call_types where key = 'fees' and institute_id is null);
  t_sale uuid := (select id from public.call_types where key = 'sales' and institute_id is null);
  t_adm  uuid := (select id from public.call_types where key = 'admission' and institute_id is null);
  fees_v2 jsonb; fees_v3 jsonb; fees_pb jsonb;
  sales_v6 jsonb; sales_v7 jsonb; sales_pb jsonb;
  adm_v1 jsonb; adm_v2 jsonb; adm_pb jsonb;
  late_v1 jsonb; late_pb jsonb;
  od_v1 jsonb; od_pb1 jsonb; od_v2 jsonb; od_pb2 jsonb;
  po_v1 jsonb; po_pb1 jsonb; po_v2 jsonb; po_pb2 jsonb;
  a9_v1 jsonb; a9_pb1 jsonb; a9_v2 jsonb; a9_pb2 jsonb;
  i int;
begin
  fees_v3 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0,
     "say": ["Hello, am I speaking with {name}?", "This is {me} from Sunrise Coaching Academy."],
     "tip": "Smile before you speak. Say who you are in one line.",
     "opts": [{"label": "Yes", "to": "reminder"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "reminder", "title": "Reminder", "stage": 1,
     "say": ["I am calling about the second term fee for Class 10.", "The fee of ₹18,000 is due on 31 October."],
     "tip": "Say the amount and the date clearly. Do not rush.",
     "opts": [{"label": "Will pay", "to": "when"}, {"label": "Already paid", "to": "already"}, {"label": "Has a problem", "to": "problem"}]},
    {"id": "when", "title": "Pay date", "stage": 3,
     "say": ["Thank you. On which date can you pay it?", "You can pay by UPI, by card, or at the office from 9 am to 5 pm."],
     "tip": "Ask for a date within 7 days. Repeat the date back to them.",
     "opts": [{"label": "Gives a date", "to": "promise"}, {"label": "Paying now", "to": "paid"}, {"label": "Not sure", "to": "problem"}]},
    {"id": "problem", "title": "Problem", "stage": 4,
     "say": ["I understand. Thank you for telling me.", "You can pay ₹9,000 now and the rest by 15 November, with the principal's OK."],
     "tip": "Listen first. Do not argue. Never talk about the child's marks.",
     "opts": [{"label": "Pays a part now", "to": "part"}, {"label": "Gives a later date", "to": "promise"}, {"label": "Cannot pay", "to": "refused"}]},
    {"id": "promise", "title": "Will pay on date", "stage": 5, "result": "will_pay_on",
     "say": ["Thank you. I have noted the date and the amount.", "I will send a reminder on WhatsApp the day before. Have a good day, {name}."]},
    {"id": "paid", "title": "Paid", "stage": 5, "result": "paid",
     "say": ["Thank you! The receipt will come on WhatsApp within a day.", "Have a good day, {name}."]},
    {"id": "part", "title": "Paid part", "stage": 5, "result": "paid_part",
     "say": ["Thank you. I have noted the part you paid and the date for the rest."]},
    {"id": "already", "title": "Says already paid", "stage": 5, "result": "already_paid",
     "say": ["Thank you! I will check this with the office.", "If you have the receipt number, please tell me."]},
    {"id": "refused", "title": "Cannot pay", "stage": 5, "result": "refused",
     "say": ["I understand. I will tell the office, and someone will call you.", "Thank you for your time, {name}."]},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number",
     "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later",
     "say": ["No problem. When can I call you back?"]}
  ]$j$::jsonb;
  -- v2: before the part-payment line and the "Paying now" choice.
  fees_v2 := jsonb_set(jsonb_set(fees_v3, '{2,opts}',
                 '[{"label": "Gives a date", "to": "promise"}, {"label": "Not sure", "to": "problem"}]'::jsonb),
               '{3,say}', '["I understand. Thank you for telling me.", "Can you pay a part now and the rest later?"]'::jsonb);
  fees_pb := $j$[
    {"label": "We already paid", "answer": "Thank you. Please tell me the date you paid or the receipt number. I will check with the office today."},
    {"label": "Money is tight this month", "answer": "I understand. Tell me a date that works for you, within the next week if you can, and I will note it down."},
    {"label": "Talk to my husband or wife", "answer": "Sure. When can I call back to speak with them? Morning or evening?"},
    {"label": "Can I pay in parts?", "answer": "Yes. You can pay ₹9,000 now and the rest by 15 November, with the principal's OK. I will note it for the office."}
  ]$j$::jsonb;

  sales_v7 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0,
     "say": ["Hello, am I speaking with {name}?"],
     "tip": "Smile before you speak. Speak slowly.",
     "opts": [{"label": "Yes", "to": "questions"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "questions", "title": "Questions", "stage": 1,
     "say": ["Hi {name}, this is {me} from Sunrise Coaching Academy. You asked about our Data Analytics course.", "What do you do now, and what do you want the course to help you with?"],
     "tip": "Let them talk. Note one thing they want. Use it in the pitch.",
     "opts": [{"label": "Told me", "to": "pitch"}, {"label": "Not looking now", "to": "no"}]},
    {"id": "pitch", "title": "Pitch", "stage": 2, "pitch": true,
     "say": ["The course teaches Excel, SQL, Python and Power BI in 4 months, with live classes and 3 real projects.", "You finish with a portfolio you can show in interviews."],
     "opts": [{"label": "Sounds good", "to": "timings"}, {"label": "Wants to think", "to": "think"}, {"label": "Not for them", "to": "no"}]},
    {"id": "timings", "title": "Timings", "stage": 3,
     "say": ["There is a weekday evening batch, 7 to 9 pm, and a weekend batch, Saturday and Sunday 10 am to 1 pm.", "Which one suits you?"],
     "opts": [{"label": "One suits them", "to": "fees"}, {"label": "Timing clash", "to": "think"}]},
    {"id": "fees", "title": "Fees", "stage": 4,
     "say": ["You can start with just ₹6,000 to book your seat.", "The full fee is ₹36,000. The rest can be paid in 3 monthly parts."],
     "tip": "Say the ₹6,000 start first, then the full fee.",
     "opts": [{"label": "Fine", "to": "close"}, {"label": "Too costly", "to": "no"}, {"label": "Will think", "to": "think"}]},
    {"id": "close", "title": "Close", "stage": 5,
     "say": ["Shall I book your seat in the November batch?", "I will send the payment link and the joining steps on WhatsApp."],
     "opts": [{"label": "Joins", "to": "joined"}, {"label": "Send details", "to": "details"}, {"label": "Not now", "to": "think"}]},
    {"id": "joined", "title": "Joined", "stage": 5, "result": "joined",
     "say": ["Great! The payment link is on WhatsApp now.", "Welcome to the batch, {name}!"]},
    {"id": "details", "title": "Wants details", "stage": 5, "result": "interested",
     "say": ["Sure. I am sending the course details and the batch dates on WhatsApp now."]},
    {"id": "think", "title": "Will think", "stage": 5, "result": "will_think",
     "say": ["Sure. I will send the details on WhatsApp.", "Can I call you again in two days?"]},
    {"id": "no", "title": "Not interested", "stage": 5, "result": "not_interested",
     "say": ["No problem. Thank you for your time, {name}."]},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number",
     "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later",
     "say": ["No problem. When can I call you back?"]}
  ]$j$::jsonb;
  -- v6: the longer pitch, and the full fee first (no ₹6,000 start line).
  sales_v6 := jsonb_set(jsonb_set(sales_v7, '{2,say}',
                 '["Our Data Analytics course is 4 months long, with live classes on weekdays or weekends.", "You learn Excel, SQL, Python, statistics and Power BI, and you build 3 real projects with mentors from the industry.", "At the end you get a certificate and help to prepare for interviews."]'::jsonb),
               '{4,say}', '["The fee is ₹36,000.", "You can pay it in 3 parts."]'::jsonb);
  sales_v6 := sales_v6 #- '{4,tip}';
  sales_pb := $j$[
    {"label": "It costs too much", "answer": "I understand. You can start with just ₹6,000 and pay the rest in 3 monthly parts."},
    {"label": "I have no time", "answer": "Many of our students work. The weekend batch is Saturday and Sunday, 10 am to 1 pm, and every class is recorded."},
    {"label": "Will I get a job?", "answer": "We do not promise a job. We help you build 3 projects and prepare for interviews, and we share openings we hear about."},
    {"label": "Send me the details", "answer": "Sure, I am sending them on WhatsApp now. Can I call you after you read them, tomorrow evening?"}
  ]$j$::jsonb;

  adm_v2 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0,
     "say": ["Hello, am I speaking with {name}?"],
     "tip": "Smile before you speak. Speak slowly.",
     "opts": [{"label": "Yes", "to": "intro"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "intro", "title": "Introduction", "stage": 1,
     "say": ["This is {me} from the admissions office of Sunrise Coaching Academy.", "You asked about admission for your child. Are you still looking for a seat this year?"],
     "opts": [{"label": "Yes", "to": "visit"}, {"label": "Joined elsewhere", "to": "elsewhere"}, {"label": "Not this year", "to": "next_year"}]},
    {"id": "visit", "title": "Visit or form", "stage": 3,
     "say": ["Would you like to visit us with your child and meet the teachers?", "We are open Monday to Saturday, 10 am to 6 pm, at Station Road. I can also send the form on WhatsApp."],
     "opts": [{"label": "Book a visit", "to": "booked"}, {"label": "Send the form", "to": "form"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "booked", "title": "Visit booked", "stage": 5, "result": "visit_booked",
     "say": ["Great! Which day suits you?", "I will send the address on WhatsApp. See you soon, {name}."]},
    {"id": "form", "title": "Form sent", "stage": 5, "result": "form_sent",
     "say": ["Sure. I am sending the form on WhatsApp now.", "Call us if you have any question."]},
    {"id": "elsewhere", "title": "Joined elsewhere", "stage": 5, "result": "joined_elsewhere",
     "say": ["Thank you for telling me. All the best to your child, {name}."]},
    {"id": "next_year", "title": "Not this year", "stage": 5, "result": "not_this_year",
     "say": ["No problem. May we call you again next year?"]},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number",
     "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later",
     "say": ["No problem. When can I call you back?"]},
    {"id": "stop", "title": "Do not call again", "stage": 5, "result": "do_not_call",
     "say": ["Sorry for the trouble. We will not call you again.", "Have a good day."]}
  ]$j$::jsonb;
  adm_v1 := jsonb_set(adm_v2, '{2,say}', '["Would you like to visit us and see the place?", "I can also send the admission form on WhatsApp."]'::jsonb);
  adm_pb := $j$[
    {"label": "What is the fee?", "answer": "The fee depends on the course. I will send the fee details with the form on WhatsApp."},
    {"label": "I need to ask my family", "answer": "Of course. When can I call back to talk with them?"},
    {"label": "Is there a bus?", "answer": "Yes, there is a school bus on 6 routes. I will send the routes on WhatsApp."}
  ]$j$::jsonb;

  late_v1 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0,
     "say": ["Hello, am I speaking with {name}?", "This is {me} from Sunrise Coaching Academy."],
     "opts": [{"label": "Yes", "to": "notice"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "notice", "title": "Late fee", "stage": 1,
     "say": ["The term fee was due on 31 October and we have not received it yet.", "From 5 November a late fee of ₹500 is added."],
     "tip": "Be polite. This is information, not a threat.",
     "check": ["Confirm the late fee amount and the date it starts with the principal."],
     "opts": [{"label": "Will pay", "to": "promise"}, {"label": "Already paid", "to": "already"}, {"label": "Cannot pay", "to": "refused"}]},
    {"id": "promise", "title": "Will pay on date", "stage": 5, "result": "will_pay_on",
     "say": ["Thank you. On which date will you pay? I will note it."]},
    {"id": "already", "title": "Says already paid", "stage": 5, "result": "already_paid",
     "say": ["Thank you! I will check this with the office."]},
    {"id": "refused", "title": "Cannot pay", "stage": 5, "result": "refused",
     "say": ["I understand. I will tell the office, and someone will call you."]},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number",
     "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later",
     "say": ["No problem. When can I call you back?"]}
  ]$j$::jsonb;
  late_pb := '[{"label": "Can you waive the late fee?", "answer": "I will ask the office and call you back today."}]'::jsonb;

  -- Library templates: the same steps and pushbacks as library.json. v2 fills the "Check this" marks with the
  -- demo's facts (ways to pay, part payment, waivers, visiting hours, timings, bus, documents) and has no marks.
  -- Overdue fee reminder (fees_overdue): v1 as copied from the library, v2 with the check marks filled in.
  od_v1 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0, "say": ["Hello, am I speaking with {name}?"], "tip": "Smile before you speak. Speak slowly.", "opts": [{"label": "Yes", "to": "intro"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "intro", "title": "Introduction", "stage": 0, "say": ["This is {me} from {institute}.", "I am calling about {student}'s fee.", "Is this a good time to talk for two minutes?"], "opts": [{"label": "Yes", "to": "due"}, {"label": "Not now", "to": "later"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "due", "title": "Fee pending", "stage": 4, "say": ["Our records show that the fee of {amount_due} was due on {due_date}.", "We have not received it yet. Sometimes this gets missed.", "When would you be able to pay?"], "tip": "Speak calmly. Many parents simply forgot.", "opts": [{"label": "Gives a date", "to": "promise"}, {"label": "Already paid", "to": "already"}, {"label": "Has a problem", "to": "problem"}]},
    {"id": "problem", "title": "Has a problem", "stage": 4, "say": ["I understand. Thank you for telling me.", "Would paying a part now, and the rest later, help you?"], "tip": "Listen first. Do not argue. Never talk about the child in a bad way.", "check": ["Write your rule for paying in parts (how many parts, by when, who approves), or remove the second line."], "opts": [{"label": "Gives a date", "to": "promise"}, {"label": "Cannot pay", "to": "refused"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "promise", "title": "Will pay on date", "stage": 5, "result": "will_pay_on", "say": ["Thank you. Please tell me the date and the amount, and I will note it.", "You can pay at the office or online."], "tip": "Repeat the date and the amount back to them.", "check": ["Write every way to pay that your institute accepts (office counter, UPI, bank transfer, cheque) and the office hours."]},
    {"id": "already", "title": "Says already paid", "stage": 5, "result": "already_paid", "say": ["Thank you! I am sorry for the trouble. I will check this with the accounts office.", "If you have the receipt number or the date you paid, please tell me."], "tip": "Write the receipt number or date in the note."},
    {"id": "refused", "title": "Cannot pay now", "stage": 5, "result": "refused", "say": ["I understand. I will tell the office, and they will talk with you.", "Thank you for your time, {name}."], "tip": "Note the reason in their words. Be kind."},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number", "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later", "say": ["No problem. When is a good time to call you back?"], "tip": "Note the day and time they give."},
    {"id": "stop", "title": "Do not call again", "stage": 5, "result": "do_not_call", "say": ["Sorry for the trouble. We will not call you again.", "Have a good day."], "tip": "Do not argue or ask why."}
  ]$j$::jsonb;
  od_pb1 := $j$[
    {"label": "Sorry, I forgot", "answer": "No problem at all, it happens. Which date suits you to pay?"},
    {"label": "Money is tight this month", "answer": "I understand. Tell me a date that works for you, and I will note it down."},
    {"check": ["Write your rule for paying in parts (how many parts, by when, who approves), or remove this answer."], "label": "Can I pay in parts?", "answer": "Let me check the rule for this with the office, and I will tell you."},
    {"check": ["Write who decides on late fee waivers and how the parent hears back, or remove this answer if there is no late fee."], "label": "Can you waive the late fee?", "answer": "I cannot decide that myself. I will pass your request to the office, and they will reply to you."},
    {"label": "Why are you calling again?", "answer": "Sorry for calling again. Our records still show the fee as pending. If you have paid, please tell me the date so we can match it."},
    {"label": "I will pay when I come to school", "answer": "That is fine. Which day will you come? I will note it."}
  ]$j$::jsonb;
  od_v2 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0, "say": ["Hello, am I speaking with {name}?"], "tip": "Smile before you speak. Speak slowly.", "opts": [{"label": "Yes", "to": "intro"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "intro", "title": "Introduction", "stage": 0, "say": ["This is {me} from {institute}.", "I am calling about {student}'s fee.", "Is this a good time to talk for two minutes?"], "opts": [{"label": "Yes", "to": "due"}, {"label": "Not now", "to": "later"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "due", "title": "Fee pending", "stage": 4, "say": ["Our records show that the fee of {amount_due} was due on {due_date}.", "We have not received it yet. Sometimes this gets missed.", "When would you be able to pay?"], "tip": "Speak calmly. Many parents simply forgot.", "opts": [{"label": "Gives a date", "to": "promise"}, {"label": "Already paid", "to": "already"}, {"label": "Has a problem", "to": "problem"}]},
    {"id": "problem", "title": "Has a problem", "stage": 4, "say": ["I understand. Thank you for telling me.", "You can pay half now and the rest by 15 November, with the principal's OK."], "tip": "Listen first. Do not argue. Never talk about the child in a bad way.", "opts": [{"label": "Gives a date", "to": "promise"}, {"label": "Cannot pay", "to": "refused"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "promise", "title": "Will pay on date", "stage": 5, "result": "will_pay_on", "say": ["Thank you. Please tell me the date and the amount, and I will note it.", "You can pay by UPI, by cheque, or at the office from 9 am to 5 pm, Monday to Saturday."], "tip": "Repeat the date and the amount back to them."},
    {"id": "already", "title": "Says already paid", "stage": 5, "result": "already_paid", "say": ["Thank you! I am sorry for the trouble. I will check this with the accounts office.", "If you have the receipt number or the date you paid, please tell me."], "tip": "Write the receipt number or date in the note."},
    {"id": "refused", "title": "Cannot pay now", "stage": 5, "result": "refused", "say": ["I understand. I will tell the office, and they will talk with you.", "Thank you for your time, {name}."], "tip": "Note the reason in their words. Be kind."},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number", "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later", "say": ["No problem. When is a good time to call you back?"], "tip": "Note the day and time they give."},
    {"id": "stop", "title": "Do not call again", "stage": 5, "result": "do_not_call", "say": ["Sorry for the trouble. We will not call you again.", "Have a good day."], "tip": "Do not argue or ask why."}
  ]$j$::jsonb;
  od_pb2 := $j$[
    {"label": "Sorry, I forgot", "answer": "No problem at all, it happens. Which date suits you to pay?"},
    {"label": "Money is tight this month", "answer": "I understand. Tell me a date that works for you, and I will note it down."},
    {"label": "Can I pay in parts?", "answer": "Yes. You can pay half now and the rest by 15 November, with the principal's OK. I will note it."},
    {"label": "Can you waive the late fee?", "answer": "I cannot decide that myself. The principal decides on waivers, and the office will call you back within two days."},
    {"label": "Why are you calling again?", "answer": "Sorry for calling again. Our records still show the fee as pending. If you have paid, please tell me the date so we can match it."},
    {"label": "I will pay when I come to school", "answer": "That is fine. Which day will you come? I will note it."}
  ]$j$::jsonb;
  -- Fee reminder before the due date (fees_reminder_polite): v1 as copied from the library, v2 with the check marks filled in.
  po_v1 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0, "say": ["Hello, am I speaking with {name}?"], "tip": "Smile before you speak. Speak slowly.", "opts": [{"label": "Yes", "to": "intro"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "intro", "title": "Introduction", "stage": 0, "say": ["This is {me} from {institute}.", "I am calling about {student}'s fee.", "Is this a good time to talk for two minutes?"], "opts": [{"label": "Yes", "to": "reminder"}, {"label": "Not now", "to": "later"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "reminder", "title": "Reminder", "stage": 4, "say": ["This is a friendly reminder.", "The fee of {amount_due} is due on {due_date}.", "Will you be able to pay by then?"], "tip": "Say the amount and the date slowly. Do not rush.", "opts": [{"label": "Will pay", "to": "promise"}, {"label": "Already paid", "to": "already"}, {"label": "Needs time", "to": "time"}]},
    {"id": "time", "title": "Needs more time", "stage": 4, "say": ["No problem. Thank you for telling me.", "Which date would be possible for you?"], "tip": "Listen first. Do not argue. Any honest date is fine.", "opts": [{"label": "Gives a date", "to": "promise"}, {"label": "Cannot pay", "to": "refused"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "promise", "title": "Will pay on date", "stage": 5, "result": "will_pay_on", "say": ["Thank you. Please tell me the date, and I will note it.", "You can pay at the office or online."], "tip": "Repeat the date and the amount back to them.", "check": ["Write every way to pay that your institute accepts (office counter, UPI, bank transfer, cheque) and the office hours."]},
    {"id": "already", "title": "Says already paid", "stage": 5, "result": "already_paid", "say": ["Thank you! I will check this with the accounts office.", "If you have the receipt number or the date you paid, please tell me."], "tip": "Write the receipt number or date in the note."},
    {"id": "refused", "title": "Cannot pay now", "stage": 5, "result": "refused", "say": ["I understand. I will tell the office.", "Thank you for your time, {name}."], "tip": "Note the reason in their words. Be kind."},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number", "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later", "say": ["No problem. When is a good time to call you back?"], "tip": "Note the day and time they give."},
    {"id": "stop", "title": "Do not call again", "stage": 5, "result": "do_not_call", "say": ["Sorry for the trouble. We will not call you again.", "Have a good day."], "tip": "Do not argue or ask why."}
  ]$j$::jsonb;
  po_pb1 := $j$[
    {"check": ["Write your rule for paying in parts (how many parts, by when, who approves), or remove this answer."], "label": "Can I pay in parts?", "answer": "Let me check the rule for this with the office, and I will tell you."},
    {"label": "Please tell me the amount again", "answer": "Sure. The amount due is {amount_due}, and the due date is {due_date}."},
    {"check": ["Write every way to pay that your institute accepts (office counter, UPI, bank transfer, cheque) and the office hours."], "label": "Can I pay online?", "answer": "Yes. You can pay online or at the office. I can send the details on WhatsApp."},
    {"check": ["Confirm the office can share a break-up of the fee."], "label": "Why is the fee so high?", "answer": "I understand. I can send you the fee details on WhatsApp, and the accounts office can explain any part of it."},
    {"check": ["Write your late fee rule (amount and the date it starts), or write that there is no late fee."], "label": "Is there a late fee?", "answer": "Let me tell you the rule exactly, so there is no confusion."},
    {"check": ["Say how the receipt is given: printed, on WhatsApp or in the app."], "label": "Will I get a receipt?", "answer": "Yes. The office gives a receipt for every payment."}
  ]$j$::jsonb;
  po_v2 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0, "say": ["Hello, am I speaking with {name}?"], "tip": "Smile before you speak. Speak slowly.", "opts": [{"label": "Yes", "to": "intro"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "intro", "title": "Introduction", "stage": 0, "say": ["This is {me} from {institute}.", "I am calling about {student}'s fee.", "Is this a good time to talk for two minutes?"], "opts": [{"label": "Yes", "to": "reminder"}, {"label": "Not now", "to": "later"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "reminder", "title": "Reminder", "stage": 4, "say": ["This is a friendly reminder.", "The fee of {amount_due} is due on {due_date}.", "Will you be able to pay by then?"], "tip": "Say the amount and the date slowly. Do not rush.", "opts": [{"label": "Will pay", "to": "promise"}, {"label": "Already paid", "to": "already"}, {"label": "Needs time", "to": "time"}]},
    {"id": "time", "title": "Needs more time", "stage": 4, "say": ["No problem. Thank you for telling me.", "Which date would be possible for you?"], "tip": "Listen first. Do not argue. Any honest date is fine.", "opts": [{"label": "Gives a date", "to": "promise"}, {"label": "Cannot pay", "to": "refused"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "promise", "title": "Will pay on date", "stage": 5, "result": "will_pay_on", "say": ["Thank you. Please tell me the date, and I will note it.", "You can pay by UPI, by cheque, or at the office from 9 am to 5 pm, Monday to Saturday."], "tip": "Repeat the date and the amount back to them."},
    {"id": "already", "title": "Says already paid", "stage": 5, "result": "already_paid", "say": ["Thank you! I will check this with the accounts office.", "If you have the receipt number or the date you paid, please tell me."], "tip": "Write the receipt number or date in the note."},
    {"id": "refused", "title": "Cannot pay now", "stage": 5, "result": "refused", "say": ["I understand. I will tell the office.", "Thank you for your time, {name}."], "tip": "Note the reason in their words. Be kind."},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number", "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later", "say": ["No problem. When is a good time to call you back?"], "tip": "Note the day and time they give."},
    {"id": "stop", "title": "Do not call again", "stage": 5, "result": "do_not_call", "say": ["Sorry for the trouble. We will not call you again.", "Have a good day."], "tip": "Do not argue or ask why."}
  ]$j$::jsonb;
  po_pb2 := $j$[
    {"label": "Can I pay in parts?", "answer": "Yes. You can pay half by the due date and the rest by 30 November. I will note it for the office."},
    {"label": "Please tell me the amount again", "answer": "Sure. The amount due is {amount_due}, and the due date is {due_date}."},
    {"label": "Can I pay online?", "answer": "Yes. You can pay by UPI or bank transfer, or by cheque at the office. I can send the details on WhatsApp."},
    {"label": "Why is the fee so high?", "answer": "I understand. I can send you the fee details on WhatsApp, and the accounts office can explain any part of it."},
    {"label": "Is there a late fee?", "answer": "There is no late fee until 15 November. After that, ₹200 is added."},
    {"label": "Will I get a receipt?", "answer": "Yes. The office sends the receipt on WhatsApp within a day of the payment."}
  ]$j$::jsonb;
  -- School admission enquiry follow-up (admission_enquiry_school): v1 as copied from the library, v2 with the check marks filled in.
  a9_v1 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0, "say": ["Hello, am I speaking with {name}?"], "tip": "Smile before you speak. Speak slowly.", "opts": [{"label": "Yes", "to": "intro"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "intro", "title": "Introduction", "stage": 0, "say": ["This is {me} from {institute}.", "Thank you for your enquiry about admission in {class} class.", "Is this a good time to talk for two minutes?"], "opts": [{"label": "Yes", "to": "needs"}, {"label": "Not now", "to": "later"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "needs", "title": "What they need", "stage": 1, "say": ["Are you still looking for a school for your child?", "What matters most to you in a new school?"], "tip": "Listen. Note what matters to them: distance, teachers, fees, board, activities.", "opts": [{"label": "Still looking", "to": "visit"}, {"label": "Not looking now", "to": "not_now"}]},
    {"id": "visit", "title": "Visit or form", "stage": 3, "say": ["The best way to decide is to see the school and meet our teachers.", "Would you like to visit? I can also send the admission form on WhatsApp."], "check": ["Add your visiting days, hours and address, the way callers should say them."], "opts": [{"label": "Book a visit", "to": "booked"}, {"label": "Send the form", "to": "form"}, {"label": "Will think", "to": "later"}]},
    {"id": "booked", "title": "Visit booked", "stage": 5, "result": "visit_booked", "say": ["Great! Which day and time suits you?", "I will send the address and location on WhatsApp. See you soon, {name}."], "tip": "Note the date. Repeat it back."},
    {"id": "form", "title": "Form sent", "stage": 5, "result": "form_sent", "say": ["Sure. I am sending the admission form on WhatsApp now.", "Please call us if you have any question."]},
    {"id": "not_now", "title": "Not looking now", "stage": 5, "result": "not_this_year", "say": ["No problem. Thank you for your time, {name}.", "All the best to your child."], "tip": "If they joined another school, choose Joined elsewhere instead."},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number", "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later", "say": ["No problem. When is a good time to call you back?"], "tip": "Note the day and time they give."},
    {"id": "stop", "title": "Do not call again", "stage": 5, "result": "do_not_call", "say": ["Sorry for the trouble. We will not call you again.", "Have a good day."], "tip": "Do not argue or ask why."}
  ]$j$::jsonb;
  a9_pb1 := $j$[
    {"check": ["Confirm the campaign's board tag is your school's board, or write the board here."], "label": "Which board is the school?", "answer": "We follow the {board} board."},
    {"check": ["Add your school timings by class."], "label": "What are the school timings?", "answer": "Let me tell you the timings for {class} class."},
    {"check": ["Write whether you have a bus and which areas it covers."], "label": "Is there a school bus?", "answer": "Let me tell you about the bus routes. I can also send them on WhatsApp."},
    {"check": ["Write if seats are open. Never say seats are almost full unless it is true."], "label": "Are seats available?", "answer": "Let me check the seats for {class} class with the office and tell you correctly."},
    {"check": ["Write the list of documents, or confirm it is sent with the form."], "label": "What documents are needed?", "answer": "I will send the list of documents with the form on WhatsApp."},
    {"check": ["Write your age rule for each class (mainly Nursery to class 1), or remove this answer."], "label": "What is the age rule?", "answer": "Let me tell you the age rule for {class} class."}
  ]$j$::jsonb;
  a9_v2 := $j$[
    {"id": "open", "title": "Opening", "start": true, "stage": 0, "say": ["Hello, am I speaking with {name}?"], "tip": "Smile before you speak. Speak slowly.", "opts": [{"label": "Yes", "to": "intro"}, {"label": "Wrong person", "to": "wrong"}, {"label": "Busy now", "to": "later"}]},
    {"id": "intro", "title": "Introduction", "stage": 0, "say": ["This is {me} from {institute}.", "Thank you for your enquiry about admission in {class} class.", "Is this a good time to talk for two minutes?"], "opts": [{"label": "Yes", "to": "needs"}, {"label": "Not now", "to": "later"}, {"label": "Stop calling", "to": "stop"}]},
    {"id": "needs", "title": "What they need", "stage": 1, "say": ["Are you still looking for a school for your child?", "What matters most to you in a new school?"], "tip": "Listen. Note what matters to them: distance, teachers, fees, board, activities.", "opts": [{"label": "Still looking", "to": "visit"}, {"label": "Not looking now", "to": "not_now"}]},
    {"id": "visit", "title": "Visit or form", "stage": 3, "say": ["The best way to decide is to see the school and meet our teachers.", "Visits are Monday to Saturday, 10 am to 1 pm, at Station Road.", "Would you like to visit? I can also send the admission form on WhatsApp."], "opts": [{"label": "Book a visit", "to": "booked"}, {"label": "Send the form", "to": "form"}, {"label": "Will think", "to": "later"}]},
    {"id": "booked", "title": "Visit booked", "stage": 5, "result": "visit_booked", "say": ["Great! Which day and time suits you?", "I will send the address and location on WhatsApp. See you soon, {name}."], "tip": "Note the date. Repeat it back."},
    {"id": "form", "title": "Form sent", "stage": 5, "result": "form_sent", "say": ["Sure. I am sending the admission form on WhatsApp now.", "Please call us if you have any question."]},
    {"id": "not_now", "title": "Not looking now", "stage": 5, "result": "not_this_year", "say": ["No problem. Thank you for your time, {name}.", "All the best to your child."], "tip": "If they joined another school, choose Joined elsewhere instead."},
    {"id": "wrong", "title": "Wrong person", "stage": 5, "result": "wrong_number", "say": ["Sorry to trouble you. Have a good day."]},
    {"id": "later", "title": "Call back later", "stage": 5, "result": "call_back_later", "say": ["No problem. When is a good time to call you back?"], "tip": "Note the day and time they give."},
    {"id": "stop", "title": "Do not call again", "stage": 5, "result": "do_not_call", "say": ["Sorry for the trouble. We will not call you again.", "Have a good day."], "tip": "Do not argue or ask why."}
  ]$j$::jsonb;
  a9_pb2 := $j$[
    {"label": "Which board is the school?", "answer": "We follow the {board} board."},
    {"label": "What are the school timings?", "answer": "For {class} class it is 7:30 am to 1:30 pm, Monday to Friday, and 7:30 to 11:30 am on Saturday."},
    {"label": "Is there a school bus?", "answer": "Yes. Our buses cover Kothrud, Karve Nagar, Warje and Bavdhan. I can send the routes on WhatsApp."},
    {"label": "Are seats available?", "answer": "Yes, there are seats open in {class} class this year. The office confirms a seat when the form is in."},
    {"label": "What documents are needed?", "answer": "The birth certificate, the last report card, the transfer certificate and 2 photos. I will send the list on WhatsApp."}
  ]$j$::jsonb;

  insert into public.scripts (id, institute_id, name, created_by, created_at, call_type_id) values
    ((select id from demo_scripts where k = 'fees'),      inst, 'Fees reminder',    owner, pg_temp.ist(today - 62, 40000), t_fees),
    ((select id from demo_scripts where k = 'sales'),     inst, 'Course sales',     owner, pg_temp.ist(today - 45, 40000), t_sale),
    ((select id from demo_scripts where k = 'admission'), inst, 'Admission check',  mgr,   pg_temp.ist(today - 21, 40000), t_adm),
    ((select id from demo_scripts where k = 'late_fee'),  inst, 'Late fee warning', owner, pg_temp.ist(today, 0) + (now() - pg_temp.ist(today, 0)) / 3, t_fees),
    ((select id from demo_scripts where k = 'overdue10'), inst, 'Overdue fees – Class 10', owner, pg_temp.ist(today - 26, 40000), t_fees),
    ((select id from demo_scripts where k = 'polite8'),   inst, 'Term 2 reminder – Class 8', owner, pg_temp.ist(today - 2, 40000), t_fees),
    ((select id from demo_scripts where k = 'adm9'),      inst, 'Class 9 admission enquiry', mgr, pg_temp.ist(today - 5, 38000), t_adm);

  -- Only the newest version of each script is published (one per script).
  insert into public.script_versions (script_id, institute_id, version, steps, pushbacks, change_note, published, created_at, created_by) values
    ((select id from demo_scripts where k = 'fees'), inst, 1, fees_v2, fees_pb - 3, 'First version', false, pg_temp.ist(today - 62, 40000), owner),
    ((select id from demo_scripts where k = 'fees'), inst, 2, fees_v2, fees_pb - 3, 'Ways to pay and office hours', false, pg_temp.ist(today - 56, 41000), owner),
    ((select id from demo_scripts where k = 'fees'), inst, 3, fees_v3, fees_pb, 'Part payment line, "Paying now" choice, ask for a date within 7 days', true, pg_temp.ist(today - 25, 42000), owner),
    ((select id from demo_scripts where k = 'admission'), inst, 1, adm_v1, adm_pb, 'First version', false, pg_temp.ist(today - 21, 40000), mgr),
    ((select id from demo_scripts where k = 'admission'), inst, 2, adm_v2, adm_pb, 'Visiting hours and address', true, pg_temp.ist(today - 15, 40000), mgr),
    ((select id from demo_scripts where k = 'late_fee'), inst, 1, late_v1, late_pb, 'Draft', false, pg_temp.ist(today, 0) + (now() - pg_temp.ist(today, 0)) / 3, owner),
    ((select id from demo_scripts where k = 'overdue10'), inst, 1, od_v1, od_pb1, 'From the library: Overdue fee reminder', false, pg_temp.ist(today - 26, 40000), owner),
    ((select id from demo_scripts where k = 'overdue10'), inst, 2, od_v2, od_pb2, 'Filled in: ways to pay, half now and the rest by 15 November, waivers', true, pg_temp.ist(today - 25, 41000), owner),
    ((select id from demo_scripts where k = 'polite8'), inst, 1, po_v1, po_pb1, 'From the library: Fee reminder before the due date', false, pg_temp.ist(today - 2, 40000), owner),
    ((select id from demo_scripts where k = 'polite8'), inst, 2, po_v2, po_pb2, 'Filled in: ways to pay, parts, late fee, receipts', true, pg_temp.ist(today - 1, 39000), owner),
    ((select id from demo_scripts where k = 'adm9'), inst, 1, a9_v1, a9_pb1, 'From the library: School admission enquiry follow-up', false, pg_temp.ist(today - 5, 38000), mgr),
    ((select id from demo_scripts where k = 'adm9'), inst, 2, a9_v2, a9_pb2, 'Filled in: visiting hours, timings, bus, seats, documents; no age rule for Class 9', true, pg_temp.ist(today - 5, 41000), mgr);
  for i in 1 .. 5 loop
    insert into public.script_versions (script_id, institute_id, version, steps, pushbacks, change_note, published, created_at, created_by)
      values ((select id from demo_scripts where k = 'sales'), inst, i, sales_v6, sales_pb,
              (array['First version', 'Shorter opening', 'Weekend batch times', 'Added the projects line', 'Pushback answers for price and jobs'])[i],
              false, pg_temp.ist(today - 45 + (i - 1) * 6, 40000), owner);
  end loop;
  insert into public.script_versions (script_id, institute_id, version, steps, pushbacks, change_note, published, created_at, created_by) values
    ((select id from demo_scripts where k = 'sales'), inst, 6, sales_v6, sales_pb, 'Questions step before the pitch', false, pg_temp.ist(today - 16, 40000), owner),
    ((select id from demo_scripts where k = 'sales'), inst, 7, sales_v7, sales_pb, 'Shorter pitch and the ₹6,000 start line', true, pg_temp.ist(today - 9, 36000), owner);
end $$;

-- ---------- 6b. the fee ledger: students, fee items, the opening balance import ----------
-- Class 10 (CBSE, 240: the Oct fees parents), Class 9 (ICSE, 150: the Sept fees parents) and Class 8 (CBSE,
-- 180), academic year 2026-27. Kavita imported them 58 days ago with Term 1 as "paid so far" (an opening
-- balance; a few still owe part of Term 1). Term 2 is due 40 days ago (Class 9), 15 days ago (Class 10) and in
-- 6 days (Class 8). Some students take the school bus (a bus fee per term). Payments after the import come
-- from the calls (section 9b) and, for Class 8, from parents paying early. Everything here is a formula of the
-- student's number, so the ledger is the same on every load (dates shifted to today).
-- Fees basics: the fees come from three fee plans (Class 8 CBSE, Class 9 ICSE, Class 10 CBSE: Term 1 and Term 2
-- tuition for everyone, the bus fee per term for students who use the bus), each fee item linked to its plan
-- item, so the Fee plan screen shows nothing left to apply and applying it adds nothing. A few discounts: the
-- Class 8 twins' second child has the plan's "Sibling 10% on tuition"; three teachers' children (Class 9 and 10)
-- have "Staff child 50% on tuition", approved by the owner. Opening balances pay Term 1 net of the discount.

create temp table demo_st (
  cls       int not null,
  i         int not null,
  id        uuid not null default gen_random_uuid(),
  adm_date  date not null,   -- when the parent filled the admission form ({source_date} of fees leads)
  t2_due    date not null,
  primary key (cls, i)
) on commit drop;

do $$
declare
  inst    uuid := '5a1e0000-0000-4000-8000-000000000001';
  today   date := (select v::date from demo_ctx where k = 'today');
  kavita  uuid := '5a1e0000-0000-4000-8000-000000000108';
  imp_t   timestamptz := pg_temp.ist((select v::date from demo_ctx where k = 'today') - 58, 11 * 3600 + 1500);
  pf  text[] := (select a from demo_names where k = 'pf');
  sn  text[] := (select a from demo_names where k = 'sn');
  kid text[] := (select a from demo_names where k = 'kid');
  seq int := 0;
  c   int;
  i   int;
  f   int;
  n   int;
  t1  numeric; t2 numeric; bus numeric; arr numeric;
  has_bus boolean;
  t1_due date := today - 130;
  t2_due date;
  yr  int;
  st  demo_st;
  nm  text; par text; ph text; sec text;
  pd  date;
  md  text;
  pct numeric;
  gid uuid;
  plan uuid;
  sib_rule uuid := '5a1e0000-0000-4000-8000-000000000511';
begin
  perform setseed(current_setting('demo.seed')::float8 / 2);
  -- The three fee plans, made by Kavita just before the import.
  insert into public.fee_plans (id, institute_id, academic_year, class_label, board, auto_apply, created_by, created_at, updated_at) values
    ('5a1e0000-0000-4000-8000-000000000501', inst, '2026-27', '8th', 'CBSE', true, kavita, imp_t - interval '25 minutes', imp_t - interval '25 minutes'),
    ('5a1e0000-0000-4000-8000-000000000502', inst, '2026-27', '9th', 'ICSE', true, kavita, imp_t - interval '20 minutes', imp_t - interval '20 minutes'),
    ('5a1e0000-0000-4000-8000-000000000503', inst, '2026-27', '10th', 'CBSE', true, kavita, imp_t - interval '15 minutes', imp_t - interval '15 minutes');
  insert into public.fee_plan_items (institute_id, plan_id, head, amount, due_date, who, sort_order, created_at, updated_at)
  select inst, p.id, x.head, x.amt, x.due, x.who, x.ord, imp_t - interval '15 minutes', imp_t - interval '15 minutes'
  from (values (8, '5a1e0000-0000-4000-8000-000000000501'::uuid, 14000, 5500, today + 6),
               (9, '5a1e0000-0000-4000-8000-000000000502'::uuid, 15000, 5500, today - 40),
               (10, '5a1e0000-0000-4000-8000-000000000503'::uuid, 18000, 6000, today - 15)) p(c, id, tu, bu, due2)
  cross join lateral (values ('Term 1 tuition', p.tu, t1_due, 'all', 1), ('Term 2 tuition', p.tu, p.due2, 'all', 2),
                             ('Bus fee – Term 1', p.bu, t1_due, 'bus', 3), ('Bus fee – Term 2', p.bu, p.due2, 'bus', 4)) x(head, amt, due, who, ord);
  insert into public.fee_plan_rules (id, institute_id, plan_id, reason, percent, heads, created_at)
    values (sib_rule, inst, '5a1e0000-0000-4000-8000-000000000501', 'sibling', 10,
            array['Term 1 tuition', 'Term 2 tuition'], imp_t - interval '15 minutes');
  for c in select unnest(array[10, 9, 8]) loop
    plan := case c when 8 then '5a1e0000-0000-4000-8000-000000000501'::uuid when 9 then '5a1e0000-0000-4000-8000-000000000502'::uuid
                   else '5a1e0000-0000-4000-8000-000000000503'::uuid end;
    n := case c when 10 then 240 when 9 then 150 else 180 end;
    t1 := case c when 10 then 18000 when 9 then 15000 else 14000 end;
    t2 := t1;
    bus := case c when 10 then 6000 else 5500 end;
    t2_due := case c when 10 then today - 15 when 9 then today - 40 else today + 6 end;
    for i in 1 .. n loop
      seq := seq + 1;
      -- Class 8 twins share the parent and the phone (one lead for both in a fees campaign from the ledger).
      f := case when c = 8 and i in (23, 67, 143) then i - 1 else i end;
      if c = 10 then
        nm := kid[1 + (i * 5) % 31] || ' ' || sn[1 + (i * 11) % 31];
        par := pf[1 + (i * 7) % 41] || ' ' || sn[1 + (i * 11) % 31];
        ph := '+91' || (9999010000 + i)::text;
        sec := case when i % 2 = 0 then 'A' else 'B' end;
        yr := 2018 + (i * 7) % 5;
        has_bus := i % 5 = 2;
        arr := case when i % 13 = 7 then 6000 else 0 end;
      elsif c = 9 then
        nm := kid[1 + (i * 3) % 31] || ' ' || sn[1 + (i * 5) % 31];
        par := pf[1 + (i * 13) % 41] || ' ' || sn[1 + (i * 5) % 31];
        ph := '+91' || (9999020000 + i)::text;
        sec := case when i % 2 = 0 then 'A' else 'B' end;
        yr := 2019 + (i * 3) % 5;
        has_bus := i % 6 = 1;
        arr := case when i % 17 = 3 then 5000 else 0 end;
      else
        nm := kid[1 + (i * 7) % 31] || ' ' || sn[1 + (f * 17) % 31];
        par := pf[1 + (f * 11) % 41] || ' ' || sn[1 + (f * 17) % 31];
        ph := case when i in (98, 150) then null else '+91' || (9999060000 + f)::text end;   -- two with no phone
        sec := (array['A', 'B', 'C'])[1 + i % 3];
        yr := 2020 + (f * 11) % 5;
        has_bus := i % 4 = 3;
        arr := case when i % 15 = 4 then 4000 else 0 end;
      end if;
      insert into demo_st (cls, i, adm_date, t2_due)
        values (c, i, make_date(yr, 4, 1) + (i * 13) % 70, t2_due)
        returning * into st;
      insert into public.students (id, institute_id, admission_no, name, class_label, section, board, academic_year,
                                   parent_name, phone, status, source, created_by, created_at, updated_at, uses_bus)
        values (st.id, inst, 'SCA/' || yr || '/' || lpad((300 + seq)::text, 4, '0'), nm, c || 'th', sec,
                case when c = 9 then 'ICSE' else 'CBSE' end, '2026-27', par, ph,
                case when c = 8 and i in (45, 160) then 'left' else 'active' end, 'import', kavita, imp_t, imp_t, has_bus);
      insert into public.fee_items (institute_id, student_id, head, amount, due_date, academic_year, created_by, created_at, plan_item_id)
        select inst, st.id, x.head, x.amt, x.due, '2026-27', kavita, imp_t,
               (select pi.id from public.fee_plan_items pi where pi.plan_id = plan and pi.head = x.head)
        from (values ('Term 1 tuition', t1, t1_due, true), ('Term 2 tuition', t2, t2_due, true),
                     ('Bus fee – Term 1', bus, t1_due, has_bus), ('Bus fee – Term 2', bus, t2_due, has_bus)) x(head, amt, due, keep)
        where x.keep;
      -- Discounts on tuition: the twins' second child (the plan's sibling rule) and three teachers' children.
      pct := case when c = 8 and i in (23, 67, 143) then 10 when (c = 10 and i in (6, 18)) or (c = 9 and i = 8) then 50 else 0 end;
      if pct > 0 then
        gid := gen_random_uuid();
        insert into public.discounts (institute_id, student_id, fee_item_id, grant_id, amount, percent, scope, reason, note,
                                      approved_by, plan_rule_id, created_by, created_at)
          select inst, st.id, fi.id, gid, round(fi.amount * pct / 100, 2), pct, 'fees',
                 case when c = 8 then 'sibling' else 'staff_child' end,
                 case when c = 8 then 'Twin: the elder one pays the full fee' else 'Mother teaches Class 6' end,
                 case when c = 8 then 'Kavita Joshi' else 'Anita Sharma (owner)' end,
                 case when c = 8 then sib_rule end, kavita, imp_t
          from public.fee_items fi
          where fi.student_id = st.id and fi.head in ('Term 1 tuition', 'Term 2 tuition');
      end if;
      -- The opening balance: Term 1 (and its bus fee) paid before the import, less what some still owe.
      insert into public.payments (institute_id, student_id, amount, paid_on, mode, note, recorded_by, created_at, opening)
        values (inst, st.id, t1 + case when has_bus then bus else 0 end - arr - round(t1 * pct / 100, 2), today - 58, 'other',
                'Opening balance import', kavita, imp_t, true);

      -- Paid early, after the import (before any call): half of Term 2 for every 4th Class 10 parent (dated
      -- the week before the Oct fees calls began) and every 5th Class 9 parent; Class 8 parents pay Term 2 in
      -- full in the last three weeks (every 4th), or ₹7,000 of it (every 9th of the others).
      pd := null;
      if c = 10 and i % 4 = 0 then
        pd := today - 25 - i % 12;
        perform pg_temp.add_payment(st.id, 9000, pd, pg_temp.pay_mode(), null, pg_temp.ist(pd, 10 * 3600 + (i * 977) % 27000));
      elsif c = 9 and i % 5 = 0 then
        pd := today - 57 + i % 4;
        perform pg_temp.add_payment(st.id, 7500, pd, pg_temp.pay_mode(), null, pg_temp.ist(pd, 10 * 3600 + (i * 977) % 27000));
      elsif c = 8 and i % 4 = 1 then
        pd := today - 2 - (i * 7) % 19;
        md := case when i = 33 then 'cheque' else pg_temp.pay_mode() end;   -- this cheque bounces (9b)
        perform pg_temp.add_payment(st.id, t2 + case when has_bus then bus else 0 end, pd, md,
                                    case when md = 'cheque' then 'Given at the office by the father' end,
                                    pg_temp.ist(pd, 10 * 3600 + (i * 977) % 27000));
      elsif c = 8 and i % 9 = 0 then
        pd := today - 1 - (i * 5) % 14;
        perform pg_temp.add_payment(st.id, 7000, pd, pg_temp.pay_mode(), 'Rest by 30 November',
                                    pg_temp.ist(pd, 10 * 3600 + (i * 977) % 27000));
      end if;
    end loop;
  end loop;
end $$;

-- ---------- 7. campaigns and leads ----------

create temp table demo_camps (
  id          uuid primary key,
  k           text not null unique,     -- oct / sales / adm / sept / ptm / adm9 / c8
  kind        text not null,            -- fees / sales / admission / event
  script_k    text,
  version     int,                      -- the script version calls use (sales: see the test)
  first_day   int,                      -- days before today the calling starts
  last_day    int,                      -- days before today the calling ends (0 = today)
  forget_quota int not null default 0,  -- promises the callers never call back (broken, still promised)
  forgot      int not null default 0,
  test_id     uuid,
  test_start  timestamptz,
  arm_n       int not null default 0
) on commit drop;

insert into demo_camps (id, k, kind, script_k, version, first_day, last_day, forget_quota) values
  ('5a1e0000-0000-4000-8000-000000000201', 'oct',   'fees',      'overdue10', 2, 23, 0, 14),
  ('5a1e0000-0000-4000-8000-000000000202', 'sales', 'sales',     'sales',     6, 13, 0, 0),
  ('5a1e0000-0000-4000-8000-000000000203', 'adm',   'admission', 'admission', 2, 14, 0, 0),
  ('5a1e0000-0000-4000-8000-000000000204', 'sept',  'fees',      'fees',      2, 53, 24, 0),
  ('5a1e0000-0000-4000-8000-000000000205', 'ptm',   'event',     null,        null, null, null, 0),
  ('5a1e0000-0000-4000-8000-000000000207', 'adm9',  'admission', 'adm9',      2, null, null, 0);

-- Sim state per lead (not stored in the app).
create temp table demo_lx (
  lead_id        uuid primary key,
  camp           text not null,
  cls            text,
  dead           boolean not null default false,  -- hardly ever picks up
  forgotten      boolean not null default false,
  forget_checked boolean not null default true,
  promise_away   int,
  arm            text,
  picked         int not null default 0,
  visit          boolean not null default false
) on commit drop;

do $$
declare
  inst  uuid := '5a1e0000-0000-4000-8000-000000000001';
  today date := (now() at time zone 'Asia/Kolkata')::date;
  owner uuid := '5a1e0000-0000-4000-8000-000000000101';
  mgr   uuid := '5a1e0000-0000-4000-8000-000000000102';
  ravi  uuid := '5a1e0000-0000-4000-8000-000000000103';
  priya uuid := '5a1e0000-0000-4000-8000-000000000104';
  neha  uuid := '5a1e0000-0000-4000-8000-000000000105';
  amit  uuid := '5a1e0000-0000-4000-8000-000000000106';
  sana  uuid := '5a1e0000-0000-4000-8000-000000000107';
  c_oct  uuid := '5a1e0000-0000-4000-8000-000000000201';
  c_sale uuid := '5a1e0000-0000-4000-8000-000000000202';
  c_adm  uuid := '5a1e0000-0000-4000-8000-000000000203';
  c_sept uuid := '5a1e0000-0000-4000-8000-000000000204';
  c_ptm  uuid := '5a1e0000-0000-4000-8000-000000000205';
  c_adm9 uuid := '5a1e0000-0000-4000-8000-000000000207';
  pf    text[] := (select a from demo_names where k = 'pf');
  sn    text[] := (select a from demo_names where k = 'sn');
  kid   text[] := (select a from demo_names where k = 'kid');
  adult text[] := (select a from demo_names where k = 'adult');
  t_fees uuid := (select id from public.call_types where key = 'fees' and institute_id is null);
  t_adm  uuid := (select id from public.call_types where key = 'admission' and institute_id is null);
begin
  -- Every campaign is open to all callers (Phase A.2) and tagged by class and board where it has one. The old
  -- member rows stay: they only say who the campaign was first shared with.
  insert into public.campaigns (id, institute_id, name, call_type_id, script_id, start_date, end_date, status,
                                daily_target, share_mode, call_hours, created_by, created_at, goal,
                                open_to_all, class_label, board) values
    (c_oct, inst, 'Oct fees – Class 10', t_fees,
     (select id from demo_scripts where k = 'overdue10'), today - 23, today + 7, 'running', 60, 'equal', null, owner,
     pg_temp.ist(today - 24, 39000), null, true, '10th', 'CBSE'),
    (c_sale, inst, 'Course sales – Data Analytics', (select id from public.call_types where key = 'sales' and institute_id is null),
     (select id from demo_scripts where k = 'sales'), today - 13, today + 18, 'running', 80, 'equal', null, owner,
     pg_temp.ist(today - 14, 39000), 100, true, null, null),
    (c_adm, inst, 'Admission follow-up', t_adm,
     (select id from demo_scripts where k = 'admission'), today - 14, null, 'running', 35, 'equal', null, mgr,
     pg_temp.ist(today - 15, 39000), 70, true, null, null),
    (c_sept, inst, 'Sept fees – Class 9', t_fees,
     (select id from demo_scripts where k = 'fees'), today - 53, today - 24, 'running', 40, 'equal', null, owner,
     pg_temp.ist(today - 54, 39000), null, true, '9th', 'ICSE'),
    (c_ptm, inst, 'PTM reminder – Nov', (select id from public.call_types where key = 'event' and institute_id is null),
     null, today + 8, today + 12, 'draft', null, 'equal', null, mgr, now() - interval '3 hours', null, true, '10th', 'CBSE'),
    -- New this week: enquiries for Class 9 (ICSE) admission, nobody attached: callers take them from the pool.
    (c_adm9, inst, 'Class 9 admission enquiries', t_adm,
     (select id from demo_scripts where k = 'adm9'), today - 3, today + 25, 'running', 25, 'next_free', null, mgr,
     pg_temp.ist(today - 4, 41500), 20, true, '9th', 'ICSE');

  insert into public.campaign_members (campaign_id, seat_id, institute_id, added_at) values
    (c_oct, ravi, inst, pg_temp.ist(today - 24, 40000)), (c_oct, amit, inst, pg_temp.ist(today - 24, 40000)),
    (c_sale, priya, inst, pg_temp.ist(today - 14, 40000)), (c_sale, neha, inst, pg_temp.ist(today - 14, 40000)),
    (c_adm, sana, inst, pg_temp.ist(today - 15, 40000)),
    (c_sept, ravi, inst, pg_temp.ist(today - 54, 40000));

  -- Oct fees: 240 parents of Class 10 (half 10-A, half 10-B), shared equally between Ravi and Amit. Each lead is
  -- the student's parent; amount_due starts as the balance due for Term 2 (section 9b sets today's balance).
  insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, assigned_seat_id, created_at, student_id)
  select inst, c_oct, s.parent_name, s.phone,
         jsonb_build_object('student', s.name, 'class', '10-' || s.section, 'section', s.section, 'board', s.board,
                            'admission_no', s.admission_no, 'source', 'your child''s admission form',
                            'source_date', pg_temp.say_date(st.adm_date), 'due_date', pg_temp.say_date(st.t2_due)),
         b.balance_due_now,
         case when st.i % 2 = 1 then ravi else amit end,
         pg_temp.ist(today - 24, 40000) + st.i * interval '1 microsecond', s.id
  from demo_st st
  join public.students s on s.id = st.id
  cross join lateral public.student_balance_rows(inst, s.id, st.t2_due) b
  where st.cls = 10;

  -- Course sales: 420 people who asked about the Data Analytics course, Priya and Neha.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, assigned_seat_id, created_at)
  select inst, c_sale, adult[1 + (i * 7) % 31] || ' ' || sn[1 + (i * 13) % 31],
         '+91' || (9999030000 + i)::text,
         jsonb_build_object('city', (array['Pune', 'Mumbai', 'Nagpur', 'Nashik', 'Thane', 'Aurangabad'])[1 + i % 6],
                            'course', 'Data Analytics',
                            'source', (array['our Instagram ad', 'the enquiry form on our website', 'a friend who studies with us',
                                             'our free career webinar', 'our Google ad'])[1 + (i * 3) % 5],
                            'source_date', pg_temp.say_date(today - 15 - (i * 7) % 30),
                            'background', (array['B.Com final year', 'Works in sales', 'BCA graduate', 'Bank clerk',
                                                 'MBA student', 'Teacher', 'Works in accounts'])[1 + (i * 5) % 7]),
         case when i % 2 = 1 then priya else neha end,
         pg_temp.ist(today - 14, 40000) + i * interval '1 microsecond'
  from generate_series(1, 420) i;

  -- Admission follow-up: 150 enquiries, Sana.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, assigned_seat_id, created_at)
  select inst, c_adm, pf[1 + (i * 3) % 41] || ' ' || sn[1 + (i * 7) % 31],
         '+91' || (9999040000 + i)::text,
         jsonb_build_object('student', kid[1 + (i * 7) % 31],
                            'course', (array['Class 11 Science', 'Class 11 Commerce', 'JEE Foundation', 'NEET 2-year'])[1 + i % 4],
                            'source', (array['your visit to our office', 'the enquiry form on our website', 'a call to our office',
                                             'our career seminar at the city library'])[1 + (i * 3) % 4],
                            'source_date', pg_temp.say_date(today - 16 - (i * 5) % 25)),
         sana, pg_temp.ist(today - 15, 40000) + i * interval '1 microsecond'
  from generate_series(1, 150) i;

  -- Sept fees: 150 parents of Class 9, Ravi (closed at the end). amount_due starts as the Term 2 balance.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, assigned_seat_id, created_at, student_id)
  select inst, c_sept, s.parent_name, s.phone,
         jsonb_build_object('student', s.name, 'class', '9-' || s.section, 'section', s.section, 'board', s.board,
                            'admission_no', s.admission_no, 'source', 'your child''s admission form',
                            'source_date', pg_temp.say_date(st.adm_date), 'due_date', pg_temp.say_date(st.t2_due)),
         b.balance_due_now, ravi,
         pg_temp.ist(today - 54, 40000) + st.i * interval '1 microsecond', s.id
  from demo_st st
  join public.students s on s.id = st.id
  cross join lateral public.student_balance_rows(inst, s.id, st.t2_due) b
  where st.cls = 9;

  -- PTM reminder (draft): the first 120 Class 10 parents again, not shared yet.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, created_at, student_id)
  select inst, c_ptm, l.name, l.phone, l.extra - 'due_date',
         now() - interval '3 hours' + row_number() over (order by l.created_at) * interval '1 microsecond', l.student_id
  from public.leads l where l.campaign_id = c_oct
  order by l.created_at limit 120;

  -- Class 9 admission enquiries: 64 parents, in the pool (nobody called yet).
  insert into public.leads (institute_id, campaign_id, name, phone, extra, created_at)
  select inst, c_adm9, pf[1 + (i * 17) % 41] || ' ' || sn[1 + (i * 19) % 31],
         '+91' || (9999050000 + i)::text,
         jsonb_build_object('student', kid[1 + (i * 11) % 31], 'class', '9th', 'board', 'ICSE',
                            'current school', (array['St. Mary''s High School', 'City Public School', 'New English School',
                                                     'Green Valley School'])[1 + (i * 3) % 4],
                            'source', (array['the enquiry form on our website', 'our admission fair at Phoenix Mall',
                                             'a call to our office', 'our admission fair at Phoenix Mall',
                                             'your reply to our newspaper ad'])[1 + i % 5],
                            'source_date', pg_temp.say_date(today - 3 - (i * 7) % 10)),
         pg_temp.ist(today - 4, 41800) + i * interval '1 microsecond'
  from generate_series(1, 64) i;

  insert into demo_lx (lead_id, camp, cls, dead)
  select l.id, k.k, l.extra ->> 'class', (row_number() over (partition by l.campaign_id order by l.created_at)) % 19 = 0
  from public.leads l join demo_camps k on k.id = l.campaign_id
  where l.institute_id = inst;
end $$;

-- ---------- 8. one call ----------

-- Inserts one call_outcomes row (the same fields the caller page saves through save_call_result).
create function pg_temp.add_call(p_seat uuid, p_lead uuid, p_at timestamptz, p_key text, p_secs int,
  p_script uuid, p_ver int, p_reached text, p_steps jsonb, p_date date, p_amount numeric, p_reason text,
  p_note text, p_loss text, p_stage text, p_obj text)
returns void language sql as $$
  insert into public.call_outcomes (institute_id, seat_id, client_record_id, script_id, script_version, script_step,
      objection, dialled_at, connected_seconds, uploaded_at, loss_reason, stage_reached, lead_id, result_key,
      promised_date, amount, result_reason, step_times, reached_step, note)
  values ('5a1e0000-0000-4000-8000-000000000001', p_seat, 'demo-' || gen_random_uuid(), p_script::text, p_ver,
          p_reached, p_obj, p_at, p_secs, p_at + make_interval(secs => coalesce(p_secs, 0) + 40), p_loss, p_stage, p_lead,
          p_key, p_date, p_amount, p_reason, p_steps, p_reached, p_note)
$$;

-- Step times of a picked-up call up to the furthest step reached: { step: seconds }, and the total talk time.
create function pg_temp.step_times(p_kind text, p_ver int, p_reached text, p_who text, p_skip boolean,
                                   out steps jsonb, out secs int)
language plpgsql as $$
declare
  path  text[];
  base  int[];
  i     int;
  s     int;
begin
  if p_kind = 'fees' then
    path := case p_reached when 'open' then array['open'] when 'reminder' then array['open', 'reminder']
                           when 'when' then array['open', 'reminder', 'when']
                           else array['open', 'reminder', 'problem'] end;
  elsif p_kind = 'sales' then
    path := (array['open', 'questions', 'pitch', 'timings', 'fees', 'close'])[1 : array_position(
              array['open', 'questions', 'pitch', 'timings', 'fees', 'close'], p_reached)];
    if p_skip then path := array_remove(path, 'questions'); end if;
  else
    path := (array['open', 'intro', 'visit'])[1 : array_position(array['open', 'intro', 'visit'], p_reached)];
  end if;
  steps := '{}'::jsonb;
  secs := 25 + floor(random() * 50)::int;   -- the ending
  for i in 1 .. coalesce(array_length(path, 1), 0) loop
    s := case path[i]
           when 'open' then case when p_who = 'amit' then 62 when p_who = 'ravi' then 21 else 20 end
           when 'reminder' then 55 when 'when' then 75 when 'problem' then 95
           when 'questions' then 80 when 'pitch' then case when p_ver = 6 then 150 else 105 end
           when 'timings' then 45 when 'fees' then 72 when 'close' then 64
           when 'intro' then 60 when 'visit' then 120 else 30 end;
    s := greatest(5, round(s * (0.7 + random() * 0.6))::int);
    steps := steps || jsonb_build_object(path[i], s);
    secs := secs + s;
  end loop;
end $$;

-- One call by p_who in campaign p_camp at p_t, like the caller page would make it: the next due callback or
-- promise of the caller first, else (when p_allow_new) the next new lead. p_force: the result to save (null =
-- decided here). Saves the call and moves the lead like save_call_result. Returns 'due', 'new' or null (no lead).
create function pg_temp.sim_call(p_camp text, p_who text, p_t timestamptz, p_force text, p_allow_new boolean)
returns text language plpgsql as $$
declare
  c       demo_camps;
  x       demo_lx;
  l       public.leads;
  s       uuid := (select seat from demo_people where who = p_who);
  sid     uuid;
  today   date := (select v::date from demo_ctx where k = 'today');
  d       date := (p_t at time zone 'Asia/Kolkata')::date;
  h       int := extract(hour from p_t at time zone 'Asia/Kolkata')::int;
  dow     int := extract(isodow from p_t at time zone 'Asia/Kolkata')::int;
  src     text := 'due';
  v_picked boolean;
  res     text;
  reached text;
  skip    boolean := false;
  v_steps jsonb;
  v_secs  int;
  v_date  date;
  v_amt   numeric;
  v_rsn   text;
  v_note  text;
  v_loss  text;
  v_stage text;
  v_obj   text;
  v_next  timestamptz;
  v_ver   int;
  v_arm   text;
  away    int;
  kp      numeric;
  jp      numeric;
  r       numeric;
  needs_date boolean;
  v_kept  boolean;
begin
  select * into c from demo_camps where k = p_camp;
  sid := (select id from demo_scripts where k = c.script_k);

  -- The caller's next due lead. A promise the caller never calls back stays broken (forget quota).
  loop
    select l2.* into l from public.leads l2 join demo_lx x2 on x2.lead_id = l2.id
     where l2.campaign_id = c.id and l2.assigned_seat_id = s and l2.status in ('callback', 'promised')
       and not l2.do_not_call and l2.next_call_at <= p_t and not x2.forgotten
       and not (d = today and l2.status = 'promised' and l2.promised_date = today)
     order by l2.next_call_at, l2.created_at
     limit 1;
    exit when l.id is null;
    select * into x from demo_lx where lead_id = l.id;
    if l.status = 'promised' and l.promised_date < today and not x.forget_checked then
      update demo_lx set forget_checked = true where lead_id = l.id;
      r := case p_who when 'amit' then 0.6 else 0.22 end
           * case when x.cls = '10-B' then 1.8 else 1 end
           * case when x.promise_away >= 8 then 2.2 else 0.25 end;
      if c.forgot < c.forget_quota and random() < r then
        update demo_lx set forgotten = true where lead_id = l.id;
        update demo_camps set forgot = forgot + 1 where k = p_camp;
        c.forgot := c.forgot + 1;
        l := null;
        continue;
      end if;
    end if;
    exit;
  end loop;

  if l.id is null then
    if not p_allow_new then return null; end if;
    select l2.* into l from public.leads l2
     where l2.campaign_id = c.id and l2.assigned_seat_id = s and l2.status = 'new' and not l2.do_not_call
     order by l2.created_at limit 1;
    if l.id is null and p_force is not null then
      -- Today's fixed calls: no new lead left, so the caller rings an open lead before its time.
      select l2.* into l from public.leads l2 join demo_lx x2 on x2.lead_id = l2.id
       where l2.campaign_id = c.id and l2.assigned_seat_id = s and l2.status in ('callback', 'promised')
         and not l2.do_not_call and not x2.forgotten and l2.promised_date is distinct from today
       order by l2.next_call_at, l2.created_at limit 1;
    end if;
    if l.id is null then return null; end if;
    select * into x from demo_lx where lead_id = l.id;
    src := 'new';
  end if;

  -- Script version: the sales test splits leads between v6 (arm a) and v7 (arm b) from its start.
  v_ver := c.version;
  if c.kind = 'sales' then
    if p_t >= c.test_start then
      if x.arm is null then
        v_arm := case when c.arm_n % 2 = 0 then 'a' else 'b' end;
        update demo_camps set arm_n = arm_n + 1 where k = p_camp;
        update demo_lx set arm = v_arm where lead_id = l.id;
        x.arm := v_arm;
        insert into public.script_test_leads (test_id, lead_id, arm, assigned_at) values (c.test_id, l.id, v_arm, p_t);
      end if;
      v_ver := case when x.arm = 'a' then 6 else 7 end;
    else
      v_ver := 6;
    end if;
  end if;

  -- A promise called on or before its date: whether the parent keeps it (then they pick up to say so).
  if p_force is null and c.kind = 'fees' and l.status = 'promised' and l.promised_date is not null
     and d <= l.promised_date then
    kp := case when x.promise_away <= 3 then 0.84 when x.promise_away <= 7 then 0.66
               when x.promise_away <= 14 then 0.50 else 0.32 end
          * case when x.cls = '10-B' then 0.85 else 1 end;
    v_kept := random() < kp;
  end if;

  if p_force is not null then
    v_picked := p_force not in ('no_answer', 'busy');
  elsif v_kept then
    -- A parent who has paid is happy to pick up (a missed call is tried again 2 hours later, same day).
    v_picked := random() < least(0.95, pg_temp.pick_p(h, dow) * 2.0);
  else
    v_picked := random() < pg_temp.pick_p(h, dow) * case when x.dead then 0.15 when x.picked > 0 then 1.15 else 1 end;
  end if;

  if not v_picked then
    res := coalesce(p_force, case when random() < 0.72 then 'no_answer' else 'busy' end);
    perform pg_temp.add_call(s, l.id, p_t, res, 0, sid, v_ver, null, null, null, null, null, null, null, null, null);
    update public.leads set status = case when status = 'new' then 'callback' else status end,
                            next_call_at = p_t + case when res = 'busy' then interval '30 minutes' else interval '2 hours' end
     where id = l.id;
    return src;
  end if;

  update demo_lx set picked = picked + 1 where lead_id = l.id;
  res := p_force;

  -- ---- what the person said ----
  if c.kind = 'fees' then
    if res is null then
      if l.status = 'promised' and l.promised_date is not null then
        if d <= l.promised_date then
          if v_kept then
            res := (array['paid', 'already_paid', 'paid_part'])[pg_temp.pick(array[78, 12, 10])];
          else
            res := (array['will_pay_on', 'call_back_later', 'refused'])[pg_temp.pick(array[55, 32, 13])];
          end if;
        else
          res := (array['paid', 'will_pay_on', 'call_back_later', 'refused'])[pg_temp.pick(array[45, 30, 15, 10])];
        end if;
      elsif x.picked = 0 and random() < 0.04 then
        res := 'wrong_number';
      elsif random() < 0.012 then
        res := 'do_not_call';
      elsif p_who = 'amit' and random() < 0.3 then
        res := 'call_back_later';   -- a long opening: the parent hangs up before the fee
      elsif p_who = 'amit' and random() < 0.25 then
        res := 'refused';
      else
        res := (array['will_pay_on', 'paid', 'paid_part', 'already_paid', 'refused', 'call_back_later', 'fee_concession'])
               [pg_temp.pick(array[50, 21, 7, 6, 3, 11, 2])];
      end if;
    end if;
    reached := case res when 'will_pay_on' then 'when' when 'paid' then 'when' when 'paid_part' then 'problem'
                        when 'refused' then 'problem' when 'fee_concession' then 'problem'
                        when 'already_paid' then 'reminder' when 'do_not_call' then 'reminder' else 'open' end;
    if res = 'will_pay_on' then
      if l.status = 'promised' then
        away := (array[2, 5, 10])[pg_temp.pick(array[50, 35, 15])] + floor(random() * 2)::int;
        v_amt := coalesce(l.promised_amount, l.amount_due);
      else
        away := case pg_temp.pick(case when x.cls = '10-B' then array[17, 22, 33, 28] else array[36, 31, 21, 12] end)
                  when 1 then 1 + floor(random() * 3)::int when 2 then 4 + floor(random() * 4)::int
                  when 3 then 8 + floor(random() * 7)::int else 15 + floor(random() * 6)::int end;
        v_amt := case when l.amount_due > 9000 and random() < 0.2 then l.amount_due / 2 else l.amount_due end;
      end if;
      v_date := d + away;
      v_note := case when random() < 0.4 then (array['Will pay by UPI after salary', 'Father will come to the office',
                  'Pays on the 1st of the month', 'Wants the receipt on WhatsApp', 'Will pay at the office counter'])[1 + floor(random() * 5)::int] end;
    elsif res = 'paid' then
      v_amt := coalesce(case when l.status = 'promised' then l.promised_amount end, l.amount_due);
    elsif res = 'paid_part' then
      v_amt := round(l.amount_due / 2 / 500) * 500;
    elsif res = 'refused' then
      v_rsn := (array['Lost job, will pay next month', 'Unhappy with the batch teacher', 'Moving to another city',
                      'Fee is too high this term', 'Child is leaving the class'])[1 + floor(random() * 5)::int];
      v_loss := case when v_rsn like 'Fee%' or v_rsn like 'Lost%' then 'price' else 'other' end;
    elsif res = 'fee_concession' then
      v_rsn := (array['Sibling discount', 'Single parent', 'Lost job', 'Other'])[1 + floor(random() * 4)::int];
    elsif res = 'call_back_later' then
      v_date := d + 1 + floor(random() * 3)::int;
      v_next := pg_temp.ist(v_date, (18 + floor(random() * 2)::int) * 3600 + 1800);
      v_note := case when random() < 0.5 then (array['Call back after salary', 'Busy at work, call in the evening',
                  'Mother will call back', 'Driving, call later'])[1 + floor(random() * 4)::int] end;
    end if;
    if random() < 0.25 and res in ('will_pay_on', 'refused', 'paid_part', 'call_back_later') then
      v_obj := (array['Money is tight this month', 'Can I pay in parts?', 'Talk to my husband or wife'])[1 + floor(random() * 3)::int];
    end if;

  elsif c.kind = 'sales' then
    skip := (p_who = 'priya' and random() < 0.58) or (p_who = 'neha' and random() < 0.09);
    if res is null then
      if x.picked = 0 and random() < 0.03 then
        res := 'wrong_number'; reached := 'open';
      else
        reached := (array['open', 'questions', 'pitch', 'timings', 'fees', 'close'])[pg_temp.pick(
          case when x.picked > 0 and v_ver = 7 then array[10, 0, 12, 8, 30, 40]
               when x.picked > 0 then array[10, 0, 18, 12, 42, 18]
               when v_ver = 7 then array[9, 12, 14, 8, 39, 18]
               else array[9, 12, 17, 8, 43, 11] end)];
        if reached = 'close' then
          jp := case when v_ver = 7 then 0.66 else 0.46 end
                + case p_who when 'neha' then 0.12 when 'priya' then -0.10 else 0 end
                - case when skip then 0.22 else 0 end;
          r := random();
          res := case when r < jp then 'joined' when r < jp + (1 - jp) * 0.6 then 'interested' else 'will_think' end;
        elsif reached = 'fees' then
          res := (array['not_interested', 'will_think', 'interested'])[pg_temp.pick(
                   case when v_ver = 7 then array[50, 36, 14] else array[58, 32, 10] end)];
        elsif reached = 'timings' then
          res := (array['will_think', 'not_interested'])[pg_temp.pick(array[60, 40])];
        elsif reached = 'pitch' then
          res := (array['not_interested', 'will_think'])[pg_temp.pick(array[50, 50])];
        elsif reached = 'questions' then
          res := (array['not_interested', 'will_think', 'call_back_later'])[pg_temp.pick(array[50, 25, 25])];
        else
          res := (array['call_back_later', 'not_interested', 'do_not_call'])[pg_temp.pick(array[65, 22, 13])];
        end if;
      end if;
    else
      reached := case res
        when 'joined' then 'close'
        when 'interested' then case when random() < 0.7 then 'close' else 'fees' end
        when 'will_think' then (array['pitch', 'timings', 'fees', 'close'])[pg_temp.pick(array[20, 20, 35, 25])]
        when 'not_interested' then (array['questions', 'pitch', 'timings', 'fees'])[pg_temp.pick(array[15, 20, 10, 55])]
        else 'open' end;
    end if;
    if reached in ('open', 'questions') then skip := false; end if;
    if res = 'not_interested' then
      if reached = 'fees' then
        v_rsn := (array['Fees too high', 'Cannot pay ₹36,000 now', 'Found a cheaper course online'])[1 + floor(random() * 3)::int];
        v_loss := 'price';
        if random() < 0.65 then v_obj := 'It costs too much'; end if;
      elsif reached = 'timings' then
        v_rsn := 'Timings do not suit'; v_loss := 'timing';
        if random() < 0.6 then v_obj := 'I have no time'; end if;
      elsif reached = 'pitch' then
        v_rsn := (array['Not sure it leads to a job', 'Wants a longer course'])[1 + floor(random() * 2)::int];
        v_loss := 'no_need';
        if random() < 0.5 then v_obj := 'Will I get a job?'; end if;
      elsif reached = 'questions' then
        v_rsn := 'Already doing another course'; v_loss := 'already_enrolled';
      else
        v_rsn := 'Not looking for a course'; v_loss := 'no_need';
      end if;
    elsif res = 'will_think' and random() < 0.3 then
      v_obj := (array['It costs too much', 'Send me the details', 'I have no time'])[1 + floor(random() * 3)::int];
    elsif res = 'joined' then
      v_note := case when v_ver = 7 then 'Paid ₹6,000 seat booking' else 'Will pay the first part this week' end;
    elsif res = 'call_back_later' then
      v_date := d + 1 + floor(random() * 2)::int;
      v_next := pg_temp.ist(v_date, (18 + floor(random() * 3)::int) * 3600);
    end if;

  else  -- admission
    if res is null then
      if x.picked = 0 and random() < 0.03 then
        res := 'wrong_number';
      elsif x.visit then
        res := (array['admission_done', 'form_sent', 'not_this_year', 'joined_elsewhere', 'call_back_later'])
               [pg_temp.pick(array[40, 25, 10, 10, 15])];
      else
        res := (array['visit_booked', 'form_sent', 'not_this_year', 'joined_elsewhere', 'call_back_later', 'do_not_call'])
               [pg_temp.pick(array[36, 22, 16, 9, 15, 2])];
      end if;
    end if;
    reached := case when res in ('visit_booked', 'form_sent', 'admission_done', 'do_not_call') then 'visit'
                    when res in ('not_this_year', 'joined_elsewhere') then 'intro' else 'open' end;
    if res = 'visit_booked' then
      v_date := d + 1 + floor(random() * 5)::int;
      update demo_lx set visit = true where lead_id = l.id;
    elsif res = 'call_back_later' then
      v_date := d + 1 + floor(random() * 3)::int;
      v_next := pg_temp.ist(v_date, (11 + floor(random() * 6)::int) * 3600);
    end if;
  end if;

  select st.steps, st.secs into v_steps, v_secs from pg_temp.step_times(c.kind, v_ver, reached, p_who, skip) st;
  if res = 'wrong_number' then v_secs := 12 + floor(random() * 20)::int; v_steps := jsonb_build_object('open', v_secs - 5); end if;
  v_stage := (array['Opening', 'Discovery', 'Pitch', 'Timings', 'Fee', 'Close'])[1 + case reached
               when 'open' then 0 when 'reminder' then 1 when 'questions' then 1 when 'intro' then 1
               when 'pitch' then 2 when 'when' then 3 when 'timings' then 3 when 'visit' then 3
               when 'problem' then 4 when 'fees' then 4 when 'due' then 4 else 5 end];

  perform pg_temp.add_call(s, l.id, p_t, res, v_secs, sid, v_ver, reached, v_steps, v_date, v_amt, v_rsn, v_note,
                           v_loss, case when res in ('not_interested', 'refused', 'do_not_call') then v_stage end, v_obj);

  -- ---- the lead after the call (same mapping as save_call_result) ----
  select r2.needs_date into needs_date from public.call_type_results r2
   where r2.key = res and (r2.institute_id is null or r2.institute_id = '5a1e0000-0000-4000-8000-000000000001')
   order by r2.call_type_id nulls last limit 1;
  if res = 'do_not_call' then
    update public.leads set do_not_call = true, next_call_at = null where id = l.id;
  elsif res = 'wrong_number' then
    update public.leads set status = 'wrong_number', next_call_at = null where id = l.id;
  elsif res = 'will_pay_on' then
    update public.leads set status = 'promised', promised_date = v_date, promised_amount = v_amt,
                            next_call_at = pg_temp.ist(v_date, 36000) where id = l.id;
    update demo_lx set promise_away = away, forget_checked = false where lead_id = l.id;
  elsif needs_date then
    update public.leads set status = 'callback', next_call_at = coalesce(v_next, pg_temp.ist(v_date, 36000)) where id = l.id;
  elsif res = 'will_think' then
    update public.leads set status = 'callback', next_call_at = p_t + interval '2 days' where id = l.id;
  else
    update public.leads set status = 'done', next_call_at = null where id = l.id;
  end if;
  -- About half the people who talk say yes to WhatsApp messages.
  if random() < 0.55 then update public.leads set consent_whatsapp = true where id = l.id; end if;
  return src;
end $$;

-- ---------- 9. the calls: about 7 weeks of history, then today ----------

do $$
declare
  today   date := (select v::date from demo_ctx where k = 'today');
  day0    timestamptz := pg_temp.ist(today, 0);
  t_end   timestamptz := now() - interval '4 minutes';
  t_start timestamptz;
  sana_off timestamptz;
  dd      int;
  d       date;
  sch     record;
  n       int;
  cap     int;
  used    int;
  t       timestamptz;
  got     text;
  w0      timestamptz;
  w1      timestamptz;
  rr      record;
begin
  perform setseed(current_setting('demo.seed')::float8);

  -- Today's calls happen between t_start and t_end (the last 9 hours of today so far, from 9:30 am).
  t_start := greatest(pg_temp.ist(today, 9 * 3600 + 1800), t_end - interval '9 hours');
  if t_end - t_start < interval '100 minutes' then t_start := greatest(day0 + interval '2 minutes', t_end - interval '100 minutes'); end if;
  if t_end <= t_start then t_end := t_start + interval '30 minutes'; end if;
  -- Sana's phone went offline about 11:20 (or 40 minutes ago, when that is earlier).
  sana_off := greatest(t_start + (t_end - t_start) * 0.5, least(pg_temp.ist(today, 11 * 3600 + 1200), t_end - interval '40 minutes'));
  insert into demo_ctx values ('t_start', t_start::text), ('t_end', t_end::text), ('sana_off', sana_off::text);

  -- The sales script test (v6 against v7) started 9 days ago, when v7 was published.
  update demo_camps set test_id = gen_random_uuid(), test_start = pg_temp.ist(today - 9, 37800) where k = 'sales';
  insert into public.script_tests (id, institute_id, campaign_id, script_id, version_a, version_b, status, started_by, started_at)
  select k.test_id, '5a1e0000-0000-4000-8000-000000000001', k.id, (select id from demo_scripts where k = 'sales'),
         6, 7, 'running', '5a1e0000-0000-4000-8000-000000000101', k.test_start
  from demo_camps k where k.k = 'sales';

  -- Who calls for which campaign on which days: (who, campaign, first day back, last day back, calls a day,
  -- new leads a day). Calls stop early on a day when the caller has nothing due and no new lead left.
  create temp table demo_sched (who text, camp text, d_from int, d_to int, per_day int, new_cap numeric, y_window int) on commit drop;
  insert into demo_sched values
    ('ravi',  'sept',  53, 24, 26, 8.5, 0),
    ('ravi',  'oct',   23, 1,  24, 5.2, 22),
    ('amit',  'oct',   23, 1,  18, 4.4, 10),
    ('priya', 'sales', 13, 1,  36, 10.5, 30),
    ('neha',  'sales', 13, 1,  40, 11.5, 36),
    ('sana',  'adm',   14, 1,  20, 4.8, 27);

  for dd in reverse 53 .. 1 loop
    d := today - dd;
    for sch in select * from demo_sched where dd between d_to and d_from order by who, camp loop
      used := 0;
      -- More new leads early in a campaign, fewer later (most are called by then).
      cap := floor(sch.new_cap * (1.5 - (sch.d_from - dd)::numeric / greatest(1, sch.d_from - sch.d_to)) + random())::int;
      if dd = 1 then
        -- Yesterday: the same stretch of the day as today's calls (Home: "x% more than yesterday"), then the evening.
        w0 := t_start - interval '1 day'; w1 := t_end - interval '1 day';
        cap := cap * 3;
        for t in select w0 + (w1 - w0) * random() as tt from generate_series(1, sch.y_window) order by 1 loop
          got := pg_temp.sim_call(sch.camp, sch.who, t, null, used < cap);
          if got = 'new' then used := used + 1; end if;
        end loop;
        if w1 < pg_temp.ist(d, 20 * 3600 + 2700) then
          n := floor(extract(epoch from pg_temp.ist(d, 20 * 3600 + 2700) - w1) / 3600 * sch.per_day / 10)::int;
          for t in select w1 + (pg_temp.ist(d, 20 * 3600 + 2700) - w1) * random() as tt from generate_series(1, n) order by 1 loop
            got := pg_temp.sim_call(sch.camp, sch.who, t, null, used < cap);
            if got = 'new' then used := used + 1; end if;
          end loop;
        end if;
        continue;
      end if;
      n := greatest(4, round(sch.per_day * (0.8 + random() * 0.4)
                             * case when extract(isodow from d) = 7 then 0.45 else 1 end))::int;
      for t in select pg_temp.call_time(sch.who, d) as tt from generate_series(1, n) order by 1 loop
        got := pg_temp.sim_call(sch.camp, sch.who, t, null, used < cap);
        if got = 'new' then used := used + 1; end if;
      end loop;
    end loop;
  end loop;

  -- Sept fees ends: everyone still open was settled at the office on the last day.
  for rr in select l.id, l.status from public.leads l join demo_camps k on k.id = l.campaign_id
            where k.k = 'sept' and l.status in ('new', 'callback', 'promised') order by l.created_at loop
    t := pg_temp.call_time('ravi', today - 24);
    got := pg_temp.sim_call('sept', 'ravi', t, case when rr.status = 'promised' then 'paid' else 'already_paid' end, true);
  end loop;
  update public.leads l set status = 'done', next_call_at = null from demo_camps k
   where k.id = l.campaign_id and k.k = 'sept' and l.status in ('new', 'callback', 'promised');
  update public.campaigns set status = 'closed' where id = (select id from demo_camps where k = 'sept');

  -- Home "Fee promises due today": about 6. Bring a few promises due in the next 3 days forward to today (the
  -- lead and the call that made the promise, so Insights still agrees).
  for rr in
    select l.id from public.leads l join demo_camps k on k.id = l.campaign_id
    where k.k = 'oct' and l.status = 'promised' and l.promised_date between today + 1 and today + 3
    order by l.promised_date, l.created_at
    limit greatest(0, 6 - (select count(*) from public.leads l2 join demo_camps k2 on k2.id = l2.campaign_id
                           where k2.k = 'oct' and l2.status = 'promised' and l2.promised_date = today))
  loop
    update public.call_outcomes o set promised_date = today
     where o.id = (select o2.id from public.call_outcomes o2 where o2.lead_id = rr.id and o2.result_key = 'will_pay_on'
                   order by o2.dialled_at desc limit 1);
    update public.leads set promised_date = today, next_call_at = pg_temp.ist(today, 36000) where id = rr.id;
  end loop;

  -- Today: fixed result counts per caller (Home tiles like the mockup), in random order between t_start and t_end.
  -- Amit has made no call today (Home: "No calls for 45 min"); Sana's calls stop when her phone went offline.
  create temp table demo_today (who text, camp text, res text, n int) on commit drop;
  insert into demo_today values
    ('ravi', 'oct', 'paid', 2), ('ravi', 'oct', 'paid_part', 2), ('ravi', 'oct', 'will_pay_on', 4),
    ('ravi', 'oct', 'already_paid', 1), ('ravi', 'oct', 'call_back_later', 2), ('ravi', 'oct', 'refused', 1),
    ('ravi', 'oct', 'no_answer', 9), ('ravi', 'oct', 'busy', 3),
    ('priya', 'sales', 'joined', 3), ('priya', 'sales', 'interested', 5), ('priya', 'sales', 'will_think', 5),
    ('priya', 'sales', 'not_interested', 6), ('priya', 'sales', 'call_back_later', 2), ('priya', 'sales', 'wrong_number', 1),
    ('priya', 'sales', 'no_answer', 12), ('priya', 'sales', 'busy', 4),
    ('neha', 'sales', 'joined', 6), ('neha', 'sales', 'interested', 8), ('neha', 'sales', 'will_think', 6),
    ('neha', 'sales', 'not_interested', 8), ('neha', 'sales', 'call_back_later', 2),
    ('neha', 'sales', 'no_answer', 12), ('neha', 'sales', 'busy', 4),
    ('sana', 'adm', 'visit_booked', 6), ('sana', 'adm', 'admission_done', 5), ('sana', 'adm', 'form_sent', 4),
    ('sana', 'adm', 'not_this_year', 2), ('sana', 'adm', 'joined_elsewhere', 1), ('sana', 'adm', 'call_back_later', 2),
    ('sana', 'adm', 'no_answer', 9), ('sana', 'adm', 'busy', 3);

  for sch in select distinct who, camp from demo_today order by who loop
    w0 := t_start;
    w1 := case when sch.who = 'sana' then sana_off - interval '3 minutes' else t_end end;
    for rr in
      with list as (select x.res from demo_today x cross join generate_series(1, x.n) where x.who = sch.who order by random()),
           draws as (select random() as r from list),
           -- The caller's last call is at the end of the window, so Home shows them as working now.
           times as (select w0 + (w1 - w0) * case when r = max(r) over () then 1 else r end as tt from draws)
      select l.res, t2.tt from (select res, row_number() over () as rn from list) l
      join (select tt, row_number() over (order by tt) as rn from times) t2 on t2.rn = l.rn
      order by t2.tt
    loop
      got := pg_temp.sim_call(sch.camp, sch.who, rr.tt, rr.res, true);
    end loop;
  end loop;
end $$;

-- ---------- 9b. the ledger after the calls, the fees campaign from the ledger, follow-ups back in the pool ----------

-- "Says already paid" calls of the last 10 days that the office cannot find in the ledger yet (every other one,
-- 5 at most): the accounts office checks these (student page → calls).
create temp table demo_noledger (outcome_id uuid primary key) on commit drop;

do $$
declare
  inst    uuid := '5a1e0000-0000-4000-8000-000000000001';
  today   date := (select v::date from demo_ctx where k = 'today');
  owner_u uuid := (select user_id from demo_people where who = 'owner');
  mgr_u   uuid := (select user_id from demo_people where who = 'manager');
  kav_u   uuid := (select user_id from demo_people where who = 'kavita');
  sana_u  uuid := (select user_id from demo_people where who = 'sana');
  kavita  uuid := '5a1e0000-0000-4000-8000-000000000108';
  priya   uuid := '5a1e0000-0000-4000-8000-000000000104';
  neha    uuid := '5a1e0000-0000-4000-8000-000000000105';
  sana    uuid := '5a1e0000-0000-4000-8000-000000000107';
  c_oct   uuid := '5a1e0000-0000-4000-8000-000000000201';
  c_sale  uuid := '5a1e0000-0000-4000-8000-000000000202';
  c_adm   uuid := '5a1e0000-0000-4000-8000-000000000203';
  c_c8    uuid;
  r       record;
  rem     numeric;
  amt     numeric;
  d       date;
  pd      date;
  t       timestamptz;
  pid     uuid;
  wid     uuid;
  lid     uuid;
  rel_t   timestamptz;
  i       int;
begin
  perform setseed(current_setting('demo.seed')::float8 / 3);

  insert into demo_noledger
  select x.id from (
    select o.id, row_number() over (order by o.dialled_at desc) as rn
    from public.call_outcomes o join public.leads l on l.id = o.lead_id
    where l.campaign_id = c_oct and o.result_key = 'already_paid' and o.corrects_id is null
      and o.dialled_at >= pg_temp.ist(today - 10, 0)) x
  where x.rn % 2 = 1 and x.rn <= 9;

  -- 1. Payments for the fees calls: "Paid" and "Paid part" are recorded 0–2 days after the call (a few later);
  --    "Says already paid" was paid 0–2 days before the call. Never more than the Term 2 balance left.
  for r in
    select o.id, o.result_key, o.amount, o.dialled_at, l.student_id, st.t2_due
    from public.call_outcomes o
    join public.leads l on l.id = o.lead_id
    join demo_st st on st.id = l.student_id
    where l.campaign_id in (c_oct, '5a1e0000-0000-4000-8000-000000000204')
      and o.result_key in ('paid', 'paid_part', 'already_paid') and o.corrects_id is null
      and not exists (select 1 from demo_noledger n where n.outcome_id = o.id)
    order by o.dialled_at, o.id
  loop
    select b.balance_due_now into rem from public.student_balance_rows(inst, r.student_id, r.t2_due) b;
    continue when rem <= 0;
    d := (r.dialled_at at time zone 'Asia/Kolkata')::date;
    if r.result_key = 'already_paid' then
      amt := rem;
      pd := d - (pg_temp.pick(array[30, 40, 30]) - 1);
      t := pg_temp.ist(pd, 10 * 3600 + floor(random() * 27000)::int);
    else
      amt := least(coalesce(r.amount, rem), rem);
      pd := least(today, d + case when random() < 0.08 then 3 + floor(random() * 3)::int
                                  else pg_temp.pick(array[60, 28, 12]) - 1 end);
      t := greatest(r.dialled_at + interval '20 minutes', pg_temp.ist(pd, 10 * 3600 + floor(random() * 27000)::int));
    end if;
    perform pg_temp.add_payment(r.student_id, amt, pd, pg_temp.pay_mode(), null,
                                least(now() - interval '2 minutes', t));
  end loop;

  -- 2. Oct promises whose date has passed and that the callers did not forget: the parent paid without a call
  --    (on or just before the date). Their leads close below, like accounts_record_payment closes them. The 14
  --    forgotten promises stay broken: promised, date passed, nothing in the ledger.
  for r in
    select l.id, l.student_id, l.promised_date, st.t2_due
    from public.leads l join demo_lx x on x.lead_id = l.id join demo_st st on st.id = l.student_id
    where l.campaign_id = c_oct and l.status = 'promised' and l.promised_date < today and not x.forgotten
    order by l.promised_date, l.created_at
  loop
    select b.balance_due_now into rem from public.student_balance_rows(inst, r.student_id, r.t2_due) b;
    continue when rem <= 0;
    pd := r.promised_date - (pg_temp.pick(array[60, 40]) - 1);
    perform pg_temp.add_payment(r.student_id, rem, pd, pg_temp.pay_mode(), null,
                                least(now() - interval '2 minutes', pg_temp.ist(pd + 1, 10 * 3600 + floor(random() * 25000)::int)));
  end loop;

  -- 2b. Class 9 parents who did not pay during Sept fees (refused, asked for a concession, wrong number …):
  --     most paid at the office in the weeks after it closed; about a third still owe.
  for r in
    select st.id as student_id, st.t2_due from demo_st st where st.cls = 9 order by st.i
  loop
    select b.balance_due_now into rem from public.student_balance_rows(inst, r.student_id, r.t2_due) b;
    continue when rem <= 0 or random() < 0.35;
    pd := today - 23 + floor(random() * 20)::int;
    perform pg_temp.add_payment(r.student_id, rem, pd, pg_temp.pay_mode(), null,
                                pg_temp.ist(pd, 10 * 3600 + floor(random() * 27000)::int));
  end loop;

  -- 3. Three reversals. (a) A Class 8 cheque came back unpaid: that student owes Term 2 again.
  select p.id, p.created_at into pid, t from public.payments p join demo_st st on st.id = p.student_id
   where st.cls = 8 and st.i = 33 and p.mode = 'cheque' and not p.opening;
  perform pg_temp.reverse_payment(pid, 'Cheque returned unpaid by the bank. Parent told; will pay by UPI.', t + interval '4 days');

  -- (b) A UPI payment first recorded on the wrong student (the next one in the list), reversed, then recorded
  --     on the right student with the same UTR (allowed once the first one is reversed).
  select p.id, p.student_id, p.amount, p.paid_on, p.reference, p.created_at into r
    from public.payments p join demo_st st on st.id = p.student_id
   where st.cls = 10 and p.mode = 'upi' and not p.opening and p.paid_on <= today - 3
   order by p.paid_on desc, p.created_at desc limit 1;
  insert into public.payments (institute_id, student_id, amount, paid_on, mode, reference, recorded_by, created_at)
    select inst, s2.id, r.amount, r.paid_on, 'upi', r.reference, kavita, r.created_at - interval '50 minutes'
    from demo_st st join demo_st s2 on s2.cls = 10 and s2.i = case when st.i < 240 then st.i + 2 else st.i - 2 end
    where st.id = r.student_id
    returning id into wid;
  perform pg_temp.reverse_payment(wid, 'Recorded on the wrong student by mistake; recorded again on '
                                       || (select admission_no from public.students where id = r.student_id) || '.',
                                  r.created_at - interval '5 minutes');

  -- (c) A cash payment typed in twice.
  select p.id, p.student_id, p.amount, p.paid_on, p.created_at into r
    from public.payments p join demo_st st on st.id = p.student_id
   where st.cls = 10 and p.mode = 'cash' and not p.opening and p.paid_on <= today - 2
   order by p.paid_on desc, p.created_at desc limit 1;
  insert into public.payments (institute_id, student_id, amount, paid_on, mode, reference, recorded_by, created_at)
    values (inst, r.student_id, r.amount, r.paid_on, 'cash', null, kavita, r.created_at + interval '3 minutes')
    returning id into wid;
  perform pg_temp.reverse_payment(wid, 'Recorded twice by mistake.', r.created_at + interval '1 day 2 hours');

  -- 4. "Admission confirmed" makes a student (creates_student), as save_call_result does: no fee plan yet,
  --    the office adds it.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', sana_u, 'role', 'authenticated')::text, true);
  for r in
    select distinct on (o.lead_id) o.lead_id, o.dialled_at, l.extra
    from public.call_outcomes o join public.leads l on l.id = o.lead_id
    where l.campaign_id = c_adm and o.result_key = 'admission_done' and o.corrects_id is null
    order by o.lead_id, o.dialled_at
  loop
    pid := public.ledger_student_from_lead(r.lead_id, sana);
    update public.students
       set created_at = r.dialled_at + interval '3 minutes', updated_at = r.dialled_at + interval '3 minutes',
           academic_year = '2026-27',
           class_label = case when r.extra ->> 'course' like 'Class 11%' or r.extra ->> 'course' like 'NEET%' then '11th' end,
           board = case when r.extra ->> 'course' like 'Class 11%' or r.extra ->> 'course' like 'NEET%' then 'CBSE' end
     where id = pid;
    update public.audit_log set created_at = r.dialled_at + interval '3 minutes'
     where institute_id = inst and action = 'student.added_from_admission' and target like pid::text || ':%';
  end loop;

  -- 5. "Term 2 fees – Class 8": made from the ledger by Kavita this morning with accounts_create_fees_campaign
  --    (Class 8, CBSE, balance due by the Term 2 due date, open to all, started). One lead per phone (the twins
  --    get one), students with no phone left out; the leads wait in the pool.
  perform set_config('request.jwt.claims', jsonb_build_object('sub', kav_u, 'role', 'authenticated')::text, true);
  c_c8 := public.accounts_create_fees_campaign('Term 2 fees – Class 8', '8th', 'CBSE', today + 6, 0,
                                               (select id from demo_scripts where k = 'polite8'), true, true);
  perform set_config('request.jwt.claims', '', true);
  t := least(now() - interval '20 minutes', greatest(pg_temp.ist(today, 9 * 3600 + 1200), now() - interval '2 hours'));
  update public.campaigns set created_at = t, start_date = today, end_date = today + 20, daily_target = 50 where id = c_c8;
  update public.leads l
     set created_at = t + (l.created_at - (select min(l2.created_at) from public.leads l2 where l2.campaign_id = c_c8)),
         extra = l.extra || jsonb_build_object('source', 'your child''s admission form',
                                               'source_date', pg_temp.say_date(st.adm_date), 'due_date', pg_temp.say_date(st.t2_due))
    from demo_st st
   where l.campaign_id = c_c8 and st.id = l.student_id;
  update public.audit_log a set created_at = t + interval '10 seconds'
   where a.institute_id = inst and a.target like c_c8::text || '%';
  insert into demo_camps (id, k, kind, script_k, version) values (c_c8, 'c8', 'fees', 'polite8', 2);

  -- 6. Every fees lead with a student: amount_due = the student's balance due by max(today, fees_due_by), as
  --    ledger_sync_student keeps it. An open lead with nothing left to pay is closed (lead.closed_paid).
  for r in
    select l.id, l.status, l.do_not_call, c.status as cst, l.student_id,
           greatest(b.balance_due_now, 0) as due
    from public.leads l
    join public.campaigns c on c.id = l.campaign_id
    join public.call_types ct on ct.id = c.call_type_id and ct.key = 'fees'
    cross join lateral public.student_balance_rows(inst, l.student_id, greatest(today, coalesce(c.fees_due_by, today))) b
    where l.institute_id = inst and l.student_id is not null
  loop
    if r.due <= 0 and r.cst <> 'closed' and public.lead_is_open(r.status, r.do_not_call) then
      update public.leads set amount_due = 0, status = 'done', next_call_at = null where id = r.id;
      insert into public.audit_log (institute_id, actor_id, action, target, created_at)
        values (inst, kav_u, 'lead.closed_paid', r.id::text,
                (select max(p.created_at) from public.payments p where p.student_id = r.student_id));
    else
      update public.leads set amount_due = r.due where id = r.id and amount_due is distinct from r.due;
    end if;
  end loop;

  -- 7. Back to the pool today: 4 walk-in enquiries added to Admission follow-up 4 days ago. Priya took them from
  --    the pool 3 days ago (the campaign is open to all) and they asked for a call back this morning; she has
  --    not worked that campaign since (24 working hours), so they went back to the pool when Sana asked for her
  --    next lead (release_stale_leads; audit lead.released <lead>:<seat>:idle). Home shows the alert.
  rel_t := least(now() - interval '15 minutes', greatest(pg_temp.ist(today, 10 * 3600 + 1500), now() - interval '5 hours'));
  for i in 1 .. 4 loop
    insert into public.leads (institute_id, campaign_id, name, phone, extra, status, next_call_at, consent_whatsapp, created_at)
      values (inst, c_adm,
              (array['Farhan Qureshi', 'Leela Bhat', 'Gopal Rane', 'Mansi Thakur'])[i], '+91' || (9999040150 + i)::text,
              jsonb_build_object('student', (array['Ayaan', 'Kavya', 'Parth', 'Siya'])[i],
                                 'course', (array['JEE Foundation', 'Class 11 Science', 'NEET 2-year', 'Class 11 Commerce'])[i],
                                 'source', 'your visit to our office', 'source_date', pg_temp.say_date(today - 5)),
              'callback', rel_t - interval '50 minutes' + i * interval '4 minutes', i % 2 = 0,
              pg_temp.ist(today - 4, 16 * 3600 + i * 60))
      returning id into lid;
    t := pg_temp.ist(today - 3, 17 * 3600 + i * 420);
    perform pg_temp.add_call(priya, lid, t, 'call_back_later', 40 + i * 9,
                             (select id from demo_scripts where k = 'admission'), 2, 'open',
                             jsonb_build_object('open', 18 + i), today, null, null,
                             'Asked for a call back in the morning', null, null, null);
    insert into public.audit_log (institute_id, actor_id, action, target, created_at)
      values (inst, sana_u, 'lead.released', lid::text || ':' || priya::text || ':idle', rel_t + i * interval '1 second');
  end loop;
  insert into public.audit_log (institute_id, actor_id, action, target, created_at)
    values (inst, mgr_u, 'leads.added', c_adm::text || ':4', pg_temp.ist(today - 4, 16 * 3600));

  -- 8. Shronit: a real person for a live call in the demo (the owner's guest). He called the office about the
  --    Data Analytics course and asked for a call back: Neha's first due call back. No WhatsApp consent.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, status, next_call_at, assigned_seat_id,
                            consent_whatsapp, created_at)
    values (inst, c_sale, 'Shronit', '+919619707601',
            jsonb_build_object('course', 'Data Analytics', 'source', 'a call to our office',
                               'source_date', pg_temp.say_date(today - 1)),
            'callback',
            least(now() - interval '10 minutes',
                  coalesce((select min(l.next_call_at) from public.leads l
                            where l.campaign_id = c_sale and l.assigned_seat_id = neha and l.next_call_at <= now()
                              and l.status in ('new', 'callback', 'promised') and not l.do_not_call), now()) - interval '1 minute'),
            neha, false, pg_temp.ist(today - 1, 17 * 3600 + 1500));
  insert into public.audit_log (institute_id, actor_id, action, target, created_at)
    values (inst, owner_u, 'leads.added', c_sale::text || ':1', pg_temp.ist(today - 1, 17 * 3600 + 1500));

  -- 8b. Today's collection: Class 8 parents who came to the office this morning to pay Term 2 before its due
  --     date (cash, UPI and a cheque to bank), one taken by the owner, and a cash payment typed with the
  --     wrong amount and reversed. Their Term 2 leads close as accounts_record_payment closes them.
  i := 0;
  for r in
    select st.id as student_id, b.balance_total
    from demo_st st
    join public.students s on s.id = st.id and s.status = 'active' and s.phone is not null
    cross join lateral public.student_balance_rows(inst, st.id) b
    where st.cls = 8 and st.i % 4 = 0 and b.balance_total > 0
    order by st.i
    limit 5
  loop
    i := i + 1;
    t := least(now() - interval '25 minutes' + i * interval '3 minutes', pg_temp.ist(today, 9 * 3600 + 1800 + i * 1500));
    perform pg_temp.add_payment(r.student_id, r.balance_total, today, (array['cash', 'upi', 'cheque', 'cash', 'upi'])[i],
                                case i when 3 then 'Cheque for the bank on Monday' end, t,
                                case when i = 4 then '5a1e0000-0000-4000-8000-000000000101'::uuid
                                     else '5a1e0000-0000-4000-8000-000000000108'::uuid end);
    if i = 2 then
      wid := pg_temp.add_payment(r.student_id, 5000, today, 'cash', null, t + interval '1 minute',
                                 '5a1e0000-0000-4000-8000-000000000108'::uuid);
      perform pg_temp.reverse_payment(wid, 'Wrong amount typed; the parent paid by UPI.', t + interval '6 minutes');
    end if;
    perform public.ledger_sync_student(r.student_id);
  end loop;

  -- 9. The walkthrough's parent: one of Ravi's promises due today becomes "Sunita Bhosale" (student Riya
  --    Bhosale, 10-A), promising exactly her balance. Kavita records her UPI payment in the demo and the lead
  --    leaves Ravi's list. Prefer a student whose balance is just Term 2 (₹18,000).
  select l.id, l.student_id into r
    from public.leads l
    cross join lateral public.student_balance_rows(inst, l.student_id, today) b
   where l.campaign_id = c_oct and l.status = 'promised' and l.promised_date = today
     and l.assigned_seat_id = '5a1e0000-0000-4000-8000-000000000103'
   order by (b.balance_due_now = 18000) desc, l.created_at
   limit 1;
  if r.id is not null then
    update public.students set name = 'Riya Bhosale', parent_name = 'Sunita Bhosale', section = 'A' where id = r.student_id;
    select greatest(b.balance_due_now, 0) into amt from public.student_balance_rows(inst, r.student_id, today) b;
    update public.leads set name = 'Sunita Bhosale', promised_amount = amt, amount_due = amt,
                            extra = extra || jsonb_build_object('student', 'Riya Bhosale', 'class', '10-A', 'section', 'A')
     where id = r.id;
    update public.leads set name = 'Sunita Bhosale', extra = extra || jsonb_build_object('student', 'Riya Bhosale', 'class', '10-A', 'section', 'A')
     where student_id = r.student_id and campaign_id <> c_oct;
    update public.call_outcomes set amount = amt
     where id = (select o.id from public.call_outcomes o where o.lead_id = r.id and o.result_key = 'will_pay_on'
                 order by o.dialled_at desc limit 1);
  end if;
end $$;

-- ---------- 10. what the other screens read ----------

do $$
declare
  inst    uuid := '5a1e0000-0000-4000-8000-000000000001';
  today   date := (select v::date from demo_ctx where k = 'today');
  t_end   timestamptz := (select v::timestamptz from demo_ctx where k = 't_end');
  sana_off timestamptz := (select v::timestamptz from demo_ctx where k = 'sana_off');
  owner_u uuid := (select user_id from demo_people where who = 'owner');
  mgr_u   uuid := (select user_id from demo_people where who = 'manager');
  owner   uuid := '5a1e0000-0000-4000-8000-000000000101';
  mgr     uuid := '5a1e0000-0000-4000-8000-000000000102';
  ravi    uuid := '5a1e0000-0000-4000-8000-000000000103';
  priya   uuid := '5a1e0000-0000-4000-8000-000000000104';
  neha    uuid := '5a1e0000-0000-4000-8000-000000000105';
  amit    uuid := '5a1e0000-0000-4000-8000-000000000106';
  sana    uuid := '5a1e0000-0000-4000-8000-000000000107';
  c_oct   uuid := '5a1e0000-0000-4000-8000-000000000201';
  c_sale  uuid := '5a1e0000-0000-4000-8000-000000000202';
  c_adm   uuid := '5a1e0000-0000-4000-8000-000000000203';
  c_sept  uuid := '5a1e0000-0000-4000-8000-000000000204';
  c_ptm   uuid := '5a1e0000-0000-4000-8000-000000000205';
  s_fees  uuid := (select id from demo_scripts where k = 'fees');
  s_sale  uuid := (select id from demo_scripts where k = 'sales');
  s_late  uuid := (select id from demo_scripts where k = 'late_fee');
  s_od    uuid := (select id from demo_scripts where k = 'overdue10');
  kav_u   uuid := (select user_id from demo_people where who = 'kavita');
  c_adm9  uuid := '5a1e0000-0000-4000-8000-000000000207';
  month0  timestamptz := (date_trunc('month', now() at time zone 'Asia/Kolkata'))::timestamp at time zone 'Asia/Kolkata';
  r_conc  uuid := (select id from public.call_type_results where institute_id = inst and key = 'fee_concession');
  r_adm   uuid := (select id from public.call_type_results where institute_id = inst and key = 'admission_done');
begin
  -- "Callers right now": the caller screens report presence every minute. seen_at is set a few hours ahead so
  -- the statuses stay live for the whole demo (they are only read as "seen in the last 3 minutes").
  -- Neha and Ravi are on calls their phones confirm (20261025190000): Home shows "On a call · m:ss" from
  -- call_started_at, a few minutes before the seed ran.
  insert into public.seat_presence (seat_id, institute_id, seen_at, online_since, on_call, phone_ok, phone_offline_since,
                                    call_state, call_started_at, state_at) values
    (ravi,  inst, now() + interval '8 hours', pg_temp.ist(today, 9 * 3600 + 1500), true,  true,  null,
       'connected', now() - interval '1 minute 40 seconds', now() - interval '1 minute 30 seconds'),
    (priya, inst, now() + interval '8 hours', pg_temp.ist(today, 9 * 3600 + 1700), false, true,  null, 'none', null, now()),
    (neha,  inst, now() + interval '8 hours', pg_temp.ist(today, 9 * 3600 + 1600), true,  true,  null,
       'connected', now() - interval '3 minutes 12 seconds', now() - interval '3 minutes'),
    (amit,  inst, now() + interval '8 hours', now() - interval '45 minutes',        false, true,  null, 'none', null, now()),
    (sana,  inst, now() + interval '8 hours', pg_temp.ist(today, 9 * 3600 + 1800), false, false, sana_off, 'none', null, now());

  -- Supervisor notes (Callers tab, coaching).
  insert into public.supervisor_notes (institute_id, target_seat_id, author_seat_id, note_day, note, created_at) values
    (inst, priya, mgr, today - 1, 'Skips the Questions step on most calls and goes straight to the pitch. Ask what they do now and what they want first: callers who ask get about 2x more joinings.', pg_temp.ist(today - 1, 18 * 3600 + 600)),
    (inst, priya, owner, today - 6, 'Good energy on the phone. Listen to two of Neha''s calls this week.', pg_temp.ist(today - 6, 17 * 3600)),
    (inst, amit, mgr, today - 2, 'Opening takes about a minute. Keep it to name, school and the fee, then ask for a date. Sent to practice mode.', pg_temp.ist(today - 2, 16 * 3600 + 1200)),
    (inst, neha, owner, today - 3, 'Best joining rate this month. Ask her to share how she handles "It costs too much" in Monday''s meeting.', pg_temp.ist(today - 3, 19 * 3600)),
    (inst, ravi, mgr, today - 4, 'Calls mostly around 11 am, when parents are at work. Try 7–9 pm on weekdays.', pg_temp.ist(today - 4, 12 * 3600));

  -- Feedback from callers.
  insert into public.feedback (institute_id, seat_id, message, created_at) values
    (inst, neha, 'The ₹6,000 start line in v7 works. People stay on the call after the fee.', pg_temp.ist(today - 5, 19 * 3600 + 1200)),
    (inst, ravi, 'Parents ask for the receipt on WhatsApp. Can we send it from the app?', pg_temp.ist(today - 8, 13 * 3600));

  -- Practice mode: Amit is asked to practise the Oct fees script (not done yet).
  insert into public.practice_assignments (institute_id, seat_id, script_id, note, assigned_by, assigned_at) values
    (inst, amit, s_od, 'Practise a short opening: name, school, fee and date in under 25 seconds.', mgr, pg_temp.ist(today - 2, 16 * 3600 + 1300));

  -- AI script maker: 3 drafts (and 2 "Make simpler") this month. Placed inside this month, before now.
  insert into public.ai_requests (institute_id, seat_id, kind, model, attempts, input_tokens, output_tokens,
                                  cache_read_tokens, cache_write_tokens, cost_usd, ok, created_at, finished_at)
  select inst, owner, v.kind, v.model, v.att, v.inp, v.outp, v.cr, v.cw, v.cost, true,
         month0 + (now() - month0) * v.f, month0 + (now() - month0) * v.f + interval '14 seconds'
  from (values ('draft', 'claude-haiku-5-5', 1, 6150, 11800, 0, 4200, 0.006520, 0.15),
               ('draft', 'claude-haiku-5-5', 2, 12400, 23100, 4200, 4200, 0.012990, 0.55),
               ('simplify', 'claude-haiku-5-5', 1, 2900, 1400, 4200, 0, 0.001020, 0.56),
               ('draft', 'claude-haiku-5-5', 1, 6020, 12650, 4200, 0, 0.006930, 0.92),
               ('simplify', 'claude-haiku-5-5', 1, 3100, 1250, 4200, 0, 0.000980, 0.93)) v(kind, model, att, inp, outp, cr, cw, cost, f);

  -- Admin activity log (Settings), oldest first. Targets start with the id of what changed, like the app writes them.
  insert into public.audit_log (institute_id, actor_id, action, target, created_at) values
    (inst, owner_u, 'institute.created', inst::text, pg_temp.ist(today - 75, 11 * 3600)),
    (inst, owner_u, 'seat.invited', mgr::text, pg_temp.ist(today - 75, 11 * 3600 + 600)),
    (inst, owner_u, 'seat.invited', ravi::text, pg_temp.ist(today - 75, 11 * 3600 + 700)),
    (inst, owner_u, 'seat.invited', priya::text, pg_temp.ist(today - 75, 11 * 3600 + 800)),
    (inst, owner_u, 'seat.invited', neha::text, pg_temp.ist(today - 75, 11 * 3600 + 900)),
    (inst, owner_u, 'seat.invited', amit::text, pg_temp.ist(today - 75, 11 * 3600 + 1000)),
    (inst, owner_u, 'seat.invited', sana::text, pg_temp.ist(today - 75, 11 * 3600 + 1100)),
    (inst, owner_u, 'script.published', (select id::text from public.script_versions where script_id = s_fees and version = 2), pg_temp.ist(today - 56, 41000)),
    (inst, owner_u, 'campaign.created', c_sept::text, pg_temp.ist(today - 54, 39000)),
    (inst, owner_u, 'leads.added', c_sept::text || ':150', pg_temp.ist(today - 54, 39300)),
    (inst, owner_u, 'campaign.running', c_sept::text, pg_temp.ist(today - 54, 39600)),
    (inst, owner_u, 'script.published', (select id::text from public.script_versions where script_id = s_sale and version = 5), pg_temp.ist(today - 21, 40000)),
    (inst, owner_u, 'money.access_removed', mgr::text, pg_temp.ist(today - 40, 15 * 3600)),
    (inst, owner_u, 'call_type_result.added', r_conc::text, pg_temp.ist(today - 40, 15 * 3600 + 600)),
    (inst, mgr_u, 'call_type_result.added', r_adm::text, pg_temp.ist(today - 21, 12 * 3600)),
    (inst, owner_u, 'script.published', (select id::text from public.script_versions where script_id = s_fees and version = 3), pg_temp.ist(today - 25, 42000)),
    (inst, owner_u, 'campaign.created', c_oct::text, pg_temp.ist(today - 24, 39000)),
    (inst, owner_u, 'leads.added', c_oct::text || ':240', pg_temp.ist(today - 24, 39300)),
    (inst, owner_u, 'campaign.members_set', c_oct::text || ':2', pg_temp.ist(today - 24, 39500)),
    (inst, owner_u, 'campaign.closed', c_sept::text, pg_temp.ist(today - 24, 18 * 3600)),
    (inst, owner_u, 'campaign.running', c_oct::text, pg_temp.ist(today - 23, 33000)),
    (inst, mgr_u, 'script.published', (select id::text from public.script_versions where script_id = (select id from demo_scripts where k = 'admission') and version = 2), pg_temp.ist(today - 15, 40000)),
    (inst, mgr_u, 'campaign.created', c_adm::text, pg_temp.ist(today - 15, 39000)),
    (inst, mgr_u, 'leads.added', c_adm::text || ':150', pg_temp.ist(today - 15, 39300)),
    (inst, mgr_u, 'campaign.running', c_adm::text, pg_temp.ist(today - 14, 33000)),
    (inst, owner_u, 'script.published', (select id::text from public.script_versions where script_id = s_sale and version = 6), pg_temp.ist(today - 16, 40000)),
    (inst, owner_u, 'campaign.created', c_sale::text, pg_temp.ist(today - 14, 39000)),
    (inst, owner_u, 'leads.added', c_sale::text || ':420', pg_temp.ist(today - 14, 39300)),
    (inst, owner_u, 'campaign.running', c_sale::text, pg_temp.ist(today - 13, 33000)),
    (inst, owner_u, 'script.published', (select id::text from public.script_versions where script_id = s_sale and version = 7), pg_temp.ist(today - 9, 36000)),
    (inst, owner_u, 'script_test.started', (select test_id::text from demo_camps where k = 'sales'), pg_temp.ist(today - 9, 37800)),
    (inst, owner_u, 'money.exported', 'fees_report:240', pg_temp.ist(today - 7, 18 * 3600)),
    (inst, mgr_u, 'rep_target.set', sana::text || ':calls', pg_temp.ist(today - 6, 11 * 3600)),
    (inst, mgr_u, 'supervisor_note.added', ravi::text, pg_temp.ist(today - 4, 12 * 3600)),
    (inst, owner_u, 'supervisor_note.added', neha::text, pg_temp.ist(today - 3, 19 * 3600)),
    (inst, mgr_u, 'supervisor_note.added', amit::text, pg_temp.ist(today - 2, 16 * 3600 + 1200)),
    (inst, mgr_u, 'practice.assigned', amit::text || ':' || s_od::text, pg_temp.ist(today - 2, 16 * 3600 + 1300)),
    (inst, mgr_u, 'supervisor_note.added', priya::text, pg_temp.ist(today - 1, 18 * 3600 + 600)),
    (inst, mgr_u, 'campaign.created', c_ptm::text, now() - interval '3 hours'),
    (inst, mgr_u, 'leads.added', c_ptm::text || ':120', now() - interval '3 hours' + interval '2 minutes'),
    (inst, owner_u, 'script.draft_saved', (select id::text from public.script_versions where script_id = s_late and version = 1),
       pg_temp.ist(today, 0) + (now() - pg_temp.ist(today, 0)) / 3),
    -- Phase A.2: the fees office, the ledger import, scripts from the library, the Class 9 enquiries.
    (inst, owner_u, 'seat.invited', '5a1e0000-0000-4000-8000-000000000108', pg_temp.ist(today - 60, 9 * 3600 + 1800)),
    (inst, kav_u, 'students.imported', (select count(*) from demo_st)::text || ':0:0', pg_temp.ist(today - 58, 11 * 3600 + 1500)),
    (inst, owner_u, 'script.published', (select id::text from public.script_versions where script_id = s_od and version = 2), pg_temp.ist(today - 25, 41000)),
    (inst, mgr_u, 'script.published', (select id::text from public.script_versions where script_id = (select id from demo_scripts where k = 'adm9') and version = 2), pg_temp.ist(today - 5, 41000)),
    (inst, mgr_u, 'campaign.created', c_adm9::text, pg_temp.ist(today - 4, 41500)),
    (inst, mgr_u, 'leads.added', c_adm9::text || ':64', pg_temp.ist(today - 4, 41900)),
    (inst, mgr_u, 'campaign.running', c_adm9::text, pg_temp.ist(today - 3, 33000)),
    (inst, owner_u, 'script.published', (select id::text from public.script_versions where script_id = (select id from demo_scripts where k = 'polite8') and version = 2), pg_temp.ist(today - 1, 39000));
end $$;

-- ---------- 10b. Autopilot (docs/autopilot-plan.md, phase 1) ----------
-- Class 8 State Board (new this year, 48 students, a fee plan): Term 2 is due in 6 days and nobody has made a
-- calling list for it, so Today asks "Start Term 2 fees – Class 8 State Board". The owner switched "Create
-- calling lists for me" and "Send reminders to parents who agreed" to ask first while she tries Vector, so the
-- missed fee promises of Oct fees are a card too. "Balance work between callers" stays on: Vector put the
-- Class 9 enquiries first by itself (the planning run below), and the feed also shows two things it did
-- yesterday and this morning. Goals are set (90% of fees by the due date, 40 admissions this season).

do $$
declare
  inst    uuid := '5a1e0000-0000-4000-8000-000000000001';
  today   date := (select v::date from demo_ctx where k = 'today');
  kavita  uuid := '5a1e0000-0000-4000-8000-000000000108';
  owner_u uuid := (select user_id from demo_people where who = 'owner');
  plan    uuid := '5a1e0000-0000-4000-8000-000000000504';
  imp_t   timestamptz := pg_temp.ist((select v::date from demo_ctx where k = 'today') - 30, 11 * 3600);
  pf  text[] := (select a from demo_names where k = 'pf');
  sn  text[] := (select a from demo_names where k = 'sn');
  kid text[] := (select a from demo_names where k = 'kid');
  sid uuid;
  i   int;
begin
  insert into public.fee_plans (id, institute_id, academic_year, class_label, board, auto_apply, created_by, created_at, updated_at)
    values (plan, inst, '2026-27', '8th', 'State', true, kavita, imp_t - interval '10 minutes', imp_t - interval '10 minutes');
  insert into public.fee_plan_items (institute_id, plan_id, head, amount, due_date, who, sort_order, created_at, updated_at) values
    (inst, plan, 'Term 1 tuition', 12000, today - 130, 'all', 1, imp_t, imp_t),
    (inst, plan, 'Term 2 tuition', 12000, today + 6, 'all', 2, imp_t, imp_t);
  for i in 1 .. 48 loop
    sid := gen_random_uuid();
    insert into public.students (id, institute_id, admission_no, name, class_label, section, board, academic_year, parent_name,
                                 phone, status, source, created_by, created_at, updated_at)
      values (sid, inst, 'SCA/2026/' || lpad((900 + i)::text, 4, '0'), kid[1 + (i * 13) % 31] || ' ' || sn[1 + (i * 23) % 31],
              '8th', 'S', 'State', '2026-27', pf[1 + (i * 19) % 41] || ' ' || sn[1 + (i * 23) % 31],
              '+91' || (9999070000 + i)::text, 'active', 'import', kavita, imp_t, imp_t);
    insert into public.fee_items (institute_id, student_id, head, amount, due_date, academic_year, created_by, created_at, plan_item_id)
      select inst, sid, pi.head, pi.amount, pi.due_date, '2026-27', kavita, imp_t, pi.id
      from public.fee_plan_items pi where pi.plan_id = plan;
    insert into public.payments (institute_id, student_id, amount, paid_on, mode, note, recorded_by, created_at, opening)
      values (inst, sid, 12000, today - 30, 'other', 'Opening balance import', kavita, imp_t, true);
    if i % 6 = 0 then   -- a few have paid Term 2 already
      perform pg_temp.add_payment(sid, 12000, today - 1 - i % 5, pg_temp.pay_mode(), null, pg_temp.ist(today - 1 - i % 5, 11 * 3600 + i * 60));
    end if;
  end loop;

  insert into public.institute_goals (institute_id, fees_pct, admissions_target, season_start, updated_at, updated_by)
    values (inst, 90, 40, today - 60, now() - interval '20 days', owner_u);
  insert into public.autopilot_settings (institute_id, modes, updated_at, updated_by)
    values (inst, '{"fees_due_list": "ask", "missed_promises": "ask"}', now() - interval '20 days', owner_u);

  -- What Vector did yesterday evening and this morning (the jobs of phase 2; written here for the feed).
  insert into public.suggestions (institute_id, kind, dedupe_key, title, why, status, result, priority, created_at, decided_at, done_at) values
    (inst, 'close_paid', 'demo:close_paid:' || today, 'Closed paid parents',
     '{"text": "The fees office recorded their payments, so nobody calls them again."}', 'auto_done',
     '{"text": "Closed 6 parents in \"Oct fees – Class 10\" who paid at the office."}', 80,
     pg_temp.ist(today - 1, 19 * 3600), pg_temp.ist(today - 1, 19 * 3600), pg_temp.ist(today - 1, 19 * 3600)),
    (inst, 'balance_work', 'demo:balance:' || today, 'Gave waiting follow-ups to free callers',
     '{"text": "Their caller had not called in that list for a working day, and the parents were due a call back."}', 'auto_done',
     '{"text": "Gave 4 follow-ups in \"Admission follow-up\" to the next free callers."}', 80,
     pg_temp.ist(today, 9 * 3600 + 900), pg_temp.ist(today, 9 * 3600 + 900), pg_temp.ist(today, 9 * 3600 + 900));

  perform public.autopilot_plan(inst);
end $$;

select kind, status, title from public.suggestions where institute_id = '5a1e0000-0000-4000-8000-000000000001' order by status, priority;

-- ---------- 11. a short summary ----------

select k.k as campaign, c.status, count(distinct l.id) as leads,
       count(distinct l.id) filter (where l.status <> 'new') as called,
       (select count(*) from public.call_outcomes o where o.campaign_id = c.id) as calls,
       (select count(*) from public.call_outcomes o where o.campaign_id = c.id
          and o.dialled_at >= pg_temp.ist((select v::date from demo_ctx where k = 'today'), 0)) as calls_today,
       count(distinct l.id) filter (where l.status = 'promised'
          and l.promised_date < (select v::date from demo_ctx where k = 'today')) as broken_promises
from demo_camps k join public.campaigns c on c.id = k.id left join public.leads l on l.campaign_id = c.id
group by k.k, c.status, c.id order by k.k;

-- The ledger: students and what they owe now, and the payments of the last 8 weeks by mode.
select s.class_label as class, s.board, count(*) as students,
       count(*) filter (where b.balance_due_now > 0) as owing_now, sum(greatest(b.balance_due_now, 0)) as due_now,
       sum(b.balance_total) as due_this_year
from public.students s
cross join lateral public.student_balance_rows(s.institute_id, s.id) b
where s.institute_id = '5a1e0000-0000-4000-8000-000000000001'
group by s.class_label, s.board order by s.class_label nulls last;

select p.mode, count(*) filter (where p.reverses_id is null) as payments, count(*) filter (where p.reverses_id is not null) as reversals,
       sum(case when p.reverses_id is null then p.amount else -p.amount end) as net_amount
from public.payments p
where p.institute_id = '5a1e0000-0000-4000-8000-000000000001' and not p.opening
group by p.mode order by count(*) desc;

commit;

\echo 'Demo institute "Sunrise Coaching Academy (Demo)" loaded. Sign in with the demo logins (docs/demo.md).'
