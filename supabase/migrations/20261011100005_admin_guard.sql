-- Vector 2.0: admins cannot revoke or reassign their own seat, and cannot change any admin seat.
-- This replaces revoke_seat and reassign_seat from 0002 with the same signatures, security and
-- search_path settings. The rules are enforced here on the server, not only in the web page.
-- Everything else (audit entry, unpairing the seat's devices) is unchanged.

create or replace function public.revoke_seat(p_seat uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  inst uuid;
  srole text;
  suser uuid;
begin
  select institute_id, role, user_id into inst, srole, suser from seats where id = p_seat;
  if inst is null then raise exception 'seat not found'; end if;
  if not public.is_admin_of(inst) then raise exception 'only an admin of this institute can revoke'; end if;
  if suser is not null and suser = auth.uid() then
    raise exception 'you cannot revoke your own seat';
  end if;
  if srole = 'admin' then
    raise exception 'admin seats cannot be changed from the app yet';
  end if;
  update seats set status = 'revoked', user_id = null where id = p_seat;
  update devices set revoked_at = now() where seat_id = p_seat and revoked_at is null;
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'seat.revoked', p_seat::text);
end $$;

create or replace function public.reassign_seat(p_seat uuid, p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  inst uuid;
  srole text;
  suser uuid;
  mail text := lower(trim(p_email));
begin
  select institute_id, role, user_id into inst, srole, suser from seats where id = p_seat;
  if inst is null then raise exception 'seat not found'; end if;
  if not public.is_admin_of(inst) then raise exception 'only an admin of this institute can reassign'; end if;
  if suser is not null and suser = auth.uid() then
    raise exception 'you cannot reassign your own seat';
  end if;
  if srole = 'admin' then
    raise exception 'admin seats cannot be changed from the app yet';
  end if;
  if mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'enter a valid email'; end if;

  update seats set user_id = null, status = 'invited', invite_email = mail where id = p_seat;
  update devices set revoked_at = now() where seat_id = p_seat and revoked_at is null;
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'seat.reassigned', p_seat::text);
end $$;

-- Same grants as 0002: signed-in users only.
revoke all on function public.revoke_seat(uuid) from public, anon;
revoke all on function public.reassign_seat(uuid, text) from public, anon;
grant execute on function public.revoke_seat(uuid) to authenticated;
grant execute on function public.reassign_seat(uuid, text) to authenticated;
