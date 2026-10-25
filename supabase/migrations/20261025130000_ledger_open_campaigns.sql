-- Vector Phase A.2: open campaigns and the fee ledger (docs/phase-a-plan.md, "Phase A.2"; contract in
-- docs/data-contract.md, section "Phase A.2: open campaigns and the fee ledger"). Apply after
-- 20261025120000_campaign_script_pushbacks.sql.
--
-- 1. Accounts role. A new kind of seat for the fees office: seats.role 'accounts' with admin_kind 'accounts'
--    (access_role 'accounts'). It is NOT an admin: is_admin_of() stays false for it and every check of
--    role = 'admin' refuses it, so it cannot manage seats, roles, campaigns, scripts or call types. It reads
--    the ledger and always sees money (hide_money does not apply: the fees office cannot work without
--    amounts), records and reverses payments, imports students and fees, and creates fees campaigns from
--    the ledger. New helpers: is_accounts_of(), can_read_ledger(), can_manage_ledger().
-- 2. Open campaigns. campaigns.open_to_all (default true, so every existing campaign is open): every active
--    seat of the institute can see and work a running or paused open campaign without being a member;
--    restricted campaigns (open_to_all false) keep the member rule. Tags: class_label ('8th') and board.
--    Leads of open campaigns are taken from the pool with next_free_lead(); a lead already assigned stays
--    with its caller. New open campaigns share by next_free unless told otherwise.
-- 3. The fee ledger: students, fee_items, payments (corrections by reversal, never edited or deleted),
--    balances per student, leads.student_id. Money columns are not granted to the browser; amounts are read
--    through security definer functions that call can_see_money().
-- 4. Ledger RPCs (accounts_*), fees campaign from the ledger, payments update and close fees leads,
--    "creates a student" results (call_type_results.creates_student), reports ledger_collected() and
--    promises_vs_payments().

-- =====================================================================================================
-- 1. Accounts role
-- =====================================================================================================

alter table public.seats drop constraint if exists seats_role_check;
alter table public.seats add constraint seats_role_check check (role in ('admin', 'rep', 'accounts'));
alter table public.seats drop constraint if exists seats_admin_kind_check;
alter table public.seats add constraint seats_admin_kind_check check (admin_kind in ('owner', 'manager', 'accounts'));
alter table public.seats drop constraint if exists seats_admin_kind_matches_role;
alter table public.seats add constraint seats_admin_kind_matches_role check (
  (role = 'rep') = (admin_kind is null)
  and (role = 'accounts') = (coalesce(admin_kind, '') = 'accounts'));

-- access_role: owner / manager / accounts / caller.
alter table public.seats drop column if exists access_role;
alter table public.seats
  add column access_role text generated always as (case when role = 'rep' then 'caller' else admin_kind end) stored;

-- Same as 0013, plus: an accounts seat always has admin_kind 'accounts'; an admin seat never does.
create or replace function public.seats_admin_kind()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.role = 'rep' then
    new.admin_kind := null;
    new.can_see_money := false;
  elsif new.role = 'accounts' then
    new.admin_kind := 'accounts';
  elsif new.admin_kind is null or new.admin_kind = 'accounts' then
    new.admin_kind := case
      when exists (select 1 from seats s
                   where s.institute_id = new.institute_id and s.role = 'admin'
                     and s.status <> 'revoked' and s.id <> new.id)
      then 'manager' else 'owner' end;
  end if;
  if new.admin_kind is distinct from 'manager' then new.can_see_money := false; end if;
  return new;
end $$;

-- True when the logged-in user holds an active accounts seat of the institute.
create or replace function public.is_accounts_of(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.seats s
    where s.institute_id = inst and s.user_id = auth.uid() and s.status = 'active' and s.role = 'accounts');
$$;

-- Who may read the ledger (students, fee items, payments): owners, managers and accounts. Amounts still
-- follow can_see_money().
create or replace function public.can_read_ledger(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.is_admin_of(inst) or public.is_accounts_of(inst) $$;

-- Who may change the ledger (students, fee items, payments, imports): owners and accounts.
create or replace function public.can_manage_ledger(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.is_owner_of(inst) or public.is_accounts_of(inst) $$;

-- Same as 0013, plus accounts seats, which always see money (hide_money does not apply to them).
create or replace function public.can_see_money(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.seats s
    join public.institutes i on i.id = s.institute_id
    where s.institute_id = inst and s.user_id = auth.uid() and s.status = 'active'
      and ((s.role = 'admin' and (s.admin_kind = 'owner' or s.can_see_money) and not i.hide_money)
           or s.role = 'accounts')
  );
$$;

-- Same as 0013, plus 'accounts'.
create or replace function public.admin_set_seat_role(p_seat uuid, p_role text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  s public.seats;
begin
  if p_role is null or p_role not in ('owner', 'manager', 'caller', 'accounts') then
    raise exception 'role must be owner, manager, accounts or caller' using errcode = '22023';
  end if;
  select * into s from public.seats where id = p_seat;
  if s.id is null then raise exception 'seat not found' using errcode = '22023'; end if;
  if not public.is_owner_of(s.institute_id) then
    raise exception 'only an owner of this institute can change roles' using errcode = '42501';
  end if;
  if s.user_id is not null and s.user_id = auth.uid() then
    raise exception 'you cannot change your own role' using errcode = '42501';
  end if;
  if s.status = 'revoked' then raise exception 'this seat is revoked' using errcode = '22023'; end if;

  if p_role = 'caller' then
    update public.seats set role = 'rep', admin_kind = null, can_see_money = false where id = p_seat;
  elsif p_role = 'accounts' then
    update public.seats set role = 'accounts', admin_kind = 'accounts', can_see_money = false where id = p_seat;
  else
    update public.seats set role = 'admin', admin_kind = p_role,
                            can_see_money = case when p_role = 'manager' then can_see_money else false end
      where id = p_seat;
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (s.institute_id, auth.uid(), 'seat.role_set', p_seat::text || ':' || p_role);
end $$;

-- Same as 0002, plus p_role 'accounts' (owner only, because an accounts seat sees money).
create or replace function public.invite_seat(
  p_institute uuid, p_email text, p_label text, p_role text default 'rep')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  sid  uuid;
  used int;
  cap  int;
  mail text := lower(trim(p_email));
begin
  if not public.is_admin_of(p_institute) then raise exception 'only an admin of this institute can invite'; end if;
  if p_role not in ('admin', 'rep', 'accounts') then raise exception 'role must be admin, rep or accounts'; end if;
  if p_role = 'accounts' and not public.is_owner_of(p_institute) then
    raise exception 'only an owner can invite an accounts seat' using errcode = '42501';
  end if;
  if mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'enter a valid email'; end if;
  if p_label is null or length(trim(p_label)) = 0 then raise exception 'label is required'; end if;

  select seat_limit into cap from institutes where id = p_institute;
  select count(*) into used from seats where institute_id = p_institute and status <> 'revoked';
  if used >= cap then raise exception 'all % seats are in use', cap; end if;

  insert into seats (institute_id, label, role, status, invite_email)
    values (p_institute, trim(p_label), p_role, 'invited', mail)
    returning id into sid;
  insert into audit_log (institute_id, actor_id, action, target)
    values (p_institute, auth.uid(), 'seat.invited', sid::text);
  return sid;
end $$;

-- =====================================================================================================
-- 2. Open campaigns: columns, read rule, helpers
-- =====================================================================================================

-- Board names accepted for students and campaign tags; 'cbse', 'State board' … are normalised.
create or replace function public.ledger_board(p_raw text)
returns text
language sql immutable set search_path = public
as $$
  select case lower(regexp_replace(trim(coalesce(p_raw, '')), '\s+board$', '', 'i'))
    when 'cbse' then 'CBSE' when 'icse' then 'ICSE' when 'state' then 'State' when 'ib' then 'IB'
    when 'igcse' then 'IGCSE' when 'other' then 'Other' else null end;
$$;

alter table public.campaigns
  add column if not exists open_to_all boolean not null default true,
  add column if not exists class_label text check (class_label is null or length(class_label) between 1 and 20),
  add column if not exists board text check (board is null or board in ('CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other')),
  -- Fees campaigns made from the ledger: leads carry the balance due by max(today, fees_due_by).
  add column if not exists fees_due_by date;

-- True when the seat may work the campaign: an active seat of the campaign's institute that is a member,
-- or any active seat of the institute when the campaign is open to all. Does not look at the status.
create or replace function public.campaign_seat_can_work(p_campaign uuid, p_seat uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.campaigns c
    join public.seats s on s.id = p_seat and s.institute_id = c.institute_id and s.status = 'active'
    where c.id = p_campaign
      and (c.open_to_all or exists (select 1 from public.campaign_members m
                                    where m.campaign_id = c.id and m.seat_id = s.id)));
$$;

-- Callers also read the running and paused open campaigns of their institute.
drop policy if exists campaigns_read on public.campaigns;
create policy campaigns_read on public.campaigns
  for select using (
    public.is_admin_of(institute_id)
    or (status <> 'draft' and exists (
      select 1 from public.campaign_members m
      join public.seats s on s.id = m.seat_id
      where m.campaign_id = campaigns.id and s.user_id = auth.uid() and s.status = 'active'))
    or (open_to_all and status in ('running', 'paused') and exists (
      select 1 from public.seats s
      where s.user_id = auth.uid() and s.status = 'active' and s.institute_id = campaigns.institute_id)));

-- Same as 0020; the pool is now: no caller, or a seat that may no longer work the campaign (in an open
-- campaign a non-member keeps the leads they took).
create or replace function public.campaign_share_equal(p_campaign uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  seats_  uuid[];
  kept    int[];
  unc     int[];
  quota   int[];
  need    int[];
  m       int;
  n       bigint;
  s       bigint;
  lvl     bigint;
  extra   bigint;
  j       int;
  i       int;
  changed int;
begin
  select coalesce(array_agg(x.seat_id order by x.kept, x.seat_id), '{}'),
         coalesce(array_agg(x.kept order by x.kept, x.seat_id), '{}'),
         coalesce(array_agg(x.unc order by x.kept, x.seat_id), '{}')
    into seats_, kept, unc
  from (
    select m.seat_id,
           count(l.id) filter (where not public.lead_is_uncalled(l.id, l.status))::int as kept,
           count(l.id) filter (where public.lead_is_uncalled(l.id, l.status))::int as unc
    from public.campaign_members m
    join public.seats st on st.id = m.seat_id and st.status = 'active'
    left join public.leads l on l.campaign_id = p_campaign and l.assigned_seat_id = m.seat_id
                             and public.lead_is_open(l.status, l.do_not_call)
    where m.campaign_id = p_campaign
    group by m.seat_id
  ) x;
  m := coalesce(array_length(seats_, 1), 0);
  if m = 0 then return 0; end if;

  select count(*) into n from public.leads l
  where l.campaign_id = p_campaign and public.lead_is_open(l.status, l.do_not_call)
    and (l.assigned_seat_id is null or not public.campaign_seat_can_work(p_campaign, l.assigned_seat_id));
  for i in 1 .. m loop n := n + unc[i]; end loop;
  if n = 0 then return 0; end if;

  quota := array_fill(0, array[m]);
  for j in reverse m .. 1 loop
    s := n;
    for i in 1 .. j loop s := s + kept[i]; end loop;
    lvl := s / j;
    if lvl >= kept[j] then
      extra := s - lvl * j;
      for i in 1 .. j loop
        quota[i] := lvl - kept[i] + case when i <= extra then 1 else 0 end;
      end loop;
      exit;
    end if;
  end loop;

  need := array_fill(0, array[m]);
  for i in 1 .. m loop
    if unc[i] > quota[i] then
      update public.leads l set assigned_seat_id = null
      where l.id in (select l2.id from public.leads l2
                     where l2.campaign_id = p_campaign and l2.assigned_seat_id = seats_[i]
                       and public.lead_is_open(l2.status, l2.do_not_call) and public.lead_is_uncalled(l2.id, l2.status)
                     order by l2.created_at desc, l2.id desc
                     limit unc[i] - quota[i]);
    else
      need[i] := quota[i] - unc[i];
    end if;
  end loop;

  with q as (
    select t.seat_id,
           coalesce(sum(t.need) over (order by t.ord rows between unbounded preceding and 1 preceding), 0) as lo,
           sum(t.need) over (order by t.ord) as hi
    from unnest(seats_, need) with ordinality as t(seat_id, need, ord)
  ), pool as (
    select l.id, row_number() over (order by l.created_at, l.id) as rn
    from public.leads l
    where l.campaign_id = p_campaign and public.lead_is_open(l.status, l.do_not_call)
      and (l.assigned_seat_id is null or not public.campaign_seat_can_work(p_campaign, l.assigned_seat_id))
  )
  update public.leads l set assigned_seat_id = q.seat_id
  from pool join q on pool.rn > q.lo and pool.rn <= q.hi
  where l.id = pool.id;
  get diagnostics changed = row_count;
  return changed;
end $$;

-- Same as 0020: uncalled open leads go back to the pool, and open leads of seats that may no longer work the
-- campaign (not a member of a restricted campaign, or not active).
create or replace function public.campaign_share_next_free(p_campaign uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare changed int;
begin
  update public.leads l set assigned_seat_id = null
  where l.campaign_id = p_campaign and l.assigned_seat_id is not null
    and public.lead_is_open(l.status, l.do_not_call)
    and (public.lead_is_uncalled(l.id, l.status)
         or not public.campaign_seat_can_work(p_campaign, l.assigned_seat_id));
  get diagnostics changed = row_count;
  return changed;
end $$;

-- Same as 0020, except: in an open campaign a seat that leaves the member list keeps its open leads (it can
-- still work the campaign).
create or replace function public.admin_set_campaign_members(p_campaign uuid, p_seats uuid[])
returns int
language plpgsql security definer set search_path = public
as $$
declare
  c     public.campaigns;
  want  uuid[] := coalesce((select array_agg(distinct x) from unnest(p_seats) x where x is not null), '{}');
  total int;
begin
  perform public.campaign_admin_seat();
  c := public.campaign_for_admin(p_campaign);
  if c.status = 'closed' then
    raise exception 'this campaign is closed and cannot be changed' using errcode = '22023';
  end if;
  if cardinality(want) > 500 then
    raise exception 'at most 500 callers on a campaign' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(want) x
             where not exists (select 1 from public.seats s
                               where s.id = x and s.institute_id = c.institute_id and s.status = 'active')) then
    raise exception 'a chosen caller is not an active seat of this institute' using errcode = '22023';
  end if;

  delete from public.campaign_members m where m.campaign_id = c.id and not (m.seat_id = any (want));
  insert into public.campaign_members (campaign_id, seat_id, institute_id)
    select c.id, x, c.institute_id from unnest(want) x
  on conflict (campaign_id, seat_id) do nothing;

  update public.leads l set assigned_seat_id = null
  where l.campaign_id = c.id and l.assigned_seat_id is not null and not (l.assigned_seat_id = any (want))
    and public.lead_is_open(l.status, l.do_not_call)
    and not public.campaign_seat_can_work(c.id, l.assigned_seat_id);
  if c.share_mode = 'equal' then perform public.campaign_share_equal(c.id); end if;

  total := cardinality(want);
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'campaign.members_set', c.id::text || ':' || total);
  return total;
end $$;

-- Checks a campaign tag pair; raises on bad input. Returns the normalised board in p_board_out.
create or replace function public.campaign_check_tags(p_class_label text, p_board text)
returns text
language plpgsql immutable set search_path = public
as $$
declare b text;
begin
  if p_class_label is not null and length(trim(p_class_label)) not between 1 and 20 then
    raise exception 'class must be 1 to 20 characters' using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_board, '')), '') is null then return null; end if;
  b := public.ledger_board(p_board);
  if b is null then
    raise exception 'board must be CBSE, ICSE, State, IB, IGCSE or Other' using errcode = '22023';
  end if;
  return b;
