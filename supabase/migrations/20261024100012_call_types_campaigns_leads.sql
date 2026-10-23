-- Vector 2.0 Phase A, Sprint 7: call types and their results, campaigns, campaign members, leads in the
-- cloud, and campaign fields on call_outcomes. Apply after 20261012100011. Money rules (roles, "can see
-- money", "hide money", money columns) are in 20261024100013_money_rules.sql.
--
-- Lead names and numbers ARE stored here from now on (Phase A decision 1, 24 Oct 2026: lead lists live in
-- the cloud so campaigns can share them between callers). This replaces the rule in the header of
-- 20261011100001_init.sql ("Lead names and numbers are NOT stored here"). The laptop-only lead sheet keeps
-- working for calls made outside a campaign.
--
-- Call types are data, not code: built-in types and results are rows with institute_id null (seeded below),
-- and an institute adds its own through admin_upsert_call_type and admin_upsert_call_type_result.
-- The browser only reads these tables (RLS). Every write goes through a function that checks the caller's
-- role itself, or through the server. The contract for other features is in docs/data-contract.md.

-- ---------- call types ----------

-- A kind of calling work (Sales, Fees collection …). institute_id null = built in, for every institute.
create table public.call_types (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid references public.institutes (id) on delete cascade,
  key           text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label         text not null check (length(label) between 1 and 60),
  sort_order    int  not null default 100 check (sort_order between 0 and 10000),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique nulls not distinct (institute_id, key)
);

-- A result button for a call type (Paid, Will pay on date …).
--   call_type_id null and institute_id null: a common result every type has (No answer, Busy …).
--   institute_id set: an institute's own result, on its own type or on a built-in type.
-- needs_date / needs_amount / needs_reason / needs_rating: the caller must fill that field to save it.
-- counts_as_good: the call reached what the campaign wants (used for success rates).
-- legacy_outcome: the old call_outcomes.outcome value for this result, so the reports from 0004-0010 keep
-- counting calls saved with a result key.
create table public.call_type_results (
  id              uuid primary key default gen_random_uuid(),
  call_type_id    uuid references public.call_types (id) on delete cascade,
  institute_id    uuid references public.institutes (id) on delete cascade,
  key             text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label           text not null check (length(label) between 1 and 60),
  needs_date      boolean not null default false,
  needs_amount    boolean not null default false,
  needs_reason    boolean not null default false,
  needs_rating    boolean not null default false,
  reason_choices  text[] check (reason_choices is null or cardinality(reason_choices) between 1 and 20),
  counts_as_good  boolean not null default false,
  legacy_outcome  text not null default 'other' check (legacy_outcome in (
                    'answered', 'no_answer', 'busy', 'callback', 'interested',
                    'not_interested', 'won', 'dropped_network', 'other')),
  sort_order      int  not null default 100 check (sort_order between 0 and 10000),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  -- An institute cannot add common results; those are built in only.
  check (call_type_id is not null or institute_id is null),
  unique nulls not distinct (call_type_id, institute_id, key)
);

create index call_type_results_type on public.call_type_results (call_type_id);

-- ---------- campaigns ----------

-- Lets leads and members point at (seat, institute) so a row can never mix two institutes.
alter table public.seats add constraint seats_id_institute_key unique (id, institute_id);

create table public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  call_type_id  uuid not null references public.call_types (id) on delete restrict,
  script_id     uuid,
  start_date    date,
  end_date      date,
  status        text not null default 'draft' check (status in ('draft', 'running', 'paused', 'closed')),
  daily_target  int check (daily_target is null or daily_target between 1 and 10000),
  -- equal: leads are split into equal parts up front; next_free: whoever is free takes the next lead.
  share_mode    text not null default 'equal' check (share_mode in ('equal', 'next_free')),
  -- Hours to call in, set from Insights ("Set call hours"). Shape is decided by that feature; null = any time.
  call_hours    jsonb check (call_hours is null or (jsonb_typeof(call_hours) = 'object' and length(call_hours::text) <= 4000)),
  created_by    uuid references public.seats (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date),
  unique (id, institute_id),
  -- The script must be in the same institute.
  foreign key (script_id, institute_id) references public.scripts (id, institute_id) on delete set null (script_id)
);

