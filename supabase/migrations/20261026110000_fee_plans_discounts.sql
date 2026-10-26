-- Fees basics: fee plans by class, discounts, and the day closing sheet ("Today's collection").
--
-- 1. Fee plans. For an academic year and a class (and, optionally, a board and a section) the fees office keeps
--    one list of fees (fee_plan_items: name, amount, due date, and who pays it: every student, only students
--    who use the school bus, or only students ticked by hand). fee_plan_apply adds the missing fees to every
--    active student of that class. It is idempotent: a fee item made from a plan item points at it
--    (fee_items.plan_item_id), and a student who already has a fee with the same name, amount and due date is
--    linked, not charged twice. When the plan changes later, the preview counts the students to change, and
--    apply cancels the old fee item and adds the new one (fee items are never edited). A fee removed from the
--    plan is cancelled for the students who have it. A fee the office cancelled by hand for one student is not
--    added again. Plans with auto_apply also go to new students (fee_plan_apply_student, and
--    accounts_import_students(p_rows, p_apply_plans)). An apply can be undone (fee_plan_undo) when it only
--    added fees and discounts.
-- 2. Discounts (table discounts). A discount is one or more rows (one per fee item, with a shared grant_id),
--    each a rupee amount off that fee item, never more than what is left of it. Percent and "whole year"
--    discounts are split over the fee items when given. A discount is never deleted: removing it keeps the row
--    with the reason. A discount counts only while it is not removed and its fee item is not cancelled.
--    Fee plans can carry discount rules (fee_plan_rules, e.g. "Sibling: 10% on tuition"); apply gives them to
--    the students ticked for them.
-- 3. Balances subtract discounts. student_balance_rows (and so accounts_students, accounts_student_detail,
--    admin_fees_ledger, lead_ledger, fees campaigns from the ledger and the leads' amount_due kept by
--    ledger_sync_student) now counts each fee item net of its live discounts: total_fees and total_due_to_date
--    are fees after discounts, and a new last column `discounts` is the discount total. Every function here that
--    changes a balance runs ledger_sync_student, so fees leads' amount_due follows.
-- 4. ledger_day_closing(p_institute, p_day): the day closing sheet.
--
-- Rules as in docs/data-contract.md: RLS on, no browser writes, amount columns not granted, security definer
-- functions with role and institute checks and audit_log, amounts only with can_see_money().

-- =====================================================================================================
-- 1. Tables
-- =====================================================================================================

alter table public.students add column if not exists uses_bus boolean not null default false;

create table public.fee_plans (
  id             uuid primary key default gen_random_uuid(),
  institute_id   uuid not null references public.institutes (id) on delete cascade,
  academic_year  text not null check (academic_year ~ '^[0-9]{4}-[0-9]{2}$'),
  class_label    text not null check (length(class_label) between 1 and 20),
  board          text check (board is null or board in ('CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other')),
  section        text check (section is null or length(section) between 1 and 20),
  auto_apply     boolean not null default true,
  created_by     uuid references public.seats (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, institute_id)
);
create unique index fee_plans_one on public.fee_plans
  (institute_id, academic_year, lower(class_label), coalesce(board, ''), lower(coalesce(section, '')));

create table public.fee_plan_items (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null,
  plan_id       uuid not null,
  head          text not null check (length(head) between 1 and 80),
  amount        numeric(12, 2) not null check (amount > 0),
  due_date      date not null,
  -- all: every student of the class; bus: students who use the school bus (students.uses_bus) unless the
  -- preview's ticks say otherwise; chosen: only students ticked on the preview.
  who           text not null default 'all' check (who in ('all', 'bus', 'chosen')),
  sort_order    int not null default 0,
  removed_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (plan_id, institute_id) references public.fee_plans (id, institute_id) on delete cascade
);
create unique index fee_plan_items_head on public.fee_plan_items (plan_id, lower(head)) where removed_at is null;

create table public.fee_plan_rules (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null,
  plan_id       uuid not null,
  reason        text not null check (reason in ('sibling', 'staff_child', 'merit', 'financial_help', 'other')),
  note          text check (note is null or length(note) between 1 and 200),
  percent       numeric(5, 2) check (percent is null or (percent > 0 and percent <= 100)),
  amount        numeric(12, 2) check (amount is null or amount > 0),
  -- The plan's fee names it applies to; empty = every fee of the plan that every student pays (who = 'all').
  heads         text[] not null default '{}',
  removed_at    timestamptz,
  created_at    timestamptz not null default now(),
  check ((percent is null) <> (amount is null)),
  foreign key (plan_id, institute_id) references public.fee_plans (id, institute_id) on delete cascade
);

create table public.fee_plan_applies (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null,
  plan_id       uuid not null,
  applied_by    uuid references public.seats (id) on delete set null,
  applied_at    timestamptz not null default now(),
  student_id    uuid,                 -- set when applied to one new student
  students      int not null default 0,
  added         int not null default 0,
  linked        int not null default 0,
  changed       int not null default 0,
  removed       int not null default 0,
  discounts     int not null default 0,
  undone_at     timestamptz,
  undone_by     uuid references public.seats (id) on delete set null,
  foreign key (plan_id, institute_id) references public.fee_plans (id, institute_id) on delete cascade
);

alter table public.fee_items
  add column if not exists plan_item_id uuid references public.fee_plan_items (id) on delete set null,
  add column if not exists plan_apply_id uuid references public.fee_plan_applies (id) on delete set null;
create index fee_items_plan_item on public.fee_items (plan_item_id) where plan_item_id is not null;
create index fee_items_plan_apply on public.fee_items (plan_apply_id) where plan_apply_id is not null;

create table public.discounts (
  id              uuid primary key default gen_random_uuid(),
  institute_id    uuid not null references public.institutes (id) on delete cascade,
  student_id      uuid not null,
  fee_item_id     uuid not null references public.fee_items (id) on delete cascade,
  grant_id        uuid not null,     -- the rows given together (one "Give a discount")
  amount          numeric(12, 2) not null check (amount > 0),
  percent         numeric(5, 2) check (percent is null or (percent > 0 and percent <= 100)),
  scope           text not null default 'fees' check (scope in ('fees', 'year')),
  reason          text not null check (reason in ('sibling', 'staff_child', 'merit', 'financial_help', 'other')),
  note            text check (note is null or length(note) between 1 and 200),
  approved_by     text not null check (length(approved_by) between 1 and 80),
  plan_rule_id    uuid references public.fee_plan_rules (id) on delete set null,
  plan_apply_id   uuid references public.fee_plan_applies (id) on delete set null,
  is_removed      boolean not null default false,
  removed_reason  text check (removed_reason is null or length(removed_reason) between 1 and 300),
  removed_at      timestamptz,
  removed_by      uuid references public.seats (id) on delete set null,
  created_by      uuid references public.seats (id) on delete set null,
  created_at      timestamptz not null default now(),
  check (not is_removed or removed_reason is not null),
  check (reason <> 'other' or note is not null),
  foreign key (student_id, institute_id) references public.students (id, institute_id) on delete cascade
);
create index discounts_fee_item on public.discounts (fee_item_id) where not is_removed;
create index discounts_student on public.discounts (student_id);
create index discounts_grant on public.discounts (grant_id);

