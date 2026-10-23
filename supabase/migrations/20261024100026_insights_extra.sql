-- Phase A, Sprint 11 (insights-extra): script A/B test, weekly brief, practice mode.
-- Apply after 20261024100014_features.sql. Depends only on 0001 to 0014.
--
-- Script test: an admin picks two versions of a campaign's script. Each lead gets one of them (alternating,
--   so the split is 50/50), stored in script_test_leads so the same lead always hears the same version. The
--   caller page asks campaign_script_version(campaign, lead) for the steps to show and must send the
--   script_id and version it got in call_outcomes (script_id, script_version), or the call is not counted.
--   Results are counted per 100 picked-up calls; "how sure" is worked out in the browser
--   (web/js/admin/insights-extra.js) from the counts admin_script_test returns.
-- Weekly brief: four plain lines from rules (forecast, best hours, promises, script versions), the same text
--   on Insights (admin_weekly_brief) and in the Monday email (Edge Function weekly-brief, service role).
-- Practice: an admin sends a caller to practise a script (practice_assignments); the caller sees it with
--   my_practice() on web/practice.html. Practice never writes call_outcomes.
-- Script test and practice are part of the Scripts add-on: every function checks has_feature(inst, 'scripts')
--   (a trial has everything). Money: only the brief's forecast line uses amounts, and only when the person may
--   see money (can_see_money); the email is counts only. Rules: docs/data-contract.md.

-- ---------- small helpers (pure) ----------

-- A count with Indian grouping: 120000 to '1,20,000'. Same as count() in web/js/admin/shared.js.
create or replace function public.ix_count(n numeric)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  d    text := abs(round(coalesce(n, 0)))::numeric(20, 0)::text;
  rest text;
begin
  if length(d) > 3 then
    rest := regexp_replace(left(d, length(d) - 3), '(\d)(?=(\d{2})+$)', '\1,', 'g');
    d := rest || ',' || right(d, 3);
  end if;
  return case when n < 0 and round(n) <> 0 then '-' else '' end || d;
end $$;

-- Short rupees for a sentence, like rupeesShort() in shared.js: '₹38,500', '₹31.2L', '₹1.5Cr'.
create or replace function public.ix_rupees_short(n numeric)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  a numeric := abs(coalesce(n, 0));
  s text := case when n < 0 then '-' else '' end;
begin
  if round(a / 1e4) >= 1000 then
    return s || '₹' || trim(trailing '.' from trim(trailing '0' from round(a / 1e7, 1)::text)) || 'Cr';
  elsif a >= 1e5 then
    return s || '₹' || trim(trailing '.' from trim(trailing '0' from round(a / 1e5, 1)::text)) || 'L';
  end if;
  return s || '₹' || public.ix_count(a);
end $$;

-- '7 pm', '12 am'. Hours 0 to 24.
create or replace function public.ix_hour(h int)
returns text
language sql immutable
set search_path = public
as $$
  select (case when h % 12 = 0 then 12 else h % 12 end)::text || case when h % 24 < 12 then ' am' else ' pm' end;
$$;

-- A two-hour window from hour h: '7–9 pm', '11 am–1 pm'.
create or replace function public.ix_hour_range(h int)
returns text
language sql immutable
set search_path = public
as $$
  select case when (h % 24 < 12) = ((h + 2) % 24 < 12) and (h + 2) % 24 <> 0
              then (case when h % 12 = 0 then 12 else h % 12 end)::text || '–' || public.ix_hour(h + 2)
              else public.ix_hour(h) || '–' || public.ix_hour(h + 2) end;
$$;

-- Whether an institute has an add-on, without looking at who is signed in (for the server-side brief).
-- Same rule as has_feature(): a trial has everything. Granted to nobody.
create or replace function public.institute_has_feature(inst uuid, feature text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from institutes i
                 where i.id = inst and (i.status = 'trial' or feature = any (i.features)));
$$;

-- ---------- internal: campaign calls as they finally stand ----------

-- One row per original campaign call in the range (p_campaign null = every campaign of the institute), with
-- its latest correction applied, like admin_effective_outcomes. talked: someone picked up (not no answer,
-- busy, wrong number or a dropped line). good: the result counts as good for the campaign's call type (old
-- rows without a result: outcome 'won'). needs_date: the result asks for a date (a promise when good).
-- Returns amounts, so it is granted to nobody: callers of it apply the money rules.
create or replace function public.ix_campaign_calls(
  p_institute uuid, p_campaign uuid, p_from timestamptz, p_to timestamptz)
returns table (call_id uuid, seat_id uuid, campaign_id uuid, lead_id uuid, script_id text, script_version int,
               script_step text, result_key text, outcome text, connected_seconds int, amount numeric,
               promised_date date, happened_at timestamptz, talked boolean, good boolean, needs_date boolean)