create index campaigns_institute on public.campaigns (institute_id, status);

-- Which seats call for which campaign. A seat can be on more than one campaign.
create table public.campaign_members (
  campaign_id   uuid not null,
  seat_id       uuid not null,
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (campaign_id, seat_id),
  foreign key (campaign_id, institute_id) references public.campaigns (id, institute_id) on delete cascade,
  foreign key (seat_id, institute_id) references public.seats (id, institute_id) on delete cascade
);

create index campaign_members_seat on public.campaign_members (seat_id);

-- ---------- leads ----------

-- Phone numbers are stored as +91 and 10 digits. Same rules as normalizePhone in web/js/import-check.js:
-- remove spaces and hyphens, then +91 (or 91 on a 12-digit number), then one leading 0; 10 digits must be
-- left. Returns null for anything else.
create or replace function public.normalise_phone(p_raw text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare d text := regexp_replace(coalesce(p_raw, ''), '[\s\-]+', '', 'g');
begin
  if d like '+91%' then d := substr(d, 4);
  elsif d ~ '^91[0-9]{10}$' then d := substr(d, 3);
  end if;
  if d like '0%' then d := substr(d, 2); end if;
  if d !~ '^[0-9]{10}$' then return null; end if;
  return '+91' || d;
end $$;

-- True when a key of a lead's extra fields looks like money. Money has its own columns (amount_due,
-- promised_amount) so the money rules can protect it; extra fields are readable by every caller on the lead.
create or replace function public.extra_has_money_key(p_extra jsonb)
returns boolean
language sql immutable
set search_path = public
as $$
  select exists (
    select 1
    from jsonb_object_keys(p_extra) k,
         lateral unnest(regexp_split_to_array(lower(k), '[^a-z0-9₹]+')) w
    where w in ('amount', 'fee', 'fees', 'paid', 'balance', 'rupee', 'rupees', 'rs', 'inr', 'price', 'cost')
       or position('₹' in k) > 0
  );
$$;

create table public.leads (
  id                uuid primary key default gen_random_uuid(),
  institute_id      uuid not null references public.institutes (id) on delete cascade,
  campaign_id       uuid not null,
  name              text not null check (length(name) between 1 and 120),
  phone             text not null check (phone ~ '^\+91[0-9]{10}$'),
  -- Other columns from the uploaded sheet (student, class …). Never money: see extra_has_money_key.
  extra             jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(extra) = 'object' and length(extra::text) <= 8000
                           and not public.extra_has_money_key(extra)),
  -- Money (rules in 0013): readable only through lead_money() and money-checked functions.
  amount_due        numeric(12, 2) check (amount_due is null or amount_due >= 0),
  promised_amount   numeric(12, 2) check (promised_amount is null or promised_amount >= 0),
  assigned_seat_id  uuid,
  -- new: not called yet; callback: call again at next_call_at; promised: a promise is due on promised_date;
  -- done: finished; wrong_number: the number is not this person; do_not_call: asked not to be called.
  status            text not null default 'new'
                    check (status in ('new', 'callback', 'promised', 'done', 'wrong_number', 'do_not_call')),
  next_call_at      timestamptz,
  promised_date     date,
  -- consent_call: the institute may call this number (true when the institute uploads it).
  -- consent_whatsapp: the person agreed to WhatsApp messages (false until a caller records a yes).
  consent_call      boolean not null default true,
  consent_whatsapp  boolean not null default false,
  do_not_call       boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- The same number once per campaign.
  unique (campaign_id, phone),
  foreign key (campaign_id, institute_id) references public.campaigns (id, institute_id) on delete cascade,
  foreign key (assigned_seat_id, institute_id) references public.seats (id, institute_id)
    on delete set null (assigned_seat_id)
);

create index leads_seat_queue on public.leads (assigned_seat_id, status, next_call_at);
create index leads_institute on public.leads (institute_id, campaign_id);

