-- Vector 2.0 Phase A, Sprint 8 (admin side): create and run campaigns, upload leads, pick callers, share and
-- move leads. Apply after 20261024100014_features.sql. Builds on the tables of 20261024100012 and the money
-- rules of 20261024100013 (docs/data-contract.md, section "Campaigns: admin functions").
--
-- Every function here is security definer, checks that the signed-in person is an admin (owner or manager) of
-- the campaign's institute, validates its input and writes audit_log. The browser still cannot insert, update
-- or delete campaigns, members or leads directly.
--
-- Sharing leads (campaigns.share_mode):
--   equal:     leads are split between the campaign's callers up front, so each caller has about the same
--              number of open leads. Re-sharing only moves leads nobody has called yet.
--   next_free: leads stay unassigned; a caller takes the next one with next_free_lead(), which locks it
--              (for update skip locked) so two callers never get the same lead.
-- Callbacks and promises stay with the caller who made them, except when that caller leaves the campaign.
--
-- No money is returned except admin_campaign_detail's amount_due_total, and only when can_see_money().

-- ---------- internal helpers (granted to nobody) ----------

-- The campaign, when the signed-in person is an admin of its institute. Otherwise "campaign not found", so
-- a guessed id from another institute tells nothing.
create or replace function public.campaign_for_admin(p_campaign uuid)
returns public.campaigns
language plpgsql stable security definer set search_path = public
as $$
declare c public.campaigns;
begin
  select * into c from public.campaigns where id = p_campaign;
  if c.id is null or not public.is_admin_of(c.institute_id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  return c;
end $$;

-- The signed-in admin's active seat, or "only an admin can manage campaigns".
create or replace function public.campaign_admin_seat()
returns public.seats
language plpgsql stable security definer set search_path = public
as $$
declare seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin can manage campaigns' using errcode = '42501';
  end if;
  return seat;
end $$;

-- A lead still to be worked: not finished, not a wrong number, not "do not call".
create or replace function public.lead_is_open(p_status text, p_do_not_call boolean)
returns boolean
language sql immutable set search_path = public
as $$ select p_status in ('new', 'callback', 'promised') and not coalesce(p_do_not_call, false) $$;

-- Checks a script for a campaign: same institute, has a live (published) version, and the institute has the
-- Scripts add-on (a trial has everything). Null is fine: a campaign can run without a script.
-- TODO(scripts agent, Sprint 9): when scripts.call_type_id exists, also require it to match p_call_type
-- (or be null). The admin screen has the matching filter switched off too (SCRIPT_TYPE_FILTER in
-- web/js/admin/campaigns.js).
create or replace function public.campaign_check_script(p_institute uuid, p_script uuid, p_call_type uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_script is null then return; end if;
  if not public.has_feature(p_institute, 'scripts') then
    raise exception 'add Scripts to your plan to use a script in a campaign' using errcode = '42501';
  end if;
  if not exists (select 1 from public.scripts s where s.id = p_script and s.institute_id = p_institute) then
    raise exception 'script not found' using errcode = '22023';
  end if;
  if not exists (select 1 from public.script_versions v where v.script_id = p_script and v.published) then
    raise exception 'that script has no live version yet: publish it first' using errcode = '22023';
  end if;
end $$;

-- A lead nobody has called yet: status new and no call saved for it.
create or replace function public.lead_is_uncalled(p_lead uuid, p_status text)
returns boolean
language sql stable security definer set search_path = public
as $$ select p_status = 'new' and not exists (select 1 from public.call_outcomes o where o.lead_id = p_lead) $$;

-- Shares a campaign's leads in equal parts between its active members, moving as few leads as possible.
-- A member keeps their callbacks, promises and leads already called; leads nobody has called yet, open
-- leads in the pool and open leads of seats that are not members are shared out so that every member ends
-- with the same number of open leads, give or take one, wherever that is possible ("water filling": the
-- members with the fewest kept leads are filled first). A member with more uncalled leads than their part
-- gives the newest ones back. Returns the number of leads that got a new caller. No audit row (callers do).
create or replace function public.campaign_share_equal(p_campaign uuid)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  seats_  uuid[];
  kept    int[];     -- open leads a member keeps whatever happens
  unc     int[];     -- open leads a member holds that nobody has called yet
  quota   int[];     -- uncalled and pool leads each member should end with
  need    int[];     -- pool leads each member still gets
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

  -- Everything that can be handed out: the pool plus every member's uncalled leads.
  select count(*) into n from public.leads l
  where l.campaign_id = p_campaign and public.lead_is_open(l.status, l.do_not_call)
    and (l.assigned_seat_id is null or not (l.assigned_seat_id = any (seats_)));
  for i in 1 .. m loop n := n + unc[i]; end loop;
  if n = 0 then return 0; end if;

  -- Raise the j members with the fewest kept leads to one level with the n leads.
  quota := array_fill(0, array[m]);
  for j in reverse m .. 1 loop
    s := n;
    for i in 1 .. j loop s := s + kept[i]; end loop;
    lvl := s / j;
    if lvl >= kept[j] then
      extra := s - lvl * j;   -- the first "extra" members get one more
      for i in 1 .. j loop
        quota[i] := lvl - kept[i] + case when i <= extra then 1 else 0 end;
      end loop;
      exit;
    end if;
  end loop;

  -- A member over their part gives back their newest uncalled leads; the others keep theirs.
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

  -- Pool rows 1..need[1] go to member 1, the next need[2] to member 2, and so on.
  with q as (
    select t.seat_id,
           coalesce(sum(t.need) over (order by t.ord rows between unbounded preceding and 1 preceding), 0) as lo,
           sum(t.need) over (order by t.ord) as hi
    from unnest(seats_, need) with ordinality as t(seat_id, need, ord)
  ), pool as (
    select l.id, row_number() over (order by l.created_at, l.id) as rn
    from public.leads l
    where l.campaign_id = p_campaign and public.lead_is_open(l.status, l.do_not_call)
      and (l.assigned_seat_id is null or not (l.assigned_seat_id = any (seats_)))
  )
  update public.leads l set assigned_seat_id = q.seat_id
  from pool join q on pool.rn > q.lo and pool.rn <= q.hi
  where l.id = pool.id;
  get diagnostics changed = row_count;
  return changed;
end $$;

-- next_free: open leads that nobody has called yet go back to the pool; callbacks and promises stay.
-- Leads of seats that are no longer members (or no longer active) go back to the pool too.
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
         or not exists (select 1 from public.campaign_members m join public.seats st on st.id = m.seat_id
                        where m.campaign_id = p_campaign and m.seat_id = l.assigned_seat_id and st.status = 'active'));
  get diagnostics changed = row_count;
  return changed;
end $$;

-- ---------- campaigns ----------

-- A new campaign, always a draft (start it with admin_update_campaign(..., p_status => 'running')).
-- p_call_type: an active built-in type or one of the institute's own. p_script: see campaign_check_script.
-- Returns the campaign id. Audit campaign.created.
create or replace function public.admin_create_campaign(
  p_name text, p_call_type uuid, p_script uuid default null, p_start date default null, p_end date default null,
  p_daily_target int default null, p_share_mode text default 'equal')
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
  nm   text := trim(coalesce(p_name, ''));
  cid  uuid;
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
  if coalesce(p_share_mode, 'equal') not in ('equal', 'next_free') then
    raise exception 'share leads must be equal or next_free' using errcode = '22023';
  end if;
  perform public.campaign_check_script(seat.institute_id, p_script, p_call_type);
  insert into public.campaigns (institute_id, name, call_type_id, script_id, start_date, end_date, daily_target,
                                share_mode, status, created_by)
    values (seat.institute_id, nm, p_call_type, p_script, p_start, p_end, p_daily_target,
            coalesce(p_share_mode, 'equal'), 'draft', seat.id)
    returning id into cid;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(), 'campaign.created', cid::text);
  return cid;
