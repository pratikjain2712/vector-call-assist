-- Vector Autopilot, phase 1: the engine (docs/autopilot-plan.md, sections 2, 5 and 6). Apply after
-- 20261026110000_fee_plans_discounts.sql.
--
-- 1. Tables: institute_goals (fees % by the due date, admissions and sales targets, term and season dates),
--    autopilot_settings (per action kind off / ask / auto, one pause switch, language of the call scripts),
--    suggestions (one row per decision Vector proposes or took: kind, dedupe key, title, why / impact / plan
--    jsonb with the numbers, status, undo), automation_runs (one row per planning run). RLS on, no browser
--    grants: everything goes through the functions below.
-- 2. campaigns.focus_seats (uuid[], default {}): the callers a list is planned for. The list stays open to every
--    caller; these callers see it first in their picker, with their part of the daily target (my_campaigns).
--    campaigns.wa_reminders: WhatsApp payment reminders wanted for this list (sent by the reminder job, with
--    consent and caps).
-- 3. Helpers: caller scores per call type (picked-up calls, good results, score, spare capacity), the best
--    two-hour window to call per class (from the insights call data), working days, list names.
-- 4. Five rules, each a function returning candidate suggestions (jsonb), so a rule can be added without
--    touching the rest:
--      fees_due_list       a fee due within 7 days (fee plans first, else fee items) with parents who still owe
--                          it → create the class's fees calling list (or add the new parents to it)
--      missed_promises     promised date passed, not paid (3 or more) → top of their callers' lists, and one
--                          WhatsApp reminder for parents who agreed (when WhatsApp is connected)
--      enquiries_uncalled  admission / sales leads waiting in the pool for over 24 hours, never called (5 or
--                          more in a list)
--                          → due now, and the best callers with spare capacity see the list first
--      list_behind_pace    a running list whose last 3 working days' pace will not reach its people by the end
--                          date (pace < 80% of what is needed, 10 or more people open) → add a focus caller,
--                          best hours, new daily target
--      setup_gaps          common answers not filled, WhatsApp not connected, no goals → one "finish setup" card
-- 5. autopilot_plan(inst): runs the rules, keeps one open suggestion per dedupe key (refreshing its numbers),
--    expires ones that no longer hold, and carries out the kinds set to 'auto' (unless paused), recorded as
--    auto_done with what Undo needs. my_suggestions(), accept_suggestion(id, overrides), undo_suggestion(id)
--    (24 hours), dismiss_suggestion(id, snooze days), autopilot_numbers() (the three numbers on Today),
--    settings and goals, autopilot_list_defaults() / autopilot_create_list() for the one-screen New calling
--    list, caller_scores(), autopilot_claim_reminders() for the WhatsApp reminder job.
-- Money rules (docs/data-contract.md): suggestions keep amounts in keys named amount / *_amount; every function
-- that returns them strips those keys unless can_see_money(). Titles and texts never hold an amount.

-- =====================================================================================================
-- 1. Tables and columns
-- =====================================================================================================

alter table public.campaigns
  add column if not exists focus_seats uuid[] not null default '{}',
  add column if not exists wa_reminders boolean not null default false;
alter table public.campaigns drop constraint if exists campaigns_focus_seats_size;
alter table public.campaigns add constraint campaigns_focus_seats_size check (cardinality(focus_seats) <= 20);

create table public.institute_goals (
  institute_id       uuid primary key references public.institutes (id) on delete cascade,
  fees_pct           int not null default 90 check (fees_pct between 1 and 100),
  admissions_target  int check (admissions_target between 1 and 100000),
  sales_target       int check (sales_target between 1 and 100000),
  term_start         date,
  term_end           date,
  season_start       date,
  season_end         date,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references auth.users (id) on delete set null,
  check (term_start is null or term_end is null or term_end >= term_start),
  check (season_start is null or season_end is null or season_end >= season_start)
);

create table public.autopilot_settings (
  institute_id  uuid primary key references public.institutes (id) on delete cascade,
  paused        boolean not null default false,
  paused_at     timestamptz,
  -- { "<kind>": "off" | "ask" | "auto" }; a kind that is not listed has its default (ap_default_mode).
  modes         jsonb not null default '{}'::jsonb check (jsonb_typeof(modes) = 'object' and length(modes::text) <= 2000),
  language      text not null default 'en' check (language in ('en', 'hinglish')),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null
);

create table public.suggestions (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  kind          text not null check (kind in ('fees_due_list', 'missed_promises', 'enquiries_uncalled', 'list_behind_pace',
                                              'setup_gaps', 'new_list', 'balance_work', 'close_paid')),
  dedupe_key    text not null check (length(dedupe_key) between 1 and 200),
  title         text not null check (length(title) between 1 and 200),
  why           jsonb not null default '{}'::jsonb check (jsonb_typeof(why) = 'object' and length(why::text) <= 20000),
  impact        jsonb not null default '{}'::jsonb check (jsonb_typeof(impact) = 'object' and length(impact::text) <= 8000),
  plan          jsonb not null default '{}'::jsonb check (jsonb_typeof(plan) = 'object' and length(plan::text) <= 60000),
  priority      int not null default 50,
  status        text not null default 'new'
                check (status in ('new', 'accepted', 'dismissed', 'snoozed', 'expired', 'auto_done', 'undone')),
  snooze_until  timestamptz,
  undo          jsonb,
  result        jsonb,
  expires_at    timestamptz,
  decided_by    uuid references public.seats (id) on delete set null,
  decided_at    timestamptz,
  done_at       timestamptz,
  undone_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- One open suggestion per institute and key: running the rules twice does nothing twice.
create unique index suggestions_open_key on public.suggestions (institute_id, dedupe_key) where status in ('new', 'snoozed');
create index suggestions_by_status on public.suggestions (institute_id, status, created_at desc);
create index suggestions_by_key on public.suggestions (institute_id, dedupe_key);

create table public.automation_runs (
  id            bigint generated always as identity primary key,
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  job           text not null check (job ~ '^[a-z][a-z0-9_]{1,39}$'),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  counts        jsonb,
  error         text check (length(error) <= 500),
  run_by        uuid references auth.users (id) on delete set null
);
create index automation_runs_latest on public.automation_runs (institute_id, job, started_at desc);

alter table public.institute_goals enable row level security;
alter table public.autopilot_settings enable row level security;
alter table public.suggestions enable row level security;
alter table public.automation_runs enable row level security;
revoke all on public.institute_goals, public.autopilot_settings, public.suggestions, public.automation_runs from public, anon, authenticated;

-- =====================================================================================================
-- 2. Small helpers (internal: granted to nobody)
-- =====================================================================================================

-- The kinds that are about calling (managers see these; Accounts never do).
create or replace function public.ap_calling_kind(p_kind text)
returns boolean language sql immutable set search_path = public
as $$ select p_kind in ('fees_due_list', 'missed_promises', 'enquiries_uncalled', 'list_behind_pace', 'new_list',
                        'balance_work', 'close_paid') $$;

-- Defaults (plan section 2): creating fees lists, reminders to parents who agreed and balancing work are "do it,
-- tell me, let me undo"; setup gaps can only ask.
create or replace function public.ap_default_mode(p_kind text)
returns text language sql immutable set search_path = public
as $$ select case when p_kind in ('fees_due_list', 'missed_promises', 'enquiries_uncalled', 'list_behind_pace') then 'auto'
                  else 'ask' end $$;

create or replace function public.ap_mode(p_inst uuid, p_kind text)
returns text language sql stable security definer set search_path = public
as $$
  select case when p_kind = 'setup_gaps' then
                case when (select s.modes ->> p_kind from public.autopilot_settings s where s.institute_id = p_inst) = 'off'
                     then 'off' else 'ask' end
              else coalesce((select s.modes ->> p_kind from public.autopilot_settings s where s.institute_id = p_inst),
                            public.ap_default_mode(p_kind)) end
$$;

create or replace function public.ap_paused(p_inst uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select s.paused from public.autopilot_settings s where s.institute_id = p_inst), false) $$;

-- Working days (Monday to Saturday) from p_from to p_to, both counted; at least 1.
create or replace function public.ap_working_days(p_from date, p_to date)
returns int language sql immutable set search_path = public
as $$
  select greatest(1, (select count(*)::int from generate_series(p_from, greatest(p_from, p_to), interval '1 day') d
                      where extract(isodow from d) < 7))
$$;

-- '5 parents', '1 parent'.
create or replace function public.ap_n(p_n numeric, p_one text, p_many text)
returns text language sql immutable set search_path = public
as $$ select public.ix_count(p_n) || ' ' || case when p_n = 1 then p_one else p_many end $$;

-- 'Ravi', 'Ravi and Neha', 'Ravi, Neha and Amit'.
create or replace function public.ap_names(p_names text[])
returns text language sql immutable set search_path = public
as $$
  select case coalesce(cardinality(p_names), 0)
           when 0 then ''
           when 1 then p_names[1]
           else array_to_string(p_names[1:cardinality(p_names) - 1], ', ') || ' and ' || p_names[cardinality(p_names)] end
$$;

-- 'Class 8 State Board', 'Class 10 CBSE', 'Nursery'.
create or replace function public.ap_class_text(p_class text, p_board text)
returns text language sql immutable set search_path = public
as $$
  select nullif(concat_ws(' ',
           case when p_class ~ '^\d{1,2}(st|nd|rd|th)?$' then 'Class ' || substring(p_class from '^\d+') else nullif(trim(p_class), '') end,
           case p_board when 'State' then 'State Board' when 'Other' then null else p_board end), '')
$$;

-- A fees list name: 'Term 2 fees – Class 8 State Board' (from the fee name 'Term 2 tuition').
create or replace function public.ap_list_name(p_head text, p_class text, p_board text, p_due date)
returns text language sql immutable set search_path = public
as $$
  select left(coalesce(nullif(trim(regexp_replace(coalesce(p_head, ''), '\s*(tuition|fees?)\s*$', '', 'i')), '') || ' fees',
                       'Fees due ' || to_char(p_due, 'FMDD Mon'))
              || coalesce(' – ' || public.ap_class_text(p_class, p_board), ''), 120)
$$;

-- campaigns.call_hours for a two-hour window from hour h, Monday to Saturday.
create or replace function public.ap_call_hours(p_hour int, p_tz text)
returns jsonb language sql immutable set search_path = public
as $$
  select case when p_hour is null then null else
    jsonb_build_object('tz', coalesce(p_tz, 'Asia/Kolkata'), 'source', 'autopilot',
      'days', (select jsonb_object_agg(d, jsonb_build_array(p_hour, p_hour + 1))
               from unnest(array['mon', 'tue', 'wed', 'thu', 'fri', 'sat']) d)) end
$$;

-- Removes money from a jsonb value: every key named amount or ending in _amount, at any depth.
create or replace function public.ap_strip_money(p jsonb)
returns jsonb language plpgsql immutable set search_path = public
as $$
declare out jsonb;
begin
  if p is null then return null; end if;
  if jsonb_typeof(p) = 'object' then
    select coalesce(jsonb_object_agg(k, public.ap_strip_money(v)), '{}'::jsonb) into out
      from jsonb_each(p) e(k, v) where k <> 'amount' and k !~ '_amount$';
    return out;
  elsif jsonb_typeof(p) = 'array' then
    select coalesce(jsonb_agg(public.ap_strip_money(v) order by i), '[]'::jsonb) into out
      from jsonb_array_elements(p) with ordinality a(v, i);
    return out;
  end if;
  return p;
end $$;

-- The best two-hour window to call (pickup rate) over the last 4 weeks: calls of lists of that class, else of
-- the whole institute. Needs 50 calls and 20 in the window (like the weekly brief). Null when not known.
-- { hour, label '7–9 pm', source 'class' | 'institute', rate }.
create or replace function public.ap_best_hours(p_inst uuid, p_class text)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  tz  text := public.institute_tz(p_inst);
  pass int;
  cls text;
  n   bigint;
  h   int;
  rate numeric;
