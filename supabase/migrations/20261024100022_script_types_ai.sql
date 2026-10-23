-- Vector 2.0 Phase A, Sprint 9: script types, ending results, pushback answers, "Check this" marks, the
-- Scripts add-on check on saving, and the log and monthly limit of the AI script maker.
-- Apply after 20261024100014_features.sql. Uses only 0001-0014.
--
-- A script has a call type (scripts.call_type_id). The type decides the result buttons callers see, so every
-- ending of a script (a step with no options) names one of the type's result keys in its "result" field, and a
-- campaign may only use a live script of its own type (trigger on campaigns below). Scripts saved before this
-- migration have no type; a campaign may still use one of those, so running campaigns keep working.
-- Pushback answers ({label, answer}) belong to a version, like the steps (script_versions.pushbacks).
-- "Check this" marks: the AI script maker and the templates put a "check" list of notes on a step or a pushback
-- when a fact must be checked by a person. A version with any mark cannot be published.
-- The step and pushback format is in web/js/script-model.js; the editor checks the content, this file checks
-- what publishing needs. The contract for other features is in docs/data-contract.md ("Scripts").

-- ---------- script types ----------

alter table public.scripts
  add column if not exists call_type_id uuid references public.call_types (id) on delete restrict;

create index if not exists scripts_call_type on public.scripts (call_type_id);

-- A script's type must be built in or the institute's own, and cannot change to another type while a campaign
-- of the old type uses the script.
create or replace function public.scripts_check_type()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.call_type_id is not null and not exists (
       select 1 from call_types t
       where t.id = new.call_type_id and (t.institute_id is null or t.institute_id = new.institute_id)) then
    raise exception 'that call type is not available in this institute' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.call_type_id is not null
     and new.call_type_id is distinct from old.call_type_id
     and exists (select 1 from campaigns c where c.script_id = new.id and c.call_type_id <> new.call_type_id) then
    raise exception 'this script is used in a campaign of another call type' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger scripts_check_type before insert or update of call_type_id, institute_id on public.scripts
  for each row execute function public.scripts_check_type();

-- A campaign uses a live script (one with a published version) of its own call type. A script without a type
-- (saved before 0022) is accepted for any type.
create or replace function public.campaigns_check_script()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  st uuid;
begin
  if new.script_id is null then return new; end if;
  select s.call_type_id into st from scripts s where s.id = new.script_id;
  if not found then return new; end if;   -- the foreign key refuses a missing script
  if st is not null and st <> new.call_type_id then
    raise exception 'that script is for another call type' using errcode = '23514';
  end if;
  if not exists (select 1 from script_versions v where v.script_id = new.script_id and v.published) then
    raise exception 'that script has no live version yet: publish it first' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger campaigns_check_script before insert or update of script_id, call_type_id on public.campaigns
  for each row execute function public.campaigns_check_script();

-- ---------- pushback answers ----------

-- [{label, answer, check?}] in button order: what a caller taps when the person pushes back, and the answer.
alter table public.script_versions
  add column if not exists pushbacks jsonb not null default '[]'::jsonb
    check (jsonb_typeof(pushbacks) = 'array' and jsonb_array_length(pushbacks) <= 12
           and length(pushbacks::text) <= 20000);

-- A published version is history: pushbacks cannot change either (replaces the 0007 guard).
create or replace function public.script_versions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.published then
      raise exception 'a published script version cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.published and (new.script_id <> old.script_id or new.version <> old.version
      or new.steps is distinct from old.steps or new.change_note <> old.change_note
      or new.pushbacks is distinct from old.pushbacks) then
    raise exception 'a published script version cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------- checks for saving and publishing ----------

-- Internal (granted to nobody): the first problem with a pushback list, or null. Same rules as
-- validatePushbacks in web/js/script-model.js.
create or replace function public.script_pushbacks_problem(p_pushbacks jsonb)
returns text
language plpgsql immutable
set search_path = public
as $$
declare
  p      jsonb;
  labels text[] := '{}';
  lbl    text;
