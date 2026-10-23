-- Vector 2.0 Phase A, Sprint 10: the admin app's Home, Callers and Settings tabs. Apply after 20261024100014.
-- Depends only on 0001–0014 (no other round-2 migration).
--
-- Adds:
--   institutes.time_zone           the institute's time zone (Home counts "today" in it). Default India.
--   seat_presence + report_presence()  the caller screen says every minute or so that it is open, whether a call
--                                  is going on and whether the phone answers. Home shows "On a call", "Ready",
--                                  "No calls for N min" and "Phone offline" from it.
--   admin_home_summary()           everything the Home tab shows, in one call.
--   admin_callers()                Callers tab: role, money access, campaigns and today's calls per seat.
--   admin_institute_settings(), admin_set_institute()   Settings: name, time zone, plan, money switch state.
--   admin_audit_log()              Settings: the admin activity log, a page at a time.
-- Money rules (docs/data-contract.md): amounts only when can_see_money(); counts always. Nothing here writes
-- money. Every admin function checks is_admin_of() (owner or manager); owner-only writes check is_owner_of().

-- ---------- institute time zone ----------

alter table public.institutes
  add column if not exists time_zone text not null default 'Asia/Kolkata'
    check (length(time_zone) between 1 and 64);

-- ---------- presence of the caller screen ----------

-- One row per seat, kept by report_presence(). seen_at: the last report. online_since: when the screen came
-- back after a gap of more than 3 minutes. phone_offline_since: when the phone stopped answering (null while it
-- answers). Read only through the admin functions below (RLS on, no policies).
create table if not exists public.seat_presence (
  seat_id              uuid primary key references public.seats (id) on delete cascade,
  institute_id         uuid not null references public.institutes (id) on delete cascade,
  seen_at              timestamptz not null default now(),
  online_since         timestamptz not null default now(),
  on_call              boolean not null default false,
  phone_ok             boolean not null default true,
  phone_offline_since  timestamptz
);

alter table public.seat_presence enable row level security;
revoke all on public.seat_presence from anon, authenticated;

-- Called by the caller screen (any active seat) about once a minute and when a call starts or ends.
-- p_on_call: a call is going on now. p_phone_ok: the paired phone answers (false = "Phone offline").
create or replace function public.report_presence(p_on_call boolean default false, p_phone_ok boolean default true)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  ok    boolean := coalesce(p_phone_ok, true);
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  insert into public.seat_presence as p (seat_id, institute_id, seen_at, online_since, on_call, phone_ok, phone_offline_since)
    values (seat.id, seat.institute_id, now(), now(), coalesce(p_on_call, false), ok, case when ok then null else now() end)
  on conflict (seat_id) do update set
    institute_id = excluded.institute_id,
    online_since = case when p.seen_at < now() - interval '3 minutes' then now() else p.online_since end,
    seen_at = now(),
    on_call = excluded.on_call,
    phone_ok = excluded.phone_ok,
    phone_offline_since = case
      when excluded.phone_ok then null
      when p.phone_ok or p.phone_offline_since is null or p.seen_at < now() - interval '3 minutes' then now()
      else p.phone_offline_since end;
end $$;

-- ---------- internal helpers (granted to nobody) ----------