language sql stable security definer set search_path = public
as $$
  with recursive roots as (
    select c.id, c.uploaded_at
    from public.call_outcomes c
    where c.institute_id = p_institute
      and c.corrects_id is null
      and c.campaign_id is not null
      and (p_campaign is null or c.campaign_id = p_campaign)
      and coalesce(c.dialled_at, c.uploaded_at) >= p_from
      and coalesce(c.dialled_at, c.uploaded_at) < p_to
  ),
  chain as (
    select r.id as node, r.id as root_id, 0 as depth, r.uploaded_at
    from roots r
    union all
    select n.id, ch.root_id, ch.depth + 1, n.uploaded_at
    from public.call_outcomes n
    join chain ch on n.corrects_id = ch.node
  ),
  latest as (
    select distinct on (ch.root_id) ch.root_id, ch.node
    from chain ch
    order by ch.root_id, ch.depth desc, ch.uploaded_at desc, ch.node
  )
  select r.id, r.seat_id, r.campaign_id, r.lead_id, r.script_id, r.script_version, r.script_step,
         o.result_key, o.outcome, o.connected_seconds, o.amount, o.promised_date,
         coalesce(r.dialled_at, r.uploaded_at),
         (coalesce(o.result_key, '') not in ('no_answer', 'busy', 'wrong_number')
           and o.outcome not in ('no_answer', 'busy', 'dropped_network')),
         coalesce(g.counts_as_good, o.result_key is null and o.outcome = 'won'),
         coalesce(g.needs_date, false)
  from latest l
  join public.call_outcomes o on o.id = l.node
  join public.call_outcomes r on r.id = l.root_id
  join public.campaigns cp on cp.id = r.campaign_id
  left join lateral (
    select x.counts_as_good, x.needs_date
    from public.call_type_results_for(cp.call_type_id, p_institute) x
    where x.key = o.result_key
    limit 1) g on true;
$$;

-- ---------- script A/B test: tables ----------

create table public.script_tests (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  campaign_id   uuid not null,
  script_id     uuid not null,
  version_a     int not null check (version_a >= 1),
  version_b     int not null check (version_b >= 1),
  -- running: leads are being split; ended: stopped, with the version chosen for everyone (winner) or none.
  status        text not null default 'running' check (status in ('running', 'ended')),
  winner        int,
  started_by    uuid references public.seats (id) on delete set null,
  started_at    timestamptz not null default now(),
  ended_by      uuid references public.seats (id) on delete set null,
  ended_at      timestamptz,
  check (version_a <> version_b),
  check (winner is null or winner = version_a or winner = version_b),
  check ((status = 'running') = (ended_at is null)),
  unique (id, institute_id),
  foreign key (campaign_id, institute_id) references public.campaigns (id, institute_id) on delete cascade,
  foreign key (script_id, institute_id) references public.scripts (id, institute_id) on delete cascade
);

-- One running test per campaign.
create unique index script_tests_one_running on public.script_tests (campaign_id) where status = 'running';

-- Which version each lead hears in a test ('a' or 'b'). Written only by campaign_script_version().
create table public.script_test_leads (
  test_id      uuid not null references public.script_tests (id) on delete cascade,
  lead_id      uuid not null references public.leads (id) on delete cascade,
  arm          text not null check (arm in ('a', 'b')),
  assigned_at  timestamptz not null default now(),
  primary key (test_id, lead_id)
);

-- ---------- practice mode: table ----------

-- An admin's request that a caller practise a script. done_at: the last time the caller finished it.
create table public.practice_assignments (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  seat_id       uuid not null,
  script_id     uuid not null,
  note          text not null default '' check (length(note) <= 300),
  assigned_by   uuid references public.seats (id) on delete set null,
  assigned_at   timestamptz not null default now(),
  done_at       timestamptz,
  done_seconds  int check (done_seconds is null or done_seconds between 0 and 86400),
  times_done    int not null default 0 check (times_done >= 0),
  unique (seat_id, script_id),
  foreign key (seat_id, institute_id) references public.seats (id, institute_id) on delete cascade,
  foreign key (script_id, institute_id) references public.scripts (id, institute_id) on delete cascade
);

-- ---------- row-level security: no direct browser access, functions only ----------

alter table public.script_tests         enable row level security;
alter table public.script_test_leads    enable row level security;
alter table public.practice_assignments enable row level security;
revoke all on public.script_tests, public.script_test_leads, public.practice_assignments from anon, authenticated;

-- ---------- script A/B test: functions ----------