end $$;

-- admin_create_campaign: three new optional arguments (p_open_to_all, p_class_label, p_board); p_share_mode
-- null (the new default) means next_free for an open campaign, equal for a restricted one. The old 7-argument
-- function is dropped so a call with named arguments is never ambiguous.
drop function if exists public.admin_create_campaign(text, uuid, uuid, date, date, int, text);
create or replace function public.admin_create_campaign(
  p_name text, p_call_type uuid, p_script uuid default null, p_start date default null, p_end date default null,
  p_daily_target int default null, p_share_mode text default null, p_open_to_all boolean default true,
  p_class_label text default null, p_board text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  nm    text := trim(coalesce(p_name, ''));
  open_ boolean := coalesce(p_open_to_all, true);
  mode  text := coalesce(p_share_mode, case when coalesce(p_open_to_all, true) then 'next_free' else 'equal' end);
  brd   text;
  cid   uuid;
begin
  seat := public.campaign_admin_seat();
  if length(nm) not between 1 and 120 then
    raise exception 'campaign name must be 1 to 120 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from public.call_types t where t.id = p_call_type and t.active
                 and (t.institute_id is null or t.institute_id = seat.institute_id)) then
    raise exception 'pick a call type' using errcode = '22023';
  end if;
  if p_start is not null and p_end is not null and p_end < p_start then
    raise exception 'the end date must be on or after the start date' using errcode = '22023';
  end if;
  if p_daily_target is not null and p_daily_target not between 1 and 10000 then
    raise exception 'daily target must be 1 to 10000 calls' using errcode = '22023';
  end if;
  if mode not in ('equal', 'next_free') then
    raise exception 'share leads must be equal or next_free' using errcode = '22023';
  end if;
  brd := public.campaign_check_tags(p_class_label, p_board);
  perform public.campaign_check_script(seat.institute_id, p_script, p_call_type);
  insert into public.campaigns (institute_id, name, call_type_id, script_id, start_date, end_date, daily_target,
                                share_mode, status, created_by, open_to_all, class_label, board)
    values (seat.institute_id, nm, p_call_type, p_script, p_start, p_end, p_daily_target,
            mode, 'draft', seat.id, open_, nullif(trim(p_class_label), ''), brd)
    returning id into cid;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(), 'campaign.created', cid::text);
  return cid;
end $$;

-- admin_update_campaign: new optional p_open_to_all, p_class_label, p_board ('' clears a tag). A draft that is
-- open to all can start without members. Restricting a campaign (open_to_all true -> false) puts the open
-- leads of seats that are not members back in the pool (equal mode then shares them). Audit
-- campaign.changed (+ campaign.<status>, + campaign.restricted / campaign.opened).
drop function if exists public.admin_update_campaign(uuid, text, uuid, uuid, boolean, date, date, boolean, int, text, text);
create or replace function public.admin_update_campaign(
  p_campaign uuid, p_name text default null, p_call_type uuid default null, p_script uuid default null,
  p_clear_script boolean default false, p_start date default null, p_end date default null,
  p_clear_dates boolean default false, p_daily_target int default null, p_share_mode text default null,
  p_status text default null, p_open_to_all boolean default null, p_class_label text default null,
  p_board text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  c     public.campaigns;
  nm    text := case when p_name is null then null else trim(p_name) end;
  typ   uuid;
  scr   uuid;
  sd    date;
  ed    date;
  st    text := coalesce(p_status, '');
  open_ boolean;
  cls   text;
  brd   text;
begin
  perform public.campaign_admin_seat();
  c := public.campaign_for_admin(p_campaign);
  if c.status = 'closed' then
    raise exception 'this campaign is closed and cannot be changed' using errcode = '22023';
  end if;
  if nm is not null and length(nm) not between 1 and 120 then
    raise exception 'campaign name must be 1 to 120 characters' using errcode = '22023';
  end if;
  typ := coalesce(p_call_type, c.call_type_id);
  if typ <> c.call_type_id then
    if c.status <> 'draft' then
      raise exception 'the call type can only change while the campaign is a draft' using errcode = '22023';
    end if;
    if not exists (select 1 from public.call_types t where t.id = typ and t.active
                   and (t.institute_id is null or t.institute_id = c.institute_id)) then
      raise exception 'pick a call type' using errcode = '22023';
    end if;
  end if;
  scr := case when coalesce(p_clear_script, false) then null else coalesce(p_script, c.script_id) end;
  if scr is distinct from c.script_id or typ <> c.call_type_id then
    perform public.campaign_check_script(c.institute_id, scr, typ);
  end if;
  if coalesce(p_clear_dates, false) then sd := null; ed := null;
  else sd := coalesce(p_start, c.start_date); ed := coalesce(p_end, c.end_date);
  end if;
  if sd is not null and ed is not null and ed < sd then
    raise exception 'the end date must be on or after the start date' using errcode = '22023';
  end if;
  if p_daily_target is not null and p_daily_target not between 0 and 10000 then
    raise exception 'daily target must be 1 to 10000 calls (0 for none)' using errcode = '22023';
  end if;
  if p_share_mode is not null and p_share_mode not in ('equal', 'next_free') then
    raise exception 'share leads must be equal or next_free' using errcode = '22023';
  end if;
  open_ := coalesce(p_open_to_all, c.open_to_all);
  cls := case when p_class_label is null then c.class_label else nullif(trim(p_class_label), '') end;
  brd := case when p_board is null then c.board else public.campaign_check_tags(null, p_board) end;
  perform public.campaign_check_tags(cls, null);
  if st <> '' and st <> c.status then
    if st not in ('running', 'paused', 'closed') then
      raise exception 'status must be running, paused or closed' using errcode = '22023';
    end if;
    if st = 'paused' and c.status <> 'running' then
      raise exception 'only a running campaign can be paused' using errcode = '22023';
    end if;
    if st = 'running' and c.status = 'draft' then
      if not open_ and not exists (select 1 from public.campaign_members m join public.seats s on s.id = m.seat_id
                     where m.campaign_id = c.id and s.status = 'active') then
        raise exception 'add at least one caller before you start' using errcode = '22023';
      end if;
      if not exists (select 1 from public.leads l where l.campaign_id = c.id) then
        raise exception 'add leads before you start' using errcode = '22023';
      end if;
    end if;
  end if;

  update public.campaigns set
    name = coalesce(nm, name),
    call_type_id = typ,
    script_id = scr,
    start_date = sd,
    end_date = ed,
    daily_target = case when p_daily_target is null then daily_target when p_daily_target = 0 then null else p_daily_target end,
    share_mode = coalesce(p_share_mode, share_mode),
    status = case when st = '' then status else st end,
    open_to_all = open_,
    class_label = cls,
    board = brd
  where id = c.id;

  if c.open_to_all and not open_ then
    update public.leads l set assigned_seat_id = null
    where l.campaign_id = c.id and l.assigned_seat_id is not null
      and public.lead_is_open(l.status, l.do_not_call)
      and not public.campaign_seat_can_work(c.id, l.assigned_seat_id);
    if coalesce(p_share_mode, c.share_mode) = 'equal' then perform public.campaign_share_equal(c.id); end if;
  end if;

  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'campaign.changed', c.id::text);
  if st <> '' and st <> c.status then
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (c.institute_id, auth.uid(), 'campaign.' || st, c.id::text);
  end if;
  if open_ <> c.open_to_all then
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (c.institute_id, auth.uid(), case when open_ then 'campaign.opened' else 'campaign.restricted' end, c.id::text);
  end if;
