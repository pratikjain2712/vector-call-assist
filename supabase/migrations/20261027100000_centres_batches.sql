-- Centres and batches, and the quick "Collect fee" screen (docs/data-contract.md, "Centres and batches" and
-- "Collect fee"). Apply after 20261026120000_autopilot_engine.sql.
--
-- 1. Tables: centres (an institute's branches: name, short code, active) and batches (name such as
--    "8th SB Morning", class, board, academic year, timing; in one centre or in all of them). New columns:
--    students.centre_id / batch_id, leads.centre_id (from the student, else the calling list, else the upload),
--    campaigns.centre_id / batch_id (null = every centre / batch), seats.centre_ids (null = every centre).
-- 2. Scope. Two things narrow what a list or total shows:
--      - the person: a seat with centre_ids sees only rows of those centres (and rows with no centre), in every
--        function below and in RLS (students, fee items, payments, discounts, leads, campaigns);
--      - the filter the page asks for (p_centre / p_batch): set for one call with scope_push / scope_pop
--        (transaction-local settings vector.centre and vector.batch) and read by the internals that every list
--        and total is built on (student_balance_rows, ledger_collected, report_fee_promise_rows, home_calls,
--        ledger_day_closing). A function that is called without a filter behaves as before.
--    An institute without centres has no centre_ids and no filter: nothing changes for it.
-- 3. Every list and total the admin app reads takes optional p_centre / p_batch (old calls keep working): the
--    old function is renamed to <name>__base (granted to nobody) and a new <name> with two more arguments
--    (default null) sets the filter and calls it.
-- 4. Autopilot: the "fees due" rule runs once per active centre ("Term 2 fees – Class 8 State Board ·
--    Andheri"); the list it makes is for that centre's students and carries centre_id.
-- 5. Collect fee: collect_search (fast student search with due amounts), collect_student (balance and the
--    unpaid fees, for the amount chips), collect_pending (students with dues), collected_by_me (the
--    signed-in person's collection today and this month from the ledger, and the institute's most used mode).
--    Payments still go through accounts_record_payment / accounts_reverse_payment.
-- 6. Settings: centres_list, admin_save_centre, admin_save_batch, admin_set_seat_centres,
--    admin_set_campaign_centre.

-- =====================================================================================================
-- 1. Tables and columns
-- =====================================================================================================

create table public.centres (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  name          text not null check (length(name) between 1 and 60),
  short_code    text check (short_code is null or short_code ~ '^[A-Z0-9]{1,8}$'),
  active        boolean not null default true,
  sort_order    int not null default 100 check (sort_order between 0 and 10000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, institute_id)
);
create unique index centres_name on public.centres (institute_id, lower(name));
create unique index centres_code on public.centres (institute_id, short_code) where short_code is not null;

create table public.batches (
  id             uuid primary key default gen_random_uuid(),
  institute_id   uuid not null references public.institutes (id) on delete cascade,
  centre_id      uuid,
  name           text not null check (length(name) between 1 and 60),
  class_label    text check (class_label is null or length(class_label) between 1 and 20),
  board          text check (board is null or board in ('CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other')),
  academic_year  text check (academic_year is null or academic_year ~ '^[0-9]{4}-[0-9]{2}$'),
  timing         text check (timing is null or length(timing) between 1 and 60),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, institute_id),
  foreign key (centre_id, institute_id) references public.centres (id, institute_id)
);
create unique index batches_name on public.batches
  (institute_id, coalesce(centre_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

alter table public.students
  add column if not exists centre_id uuid,
  add column if not exists batch_id uuid;
alter table public.students add constraint students_centre_fk foreign key (centre_id, institute_id)
  references public.centres (id, institute_id);
alter table public.students add constraint students_batch_fk foreign key (batch_id, institute_id)
  references public.batches (id, institute_id);
create index students_centre on public.students (institute_id, centre_id, batch_id);

alter table public.leads add column if not exists centre_id uuid;
alter table public.leads add constraint leads_centre_fk foreign key (centre_id, institute_id)
  references public.centres (id, institute_id);
create index leads_centre on public.leads (institute_id, centre_id) where centre_id is not null;
grant select (centre_id) on public.leads to authenticated;

alter table public.campaigns
  add column if not exists centre_id uuid,
  add column if not exists batch_id uuid;
alter table public.campaigns add constraint campaigns_centre_fk foreign key (centre_id, institute_id)
  references public.centres (id, institute_id);
alter table public.campaigns add constraint campaigns_batch_fk foreign key (batch_id, institute_id)
  references public.batches (id, institute_id);

-- The centres a staff member works in; null = every centre. Set with admin_set_seat_centres (owner).
alter table public.seats add column if not exists centre_ids uuid[];
alter table public.seats add constraint seats_centre_ids_size
  check (centre_ids is null or cardinality(centre_ids) between 1 and 50);

-- RLS: any active seat of the institute reads its centres and batches (names for pickers); writes go through
-- the functions below.
alter table public.centres enable row level security;
alter table public.batches enable row level security;
create policy centres_read on public.centres for select using (
  exists (select 1 from public.seats s where s.user_id = auth.uid() and s.status = 'active' and s.institute_id = centres.institute_id));
create policy batches_read on public.batches for select using (
  exists (select 1 from public.seats s where s.user_id = auth.uid() and s.status = 'active' and s.institute_id = batches.institute_id));
revoke all on public.centres, public.batches from anon, authenticated;
grant select on public.centres, public.batches to authenticated;

-- =====================================================================================================
-- 2. Scope helpers
-- =====================================================================================================

-- The centres the signed-in person is limited to in the institute, or null (every centre). Null too for the
-- service role (no login) and inside system work (vector.unscoped, e.g. Autopilot planning).
create or replace function public.my_centre_ids(p_institute uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select case when coalesce(current_setting('vector.unscoped', true), '') = '1' then null
              else (select s.centre_ids from public.seats s
                    where s.user_id = auth.uid() and s.status = 'active' and s.institute_id = p_institute
                    limit 1) end
$$;

-- The signed-in person may see a row of this centre. A row with no centre is shared: everyone may see it.
create or replace function public.centre_allowed(p_institute uuid, p_centre uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select p_centre is null or coalesce(p_centre = any (public.my_centre_ids(p_institute)), true) $$;

-- The filter of this call (scope_push), or null.
create or replace function public.scope_centre()
returns uuid language sql stable set search_path = public
as $$ select nullif(current_setting('vector.centre', true), '')::uuid $$;
create or replace function public.scope_batch()
returns uuid language sql stable set search_path = public
as $$ select nullif(current_setting('vector.batch', true), '')::uuid $$;

-- Whether a row is in scope. p_kind:
--   'row'   students, leads, payments: the filter must match (a row with no centre is outside a centre filter)
--   'list'  calling lists: no centre or batch = every centre or batch, so it matches any filter
--   'call'  calls: centre only (a call has no batch)
create or replace function public.in_scope(p_institute uuid, p_centre uuid, p_batch uuid, p_kind text default 'row')
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.centre_allowed(p_institute, p_centre)
     and (public.scope_centre() is null or p_centre = public.scope_centre() or (p_kind = 'list' and p_centre is null))
     and (p_kind = 'call' or public.scope_batch() is null or p_batch = public.scope_batch()
          or (p_kind = 'list' and p_batch is null))
$$;

-- Whether any scope applies (a filter, or a person limited to some centres): big queries skip the row check
-- when it is false.
create or replace function public.scope_active(p_institute uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.scope_centre() is not null or public.scope_batch() is not null or public.my_centre_ids(p_institute) is not null $$;

create or replace function public.student_in_scope(p_student uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select public.in_scope(s.institute_id, s.centre_id, s.batch_id, 'row')
                   from public.students s where s.id = p_student), false)
$$;

-- For RLS: the signed-in person may see this student (its centre). Only the person's limit, not a filter.
create or replace function public.student_in_scope_rls(p_student uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select public.centre_allowed(s.institute_id, s.centre_id) from public.students s where s.id = p_student), false)
$$;

-- Sets the filter for the rest of this call and returns what was there before (for scope_pop). A null
-- argument keeps the filter already set. p_check: the person must be allowed that centre (42501); false for
-- system work (Autopilot), which also lifts the person's own limit (vector.unscoped).
create or replace function public.scope_push(p_institute uuid, p_centre uuid, p_batch uuid, p_check boolean default true)
returns text[]
language plpgsql security definer set search_path = public
as $$
declare
  prev text[] := array[coalesce(current_setting('vector.centre', true), ''), coalesce(current_setting('vector.batch', true), ''),
                       coalesce(current_setting('vector.unscoped', true), '')];
  bc   uuid;
begin
  if p_centre is not null then
    if not exists (select 1 from public.centres c where c.id = p_centre and c.institute_id = p_institute) then
      raise exception 'centre not found' using errcode = '42501';
    end if;
    if p_check and not public.centre_allowed(p_institute, p_centre) then
      raise exception 'you can see only your own centres' using errcode = '42501';
    end if;
    perform set_config('vector.centre', p_centre::text, true);
  end if;
  if p_batch is not null then
    select b.centre_id into bc from public.batches b where b.id = p_batch and b.institute_id = p_institute;
    if not found then raise exception 'batch not found' using errcode = '42501'; end if;
    if p_check and not public.centre_allowed(p_institute, bc) then
      raise exception 'you can see only your own centres' using errcode = '42501';
    end if;
    perform set_config('vector.batch', p_batch::text, true);
  end if;
  if not p_check then perform set_config('vector.unscoped', '1', true); end if;
  return prev;
end $$;

create or replace function public.scope_pop(p_prev text[])
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform set_config('vector.centre', coalesce(p_prev[1], ''), true);
  perform set_config('vector.batch', coalesce(p_prev[2], ''), true);
  perform set_config('vector.unscoped', coalesce(p_prev[3], ''), true);
end $$;

-- A centre or batch id from a form or sheet: an id, a centre's name or short code, a batch's name (any case).
-- Null for blank; raises 22023 when it matches nothing (or several batches of that name).
create or replace function public.centre_from_text(p_institute uuid, p_raw text)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v   text := nullif(trim(coalesce(p_raw, '')), '');
  out uuid;
begin
  if v is null then return null; end if;
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select c.id into out from public.centres c where c.id = v::uuid and c.institute_id = p_institute;
  else
    select c.id into out from public.centres c
     where c.institute_id = p_institute and (lower(c.name) = lower(v) or c.short_code = upper(v)) limit 1;
  end if;
  if out is null then raise exception 'unknown centre "%"', left(v, 60) using errcode = '22023'; end if;
  return out;
end $$;

create or replace function public.batch_from_text(p_institute uuid, p_centre uuid, p_raw text)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v   text := nullif(trim(coalesce(p_raw, '')), '');
  out uuid;
  n   int;
begin
  if v is null then return null; end if;
  if v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select b.id into out from public.batches b where b.id = v::uuid and b.institute_id = p_institute;
    n := case when out is null then 0 else 1 end;
  else
    select min(b.id::text)::uuid, count(*) into out, n from public.batches b
     where b.institute_id = p_institute and lower(b.name) = lower(v)
       and (p_centre is null or b.centre_id is null or b.centre_id = p_centre)
       and public.centre_allowed(p_institute, b.centre_id);
  end if;
  if n = 0 then raise exception 'unknown batch "%"', left(v, 60) using errcode = '22023'; end if;
  if n > 1 then raise exception 'two batches are called "%": pick the centre too', left(v, 60) using errcode = '22023'; end if;
  return out;
end $$;

-- =====================================================================================================
-- 3. Centre of new students and leads
-- =====================================================================================================

-- A new student gets a centre: the one given, else its admission lead's, else the one the page or import set
-- for this call (vector.new_centre / vector.new_batch), else the only centre of a person limited to one. A
-- batch in one centre sets that centre; a batch of another centre is refused.
create or replace function public.students_centre()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  lim uuid[];
  bc  uuid;
begin
  if tg_op = 'INSERT' then
    if new.centre_id is null and new.admission_lead_id is not null then
      select l.centre_id into new.centre_id from public.leads l where l.id = new.admission_lead_id;
    end if;
    if new.centre_id is null then new.centre_id := nullif(current_setting('vector.new_centre', true), '')::uuid; end if;
    if new.batch_id is null then new.batch_id := nullif(current_setting('vector.new_batch', true), '')::uuid; end if;
    if new.centre_id is null and new.batch_id is null then
      lim := public.my_centre_ids(new.institute_id);
      if cardinality(lim) = 1 then new.centre_id := lim[1]; end if;
    end if;
  end if;
  if new.batch_id is not null then
    select b.centre_id into bc from public.batches b where b.id = new.batch_id;
    if new.centre_id is null then new.centre_id := bc;
    elsif bc is not null and bc <> new.centre_id then
      raise exception 'that batch belongs to another centre' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger students_centre before insert or update of centre_id, batch_id on public.students
  for each row execute function public.students_centre();

-- A lead's centre: given, else its student's, else its calling list's, else the upload's (vector.new_centre),
-- else the only centre of a person limited to one.
create or replace function public.leads_centre()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare lim uuid[];
begin
  if new.centre_id is null then
    new.centre_id := coalesce(
      (select s.centre_id from public.students s where s.id = new.student_id),
      (select c.centre_id from public.campaigns c where c.id = new.campaign_id),
      nullif(current_setting('vector.new_centre', true), '')::uuid);
  end if;
  if new.centre_id is null and tg_op = 'INSERT' then
    lim := public.my_centre_ids(new.institute_id);
    if cardinality(lim) = 1 then new.centre_id := lim[1]; end if;
  end if;
  return new;
end $$;
create trigger leads_centre before insert or update of student_id on public.leads
  for each row execute function public.leads_centre();

-- =====================================================================================================
-- 4. RLS: a person limited to some centres reads only those (rows with no centre stay shared)
-- =====================================================================================================

drop policy if exists students_read on public.students;
create policy students_read on public.students for select
  using (public.can_read_ledger(institute_id) and public.centre_allowed(institute_id, centre_id));
drop policy if exists fee_items_read on public.fee_items;
create policy fee_items_read on public.fee_items for select
  using (public.can_read_ledger(institute_id) and public.student_in_scope_rls(student_id));
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select
  using (public.can_read_ledger(institute_id) and public.student_in_scope_rls(student_id));
drop policy if exists discounts_read on public.discounts;
create policy discounts_read on public.discounts for select
  using (public.can_read_ledger(institute_id) and public.student_in_scope_rls(student_id));

drop policy if exists leads_read on public.leads;
create policy leads_read on public.leads
  for select using (
    (public.is_admin_of(institute_id)
     or exists (select 1 from public.seats s
                where s.id = leads.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active'))
    and public.centre_allowed(institute_id, centre_id));
drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update using (
    (public.is_admin_of(institute_id)
     or exists (select 1 from public.seats s
                where s.id = leads.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active'))
    and public.centre_allowed(institute_id, centre_id))
  with check (
    (public.is_admin_of(institute_id)
     or exists (select 1 from public.seats s
                where s.id = leads.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active'))
    and public.centre_allowed(institute_id, centre_id));

-- Campaigns: as in 20261025130000, and a person limited to some centres sees lists of those centres and lists
-- for every centre (centre_id null).
drop policy if exists campaigns_read on public.campaigns;
create policy campaigns_read on public.campaigns
  for select using (
    (public.is_admin_of(institute_id)
     or (status <> 'draft' and exists (
       select 1 from public.campaign_members m
       join public.seats s on s.id = m.seat_id
       where m.campaign_id = campaigns.id and s.user_id = auth.uid() and s.status = 'active'))
     or (open_to_all and status in ('running', 'paused') and exists (
       select 1 from public.seats s
       where s.user_id = auth.uid() and s.status = 'active' and s.institute_id = campaigns.institute_id)))
    and public.centre_allowed(institute_id, centre_id));

-- =====================================================================================================
-- 5. The internals every list and total is built on, now in scope
-- =====================================================================================================

-- student_balance_rows: as in 20261026110000. For the whole institute (p_student null) only the students in
-- scope (the person's centres and this call's filter); one student (p_student) is never filtered here: who
-- may read that student is checked by ledger_student().
create or replace function public.student_balance_rows(p_institute uuid, p_student uuid default null, p_as_of date default null)
returns table (student_id uuid, total_fees numeric, total_due_to_date numeric, paid numeric,
               balance_due_now numeric, balance_total numeric,
               last_payment_amount numeric, last_payment_on date, last_payment_mode text, discounts numeric)
language sql stable security definer set search_path = public
as $$
  with d as materialized (select coalesce(p_as_of, public.ledger_today(p_institute)) as as_of,
                                 p_student is null and public.scope_active(p_institute) as scoped)
  select s.id, f.total::numeric(12, 2), f.due::numeric(12, 2), p.paid::numeric(12, 2), (f.due - p.paid)::numeric(12, 2),
         (f.total - p.paid)::numeric(12, 2), lp.amount, lp.paid_on, lp.mode, f.disc::numeric(12, 2)
  from public.students s
  cross join d
  cross join lateral (
    select coalesce(sum(greatest(fi.amount - coalesce(dc.amt, 0), 0)), 0) as total,
           coalesce(sum(greatest(fi.amount - coalesce(dc.amt, 0), 0)) filter (where fi.due_date <= d.as_of), 0) as due,
           coalesce(sum(least(coalesce(dc.amt, 0), fi.amount)), 0) as disc
    from public.fee_items fi
    left join lateral (select sum(x.amount) as amt from public.discounts x
                       where x.fee_item_id = fi.id and not x.is_removed) dc on true
    where fi.student_id = s.id and not fi.is_void) f
  cross join lateral (
    select coalesce(sum(case when py.reverses_id is null then py.amount else -py.amount end), 0) as paid
    from public.payments py where py.student_id = s.id) p
  left join lateral (
    select py.amount, py.paid_on, py.mode from public.payments py
    where py.student_id = s.id and py.reverses_id is null
      and not exists (select 1 from public.payments r where r.reverses_id = py.id)
    order by py.paid_on desc, py.created_at desc limit 1) lp on true
  where s.institute_id = p_institute and (p_student is null or s.id = p_student)
    and (not d.scoped or public.in_scope(p_institute, s.centre_id, s.batch_id, 'row'));
$$;
revoke all on function public.student_balance_rows(uuid, uuid, date) from public, anon, authenticated;

-- ledger_student: as in 20261025130000, and a person limited to some centres gets "student not found" for a
-- student of another centre. Every accounts_* function on one student goes through it.
create or replace function public.ledger_student(p_student uuid, p_write boolean)
returns public.students
language plpgsql stable security definer set search_path = public
as $$
declare st public.students;
begin
  select * into st from public.students where id = p_student;
  if st.id is null or not (case when p_write then public.can_manage_ledger(st.institute_id)
                                else public.can_read_ledger(st.institute_id) end)
     or not public.centre_allowed(st.institute_id, st.centre_id) then
    raise exception 'student not found' using errcode = '42501';
  end if;
  return st;
end $$;

-- accounts_reverse_payment: as in 20261025130000, plus the centre check of the payment's student.
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
  if p.id is null or not public.can_manage_ledger(p.institute_id) or not public.student_in_scope_rls(p.student_id) then
    raise exception 'payment not found' using errcode = '42501';
  end if;
  seat := public.ledger_manager_seat(p.institute_id);
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

-- ledger_collected: as in 20261025130000, payments of students in scope, with an optional centre and batch.
drop function public.ledger_collected(uuid, date, date, uuid);
create function public.ledger_collected(p_institute uuid, p_from date, p_to date, p_campaign uuid default null,
                                        p_centre uuid default null, p_batch uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  money boolean;
  out   jsonb;
  prev  text[];
  sc    boolean;
begin
  if not public.can_read_ledger(p_institute) then
    raise exception 'only accounts, owners and managers can see collections' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'the from date must be on or before the to date' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then raise exception 'a report covers at most 400 days' using errcode = '22023'; end if;
  if p_campaign is not null and not exists (select 1 from public.campaigns c where c.id = p_campaign and c.institute_id = p_institute) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  prev := public.scope_push(p_institute, p_centre, p_batch);
  sc := public.scope_active(p_institute);
  money := public.can_see_money(p_institute);
  with p as (
    select py.* from public.payments py
    where py.institute_id = p_institute and py.reverses_id is null and not py.opening
      and py.paid_on between p_from and p_to
      and (p_campaign is null or py.student_id in (select l.student_id from public.leads l
                                                   where l.campaign_id = p_campaign and l.student_id is not null))
      and (not sc or public.student_in_scope(py.student_id))
  ), live as (
    select * from p where not exists (select 1 from public.payments r where r.reverses_id = p.id)
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'campaign_id', p_campaign, 'money_hidden', not money,
    'payments', (select count(*) from live),
    'reversed', (select count(*) from p) - (select count(*) from live),
    'total', case when money then (select coalesce(sum(amount), 0) from live) end,
    'by_mode', (select coalesce(jsonb_agg(jsonb_build_object('mode', x.mode, 'payments', x.n,
                                                             'amount', case when money then x.amt end) order by x.mode), '[]'::jsonb)
                from (select mode, count(*) as n, sum(amount) as amt from live group by mode) x),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', x.paid_on, 'payments', x.n,
                                                            'amount', case when money then x.amt end) order by x.paid_on), '[]'::jsonb)
               from (select paid_on, count(*) as n, sum(amount) as amt from live group by paid_on) x))
  into out;
  perform public.scope_pop(prev);
  return out;
end $$;
revoke all on function public.ledger_collected(uuid, date, date, uuid, uuid, uuid) from public, anon;
grant execute on function public.ledger_collected(uuid, date, date, uuid, uuid, uuid) to authenticated;

-- report_fee_promise_rows: as in 20261025150000, leads in scope (the lead's centre, and its student's batch).
create or replace function public.report_fee_promise_rows(p_institute uuid, p_campaign uuid, p_seat uuid)
returns table (lead_id uuid, name text, extra jsonb, student_id uuid, lead_status text, promised_date date,
               promised_amount numeric, promised_on date, seat_id uuid, campaign_id uuid, next_call_at timestamptz,
               paid numeric, paid_on date, paid_mode text, ledger_state text, days_late int)
language sql stable security definer set search_path = public
as $$
  with d as materialized (
    select public.ledger_today(p_institute) as today, public.institute_tz(p_institute) as tz,
           public.scope_active(p_institute) as scoped
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
      and (not d.scoped or public.in_scope(p_institute, l.centre_id,
                                           (select st.batch_id from public.students st where st.id = l.student_id), 'row'))
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
revoke all on function public.report_fee_promise_rows(uuid, uuid, uuid) from public, anon, authenticated;

-- home_calls: as in 20261024100023, calls in scope (the lead's centre, else the calling list's).
create or replace function public.home_calls(p_institute uuid, p_from timestamptz, p_to timestamptz)
returns table (root_id uuid, seat_id uuid, campaign_id uuid, result_key text, outcome text,
               connected_seconds int, script_id text, end_step text, amount numeric, happened_at timestamptz)
language sql stable security definer set search_path = public
as $$
  with recursive sc as materialized (select public.scope_active(p_institute) as scoped),
  roots as (
    select c.id, c.uploaded_at
    from public.call_outcomes c cross join sc
    where c.institute_id = p_institute
      and c.corrects_id is null
      and coalesce(c.dialled_at, c.uploaded_at) >= p_from
      and coalesce(c.dialled_at, c.uploaded_at) < p_to
      and (not sc.scoped or public.in_scope(p_institute,
             coalesce((select l.centre_id from public.leads l where l.id = c.lead_id),
                      (select k.centre_id from public.campaigns k where k.id = c.campaign_id)), null, 'call'))
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
  select l.root_id, o.seat_id, coalesce(o.campaign_id, r.campaign_id), o.result_key, o.outcome,
         o.connected_seconds, coalesce(o.script_id, r.script_id),
         coalesce(o.reached_step, o.script_step, r.reached_step, r.script_step), o.amount,
         coalesce(r.dialled_at, r.uploaded_at)
  from latest l
  join public.call_outcomes o on o.id = l.node
  join public.call_outcomes r on r.id = l.root_id;
$$;
revoke all on function public.home_calls(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- ledger_day_closing: as in 20261026110000, payments of students in scope, for one centre (null = all) and
-- batch. The two-argument function (below) is the same with no centre.
create function public.ledger_day_closing(p_institute uuid, p_day date, p_centre uuid, p_batch uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  money boolean;
  today date;
  dy    date;
  tz    text;
  out   jsonb;
  prev  text[];
  sc    boolean;
begin
  if not public.can_read_ledger(p_institute) then
    raise exception 'only accounts, owners and managers can see collections' using errcode = '42501';
  end if;
  money := public.can_see_money(p_institute);
  today := public.ledger_today(p_institute);
  tz := public.institute_tz(p_institute);
  dy := coalesce(p_day, today);
  if dy < date '2000-01-01' or dy > today + 366 then raise exception 'check the date' using errcode = '22023'; end if;
  prev := public.scope_push(p_institute, p_centre, p_batch);
  sc := public.scope_active(p_institute);
  with pay as (
    select p.*, not exists (select 1 from public.payments r where r.reverses_id = p.id) as live,
           (select r.note from public.payments r where r.reverses_id = p.id) as rev_reason,
           s.name as student, s.class_label, s.section, s.admission_no,
           (select se.label from public.seats se where se.id = p.recorded_by) as by_label
    from public.payments p join public.students s on s.id = p.student_id
    where p.institute_id = p_institute and p.paid_on = dy and p.reverses_id is null and not p.opening
      and (not sc or public.in_scope(p_institute, s.centre_id, s.batch_id, 'row'))
  ), rev as (
    select r.*, s.name as student, s.class_label, s.section,
           (select se.label from public.seats se where se.id = r.recorded_by) as by_label
    from public.payments r join public.students s on s.id = r.student_id
    where r.institute_id = p_institute and r.reverses_id is not null and not r.opening
      and (r.paid_on = dy or (r.created_at at time zone tz)::date = dy)
      and (not sc or public.in_scope(p_institute, s.centre_id, s.batch_id, 'row'))
  )
  select jsonb_build_object(
    'day', dy, 'today', today, 'money_hidden', not money,
    'totals', (select jsonb_build_object(
        'payments', count(*) filter (where live),
        'amount', case when money then coalesce(sum(amount) filter (where live), 0) end,
        'reversed', count(*) filter (where not live),
        'reversed_amount', case when money then coalesce(sum(amount) filter (where not live), 0) end,
        'cheques', count(*) filter (where live and mode = 'cheque'),
        'cheque_amount', case when money then coalesce(sum(amount) filter (where live and mode = 'cheque'), 0) end) from pay),
    'by_mode', (select jsonb_agg(jsonb_build_object('mode', m.mode,
                   'payments', (select count(*) from pay where live and pay.mode = m.mode),
                   'amount', case when money then (select coalesce(sum(amount), 0) from pay where live and pay.mode = m.mode) end)
                 order by m.ord)
                from unnest(array['cash', 'upi', 'cheque', 'card', 'bank', 'other']) with ordinality as m(mode, ord)),
    'by_person', (select coalesce(jsonb_agg(jsonb_build_object('seat_id', z.recorded_by, 'label', coalesce(z.by_label, 'Unknown'),
                     'payments', z.n, 'amount', case when money then z.amt end) order by z.amt desc, z.by_label), '[]'::jsonb)
                  from (select recorded_by, by_label, count(*) as n, sum(amount) as amt from pay where live
                        group by recorded_by, by_label) z),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', created_at, 'student_id', student_id,
                    'student', student, 'class_label', class_label, 'section', section, 'admission_no', admission_no,
                    'amount', case when money then amount end, 'mode', mode, 'reference', reference, 'note', note,
                    'recorded_by_label', by_label, 'reversed', not live, 'reversed_reason', rev_reason)
                    order by created_at, id), '[]'::jsonb) from pay),
    'cheques', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'at', created_at, 'student_id', student_id,
                    'student', student, 'class_label', class_label, 'section', section,
                    'amount', case when money then amount end, 'reference', reference, 'note', note,
                    'recorded_by_label', by_label) order by created_at, id), '[]'::jsonb)
                from pay where live and mode = 'cheque'),
    'reversals', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'of_id', reverses_id, 'at', created_at,
                    'student_id', student_id, 'student', student, 'class_label', class_label, 'section', section,
                    'amount', case when money then amount end, 'mode', mode,
                    'reference', (select o.reference from public.payments o where o.id = rev.reverses_id),
                    'reason', note, 'recorded_by_label', by_label, 'paid_on', paid_on) order by created_at, id), '[]'::jsonb)
                  from rev))
  into out;
  perform public.scope_pop(prev);
  return out;