-- History is kept. Fee items: voided once, or linked to a plan item once (a fee the student already had).
-- Discounts: removed once. Nothing else changes.
create or replace function public.ledger_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'payments' then
    raise exception 'payments cannot be changed: record a reversal' using errcode = '42501';
  end if;
  if tg_table_name = 'discounts' then
    if old.is_removed or not new.is_removed
       or (new.id, new.institute_id, new.student_id, new.fee_item_id, new.grant_id, new.amount, new.percent, new.scope,
           new.reason, new.note, new.approved_by, new.plan_rule_id, new.plan_apply_id, new.created_by, new.created_at)
          is distinct from
          (old.id, old.institute_id, old.student_id, old.fee_item_id, old.grant_id, old.amount, old.percent, old.scope,
           old.reason, old.note, old.approved_by, old.plan_rule_id, old.plan_apply_id, old.created_by, old.created_at) then
      raise exception 'discounts cannot be changed: remove it and give a new one' using errcode = '42501';
    end if;
    return new;
  end if;
  -- fee_items
  if (new.id, new.institute_id, new.student_id, new.head, new.amount, new.due_date, new.academic_year,
      new.created_by, new.created_at, new.plan_apply_id)
     is distinct from
     (old.id, old.institute_id, old.student_id, old.head, old.amount, old.due_date, old.academic_year,
      old.created_by, old.created_at, old.plan_apply_id) then
    raise exception 'fee items cannot be changed: void it and add a new one' using errcode = '42501';
  end if;
  if not old.is_void and not new.is_void and old.plan_item_id is null and new.plan_item_id is not null
     and (new.void_reason, new.voided_at, new.voided_by) is not distinct from (old.void_reason, old.voided_at, old.voided_by) then
    return new;   -- linked to a fee plan
  end if;
  if old.is_void or not new.is_void or new.plan_item_id is distinct from old.plan_item_id then
    raise exception 'fee items cannot be changed: void it and add a new one' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger discounts_remove_only before update on public.discounts
  for each row execute function public.ledger_guard();

-- RLS: ledger readers read their institute's rows; nobody writes from the browser; amounts are not granted.
alter table public.fee_plans        enable row level security;
alter table public.fee_plan_items   enable row level security;
alter table public.fee_plan_rules   enable row level security;
alter table public.fee_plan_applies enable row level security;
alter table public.discounts        enable row level security;
create policy fee_plans_read on public.fee_plans for select using (public.can_read_ledger(institute_id));
create policy fee_plan_items_read on public.fee_plan_items for select using (public.can_read_ledger(institute_id));
create policy fee_plan_rules_read on public.fee_plan_rules for select using (public.can_read_ledger(institute_id));
create policy fee_plan_applies_read on public.fee_plan_applies for select using (public.can_read_ledger(institute_id));
create policy discounts_read on public.discounts for select using (public.can_read_ledger(institute_id));
revoke all on public.fee_plans, public.fee_plan_items, public.fee_plan_rules, public.fee_plan_applies, public.discounts
  from anon, authenticated;
grant select on public.fee_plans, public.fee_plan_applies to authenticated;
grant select (id, institute_id, plan_id, head, due_date, who, sort_order, removed_at, created_at, updated_at)
  on public.fee_plan_items to authenticated;
grant select (id, institute_id, plan_id, reason, note, percent, heads, removed_at, created_at)
  on public.fee_plan_rules to authenticated;
grant select (id, institute_id, student_id, fee_item_id, grant_id, percent, scope, reason, note, approved_by,
              plan_rule_id, plan_apply_id, is_removed, removed_reason, removed_at, removed_by, created_by, created_at)
  on public.discounts to authenticated;
grant select (plan_item_id, plan_apply_id) on public.fee_items to authenticated;

-- =====================================================================================================
-- 2. Balances net of discounts
-- =====================================================================================================

