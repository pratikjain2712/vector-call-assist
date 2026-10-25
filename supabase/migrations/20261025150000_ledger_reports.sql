-- Vector Phase A.2: Reports, Home and Insights count money received from the fee ledger. Apply after
-- 20261025130000_ledger_open_campaigns.sql.
--
-- admin_fees_ledger      Reports > Fees collection: total due now and collected (the ledger), promised and not
--                        yet paid and broken promises (the calls, checked against the ledger).
-- admin_promises_ledger  "Promises due this week": each promise with what the ledger shows since it was made.
-- admin_home_ledger      Home: collected in the day (the ledger), promises due today not yet paid in the ledger,
--                        follow-ups returned to the pool today (audit_log lead.released).
-- Insights reads promises_vs_payments (20261025130000) as it is.
--
-- admin_fees_ledger and admin_promises_ledger are for owners, managers and accounts seats (can_read_ledger:
-- an accounts seat opens Reports > Fees collection); admin_home_ledger is for owners and managers (Home).
-- Money follows docs/data-contract.md: amounts only when can_see_money() is true, otherwise null with
-- money_hidden true; counts always. The ledger numbers leave out reversed payments, the reversals themselves
-- and opening imports ("paid so far"), like ledger_collected.
--
-- Words:
--   promise       a lead of a fees campaign with a promised date: an open promise (status promised, not
--                 do-not-call), or a lead closed in the last 7 days (status done) that still has its date.
--   promised on   the day of the latest call on the lead that set a promised date (not corrected since), else
--                 the day the lead was added.
--   paid          the student's payments dated from the promised-on day to today.
--   ledger state  no_student (the lead has no student, so the ledger cannot say), paid (paid reaches the
--                 promised amount, or the lead was closed by a payment), part_paid, not_paid.
--   broken        an open promise whose date has passed and that is not paid in the ledger.

-- ---------- internal (granted to nobody) ----------

create or replace function public.report_fee_promise_rows(p_institute uuid, p_campaign uuid, p_seat uuid)
returns table (lead_id uuid, name text, extra jsonb, student_id uuid, lead_status text, promised_date date,
               promised_amount numeric, promised_on date, seat_id uuid, campaign_id uuid, next_call_at timestamptz,
               paid numeric, paid_on date, paid_mode text, ledger_state text, days_late int)
language sql stable security definer set search_path = public
as $$
  with d as (
    select public.ledger_today(p_institute) as today, public.institute_tz(p_institute) as tz
  ),
  cand as (
    select l.id, l.name, l.extra, l.student_id, l.status, l.promised_date, l.promised_amount, l.assigned_seat_id,
           l.campaign_id, l.next_call_at, l.created_at, d.today, d.tz
    from public.leads l cross join d
    where l.institute_id = p_institute
      and l.campaign_id in (select public.report_campaigns(p_institute, p_campaign, 'fees'))
      and (p_seat is null or l.assigned_seat_id = p_seat)
      and l.promised_date is not null
      and ((l.status = 'promised' and not l.do_not_call)
           or (l.status = 'done' and l.promised_date >= d.today - 7))
  ),
  x as (
    select c.*, coalesce(pc.day, (c.created_at at time zone c.tz)::date) as on_day
    from cand c
    left join lateral (
      select (coalesce(o.dialled_at, o.uploaded_at) at time zone c.tz)::date as day
      from public.call_outcomes o
      where o.lead_id = c.id and o.promised_date is not null
        and not exists (select 1 from public.call_outcomes k where k.corrects_id = o.id)
      order by coalesce(o.dialled_at, o.uploaded_at) desc
      limit 1) pc on true
  ),
  y as (
    select x.*, coalesce(p.paid, 0) as paid_sum, lp.paid_on as last_on, lp.mode as last_mode
    from x
    left join lateral (
      select sum(py.amount) as paid from public.payments py
      where x.student_id is not null and py.student_id = x.student_id
        and py.reverses_id is null and not py.opening
        and not exists (select 1 from public.payments r where r.reverses_id = py.id)
        and py.paid_on between x.on_day and x.today) p on true
    left join lateral (
      select py.paid_on, py.mode from public.payments py
      where x.student_id is not null and py.student_id = x.student_id
        and py.reverses_id is null and not py.opening
        and not exists (select 1 from public.payments r where r.reverses_id = py.id)
        and py.paid_on between x.on_day and x.today
      order by py.paid_on desc, py.created_at desc
      limit 1) lp on true
  )
  select y.id, y.name, y.extra, y.student_id, y.status, y.promised_date, y.promised_amount, y.on_day,
         y.assigned_seat_id, y.campaign_id, y.next_call_at, y.paid_sum, y.last_on, y.last_mode,
         case when y.student_id is null then 'no_student'
              when y.paid_sum > 0 and (y.status = 'done' or y.paid_sum >= coalesce(y.promised_amount, 0)) then 'paid'
              when y.paid_sum > 0 then 'part_paid'
              else 'not_paid' end,
         (y.today - y.promised_date)::int
  from y;