-- The script a call should use: the steps to show, the script id and version to save in call_outcomes, and
-- the running test (test_id, arm 'a' or 'b') when the lead is in one. For the caller of the lead (active
-- seat, campaign member) and admins of the institute. Without p_lead, or without a running test, it is the
-- script's published version. No rows when the campaign has no script, the script has no published version,
-- or the institute does not have the Scripts add-on.
create or replace function public.campaign_script_version(p_campaign uuid, p_lead uuid default null)
returns table (script_id uuid, script_name text, version int, steps jsonb, test_id uuid, arm text)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  c      public.campaigns;
  l      public.leads;
  t      public.script_tests;
  admin  boolean;
  my_arm text;
  n      bigint;
  v      int;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null then raise exception 'campaign not found' using errcode = '42501'; end if;
  admin := public.is_admin_of(c.institute_id);
  if not admin and (c.status = 'draft' or not exists (
      select 1 from public.campaign_members m join public.seats s on s.id = m.seat_id
      where m.campaign_id = c.id and s.user_id = auth.uid() and s.status = 'active')) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if p_lead is not null then
    select * into l from public.leads where id = p_lead and campaign_id = c.id;
    if l.id is null or (not admin and not exists (
        select 1 from public.seats s where s.id = l.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active')) then
      raise exception 'lead not found' using errcode = '42501';
    end if;
  end if;
  if c.script_id is null or not public.has_feature(c.institute_id, 'scripts') then return; end if;

  select * into t from public.script_tests x
    where x.campaign_id = c.id and x.status = 'running' and x.script_id = c.script_id;
  if t.id is not null and p_lead is not null then
    -- Lock the test so two callers asking at once still alternate.
    perform 1 from public.script_tests x where x.id = t.id for update;
    select a.arm into my_arm from public.script_test_leads a where a.test_id = t.id and a.lead_id = p_lead;
    if my_arm is null then
      select count(*) into n from public.script_test_leads a where a.test_id = t.id;
      my_arm := case when n % 2 = 0 then 'a' else 'b' end;
      insert into public.script_test_leads (test_id, lead_id, arm) values (t.id, p_lead, my_arm);
    end if;
    v := case when my_arm = 'a' then t.version_a else t.version_b end;
    return query
      select sv.script_id, s.name, sv.version, sv.steps, t.id, my_arm
      from public.script_versions sv join public.scripts s on s.id = sv.script_id
      where sv.script_id = t.script_id and sv.version = v;
    if found then return; end if;
    -- The tested version was a draft that has since been deleted: use the published version.
  end if;

  return query
    select sv.script_id, s.name, sv.version, sv.steps, null::uuid, null::text
    from public.script_versions sv join public.scripts s on s.id = sv.script_id
    where sv.script_id = c.script_id and sv.published;
end $$;

-- Internal: the campaign for an admin action, checked (admin of its institute, Scripts add-on).
create or replace function public.ix_admin_campaign(p_campaign uuid)
returns public.campaigns
language plpgsql stable security definer set search_path = public
as $$
declare c public.campaigns;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null or not public.is_admin_of(c.institute_id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if not public.has_feature(c.institute_id, 'scripts') then
    raise exception 'Script tests are part of the Scripts add-on' using errcode = '42501';
  end if;
  return c;
end $$;

-- Start a test of two versions of the campaign's script. Returns the test id.
create or replace function public.admin_start_script_test(p_campaign uuid, p_version_a int, p_version_b int)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  c   public.campaigns := public.ix_admin_campaign(p_campaign);
  tid uuid;
begin
  if c.status = 'closed' then raise exception 'this campaign is closed' using errcode = '22023'; end if;
  if c.script_id is null then raise exception 'choose a script for this campaign first' using errcode = '22023'; end if;
  if p_version_a is null or p_version_b is null or p_version_a = p_version_b then
    raise exception 'choose two different versions' using errcode = '22023';
  end if;
  if (select count(*) from public.script_versions v
      where v.script_id = c.script_id and v.version in (p_version_a, p_version_b)) <> 2 then
    raise exception 'that script version was not found' using errcode = '22023';
  end if;
  if exists (select 1 from public.script_tests t where t.campaign_id = c.id and t.status = 'running') then
    raise exception 'a test is already running on this campaign; stop it first' using errcode = '22023';
  end if;
  insert into public.script_tests (institute_id, campaign_id, script_id, version_a, version_b, started_by)
    values (c.institute_id, c.id, c.script_id, p_version_a, p_version_b, (public.my_active_seat()).id)
    returning id into tid;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'script_test.started', tid::text);
  return tid;
end $$;

-- End a running test. p_winner = a version of the test: it becomes the script's published version, so every
-- campaign using the script uses it ("Use vX for everyone"). p_winner null: stop without a winner (the
-- published version stays as it is).
create or replace function public.admin_end_script_test(p_test uuid, p_winner int default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t   public.script_tests;
  vid uuid;
begin
  select * into t from public.script_tests where id = p_test;
  if t.id is null or not public.is_admin_of(t.institute_id) then
    raise exception 'test not found' using errcode = '42501';
  end if;
  if t.status <> 'running' then raise exception 'this test has already ended' using errcode = '22023'; end if;
  if p_winner is not null then
    if p_winner <> t.version_a and p_winner <> t.version_b then
      raise exception 'the winner must be one of the two versions' using errcode = '22023';
    end if;
    if not public.has_feature(t.institute_id, 'scripts') then
      raise exception 'Script tests are part of the Scripts add-on' using errcode = '42501';
    end if;
    select v.id into vid from public.script_versions v where v.script_id = t.script_id and v.version = p_winner;
    if vid is null then raise exception 'that script version was not found' using errcode = '22023'; end if;
    perform 1 from public.scripts s where s.id = t.script_id for update;
    update public.script_versions v set published = false
      where v.script_id = t.script_id and v.published and v.id <> vid;
    update public.script_versions v set published = true where v.id = vid and not v.published;
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (t.institute_id, auth.uid(), 'script.published', vid::text);
  end if;
  update public.script_tests x
    set status = 'ended', winner = p_winner, ended_at = now(), ended_by = (public.my_active_seat()).id
    where x.id = t.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (t.institute_id, auth.uid(), 'script_test.ended',
            t.id::text || ':' || coalesce('v' || p_winner::text, 'none'));
end $$;

-- The script test card for a campaign: the campaign and its script, the script's versions (to choose from),
-- and the running test, or else the last one, with counts per version since it started:
--   calls, picked_up (someone answered), good (good results among picked-up calls), avg_seconds (average
--   connected length of picked-up calls). No money. "How sure" is computed in the browser from these counts.
create or replace function public.admin_script_test(p_campaign uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  c        public.campaigns := public.ix_admin_campaign(p_campaign);
  t        public.script_tests;
  sname    text;
  versions jsonb;
  arms     jsonb;
begin
  select s.name into sname from public.scripts s where s.id = c.script_id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'version', v.version, 'published', v.published, 'change_note', v.change_note, 'created_at', v.created_at)
           order by v.version desc), '[]'::jsonb)
    into versions
    from (select * from public.script_versions v where v.script_id = c.script_id order by v.version desc limit 30) v;

  select * into t from public.script_tests x
    where x.campaign_id = c.id order by (x.status = 'running') desc, x.started_at desc limit 1;

  if t.id is not null then
    select jsonb_agg(jsonb_build_object(
             'arm', a.arm, 'version', a.version,
             'calls', coalesce(s.calls, 0), 'picked_up', coalesce(s.picked_up, 0), 'good', coalesce(s.good, 0),
             'avg_seconds', s.avg_seconds,
             'change_note', (select v.change_note from public.script_versions v
                             where v.script_id = t.script_id and v.version = a.version))
             order by a.arm)
      into arms
      from (values ('a', t.version_a), ('b', t.version_b)) a(arm, version)
      left join (
        select x.script_version as version, count(*) as calls,
               count(*) filter (where x.talked) as picked_up,
               count(*) filter (where x.talked and x.good) as good,
               round(avg(x.connected_seconds) filter (where x.talked and x.connected_seconds > 0)) as avg_seconds
        from public.ix_campaign_calls(c.institute_id, c.id, t.started_at - interval '1 minute',
                                      coalesce(t.ended_at, now()) + interval '1 minute') x
        where x.script_id = t.script_id::text and x.script_version in (t.version_a, t.version_b)
        group by x.script_version) s on s.version = a.version;
  end if;

  return jsonb_build_object(
    'campaign', jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status,
                                   'script_id', c.script_id, 'script_name', sname),
    'versions', versions,
    'test', case when t.id is null then null else jsonb_build_object(
              'id', t.id, 'status', t.status, 'version_a', t.version_a, 'version_b', t.version_b,
              'winner', t.winner, 'started_at', t.started_at, 'ended_at', t.ended_at,
              'same_script', t.script_id is not distinct from c.script_id,
              'leads', (select count(*) from public.script_test_leads a where a.test_id = t.id),
              'arms', coalesce(arms, '[]'::jsonb)) end);
