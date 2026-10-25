-- Phase A.2 integration: what the five A.2 branches needed from each other.
--
-- 1. {due_date} on the caller page. my_call_queue (same columns and checks as 20261025130000) adds the
--    campaign's 'fees_due_by' and, per lead, 'due_date': the campaign's fees_due_by when it has one, else
--    for a lead linked to a student, the due date of the student's oldest fee item not yet covered by
--    payments (student_next_due_date). Leads without a student: null (the lead's own extra may carry one).
-- 2. Accounts seats are not callers. admin_callers (same columns as 20261024100023) gives accounts seats no
--    "now" status, no call target and no campaigns, so the Callers tab shows them as seats with the role
--    Accounts only. admin_home_summary (same answer as 20261024100023) never lists an accounts seat under
--    callers, and with a campaign filter also lists the callers holding open leads of that campaign (open
--    campaigns have no members: their callers take leads from the pool).
-- 3. Common answers keep the library's order (the most asked first: "Where did you get my number?" before
--    "I never gave you my number"): common_answers.sort_order, set for the 21 seeded answers; new answers go
--    last. my_common_answers (same columns as 20261025140000) orders by sort_order, then label.
-- 4. Speed (found on the demo data, 570 students): institute_tz looked the zone up in pg_timezone_names
--    (~20 ms a call), and student_balance_rows called it once per fee item, so accounts_students timed out.
--    institute_tz now checks the zone without that view (same answer: the zone when the database knows it,
--    else India), and student_balance_rows works out "today" once.

-- ---------- 1. {due_date} ----------

-- The due date of the student's oldest fee item that payments do not cover yet (fee items in due-date order,
-- payments net of reversals). Null when nothing is unpaid or the student has no fee items. Internal.
create or replace function public.student_next_due_date(p_student uuid)
returns date
language sql stable security definer set search_path = public
as $$
  with paid as (
    select coalesce(sum(case when py.reverses_id is null then py.amount else -py.amount end), 0) as amt
    from public.payments py where py.student_id = p_student
  ), run as (
    select fi.due_date,
           sum(fi.amount) over (order by fi.due_date, fi.created_at, fi.id) as upto
    from public.fee_items fi
    where fi.student_id = p_student and not fi.is_void
  )
  select min(r.due_date) from run r, paid p where r.upto > p.amt;
$$;
revoke all on function public.student_next_due_date(uuid) from public, anon, authenticated;

-- my_call_queue: same as 20261025130000, plus 'fees_due_by' and each lead's 'due_date'.
create or replace function public.my_call_queue(p_campaign uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat  public.seats;
  c     public.campaigns;
  since timestamptz := public.india_day_start();
  out   jsonb;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  select x.* into c from public.campaigns x
   where x.id = p_campaign and x.status in ('running', 'paused') and x.institute_id = seat.institute_id
     and public.campaign_seat_can_work(x.id, seat.id);
  if c.id is null then raise exception 'campaign not found' using errcode = '42501'; end if;

  select jsonb_build_object(
    'campaign_id', c.id, 'status', c.status, 'share_mode', c.share_mode, 'daily_target', c.daily_target,
    'open_to_all', c.open_to_all, 'class_label', c.class_label, 'board', c.board, 'fees_due_by', c.fees_due_by,
    'my_calls_today', (select count(*) from public.call_outcomes o
                        where o.campaign_id = c.id and o.seat_id = seat.id and o.corrects_id is null
                          and coalesce(o.dialled_at, o.uploaded_at) >= since),
    'team_calls_today', (select count(*) from public.call_outcomes o
                          where o.campaign_id = c.id and o.corrects_id is null
                            and coalesce(o.dialled_at, o.uploaded_at) >= since),
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'name', l.name, 'phone', l.phone, 'extra', l.extra, 'status', l.status,
               'next_call_at', l.next_call_at, 'promised_date', l.promised_date,
               'consent_whatsapp', l.consent_whatsapp, 'created_at', l.created_at, 'student_id', l.student_id,
               'due_date', coalesce(c.fees_due_by,
                                    case when l.student_id is not null then public.student_next_due_date(l.student_id) end),
               'calls', last.calls, 'last_called_at', last.at, 'last_result_key', last.result_key,
               'last_note', last.note)
             order by case when l.next_call_at is not null and l.next_call_at <= now() then 0
                           when l.next_call_at is null then 1 else 2 end,
                      l.next_call_at nulls last, l.created_at, l.id)
      from (select * from public.leads l
             where l.campaign_id = c.id and l.assigned_seat_id = seat.id
               and l.status in ('new', 'callback', 'promised') and not l.do_not_call and l.consent_call
             order by case when l.next_call_at is not null and l.next_call_at <= now() then 0
                           when l.next_call_at is null then 1 else 2 end,
                      l.next_call_at nulls last, l.created_at, l.id
             limit 500) l
      left join lateral (
        select count(*) over () as calls, coalesce(o.dialled_at, o.uploaded_at) as at, o.result_key,
               coalesce(o.note, o.result_reason) as note
        from public.call_outcomes o
        where o.lead_id = l.id and o.corrects_id is null
        order by coalesce(o.dialled_at, o.uploaded_at) desc
        limit 1) last on true), '[]'::jsonb))
  into out;
  return out;
end $$;
revoke all on function public.my_call_queue(uuid) from public, anon;
grant execute on function public.my_call_queue(uuid) to authenticated;

-- ---------- 2. Accounts seats are not callers ----------