end $$;
revoke all on function public.ledger_day_closing(uuid, date, uuid, uuid) from public, anon;
grant execute on function public.ledger_day_closing(uuid, date, uuid, uuid) to authenticated;
create or replace function public.ledger_day_closing(p_institute uuid, p_day date default null)
returns jsonb
language sql security definer set search_path = public
as $$ select public.ledger_day_closing(p_institute, p_day, null::uuid, null::uuid) $$;

-- accounts_students: as in 20261025130000 (students in scope through student_balance_rows), with two more
-- filters, centre_id and batch_id (ids), and four more columns: centre_id, batch_id, batch_name, centre_name.
drop function public.accounts_students(jsonb);
create function public.accounts_students(p_filters jsonb default '{}'::jsonb)
returns table (student_id uuid, admission_no text, name text, class_label text, section text, board text,
               academic_year text, parent_name text, phone text, alt_phone text, status text, source text,
               total_fees numeric, total_due_to_date numeric, paid numeric, balance_due_now numeric,
               balance_total numeric, last_payment_amount numeric, last_payment_on date, last_payment_mode text,
               money_hidden boolean, total_rows bigint, centre_id uuid, batch_id uuid, batch_name text, centre_name text)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat  public.seats;
  f     jsonb := coalesce(p_filters, '{}'::jsonb);
  money boolean;
  cls   text := nullif(trim(coalesce(f ->> 'class_label', '')), '');
  brd   text := nullif(trim(coalesce(f ->> 'board', '')), '');
  q     text := nullif(trim(coalesce(f ->> 'search', '')), '');
  qd    text;
  yr    text := nullif(trim(coalesce(f ->> 'academic_year', '')), '');
  due   boolean := coalesce((f ->> 'only_due')::boolean, false);
  sts   text := coalesce(nullif(trim(coalesce(f ->> 'status', '')), ''), 'active');
  lim   int := coalesce((f ->> 'limit')::int, 500);
  off   int := coalesce((f ->> 'offset')::int, 0);
  fc    uuid;
  fb    uuid;
  prev  text[];
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.can_read_ledger(seat.institute_id) then
    raise exception 'only accounts, owners and managers can see the ledger' using errcode = '42501';
  end if;
  if lim not between 1 and 5000 or off < 0 then raise exception 'limit must be 1 to 5000' using errcode = '22023'; end if;
  if sts not in ('active', 'left', 'all') then raise exception 'status must be active, left or all' using errcode = '22023'; end if;
  begin
    fc := nullif(trim(coalesce(f ->> 'centre_id', '')), '')::uuid;
    fb := nullif(trim(coalesce(f ->> 'batch_id', '')), '')::uuid;
  exception when others then
    raise exception 'centre and batch must be ids' using errcode = '22023';
  end;
  if brd is not null then brd := public.campaign_check_tags(null, brd); end if;
  qd := nullif(regexp_replace(coalesce(q, ''), '[^0-9]', '', 'g'), '');
  money := public.can_see_money(seat.institute_id);
  prev := public.scope_push(seat.institute_id, fc, fb);
  return query
    select s.id, s.admission_no, s.name, s.class_label, s.section, s.board, s.academic_year, s.parent_name,
           s.phone, s.alt_phone, s.status, s.source,
           case when money then b.total_fees end, case when money then b.total_due_to_date end,
           case when money then b.paid end, case when money then b.balance_due_now end,
           case when money then b.balance_total end, case when money then b.last_payment_amount end,
           b.last_payment_on, b.last_payment_mode, not money, count(*) over (),
           s.centre_id, s.batch_id, bt.name, ce.name
    from public.students s
    join public.student_balance_rows(seat.institute_id) b on b.student_id = s.id
    left join public.batches bt on bt.id = s.batch_id
    left join public.centres ce on ce.id = s.centre_id
    where s.institute_id = seat.institute_id
      and (sts = 'all' or s.status = sts)
      and (cls is null or lower(s.class_label) = lower(cls))
      and (brd is null or s.board = brd)
      and (yr is null or s.academic_year = yr)
      and (not due or b.balance_due_now > 0)
      and (q is null or s.name ilike '%' || q || '%' or s.admission_no ilike q || '%'
           or s.parent_name ilike '%' || q || '%'
           or (qd is not null and length(qd) >= 4 and (s.phone like '%' || qd || '%' or s.alt_phone like '%' || qd || '%')))
    order by s.class_label nulls last, s.section nulls last, s.name, s.id
    limit lim offset off;
  perform public.scope_pop(prev);