end $$;

-- ---------- weekly brief ----------

-- Line 1: will the campaign get there? Pace of the last 7 days, carried to the end date (or one week).
-- Fees with money allowed: rupees collected (reported by callers) against rupees due. Otherwise leads with a
-- good result against all leads. Under 50 calls: "not enough calls yet".
create or replace function public.ix_brief_forecast(p_campaign uuid, p_money boolean)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  c          public.campaigns;
  ctype      text;
  today      date := (now() at time zone 'Asia/Kolkata')::date;
  n          bigint;
  days       int;
  by_text    text;
  collected  numeric;
  collected7 numeric;
  due        numeric;
  good_leads bigint;
  new7       bigint;
  all_leads  bigint;
  proj       numeric;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null then return 'No campaign is running, so there is nothing to forecast yet.'; end if;
  select t.key into ctype from public.call_types t where t.id = c.call_type_id;
  select count(*) into n from public.ix_campaign_calls(c.institute_id, c.id, '-infinity', now() + interval '1 minute');
  if n < 50 then
    return c.name || ': not enough calls yet to forecast (' || n || ' of 50).';
  end if;
  if c.end_date is not null and c.end_date >= today then
    days := c.end_date - today;
    by_text := 'by ' || to_char(c.end_date, 'FMDD Mon');
  else
    days := 7;
    by_text := 'in a week';
  end if;

  if ctype = 'fees' and p_money then
    select coalesce(sum(l.amount_due), 0) into due from public.leads l where l.campaign_id = c.id;
    if due > 0 then
      select coalesce(sum(x.amount) filter (where x.result_key in ('paid', 'paid_part')), 0),
             coalesce(sum(x.amount) filter (where x.result_key in ('paid', 'paid_part')
                                              and x.happened_at >= now() - interval '7 days'), 0)
        into collected, collected7
        from public.ix_campaign_calls(c.institute_id, c.id, '-infinity', now() + interval '1 minute') x;
      proj := least(due, collected + collected7 / 7.0 * days);
      return c.name || ': at this speed you will collect ' || public.ix_rupees_short(proj) || ' of '
        || public.ix_rupees_short(due) || ' ' || by_text || ' (' || public.ix_rupees_short(collected)
        || ' so far, reported by callers).';
    end if;
  end if;

  select count(*) into all_leads from public.leads l where l.campaign_id = c.id;
  select count(*) filter (where s.first_good is not null),
         count(*) filter (where s.first_good >= now() - interval '7 days')
    into good_leads, new7
    from (select x.lead_id, min(x.happened_at) filter (where x.good) as first_good
          from public.ix_campaign_calls(c.institute_id, c.id, '-infinity', now() + interval '1 minute') x
          where x.lead_id is not null
          group by x.lead_id) s;
  if all_leads = 0 then return c.name || ': no leads yet, so there is nothing to forecast.'; end if;
  proj := least(all_leads, good_leads + round(new7 / 7.0 * days));
  return c.name || ': ' || public.ix_count(good_leads) || ' of ' || public.ix_count(all_leads)
    || ' leads have a good result so far. At this speed it will be ' || public.ix_count(proj) || ' ' || by_text || '.';
