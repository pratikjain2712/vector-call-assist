-- Demo institute "Sunrise Coaching Academy (Demo)" for sales demos. FAKE DATA ONLY: every name is made up and
-- every phone number is in the +91 9999xxxxxx block, which is used here as an obviously fake range.
--
-- Run AFTER all migrations and AFTER create-demo-users.mjs (it finds the 7 demo logins by email):
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
  role     text not null,          -- admin / rep
  kind     text,                   -- owner / manager / null
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
  ('sana',    'sana.sunrise@example.com',    'Sana',         'rep',   null,      '5a1e0000-0000-4000-8000-000000000107');

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

-- ---------- 4. the institute, people, devices, terms ----------

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
              pg_temp.ist(today - 75, 11 * 3600) + (p.seat::text > '5a1e0000-0000-4000-8000-000000000102')::int * interval '2 days');
    insert into public.profiles (id, full_name) values (p.user_id, p.label)
      on conflict (id) do update set full_name = excluded.full_name;
    -- Terms already accepted, so nobody is stopped by the terms panel.
    insert into public.accepted_terms (institute_id, seat_id, user_id, terms_version, text_hash, accepted_at)
      values (inst, p.seat, p.user_id, current_setting('demo.terms_version'), current_setting('demo.terms_hash'),
              pg_temp.ist(today - 72, 10 * 3600 + floor(random() * 20000)::int));
    -- A laptop for everyone, and a paired phone for each caller (Callers tab: Phone connected).
    insert into public.devices (seat_id, kind, fingerprint, paired_at)
      values (p.seat, 'laptop', 'demo-laptop-' || replace(p.seat::text, '-', ''), pg_temp.ist(today - 72, 12 * 3600));
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
  ('late_fee',  '5a1e0000-0000-4000-8000-000000000304');

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

  insert into public.scripts (id, institute_id, name, created_by, created_at, call_type_id) values
    ((select id from demo_scripts where k = 'fees'),      inst, 'Fees reminder',    owner, pg_temp.ist(today - 62, 40000), t_fees),
    ((select id from demo_scripts where k = 'sales'),     inst, 'Course sales',     owner, pg_temp.ist(today - 45, 40000), t_sale),
    ((select id from demo_scripts where k = 'admission'), inst, 'Admission check',  mgr,   pg_temp.ist(today - 21, 40000), t_adm),
    ((select id from demo_scripts where k = 'late_fee'),  inst, 'Late fee warning', owner, pg_temp.ist(today, 0) + (now() - pg_temp.ist(today, 0)) / 3, t_fees);

  -- Only the newest version of each script is published (one per script).
  insert into public.script_versions (script_id, institute_id, version, steps, pushbacks, change_note, published, created_at, created_by) values
    ((select id from demo_scripts where k = 'fees'), inst, 1, fees_v2, fees_pb - 3, 'First version', false, pg_temp.ist(today - 62, 40000), owner),
    ((select id from demo_scripts where k = 'fees'), inst, 2, fees_v2, fees_pb - 3, 'Ways to pay and office hours', false, pg_temp.ist(today - 56, 41000), owner),
    ((select id from demo_scripts where k = 'fees'), inst, 3, fees_v3, fees_pb, 'Part payment line, "Paying now" choice, ask for a date within 7 days', true, pg_temp.ist(today - 25, 42000), owner),
    ((select id from demo_scripts where k = 'admission'), inst, 1, adm_v1, adm_pb, 'First version', false, pg_temp.ist(today - 21, 40000), mgr),
    ((select id from demo_scripts where k = 'admission'), inst, 2, adm_v2, adm_pb, 'Visiting hours and address', true, pg_temp.ist(today - 15, 40000), mgr),
    ((select id from demo_scripts where k = 'late_fee'), inst, 1, late_v1, late_pb, 'Draft', false, pg_temp.ist(today, 0) + (now() - pg_temp.ist(today, 0)) / 3, owner);
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

-- ---------- 7. campaigns and leads ----------