end $$;
revoke all on function public.accounts_students(jsonb) from public, anon;
grant execute on function public.accounts_students(jsonb) to authenticated;

-- =====================================================================================================
-- 6. Lists and totals for one centre or batch. Each old function stays as it was (it already sees only the
--    person's centres); a second function of the same name takes the old arguments (all needed) plus p_centre
--    (needed, null = every centre) and p_batch (default null), sets the filter and calls the old one. A call
--    with p_centre goes to the new function, a call without it to the old one, so old calls keep working.
-- =====================================================================================================

-- Reports > Fees collection, the Fees cards, the checklist.
create or replace function public.admin_fees_ledger(p_institute uuid, p_from date, p_to date, p_campaign uuid,
                                                    p_seat uuid, p_centre uuid, p_batch uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  prev text[];
  out  jsonb;
begin
  perform public.report_require_ledger(p_institute);
  prev := public.scope_push(p_institute, p_centre, p_batch);
  out := public.admin_fees_ledger(p_institute, p_from, p_to, p_campaign, p_seat);
  perform public.scope_pop(prev);
  return out || jsonb_build_object('centre_id', p_centre, 'batch_id', p_batch);
end $$;

-- "Promises due this week".
create or replace function public.admin_promises_ledger(p_institute uuid, p_campaign uuid, p_seat uuid, p_days int,
                                                        p_centre uuid, p_batch uuid default null)
returns table (lead_id uuid, name text, extra jsonb, student_id uuid, amount numeric, promised_date date,
               days_late int, promised_on date, seat_id uuid, caller text, campaign_id uuid, campaign text,
               next_call_at timestamptz, lead_status text, ledger_state text, paid_amount numeric, paid_on date,
               paid_mode text, money_hidden boolean)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare prev text[];
begin
  perform public.report_require_ledger(p_institute);
  prev := public.scope_push(p_institute, p_centre, p_batch);
  return query select * from public.admin_promises_ledger(p_institute, p_campaign, p_seat, coalesce(p_days, 7));
  perform public.scope_pop(prev);
end $$;

-- Today: collected today, promises due today, follow-ups returned.
create or replace function public.admin_home_ledger(p_day text, p_campaign uuid, p_centre uuid, p_batch uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  prev text[];
  out  jsonb;
begin
  seat := public.home_admin_seat();
  prev := public.scope_push(seat.institute_id, p_centre, p_batch);
  out := public.admin_home_ledger(coalesce(p_day, 'today'), p_campaign);
  perform public.scope_pop(prev);
  return out;
end $$;

-- Today: the day's numbers (calls of the centre's leads and lists).
create or replace function public.admin_home_summary(p_day text, p_campaign uuid, p_centre uuid, p_batch uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  prev text[];
  out  jsonb;
begin
  seat := public.home_admin_seat();
  prev := public.scope_push(seat.institute_id, p_centre, p_batch);
  out := public.admin_home_summary(coalesce(p_day, 'today'), p_campaign);
  perform public.scope_pop(prev);
  return out;
end $$;

-- Autopilot's three numbers (fees of the centre's students).
create or replace function public.autopilot_numbers(p_centre uuid, p_batch uuid default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  prev text[];
  out  jsonb;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an owner or manager can see these numbers' using errcode = '42501';
  end if;
  prev := public.scope_push(seat.institute_id, p_centre, p_batch);
  out := public.autopilot_numbers();
  perform public.scope_pop(prev);
  return out;
end $$;

-- A suggestion card is in scope when its plan has no centre, or the centre is allowed and matches the filter.
create or replace function public.ap_card_in_scope(p_inst uuid, p_card jsonb, p_centre uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.centre_allowed(p_inst, c) and (p_centre is null or c is null or c = p_centre)
  from (select nullif(p_card -> 'plan' ->> 'centre_id', '')::uuid as c) x
$$;

-- my_suggestions(): as in 20261026120000, without the cards of centres the person does not work in.
alter function public.my_suggestions() rename to my_suggestions__base;
revoke all on function public.my_suggestions__base() from public, anon, authenticated;
create function public.my_suggestions()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  out  jsonb;
  inst uuid;
begin
  out := public.my_suggestions__base();
  inst := (public.my_active_seat()).institute_id;
  if public.my_centre_ids(inst) is null then return out; end if;
  return out || jsonb_build_object(
    'cards', (select coalesce(jsonb_agg(c order by n), '[]'::jsonb) from jsonb_array_elements(out -> 'cards') with ordinality e(c, n)
              where public.ap_card_in_scope(inst, c, null)),
    'feed', (select coalesce(jsonb_agg(c order by n), '[]'::jsonb) from jsonb_array_elements(out -> 'feed') with ordinality e(c, n)
             where public.ap_card_in_scope(inst, c, null)));
end $$;

-- Today's cards and feed for one centre: its cards and the cards for every centre.
create function public.my_suggestions(p_centre uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  out  jsonb;
  inst uuid;
  prev text[];
begin
  out := public.my_suggestions();
  inst := (public.my_active_seat()).institute_id;
  prev := public.scope_push(inst, p_centre, null);   -- checks the centre
  perform public.scope_pop(prev);
  return out || jsonb_build_object(
    'centre_id', p_centre,
    'cards', (select coalesce(jsonb_agg(c order by n), '[]'::jsonb) from jsonb_array_elements(out -> 'cards') with ordinality e(c, n)
              where public.ap_card_in_scope(inst, c, p_centre)),
    'feed', (select coalesce(jsonb_agg(c order by n), '[]'::jsonb) from jsonb_array_elements(out -> 'feed') with ordinality e(c, n)
             where public.ap_card_in_scope(inst, c, p_centre)));
end $$;

-- admin_campaign_list(): as before, without lists of centres the person does not work in.
alter function public.admin_campaign_list() rename to admin_campaign_list__base;
revoke all on function public.admin_campaign_list__base() from public, anon, authenticated;
create function public.admin_campaign_list()
returns table (id uuid, name text, status text, call_type_id uuid, call_type_key text, call_type_label text,
               script_id uuid, script_name text, start_date date, end_date date, daily_target int,
               share_mode text, leads_total bigint, leads_called bigint, leads_open bigint,
               leads_unassigned bigint, callers jsonb, created_at timestamptz, updated_at timestamptz,
               open_to_all boolean, class_label text, board text)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  return query
    select b.* from public.admin_campaign_list__base() b
    join public.campaigns c on c.id = b.id
    where public.centre_allowed(c.institute_id, c.centre_id);
end $$;

-- Calling lists of one centre (and batch), lists for every centre too; with their centre and batch.
create function public.admin_campaign_list(p_centre uuid, p_batch uuid default null)
returns table (id uuid, name text, status text, call_type_id uuid, call_type_key text, call_type_label text,
               script_id uuid, script_name text, start_date date, end_date date, daily_target int,
               share_mode text, leads_total bigint, leads_called bigint, leads_open bigint,
               leads_unassigned bigint, callers jsonb, created_at timestamptz, updated_at timestamptz,
               open_to_all boolean, class_label text, board text, centre_id uuid, batch_id uuid)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
  prev text[];
begin
  seat := public.campaign_admin_seat();
  prev := public.scope_push(seat.institute_id, p_centre, p_batch);
  return query
    select b.id, b.name, b.status, b.call_type_id, b.call_type_key, b.call_type_label, b.script_id, b.script_name,
           b.start_date, b.end_date, b.daily_target, b.share_mode, b.leads_total, b.leads_called, b.leads_open,
           b.leads_unassigned, b.callers, b.created_at, b.updated_at, b.open_to_all, b.class_label, b.board,
           c.centre_id, c.batch_id
    from public.admin_campaign_list__base() b
    join public.campaigns c on c.id = b.id
    where public.in_scope(c.institute_id, c.centre_id, c.batch_id, 'list');
  perform public.scope_pop(prev);
end $$;

-- admin_callers(p_institute): as before, without people of centres the viewer does not work in.
alter function public.admin_callers(uuid) rename to admin_callers__base;
revoke all on function public.admin_callers__base(uuid) from public, anon, authenticated;
create function public.admin_callers(p_institute uuid)
returns table (seat_id uuid, label text, access_role text, can_see_money boolean, status text,
               campaigns jsonb, calls_today bigint, calls_target int, now_status jsonb)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare lim uuid[];
begin
  lim := public.my_centre_ids(p_institute);
  return query
    select b.* from public.admin_callers__base(p_institute) b
    join public.seats s on s.id = b.seat_id
    where lim is null or s.centre_ids is null or s.centre_ids && lim;
end $$;

-- Team for one centre: the people of that centre and the people of every centre, with their centres.
create function public.admin_callers(p_institute uuid, p_centre uuid)
returns table (seat_id uuid, label text, access_role text, can_see_money boolean, status text,
               campaigns jsonb, calls_today bigint, calls_target int, now_status jsonb, centre_ids uuid[])
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare prev text[];
begin
  perform public.admin_require(p_institute);
  prev := public.scope_push(p_institute, p_centre, null);   -- checks the centre
  perform public.scope_pop(prev);
  return query
    select b.seat_id, b.label, b.access_role, b.can_see_money, b.status, b.campaigns, b.calls_today, b.calls_target,
           b.now_status, s.centre_ids
    from public.admin_callers(p_institute) b
    join public.seats s on s.id = b.seat_id
    where p_centre is null or s.centre_ids is null or p_centre = any (s.centre_ids);
end $$;

-- A fees calling list from the ledger for one centre or batch (its students only). The old function (no
-- centre) still makes a list of every student the person may see.
create or replace function public.accounts_create_fees_campaign(
  p_name text, p_class_label text, p_board text, p_due_by date, p_min_due numeric, p_script uuid,
  p_open_to_all boolean, p_start boolean, p_centre uuid, p_batch uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  prev text[];
  cid  uuid;
  cen  uuid := p_centre;
  lim  uuid[];
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  prev := public.scope_push(seat.institute_id, p_centre, p_batch);
  cid := public.accounts_create_fees_campaign(p_name, p_class_label, p_board, p_due_by, coalesce(p_min_due, 0), p_script,
                                              coalesce(p_open_to_all, true), coalesce(p_start, true));
  perform public.scope_pop(prev);
  if cen is null and p_batch is not null then select b.centre_id into cen from public.batches b where b.id = p_batch; end if;
  if cen is null then
    lim := public.my_centre_ids(seat.institute_id);
    if cardinality(lim) = 1 then cen := lim[1]; end if;
  end if;
  if cen is not null or p_batch is not null then
    update public.campaigns set centre_id = cen, batch_id = p_batch where id = cid;
  end if;
  return cid;
end $$;

-- Lead upload into a list: leads with no student in a list for every centre get p_centre (the page's centre).
create or replace function public.admin_add_leads(p_campaign uuid, p_rows jsonb, p_centre uuid)
returns table (added int, bad_numbers int, repeats int, other_skipped int)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  inst uuid;
  old  text := coalesce(current_setting('vector.new_centre', true), '');
begin
  if p_centre is not null then
    select c.institute_id into inst from public.campaigns c where c.id = p_campaign;
    if inst is null or not public.is_admin_of(inst) then raise exception 'campaign not found' using errcode = '42501'; end if;
    if not exists (select 1 from public.centres c where c.id = p_centre and c.institute_id = inst)
       or not public.centre_allowed(inst, p_centre) then
      raise exception 'centre not found' using errcode = '42501';
    end if;
    perform set_config('vector.new_centre', p_centre::text, true);
  end if;
  return query select * from public.admin_add_leads(p_campaign, p_rows);
  perform set_config('vector.new_centre', old, true);
end $$;

-- One student by hand: p_data may also carry centre_id (or centre: a name or short code) and batch_id (or
-- batch: a name). A person limited to some centres can put students only in those.
alter function public.accounts_save_student(uuid, jsonb) rename to accounts_save_student__base;
revoke all on function public.accounts_save_student__base(uuid, jsonb) from public, anon, authenticated;
create function public.accounts_save_student(p_student uuid, p_data jsonb)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  inst  uuid;
  d     jsonb := coalesce(p_data, '{}'::jsonb);
  has_c boolean;
  has_b boolean;
  c     uuid;
  b     uuid;
  sid   uuid;
  old_c text := coalesce(current_setting('vector.new_centre', true), '');
  old_b text := coalesce(current_setting('vector.new_batch', true), '');
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  inst := seat.institute_id;
  if jsonb_typeof(d) <> 'object' then raise exception 'send the student as an object' using errcode = '22023'; end if;
  has_c := d ? 'centre_id' or d ? 'centre';
  has_b := d ? 'batch_id' or d ? 'batch';
  if has_c then
    c := public.centre_from_text(inst, coalesce(d ->> 'centre_id', d ->> 'centre'));
    if c is not null and not public.centre_allowed(inst, c) then
      raise exception 'you can add students only to your own centres' using errcode = '42501';
    end if;
  end if;
  if has_b then
    b := public.batch_from_text(inst, c, coalesce(d ->> 'batch_id', d ->> 'batch'));
    if b is not null and not public.centre_allowed(inst, (select x.centre_id from public.batches x where x.id = b)) then
      raise exception 'you can add students only to your own centres' using errcode = '42501';
    end if;
  end if;
  d := d - 'centre_id' - 'centre' - 'batch_id' - 'batch';
  if p_student is null then
    perform set_config('vector.new_centre', coalesce(c::text, ''), true);
    perform set_config('vector.new_batch', coalesce(b::text, ''), true);
    sid := public.accounts_save_student__base(null, d);
    perform set_config('vector.new_centre', old_c, true);
    perform set_config('vector.new_batch', old_b, true);
  else
    sid := public.accounts_save_student__base(p_student, d);
    if has_c or has_b then
      update public.students s set
        centre_id = case when has_c then c else s.centre_id end,
        batch_id = case when has_b then b
                        when has_c and exists (select 1 from public.batches x where x.id = s.batch_id
                                                 and x.centre_id is not null and x.centre_id is distinct from c) then null
                        else s.batch_id end
       where s.id = sid;
    end if;
  end if;
  return sid;
end $$;

-- Import: each row may also carry centre (a name, short code or id) and batch (a name or id). A row naming an
-- unknown centre or batch, a centre the person does not work in, or a student of another centre is skipped
-- with that reason. A person limited to one centre imports into it.
alter function public.accounts_import_students(jsonb) rename to accounts_import_students__base;
revoke all on function public.accounts_import_students__base(jsonb) from public, anon, authenticated;
create function public.accounts_import_students(p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  inst  uuid;
  lim   uuid[];
  rows_ jsonb := '[]'::jsonb;
  r     jsonb;
  i     int := 0;
  c     uuid;
  b     uuid;
  cs    uuid[] := '{}';
  bs    uuid[] := '{}';
  bad   jsonb := '{}'::jsonb;
  adm   text;
  sid   uuid;
  res   jsonb;
  skip  int[];
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  inst := seat.institute_id;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return public.accounts_import_students__base(p_rows); end if;
  lim := public.my_centre_ids(inst);
  for r in select e from jsonb_array_elements(p_rows) e loop
    i := i + 1;
    c := null; b := null;
    if jsonb_typeof(r) = 'object' then
      begin
        c := public.centre_from_text(inst, coalesce(r ->> 'centre_id', r ->> 'centre'));
        b := public.batch_from_text(inst, c, coalesce(r ->> 'batch_id', r ->> 'batch'));
        if c is null and b is not null then select x.centre_id into c from public.batches x where x.id = b; end if;
        if c is not null and not public.centre_allowed(inst, c) then
          raise exception 'a centre you do not work in' using errcode = '22023';
        end if;
        adm := nullif(trim(coalesce(r ->> 'admission_no', '')), '');
        if adm is not null and exists (select 1 from public.students s where s.institute_id = inst
                                         and lower(s.admission_no) = lower(left(adm, 40))
                                         and not public.centre_allowed(inst, s.centre_id)) then
          raise exception 'a student of another centre' using errcode = '22023';
        end if;
        if c is null and cardinality(lim) = 1 then c := lim[1]; end if;
        r := r - 'centre_id' - 'centre' - 'batch_id' - 'batch';
      exception when sqlstate '22023' then
        bad := bad || jsonb_build_object(i::text, sqlerrm);
        r := 'null'::jsonb;
        c := null; b := null;
      end;
    end if;
    rows_ := rows_ || jsonb_build_array(r);
    cs := cs || c;
    bs := bs || b;
  end loop;

  res := public.accounts_import_students__base(rows_);
  if bad <> '{}'::jsonb then
    res := jsonb_set(res, '{skipped_rows}', (select coalesce(jsonb_agg(case when bad ? (x ->> 'row')
                                                    then jsonb_build_object('row', (x ->> 'row')::int, 'reason', bad ->> (x ->> 'row'))
                                                    else x end), '[]'::jsonb)
                                             from jsonb_array_elements(res -> 'skipped_rows') x));
  end if;
  select coalesce(array_agg((x ->> 'row')::int), '{}') into skip from jsonb_array_elements(res -> 'skipped_rows') x;

  -- The centre and batch of the students of the rows that went in.
  i := 0;
  for r in select e from jsonb_array_elements(rows_) e loop
    i := i + 1;
    continue when jsonb_typeof(r) <> 'object' or (cs[i] is null and bs[i] is null) or i = any (skip);
    sid := null;
    adm := nullif(left(trim(coalesce(r ->> 'admission_no', '')), 40), '');
    if adm is not null then
      select s.id into sid from public.students s where s.institute_id = inst and lower(s.admission_no) = lower(adm);
    else
      select s.id into sid from public.students s
       where s.institute_id = inst and s.created_at = now() and s.created_by = seat.id
         and s.name = left(trim(coalesce(r ->> 'name', '')), 120)
         and s.phone is not distinct from public.normalise_phone(nullif(trim(coalesce(r ->> 'phone', '')), ''))
       order by s.id limit 1;
    end if;
    continue when sid is null;
    update public.students s set
      centre_id = coalesce(cs[i], s.centre_id),
      batch_id = case when bs[i] is not null then bs[i]
                      when cs[i] is not null and exists (select 1 from public.batches x where x.id = s.batch_id
                                                           and x.centre_id is not null and x.centre_id <> cs[i]) then null
                      else s.batch_id end
     where s.id = sid;
  end loop;
  return res;
end $$;

-- Planning is system work: the rules see every centre whoever asks for a plan.
alter function public.autopilot_plan(uuid) rename to autopilot_plan__base;
revoke all on function public.autopilot_plan__base(uuid) from public, anon, authenticated;
create function public.autopilot_plan(p_institute uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  prev text[];
  out  jsonb;
begin
  if auth.uid() is not null and not public.is_admin_of(p_institute) then
    raise exception 'only an owner or manager of this institute can plan' using errcode = '42501';
  end if;
  prev := public.scope_push(p_institute, null, null, false);
  out := public.autopilot_plan__base(p_institute);
  perform public.scope_pop(prev);
  return out;
end $$;

-- =====================================================================================================
-- 7. Autopilot: the fees-due rule per centre
-- =====================================================================================================

-- ap_rule_fees_due_one: the rule of 20261026120000 for the students in scope (student_balance_rows), and an
-- existing list counts only when it is for this centre or for every centre.
alter function public.ap_rule_fees_due(uuid) rename to ap_rule_fees_due_one;
revoke all on function public.ap_rule_fees_due_one(uuid) from public, anon, authenticated;
create or replace function public.ap_rule_fees_due_one(p_inst uuid)
returns setof jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  today  date := public.ledger_today(p_inst);
  r      record;
  camp   public.campaigns;
  n_par  int;
  n_noph int;
  amt    numeric;
  common jsonb;
  tmpl   jsonb;
  scr    record;
  nm     text;
  wa     boolean := exists (select 1 from public.whatsapp_accounts a where a.institute_id = p_inst and a.status = 'connected');
  ctext  text;
begin
  for r in
    with plan_groups as (
      select lower(p.class_label) as cls_key, min(p.class_label) as cls, p.board, i.due_date,
             coalesce(mode() within group (order by i.head) filter (where i.who = 'all'), min(i.head)) as head
      from public.fee_plans p
      join public.fee_plan_items i on i.plan_id = p.id and i.removed_at is null
      where p.institute_id = p_inst and i.due_date between today and today + 7
      group by 1, p.board, i.due_date
    ), item_groups as (
      select lower(s.class_label) as cls_key, min(s.class_label) as cls, s.board, f.due_date,
             coalesce(mode() within group (order by f.head) filter (where f.head !~* '(bus|transport)'), min(f.head)) as head
      from public.fee_items f
      join public.students s on s.id = f.student_id
      where f.institute_id = p_inst and not f.is_void and s.status = 'active' and s.class_label is not null
        and f.due_date between today and today + 7
        and not exists (select 1 from public.fee_plans p where p.institute_id = p_inst and lower(p.class_label) = lower(s.class_label)
                          and p.board is not distinct from s.board)
      group by 1, s.board, f.due_date
    )
    select * from plan_groups union all select * from item_groups
    order by due_date, cls_key, board
  loop
    select count(distinct s.phone), count(*) filter (where s.phone is null), sum(b.balance_due_now)
      into n_par, n_noph, amt
    from public.students s
    join public.student_balance_rows(p_inst, null, r.due_date) b on b.student_id = s.id
    where s.institute_id = p_inst and s.status = 'active' and lower(s.class_label) = r.cls_key
      and s.board is not distinct from r.board and b.balance_due_now > 0;
    continue when coalesce(n_par, 0) = 0;
    ctext := coalesce(public.ap_class_text(r.cls, r.board), r.cls);

    select c.* into camp from public.campaigns c join public.call_types t on t.id = c.call_type_id and t.key = 'fees'
     where c.institute_id = p_inst and c.status in ('draft', 'running', 'paused')
       and lower(coalesce(c.class_label, '')) = r.cls_key and c.board is not distinct from r.board
       and (c.fees_due_by between r.due_date - 3 and r.due_date + 3
            or (c.fees_due_by is null and c.created_at > now() - interval '30 days'))
       and public.in_scope(p_inst, c.centre_id, c.batch_id, 'list')
     order by c.created_at desc limit 1;
    if camp.id is not null then
      select count(distinct s.phone), sum(b.balance_due_now) into n_par, amt
      from public.students s
      join public.student_balance_rows(p_inst, null, r.due_date) b on b.student_id = s.id
      where s.institute_id = p_inst and s.status = 'active' and lower(s.class_label) = r.cls_key
        and s.board is not distinct from r.board and b.balance_due_now > 0 and s.phone is not null
        and not exists (select 1 from public.leads l where l.campaign_id = camp.id and (l.student_id = s.id or l.phone = s.phone));
      continue when coalesce(n_par, 0) = 0;
      return next jsonb_build_object(
        'kind', 'fees_due_list', 'key', 'fees_topup:' || camp.id || ':' || r.due_date || ':' || today,
        'title', 'Add ' || public.ap_n(n_par, 'parent', 'parents') || ' to "' || camp.name || '"',
        'why', jsonb_build_object('text', public.ap_n(n_par, 'parent', 'parents') || ' of ' || ctext || ' owe fees due '
                                          || to_char(r.due_date, 'FMDD Mon') || ' and are not on the list yet.',
                                  'parents', n_par, 'due_date', r.due_date, 'amount', amt),
        'impact', jsonb_build_object('text', 'Their callers reach them before the due date.'),
        'plan', jsonb_build_object('action', 'topup', 'call_type', 'fees', 'campaign_id', camp.id, 'name', camp.name,
                                   'class_label', r.cls, 'board', r.board, 'due_by', r.due_date, 'parents', n_par),
        'priority', 15 + (r.due_date - today), 'expires_at', r.due_date + 1);
      continue;
    end if;

    nm := public.ap_list_name(r.head, r.cls, r.board, r.due_date);
    common := public.ap_plan_common(p_inst, 'fees', r.cls, n_par, r.due_date + 7);
    tmpl := public.ap_pick_template(p_inst, 'fees_reminder_polite');
    select * into scr from public.ap_pick_script(p_inst, 'fees', 'reminder');
    return next jsonb_build_object(
      'kind', 'fees_due_list', 'key', 'fees_list:' || r.cls_key || ':' || lower(coalesce(r.board, '')) || ':' || r.due_date,
      'title', 'Start "' || nm || '"',
      'why', jsonb_build_object('text', initcap(substr(r.head, 1, 1)) || substr(r.head, 2) || ' is due in '
                                        || public.ap_n(r.due_date - today, 'day', 'days') || ' (' || to_char(r.due_date, 'FMDD Mon')
                                        || '). ' || public.ap_n(n_par, 'parent', 'parents') || ' of ' || ctext || ' still owe it.',
                                'parents', n_par, 'no_phone', n_noph, 'due_date', r.due_date, 'days_left', r.due_date - today,
                                'amount', amt),
      'impact', jsonb_build_object('text', 'About ' || public.ap_n((common ->> 'daily_target')::int, 'call', 'calls')
                                           || ' a day; every parent called by ' || to_char((common ->> 'end_date')::date, 'FMDD Mon') || '.',
                                   'calls_per_day', common -> 'daily_target', 'finish_by', common -> 'end_date'),
      'plan', common || jsonb_build_object('action', 'create', 'call_type', 'fees', 'name', nm, 'class_label', r.cls,
                                           'board', r.board, 'due_by', r.due_date, 'parents', n_par, 'no_phone', n_noph,
                                           'template_key', tmpl ->> 'key', 'template_name', tmpl ->> 'name',
                                           'script_id', scr.id, 'script_name', scr.name, 'whatsapp', wa, 'amount', amt),
      'priority', 10 + (r.due_date - today), 'expires_at', r.due_date + 1);
  end loop;
end $$;
revoke all on function public.ap_rule_fees_due_one(uuid) from public, anon, authenticated;

-- A card of one centre: its key, plan (centre_id, centre_name) and, for a new list, the name end with the centre.
create or replace function public.ap_centre_card(p_card jsonb, p_centre uuid, p_name text)
returns jsonb
language plpgsql immutable set search_path = public
as $$
declare
  j  jsonb := p_card;
  nm text;
begin
  j := jsonb_set(j, '{key}', to_jsonb((j ->> 'key') || ':' || p_centre::text));
  j := jsonb_set(j, '{plan}', coalesce(j -> 'plan', '{}'::jsonb) || jsonb_build_object('centre_id', p_centre, 'centre_name', p_name));
  if j -> 'plan' ->> 'action' = 'create' then
    nm := left((j -> 'plan' ->> 'name') || ' · ' || p_name, 120);
    j := jsonb_set(j, '{plan,name}', to_jsonb(nm));
    j := jsonb_set(j, '{title}', to_jsonb(left('Start "' || nm || '"', 200)));
  end if;
  if j ? 'why' and j -> 'why' ? 'text' then
    j := jsonb_set(j, '{why,text}', to_jsonb((j -> 'why' ->> 'text') || ' (' || p_name || ')'));
  end if;
  return j;
end $$;
revoke all on function public.ap_centre_card(jsonb, uuid, text) from public, anon, authenticated;

-- The rule Autopilot runs: as before for an institute without centres; else once per active centre, each
-- card for that centre's students ("Term 2 fees – Class 8 State Board · Andheri").
create function public.ap_rule_fees_due(p_inst uuid)
returns setof jsonb language plpgsql security definer set search_path = public
as $$
declare
  c    record;
  j    jsonb;
  prev text[];
begin
  if not exists (select 1 from public.centres x where x.institute_id = p_inst and x.active) then
    return query select * from public.ap_rule_fees_due_one(p_inst);
    return;
  end if;
  for c in select x.id, x.name from public.centres x where x.institute_id = p_inst and x.active order by x.sort_order, x.name loop
    prev := public.scope_push(p_inst, c.id, null, false);
    for j in select * from public.ap_rule_fees_due_one(p_inst) loop
      return next public.ap_centre_card(j, c.id, c.name);
    end loop;
    perform public.scope_pop(prev);
  end loop;
end $$;
revoke all on function public.ap_rule_fees_due(uuid) from public, anon, authenticated;

-- A fees list from a plan with a centre: that centre's students; the new list carries the centre.
alter function public.ap_exec_fees_list(uuid, jsonb, uuid) rename to ap_exec_fees_list__base;
revoke all on function public.ap_exec_fees_list__base(uuid, jsonb, uuid) from public, anon, authenticated;
create function public.ap_exec_fees_list(p_inst uuid, p_plan jsonb, p_seat uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  cen  uuid;
  prev text[];
  out  jsonb;
begin
  begin
    cen := nullif(p_plan ->> 'centre_id', '')::uuid;
  exception when others then
    raise exception 'the plan has a bad centre' using errcode = '22023';
  end;
  if cen is null then return public.ap_exec_fees_list__base(p_inst, p_plan, p_seat); end if;
  if p_seat is not null and not public.centre_allowed(p_inst, cen) then
    raise exception 'you can see only your own centres' using errcode = '42501';
  end if;
  prev := public.scope_push(p_inst, cen, null, false);
  out := public.ap_exec_fees_list__base(p_inst, p_plan, p_seat);
  perform public.scope_pop(prev);
  if coalesce(p_plan ->> 'action', 'create') <> 'topup' then
    update public.campaigns set centre_id = cen where id = (out -> 'result' ->> 'campaign_id')::uuid and institute_id = p_inst;
  end if;
  return out;
end $$;
revoke all on function public.ap_exec_fees_list(uuid, jsonb, uuid) from public, anon, authenticated;

-- =====================================================================================================
-- 8. Collect fee
-- =====================================================================================================

-- Students for the Collect screen, best match first: admission no (exact), name starts with the text, a word
-- of the name starts with it, every word starts a word of the name or the parent's name, admission no starts
-- with it, 4+ digits in a phone, name contains it (3+ letters). Active students in scope (the person's
-- centres, p_centre, p_batch). Due now and the year's balance only with money access. Ledger readers.
create or replace function public.collect_search(p_q text, p_centre uuid default null, p_batch uuid default null,
                                                 p_limit int default 12)
returns table (student_id uuid, name text, admission_no text, class_label text, section text, board text,
               batch_id uuid, batch_name text, centre_id uuid, centre_name text, parent_name text, phone text,
               due_now numeric, balance_total numeric, has_dues boolean, money_hidden boolean, rank int)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat  public.seats;
  inst  uuid;
  q     text := lower(left(regexp_replace(trim(coalesce(p_q, '')), '\s+', ' ', 'g'), 60));
  qe    text;
  qd    text;
  words text[];
  money boolean;
  lim   int := least(greatest(coalesce(p_limit, 12), 1), 50);
  prev  text[];
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.can_read_ledger(seat.institute_id) then
    raise exception 'only accounts, owners and managers can see the ledger' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  if q = '' then return; end if;
  qe := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  qd := regexp_replace(q, '[^0-9]', '', 'g');
  select array_agg(replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_')) into words
    from unnest(string_to_array(q, ' ')) w where w <> '';
  money := public.can_see_money(inst);
  prev := public.scope_push(inst, p_centre, p_batch);
  return query
    with m as (
      select s.*, case
          when lower(s.admission_no) = q then 0
          when lower(s.name) like qe || '%' then 1
          when ' ' || lower(s.name) like '% ' || qe || '%' then 2
          when not exists (select 1 from unnest(words) w
                           where not (' ' || lower(s.name) || ' ' || lower(coalesce(s.parent_name, '')) like '% ' || w || '%')) then 3
          when lower(s.admission_no) like qe || '%' then 4
          when length(qd) >= 4 and (s.phone like '%' || qd || '%' or s.alt_phone like '%' || qd || '%') then 5
          when length(q) >= 3 and lower(s.name) like '%' || qe || '%' then 6
        end as rk
      from public.students s
      where s.institute_id = inst and s.status = 'active'
        and public.in_scope(inst, s.centre_id, s.batch_id, 'row')
    ), top as (
      select * from m where m.rk is not null order by m.rk, m.name, m.id limit lim
    )
    select t.id, t.name, t.admission_no, t.class_label, t.section, t.board, t.batch_id, bt.name, t.centre_id, ce.name,
           t.parent_name, t.phone,
           case when money then b.balance_due_now end, case when money then b.balance_total end,
           coalesce(b.balance_due_now, 0) > 0, not money, t.rk
    from top t
    cross join lateral public.student_balance_rows(inst, t.id) b
    left join public.batches bt on bt.id = t.batch_id
    left join public.centres ce on ce.id = t.centre_id
    order by t.rk, t.name, t.id;
  perform public.scope_pop(prev);
end $$;

-- One student for the Collect form: who, the balance, and the fees not paid yet (oldest first: payments pay
-- the oldest fees first), for the amount chips. unpaid [{ fee_item_id, head, due_date, left, is_due }] (left
-- null without money access). whatsapp { connected, consent }: the institute's WhatsApp is connected, and a
-- lead of the student agreed to WhatsApp and is not do-not-call.
create or replace function public.collect_student(p_student uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  st    public.students;
  money boolean;
  b     record;
  today date;
begin
  st := public.ledger_student(p_student, false);
  money := public.can_see_money(st.institute_id);
  today := public.ledger_today(st.institute_id);
  select * into b from public.student_balance_rows(st.institute_id, st.id);
  return jsonb_build_object(
    'student', jsonb_build_object('id', st.id, 'name', st.name, 'admission_no', st.admission_no, 'class_label', st.class_label,
                                  'section', st.section, 'board', st.board, 'parent_name', st.parent_name, 'phone', st.phone,
                                  'centre_id', st.centre_id, 'batch_id', st.batch_id,
                                  'centre_name', (select c.name from public.centres c where c.id = st.centre_id),
                                  'batch_name', (select x.name from public.batches x where x.id = st.batch_id)),
    'today', today, 'money_hidden', not money,
    'due_now', case when money then b.balance_due_now end,
    'balance_total', case when money then b.balance_total end,
    'has_dues', coalesce(b.balance_due_now, 0) > 0,
    'unpaid', (select coalesce(jsonb_agg(jsonb_build_object('fee_item_id', u.id, 'head', u.head, 'due_date', u.due_date,
                                                             'left', case when money then u.lft end, 'is_due', u.due_date <= today)
                                         order by u.due_date, u.created_at, u.id), '[]'::jsonb)
               from (select f.*, greatest(0, least(f.net, f.cum - coalesce(b.paid, 0))) as lft
                     from (select fi.id, fi.head, fi.due_date, fi.created_at, public.fee_item_left(fi.id) as net,
                                  sum(public.fee_item_left(fi.id)) over (order by fi.due_date, fi.created_at, fi.id) as cum
                           from public.fee_items fi where fi.student_id = st.id and not fi.is_void) f) u
               where u.lft > 0),
    'whatsapp', jsonb_build_object(
      'connected', exists (select 1 from public.whatsapp_accounts a where a.institute_id = st.institute_id and a.status = 'connected'),
      'consent', exists (select 1 from public.leads l where l.student_id = st.id and l.consent_whatsapp and not l.do_not_call)));
end $$;

-- Students with dues, for the Pending list: active, balance due now above 0, in scope. p_sort 'amount' (most
-- due first, default) or 'date' (oldest unpaid fee first). oldest_due_date: the due date of the oldest unpaid
-- fee. total_rows and total_due (null without money) are for all the rows, not only this page.
create or replace function public.collect_pending(p_centre uuid default null, p_batch uuid default null,
                                                  p_sort text default 'amount', p_limit int default 200, p_offset int default 0)
returns table (student_id uuid, name text, admission_no text, class_label text, section text, board text,
               batch_name text, centre_name text, parent_name text, phone text, due_now numeric,
               oldest_due_date date, last_payment_on date, money_hidden boolean, total_rows bigint, total_due numeric)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat  public.seats;
  inst  uuid;
  money boolean;
  srt   text := coalesce(nullif(trim(p_sort), ''), 'amount');
  lim   int := coalesce(p_limit, 200);
  off   int := coalesce(p_offset, 0);
  prev  text[];
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.can_read_ledger(seat.institute_id) then
    raise exception 'only accounts, owners and managers can see the ledger' using errcode = '42501';
  end if;
  if srt not in ('amount', 'date') then raise exception 'sort by amount or date' using errcode = '22023'; end if;
  if lim not between 1 and 1000 or off < 0 then raise exception 'limit must be 1 to 1000' using errcode = '22023'; end if;
  inst := seat.institute_id;
  money := public.can_see_money(inst);
  prev := public.scope_push(inst, p_centre, p_batch);
  return query
    with d as (
      select s.id, s.name, s.admission_no, s.class_label, s.section, s.board, s.batch_id, s.centre_id, s.parent_name,
             s.phone, b.balance_due_now as due, b.last_payment_on as last_on, public.student_next_due_date(s.id) as oldest
      from public.students s
      join public.student_balance_rows(inst) b on b.student_id = s.id
      where s.institute_id = inst and s.status = 'active' and b.balance_due_now > 0
    )
    select d.id, d.name, d.admission_no, d.class_label, d.section, d.board, bt.name, ce.name, d.parent_name, d.phone,
           case when money then d.due end, d.oldest, d.last_on, not money, count(*) over (),
           case when money then sum(d.due) over () end
    from d
    left join public.batches bt on bt.id = d.batch_id
    left join public.centres ce on ce.id = d.centre_id
    order by case when srt = 'date' then d.oldest end nulls last, d.due desc, d.name, d.id
    limit lim offset off;
  perform public.scope_pop(prev);
end $$;

-- What the signed-in person recorded in the ledger (payments that stand; opening imports and reversals left
-- out), dated today and this month (institute time zone), and the institute's most used mode of the last 90
-- days (cash when there is none), for the Collect screen and Today. Ledger readers; amounts with money access.
create or replace function public.collected_by_me()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat  public.seats;
  inst  uuid;
  money boolean;
  today date;
  m0    date;
  x     record;
  md    text;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.can_read_ledger(seat.institute_id) then
    raise exception 'only accounts, owners and managers can see the ledger' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  money := public.can_see_money(inst);
  today := public.ledger_today(inst);
  m0 := date_trunc('month', today)::date;
  select count(*) filter (where p.paid_on = today) as t_n, sum(p.amount) filter (where p.paid_on = today) as t_amt,
         count(*) as m_n, sum(p.amount) as m_amt
    into x
    from public.payments p
   where p.institute_id = inst and p.recorded_by = seat.id and p.reverses_id is null and not p.opening
     and p.paid_on between m0 and today
     and not exists (select 1 from public.payments r where r.reverses_id = p.id);
  select p.mode into md from public.payments p
   where p.institute_id = inst and p.reverses_id is null and not p.opening and p.mode <> 'other'
     and p.created_at > now() - interval '90 days'
   group by p.mode order by count(*) desc, (p.mode = 'cash') desc, p.mode limit 1;
  return jsonb_build_object(
    'seat_id', seat.id, 'label', seat.label, 'today', today, 'month_start', m0, 'money_hidden', not money,
    'can_collect', public.can_manage_ledger(inst),
    'today_payments', x.t_n, 'today_amount', case when money then coalesce(x.t_amt, 0) end,
    'month_payments', x.m_n, 'month_amount', case when money then coalesce(x.m_amt, 0) end,
    'top_mode', coalesce(md, 'cash'));
end $$;

-- =====================================================================================================
-- 9. Settings: centres, batches, who works where
-- =====================================================================================================

-- Centres and batches of the signed-in person's institute (active and not), with active students in each for
-- ledger readers, and the person's own centres. has_centres: the institute has an active centre (the page
-- shows centre pickers only then).
create or replace function public.centres_list()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat public.seats;
  inst uuid;
  rd   boolean;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  inst := seat.institute_id;
  rd := public.can_read_ledger(inst);
  return jsonb_build_object(
    'has_centres', exists (select 1 from public.centres c where c.institute_id = inst and c.active),
    'my_centre_ids', to_jsonb(seat.centre_ids),
    'centres', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'short_code', c.short_code,
                  'active', c.active, 'sort_order', c.sort_order,
                  'students', case when rd then (select count(*) from public.students s where s.centre_id = c.id and s.status = 'active') end)
                  order by c.active desc, c.sort_order, c.name), '[]'::jsonb)
                from public.centres c where c.institute_id = inst),
    'batches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'centre_id', b.centre_id, 'name', b.name,
                  'class_label', b.class_label, 'board', b.board, 'academic_year', b.academic_year, 'timing', b.timing,
                  'active', b.active,
                  'students', case when rd then (select count(*) from public.students s where s.batch_id = b.id and s.status = 'active') end)
                  order by b.active desc, b.name), '[]'::jsonb)
                from public.batches b where b.institute_id = inst));
end $$;

-- Adds (p_id null) or changes a centre. Owner. Name 1-60 characters, unique in the institute (any case);
-- short code up to 8 letters or digits (made capital). Audit centre.added / centre.changed.
create or replace function public.admin_save_centre(p_id uuid, p_name text, p_short_code text default null,
                                                    p_active boolean default true)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  inst uuid;
  nm   text := trim(coalesce(p_name, ''));
  sc   text := nullif(upper(regexp_replace(coalesce(p_short_code, ''), '\s', '', 'g')), '');
  cid  uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_owner_of(seat.institute_id) then
    raise exception 'only the owner can change centres' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  if length(nm) not between 1 and 60 then raise exception 'a centre needs a name of 1 to 60 characters' using errcode = '22023'; end if;
  if sc is not null and sc !~ '^[A-Z0-9]{1,8}$' then raise exception 'short code: up to 8 letters or digits' using errcode = '22023'; end if;
  if exists (select 1 from public.centres c where c.institute_id = inst and lower(c.name) = lower(nm) and c.id is distinct from p_id) then
    raise exception 'a centre with this name already exists' using errcode = '23505';
  end if;
  if sc is not null and exists (select 1 from public.centres c where c.institute_id = inst and c.short_code = sc and c.id is distinct from p_id) then
    raise exception 'another centre has this short code' using errcode = '23505';
  end if;
  if p_id is null then
    insert into public.centres (institute_id, name, short_code, active, sort_order)
      values (inst, nm, sc, coalesce(p_active, true), 100 + (select count(*) from public.centres c where c.institute_id = inst)::int)
      returning id into cid;
  else
    update public.centres set name = nm, short_code = sc, active = coalesce(p_active, active), updated_at = now()
     where id = p_id and institute_id = inst returning id into cid;
    if cid is null then raise exception 'centre not found' using errcode = '42501'; end if;
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), case when p_id is null then 'centre.added' else 'centre.changed' end, cid::text);
  return cid;
end $$;

-- Adds (p_id null) or changes a batch. Owner or Accounts. p_data { name, centre_id (null = every centre),
-- class_label, board, academic_year, timing, active }; a key left out keeps its value. Name 1-60, unique in its
-- centre. Audit batch.added / batch.changed.
create or replace function public.admin_save_batch(p_id uuid, p_data jsonb)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  inst uuid;
  d    jsonb := coalesce(p_data, '{}'::jsonb);
  b    public.batches;
  v    text;
  k    text;
  bid  uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null or not (public.is_owner_of(seat.institute_id) or public.is_accounts_of(seat.institute_id)) then
    raise exception 'only the owner or accounts can change batches' using errcode = '42501';
  end if;
  inst := seat.institute_id;
  if jsonb_typeof(d) <> 'object' then raise exception 'send the batch as an object' using errcode = '22023'; end if;
  if p_id is not null then
    select * into b from public.batches where id = p_id and institute_id = inst;
    if b.id is null then raise exception 'batch not found' using errcode = '42501'; end if;
  else
    b.institute_id := inst; b.active := true;
  end if;
  for k in select jsonb_object_keys(d) loop
    v := nullif(trim(coalesce(d ->> k, '')), '');
    case k
      when 'name' then b.name := v;
      when 'centre_id' then b.centre_id := public.centre_from_text(inst, v);
      when 'class_label' then b.class_label := left(v, 20);
      when 'board' then b.board := case when v is null then null else public.campaign_check_tags(null, v) end;
      when 'academic_year' then
        if v is not null and v !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'academic year must look like 2026-27' using errcode = '22023'; end if;
        b.academic_year := v;
      when 'timing' then b.timing := left(v, 60);
      when 'active' then b.active := coalesce(v::boolean, true);
      else null;
    end case;
  end loop;
  if length(coalesce(b.name, '')) not between 1 and 60 then raise exception 'a batch needs a name of 1 to 60 characters' using errcode = '22023'; end if;
  if not public.centre_allowed(inst, b.centre_id) then raise exception 'you can see only your own centres' using errcode = '42501'; end if;
  if exists (select 1 from public.batches x where x.institute_id = inst and lower(x.name) = lower(b.name)
               and x.centre_id is not distinct from b.centre_id and x.id is distinct from p_id) then
    raise exception 'a batch with this name already exists in that centre' using errcode = '23505';
  end if;
  if p_id is null then
    insert into public.batches (institute_id, centre_id, name, class_label, board, academic_year, timing, active)
      values (inst, b.centre_id, b.name, b.class_label, b.board, b.academic_year, b.timing, coalesce(b.active, true))
      returning id into bid;
  else
    update public.batches set centre_id = b.centre_id, name = b.name, class_label = b.class_label, board = b.board,
           academic_year = b.academic_year, timing = b.timing, active = b.active, updated_at = now()
     where id = p_id returning id into bid;
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), case when p_id is null then 'batch.added' else 'batch.changed' end, bid::text);
  return bid;
