-- Vector 2.0: read-only reports for the admin page (web/admin.html).
-- Apply after 0003. Each report checks is_admin_of() itself and raises an error for anyone else,
-- so a rep, or an admin of another institute, gets an error and never rows.
-- Outcomes are read as their latest correction (0001 keeps history: a correction is a new row that
-- points at the row it corrects). A correction never counts as a call of its own.
-- Days are bucketed in p_tz (the browser's time zone; UTC by default).
-- Nothing here returns lead names or numbers: none are stored in the database.

create index if not exists call_outcomes_corrects_idx
  on public.call_outcomes (corrects_id) where corrects_id is not null;

-- ---------- internal helpers (not granted to any role) ----------

create or replace function public.admin_require(p_institute uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_admin_of(p_institute) then
    raise exception 'only an admin of this institute can view these reports' using errcode = '42501';
  end if;
end $$;

create or replace function public.admin_check_range(p_from timestamptz, p_to timestamptz)
returns void
language plpgsql immutable
as $$
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'the from time must be before the to time' using errcode = '22023';
  end if;
  if p_to - p_from > interval '400 days' then
    raise exception 'a report covers at most 400 days' using errcode = '22023';
  end if;
end $$;

-- One row per original call (corrects_id is null) that happened in the range, with its latest
-- correction applied. The latest correction is the deepest one in the chain, ties broken by upload time.
-- It does not check the caller, so it is granted to nobody: only the reports below call it.
create or replace function public.admin_effective_outcomes(
  p_institute uuid, p_from timestamptz, p_to timestamptz)
returns table (root_id uuid, seat_id uuid, outcome text, connected_seconds int, happened_at timestamptz)
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
  select l.root_id, o.seat_id, o.outcome, o.connected_seconds,
         coalesce(r.dialled_at, r.uploaded_at)
  from latest l
  join public.call_outcomes o on o.id = l.node
  join public.call_outcomes r on r.id = l.root_id;
$$;

-- ---------- reports for the admin page ----------

-- Per rep per day: calls, connected calls (connected_seconds > 0), connect rate (connected / calls),
-- total talk seconds, and the time of the last call that day.
create or replace function public.admin_team_activity(
  p_institute uuid, p_from timestamptz, p_to timestamptz, p_tz text default 'UTC')
returns table (seat_id uuid, label text, day date, calls bigint, connected_calls bigint,
               connect_rate numeric, talk_seconds bigint, last_activity timestamptz)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_range(p_from, p_to);
  if not exists (select 1 from pg_timezone_names where name = p_tz) then
    raise exception 'unknown time zone %', p_tz using errcode = '22023';
  end if;
  return query
    select e.seat_id,
           s.label,
           (e.happened_at at time zone p_tz)::date,
           count(*),
           count(*) filter (where e.connected_seconds > 0),
           round(count(*) filter (where e.connected_seconds > 0)::numeric / count(*), 4),
           coalesce(sum(e.connected_seconds) filter (where e.connected_seconds > 0), 0)::bigint,
           max(e.happened_at)
    from public.admin_effective_outcomes(p_institute, p_from, p_to) e
    join public.seats s on s.id = e.seat_id
    group by e.seat_id, s.label, (e.happened_at at time zone p_tz)::date
    order by s.label, (e.happened_at at time zone p_tz)::date;
end $$;

-- Per rep and outcome: how many calls ended that way in the range.
create or replace function public.admin_results_by_outcome(
  p_institute uuid, p_from timestamptz, p_to timestamptz)
returns table (seat_id uuid, label text, outcome text, outcome_count bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_range(p_from, p_to);
  return query
    select e.seat_id, s.label, e.outcome, count(*)
    from public.admin_effective_outcomes(p_institute, p_from, p_to) e
    join public.seats s on s.id = e.seat_id
    group by e.seat_id, s.label, e.outcome
    order by s.label, e.outcome;
end $$;

-- Every seat in the institute: label, role, status, active device kinds, time of the last call
-- (corrections excluded), and whether an active phone is paired. No user ids or emails are returned.
create or replace function public.admin_seat_list(p_institute uuid)
returns table (seat_id uuid, label text, role text, status text, device_kinds text[],
               last_call_at timestamptz, has_phone boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.admin_require(p_institute);
  return query
    select s.id,
           s.label,
           s.role,
           s.status,
           coalesce((select array_agg(d.kind order by d.kind)
                     from public.devices d
                     where d.seat_id = s.id and d.revoked_at is null), '{}'::text[]),
           (select max(coalesce(c.dialled_at, c.uploaded_at))
            from public.call_outcomes c
            where c.seat_id = s.id and c.corrects_id is null),
           exists (select 1 from public.devices d
                   where d.seat_id = s.id and d.kind = 'phone' and d.revoked_at is null)
    from public.seats s
    where s.institute_id = p_institute
    order by s.status, s.label;
end $$;

-- ---------- grants: signed-in users only ----------

revoke all on function public.admin_require(uuid) from public, anon, authenticated;
revoke all on function public.admin_check_range(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_effective_outcomes(uuid, timestamptz, timestamptz) from public, anon, authenticated;

revoke all on function public.admin_team_activity(uuid, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.admin_results_by_outcome(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_seat_list(uuid) from public, anon;
grant execute on function public.admin_team_activity(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.admin_results_by_outcome(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_seat_list(uuid) to authenticated;