end $$;

-- admin_campaign_list: three new columns at the end (open_to_all, class_label, board).
drop function if exists public.admin_campaign_list();
create or replace function public.admin_campaign_list()
returns table (id uuid, name text, status text, call_type_id uuid, call_type_key text, call_type_label text,
               script_id uuid, script_name text, start_date date, end_date date, daily_target int,
               share_mode text, leads_total bigint, leads_called bigint, leads_open bigint,
               leads_unassigned bigint, callers jsonb, created_at timestamptz, updated_at timestamptz,
               open_to_all boolean, class_label text, board text)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare seat public.seats;
begin
  seat := public.campaign_admin_seat();
  return query
    select c.id, c.name, c.status, c.call_type_id, t.key, t.label, c.script_id, sc.name, c.start_date, c.end_date,
           c.daily_target, c.share_mode,
           coalesce(ls.total, 0), coalesce(ls.called, 0), coalesce(ls.open, 0), coalesce(ls.unassigned, 0),
           (select coalesce(jsonb_agg(jsonb_build_object('seat_id', s.id, 'label', s.label) order by s.label), '[]'::jsonb)
              from public.campaign_members m join public.seats s on s.id = m.seat_id
              where m.campaign_id = c.id),
           c.created_at, c.updated_at, c.open_to_all, c.class_label, c.board
    from public.campaigns c
    join public.call_types t on t.id = c.call_type_id
    left join public.scripts sc on sc.id = c.script_id
    left join lateral (
      select count(*) as total,
             count(*) filter (where l.status <> 'new'
                              or exists (select 1 from public.call_outcomes o where o.lead_id = l.id)) as called,
             count(*) filter (where public.lead_is_open(l.status, l.do_not_call)) as open,
             count(*) filter (where public.lead_is_open(l.status, l.do_not_call) and l.assigned_seat_id is null) as unassigned
      from public.leads l where l.campaign_id = c.id
    ) ls on true
    where c.institute_id = seat.institute_id
    order by case c.status when 'running' then 0 when 'paused' then 1 when 'draft' then 2 else 3 end,
             c.created_at desc;
end $$;

-- admin_campaign_detail: adds open_to_all, class_label, board, fees_due_by; callers now lists members and
-- every seat holding leads of the campaign, each with "member".
create or replace function public.admin_campaign_detail(p_campaign uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  c      public.campaigns;
  money  boolean;
  day0   timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  out    jsonb;
begin
  perform public.campaign_admin_seat();
  c := public.campaign_for_admin(p_campaign);
  money := public.can_see_money(c.institute_id);
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'status', c.status, 'call_type_id', c.call_type_id,
    'call_type_key', t.key, 'call_type_label', t.label, 'script_id', c.script_id,
    'script_name', (select s.name from public.scripts s where s.id = c.script_id),
    'script_live_version', (select v.version from public.script_versions v where v.script_id = c.script_id and v.published limit 1),
    'start_date', c.start_date, 'end_date', c.end_date, 'daily_target', c.daily_target,
    'share_mode', c.share_mode, 'created_at', c.created_at,
    'open_to_all', c.open_to_all, 'class_label', c.class_label, 'board', c.board, 'fees_due_by', c.fees_due_by,
    'leads', (select jsonb_build_object(
                'total', count(*),
                'called', count(*) filter (where l.status <> 'new'
                                           or exists (select 1 from public.call_outcomes o where o.lead_id = l.id)),
                'open', count(*) filter (where public.lead_is_open(l.status, l.do_not_call)),
                'unassigned', count(*) filter (where public.lead_is_open(l.status, l.do_not_call) and l.assigned_seat_id is null),
                'new', count(*) filter (where l.status = 'new'),
                'callback', count(*) filter (where l.status = 'callback'),
                'promised', count(*) filter (where l.status = 'promised'),
                'done', count(*) filter (where l.status = 'done'),
                'wrong_number', count(*) filter (where l.status = 'wrong_number'),
                'do_not_call', count(*) filter (where l.status = 'do_not_call'))
              from public.leads l where l.campaign_id = c.id),
    'calls_today', (select count(*) from public.call_outcomes o
                    where o.campaign_id = c.id and o.corrects_id is null and coalesce(o.dialled_at, o.uploaded_at) >= day0),
    'callers', (select coalesce(jsonb_agg(jsonb_build_object(
                  'seat_id', s.id, 'label', s.label, 'status', s.status,
                  'member', exists (select 1 from public.campaign_members m where m.campaign_id = c.id and m.seat_id = s.id),
                  'leads', (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = s.id),
                  'open', (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = s.id
                             and public.lead_is_open(l.status, l.do_not_call)),
                  'called', (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = s.id
                               and (l.status <> 'new' or exists (select 1 from public.call_outcomes o where o.lead_id = l.id))),
                  'calls_today', (select count(*) from public.call_outcomes o
                                  where o.campaign_id = c.id and o.seat_id = s.id and o.corrects_id is null
                                    and coalesce(o.dialled_at, o.uploaded_at) >= day0)
                ) order by s.label), '[]'::jsonb)
                from public.seats s
                where s.id in (select m.seat_id from public.campaign_members m where m.campaign_id = c.id
                               union
                               select l.assigned_seat_id from public.leads l
                               where l.campaign_id = c.id and l.assigned_seat_id is not null)),
    'results', (select coalesce(jsonb_agg(jsonb_build_object('key', x.result_key, 'label', x.label, 'count', x.n)
                                          order by x.n desc, x.result_key), '[]'::jsonb)
                from (select o.result_key, coalesce(r.label, o.result_key) as label, count(*) as n
                      from public.call_outcomes o
                      left join lateral (select r.label from public.call_type_results_for(c.call_type_id, c.institute_id) r
                                         where r.key = o.result_key limit 1) r on true
                      where o.campaign_id = c.id and o.result_key is not null
                        and not exists (select 1 from public.call_outcomes x where x.corrects_id = o.id)
                      group by o.result_key, r.label) x),
    'amount_due_total', case when money then (select coalesce(sum(l.amount_due), 0) from public.leads l where l.campaign_id = c.id) end,
    'money_hidden', not money)
  into out
  from public.call_types t where t.id = c.call_type_id;
  return out;
end $$;

-- my_campaigns: running and paused campaigns the seat is a member of, plus the open ones of its institute.
-- New columns: call_type_id, share_mode, open_to_all, class_label, board, is_member, pool_leads_due (leads
-- waiting in the pool that next_free_lead can hand out now). No money.
drop function if exists public.my_campaigns();
create or replace function public.my_campaigns()
returns table (campaign_id uuid, name text, status text, call_type_id uuid, call_type_key text, call_type_label text,
               script_id uuid, start_date date, end_date date, daily_target int, call_hours jsonb,
               share_mode text, open_to_all boolean, class_label text, board text, is_member boolean,
               my_leads bigint, my_leads_due bigint, pool_leads_due bigint, results jsonb)
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
           (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = seat.id),
           (select count(*) from public.leads l
             where l.campaign_id = c.id and l.assigned_seat_id = seat.id
               and l.status in ('new', 'callback', 'promised') and not l.do_not_call
               and (l.next_call_at is null or l.next_call_at <= now())),
           (select count(*) from public.leads l
             where l.campaign_id = c.id and l.assigned_seat_id is null
               and l.status in ('new', 'callback', 'promised') and not l.do_not_call and l.consent_call
               and (l.next_call_at is null or l.next_call_at <= now())
               and (l.status <> 'promised' or l.promised_date is null or l.promised_date <= today)),
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'key', r.key, 'label', r.label,
                     'needs_date', r.needs_date, 'needs_amount', r.needs_amount,
                     'needs_reason', r.needs_reason, 'needs_rating', r.needs_rating,
                     'reason_choices', r.reason_choices, 'counts_as_good', r.counts_as_good,
                     'common', r.call_type_id is null)), '[]'::jsonb)
              from public.call_type_results_for(c.call_type_id, c.institute_id) r)
    from public.campaigns c
    join public.call_types t on t.id = c.call_type_id
    where c.institute_id = seat.institute_id and c.status in ('running', 'paused')
      and (c.open_to_all or exists (select 1 from public.campaign_members m
                                    where m.campaign_id = c.id and m.seat_id = seat.id))
    order by c.status, t.sort_order, t.label, c.class_label nulls last, c.board nulls last, c.name;
end $$;

-- next_free_lead: same as 0020; the seat must be able to work the campaign (member, or open to all).
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

  select l.id into lid from public.leads l
  where l.campaign_id = c.id and l.assigned_seat_id = seat.id and l.status = 'new' and not l.do_not_call
    and l.consent_call
    and not exists (select 1 from public.call_outcomes o where o.lead_id = l.id)
  order by l.updated_at, l.id
  limit 1;

  if lid is null then
    select l.id into lid from public.leads l
    where l.campaign_id = c.id and l.assigned_seat_id is null
      and l.status in ('new', 'callback', 'promised') and not l.do_not_call and l.consent_call
      and (l.next_call_at is null or l.next_call_at <= now())
      and (l.status <> 'promised' or l.promised_date is null or l.promised_date <= (now() at time zone 'Asia/Kolkata')::date)
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

-- my_call_queue: same as 0021; the seat must be able to work the campaign (member, or open to all).
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
    'open_to_all', c.open_to_all, 'class_label', c.class_label, 'board', c.board,
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

