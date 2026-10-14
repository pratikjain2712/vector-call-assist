-- Coaching suggestions and a team leaderboard. Apply after 0011.
-- Coaching compares each rep with the whole team over a date range, using data already recorded on every
-- call (outcome, connected time, the stage reached, the objection and the loss reason). Where a rep is
-- clearly behind, the admin sees a suggestion and can send it to the rep as a tip. Each tip keeps the
-- rep's figure at the time it was sent, so the admin can see later whether it improved.
-- The leaderboard ranks active reps by calls, connected calls, won calls and talk time. Reps see it too,
-- unless an admin turns that off for the institute.
-- Nothing here reads or returns lead names or numbers: none are stored in the database.

-- ---------- tables ----------

alter table public.institutes
  add column if not exists leaderboard_for_reps boolean not null default true;

-- A tip an admin sent to a rep. Only the functions below read or write it: RLS is on with no policies.
create table if not exists public.coaching_tips (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  seat_id       uuid not null references public.seats (id) on delete cascade,
  tip_key       text not null check (length(tip_key) between 1 and 120),
  better        text not null check (better in ('lower', 'higher')),
  rep_text      text not null check (length(rep_text) between 1 and 400),
  admin_note    text check (length(admin_note) <= 300),
  baseline      numeric not null,
  team_baseline numeric,
  sent_by       uuid not null default auth.uid(),
  sent_at       timestamptz not null default now(),
  seen_at       timestamptz
);
create index if not exists coaching_tips_seat_time on public.coaching_tips (seat_id, sent_at desc);
create index if not exists coaching_tips_institute_time on public.coaching_tips (institute_id, sent_at desc);
alter table public.coaching_tips enable row level security;

-- ---------- internal helpers (granted to nobody) ----------

-- Effective calls in a range with the stage, objection and loss reason of the original call.
-- p_seat null means the whole team: every rep seat in the institute.
create or replace function public.coach_calls(
  p_institute uuid, p_seat uuid, p_from timestamptz, p_to timestamptz)
returns table (outcome text, connected_seconds int, stage_reached text, objection text, loss_reason text)
language sql stable security definer set search_path = public
as $$
  select e.outcome, e.connected_seconds, r.stage_reached, r.objection, r.loss_reason
  from public.admin_effective_outcomes(p_institute, p_from, p_to) e
  join public.call_outcomes r on r.id = e.root_id
  join public.seats s on s.id = r.seat_id
  where (p_seat is null and s.role = 'rep') or r.seat_id = p_seat;
$$;

-- Which way is better for a coaching key: connect rate should go up, everything else down.
create or replace function public.coach_better(p_key text)
returns text
language sql immutable
as $$ select case when p_key = 'connect' then 'higher' else 'lower' end; $$;

-- One coaching figure for a rep (or the team) over a range, with the number of calls it is based on.
--   connect          connected calls per 100 calls
--   stage:<stage>    calls lost at that stage per 100 calls
--   objection:<text> lost calls with that objection per 100 calls
--   reason_missing   lost calls with no loss reason per 100 lost calls (based on lost calls)
create or replace function public.coach_metric(
  p_institute uuid, p_seat uuid, p_key text, p_from timestamptz, p_to timestamptz)
returns table (value numeric, base bigint, hits bigint)
language plpgsql stable security definer set search_path = public
as $$
declare
  n bigint := 0;
  h bigint := 0;
begin
  if p_key = 'connect' then
    select count(*), count(*) filter (where c.connected_seconds > 0) into n, h
      from public.coach_calls(p_institute, p_seat, p_from, p_to) c;
  elsif p_key = 'reason_missing' then
    select count(*), count(*) filter (where c.loss_reason is null) into n, h
      from public.coach_calls(p_institute, p_seat, p_from, p_to) c
      where c.outcome = 'not_interested';
  elsif p_key like 'stage:_%' then
    select count(*), count(*) filter (where c.outcome = 'not_interested' and c.stage_reached = substr(p_key, 7)) into n, h
      from public.coach_calls(p_institute, p_seat, p_from, p_to) c;
  elsif p_key like 'objection:_%' then
    select count(*), count(*) filter (where c.outcome = 'not_interested' and c.objection = substr(p_key, 11)) into n, h
      from public.coach_calls(p_institute, p_seat, p_from, p_to) c;
  else
    raise exception 'unknown coaching key' using errcode = '22023';
  end if;
  return query select case when n > 0 then round(100.0 * h / n, 1) end, n, h;
end $$;