-- ---------- triggers ----------

-- updated_at on every change.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger campaigns_touch before update on public.campaigns
  for each row execute function public.touch_updated_at();

-- A campaign's call type must be built in or the institute's own.
create or replace function public.campaigns_check()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (select 1 from call_types t
                 where t.id = new.call_type_id
                   and (t.institute_id is null or t.institute_id = new.institute_id)) then
    raise exception 'that call type is not available in this institute' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger campaigns_check before insert or update of call_type_id, institute_id on public.campaigns
  for each row execute function public.campaigns_check();

-- Leads: phone is normalised before the check; updated_at is kept; only an admin can clear "do not call".
create or replace function public.leads_before_write()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.phone := coalesce(public.normalise_phone(new.phone), new.phone);
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    if old.do_not_call and not new.do_not_call
       and auth.uid() is not null and not public.is_admin_of(old.institute_id) then
      raise exception 'only an admin can call this number again' using errcode = '42501';
    end if;
  end if;
  if new.do_not_call then new.status := 'do_not_call'; end if;
  return new;
end $$;

create trigger leads_before_write before insert or update on public.leads
  for each row execute function public.leads_before_write();

-- ---------- call_outcomes: campaign fields ----------

-- Old rows keep every new column null and are read exactly as before. The old outcome column stays
-- required; a row with result_key and no outcome gets the result's legacy_outcome.
alter table public.call_outcomes
  add column if not exists campaign_id   uuid references public.campaigns (id) on delete set null,
  add column if not exists lead_id       uuid references public.leads (id) on delete set null,
  add column if not exists result_key    text check (result_key is null or result_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- The date the result asks for: promised payment date, visit date, call-back date …
  add column if not exists promised_date date,
  -- Money (rules in 0013): the amount the result asks for, as reported by the caller.
  add column if not exists amount        numeric(12, 2) check (amount is null or amount >= 0),
  add column if not exists result_reason text check (result_reason is null or length(result_reason) <= 300),
  add column if not exists rating        smallint check (rating is null or rating between 1 and 5),
  -- Seconds spent on each script step: { "<step id>": seconds, … }.
  add column if not exists step_times    jsonb check (step_times is null or
                                           (jsonb_typeof(step_times) = 'object' and length(step_times::text) <= 20000)),
  -- The furthest script step the call reached (for the sales funnel: "heard the pitch").
  add column if not exists reached_step  text check (reached_step is null or length(reached_step) <= 80);

create index if not exists call_outcomes_campaign on public.call_outcomes (campaign_id) where campaign_id is not null;
create index if not exists call_outcomes_lead on public.call_outcomes (lead_id) where lead_id is not null;

-- Internal (granted to nobody): the active results a campaign of this type can save in this institute:
-- the type's built-in results, the institute's own results on the type, then the common results.
create or replace function public.call_type_results_for(p_call_type uuid, p_institute uuid)
returns setof public.call_type_results
language sql stable security definer set search_path = public
as $$
  select r.* from public.call_type_results r
  where r.active
    and ((r.call_type_id = p_call_type and (r.institute_id is null or r.institute_id = p_institute))
         or (r.call_type_id is null and r.institute_id is null))
  order by (r.call_type_id is null), r.sort_order, r.label;
$$;

-- Checks the campaign fields of a new outcome. Runs as the table owner so it can read the lead and campaign
-- even when the caller's RLS hides them (for example a lead moved to another caller while the phone was offline).
create or replace function public.call_outcomes_check()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  l public.leads;
  c public.campaigns;
  r public.call_type_results;
begin
  if new.lead_id is not null then
    select * into l from leads where id = new.lead_id;
    if l.id is null or l.institute_id <> new.institute_id then
      raise exception 'lead not found in this institute' using errcode = '23514';
    end if;
    if new.campaign_id is null then new.campaign_id := l.campaign_id;
    elsif new.campaign_id <> l.campaign_id then
      raise exception 'the lead is not in that campaign' using errcode = '23514';
    end if;
  end if;

  if new.campaign_id is not null then
    select * into c from campaigns where id = new.campaign_id;
    if c.id is null or c.institute_id <> new.institute_id then
      raise exception 'campaign not found in this institute' using errcode = '23514';
    end if;
  end if;

  if new.result_key is not null then
    if c.id is null then raise exception 'a result needs a campaign' using errcode = '23514'; end if;
    select * into r from call_type_results_for(c.call_type_id, c.institute_id) x where x.key = new.result_key limit 1;
    if r.id is null then
      raise exception 'result % is not a result of this campaign''s call type', new.result_key using errcode = '23514';
    end if;
    if r.needs_date and new.promised_date is null then
      raise exception '% needs a date', r.label using errcode = '23514';
    end if;
    if r.needs_amount and new.amount is null then
      raise exception '% needs an amount', r.label using errcode = '23514';
    end if;
    if r.needs_reason and coalesce(trim(new.result_reason), '') = '' then
      raise exception '% needs a reason', r.label using errcode = '23514';
    end if;
    if r.needs_rating and new.rating is null then
      raise exception '% needs a rating', r.label using errcode = '23514';
    end if;
    if new.outcome is null then new.outcome := r.legacy_outcome; end if;
  end if;
  return new;
end $$;

create trigger call_outcomes_check before insert on public.call_outcomes
  for each row execute function public.call_outcomes_check();

-- ---------- row-level security: reads only, except a caller's own leads ----------

alter table public.call_types        enable row level security;
alter table public.call_type_results enable row level security;
alter table public.campaigns         enable row level security;
alter table public.campaign_members  enable row level security;
alter table public.leads             enable row level security;

-- Call types and results: anyone with an active seat reads the built-in rows and their own institute's rows.
create policy call_types_read on public.call_types
  for select using (exists (
    select 1 from public.seats s
    where s.user_id = auth.uid() and s.status = 'active'
      and (call_types.institute_id is null or s.institute_id = call_types.institute_id)));

create policy call_type_results_read on public.call_type_results
  for select using (exists (
    select 1 from public.seats s
    where s.user_id = auth.uid() and s.status = 'active'
      and (call_type_results.institute_id is null or s.institute_id = call_type_results.institute_id)));

-- Campaigns: admins read their institute's; a caller reads the campaigns their active seat is on, not drafts.
create policy campaigns_read on public.campaigns
  for select using (
    public.is_admin_of(institute_id)
    or (status <> 'draft' and exists (
      select 1 from public.campaign_members m
      join public.seats s on s.id = m.seat_id
      where m.campaign_id = campaigns.id and s.user_id = auth.uid() and s.status = 'active')));

create policy campaign_members_read on public.campaign_members
  for select using (
    public.is_admin_of(institute_id)
    or exists (select 1 from public.seats s
               where s.id = campaign_members.seat_id and s.user_id = auth.uid() and s.status = 'active'));

-- Leads: a caller reads and updates only the leads assigned to their own active seat. Admins read and update
-- their institute's leads. Nobody inserts or deletes from the browser (lead upload is a checked function).
create policy leads_read on public.leads
  for select using (
    public.is_admin_of(institute_id)
    or exists (select 1 from public.seats s
               where s.id = leads.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active'));

create policy leads_update on public.leads
  for update using (
    public.is_admin_of(institute_id)
    or exists (select 1 from public.seats s
               where s.id = leads.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active'))
  with check (
    public.is_admin_of(institute_id)
    or exists (select 1 from public.seats s
               where s.id = leads.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active'));

-- ---------- privileges ----------

revoke all on public.call_types, public.call_type_results, public.campaigns, public.campaign_members, public.leads
  from anon, authenticated;
grant select on public.call_types, public.call_type_results, public.campaigns, public.campaign_members
  to authenticated;
-- Leads: column grants. amount_due and promised_amount are left out on purpose (money rules, 0013). A new
-- leads column is invisible to the browser until it is granted here in a later migration.
grant select (id, institute_id, campaign_id, name, phone, extra, assigned_seat_id, status, next_call_at,
              promised_date, consent_call, consent_whatsapp, do_not_call, created_at, updated_at)
  on public.leads to authenticated;
-- What a caller changes after a call. Moving a lead, the campaign or the number goes through functions.
grant update (status, next_call_at, promised_date, promised_amount, consent_call, consent_whatsapp, do_not_call)
  on public.leads to authenticated;

-- ---------- functions ----------

-- Every call type the caller's institute can use (built in and its own, active or not), each with its
-- active results as a list. Admin only.
create or replace function public.admin_list_call_types()
returns table (id uuid, key text, label text, sort_order int, active boolean, built_in boolean, results jsonb)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin can manage call types' using errcode = '42501';
  end if;
  return query
    select t.id, t.key, t.label, t.sort_order, t.active, t.institute_id is null,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', r.id, 'key', r.key, 'label', r.label,
                     'needs_date', r.needs_date, 'needs_amount', r.needs_amount,
                     'needs_reason', r.needs_reason, 'needs_rating', r.needs_rating,
                     'reason_choices', r.reason_choices, 'counts_as_good', r.counts_as_good,
                     'sort_order', r.sort_order, 'common', r.call_type_id is null,
                     'built_in', r.institute_id is null)), '[]'::jsonb)
              from public.call_type_results_for(t.id, seat.institute_id) r)
    from public.call_types t
    where t.institute_id is null or t.institute_id = seat.institute_id
    order by t.sort_order, t.label;
end $$;

-- A key from a label: "Fee follow-up" -> "fee_follow_up".
create or replace function public.key_from_label(p_label text)
returns text
language sql immutable
set search_path = public
as $$
  select left(trim(both '_' from regexp_replace(lower(coalesce(p_label, '')), '[^a-z0-9]+', '_', 'g')), 40);
$$;

-- Add (p_id null) or change one of the institute's own call types. Built-in types cannot be changed.
-- p_key is set once when the type is added (from the label when null) and never changes. Returns the id.
create or replace function public.admin_upsert_call_type(
  p_id uuid, p_label text, p_key text default null, p_sort_order int default null, p_active boolean default true)
returns uuid
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
  t    public.call_types;
  lbl  text := trim(coalesce(p_label, ''));
  k    text;
  tid  uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin can manage call types' using errcode = '42501';
  end if;
  if length(lbl) not between 1 and 60 then
    raise exception 'name must be 1 to 60 characters' using errcode = '22023';
  end if;
  if p_sort_order is not null and p_sort_order not between 0 and 10000 then
    raise exception 'order must be 0 to 10000' using errcode = '22023';
  end if;

  if p_id is null then
    k := coalesce(nullif(trim(p_key), ''), public.key_from_label(lbl));
    if k !~ '^[a-z][a-z0-9_]{1,39}$' then
      raise exception 'key must start with a letter and use only a-z, 0-9 and _' using errcode = '22023';
    end if;
    if exists (select 1 from call_types x
               where x.key = k and (x.institute_id is null or x.institute_id = seat.institute_id)) then
      raise exception 'a call type with this key already exists' using errcode = '23505';
    end if;
    insert into call_types (institute_id, key, label, sort_order, active)
      values (seat.institute_id, k, lbl, coalesce(p_sort_order, 500), coalesce(p_active, true))
      returning id into tid;
    insert into audit_log (institute_id, actor_id, action, target)
      values (seat.institute_id, auth.uid(), 'call_type.added', tid::text);
  else
    select * into t from call_types where id = p_id;
    if t.id is null or (t.institute_id is not null and t.institute_id <> seat.institute_id) then
      raise exception 'call type not found' using errcode = '22023';
    end if;
    if t.institute_id is null then
      raise exception 'built-in call types cannot be changed' using errcode = '42501';
    end if;
    update call_types set label = lbl, sort_order = coalesce(p_sort_order, sort_order),
                          active = coalesce(p_active, active)
      where id = p_id;
    tid := p_id;
    insert into audit_log (institute_id, actor_id, action, target)
      values (seat.institute_id, auth.uid(), 'call_type.changed', tid::text);
  end if;
  return tid;
end $$;

-- Add (p_id null) or change one of the institute's own results. A result can be added to a built-in type or
-- to the institute's own type. Built-in and common results cannot be changed. The key is set once (from the
-- label when null) and must not clash with another result of the type or a common result. Returns the id.
create or replace function public.admin_upsert_call_type_result(
  p_id uuid, p_call_type uuid, p_label text, p_key text default null,
  p_needs_date boolean default false, p_needs_amount boolean default false,
  p_needs_reason boolean default false, p_needs_rating boolean default false,
  p_counts_as_good boolean default false, p_reason_choices text[] default null,
  p_sort_order int default null, p_active boolean default true)
returns uuid
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
  t    public.call_types;
  r    public.call_type_results;
  lbl  text := trim(coalesce(p_label, ''));
  k    text;
  rid  uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin can manage call types' using errcode = '42501';
  end if;
  if length(lbl) not between 1 and 60 then
    raise exception 'name must be 1 to 60 characters' using errcode = '22023';
  end if;
  if p_sort_order is not null and p_sort_order not between 0 and 10000 then
    raise exception 'order must be 0 to 10000' using errcode = '22023';
  end if;
  if p_reason_choices is not null and cardinality(p_reason_choices) not between 1 and 20 then
    raise exception 'give 1 to 20 reasons, or none' using errcode = '22023';
  end if;

  if p_id is null then
    select * into t from call_types where id = p_call_type;
    if t.id is null or (t.institute_id is not null and t.institute_id <> seat.institute_id) then
      raise exception 'call type not found' using errcode = '22023';
    end if;
    k := coalesce(nullif(trim(p_key), ''), public.key_from_label(lbl));
    if k !~ '^[a-z][a-z0-9_]{1,39}$' then
      raise exception 'key must start with a letter and use only a-z, 0-9 and _' using errcode = '22023';
    end if;
    if exists (select 1 from call_type_results x
               where x.key = k
                 and ((x.call_type_id = t.id and (x.institute_id is null or x.institute_id = seat.institute_id))
                      or x.call_type_id is null)) then
      raise exception 'this call type already has a result with this key' using errcode = '23505';
    end if;
    insert into call_type_results (call_type_id, institute_id, key, label, needs_date, needs_amount,
                                   needs_reason, needs_rating, reason_choices, counts_as_good,
                                   legacy_outcome, sort_order, active)
      values (t.id, seat.institute_id, k, lbl, coalesce(p_needs_date, false), coalesce(p_needs_amount, false),
              coalesce(p_needs_reason, false), coalesce(p_needs_rating, false), p_reason_choices,
              coalesce(p_counts_as_good, false),
              case when coalesce(p_counts_as_good, false) then 'won' else 'other' end,
              coalesce(p_sort_order, 500), coalesce(p_active, true))
      returning id into rid;
    insert into audit_log (institute_id, actor_id, action, target)
      values (seat.institute_id, auth.uid(), 'call_type_result.added', rid::text);
  else
    select * into r from call_type_results where id = p_id;
    if r.id is null or (r.institute_id is not null and r.institute_id <> seat.institute_id) then
      raise exception 'result not found' using errcode = '22023';
    end if;
    if r.institute_id is null then
      raise exception 'built-in results cannot be changed' using errcode = '42501';
    end if;
    update call_type_results
       set label = lbl,
           needs_date = coalesce(p_needs_date, needs_date),
           needs_amount = coalesce(p_needs_amount, needs_amount),
           needs_reason = coalesce(p_needs_reason, needs_reason),
           needs_rating = coalesce(p_needs_rating, needs_rating),
           reason_choices = p_reason_choices,
           counts_as_good = coalesce(p_counts_as_good, counts_as_good),
           legacy_outcome = case when coalesce(p_counts_as_good, counts_as_good) then 'won' else 'other' end,
           sort_order = coalesce(p_sort_order, sort_order),
           active = coalesce(p_active, active)
     where id = p_id;
    rid := p_id;
    insert into audit_log (institute_id, actor_id, action, target)
      values (seat.institute_id, auth.uid(), 'call_type_result.changed', rid::text);
  end if;
  return rid;
end $$;

-- The campaigns the caller's active seat is on, running or paused (not drafts, not closed), with the
-- campaign's result buttons and how many of the caller's leads there are and are due now. No money.
create or replace function public.my_campaigns()
returns table (campaign_id uuid, name text, status text, call_type_key text, call_type_label text,
               script_id uuid, start_date date, end_date date, daily_target int, call_hours jsonb,
               my_leads bigint, my_leads_due bigint, results jsonb)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  return query
    select c.id, c.name, c.status, t.key, t.label, c.script_id, c.start_date, c.end_date, c.daily_target,
           c.call_hours,
           (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = seat.id),
           (select count(*) from public.leads l
             where l.campaign_id = c.id and l.assigned_seat_id = seat.id
               and l.status in ('new', 'callback', 'promised') and not l.do_not_call
               and (l.next_call_at is null or l.next_call_at <= now())),
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', r.key, 'label', r.label,
                     'needs_date', r.needs_date, 'needs_amount', r.needs_amount,
                     'needs_reason', r.needs_reason, 'needs_rating', r.needs_rating,
                     'reason_choices', r.reason_choices, 'counts_as_good', r.counts_as_good,
                     'common', r.call_type_id is null)), '[]'::jsonb)
              from public.call_type_results_for(c.call_type_id, c.institute_id) r)
    from public.campaign_members m
    join public.campaigns c on c.id = m.campaign_id
    join public.call_types t on t.id = c.call_type_id
    where m.seat_id = seat.id and c.status in ('running', 'paused')
    order by c.status, c.name;