-- What a seat is doing now, for Home and Callers: {status, since, idle_minutes}.
--   phone_offline  the screen is open (seen in the last 3 min) and the phone does not answer
--   on_call        the screen is open and a call is going on
--   idle           no call for 15 minutes or more (since the last call today, or since the screen opened)
--   ready          a call less than 15 minutes ago
--   not_started    no call today and the screen is not open
-- p_day_start is the start of today in the institute's time zone.
create or replace function public.home_seat_status(p_seat uuid, p_day_start timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  p          public.seat_presence;
  last_call  timestamptz;
  recent     boolean;
  ref        timestamptz;
  mins       int;
begin
  select * into p from public.seat_presence where seat_id = p_seat;
  select max(coalesce(c.dialled_at, c.uploaded_at)) into last_call
    from public.call_outcomes c
    where c.seat_id = p_seat and c.corrects_id is null
      and coalesce(c.dialled_at, c.uploaded_at) >= p_day_start;
  recent := p.seat_id is not null and p.seen_at >= now() - interval '3 minutes';
  if recent and not p.phone_ok then
    return jsonb_build_object('status', 'phone_offline', 'since', coalesce(p.phone_offline_since, p.seen_at));
  end if;
  if recent and p.on_call then
    return jsonb_build_object('status', 'on_call', 'since', last_call);
  end if;
  -- greatest() skips nulls: the later of the last call today and the moment the screen opened today.
  ref := greatest(last_call, case when recent and p.online_since >= p_day_start then p.online_since end);
  if ref is null then return jsonb_build_object('status', 'not_started'); end if;
  mins := greatest(0, floor(extract(epoch from now() - ref) / 60)::int);
  if mins >= 15 then
    return jsonb_build_object('status', 'idle', 'since', ref, 'idle_minutes', mins);
  end if;
  return jsonb_build_object('status', 'ready', 'since', ref);
end $$;

-- One row per original call (corrects_id is null) in the range, with its latest correction applied, like
-- admin_effective_outcomes (0004) but with the Phase A columns. amount is money: callers of this function
-- must check can_see_money() before returning it.
create or replace function public.home_calls(p_institute uuid, p_from timestamptz, p_to timestamptz)
returns table (root_id uuid, seat_id uuid, campaign_id uuid, result_key text, outcome text,
               connected_seconds int, script_id text, end_step text, amount numeric, happened_at timestamptz)
language sql stable security definer set search_path = public
as $$
  with recursive roots as (
    select c.id, c.uploaded_at
    from public.call_outcomes c
    where c.institute_id = p_institute
      and c.corrects_id is null
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
  select l.root_id, o.seat_id, coalesce(o.campaign_id, r.campaign_id), o.result_key, o.outcome,
         o.connected_seconds, coalesce(o.script_id, r.script_id),
         coalesce(o.reached_step, o.script_step, r.reached_step, r.script_step), o.amount,
         coalesce(r.dialled_at, r.uploaded_at)
  from latest l
  join public.call_outcomes o on o.id = l.node
  join public.call_outcomes r on r.id = l.root_id;
$$;

-- The institute's time zone, or India when it is missing or unknown to the database.
create or replace function public.institute_tz(p_institute uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce((select i.time_zone from public.institutes i
                   where i.id = p_institute
                     and exists (select 1 from pg_timezone_names z where z.name = i.time_zone)),
                  'Asia/Kolkata');
$$;

-- The signed-in admin's active seat (owner or manager), else 42501.
create or replace function public.home_admin_seat()
returns public.seats
language plpgsql stable security definer set search_path = public
as $$
declare
  seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an admin of this institute can see this' using errcode = '42501';
  end if;
  return seat;
end $$;

-- ---------- Home ----------

-- Everything the Home tab shows, for the admin's own institute, as one jsonb:
--   day, time_zone, from, to, money_hidden, scripts_feature, generated_at
--   tiles: calls, calls_before (the same stretch of the day before / week before), picked_up, talk_seconds,
--          has_sales, joined, interested, has_fees, paid_calls, promised_calls,
--          paid_amount, promised_amount (both null unless can_see_money; reported by callers)
--   callers: [{seat_id, label, campaigns [names], calls, picked_up, talk_seconds, target, results [{label, count}],
--              now {status, since, idle_minutes}}]   active callers, and anyone who made calls in the period
--   promises_due_today: {count, amount (null unless can_see_money)}   leads promised for today, not yet done
--   script_ends: [{script_id, script_name, step, step_label, ended, picked_up, share}]   last 7 days: the step
--          where more than 35% of a script's picked-up calls end without a good result (10 calls or more).
--          Empty without the Scripts add-on.
--   campaigns: [{id, name, status, end_date, leads_total, leads_called}]   running and paused
--   campaign_choices: [{id, name, status}]   for the campaign filter (not drafts)
-- p_day: 'today', 'yesterday' or 'week' (Monday to Sunday). p_campaign: one campaign, or null for all.
create or replace function public.admin_home_summary(p_day text default 'today', p_campaign uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat       public.seats;
  inst       uuid;
  tz         text;
  money      boolean;
  scripts_on boolean;
  today      date;
  day_start  timestamptz;
  v_from     timestamptz;
  v_to       timestamptz;
  span       interval;
  out        jsonb;
begin
  seat := public.home_admin_seat();
  inst := seat.institute_id;
  if p_day is null or p_day not in ('today', 'yesterday', 'week') then
    raise exception 'day must be today, yesterday or week' using errcode = '22023';
  end if;
  if p_campaign is not null and not exists (
       select 1 from public.campaigns c where c.id = p_campaign and c.institute_id = inst) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  tz := public.institute_tz(inst);
  money := public.can_see_money(inst);
  scripts_on := public.has_feature(inst, 'scripts');
  today := (now() at time zone tz)::date;
  day_start := today::timestamp at time zone tz;
  if p_day = 'today' then
    v_from := day_start; v_to := (today + 1)::timestamp at time zone tz; span := interval '1 day';
  elsif p_day = 'yesterday' then
    v_from := (today - 1)::timestamp at time zone tz; v_to := day_start; span := interval '1 day';
  else
    v_from := date_trunc('week', today::timestamp) at time zone tz; v_to := v_from + interval '7 days';
    span := interval '7 days';
  end if;

  with calls as (
    select h.*, ct.key as type_key, res.label as result_label,
           coalesce(res.common, true) as common_result
    from public.home_calls(inst, v_from, v_to) h
    left join public.campaigns c on c.id = h.campaign_id
    left join public.call_types ct on ct.id = c.call_type_id
    left join lateral (
      select r.label, r.call_type_id is null as common
      from public.call_type_results r
      where h.result_key is not null and r.key = h.result_key
        and (r.call_type_id = c.call_type_id or r.call_type_id is null)
        and (r.institute_id is null or r.institute_id = inst)
      order by r.call_type_id nulls last, r.institute_id nulls last
      limit 1) res on true
    where p_campaign is null or h.campaign_id = p_campaign
  ),
  before as (
    select count(*) as n
    from public.home_calls(inst, v_from - span, least(v_to, now()) - span) h
    where p_campaign is null or h.campaign_id = p_campaign
  ),
  open_types as (
    select distinct ct.key
    from public.campaigns c join public.call_types ct on ct.id = c.call_type_id
    where c.institute_id = inst and c.status in ('running', 'paused')
      and (p_campaign is null or c.id = p_campaign)
  ),
  tiles as (
    select count(*) as calls,
           count(*) filter (where k.connected_seconds > 0) as picked_up,
           coalesce(sum(k.connected_seconds) filter (where k.connected_seconds > 0), 0) as talk_seconds,
           count(*) filter (where k.type_key = 'sales' and k.result_key = 'joined') as joined,
           count(*) filter (where k.type_key = 'sales' and k.result_key = 'interested') as interested,
           count(*) filter (where k.type_key = 'sales') as sales_calls,
           count(*) filter (where k.type_key = 'fees' and k.result_key in ('paid', 'paid_part')) as paid_calls,
           count(*) filter (where k.type_key = 'fees' and k.result_key = 'will_pay_on') as promised_calls,
           count(*) filter (where k.type_key = 'fees') as fees_calls,
           coalesce(sum(k.amount) filter (where k.type_key = 'fees' and k.result_key in ('paid', 'paid_part')), 0) as paid_amount,
           coalesce(sum(k.amount) filter (where k.type_key = 'fees' and k.result_key = 'will_pay_on'), 0) as promised_amount
    from calls k
  ),
  people as (
    select s.id, s.label
    from public.seats s
    where s.institute_id = inst and s.status = 'active'
      and (
        (s.role = 'rep' and (p_campaign is null or exists (
           select 1 from public.campaign_members m where m.seat_id = s.id and m.campaign_id = p_campaign)))
        or exists (select 1 from calls k where k.seat_id = s.id))
  )
  select jsonb_build_object(
    'day', p_day,
    'time_zone', tz,
    'from', v_from,
    'to', v_to,
    'money_hidden', not money,
    'scripts_feature', scripts_on,
    'generated_at', now(),
    'tiles', (select jsonb_build_object(
        'calls', t.calls,
        'calls_before', (select b.n from before b),
        'picked_up', t.picked_up,
        'talk_seconds', t.talk_seconds,
        'has_sales', t.sales_calls > 0 or exists (select 1 from open_types o where o.key = 'sales'),
        'joined', t.joined,
        'interested', t.interested,
        'has_fees', t.fees_calls > 0 or exists (select 1 from open_types o where o.key = 'fees'),
        'paid_calls', t.paid_calls,
        'promised_calls', t.promised_calls,
        'paid_amount', case when money then t.paid_amount end,
        'promised_amount', case when money then t.promised_amount end)
      from tiles t),
    'callers', (select coalesce(jsonb_agg(jsonb_build_object(
        'seat_id', pp.id,
        'label', pp.label,
        'campaigns', (select coalesce(jsonb_agg(c.name order by c.name), '[]'::jsonb)
                      from public.campaign_members m join public.campaigns c on c.id = m.campaign_id
                      where m.seat_id = pp.id and c.status in ('running', 'paused')),
        'calls', (select count(*) from calls k where k.seat_id = pp.id),
        'picked_up', (select count(*) from calls k where k.seat_id = pp.id and k.connected_seconds > 0),
        'talk_seconds', (select coalesce(sum(k.connected_seconds), 0) from calls k
                         where k.seat_id = pp.id and k.connected_seconds > 0),
        'target', (select t.daily_target from public.rep_targets t where t.seat_id = pp.id and t.metric = 'calls'),
        'results', (select coalesce(jsonb_agg(jsonb_build_object('label', x.result_label, 'count', x.n)
                                              order by x.n desc, x.result_label), '[]'::jsonb)
                    from (select k.result_label, count(*) as n from calls k
                          where k.seat_id = pp.id and k.result_label is not null and not k.common_result
                          group by k.result_label order by count(*) desc, k.result_label limit 3) x),
        'now', public.home_seat_status(pp.id, day_start)) order by pp.label), '[]'::jsonb)
      from people pp),
    'promises_due_today', (select jsonb_build_object(
        'count', count(*),
        'amount', case when money then coalesce(sum(l.promised_amount), 0) end)
      from public.leads l
      where l.institute_id = inst and l.status = 'promised' and l.promised_date = today and not l.do_not_call
        and (p_campaign is null or l.campaign_id = p_campaign)),
    'script_ends', case when not scripts_on then '[]'::jsonb else (
      with recent as (
        select h.script_id, h.end_step, h.outcome, h.result_key
        from public.home_calls(inst, now() - interval '7 days', now()) h
        where h.connected_seconds > 0 and h.script_id is not null
          and (p_campaign is null or h.campaign_id = p_campaign)
      ),
      per_script as (
        select r.script_id, count(*) as picked from recent r group by r.script_id having count(*) >= 10
      ),
      ends as (
        select r.script_id, r.end_step, count(*) as ended
        from recent r
        where r.end_step is not null and r.outcome <> 'won'
          and not exists (select 1 from public.call_type_results g
                          where g.key = r.result_key and g.counts_as_good
                            and (g.institute_id is null or g.institute_id = inst))
        group by r.script_id, r.end_step
      ),
      worst as (
        select distinct on (e.script_id) e.script_id, e.end_step, e.ended, p.picked
        from ends e join per_script p on p.script_id = e.script_id
        where e.ended::numeric / p.picked > 0.35
        order by e.script_id, e.ended desc, e.end_step
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'script_id', sc.id,
          'script_name', sc.name,
          'step', w.end_step,
          'step_label', (select st->>'title' from public.script_versions v, jsonb_array_elements(v.steps) st
                         where v.script_id = sc.id and v.published and st->>'id' = w.end_step limit 1),
          'ended', w.ended,
          'picked_up', w.picked,
          'share', round(w.ended::numeric / w.picked, 3)) order by w.ended::numeric / w.picked desc), '[]'::jsonb)
      from worst w join public.scripts sc on sc.id::text = w.script_id and sc.institute_id = inst) end,
    'campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'status', c.status, 'end_date', c.end_date,
        'leads_total', (select count(*) from public.leads l where l.campaign_id = c.id),
        'leads_called', (select count(*) from public.leads l where l.campaign_id = c.id
                           and (l.status <> 'new' or exists (select 1 from public.call_outcomes o where o.lead_id = l.id))))
        order by c.status = 'running' desc, c.end_date nulls last, c.name), '[]'::jsonb)
      from public.campaigns c
      where c.institute_id = inst and c.status in ('running', 'paused')
        and (p_campaign is null or c.id = p_campaign)),
    'campaign_choices', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status)
                                                   order by c.status = 'closed', c.name), '[]'::jsonb)
      from public.campaigns c
      where c.institute_id = inst and c.status <> 'draft')
  ) into out;
  return out;
