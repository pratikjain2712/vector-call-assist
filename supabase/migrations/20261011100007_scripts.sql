-- Vector 2.0: call scripts with numbered versions, publishing, and a per-version report.
-- Apply after 20261011100005_admin_guard.sql. (No 20261011100006 file is in the repo.)
-- A script has numbered versions. A version is a draft until it is published, and only one version
-- of a script is published at a time. Reps read published versions only. Admins write through
-- admin_save_script_version, which numbers the version, unpublishes the previous one and writes the
-- audit row. A published version cannot be changed or deleted, so the script a rep used is kept.
-- Reports read call_outcomes by script_id (the script's id as text) and script_version (the version
-- number). The rep page must send both, or its calls will not appear in the report.
-- Each report checks is_admin_of() itself, as in 0004_admin_views.sql.

-- ---------- tables ----------

create table public.scripts (
  id            uuid primary key default gen_random_uuid(),
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  name          text not null check (length(name) between 1 and 120),
  created_by    uuid references public.seats (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (id, institute_id)
);

-- steps is a list of step objects: { id, title, start, say: [lines], tip, opts: [{ label, to }] }.
-- The editor checks the content (web/js/script-model.js); the database checks the shape and size.
create table public.script_versions (
  id            uuid primary key default gen_random_uuid(),
  script_id     uuid not null,
  institute_id  uuid not null references public.institutes (id) on delete cascade,
  version       int not null check (version >= 1),
  steps         jsonb not null check (jsonb_typeof(steps) = 'array' and length(steps::text) <= 200000),
  change_note   text not null default '' check (length(change_note) between 0 and 500),
  published     boolean not null default false,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.seats (id) on delete set null,
  unique (script_id, version),
  foreign key (script_id, institute_id) references public.scripts (id, institute_id) on delete cascade
);

-- At most one published version per script.
create unique index script_versions_one_published
  on public.script_versions (script_id) where published;

-- ---------- row-level security ----------

alter table public.scripts         enable row level security;
alter table public.script_versions enable row level security;

-- Admins of the institute read and write (the RPCs below are the normal path for writes).
create policy scripts_admin_all on public.scripts
  for all using (public.is_admin_of(institute_id)) with check (public.is_admin_of(institute_id));

-- A rep sees a script only when it has a published version.
create policy scripts_rep_read on public.scripts
  for select using (
    exists (select 1 from public.script_versions v where v.script_id = scripts.id and v.published)
  );

create policy versions_admin_all on public.script_versions
  for all using (public.is_admin_of(institute_id)) with check (public.is_admin_of(institute_id));

-- An active rep of the institute reads published versions only. Drafts never reach a rep.
create policy versions_rep_read_published on public.script_versions
  for select using (
    published and exists (
      select 1 from public.seats s
      where s.institute_id = script_versions.institute_id
        and s.user_id = auth.uid()
        and s.status = 'active'
    )
  );

-- A published version is history: its content cannot change and it cannot be deleted.
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
      or new.steps is distinct from old.steps or new.change_note <> old.change_note) then
    raise exception 'a published script version cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger script_versions_guard
  before update or delete on public.script_versions
  for each row execute function public.script_versions_guard();

revoke all on public.scripts, public.script_versions from anon;
grant select, insert, update, delete on public.scripts, public.script_versions to authenticated;

-- ---------- writes ----------

-- Save a version of a script. p_script null creates the script in the caller's institute.
-- Returns the new version's id. Publishing unpublishes the script's previous published version.
create or replace function public.admin_save_script_version(
  p_script uuid, p_name text, p_steps jsonb, p_change_note text, p_publish boolean)
returns uuid
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
    select s.institute_id into inst from public.scripts s where s.id = p_script;
    if inst is null then raise exception 'script not found' using errcode = '22023'; end if;
    if not public.is_admin_of(inst) then
      raise exception 'only an admin of this institute can save scripts' using errcode = '42501';
    end if;
  end if;

  if length(nm) not between 1 and 120 then
    raise exception 'name must be 1 to 120 characters' using errcode = '22023';
  end if;
  if length(note) > 500 then
    raise exception 'change note must be 500 characters or less' using errcode = '22023';
  end if;
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then
    raise exception 'steps must be a list' using errcode = '22023';
  end if;

  if p_script is null then
    insert into public.scripts (institute_id, name, created_by) values (inst, nm, seat.id)
      returning id into sid;
  else
    perform 1 from public.scripts s where s.id = sid for update;
    update public.scripts s set name = nm where s.id = sid;
  end if;

  select coalesce(max(v.version), 0) + 1 into next_v from public.script_versions v where v.script_id = sid;

  if pub then
    update public.script_versions v set published = false where v.script_id = sid and v.published;
  end if;

  insert into public.script_versions (script_id, institute_id, version, steps, change_note, published, created_by)
    values (sid, inst, next_v, p_steps, note, pub, seat.id)
    returning id into vid;

  insert into public.audit_log (institute_id, actor_id, action, target)
    values (inst, auth.uid(), case when pub then 'script.published' else 'script.draft_saved' end, vid::text);
  return vid;