-- The text for a tip. p_who is the rep's label for the admin's version, or null for the rep's own ("you").
create or replace function public.coach_text(p_key text, p_who text, p_rep numeric, p_team numeric)
returns text
language plpgsql immutable
as $$
declare
  r text := round(coalesce(p_rep, 0))::text;
  t text := round(coalesce(p_team, 0))::text;
  you boolean := p_who is null;
begin
  if p_key = 'connect' then
    return case when you then 'You connect ' || r || '% of your calls; the team connects ' || t ||
                              '%. Try calling at other times of day, and check the numbers on your list.'
                else p_who || ' connects ' || r || '% of calls; the team connects ' || t ||
                     '%. Check their calling times and the quality of the numbers on their list.' end;
  elsif p_key = 'reason_missing' then
    r := round(100 - coalesce(p_rep, 0))::text;
    t := round(100 - coalesce(p_team, 0))::text;
    return case when you then 'You pick a loss reason on ' || r || '% of lost calls; the team does on ' || t ||
                              '%. Tap a reason after every lost call, so the script can be fixed.'
                else p_who || ' picks a loss reason on only ' || r || '% of lost calls; the team does on ' || t ||
                     '%. Ask them to tap a reason after every lost call.' end;
  elsif p_key like 'stage:%' then
    return case when you then 'You lose ' || r || ' of every 100 calls at the ' || substr(p_key, 7) ||
                              ' step; the team loses ' || t || '. Practise the ' || substr(p_key, 7) || ' lines.'
                else p_who || ' loses ' || r || ' of every 100 calls at the ' || substr(p_key, 7) ||
                     ' step; the team loses ' || t || '. Practise the ' || substr(p_key, 7) || ' lines together.' end;
  else
    return case when you then '"' || substr(p_key, 11) || '" ends ' || r || ' of every 100 of your calls; for the team it is ' ||
                              t || '. Go over the script''s answer to it.'
                else '"' || substr(p_key, 11) || '" ends ' || r || ' of every 100 of ' || p_who ||
                     '''s calls; for the team it is ' || t || '. Go over the script''s answer to it with them.' end;
  end if;
end $$;

-- Does a rep's figure differ enough from the team's to suggest coaching? Returns the gap (bigger is worse),
-- or null when it does not qualify. Each rule needs enough calls to be fair to the rep.
create or replace function public.coach_gap(
  p_key text, p_rep numeric, p_base bigint, p_hits bigint, p_team numeric)
returns numeric
language plpgsql immutable
as $$
begin
  if p_rep is null or p_team is null then return null; end if;
  if p_key = 'connect' then
    if p_base >= 20 and p_team - p_rep >= 15 then return p_team - p_rep; end if;
  elsif p_key = 'reason_missing' then
    if p_base >= 5 and p_rep >= 50 and p_rep - p_team >= 20 then return p_rep - p_team; end if;
  else
    -- stage or objection: at least 15 calls, 3 lost this way, 1.5 times the team rate and 5 points more.
    if p_base >= 15 and p_hits >= 3 and p_rep >= 1.5 * p_team and p_rep - p_team >= 5 then return p_rep - p_team; end if;
  end if;
  return null;
end $$;

-- ---------- coaching (admin only) ----------

-- Suggestions for every active rep in the range: at most two per rep, the biggest gaps first.
-- Each item: seat_id, label, key, text, rep_value, team_value, calls, better, and sent_at when the same
-- tip went to this rep in the last 7 days.
create or replace function public.admin_coaching_suggestions(
  p_institute uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  rep   record;
  k     text;
  m     record;
  tm    record;
  gap   numeric;
  cands jsonb;
  acc   jsonb := '[]'::jsonb;
  item  jsonb;
  sent  timestamptz;
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_range(p_from, p_to);

  for rep in select s.id, s.label from public.seats s
             where s.institute_id = p_institute and s.role = 'rep' and s.status = 'active'
             order by s.label loop
    cands := '[]'::jsonb;
    for k in
      select 'connect' union all select 'reason_missing'
      union all
      select distinct 'stage:' || c.stage_reached from public.coach_calls(p_institute, rep.id, p_from, p_to) c
        where c.outcome = 'not_interested' and c.stage_reached is not null
      union all
      select distinct 'objection:' || c.objection from public.coach_calls(p_institute, rep.id, p_from, p_to) c
        where c.outcome = 'not_interested' and c.objection is not null
    loop
      select * into m from public.coach_metric(p_institute, rep.id, k, p_from, p_to);
      select * into tm from public.coach_metric(p_institute, null, k, p_from, p_to);
      gap := public.coach_gap(k, m.value, m.base, m.hits, tm.value);
      if gap is not null then
        select max(t.sent_at) into sent from public.coaching_tips t
          where t.seat_id = rep.id and t.tip_key = k and t.sent_at > now() - interval '7 days';
        cands := cands || jsonb_build_object(
          'seat_id', rep.id, 'label', rep.label, 'key', k,
          'text', public.coach_text(k, rep.label, m.value, tm.value),
          'rep_value', m.value, 'team_value', tm.value, 'calls', m.base,
          'better', public.coach_better(k), 'gap', gap, 'sent_at', sent);
      end if;
    end loop;
    for item in select x from jsonb_array_elements(cands) x
                order by (x ->> 'gap')::numeric desc, x ->> 'key' limit 2 loop
      acc := acc || (item - 'gap');
    end loop;
  end loop;
  return acc;
end $$;

-- Send one suggestion to a rep as a tip. The figures and the rep's text are worked out here from the same
-- range, so the browser cannot change them; the admin can add a short note. Returns the tip id.
create or replace function public.admin_send_coaching_tip(
  p_seat uuid, p_key text, p_from timestamptz, p_to timestamptz, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  s    public.seats;
  m    record;
  tm   record;
  note text := nullif(btrim(coalesce(p_note, '')), '');
  tid  uuid;
begin
  select * into s from public.seats where id = p_seat;
  if s.id is null then raise exception 'seat not found' using errcode = '22023'; end if;
  perform public.admin_require(s.institute_id);
  if s.role <> 'rep' or s.status <> 'active' then
    raise exception 'tips go to active reps only' using errcode = '22023';
  end if;
  perform public.admin_check_range(p_from, p_to);
  if note is not null and length(note) > 300 then
    raise exception 'a note is at most 300 characters' using errcode = '22023';
  end if;
  if exists (select 1 from public.coaching_tips t
             where t.seat_id = p_seat and t.tip_key = p_key and t.sent_at > now() - interval '7 days') then
    raise exception 'this tip was already sent to this rep in the last 7 days' using errcode = '23505';
  end if;

  select * into m from public.coach_metric(s.institute_id, p_seat, p_key, p_from, p_to);
  select * into tm from public.coach_metric(s.institute_id, null, p_key, p_from, p_to);
  if m.value is null then raise exception 'this rep has no calls for that tip in the range' using errcode = '22023'; end if;

  insert into public.coaching_tips (institute_id, seat_id, tip_key, better, rep_text, admin_note, baseline, team_baseline)
  values (s.institute_id, p_seat, p_key, public.coach_better(p_key),
          public.coach_text(p_key, null, m.value, tm.value), note, m.value, tm.value)
  returning id into tid;

  insert into public.audit_log (institute_id, actor_id, action, target)
  values (s.institute_id, auth.uid(), 'coaching_tip_sent', p_seat::text || ' ' || left(p_key, 120));
  return tid;
end $$;

-- Tips sent in the institute, newest first, with the rep's figure since the tip was sent.
-- result: waiting (fewer than 10 calls since, 5 lost calls for reason_missing), improved, same or worse
-- (a change of 3 points or more counts).
create or replace function public.admin_coaching_tips(p_institute uuid)
returns table (id uuid, seat_id uuid, label text, tip_key text, rep_text text, admin_note text,
               sent_at timestamptz, seen_at timestamptz, better text, baseline numeric, team_baseline numeric,
               after_value numeric, after_calls bigint, result text)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  t     record;
  m     record;
  diff  numeric;
  need  int;
begin
  perform public.admin_require(p_institute);
  for t in select ct.*, s.label as seat_label from public.coaching_tips ct
           join public.seats s on s.id = ct.seat_id
           where ct.institute_id = p_institute
           order by ct.sent_at desc limit 50 loop
    select * into m from public.coach_metric(p_institute, t.seat_id, t.tip_key, t.sent_at, greatest(now(), t.sent_at + interval '1 second'));
    need := case when t.tip_key = 'reason_missing' then 5 else 10 end;
    id := t.id; seat_id := t.seat_id; label := t.seat_label; tip_key := t.tip_key;
    rep_text := t.rep_text; admin_note := t.admin_note; sent_at := t.sent_at; seen_at := t.seen_at;
    better := t.better; baseline := t.baseline; team_baseline := t.team_baseline;
    after_value := m.value; after_calls := m.base;
    if m.base < need or m.value is null then
      result := 'waiting';
    else
      diff := (m.value - t.baseline) * case when t.better = 'higher' then 1 else -1 end;
      result := case when diff >= 3 then 'improved' when diff <= -3 then 'worse' else 'same' end;
    end if;
    return next;
  end loop;
end $$;

-- ---------- coaching (the rep's own tips) ----------

-- The caller's tips, newest first (at most 20). Empty when the caller has no active seat.
create or replace function public.my_coaching_tips()
returns table (id uuid, rep_text text, admin_note text, sent_at timestamptz, seen_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select t.id, t.rep_text, t.admin_note, t.sent_at, t.seen_at
  from public.coaching_tips t
  join public.seats s on s.id = t.seat_id
  where s.user_id = auth.uid() and s.status = 'active'
  order by t.sent_at desc
  limit 20;
$$;

-- The rep marks a tip as read. Only their own tips; a second call changes nothing.
create or replace function public.ack_coaching_tip(p_tip uuid)
returns void
language sql security definer set search_path = public
as $$
  update public.coaching_tips t set seen_at = now()
  from public.seats s
  where t.id = p_tip and s.id = t.seat_id and s.user_id = auth.uid() and s.status = 'active'
    and t.seen_at is null;
$$;

-- ---------- leaderboard ----------

-- Active reps ranked by the browser on calls, connected calls, won calls or talk time for a range.
-- Any active seat in the institute can read it; reps only while leaderboard_for_reps is on.
-- Returns { visible, for_reps, rows: [{ label, me, calls, connected, won, talk_minutes }] }.
create or replace function public.team_leaderboard(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  me   public.seats;
  inst public.institutes;
  v_rows jsonb;
begin
  select * into me from public.seats s where s.user_id = auth.uid() and s.status = 'active' limit 1;
  if me.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  perform public.admin_check_range(p_from, p_to);
  select * into inst from public.institutes where id = me.institute_id;

  if me.role <> 'admin' and not inst.leaderboard_for_reps then
    return jsonb_build_object('visible', false, 'for_reps', false, 'rows', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'label', x.label, 'me', x.id = me.id, 'calls', x.calls, 'connected', x.connected,
           'won', x.won, 'talk_minutes', x.talk_minutes) order by x.label), '[]'::jsonb)
    into v_rows
    from (
      select s.id, s.label,
             count(e.root_id) as calls,
             count(e.root_id) filter (where e.connected_seconds > 0) as connected,
             count(e.root_id) filter (where e.outcome = 'won') as won,
             round(coalesce(sum(e.connected_seconds), 0) / 60.0)::int as talk_minutes
      from public.seats s
      left join public.admin_effective_outcomes(me.institute_id, p_from, p_to) e on e.seat_id = s.id
      where s.institute_id = me.institute_id and s.role = 'rep' and s.status = 'active'
      group by s.id, s.label
    ) x;

  return jsonb_build_object('visible', true, 'for_reps', inst.leaderboard_for_reps, 'rows', v_rows);
end $$;

-- An admin turns the leaderboard on or off for the institute's reps. Admins always see it.
create or replace function public.admin_set_leaderboard_for_reps(p_institute uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.admin_require(p_institute);
  if p_on is null then raise exception 'on or off is required' using errcode = '22023'; end if;
  update public.institutes set leaderboard_for_reps = p_on where id = p_institute;
  insert into public.audit_log (institute_id, actor_id, action, target)
  values (p_institute, auth.uid(), 'leaderboard_for_reps', case when p_on then 'on' else 'off' end);
end $$;

-- ---------- grants: signed-in users only; helpers to nobody ----------

revoke all on function public.coach_calls(uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.coach_metric(uuid, uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.coach_text(text, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.coach_gap(text, numeric, bigint, bigint, numeric) from public, anon, authenticated;
revoke all on function public.coach_better(text) from public, anon, authenticated;

revoke all on function public.admin_coaching_suggestions(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_send_coaching_tip(uuid, text, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.admin_coaching_tips(uuid) from public, anon;
revoke all on function public.my_coaching_tips() from public, anon;
revoke all on function public.ack_coaching_tip(uuid) from public, anon;
revoke all on function public.team_leaderboard(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_set_leaderboard_for_reps(uuid, boolean) from public, anon;

grant execute on function public.admin_coaching_suggestions(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_send_coaching_tip(uuid, text, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_coaching_tips(uuid) to authenticated;
grant execute on function public.my_coaching_tips() to authenticated;
grant execute on function public.ack_coaching_tip(uuid) to authenticated;
grant execute on function public.team_leaderboard(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_set_leaderboard_for_reps(uuid, boolean) to authenticated;