begin
  if p_pushbacks is null or jsonb_typeof(p_pushbacks) <> 'array' then return 'pushback answers must be a list'; end if;
  if jsonb_array_length(p_pushbacks) > 12 then return 'keep to 12 pushback answers or fewer'; end if;
  for p in select x from jsonb_array_elements(p_pushbacks) x loop
    if jsonb_typeof(p) <> 'object' then return 'a pushback answer is not a {label, answer} pair'; end if;
    lbl := trim(coalesce(p ->> 'label', ''));
    if jsonb_typeof(p -> 'label') is distinct from 'string' or length(lbl) not between 1 and 60 then
      return 'each pushback needs a label of 1 to 60 characters';
    end if;
    if jsonb_typeof(p -> 'answer') is distinct from 'string' or length(trim(p ->> 'answer')) not between 1 and 600 then
      return 'the pushback "' || lbl || '" needs an answer of 1 to 600 characters';
    end if;
    if lower(lbl) = any (labels) then return 'two pushbacks are labelled "' || lbl || '"'; end if;
    labels := labels || lower(lbl);
  end loop;
  return null;
end $$;

-- True when a step or pushback carries a non-empty "check" list.
create or replace function public.script_has_check_mark(p_item jsonb)
returns boolean
language sql immutable
as $$
  select jsonb_typeof(p_item) = 'object' and jsonb_typeof(p_item -> 'check') = 'array'
         and jsonb_array_length(p_item -> 'check') > 0
$$;

-- Internal (granted to nobody): the first reason a version cannot be published, or null.
--   No "Check this" mark on a step or pushback; a call type; every ending linked to an active result of the type.
create or replace function public.script_publish_problem(
  p_steps jsonb, p_pushbacks jsonb, p_call_type uuid, p_institute uuid)
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare
  s    jsonb;
  res  text;
  name text;
begin
  if p_call_type is null then return 'choose the call type before publishing'; end if;
  if jsonb_array_length(p_steps) = 0 then return 'add at least one step before publishing'; end if;
  if exists (select 1 from jsonb_array_elements(p_steps) x where public.script_has_check_mark(x))
     or exists (select 1 from jsonb_array_elements(coalesce(p_pushbacks, '[]'::jsonb)) x where public.script_has_check_mark(x)) then
    return 'the script still has "Check this" marks: check each one and remove it before publishing';
  end if;
  for s in select x from jsonb_array_elements(p_steps) x loop
    if jsonb_typeof(s) <> 'object' then return 'a step is not a step'; end if;
    -- An ending is a step with no options.
    if coalesce(jsonb_typeof(s -> 'opts'), 'null') = 'null'
       or (jsonb_typeof(s -> 'opts') = 'array' and jsonb_array_length(s -> 'opts') = 0) then
      res := s ->> 'result';
      name := coalesce(nullif(s ->> 'title', ''), s ->> 'id', '?');
      if res is null or res = '' then
        return 'the ending "' || name || '" is not linked to a result';
      end if;
      if not exists (select 1 from public.call_type_results_for(p_call_type, p_institute) r where r.key = res) then
        return 'the ending "' || name || '" is linked to "' || res || '", which is not a result of this call type';
      end if;
    end if;
  end loop;
  return null;
end $$;

-- ---------- saving ----------

