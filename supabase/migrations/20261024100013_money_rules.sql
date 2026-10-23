-- Vector 2.0 Phase A, Sprint 7: money rules. Apply after 20261024100012.
--
-- Roles. seats.role keeps its two values, so every function that checks role = 'admin' or is_admin_of()
-- works as before:
--   role 'admin' + admin_kind 'owner'   = Owner: everything, money included, and the money switches.
--   role 'admin' + admin_kind 'manager' = Manager: everything an admin did before, but no money unless the
--                                         seat's can_see_money is on.
--   role 'rep'   (admin_kind null)      = Caller.
-- seats.access_role ('owner' | 'manager' | 'caller') is the same thing as one column, for the web pages.
-- Admin seats that exist now become owners (they could see everything before). A new admin seat becomes the
-- owner when it is the institute's first admin seat (create_institute, start_trial_institute), otherwise a
-- manager (invite_seat with role 'admin'). admin_set_seat_role changes it.
--
-- Money. institutes.hide_money hides money from everyone, owners included ("Hide money everywhere").
-- can_see_money(institute) is the one check for totals, reports and exports. A caller sees money only for one
-- lead at a time, through lead_money(), and only for a lead assigned to them.
-- Enforcement: money columns (leads.amount_due, leads.promised_amount, call_outcomes.amount) have no SELECT
-- grant for the browser role at all, for any role. They are read only through security definer functions
-- that call can_see_money() (or lead_money()'s caller rule). Every money export is written to audit_log
-- with log_money_export(). We store amounts and dates only, never bank, card or UPI details.

-- ---------- columns ----------

alter table public.institutes
  add column if not exists hide_money boolean not null default false;

alter table public.seats
  add column if not exists admin_kind text check (admin_kind in ('owner', 'manager')),
  add column if not exists can_see_money boolean not null default false;

update public.seats set admin_kind = 'owner' where role = 'admin' and admin_kind is null;

alter table public.seats
  add constraint seats_admin_kind_matches_role check ((role = 'admin') = (admin_kind is not null)),
  add constraint seats_money_for_managers check (not can_see_money or admin_kind = 'manager');

alter table public.seats
  add column if not exists access_role text generated always as
    (case when role = 'admin' then admin_kind else 'caller' end) stored;

-- Fills admin_kind on a new or changed seat, so the functions from 0002, 0009 and 0011 need no change.
create or replace function public.seats_admin_kind()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.role = 'rep' then
    new.admin_kind := null;
    new.can_see_money := false;
  elsif new.admin_kind is null then
    new.admin_kind := case
      when exists (select 1 from seats s
                   where s.institute_id = new.institute_id and s.role = 'admin'
                     and s.status <> 'revoked' and s.id <> new.id)
      then 'manager' else 'owner' end;
  end if;
  if new.admin_kind is distinct from 'manager' then new.can_see_money := false; end if;
  return new;
end $$;

create trigger seats_admin_kind before insert or update of role, admin_kind, can_see_money on public.seats
  for each row execute function public.seats_admin_kind();

-- ---------- helpers ----------

-- True when the logged-in user is an active owner of the given institute.
create or replace function public.is_owner_of(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.seats s
    where s.institute_id = inst and s.user_id = auth.uid()
      and s.role = 'admin' and s.admin_kind = 'owner' and s.status = 'active'
  );
$$;

-- True when the logged-in user may see money totals, reports and exports for the institute: an active owner,
-- or an active manager with can_see_money, and the institute does not hide money. Callers: always false
-- (their one-lead rule is in lead_money). Call this in every function that returns an amount.
create or replace function public.can_see_money(inst uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.seats s
    join public.institutes i on i.id = s.institute_id
    where s.institute_id = inst and s.user_id = auth.uid() and s.status = 'active'
      and s.role = 'admin' and (s.admin_kind = 'owner' or s.can_see_money)
      and not i.hide_money
  );
$$;

-- ---------- money columns: no direct reads ----------

-- call_outcomes: 0001 granted SELECT on the whole table. Swap it for column grants without amount.
-- A new call_outcomes column is invisible to the browser until a later migration grants it here.
revoke select on public.call_outcomes from authenticated;
grant select (id, institute_id, seat_id, client_record_id, corrects_id, script_id, script_version, script_step,
              objection, outcome, dialled_at, connected_seconds, phone_session_id, uploaded_at,
              loss_reason, stage_reached, campaign_id, lead_id, result_key, promised_date, result_reason,
              rating, step_times, reached_step)
  on public.call_outcomes to authenticated;
-- INSERT stays a table grant: a caller reports an amount but cannot read amounts back.

-- leads.amount_due and leads.promised_amount were never granted for SELECT (0012). Keep it that way.

-- ---------- reading money ----------

-- Money of one lead. A caller gets it only for a lead assigned to their active seat; an admin only when
-- can_see_money(). money_hidden is true (amounts null) when the person may see the lead but not its money,
-- or when the institute hides money. A lead the person cannot see raises "lead not found".
create or replace function public.lead_money(p_lead uuid)
returns table (lead_id uuid, amount_due numeric, promised_amount numeric, promised_date date, money_hidden boolean)
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
  if not mine and not public.is_admin_of(l.institute_id) then
    raise exception 'lead not found' using errcode = '42501';
  end if;
  allowed := public.can_see_money(l.institute_id)
             or (mine and not (select i.hide_money from public.institutes i where i.id = l.institute_id));
  return query select l.id,
                      case when allowed then l.amount_due end,
                      case when allowed then l.promised_amount end,
                      l.promised_date,
                      not allowed;
end $$;

-- Write that the caller exported money (an Excel file with ₹ columns, for example). Call it before the file
-- is built; it raises when the caller may not see money, so the export must stop. p_what says what was
-- exported (e.g. 'fees_report'), p_rows how many rows. Returns the audit_log id.
create or replace function public.log_money_export(p_institute uuid, p_what text, p_rows int)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  what text := trim(coalesce(p_what, ''));
  aid  bigint;
begin
  if not public.can_see_money(p_institute) then
    raise exception 'you cannot export money for this institute' using errcode = '42501';
  end if;
  if what !~ '^[a-z][a-z0-9_]{1,59}$' then
    raise exception 'export name must be 2 to 60 characters: a-z, 0-9 and _' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 then
    raise exception 'row count must be 0 or more' using errcode = '22023';
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (p_institute, auth.uid(), 'money.exported', what || ':' || p_rows)
    returning id into aid;
  return aid;
end $$;

-- ---------- owner switches ----------

-- Turn "Can see money" on or off for a manager seat. Owner only. Owners always see money; callers never
-- see totals, so only manager seats take this switch.
create or replace function public.admin_set_money_access(p_seat uuid, p_allowed boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  s public.seats;
begin
  select * into s from public.seats where id = p_seat;
  if s.id is null then raise exception 'seat not found' using errcode = '22023'; end if;
  if not public.is_owner_of(s.institute_id) then
    raise exception 'only an owner of this institute can change money access' using errcode = '42501';
  end if;
  if s.admin_kind is distinct from 'manager' then
    raise exception 'money access is set for manager seats only' using errcode = '22023';
  end if;
  if p_allowed is null then raise exception 'say yes or no' using errcode = '22023'; end if;
  update public.seats set can_see_money = p_allowed where id = p_seat;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (s.institute_id, auth.uid(),
            case when p_allowed then 'money.access_given' else 'money.access_removed' end, p_seat::text);
end $$;

-- "Hide money everywhere" for the caller's institute. Owner only. While on, nobody sees amounts.
create or replace function public.admin_set_hide_money(p_hide boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or not public.is_owner_of(seat.institute_id) then
    raise exception 'only an owner can hide or show money' using errcode = '42501';
  end if;
  if p_hide is null then raise exception 'say yes or no' using errcode = '22023'; end if;
  update public.institutes set hide_money = p_hide where id = seat.institute_id;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (seat.institute_id, auth.uid(), case when p_hide then 'money.hidden' else 'money.shown' end,
            seat.institute_id::text);
end $$;

-- Make a seat an owner, a manager or a caller. Owner only; not on your own seat (so an institute always
-- keeps an owner); not on a revoked seat. Moving to caller or owner clears can_see_money.
create or replace function public.admin_set_seat_role(p_seat uuid, p_role text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  s public.seats;
begin
  if p_role is null or p_role not in ('owner', 'manager', 'caller') then
    raise exception 'role must be owner, manager or caller' using errcode = '22023';
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
  else
    update public.seats set role = 'admin', admin_kind = p_role,
                            can_see_money = case when p_role = 'manager' then can_see_money else false end
      where id = p_seat;
  end if;
  insert into public.audit_log (institute_id, actor_id, action, target)
    values (s.institute_id, auth.uid(), 'seat.role_set', p_seat::text || ':' || p_role);
end $$;

-- ---------- my_trial_status: adds the access role and money flags ----------

-- Same as 0009, plus access_role ('owner' | 'manager' | 'caller'), can_see_money (the effective answer of
-- can_see_money() for this login) and hide_money. 'role' keeps its old values ('admin' | 'rep').
create or replace function public.my_trial_status()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'institute_id',   i.id,
    'institute_name', i.name,
    'status',         i.status,
    'seat_limit',     i.seat_limit,
    'trial_ends_at',  i.trial_ends_at,
    'role',           s.role,
    'access_role',    s.access_role,
    'can_see_money',  public.can_see_money(i.id),
    'hide_money',     i.hide_money)
  from public.seats s
  join public.institutes i on i.id = s.institute_id
  where s.user_id = auth.uid() and s.status = 'active'
  limit 1;
$$;

-- ---------- grants: signed-in users only ----------

revoke all on function public.seats_admin_kind() from public, anon, authenticated;

revoke all on function public.is_owner_of(uuid) from public, anon;
revoke all on function public.can_see_money(uuid) from public, anon;
revoke all on function public.lead_money(uuid) from public, anon;
revoke all on function public.log_money_export(uuid, text, int) from public, anon;
revoke all on function public.admin_set_money_access(uuid, boolean) from public, anon;
revoke all on function public.admin_set_hide_money(boolean) from public, anon;
revoke all on function public.admin_set_seat_role(uuid, text) from public, anon;
revoke execute on function public.my_trial_status() from public, anon;
grant execute on function public.is_owner_of(uuid) to authenticated;
grant execute on function public.can_see_money(uuid) to authenticated;
grant execute on function public.lead_money(uuid) to authenticated;
grant execute on function public.log_money_export(uuid, text, int) to authenticated;
grant execute on function public.admin_set_money_access(uuid, boolean) to authenticated;
grant execute on function public.admin_set_hide_money(boolean) to authenticated;
grant execute on function public.admin_set_seat_role(uuid, text) to authenticated;
grant execute on function public.my_trial_status() to authenticated;