-- campaign_script_version: same as 20261025120000 (pushbacks column and script-test logic unchanged); the
-- member check now also accepts any active seat of the institute for a running or paused open campaign.
create or replace function public.campaign_script_version(p_campaign uuid, p_lead uuid default null)
returns table (script_id uuid, script_name text, version int, steps jsonb, test_id uuid, arm text, pushbacks jsonb)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  c      public.campaigns;
  l      public.leads;
  t      public.script_tests;
  admin  boolean;
  my_arm text;
  n      bigint;
  v      int;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null then raise exception 'campaign not found' using errcode = '42501'; end if;
  admin := public.is_admin_of(c.institute_id);
  if not admin and (c.status = 'draft' or not (
      exists (select 1 from public.campaign_members m join public.seats s on s.id = m.seat_id
              where m.campaign_id = c.id and s.user_id = auth.uid() and s.status = 'active')
      or (c.open_to_all and c.status in ('running', 'paused')
          and exists (select 1 from public.seats s
                      where s.user_id = auth.uid() and s.status = 'active' and s.institute_id = c.institute_id)))) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if p_lead is not null then
    select * into l from public.leads where id = p_lead and campaign_id = c.id;
    if l.id is null or (not admin and not exists (
        select 1 from public.seats s where s.id = l.assigned_seat_id and s.user_id = auth.uid() and s.status = 'active')) then
      raise exception 'lead not found' using errcode = '42501';
    end if;
  end if;
  if c.script_id is null or not public.has_feature(c.institute_id, 'scripts') then return; end if;

  select * into t from public.script_tests x
    where x.campaign_id = c.id and x.status = 'running' and x.script_id = c.script_id;
  if t.id is not null and p_lead is not null then
    -- Lock the test so two callers asking at once still alternate.
    perform 1 from public.script_tests x where x.id = t.id for update;
    select a.arm into my_arm from public.script_test_leads a where a.test_id = t.id and a.lead_id = p_lead;
    if my_arm is null then
      select count(*) into n from public.script_test_leads a where a.test_id = t.id;
      my_arm := case when n % 2 = 0 then 'a' else 'b' end;
      insert into public.script_test_leads (test_id, lead_id, arm) values (t.id, p_lead, my_arm);
    end if;
    v := case when my_arm = 'a' then t.version_a else t.version_b end;
    return query
      select sv.script_id, s.name, sv.version, sv.steps, t.id, my_arm, sv.pushbacks
      from public.script_versions sv join public.scripts s on s.id = sv.script_id
      where sv.script_id = t.script_id and sv.version = v;
    if found then return; end if;
    -- The tested version was a draft that has since been deleted: use the published version.
  end if;

  return query
    select sv.script_id, s.name, sv.version, sv.steps, null::uuid, null::text, sv.pushbacks
    from public.script_versions sv join public.scripts s on s.id = sv.script_id
    where sv.script_id = c.script_id and sv.published;
end $$;

-- =====================================================================================================
-- 3. The fee ledger: tables
-- =====================================================================================================

create table public.students (
  id                 uuid primary key default gen_random_uuid(),
  institute_id       uuid not null references public.institutes (id) on delete cascade,
  admission_no       text check (admission_no is null or length(admission_no) between 1 and 40),
  name               text not null check (length(name) between 1 and 120),
  class_label        text check (class_label is null or length(class_label) between 1 and 20),
  section            text check (section is null or length(section) between 1 and 20),
  board              text check (board is null or board in ('CBSE', 'ICSE', 'State', 'IB', 'IGCSE', 'Other')),
  academic_year      text check (academic_year is null or academic_year ~ '^[0-9]{4}-[0-9]{2}$'),
  parent_name        text check (parent_name is null or length(parent_name) between 1 and 120),
  phone              text check (phone is null or phone ~ '^\+91[0-9]{10}$'),
  alt_phone          text check (alt_phone is null or alt_phone ~ '^\+91[0-9]{10}$'),
  status             text not null default 'active' check (status in ('active', 'left')),
  source             text not null default 'manual' check (source in ('import', 'admission', 'manual')),
  admission_lead_id  uuid references public.leads (id) on delete set null,
  created_by         uuid references public.seats (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (id, institute_id)
);
create unique index students_admission_no on public.students (institute_id, lower(admission_no))
  where admission_no is not null;
create unique index students_admission_lead on public.students (admission_lead_id) where admission_lead_id is not null;
create index students_institute_class on public.students (institute_id, class_label, board);

create table public.fee_items (
  id             uuid primary key default gen_random_uuid(),
  institute_id   uuid not null references public.institutes (id) on delete cascade,
  student_id     uuid not null,
  head           text not null check (length(head) between 1 and 80),
  amount         numeric(12, 2) not null check (amount > 0),
  due_date       date not null,
  academic_year  text check (academic_year is null or academic_year ~ '^[0-9]{4}-[0-9]{2}$'),
  is_void        boolean not null default false,
  void_reason    text check (void_reason is null or length(void_reason) between 1 and 300),
  voided_at      timestamptz,
  voided_by      uuid references public.seats (id) on delete set null,
  created_by     uuid references public.seats (id) on delete set null,
  created_at     timestamptz not null default now(),
  check (not is_void or void_reason is not null),
  foreign key (student_id, institute_id) references public.students (id, institute_id) on delete cascade
);
create index fee_items_student on public.fee_items (student_id);

create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  student_id    uuid not null,
  amount        numeric(12, 2) not null check (amount > 0),
  paid_on       date not null,
  mode          text not null check (mode in ('upi', 'cash', 'cheque', 'card', 'bank', 'other')),
  -- The transaction or receipt reference (UTR, cheque number …). Never account, card or UPI ids.
  reference     text check (reference is null or length(reference) between 1 and 60),
  note          text check (note is null or length(note) <= 300),
  recorded_by   uuid references public.seats (id) on delete set null,
  created_at    timestamptz not null default now(),
  -- A reversal is a new row pointing at the payment it cancels, with the same amount. One per payment.
  reverses_id   uuid unique references public.payments (id) on delete restrict,
  -- "Paid so far" from an import: counts in balances, not in collections (ledger_collected).
  opening       boolean not null default false,
  foreign key (student_id, institute_id) references public.students (id, institute_id) on delete cascade
);
create index payments_student on public.payments (student_id);
create index payments_institute_day on public.payments (institute_id, paid_on);
create index payments_reference on public.payments (institute_id, mode, lower(reference)) where reference is not null;

alter table public.leads add column if not exists student_id uuid;
alter table public.leads add constraint leads_student_fk foreign key (student_id, institute_id)
  references public.students (id, institute_id) on delete set null (student_id);
create index leads_student on public.leads (student_id) where student_id is not null;
grant select (student_id) on public.leads to authenticated;

-- Admins can mark a result (e.g. "Admission confirmed") as creating a student when saved.
alter table public.call_type_results add column if not exists creates_student boolean not null default false;

-- History is kept: payments are never edited, fee items only get voided (once), students keep their id.
create or replace function public.ledger_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'payments' then
    raise exception 'payments cannot be changed: record a reversal' using errcode = '42501';
  end if;
  -- fee_items: only the void fields, and only from not void to void.
  if old.is_void or not new.is_void
     or (new.id, new.institute_id, new.student_id, new.head, new.amount, new.due_date, new.academic_year,
         new.created_by, new.created_at)
        is distinct from
        (old.id, old.institute_id, old.student_id, old.head, old.amount, old.due_date, old.academic_year,
         old.created_by, old.created_at) then
    raise exception 'fee items cannot be changed: void it and add a new one' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger payments_no_update before update on public.payments
  for each row execute function public.ledger_guard();
create trigger fee_items_void_only before update on public.fee_items
  for each row execute function public.ledger_guard();

create or replace function public.students_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.phone := public.normalise_phone(new.phone);
  new.alt_phone := public.normalise_phone(new.alt_phone);
  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;
create trigger students_before_write before insert or update on public.students
  for each row execute function public.students_before_write();

-- RLS: ledger readers (owners, managers, accounts) read rows of their institute; nobody writes from the
-- browser. Amount columns are not granted at all: read them through the accounts_* functions.
alter table public.students  enable row level security;
alter table public.fee_items enable row level security;
alter table public.payments  enable row level security;
create policy students_read on public.students for select using (public.can_read_ledger(institute_id));
create policy fee_items_read on public.fee_items for select using (public.can_read_ledger(institute_id));
create policy payments_read on public.payments for select using (public.can_read_ledger(institute_id));
revoke all on public.students, public.fee_items, public.payments from anon, authenticated;
grant select on public.students to authenticated;
grant select (id, institute_id, student_id, head, due_date, academic_year, is_void, void_reason, voided_at,
              voided_by, created_by, created_at) on public.fee_items to authenticated;
grant select (id, institute_id, student_id, paid_on, mode, reference, note, recorded_by, created_at, reverses_id, opening)
  on public.payments to authenticated;

-- =====================================================================================================
-- 3b. Ledger internals (granted to nobody)
-- =====================================================================================================

-- Today in the institute's time zone.
create or replace function public.ledger_today(p_institute uuid)
returns date
language sql stable security definer set search_path = public
as $$ select (now() at time zone public.institute_tz(p_institute))::date $$;

-- An amount from a sheet or form: '12,500', '₹ 12500.50', 12500. Null for empty; -1 when it is not an amount.
create or replace function public.ledger_amount(p_raw text)
returns numeric
language plpgsql immutable set search_path = public
as $$
declare t text := regexp_replace(coalesce(p_raw, ''), '[\s,₹]|^(rs\.?|inr)', '', 'gi');
begin
  if t = '' then return null; end if;
  if t !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then return -1; end if;
  return t::numeric;
end $$;

-- A date as YYYY-MM-DD. Null for empty; raises 22023 for anything else.
create or replace function public.ledger_date(p_raw text)
returns date
language plpgsql immutable set search_path = public
as $$
begin
  if nullif(trim(coalesce(p_raw, '')), '') is null then return null; end if;
  if trim(p_raw) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'bad date' using errcode = '22023'; end if;
  return trim(p_raw)::date;
end $$;

