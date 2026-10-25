-- Presence: what the caller is doing on the call, from the paired phone. Apply after 20261025180000.
--
-- Until now the caller screen said only "a call is going on" (on_call), which was true from the moment Dial was
-- pressed or the first answer tapped until the result was saved, so Home showed "On a call" while the caller was
-- typing notes after hanging up. Now the screen says which part of the call it is in:
--   dialling      the paired phone is ringing the lead (phase REQUESTED)
--   connected     the paired phone's line is in use (phase OFFHOOK)
--   wrapup        the phone has hung up and the caller is saving the result
--   unconfirmed   no phone is paired (or it has not reported a call) and only the page says a call is going on
--   none          no call
-- and when the call started (call_started_at, the page's clock, kept within the last 12 hours).
--
-- Adds to seat_presence: call_state, call_started_at, state_at (when call_state last changed, the server's clock).
-- report_presence() takes two more optional arguments; the old two-argument call (older caller pages) still works
-- and is read as 'unconfirmed' when p_on_call is true.
-- home_seat_status() (same signature, so admin_home_summary and admin_callers are unchanged) returns, besides
-- phone_offline / ready / idle / not_started:
--   {status: 'on_call', call_state: 'dialling'|'connected'|'unconfirmed', confirmed, since, seconds}
--   {status: 'wrapup', since, seconds}   for at most 10 minutes after the phone went idle; then the normal rules.
-- seconds: whole seconds from since to now (Home ticks it on locally between refreshes).

-- ---------- columns ----------

alter table public.seat_presence
  add column if not exists call_state text not null default 'none'
    check (call_state in ('none', 'dialling', 'connected', 'wrapup', 'unconfirmed')),
  add column if not exists call_started_at timestamptz,
  add column if not exists state_at timestamptz;

-- Rows written by the old report_presence: a call going on was all it knew.
update public.seat_presence
   set call_state = case when on_call then 'unconfirmed' else 'none' end,
       state_at = coalesce(state_at, seen_at)
 where state_at is null;

-- ---------- report_presence ----------

-- Called by the caller screen (any active seat) about once a minute, at every phone call-phase change (dial,
-- connect, hang up) and when a result is saved.
-- p_on_call: a call is going on now (kept for older pages). p_phone_ok: the paired phone answers.
-- p_call_state: one of the states above; null (older pages) = 'unconfirmed' when p_on_call, else 'none'.
-- p_call_started_at: when the call started on the page's clock; ignored for 'none'.
drop function if exists public.report_presence(boolean, boolean);
create or replace function public.report_presence(
  p_on_call boolean default false,
  p_phone_ok boolean default true,
  p_call_state text default null,
  p_call_started_at timestamptz default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat     public.seats;
  ok       boolean := coalesce(p_phone_ok, true);
  st       text := coalesce(p_call_state, case when coalesce(p_on_call, false) then 'unconfirmed' else 'none' end);
  live     boolean;
  started  timestamptz;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if st not in ('none', 'dialling', 'connected', 'wrapup', 'unconfirmed') then
    raise exception 'call state must be none, dialling, connected, wrapup or unconfirmed' using errcode = '22023';
  end if;
  live := st in ('dialling', 'connected', 'unconfirmed');
  -- The page's clock may be off: a start in the future is now, one more than 12 hours ago is not believed.
  started := case
    when st = 'none' or p_call_started_at is null then null
    when p_call_started_at > now() then now()
    when p_call_started_at < now() - interval '12 hours' then null
    else p_call_started_at end;
  insert into public.seat_presence as p (seat_id, institute_id, seen_at, online_since, on_call, phone_ok, phone_offline_since,
                                         call_state, call_started_at, state_at)
    values (seat.id, seat.institute_id, now(), now(), live, ok, case when ok then null else now() end,
            st, case when live then coalesce(started, now()) when st = 'wrapup' then started end, now())
  on conflict (seat_id) do update set
    institute_id = excluded.institute_id,
    online_since = case when p.seen_at < now() - interval '3 minutes' then now() else p.online_since end,
    seen_at = now(),
    on_call = excluded.on_call,
    phone_ok = excluded.phone_ok,
    phone_offline_since = case
      when excluded.phone_ok then null
      when p.phone_ok or p.phone_offline_since is null or p.seen_at < now() - interval '3 minutes' then now()
      else p.phone_offline_since end,
    call_state = excluded.call_state,
    -- A start the page did not send keeps the one already known for the same call.
    call_started_at = case
      when excluded.call_state = 'none' then null
      when started is not null then started
      when p.call_state <> 'none' and p.seen_at >= now() - interval '3 minutes' and p.call_started_at is not null then p.call_started_at
      when live then now()
      else null end,
    -- The moment the state changed (wrap-up time counts from it); a gap of more than 3 minutes starts again.
    state_at = case
      when p.call_state is distinct from excluded.call_state or p.state_at is null
        or p.seen_at < now() - interval '3 minutes' then now()
      else p.state_at end;
end $$;

-- ---------- home_seat_status ----------

-- What a seat is doing now, for Home and Callers (admin_home_summary, admin_callers):
--   phone_offline  the screen is open (seen in the last 3 min) and the phone does not answer
--   on_call        the screen is open and a call is going on: call_state dialling or connected (confirmed by the
--                  paired phone), or unconfirmed (only the page says so). since: when the call started.
--   wrapup         the phone hung up less than 10 minutes ago and the result is not saved yet. since: hang-up.
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
  since      timestamptz;
  st         text;
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
  st := coalesce(p.call_state, case when p.on_call then 'unconfirmed' else 'none' end);
  if recent and st in ('dialling', 'connected', 'unconfirmed') then
    since := coalesce(p.call_started_at, p.state_at, last_call);
    return jsonb_build_object('status', 'on_call', 'call_state', st, 'confirmed', st <> 'unconfirmed', 'since', since,
      'seconds', case when since is not null then greatest(0, floor(extract(epoch from now() - since))::int) end);
  end if;
  if recent and st = 'wrapup' and coalesce(p.state_at, p.seen_at) >= now() - interval '10 minutes' then
    since := coalesce(p.state_at, p.seen_at);
    return jsonb_build_object('status', 'wrapup', 'call_state', st, 'since', since,
      'seconds', greatest(0, floor(extract(epoch from now() - since))::int));
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

-- ---------- grants ----------

revoke all on function public.home_seat_status(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.report_presence(boolean, boolean, text, timestamptz) from public, anon;
grant execute on function public.report_presence(boolean, boolean, text, timestamptz) to authenticated;