begin
  for pass in 1 .. 2 loop
    cls := case when pass = 1 then nullif(trim(coalesce(p_class, '')), '') end;
    continue when pass = 1 and cls is null;
    with calls as (
      select x.talked, extract(hour from x.happened_at at time zone tz)::int as hr
      from public.ix_campaign_calls(p_inst, null, now() - interval '28 days', now() + interval '1 minute') x
      join public.campaigns c on c.id = x.campaign_id
      where cls is null or lower(c.class_label) = lower(cls)
    )
    select (select count(*) from calls), w.h, w.rate into n, h, rate
    from (select g.h, count(*) filter (where c.talked)::numeric / count(*) as rate, count(*) as calls
          from calls c cross join generate_series(8, 20) g(h)
          where c.hr in (g.h, g.h + 1)
          group by g.h having count(*) >= 20) w
    order by w.rate desc, w.calls desc, w.h
    limit 1;
    if h is not null and n >= 50 then
      return jsonb_build_object('hour', h, 'label', public.ix_hour_range(h),
                                'source', case when cls is null then 'institute' else 'class' end, 'rate', round(rate, 2));
    end if;
    h := null;
  end loop;
  return null;
end $$;

-- Caller scores for one call type (null = all), last p_days days: picked-up calls, good results, a score
-- (good results per 100 picked-up calls, pulled towards 20 while there are few calls), the caller's daily
-- calls target (rep_targets, else 40), what focus lists already ask of them a day, and the spare capacity.
-- Callers only (rep seats), active. Ordered best first: spare capacity, score, picked-up calls.
create or replace function public.ap_caller_scores(p_inst uuid, p_type text, p_days int default 60)
returns table (seat_id uuid, label text, picked bigint, good bigint, score numeric, calls_target int, focus_load int, spare int)
language sql stable security definer set search_path = public
as $$
  with calls as (
    select x.seat_id, count(*) filter (where x.talked) as picked, count(*) filter (where x.talked and x.good) as good
    from public.ix_campaign_calls(p_inst, null, now() - make_interval(days => greatest(1, coalesce(p_days, 60))), now() + interval '1 minute') x
    join public.campaigns c on c.id = x.campaign_id
    join public.call_types t on t.id = c.call_type_id
    where p_type is null or t.key = p_type
    group by x.seat_id
  ), load as (
    select f.seat_id, sum(ceil(c.daily_target::numeric / greatest(1, cardinality(c.focus_seats))))::int as load
    from public.campaigns c cross join lateral unnest(c.focus_seats) f(seat_id)
    where c.institute_id = p_inst and c.status in ('running', 'paused') and c.daily_target is not null
    group by f.seat_id
  )
  select s.id, s.label, coalesce(k.picked, 0), coalesce(k.good, 0),
         round(100.0 * (coalesce(k.good, 0) + 1) / (coalesce(k.picked, 0) + 5), 1),
         coalesce(t.daily_target, 40), coalesce(l.load, 0), coalesce(t.daily_target, 40) - coalesce(l.load, 0)
  from public.seats s
  left join calls k on k.seat_id = s.id
  left join load l on l.seat_id = s.id
  left join public.rep_targets t on t.seat_id = s.id and t.metric = 'calls'
  where s.institute_id = p_inst and s.status = 'active' and s.role = 'rep'
  order by (coalesce(t.daily_target, 40) - coalesce(l.load, 0) > 0) desc,
           round(100.0 * (coalesce(k.good, 0) + 1) / (coalesce(k.picked, 0) + 5), 1) desc, coalesce(k.picked, 0) desc, s.label
$$;

-- A live script of the call type for the plan: the name has the hint first ('reminder', 'overdue'), then the
-- script most used in the last 60 days. Needs the Scripts add-on (checked without a login).
create or replace function public.ap_pick_script(p_inst uuid, p_type text, p_hint text)
returns table (id uuid, name text)
language sql stable security definer set search_path = public
as $$
  select s.id, s.name
  from public.scripts s
  join public.call_types t on t.id = s.call_type_id and t.key = p_type
  where s.institute_id = p_inst and public.institute_has_feature(p_inst, 'scripts')
    and exists (select 1 from public.script_versions v where v.script_id = s.id and v.published)
  order by (p_hint is not null and s.name ilike '%' || p_hint || '%') desc,
           (select count(*) from public.call_outcomes o where o.institute_id = p_inst and o.script_id = s.id::text
              and o.uploaded_at > now() - interval '60 days') desc,
           s.created_at desc
  limit 1
$$;

-- A template of the library for a purpose, in the institute's language when there is one.
create or replace function public.ap_pick_template(p_inst uuid, p_base text)
returns jsonb language sql stable security definer set search_path = public
as $$
  select jsonb_build_object('key', t.key, 'name', t.name)
  from public.script_templates t
  where t.active and t.key in (p_base, p_base || '_hinglish')
  order by (t.key = p_base || '_hinglish') = (coalesce((select a.language from public.autopilot_settings a where a.institute_id = p_inst), 'en') = 'hinglish') desc
  limit 1
$$;

-- The callers a plan suggests: the top n by score with spare capacity, not in p_skip; when nobody has spare
-- capacity, the top n anyway. [{ seat_id, label, score, spare }] for the options list, ids in "picked".
create or replace function public.ap_plan_callers(p_inst uuid, p_type text, p_n int, p_skip uuid[] default '{}')
returns jsonb language sql stable security definer set search_path = public
as $$
  with s as (select x.*, row_number() over () as rk from public.ap_caller_scores(p_inst, p_type) x)
  select jsonb_build_object(
    'options', coalesce((select jsonb_agg(jsonb_build_object('seat_id', s.seat_id, 'label', s.label, 'score', s.score,
                                                             'spare', s.spare, 'picked', s.picked) order by s.rk) from s), '[]'::jsonb),
    'picked', coalesce((select jsonb_agg(p.seat_id order by p.rk) from (
                select s.seat_id, s.rk from s where not (s.seat_id = any (coalesce(p_skip, '{}'))) order by (s.spare > 0) desc, s.rk limit greatest(0, p_n)) p),
              '[]'::jsonb))
$$;