end $$;

-- Line 2: the two-hour window (weekdays or weekends) when most people pick up, over the last 4 weeks, and a
-- caller who mostly calls at another hour. Needs 50 calls, and 20 in a window.
create or replace function public.ix_brief_hours(p_institute uuid, p_campaign uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  n      bigint;
  b_kind text;
  b_h    int;
  b_rate numeric;
  w_name text;
  w_hr   int;
  w_pct  numeric;
  line   text;
begin
  select count(*) into n
    from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '28 days', now() + interval '1 minute');
  if n < 50 then
    return 'Not enough calls in the last 4 weeks to find the best hours to call (' || n || ' of 50).';
  end if;

  with calls as (
    select x.talked, x.happened_at at time zone 'Asia/Kolkata' as lt
    from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '28 days', now() + interval '1 minute') x
  )
  select w.kind, w.h, w.picked::numeric / w.calls into b_kind, b_h, b_rate
  from (select case when extract(isodow from c.lt) <= 5 then 'weekdays' else 'weekends' end as kind, h.h,
               count(*) as calls, count(*) filter (where c.talked) as picked
        from calls c
        cross join generate_series(0, 22) h(h)
        where extract(hour from c.lt)::int in (h.h, h.h + 1)
        group by 1, 2
        having count(*) >= 20) w
  order by w.picked::numeric / w.calls desc, w.calls desc, w.h
  limit 1;
  if b_kind is null then
    return 'Not enough calls at any one time of day yet to find the best hours to call.';
  end if;
  line := 'People pick up most on ' || b_kind || ' ' || public.ix_hour_range(b_h)
          || ' (' || round(b_rate * 100) || '%).';

  with calls as (
    select x.seat_id, extract(hour from x.happened_at at time zone 'Asia/Kolkata')::int as hr
    from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '28 days', now() + interval '1 minute') x
  )
  select s.label, t.hr, t.share into w_name, w_hr, w_pct
  from (select c.seat_id, c.hr,
               count(*)::numeric / sum(count(*)) over (partition by c.seat_id) as share,
               sum(count(*)) over (partition by c.seat_id) as seat_calls,
               row_number() over (partition by c.seat_id order by count(*) desc, c.hr) as rn
        from calls c
        group by c.seat_id, c.hr) t
  join public.seats s on s.id = t.seat_id
  where t.rn = 1 and t.seat_calls >= 10 and t.hr not in (b_h, b_h + 1)
  order by t.seat_calls desc, s.label
  limit 1;
  if w_name is not null then
    line := line || ' ' || w_name || ' calls mostly at ' || public.ix_hour(w_hr)
            || ' (' || round(w_pct * 100) || '% of their calls).';
  end if;
  return line;
end $$;