-- What is left of a fee item after its live discounts (0 for a cancelled item). Internal.
create or replace function public.fee_item_left(p_fee_item uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select case when fi.is_void then 0 else greatest(fi.amount - coalesce((select sum(d.amount) from public.discounts d
                                                     where d.fee_item_id = fi.id and not d.is_removed), 0), 0) end
  from public.fee_items fi where fi.id = p_fee_item;
$$;
revoke all on function public.fee_item_left(uuid) from public, anon, authenticated;

-- student_balance_rows: as in 20261025180000, with each fee item net of its live discounts, and the discount
-- total as a new last column. total_fees and total_due_to_date are fees after discounts, so balance_due_now
-- = due to date − paid and balance_total = total − paid, as before.
drop function public.student_balance_rows(uuid, uuid, date);
create function public.student_balance_rows(p_institute uuid, p_student uuid default null, p_as_of date default null)
returns table (student_id uuid, total_fees numeric, total_due_to_date numeric, paid numeric,
               balance_due_now numeric, balance_total numeric,
               last_payment_amount numeric, last_payment_on date, last_payment_mode text, discounts numeric)
language sql stable security definer set search_path = public
as $$
  with d as materialized (select coalesce(p_as_of, public.ledger_today(p_institute)) as as_of)
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
  where s.institute_id = p_institute and (p_student is null or s.id = p_student);
$$;
revoke all on function public.student_balance_rows(uuid, uuid, date) from public, anon, authenticated;

-- student_next_due_date: as in 20261025180000, with fee items net of discounts.
create or replace function public.student_next_due_date(p_student uuid)
returns date
language sql stable security definer set search_path = public
as $$
  with paid as (
    select coalesce(sum(case when py.reverses_id is null then py.amount else -py.amount end), 0) as amt
    from public.payments py where py.student_id = p_student
  ), run as (
    select fi.due_date,
           sum(public.fee_item_left(fi.id)) over (order by fi.due_date, fi.created_at, fi.id) as upto
    from public.fee_items fi
    where fi.student_id = p_student and not fi.is_void
  )
  select min(r.due_date) from run r, paid p where r.upto > p.amt;
$$;
revoke all on function public.student_next_due_date(uuid) from public, anon, authenticated;

-- =====================================================================================================
-- 3. Helpers (granted to nobody)
-- =====================================================================================================

-- Owners and Accounts always; managers only when they can see money. Discounts change what a family owes.
create or replace function public.can_give_discount(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.can_manage_ledger(inst) or (public.is_admin_of(inst) and public.can_see_money(inst)) $$;
revoke all on function public.can_give_discount(uuid) from public, anon, authenticated;

create or replace function public.discount_reason_label(p_reason text)
returns text
language sql immutable set search_path = public
as $$ select case p_reason when 'sibling' then 'Sibling' when 'staff_child' then 'Staff child' when 'merit' then 'Merit'
                           when 'financial_help' then 'Financial help' else 'Other' end $$;

-- The fee plan for an action: the plan of an institute the person may read (p_write false) or manage.
create or replace function public.fee_plan_get(p_plan uuid, p_write boolean)
returns public.fee_plans
language plpgsql stable security definer set search_path = public
as $$
declare p public.fee_plans;
begin
  select * into p from public.fee_plans where id = p_plan;
  if p.id is null or not (case when p_write then public.can_manage_ledger(p.institute_id)
                               else public.can_read_ledger(p.institute_id) end) then
    raise exception 'fee plan not found' using errcode = '42501';
  end if;
  return p;
end $$;
revoke all on function public.fee_plan_get(uuid, boolean) from public, anon, authenticated;

-- The active students a plan is for: same class (any case), the plan's board and section when it has them,
-- and the plan's academic year (or no year).
create or replace function public.fee_plan_students(p_plan uuid)
returns setof public.students
language sql stable security definer set search_path = public
as $$
  select s.* from public.fee_plans p
  join public.students s on s.institute_id = p.institute_id and s.status = 'active'
   and lower(trim(s.class_label)) = lower(p.class_label)
   and (p.board is null or s.board = p.board)
   and (p.section is null or lower(s.section) = lower(p.section))
   and (s.academic_year is null or s.academic_year = p.academic_year)
  where p.id = p_plan;
$$;
revoke all on function public.fee_plan_students(uuid) from public, anon, authenticated;

-- Each (student, live plan item) of a plan and where it stands:
--   has        the student has the fee from this plan item, with the plan's name, amount and due date
--   change     the student has it from this plan item, but the plan changed since
--   cancelled  the fee from this plan item was cancelled for this student (by hand): not added again
--   same       the student has a fee with the same name, amount and due date (an import): linked on apply
--   other      the student has a fee with the same name but another amount or date: left as it is
--   missing    the student does not have it: added on apply (optional fees only when ticked)
-- fee_item_id: the student's fee item for has / change / cancelled / same / other.
create or replace function public.fee_plan_rows(p_plan uuid, p_student uuid default null)
returns table (student_id uuid, item_id uuid, state text, fee_item_id uuid)
language sql stable security definer set search_path = public
as $$
  select s.id, it.id,
         case when lk.id is not null and lk.is_void then 'cancelled'
              when lk.id is not null and (lk.head, lk.amount, lk.due_date) = (it.head, it.amount, it.due_date) then 'has'
              when lk.id is not null then 'change'
              when hm.id is not null and hm.amount = it.amount and hm.due_date = it.due_date then 'same'
              when hm.id is not null then 'other'
              else 'missing' end,
         coalesce(lk.id, hm.id)
  from public.fee_plans p
  join public.fee_plan_items it on it.plan_id = p.id and it.removed_at is null
  cross join lateral public.fee_plan_students(p.id) s
  left join lateral (
    select fi.id, fi.is_void, fi.head, fi.amount, fi.due_date from public.fee_items fi
    where fi.student_id = s.id and fi.plan_item_id = it.id
      and not (fi.is_void and exists (select 1 from public.fee_plan_applies a
                                      where a.id = fi.plan_apply_id and a.undone_at is not null))
    order by fi.is_void, fi.created_at desc limit 1) lk on true
  left join lateral (
    select fi.id, fi.amount, fi.due_date from public.fee_items fi
    where fi.student_id = s.id and not fi.is_void and fi.plan_item_id is null
      and lower(btrim(fi.head)) = lower(btrim(it.head))
      and (fi.academic_year is null or fi.academic_year = p.academic_year)
    order by (fi.amount = it.amount and fi.due_date = it.due_date) desc, fi.created_at limit 1) hm on true
  where p.id = p_plan and (p_student is null or s.id = p_student);
$$;
revoke all on function public.fee_plan_rows(uuid, uuid) from public, anon, authenticated;

-- Live fee items of students that come from plan items now removed from the plan (to cancel on apply).
create or replace function public.fee_plan_removed_rows(p_plan uuid)
returns table (student_id uuid, item_id uuid, head text, fee_item_id uuid)
language sql stable security definer set search_path = public
as $$
  select fi.student_id, it.id, it.head, fi.id
  from public.fee_plan_items it
  join public.fee_items fi on fi.plan_item_id = it.id and not fi.is_void
  join public.students s on s.id = fi.student_id and s.status = 'active'
  where it.plan_id = p_plan and it.removed_at is not null;
$$;
revoke all on function public.fee_plan_removed_rows(uuid) from public, anon, authenticated;

-- Gives one discount on fee items (internal; callers check who may). p_kind 'percent' or 'amount'; percent:
-- each item × p_value %; amount: p_value split over the items in proportion to what is left of each (paise
-- rounding on the last). Never more than what is left of an item. Returns the total given (0 when nothing).
create or replace function public.discount_give_rows(
  p_student uuid, p_items uuid[], p_kind text, p_value numeric, p_scope text, p_reason text, p_note text,
  p_approved_by text, p_seat uuid, p_grant uuid, p_rule uuid default null, p_apply uuid default null)
returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  st      public.students;
  r       record;
  lefts   numeric := 0;
  given   numeric := 0;
  share   numeric;
  n       int;
  k       int := 0;
begin
  select * into st from public.students where id = p_student;
  select count(*), coalesce(sum(public.fee_item_left(fi.id)), 0) into n, lefts
  from public.fee_items fi where fi.id = any (p_items) and fi.student_id = p_student and not fi.is_void
    and public.fee_item_left(fi.id) > 0;
  if n = 0 then return 0; end if;
  if p_kind = 'amount' and p_value > lefts then
    raise exception 'the discount (%) is more than what is left to pay on these fees (%)', p_value, lefts using errcode = '22023';
  end if;
  for r in
    select fi.id, fi.amount, public.fee_item_left(fi.id) as lft from public.fee_items fi
    where fi.id = any (p_items) and fi.student_id = p_student and not fi.is_void and public.fee_item_left(fi.id) > 0
    order by fi.due_date, fi.created_at, fi.id
  loop
    k := k + 1;
    if p_kind = 'percent' then
      share := least(round(r.amount * p_value / 100, 2), r.lft);
    elsif k = n then
      share := least(p_value - given, r.lft);
    else
      share := least(round(p_value * r.lft / lefts, 2), r.lft);
    end if;
    if share > 0 then
      insert into public.discounts (institute_id, student_id, fee_item_id, grant_id, amount, percent, scope, reason, note,
                                    approved_by, plan_rule_id, plan_apply_id, created_by)
        values (st.institute_id, st.id, r.id, p_grant, share, case when p_kind = 'percent' then p_value end, p_scope,
                p_reason, p_note, p_approved_by, p_rule, p_apply, p_seat);
      given := given + share;
    end if;
  end loop;
  return given;
end $$;
revoke all on function public.discount_give_rows(uuid, uuid[], text, numeric, text, text, text, text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;

-- The work of fee_plan_apply and fee_plan_apply_student. p_student: one student only (null = every student of
-- the plan). p_chosen: { "<plan item id>": ["<student id>", …] } for the optional fees (null for an item:
-- bus fees go to students with uses_bus, "chosen" fees to nobody). p_rules: { "<rule id>": ["<student id>", …] }.
-- p_remove: cancel fees removed from the plan. Returns the counts; ledger_sync_student runs for each student
-- whose balance changed.
create or replace function public.fee_plan_apply_core(
  p_plan uuid, p_seat public.seats, p_student uuid, p_chosen jsonb, p_rules jsonb, p_remove boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  p        public.fee_plans;
  aid      uuid;
  r        record;
  it       public.fee_plan_items;
  fid      uuid;
  ticked   boolean;
  touched  uuid[] := '{}';
  n_add    int := 0;
  n_link   int := 0;
  n_chg    int := 0;
  n_rem    int := 0;
  n_disc   int := 0;
  n_leads  int := 0;
  ru       public.fee_plan_rules;
  sid      uuid;
  items    uuid[];
  gid      uuid;
  by_label text := coalesce(nullif(trim(p_seat.label), ''), 'Fees office');
  fi_id    uuid;
  got      numeric;
  chosen   jsonb := coalesce(p_chosen, '{}'::jsonb);
  rules    jsonb := coalesce(p_rules, '{}'::jsonb);
  d        record;
begin
  select * into p from public.fee_plans where id = p_plan for update;
  if jsonb_typeof(chosen) <> 'object' or jsonb_typeof(rules) <> 'object' then
    raise exception 'ticks must be an object of lists' using errcode = '22023';
  end if;
  insert into public.fee_plan_applies (institute_id, plan_id, applied_by, student_id)
    values (p.institute_id, p.id, p_seat.id, p_student) returning id into aid;

  for r in select x.student_id, x.item_id, x.state, x.fee_item_id from public.fee_plan_rows(p.id, p_student) x
           where x.state in ('missing', 'same', 'change') loop
    select * into it from public.fee_plan_items where id = r.item_id;
    if r.state = 'same' then
      update public.fee_items set plan_item_id = it.id where id = r.fee_item_id and plan_item_id is null;
      n_link := n_link + 1;
    elsif r.state = 'missing' then
      if it.who = 'all' then
        ticked := true;
      elsif chosen ? it.id::text then
        if jsonb_typeof(chosen -> it.id::text) <> 'array' then
          raise exception 'ticks must be an object of lists' using errcode = '22023';
        end if;
        ticked := (chosen -> it.id::text) ? r.student_id::text;
      else
        ticked := it.who = 'bus' and exists (select 1 from public.students s where s.id = r.student_id and s.uses_bus);
      end if;
      if ticked then
        insert into public.fee_items (institute_id, student_id, head, amount, due_date, academic_year, created_by,
                                      plan_item_id, plan_apply_id)
          values (p.institute_id, r.student_id, it.head, it.amount, it.due_date, p.academic_year, p_seat.id, it.id, aid);
        if it.who = 'bus' then update public.students set uses_bus = true where id = r.student_id and not uses_bus; end if;
        n_add := n_add + 1;
        touched := touched || r.student_id;
      end if;
    else   -- change: cancel the old fee, add the plan's, and carry its discounts over
      update public.fee_items set is_void = true, void_reason = 'The fee plan changed', voided_at = now(), voided_by = p_seat.id
       where id = r.fee_item_id;
      insert into public.fee_items (institute_id, student_id, head, amount, due_date, academic_year, created_by,
                                    plan_item_id, plan_apply_id)
        values (p.institute_id, r.student_id, it.head, it.amount, it.due_date, p.academic_year, p_seat.id, it.id, aid)
        returning id into fid;
      for d in select * from public.discounts x where x.fee_item_id = r.fee_item_id and not x.is_removed loop
        perform public.discount_give_rows(r.student_id, array[fid],
                  case when d.percent is not null then 'percent' else 'amount' end,
                  coalesce(d.percent, least(d.amount, it.amount)), d.scope, d.reason, d.note, d.approved_by, p_seat.id,
                  d.grant_id, d.plan_rule_id, aid);
      end loop;
      n_chg := n_chg + 1;
      touched := touched || r.student_id;
    end if;
  end loop;

  if p_remove then
    for r in select * from public.fee_plan_removed_rows(p.id) x where p_student is null or x.student_id = p_student loop
      update public.fee_items set is_void = true, void_reason = 'Removed from the fee plan', voided_at = now(), voided_by = p_seat.id
       where id = r.fee_item_id;
      n_rem := n_rem + 1;
      touched := touched || r.student_id;
    end loop;
  end if;

  -- Discount rules for the ticked students: on each of the rule's fees the student has from this plan, once.
  for ru in select * from public.fee_plan_rules x where x.plan_id = p.id and x.removed_at is null loop
    if not rules ? ru.id::text then continue; end if;
    if jsonb_typeof(rules -> ru.id::text) <> 'array' then
      raise exception 'ticks must be an object of lists' using errcode = '22023';
    end if;
    for sid in select (v #>> '{}')::uuid from jsonb_array_elements(rules -> ru.id::text) v loop
      if not exists (select 1 from public.fee_plan_students(p.id) s where s.id = sid) then continue; end if;
      if p_student is not null and sid <> p_student then continue; end if;
      select coalesce(array_agg(fi.id), '{}') into items
      from public.fee_items fi
      join public.fee_plan_items pi on pi.id = fi.plan_item_id and pi.plan_id = p.id and pi.removed_at is null
      where fi.student_id = sid and not fi.is_void
        and (case when cardinality(ru.heads) = 0 then pi.who = 'all'
                  else lower(pi.head) = any (select lower(h) from unnest(ru.heads) h) end)
        and not exists (select 1 from public.discounts x where x.fee_item_id = fi.id and x.plan_rule_id = ru.id
                        and not x.is_removed);
      if cardinality(items) = 0 then continue; end if;
      gid := gen_random_uuid();
      got := 0;
      if ru.percent is not null then
        got := public.discount_give_rows(sid, items, 'percent', ru.percent, 'fees', ru.reason, ru.note, by_label,
                                         p_seat.id, gid, ru.id, aid);
      else
        foreach fi_id in array items loop   -- an amount rule: that amount off each of its fees
          got := got + public.discount_give_rows(sid, array[fi_id], 'amount', least(ru.amount, public.fee_item_left(fi_id)),
                                                 'fees', ru.reason, ru.note, by_label, p_seat.id, gid, ru.id, aid);
        end loop;
      end if;
      if got > 0 then
        n_disc := n_disc + 1;
        touched := touched || sid;
      end if;
    end loop;
  end loop;

  select coalesce(sum(public.ledger_sync_student(x)), 0) into n_leads from (select distinct unnest(touched) as x) t;
  update public.fee_plan_applies
     set students = (select count(distinct x) from unnest(touched) x), added = n_add, linked = n_link, changed = n_chg,
         removed = n_rem, discounts = n_disc
   where id = aid;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (p.institute_id, auth.uid(), 'fee_plan.applied',
            p.id::text || ':' || aid::text || ':' || n_add || ':' || n_chg || ':' || n_rem || ':' || n_disc);
  return jsonb_build_object('apply_id', aid, 'plan_id', p.id, 'students', (select count(distinct x) from unnest(touched) x),
                            'added', n_add, 'linked', n_link, 'changed', n_chg, 'removed', n_rem, 'discounts', n_disc,
                            'leads_updated', n_leads, 'can_undo', n_chg = 0 and n_rem = 0 and (n_add + n_disc) > 0);
end $$;
revoke all on function public.fee_plan_apply_core(uuid, public.seats, uuid, jsonb, jsonb, boolean) from public, anon, authenticated;

-- =====================================================================================================
-- 4. Fee plans: RPCs
-- =====================================================================================================

-- Adds (p_plan null) or changes a fee plan. p_data: { academic_year, class_label, board, section, auto_apply,
-- items: [{ id (to keep an item), head, amount, due_date 'YYYY-MM-DD', who 'all' | 'bus' | 'chosen' }],
-- rules: [{ id, reason, note, percent | amount, heads: [fee names] }] }. Items and rules left out are removed
-- from the plan (fees already given stay until the change is applied). Owner or Accounts. Audit
-- fee_plan.created / fee_plan.changed. Returns the plan id.
create or replace function public.fee_plan_save(p_plan uuid, p_data jsonb)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat   public.seats;
  p      public.fee_plans;
  d      jsonb := coalesce(p_data, '{}'::jsonb);
  x      jsonb;
  k      int := 0;
  hd     text;
  amt    numeric;
  due    date;
  wh     text;
  keep   uuid[] := '{}';
  keep_r uuid[] := '{}';
  iid    uuid;
  heads  text[] := '{}';
  rh     text[];
  pct    numeric;
  ramt   numeric;
  rsn    text;
  nt     text;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if jsonb_typeof(d) <> 'object' then raise exception 'send the fee plan as an object' using errcode = '22023'; end if;
  if p_plan is null then
    perform public.ledger_manager_seat(seat.institute_id);
    p.institute_id := seat.institute_id;
  else
    p := public.fee_plan_get(p_plan, true);
    seat := public.ledger_manager_seat(p.institute_id);
  end if;
  if d ? 'academic_year' or p_plan is null then p.academic_year := nullif(trim(coalesce(d ->> 'academic_year', '')), ''); end if;
  if d ? 'class_label' or p_plan is null then p.class_label := nullif(left(trim(coalesce(d ->> 'class_label', '')), 20), ''); end if;
  if d ? 'board' then p.board := public.campaign_check_tags(null, nullif(trim(coalesce(d ->> 'board', '')), '')); end if;
  if d ? 'section' then p.section := nullif(left(trim(coalesce(d ->> 'section', '')), 20), ''); end if;
  p.auto_apply := coalesce((d ->> 'auto_apply')::boolean, p.auto_apply, true);
  if p.class_label is null then raise exception 'pick the class' using errcode = '22023'; end if;
  if p.academic_year is null or p.academic_year !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'academic year must look like 2026-27' using errcode = '22023';
  end if;
  if exists (select 1 from public.fee_plans f where f.institute_id = p.institute_id and f.academic_year = p.academic_year
               and lower(f.class_label) = lower(p.class_label) and coalesce(f.board, '') = coalesce(p.board, '')
               and lower(coalesce(f.section, '')) = lower(coalesce(p.section, '')) and f.id is distinct from p.id) then
    raise exception 'there is already a fee plan for this class and year: open it and change it' using errcode = '23505';
  end if;
  if coalesce(jsonb_typeof(d -> 'items'), '') <> 'array' or jsonb_array_length(d -> 'items') not between 1 and 30 then
    raise exception 'a fee plan needs 1 to 30 fees' using errcode = '22023';
  end if;

  if p_plan is null then
    insert into public.fee_plans (institute_id, academic_year, class_label, board, section, auto_apply, created_by)
      values (p.institute_id, p.academic_year, p.class_label, p.board, p.section, p.auto_apply, seat.id)
      returning * into p;
  else
    update public.fee_plans set academic_year = p.academic_year, class_label = p.class_label, board = p.board,
           section = p.section, auto_apply = p.auto_apply, updated_at = now()
     where id = p.id;
  end if;

  -- Items: check them all first (names once each).
  for x in select e from jsonb_array_elements(d -> 'items') e loop
    hd := trim(coalesce(x ->> 'head', ''));
    if length(hd) not between 1 and 80 then raise exception 'each fee needs a name (up to 80 characters)' using errcode = '22023'; end if;
    if lower(hd) = any (select lower(h) from unnest(heads) h) then
      raise exception 'the fee "%" is in the plan twice', hd using errcode = '22023';
    end if;
    heads := heads || hd;
  end loop;
  -- Removed items first, so a name can move to a new line.
  update public.fee_plan_items set removed_at = now(), updated_at = now()
   where plan_id = p.id and removed_at is null
     and id not in (select (e ->> 'id')::uuid from jsonb_array_elements(d -> 'items') e where nullif(e ->> 'id', '') is not null);
  for x in select e from jsonb_array_elements(d -> 'items') e loop
    k := k + 1;
    hd := trim(x ->> 'head');
    amt := public.ledger_amount(x ->> 'amount');
    if amt is null or amt <= 0 then raise exception 'the fee "%" needs an amount in rupees', hd using errcode = '22023'; end if;
    begin
      due := public.ledger_date(x ->> 'due_date');
    exception when others then raise exception 'the due date of "%" must be a date', hd using errcode = '22023';
    end;
    if due is null then raise exception 'the fee "%" needs a due date', hd using errcode = '22023'; end if;
    wh := coalesce(nullif(trim(coalesce(x ->> 'who', '')), ''), 'all');
    if wh not in ('all', 'bus', 'chosen') then raise exception 'who pays must be all, bus or chosen' using errcode = '22023'; end if;
    iid := nullif(x ->> 'id', '')::uuid;
    if iid is not null then
      update public.fee_plan_items set head = hd, amount = amt, due_date = due, who = wh, sort_order = k, updated_at = now()
       where id = iid and plan_id = p.id and removed_at is null
       returning id into iid;
    end if;
    if iid is null then
      insert into public.fee_plan_items (institute_id, plan_id, head, amount, due_date, who, sort_order)
        values (p.institute_id, p.id, hd, amt, due, wh, k) returning id into iid;
    end if;
    keep := keep || iid;
  end loop;

  -- Discount rules.
  if d ? 'rules' and jsonb_typeof(d -> 'rules') not in ('array', 'null') then
    raise exception 'rules must be a list' using errcode = '22023';
  end if;
  if jsonb_typeof(d -> 'rules') = 'array' then
    if jsonb_array_length(d -> 'rules') > 10 then raise exception 'at most 10 discount rules' using errcode = '22023'; end if;
    for x in select e from jsonb_array_elements(d -> 'rules') e loop
      rsn := lower(trim(coalesce(x ->> 'reason', '')));
      if rsn not in ('sibling', 'staff_child', 'merit', 'financial_help', 'other') then
        raise exception 'reason must be sibling, staff_child, merit, financial_help or other' using errcode = '22023';
      end if;
      nt := nullif(left(trim(coalesce(x ->> 'note', '')), 200), '');
      if rsn = 'other' and nt is null then raise exception 'write what the "Other" discount is for' using errcode = '22023'; end if;
      pct := nullif(trim(coalesce(x ->> 'percent', '')), '')::numeric;
      ramt := public.ledger_amount(x ->> 'amount');
      if (pct is null) = (ramt is null) then raise exception 'a discount rule needs a percent or an amount' using errcode = '22023'; end if;
      if pct is not null and (pct <= 0 or pct > 100) then raise exception 'percent must be more than 0 and up to 100' using errcode = '22023'; end if;
      if ramt is not null and ramt <= 0 then raise exception 'the discount amount must be more than 0' using errcode = '22023'; end if;
      select coalesce(array_agg(trim(h)), '{}') into rh from jsonb_array_elements_text(coalesce(x -> 'heads', '[]'::jsonb)) h
       where trim(h) <> '';
      if exists (select 1 from unnest(rh) h where lower(h) <> all (select lower(z) from unnest(heads) z)) then
        raise exception 'a discount rule names a fee that is not in the plan' using errcode = '22023';
      end if;
      iid := nullif(x ->> 'id', '')::uuid;
      if iid is not null then
        update public.fee_plan_rules set reason = rsn, note = nt, percent = pct, amount = ramt, heads = rh
         where id = iid and plan_id = p.id and removed_at is null returning id into iid;
      end if;
      if iid is null then
        insert into public.fee_plan_rules (institute_id, plan_id, reason, note, percent, amount, heads)
          values (p.institute_id, p.id, rsn, nt, pct, ramt, rh) returning id into iid;
      end if;
      keep_r := keep_r || iid;
    end loop;
  end if;
  update public.fee_plan_rules set removed_at = now() where plan_id = p.id and removed_at is null and id <> all (keep_r);

  insert into public.audit_log (institute_id, actor_id, action, target)
    values (p.institute_id, auth.uid(), case when p_plan is null then 'fee_plan.created' else 'fee_plan.changed' end, p.id::text);
  return p.id;
end $$;

-- Removes a fee plan that was never applied (nothing came from it yet). Owner or Accounts. Audit fee_plan.deleted.
create or replace function public.fee_plan_delete(p_plan uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare p public.fee_plans;
begin
  p := public.fee_plan_get(p_plan, true);
  perform public.ledger_manager_seat(p.institute_id);
  if exists (select 1 from public.fee_items fi join public.fee_plan_items it on it.id = fi.plan_item_id where it.plan_id = p.id)
     or exists (select 1 from public.discounts x join public.fee_plan_rules ru on ru.id = x.plan_rule_id where ru.plan_id = p.id) then
    raise exception 'this fee plan was already used: change its fees instead' using errcode = '22023';
  end if;
  delete from public.fee_plans where id = p.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (p.institute_id, auth.uid(), 'fee_plan.deleted', p.id::text);
end $$;

-- The institute's fee plans: [{ id, academic_year, class_label, board, section, auto_apply, updated_at, students,
-- items [{ id, head, amount, due_date, who }], rules [{ id, reason, reason_label, note, percent, amount, heads }],
-- pending { add, change, remove, students } }] (pending: what apply would do now, optional fees left out).
-- Owners, managers, Accounts; amounts null unless can_see_money().
create or replace function public.fee_plans_list()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  seat  public.seats;
  money boolean;
  out   jsonb;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.can_read_ledger(seat.institute_id) then
    raise exception 'only accounts, owners and managers can see fee plans' using errcode = '42501';
  end if;
  money := public.can_see_money(seat.institute_id);
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'academic_year', p.academic_year, 'class_label', p.class_label, 'board', p.board, 'section', p.section,
      'auto_apply', p.auto_apply, 'updated_at', p.updated_at, 'money_hidden', not money,
      'students', (select count(*) from public.fee_plan_students(p.id)),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('id', it.id, 'head', it.head,
                  'amount', case when money then it.amount end, 'due_date', it.due_date, 'who', it.who)
                  order by it.sort_order, it.created_at), '[]'::jsonb)
                from public.fee_plan_items it where it.plan_id = p.id and it.removed_at is null),
      'rules', (select coalesce(jsonb_agg(jsonb_build_object('id', ru.id, 'reason', ru.reason,
                  'reason_label', public.discount_reason_label(ru.reason), 'note', ru.note, 'percent', ru.percent,
                  'amount', case when money then ru.amount end, 'heads', to_jsonb(ru.heads)) order by ru.created_at), '[]'::jsonb)
                from public.fee_plan_rules ru where ru.plan_id = p.id and ru.removed_at is null),
      'pending', (select jsonb_build_object(
                    'add', count(*) filter (where x.state = 'missing' and it.who = 'all'),
                    'change', count(*) filter (where x.state = 'change'),
                    'remove', (select count(*) from public.fee_plan_removed_rows(p.id)),
                    'students', count(distinct x.student_id) filter (where (x.state = 'missing' and it.who = 'all') or x.state = 'change'))
                  from public.fee_plan_rows(p.id) x join public.fee_plan_items it on it.id = x.item_id))
    order by p.academic_year desc, p.class_label, p.board nulls first, p.section nulls first), '[]'::jsonb)
  into out
  from public.fee_plans p where p.institute_id = seat.institute_id;
  return out;