-- The common plan fields of a new list: callers, hours, target, end date. p_people: how many to call.
create or replace function public.ap_plan_common(p_inst uuid, p_type text, p_class text, p_people int, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  today date := public.ledger_today(p_inst);
  ends  date := greatest(coalesce(p_end, today + 14), today + 1);
  wd    int := public.ap_working_days(today, ends);
  cl    jsonb := public.ap_plan_callers(p_inst, p_type, 2);
  n     int := jsonb_array_length(cl -> 'picked');
  best  jsonb := public.ap_best_hours(p_inst, p_class);
  daily int := case when coalesce(p_people, 0) > 0 then least(10000, ceil(p_people::numeric / wd)::int) end;
begin
  return jsonb_build_object(
    'callers', cl -> 'picked', 'caller_options', cl -> 'options',
    'hour', best -> 'hour', 'hours_label', coalesce(best ->> 'label', 'Any time'), 'hours_source', best ->> 'source',
    'start_date', today, 'end_date', ends, 'working_days', wd,
    'daily_target', daily,
    'per_caller_target', case when daily is not null then ceil(daily::numeric / greatest(1, n))::int end,
    'whatsapp_available', exists (select 1 from public.whatsapp_accounts a where a.institute_id = p_inst and a.status = 'connected'));
end $$;

-- Who is acting: the active seat of the login in this institute, or null (the system: service role).
create or replace function public.ap_actor_seat(p_inst uuid)
returns uuid language sql stable security definer set search_path = public
as $$ select s.id from public.seats s where s.institute_id = p_inst and s.user_id = auth.uid() and s.status = 'active' limit 1 $$;

-- =====================================================================================================
-- 3. Rules. Each returns candidate suggestions:
--    { kind, key, title, why {text, …}, impact {text, …}, plan {…}, priority, expires_at }
-- =====================================================================================================

-- (a) A fee due within 7 days with parents who still owe it → a fees calling list for that class and board.
create or replace function public.ap_rule_fees_due(p_inst uuid)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  today  date := public.ledger_today(p_inst);
  r      record;
  camp   public.campaigns;
  n_par  int;
  n_noph int;
  amt    numeric;
  common jsonb;
  tmpl   jsonb;
  scr    record;
  nm     text;
  wa     boolean := exists (select 1 from public.whatsapp_accounts a where a.institute_id = p_inst and a.status = 'connected');
  ctext  text;
begin
  for r in
    with plan_groups as (
      -- Fee plans first (Fees basics): the class's plan items due in the window.
      select lower(p.class_label) as cls_key, min(p.class_label) as cls, p.board, i.due_date,
             coalesce(mode() within group (order by i.head) filter (where i.who = 'all'), min(i.head)) as head
      from public.fee_plans p
      join public.fee_plan_items i on i.plan_id = p.id and i.removed_at is null
      where p.institute_id = p_inst and i.due_date between today and today + 7
      group by 1, p.board, i.due_date
    ), item_groups as (
      -- Classes without a plan: their fee items.
      select lower(s.class_label) as cls_key, min(s.class_label) as cls, s.board, f.due_date,
             coalesce(mode() within group (order by f.head) filter (where f.head !~* '(bus|transport)'), min(f.head)) as head
      from public.fee_items f
      join public.students s on s.id = f.student_id
      where f.institute_id = p_inst and not f.is_void and s.status = 'active' and s.class_label is not null
        and f.due_date between today and today + 7
        and not exists (select 1 from public.fee_plans p where p.institute_id = p_inst and lower(p.class_label) = lower(s.class_label)
                          and p.board is not distinct from s.board)
      group by 1, s.board, f.due_date
    )
    select * from plan_groups union all select * from item_groups
    order by due_date, cls_key, board
  loop
    -- Parents who owe by that date (one per phone, like accounts_create_fees_campaign).
    select count(distinct s.phone), count(*) filter (where s.phone is null), sum(b.balance_due_now)
      into n_par, n_noph, amt
    from public.students s
    join public.student_balance_rows(p_inst, null, r.due_date) b on b.student_id = s.id
    where s.institute_id = p_inst and s.status = 'active' and lower(s.class_label) = r.cls_key
      and s.board is not distinct from r.board and b.balance_due_now > 0;
    continue when coalesce(n_par, 0) = 0;
    ctext := coalesce(public.ap_class_text(r.cls, r.board), r.cls);

    -- A fees list for the class and board that is not closed already covers this due date: add the new parents.
    select c.* into camp from public.campaigns c join public.call_types t on t.id = c.call_type_id and t.key = 'fees'
     where c.institute_id = p_inst and c.status in ('draft', 'running', 'paused')
       and lower(coalesce(c.class_label, '')) = r.cls_key and c.board is not distinct from r.board
       and (c.fees_due_by between r.due_date - 3 and r.due_date + 3
            or (c.fees_due_by is null and c.created_at > now() - interval '30 days'))
     order by c.created_at desc limit 1;
    if camp.id is not null then
      select count(distinct s.phone), sum(b.balance_due_now) into n_par, amt
      from public.students s
      join public.student_balance_rows(p_inst, null, r.due_date) b on b.student_id = s.id
      where s.institute_id = p_inst and s.status = 'active' and lower(s.class_label) = r.cls_key
        and s.board is not distinct from r.board and b.balance_due_now > 0 and s.phone is not null
        and not exists (select 1 from public.leads l where l.campaign_id = camp.id and (l.student_id = s.id or l.phone = s.phone));
      continue when coalesce(n_par, 0) = 0;
      return next jsonb_build_object(
        'kind', 'fees_due_list', 'key', 'fees_topup:' || camp.id || ':' || r.due_date || ':' || today,
        'title', 'Add ' || public.ap_n(n_par, 'parent', 'parents') || ' to "' || camp.name || '"',
        'why', jsonb_build_object('text', public.ap_n(n_par, 'parent', 'parents') || ' of ' || ctext || ' owe fees due '
                                          || to_char(r.due_date, 'FMDD Mon') || ' and are not on the list yet.',
                                  'parents', n_par, 'due_date', r.due_date, 'amount', amt),
        'impact', jsonb_build_object('text', 'Their callers reach them before the due date.'),
        'plan', jsonb_build_object('action', 'topup', 'call_type', 'fees', 'campaign_id', camp.id, 'name', camp.name,
                                   'class_label', r.cls, 'board', r.board, 'due_by', r.due_date, 'parents', n_par),
        'priority', 15 + (r.due_date - today), 'expires_at', r.due_date + 1);
      continue;
    end if;

    nm := public.ap_list_name(r.head, r.cls, r.board, r.due_date);
    common := public.ap_plan_common(p_inst, 'fees', r.cls, n_par, r.due_date + 7);
    tmpl := public.ap_pick_template(p_inst, 'fees_reminder_polite');
    select * into scr from public.ap_pick_script(p_inst, 'fees', 'reminder');
    return next jsonb_build_object(
      'kind', 'fees_due_list', 'key', 'fees_list:' || r.cls_key || ':' || lower(coalesce(r.board, '')) || ':' || r.due_date,
      'title', 'Start "' || nm || '"',
      'why', jsonb_build_object('text', initcap(substr(r.head, 1, 1)) || substr(r.head, 2) || ' is due in '
                                        || public.ap_n(r.due_date - today, 'day', 'days') || ' (' || to_char(r.due_date, 'FMDD Mon')
                                        || '). ' || public.ap_n(n_par, 'parent', 'parents') || ' of ' || ctext || ' still owe it.',
                                'parents', n_par, 'no_phone', n_noph, 'due_date', r.due_date, 'days_left', r.due_date - today,
                                'amount', amt),
      'impact', jsonb_build_object('text', 'About ' || public.ap_n((common ->> 'daily_target')::int, 'call', 'calls')
                                           || ' a day; every parent called by ' || to_char((common ->> 'end_date')::date, 'FMDD Mon') || '.',
                                   'calls_per_day', common -> 'daily_target', 'finish_by', common -> 'end_date'),
      'plan', common || jsonb_build_object('action', 'create', 'call_type', 'fees', 'name', nm, 'class_label', r.cls,
                                           'board', r.board, 'due_by', r.due_date, 'parents', n_par, 'no_phone', n_noph,
                                           'template_key', tmpl ->> 'key', 'template_name', tmpl ->> 'name',
                                           'script_id', scr.id, 'script_name', scr.name, 'whatsapp', wa, 'amount', amt),
      'priority', 10 + (r.due_date - today), 'expires_at', r.due_date + 1);
  end loop;
end $$;

-- (b) Promised date passed and not paid → top of their callers' lists, and one WhatsApp reminder (consent).
create or replace function public.ap_rule_missed_promises(p_inst uuid)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  today date := public.ledger_today(p_inst);
  wa    boolean := exists (select 1 from public.whatsapp_accounts a where a.institute_id = p_inst and a.status = 'connected');
  ids   jsonb;
  n     int;
  n_wa  int;
  amt   numeric;
  oldest int;
  camps jsonb;
begin
  with miss as (
    select l.id, l.campaign_id, l.promised_date, l.promised_amount, l.consent_whatsapp
    from public.leads l
    join public.campaigns c on c.id = l.campaign_id and c.status in ('running', 'paused')
    left join public.student_balance_rows(p_inst) b on b.student_id = l.student_id
    where l.institute_id = p_inst and l.status = 'promised' and l.promised_date < today and not l.do_not_call
      and (l.student_id is null or coalesce(b.balance_due_now, 0) > 0)
      and not exists (select 1 from public.suggestions s
                       where s.institute_id = p_inst and s.kind = 'missed_promises' and s.status in ('accepted', 'auto_done')
                         and s.done_at > now() - interval '7 days' and (s.result -> 'lead_ids') ? l.id::text)
  )
  select jsonb_agg(m.id order by m.promised_date, m.id), count(*), count(*) filter (where m.consent_whatsapp),
         sum(m.promised_amount), max(today - m.promised_date),
         (select jsonb_agg(jsonb_build_object('campaign_id', x.campaign_id, 'name', c.name, 'count', x.n) order by x.n desc)
            from (select m2.campaign_id, count(*) as n from miss m2 group by 1) x join public.campaigns c on c.id = x.campaign_id)
    into ids, n, n_wa, amt, oldest, camps
  from miss m;
  if coalesce(n, 0) < 3 then return; end if;
  return next jsonb_build_object(
    'kind', 'missed_promises', 'key', 'missed_promises:' || today,
    'title', public.ap_n(n, 'missed promise', 'missed promises') || ' to pay',
    'why', jsonb_build_object('text', public.ap_n(n, 'parent', 'parents') || ' promised to pay by a date that has passed (up to '
                                      || public.ap_n(oldest, 'day', 'days') || ' ago) and have not paid.',
                              'count', n, 'oldest_days', oldest, 'amount', amt),
    'impact', jsonb_build_object('text', 'They go to the top of their callers'' lists'
                                         || case when wa and n_wa > 0 then ', and ' || public.ap_n(n_wa, 'parent', 'parents')
                                                 || ' who agreed get one WhatsApp reminder.' else '.' end),
    'plan', jsonb_build_object('lead_ids', ids, 'campaigns', camps, 'reminders', case when wa then n_wa else 0 end,
                               'whatsapp_available', wa),
    'priority', 20, 'expires_at', (today + 1)::timestamp at time zone public.institute_tz(p_inst));
end $$;

-- (c) Admission and sales enquiries new for over 24 hours, never called → due now, and focus callers.
create or replace function public.ap_rule_enquiries(p_inst uuid)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  today date := public.ledger_today(p_inst);
  r     record;
  cl    jsonb;
  names text[];
begin
  for r in
    select c.id, c.name, c.focus_seats, t.key as type_key, c.class_label,
           jsonb_agg(l.id order by l.created_at, l.id) as ids, count(*) as n, max(now()::date - l.created_at::date) as days
    from public.campaigns c
    join public.call_types t on t.id = c.call_type_id and t.key in ('admission', 'sales')
    join public.leads l on l.campaign_id = c.id
    where c.institute_id = p_inst and c.status = 'running'
      and l.status = 'new' and not l.do_not_call and l.consent_call and l.created_at < now() - interval '24 hours'
      and l.assigned_seat_id is null and (l.next_call_at is null or l.next_call_at > now())
      and not exists (select 1 from public.call_outcomes o where o.lead_id = l.id)
    group by c.id, c.name, c.focus_seats, t.key, c.class_label
    having count(*) >= 5
    order by count(*) desc
  loop
    cl := public.ap_plan_callers(p_inst, r.type_key, greatest(0, 2 - cardinality(r.focus_seats)), r.focus_seats);
    select array_agg(s.label order by array_position(array(select jsonb_array_elements_text(cl -> 'picked'))::uuid[], s.id))
      into names from public.seats s where s.id::text in (select jsonb_array_elements_text(cl -> 'picked'));
    return next jsonb_build_object(
      'kind', 'enquiries_uncalled', 'key', 'enquiries:' || r.id || ':' || today,
      'title', public.ap_n(r.n, 'enquiry', 'enquiries') || ' waiting: ' || r.name,
      'why', jsonb_build_object('text', public.ap_n(r.n, 'person', 'people') || ' asked more than a day ago (up to '
                                        || public.ap_n(r.days, 'day', 'days') || ') and nobody has called them yet.',
                                'count', r.n, 'days', r.days),
      'impact', jsonb_build_object('text', 'They go first in the list' || case when cardinality(names) > 0
                                     then '; ' || public.ap_names(names) || ' see it first in their lists.' else '.' end),
      'plan', jsonb_build_object('campaign_id', r.id, 'name', r.name, 'lead_ids', r.ids, 'count', r.n,
                                 'callers', cl -> 'picked', 'caller_options', cl -> 'options'),
      'priority', 40, 'expires_at', now() + interval '2 days');
  end loop;
end $$;

-- (d) A running list that will not reach its people by the end date at the last 3 working days' pace.
create or replace function public.ap_rule_behind_pace(p_inst uuid)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  today date := public.ledger_today(p_inst);
  tz    text := public.institute_tz(p_inst);
  r     record;
  rate  numeric;
  need  int;
  wd    int;
  reach int;
  cl    jsonb;
  best  jsonb;
  addl  text;
begin
  for r in
    select c.*, t.key as type_key,
           (select count(*) from public.leads l where l.campaign_id = c.id and l.status in ('new', 'callback', 'promised')
              and not l.do_not_call and l.consent_call) as open_n
    from public.campaigns c join public.call_types t on t.id = c.call_type_id
    where c.institute_id = p_inst and c.status = 'running' and c.end_date > today
      and c.created_at < now() - interval '2 days'
  loop
    continue when r.open_n < 10;
    -- Waiting enquiries of the list are the enquiries rule's card, not this one.
    continue when r.type_key in ('admission', 'sales') and (select count(*) from public.leads l where l.campaign_id = r.id
                    and l.status = 'new' and l.assigned_seat_id is null and l.created_at < now() - interval '24 hours'
                    and not exists (select 1 from public.call_outcomes o where o.lead_id = l.id)) >= 5;
    -- Calls a day over the last 3 working days.
    select count(*)::numeric / 3 into rate
      from public.call_outcomes o
     where o.campaign_id = r.id and o.corrects_id is null
       and coalesce(o.dialled_at, o.uploaded_at) >= (select min(d)::timestamp at time zone tz
              from (select d::date from generate_series(today - 6, today - 1, interval '1 day') d
                    where extract(isodow from d) < 7 order by d desc limit 3) x)
       and coalesce(o.dialled_at, o.uploaded_at) < today::timestamp at time zone tz;
    wd := public.ap_working_days(today, r.end_date);
    need := ceil(r.open_n::numeric / wd)::int;
    continue when rate >= 0.8 * need;
    reach := least(r.open_n, floor(rate * wd))::int;
    cl := public.ap_plan_callers(p_inst, r.type_key, 1, r.focus_seats);
    best := case when r.call_hours is null then public.ap_best_hours(p_inst, r.class_label) end;
    select s.label into addl from public.seats s where s.id::text = (cl -> 'picked' ->> 0);
    continue when addl is null and best is null;
    return next jsonb_build_object(
      'kind', 'list_behind_pace', 'key', 'pace:' || r.id || ':' || to_char(today, 'IYYY-IW'),
      'title', r.name || ' is behind',
      'why', jsonb_build_object('text', 'At ' || public.ap_n(round(rate), 'call', 'calls') || ' a day, ' || public.ix_count(reach)
                                        || ' of ' || public.ap_n(r.open_n, 'person', 'people') || ' will be called by '
                                        || to_char(r.end_date, 'FMDD Mon') || '.',
                                'open', r.open_n, 'per_day', round(rate, 1), 'needed_per_day', need, 'end_date', r.end_date),
      'impact', jsonb_build_object('text', concat_ws(' and ', case when addl is not null then 'Add ' || addl || ' as a focus caller' end,
                                                    case when best is not null then 'call ' || (best ->> 'label') end)
                                           || ': about ' || public.ap_n(need, 'call', 'calls') || ' a day.',
                                   'calls_per_day', need),
      'plan', jsonb_build_object('campaign_id', r.id, 'name', r.name, 'add_callers', cl -> 'picked', 'caller_options', cl -> 'options',
                                 'hour', best -> 'hour', 'hours_label', best ->> 'label', 'daily_target', least(need, 10000)),
      'priority', 30, 'expires_at', now() + interval '3 days');
  end loop;
end $$;

-- (e) Setup left to do: common answers, WhatsApp, goals. One card; the key changes when the gaps change.
create or replace function public.ap_rule_setup(p_inst uuid)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  need   int;
  filled int;
  gaps   text[] := '{}';
  words  text[] := '{}';
  link   text;
begin
  select count(*), count(f.answer_key) into need, filled
    from public.common_answers a
    left join public.institute_answer_fills f on f.institute_id = p_inst and f.answer_key = a.key
   where a.active and coalesce(cardinality(a.checks), 0) > 0;
  if need > 0 and filled < need then
    gaps := array_append(gaps, 'answers'); words := array_append(words, 'fill common answers (' || filled || ' of ' || need || ')'); link := '#settings';
  end if;
  if not exists (select 1 from public.whatsapp_accounts a where a.institute_id = p_inst and a.status = 'connected') then
    gaps := array_append(gaps, 'whatsapp'); words := array_append(words, 'connect WhatsApp'); link := coalesce(link, '#settings');
  end if;
  if not exists (select 1 from public.institute_goals g where g.institute_id = p_inst) then
    gaps := array_append(gaps, 'goals'); words := array_append(words, 'set your goals'); link := coalesce(link, '#settings?autopilot=1');
  end if;
  if cardinality(gaps) = 0 then return; end if;
  return next jsonb_build_object(
    'kind', 'setup_gaps', 'key', 'setup:' || array_to_string(gaps, ','),
    'title', 'Finish setup',
    'why', jsonb_build_object('text', initcap(substr(public.ap_names(words), 1, 1)) || substr(public.ap_names(words), 2) || '.',
                              'gaps', to_jsonb(gaps)),
    'impact', jsonb_build_object('text', 'Callers get answers on calls, parents get reminders, and Today shows progress against your goals.'),
    'plan', jsonb_build_object('link', link, 'gaps', to_jsonb(gaps)),
    'priority', 60, 'expires_at', null);
end $$;

-- =====================================================================================================
-- 4. Doing it (and undoing it)
-- =====================================================================================================

-- Callers of a plan, checked: active rep seats of the institute, at most 20, no repeats.
create or replace function public.ap_check_callers(p_inst uuid, p_ids jsonb)
returns uuid[] language plpgsql stable security definer set search_path = public
as $$
declare ids uuid[];
begin
  if p_ids is null or jsonb_typeof(p_ids) = 'null' then return '{}'; end if;
  if jsonb_typeof(p_ids) <> 'array' or jsonb_array_length(p_ids) > 20 then
    raise exception 'callers must be a list of up to 20 callers' using errcode = '22023';
  end if;
  begin
    select coalesce(array_agg(distinct x::uuid), '{}') into ids from jsonb_array_elements_text(p_ids) x;
  exception when invalid_text_representation then
    raise exception 'callers must be caller ids' using errcode = '22023';
  end;
  if exists (select 1 from unnest(ids) i where not exists (select 1 from public.seats s
               where s.id = i and s.institute_id = p_inst and s.status = 'active' and s.role = 'rep')) then
    raise exception 'pick callers of this institute' using errcode = '22023';
  end if;
  return ids;
end $$;

-- A fees calling list from the ledger with the plan (create), or the new parents added to it (topup). The same
-- rules as accounts_create_fees_campaign (one lead per phone, the student's balance due by the due date), plus
-- focus callers, hours, target and end date. Returns { result, undo }.
create or replace function public.ap_exec_fees_list(p_inst uuid, p_plan jsonb, p_seat uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  today  date := public.ledger_today(p_inst);
  tz     text := public.institute_tz(p_inst);
  nm     text := trim(coalesce(p_plan ->> 'name', ''));
  cls    text := nullif(trim(coalesce(p_plan ->> 'class_label', '')), '');
  brd    text;
  due    date;
  ends   date;
  typ    uuid;
  scr    uuid;
  callers uuid[];
  daily  int;
  hr     int;
  hours  jsonb;
  cid    uuid;
  n_lead int;
  added  jsonb;
  names  text[];
  camp   public.campaigns;
begin
  begin
    due := nullif(p_plan ->> 'due_by', '')::date;
    ends := coalesce(nullif(p_plan ->> 'end_date', '')::date, greatest(coalesce(due, today) + 7, today + 7));
    daily := nullif(p_plan ->> 'daily_target', '')::int;
    hr := nullif(p_plan ->> 'hour', '')::int;
    scr := nullif(p_plan ->> 'script_id', '')::uuid;
  exception when others then
    raise exception 'the plan has a bad date, number or script' using errcode = '22023';
  end;
  callers := public.ap_check_callers(p_inst, p_plan -> 'callers');
  select t.id into typ from public.call_types t where t.key = 'fees' and t.institute_id is null;

  if p_plan ->> 'action' = 'topup' then
    select * into camp from public.campaigns where id = (p_plan ->> 'campaign_id')::uuid and institute_id = p_inst;
    if camp.id is null or camp.status = 'closed' then raise exception 'that calling list is closed or gone' using errcode = '22023'; end if;
    with due_s as (
      select s.*, b.balance_due_now as bal
      from public.students s join public.student_balance_rows(p_inst, null, greatest(today, coalesce(due, camp.fees_due_by, today))) b on b.student_id = s.id
      where s.institute_id = p_inst and s.status = 'active' and s.phone is not null
        and (camp.class_label is null or lower(s.class_label) = lower(camp.class_label))
        and s.board is not distinct from coalesce(camp.board, s.board) and b.balance_due_now > 0
        and not exists (select 1 from public.leads l where l.campaign_id = camp.id and (l.student_id = s.id or l.phone = s.phone))
    ), firsts as (select distinct on (d.phone) d.* from due_s d order by d.phone, d.bal desc, d.name, d.id),
    ins as (
      insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, student_id, created_at)
      select p_inst, camp.id, coalesce(f.parent_name, f.name), f.phone,
             jsonb_strip_nulls(jsonb_build_object('student', f.name, 'class', f.class_label, 'section', f.section, 'board', f.board,
                                                  'admission_no', f.admission_no, 'source', 'your child''s admission form')),
             f.bal, f.id, now() + (row_number() over (order by f.class_label, f.section, f.name, f.id) * interval '1 microsecond')
      from firsts f returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb), count(*) into added, n_lead from ins;
    insert into public.audit_log (institute_id, actor_id, action, target) values (p_inst, auth.uid(), 'leads.added', camp.id::text || ':' || n_lead);
    return jsonb_build_object(
      'result', jsonb_build_object('campaign_id', camp.id, 'leads', n_lead,
                                   'text', 'Added ' || public.ap_n(n_lead, 'parent', 'parents') || ' to "' || camp.name || '".'),
      'undo', jsonb_build_object('campaign_id', camp.id, 'lead_ids', added));
  end if;

  if length(nm) not between 1 and 120 then raise exception 'the list needs a name of 1 to 120 characters' using errcode = '22023'; end if;
  if ends < today then raise exception 'the end date is in the past' using errcode = '22023'; end if;
  if daily is not null and daily not between 1 and 10000 then raise exception 'daily target must be 1 to 10000 calls' using errcode = '22023'; end if;
  if hr is not null and hr not between 0 and 22 then raise exception 'call hours must start between 0 and 22' using errcode = '22023'; end if;
  brd := public.campaign_check_tags(cls, p_plan ->> 'board');
  if scr is not null then
    if not public.institute_has_feature(p_inst, 'scripts') then
      raise exception 'add Scripts to your plan to use a script in a campaign' using errcode = '42501';
    end if;
    if not exists (select 1 from public.scripts s where s.id = scr and s.institute_id = p_inst
                     and (s.call_type_id is null or s.call_type_id = typ)
                     and exists (select 1 from public.script_versions v where v.script_id = s.id and v.published)) then
      raise exception 'pick a live fees script' using errcode = '22023';
    end if;
  end if;
  hours := public.ap_call_hours(hr, tz);

  insert into public.campaigns (institute_id, name, call_type_id, script_id, start_date, end_date, daily_target, share_mode,
                                status, created_by, open_to_all, class_label, board, fees_due_by, call_hours, focus_seats,
                                wa_reminders)
    values (p_inst, nm, typ, scr, today, ends, daily, 'next_free', 'draft', p_seat, true, cls, brd, due, hours, callers,
            coalesce((p_plan ->> 'whatsapp')::boolean, false)
              and exists (select 1 from public.whatsapp_accounts a where a.institute_id = p_inst and a.status = 'connected'))
    returning id into cid;
  with due_s as (
    select s.*, b.balance_due_now as bal
    from public.students s join public.student_balance_rows(p_inst, null, greatest(today, coalesce(due, today))) b on b.student_id = s.id
    where s.institute_id = p_inst and s.status = 'active' and s.phone is not null
      and (cls is null or lower(s.class_label) = lower(cls)) and (brd is null or s.board = brd) and b.balance_due_now > 0
  ), firsts as (select distinct on (d.phone) d.* from due_s d order by d.phone, d.bal desc, d.name, d.id),
  ins as (
    insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, student_id, created_at)
    select p_inst, cid, coalesce(f.parent_name, f.name), f.phone,
           jsonb_strip_nulls(jsonb_build_object('student', f.name, 'class', f.class_label, 'section', f.section, 'board', f.board,
                                                'admission_no', f.admission_no, 'source', 'your child''s admission form')),
           f.bal, f.id, now() + (row_number() over (order by f.class_label, f.section, f.name, f.id) * interval '1 microsecond')
    from firsts f returning 1)
  select count(*) into n_lead from ins;
  if n_lead = 0 then raise exception 'nobody owes fees for that class and date' using errcode = '22023'; end if;
  update public.campaigns set status = 'running' where id = cid;
  insert into public.audit_log (institute_id, actor_id, action, target) values
    (p_inst, auth.uid(), 'campaign.created', cid::text),
    (p_inst, auth.uid(), 'leads.added', cid::text || ':' || n_lead),
    (p_inst, auth.uid(), 'campaign.running', cid::text);
  select array_agg(s.label order by array_position(callers, s.id)) into names from public.seats s where s.id = any (callers);
  return jsonb_build_object(
    'result', jsonb_build_object('campaign_id', cid, 'leads', n_lead,
      'text', 'Created "' || nm || '": ' || public.ap_n(n_lead, 'parent', 'parents')
              || case when cardinality(names) > 0 then ', ' || public.ap_names(names) || ' calling' else ', open to all callers' end
              || case when hr is not null then ' ' || public.ix_hour_range(hr) else '' end || '.'),
    'undo', jsonb_build_object('campaign_id', cid, 'created', true));
end $$;

-- Leads to the top of their callers' lists (due long ago, oldest promise first). Undo puts the times back.
create or replace function public.ap_exec_missed(p_inst uuid, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  mark  timestamptz := date_trunc('day', now()) - interval '30 days';
  saved jsonb;
  done  jsonb;
  n     int;
  rem   jsonb;
begin
  perform 1 from public.leads l
   where l.institute_id = p_inst and l.id::text in (select jsonb_array_elements_text(p_plan -> 'lead_ids')) for update;
  with pick as (
    select l.id, l.next_call_at, l.consent_whatsapp, row_number() over (order by l.promised_date, l.id) as rk
    from public.leads l
    where l.institute_id = p_inst and l.id::text in (select jsonb_array_elements_text(p_plan -> 'lead_ids'))
      and l.status = 'promised' and not l.do_not_call
  ), upd as (
    update public.leads l set next_call_at = mark + p.rk * interval '1 second'
    from pick p where l.id = p.id
    returning l.id, p.next_call_at as old_at, mark + p.rk * interval '1 second' as new_at, p.consent_whatsapp
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'old', old_at, 'new', new_at)), '[]'::jsonb),
         coalesce(jsonb_agg(id), '[]'::jsonb), count(*),
         coalesce(jsonb_agg(id) filter (where consent_whatsapp and coalesce((p_plan ->> 'reminders')::int, 0) > 0), '[]'::jsonb)
    into saved, done, n, rem
  from upd;
  if n = 0 then raise exception 'those promises are no longer open' using errcode = '22023'; end if;
  return jsonb_build_object(
    'result', jsonb_build_object('lead_ids', done, 'reminder_lead_ids', rem,
      'text', 'Put ' || public.ap_n(n, 'missed promise', 'missed promises') || ' at the top of their callers'' lists'
              || case when jsonb_array_length(rem) > 0 then ', and asked WhatsApp to remind '
                        || public.ap_n(jsonb_array_length(rem), 'parent', 'parents') || ' who agreed' else '' end || '.'),
    'undo', jsonb_build_object('leads', saved));