-- Internal (granted to nobody): saves a version. Shared by admin_save_script and the older
-- admin_save_script_version. p_call_type null keeps the script's type; p_pushbacks null copies the latest
-- version's. p_require_type: publishing needs a call type (false only for the older function, so calls
-- written before 0022 keep working).
create or replace function public.script_save(
  p_script uuid, p_name text, p_call_type uuid, p_steps jsonb, p_pushbacks jsonb, p_change_note text,
  p_publish boolean, p_require_type boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat    public.seats;
  inst    uuid;
  sid     uuid := p_script;
  nm      text := trim(coalesce(p_name, ''));
  note    text := coalesce(p_change_note, '');
  pub     boolean := coalesce(p_publish, false);
  typ     uuid;
  pbs     jsonb := p_pushbacks;
  problem text;
  next_v  int;
  vid     uuid;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin can save scripts' using errcode = '42501';
  end if;

  if p_script is null then
    inst := seat.institute_id;
  else
    select s.institute_id, s.call_type_id into inst, typ from public.scripts s where s.id = p_script;
    if inst is null then raise exception 'script not found' using errcode = '22023'; end if;
    if not public.is_admin_of(inst) then
      raise exception 'only an admin of this institute can save scripts' using errcode = '42501';
    end if;
  end if;
  if not public.has_feature(inst, 'scripts') then
    raise exception 'add Scripts to your plan to save scripts' using errcode = '42501';
  end if;
  typ := coalesce(p_call_type, typ);

  if length(nm) not between 1 and 120 then
    raise exception 'name must be 1 to 120 characters' using errcode = '22023';
  end if;
  if length(note) > 500 then
    raise exception 'change note must be 500 characters or less' using errcode = '22023';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'steps must be a list' using errcode = '22023';
  end if;
  if pbs is null and sid is not null then
    select v.pushbacks into pbs from public.script_versions v where v.script_id = sid order by v.version desc limit 1;
  end if;
  pbs := coalesce(pbs, '[]'::jsonb);
  problem := public.script_pushbacks_problem(pbs);
  if problem is not null then raise exception '%', problem using errcode = '22023'; end if;

  if pub then
    if typ is null and not coalesce(p_require_type, true) then
      -- The older function: publishing an untyped script is allowed, but marks still block it.
      if exists (select 1 from jsonb_array_elements(p_steps) x where public.script_has_check_mark(x))
         or exists (select 1 from jsonb_array_elements(pbs) x where public.script_has_check_mark(x)) then
        problem := 'the script still has "Check this" marks: check each one and remove it before publishing';
      end if;
    else
      problem := public.script_publish_problem(p_steps, pbs, typ, inst);
    end if;
    if problem is not null then raise exception '%', problem using errcode = '22023'; end if;
  end if;

  if p_script is null then
    insert into public.scripts (institute_id, name, created_by, call_type_id) values (inst, nm, seat.id, typ)
      returning id into sid;
  else
    perform 1 from public.scripts s where s.id = sid for update;
    update public.scripts s set name = nm, call_type_id = typ where s.id = sid;
  end if;

  select coalesce(max(v.version), 0) + 1 into next_v from public.script_versions v where v.script_id = sid;

  if pub then
    update public.script_versions v set published = false where v.script_id = sid and v.published;
  end if;

  insert into public.script_versions (script_id, institute_id, version, steps, pushbacks, change_note, published, created_by)
    values (sid, inst, next_v, p_steps, pbs, note, pub, seat.id)
    returning id into vid;

  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), case when pub then 'script.published' else 'script.draft_saved' end, vid::text);
  return jsonb_build_object('script_id', sid, 'version_id', vid, 'version', next_v);
end $$;

-- Save a version of a script with its call type and pushback answers. Admin only, Scripts add-on needed.
-- p_script null creates the script in the admin's institute. p_call_type null keeps the script's type;
-- p_pushbacks null keeps the latest version's. Publishing needs a call type, no "Check this" mark and every
-- ending linked to a result of the type, and unpublishes the script's previous published version.
-- Returns {script_id, version_id, version}.
create or replace function public.admin_save_script(
  p_script uuid, p_name text, p_call_type uuid, p_steps jsonb, p_pushbacks jsonb, p_change_note text,
  p_publish boolean)
returns jsonb
language sql security definer set search_path = public
as $$
  select public.script_save(p_script, p_name, p_call_type, p_steps, p_pushbacks, p_change_note, p_publish, true);
$$;

-- The 0007 function, kept for older pages: same checks (Scripts add-on, "Check this" marks), keeps the type
-- and pushbacks, and may still publish a script without a type.
create or replace function public.admin_save_script_version(
  p_script uuid, p_name text, p_steps jsonb, p_change_note text, p_publish boolean)
returns uuid
language sql security definer set search_path = public
as $$
  select (public.script_save(p_script, p_name, null, p_steps, null, p_change_note, p_publish, false) ->> 'version_id')::uuid;
$$;

-- ---------- the Scripts tab list ----------