end $$;

-- What applying a plan would do, student by student, for the preview:
-- { plan {…}, money_hidden, students, items [{ id, head, amount, due_date, who, missing, same, has, change, other,
--   cancelled, ticked (optional fees: students ticked by default) }], removed [{ id, head, students }],
--   rules [{ id, reason, reason_label, note, percent, amount, heads, given }],
--   rows [{ student_id, name, admission_no, section, board, uses_bus, items { "<item id>": state }, rules [rule ids
--   already given] }] }. Owners, managers, Accounts; amounts null unless can_see_money().
create or replace function public.fee_plan_preview(p_plan uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  p     public.fee_plans;
  money boolean;
  out   jsonb;
begin
  p := public.fee_plan_get(p_plan, false);
  money := public.can_see_money(p.institute_id);
  with pr as (select * from public.fee_plan_rows(p.id)),
       st as (select * from public.fee_plan_students(p.id))
  select jsonb_build_object(
    'plan', jsonb_build_object('id', p.id, 'academic_year', p.academic_year, 'class_label', p.class_label,
                               'board', p.board, 'section', p.section, 'auto_apply', p.auto_apply),
    'money_hidden', not money,
    'students', (select count(*) from st),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', it.id, 'head', it.head, 'amount', case when money then it.amount end, 'due_date', it.due_date,
                'who', it.who,
                'missing', (select count(*) from pr r where r.item_id = it.id and r.state = 'missing'),
                'same', (select count(*) from pr r where r.item_id = it.id and r.state = 'same'),
                'has', (select count(*) from pr r where r.item_id = it.id and r.state = 'has'),
                'change', (select count(*) from pr r where r.item_id = it.id and r.state = 'change'),
                'other', (select count(*) from pr r where r.item_id = it.id and r.state = 'other'),
                'cancelled', (select count(*) from pr r where r.item_id = it.id and r.state = 'cancelled'),
                'ticked', (select count(*) from pr r join st on st.id = r.student_id
                           where r.item_id = it.id and r.state = 'missing' and (it.who = 'all' or (it.who = 'bus' and st.uses_bus))))
                order by it.sort_order, it.created_at), '[]'::jsonb)
              from public.fee_plan_items it where it.plan_id = p.id and it.removed_at is null),
    'removed', (select coalesce(jsonb_agg(jsonb_build_object('id', z.item_id, 'head', z.head, 'students', z.n)), '[]'::jsonb)
                from (select x.item_id, x.head, count(*) as n from public.fee_plan_removed_rows(p.id) x group by x.item_id, x.head) z),
    'rules', (select coalesce(jsonb_agg(jsonb_build_object('id', ru.id, 'reason', ru.reason,
                'reason_label', public.discount_reason_label(ru.reason), 'note', ru.note, 'percent', ru.percent,
                'amount', case when money then ru.amount end, 'heads', to_jsonb(ru.heads),
                'given', (select count(distinct x.student_id) from public.discounts x
                          where x.plan_rule_id = ru.id and not x.is_removed)) order by ru.created_at), '[]'::jsonb)
              from public.fee_plan_rules ru where ru.plan_id = p.id and ru.removed_at is null),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'student_id', s.id, 'name', s.name, 'admission_no', s.admission_no, 'section', s.section, 'board', s.board,
               'uses_bus', s.uses_bus,
               'items', (select coalesce(jsonb_object_agg(r.item_id, r.state), '{}'::jsonb) from pr r where r.student_id = s.id),
               'rules', (select coalesce(jsonb_agg(distinct x.plan_rule_id), '[]'::jsonb) from public.discounts x
                         join public.fee_plan_rules ru on ru.id = x.plan_rule_id and ru.plan_id = p.id
                         where x.student_id = s.id and not x.is_removed))
               order by s.section nulls last, s.name, s.id), '[]'::jsonb)
             from st s))
  into out;
  return out;
