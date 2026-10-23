-- Vector 2.0 Phase A, Sprint 8 (caller side): the caller screen of a campaign. Apply after 20261024100014.
--
-- 1. lead_money(): a caller sees the money of the one lead on their call even when the institute hides money
--    ("Hide money everywhere" hides amounts in admin screens, reports and exports; a caller cannot run a fees
--    call without the amount due). Admins still follow can_see_money(), which applies hide_money.
-- 2. call_outcomes.note: the caller's note on the call ("Will pay by UPI after salary"). Shown to the next
--    caller of the lead as "last call". Never bank, card or UPI details (rule 7 of docs/data-contract.md).
-- 3. my_call_queue(campaign): the caller's waiting leads of one campaign with the last call of each, and
--    today's calls against the campaign's daily target. No money.
-- 4. save_call_result(...): saves one campaign call atomically: the call_outcomes row and the lead's next
--    state (status, next call, promise, do not call, WhatsApp consent). The same seat and client_record_id
--    are saved once, so an offline result that is sent twice is stored once.

-- ---------- 1. lead money for the caller on the call ----------

create or replace function public.lead_money(p_lead uuid)
returns table (lead_id uuid, amount_due numeric, promised_amount numeric, promised_date date, money_hidden boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  l       public.leads;
  mine    boolean;
  allowed boolean;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then raise exception 'lead not found' using errcode = '42501'; end if;
  mine := exists (select 1 from public.seats s
                  where s.id = l.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active');
  if not mine and not public.is_admin_of(l.institute_id) then
    raise exception 'lead not found' using errcode = '42501';
  end if;
  -- The caller of the lead sees its money even when the institute hides money (Phase A decision, 24 Oct).
  allowed := mine or public.can_see_money(l.institute_id);
  return query select l.id,
                      case when allowed then l.amount_due end,
                      case when allowed then l.promised_amount end,
                      l.promised_date,
                      not allowed;
end $$;

-- ---------- 2. the caller's note on a call ----------

alter table public.call_outcomes
  add column if not exists note text check (note is null or length(note) <= 300);
grant select (note) on public.call_outcomes to authenticated;

-- ---------- 3. the caller's queue for one campaign ----------

-- Start of today in India, for "calls today".
create or replace function public.india_day_start()
returns timestamptz
language sql stable
set search_path = public
as $$
  select date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
$$;

-- The active seat's waiting leads in one running or paused campaign it is on: leads assigned to the seat that
-- are new, a call back or a promise, not "do not call", and that the institute may call. Due leads first
-- (earliest first), then new leads, then leads due later today or after. Each lead carries its last call
-- (by any caller: the lead may have moved). Also today's calls of the seat and of the whole campaign, and the
-- daily target. No money: the lead card reads it with lead_money().
-- Returns jsonb: { campaign_id, status, share_mode, daily_target, my_calls_today, team_calls_today,
--   leads: [{ id, name, phone, extra, status, next_call_at, promised_date, consent_whatsapp, created_at,
--             calls, last_called_at, last_result_key, last_note }] }
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
    join public.campaign_members m on m.campaign_id = x.id and m.seat_id = seat.id
   where x.id = p_campaign and x.status in ('running', 'paused');
  if c.id is null then raise exception 'campaign not found' using errcode = '42501'; end if;

  select jsonb_build_object(
    'campaign_id', c.id, 'status', c.status, 'share_mode', c.share_mode, 'daily_target', c.daily_target,
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
               'consent_whatsapp', l.consent_whatsapp, 'created_at', l.created_at,
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

-- ---------- 4. saving a campaign call ----------

-- One campaign call, saved in one transaction: the call_outcomes row (checked by call_outcomes_check: the
-- result must belong to the campaign's call type and have the date, amount, reason or rating it needs) and
-- the lead's next state:
--   do_not_call                 -> do_not_call (status follows)
--   wrong_number                -> status wrong_number
--   no_answer / busy            -> try again in 2 hours / 30 minutes (a new lead becomes a call back)
--   a result with a date and ₹  -> status promised, promised_date and promised_amount, call on that date
--   a result with a date        -> status callback on that date (p_next_call_at when given, else 10:00 India)
--   a "call back" result        -> status callback in 2 days (e.g. Will think)
--   anything else               -> status done
-- p_consent_whatsapp (when not null) records what the lead said about WhatsApp messages.
-- The lead is changed only while it is still assigned to the seat, is not "do not call" (only an admin can
-- undo that) and no later call of the lead is saved; the call itself is always kept. A caller may save a
-- call for a lead that moved to another caller while the phone was offline, if the seat is still on that
-- campaign. The same seat and p_client_record_id are saved once: a repeat returns the first row's id.
-- Returns jsonb { outcome_id, duplicate, lead_updated, lead_status, next_call_at }.
create or replace function public.save_call_result(
  p_client_record_id text, p_lead uuid, p_result_key text,
  p_promised_date date default null, p_amount numeric default null, p_reason text default null,
  p_rating int default null, p_note text default null,
  p_step_times jsonb default null, p_reached_step text default null, p_script_step text default null,
  p_script_id text default null, p_script_version int default null,
  p_dialled_at timestamptz default null, p_connected_seconds int default null, p_phone_session_id text default null,
  p_next_call_at timestamptz default null, p_consent_whatsapp boolean default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat   public.seats;
  l      public.leads;
  c      public.campaigns;
  r      public.call_type_results;
  oid    uuid;
  at     timestamptz := coalesce(p_dialled_at, now());
  st     text;
  nxt    timestamptz;
  pdate  date;
  pamt   numeric;
  upd    boolean := false;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if coalesce(trim(p_client_record_id), '') = '' or length(p_client_record_id) > 80 then
    raise exception 'record id must be 1 to 80 characters' using errcode = '22023';
  end if;

  -- Sent before (an offline retry): nothing more to do.
  select o.id into oid from public.call_outcomes o
   where o.seat_id = seat.id and o.client_record_id = p_client_record_id;
  if oid is not null then
    return jsonb_build_object('outcome_id', oid, 'duplicate', true, 'lead_updated', false);
  end if;

  select * into l from public.leads where id = p_lead;
  if l.id is null or l.institute_id <> seat.institute_id
     or (l.assigned_seat_id is distinct from seat.id
         and not exists (select 1 from public.campaign_members m
                          where m.campaign_id = l.campaign_id and m.seat_id = seat.id)) then
    raise exception 'lead not found' using errcode = '42501';
  end if;
  select * into c from public.campaigns where id = l.campaign_id;
  if c.status = 'draft' then raise exception 'lead not found' using errcode = '42501'; end if;
  if p_rating is not null and p_rating not between 1 and 5 then
    raise exception 'rating must be 1 to 5' using errcode = '22023';
  end if;
  if p_amount is not null and p_amount < 0 then
    raise exception 'amount must be 0 or more' using errcode = '22023';
  end if;

  select * into r from public.call_type_results_for(c.call_type_id, c.institute_id) x
   where x.key = p_result_key limit 1;
  -- An unknown result is refused by call_outcomes_check below with its own message.

  insert into public.call_outcomes (
      institute_id, seat_id, client_record_id, script_id, script_version, script_step, dialled_at,
      connected_seconds, phone_session_id, campaign_id, lead_id, result_key, promised_date, amount,
      result_reason, rating, step_times, reached_step, note)
    values (
      seat.institute_id, seat.id, p_client_record_id, nullif(left(p_script_id, 80), ''), p_script_version,
      nullif(left(p_script_step, 80), ''), at, p_connected_seconds, nullif(left(p_phone_session_id, 80), ''),
      l.campaign_id, l.id, p_result_key,
      case when r.needs_date then p_promised_date end,
      case when r.needs_amount then p_amount end,
      nullif(trim(p_reason), ''),
      case when r.needs_rating then p_rating end,
      p_step_times, nullif(left(p_reached_step, 80), ''), nullif(trim(p_note), ''))
    returning id into oid;

  -- The lead's next state, only while it is still this caller's and this is its latest call.
  if l.assigned_seat_id = seat.id and not l.do_not_call
     and not exists (select 1 from public.call_outcomes o
                      where o.lead_id = l.id and o.id <> oid and coalesce(o.dialled_at, o.uploaded_at) > at) then
    st := l.status; nxt := l.next_call_at; pdate := l.promised_date; pamt := l.promised_amount;
    if p_result_key = 'do_not_call' then
      st := 'do_not_call'; nxt := null;
    elsif p_result_key = 'wrong_number' then
      st := 'wrong_number'; nxt := null;
    elsif p_result_key in ('no_answer', 'busy') then
      if st = 'new' then st := 'callback'; end if;
      nxt := now() + case when p_result_key = 'busy' then interval '30 minutes' else interval '2 hours' end;
    elsif r.needs_date and p_promised_date is not null then
      nxt := coalesce(p_next_call_at, (p_promised_date + time '10:00') at time zone 'Asia/Kolkata');
      if r.needs_amount then st := 'promised'; pdate := p_promised_date; pamt := p_amount;
      else st := 'callback'; end if;
    elsif r.legacy_outcome = 'callback' then
      st := 'callback'; nxt := now() + interval '2 days';
    else
      st := 'done'; nxt := null;
    end if;
    update public.leads
       set status = st, next_call_at = nxt, promised_date = pdate, promised_amount = pamt,
           do_not_call = (p_result_key = 'do_not_call'),
           consent_whatsapp = coalesce(p_consent_whatsapp, consent_whatsapp)
     where id = l.id;
    upd := true;
  end if;

  return jsonb_build_object('outcome_id', oid, 'duplicate', false, 'lead_updated', upd,
                            'lead_status', case when upd then st end, 'next_call_at', case when upd then nxt end);
end $$;

-- ---------- grants ----------

revoke all on function public.india_day_start() from public, anon;
revoke all on function public.my_call_queue(uuid) from public, anon;
revoke all on function public.save_call_result(text, uuid, text, date, numeric, text, int, text, jsonb, text, text,
  text, int, timestamptz, int, text, timestamptz, boolean) from public, anon;
grant execute on function public.india_day_start() to authenticated;
grant execute on function public.my_call_queue(uuid) to authenticated;
grant execute on function public.save_call_result(text, uuid, text, date, numeric, text, int, text, jsonb, text, text,
  text, int, timestamptz, int, text, timestamptz, boolean) to authenticated;