-- Balances per student of an institute (or one student). Fee items: not void. Paid: payments minus
-- reversals. Due to date: fee items due on or before p_as_of (default today in the institute's time zone).
-- Last payment: the latest payment that is not reversed.
create or replace function public.student_balance_rows(p_institute uuid, p_student uuid default null, p_as_of date default null)
returns table (student_id uuid, total_fees numeric, total_due_to_date numeric, paid numeric,
               balance_due_now numeric, balance_total numeric,
               last_payment_amount numeric, last_payment_on date, last_payment_mode text)
language sql stable security definer set search_path = public
as $$
  with d as (select coalesce(p_as_of, public.ledger_today(p_institute)) as as_of)
  select s.id, f.total::numeric(12, 2), f.due::numeric(12, 2), p.paid::numeric(12, 2), (f.due - p.paid)::numeric(12, 2),
         (f.total - p.paid)::numeric(12, 2), lp.amount, lp.paid_on, lp.mode
  from public.students s
  cross join d
  cross join lateral (
    select coalesce(sum(fi.amount), 0) as total,
           coalesce(sum(fi.amount) filter (where fi.due_date <= d.as_of), 0) as due
    from public.fee_items fi where fi.student_id = s.id and not fi.is_void) f
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

-- A payment that is still counted: not a reversal and not reversed.
create or replace function public.payment_is_live(p_payment uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.payments p where p.id = p_payment and p.reverses_id is null
                 and not exists (select 1 from public.payments r where r.reverses_id = p.id));
$$;

-- After the ledger of a student changes: every open lead of the student in a fees campaign that is not
-- closed gets amount_due = the balance due by max(today, campaign.fees_due_by). When nothing is due, the
-- lead is done (no more calls) and audit_log gets lead.closed_paid. Returns the number of leads changed.
create or replace function public.ledger_sync_student(p_student uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  st    public.students;
  r     record;
  today date;
  due   numeric;
  n     int := 0;
begin
  select * into st from public.students where id = p_student;
  if st.id is null then return 0; end if;
  today := public.ledger_today(st.institute_id);
  for r in
    select l.id, l.amount_due, c.fees_due_by
    from public.leads l
    join public.campaigns c on c.id = l.campaign_id and c.status <> 'closed'
    join public.call_types t on t.id = c.call_type_id and t.key = 'fees'
    where l.student_id = st.id and public.lead_is_open(l.status, l.do_not_call)
    for update of l
  loop
    select greatest(b.balance_due_now, 0) into due
    from public.student_balance_rows(st.institute_id, st.id, greatest(today, coalesce(r.fees_due_by, today))) b;
    if due <= 0 then
      update public.leads set amount_due = 0, status = 'done', next_call_at = null where id = r.id;
      insert into public.audit_log (institute_id, actor_id, action, target)
        values (st.institute_id, auth.uid(), 'lead.closed_paid', r.id::text);
      n := n + 1;
    elsif due is distinct from r.amount_due then
      update public.leads set amount_due = due where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- The seat for a ledger change: an active owner or accounts seat of the institute, else 42501.
create or replace function public.ledger_manager_seat(p_institute uuid)
returns public.seats
language plpgsql stable security definer set search_path = public
as $$
declare seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.institute_id is distinct from p_institute or not public.can_manage_ledger(p_institute) then
    raise exception 'only accounts or an owner can change the fee ledger' using errcode = '42501';
  end if;
  return seat;
end $$;

-- The student for a ledger action, when the signed-in person may read (p_write false) or change it.
create or replace function public.ledger_student(p_student uuid, p_write boolean)
returns public.students
language plpgsql stable security definer set search_path = public
as $$
declare st public.students;
begin
  select * into st from public.students where id = p_student;
  if st.id is null or not (case when p_write then public.can_manage_ledger(st.institute_id)
                                else public.can_read_ledger(st.institute_id) end) then
    raise exception 'student not found' using errcode = '42501';
  end if;
  return st;
end $$;

-- A student from an admission lead (a result with creates_student). Reads the student's name, class,
-- section, board and year from the lead's extra fields when they are there; the lead's name then becomes
-- the parent's name. Does nothing (returns the existing id) when the lead already made a student.
create or replace function public.ledger_student_from_lead(p_lead uuid, p_seat uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  l    public.leads;
  sid  uuid;
  kid  text;
  cls  text;
  sec  text;
  brd  text;
  yr   text;
  e    record;
  k    text;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then return null; end if;
  select s.id into sid from public.students s where s.admission_lead_id = l.id;
  if sid is not null then return sid; end if;
  for e in select * from jsonb_each_text(l.extra) loop
    k := regexp_replace(lower(e.key), '[^a-z]', '', 'g');
    if kid is null and k in ('student', 'studentname', 'studentsname', 'child', 'childname', 'childsname', 'nameofstudent') then
      kid := nullif(left(trim(e.value), 120), '');
    elsif cls is null and k in ('class', 'classlabel', 'grade', 'std', 'standard', 'classapplied', 'classapplyingfor', 'admissionclass') then
      cls := nullif(left(trim(e.value), 20), '');
    elsif sec is null and k = 'section' then
      sec := nullif(left(trim(e.value), 20), '');
    elsif brd is null and k = 'board' then
      brd := public.ledger_board(e.value);
    elsif yr is null and k in ('academicyear', 'session', 'year') and trim(e.value) ~ '^[0-9]{4}-[0-9]{2}$' then
      yr := trim(e.value);
    end if;
  end loop;
  insert into public.students (institute_id, name, class_label, section, board, academic_year, parent_name, phone,
                               source, admission_lead_id, created_by)
    values (l.institute_id, coalesce(kid, l.name), cls, sec, brd, yr, case when kid is not null then l.name end,
            l.phone, 'admission', l.id, p_seat)
    returning id into sid;
  update public.leads set student_id = sid where id = l.id and student_id is null;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (l.institute_id, auth.uid(), 'student.added_from_admission', sid::text || ':' || l.id::text);
  return sid;
end $$;

-- An institute's own result on the built-in admission type with key admission_done / admission_confirmed
-- creates a student by default (the demo's "Admission confirmed"); admins can change it.
create or replace function public.call_type_results_creates_student_default()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if not new.creates_student and new.key in ('admission_done', 'admission_confirmed')
     and exists (select 1 from call_types t where t.id = new.call_type_id and t.key = 'admission' and t.institute_id is null) then
    new.creates_student := true;
  end if;
  return new;
end $$;
create trigger call_type_results_creates_student before insert on public.call_type_results
  for each row execute function public.call_type_results_creates_student_default();
update public.call_type_results r set creates_student = true
 where r.key in ('admission_done', 'admission_confirmed')
   and exists (select 1 from public.call_types t where t.id = r.call_type_id and t.key = 'admission' and t.institute_id is null);

-- =====================================================================================================
-- 4. save_call_result: open campaigns and "creates a student"
-- =====================================================================================================

-- Same as 0021, except:
--   * who may save: the seat the lead is assigned to; a member of the lead's campaign (a lead moved while
--     the phone was offline, as before); or, in an open campaign, a seat that already saved a call of that
--     lead (an offline retry after the lead moved). Anyone else gets "lead not found". The lead itself still
--     changes only while it is assigned to the seat.
--   * a result with creates_student makes a student from the lead (once per lead), source 'admission'.
-- Returns jsonb { outcome_id, duplicate, lead_updated, lead_status, next_call_at, student_id }.
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
  sid    uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if coalesce(trim(p_client_record_id), '') = '' or length(p_client_record_id) > 80 then
    raise exception 'record id must be 1 to 80 characters' using errcode = '22023';
  end if;

  select o.id into oid from public.call_outcomes o
   where o.seat_id = seat.id and o.client_record_id = p_client_record_id;
  if oid is not null then
    return jsonb_build_object('outcome_id', oid, 'duplicate', true, 'lead_updated', false);
  end if;

  select * into l from public.leads where id = p_lead;
  select * into c from public.campaigns where id = l.campaign_id;
  if l.id is null or l.institute_id <> seat.institute_id
     or (l.assigned_seat_id is distinct from seat.id
         and not exists (select 1 from public.campaign_members m
                          where m.campaign_id = l.campaign_id and m.seat_id = seat.id)
         and not (c.open_to_all and exists (select 1 from public.call_outcomes o
                                            where o.lead_id = l.id and o.seat_id = seat.id))) then
    raise exception 'lead not found' using errcode = '42501';
  end if;
  if c.status = 'draft' then raise exception 'lead not found' using errcode = '42501'; end if;
  if p_rating is not null and p_rating not between 1 and 5 then
    raise exception 'rating must be 1 to 5' using errcode = '22023';
  end if;
  if p_amount is not null and p_amount < 0 then
    raise exception 'amount must be 0 or more' using errcode = '22023';
  end if;

  select * into r from public.call_type_results_for(c.call_type_id, c.institute_id) x
   where x.key = p_result_key limit 1;

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

  if r.creates_student then
    sid := public.ledger_student_from_lead(l.id, seat.id);
  end if;

  return jsonb_build_object('outcome_id', oid, 'duplicate', false, 'lead_updated', upd,
                            'lead_status', case when upd then st end, 'next_call_at', case when upd then nxt end,
                            'student_id', sid);
end $$;

-- Turn "creates a student" on or off for a result: built-in type results and the institute's own results.
-- Admin. Audit call_type_result.creates_student_on / _off.
create or replace function public.admin_set_result_creates_student(p_result uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  r    public.call_type_results;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_admin_of(seat.institute_id) then
    raise exception 'only an admin can manage call types' using errcode = '42501';
  end if;
  if p_on is null then raise exception 'say yes or no' using errcode = '22023'; end if;
  select * into r from public.call_type_results where id = p_result;
  if r.id is null or r.institute_id is distinct from seat.institute_id then
    raise exception 'result not found: only your institute''s own results can be changed' using errcode = '22023';
  end if;
  update public.call_type_results set creates_student = p_on where id = r.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(),
            case when p_on then 'call_type_result.creates_student_on' else 'call_type_result.creates_student_off' end,
            r.id::text);
end $$;

-- =====================================================================================================
-- 5. Ledger RPCs
-- =====================================================================================================

-- Imports students (and their fee items and an opening "paid so far") from a sheet. p_rows: a JSON array of
-- at most 5000 objects:
--   { admission_no, name, class_label (or class), section, board, academic_year, parent_name, phone,
--     alt_phone, status ('active' | 'left'),
--     fees: [{ head, amount, due_date 'YYYY-MM-DD', academic_year }], paid_so_far, paid_on 'YYYY-MM-DD' }
-- A row whose admission_no is already a student updates that student (fields that are given); other rows
-- add a student (source 'import'). Fee items already there (same head, amount and due date, not void) are
-- not added twice. paid_so_far > 0 is recorded once per student as a payment (mode 'other', note 'Opening
-- balance import', paid_on or today). A bad row is skipped with its reason; the rest go in.
-- Returns jsonb { added, updated, skipped, fee_items_added, payments_added, skipped_rows: [{ row, reason }] }
-- (row = 1-based position). Owner or accounts. Audit students.imported <added>:<updated>:<skipped>.
create or replace function public.accounts_import_students(p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  seat     public.seats;
  inst     uuid;
  today    date;
  r        jsonb;
  i        int := 0;
  why      text;
  adm      text;
  nm       text;
  cls      text;
  sec      text;
  brd      text;
  yr       text;
  par      text;
  ph       text;
  alt      text;
  sts      text;
  paid     numeric;
  paid_on  date;
  fee      jsonb;
  f_amt    numeric;
  f_due    date;
  f_head   text;
  f_yr     text;
  sid      uuid;
  seen     text[] := '{}';
  n_add    int := 0;
  n_upd    int := 0;
  n_fee    int := 0;
  n_pay    int := 0;
  touched  boolean;
  skipped  jsonb := '[]'::jsonb;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  inst := seat.institute_id;
  perform public.ledger_manager_seat(inst);
  today := public.ledger_today(inst);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'students must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'send at most 5000 students at a time' using errcode = '22023';
  end if;

  for r in select e from jsonb_array_elements(p_rows) e loop
    i := i + 1;
    why := null;
    if jsonb_typeof(r) <> 'object' then
      skipped := skipped || jsonb_build_object('row', i, 'reason', 'not a row'); continue;
    end if;
    adm := nullif(left(trim(coalesce(r ->> 'admission_no', '')), 40), '');
    nm := nullif(left(trim(coalesce(r ->> 'name', '')), 120), '');
    cls := nullif(left(trim(coalesce(r ->> 'class_label', r ->> 'class', '')), 20), '');
    sec := nullif(left(trim(coalesce(r ->> 'section', '')), 20), '');
    par := nullif(left(trim(coalesce(r ->> 'parent_name', '')), 120), '');
    brd := null; yr := null; ph := null; alt := null; sts := null; paid := null; paid_on := null;
    if nm is null then why := 'no name'; end if;
    if why is null and adm is not null and lower(adm) = any (seen) then why := 'admission number twice in the file'; end if;
    if why is null and nullif(trim(coalesce(r ->> 'board', '')), '') is not null then
      brd := public.ledger_board(r ->> 'board');
      if brd is null then why := 'unknown board'; end if;
    end if;
    if why is null and nullif(trim(coalesce(r ->> 'academic_year', '')), '') is not null then
      yr := trim(r ->> 'academic_year');
      if yr !~ '^[0-9]{4}-[0-9]{2}$' then why := 'academic year must look like 2026-27'; end if;
    end if;
    if why is null and nullif(trim(coalesce(r ->> 'phone', '')), '') is not null then
      ph := public.normalise_phone(r ->> 'phone');
      if ph is null then why := 'bad phone number'; end if;
    end if;
    if why is null and nullif(trim(coalesce(r ->> 'alt_phone', '')), '') is not null then
      alt := public.normalise_phone(r ->> 'alt_phone');
      if alt is null then why := 'bad alternate phone number'; end if;
    end if;
    if why is null and nullif(trim(coalesce(r ->> 'status', '')), '') is not null then
      sts := lower(trim(r ->> 'status'));
      if sts not in ('active', 'left') then why := 'status must be active or left'; end if;
    end if;
    if why is null then
      paid := public.ledger_amount(r ->> 'paid_so_far');
      if paid < 0 then why := 'bad paid so far amount'; end if;
    end if;
    if why is null then
      begin
        paid_on := public.ledger_date(r ->> 'paid_on');
      exception when others then why := 'paid on must be a date (YYYY-MM-DD)';
      end;
    end if;
    if why is null and r ? 'fees' and jsonb_typeof(r -> 'fees') not in ('array', 'null') then
      why := 'fees must be a list';
    end if;
    if why is null and jsonb_typeof(r -> 'fees') = 'array' then
      for fee in select x from jsonb_array_elements(r -> 'fees') x loop
        if jsonb_typeof(fee) <> 'object' or nullif(trim(coalesce(fee ->> 'head', '')), '') is null
           or length(trim(fee ->> 'head')) > 80
           or coalesce(public.ledger_amount(fee ->> 'amount'), 0) <= 0
           or coalesce(trim(fee ->> 'academic_year'), '') !~ '^([0-9]{4}-[0-9]{2})?$' then
          why := 'bad fee item'; exit;
        end if;
        begin
          if public.ledger_date(fee ->> 'due_date') is null then why := 'a fee item needs a due date'; exit; end if;
        exception when others then why := 'fee due date must be a date (YYYY-MM-DD)'; exit;
        end;
      end loop;
    end if;
    if why is not null then
      skipped := skipped || jsonb_build_object('row', i, 'reason', why); continue;
    end if;
    if adm is not null then seen := seen || lower(adm); end if;

    sid := null;
    if adm is not null then
      select s.id into sid from public.students s where s.institute_id = inst and lower(s.admission_no) = lower(adm);
    end if;
    if sid is null then
      insert into public.students (institute_id, admission_no, name, class_label, section, board, academic_year,
                                   parent_name, phone, alt_phone, status, source, created_by)
        values (inst, adm, nm, cls, sec, brd, yr, par, ph, alt, coalesce(sts, 'active'), 'import', seat.id)
        returning id into sid;
      n_add := n_add + 1;
    else
      update public.students set
        name = nm, class_label = coalesce(cls, class_label), section = coalesce(sec, section),
        board = coalesce(brd, board), academic_year = coalesce(yr, academic_year),
        parent_name = coalesce(par, parent_name), phone = coalesce(ph, phone), alt_phone = coalesce(alt, alt_phone),
        status = coalesce(sts, status)
      where id = sid;
      n_upd := n_upd + 1;
    end if;

    touched := false;
    if jsonb_typeof(r -> 'fees') = 'array' then
      for fee in select x from jsonb_array_elements(r -> 'fees') x loop
        f_head := trim(fee ->> 'head');
        f_amt := public.ledger_amount(fee ->> 'amount');
        f_due := public.ledger_date(fee ->> 'due_date');
        f_yr := coalesce(nullif(trim(fee ->> 'academic_year'), ''), yr);
        if not exists (select 1 from public.fee_items fi where fi.student_id = sid and not fi.is_void
                       and lower(fi.head) = lower(f_head) and fi.amount = f_amt and fi.due_date = f_due) then
          insert into public.fee_items (institute_id, student_id, head, amount, due_date, academic_year, created_by)
            values (inst, sid, f_head, f_amt, f_due, f_yr, seat.id);
          n_fee := n_fee + 1;
          touched := true;
        end if;
      end loop;
    end if;
    if coalesce(paid, 0) > 0
       and not exists (select 1 from public.payments p where p.student_id = sid and p.opening
                       and public.payment_is_live(p.id)) then
      insert into public.payments (institute_id, student_id, amount, paid_on, mode, note, recorded_by, opening)
        values (inst, sid, paid, least(coalesce(paid_on, today), today), 'other', 'Opening balance import', seat.id, true);
      n_pay := n_pay + 1;
      touched := true;
    end if;
    if touched then perform public.ledger_sync_student(sid); end if;
  end loop;

  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'students.imported', n_add || ':' || n_upd || ':' || jsonb_array_length(skipped));
  return jsonb_build_object('added', n_add, 'updated', n_upd, 'skipped', jsonb_array_length(skipped),
                            'fee_items_added', n_fee, 'payments_added', n_pay, 'skipped_rows', skipped);
end $$;

-- Adds or changes one student by hand. p_student null adds (source 'manual'); otherwise changes the given
-- fields. p_data: { admission_no, name, class_label, section, board, academic_year, parent_name, phone,
-- alt_phone, status }; a key that is missing keeps its value, '' or null clears it (name cannot be cleared).
-- Owner or accounts. Audit student.added / student.changed. Returns the student id.
create or replace function public.accounts_save_student(p_student uuid, p_data jsonb)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  st   public.students;
  d    jsonb := coalesce(p_data, '{}'::jsonb);
  v    text;
  sid  uuid;
  function_key text;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  if jsonb_typeof(d) <> 'object' then raise exception 'send the student as an object' using errcode = '22023'; end if;
  if p_student is null then
    perform public.ledger_manager_seat(seat.institute_id);
    st.institute_id := seat.institute_id; st.status := 'active';
  else
    st := public.ledger_student(p_student, true);
  end if;
  for function_key in select jsonb_object_keys(d) loop
    v := nullif(trim(coalesce(d ->> function_key, '')), '');
    case function_key
      when 'admission_no' then st.admission_no := left(v, 40);
      when 'name' then
        if v is null then raise exception 'name is required' using errcode = '22023'; end if;
        st.name := left(v, 120);
      when 'class_label' then st.class_label := left(v, 20);
      when 'section' then st.section := left(v, 20);
      when 'board' then st.board := public.campaign_check_tags(null, v);
      when 'academic_year' then
        if v is not null and v !~ '^[0-9]{4}-[0-9]{2}$' then
          raise exception 'academic year must look like 2026-27' using errcode = '22023';
        end if;
        st.academic_year := v;
      when 'parent_name' then st.parent_name := left(v, 120);
      when 'phone' then
        st.phone := public.normalise_phone(v);
        if v is not null and st.phone is null then raise exception 'enter a 10-digit mobile number' using errcode = '22023'; end if;
      when 'alt_phone' then
        st.alt_phone := public.normalise_phone(v);
        if v is not null and st.alt_phone is null then raise exception 'enter a 10-digit mobile number' using errcode = '22023'; end if;
      when 'status' then
        if v not in ('active', 'left') then raise exception 'status must be active or left' using errcode = '22023'; end if;
        st.status := v;
      else null;
    end case;
  end loop;
  if st.name is null then raise exception 'name is required' using errcode = '22023'; end if;
  if st.admission_no is not null and exists (select 1 from public.students s where s.institute_id = st.institute_id
       and lower(s.admission_no) = lower(st.admission_no) and s.id is distinct from st.id) then
    raise exception 'another student has this admission number' using errcode = '23505';
  end if;
  if p_student is null then
    insert into public.students (institute_id, admission_no, name, class_label, section, board, academic_year,
                                 parent_name, phone, alt_phone, status, source, created_by)
      values (st.institute_id, st.admission_no, st.name, st.class_label, st.section, st.board, st.academic_year,
              st.parent_name, st.phone, st.alt_phone, st.status, 'manual', seat.id)
      returning id into sid;
  else
    update public.students set admission_no = st.admission_no, name = st.name, class_label = st.class_label,
           section = st.section, board = st.board, academic_year = st.academic_year, parent_name = st.parent_name,
           phone = st.phone, alt_phone = st.alt_phone, status = st.status
     where id = st.id;
    sid := st.id;
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (st.institute_id, auth.uid(), case when p_student is null then 'student.added' else 'student.changed' end, sid::text);
  return sid;
end $$;

-- Adds a fee item to a student. Owner or accounts. Open fees leads of the student get the new balance.
-- Audit fee_item.added. Returns the fee item id.
create or replace function public.accounts_add_fee_item(
  p_student uuid, p_head text, p_amount numeric, p_due_date date, p_academic_year text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  st   public.students;
  seat public.seats;
  hd   text := trim(coalesce(p_head, ''));
  fid  uuid;
begin
  st := public.ledger_student(p_student, true);
  seat := public.ledger_manager_seat(st.institute_id);
  if length(hd) not between 1 and 80 then raise exception 'fee head must be 1 to 80 characters' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount >= 10000000000 or p_amount <> round(p_amount, 2) then
    raise exception 'amount must be more than 0, in rupees and paise' using errcode = '22023';
  end if;
  if p_due_date is null then raise exception 'give the due date' using errcode = '22023'; end if;
  if p_academic_year is not null and p_academic_year !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'academic year must look like 2026-27' using errcode = '22023';
  end if;
  insert into public.fee_items (institute_id, student_id, head, amount, due_date, academic_year, created_by)
    values (st.institute_id, st.id, hd, p_amount, p_due_date, coalesce(p_academic_year, st.academic_year), seat.id)
    returning id into fid;
  perform public.ledger_sync_student(st.id);
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (st.institute_id, auth.uid(), 'fee_item.added', fid::text);
  return fid;
end $$;

-- Voids a fee item (it stays in the history with the reason). Owner or accounts. Audit fee_item.voided.
create or replace function public.accounts_void_fee_item(p_fee_item uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  f    public.fee_items;
  seat public.seats;
  why  text := trim(coalesce(p_reason, ''));
begin
  select * into f from public.fee_items where id = p_fee_item;
  if f.id is null or not public.can_manage_ledger(f.institute_id) then
    raise exception 'fee item not found' using errcode = '42501';
  end if;
  seat := public.ledger_manager_seat(f.institute_id);
  if f.is_void then raise exception 'this fee item is already void' using errcode = '22023'; end if;
  if length(why) not between 1 and 300 then raise exception 'give a reason (up to 300 characters)' using errcode = '22023'; end if;
  update public.fee_items set is_void = true, void_reason = why, voided_at = now(), voided_by = seat.id where id = f.id;
  perform public.ledger_sync_student(f.student_id);
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (f.institute_id, auth.uid(), 'fee_item.voided', f.id::text);
end $$;

-- Records a payment. Owner or accounts. p_mode: upi, cash, cheque, card, bank, other. p_paid_on: not in the
-- future (institute time zone), not before 2000; null = today. For upi, bank and card the reference is
-- required and the same (mode, reference) cannot be recorded twice in the institute while the first payment
-- stands (a reversed payment frees its reference). Open fees leads of the student get the new balance and
-- are closed when nothing is due. Audit payment.recorded <payment>:<student>. Returns the payment id.
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
  st := public.ledger_student(p_student, true);
  seat := public.ledger_manager_seat(st.institute_id);
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

-- Reverses a payment: a new row with the same amount, date and mode pointing at it (reverses_id); the reason
-- goes in its note. Not a reversal, and only once. Owner or accounts. Leads of the student get the new
-- balance (open leads only: a lead already closed stays closed). Audit payment.reversed <reversal>:<payment>.
-- Returns the reversal's id.
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
  if p.id is null or not public.can_manage_ledger(p.institute_id) then
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

-- The students list with balances. p_filters (all optional): { class_label, board, search, only_due,
-- academic_year, status ('active' default, 'left' or 'all'), limit (1-5000, default 500), offset }.
-- search matches name, admission no, parent name or phone digits. only_due: balance due now > 0 (works for
-- people who cannot see money too: they see who owes, not how much). Money columns are null and
-- money_hidden true unless can_see_money(). Owners, managers, accounts. Ordered by class, section, name.
create or replace function public.accounts_students(p_filters jsonb default '{}'::jsonb)
returns table (student_id uuid, admission_no text, name text, class_label text, section text, board text,
               academic_year text, parent_name text, phone text, alt_phone text, status text, source text,
               total_fees numeric, total_due_to_date numeric, paid numeric, balance_due_now numeric,
               balance_total numeric, last_payment_amount numeric, last_payment_on date, last_payment_mode text,
               money_hidden boolean, total_rows bigint)
language plpgsql stable security definer set search_path = public
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
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.can_read_ledger(seat.institute_id) then
    raise exception 'only accounts, owners and managers can see the ledger' using errcode = '42501';
  end if;
  if lim not between 1 and 5000 or off < 0 then raise exception 'limit must be 1 to 5000' using errcode = '22023'; end if;
  if sts not in ('active', 'left', 'all') then raise exception 'status must be active, left or all' using errcode = '22023'; end if;
  if brd is not null then brd := public.campaign_check_tags(null, brd); end if;
  qd := nullif(regexp_replace(coalesce(q, ''), '[^0-9]', '', 'g'), '');
  money := public.can_see_money(seat.institute_id);
  return query
    select s.id, s.admission_no, s.name, s.class_label, s.section, s.board, s.academic_year, s.parent_name,
           s.phone, s.alt_phone, s.status, s.source,
           case when money then b.total_fees end, case when money then b.total_due_to_date end,
           case when money then b.paid end, case when money then b.balance_due_now end,
           case when money then b.balance_total end, case when money then b.last_payment_amount end,
           b.last_payment_on, b.last_payment_mode, not money, count(*) over ()
    from public.students s
    join public.student_balance_rows(seat.institute_id) b on b.student_id = s.id
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
end $$;

-- One student: { student {...}, balance { total_fees, total_due_to_date, paid, balance_due_now,
-- balance_total, last_payment_amount, last_payment_on, last_payment_mode }, money_hidden,
-- fee_items [{ id, head, amount, due_date, academic_year, is_void, void_reason, voided_at, created_at }],
-- payments [{ id, amount, paid_on, mode, reference, note, recorded_by, recorded_by_label, created_at,
--             reverses_id, reversed_by }],
-- calls [{ outcome_id, at, campaign_id, campaign_name, lead_id, result_key, result_label, promised_date,
--          promised_amount, caller, note }] }  (calls of the student's leads and of the admission lead,
-- newest first, at most 200; corrections shown as their own rows). Amounts are null unless can_see_money().
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
    'balance', (select jsonb_build_object(
                  'total_fees', case when money then b.total_fees end,
                  'total_due_to_date', case when money then b.total_due_to_date end,
                  'paid', case when money then b.paid end,
                  'balance_due_now', case when money then b.balance_due_now end,
                  'balance_total', case when money then b.balance_total end,
                  'last_payment_amount', case when money then b.last_payment_amount end,
                  'last_payment_on', b.last_payment_on, 'last_payment_mode', b.last_payment_mode)
                from public.student_balance_rows(st.institute_id, st.id) b),
    'fee_items', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', f.id, 'head', f.head, 'amount', case when money then f.amount end, 'due_date', f.due_date,
                    'academic_year', f.academic_year, 'is_void', f.is_void, 'void_reason', f.void_reason,
                    'voided_at', f.voided_at, 'created_at', f.created_at) order by f.due_date, f.created_at), '[]'::jsonb)
                  from public.fee_items f where f.student_id = st.id),
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

-- A fees campaign from the ledger. Students: active, of p_class_label and p_board when given (null = all),
-- with a valid phone, whose balance due by max(today, p_due_by) is more than p_min_due (default 0). One lead
-- per student: name = parent's name (or the student's), phone = the student's phone, amount_due = that
-- balance, student_id set, extra = { student, class, section, board, admission_no }. Two students with the same
-- phone (siblings) get one lead: the student with the highest balance. The campaign: call type fees, tags, script
-- (checked like admin_create_campaign), open_to_all (default true), share mode next_free (equal when
-- restricted), fees_due_by = p_due_by. It starts running at once when p_start, open to all and there are
-- leads; otherwise it is a draft for an admin to start. Owner, accounts, or a manager who can see money.
-- Audit campaign.created, leads.added <campaign>:<n>, campaign.running, fees_campaign.from_ledger
-- <campaign>:<leads>:<no phone>:<same phone>. Returns the campaign id.
create or replace function public.accounts_create_fees_campaign(
  p_name text, p_class_label text default null, p_board text default null, p_due_by date default null,
  p_min_due numeric default 0, p_script uuid default null, p_open_to_all boolean default true,
  p_start boolean default true)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat   public.seats;
  inst   uuid;
  nm     text := trim(coalesce(p_name, ''));
  brd    text;
  cls    text := nullif(trim(coalesce(p_class_label, '')), '');
  typ    uuid;
  open_  boolean := coalesce(p_open_to_all, true);
  as_of  date;
  cid    uuid;
  n_lead int;
  n_noph int;
  n_same int;
begin
  seat := public.my_active_seat();
  if seat.id is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  inst := seat.institute_id;
  if not (public.can_manage_ledger(inst) or (public.is_admin_of(inst) and public.can_see_money(inst))) then
    raise exception 'only accounts, an owner or a manager who can see money can make a fees campaign from the ledger'
      using errcode = '42501';
  end if;
  if length(nm) not between 1 and 120 then
    raise exception 'campaign name must be 1 to 120 characters' using errcode = '22023';
  end if;
  if p_min_due is null or p_min_due < 0 then raise exception 'minimum due must be 0 or more' using errcode = '22023'; end if;
  brd := public.campaign_check_tags(cls, p_board);
  select t.id into typ from public.call_types t where t.key = 'fees' and t.institute_id is null;
  perform public.campaign_check_script(inst, p_script, typ);
  as_of := greatest(public.ledger_today(inst), coalesce(p_due_by, public.ledger_today(inst)));

  insert into public.campaigns (institute_id, name, call_type_id, script_id, share_mode, status, created_by,
                                open_to_all, class_label, board, fees_due_by)
    values (inst, nm, typ, p_script, case when open_ then 'next_free' else 'equal' end, 'draft', seat.id,
            open_, cls, brd, p_due_by)
    returning id into cid;

  with due as (
    select s.*, b.balance_due_now as bal
    from public.students s
    join public.student_balance_rows(inst, null, as_of) b on b.student_id = s.id
    where s.institute_id = inst and s.status = 'active'
      and (cls is null or lower(s.class_label) = lower(cls))
      and (brd is null or s.board = brd)
      and b.balance_due_now > p_min_due
  ), firsts as (
    select distinct on (d.phone) d.*
    from due d where d.phone is not null
    order by d.phone, d.bal desc, d.name, d.id
  ), ins as (
    insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, student_id, created_at)
      select inst, cid, coalesce(f.parent_name, f.name), f.phone,
             jsonb_strip_nulls(jsonb_build_object('student', f.name, 'class', f.class_label, 'section', f.section,
                                                  'board', f.board, 'admission_no', f.admission_no)),
             f.bal, f.id,
             now() + (row_number() over (order by f.class_label nulls last, f.section nulls last, f.name, f.id)
                      * interval '1 microsecond')
      from firsts f
    returning 1
  )
  select (select count(*) from ins), (select count(*) from due where phone is null),
         (select count(*) from due where phone is not null) - (select count(*) from firsts)
    into n_lead, n_noph, n_same;

  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'campaign.created', cid::text);
  if n_lead > 0 then
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (inst, auth.uid(), 'leads.added', cid::text || ':' || n_lead);
  end if;
  if coalesce(p_start, true) and open_ and n_lead > 0 then
    update public.campaigns set status = 'running' where id = cid;
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (inst, auth.uid(), 'campaign.running', cid::text);
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'fees_campaign.from_ledger', cid::text || ':' || n_lead || ':' || n_noph || ':' || n_same);
  return cid;