end $$;

-- ---------- Callers ----------

-- Every seat of the institute with what the Callers tab adds to admin_seat_list: the role as owner / manager /
-- caller, the manager's money switch, the campaigns (not closed) the seat is on, today's calls and daily call
-- target, and what the seat is doing now (see home_seat_status). No emails, no money.
create or replace function public.admin_callers(p_institute uuid)
returns table (seat_id uuid, label text, access_role text, can_see_money boolean, status text,
               campaigns jsonb, calls_today bigint, calls_target int, now_status jsonb)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  tz        text;
  day_start timestamptz;
begin
  perform public.admin_require(p_institute);
  tz := public.institute_tz(p_institute);
  day_start := (now() at time zone tz)::date::timestamp at time zone tz;
  return query
    select s.id, s.label, s.access_role, s.can_see_money, s.status,
           (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status)
                                      order by c.name), '[]'::jsonb)
            from public.campaign_members m join public.campaigns c on c.id = m.campaign_id
            where m.seat_id = s.id and c.status <> 'closed'),
           (select count(*) from public.call_outcomes o
            where o.seat_id = s.id and o.corrects_id is null
              and coalesce(o.dialled_at, o.uploaded_at) >= day_start),
           (select t.daily_target from public.rep_targets t where t.seat_id = s.id and t.metric = 'calls'),
           case when s.status = 'active' then public.home_seat_status(s.id, day_start) end
    from public.seats s
    where s.institute_id = p_institute
    order by s.status, s.label;