end $$;

-- ---------- grants ----------

revoke all on function public.call_type_results_for(uuid, uuid) from public, anon, authenticated;
revoke all on function public.call_outcomes_check() from public, anon, authenticated;
revoke all on function public.campaigns_check() from public, anon, authenticated;
revoke all on function public.leads_before_write() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

revoke all on function public.normalise_phone(text) from public, anon;
revoke all on function public.extra_has_money_key(jsonb) from public, anon;
revoke all on function public.key_from_label(text) from public, anon;
revoke all on function public.admin_list_call_types() from public, anon;
revoke all on function public.admin_upsert_call_type(uuid, text, text, int, boolean) from public, anon;
revoke all on function public.admin_upsert_call_type_result(uuid, uuid, text, text, boolean, boolean, boolean,
  boolean, boolean, text[], int, boolean) from public, anon;
revoke all on function public.my_campaigns() from public, anon;
grant execute on function public.normalise_phone(text) to authenticated;
grant execute on function public.extra_has_money_key(jsonb) to authenticated;
grant execute on function public.key_from_label(text) to authenticated;
grant execute on function public.admin_list_call_types() to authenticated;
grant execute on function public.admin_upsert_call_type(uuid, text, text, int, boolean) to authenticated;
grant execute on function public.admin_upsert_call_type_result(uuid, uuid, text, text, boolean, boolean, boolean,
  boolean, boolean, text[], int, boolean) to authenticated;
