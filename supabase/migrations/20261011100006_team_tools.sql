-- Vector 2.0: team tools. Terms acceptance, feedback, supervisor notes, rep daily targets, and the
-- team progress and weekly reports.
-- Apply after 0005. Every function runs with the caller's own login (auth.uid()) and checks the
-- caller's role itself. The browser can only read these tables (RLS); every write goes through
-- the functions below. The database never sees the terms text: the browser computes text_hash.
-- Reports bucket days in p_tz, the same way 0004 does (UTC by default).

-- ---------- tables ----------

-- A seat accepts the terms once per version. The first accepted hash is kept.
create table public.accepted_terms (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  seat_id       uuid not null references public.seats (id) on delete cascade,
  terms_version text not null check (length(terms_version) between 1 and 40),
  text_hash     text not null check (length(text_hash) between 16 and 128),
  accepted_at   timestamptz not null default now(),
  unique (seat_id, terms_version)
);

-- Feedback from a seat to the institute's admins.
create table public.feedback (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  seat_id       uuid not null references public.seats (id) on delete cascade,
  message       text not null check (length(message) between 1 and 2000),
  created_at    timestamptz not null default now()
);

-- Notes an admin writes about a rep for one day. Admins only.
create table public.supervisor_notes (
  id              uuid primary key default gen_random_uuid(),
  institute_id    uuid not null references public.institutes (id) on delete cascade,
  target_seat_id  uuid not null references public.seats (id) on delete cascade,
  author_seat_id  uuid not null references public.seats (id) on delete cascade,
  note_day        date not null,
  note            text not null check (length(note) between 1 and 1000),
  created_at      timestamptz not null default now()
);

create index supervisor_notes_target_day on public.supervisor_notes (target_seat_id, note_day);

-- Daily target per rep and metric. Admins only.
create table public.rep_targets (
  seat_id       uuid not null references public.seats (id) on delete cascade,
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  metric        text not null check (metric in ('calls', 'connected_calls', 'talk_minutes')),
  daily_target  int  not null check (daily_target between 1 and 500),
  primary key (seat_id, metric)
);

-- ---------- helpers (not granted to any role) ----------

-- Same rule as 0004: the time zone must be a name the database knows.
create or replace function public.admin_check_tz(p_tz text)
returns void
language plpgsql stable set search_path = public
as $$
begin
  if p_tz is null or not exists (select 1 from pg_timezone_names where name = p_tz) then
    raise exception 'unknown time zone %', p_tz using errcode = '22023';
  end if;
end $$;

-- ---------- row-level security: reads only; writes go through the functions ----------

alter table public.accepted_terms  enable row level security;
alter table public.feedback        enable row level security;
alter table public.supervisor_notes enable row level security;
alter table public.rep_targets     enable row level security;

-- A seat reads its own acceptances; admins read their institute's.
create policy accepted_terms_read on public.accepted_terms
  for select using (
    public.is_admin_of(institute_id)
    or exists (select 1 from public.seats s where s.id = accepted_terms.seat_id and s.user_id = auth.uid())
  );

create policy feedback_admin_read on public.feedback
  for select using (public.is_admin_of(institute_id));

create policy supervisor_notes_admin_read on public.supervisor_notes
  for select using (public.is_admin_of(institute_id));

create policy rep_targets_admin_read on public.rep_targets
  for select using (public.is_admin_of(institute_id));

-- No insert, update or delete policy and no write grant: the browser cannot write these tables directly.
revoke all on public.accepted_terms, public.feedback, public.supervisor_notes, public.rep_targets
  from anon, authenticated;
grant select on public.accepted_terms, public.feedback, public.supervisor_notes, public.rep_targets
  to authenticated;

-- ---------- terms acceptance ----------

