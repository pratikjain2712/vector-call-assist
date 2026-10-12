-- Vector 2.0: new trials last 5 days instead of 14.
-- Replaces start_trial_institute from 20261011100009 with the same signature, security and grants; only the
-- trial length changes. Trials already started keep the end date they were given. Apply after 0010.

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
    values (inst_name, 'trial', 5, now() + interval '5 days', uid)
    returning id into inst;
  insert into seats (institute_id, user_id, label, role, status)
    values (inst, uid, 'Admin', 'admin', 'active');
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, uid, 'institute.trial_started', inst::text);
  return inst;
end $$;

-- Same grants as 0009: signed-in users only.
revoke execute on function public.start_trial_institute(text) from public, anon;
grant  execute on function public.start_trial_institute(text) to authenticated;