end $$;

-- ---------- reports ----------

-- Internal (granted to nobody): one row per original call for one script version in the range,
-- with its latest correction's outcome. Corrections are never counted as calls of their own.
create or replace function public.admin_script_calls(
  p_institute uuid, p_script text, p_version int, p_from timestamptz, p_to timestamptz)
returns table (call_id uuid, script_step text, objection text, outcome text)
language sql stable security definer set search_path = public
as $$
  select r.id, r.script_step, r.objection, e.outcome
  from public.call_outcomes r
  join public.admin_effective_outcomes(p_institute, p_from, p_to) e on e.root_id = r.id
  where r.institute_id = p_institute
    and r.corrects_id is null
    and r.script_id = p_script
    and r.script_version = p_version;
$$;

-- Report for one script version. Admin only; raises for anyone else.
-- steps: calls by the final script_step, with share of all calls (the drop-off at that step).
--   The rep page logs only the end card reached, so this is where calls ended, not a funnel.
-- objections: calls that raised each objection (the last one raised, as the rep page stores it).
-- outcomes: calls by effective outcome (a correction changes the outcome it corrects).
create or replace function public.admin_script_report(
  p_institute uuid, p_script_version_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v       public.script_versions;
  sname   text;
  total   bigint;
  steps_j jsonb;
  objs_j  jsonb;
  outs_j  jsonb;
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_range(p_from, p_to);

  select * into v from public.script_versions where id = p_script_version_id and institute_id = p_institute;
  if v.id is null then raise exception 'script version not found in this institute' using errcode = '22023'; end if;
  select s.name into sname from public.scripts s where s.id = v.script_id;

  select count(*) into total
    from public.admin_script_calls(p_institute, v.script_id::text, v.version, p_from, p_to);

  select coalesce(jsonb_agg(jsonb_build_object(
           'step', x.step, 'calls', x.n, 'share', round(x.n::numeric / nullif(total, 0), 4))
           order by x.n desc, x.step), '[]'::jsonb)
    into steps_j
    from (select c.script_step as step, count(*) as n
          from public.admin_script_calls(p_institute, v.script_id::text, v.version, p_from, p_to) c
          group by c.script_step) x;

  select coalesce(jsonb_agg(jsonb_build_object('objection', x.objection, 'calls', x.n)
           order by x.n desc, x.objection), '[]'::jsonb)
    into objs_j
    from (select c.objection, count(*) as n
          from public.admin_script_calls(p_institute, v.script_id::text, v.version, p_from, p_to) c
          where c.objection is not null
          group by c.objection) x;

  select coalesce(jsonb_agg(jsonb_build_object('outcome', x.outcome, 'calls', x.n)
           order by x.n desc, x.outcome), '[]'::jsonb)
    into outs_j
    from (select c.outcome, count(*) as n
          from public.admin_script_calls(p_institute, v.script_id::text, v.version, p_from, p_to) c
          group by c.outcome) x;

  return jsonb_build_object(
    'script_id', v.script_id, 'script_name', sname, 'version', v.version, 'published', v.published,
    'from', p_from, 'to', p_to, 'total_calls', total,
    'steps', steps_j, 'objections', objs_j, 'outcomes', outs_j);
end $$;

-- ---------- grants: signed-in users only ----------

revoke all on function public.admin_script_calls(uuid, text, int, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_save_script_version(uuid, text, jsonb, text, boolean) from public, anon;
revoke all on function public.admin_script_report(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_save_script_version(uuid, text, jsonb, text, boolean) to authenticated;
grant execute on function public.admin_script_report(uuid, uuid, timestamptz, timestamptz) to authenticated;