-- Line 3: broken promises (leads still "promised" after the promised date) and the 7-day rule: how often
-- promises more than 7 days away were kept, against promises within 7 days. A promise is a good result that
-- asks for a date (Will pay on date, Visit booked …); it is kept when the lead is done or a later call has a
-- good result without a date (Paid …). Only promises already due count.
create or replace function public.ix_brief_promises(p_institute uuid, p_campaign uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  today  date := (now() at time zone 'Asia/Kolkata')::date;
  broken bigint;
  nf     bigint;
  kf     bigint;
  nn     bigint;
  kn     bigint;
  line   text;
begin
  select count(*) into broken from public.leads l
    where l.institute_id = p_institute and (p_campaign is null or l.campaign_id = p_campaign)
      and l.status = 'promised' and l.promised_date < today and not l.do_not_call;

  with calls as (
    select * from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '120 days', now() + interval '1 minute')
  ), promises as (
    select p.lead_id, p.happened_at,
           p.promised_date - (p.happened_at at time zone 'Asia/Kolkata')::date > 7 as far
    from calls p
    where p.good and p.needs_date and p.promised_date is not null and p.promised_date < today and p.lead_id is not null
  ), scored as (
    select pr.far,
           exists (select 1 from public.leads l where l.id = pr.lead_id and l.status = 'done')
           or exists (select 1 from calls k where k.lead_id = pr.lead_id and k.good and not k.needs_date
                        and k.happened_at > pr.happened_at) as kept
    from promises pr
  )
  select count(*) filter (where far), count(*) filter (where far and kept),
         count(*) filter (where not far), count(*) filter (where not far and kept)
    into nf, kf, nn, kn
    from scored;

  if broken = 0 and nf + nn = 0 then return 'No promises have come due yet.'; end if;
  line := case broken when 0 then 'No broken promises right now.'
                      when 1 then '1 person broke a promise.'
                      else public.ix_count(broken) || ' people broke a promise.' end;
  if nf >= 5 and nn >= 5 then
    line := line || ' People who promised more than 7 days away kept it ' || round(100.0 * kf / nf)
            || '% of the time (within 7 days: ' || round(100.0 * kn / nn) || '%).';
    if 100.0 * kf / nf + 10 < 100.0 * kn / nn then
      line := line || ' Ask for a date within 7 days.';
    end if;
  elsif nf + nn >= 5 then
    line := line || ' ' || round(100.0 * (kf + kn) / (nf + nn)) || '% of promises that came due were kept.';
  end if;
  return line;
end $$;

-- Line 4: the newest script version against the one before, in good results per 100 picked-up calls (last
-- 90 days, 30 picked-up calls each), and the step where most calls without a good result end.
-- Scripts add-on only.
create or replace function public.ix_brief_script(p_institute uuid, p_campaign uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  sid    text;
  sname  text;
  v_new  int;
  v_old  int;
  t_new  bigint; g_new bigint;
  t_old  bigint; g_old bigint;
  diff   int;
  step   text;
  title  text;
  line   text;
begin
  if not public.institute_has_feature(p_institute, 'scripts') then
    return 'Add Scripts to see how each script version does.';
  end if;
  -- The campaign's own script when it has one, else the script with the most calls in the last 4 weeks.
  if p_campaign is not null then
    select c.script_id::text into sid from public.campaigns c where c.id = p_campaign;
  end if;
  if sid is null then
    select x.script_id into sid
      from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '28 days', now() + interval '1 minute') x
      where x.script_id is not null and x.script_version is not null
      group by x.script_id order by count(*) desc, x.script_id limit 1;
  end if;
  if sid is null then return 'No calls with a script in the last 4 weeks, so there is no script change to compare.'; end if;
  select s.name into sname from public.scripts s where s.id::text = sid and s.institute_id = p_institute;
  sname := coalesce(sname, 'Script');

  select max(c.script_version) into v_new from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '90 days', now() + interval '1 minute') c where c.script_id = sid;
  if v_new is null then return sname || ': no calls in the last 4 weeks, so there is no change to compare.'; end if;
  select max(c.script_version) into v_old from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '90 days', now() + interval '1 minute') c where c.script_id = sid and c.script_version < v_new;
  if v_old is null then
    return sname || ' v' || v_new || ': no earlier version to compare with yet.';
  end if;

  select count(*) filter (where c.talked), count(*) filter (where c.talked and c.good) into t_new, g_new
    from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '90 days', now() + interval '1 minute') c where c.script_id = sid and c.script_version = v_new;
  select count(*) filter (where c.talked), count(*) filter (where c.talked and c.good) into t_old, g_old
    from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '90 days', now() + interval '1 minute') c where c.script_id = sid and c.script_version = v_old;
  if t_new < 30 or t_old < 30 then
    return sname || ' v' || v_new || ': not enough picked-up calls yet to compare with v' || v_old
      || ' (' || least(t_new, t_old) || ' of 30).';
  end if;

  diff := round(100.0 * g_new / t_new - 100.0 * g_old / t_old);
  line := sname || ': v' || v_new || ' gets '
    || case when diff > 0 then diff || ' more good results per 100 picked-up calls than v' || v_old || '.'
            when diff < 0 then (-diff) || ' fewer good results per 100 picked-up calls than v' || v_old || '.'
            else 'about the same good results per 100 picked-up calls as v' || v_old || '.' end;

  select c.script_step into step from public.ix_campaign_calls(p_institute, p_campaign, now() - interval '90 days', now() + interval '1 minute') c
    where c.script_id = sid and c.script_version = v_new and c.talked and not c.good and c.script_step is not null
    group by c.script_step having count(*) >= 10
    order by count(*) desc, c.script_step limit 1;
  if step is not null then
    select nullif(trim(e ->> 'title'), '') into title
      from public.script_versions v, jsonb_array_elements(v.steps) e
      where v.script_id::text = sid and v.version = v_new and e ->> 'id' = step limit 1;
    line := line || ' Most calls without a good result end at "' || coalesce(title, step) || '".';
  end if;
  return line;