end $$;

-- Changes a campaign. A null argument keeps the value; p_clear_script, p_clear_dates and p_daily_target 0
-- clear. The call type changes only while the campaign is a draft. Status changes:
--   draft -> running (needs at least one caller and one lead), draft -> closed,
--   running <-> paused, running or paused -> closed. A closed campaign stays closed.
-- p_share_mode only records the mode; admin_share_leads moves the leads. Audit campaign.changed and, for a
-- status change, campaign.<status> (campaign.running, campaign.paused, campaign.closed).
create or replace function public.admin_update_campaign(
  p_campaign uuid, p_name text default null, p_call_type uuid default null, p_script uuid default null,
  p_clear_script boolean default false, p_start date default null, p_end date default null,
  p_clear_dates boolean default false, p_daily_target int default null, p_share_mode text default null,
  p_status text default null)
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
  if st <> '' and st <> c.status then
    if st not in ('running', 'paused', 'closed') then
      raise exception 'status must be running, paused or closed' using errcode = '22023';
    end if;
    if st = 'paused' and c.status <> 'running' then
      raise exception 'only a running campaign can be paused' using errcode = '22023';
    end if;
    if st = 'running' and c.status = 'draft' then
      if not exists (select 1 from public.campaign_members m join public.seats s on s.id = m.seat_id
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
    status = case when st = '' then status else st end
  where id = c.id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'campaign.changed', c.id::text);
  if st <> '' and st <> c.status then
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (c.institute_id, auth.uid(), 'campaign.' || st, c.id::text);
  end if;