end $$;

-- ---------- Settings ----------

-- The admin's institute for the Settings tab: name, time zone, hide_money, plan (status, trial end and days
-- left, seats), the add-ons it has (my_features) and whether the signed-in admin is an owner.
create or replace function public.admin_institute_settings()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat public.seats;
  out  jsonb;
begin
  seat := public.home_admin_seat();
  select jsonb_build_object(
    'institute_id', i.id,
    'name', i.name,
    'time_zone', i.time_zone,
    'hide_money', i.hide_money,
    'status', i.status,
    'trial_ends_at', i.trial_ends_at,
    'trial_days_left', case when i.status = 'trial' and i.trial_ends_at is not null
                            then greatest(0, ceil(extract(epoch from i.trial_ends_at - now()) / 86400))::int end,
    'seat_limit', i.seat_limit,
    'seats_used', (select count(*) from public.seats s where s.institute_id = i.id and s.status <> 'revoked'),
    'features', to_jsonb(coalesce(public.my_features(), '{}'::text[])),
    'is_owner', public.is_owner_of(i.id),
    'access_role', seat.access_role)
  into out
  from public.institutes i
  where i.id = seat.institute_id;
  return out;
end $$;

-- Change the institute's name and time zone. Owner only. Null keeps a value. Audit institute.changed with
-- what changed ('name', 'time_zone' or both).
create or replace function public.admin_set_institute(p_name text default null, p_time_zone text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat    public.seats;
  nm      text := nullif(trim(coalesce(p_name, '')), '');
  zone    text := nullif(trim(coalesce(p_time_zone, '')), '');
  i       public.institutes;
  changed text[] := '{}';
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_owner_of(seat.institute_id) then
    raise exception 'only an owner can change the institute name or time zone' using errcode = '42501';
  end if;
  if nm is not null and (length(nm) < 2 or length(nm) > 120) then
    raise exception 'institute name must be 2 to 120 characters' using errcode = '22023';
  end if;
  if zone is not null and (length(zone) > 64 or not exists (select 1 from pg_timezone_names z where z.name = zone)) then
    raise exception 'unknown time zone %', zone using errcode = '22023';
  end if;
  select * into i from public.institutes where id = seat.institute_id;
  if nm is not null and nm <> i.name then changed := changed || 'name'::text; end if;
  if zone is not null and zone <> i.time_zone then changed := changed || 'time_zone'::text; end if;
  if cardinality(changed) = 0 then return; end if;
  update public.institutes
     set name = coalesce(nm, name), time_zone = coalesce(zone, time_zone)
   where id = seat.institute_id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(), 'institute.changed', array_to_string(changed, ','));