-- Record that the caller's active seat in p_institute accepted terms version p_version.
-- Idempotent: a second call for the same version changes nothing.
create or replace function public.accept_terms(p_institute uuid, p_version text, p_text_hash text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  sid uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_version is null or length(p_version) not between 1 and 40 then
    raise exception 'terms version must be 1 to 40 characters';
  end if;
  if p_text_hash is null or length(p_text_hash) not between 16 and 128 then
    raise exception 'terms hash must be 16 to 128 characters';
  end if;
  select id into sid from public.seats
    where institute_id = p_institute and user_id = auth.uid() and status = 'active';
  if sid is null then raise exception 'this login holds no active seat in that institute'; end if;

  insert into public.accepted_terms (institute_id, seat_id, terms_version, text_hash)
    values (p_institute, sid, p_version, p_text_hash)
    on conflict (seat_id, terms_version) do nothing;
end $$;

-- The caller's acceptances in p_institute (empty when the caller has no active seat there).
create or replace function public.my_terms_status(p_institute uuid)
returns table (terms_version text, accepted_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select t.terms_version, t.accepted_at
  from public.accepted_terms t
  join public.seats s on s.id = t.seat_id
  where s.institute_id = p_institute
    and s.user_id = auth.uid()
    and s.status = 'active'
  order by t.accepted_at;
$$;

-- ---------- feedback ----------

-- Send feedback from the caller's active seat. Returns the new feedback id.
create or replace function public.submit_feedback(p_message text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  fid  uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'you need an active seat to send feedback'; end if;
  if p_message is null or length(trim(p_message)) = 0 then raise exception 'feedback is required'; end if;
  if length(p_message) > 2000 then raise exception 'feedback can be at most 2000 characters'; end if;

  insert into public.feedback (institute_id, seat_id, message)
    values (seat.institute_id, seat.id, p_message)
    returning id into fid;
  return fid;
end $$;

-- ---------- supervisor notes (admin only) ----------

-- An admin adds a note about a seat for one day. The seat must be in an institute the caller administers.
create or replace function public.add_supervisor_note(p_seat uuid, p_day date, p_note text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  inst      uuid;
  author_id uuid;
  nid       uuid;
begin
  select institute_id into inst from public.seats where id = p_seat;
  if inst is null then raise exception 'seat not found'; end if;
  if not public.is_admin_of(inst) then raise exception 'only an admin of this institute can add supervisor notes'; end if;
  select id into author_id from public.seats
    where institute_id = inst and user_id = auth.uid() and status = 'active';
  if p_day is null then raise exception 'a day is required'; end if;
  if p_note is null or length(trim(p_note)) = 0 then raise exception 'note is required'; end if;
  if length(p_note) > 1000 then raise exception 'a note can be at most 1000 characters'; end if;

  insert into public.supervisor_notes (institute_id, target_seat_id, author_seat_id, note_day, note)
    values (inst, p_seat, author_id, p_day, p_note)
    returning id into nid;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'supervisor_note.added', p_seat::text);
  return nid;
end $$;

-- Notes in an institute, newest day first. p_seat, p_from and p_to are optional filters (null = no limit).
create or replace function public.list_supervisor_notes(
  p_institute uuid, p_seat uuid default null, p_from date default null, p_to date default null)
returns table (id uuid, target_seat_id uuid, target_label text, author_label text,
               note_day date, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_admin_of(p_institute) then
    raise exception 'only an admin of this institute can read supervisor notes' using errcode = '42501';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'the from day must be on or before the to day' using errcode = '22023';
  end if;
  return query
    select n.id, n.target_seat_id, t.label, a.label, n.note_day, n.note, n.created_at
    from public.supervisor_notes n
    join public.seats t on t.id = n.target_seat_id
    join public.seats a on a.id = n.author_seat_id
    where n.institute_id = p_institute
      and (p_seat is null or n.target_seat_id = p_seat)
      and (p_from is null or n.note_day >= p_from)
      and (p_to is null or n.note_day <= p_to)
    order by n.note_day desc, n.created_at desc;
end $$;

-- ---------- rep targets (admin only) ----------

-- Set (or replace) a rep's daily target for one metric. The seat must be a rep in an institute the caller administers.
create or replace function public.set_rep_target(p_seat uuid, p_metric text, p_daily_target int)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  inst  uuid;
  srole text;
begin
  select institute_id, role into inst, srole from public.seats where id = p_seat;
  if inst is null then raise exception 'seat not found'; end if;
  if not public.is_admin_of(inst) then raise exception 'only an admin of this institute can set targets'; end if;
  if srole <> 'rep' then raise exception 'targets are set for rep seats'; end if;
  if p_metric is null or p_metric not in ('calls', 'connected_calls', 'talk_minutes') then
    raise exception 'metric must be calls, connected_calls or talk_minutes';
  end if;
  if p_daily_target is null or p_daily_target < 1 or p_daily_target > 500 then
    raise exception 'daily target must be 1 to 500';
  end if;

  insert into public.rep_targets (seat_id, institute_id, metric, daily_target)
    values (p_seat, inst, p_metric, p_daily_target)
    on conflict (seat_id, metric) do update set daily_target = excluded.daily_target;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'rep_target.set', p_seat::text || ':' || p_metric);
end $$;

-- ---------- team reports (admin only) ----------

-- One row per active rep for one day. Calls use the same effective outcomes as 0004: a correction never
-- counts as a call of its own, and a call's connected time is its latest correction.
-- Progress percentages are actual / target * 100 (not capped), or null when the rep has no target.
create or replace function public.admin_rep_progress(
  p_institute uuid, p_day date, p_tz text default 'UTC')
returns table (seat_id uuid, label text, calls bigint, connected_calls bigint, talk_minutes int,
               calls_target int, calls_pct numeric,
               connected_target int, connected_pct numeric,
               talk_target int, talk_pct numeric)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_from timestamptz;
  v_to   timestamptz;
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_tz(p_tz);
  if p_day is null then raise exception 'a day is required' using errcode = '22023'; end if;
  v_from := p_day::timestamp at time zone p_tz;
  v_to   := v_from + interval '1 day';

  return query
    with eff as (
      select e.seat_id as sid, e.connected_seconds as secs
      from public.admin_effective_outcomes(p_institute, v_from, v_to) e
    ),
    per_rep as (
      select eff.sid as sid,
             count(*) as n_calls,
             count(*) filter (where eff.secs > 0) as n_connected,
             coalesce(sum(eff.secs), 0) as n_secs
      from eff
      group by eff.sid
    ),
    base as (
      select r.id as rid, r.label as rlabel,
             coalesce(pr.n_calls, 0) as calls_n,
             coalesce(pr.n_connected, 0) as conn_n,
             round(coalesce(pr.n_secs, 0) / 60.0)::int as talk_n
      from public.seats r
      left join per_rep pr on pr.sid = r.id
      where r.institute_id = p_institute and r.role = 'rep' and r.status = 'active'
    )
    select b.rid, b.rlabel, b.calls_n, b.conn_n, b.talk_n,
           tc.daily_target, round(100.0 * b.calls_n / tc.daily_target, 1),
           tn.daily_target, round(100.0 * b.conn_n / tn.daily_target, 1),
           tt.daily_target, round(100.0 * b.talk_n / tt.daily_target, 1)
    from base b
    left join public.rep_targets tc on tc.seat_id = b.rid and tc.metric = 'calls'
    left join public.rep_targets tn on tn.seat_id = b.rid and tn.metric = 'connected_calls'
    left join public.rep_targets tt on tt.seat_id = b.rid and tt.metric = 'talk_minutes'
    order by b.rlabel;
end $$;

-- Seven days from p_week_start, one row per day: calls, connected calls, connect rate (connected / calls,
-- null on a day with no calls), talk minutes, and how many active reps made a call that day or made none.
create or replace function public.admin_weekly_summary(
  p_institute uuid, p_week_start date, p_tz text default 'UTC')
returns table (day date, calls bigint, connected_calls bigint, connect_rate numeric,
               talk_minutes int, reps_with_calls bigint, reps_with_no_calls bigint)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v_from timestamptz;
  v_to   timestamptz;
  v_reps bigint;
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_tz(p_tz);
  if p_week_start is null then raise exception 'a week start day is required' using errcode = '22023'; end if;
  v_from := p_week_start::timestamp at time zone p_tz;
  v_to   := v_from + interval '7 days';

  select count(*) into v_reps from public.seats s
    where s.institute_id = p_institute and s.role = 'rep' and s.status = 'active';

  return query
    with reps as (
      select s.id as rid from public.seats s
      where s.institute_id = p_institute and s.role = 'rep' and s.status = 'active'
    ),
    eff as (
      select e.seat_id as sid, e.connected_seconds as secs,
             (e.happened_at at time zone p_tz)::date as dd,
             (e.seat_id in (select rep.rid from reps rep)) as is_rep
      from public.admin_effective_outcomes(p_institute, v_from, v_to) e
    ),
    per_day as (
      select eff.dd as dd,
             count(*) as n_calls,
             count(*) filter (where eff.secs > 0) as n_connected,
             coalesce(sum(eff.secs), 0) as n_secs,
             count(distinct case when eff.is_rep then eff.sid end) as n_reps
      from eff
      group by eff.dd
    ),
    days as (
      select (p_week_start + g)::date as dd from generate_series(0, 6) as g
    )
    select d.dd,
           coalesce(pd.n_calls, 0),
           coalesce(pd.n_connected, 0),
           case when coalesce(pd.n_calls, 0) = 0 then null
                else round(pd.n_connected::numeric / pd.n_calls, 4) end,
           round(coalesce(pd.n_secs, 0) / 60.0)::int,
           coalesce(pd.n_reps, 0),
           v_reps - coalesce(pd.n_reps, 0)
    from days d
    left join per_day pd on pd.dd = d.dd
    order by d.dd;
end $$;

-- ---------- grants: signed-in users only ----------

revoke all on function public.admin_check_tz(text) from public, anon, authenticated;

revoke all on function public.accept_terms(uuid, text, text) from public, anon;
revoke all on function public.my_terms_status(uuid) from public, anon;
revoke all on function public.submit_feedback(text) from public, anon;
revoke all on function public.add_supervisor_note(uuid, date, text) from public, anon;
revoke all on function public.list_supervisor_notes(uuid, uuid, date, date) from public, anon;
revoke all on function public.set_rep_target(uuid, text, int) from public, anon;
revoke all on function public.admin_rep_progress(uuid, date, text) from public, anon;
revoke all on function public.admin_weekly_summary(uuid, date, text) from public, anon;

grant execute on function public.accept_terms(uuid, text, text) to authenticated;
grant execute on function public.my_terms_status(uuid) to authenticated;
grant execute on function public.submit_feedback(text) to authenticated;
grant execute on function public.add_supervisor_note(uuid, date, text) to authenticated;
grant execute on function public.list_supervisor_notes(uuid, uuid, date, date) to authenticated;
grant execute on function public.set_rep_target(uuid, text, int) to authenticated;
grant execute on function public.admin_rep_progress(uuid, date, text) to authenticated;
grant execute on function public.admin_weekly_summary(uuid, date, text) to authenticated;
