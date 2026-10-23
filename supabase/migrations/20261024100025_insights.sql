-- Insights tab, Phase A (docs/phase-a-plan.md, Sprint 11): forecast, what-if, best time to call, where calls
-- end, promises kept, caller coaching, "Apply plan" and "Set call hours". Apply after 0014.
-- Every report is admin only (admin_require) and returns aggregates: counts, rates and, for people who may see
-- money, totals of amounts. No lead names or numbers. Money follows docs/data-contract.md: amounts only when
-- can_see_money(), otherwise counts (the forecast switches to "payments" instead of ₹).
-- Script-based reports (where calls end, step coaching) need the 'scripts' add-on (has_feature).
-- A call is read as its latest correction, as in 0004: a correction never counts as a call of its own.
-- Words used below:
--   picked up  = the call's outcome is not no_answer, busy or dropped_network (someone answered);
--   good       = the result counts_as_good (old rows without a result: outcome 'won');
--   promise    = a 'will_pay_on' (fees) or 'will_renew_on' (renewal) result with a date;
--   kept       = the same lead later got a paying / renewing result on or before the promised date.

-- ---------- campaign columns for Insights ----------

alter table public.campaigns
  -- Good results wanted by the end date, for campaigns that are not fees (fees aim at 90% of due).
  add column if not exists goal int check (goal is null or goal between 1 and 1000000),
  -- The last plan applied from Insights: { callers, calls_per_caller, evening_share, applied_at, applied_by }.
  -- The callers count is a note: adding people to the campaign is done on the Campaigns tab.
  add column if not exists insights_plan jsonb check (insights_plan is null or
    (jsonb_typeof(insights_plan) = 'object' and length(insights_plan::text) <= 2000));

-- ---------- internal helpers (granted to nobody) ----------

-- Shape of campaigns.call_hours written by Insights:
--   { "tz": "Asia/Kolkata", "days": { "mon": [18, 19, 20], "sat": [10, 11] }, "source": "insights" }
-- days lists, per day (mon … sun), the hours (0–23, local to tz) to call in. A day that is not listed has
-- no preference. tz and source are optional text.
create or replace function public.insights_valid_call_hours(p jsonb)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  k text;
  v jsonb;
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' or length(p::text) > 4000 then return false; end if;
  if exists (select 1 from jsonb_object_keys(p) x where x not in ('tz', 'days', 'source')) then return false; end if;
  if p ? 'tz' and (jsonb_typeof(p->'tz') <> 'string' or length(p->>'tz') > 60) then return false; end if;
  if p ? 'source' and (jsonb_typeof(p->'source') <> 'string' or length(p->>'source') > 40) then return false; end if;
  if not (p ? 'days') or jsonb_typeof(p->'days') <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(p->'days') loop
    if k not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then return false; end if;
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 24 then return false; end if;
    if exists (select 1 from jsonb_array_elements(v) h
               where jsonb_typeof(h) <> 'number' or (h::text)::numeric not in
                 (0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23)) then
      return false;
    end if;
    if (select count(distinct h::text) from jsonb_array_elements(v) h) <> jsonb_array_length(v) then return false; end if;
  end loop;
  return true;
end $$;

-- The results that keep a promise of this kind (empty for a result that is not a promise).
create or replace function public.insights_kept_keys(p_promise text)
returns text[]
language sql immutable
as $$
  select case p_promise
           when 'will_pay_on' then array['paid', 'paid_part', 'already_paid']
           when 'will_renew_on' then array['renewed']
           else array[]::text[] end;
$$;

-- The campaign of this institute, or an error. Also checks that the caller is an admin of the institute.
create or replace function public.insights_campaign(p_institute uuid, p_campaign uuid)
returns public.campaigns
language plpgsql stable security definer set search_path = public
as $$
declare
  c public.campaigns;
begin
  perform public.admin_require(p_institute);
  select * into c from public.campaigns where id = p_campaign and institute_id = p_institute;
  if c.id is null then raise exception 'campaign not found in this institute' using errcode = '22023'; end if;
  return c;
end $$;

