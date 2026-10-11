-- Vector 2.0: institutes, seats, devices, call outcomes, audit log.
-- Lead names and numbers are NOT stored here. Only call outcomes and counts sync to the cloud.
-- Access is enforced by row-level security. Writes that change seats or devices go through the
-- server (service role), never directly from a browser.

create extension if not exists pgcrypto;

-- ---------- tables ----------

create table public.institutes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 2 and 120),
  status      text not null default 'trial'
              check (status in ('trial', 'active', 'grace', 'suspended', 'cancelled')),
  seat_limit  int  not null default 5 check (seat_limit between 0 and 500),
  created_at  timestamptz not null default now()
);

-- One row per login. Created by the server when an account is invited.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text check (length(full_name) <= 120),
  created_at  timestamptz not null default now()
);

-- A seat is one person's place in an institute. Admins hold seats too (role = 'admin').
-- Reassigning a seat changes user_id; the old user's access stops at their next login.
create table public.seats (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  user_id       uuid references auth.users (id) on delete set null,
  label         text not null check (length(label) between 1 and 60),
  role          text not null default 'rep' check (role in ('admin', 'rep')),
  status        text not null default 'invited' check (status in ('invited', 'active', 'revoked')),
  created_at    timestamptz not null default now()
);

-- One login holds at most one active seat.
create unique index seats_one_active_per_user
  on public.seats (user_id) where status = 'active';

-- A seat is paired with exactly one phone and one laptop.
create table public.devices (
  id            uuid primary key default gen_random_uuid(),
  seat_id       uuid not null references public.seats (id) on delete cascade,
  kind          text not null check (kind in ('phone', 'laptop')),
  fingerprint   text not null check (length(fingerprint) between 16 and 200),
  paired_at     timestamptz not null default now(),
  revoked_at    timestamptz
);

-- Only one active device of each kind per seat.
create unique index devices_one_active_per_kind
  on public.devices (seat_id, kind) where revoked_at is null;

-- Call outcomes from a seat. Append-only from the browser: corrections are new rows that
-- reference the row they correct, so the history is never rewritten.
create table public.call_outcomes (
  id                uuid primary key default gen_random_uuid(),
  institute_id      uuid not null references public.institutes (id) on delete cascade,
  seat_id           uuid not null references public.seats (id) on delete cascade,
  client_record_id  text not null check (length(client_record_id) between 1 and 80),
  corrects_id       uuid references public.call_outcomes (id) on delete restrict,
  script_id         text check (length(script_id) <= 80),
  script_version    int check (script_version >= 1),
  script_step       text check (length(script_step) <= 80),
  objection         text check (length(objection) <= 80),
  outcome           text not null check (outcome in (
                      'answered', 'no_answer', 'busy', 'callback', 'interested',
                      'not_interested', 'won', 'dropped_network', 'other')),
  dialled_at        timestamptz,
  connected_seconds int check (connected_seconds is null or connected_seconds >= 0),
  phone_session_id  text check (length(phone_session_id) <= 80),
  uploaded_at       timestamptz not null default now(),
  -- The same outcome from the same seat is stored once, however many times the upload retries.
  unique (seat_id, client_record_id)
);

create index call_outcomes_institute_time on public.call_outcomes (institute_id, dialled_at);

-- Admin actions. Written only by the server.
create table public.audit_log (
  id            bigint generated always as identity primary key,
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  actor_id      uuid references auth.users (id) on delete set null,
  action        text not null check (length(action) <= 80),
  target        text check (length(target) <= 200),
  created_at    timestamptz not null default now()
);

-- ---------- helpers ----------

-- The active seat of the logged-in user, if any.
create or replace function public.my_active_seat()
returns public.seats
language sql stable security definer set search_path = public
as $$
  select s.* from public.seats s
  where s.user_id = auth.uid() and s.status = 'active'
  limit 1;
$$;

-- True when the logged-in user is an active admin of the given institute.
create or replace function public.is_admin_of(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.seats s
    where s.institute_id = inst
      and s.user_id = auth.uid()
      and s.role = 'admin'
      and s.status = 'active'
  );
$$;

-- ---------- row-level security ----------

alter table public.institutes   enable row level security;
alter table public.profiles     enable row level security;
alter table public.seats        enable row level security;
alter table public.devices      enable row level security;
alter table public.call_outcomes enable row level security;
alter table public.audit_log    enable row level security;

-- Institutes: an admin can read their own institute. Nobody edits it from the browser.
create policy institutes_admin_read on public.institutes
  for select using (public.is_admin_of(id));

-- Profiles: a user reads their own profile only.
create policy profiles_read_own on public.profiles
  for select using (id = auth.uid());

-- Seats: a user sees their own seat; admins see every seat in their institute.
create policy seats_read on public.seats
  for select using (user_id = auth.uid() or public.is_admin_of(institute_id));

-- Devices: admins only, from the browser. Pairing changes go through the server.
create policy devices_admin_read on public.devices
  for select using (
    public.is_admin_of((select institute_id from public.seats s where s.id = seat_id))
  );

-- Call outcomes: a rep can add outcomes for their own active seat, and read their own.
create policy outcomes_insert_own on public.call_outcomes
  for insert with check (
    exists (
      select 1 from public.seats s
      where s.id = seat_id
        and s.institute_id = call_outcomes.institute_id
        and s.user_id = auth.uid()
        and s.status = 'active'
    )
  );

create policy outcomes_read on public.call_outcomes
  for select using (
    public.is_admin_of(institute_id)
    or exists (select 1 from public.seats s where s.id = seat_id and s.user_id = auth.uid())
  );

-- No update or delete policies on call_outcomes: the browser cannot change or remove history.

-- Audit log: admins can read their institute's log. Only the server writes it.
create policy audit_admin_read on public.audit_log
  for select using (public.is_admin_of(institute_id));

-- Lock down direct privileges: the browser role only gets what the policies above allow.
revoke all on public.institutes, public.profiles, public.seats, public.devices,
              public.call_outcomes, public.audit_log from anon;
grant select on public.institutes, public.profiles, public.seats, public.devices, public.audit_log to authenticated;
grant select, insert on public.call_outcomes to authenticated;
