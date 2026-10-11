-- Vector 2.0: seat and invite functions.
-- Every function here runs with the caller's own login (auth.uid()). It checks the caller's role
-- itself, so it's safe to call from the browser through the normal API.
-- Sending the invite email is done by a server function that calls invite_seat() first.

alter table public.seats add column if not exists invite_email text
  check (invite_email is null or length(invite_email) <= 254);

-- An invited seat is claimable only by the login whose email matches.
create unique index if not exists seats_one_invite_per_email
  on public.seats (institute_id, lower(invite_email)) where status = 'invited' and invite_email is not null;

-- Create an institute. The caller becomes its first admin.
create or replace function public.create_institute(p_name text, p_seat_limit int default 5)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  inst uuid;
  uid  uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first'; end if;
  if p_seat_limit < 1 or p_seat_limit > 500 then raise exception 'seat limit must be 1 to 500'; end if;
  insert into institutes (name, seat_limit, status) values (p_name, p_seat_limit, 'trial')
    returning id into inst;
  insert into seats (institute_id, user_id, label, role, status)
    values (inst, uid, 'Admin', 'admin', 'active');
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, uid, 'institute.created', inst::text);
  return inst;
end $$;

-- Invite a person to a seat. Returns the seat id. The email is sent by the server function.
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
  if p_role not in ('admin', 'rep') then raise exception 'role must be admin or rep'; end if;
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

-- Called by a person right after they sign in: claims the invited seat that matches their email.
create or replace function public.claim_my_invite()
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  uid  uuid := auth.uid();
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  s    public.seats;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if exists (select 1 from seats where user_id = uid and status = 'active') then
    raise exception 'this login already holds an active seat';
  end if;
  select * into s from seats
    where status = 'invited' and lower(invite_email) = mail
    order by created_at limit 1;
  if s.id is null then raise exception 'no invitation found for this email'; end if;

  update seats set user_id = uid, status = 'active', invite_email = null where id = s.id;
  insert into audit_log (institute_id, actor_id, action, target)
    values (s.institute_id, uid, 'seat.claimed', s.id::text);
  return s.id;
end $$;

-- Revoke a seat. Its devices are unpaired and the person's access stops at their next write.
create or replace function public.revoke_seat(p_seat uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare inst uuid;
begin
  select institute_id into inst from seats where id = p_seat;
  if inst is null then raise exception 'seat not found'; end if;
  if not public.is_admin_of(inst) then raise exception 'only an admin of this institute can revoke'; end if;
  update seats set status = 'revoked', user_id = null where id = p_seat;
  update devices set revoked_at = now() where seat_id = p_seat and revoked_at is null;
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'seat.revoked', p_seat::text);
end $$;

-- Hand a seat to someone else. The old person's devices are unpaired; the new person must claim it.
create or replace function public.reassign_seat(p_seat uuid, p_email text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  inst uuid;
  mail text := lower(trim(p_email));
begin
  select institute_id into inst from seats where id = p_seat;
  if inst is null then raise exception 'seat not found'; end if;
  if not public.is_admin_of(inst) then raise exception 'only an admin of this institute can reassign'; end if;
  if mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'enter a valid email'; end if;

  update seats set user_id = null, status = 'invited', invite_email = mail where id = p_seat;
  update devices set revoked_at = now() where seat_id = p_seat and revoked_at is null;
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'seat.reassigned', p_seat::text);
end $$;

-- Unpair one device so the seat can pair a new phone or laptop.
create or replace function public.reset_pairing(p_seat uuid, p_kind text)
returns void
language plpgsql security definer set search_path = public
as $$
declare inst uuid;
begin
  if p_kind not in ('phone', 'laptop') then raise exception 'kind must be phone or laptop'; end if;
  select institute_id into inst from seats where id = p_seat;
  if inst is null then raise exception 'seat not found'; end if;
  if not public.is_admin_of(inst) then raise exception 'only an admin of this institute can reset pairing'; end if;
  update devices set revoked_at = now()
    where seat_id = p_seat and kind = p_kind and revoked_at is null;
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'pairing.reset', p_seat::text || ':' || p_kind);
end $$;

-- Pairing: a seat registers a new device. Only the seat's own login can do this, and only once per kind.
create or replace function public.register_device(p_seat uuid, p_kind text, p_fingerprint text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  did uuid;
  inst uuid;
begin
  if p_kind not in ('phone', 'laptop') then raise exception 'kind must be phone or laptop'; end if;
  if length(coalesce(p_fingerprint, '')) not between 16 and 200 then raise exception 'bad device fingerprint'; end if;
  if not exists (select 1 from seats where id = p_seat and user_id = auth.uid() and status = 'active') then
    raise exception 'this login does not hold that seat';
  end if;
  if exists (select 1 from devices where seat_id = p_seat and kind = p_kind and revoked_at is null) then
    raise exception 'a % is already paired to this seat; ask an admin to reset it', p_kind;
  end if;
  select institute_id into inst from seats where id = p_seat;
  insert into devices (seat_id, kind, fingerprint) values (p_seat, p_kind, p_fingerprint)
    returning id into did;
  insert into audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), 'device.registered', p_kind);
  return did;
end $$;

-- Let signed-in users run these functions; nobody else.
revoke all on function public.create_institute(text, int) from public, anon;
revoke all on function public.invite_seat(uuid, text, text, text) from public, anon;
revoke all on function public.claim_my_invite() from public, anon;
revoke all on function public.revoke_seat(uuid) from public, anon;
revoke all on function public.reassign_seat(uuid, text) from public, anon;
revoke all on function public.reset_pairing(uuid, text) from public, anon;
revoke all on function public.register_device(uuid, text, text) from public, anon;
grant execute on function public.create_institute(text, int) to authenticated;
grant execute on function public.invite_seat(uuid, text, text, text) to authenticated;
grant execute on function public.claim_my_invite() to authenticated;
grant execute on function public.revoke_seat(uuid) to authenticated;
grant execute on function public.reassign_seat(uuid, text) to authenticated;
grant execute on function public.reset_pairing(uuid, text) to authenticated;
grant execute on function public.register_device(uuid, text, text) to authenticated;