grant execute on function public.my_campaigns() to authenticated;

-- ---------- seed: built-in call types and results (Phase A list, 24 Oct) ----------

insert into public.call_types (key, label, sort_order) values
  ('sales',      'Sales',                     10),
  ('fees',       'Fees collection',           20),
  ('follow_up',  'Follow-up / appointment',   30),
  ('admission',  'Admission enquiry',         40),
  ('absence',    'Absence call',              50),
  ('event',      'Event or PTM reminder',     60),
  ('feedback',   'Feedback or survey',        70),
  ('renewal',    'Renewal / re-enrolment',    80);

-- type key, result key, label, date, amount, reason, rating, reason choices, good, legacy outcome, order
insert into public.call_type_results (call_type_id, key, label, needs_date, needs_amount, needs_reason,
                                      needs_rating, reason_choices, counts_as_good, legacy_outcome, sort_order)
select t.id, v.rkey, v.label, v.d, v.a, v.r, v.rt, v.choices, v.good, v.legacy, v.ord
from (values
  ('sales',     'joined',           'Joined',              false, false, false, false, null::text[], true,  'won',            10),
  ('sales',     'interested',       'Interested',          false, false, false, false, null,         false, 'interested',     20),
  ('sales',     'will_think',       'Will think',          false, false, false, false, null,         false, 'callback',       30),
  ('sales',     'not_interested',   'Not interested',      false, false, true,  false, null,         false, 'not_interested', 40),
  ('fees',      'paid',             'Paid',                false, true,  false, false, null,         true,  'won',            10),
  ('fees',      'will_pay_on',      'Will pay on date',    true,  true,  false, false, null,         true,  'interested',     20),
  ('fees',      'paid_part',        'Paid part',           false, true,  false, false, null,         true,  'won',            30),
  ('fees',      'already_paid',     'Says already paid',   false, false, false, false, null,         false, 'answered',       40),
  ('fees',      'refused',          'Refused',             false, false, true,  false, null,         false, 'not_interested', 50),
  ('follow_up', 'confirmed',        'Confirmed',           false, false, false, false, null,         true,  'won',            10),
  ('follow_up', 'new_date',         'New date',            true,  false, false, false, null,         false, 'callback',       20),
  ('follow_up', 'cancelled',        'Cancelled',           false, false, true,  false, null,         false, 'not_interested', 30),
  ('admission', 'visit_booked',     'Visit booked',        true,  false, false, false, null,         true,  'won',            10),
  ('admission', 'form_sent',        'Form sent',           false, false, false, false, null,         true,  'interested',     20),
  ('admission', 'not_this_year',    'Not this year',       false, false, false, false, null,         false, 'not_interested', 30),
  ('admission', 'joined_elsewhere', 'Joined elsewhere',    false, false, false, false, null,         false, 'not_interested', 40),
  ('absence',   'reason_given',     'Reason given',        false, false, true,  false, array['Sick', 'Travel', 'Other'], true, 'answered', 10),
  ('absence',   'will_come_on',     'Will come on',        true,  false, false, false, null,         true,  'answered',       20),
  ('absence',   'needs_counsellor', 'Needs counsellor',    false, false, false, false, null,         false, 'answered',       30),
  ('event',     'coming',           'Coming',              false, false, false, false, null,         true,  'won',            10),
  ('event',     'not_coming',       'Not coming',          false, false, false, false, null,         false, 'not_interested', 20),
  ('event',     'maybe',            'Maybe',               false, false, false, false, null,         false, 'answered',       30),
  ('feedback',  'rated',            'Rating given',        false, false, false, true,  null,         true,  'answered',       10),
  ('feedback',  'refused',          'Refused',             false, false, false, false, null,         false, 'not_interested', 20),
  ('renewal',   'renewed',          'Renewed',             false, false, false, false, null,         true,  'won',            10),
  ('renewal',   'will_renew_on',    'Will renew on date',  true,  false, false, false, null,         false, 'interested',     20),
  ('renewal',   'not_renewing',     'Not renewing',        false, false, true,  false, null,         false, 'not_interested', 30)
) as v(tkey, rkey, label, d, a, r, rt, choices, good, legacy, ord)
join public.call_types t on t.key = v.tkey and t.institute_id is null;

-- Common results: every call type has these.
insert into public.call_type_results (call_type_id, key, label, needs_date, counts_as_good, legacy_outcome, sort_order)
values
  (null, 'no_answer',       'No answer',           false, false, 'no_answer',      900),
  (null, 'busy',            'Busy',                false, false, 'busy',           910),
  (null, 'wrong_number',    'Wrong number',        false, false, 'other',          920),
  (null, 'call_back_later', 'Call back later',     true,  false, 'callback',       930),
  (null, 'do_not_call',     'Do not call again',   false, false, 'not_interested', 940);