-- admin_callers: same as 20261024100023; accounts seats get no campaigns, call target or "now" status.
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
           case when s.role = 'accounts' then '[]'::jsonb else
           (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status)
                                      order by c.name), '[]'::jsonb)
            from public.campaign_members m join public.campaigns c on c.id = m.campaign_id
            where m.seat_id = s.id and c.status <> 'closed') end,
           (select count(*) from public.call_outcomes o
            where o.seat_id = s.id and o.corrects_id is null
              and coalesce(o.dialled_at, o.uploaded_at) >= day_start),
           case when s.role = 'accounts' then null else
           (select t.daily_target from public.rep_targets t where t.seat_id = s.id and t.metric = 'calls') end,
           case when s.status = 'active' and s.role <> 'accounts' then public.home_seat_status(s.id, day_start) end
    from public.seats s
    where s.institute_id = p_institute
    order by s.status, s.label;
end $$;
revoke all on function public.admin_callers(uuid) from public, anon;
grant execute on function public.admin_callers(uuid) to authenticated;

-- admin_home_summary: same as 20261024100023, except who is listed under callers: never an accounts seat;
-- with a campaign filter, members and the callers holding open leads of that campaign (open campaigns have
-- no members).
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
    where s.institute_id = inst and s.status = 'active' and s.role <> 'accounts'
      and (
        (s.role = 'rep' and (p_campaign is null
           or exists (select 1 from public.campaign_members m where m.seat_id = s.id and m.campaign_id = p_campaign)
           or exists (select 1 from public.leads ol
                      where ol.campaign_id = p_campaign and ol.assigned_seat_id = s.id
                        and ol.status in ('new', 'callback', 'promised'))))
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

revoke all on function public.admin_home_summary(text, uuid) from public, anon;
grant execute on function public.admin_home_summary(text, uuid) to authenticated;

-- ---------- 3. Common answers in the library's order ----------

alter table public.common_answers add column if not exists sort_order int not null default 1000;
update public.common_answers a set sort_order = o.n * 10
from unnest(array['where_number', 'never_gave_number', 'who_are_you', 'sales_call', 'busy_call_later', 'how_long',
                  'send_whatsapp', 'do_not_call', 'dnd', 'fee_amount', 'discount', 'fraud_check', 'otp_bank',
                  'speak_hindi', 'ask_family', 'other_parent', 'joined_elsewhere', 'wrong_number', 'location',
                  'speak_senior', 'call_back_number']) with ordinality as o(key, n)
where a.key = o.key and a.sort_order = 1000;

-- my_common_answers: same columns and rules as 20261025140000, in the library's order.
create or replace function public.my_common_answers()
returns table (key text, label text, answer text, tags text[], fallback text, result text, "check" text[],
  filled boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_inst uuid;
begin
  select s.institute_id into v_inst from public.seats s where s.user_id = auth.uid() and s.status = 'active' limit 1;
  if v_inst is null then
    raise exception 'no active seat for this login' using errcode = '42501';
  end if;
  return query
    select a.key, a.label, coalesce(f.answer, a.answer), a.tags, a.fallback, a.result, a.checks,
           (cardinality(a.checks) = 0 or f.answer is not null)
    from public.common_answers a
    left join public.institute_answer_fills f on f.answer_key = a.key and f.institute_id = v_inst
    where a.active
    order by a.sort_order, a.label;
end $$;
revoke all on function public.my_common_answers() from public, anon;
grant execute on function public.my_common_answers() to authenticated;

-- ---------- 4. Speed ----------

-- The institute's time zone, or India when it is missing or unknown to the database. Same answer as
-- 20261024100023 without reading pg_timezone_names (slow): a zone name is checked by using it.
create or replace function public.institute_tz(p_institute uuid)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  tz text;
begin
  select i.time_zone into tz from public.institutes i where i.id = p_institute;
  if tz is null or tz = 'Asia/Kolkata' then return 'Asia/Kolkata'; end if;
  if tz !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' then return 'Asia/Kolkata'; end if;
  begin
    perform now() at time zone tz;
  exception when others then
    return 'Asia/Kolkata';
  end;
  return tz;
end $$;
revoke all on function public.institute_tz(uuid) from public, anon, authenticated;

-- student_balance_rows: same as 20261025130000; "today" is worked out once, not once per fee item.
create or replace function public.student_balance_rows(p_institute uuid, p_student uuid default null, p_as_of date default null)
returns table (student_id uuid, total_fees numeric, total_due_to_date numeric, paid numeric,
               balance_due_now numeric, balance_total numeric,
               last_payment_amount numeric, last_payment_on date, last_payment_mode text)
language sql stable security definer set search_path = public
as $$
  with d as materialized (select coalesce(p_as_of, public.ledger_today(p_institute)) as as_of)
  select s.id, f.total::numeric(12, 2), f.due::numeric(12, 2), p.paid::numeric(12, 2), (f.due - p.paid)::numeric(12, 2),
         (f.total - p.paid)::numeric(12, 2), lp.amount, lp.paid_on, lp.mode
  from public.students s
  cross join d
  cross join lateral (
    select coalesce(sum(fi.amount), 0) as total,
           coalesce(sum(fi.amount) filter (where fi.due_date <= d.as_of), 0) as due
    from public.fee_items fi where fi.student_id = s.id and not fi.is_void) f
  cross join lateral (
    select coalesce(sum(case when py.reverses_id is null then py.amount else -py.amount end), 0) as paid
    from public.payments py where py.student_id = s.id) p
  left join lateral (
    select py.amount, py.paid_on, py.mode from public.payments py
    where py.student_id = s.id and py.reverses_id is null
      and not exists (select 1 from public.payments r where r.reverses_id = py.id)
    order by py.paid_on desc, py.created_at desc limit 1) lp on true
  where s.institute_id = p_institute and (p_student is null or s.id = p_student);
$$;

revoke all on function public.student_balance_rows(uuid, uuid, date) from public, anon, authenticated;
