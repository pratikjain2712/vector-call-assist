-- Vector 2.0 Phase A, Sprint 10: the Reports tab (web/js/admin/reports.js). Apply after 20261024100014.
--
-- admin_fees_report     Fees collection: total due, paid after a call, promised, promise date passed and not paid.
-- admin_promises_due    The promises due this week (and the late ones), one row per lead.
-- admin_send_back_leads "Send these back to callers": next_call_at = now() so the leads come up first.
-- admin_sales_funnel    Called, picked up, heard the pitch, interested, joined, and the top loss reason.
--
-- Every function checks the admin seat of the institute (admin_require: owners and managers). Money follows
-- docs/data-contract.md: amounts are returned only when can_see_money() is true, otherwise they are null and
-- money_hidden is true (the counts are always returned). Amounts paid are what the caller reported.
-- Calls are read as their latest correction, like the older reports (0004); a correction is never a call.
-- Scope when no campaign is picked: fees reports cover campaigns of the built-in 'fees' type; the sales funnel
-- covers campaigns of the built-in 'sales' type and calls with no campaign (the calling screen before
-- campaigns, which was sales only). A picked campaign is used whatever its type.

-- ---------- internal helpers (granted to nobody) ----------

-- One row per original call in the range: the root row and its latest correction (the root itself when it was
-- never corrected). Same chain rule as admin_effective_outcomes in 0004.
create or replace function public.report_effective_calls(
  p_institute uuid, p_from timestamptz, p_to timestamptz)
