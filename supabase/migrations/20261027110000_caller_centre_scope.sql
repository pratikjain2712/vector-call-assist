-- Callers limited to some centres get only those centres' calls; managers who can see money record payments;
-- a fees calling list in one step from the Fees list; "Away today" with Undo on the Team tab.
-- Apply after 20261027100000_centres_batches.sql. Contract: docs/data-contract.md, "Office clicks".
--
-- 1. Caller centre scope. seats.centre_ids (null = every centre) now also limits calling: a caller limited to
--    some centres only gets leads whose centre_id is one of theirs or null (shared), and only calling lists for
--    their centres or for every centre (campaigns.centre_id null).
--      - seat_takes_centre(seat, centre): the rule, in one place.
--      - campaign_seat_can_work: a list of another centre is not workable by that seat (so the share functions
--        release its leads from that seat, and next_free_lead / my_call_queue refuse it).
--      - next_free_lead: the seat's own new leads and the pool, in the seat's centres only.
--      - my_call_queue, my_campaigns: only leads (and lists) in the seat's centres; counts likewise.
--      - campaign_share_equal / campaign_share_next_free: after sharing, an open lead held by a seat that does
--        not take its centre goes to a member that does (equal share) or back to the pool.
--      - admin_set_seat_centres: the seat's open leads outside its new centres go back to the pool.
-- 2. Payments by managers who can see money (owner decision): can_record_payment() = owner or Accounts
--    (can_manage_ledger) or a manager with can_see_money(). accounts_record_payment takes it (recorded_by is
--    the manager); accounts_reverse_payment lets such a manager reverse only their own payment, within 10
--    minutes (the Undo on Collect); collected_by_me says can_collect. The centre check is unchanged
--    (ledger_student / student_in_scope_rls). Managers without money access stay refused.
-- 3. "Call these N parents" on the Fees list: fees_call_plan(p_filters) (how many parents, the name, the
--    script and the callers Autopilot would pick) and fees_call_start(p_filters) (makes and starts the list).
--    Filters as the list: centre_id, batch_id, class_label, section, board, academic_year; students with dues
--    now. Who: as accounts_create_fees_campaign (owner, Accounts, a manager who can see money).
-- 4. "Away today": admin_away_today(seat) sends the seat's open leads back to the pool and returns their ids;
--    admin_undo_away(seat, ids) gives back those still in the pool.

-- =====================================================================================================
-- 1. Caller centre scope
-- =====================================================================================================

