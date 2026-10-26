-- Add row (26 Oct 2026): "+ Add lead" on a calling list and "Add leads by hand" in New calling list send one or
-- a few rows to admin_add_leads, and the admin says whether the person agreed to calls and to WhatsApp.
-- admin_add_leads (20261024100020_campaign_admin.sql) now also reads two optional keys per row:
--   consent_call      boolean, default true  (false: the lead is kept but never handed to a caller)
--   consent_whatsapp  boolean, default false (true: WhatsApp messages may be sent, as when a caller records it)
-- Each takes a JSON true / false, or the text 'true' / 'false' / 'yes' / 'no' (any case); anything else skips the
-- row as "other". Rows without the keys behave exactly as before (Excel uploads send none). Same signature, same
-- answer, same checks (admin, not closed, at most 5000 rows, no money key in extra, bad numbers, repeats), same
-- audit. Tests: supabase/tests/add_row_test.sql.

-- A consent key of a row: true / false, null when the key is missing or JSON null, 'bad' (raised as 22023 inside
-- the caller's loop, never outside) when it is something else. Internal: granted to nobody.
create or replace function public.lead_row_consent(p_row jsonb, p_key text)
returns boolean
language plpgsql immutable
set search_path = public
as $$
declare
  v jsonb := p_row -> p_key;
  t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) = 'boolean' then return (v #>> '{}')::boolean; end if;
  t := lower(trim(coalesce(v #>> '{}', '')));
  if t in ('true', 'yes', 'y') then return true; end if;
  if t in ('false', 'no', 'n') then return false; end if;
  if t = '' then return null; end if;
  raise exception 'consent must be yes or no' using errcode = '22023';
end $$;

create or replace function public.admin_add_leads(p_campaign uuid, p_rows jsonb)
returns table (added int, bad_numbers int, repeats int, other_skipped int)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  c       public.campaigns;
  r       jsonb;
  nm      text;
  ph      text;
  amt     numeric;
  amt_txt text;
  ex      jsonb;
  cc      boolean;
  cw      boolean;
  -- The good rows, in sheet order (plpgsql appends to arrays in place, so this stays fast for 5000 rows).
  names   text[] := '{}';
  phones  text[] := '{}';
  amounts numeric[] := '{}';
  extras  jsonb[] := '{}';
  calls   boolean[] := '{}';
  was     boolean[] := '{}';
  n_add   int := 0;
  n_bad   int := 0;
  n_rep   int := 0;
  n_other int := 0;
begin
  perform public.campaign_admin_seat();
  c := public.campaign_for_admin(p_campaign);
  if c.status = 'closed' then
    raise exception 'this campaign is closed: start a new one for more leads' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'leads must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'send at most 5000 leads at a time' using errcode = '22023';
  end if;
  -- A wrong column mapping is refused as a whole: money must go to amount_due, never to extra.
  if exists (select 1 from jsonb_array_elements(p_rows) e
             where jsonb_typeof(e -> 'extra') = 'object' and public.extra_has_money_key(e -> 'extra')) then
    raise exception 'a column with money in it was sent as an extra field: match it to Amount due or leave it out'
      using errcode = '22023';
  end if;

  for r in select e from jsonb_array_elements(p_rows) e loop
    if jsonb_typeof(r) <> 'object' then n_other := n_other + 1; continue; end if;
    ph := public.normalise_phone(r ->> 'phone');
    if ph is null then n_bad := n_bad + 1; continue; end if;
    nm := left(trim(coalesce(r ->> 'name', '')), 120);
    if nm = '' then n_other := n_other + 1; continue; end if;
    amt := null;
    amt_txt := trim(coalesce(r ->> 'amount_due', ''));
    if amt_txt <> '' then
      if amt_txt !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then n_other := n_other + 1; continue; end if;
      amt := amt_txt::numeric;
    end if;
    ex := coalesce(r -> 'extra', '{}'::jsonb);
    if jsonb_typeof(ex) = 'null' then ex := '{}'::jsonb; end if;
    if jsonb_typeof(ex) <> 'object' or length(ex::text) > 8000 then n_other := n_other + 1; continue; end if;
    begin
      cc := coalesce(public.lead_row_consent(r, 'consent_call'), true);
      cw := coalesce(public.lead_row_consent(r, 'consent_whatsapp'), false);
    exception when sqlstate '22023' then
      n_other := n_other + 1; continue;
    end;
    -- The same number twice in the rows, or already in the campaign.
    if ph = any (phones) or exists (select 1 from public.leads l where l.campaign_id = c.id and l.phone = ph) then
      n_rep := n_rep + 1; continue;
    end if;
    names := names || nm;
    phones := phones || ph;
    amounts := amounts || amt;
    extras := extras || ex;
    calls := calls || cc;
    was := was || cw;
  end loop;

  -- created_at keeps the sheet order (a microsecond apart), so shares and next_free_lead go in upload order.
  insert into public.leads (institute_id, campaign_id, name, phone, extra, amount_due, consent_call, consent_whatsapp, created_at)
    select c.institute_id, c.id, t.name, t.phone, t.extra, t.amount_due, t.consent_call, t.consent_whatsapp,
           now() + (t.n * interval '1 microsecond')
    from unnest(names, phones, amounts, extras, calls, was) with ordinality
      as t(name, phone, amount_due, extra, consent_call, consent_whatsapp, n);
  get diagnostics n_add = row_count;

  if n_add > 0 then
    if c.share_mode = 'equal' then perform public.campaign_share_equal(c.id); end if;
    insert into public.audit_log (institute_id, actor_id, action, target)
      values (c.institute_id, auth.uid(), 'leads.added', c.id::text || ':' || n_add);
  end if;
  return query select n_add, n_bad, n_rep, n_other;
end $$;

revoke all on function public.lead_row_consent(jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_add_leads(uuid, jsonb) from public, anon;
grant execute on function public.admin_add_leads(uuid, jsonb) to authenticated;