-- One row per original call of a campaign, with its latest correction applied. Money (amount) is returned;
-- only the reports below read it, after can_see_money().
create or replace function public.insights_calls(p_institute uuid, p_campaign uuid)
returns table (root_id uuid, seat_id uuid, lead_id uuid, happened_at timestamptz, outcome text, result_key text,
               connected_seconds int, promised_date date, amount numeric, reached_step text, step_times jsonb,
               picked boolean, good boolean)
language sql stable security definer set search_path = public
as $$
  with recursive roots as (
    select c.id, c.uploaded_at
    from public.call_outcomes c
    where c.institute_id = p_institute and c.campaign_id = p_campaign and c.corrects_id is null
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
  ),
  res as (
    select x.key, x.counts_as_good
    from public.campaigns k
    cross join lateral public.call_type_results_for(k.call_type_id, k.institute_id) x
    where k.id = p_campaign
  )
  select l.root_id, r.seat_id, coalesce(o.lead_id, r.lead_id), coalesce(r.dialled_at, r.uploaded_at),
         o.outcome, o.result_key, o.connected_seconds, o.promised_date, o.amount,
         coalesce(o.reached_step, r.reached_step), coalesce(o.step_times, r.step_times),
         o.outcome not in ('no_answer', 'busy', 'dropped_network'),
         coalesce((select res.counts_as_good from res where res.key = o.result_key limit 1), o.outcome = 'won')
  from latest l
  join public.call_outcomes o on o.id = l.node
  join public.call_outcomes r on r.id = l.root_id;
$$;

-- Steps of the campaign's script (published version, else the newest), in script order, with their titles.
create or replace function public.insights_script_steps(p_campaign uuid)
returns table (step text, step_label text, step_order int)
language sql stable security definer set search_path = public
as $$
  with v as (
    select sv.steps
    from public.campaigns c
    join public.script_versions sv on sv.script_id = c.script_id
    where c.id = p_campaign
    order by sv.published desc, sv.version desc
    limit 1
  )
  select s.value->>'id', coalesce(nullif(trim(s.value->>'title'), ''), s.value->>'id'), s.ord::int
  from v cross join lateral jsonb_array_elements(v.steps) with ordinality as s(value, ord)
  where jsonb_typeof(s.value) = 'object' and s.value ? 'id';
$$;

-- ---------- reports ----------

-- What the Insights tab needs to start: money access, add-ons, whether practice mode exists, and the
-- institute's campaigns (not drafts first … newest first) with their callers, calls and leads counts.
create or replace function public.admin_insights_setup(p_institute uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  camps jsonb;
begin
  perform public.admin_require(p_institute);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'status', c.status, 'call_type_key', t.key, 'call_type_label', t.label,
           'start_date', c.start_date, 'end_date', c.end_date, 'daily_target', c.daily_target,
           'call_hours', c.call_hours, 'goal', c.goal, 'plan', c.insights_plan, 'script_id', c.script_id,
           'callers', (select count(*) from public.campaign_members m join public.seats s on s.id = m.seat_id
                       where m.campaign_id = c.id and s.status = 'active'),
           'calls', (select count(*) from public.call_outcomes o where o.campaign_id = c.id and o.corrects_id is null),
           'leads', (select count(*) from public.leads l where l.campaign_id = c.id))
         order by case c.status when 'running' then 0 when 'paused' then 1 when 'closed' then 2 else 3 end,
                  c.start_date desc nulls last, c.created_at desc), '[]'::jsonb)
    into camps
    from public.campaigns c
    join public.call_types t on t.id = c.call_type_id
    where c.institute_id = p_institute;
  return jsonb_build_object(
    'money', public.can_see_money(p_institute),
    'features', array_remove(array[
        case when public.has_feature(p_institute, 'scripts') then 'scripts' end,
        case when public.has_feature(p_institute, 'ai_drafts') then 'ai_drafts' end], null),
    'practice_available', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                  where n.nspname = 'public' and p.proname = 'admin_assign_practice'),
    'campaigns', camps);
end $$;

