-- The caller screen's helper column searches a script's pushback answers ({label, answer}), so the campaign's
-- script comes with the pushbacks of the same version (the tested version for a lead in a script test).
-- Same checks and rows as 20261024100026; only the pushbacks column is new. A new return column needs a
-- drop and create, so the grants are given again.
drop function if exists public.campaign_script_version(uuid, uuid);

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
  if not admin and (c.status = 'draft' or not exists (
      select 1 from public.campaign_members m join public.seats s on s.id = m.seat_id
      where m.campaign_id = c.id and s.user_id = auth.uid() and s.status = 'active')) then
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

revoke all on function public.campaign_script_version(uuid, uuid) from public, anon;
grant execute on function public.campaign_script_version(uuid, uuid) to authenticated;