end $$;

-- ---------- leads ----------

-- Adds leads to a campaign in one go. p_rows is a JSON array (at most 5000 rows a call) of
--   { "name": text, "phone": text, "amount_due": number or numeric text or null, "extra": { text: text } }.
-- Rows are checked one by one and the bad ones skipped, never the whole call, except: extra keys that look
-- like money (extra_has_money_key) refuse the whole call, because the column mapping is wrong.
-- Returns the counts: added, bad_numbers (missing or not 10 digits), repeats (twice in the rows or already
-- in the campaign), other_skipped (no name, a bad amount, extra too long or not an object).
-- In equal mode the new leads are shared between the callers at once. Not for a closed campaign.
-- Audit leads.added, target <campaign>:<added>.
create or replace function public.admin_add_leads(p_campaign uuid, p_rows jsonb)
returns table (added int, bad_numbers int, repeats int, other_skipped int)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  c       public.campaigns;
  r       jsonb;
  nm      text;
  ph      text;
  amt     numeric;
  amt_txt text;
  ex      jsonb;
  -- The good rows, in sheet order (plpgsql appends to arrays in place, so this stays fast for 5000 rows).
  names   text[] := '{}';
  phones  text[] := '{}';
  amounts numeric[] := '{}';
  extras  jsonb[] := '{}';
  n_add   int := 0;
  n_bad   int := 0;
  n_rep   int := 0;
  n_other int := 0;