$$;

-- The date range of a ledger report: from on or before to, at most 400 days (as ledger_collected).
create or replace function public.report_check_days(p_from date, p_to date)
returns void
language plpgsql immutable set search_path = public
as $$
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'the from date must be on or before the to date' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'a report covers at most 400 days' using errcode = '22023';
  end if;
end $$;

-- Owners, managers and accounts seats of the institute (can_read_ledger), else 42501.
create or replace function public.report_require_ledger(p_institute uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.can_read_ledger(p_institute) then
    raise exception 'only owners, managers and accounts can see fee reports' using errcode = '42501';
  end if;
end $$;

-- ---------- Reports > Fees collection ----------

-- One jsonb for the tiles:
--   from, to, campaign_id, today, money_hidden, has_ledger (the institute has students), linked_leads (fees
--   leads in scope that point at a student)
--   due_now    {students, amount}   active students (with a lead in the campaign, when one is picked) whose
--                                   balance due now is above 0, and the sum. The ledger; not by caller.
--   collected  {payments, reversed, total, by_mode [{mode, payments, amount}], by_day [{day, payments, amount}]}
--              payments dated in the range (ledger_collected). The ledger; not by caller.
--   promised   {leads, amount}      open promises dated today or later, not paid in the ledger; amount = what
--                                   is still to pay (promised minus paid). The calls; the caller filter applies.
--   broken     {leads, amount, part_paid}   open promises whose date has passed, not paid in the ledger.
--   promises_paid {leads}           open promises already paid in the ledger (the lead is still open because
--                                   other fees are due).
create or replace function public.admin_fees_ledger(
  p_institute uuid, p_from date, p_to date, p_campaign uuid default null, p_seat uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  money boolean;
  today date;
  col   jsonb;
  out   jsonb;
begin
  perform public.report_require_ledger(p_institute);
  perform public.report_check_days(p_from, p_to);
  perform public.report_check_campaign(p_institute, p_campaign);
  perform public.report_check_seat(p_institute, p_seat);
  money := public.can_see_money(p_institute);
  today := public.ledger_today(p_institute);
  col := public.ledger_collected(p_institute, p_from, p_to, p_campaign);

  with pr as (
    select r.* from public.report_fee_promise_rows(p_institute, p_campaign, p_seat) r
    where r.lead_status = 'promised'
  ),
  st as (
    select b.balance_due_now
    from public.student_balance_rows(p_institute) b
    join public.students s on s.id = b.student_id
    where s.status = 'active'
      and (p_campaign is null or exists (select 1 from public.leads l
                                         where l.campaign_id = p_campaign and l.student_id = s.id))
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'campaign_id', p_campaign, 'today', today, 'money_hidden', not money,
    'has_ledger', exists (select 1 from public.students s where s.institute_id = p_institute),
    'linked_leads', (select count(*) from public.leads l
                     where l.institute_id = p_institute and l.student_id is not null
                       and l.campaign_id in (select public.report_campaigns(p_institute, p_campaign, 'fees'))),
    'due_now', (select jsonb_build_object(
        'students', count(*) filter (where st.balance_due_now > 0),
        'amount', case when money then coalesce(sum(st.balance_due_now) filter (where st.balance_due_now > 0), 0) end)
      from st),
    'collected', jsonb_build_object(
        'payments', col -> 'payments', 'reversed', col -> 'reversed', 'total', col -> 'total',
        'by_mode', col -> 'by_mode', 'by_day', col -> 'by_day'),
    'promised', (select jsonb_build_object(
        'leads', count(*),
        'amount', case when money then coalesce(sum(greatest(coalesce(pr.promised_amount, 0) - pr.paid, 0)), 0) end)
      from pr where pr.promised_date >= today and pr.ledger_state <> 'paid'),
    'broken', (select jsonb_build_object(
        'leads', count(*),
        'part_paid', count(*) filter (where pr.ledger_state = 'part_paid'),
        'amount', case when money then coalesce(sum(greatest(coalesce(pr.promised_amount, 0) - pr.paid, 0)), 0) end)
      from pr where pr.promised_date < today and pr.ledger_state <> 'paid'),
    'promises_paid', (select jsonb_build_object('leads', count(*)) from pr where pr.ledger_state = 'paid'))
  into out;
  return out;
end $$;

-- "Promises due this week": promises dated on or before today + p_days - 1 (late ones included) that are still
-- open, or that the ledger shows as paid (closed leads of the last 7 days too). Oldest date first, 500 at most.
-- amount: the promised amount; paid_amount: paid since the promise (both null unless can_see_money).
-- paid_on, paid_mode: the latest payment since the promise. lead_status: the lead now (promised or done).
create or replace function public.admin_promises_ledger(
  p_institute uuid, p_campaign uuid default null, p_seat uuid default null, p_days int default 7)
returns table (lead_id uuid, name text, extra jsonb, student_id uuid, amount numeric, promised_date date,
               days_late int, promised_on date, seat_id uuid, caller text, campaign_id uuid, campaign text,
               next_call_at timestamptz, lead_status text, ledger_state text, paid_amount numeric, paid_on date,
               paid_mode text, money_hidden boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  money boolean;
  today date;
begin
  perform public.report_require_ledger(p_institute);
  perform public.report_check_campaign(p_institute, p_campaign);
  perform public.report_check_seat(p_institute, p_seat);
  if p_days is null or p_days < 1 or p_days > 31 then
    raise exception 'days must be 1 to 31' using errcode = '22023';
  end if;
  money := public.can_see_money(p_institute);
  today := public.ledger_today(p_institute);
  return query
    select r.lead_id, r.name, r.extra, r.student_id,
           case when money then r.promised_amount end,
           r.promised_date, r.days_late, r.promised_on, r.seat_id, s.label, r.campaign_id, c.name, r.next_call_at,
           r.lead_status, r.ledger_state,
           case when money then r.paid end,
           r.paid_on, r.paid_mode, not money
    from public.report_fee_promise_rows(p_institute, p_campaign, p_seat) r
    join public.campaigns c on c.id = r.campaign_id
    left join public.seats s on s.id = r.seat_id
    where r.promised_date <= today + (p_days - 1)
      and (r.lead_status = 'promised' or r.ledger_state = 'paid')
    order by r.promised_date, r.name, r.lead_id
    limit 500;
end $$;

-- ---------- Home ----------

-- For the admin's own institute, the same day and campaign filter as admin_home_summary:
--   day, from, to (dates in the institute's time zone), money_hidden, has_ledger
--   collected        {payments, amount}   ledger payments dated in the day (or Monday to Sunday for week)
--   promises_due_unpaid {count, amount}   open fees promises dated today that the ledger does not show as
--                                         paid; amount = still to pay
--   released_today   {count, idle, inactive, revoked, admin}   follow-ups returned to the pool today
--                                         (audit_log lead.released, by reason)
create or replace function public.admin_home_ledger(p_day text default 'today', p_campaign uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat   public.seats;
  inst   uuid;
  tz     text;
  money  boolean;
  today  date;
  d_from date;
  d_to   date;
  col    jsonb;
  out    jsonb;
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
  today := public.ledger_today(inst);
  if p_day = 'today' then d_from := today; d_to := today;
  elsif p_day = 'yesterday' then d_from := today - 1; d_to := today - 1;
  else d_from := date_trunc('week', today::timestamp)::date; d_to := d_from + 6;
  end if;
  col := public.ledger_collected(inst, d_from, d_to, p_campaign);

  with due as (
    select r.* from public.report_fee_promise_rows(inst, p_campaign, null) r
    where r.lead_status = 'promised' and r.promised_date = today and r.ledger_state <> 'paid'
  ),
  rel as (
    select split_part(a.target, ':', 3) as why
    from public.audit_log a
    where a.institute_id = inst and a.action = 'lead.released'
      and a.created_at >= (today::timestamp at time zone tz)
      and (p_campaign is null or exists (select 1 from public.leads l
                                         where l.id::text = split_part(a.target, ':', 1) and l.campaign_id = p_campaign))
  )
  select jsonb_build_object(
    'day', p_day, 'from', d_from, 'to', d_to, 'money_hidden', not money,
    'has_ledger', exists (select 1 from public.students s where s.institute_id = inst),
    'collected', jsonb_build_object('payments', col -> 'payments', 'amount', col -> 'total'),
    'promises_due_unpaid', (select jsonb_build_object(
        'count', count(*),
        'amount', case when money then coalesce(sum(greatest(coalesce(due.promised_amount, 0) - due.paid, 0)), 0) end)
      from due),
    'released_today', (select jsonb_build_object(
        'count', count(*),
        'idle', count(*) filter (where rel.why = 'idle'),
        'inactive', count(*) filter (where rel.why = 'inactive'),
        'revoked', count(*) filter (where rel.why = 'revoked'),
        'admin', count(*) filter (where rel.why = 'admin'))
      from rel))
  into out;
  return out;
end $$;

-- ---------- grants ----------

revoke all on function public.report_fee_promise_rows(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.report_check_days(date, date) from public, anon, authenticated;
revoke all on function public.report_require_ledger(uuid) from public, anon, authenticated;
revoke all on function public.admin_fees_ledger(uuid, date, date, uuid, uuid) from public, anon;
revoke all on function public.admin_promises_ledger(uuid, uuid, uuid, int) from public, anon;
revoke all on function public.admin_home_ledger(text, uuid) from public, anon;
grant execute on function public.admin_fees_ledger(uuid, date, date, uuid, uuid) to authenticated;
grant execute on function public.admin_promises_ledger(uuid, uuid, uuid, int) to authenticated;
grant execute on function public.admin_home_ledger(text, uuid) to authenticated;