create temp table demo_camps (
  id          uuid primary key,
  k           text not null unique,     -- oct / sales / adm / sept / ptm
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
  ('5a1e0000-0000-4000-8000-000000000201', 'oct',   'fees',      'fees',      3, 23, 0, 14),
  ('5a1e0000-0000-4000-8000-000000000202', 'sales', 'sales',     'sales',     6, 13, 0, 0),
  ('5a1e0000-0000-4000-8000-000000000203', 'adm',   'admission', 'admission', 2, 14, 0, 0),
  ('5a1e0000-0000-4000-8000-000000000204', 'sept',  'fees',      'fees',      2, 53, 24, 0),
  ('5a1e0000-0000-4000-8000-000000000205', 'ptm',   'event',     null,        null, null, null, 0);

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
  pf text[] := array['Rakesh', 'Sunita', 'Manoj', 'Priti', 'Suresh', 'Kavita', 'Ajay', 'Meena', 'Vijay', 'Rekha',
                     'Sanjay', 'Anjali', 'Deepak', 'Pooja', 'Rajesh', 'Neeta', 'Anil', 'Seema', 'Ashok', 'Geeta',
                     'Mahesh', 'Shalini', 'Prakash', 'Usha', 'Ramesh', 'Vandana', 'Dinesh', 'Lata', 'Nitin', 'Swati',
                     'Sachin', 'Rupali', 'Harish', 'Asha', 'Girish', 'Jyoti', 'Mukesh', 'Smita', 'Pankaj', 'Nisha', 'Alok'];
  sn text[] := array['Sharma', 'Patel', 'Mehta', 'Iyer', 'Nair', 'Reddy', 'Gupta', 'Joshi', 'Kulkarni', 'Deshmukh',
                     'Singh', 'Verma', 'Rao', 'Pillai', 'Shah', 'Desai', 'Chauhan', 'Bose', 'Das', 'Menon', 'Pandey',
                     'Mishra', 'Kapoor', 'Malhotra', 'Agarwal', 'Jain', 'Shetty', 'Naik', 'Patil', 'Yadav', 'Khan'];
  kid text[] := array['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ananya', 'Diya',
                      'Aadhya', 'Saanvi', 'Myra', 'Kiara', 'Riya', 'Anika', 'Kabir', 'Rohan', 'Tanvi', 'Shreya',
                      'Aryan', 'Dhruv', 'Meera', 'Nikhil', 'Pranav', 'Sneha', 'Ira', 'Yash', 'Om', 'Tara', 'Zoya'];
  adult text[] := array['Rahul', 'Karan', 'Sneha', 'Pooja', 'Akash', 'Nidhi', 'Varun', 'Komal', 'Siddharth', 'Payal',
                        'Abhishek', 'Ritika', 'Gaurav', 'Neha', 'Rohit', 'Shruti', 'Manish', 'Divya', 'Kunal', 'Isha',
                        'Tushar', 'Megha', 'Harsh', 'Aditi', 'Vikas', 'Sakshi', 'Saurabh', 'Prachi', 'Ankit', 'Juhi', 'Imran'];
begin
  insert into public.campaigns (id, institute_id, name, call_type_id, script_id, start_date, end_date, status,
                                daily_target, share_mode, call_hours, created_by, created_at, goal) values
    (c_oct, inst, 'Oct fees – Class 10', (select id from public.call_types where key = 'fees' and institute_id is null),
     (select id from demo_scripts where k = 'fees'), today - 23, today + 7, 'running', 60, 'equal', null, owner,
     pg_temp.ist(today - 24, 39000), null),
    (c_sale, inst, 'Course sales – Data Analytics', (select id from public.call_types where key = 'sales' and institute_id is null),
     (select id from demo_scripts where k = 'sales'), today - 13, today + 18, 'running', 80, 'equal', null, owner,
     pg_temp.ist(today - 14, 39000), 100),
    (c_adm, inst, 'Admission follow-up', (select id from public.call_types where key = 'admission' and institute_id is null),
     (select id from demo_scripts where k = 'admission'), today - 14, null, 'running', 35, 'equal', null, mgr,
     pg_temp.ist(today - 15, 39000), 70),
    (c_sept, inst, 'Sept fees – Class 9', (select id from public.call_types where key = 'fees' and institute_id is null),
     (select id from demo_scripts where k = 'fees'), today - 53, today - 24, 'running', 40, 'equal', null, owner,
     pg_temp.ist(today - 54, 39000), null),
    (c_ptm, inst, 'PTM reminder – Nov', (select id from public.call_types where key = 'event' and institute_id is null),
     null, today + 8, today + 12, 'draft', null, 'equal', null, mgr, now() - interval '3 hours', null);

  insert into public.campaign_members (campaign_id, seat_id, institute_id, added_at) values
    (c_oct, ravi, inst, pg_temp.ist(today - 24, 40000)), (c_oct, amit, inst, pg_temp.ist(today - 24, 40000)),
    (c_sale, priya, inst, pg_temp.ist(today - 14, 40000)), (c_sale, neha, inst, pg_temp.ist(today - 14, 40000)),
    (c_adm, sana, inst, pg_temp.ist(today - 15, 40000)),
    (c_sept, ravi, inst, pg_temp.ist(today - 54, 40000));

  -- Oct fees: 240 parents of Class 10 (half 10-A, half 10-B), shared equally between Ravi and Amit.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, assigned_seat_id, created_at)
  select inst, c_oct, pf[1 + (i * 7) % 41] || ' ' || sn[1 + (i * 11) % 31],
         '+91' || (9999010000 + i)::text,
         jsonb_build_object('student', kid[1 + (i * 5) % 31] || ' ' || sn[1 + (i * 11) % 31],
                            'class', case when i % 2 = 0 then '10-A' else '10-B' end),
         case when i % 4 = 0 then 9000 else 18000 end,
         case when i % 2 = 1 then ravi else amit end,
         pg_temp.ist(today - 24, 40000) + i * interval '1 microsecond'
  from generate_series(1, 240) i;

  -- Course sales: 420 people who asked about the Data Analytics course, Priya and Neha.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, assigned_seat_id, created_at)
  select inst, c_sale, adult[1 + (i * 7) % 31] || ' ' || sn[1 + (i * 13) % 31],
         '+91' || (9999030000 + i)::text,
         jsonb_build_object('city', (array['Pune', 'Mumbai', 'Nagpur', 'Nashik', 'Thane', 'Aurangabad'])[1 + i % 6],
                            'source', (array['Instagram ad', 'Website form', 'Friend', 'Free webinar', 'Google ad'])[1 + (i * 3) % 5],
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
                            'enquiry', (array['Walk-in', 'Website', 'Phone call', 'Seminar'])[1 + (i * 3) % 4]),
         sana, pg_temp.ist(today - 15, 40000) + i * interval '1 microsecond'
  from generate_series(1, 150) i;

  -- Sept fees: 212 parents of Class 9, Ravi (closed at the end).
  insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, assigned_seat_id, created_at)
  select inst, c_sept, pf[1 + (i * 13) % 41] || ' ' || sn[1 + (i * 5) % 31],
         '+91' || (9999020000 + i)::text,
         jsonb_build_object('student', kid[1 + (i * 3) % 31] || ' ' || sn[1 + (i * 5) % 31],
                            'class', case when i % 2 = 0 then '9-A' else '9-B' end),
         case when i % 5 = 0 then 7500 else 15000 end, ravi,
         pg_temp.ist(today - 54, 40000) + i * interval '1 microsecond'
  from generate_series(1, 212) i;

  -- PTM reminder (draft): the first 120 Class 10 parents again, not shared yet.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, created_at)
  select inst, c_ptm, l.name, l.phone, l.extra, now() - interval '3 hours' + row_number() over (order by l.created_at) * interval '1 microsecond'
  from public.leads l where l.campaign_id = c_oct
  order by l.created_at limit 120;

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
               when 'problem' then 4 when 'fees' then 4 else 5 end];

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
  month0  timestamptz := (date_trunc('month', now() at time zone 'Asia/Kolkata'))::timestamp at time zone 'Asia/Kolkata';
  r_conc  uuid := (select id from public.call_type_results where institute_id = inst and key = 'fee_concession');
  r_adm   uuid := (select id from public.call_type_results where institute_id = inst and key = 'admission_done');