begin
  perform public.campaign_admin_seat();
  c := public.campaign_for_admin(p_campaign);
  if c.status = 'closed' then
    raise exception 'this campaign is closed: start a new one for more leads' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'leads must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'send at most 5000 leads at a time' using errcode = '22023';
  end if;
  -- A wrong column mapping is refused as a whole: money must go to amount_due, never to extra.
  if exists (select 1 from jsonb_array_elements(p_rows) e
             where jsonb_typeof(e -> 'extra') = 'object' and public.extra_has_money_key(e -> 'extra')) then
    raise exception 'a column with money in it was sent as an extra field: match it to Amount due or leave it out'
      using errcode = '22023';
  end if;

  for r in select e from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(r) <> 'object' then n_other := n_other + 1; continue; end if;
    ph := public.normalise_phone(r ->> 'phone');
    if ph is null then n_bad := n_bad + 1; continue; end if;
    nm := left(trim(coalesce(r ->> 'name', '')), 120);
    if nm = '' then n_other := n_other + 1; continue; end if;
    amt := null;
    amt_txt := trim(coalesce(r ->> 'amount_due', ''));
    if amt_txt <> '' then
      if amt_txt !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then n_other := n_other + 1; continue; end if;
      amt := amt_txt::numeric;
    end if;
    ex := coalesce(r -> 'extra', '{}'::jsonb);
    if jsonb_typeof(ex) = 'null' then ex := '{}'::jsonb; end if;
    if jsonb_typeof(ex) <> 'object' or length(ex::text) > 8000 then n_other := n_other + 1; continue; end if;
    -- The same number twice in the rows, or already in the campaign.
    if ph = any (phones) or exists (select 1 from public.leads l where l.campaign_id = c.id and l.phone = ph) then
      n_rep := n_rep + 1; continue;
    end if;
    names := names || nm;
    phones := phones || ph;
    amounts := amounts || amt;
    extras := extras || ex;
  end loop;

  -- created_at keeps the sheet order (a microsecond apart), so shares and next_free_lead go in upload order.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, created_at)
    select c.institute_id, c.id, t.name, t.phone, t.extra, t.amount_due, now() + (t.n * interval '1 microsecond')
    from unnest(names, phones, amounts, extras) with ordinality as t(name, phone, amount_due, extra, n);
  get diagnostics n_add = row_count;

  if n_add > 0 then
    if c.share_mode = 'equal' then perform public.campaign_share_equal(c.id); end if;
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (c.institute_id, auth.uid(), 'leads.added', c.id::text || ':' || n_add);
  end if;
  return query select n_add, n_bad, n_rep, n_other;
end $$;

-- ---------- callers ----------

-- Sets who calls for a campaign: p_seats replaces the member list. Every seat must be an active seat of the
-- campaign's institute. Open leads of a seat that leaves go back to the pool; in equal mode the leads are
-- then shared again between the members. Returns the number of members. Audit campaign.members_set,
-- target <campaign>:<members>.
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

  -- Open leads of seats that left go back to the pool.
  update public.leads l set assigned_seat_id = null
  where l.campaign_id = c.id and l.assigned_seat_id is not null and not (l.assigned_seat_id = any (want))
    and public.lead_is_open(l.status, l.do_not_call);
  if c.share_mode = 'equal' then perform public.campaign_share_equal(c.id); end if;

  total := cardinality(want);
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'campaign.members_set', c.id::text || ':' || total);
  return total;
end $$;

-- Shares a campaign's leads: 'equal' splits them between the callers now (needs at least one caller);
-- 'next_free' puts every lead nobody has called yet back in the pool for next_free_lead(). Also records the
-- mode on the campaign. Returns how many leads changed hands. Audit leads.shared, target <campaign>:<mode>:<n>.
create or replace function public.admin_share_leads(p_campaign uuid, p_mode text)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  c       public.campaigns;
  changed int;
begin
  perform public.campaign_admin_seat();
  c := public.campaign_for_admin(p_campaign);
  if c.status = 'closed' then
    raise exception 'this campaign is closed and cannot be changed' using errcode = '22023';
  end if;
  if p_mode is null or p_mode not in ('equal', 'next_free') then
    raise exception 'share leads must be equal or next_free' using errcode = '22023';
  end if;
  if p_mode = 'equal' and not exists (select 1 from public.campaign_members m join public.seats s on s.id = m.seat_id
                                      where m.campaign_id = c.id and s.status = 'active') then
    raise exception 'add at least one caller first' using errcode = '22023';
  end if;
  update public.campaigns set share_mode = p_mode where id = c.id and share_mode <> p_mode;
  if p_mode = 'equal' then changed := public.campaign_share_equal(c.id);
  else changed := public.campaign_share_next_free(c.id);
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (c.institute_id, auth.uid(), 'leads.shared', c.id::text || ':' || p_mode || ':' || changed);
  return changed;
