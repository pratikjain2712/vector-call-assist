-- Phase A integration fixes (Sprint 8–12 branches merged together).
--
-- 1. wa_claim_briefs (0027) aggregated the rows of admin_weekly_brief, but the real function (0026) returns one
--    text[]; the brief would have gone out as a single nested array. It now flattens the array.
-- 2. campaign_check_script (0020): its TODO is done. scripts.call_type_id exists (0022), so a campaign's script
--    must be of the campaign's type or untyped (saved before 0022). The trigger campaigns_check_script (0022)
--    enforces the same rule; this gives the admin functions the same message before the write.

create or replace function public.wa_claim_briefs(p_week date)
returns setof jsonb
language plpgsql security definer set search_path = public
as $$
declare
  r      record;
  lines  jsonb;
  mid    uuid;
  old_claims text;
  old_sub    text;
begin
  if not public.wa_brief_available() then return; end if;
  old_claims := current_setting('request.jwt.claims', true);
  old_sub := current_setting('request.jwt.claim.sub', true);
  for r in
    select b.seat_id, b.phone, s.user_id, s.institute_id, i.name as institute_name, c.id as campaign_id,
           c.name as campaign_name,
           t.id as template_id, t.key, t.meta_name, t.language, t.category, t.body, t.param_sources,
           a.phone_number_id, a.token_source,
           (select x.token_cipher from public.whatsapp_secrets x where x.institute_id = s.institute_id) as token_cipher
    from public.whatsapp_brief_recipients b
    join public.seats s on s.id = b.seat_id and s.status = 'active' and s.role = 'admin' and s.admin_kind = 'owner'
    join public.institutes i on i.id = s.institute_id and i.status in ('trial', 'active', 'grace')
    join public.whatsapp_accounts a on a.institute_id = s.institute_id and a.status = 'connected'
    join public.whatsapp_templates t on t.institute_id = s.institute_id and t.key = 'weekly_brief'
                                    and t.meta_status = 'approved'
    join public.campaigns c on c.institute_id = s.institute_id and c.status = 'running'
    order by s.institute_id, b.seat_id, c.name
  loop
    begin
      perform set_config('request.jwt.claims', jsonb_build_object('sub', r.user_id, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', r.user_id::text, true);
      -- admin_weekly_brief (0026) returns text[]: one row holding the array. Flatten it, so lines is a list of
      -- strings whether the function returns an array, a set of text or rows.
      execute 'select coalesce(jsonb_agg(e.v), ''[]''::jsonb)
               from (select to_jsonb(b) as j from public.admin_weekly_brief($1) b) x,
                    jsonb_array_elements(case when jsonb_typeof(x.j) = ''array'' then x.j else jsonb_build_array(x.j) end) as e(v)'
        into lines using r.campaign_id;
    exception when others then
      lines := null;
    end;
    perform set_config('request.jwt.claims', coalesce(old_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
    continue when lines is null or lines = '[]'::jsonb;
    mid := null;
    insert into public.whatsapp_messages (institute_id, seat_id, template_id, template_key, direction, kind, status,
                                          category, dedupe_key)
      values (r.institute_id, r.seat_id, r.template_id, r.key, 'out', 'brief', 'queued', r.category,
              'brief:' || r.seat_id || ':' || r.campaign_id || ':' || p_week)
      on conflict (institute_id, dedupe_key) do update set status = 'queued', error = null, status_at = now()
        where whatsapp_messages.status = 'failed'
      returning id into mid;
    continue when mid is null;
    return next jsonb_build_object(
      'message_id', mid, 'institute_id', r.institute_id, 'institute_name', r.institute_name, 'phone', r.phone,
      'campaign_name', r.campaign_name,
      'lines', lines,
      'template', jsonb_build_object('id', r.template_id, 'key', r.key, 'meta_name', r.meta_name,
                                     'language', r.language, 'category', r.category, 'body', r.body,
                                     'param_sources', to_jsonb(r.param_sources)),
      'account', jsonb_build_object('phone_number_id', r.phone_number_id, 'token_source', r.token_source),
      'token_cipher', r.token_cipher);
  end loop;
end $$;

create or replace function public.campaign_check_script(p_institute uuid, p_script uuid, p_call_type uuid)
returns void
language plpgsql stable security definer set search_path = public
as $$
declare st uuid;
begin
  if p_script is null then return; end if;
  if not public.has_feature(p_institute, 'scripts') then
    raise exception 'add Scripts to your plan to use a script in a campaign' using errcode = '42501';
  end if;
  select s.call_type_id into st from public.scripts s where s.id = p_script and s.institute_id = p_institute;
  if not found then
    raise exception 'script not found' using errcode = '22023';
  end if;
  if st is not null and p_call_type is not null and st <> p_call_type then
    raise exception 'that script is for another call type' using errcode = '22023';
  end if;
  if not exists (select 1 from public.script_versions v where v.script_id = p_script and v.published) then
    raise exception 'that script has no live version yet: publish it first' using errcode = '22023';
  end if;
end $$;

revoke all on function public.campaign_check_script(uuid, uuid, uuid) from public, anon, authenticated;