end $$;

-- Applies a fee plan to its students (see fee_plan_apply_core). Owner or Accounts. Audit fee_plan.applied
-- <plan>:<apply>:<added>:<changed>:<removed>:<discounts>. Returns { apply_id, plan_id, students, added,
-- linked, changed, removed, discounts, leads_updated, can_undo }.
create or replace function public.fee_plan_apply(p_plan uuid, p_chosen jsonb default null, p_rules jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  p    public.fee_plans;
  seat public.seats;
begin
  p := public.fee_plan_get(p_plan, true);
  seat := public.ledger_manager_seat(p.institute_id);
  return public.fee_plan_apply_core(p.id, seat, null, p_chosen, p_rules, true);
end $$;

-- The fee plans of a new student's class (those with auto_apply): the fees every student pays, and the bus
-- fees when the student uses the bus. Owner or Accounts. Returns { plans, added, heads [names added] }.
create or replace function public.fee_plan_apply_student(p_student uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  st    public.students;
  seat  public.seats;
  p     record;
  res   jsonb;
  n     int := 0;
  added int := 0;
  hds   jsonb := '[]'::jsonb;
begin
  st := public.ledger_student(p_student, true);
  seat := public.ledger_manager_seat(st.institute_id);
  for p in select f.id from public.fee_plans f where f.institute_id = st.institute_id and f.auto_apply
             and exists (select 1 from public.fee_plan_students(f.id) s where s.id = st.id)
           order by f.created_at loop
    res := public.fee_plan_apply_core(p.id, seat, st.id, null, null, false);
    n := n + 1;
    added := added + (res ->> 'added')::int;
    hds := hds || coalesce((select jsonb_agg(fi.head order by fi.due_date) from public.fee_items fi
                            where fi.plan_apply_id = (res ->> 'apply_id')::uuid), '[]'::jsonb);
  end loop;
  return jsonb_build_object('plans', n, 'added', added, 'heads', hds);
end $$;

-- Undoes an apply that only added fees and discounts: its fees are cancelled ("Undo") and its discounts removed;
-- applying the plan again adds them again. Owner or Accounts. Audit fee_plan.undone <apply>.
create or replace function public.fee_plan_undo(p_apply uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  a     public.fee_plan_applies;
  seat  public.seats;
  n_f   int;
  n_d   int;
  sid   uuid;
begin
  select * into a from public.fee_plan_applies where id = p_apply for update;
  if a.id is null or not public.can_manage_ledger(a.institute_id) then
    raise exception 'not found' using errcode = '42501';
  end if;
  seat := public.ledger_manager_seat(a.institute_id);
  if a.undone_at is not null then raise exception 'this was already undone' using errcode = '22023'; end if;
  if a.changed > 0 or a.removed > 0 then
    raise exception 'this change cannot be undone: it changed fees students already had' using errcode = '22023';
  end if;
  update public.fee_plan_applies set undone_at = now(), undone_by = seat.id where id = a.id;
  update public.discounts set is_removed = true, removed_reason = 'Undo', removed_at = now(), removed_by = seat.id
   where plan_apply_id = a.id and not is_removed;
  get diagnostics n_d = row_count;
  update public.fee_items set is_void = true, void_reason = 'Undo', voided_at = now(), voided_by = seat.id
   where plan_apply_id = a.id and not is_void;
  get diagnostics n_f = row_count;
  for sid in select distinct x.student_id from (
               select fi.student_id from public.fee_items fi where fi.plan_apply_id = a.id
               union select d.student_id from public.discounts d where d.plan_apply_id = a.id) x loop
    perform public.ledger_sync_student(sid);
  end loop;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (a.institute_id, auth.uid(), 'fee_plan.undone', a.id::text);
  return jsonb_build_object('fees_cancelled', n_f, 'discounts_removed', n_d);
end $$;

-- "Uses the school bus" on a student (bus fees of fee plans follow it). Owner or Accounts. Audit student.changed.
create or replace function public.accounts_set_uses_bus(p_student uuid, p_uses_bus boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare st public.students;
begin
  st := public.ledger_student(p_student, true);
  perform public.ledger_manager_seat(st.institute_id);
  update public.students set uses_bus = coalesce(p_uses_bus, false) where id = st.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (st.institute_id, auth.uid(), 'student.changed', st.id::text);
end $$;

-- The import with fee plans: accounts_import_students(p_rows) as before; then, when p_apply_plans, every
-- student this call added gets the fee plans of its class (fee_plan_apply_student). The answer has
-- plan_fee_items_added too.
create or replace function public.accounts_import_students(p_rows jsonb, p_apply_plans boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  res  jsonb;
  seat public.seats;
  sid  uuid;
  n    int := 0;
begin
  res := public.accounts_import_students(p_rows);
  if coalesce(p_apply_plans, false) then
    seat := public.my_active_seat();
    for sid in select s.id from public.students s
               where s.institute_id = seat.institute_id and s.source = 'import' and s.created_at = now() and s.created_by = seat.id
               order by s.id loop
      n := n + (public.fee_plan_apply_student(sid) ->> 'added')::int;
    end loop;
  end if;
  return res || jsonb_build_object('plan_fee_items_added', n);
end $$;

-- =====================================================================================================
-- 5. Discounts: RPCs
-- =====================================================================================================

-- Gives a discount to a student. p_data: { kind 'amount' | 'percent', value, fee_items [ids] (null or empty
-- with whole_year true = every fee of the year), whole_year, academic_year (default the student's), reason
-- (sibling, staff_child, merit, financial_help, other), note (needed for other), approved_by (default the
-- signed-in person's name) }. Owners and Accounts; managers only when they can see money. The discount is
-- split over the fees (see discount_give_rows); a percent applies to each fee. Fees leads follow the new
-- balance. Audit discount.given <grant>:<student>. Returns { grant_id, amount, fees }.
create or replace function public.accounts_give_discount(p_student uuid, p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  st     public.students;
  seat   public.seats;
  d      jsonb := coalesce(p_data, '{}'::jsonb);
  kind   text := lower(trim(coalesce(d ->> 'kind', '')));
  val    numeric;
  whole  boolean := coalesce((d ->> 'whole_year')::boolean, false);
  yr     text;
  items  uuid[];
  rsn    text := lower(trim(coalesce(d ->> 'reason', '')));
  nt     text := nullif(left(trim(coalesce(d ->> 'note', '')), 200), '');
  appr   text;
  gid    uuid := gen_random_uuid();
  total  numeric;
begin
  select * into st from public.students where id = p_student;
  if st.id is null or not public.can_give_discount(st.institute_id) then
    raise exception 'student not found' using errcode = '42501';
  end if;
  seat := public.my_active_seat();
  if seat.id is null or seat.institute_id <> st.institute_id then raise exception 'student not found' using errcode = '42501'; end if;
  if jsonb_typeof(d) <> 'object' then raise exception 'send the discount as an object' using errcode = '22023'; end if;
  if kind not in ('amount', 'percent') then raise exception 'pick an amount or a percent' using errcode = '22023'; end if;
  val := public.ledger_amount(d ->> 'value');
  if val is null or val <= 0 then raise exception 'enter the discount' using errcode = '22023'; end if;
  if kind = 'percent' and val > 100 then raise exception 'a percent discount can be at most 100' using errcode = '22023'; end if;
  if rsn not in ('sibling', 'staff_child', 'merit', 'financial_help', 'other') then
    raise exception 'pick the reason: sibling, staff child, merit, financial help or other' using errcode = '22023';
  end if;
  if rsn = 'other' and nt is null then raise exception 'write what the discount is for' using errcode = '22023'; end if;
  appr := coalesce(nullif(left(trim(coalesce(d ->> 'approved_by', '')), 80), ''), nullif(trim(seat.label), ''), 'Fees office');
  if whole then
    yr := coalesce(nullif(trim(coalesce(d ->> 'academic_year', '')), ''), st.academic_year);
    select coalesce(array_agg(fi.id), '{}') into items from public.fee_items fi
     where fi.student_id = st.id and not fi.is_void and (yr is null or fi.academic_year is null or fi.academic_year = yr);
  else
    if coalesce(jsonb_typeof(d -> 'fee_items'), '') <> 'array' or jsonb_array_length(d -> 'fee_items') = 0 then
      raise exception 'pick the fees the discount is on' using errcode = '22023';
    end if;
    select coalesce(array_agg(fi.id), '{}') into items from public.fee_items fi
     where fi.student_id = st.id and not fi.is_void
       and fi.id in (select (v #>> '{}')::uuid from jsonb_array_elements(d -> 'fee_items') v);
    if cardinality(items) <> jsonb_array_length(d -> 'fee_items') then
      raise exception 'a fee picked is not one of this student''s fees' using errcode = '22023';
    end if;
  end if;
  if cardinality(items) = 0 then raise exception 'this student has no fees to give a discount on' using errcode = '22023'; end if;
  total := public.discount_give_rows(st.id, items, kind, val, case when whole then 'year' else 'fees' end, rsn, nt, appr,
                                     seat.id, gid);
  if total <= 0 then raise exception 'these fees are already fully discounted' using errcode = '22023'; end if;
  perform public.ledger_sync_student(st.id);
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (st.institute_id, auth.uid(), 'discount.given', gid::text || ':' || st.id::text);
  return jsonb_build_object('grant_id', gid, 'amount', total,
                            'fees', (select count(*) from public.discounts x where x.grant_id = gid));
end $$;

-- Removes a discount (every row of the grant). It stays in the history with the reason. Same people as
-- accounts_give_discount. Fees leads follow the new balance. Audit discount.removed <grant>:<student>.
create or replace function public.accounts_remove_discount(p_grant uuid, p_reason text)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  x    public.discounts;
  seat public.seats;
  why  text := trim(coalesce(p_reason, ''));
  n    int;
begin
  select * into x from public.discounts where grant_id = p_grant order by is_removed limit 1;
  if x.id is null or not public.can_give_discount(x.institute_id) then
    raise exception 'discount not found' using errcode = '42501';
  end if;
  seat := public.my_active_seat();
  if x.is_removed then raise exception 'this discount is already removed' using errcode = '22023'; end if;
  if length(why) not between 1 and 300 then raise exception 'give a reason (up to 300 characters)' using errcode = '22023'; end if;
  update public.discounts set is_removed = true, removed_reason = why, removed_at = now(), removed_by = seat.id
   where grant_id = p_grant and not is_removed;
  get diagnostics n = row_count;
  perform public.ledger_sync_student(x.student_id);
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (x.institute_id, auth.uid(), 'discount.removed', p_grant::text || ':' || x.student_id::text);
  return n;
end $$;

-- accounts_student_detail: as in 20261025130000, plus balance.discounts, each fee item's plan_item_id and
-- discount (live discounts on it), and discounts: [{ grant_id, reason, reason_label, note, percent, scope,
-- approved_by, amount, fees [{ fee_item_id, head, amount, fee_cancelled }], plan_rule_id, created_at,
-- created_by_label, is_removed, removed_reason, removed_at, removed_by_label }] newest first.
create or replace function public.accounts_student_detail(p_student uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  st    public.students;
  money boolean;
  out   jsonb;
begin
  st := public.ledger_student(p_student, false);
  money := public.can_see_money(st.institute_id);
  select jsonb_build_object(
    'student', to_jsonb(st),
    'money_hidden', not money,
    'can_discount', public.can_give_discount(st.institute_id),
    'balance', (select jsonb_build_object(
                  'total_fees', case when money then b.total_fees end,
                  'total_due_to_date', case when money then b.total_due_to_date end,
                  'paid', case when money then b.paid end,
                  'balance_due_now', case when money then b.balance_due_now end,
                  'balance_total', case when money then b.balance_total end,
                  'discounts', case when money then b.discounts end,
                  'last_payment_amount', case when money then b.last_payment_amount end,
                  'last_payment_on', b.last_payment_on, 'last_payment_mode', b.last_payment_mode)
                from public.student_balance_rows(st.institute_id, st.id) b),
    'fee_items', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', f.id, 'head', f.head, 'amount', case when money then f.amount end, 'due_date', f.due_date,
                    'academic_year', f.academic_year, 'is_void', f.is_void, 'void_reason', f.void_reason,
                    'voided_at', f.voided_at, 'created_at', f.created_at, 'plan_item_id', f.plan_item_id,
                    'discount', case when money then (select coalesce(sum(x.amount), 0) from public.discounts x
                                                      where x.fee_item_id = f.id and not x.is_removed) end)
                    order by f.due_date, f.created_at), '[]'::jsonb)
                  from public.fee_items f where f.student_id = st.id),
    'discounts', (select coalesce(jsonb_agg(g.j order by g.at desc), '[]'::jsonb) from (
                    select min(x.created_at) as at, jsonb_build_object(
                      'grant_id', x.grant_id, 'reason', min(x.reason), 'reason_label', public.discount_reason_label(min(x.reason)),
                      'note', min(x.note), 'percent', min(x.percent), 'scope', min(x.scope), 'approved_by', min(x.approved_by),
                      'amount', case when money then sum(x.amount) filter (where not fi.is_void) end,
                      'fees', jsonb_agg(jsonb_build_object('fee_item_id', x.fee_item_id, 'head', fi.head,
                                'amount', case when money then x.amount end, 'fee_cancelled', fi.is_void) order by fi.due_date),
                      'plan_rule_id', (array_agg(x.plan_rule_id))[1], 'created_at', min(x.created_at),
                      'created_by_label', (select s.label from public.seats s where s.id = (array_agg(x.created_by))[1]),
                      'is_removed', bool_and(x.is_removed), 'removed_reason', min(x.removed_reason), 'removed_at', max(x.removed_at),
                      'removed_by_label', (select s.label from public.seats s where s.id = (array_agg(x.removed_by))[1])) as j
                    from public.discounts x join public.fee_items fi on fi.id = x.fee_item_id
                    where x.student_id = st.id
                    group by x.grant_id, x.is_removed) g),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', p.id, 'amount', case when money then p.amount end, 'paid_on', p.paid_on, 'mode', p.mode,
                   'reference', p.reference, 'note', p.note, 'recorded_by', p.recorded_by,
                   'recorded_by_label', (select s.label from public.seats s where s.id = p.recorded_by),
                   'created_at', p.created_at, 'reverses_id', p.reverses_id,
                   'reversed_by', (select r.id from public.payments r where r.reverses_id = p.id))
                   order by p.paid_on desc, p.created_at desc), '[]'::jsonb)
                 from public.payments p where p.student_id = st.id),
    'calls', (select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
                select coalesce(o.dialled_at, o.uploaded_at) as at, jsonb_build_object(
                  'outcome_id', o.id, 'at', coalesce(o.dialled_at, o.uploaded_at), 'campaign_id', o.campaign_id,
                  'campaign_name', c.name, 'lead_id', o.lead_id, 'result_key', o.result_key,
                  'result_label', (select r.label from public.call_type_results_for(c.call_type_id, c.institute_id) r
                                   where r.key = o.result_key limit 1),
                  'promised_date', o.promised_date, 'promised_amount', case when money then o.amount end,
                  'caller', (select s.label from public.seats s where s.id = o.seat_id),
                  'corrects_id', o.corrects_id, 'note', coalesce(o.note, o.result_reason)) as j
                from public.call_outcomes o
                join public.leads l on l.id = o.lead_id
                left join public.campaigns c on c.id = o.campaign_id
                where l.student_id = st.id or l.id = st.admission_lead_id
                order by coalesce(o.dialled_at, o.uploaded_at) desc
                limit 200) x))
  into out;
  return out;
end $$;

-- =====================================================================================================
-- 6. Day closing ("Today's collection")
-- =====================================================================================================

-- The day closing sheet for one day (default today in the institute's time zone):
-- { day, today, money_hidden,
--   totals { payments, amount, reversed, reversed_amount, cheques, cheque_amount },
--   by_mode [{ mode, payments, amount }]  (all six modes, in the order cash, upi, cheque, card, bank, other),
--   by_person [{ seat_id, label, payments, amount }],
--   payments [{ id, at, student_id, student, class_label, section, admission_no, amount, mode, reference, note,
--               recorded_by_label, reversed, reversed_reason }]  (dated that day, oldest first; opening balances
--               of an import left out),
--   cheques [the cheque payments of the day that stand, for the bank],
--   reversals [{ id, of_id, at, student_id, student, class_label, section, amount, mode, reference, reason,
--                recorded_by_label, paid_on }]  (reversals of that day's payments, and reversals recorded that day) }
-- Totals count the payments that stand (reversed ones and reversals left out), the same as ledger_collected
-- and "Collected today". Owners, managers, Accounts; amounts null unless can_see_money().
create or replace function public.ledger_day_closing(p_institute uuid, p_day date default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  money boolean;
  today date;
  dy    date;
  tz    text;
  out   jsonb;
begin
  if not public.can_read_ledger(p_institute) then
    raise exception 'only accounts, owners and managers can see collections' using errcode = '42501';
  end if;
  money := public.can_see_money(p_institute);
  today := public.ledger_today(p_institute);
  tz := public.institute_tz(p_institute);
  dy := coalesce(p_day, today);
  if dy < date '2000-01-01' or dy > today + 366 then raise exception 'check the date' using errcode = '22023'; end if;
  with pay as (
    select p.*, not exists (select 1 from public.payments r where r.reverses_id = p.id) as live,
           (select r.note from public.payments r where r.reverses_id = p.id) as rev_reason,
           s.name as student, s.class_label, s.section, s.admission_no,
           (select se.label from public.seats se where se.id = p.recorded_by) as by_label
    from public.payments p join public.students s on s.id = p.student_id
    where p.institute_id = p_institute and p.paid_on = dy and p.reverses_id is null and not p.opening
  ), rev as (
    select r.*, s.name as student, s.class_label, s.section,
           (select se.label from public.seats se where se.id = r.recorded_by) as by_label
    from public.payments r join public.students s on s.id = r.student_id
    where r.institute_id = p_institute and r.reverses_id is not null and not r.opening
      and (r.paid_on = dy or (r.created_at at time zone tz)::date = dy)
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
  return out;
end $$;

-- =====================================================================================================
-- 7. Grants
-- =====================================================================================================

revoke all on function public.discount_reason_label(text) from public, anon;
grant execute on function public.discount_reason_label(text) to authenticated;
revoke all on function public.fee_plan_save(uuid, jsonb) from public, anon;
revoke all on function public.fee_plan_delete(uuid) from public, anon;
revoke all on function public.fee_plans_list() from public, anon;
revoke all on function public.fee_plan_preview(uuid) from public, anon;
revoke all on function public.fee_plan_apply(uuid, jsonb, jsonb) from public, anon;
revoke all on function public.fee_plan_apply_student(uuid) from public, anon;
revoke all on function public.fee_plan_undo(uuid) from public, anon;
revoke all on function public.accounts_set_uses_bus(uuid, boolean) from public, anon;
revoke all on function public.accounts_import_students(jsonb, boolean) from public, anon;
revoke all on function public.accounts_give_discount(uuid, jsonb) from public, anon;
revoke all on function public.accounts_remove_discount(uuid, text) from public, anon;
revoke all on function public.accounts_student_detail(uuid) from public, anon;
revoke all on function public.ledger_day_closing(uuid, date) from public, anon;
grant execute on function public.fee_plan_save(uuid, jsonb) to authenticated;
grant execute on function public.fee_plan_delete(uuid) to authenticated;
grant execute on function public.fee_plans_list() to authenticated;
grant execute on function public.fee_plan_preview(uuid) to authenticated;
grant execute on function public.fee_plan_apply(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.fee_plan_apply_student(uuid) to authenticated;
grant execute on function public.fee_plan_undo(uuid) to authenticated;
grant execute on function public.accounts_set_uses_bus(uuid, boolean) to authenticated;
grant execute on function public.accounts_import_students(jsonb, boolean) to authenticated;
grant execute on function public.accounts_give_discount(uuid, jsonb) to authenticated;
grant execute on function public.accounts_remove_discount(uuid, text) to authenticated;
grant execute on function public.accounts_student_detail(uuid) to authenticated;
grant execute on function public.ledger_day_closing(uuid, date) to authenticated;