end $$;

-- The ledger of one lead's student, for the caller's lead card (same rule as lead_money: the caller of the
-- lead sees it even with hide_money; admins and accounts follow can_see_money). One row; all null with
-- student_id null when the lead has no student. Dates and mode are not money and always come back.
create or replace function public.lead_ledger(p_lead uuid)
returns table (lead_id uuid, student_id uuid, balance_due_now numeric, balance_total numeric,
               last_payment_amount numeric, last_payment_on date, last_payment_mode text, money_hidden boolean)
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
  if not mine and not public.can_read_ledger(l.institute_id) then
    raise exception 'lead not found' using errcode = '42501';
  end if;
  allowed := mine or public.can_see_money(l.institute_id);
  if l.student_id is null then
    return query select l.id, null::uuid, null::numeric, null::numeric, null::numeric, null::date, null::text, not allowed;
    return;
  end if;
  return query
    select l.id, l.student_id,
           case when allowed then b.balance_due_now end, case when allowed then b.balance_total end,
           case when allowed then b.last_payment_amount end, b.last_payment_on, b.last_payment_mode, not allowed
    from public.student_balance_rows(l.institute_id, l.student_id) b;
end $$;

-- Money collected (ledger payments, reversals taken off, opening "paid so far" imports left out) from p_from to p_to (dates, inclusive; at most
-- 400 days), optionally only students with a lead in p_campaign. jsonb { from, to, campaign_id, payments,
-- reversed, total, by_mode [{ mode, payments, amount }], by_day [{ day, payments, amount }], money_hidden }.
-- Counts always; amounts (total, amount) null unless can_see_money(). Owners, managers, accounts.
create or replace function public.ledger_collected(p_institute uuid, p_from date, p_to date, p_campaign uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  money boolean;
  out   jsonb;
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
  money := public.can_see_money(p_institute);
  with p as (
    select py.* from public.payments py
    where py.institute_id = p_institute and py.reverses_id is null and not py.opening
      and py.paid_on between p_from and p_to
      and (p_campaign is null or py.student_id in (select l.student_id from public.leads l
                                                   where l.campaign_id = p_campaign and l.student_id is not null))
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
  return out;
end $$;

-- Promises against the ledger for one campaign. A promise = a call in the campaign with a promised date and
-- amount (e.g. Will pay on date) that has not been corrected. It is kept when the student's payments (not
-- reversed) dated from the call's day to the promised date + 2 days reach the promised amount; part_paid when
-- something was paid; broken when nothing was paid and the grace has passed; waiting otherwise; no_student
-- when the lead has no student (not judged). jsonb { campaign_id, grace_days, promises, kept, part_paid,
-- broken, waiting, no_student, promised_amount, paid_amount, money_hidden, rows [{ outcome_id, lead_id,
-- lead_name, student_id, caller, promised_on, promised_date, promised_amount, paid_amount, state }] } (rows:
-- newest 500). Counts always; amounts null unless can_see_money(). Owners, managers, accounts.
create or replace function public.promises_vs_payments(p_campaign uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  c     public.campaigns;
  money boolean;
  today date;
  tz    text;
  out   jsonb;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null or not public.can_read_ledger(c.institute_id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  money := public.can_see_money(c.institute_id);
  today := public.ledger_today(c.institute_id);
  tz := public.institute_tz(c.institute_id);
  with pr as (
    select o.id, o.lead_id, o.seat_id, o.promised_date, o.amount,
           (coalesce(o.dialled_at, o.uploaded_at) at time zone tz)::date as promised_on,
           coalesce(o.dialled_at, o.uploaded_at) as at, l.name as lead_name, l.student_id
    from public.call_outcomes o
    join public.leads l on l.id = o.lead_id
    where o.campaign_id = c.id and o.promised_date is not null and o.amount is not null and o.amount > 0
      and not exists (select 1 from public.call_outcomes x where x.corrects_id = o.id)
  ), judged as (
    select pr.*, coalesce(pd.paid, 0) as paid,
           case when pr.student_id is null then 'no_student'
                when coalesce(pd.paid, 0) >= pr.amount then 'kept'
                when coalesce(pd.paid, 0) > 0 then 'part_paid'
                when today > pr.promised_date + 2 then 'broken'
                else 'waiting' end as state
    from pr
    left join lateral (
      select sum(py.amount) as paid from public.payments py
      where py.student_id = pr.student_id and py.reverses_id is null
        and not exists (select 1 from public.payments r where r.reverses_id = py.id)
        and py.paid_on between pr.promised_on and pr.promised_date + 2) pd on true
  )
  select jsonb_build_object(
    'campaign_id', c.id, 'grace_days', 2, 'money_hidden', not money,
    'promises', (select count(*) from judged),
    'kept', (select count(*) from judged where state = 'kept'),
    'part_paid', (select count(*) from judged where state = 'part_paid'),
    'broken', (select count(*) from judged where state = 'broken'),
    'waiting', (select count(*) from judged where state = 'waiting'),
    'no_student', (select count(*) from judged where state = 'no_student'),
    'promised_amount', case when money then (select coalesce(sum(amount), 0) from judged where state <> 'no_student') end,
    'paid_amount', case when money then (select coalesce(sum(least(paid, amount)), 0) from judged) end,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'outcome_id', j.id, 'lead_id', j.lead_id, 'lead_name', j.lead_name, 'student_id', j.student_id,
               'caller', (select s.label from public.seats s where s.id = j.seat_id),
               'promised_on', j.promised_on, 'promised_date', j.promised_date,
               'promised_amount', case when money then j.amount end,
               'paid_amount', case when money then j.paid end, 'state', j.state) order by j.at desc), '[]'::jsonb)
             from (select * from judged order by at desc limit 500) j))
  into out;
  return out;