-- The numbers the forecast model (web/js/insights-model.js) runs on, for one campaign.
-- kind 'amount' (fees, money allowed): values are ₹ reported by callers. kind 'count': values are good
-- results (payments or joinings …); fees fall back to counts when money is hidden (money_hidden true).
create or replace function public.admin_insights_forecast(p_institute uuid, p_campaign uuid, p_tz text default 'UTC')
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  c       public.campaigns;
  tkey    text;
  money   boolean;
  amounts boolean;
  today   date;
  first_day date;
  stats   jsonb;
  daily   jsonb;
  openp   jsonb;
  prom    jsonb;
  hours   jsonb;
  callers bigint;
  nleads  bigint;
  due     numeric;
  target  numeric;
begin
  c := public.insights_campaign(p_institute, p_campaign);
  perform public.admin_check_tz(p_tz);
  select t.key into tkey from public.call_types t where t.id = c.call_type_id;
  money := public.can_see_money(p_institute);
  amounts := tkey = 'fees' and money;
  today := (now() at time zone p_tz)::date;

  -- Every number below is an aggregate of the campaign's calls (insights_calls).
  with k as (select * from public.insights_calls(p_institute, p_campaign))
  select jsonb_build_object(
           'calls', count(*),
           'picked', count(*) filter (where k.picked),
           'good', count(*) filter (where k.good),
           -- Value got straight away: ₹ paid (amount kind) or good results that are not promises.
           'direct_value', case when amounts
                             then coalesce(sum(k.amount) filter (where k.good and k.result_key in ('paid', 'paid_part')), 0)
                             else count(*) filter (where k.good and coalesce(k.result_key, '') not in ('will_pay_on', 'will_renew_on')) end,
           'promises_made', count(*) filter (where k.result_key in ('will_pay_on', 'will_renew_on') and k.promised_date is not null),
           'promise_value_made', case when amounts
                             then coalesce(sum(k.amount) filter (where k.result_key = 'will_pay_on' and k.promised_date is not null), 0)
                             else count(*) filter (where k.result_key in ('will_pay_on', 'will_renew_on') and k.promised_date is not null) end,
           'evening_calls', count(*) filter (where extract(hour from k.happened_at at time zone p_tz) in (19, 20)),
           'evening_picked', count(*) filter (where k.picked and extract(hour from k.happened_at at time zone p_tz) in (19, 20)),
           'first_day', min((k.happened_at at time zone p_tz)::date))
    into stats
    from k;

  first_day := least(coalesce(c.start_date, (stats->>'first_day')::date, today),
                     coalesce((stats->>'first_day')::date, today));

  -- Calls and value per day, from the first day to today (days with no calls included).
  with k as (select * from public.insights_calls(p_institute, p_campaign)),
  days as (select d::date as day from generate_series(first_day, greatest(first_day, today), interval '1 day') d)
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', days.day,
           'calls', (select count(*) from k where (k.happened_at at time zone p_tz)::date = days.day),
           'callers', (select count(distinct k.seat_id) from k where (k.happened_at at time zone p_tz)::date = days.day),
           'value', (select case when amounts
                              then coalesce(sum(k.amount) filter (where k.good and k.result_key in ('paid', 'paid_part')), 0)
                              else count(*) filter (where k.good and coalesce(k.result_key, '') not in ('will_pay_on', 'will_renew_on')) end
                     from k where (k.happened_at at time zone p_tz)::date = days.day))
         order by days.day), '[]'::jsonb)
    into daily
    from days;

  -- Promises: kept, broken (date passed, not kept) and open (date today or later, not kept yet).
  with k as (select * from public.insights_calls(p_institute, p_campaign)),
  p as (
    select k.root_id, k.promised_date, k.amount,
           exists (select 1 from k x
                   where x.lead_id = k.lead_id and k.lead_id is not null
                     and x.result_key = any (public.insights_kept_keys(k.result_key))
                     and x.happened_at > k.happened_at
                     and (x.happened_at at time zone p_tz)::date <= k.promised_date) as kept
    from k
    where k.result_key in ('will_pay_on', 'will_renew_on') and k.promised_date is not null
  )
  select jsonb_build_object(
           'judged', count(*) filter (where p.kept or p.promised_date < today),
           'kept', count(*) filter (where p.kept),
           'broken', count(*) filter (where not p.kept and p.promised_date < today),
           'broken_value', case when amounts then coalesce(sum(p.amount) filter (where not p.kept and p.promised_date < today), 0)
                                else count(*) filter (where not p.kept and p.promised_date < today) end),
         (select coalesce(jsonb_agg(jsonb_build_object('date', o.d, 'value', o.v) order by o.d), '[]'::jsonb)
            from (select p2.promised_date as d,
                         case when amounts then coalesce(sum(p2.amount), 0) else count(*) end as v
                  from p p2 where not p2.kept and p2.promised_date >= today
                  group by p2.promised_date) o)
    into prom, openp
    from p;

  -- Pickup by hour of day (all days), for the evening suggestion and "Set call hours".
  with k as (select * from public.insights_calls(p_institute, p_campaign))
  select coalesce(jsonb_agg(jsonb_build_object('hour', h.hour, 'calls', h.calls, 'picked', h.picked) order by h.hour), '[]'::jsonb)
    into hours
    from (select extract(hour from k.happened_at at time zone p_tz)::int as hour, count(*) as calls,
                 count(*) filter (where k.picked) as picked
          from k group by 1) h;

  select count(*) into callers
    from public.campaign_members m join public.seats s on s.id = m.seat_id
    where m.campaign_id = c.id and s.status = 'active';
  select count(*) into nleads from public.leads l where l.campaign_id = c.id;
  if amounts then
    select coalesce(sum(l.amount_due), 0) into due from public.leads l where l.campaign_id = c.id;
  end if;

  -- Target: fees aim at 90% of what is due (₹, or leads when money is hidden); other types use the goal.
  target := case when tkey = 'fees' and amounts then round(due * 0.9)
                 when tkey = 'fees' then ceil(nleads * 0.9)
                 else c.goal end;

  return jsonb_build_object(
    'campaign_id', c.id, 'name', c.name, 'status', c.status, 'call_type_key', tkey,
    'kind', case when amounts then 'amount' else 'count' end,
    'money_hidden', tkey = 'fees' and not money,
    'today', today, 'start_date', coalesce(c.start_date, first_day), 'end_date', c.end_date,
    'daily_target', c.daily_target, 'goal', c.goal, 'plan', c.insights_plan, 'call_hours', c.call_hours,
    'callers', callers, 'leads', nleads,
    'cap', case when amounts then due when tkey = 'fees' or nleads > 0 then nleads end,
    'target', case when target > 0 then target end,
    'stats', stats - 'first_day', 'promises', prom, 'open_promises', openp, 'daily', daily, 'hours', hours);