end $$;

-- The centres a staff member works in (null or empty = every centre). Owner; not an owner's seat (owners see
-- every centre). Audit seat.centres_set <seat>:<n or all>.
create or replace function public.admin_set_seat_centres(p_seat uuid, p_centres uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  s    public.seats;
  ids  uuid[];
begin
  select * into s from public.seats where id = p_seat;
  if s.id is null or not public.is_owner_of(s.institute_id) then raise exception 'seat not found' using errcode = '42501'; end if;
  if s.role = 'admin' and s.admin_kind = 'owner' then
    raise exception 'an owner works in every centre' using errcode = '22023';
  end if;
  select array_agg(distinct x) into ids from unnest(coalesce(p_centres, '{}')) x where x is not null;
  if cardinality(ids) > 50 then raise exception 'at most 50 centres' using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(ids, '{}')) x
             where not exists (select 1 from public.centres c where c.id = x and c.institute_id = s.institute_id)) then
    raise exception 'centre not found' using errcode = '22023';
  end if;
  update public.seats set centre_ids = case when cardinality(ids) > 0 then ids end where id = s.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (s.institute_id, auth.uid(), 'seat.centres_set', s.id::text || ':' || coalesce(cardinality(ids)::text, 'all'));
end $$;

-- The centre and batch of a calling list (null = every centre / batch). Owner or manager. Audit
-- campaign.centre_set.
create or replace function public.admin_set_campaign_centre(p_campaign uuid, p_centre uuid, p_batch uuid default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare c public.campaigns;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null or not public.is_admin_of(c.institute_id) or not public.centre_allowed(c.institute_id, c.centre_id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if p_centre is not null and (not exists (select 1 from public.centres x where x.id = p_centre and x.institute_id = c.institute_id)
                               or not public.centre_allowed(c.institute_id, p_centre)) then
    raise exception 'centre not found' using errcode = '42501';
  end if;
  if p_batch is not null and not exists (select 1 from public.batches x where x.id = p_batch and x.institute_id = c.institute_id
                                           and (x.centre_id is null or p_centre is null or x.centre_id = p_centre)) then
    raise exception 'batch not found' using errcode = '22023';
  end if;
  update public.campaigns set centre_id = p_centre, batch_id = p_batch where id = c.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'campaign.centre_set', c.id::text);
end $$;

-- =====================================================================================================
-- 10. Grants
-- =====================================================================================================

revoke all on function public.my_centre_ids(uuid) from public, anon;
revoke all on function public.centre_allowed(uuid, uuid) from public, anon;
revoke all on function public.student_in_scope_rls(uuid) from public, anon;
grant execute on function public.my_centre_ids(uuid) to authenticated;
grant execute on function public.centre_allowed(uuid, uuid) to authenticated;
grant execute on function public.student_in_scope_rls(uuid) to authenticated;
revoke all on function public.scope_centre() from public, anon, authenticated;
revoke all on function public.scope_batch() from public, anon, authenticated;
revoke all on function public.in_scope(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.scope_active(uuid) from public, anon, authenticated;
revoke all on function public.student_in_scope(uuid) from public, anon, authenticated;
revoke all on function public.scope_push(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.scope_pop(text[]) from public, anon, authenticated;
revoke all on function public.centre_from_text(uuid, text) from public, anon, authenticated;
revoke all on function public.batch_from_text(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.students_centre() from public, anon, authenticated;
revoke all on function public.leads_centre() from public, anon, authenticated;
revoke all on function public.ap_card_in_scope(uuid, jsonb, uuid) from public, anon, authenticated;

revoke all on function public.admin_fees_ledger(uuid, date, date, uuid, uuid, uuid, uuid) from public, anon;
revoke all on function public.admin_promises_ledger(uuid, uuid, uuid, int, uuid, uuid) from public, anon;
revoke all on function public.admin_home_ledger(text, uuid, uuid, uuid) from public, anon;
revoke all on function public.admin_home_summary(text, uuid, uuid, uuid) from public, anon;
revoke all on function public.autopilot_numbers(uuid, uuid) from public, anon;
revoke all on function public.my_suggestions(uuid) from public, anon;
revoke all on function public.admin_campaign_list(uuid, uuid) from public, anon;
revoke all on function public.admin_callers(uuid, uuid) from public, anon;
revoke all on function public.accounts_create_fees_campaign(text, text, text, date, numeric, uuid, boolean, boolean, uuid, uuid) from public, anon;
revoke all on function public.admin_add_leads(uuid, jsonb, uuid) from public, anon;
revoke all on function public.accounts_save_student(uuid, jsonb) from public, anon;
revoke all on function public.accounts_import_students(jsonb) from public, anon;
revoke all on function public.autopilot_plan(uuid) from public, anon;
revoke all on function public.collect_search(text, uuid, uuid, int) from public, anon;
revoke all on function public.collect_student(uuid) from public, anon;
revoke all on function public.collect_pending(uuid, uuid, text, int, int) from public, anon;
revoke all on function public.collected_by_me() from public, anon;
revoke all on function public.centres_list() from public, anon;
revoke all on function public.admin_save_centre(uuid, text, text, boolean) from public, anon;
revoke all on function public.admin_save_batch(uuid, jsonb) from public, anon;
revoke all on function public.admin_set_seat_centres(uuid, uuid[]) from public, anon;
revoke all on function public.admin_set_campaign_centre(uuid, uuid, uuid) from public, anon;
revoke all on function public.my_suggestions() from public, anon;
revoke all on function public.admin_campaign_list() from public, anon;
revoke all on function public.admin_callers(uuid) from public, anon;
grant execute on function public.my_suggestions() to authenticated;
grant execute on function public.admin_campaign_list() to authenticated;
grant execute on function public.admin_callers(uuid) to authenticated;
grant execute on function public.admin_fees_ledger(uuid, date, date, uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.admin_promises_ledger(uuid, uuid, uuid, int, uuid, uuid) to authenticated;
grant execute on function public.admin_home_ledger(text, uuid, uuid, uuid) to authenticated;
grant execute on function public.admin_home_summary(text, uuid, uuid, uuid) to authenticated;
grant execute on function public.autopilot_numbers(uuid, uuid) to authenticated;
grant execute on function public.my_suggestions(uuid) to authenticated;
grant execute on function public.admin_campaign_list(uuid, uuid) to authenticated;
grant execute on function public.admin_callers(uuid, uuid) to authenticated;
grant execute on function public.accounts_create_fees_campaign(text, text, text, date, numeric, uuid, boolean, boolean, uuid, uuid) to authenticated;
grant execute on function public.admin_add_leads(uuid, jsonb, uuid) to authenticated;
grant execute on function public.accounts_save_student(uuid, jsonb) to authenticated;
grant execute on function public.accounts_import_students(jsonb) to authenticated;
grant execute on function public.autopilot_plan(uuid) to authenticated, service_role;
grant execute on function public.collect_search(text, uuid, uuid, int) to authenticated;
grant execute on function public.collect_student(uuid) to authenticated;
grant execute on function public.collect_pending(uuid, uuid, text, int, int) to authenticated;
grant execute on function public.collected_by_me() to authenticated;
grant execute on function public.centres_list() to authenticated;
grant execute on function public.admin_save_centre(uuid, text, text, boolean) to authenticated;
grant execute on function public.admin_save_batch(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_seat_centres(uuid, uuid[]) to authenticated;
grant execute on function public.admin_set_campaign_centre(uuid, uuid, uuid) to authenticated;