end $$;

-- =====================================================================================================
-- 6. Grants
-- =====================================================================================================

-- Internal: granted to nobody.
revoke all on function public.campaign_seat_can_work(uuid, uuid) from public, anon, authenticated;
revoke all on function public.campaign_check_tags(text, text) from public, anon, authenticated;
revoke all on function public.ledger_guard() from public, anon, authenticated;
revoke all on function public.students_before_write() from public, anon, authenticated;
revoke all on function public.ledger_today(uuid) from public, anon, authenticated;
revoke all on function public.ledger_amount(text) from public, anon, authenticated;
revoke all on function public.ledger_date(text) from public, anon, authenticated;
revoke all on function public.student_balance_rows(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.payment_is_live(uuid) from public, anon, authenticated;
revoke all on function public.ledger_sync_student(uuid) from public, anon, authenticated;
revoke all on function public.ledger_manager_seat(uuid) from public, anon, authenticated;
revoke all on function public.ledger_student(uuid, boolean) from public, anon, authenticated;
revoke all on function public.ledger_student_from_lead(uuid, uuid) from public, anon, authenticated;
revoke all on function public.call_type_results_creates_student_default() from public, anon, authenticated;
revoke all on function public.campaign_share_equal(uuid) from public, anon, authenticated;
revoke all on function public.campaign_share_next_free(uuid) from public, anon, authenticated;

-- Signed-in users (each function checks the person itself).
revoke all on function public.is_accounts_of(uuid) from public, anon;
revoke all on function public.can_read_ledger(uuid) from public, anon;
revoke all on function public.can_manage_ledger(uuid) from public, anon;
revoke all on function public.can_see_money(uuid) from public, anon;
revoke all on function public.admin_set_seat_role(uuid, text) from public, anon;
revoke all on function public.invite_seat(uuid, text, text, text) from public, anon;
revoke all on function public.ledger_board(text) from public, anon;
revoke all on function public.admin_set_campaign_members(uuid, uuid[]) from public, anon;
revoke all on function public.admin_create_campaign(text, uuid, uuid, date, date, int, text, boolean, text, text) from public, anon;
revoke all on function public.admin_update_campaign(uuid, text, uuid, uuid, boolean, date, date, boolean, int, text, text, boolean, text, text) from public, anon;
revoke all on function public.admin_campaign_list() from public, anon;
revoke all on function public.admin_campaign_detail(uuid) from public, anon;
revoke all on function public.my_campaigns() from public, anon;
revoke all on function public.next_free_lead(uuid) from public, anon;
revoke all on function public.my_call_queue(uuid) from public, anon;
revoke all on function public.campaign_script_version(uuid, uuid) from public, anon;
revoke all on function public.save_call_result(text, uuid, text, date, numeric, text, int, text, jsonb, text, text,
  text, int, timestamptz, int, text, timestamptz, boolean) from public, anon;
revoke all on function public.admin_set_result_creates_student(uuid, boolean) from public, anon;
revoke all on function public.accounts_import_students(jsonb) from public, anon;
revoke all on function public.accounts_save_student(uuid, jsonb) from public, anon;
revoke all on function public.accounts_add_fee_item(uuid, text, numeric, date, text) from public, anon;
revoke all on function public.accounts_void_fee_item(uuid, text) from public, anon;
revoke all on function public.accounts_record_payment(uuid, numeric, date, text, text, text) from public, anon;
revoke all on function public.accounts_reverse_payment(uuid, text) from public, anon;
revoke all on function public.accounts_students(jsonb) from public, anon;
revoke all on function public.accounts_student_detail(uuid) from public, anon;
revoke all on function public.accounts_create_fees_campaign(text, text, text, date, numeric, uuid, boolean, boolean) from public, anon;
revoke all on function public.lead_ledger(uuid) from public, anon;
revoke all on function public.ledger_collected(uuid, date, date, uuid) from public, anon;
revoke all on function public.promises_vs_payments(uuid) from public, anon;

grant execute on function public.is_accounts_of(uuid) to authenticated;
grant execute on function public.can_read_ledger(uuid) to authenticated;
grant execute on function public.can_manage_ledger(uuid) to authenticated;
grant execute on function public.can_see_money(uuid) to authenticated;
grant execute on function public.admin_set_seat_role(uuid, text) to authenticated;
grant execute on function public.invite_seat(uuid, text, text, text) to authenticated;
grant execute on function public.ledger_board(text) to authenticated;
grant execute on function public.admin_set_campaign_members(uuid, uuid[]) to authenticated;
grant execute on function public.admin_create_campaign(text, uuid, uuid, date, date, int, text, boolean, text, text) to authenticated;
grant execute on function public.admin_update_campaign(uuid, text, uuid, uuid, boolean, date, date, boolean, int, text, text, boolean, text, text) to authenticated;
grant execute on function public.admin_campaign_list() to authenticated;
grant execute on function public.admin_campaign_detail(uuid) to authenticated;
grant execute on function public.my_campaigns() to authenticated;
grant execute on function public.next_free_lead(uuid) to authenticated;
grant execute on function public.my_call_queue(uuid) to authenticated;
grant execute on function public.campaign_script_version(uuid, uuid) to authenticated;
grant execute on function public.save_call_result(text, uuid, text, date, numeric, text, int, text, jsonb, text, text,
  text, int, timestamptz, int, text, timestamptz, boolean) to authenticated;
grant execute on function public.admin_set_result_creates_student(uuid, boolean) to authenticated;
grant execute on function public.accounts_import_students(jsonb) to authenticated;
grant execute on function public.accounts_save_student(uuid, jsonb) to authenticated;
grant execute on function public.accounts_add_fee_item(uuid, text, numeric, date, text) to authenticated;
grant execute on function public.accounts_void_fee_item(uuid, text) to authenticated;
grant execute on function public.accounts_record_payment(uuid, numeric, date, text, text, text) to authenticated;
grant execute on function public.accounts_reverse_payment(uuid, text) to authenticated;
grant execute on function public.accounts_students(jsonb) to authenticated;
grant execute on function public.accounts_student_detail(uuid) to authenticated;
grant execute on function public.accounts_create_fees_campaign(text, text, text, date, numeric, uuid, boolean, boolean) to authenticated;
grant execute on function public.lead_ledger(uuid) to authenticated;
grant execute on function public.ledger_collected(uuid, date, date, uuid) to authenticated;
grant execute on function public.promises_vs_payments(uuid) to authenticated;
