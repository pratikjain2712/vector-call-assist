-- Vector 2.0: terms acceptance is per person (auth user), not per seat.
-- Before this, accepted_terms was keyed on seat_id, so a seat handed to someone new (reassign_seat keeps
-- the seat id) inherited the previous holder's acceptance. Apply after 0007.
-- Old rows are kept. A row keeps its seat_id; user_id is filled in where the seat's holder is known for
-- certain, and stays null otherwise (a null user_id matches no login, so that person accepts again).

-- ---------- column ----------

alter table public.accepted_terms
  add column if not exists user_id uuid references auth.users (id) on delete set null;

-- ---------- backfill ----------

-- Credit a row to the seat's current holder only when the seat was not reassigned after the row was
-- accepted. Otherwise the current holder is someone else and the row stays null.
update public.accepted_terms t
   set user_id = s.user_id
  from public.seats s
 where s.id = t.seat_id
   and s.user_id is not null
   and t.user_id is null
   and not exists (
     select 1 from public.audit_log a
     where a.action = 'seat.reassigned'
       and a.target = t.seat_id::text
       and a.created_at > t.accepted_at
   );

-- A person who held two seats in one institute may have accepted the same version twice. Keep the
-- earliest; the later row keeps its seat_id but loses the person (user_id null), so the unique key holds.
update public.accepted_terms t
   set user_id = null
 where t.user_id is not null
   and exists (
     select 1 from public.accepted_terms o
     where o.user_id = t.user_id
       and o.institute_id = t.institute_id
       and o.terms_version = t.terms_version
       and (o.accepted_at, o.id) < (t.accepted_at, t.id)
   );

-- ---------- keys ----------

alter table public.accepted_terms drop constraint if exists accepted_terms_seat_id_terms_version_key;
alter table public.accepted_terms
  add constraint accepted_terms_user_institute_version_key unique (user_id, institute_id, terms_version);

-- ---------- row-level security ----------

-- A seat's new holder must not read the previous holder's acceptances. Admins still read the institute's.
drop policy if exists accepted_terms_read on public.accepted_terms;
create policy accepted_terms_read on public.accepted_terms
  for select using (
    public.is_admin_of(institute_id)
    or user_id = auth.uid()
  );

-- ---------- terms acceptance ----------

-- Record that the caller accepted terms version p_version in p_institute, on the caller's active seat there.
-- Idempotent per person and version: a second call changes nothing and keeps the first hash.
create or replace function public.accept_terms(p_institute uuid, p_version text, p_text_hash text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if p_version is null or length(p_version) not between 1 and 40 then
    raise exception 'terms version must be 1 to 40 characters';
  end if;
  if p_text_hash is null or length(p_text_hash) not between 16 and 128 then
    raise exception 'terms hash must be 16 to 128 characters';
  end if;
  select id into sid from public.seats
    where institute_id = p_institute and user_id = uid and status = 'active';
  if sid is null then raise exception 'this login holds no active seat in that institute'; end if;

  insert into public.accepted_terms (institute_id, seat_id, user_id, terms_version, text_hash)
    values (p_institute, sid, uid, p_version, p_text_hash)
    on conflict (user_id, institute_id, terms_version) do nothing;
end $$;

-- The caller's own acceptances in p_institute (empty when the caller holds no active seat there).
create or replace function public.my_terms_status(p_institute uuid)
returns table (terms_version text, accepted_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select t.terms_version, t.accepted_at
  from public.accepted_terms t
  where t.institute_id = p_institute
    and t.user_id = auth.uid()
    and exists (
      select 1 from public.seats s
      where s.institute_id = p_institute
        and s.user_id = auth.uid()
        and s.status = 'active'
    )
  order by t.accepted_at;
$$;

-- ---------- grants: signed-in users only (unchanged) ----------

revoke all on function public.accept_terms(uuid, text, text) from public, anon;
revoke all on function public.my_terms_status(uuid) from public, anon;
grant execute on function public.accept_terms(uuid, text, text) to authenticated;
grant execute on function public.my_terms_status(uuid) to authenticated;