end $$;

-- Moves the open leads (new, callback, promised; not "do not call") of one seat to another, in one campaign
-- or (p_campaign null) in every campaign of the institute that is not closed. p_to_seat null puts them back
-- in the pool. The new seat must be an active seat of the same institute and becomes a member of each
-- campaign it gets leads in. Returns the number of leads moved. Used by the Callers tab ("Move leads").
-- Audit leads.moved, target <from>:<to or pool>:<n>.
create or replace function public.admin_move_leads(p_from_seat uuid, p_to_seat uuid, p_campaign uuid default null)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  seat  public.seats;
  inst  uuid;
  moved int;
begin
  seat := public.campaign_admin_seat();
  select s.institute_id into inst from public.seats s where s.id = p_from_seat;
  if inst is null or not public.is_admin_of(inst) then
    raise exception 'caller not found' using errcode = '42501';
  end if;
  if p_to_seat is not null then
    if p_to_seat = p_from_seat then
      raise exception 'pick a different caller to move the leads to' using errcode = '22023';
    end if;
    if not exists (select 1 from public.seats s where s.id = p_to_seat and s.institute_id = inst and s.status = 'active') then
      raise exception 'the caller to move the leads to is not an active seat of this institute' using errcode = '22023';
    end if;
  end if;
  if p_campaign is not null then
    perform public.campaign_for_admin(p_campaign);
    if exists (select 1 from public.campaigns k where k.id = p_campaign and (k.institute_id <> inst or k.status = 'closed')) then
      raise exception 'leads of a closed campaign cannot be moved' using errcode = '22023';
    end if;
  end if;

  with m as (
    update public.leads l set assigned_seat_id = p_to_seat
    from public.campaigns k
    where k.id = l.campaign_id and l.institute_id = inst and l.assigned_seat_id = p_from_seat
      and k.status <> 'closed' and (p_campaign is null or l.campaign_id = p_campaign)
      and public.lead_is_open(l.status, l.do_not_call)
    returning l.id, l.campaign_id
  ), joined as (
    -- The new seat joins each campaign it gets leads in.
    insert into public.campaign_members (campaign_id, seat_id, institute_id)
      select distinct m.campaign_id, p_to_seat, inst from m where p_to_seat is not null
    on conflict (campaign_id, seat_id) do nothing
    returning 1
  )
  select count(*) into moved from m;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'leads.moved',
            p_from_seat::text || ':' || coalesce(p_to_seat::text, 'pool') || ':' || moved);
  return moved;
end $$;

-- ---------- reading ----------

-- Every campaign of the admin's institute, newest first, with progress counts. No money.
--   leads_total: all leads; leads_called: leads with a saved call or a status other than new;
--   leads_open: leads still to be worked; leads_unassigned: open leads in the pool (next_free) or waiting
--   for a caller; callers: [{ seat_id, label }] in label order.
create or replace function public.admin_campaign_list()
returns table (id uuid, name text, status text, call_type_id uuid, call_type_key text, call_type_label text,
               script_id uuid, script_name text, start_date date, end_date date, daily_target int,
               share_mode text, leads_total bigint, leads_called bigint, leads_open bigint,
               leads_unassigned bigint, callers jsonb, created_at timestamptz, updated_at timestamptz)
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
           c.created_at, c.updated_at
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