end $$;

-- Uncalled enquiries due now and focus callers on their list.
create or replace function public.ap_exec_enquiries(p_inst uuid, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  c      public.campaigns;
  callers uuid[] := public.ap_check_callers(p_inst, p_plan -> 'callers');
  newf   uuid[];
  stamp  timestamptz := now();
  ids    jsonb;
  n      int;
  names  text[];
begin
  select * into c from public.campaigns where id = (p_plan ->> 'campaign_id')::uuid and institute_id = p_inst for update;
  if c.id is null or c.status = 'closed' then raise exception 'that calling list is closed or gone' using errcode = '22023'; end if;
  with upd as (
    update public.leads l set next_call_at = stamp
     where l.campaign_id = c.id and l.status = 'new' and l.next_call_at is null
       and l.id::text in (select jsonb_array_elements_text(p_plan -> 'lead_ids'))
    returning l.id)
  select coalesce(jsonb_agg(id), '[]'::jsonb), count(*) into ids, n from upd;
  newf := array(select distinct x from unnest(c.focus_seats || callers) x);
  update public.campaigns set focus_seats = newf where id = c.id;
  select array_agg(s.label) into names from public.seats s where s.id = any (callers);
  return jsonb_build_object(
    'result', jsonb_build_object('campaign_id', c.id, 'lead_ids', ids,
      'text', 'Put ' || public.ap_n(n, 'waiting enquiry', 'waiting enquiries') || ' first in "' || c.name || '"'
              || case when cardinality(names) > 0 then '; ' || public.ap_names(names) || ' see it first' else '' end || '.'),
    'undo', jsonb_build_object('campaign_id', c.id, 'lead_ids', ids, 'stamp', stamp, 'focus_before', to_jsonb(c.focus_seats),
                               'focus_after', to_jsonb(newf)));
end $$;

-- A list behind pace: another focus caller, best hours (when it had none), the daily target needed.
create or replace function public.ap_exec_pace(p_inst uuid, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  c      public.campaigns;
  addc   uuid[] := public.ap_check_callers(p_inst, p_plan -> 'add_callers');
  hr     int := nullif(p_plan ->> 'hour', '')::int;
  daily  int := nullif(p_plan ->> 'daily_target', '')::int;
  newf   uuid[];
  hours  jsonb;
  names  text[];
begin
  select * into c from public.campaigns where id = (p_plan ->> 'campaign_id')::uuid and institute_id = p_inst for update;
  if c.id is null or c.status = 'closed' then raise exception 'that calling list is closed or gone' using errcode = '22023'; end if;
  if daily is not null and daily not between 1 and 10000 then raise exception 'daily target must be 1 to 10000 calls' using errcode = '22023'; end if;
  newf := array(select distinct x from unnest(c.focus_seats || addc) x);
  hours := case when hr is not null then public.ap_call_hours(hr, public.institute_tz(p_inst)) else c.call_hours end;
  update public.campaigns set focus_seats = newf, call_hours = hours, daily_target = coalesce(daily, daily_target) where id = c.id;
  insert into public.audit_log (institute_id, actor_id, action, target) values (p_inst, auth.uid(), 'campaign.plan_applied', c.id::text);
  select array_agg(s.label) into names from public.seats s where s.id = any (addc);
  return jsonb_build_object(
    'result', jsonb_build_object('campaign_id', c.id,
      'text', concat_ws(' and ', case when cardinality(names) > 0 then 'Added ' || public.ap_names(names) || ' to "' || c.name || '"' end,
                                 case when hr is not null then 'set calls for ' || public.ix_hour_range(hr)
                                      || case when cardinality(names) > 0 then '' else ' on "' || c.name || '"' end end) || '.'),
    'undo', jsonb_build_object('campaign_id', c.id, 'focus_before', to_jsonb(c.focus_seats), 'focus_after', to_jsonb(newf),
                               'hours_before', c.call_hours, 'hours_after', hours,
                               'target_before', c.daily_target, 'target_after', coalesce(daily, c.daily_target)));
end $$;

-- Carries out a suggestion's plan. Returns { result, undo }.
create or replace function public.ap_execute(p_inst uuid, p_kind text, p_plan jsonb, p_seat uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if p_kind in ('fees_due_list', 'new_list') then return public.ap_exec_fees_list(p_inst, p_plan, p_seat); end if;
  if p_kind = 'missed_promises' then return public.ap_exec_missed(p_inst, p_plan); end if;
  if p_kind = 'enquiries_uncalled' then return public.ap_exec_enquiries(p_inst, p_plan); end if;
  if p_kind = 'list_behind_pace' then return public.ap_exec_pace(p_inst, p_plan); end if;
  if p_kind = 'setup_gaps' then
    return jsonb_build_object('result', jsonb_build_object('link', p_plan ->> 'link', 'text', 'Opened setup.'), 'undo', null);
  end if;
  raise exception 'this suggestion cannot be carried out' using errcode = '22023';
end $$;

-- Undoes what ap_execute did, as far as it still can. Returns the words for the page.
create or replace function public.ap_undo(p_inst uuid, p_kind text, p_undo jsonb)
returns text language plpgsql security definer set search_path = public
as $$
declare
  c   public.campaigns;
  n   int;
begin
  if p_undo is null then raise exception 'this cannot be undone' using errcode = '22023'; end if;
  if p_kind in ('fees_due_list', 'new_list') then
    select * into c from public.campaigns where id = (p_undo ->> 'campaign_id')::uuid and institute_id = p_inst for update;
    if c.id is null then return 'The calling list is already gone.'; end if;
    if coalesce((p_undo ->> 'created')::boolean, false) then
      if not exists (select 1 from public.call_outcomes o where o.campaign_id = c.id) then
        update public.call_outcomes set lead_id = null where lead_id in (select id from public.leads where campaign_id = c.id);
        delete from public.campaigns where id = c.id;
        insert into public.audit_log (institute_id, actor_id, action, target) values (p_inst, auth.uid(), 'campaign.deleted_by_undo', c.id::text);
        return 'Removed "' || c.name || '" (no calls had been made).';
      end if;
      update public.campaigns set status = case when status = 'running' then 'paused' else status end, focus_seats = '{}' where id = c.id;
      insert into public.audit_log (institute_id, actor_id, action, target) values (p_inst, auth.uid(), 'campaign.paused', c.id::text);
      return 'Paused "' || c.name || '": calls were already made, so it was kept.';
    end if;
    with del as (
      delete from public.leads l
       where l.campaign_id = c.id and l.status = 'new' and l.id::text in (select jsonb_array_elements_text(p_undo -> 'lead_ids'))
         and not exists (select 1 from public.call_outcomes o where o.lead_id = l.id)
      returning 1)
    select count(*) into n from del;
    return 'Took ' || public.ap_n(n, 'parent', 'parents') || ' off "' || c.name || '".';
  end if;
  if p_kind = 'missed_promises' then
    update public.leads l set next_call_at = (x ->> 'old')::timestamptz
      from jsonb_array_elements(p_undo -> 'leads') x
     where l.id = (x ->> 'id')::uuid and l.institute_id = p_inst and l.next_call_at = (x ->> 'new')::timestamptz;
    get diagnostics n = row_count;
    return 'Put ' || public.ap_n(n, 'promise', 'promises') || ' back where they were.';
  end if;
  if p_kind = 'enquiries_uncalled' then
    update public.leads l set next_call_at = null
     where l.institute_id = p_inst and l.status = 'new' and l.next_call_at = (p_undo ->> 'stamp')::timestamptz
       and l.id::text in (select jsonb_array_elements_text(p_undo -> 'lead_ids'));
    get diagnostics n = row_count;
    update public.campaigns c2 set focus_seats = array(select jsonb_array_elements_text(p_undo -> 'focus_before'))::uuid[]
     where c2.id = (p_undo ->> 'campaign_id')::uuid and c2.institute_id = p_inst
       and c2.focus_seats = array(select jsonb_array_elements_text(p_undo -> 'focus_after'))::uuid[];
    return 'Put ' || public.ap_n(n, 'enquiry', 'enquiries') || ' back in their usual order.';
  end if;
  if p_kind = 'list_behind_pace' then
    update public.campaigns c2 set
      focus_seats = case when c2.focus_seats = array(select jsonb_array_elements_text(p_undo -> 'focus_after'))::uuid[]
                         then array(select jsonb_array_elements_text(p_undo -> 'focus_before'))::uuid[] else c2.focus_seats end,
      call_hours = case when c2.call_hours is not distinct from (p_undo -> 'hours_after')
                        then nullif(p_undo -> 'hours_before', 'null'::jsonb) else c2.call_hours end,
      daily_target = case when c2.daily_target is not distinct from nullif(p_undo ->> 'target_after', '')::int
                          then nullif(p_undo ->> 'target_before', '')::int else c2.daily_target end
     where c2.id = (p_undo ->> 'campaign_id')::uuid and c2.institute_id = p_inst;
    return 'Put the list back as it was.';
  end if;
  raise exception 'this cannot be undone' using errcode = '22023';
end $$;

-- =====================================================================================================
-- 5. Planning run
-- =====================================================================================================

-- Runs every rule for the institute: one open suggestion per key (numbers refreshed), stale ones expired, and
-- the kinds set to 'auto' carried out (unless paused) and recorded as auto_done. Idempotent. Owners and
-- managers of the institute, or the service role (no login). Returns the counts.
create or replace function public.autopilot_plan(p_institute uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  run_id  bigint;
  cand    jsonb;
  kinds   text[] := array['fees_due_list', 'missed_promises', 'enquiries_uncalled', 'list_behind_pace', 'setup_gaps'];
  k       text;
  mode    text;
  paused  boolean;
  seen    text[] := '{}';
  sid     uuid;
  st      text;
  out     jsonb;
  n_new   int := 0;
  n_ref   int := 0;
  n_auto  int := 0;
  n_exp   int := 0;
  n_fail  int := 0;
  n_tmp   int;
  errs    text[] := '{}';
begin
  if auth.uid() is not null and not public.is_admin_of(p_institute) then
    raise exception 'only an owner or manager of this institute can plan' using errcode = '42501';
  end if;
  if not exists (select 1 from public.institutes i where i.id = p_institute) then
    raise exception 'institute not found' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('autopilot:' || p_institute::text));
  paused := public.ap_paused(p_institute);
  insert into public.automation_runs (institute_id, job, run_by) values (p_institute, 'plan', auth.uid()) returning id into run_id;

  -- Snoozed long enough: back to new. Past their date: expired.
  update public.suggestions set status = 'new', snooze_until = null, updated_at = now()
   where institute_id = p_institute and status = 'snoozed' and snooze_until <= now()
     and not exists (select 1 from public.suggestions o where o.institute_id = p_institute and o.dedupe_key = suggestions.dedupe_key
                       and o.status = 'new');
  update public.suggestions set status = 'expired', updated_at = now()
   where institute_id = p_institute and status in ('new', 'snoozed') and expires_at <= now();
  get diagnostics n_exp = row_count;

  foreach k in array kinds loop
    mode := public.ap_mode(p_institute, k);
    continue when mode = 'off';
    for cand in
      select x from public.ap_rule_fees_due(p_institute) x where k = 'fees_due_list'
      union all select x from public.ap_rule_missed_promises(p_institute) x where k = 'missed_promises'
      union all select x from public.ap_rule_enquiries(p_institute) x where k = 'enquiries_uncalled'
      union all select x from public.ap_rule_behind_pace(p_institute) x where k = 'list_behind_pace'
      union all select x from public.ap_rule_setup(p_institute) x where k = 'setup_gaps'
    loop
      seen := seen || (cand ->> 'key');
      -- Decided before (done, dismissed or undone): never again for this key.
      continue when exists (select 1 from public.suggestions s where s.institute_id = p_institute and s.dedupe_key = cand ->> 'key'
                              and s.status in ('accepted', 'auto_done', 'dismissed', 'undone'));
      sid := null;
      select s.id, s.status into sid, st from public.suggestions s
       where s.institute_id = p_institute and s.dedupe_key = cand ->> 'key' and s.status in ('new', 'snoozed');
      if sid is null then
        insert into public.suggestions (institute_id, kind, dedupe_key, title, why, impact, plan, priority, expires_at)
          values (p_institute, k, cand ->> 'key', cand ->> 'title', cand -> 'why', cand -> 'impact', cand -> 'plan',
                  coalesce((cand ->> 'priority')::int, 50), nullif(cand ->> 'expires_at', '')::timestamptz)
          returning id into sid;
        st := 'new';
        n_new := n_new + 1;
      else
        update public.suggestions set title = cand ->> 'title', why = cand -> 'why', impact = cand -> 'impact', plan = cand -> 'plan',
               priority = coalesce((cand ->> 'priority')::int, 50), expires_at = nullif(cand ->> 'expires_at', '')::timestamptz,
               updated_at = now()
         where id = sid;
        n_ref := n_ref + 1;
      end if;
      if mode = 'auto' and not paused and st = 'new' and k <> 'setup_gaps' then
        begin
          out := public.ap_execute(p_institute, k, cand -> 'plan', null);
          update public.suggestions set status = 'auto_done', done_at = now(), decided_at = now(), result = out -> 'result',
                 undo = out -> 'undo', updated_at = now()
           where id = sid;
          insert into public.audit_log (institute_id, actor_id, action, target) values (p_institute, null, 'autopilot.done', sid::text || ':' || k);
          n_auto := n_auto + 1;
        exception when others then
          n_fail := n_fail + 1;
          errs := errs || left(k || ': ' || sqlerrm, 200);
        end;
      end if;
    end loop;
  end loop;

  -- Open suggestions of the rules that no longer hold (or whose kind is off): expired.
  update public.suggestions set status = 'expired', updated_at = now()
   where institute_id = p_institute and status in ('new', 'snoozed') and kind = any (kinds) and not (dedupe_key = any (seen));
  get diagnostics n_tmp = row_count;
  n_exp := n_exp + n_tmp;

  update public.automation_runs set finished_at = now(),
         counts = jsonb_build_object('new', n_new, 'refreshed', n_ref, 'auto_done', n_auto, 'expired', n_exp, 'failed', n_fail,
                                     'paused', paused),
         error = nullif(left(array_to_string(errs, '; '), 500), '')
   where id = run_id;
  return jsonb_build_object('run_id', run_id, 'new', n_new, 'refreshed', n_ref, 'auto_done', n_auto, 'expired', n_exp,
                            'failed', n_fail, 'paused', paused);
end $$;

-- =====================================================================================================
-- 6. What the admin app calls
-- =====================================================================================================

-- The signed-in person's seat in their institute, with what they may see of suggestions:
-- owner: every kind; manager: calling kinds (fees lists only with money access); accounts: none.
create or replace function public.ap_viewer()
returns table (seat_id uuid, institute_id uuid, kind text, money boolean)
language plpgsql stable security definer set search_path = public
as $$
declare s public.seats;
begin
  s := public.my_active_seat();
  if s.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if s.role not in ('admin', 'accounts') then
    raise exception 'only an owner or manager can see suggestions' using errcode = '42501';
  end if;
  return query select s.id, s.institute_id,
    case when s.role = 'accounts' then 'accounts' when s.admin_kind = 'manager' then 'manager' else 'owner' end,
    public.can_see_money(s.institute_id);
end $$;

create or replace function public.ap_may_see(p_viewer text, p_money boolean, p_kind text)
returns boolean language sql immutable set search_path = public
as $$
  select case p_viewer
           when 'owner' then true
           when 'manager' then public.ap_calling_kind(p_kind) and (p_money or p_kind not in ('fees_due_list', 'new_list'))
           else false end
$$;

-- One suggestion for the page, money stripped unless allowed.
create or replace function public.ap_card(s public.suggestions, p_money boolean)
returns jsonb language sql stable set search_path = public
as $$
  select jsonb_build_object('id', s.id, 'kind', s.kind, 'dedupe_key', s.dedupe_key, 'title', s.title,
           'why', case when p_money then s.why else public.ap_strip_money(s.why) end,
           'impact', case when p_money then s.impact else public.ap_strip_money(s.impact) end,
           'plan', case when p_money then s.plan else public.ap_strip_money(s.plan) end,
           'priority', s.priority, 'status', s.status, 'created_at', s.created_at, 'done_at', s.done_at,
           'result', public.ap_strip_money(s.result),
           'by', case when s.status = 'auto_done' then 'vector' else 'you' end,
           'can_undo', s.status in ('accepted', 'auto_done') and s.undo is not null and s.done_at > now() - interval '24 hours',
           'undo_until', case when s.undo is not null and s.done_at is not null then s.done_at + interval '24 hours' end,
           'money_hidden', not p_money)
$$;

-- Today: "Needs your OK" cards (status new, best first) and "Vector did for you" (done since the start of
-- yesterday), filtered by role. Also when the rules last ran, so the page can ask for a new plan.
create or replace function public.my_suggestions()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  v     record;
  since timestamptz;
begin
  select * into v from public.ap_viewer();
  since := (public.ledger_today(v.institute_id) - 1)::timestamp at time zone public.institute_tz(v.institute_id);
  return jsonb_build_object(
    'viewer', v.kind,
    'paused', public.ap_paused(v.institute_id),
    'last_run_at', (select max(r.started_at) from public.automation_runs r where r.institute_id = v.institute_id and r.job = 'plan'),
    'cards', coalesce((select jsonb_agg(public.ap_card(s, v.money) order by s.priority, s.created_at)
                       from public.suggestions s
                       where s.institute_id = v.institute_id and s.status = 'new' and public.ap_may_see(v.kind, v.money, s.kind)), '[]'::jsonb),
    'feed', coalesce((select jsonb_agg(public.ap_card(s, v.money) order by s.done_at desc)
                      from public.suggestions s
                      where s.institute_id = v.institute_id and s.status in ('auto_done', 'accepted') and s.done_at >= since
                        and s.kind <> 'setup_gaps' and public.ap_may_see(v.kind, v.money, s.kind)), '[]'::jsonb));
end $$;

-- The suggestion for a decision, locked, after the role check.
create or replace function public.ap_suggestion_for(p_id uuid)
returns public.suggestions language plpgsql security definer set search_path = public
as $$
declare
  v record;
  s public.suggestions;
begin
  select * into v from public.ap_viewer();
  select * into s from public.suggestions where id = p_id and institute_id = v.institute_id for update;
  if s.id is null or not public.ap_may_see(v.kind, v.money, s.kind) then
    raise exception 'suggestion not found' using errcode = '42501';
  end if;
  return s;
end $$;

-- Confirm (with the owner's changes): carries the plan out in one transaction.
-- p_overrides: name, callers, script_id, hour, daily_target, end_date, whatsapp, add_callers.
create or replace function public.accept_suggestion(p_id uuid, p_overrides jsonb default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  s     public.suggestions;
  seat  uuid;
  ov    jsonb := coalesce(p_overrides, '{}'::jsonb);
  v_plan jsonb;
  out   jsonb;
begin
  s := public.ap_suggestion_for(p_id);
  if s.status not in ('new', 'snoozed') then
    raise exception 'this suggestion was already decided' using errcode = '22023';
  end if;
  if jsonb_typeof(ov) <> 'object' or exists (select 1 from jsonb_object_keys(ov) k
       where k not in ('name', 'callers', 'script_id', 'hour', 'daily_target', 'end_date', 'whatsapp', 'add_callers')) then
    raise exception 'changes can be name, callers, script_id, hour, daily_target, end_date, whatsapp or add_callers' using errcode = '22023';
  end if;
  seat := public.ap_actor_seat(s.institute_id);
  v_plan := s.plan || ov;
  out := public.ap_execute(s.institute_id, s.kind, v_plan, seat);
  update public.suggestions set status = 'accepted', plan = v_plan, decided_by = seat, decided_at = now(), done_at = now(),
         result = out -> 'result', undo = out -> 'undo', snooze_until = null, updated_at = now()
   where id = s.id;
  insert into public.audit_log (institute_id, actor_id, action, target) values (s.institute_id, auth.uid(), 'suggestion.accepted', s.id::text || ':' || s.kind);
  select * into s from public.suggestions where id = p_id;
  return public.ap_card(s, public.can_see_money(s.institute_id));
end $$;

-- Undo, within 24 hours of the action: a list with no calls yet is removed (else paused), queue order restored.
create or replace function public.undo_suggestion(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  s    public.suggestions;
  txt  text;
begin
  s := public.ap_suggestion_for(p_id);
  if s.status not in ('accepted', 'auto_done') or s.undo is null then
    raise exception 'this cannot be undone' using errcode = '22023';
  end if;
  if s.done_at < now() - interval '24 hours' then
    raise exception 'undo is possible for 24 hours only' using errcode = '22023';
  end if;
  txt := public.ap_undo(s.institute_id, s.kind, s.undo);
  update public.suggestions set status = 'undone', undone_at = now(), updated_at = now(),
         result = coalesce(result, '{}'::jsonb) || jsonb_build_object('undo_text', txt)
   where id = s.id;
  insert into public.audit_log (institute_id, actor_id, action, target) values (s.institute_id, auth.uid(), 'suggestion.undone', s.id::text || ':' || s.kind);
  return jsonb_build_object('id', s.id, 'status', 'undone', 'text', txt);
end $$;

-- Not now: snoozed for p_snooze_days (1 to 30), or dismissed for good when null or 0.
create or replace function public.dismiss_suggestion(p_id uuid, p_snooze_days int default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare s public.suggestions;
begin
  s := public.ap_suggestion_for(p_id);
  if s.status not in ('new', 'snoozed') then raise exception 'this suggestion was already decided' using errcode = '22023'; end if;
  if p_snooze_days is not null and p_snooze_days not between 0 and 30 then
    raise exception 'snooze for 1 to 30 days' using errcode = '22023';
  end if;
  update public.suggestions set status = case when coalesce(p_snooze_days, 0) > 0 then 'snoozed' else 'dismissed' end,
         snooze_until = case when coalesce(p_snooze_days, 0) > 0 then now() + make_interval(days => p_snooze_days) end,
         decided_by = public.ap_actor_seat(s.institute_id), decided_at = now(), updated_at = now()
   where id = s.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (s.institute_id, auth.uid(), case when coalesce(p_snooze_days, 0) > 0 then 'suggestion.snoozed' else 'suggestion.dismissed' end,
            s.id::text || ':' || s.kind);
  return jsonb_build_object('id', s.id, 'status', case when coalesce(p_snooze_days, 0) > 0 then 'snoozed' else 'dismissed' end);
end $$;

-- The three numbers on Today, each against its goal. Owners and managers.
--   fees: of the fees due this term till today (term_start, default 1 April), how much is paid. Amounts and the
--         ₹-based percent only with money access; parents fully paid / parents with fees due always.
--   admissions: students who joined from an admission call since season_start (default term start) vs target.
--   team: calls today, people reached, callers who called today.
create or replace function public.autopilot_numbers()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  seat  public.seats;
  inst  uuid;
  money boolean;
  today date;
  tz    text;
  g     public.institute_goals;
  t0    date;
  s0    date;
  f     record;
  adm   int;
  tm    record;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an owner or manager can see these numbers' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  money := public.can_see_money(inst);
  today := public.ledger_today(inst);
  tz := public.institute_tz(inst);
  select * into g from public.institute_goals where institute_id = inst;
  t0 := coalesce(g.term_start, make_date(extract(year from today)::int - case when extract(month from today) < 4 then 1 else 0 end, 4, 1));
  s0 := coalesce(g.season_start, t0);
  with per as (
    select s.id, coalesce(sum(i.amount - coalesce((select sum(d.amount) from public.discounts d where d.fee_item_id = i.id and not d.is_removed), 0)), 0) as due_w,
           greatest(b.balance_due_now, 0) as owed
    from public.students s
    join public.student_balance_rows(inst) b on b.student_id = s.id
    left join public.fee_items i on i.student_id = s.id and not i.is_void and i.due_date between t0 and today
    where s.institute_id = inst and s.status = 'active'
    group by s.id, b.balance_due_now
  ), w as (select id, due_w, least(owed, due_w) as left_w from per where due_w > 0)
  select coalesce(sum(due_w), 0) as due, coalesce(sum(due_w - left_w), 0) as paid, count(*) as parents,
         count(*) filter (where left_w <= 0) as parents_paid
    into f from w;
  select count(*) into adm from public.students s where s.institute_id = inst and s.source = 'admission' and s.created_at >= s0::timestamp at time zone tz;
  select count(*) as calls, count(*) filter (where o.outcome not in ('no_answer', 'busy', 'dropped_network')
                                              and coalesce(o.result_key, '') not in ('no_answer', 'busy', 'wrong_number')) as reached,
         count(distinct o.seat_id) as callers
    into tm
    from public.call_outcomes o
   where o.institute_id = inst and o.corrects_id is null and coalesce(o.dialled_at, o.uploaded_at) >= today::timestamp at time zone tz;
  return jsonb_build_object(
    'goals_set', g.institute_id is not null, 'money_hidden', not money, 'term_start', t0, 'season_start', s0,
    'fees', jsonb_build_object('has_ledger', exists (select 1 from public.students s where s.institute_id = inst),
      'goal_pct', coalesce(g.fees_pct, 90),
      'due_amount', case when money then f.due end, 'collected_amount', case when money then f.paid end,
      'pct', case when money and f.due > 0 then round(100 * f.paid / f.due) end,
      'parents', f.parents, 'parents_paid', f.parents_paid,
      'parents_pct', case when f.parents > 0 then round(100.0 * f.parents_paid / f.parents) end),
    'admissions', jsonb_build_object('confirmed', adm, 'target', g.admissions_target,
      'pct', case when g.admissions_target > 0 then round(100.0 * adm / g.admissions_target) end),
    'team', jsonb_build_object('calls', tm.calls, 'reached', tm.reached, 'callers', tm.callers,
      'callers_total', (select count(*) from public.seats s where s.institute_id = inst and s.status = 'active' and s.role = 'rep')));
end $$;

-- Settings > Autopilot: the switches, language and goals. Owners and managers read; owners change.
create or replace function public.autopilot_get_settings()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  seat public.seats;
  a    public.autopilot_settings;
  g    public.institute_goals;
  inst uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an owner or manager can see Autopilot settings' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  select * into a from public.autopilot_settings where institute_id = inst;
  select * into g from public.institute_goals where institute_id = inst;
  return jsonb_build_object(
    'is_owner', public.is_owner_of(inst), 'paused', coalesce(a.paused, false), 'language', coalesce(a.language, 'en'),
    'modes', jsonb_build_object('fees_due_list', public.ap_mode(inst, 'fees_due_list'), 'missed_promises', public.ap_mode(inst, 'missed_promises'),
                                'enquiries_uncalled', public.ap_mode(inst, 'enquiries_uncalled'), 'list_behind_pace', public.ap_mode(inst, 'list_behind_pace'),
                                'setup_gaps', public.ap_mode(inst, 'setup_gaps')),
    'toggles', jsonb_build_object('lists', public.ap_mode(inst, 'fees_due_list') = 'auto',
                                  'reminders', public.ap_mode(inst, 'missed_promises') = 'auto',
                                  'balance', public.ap_mode(inst, 'enquiries_uncalled') = 'auto' and public.ap_mode(inst, 'list_behind_pace') = 'auto'),
    'goals', case when g.institute_id is null then null else jsonb_build_object(
      'fees_pct', g.fees_pct, 'admissions_target', g.admissions_target, 'sales_target', g.sales_target,
      'term_start', g.term_start, 'term_end', g.term_end, 'season_start', g.season_start, 'season_end', g.season_end) end);
end $$;

-- Owner: pause or resume, modes per kind ({ kind: off | ask | auto }), language. Null keeps a value.
create or replace function public.autopilot_save_settings(p_paused boolean default null, p_modes jsonb default null, p_language text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  inst uuid;
  cur  public.autopilot_settings;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_owner_of(seat.institute_id) then
    raise exception 'only the owner can change Autopilot' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  if p_modes is not null and (jsonb_typeof(p_modes) <> 'object' or exists (
       select 1 from jsonb_each(p_modes) e(k, v)
        where k not in ('fees_due_list', 'missed_promises', 'enquiries_uncalled', 'list_behind_pace', 'setup_gaps')
           or jsonb_typeof(v) <> 'string' or v #>> '{}' not in ('off', 'ask', 'auto')
           or (k = 'setup_gaps' and v #>> '{}' = 'auto'))) then
    raise exception 'modes are off, ask or auto for fees_due_list, missed_promises, enquiries_uncalled, list_behind_pace (setup_gaps: off or ask)'
      using errcode = '22023';
  end if;
  if p_language is not null and p_language not in ('en', 'hinglish') then
    raise exception 'language must be en or hinglish' using errcode = '22023';
  end if;
  select * into cur from public.autopilot_settings where institute_id = inst;
  insert into public.autopilot_settings as a (institute_id, paused, paused_at, modes, language, updated_at, updated_by)
    values (inst, coalesce(p_paused, false), case when p_paused then now() end, coalesce(p_modes, '{}'::jsonb),
            coalesce(p_language, 'en'), now(), auth.uid())
    on conflict (institute_id) do update set
      paused = coalesce(p_paused, a.paused),
      paused_at = case when p_paused is null then a.paused_at when p_paused then coalesce(a.paused_at, now()) else null end,
      modes = a.modes || coalesce(p_modes, '{}'::jsonb),
      language = coalesce(p_language, a.language), updated_at = now(), updated_by = auth.uid();
  if p_paused is not null and p_paused is distinct from coalesce(cur.paused, false) then
    insert into public.audit_log (institute_id, actor_id, action, target) values (inst, auth.uid(), case when p_paused then 'autopilot.paused' else 'autopilot.resumed' end, inst::text);
  end if;
  if p_modes is not null or p_language is not null then
    insert into public.audit_log (institute_id, actor_id, action, target) values (inst, auth.uid(), 'autopilot.changed', left(coalesce(p_modes::text, '') || coalesce(' ' || p_language, ''), 200));
  end if;
  return public.autopilot_get_settings();
end $$;

-- Owner: the goals. Null fees % keeps 90; dates optional.
create or replace function public.autopilot_save_goals(
  p_fees_pct int default null, p_admissions_target int default null, p_sales_target int default null,
  p_term_start date default null, p_term_end date default null, p_season_start date default null, p_season_end date default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_owner_of(seat.institute_id) then
    raise exception 'only the owner can set goals' using errcode = '42501';
  end if;
  if p_fees_pct is not null and p_fees_pct not between 1 and 100 then raise exception 'fees goal must be 1 to 100%%' using errcode = '22023'; end if;
  if p_admissions_target is not null and p_admissions_target not between 1 and 100000 then raise exception 'admissions target must be 1 to 100000' using errcode = '22023'; end if;
  if p_sales_target is not null and p_sales_target not between 1 and 100000 then raise exception 'sales target must be 1 to 100000' using errcode = '22023'; end if;
  if (p_term_start is not null and p_term_end is not null and p_term_end < p_term_start)
     or (p_season_start is not null and p_season_end is not null and p_season_end < p_season_start) then
    raise exception 'an end date is before its start date' using errcode = '22023';
  end if;
  insert into public.institute_goals as g (institute_id, fees_pct, admissions_target, sales_target, term_start, term_end,
                                           season_start, season_end, updated_at, updated_by)
    values (seat.institute_id, coalesce(p_fees_pct, 90), p_admissions_target, p_sales_target, p_term_start, p_term_end,
            p_season_start, p_season_end, now(), auth.uid())
    on conflict (institute_id) do update set fees_pct = coalesce(p_fees_pct, g.fees_pct), admissions_target = p_admissions_target,
      sales_target = p_sales_target, term_start = p_term_start, term_end = p_term_end, season_start = p_season_start,
      season_end = p_season_end, updated_at = now(), updated_by = auth.uid();
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(), 'goals.set', coalesce(p_fees_pct, 90) || '%:' || coalesce(p_admissions_target::text, '-'));
  return public.autopilot_get_settings();
end $$;

-- Caller scores for the admin pages (no money): one call type key, or all.
create or replace function public.caller_scores(p_call_type text default null)
returns table (seat_id uuid, label text, picked bigint, good bigint, score numeric, calls_target int, focus_load int, spare int)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an owner or manager can see caller scores' using errcode = '42501';
  end if;
  return query select * from public.ap_caller_scores(seat.institute_id, p_call_type);
end $$;

-- The one-screen New calling list: everything filled in by the same planner as the fees rule.
-- Fees (from the ledger): class, board and due date (null = the next fee due for that class), the parents who
-- owe, name, template, script, callers, hours, target, end date, WhatsApp. Other types: callers, hours,
-- script, end date (the people come from a sheet or by hand).
create or replace function public.autopilot_list_defaults(p_call_type text default 'fees', p_class_label text default null,
                                                         p_board text default null, p_due_by date default null)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  seat  public.seats;
  inst  uuid;
  today date;
  typ   text := coalesce(nullif(trim(p_call_type), ''), 'fees');
  cls   text := nullif(trim(coalesce(p_class_label, '')), '');
  brd   text;
  due   date := p_due_by;
  head  text;
  n_par int;
  n_noph int;
  amt   numeric;
  common jsonb;
  tmpl  jsonb;
  scr   record;
  money boolean;
  out   jsonb;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an owner or manager can plan a calling list' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  today := public.ledger_today(inst);
  money := public.can_see_money(inst);
  brd := public.campaign_check_tags(cls, p_board);
  if not exists (select 1 from public.call_types t where t.key = typ and (t.institute_id is null or t.institute_id = inst)) then
    raise exception 'unknown call type' using errcode = '22023';
  end if;
  if typ <> 'fees' then
    common := public.ap_plan_common(inst, typ, cls, null, today + 14);
    tmpl := public.ap_pick_template(inst, case typ when 'admission' then 'admission_enquiry_school' when 'sales' then 'course_sales_enquiry' end);
    select * into scr from public.ap_pick_script(inst, typ, null);
    return common || jsonb_build_object('action', 'create', 'call_type', typ, 'class_label', cls, 'board', brd,
      'name', initcap(typ) || coalesce(' – ' || public.ap_class_text(cls, brd), ''), 'template_key', tmpl ->> 'key',
      'template_name', tmpl ->> 'name', 'script_id', scr.id, 'script_name', scr.name, 'whatsapp', false);
  end if;
  if due is null then
    select min(f.due_date) into due from public.fee_items f join public.students s on s.id = f.student_id
     where f.institute_id = inst and not f.is_void and f.due_date >= today and s.status = 'active'
       and (cls is null or lower(s.class_label) = lower(cls)) and (brd is null or s.board = brd);
    due := coalesce(due, today);
  end if;
  select coalesce(mode() within group (order by f.head) filter (where f.head !~* '(bus|transport)'), min(f.head)) into head
    from public.fee_items f join public.students s on s.id = f.student_id
   where f.institute_id = inst and not f.is_void and f.due_date = due and (cls is null or lower(s.class_label) = lower(cls))
     and (brd is null or s.board = brd);
  select count(distinct s.phone), count(*) filter (where s.phone is null), sum(b.balance_due_now) into n_par, n_noph, amt
    from public.students s join public.student_balance_rows(inst, null, greatest(today, due)) b on b.student_id = s.id
   where s.institute_id = inst and s.status = 'active' and (cls is null or lower(s.class_label) = lower(cls))
     and (brd is null or s.board = brd) and b.balance_due_now > 0;
  common := public.ap_plan_common(inst, 'fees', cls, n_par, greatest(due + 7, today + 7));
  tmpl := public.ap_pick_template(inst, case when due < today then 'fees_overdue' else 'fees_reminder_polite' end);
  select * into scr from public.ap_pick_script(inst, 'fees', case when due < today then 'overdue' else 'reminder' end);
  out := common || jsonb_build_object('action', 'create', 'call_type', 'fees', 'class_label', cls, 'board', brd, 'due_by', due,
    'name', public.ap_list_name(head, cls, brd, due), 'parents', coalesce(n_par, 0), 'no_phone', coalesce(n_noph, 0),
    'template_key', tmpl ->> 'key', 'template_name', tmpl ->> 'name', 'script_id', scr.id, 'script_name', scr.name,
    'whatsapp', (common ->> 'whatsapp_available')::boolean, 'amount', amt);
  return case when money then out else public.ap_strip_money(out) end;
end $$;

-- Confirm on the one-screen New calling list (fees from the ledger): creates the list like an accepted
-- suggestion, so it shows in "Vector did for you" with Undo for 24 hours. Same rule as
-- accounts_create_fees_campaign: the owner, or a manager who can see money.
create or replace function public.autopilot_create_list(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  inst uuid;
  out  jsonb;
  sid  uuid;
  s    public.suggestions;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an owner or manager can start a calling list' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  if not public.can_see_money(inst) then
    raise exception 'only the owner or a manager who can see money can make a fees list from the ledger' using errcode = '42501';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' or coalesce(p_plan ->> 'call_type', 'fees') <> 'fees' then
    raise exception 'the one-screen list is for fees from the ledger' using errcode = '22023';
  end if;
  out := public.ap_exec_fees_list(inst, p_plan || jsonb_build_object('action', 'create'), seat.id);
  insert into public.suggestions (institute_id, kind, dedupe_key, title, why, impact, plan, priority, status, result, undo,
                                  decided_by, decided_at, done_at)
    values (inst, 'new_list', 'manual:' || (out -> 'result' ->> 'campaign_id'), left('Start "' || (p_plan ->> 'name') || '"', 200),
            jsonb_build_object('text', 'You started this list.'), '{}'::jsonb, p_plan, 90, 'accepted', out -> 'result', out -> 'undo',
            seat.id, now(), now())
    returning id into sid;
  insert into public.audit_log (institute_id, actor_id, action, target) values (inst, auth.uid(), 'suggestion.accepted', sid::text || ':new_list');
  select * into s from public.suggestions where id = sid;
  return public.ap_card(s, true);
end $$;

-- For the WhatsApp reminder job (service role): one reminder per parent from missed-promise suggestions carried
-- out in the last day, with the institute's approved 'promise_due' template, consent and not do-not-call.
-- Claimed with a queued message (dedupe 'missed:<lead>:<promised date>') so it never goes twice. Same row shape
-- as wa_claim_reminders.
create or replace function public.autopilot_claim_reminders(p_limit int default 500)
returns setof jsonb language plpgsql security definer set search_path = public
as $$
declare
  r   record;
  mid uuid;
begin
  for r in
    select distinct on (l.id) l.id as lead_id, l.institute_id, l.name, l.phone, l.amount_due, l.promised_amount, l.promised_date,
           i.name as institute_name, t.id as template_id, t.key, t.meta_name, t.language, t.category, t.body, t.param_sources,
           a.phone_number_id, a.token_source,
           (select x.token_cipher from public.whatsapp_secrets x where x.institute_id = l.institute_id) as token_cipher
    from public.suggestions s
    cross join lateral jsonb_array_elements_text(coalesce(s.result -> 'reminder_lead_ids', '[]'::jsonb)) rid
    join public.leads l on l.id = rid::uuid and l.institute_id = s.institute_id
    join public.institutes i on i.id = l.institute_id and i.status in ('trial', 'active', 'grace')
    join public.whatsapp_accounts a on a.institute_id = l.institute_id and a.status = 'connected'
    join public.whatsapp_templates t on t.institute_id = l.institute_id and t.key = 'promise_due' and t.meta_status = 'approved'
                                    and t.category = 'utility'
    where s.kind = 'missed_promises' and s.status in ('accepted', 'auto_done') and s.done_at > now() - interval '1 day'
      and not public.ap_paused(s.institute_id)
      and l.status = 'promised' and l.consent_whatsapp and not l.do_not_call
    order by l.id
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  loop
    mid := null;
    insert into public.whatsapp_messages (institute_id, lead_id, template_id, template_key, direction, kind, status, category, dedupe_key)
      values (r.institute_id, r.lead_id, r.template_id, r.key, 'out', 'reminder', 'queued', r.category, 'missed:' || r.lead_id || ':' || r.promised_date)
      on conflict (institute_id, dedupe_key) do nothing
      returning id into mid;
    continue when mid is null;
    return next jsonb_build_object(
      'message_id', mid, 'institute_id', r.institute_id, 'institute_name', r.institute_name, 'caller_name', null,
      'lead', jsonb_build_object('id', r.lead_id, 'name', r.name, 'phone', r.phone, 'amount_due', r.amount_due,
                                 'promised_amount', r.promised_amount, 'promised_date', r.promised_date),
      'template', jsonb_build_object('id', r.template_id, 'key', r.key, 'meta_name', r.meta_name, 'language', r.language,
                                     'category', r.category, 'body', r.body, 'param_sources', to_jsonb(r.param_sources)),
      'account', jsonb_build_object('phone_number_id', r.phone_number_id, 'token_source', r.token_source),
      'token_cipher', r.token_cipher);
  end loop;
end $$;

-- my_campaigns: as in 20261025130000, plus is_focus (this caller is one of the list's focus callers) and
-- focus_target (their part of the daily target). Focus lists come first.
drop function if exists public.my_campaigns();
create or replace function public.my_campaigns()
returns table (campaign_id uuid, name text, status text, call_type_id uuid, call_type_key text, call_type_label text,
               script_id uuid, start_date date, end_date date, daily_target int, call_hours jsonb,
               share_mode text, open_to_all boolean, class_label text, board text, is_member boolean,
               my_leads bigint, my_leads_due bigint, pool_leads_due bigint, results jsonb,
               is_focus boolean, focus_target int)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
  today date;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  today := (now() at time zone 'Asia/Kolkata')::date;
  return query
    select c.id, c.name, c.status, t.id, t.key, t.label, c.script_id, c.start_date, c.end_date, c.daily_target,
           c.call_hours, c.share_mode, c.open_to_all, c.class_label, c.board,
           exists (select 1 from public.campaign_members m where m.campaign_id = c.id and m.seat_id = seat.id),
           (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = seat.id),
           (select count(*) from public.leads l
             where l.campaign_id = c.id and l.assigned_seat_id = seat.id
               and l.status in ('new', 'callback', 'promised') and not l.do_not_call
               and (l.next_call_at is null or l.next_call_at <= now())),
           (select count(*) from public.leads l
             where l.campaign_id = c.id and l.assigned_seat_id is null
               and l.status in ('new', 'callback', 'promised') and not l.do_not_call and l.consent_call
               and (l.next_call_at is null or l.next_call_at <= now())
               and (l.status <> 'promised' or l.promised_date is null or l.promised_date <= today)),
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', r.key, 'label', r.label,
                     'needs_date', r.needs_date, 'needs_amount', r.needs_amount,
                     'needs_reason', r.needs_reason, 'needs_rating', r.needs_rating,
                     'reason_choices', r.reason_choices, 'counts_as_good', r.counts_as_good,
                     'common', r.call_type_id is null)), '[]'::jsonb)
              from public.call_type_results_for(c.call_type_id, c.institute_id) r),
           seat.id = any (c.focus_seats),
           case when seat.id = any (c.focus_seats) and c.daily_target is not null
                then ceil(c.daily_target::numeric / cardinality(c.focus_seats))::int end
    from public.campaigns c
    join public.call_types t on t.id = c.call_type_id
    where c.institute_id = seat.institute_id and c.status in ('running', 'paused')
      and (c.open_to_all or exists (select 1 from public.campaign_members m
                                    where m.campaign_id = c.id and m.seat_id = seat.id))
    order by (seat.id = any (c.focus_seats)) desc, c.status, t.sort_order, t.label, c.class_label nulls last, c.board nulls last, c.name;
end $$;

-- =====================================================================================================
-- 7. Grants
-- =====================================================================================================

do $$
declare f text;
begin
  foreach f in array array[
    'ap_calling_kind(text)', 'ap_default_mode(text)', 'ap_mode(uuid, text)', 'ap_paused(uuid)', 'ap_working_days(date, date)',
    'ap_n(numeric, text, text)', 'ap_names(text[])', 'ap_class_text(text, text)', 'ap_list_name(text, text, text, date)',
    'ap_call_hours(int, text)', 'ap_strip_money(jsonb)', 'ap_best_hours(uuid, text)', 'ap_caller_scores(uuid, text, int)',
    'ap_pick_script(uuid, text, text)', 'ap_pick_template(uuid, text)', 'ap_plan_callers(uuid, text, int, uuid[])',
    'ap_plan_common(uuid, text, text, int, date)', 'ap_actor_seat(uuid)', 'ap_rule_fees_due(uuid)', 'ap_rule_missed_promises(uuid)',
    'ap_rule_enquiries(uuid)', 'ap_rule_behind_pace(uuid)', 'ap_rule_setup(uuid)', 'ap_check_callers(uuid, jsonb)',
    'ap_exec_fees_list(uuid, jsonb, uuid)', 'ap_exec_missed(uuid, jsonb)', 'ap_exec_enquiries(uuid, jsonb)',
    'ap_exec_pace(uuid, jsonb)', 'ap_execute(uuid, text, jsonb, uuid)', 'ap_undo(uuid, text, jsonb)', 'ap_viewer()',
    'ap_may_see(text, boolean, text)', 'ap_card(public.suggestions, boolean)', 'ap_suggestion_for(uuid)']
  loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
end $$;

revoke all on function public.autopilot_plan(uuid) from public, anon;
revoke all on function public.my_suggestions() from public, anon;
revoke all on function public.accept_suggestion(uuid, jsonb) from public, anon;
revoke all on function public.undo_suggestion(uuid) from public, anon;
revoke all on function public.dismiss_suggestion(uuid, int) from public, anon;
revoke all on function public.autopilot_numbers() from public, anon;
revoke all on function public.autopilot_get_settings() from public, anon;
revoke all on function public.autopilot_save_settings(boolean, jsonb, text) from public, anon;
revoke all on function public.autopilot_save_goals(int, int, int, date, date, date, date) from public, anon;
revoke all on function public.caller_scores(text) from public, anon;
revoke all on function public.autopilot_list_defaults(text, text, text, date) from public, anon;
revoke all on function public.autopilot_create_list(jsonb) from public, anon;
revoke all on function public.autopilot_claim_reminders(int) from public, anon, authenticated;
revoke all on function public.my_campaigns() from public, anon;

grant execute on function public.autopilot_plan(uuid) to authenticated, service_role;
grant execute on function public.my_suggestions() to authenticated;
grant execute on function public.accept_suggestion(uuid, jsonb) to authenticated;
grant execute on function public.undo_suggestion(uuid) to authenticated;
grant execute on function public.dismiss_suggestion(uuid, int) to authenticated;
grant execute on function public.autopilot_numbers() to authenticated;
grant execute on function public.autopilot_get_settings() to authenticated;
grant execute on function public.autopilot_save_settings(boolean, jsonb, text) to authenticated;
grant execute on function public.autopilot_save_goals(int, int, int, date, date, date, date) to authenticated;
grant execute on function public.caller_scores(text) to authenticated;
grant execute on function public.autopilot_list_defaults(text, text, text, date) to authenticated;
grant execute on function public.autopilot_create_list(jsonb) to authenticated;
grant execute on function public.autopilot_claim_reminders(int) to service_role;
grant execute on function public.my_campaigns() to authenticated;