-- Every script of the admin's institute, for the Scripts tab: type, live version, latest version and when it
-- changed, campaigns that use it, and calls in the last 90 days (original calls only) with how many got a good
-- result (a result that counts as good for the campaign's type, or the old outcome "won" for calls without a
-- result). check_marks: "Check this" marks on the latest version. No money.
create or replace function public.admin_list_scripts()
returns table (id uuid, name text, call_type_id uuid, call_type_key text, call_type_label text,
               live_version int, live_version_id uuid, latest_version int, changed_at timestamptz,
               used_in jsonb, calls bigint, good_calls bigint, check_marks int)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin can list scripts' using errcode = '42501';
  end if;
  return query
    select s.id, s.name, s.call_type_id, t.key, t.label,
           pv.version, pv.id, lv.version, coalesce(lv.created_at, s.created_at),
           (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status)
                     order by c.status = 'closed', c.name), '[]'::jsonb)
              from public.campaigns c where c.script_id = s.id),
           coalesce(k.calls, 0), coalesce(k.good, 0),
           coalesce((select count(*)::int from jsonb_array_elements(lv.steps) x where public.script_has_check_mark(x))
                  + (select count(*)::int from jsonb_array_elements(lv.pushbacks) x where public.script_has_check_mark(x)), 0)
    from public.scripts s
    left join public.call_types t on t.id = s.call_type_id
    left join lateral (select v.id, v.version from public.script_versions v
                       where v.script_id = s.id and v.published limit 1) pv on true
    left join lateral (select v.version, v.created_at, v.steps, v.pushbacks from public.script_versions v
                       where v.script_id = s.id order by v.version desc limit 1) lv on true
    left join lateral (
      select count(*) as calls,
             count(*) filter (where
               (o.result_key is null and o.outcome = 'won')
               or exists (select 1 from public.campaigns c
                          cross join lateral public.call_type_results_for(c.call_type_id, c.institute_id) r
                          where c.id = o.campaign_id and r.key = o.result_key and r.counts_as_good)) as good
      from public.call_outcomes o
      where o.institute_id = s.institute_id and o.corrects_id is null and o.script_id = s.id::text
        and coalesce(o.dialled_at, o.uploaded_at) >= now() - interval '90 days') k on true
    where s.institute_id = seat.institute_id
    order by s.name, s.id;
end $$;

-- ---------- AI script maker: request log and monthly limit ----------

-- One row per request to the ai-script-draft Edge Function (a draft, a "Try again" or a "Make simpler").
-- Tokens and cost add up every model call the request made (a draft may retry). ok is null while the request
-- runs, true when it returned a draft, false when it failed. Written by the Edge Function with the service
-- role only; admins of the institute read it.
create table public.ai_requests (
  id                  bigint generated always as identity primary key,
  institute_id        uuid not null references public.institutes (id) on delete cascade,
  seat_id             uuid references public.seats (id) on delete set null,
  kind                text not null check (kind in ('draft', 'simplify')),
  model               text check (model is null or length(model) <= 80),
  attempts            smallint not null default 0 check (attempts between 0 and 10),
  input_tokens        int not null default 0 check (input_tokens >= 0),
  output_tokens       int not null default 0 check (output_tokens >= 0),
  cache_read_tokens   int not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens  int not null default 0 check (cache_write_tokens >= 0),
  cost_usd            numeric(10, 6) not null default 0 check (cost_usd >= 0),
  ok                  boolean,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz
);

create index ai_requests_institute_month on public.ai_requests (institute_id, kind, created_at);

alter table public.ai_requests enable row level security;
create policy ai_requests_admin_read on public.ai_requests
  for select using (public.is_admin_of(institute_id));

revoke all on public.ai_requests from public, anon, authenticated;
grant select on public.ai_requests to authenticated;
grant select, insert, update on public.ai_requests to service_role;

-- Requests allowed per institute per calendar month (India time). Drafts: 20 (decision 2). "Make simpler"
-- has its own, larger limit so it cannot be used for unlimited drafts.
create or replace function public.ai_monthly_limit(p_kind text)
returns int
language sql immutable
as $$
  select case p_kind when 'draft' then 20 when 'simplify' then 100 else 0 end
$$;

-- The first day of this month in India time, and the instant it starts.
create or replace function public.ai_month_start()
returns date
language sql stable
as $$
  select date_trunc('month', now() at time zone 'Asia/Kolkata')::date
$$;

-- Internal: requests of a kind that count against the limit this month: done (ok) or still running (ok null,
-- started in the last 10 minutes, so a crashed request stops counting).
create or replace function public.ai_used_this_month(p_institute uuid, p_kind text)
returns int
language sql stable security definer set search_path = public
as $$
  select count(*)::int from public.ai_requests r
  where r.institute_id = p_institute and r.kind = p_kind
    and r.created_at >= (public.ai_month_start()::timestamp at time zone 'Asia/Kolkata')
    and (r.ok or (r.ok is null and r.created_at > now() - interval '10 minutes'))
$$;