end $$;

-- The admin activity log of the admin's institute, newest first, p_limit rows (1–100) from p_offset.
-- actor_label: the seat label of the person who did it in this institute (null when unknown).
-- target_label: when the target starts with the id of a seat, campaign, call type or script of this
-- institute, its label or name; target_rest: what follows that id (e.g. ':manager'). total_rows: all rows.
create or replace function public.admin_audit_log(p_limit int default 25, p_offset int default 0)
returns table (id bigint, created_at timestamptz, action text, target text, actor_label text,
               target_label text, target_rest text, total_rows bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
  inst uuid;
begin
  seat := public.home_admin_seat();
  inst := seat.institute_id;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'a page has 1 to 100 rows' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'the page start must be 0 or more' using errcode = '22023';
  end if;
  return query
    with page as (
      select a.id, a.created_at, a.action, a.target, a.actor_id,
             case when a.target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
                  then lower(substr(a.target, 1, 36)) end as tid,
             count(*) over () as total
      from public.audit_log a
      where a.institute_id = inst
      order by a.created_at desc, a.id desc
      limit p_limit offset p_offset
    )
    select p.id, p.created_at, p.action, p.target,
           (select s.label from public.seats s
            where s.institute_id = inst and s.user_id = p.actor_id
            order by s.status = 'active' desc, s.created_at desc limit 1),
           case when p.tid is not null then coalesce(
             (select s.label from public.seats s where s.id::text = p.tid and s.institute_id = inst),
             (select c.name from public.campaigns c where c.id::text = p.tid and c.institute_id = inst),
             (select t.label from public.call_types t where t.id::text = p.tid and (t.institute_id = inst or t.institute_id is null)),
             (select r.label from public.call_type_results r where r.id::text = p.tid and r.institute_id = inst),
             (select sc.name from public.scripts sc where sc.id::text = p.tid and sc.institute_id = inst),
             (select i.name from public.institutes i where i.id::text = p.tid and i.id = inst)) end,
           case when p.tid is not null then nullif(substr(p.target, 37), '') end,
           p.total
    from page p
    order by p.created_at desc, p.id desc;
end $$;

-- ---------- grants ----------

revoke all on function public.home_seat_status(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.home_calls(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.institute_tz(uuid) from public, anon, authenticated;
revoke all on function public.home_admin_seat() from public, anon, authenticated;

revoke all on function public.report_presence(boolean, boolean) from public, anon;
revoke all on function public.admin_home_summary(text, uuid) from public, anon;
revoke all on function public.admin_callers(uuid) from public, anon;
revoke all on function public.admin_institute_settings() from public, anon;
revoke all on function public.admin_set_institute(text, text) from public, anon;
revoke all on function public.admin_audit_log(int, int) from public, anon;
grant execute on function public.report_presence(boolean, boolean) to authenticated;
grant execute on function public.admin_home_summary(text, uuid) to authenticated;
grant execute on function public.admin_callers(uuid) to authenticated;
grant execute on function public.admin_institute_settings() to authenticated;
grant execute on function public.admin_set_institute(text, text) to authenticated;
grant execute on function public.admin_audit_log(int, int) to authenticated;

-- The browser must not change the time zone directly (admin_set_institute checks the name).
revoke update (time_zone) on public.institutes from authenticated, anon;