end $$;

-- The four lines for an institute (p_campaign null: the busiest running or paused campaign for the forecast,
-- every campaign for the rest). p_money: may line 1 show rupees. For the server only (service role):
-- the Edge Function weekly-brief sends it with p_money false (the email is counts only).
create or replace function public.weekly_brief_lines(p_institute uuid, p_campaign uuid default null,
                                                     p_money boolean default false)
returns text[]
language plpgsql security definer set search_path = public
as $$
declare camp uuid := p_campaign;
begin
  if p_campaign is not null and not exists (
      select 1 from public.campaigns c where c.id = p_campaign and c.institute_id = p_institute) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if camp is null then
    select c.id into camp from public.campaigns c
      where c.institute_id = p_institute and c.status in ('running', 'paused')
      order by (select count(*) from public.call_outcomes o
                where o.campaign_id = c.id and o.corrects_id is null
                  and coalesce(o.dialled_at, o.uploaded_at) >= now() - interval '7 days') desc,
               c.created_at desc, c.id
      limit 1;
  end if;
  return array[
    public.ix_brief_forecast(camp, coalesce(p_money, false)),
    public.ix_brief_hours(p_institute, p_campaign),
    public.ix_brief_promises(p_institute, p_campaign),
    public.ix_brief_script(p_institute, p_campaign)];
end $$;

-- The weekly brief for the signed-in admin's institute, as shown on Insights (and reused for WhatsApp).
-- Rupees only when can_see_money(); otherwise counts.
create or replace function public.admin_weekly_brief(p_campaign uuid default null)
returns text[]
language plpgsql security definer set search_path = public
as $$
declare seat public.seats := public.my_active_seat();
begin
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an admin can see the weekly brief' using errcode = '42501';
  end if;
  return public.weekly_brief_lines(seat.institute_id, p_campaign, public.can_see_money(seat.institute_id));
end $$;

-- Who gets the Monday email: each live institute (trial, active, grace) and its active owners' emails.
-- For the server only (service role).
create or replace function public.weekly_brief_recipients()
returns table (institute_id uuid, institute_name text, emails text[])
language sql stable security definer set search_path = public
as $$
  select i.id, i.name, array_agg(distinct u.email order by u.email)
  from public.institutes i
  join public.seats s on s.institute_id = i.id and s.status = 'active' and s.role = 'admin' and s.admin_kind = 'owner'
  join auth.users u on u.id = s.user_id
  where i.status in ('trial', 'active', 'grace') and coalesce(u.email, '') <> ''
  group by i.id, i.name
  order by i.name, i.id;
$$;

-- ---------- practice mode: functions ----------