-- One campaign in detail, as one JSON object:
--   { id, name, status, call_type_id, call_type_key, call_type_label, script_id, script_name,
--     script_live_version, start_date, end_date, daily_target, share_mode, created_at,
--     leads: { total, called, open, unassigned, new, callback, promised, done, wrong_number, do_not_call },
--     calls_today, callers: [{ seat_id, label, status, leads, open, called, calls_today }],
--     results: [{ key, label, count }]  (latest saved result per call, corrections applied),
--     amount_due_total (null unless can_see_money), money_hidden }
-- "Today" is the current day in Asia/Kolkata.
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
                  'leads', (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = s.id),
                  'open', (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = s.id
                             and public.lead_is_open(l.status, l.do_not_call)),
                  'called', (select count(*) from public.leads l where l.campaign_id = c.id and l.assigned_seat_id = s.id
                               and (l.status <> 'new' or exists (select 1 from public.call_outcomes o where o.lead_id = l.id))),
                  'calls_today', (select count(*) from public.call_outcomes o
                                  where o.campaign_id = c.id and o.seat_id = s.id and o.corrects_id is null
                                    and coalesce(o.dialled_at, o.uploaded_at) >= day0)
                ) order by s.label), '[]'::jsonb)
                from public.campaign_members m join public.seats s on s.id = m.seat_id
                where m.campaign_id = c.id),
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

-- ---------- caller: the next lead ("whoever is free next") ----------

-- Gives the signed-in caller the next lead of a running campaign their active seat is a member of, and
-- assigns it to them. If they already hold a lead they took and have not called yet (a reload, for example),
-- that one comes back instead of a new one, so the pool is not emptied by accident. Otherwise: the oldest
-- due callback or promise in the pool first, then new leads in upload order. Only leads the institute may
-- call (consent_call) and not "do not call". Locked with for update skip locked: two callers asking at the
-- same moment get different leads. No row when the pool is empty. No money (use lead_money(lead_id)).
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
  if c.id is null or c.institute_id <> seat.institute_id
     or not exists (select 1 from public.campaign_members m where m.campaign_id = c.id and m.seat_id = seat.id) then
    raise exception 'campaign not found' using errcode = '42501';
  end if;
  if c.status <> 'running' then
    raise exception 'this campaign is not running' using errcode = '22023';
  end if;

  -- A lead this caller took and has not called yet.
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

-- ---------- grants ----------

revoke all on function public.campaign_for_admin(uuid) from public, anon, authenticated;
revoke all on function public.campaign_admin_seat() from public, anon, authenticated;
revoke all on function public.lead_is_open(text, boolean) from public, anon, authenticated;
revoke all on function public.campaign_check_script(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.lead_is_uncalled(uuid, text) from public, anon, authenticated;
revoke all on function public.campaign_share_equal(uuid) from public, anon, authenticated;
revoke all on function public.campaign_share_next_free(uuid) from public, anon, authenticated;

revoke all on function public.admin_create_campaign(text, uuid, uuid, date, date, int, text) from public, anon;
revoke all on function public.admin_update_campaign(uuid, text, uuid, uuid, boolean, date, date, boolean, int, text, text) from public, anon;
revoke all on function public.admin_add_leads(uuid, jsonb) from public, anon;
revoke all on function public.admin_set_campaign_members(uuid, uuid[]) from public, anon;
revoke all on function public.admin_share_leads(uuid, text) from public, anon;
revoke all on function public.admin_move_leads(uuid, uuid, uuid) from public, anon;
revoke all on function public.admin_campaign_list() from public, anon;
revoke all on function public.admin_campaign_detail(uuid) from public, anon;
revoke all on function public.next_free_lead(uuid) from public, anon;
grant execute on function public.admin_create_campaign(text, uuid, uuid, date, date, int, text) to authenticated;
grant execute on function public.admin_update_campaign(uuid, text, uuid, uuid, boolean, date, date, boolean, int, text, text) to authenticated;
grant execute on function public.admin_add_leads(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_campaign_members(uuid, uuid[]) to authenticated;
grant execute on function public.admin_share_leads(uuid, text) to authenticated;
grant execute on function public.admin_move_leads(uuid, uuid, uuid) to authenticated;
grant execute on function public.admin_campaign_list() to authenticated;
grant execute on function public.admin_campaign_detail(uuid) to authenticated;
grant execute on function public.next_free_lead(uuid) to authenticated;