-- Service role only (the Edge Function, after it checked the admin seat and the ai_drafts add-on with the
-- admin's own token): reserves one request, or raises "limit reached" (errcode 54000). Returns the row id.
create or replace function public.ai_reserve_request(p_institute uuid, p_seat uuid, p_kind text)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  rid bigint;
begin
  if p_kind not in ('draft', 'simplify') then
    raise exception 'unknown request kind' using errcode = '22023';
  end if;
  if not exists (select 1 from public.seats s where s.id = p_seat and s.institute_id = p_institute) then
    raise exception 'seat not found in this institute' using errcode = '22023';
  end if;
  -- One reservation at a time per institute, so two requests cannot both take the last one.
  perform pg_advisory_xact_lock(hashtext('ai_requests:' || p_institute::text));
  if public.ai_used_this_month(p_institute, p_kind) >= public.ai_monthly_limit(p_kind) then
    raise exception 'limit reached: % AI % requests this month', public.ai_monthly_limit(p_kind), p_kind
      using errcode = '54000';
  end if;
  insert into public.ai_requests (institute_id, seat_id, kind) values (p_institute, p_seat, p_kind)
    returning id into rid;
  return rid;
end $$;

-- Service role only: records what a reserved request used and whether it worked. A finished row is not changed.
create or replace function public.ai_finish_request(
  p_id bigint, p_model text, p_attempts int, p_input int, p_output int, p_cache_read int, p_cache_write int,
  p_cost numeric, p_ok boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.ai_requests r
     set model = left(p_model, 80), attempts = greatest(0, least(coalesce(p_attempts, 0), 10)),
         input_tokens = greatest(0, coalesce(p_input, 0)), output_tokens = greatest(0, coalesce(p_output, 0)),
         cache_read_tokens = greatest(0, coalesce(p_cache_read, 0)),
         cache_write_tokens = greatest(0, coalesce(p_cache_write, 0)),
         cost_usd = greatest(0, coalesce(p_cost, 0)), ok = coalesce(p_ok, false), finished_at = now()
   where r.id = p_id and r.ok is null;
end $$;

-- AI drafts this month for the signed-in admin's institute, for Settings and the Scripts tab:
-- drafts used (including "Try again"), the monthly limit, the month (its first day) and the month's cost in
-- US dollars of every AI request (drafts and "Make simpler").
create or replace function public.admin_ai_usage()
returns table (used int, monthly_limit int, month date, cost_usd numeric)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  seat public.seats;
begin
  seat := public.my_active_seat();
  if seat.id is null or seat.role <> 'admin' then
    raise exception 'only an admin can see AI usage' using errcode = '42501';
  end if;
  return query
    select public.ai_used_this_month(seat.institute_id, 'draft'),
           public.ai_monthly_limit('draft'),
           public.ai_month_start(),
           coalesce((select round(sum(r.cost_usd), 4) from public.ai_requests r
                     where r.institute_id = seat.institute_id
                       and r.created_at >= (public.ai_month_start()::timestamp at time zone 'Asia/Kolkata')), 0)::numeric;
end $$;

-- ---------- grants ----------

revoke all on function public.scripts_check_type() from public, anon, authenticated;
revoke all on function public.campaigns_check_script() from public, anon, authenticated;
revoke all on function public.script_pushbacks_problem(jsonb) from public, anon, authenticated;
revoke all on function public.script_has_check_mark(jsonb) from public, anon;
grant execute on function public.script_has_check_mark(jsonb) to authenticated;
revoke all on function public.script_publish_problem(jsonb, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.script_save(uuid, text, uuid, jsonb, jsonb, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.admin_save_script(uuid, text, uuid, jsonb, jsonb, text, boolean) from public, anon;
grant execute on function public.admin_save_script(uuid, text, uuid, jsonb, jsonb, text, boolean) to authenticated;
revoke all on function public.admin_save_script_version(uuid, text, jsonb, text, boolean) from public, anon;
grant execute on function public.admin_save_script_version(uuid, text, jsonb, text, boolean) to authenticated;
revoke all on function public.admin_list_scripts() from public, anon;
grant execute on function public.admin_list_scripts() to authenticated;

revoke all on function public.ai_monthly_limit(text) from public, anon;
grant execute on function public.ai_monthly_limit(text) to authenticated, service_role;
revoke all on function public.ai_month_start() from public, anon;
grant execute on function public.ai_month_start() to authenticated, service_role;
revoke all on function public.ai_used_this_month(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_reserve_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_reserve_request(uuid, uuid, text) to service_role;
revoke all on function public.ai_finish_request(bigint, text, int, int, int, int, int, numeric, boolean) from public, anon, authenticated;
grant execute on function public.ai_finish_request(bigint, text, int, int, int, int, int, numeric, boolean) to service_role;
revoke all on function public.admin_ai_usage() from public, anon;
grant execute on function public.admin_ai_usage() to authenticated;