end $$;

-- Headline numbers of a campaign, for "Compare with": the whole campaign, or calls in [p_from, p_to).
create or replace function public.admin_insights_summary(
  p_institute uuid, p_campaign uuid, p_from timestamptz default null, p_to timestamptz default null,
  p_tz text default 'UTC')
returns table (calls bigint, picked bigint, good bigint, active_days bigint, callers bigint,
               promises_judged bigint, promises_kept bigint, talk_seconds bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  c     public.campaigns;
  today date;
begin
  c := public.insights_campaign(p_institute, p_campaign);
  perform public.admin_check_tz(p_tz);
  if p_from is not null or p_to is not null then perform public.admin_check_range(p_from, p_to); end if;
  today := (now() at time zone p_tz)::date;
  return query
    with k_all as (select * from public.insights_calls(p_institute, p_campaign)),
    k as (select * from k_all where (p_from is null or k_all.happened_at >= p_from) and (p_to is null or k_all.happened_at < p_to)),
    p as (
      select (exists (select 1 from k_all x
                      where x.lead_id = k.lead_id and k.lead_id is not null
                        and x.result_key = any (public.insights_kept_keys(k.result_key))
                        and x.happened_at > k.happened_at
                        and (x.happened_at at time zone p_tz)::date <= k.promised_date)) as kept,
             k.promised_date
      from k where k.result_key in ('will_pay_on', 'will_renew_on') and k.promised_date is not null
    )
    select count(*),
           count(*) filter (where k.picked),
           count(*) filter (where k.good),
           count(distinct (k.happened_at at time zone p_tz)::date),
           count(distinct k.seat_id),
           (select count(*) from p where p.kept or p.promised_date < today),
           (select count(*) from p where p.kept),
           coalesce(sum(k.connected_seconds) filter (where k.connected_seconds > 0), 0)::bigint
    from k;
end $$;

-- Pickup by day of week (1 = Monday … 7 = Sunday) and hour, for the whole campaign or one caller.
create or replace function public.admin_insights_best_time(
  p_institute uuid, p_campaign uuid, p_seat uuid default null, p_tz text default 'UTC')
returns table (dow int, hour int, calls bigint, picked bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.insights_campaign(p_institute, p_campaign);
  perform public.admin_check_tz(p_tz);
  return query
    select extract(isodow from k.happened_at at time zone p_tz)::int,
           extract(hour from k.happened_at at time zone p_tz)::int,
           count(*), count(*) filter (where k.picked)
    from public.insights_calls(p_institute, p_campaign) k
    where p_seat is null or k.seat_id = p_seat
    group by 1, 2
    order by 1, 2;
end $$;

-- Where picked-up calls end: the furthest script step each reached, in script order. Scripts add-on.
create or replace function public.admin_insights_call_ends(p_institute uuid, p_campaign uuid)
returns table (step text, step_label text, step_order int, calls bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.insights_campaign(p_institute, p_campaign);
  if not public.has_feature(p_institute, 'scripts') then
    raise exception 'this needs the Scripts add-on' using errcode = '42501';
  end if;
  return query
    with ends as (
      select coalesce(k.reached_step, '') as step, count(*) as n
      from public.insights_calls(p_institute, p_campaign) k
      where k.picked
      group by 1
    )
    select nullif(e.step, ''), coalesce(s.step_label, nullif(e.step, '')), s.step_order, e.n
    from ends e
    left join public.insights_script_steps(p_campaign) s on s.step = e.step
    order by s.step_order nulls last, e.n desc, e.step;
end $$;

-- Promises kept, by how many days away the promised date was when it was made. Only promises whose date
-- has passed (or that were already kept) are judged; waiting = date still ahead and not kept yet.
create or replace function public.admin_insights_promises(p_institute uuid, p_campaign uuid, p_tz text default 'UTC')
returns table (bucket text, bucket_order int, promises bigint, kept bigint, waiting bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  today date;
begin
  perform public.insights_campaign(p_institute, p_campaign);
  perform public.admin_check_tz(p_tz);
  today := (now() at time zone p_tz)::date;
  return query
    with k as (select * from public.insights_calls(p_institute, p_campaign)),
    p as (
      select k.promised_date - (k.happened_at at time zone p_tz)::date as away,
             k.promised_date,
             exists (select 1 from k x
                     where x.lead_id = k.lead_id and k.lead_id is not null
                       and x.result_key = any (public.insights_kept_keys(k.result_key))
                       and x.happened_at > k.happened_at
                       and (x.happened_at at time zone p_tz)::date <= k.promised_date) as kept
      from k where k.result_key in ('will_pay_on', 'will_renew_on') and k.promised_date is not null
    ),
    b as (select * from (values ('1–3 days', 1, -100000, 3), ('4–7 days', 2, 4, 7),
                                ('8–14 days', 3, 8, 14), ('15+ days', 4, 15, 100000)) v(bucket, ord, lo, hi))
    select b.bucket, b.ord,
           count(p.*) filter (where p.kept or p.promised_date < today),
           count(p.*) filter (where p.kept),
           count(p.*) filter (where not p.kept and p.promised_date >= today)
    from b left join p on p.away between b.lo and b.hi
    group by b.bucket, b.ord
    order by b.ord;
end $$;

-- Per caller on the campaign: calls, picked up, good results and talk time. Callers who are members or made
-- a call on it. Revoked seats are left out.
create or replace function public.admin_insights_coaching(p_institute uuid, p_campaign uuid)
returns table (seat_id uuid, label text, calls bigint, picked bigint, good bigint, talk_seconds bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.insights_campaign(p_institute, p_campaign);
  return query
    with k as (select * from public.insights_calls(p_institute, p_campaign)),
    who as (
      select m.seat_id as sid from public.campaign_members m where m.campaign_id = p_campaign
      union
      select k.seat_id from k
    )
    select s.id, s.label,
           (select count(*) from k where k.seat_id = s.id),
           (select count(*) from k where k.seat_id = s.id and k.picked),
           (select count(*) from k where k.seat_id = s.id and k.good),
           (select coalesce(sum(k.connected_seconds) filter (where k.connected_seconds > 0), 0)::bigint
              from k where k.seat_id = s.id)
    from who join public.seats s on s.id = who.sid
    where s.status <> 'revoked'
    order by s.label;
end $$;

-- Per caller and script step (seat_id null = the whole team): picked-up calls with step times, how many of
-- them passed the step, and the average seconds spent on it. Scripts add-on.
create or replace function public.admin_insights_step_coaching(p_institute uuid, p_campaign uuid)
returns table (seat_id uuid, label text, step text, step_label text, step_order int,
               timed_calls bigint, calls_with_step bigint, avg_seconds numeric)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.insights_campaign(p_institute, p_campaign);
  if not public.has_feature(p_institute, 'scripts') then
    raise exception 'this needs the Scripts add-on' using errcode = '42501';
  end if;
  return query
    with k as (
      select x.root_id, x.seat_id, x.step_times
      from public.insights_calls(p_institute, p_campaign) x
      where x.picked and x.step_times is not null and x.step_times <> '{}'::jsonb
    ),
    st as (
      select k.root_id, k.seat_id, e.key as step, (e.value::text)::numeric as secs
      from k cross join lateral jsonb_each(k.step_times) e
      where jsonb_typeof(e.value) = 'number' and (e.value::text)::numeric >= 0
    ),
    timed as (
      select k.seat_id, count(*) as n from k group by k.seat_id
      union all
      select null::uuid, count(*) from k
    ),
    per as (
      select st.seat_id, st.step, count(distinct st.root_id) as n, avg(st.secs) as secs from st group by st.seat_id, st.step
      union all
      select null::uuid, st.step, count(distinct st.root_id), avg(st.secs) from st group by st.step
    )
    select per.seat_id, s.label, per.step, coalesce(ss.step_label, per.step), ss.step_order,
           t.n, per.n, round(per.secs, 1)
    from per
    join timed t on t.seat_id is not distinct from per.seat_id
    left join public.seats s on s.id = per.seat_id
    left join public.insights_script_steps(p_campaign) ss on ss.step = per.step
    order by per.seat_id nulls first, ss.step_order nulls last, per.step;
end $$;

-- ---------- writes ----------

-- The campaign for a write: in an institute the caller administers, and not closed.
create or replace function public.insights_campaign_for_write(p_campaign uuid)
returns public.campaigns
language plpgsql stable security definer set search_path = public
as $$
declare
  c public.campaigns;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null or not public.is_admin_of(c.institute_id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if c.status = 'closed' then raise exception 'this campaign is closed' using errcode = '22023'; end if;
  return c;
end $$;

-- "Set call hours": saves campaigns.call_hours (shape above). Null clears it (any time).
create or replace function public.admin_set_call_hours(p_campaign uuid, p_call_hours jsonb)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c public.campaigns;
begin
  c := public.insights_campaign_for_write(p_campaign);
  if not public.insights_valid_call_hours(p_call_hours) then
    raise exception 'call hours must list days (mon to sun) with hours 0 to 23' using errcode = '22023';
  end if;
  update public.campaigns set call_hours = p_call_hours where id = c.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'campaign.call_hours_set', c.id::text);
end $$;

-- "Apply plan" from What-if: keeps the plan (callers is a note), sets the daily target (calls a day for the
-- campaign) and, when given, the call hours.
create or replace function public.admin_apply_insights_plan(
  p_campaign uuid, p_callers int, p_calls_per_caller int, p_evening_share numeric,
  p_daily_target int, p_call_hours jsonb default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c    public.campaigns;
  seat uuid;
begin
  c := public.insights_campaign_for_write(p_campaign);
  if p_callers is null or p_callers < 1 or p_callers > 200 then
    raise exception 'callers must be 1 to 200' using errcode = '22023';
  end if;
  if p_calls_per_caller is null or p_calls_per_caller < 1 or p_calls_per_caller > 500 then
    raise exception 'calls per caller must be 1 to 500 a day' using errcode = '22023';
  end if;
  if p_evening_share is null or p_evening_share < 0 or p_evening_share > 1 then
    raise exception 'the evening share must be 0 to 1' using errcode = '22023';
  end if;
  if p_daily_target is null or p_daily_target < 1 or p_daily_target > 10000 then
    raise exception 'the daily target must be 1 to 10000 calls' using errcode = '22023';
  end if;
  if not public.insights_valid_call_hours(p_call_hours) then
    raise exception 'call hours must list days (mon to sun) with hours 0 to 23' using errcode = '22023';
  end if;
  select s.id into seat from public.seats s
    where s.institute_id = c.institute_id and s.user_id = auth.uid() and s.status = 'active';
  update public.campaigns
     set daily_target = p_daily_target,
         call_hours = coalesce(p_call_hours, call_hours),
         insights_plan = jsonb_build_object('callers', p_callers, 'calls_per_caller', p_calls_per_caller,
                                            'evening_share', round(p_evening_share, 2),
                                            'applied_at', now(), 'applied_by', seat)
   where id = c.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'campaign.plan_applied', c.id::text);
end $$;

-- The goal (good results wanted by the end date) of a campaign that is not fees. Null clears it.
create or replace function public.admin_set_campaign_goal(p_campaign uuid, p_goal int)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c public.campaigns;
begin
  c := public.insights_campaign_for_write(p_campaign);
  if p_goal is not null and (p_goal < 1 or p_goal > 1000000) then
    raise exception 'the goal must be 1 to 1000000' using errcode = '22023';
  end if;
  update public.campaigns set goal = p_goal where id = c.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'campaign.goal_set', c.id::text || ':' || coalesce(p_goal::text, 'none'));
end $$;

-- ---------- grants ----------

revoke all on function public.insights_valid_call_hours(jsonb) from public, anon, authenticated;
revoke all on function public.insights_kept_keys(text) from public, anon, authenticated;
revoke all on function public.insights_campaign(uuid, uuid) from public, anon, authenticated;
revoke all on function public.insights_calls(uuid, uuid) from public, anon, authenticated;
revoke all on function public.insights_script_steps(uuid) from public, anon, authenticated;
revoke all on function public.insights_campaign_for_write(uuid) from public, anon, authenticated;

revoke all on function public.admin_insights_setup(uuid) from public, anon;
revoke all on function public.admin_insights_forecast(uuid, uuid, text) from public, anon;
revoke all on function public.admin_insights_summary(uuid, uuid, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.admin_insights_best_time(uuid, uuid, uuid, text) from public, anon;
revoke all on function public.admin_insights_call_ends(uuid, uuid) from public, anon;
revoke all on function public.admin_insights_promises(uuid, uuid, text) from public, anon;
revoke all on function public.admin_insights_coaching(uuid, uuid) from public, anon;
revoke all on function public.admin_insights_step_coaching(uuid, uuid) from public, anon;
revoke all on function public.admin_set_call_hours(uuid, jsonb) from public, anon;
revoke all on function public.admin_apply_insights_plan(uuid, int, int, numeric, int, jsonb) from public, anon;
revoke all on function public.admin_set_campaign_goal(uuid, int) from public, anon;
grant execute on function public.admin_insights_setup(uuid) to authenticated;
grant execute on function public.admin_insights_forecast(uuid, uuid, text) to authenticated;
grant execute on function public.admin_insights_summary(uuid, uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_insights_best_time(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.admin_insights_call_ends(uuid, uuid) to authenticated;
grant execute on function public.admin_insights_promises(uuid, uuid, text) to authenticated;
grant execute on function public.admin_insights_coaching(uuid, uuid) to authenticated;
grant execute on function public.admin_insights_step_coaching(uuid, uuid) to authenticated;
grant execute on function public.admin_set_call_hours(uuid, jsonb) to authenticated;
grant execute on function public.admin_apply_insights_plan(uuid, int, int, numeric, int, jsonb) to authenticated;
grant execute on function public.admin_set_campaign_goal(uuid, int) to authenticated;