-- Send a caller to practise a script (from coaching). The script needs a published version. Asking again for
-- the same caller and script refreshes the request (new note, not done yet). Returns the assignment id.
create or replace function public.admin_assign_practice(p_seat uuid, p_script uuid, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  s    public.seats;
  note text := trim(coalesce(p_note, ''));
  aid  uuid;
begin
  select * into s from public.seats where id = p_seat;
  if s.id is null or not public.is_admin_of(s.institute_id) then
    raise exception 'seat not found' using errcode = '42501';
  end if;
  if s.status = 'revoked' then raise exception 'this seat is not in use' using errcode = '22023'; end if;
  if not public.has_feature(s.institute_id, 'scripts') then
    raise exception 'Practice is part of the Scripts add-on' using errcode = '42501';
  end if;
  if not exists (select 1 from public.scripts x where x.id = p_script and x.institute_id = s.institute_id) then
    raise exception 'script not found' using errcode = '22023';
  end if;
  if not exists (select 1 from public.script_versions v where v.script_id = p_script and v.published) then
    raise exception 'publish this script before sending a caller to practise it' using errcode = '22023';
  end if;
  if length(note) > 300 then raise exception 'the note must be 300 characters or less' using errcode = '22023'; end if;

  insert into public.practice_assignments (institute_id, seat_id, script_id, note, assigned_by)
    values (s.institute_id, s.id, p_script, note, (public.my_active_seat()).id)
    on conflict (seat_id, script_id) do update
      set note = excluded.note, assigned_by = excluded.assigned_by, assigned_at = now(), done_at = null
    returning id into aid;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (s.institute_id, auth.uid(), 'practice.assigned', s.id::text || ':' || p_script::text);
  return aid;
end $$;

-- Practice requests in the admin's institute (newest first), for coaching.
create or replace function public.admin_list_practice()
returns table (id uuid, seat_id uuid, seat_label text, script_id uuid, script_name text, note text,
               assigned_at timestamptz, done_at timestamptz, done_seconds int, times_done int)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare seat public.seats := public.my_active_seat();
begin
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an admin can see practice requests' using errcode = '42501';
  end if;
  return query
    select p.id, p.seat_id, st.label, p.script_id, sc.name, p.note, p.assigned_at, p.done_at, p.done_seconds, p.times_done
    from public.practice_assignments p
    join public.seats st on st.id = p.seat_id
    join public.scripts sc on sc.id = p.script_id
    where p.institute_id = seat.institute_id
    order by p.assigned_at desc;
end $$;

-- What the signed-in caller can practise: the scripts their admin asked for first (assignment_id set), then
-- every other script of the institute with a published version (assignment_id null). Steps are the published
-- version's. Scripts add-on only.
create or replace function public.my_practice()
returns table (assignment_id uuid, script_id uuid, script_name text, version int, steps jsonb, note text,
               assigned_at timestamptz, assigned_by text, done_at timestamptz, times_done int)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare seat public.seats := public.my_active_seat();
begin
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if not public.has_feature(seat.institute_id, 'scripts') then
    raise exception 'Practice is part of the Scripts add-on' using errcode = '42501';
  end if;
  return query
    select p.id, sc.id, sc.name, v.version, v.steps, coalesce(p.note, ''), p.assigned_at, b.label,
           p.done_at, coalesce(p.times_done, 0)
    from public.scripts sc
    join public.script_versions v on v.script_id = sc.id and v.published
    left join public.practice_assignments p on p.script_id = sc.id and p.seat_id = seat.id
    left join public.seats b on b.id = p.assigned_by
    where sc.institute_id = seat.institute_id
    order by (p.id is not null and p.done_at is null) desc, (p.id is not null) desc, p.assigned_at desc nulls last, sc.name;
end $$;

-- The caller finished practising an assigned script: marks it done (time taken in seconds). Writes nothing
-- else; practice is never a call.
create or replace function public.my_practice_done(p_assignment uuid, p_seconds int default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare seat public.seats := public.my_active_seat();
begin
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if p_seconds is not null and (p_seconds < 0 or p_seconds > 86400) then
    raise exception 'the time must be between 0 and 86400 seconds' using errcode = '22023';
  end if;
  update public.practice_assignments p
    set done_at = now(), done_seconds = p_seconds, times_done = p.times_done + 1
    where p.id = p_assignment and p.seat_id = seat.id;
  if not found then raise exception 'practice not found' using errcode = '42501'; end if;
end $$;

-- ---------- grants ----------

revoke all on function public.ix_count(numeric) from public, anon;
revoke all on function public.ix_rupees_short(numeric) from public, anon;
revoke all on function public.ix_hour(int) from public, anon;
revoke all on function public.ix_hour_range(int) from public, anon;
grant execute on function public.ix_count(numeric) to authenticated, service_role;
grant execute on function public.ix_rupees_short(numeric) to authenticated, service_role;
grant execute on function public.ix_hour(int) to authenticated, service_role;
grant execute on function public.ix_hour_range(int) to authenticated, service_role;

-- Internal: nobody.
revoke all on function public.institute_has_feature(uuid, text) from public, anon, authenticated;
revoke all on function public.ix_campaign_calls(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.ix_admin_campaign(uuid) from public, anon, authenticated;
revoke all on function public.ix_brief_forecast(uuid, boolean) from public, anon, authenticated;
revoke all on function public.ix_brief_hours(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ix_brief_promises(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ix_brief_script(uuid, uuid) from public, anon, authenticated;

-- Server only.
revoke all on function public.weekly_brief_lines(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.weekly_brief_recipients() from public, anon, authenticated;
grant execute on function public.weekly_brief_lines(uuid, uuid, boolean) to service_role;
grant execute on function public.weekly_brief_recipients() to service_role;

-- Signed-in people (each function checks who).
revoke all on function public.campaign_script_version(uuid, uuid) from public, anon;
revoke all on function public.admin_start_script_test(uuid, int, int) from public, anon;
revoke all on function public.admin_end_script_test(uuid, int) from public, anon;
revoke all on function public.admin_script_test(uuid) from public, anon;
revoke all on function public.admin_weekly_brief(uuid) from public, anon;
revoke all on function public.admin_assign_practice(uuid, uuid, text) from public, anon;
revoke all on function public.admin_list_practice() from public, anon;
revoke all on function public.my_practice() from public, anon;
revoke all on function public.my_practice_done(uuid, int) from public, anon;
grant execute on function public.campaign_script_version(uuid, uuid) to authenticated;
grant execute on function public.admin_start_script_test(uuid, int, int) to authenticated;
grant execute on function public.admin_end_script_test(uuid, int) to authenticated;
grant execute on function public.admin_script_test(uuid) to authenticated;
grant execute on function public.admin_weekly_brief(uuid) to authenticated;
grant execute on function public.admin_assign_practice(uuid, uuid, text) to authenticated;
grant execute on function public.admin_list_practice() to authenticated;
grant execute on function public.my_practice() to authenticated;
grant execute on function public.my_practice_done(uuid, int) to authenticated;
