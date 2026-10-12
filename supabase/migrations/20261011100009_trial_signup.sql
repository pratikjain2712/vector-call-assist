-- Vector 2.0: free trial sign-up from the public home page.
-- A new login can start an institute. It becomes the admin, gets 5 seats and a 14-day trial, and pays
-- nothing. Each login can start at most one trial. The end date is recorded here; blocking invites or
-- sign-ins after trial_ends_at comes with billing. Apply after 0008.

alter table public.institutes
  add column if not exists trial_ends_at timestamptz,
  add column if not exists created_by uuid references auth.users (id) on delete set null;

-- Institutes created before this migration keep trial_ends_at null (no end date was recorded then).

-- Start a trial institute for the signed-in login. The caller becomes its only admin.
create or replace function public.start_trial_institute(p_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  inst_name text := trim(coalesce(p_name, ''));
  inst      uuid;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if length(inst_name) < 2 or length(inst_name) > 120 then
    raise exception 'institute name must be 2 to 120 characters';
  end if;
  if exists (select 1 from seats where user_id = uid and status = 'active') then
    raise exception 'this login already holds a seat';
  end if;
  if exists (select 1 from institutes where created_by = uid) then
    raise exception 'this login has already started a trial';
  end if;

  insert into institutes (name, status, seat_limit, trial_ends_at, created_by)
    values (inst_name, 'trial', 5, now() + interval '14 days', uid)
    returning id into inst;
  insert into seats (institute_id, user_id, label, role, status)
    values (inst, uid, 'Admin', 'admin', 'active');
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, uid, 'institute.trial_started', inst::text);
  return inst;
end $$;

-- The institute and role of the signed-in login's active seat, or null when it holds none.
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
    'role',           s.role)
  from public.seats s
  join public.institutes i on i.id = s.institute_id
  where s.user_id = auth.uid() and s.status = 'active'
  limit 1;
$$;

revoke execute on function public.start_trial_institute(text) from public, anon;
grant  execute on function public.start_trial_institute(text) to authenticated;
revoke execute on function public.my_trial_status() from public, anon;
grant  execute on function public.my_trial_status() to authenticated;
