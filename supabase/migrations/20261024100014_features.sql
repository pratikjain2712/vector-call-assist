-- Paid add-ons per institute (docs/phase-a-plan.md "Packaging and prices").
-- features lists what the institute pays for: 'scripts' (guided scripts, editor, script insights) and
-- 'ai_drafts' (AI script maker). A trial gets everything. Only the server (service role) changes the list;
-- billing will set it. Every server function behind an add-on calls has_feature() and refuses without it.

alter table public.institutes
  add column if not exists features text[] not null default '{}'
    check (features <@ array['scripts', 'ai_drafts']::text[]);

create or replace function public.has_feature(inst uuid, feature text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from institutes i
    where i.id = inst
      and (i.status = 'trial' or feature = any (i.features))
      and exists (select 1 from seats s
                  where s.institute_id = i.id and s.user_id = auth.uid() and s.status = 'active')
  )
$$;

-- The features the signed-in person's institute has, for showing or hiding add-on screens.
create or replace function public.my_features()
returns text[]
language sql stable security definer set search_path = public
as $$
  select case when i.status = 'trial' then array['scripts', 'ai_drafts']::text[] else i.features end
  from seats s join institutes i on i.id = s.institute_id
  where s.user_id = auth.uid() and s.status = 'active'
  limit 1
$$;

revoke all on function public.has_feature(uuid, text) from public, anon;
revoke all on function public.my_features() from public, anon;
grant execute on function public.has_feature(uuid, text) to authenticated;
grant execute on function public.my_features() to authenticated;
revoke update (features) on public.institutes from authenticated, anon;
