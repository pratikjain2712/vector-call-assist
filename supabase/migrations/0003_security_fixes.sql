-- Vector 2.0: fixes from the security review of 0001 and 0002.
-- Apply after 0002. Each change is a new statement, so earlier history is not rewritten.

-- 1. Helper functions are callable only by signed-in users, never by anonymous visitors.
revoke all on function public.my_active_seat() from public, anon;
revoke all on function public.is_admin_of(uuid) from public, anon;
grant execute on function public.my_active_seat() to authenticated;
grant execute on function public.is_admin_of(uuid) to authenticated;

-- 2. A correction must point at an outcome from the same seat, so a rep cannot reference
--    another institute's rows. The lookup runs in a security definer function so it does not
--    re-enter the call_outcomes policies.
create or replace function public.outcome_belongs_to_seat(p_outcome uuid, p_seat uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.call_outcomes c where c.id = p_outcome and c.seat_id = p_seat);
$$;
revoke all on function public.outcome_belongs_to_seat(uuid, uuid) from public, anon;
grant execute on function public.outcome_belongs_to_seat(uuid, uuid) to authenticated;

drop policy if exists outcomes_insert_own on public.call_outcomes;
create policy outcomes_insert_own on public.call_outcomes
  for insert with check (
    exists (
      select 1 from public.seats s
      where s.id = seat_id
        and s.institute_id = call_outcomes.institute_id
        and s.user_id = auth.uid()
        and s.status = 'active'
    )
    and (corrects_id is null or public.outcome_belongs_to_seat(corrects_id, seat_id))
  );

-- 3. An invitation can be claimed only by a login whose email is confirmed.
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
  if not exists (select 1 from auth.users u where u.id = uid and u.email_confirmed_at is not null) then
    raise exception 'confirm your email before claiming a seat';
  end if;
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
revoke all on function public.claim_my_invite() from public, anon;
grant execute on function public.claim_my_invite() to authenticated;