-- The seat may work a lead or list of this centre: no centre (shared), or the seat works in every centre, or
-- the centre is one of the seat's.
create or replace function public.seat_takes_centre(p_seat uuid, p_centre uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_centre is null
      or coalesce((select p_centre = any (s.centre_ids) from public.seats s where s.id = p_seat), true)
$$;

-- As in 20261025130000, and a calling list of another centre is not workable by a seat limited to some centres.
create or replace function public.campaign_seat_can_work(p_campaign uuid, p_seat uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.campaigns c
    join public.seats s on s.id = p_seat and s.institute_id = c.institute_id and s.status = 'active'
    where c.id = p_campaign
      and (c.centre_id is null or s.centre_ids is null or c.centre_id = any (s.centre_ids))
      and (c.open_to_all or exists (select 1 from public.campaign_members m
                                    where m.campaign_id = c.id and m.seat_id = s.id)));
$$;

-- Open leads held by a seat that does not take their centre: to a member of the list that does, the one with
-- the fewest open leads (p_reassign, equal share; then one of that member's uncalled leads the first seat may
-- take comes back, so the share stays equal), else back to the pool. Returns how many moved.
create or replace function public.campaign_fix_centres(p_campaign uuid, p_reassign boolean)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  r   record;
  to_ uuid;
  n   int := 0;
begin
  for r in
    select l.id, l.centre_id, l.assigned_seat_id as seat from public.leads l
    where l.campaign_id = p_campaign and l.assigned_seat_id is not null
      and public.lead_is_open(l.status, l.do_not_call)
      and not public.seat_takes_centre(l.assigned_seat_id, l.centre_id)
    order by l.created_at, l.id
  loop
    to_ := null;
    if p_reassign then
      select m.seat_id into to_
      from public.campaign_members m
      join public.seats s on s.id = m.seat_id and s.status = 'active'
      where m.campaign_id = p_campaign and public.seat_takes_centre(s.id, r.centre_id)
      order by (select count(*) from public.leads x where x.campaign_id = p_campaign and x.assigned_seat_id = s.id
                  and public.lead_is_open(x.status, x.do_not_call)), s.id
      limit 1;
    end if;
    update public.leads set assigned_seat_id = to_ where id = r.id;
    n := n + 1;
    -- Equal share stays equal: one uncalled lead of the new holder that the first seat may take goes the other way.
    if to_ is not null then
      update public.leads x set assigned_seat_id = r.seat
       where x.id = (select y.id from public.leads y
                      where y.campaign_id = p_campaign and y.assigned_seat_id = to_ and y.id <> r.id
                        and public.lead_is_open(y.status, y.do_not_call) and public.lead_is_uncalled(y.id, y.status)
                        and public.seat_takes_centre(r.seat, y.centre_id)
                      order by y.created_at desc, y.id desc limit 1);
    end if;
  end loop;
  return n;
end $$;

alter function public.campaign_share_equal(uuid) rename to campaign_share_equal__base;
alter function public.campaign_share_next_free(uuid) rename to campaign_share_next_free__base;
revoke all on function public.campaign_share_equal__base(uuid) from public, anon, authenticated;
revoke all on function public.campaign_share_next_free__base(uuid) from public, anon, authenticated;

create function public.campaign_share_equal(p_campaign uuid)
returns int
language plpgsql security definer set search_path = public
as $$
begin
  return public.campaign_share_equal__base(p_campaign) + public.campaign_fix_centres(p_campaign, true);
end $$;

create function public.campaign_share_next_free(p_campaign uuid)
returns int
language plpgsql security definer set search_path = public
as $$
begin
  return public.campaign_share_next_free__base(p_campaign) + public.campaign_fix_centres(p_campaign, false);
end $$;

-- As in 20261027100000, and the seat's open leads outside its new centres go back to the pool.
alter function public.admin_set_seat_centres(uuid, uuid[]) rename to admin_set_seat_centres__base;
revoke all on function public.admin_set_seat_centres__base(uuid, uuid[]) from public, anon, authenticated;
create function public.admin_set_seat_centres(p_seat uuid, p_centres uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.admin_set_seat_centres__base(p_seat, p_centres);
  update public.leads l set assigned_seat_id = null
   where l.assigned_seat_id = p_seat and public.lead_is_open(l.status, l.do_not_call)
     and not public.seat_takes_centre(p_seat, l.centre_id);
end $$;

-- next_free_lead: as in 20261025130000; the seat's own new leads and the pool only in the seat's centres.
create or replace function public.next_free_lead(p_campaign uuid)
returns table (lead_id uuid, campaign_id uuid, name text, phone text, extra jsonb, status text,
               next_call_at timestamptz, promised_date date)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
  c    public.campaigns;
  lid  uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  select * into c from public.campaigns k where k.id = p_campaign;
  if c.id is null or c.institute_id <> seat.institute_id or c.status = 'draft'
     or not public.campaign_seat_can_work(c.id, seat.id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if c.status <> 'running' then
    raise exception 'this campaign is not running' using errcode = '22023';
  end if;
  -- Open campaigns: due follow-ups of callers who stopped working the campaign go back to the pool first.
  if c.open_to_all then perform public.release_stale_leads(c.id); end if;

  select l.id into lid from public.leads l
  where l.campaign_id = c.id and l.assigned_seat_id = seat.id and l.status = 'new' and not l.do_not_call
    and l.consent_call and public.seat_takes_centre(seat.id, l.centre_id)
    and not exists (select 1 from public.call_outcomes o where o.lead_id = l.id)
  order by l.updated_at, l.id
  limit 1;

  if lid is null then
    select l.id into lid from public.leads l
    where l.campaign_id = c.id and l.assigned_seat_id is null
      and l.status in ('new', 'callback', 'promised') and not l.do_not_call and l.consent_call
      and (l.next_call_at is null or l.next_call_at <= now())
      and (l.status <> 'promised' or l.promised_date is null or l.promised_date <= (now() at time zone 'Asia/Kolkata')::date)
      and public.seat_takes_centre(seat.id, l.centre_id)
    order by case when l.status = 'new' then 1 else 0 end, coalesce(l.next_call_at, l.created_at), l.created_at, l.id
    limit 1
    for update skip locked;
    if lid is null then return; end if;
    update public.leads l set assigned_seat_id = seat.id where l.id = lid;
  end if;

  return query
    select l.id, l.campaign_id, l.name, l.phone, l.extra, l.status, l.next_call_at, l.promised_date
    from public.leads l where l.id = lid;
end $$;

-- my_call_queue: as in 20261025180000; only the leads in the seat's centres.
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
               and public.seat_takes_centre(seat.id, l.centre_id)
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

-- my_campaigns: as in 20261026120000; lists of the seat's centres (or every centre), counts in its centres.
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
           (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = seat.id and public.seat_takes_centre(seat.id, l.centre_id)),
           (select count(*) from public.leads l
             where l.campaign_id = c.id and l.assigned_seat_id = seat.id and public.seat_takes_centre(seat.id, l.centre_id)
               and l.status in ('new', 'callback', 'promised') and not l.do_not_call
               and (l.next_call_at is null or l.next_call_at <= now())),
           (select count(*) from public.leads l
             where l.campaign_id = c.id and l.assigned_seat_id is null
               and l.status in ('new', 'callback', 'promised') and not l.do_not_call and l.consent_call
               and (l.next_call_at is null or l.next_call_at <= now())
               and (l.status <> 'promised' or l.promised_date is null or l.promised_date <= today)
               and public.seat_takes_centre(seat.id, l.centre_id)),
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
      and public.seat_takes_centre(seat.id, c.centre_id)
      and (c.open_to_all or exists (select 1 from public.campaign_members m
                                    where m.campaign_id = c.id and m.seat_id = seat.id))
    order by (seat.id = any (c.focus_seats)) desc, c.status, t.sort_order, t.label, c.class_label nulls last, c.board nulls last, c.name;
end $$;

-- =====================================================================================================
-- 2. Payments by managers who can see money
-- =====================================================================================================

-- Who may record a payment: owners and Accounts (can_manage_ledger), and managers who can see money.
create or replace function public.can_record_payment(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.can_manage_ledger(inst) or (public.is_admin_of(inst) and public.can_see_money(inst)) $$;

create or replace function public.ledger_payment_seat(p_institute uuid)
returns public.seats
language plpgsql stable security definer set search_path = public
as $$
declare seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.institute_id is distinct from p_institute or not public.can_record_payment(p_institute) then
    raise exception 'only accounts, an owner or a manager who can see money can record payments' using errcode = '42501';
  end if;
  return seat;
end $$;

-- accounts_record_payment: as in 20261025130000 (the student through ledger_student, so the centre check
-- stays), and a manager who can see money may record it too.
create or replace function public.accounts_record_payment(
  p_student uuid, p_amount numeric, p_paid_on date, p_mode text, p_reference text default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  st    public.students;
  seat  public.seats;
  md    text := lower(trim(coalesce(p_mode, '')));
  ref   text := nullif(trim(coalesce(p_reference, '')), '');
  nt    text := nullif(trim(coalesce(p_note, '')), '');
  today date;
  pid   uuid;
begin
  st := public.ledger_student(p_student, false);
  seat := public.ledger_payment_seat(st.institute_id);
  today := public.ledger_today(st.institute_id);
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'amount must be more than 0, in rupees and paise' using errcode = '22023';
  end if;
  if md not in ('upi', 'cash', 'cheque', 'card', 'bank', 'other') then
    raise exception 'mode must be upi, cash, cheque, card, bank or other' using errcode = '22023';
  end if;
  if coalesce(p_paid_on, today) > today then raise exception 'the payment date cannot be in the future' using errcode = '22023'; end if;
  if coalesce(p_paid_on, today) < date '2000-01-01' then raise exception 'check the payment date' using errcode = '22023'; end if;
  if ref is not null and length(ref) > 60 then raise exception 'reference must be up to 60 characters' using errcode = '22023'; end if;
  if nt is not null and length(nt) > 300 then raise exception 'note must be up to 300 characters' using errcode = '22023'; end if;
  if md in ('upi', 'bank', 'card') then
    if ref is null then raise exception 'give the transaction reference for a % payment', upper(md) using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended(st.institute_id::text || ':' || md || ':' || lower(ref), 0));
    if exists (select 1 from public.payments p
               where p.institute_id = st.institute_id and p.mode = md and lower(p.reference) = lower(ref)
                 and public.payment_is_live(p.id)) then
      raise exception 'this % reference is already recorded', upper(md) using errcode = '23505';
    end if;
  end if;
  insert into public.payments (institute_id, student_id, amount, paid_on, mode, reference, note, recorded_by)
    values (st.institute_id, st.id, p_amount, coalesce(p_paid_on, today), md, ref, nt, seat.id)
    returning id into pid;
  perform public.ledger_sync_student(st.id);
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (st.institute_id, auth.uid(), 'payment.recorded', pid::text || ':' || st.id::text);
  return pid;
end $$;

-- accounts_reverse_payment: as in 20261027100000 for owners and Accounts. A manager who can see money may
-- reverse only a payment they recorded themselves in the last 10 minutes (the Undo on Collect).
create or replace function public.accounts_reverse_payment(p_payment uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  p    public.payments;
  seat public.seats;
  why  text := trim(coalesce(p_reason, ''));
  rid  uuid;
begin
  select * into p from public.payments where id = p_payment;
  if p.id is null or not public.can_record_payment(p.institute_id) or not public.student_in_scope_rls(p.student_id) then
    raise exception 'payment not found' using errcode = '42501';
  end if;
  seat := public.ledger_payment_seat(p.institute_id);
  if not public.can_manage_ledger(p.institute_id)
     and (p.recorded_by is distinct from seat.id or p.created_at < now() - interval '10 minutes') then
    raise exception 'a manager can undo only their own payment, within 10 minutes; ask Accounts or the owner'
      using errcode = '42501';
  end if;
  if p.reverses_id is not null then raise exception 'a reversal cannot be reversed' using errcode = '22023'; end if;
  if exists (select 1 from public.payments r where r.reverses_id = p.id) then
    raise exception 'this payment is already reversed' using errcode = '22023';
  end if;
  if length(why) not between 1 and 300 then raise exception 'give a reason (up to 300 characters)' using errcode = '22023'; end if;
  insert into public.payments (institute_id, student_id, amount, paid_on, mode, note, recorded_by, reverses_id, opening)
    values (p.institute_id, p.student_id, p.amount, p.paid_on, p.mode, why, seat.id, p.id, p.opening)
    returning id into rid;
  perform public.ledger_sync_student(p.student_id);
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (p.institute_id, auth.uid(), 'payment.reversed', rid::text || ':' || p.id::text);
  return rid;
end $$;

-- collected_by_me: as in 20261027100000; can_collect is true for a manager who can see money too.
alter function public.collected_by_me() rename to collected_by_me__base;
revoke all on function public.collected_by_me__base() from public, anon, authenticated;
create function public.collected_by_me()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  out  jsonb := public.collected_by_me__base();
  inst uuid;
begin
  select s.institute_id into inst from public.seats s where s.id = (out ->> 'seat_id')::uuid;
  return out || jsonb_build_object('can_collect', public.can_record_payment(inst));
end $$;

-- =====================================================================================================
-- 3. "Call these N parents" from the Fees list
-- =====================================================================================================

-- The students with dues now that match the Fees list's filters (in the person's centres; centre_id and
-- batch_id through scope_push). Internal.
create or replace function public.fees_call_students(p_inst uuid, p_filters jsonb)
returns table (student_id uuid, name text, parent_name text, phone text, class_label text, section text, board text,
               admission_no text, bal numeric)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  f    jsonb := coalesce(p_filters, '{}'::jsonb);
  cls  text := nullif(trim(coalesce(f ->> 'class_label', '')), '');
  sec  text := nullif(trim(coalesce(f ->> 'section', '')), '');
  brd  text := nullif(trim(coalesce(f ->> 'board', '')), '');
  yr   text := nullif(trim(coalesce(f ->> 'academic_year', '')), '');
  fc   uuid;
  fb   uuid;
  prev text[];
begin
  begin
    fc := nullif(trim(coalesce(f ->> 'centre_id', '')), '')::uuid;
    fb := nullif(trim(coalesce(f ->> 'batch_id', '')), '')::uuid;
  exception when others then
    raise exception 'centre and batch must be ids' using errcode = '22023';
  end;
  if brd is not null then brd := public.campaign_check_tags(null, brd); end if;
  prev := public.scope_push(p_inst, fc, fb);
  return query
    select s.id, s.name, s.parent_name, s.phone, s.class_label, s.section, s.board, s.admission_no, b.balance_due_now
    from public.students s
    join public.student_balance_rows(p_inst) b on b.student_id = s.id
    where s.institute_id = p_inst and s.status = 'active' and b.balance_due_now > 0
      and (cls is null or lower(s.class_label) = lower(cls))
      and (sec is null or lower(s.section) = lower(sec))
      and (brd is null or s.board = brd)
      and (yr is null or s.academic_year = yr);
  perform public.scope_pop(prev);
end $$;

-- Who may make a fees list from the ledger (as accounts_create_fees_campaign). Returns the seat.
create or replace function public.fees_call_seat()
returns public.seats
language plpgsql stable security definer set search_path = public
as $$
declare seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if not (public.can_manage_ledger(seat.institute_id) or (public.is_admin_of(seat.institute_id) and public.can_see_money(seat.institute_id))) then
    raise exception 'only accounts, an owner or a manager who can see money can make a fees calling list'
      using errcode = '42501';
  end if;
  return seat;
end $$;

-- What "Call these N parents" will do: { parents (one call per phone), students, no_phone, amount (with money
-- access), name ('Fees · Class 8-A · Morning · 27 Oct'), script_id, script_name, callers [{ seat_id, label }] }.
-- The script is the fees script Autopilot would pick; the callers are its top two for fees calls (in the
-- list's centre).
create or replace function public.fees_call_plan(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  inst  uuid;
  f     jsonb := coalesce(p_filters, '{}'::jsonb);
  cen   uuid;
  bat   uuid;
  n_par int;
  n_st  int;
  n_nop int;
  amt   numeric;
  scr   record;
  cl    jsonb;
  nm    text;
  today date;
begin
  seat := public.fees_call_seat();
  inst := seat.institute_id;
  today := public.ledger_today(inst);
  select count(distinct d.phone), count(*), count(*) filter (where d.phone is null), sum(d.bal)
    into n_par, n_st, n_nop, amt
    from public.fees_call_students(inst, f) d;
  begin
    cen := nullif(f ->> 'centre_id', '')::uuid;
    bat := nullif(f ->> 'batch_id', '')::uuid;
  exception when others then cen := null; bat := null;
  end;
  if cen is null and bat is not null then select b.centre_id into cen from public.batches b where b.id = bat; end if;
  select * into scr from public.ap_pick_script(inst, 'fees', 'reminder');
  select coalesce(jsonb_agg(jsonb_build_object('seat_id', s.id, 'label', s.label) order by x.ord), '[]'::jsonb) into cl
    from jsonb_array_elements_text(public.ap_plan_callers(inst, 'fees', 4) -> 'picked') with ordinality as x(id, ord)
    join public.seats s on s.id = x.id::uuid
   where public.seat_takes_centre(s.id, cen);
  cl := coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(cl) e limit 2) z), '[]'::jsonb);
  nm := left(concat_ws(' · ', 'Fees',
          nullif(concat_ws('-', public.ap_class_text(nullif(f ->> 'class_label', ''), null), nullif(f ->> 'section', '')), ''),
          (select b.name from public.batches b where b.id = bat),
          case when bat is null then (select c.name from public.centres c where c.id = cen) end,
          to_char(today, 'FMDD Mon')), 120);
  return jsonb_build_object('parents', coalesce(n_par, 0), 'students', coalesce(n_st, 0), 'no_phone', coalesce(n_nop, 0),
    'amount', case when public.can_see_money(inst) then coalesce(amt, 0) end, 'name', nm,
    'script_id', scr.id, 'script_name', scr.name, 'callers', cl);
end $$;

-- Makes and starts the list: one call per parent's phone (the student with the most due when siblings share
-- it), open to every caller, the plan's callers first (focus), centre and batch from the filters. Audit as
-- accounts_create_fees_campaign. Returns { campaign_id, leads, name, text }.
create or replace function public.fees_call_start(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  inst  uuid;
  f     jsonb := coalesce(p_filters, '{}'::jsonb);
  plan  jsonb;
  typ   uuid;
  cid   uuid;
  cen   uuid;
  bat   uuid;
  cls   text := nullif(trim(coalesce(f ->> 'class_label', '')), '');
  brd   text := nullif(trim(coalesce(f ->> 'board', '')), '');
  n     int;
  focus uuid[];
begin
  seat := public.fees_call_seat();
  inst := seat.institute_id;
  plan := public.fees_call_plan(f);
  if (plan ->> 'parents')::int = 0 then raise exception 'nobody with dues and a phone in this list' using errcode = '22023'; end if;
  begin
    cen := nullif(f ->> 'centre_id', '')::uuid;
    bat := nullif(f ->> 'batch_id', '')::uuid;
  exception when others then raise exception 'centre and batch must be ids' using errcode = '22023';
  end;
  if cen is null and bat is not null then select b.centre_id into cen from public.batches b where b.id = bat; end if;
  if cen is null and cardinality(public.my_centre_ids(inst)) = 1 then cen := (public.my_centre_ids(inst))[1]; end if;
  brd := public.campaign_check_tags(cls, brd);
  select t.id into typ from public.call_types t where t.key = 'fees' and t.institute_id is null;
  select coalesce(array_agg((e ->> 'seat_id')::uuid), '{}') into focus from jsonb_array_elements(plan -> 'callers') e;
  insert into public.campaigns (institute_id, name, call_type_id, script_id, share_mode, status, created_by, open_to_all,
                                class_label, board, focus_seats, centre_id, batch_id, start_date)
    values (inst, plan ->> 'name', typ, nullif(plan ->> 'script_id', '')::uuid, 'next_free', 'draft', seat.id, true,
            cls, brd, focus, cen, bat, public.ledger_today(inst))
    returning id into cid;
  with d as (select * from public.fees_call_students(inst, f) x where x.phone is not null),
  firsts as (select distinct on (d.phone) d.* from d order by d.phone, d.bal desc, d.name, d.student_id),
  ins as (
    insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, student_id, created_at)
    select inst, cid, coalesce(x.parent_name, x.name), x.phone,
           jsonb_strip_nulls(jsonb_build_object('student', x.name, 'class', x.class_label, 'section', x.section,
                                                'board', x.board, 'admission_no', x.admission_no)),
           x.bal, x.student_id,
           now() + (row_number() over (order by x.class_label nulls last, x.section nulls last, x.name, x.student_id)
                    * interval '1 microsecond')
    from firsts x returning 1)
  select count(*) into n from ins;
  update public.campaigns set status = 'running' where id = cid;
  insert into public.audit_log (institute_id, actor_id, action, target) values
    (inst, auth.uid(), 'campaign.created', cid::text),
    (inst, auth.uid(), 'leads.added', cid::text || ':' || n),
    (inst, auth.uid(), 'campaign.running', cid::text),
    (inst, auth.uid(), 'fees_campaign.from_ledger', cid::text || ':' || n || ':' || (plan ->> 'no_phone') || ':' ||
                                                    ((plan ->> 'students')::int - (plan ->> 'no_phone')::int - n));
  return jsonb_build_object('campaign_id', cid, 'leads', n, 'name', plan ->> 'name',
    'text', '"' || (plan ->> 'name') || '" started: ' || n || case when n = 1 then ' parent' else ' parents' end || ' to call.');
end $$;

-- =====================================================================================================
-- 4. Away today (Team), with Undo
-- =====================================================================================================

-- As admin_release_leads(seat) (every list that is not closed), returning the ids for Undo:
-- { released, lead_ids }. Owner or manager. Audit lead.released <lead>:<seat>:away.
create or replace function public.admin_away_today(p_seat uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  inst uuid;
  ids  jsonb;
  n    int;
begin
  select s.institute_id into inst from public.seats s where s.id = p_seat;
  if inst is null or not public.is_admin_of(inst) then raise exception 'caller not found' using errcode = '42501'; end if;
  with upd as (
    update public.leads l set assigned_seat_id = null
    from public.campaigns k
    where k.id = l.campaign_id and l.institute_id = inst and l.assigned_seat_id = p_seat and k.status <> 'closed'
      and public.lead_is_open(l.status, l.do_not_call)
    returning l.id
  ), logged as (
    insert into public.audit_log (institute_id, actor_id, action, target)
      select inst, auth.uid(), 'lead.released', u.id::text || ':' || p_seat::text || ':away' from upd u
    returning target
  )
  select coalesce(jsonb_agg(split_part(target, ':', 1)), '[]'::jsonb), count(*) into ids, n from logged;
  return jsonb_build_object('released', n, 'lead_ids', ids);
end $$;

-- Undo of "Away today": the leads still in the pool (open, not taken by someone else) go back to the seat, when
-- it may still work them. Returns how many came back. Audit lead.returned <lead>:<seat>.
create or replace function public.admin_undo_away(p_seat uuid, p_leads uuid[])
returns int
language plpgsql security definer set search_path = public
as $$
declare
  inst uuid;
  n    int;
begin
  select s.institute_id into inst from public.seats s where s.id = p_seat;
  if inst is null or not public.is_admin_of(inst) then raise exception 'caller not found' using errcode = '42501'; end if;
  if cardinality(p_leads) > 5000 then raise exception 'too many leads' using errcode = '22023'; end if;
  with upd as (
    update public.leads l set assigned_seat_id = p_seat
    from public.campaigns k
    where l.id = any (coalesce(p_leads, '{}')) and k.id = l.campaign_id and l.institute_id = inst and k.status <> 'closed'
      and l.assigned_seat_id is null and public.lead_is_open(l.status, l.do_not_call)
      and public.campaign_seat_can_work(l.campaign_id, p_seat) and public.seat_takes_centre(p_seat, l.centre_id)
    returning l.id
  ), logged as (
    insert into public.audit_log (institute_id, actor_id, action, target)
      select inst, auth.uid(), 'lead.returned', u.id::text || ':' || p_seat::text from upd u
    returning 1
  )
  select count(*) into n from logged;
  return n;
end $$;

-- =====================================================================================================
-- Grants
-- =====================================================================================================

revoke all on function public.seat_takes_centre(uuid, uuid) from public, anon, authenticated;
revoke all on function public.campaign_seat_can_work(uuid, uuid) from public, anon, authenticated;
revoke all on function public.campaign_fix_centres(uuid, boolean) from public, anon, authenticated;
revoke all on function public.campaign_share_equal(uuid) from public, anon, authenticated;
revoke all on function public.campaign_share_next_free(uuid) from public, anon, authenticated;
revoke all on function public.fees_call_students(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fees_call_seat() from public, anon, authenticated;
revoke all on function public.ledger_payment_seat(uuid) from public, anon, authenticated;
revoke all on function public.can_record_payment(uuid) from public, anon;
revoke all on function public.admin_set_seat_centres(uuid, uuid[]) from public, anon;
revoke all on function public.next_free_lead(uuid) from public, anon;
revoke all on function public.my_call_queue(uuid) from public, anon;
revoke all on function public.my_campaigns() from public, anon;
revoke all on function public.accounts_record_payment(uuid, numeric, date, text, text, text) from public, anon;
revoke all on function public.accounts_reverse_payment(uuid, text) from public, anon;
revoke all on function public.collected_by_me() from public, anon;
revoke all on function public.fees_call_plan(jsonb) from public, anon;
revoke all on function public.fees_call_start(jsonb) from public, anon;
revoke all on function public.admin_away_today(uuid) from public, anon;
revoke all on function public.admin_undo_away(uuid, uuid[]) from public, anon;
grant execute on function public.can_record_payment(uuid) to authenticated;
grant execute on function public.admin_set_seat_centres(uuid, uuid[]) to authenticated;
grant execute on function public.next_free_lead(uuid) to authenticated;
grant execute on function public.my_call_queue(uuid) to authenticated;
grant execute on function public.my_campaigns() to authenticated;
grant execute on function public.accounts_record_payment(uuid, numeric, date, text, text, text) to authenticated;
grant execute on function public.accounts_reverse_payment(uuid, text) to authenticated;
grant execute on function public.collected_by_me() to authenticated;
grant execute on function public.fees_call_plan(jsonb) to authenticated;
grant execute on function public.fees_call_start(jsonb) to authenticated;
grant execute on function public.admin_away_today(uuid) to authenticated;
grant execute on function public.admin_undo_away(uuid, uuid[]) to authenticated;