begin
  -- "Callers right now": the caller screens report presence every minute. seen_at is set a few hours ahead so
  -- the statuses stay live for the whole demo (they are only read as "seen in the last 3 minutes").
  insert into public.seat_presence (seat_id, institute_id, seen_at, online_since, on_call, phone_ok, phone_offline_since) values
    (ravi,  inst, now() + interval '8 hours', pg_temp.ist(today, 9 * 3600 + 1500), true,  true,  null),
    (priya, inst, now() + interval '8 hours', pg_temp.ist(today, 9 * 3600 + 1700), false, true,  null),
    (neha,  inst, now() + interval '8 hours', pg_temp.ist(today, 9 * 3600 + 1600), true,  true,  null),
    (amit,  inst, now() + interval '8 hours', now() - interval '45 minutes',        false, true,  null),
    (sana,  inst, now() + interval '8 hours', pg_temp.ist(today, 9 * 3600 + 1800), false, false, sana_off);

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

  -- Practice mode: Amit is asked to practise the fees script (not done yet).
  insert into public.practice_assignments (institute_id, seat_id, script_id, note, assigned_by, assigned_at) values
    (inst, amit, s_fees, 'Practise a short opening: name, school, fee and date in under 25 seconds.', mgr, pg_temp.ist(today - 2, 16 * 3600 + 1300));

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
    (inst, owner_u, 'leads.added', c_sept::text || ':212', pg_temp.ist(today - 54, 39300)),
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
    (inst, mgr_u, 'practice.assigned', amit::text || ':' || s_fees::text, pg_temp.ist(today - 2, 16 * 3600 + 1300)),
    (inst, mgr_u, 'supervisor_note.added', priya::text, pg_temp.ist(today - 1, 18 * 3600 + 600)),
    (inst, mgr_u, 'campaign.created', c_ptm::text, now() - interval '3 hours'),
    (inst, mgr_u, 'leads.added', c_ptm::text || ':120', now() - interval '3 hours' + interval '2 minutes'),
    (inst, owner_u, 'script.draft_saved', (select id::text from public.script_versions where script_id = s_late and version = 1),
       pg_temp.ist(today, 0) + (now() - pg_temp.ist(today, 0)) / 3);
end $$;

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

commit;

\echo 'Demo institute "Sunrise Coaching Academy (Demo)" loaded. Sign in with the demo logins (docs/demo.md).'