returns table (root_id uuid, node_id uuid, happened_at timestamptz)
language sql stable security definer set search_path = public
as $$
  with recursive roots as (
    select c.id, c.uploaded_at, coalesce(c.dialled_at, c.uploaded_at) as at
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
  select l.root_id, l.node, r.at
  from latest l join roots r on r.id = l.root_id;
$$;

-- The campaign filter: the campaign must be in the institute (null = no filter).
create or replace function public.report_check_campaign(p_institute uuid, p_campaign uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_campaign is not null and not exists (
       select 1 from public.campaigns c where c.id = p_campaign and c.institute_id = p_institute) then
    raise exception 'campaign not found in this institute' using errcode = '22023';
  end if;
end $$;

-- The caller filter: the seat must be in the institute (null = everyone).
create or replace function public.report_check_seat(p_institute uuid, p_seat uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_seat is not null and not exists (
       select 1 from public.seats s where s.id = p_seat and s.institute_id = p_institute) then
    raise exception 'caller not found in this institute' using errcode = '22023';
  end if;
end $$;

-- The campaigns a fees or sales report covers: the picked one, or every campaign of the built-in type.
create or replace function public.report_campaigns(p_institute uuid, p_campaign uuid, p_type_key text)
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select c.id from public.campaigns c
  where c.institute_id = p_institute
    and case when p_campaign is not null then c.id = p_campaign
             else c.call_type_id in (select t.id from public.call_types t
                                     where t.key = p_type_key and t.institute_id is null) end;
$$;

-- Where a step sits in a script version: its 0-based place in the steps list, and the pitch step's place.
-- The pitch is the first step marked "pitch": true; with none marked, the middle step (pitch_guessed true).
create or replace function public.report_pitch_place(p_steps jsonb, p_step text)
returns table (step_place int, pitch_place int, pitch_guessed boolean)
language sql immutable set search_path = public
as $$
  with s as (
    select (x.ord - 1)::int as place, x.step
    from jsonb_array_elements(case when jsonb_typeof(p_steps) = 'array' then p_steps else '[]'::jsonb end)
         with ordinality as x(step, ord)
  ),
  marked as (
    select min(place) as place from s
    where jsonb_typeof(step) = 'object' and step ->> 'pitch' = 'true'
  )
  select (select min(place) from s where jsonb_typeof(step) = 'object' and step ->> 'id' = p_step),
         coalesce((select place from marked), case when (select count(*) from s) > 0
                                                   then (((select count(*) from s) - 1) / 2)::int end),
         (select place from marked) is null;
$$;

-- ---------- Fees collection ----------

-- One row of totals. Lead numbers are the leads now in scope (the caller filter = leads assigned to that seat);
-- paid numbers are calls in the date range that ended Paid or Paid part (the caller filter = calls by that seat).
--   leads, total_due                 leads with an amount due, and the sum due
--   paid_leads, paid_calls, paid_amount  paid after a call (amount reported by the caller)
--   promised_leads, promised_amount  leads with an open promise to pay (status promised)
--   broken_promises                  open promises whose date is before today (in p_tz)
create or replace function public.admin_fees_report(
  p_institute uuid, p_from timestamptz, p_to timestamptz,
  p_campaign uuid default null, p_seat uuid default null, p_tz text default 'UTC')
returns table (leads bigint, total_due numeric, paid_leads bigint, paid_calls bigint, paid_amount numeric,
               promised_leads bigint, promised_amount numeric, broken_promises bigint, money_hidden boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  money boolean;
  today date;
  l_n bigint; l_due numeric; p_n bigint; p_amt numeric; b_n bigint;
  pd_leads bigint; pd_calls bigint; pd_amt numeric;
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_range(p_from, p_to);
  perform public.admin_check_tz(p_tz);
  perform public.report_check_campaign(p_institute, p_campaign);
  perform public.report_check_seat(p_institute, p_seat);
  money := public.can_see_money(p_institute);
  today := (now() at time zone p_tz)::date;

  select count(*) filter (where l.amount_due > 0),
         sum(l.amount_due),
         count(*) filter (where l.status = 'promised'),
         sum(l.promised_amount) filter (where l.status = 'promised'),
         count(*) filter (where l.status = 'promised' and l.promised_date < today and not l.do_not_call)
    into l_n, l_due, p_n, p_amt, b_n
    from public.leads l
    where l.institute_id = p_institute
      and l.campaign_id in (select public.report_campaigns(p_institute, p_campaign, 'fees'))
      and (p_seat is null or l.assigned_seat_id = p_seat);

  select count(distinct o.lead_id), count(*), sum(o.amount)
    into pd_leads, pd_calls, pd_amt
    from public.report_effective_calls(p_institute, p_from, p_to) e
    join public.call_outcomes r on r.id = e.root_id
    join public.call_outcomes o on o.id = e.node_id
    where o.result_key in ('paid', 'paid_part')
      and coalesce(o.campaign_id, r.campaign_id) in (select public.report_campaigns(p_institute, p_campaign, 'fees'))
      and (p_seat is null or r.seat_id = p_seat);

  return query select coalesce(l_n, 0), case when money then coalesce(l_due, 0) end,
                      coalesce(pd_leads, 0), coalesce(pd_calls, 0), case when money then coalesce(pd_amt, 0) end,
                      coalesce(p_n, 0), case when money then coalesce(p_amt, 0) end,
                      coalesce(b_n, 0), not money;
end $$;

-- Open promises (status promised) due on or before today + p_days - 1, late ones included, oldest date first.
-- days_late: today - promised date (0 = due today, negative = not yet due). extra is the lead's sheet columns
-- (student, class …; never money). amount is the promised amount, null when money is hidden. At most 500 rows.
create or replace function public.admin_promises_due(
  p_institute uuid, p_campaign uuid default null, p_seat uuid default null,
  p_tz text default 'UTC', p_days int default 7)
returns table (lead_id uuid, name text, extra jsonb, amount numeric, promised_date date, days_late int,
               seat_id uuid, caller text, campaign_id uuid, campaign text, next_call_at timestamptz,
               money_hidden boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  money boolean;
  today date;
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_tz(p_tz);
  perform public.report_check_campaign(p_institute, p_campaign);
  perform public.report_check_seat(p_institute, p_seat);
  if p_days is null or p_days < 1 or p_days > 31 then
    raise exception 'days must be 1 to 31' using errcode = '22023';
  end if;
  money := public.can_see_money(p_institute);
  today := (now() at time zone p_tz)::date;
  return query
    select l.id, l.name, l.extra,
           case when money then l.promised_amount end,
           l.promised_date, (today - l.promised_date)::int,
           l.assigned_seat_id, s.label, l.campaign_id, c.name, l.next_call_at, not money
    from public.leads l
    join public.campaigns c on c.id = l.campaign_id
    left join public.seats s on s.id = l.assigned_seat_id
    where l.institute_id = p_institute
      and l.campaign_id in (select public.report_campaigns(p_institute, p_campaign, 'fees'))
      and (p_seat is null or l.assigned_seat_id = p_seat)
      and l.status = 'promised' and not l.do_not_call
      and l.promised_date is not null
      and l.promised_date <= today + (p_days - 1)
    order by l.promised_date, l.name, l.id
    limit 500;
end $$;

-- "Send these back to callers": the leads come up in their callers' lists now (next_call_at = now()).
-- Only leads of this institute that are still to call (new, callback, promised; not do-not-call) change.
-- Returns how many changed. Audit 'leads.sent_back', target the count.
create or replace function public.admin_send_back_leads(p_institute uuid, p_leads uuid[])
returns int
language plpgsql security definer set search_path = public
as $$
declare
  n int;
begin
  perform public.admin_require(p_institute);
  if p_leads is null or cardinality(p_leads) = 0 then
    raise exception 'pick at least one lead' using errcode = '22023';
  end if;
  if cardinality(p_leads) > 1000 then
    raise exception 'send back at most 1000 leads at a time' using errcode = '22023';
  end if;
  update public.leads l set next_call_at = now()
    where l.institute_id = p_institute and l.id = any (p_leads)
      and l.status in ('new', 'callback', 'promised') and not l.do_not_call;
  get diagnostics n = row_count;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (p_institute, auth.uid(), 'leads.sent_back', n::text);
  return n;
end $$;

-- ---------- Sales funnel ----------

-- Calls in the range, each counted once at its latest correction:
--   called       every call
--   picked_up    talk time recorded, or a result other than no answer, busy or network drop
--   heard_pitch  picked up, and the furthest step reached (reached_step, else the logged end step) is at or
--                past the pitch step of that call's script version (script order; see report_pitch_place)
--   interested   ended Interested or Joined (old outcome interested or won)
--   joined       ended Joined (old outcome won)
-- no_step: picked-up calls with no script step to place. pitch_guessed: a script had no step marked as the
-- pitch, so its middle step was used. top_reason: the most common reason on lost calls. No money here.
create or replace function public.admin_sales_funnel(
  p_institute uuid, p_from timestamptz, p_to timestamptz,
  p_campaign uuid default null, p_seat uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_range(p_from, p_to);
  perform public.report_check_campaign(p_institute, p_campaign);
  perform public.report_check_seat(p_institute, p_seat);

  return (
    with calls as (
      select o.outcome,
             coalesce(o.connected_seconds, r.connected_seconds, 0) > 0
               or o.outcome not in ('no_answer', 'busy', 'dropped_network') as picked,
             pp.step_place, pp.pitch_place, pp.pitch_guessed, v.id as version_id,
             nullif(trim(coalesce(o.loss_reason, r.loss_reason, o.result_reason, r.result_reason)), '') as reason
      from public.report_effective_calls(p_institute, p_from, p_to) e
      join public.call_outcomes r on r.id = e.root_id
      join public.call_outcomes o on o.id = e.node_id
      left join public.campaigns c on c.id = coalesce(o.campaign_id, r.campaign_id)
      -- The call's own script version; a campaign call without one uses the campaign's published version.
      left join lateral (
        select sv.id, sv.steps from public.script_versions sv
        where sv.institute_id = p_institute
          and ((coalesce(o.script_id, r.script_id) is not null
                and sv.script_id::text = coalesce(o.script_id, r.script_id)
                and sv.version = coalesce(o.script_version, r.script_version))
            or (coalesce(o.script_id, r.script_id) is null and c.script_id is not null
                and sv.script_id = c.script_id and sv.published))
        limit 1) v on true
      left join lateral public.report_pitch_place(v.steps,
        coalesce(o.reached_step, r.reached_step, o.script_step, r.script_step)) pp on true
      where (p_seat is null or r.seat_id = p_seat)
        and case when p_campaign is not null then c.id = p_campaign
                 else c.id is null or c.id in (select public.report_campaigns(p_institute, null, 'sales')) end
    ),
    top as (
      select reason, count(*) as n from calls
      where outcome = 'not_interested' and reason is not null
      group by reason order by count(*) desc, reason limit 1
    )
    select jsonb_build_object(
      'called', count(*),
      'picked_up', count(*) filter (where picked),
      'heard_pitch', count(*) filter (where picked and step_place is not null and step_place >= pitch_place),
      'interested', count(*) filter (where outcome in ('interested', 'won')),
      'joined', count(*) filter (where outcome = 'won'),
      'no_step', count(*) filter (where picked and step_place is null),
      'pitch_guessed', coalesce(bool_or(pitch_guessed) filter (where version_id is not null), false),
      'top_reason', (select jsonb_build_object('reason', t.reason, 'calls', t.n) from top t))
    from calls);
end $$;

-- ---------- grants ----------

revoke all on function public.report_effective_calls(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.report_check_campaign(uuid, uuid) from public, anon, authenticated;
revoke all on function public.report_check_seat(uuid, uuid) from public, anon, authenticated;
revoke all on function public.report_campaigns(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.report_pitch_place(jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_fees_report(uuid, timestamptz, timestamptz, uuid, uuid, text) from public, anon;
revoke all on function public.admin_promises_due(uuid, uuid, uuid, text, int) from public, anon;
revoke all on function public.admin_send_back_leads(uuid, uuid[]) from public, anon;
revoke all on function public.admin_sales_funnel(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.admin_fees_report(uuid, timestamptz, timestamptz, uuid, uuid, text) to authenticated;
grant execute on function public.admin_promises_due(uuid, uuid, uuid, text, int) to authenticated;
grant execute on function public.admin_send_back_leads(uuid, uuid[]) to authenticated;
grant execute on function public.admin_sales_funnel(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;
