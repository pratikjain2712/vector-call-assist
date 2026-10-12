-- Why calls are lost, and where: a loss reason the rep picks on a lost call, and the stage reached.
-- Admin Insights reads these with the script report. Suggestions are rule-based; the admin approves or
-- rejects each one, and the decision is kept with the script version it was made on.

alter table public.call_outcomes
  add column if not exists loss_reason text check (loss_reason in (
    'price', 'timing', 'already_enrolled', 'no_need', 'wrong_person', 'other')),
  add column if not exists stage_reached text check (length(stage_reached) <= 40);

-- Only the functions below read or write this table. RLS is on with no policies.
create table if not exists public.script_suggestion_decisions (
  id           uuid primary key default gen_random_uuid(),
  institute_id uuid not null references public.institutes (id) on delete cascade,
  script_id    text not null check (length(script_id) <= 80),
  version      int not null check (version >= 1),
  target_key   text not null check (length(target_key) between 1 and 200),
  decision     text not null check (decision in ('approved', 'rejected')),
  decided_by   uuid not null default auth.uid(),
  decided_at   timestamptz not null default now(),
  note         text check (length(note) <= 300),
  unique (institute_id, script_id, version, target_key)
);
alter table public.script_suggestion_decisions enable row level security;

-- Internal: one row per original call for one script version, with the stage and loss reason from
-- that row and the effective outcome. A lost call is outcome 'not_interested'.
create or replace function public.admin_script_calls_detail(
  p_institute uuid, p_script text, p_version int, p_from timestamptz, p_to timestamptz)
returns table (call_id uuid, stage_reached text, objection text, outcome text, loss_reason text)
language sql stable security definer set search_path = public
as $$
  select r.id, r.stage_reached, r.objection, e.outcome, r.loss_reason
  from public.call_outcomes r
  join public.admin_effective_outcomes(p_institute, p_from, p_to) e on e.root_id = r.id
  where r.institute_id = p_institute
    and r.corrects_id is null
    and r.script_id = p_script
    and r.script_version = p_version;
$$;

-- Insights for one script version, compared with the version before it.
-- Suggestions need at least 10 calls, and each rule needs a minimum number of lost calls.
create or replace function public.admin_loss_insights(
  p_institute uuid, p_script_version_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  v        public.script_versions;
  pv       public.script_versions;
  cur_n    bigint := 0;
  cur_lost bigint := 0;
  prv_n    bigint := 0;
  prv_lost bigint := 0;
  lost_n   bigint := 0;
  reasons  jsonb;
  stages   jsonb;
  objs     jsonb;
  sugg     jsonb := '[]'::jsonb;
  rec      record;
  k        text;
  dec      record;
  item     jsonb;
  share    numeric;
  i        int;
begin
  perform public.admin_require(p_institute);
  perform public.admin_check_range(p_from, p_to);

  select * into v from public.script_versions where id = p_script_version_id and institute_id = p_institute;
  if v.id is null then raise exception 'script version not found in this institute' using errcode = '22023'; end if;
  select * into pv from public.script_versions
    where institute_id = p_institute and script_id = v.script_id and version = v.version - 1;

  select count(*), count(*) filter (where d.outcome = 'not_interested') into cur_n, cur_lost
    from public.admin_script_calls_detail(p_institute, v.script_id::text, v.version, p_from, p_to) d;
  if pv.id is not null then
    select count(*), count(*) filter (where d.outcome = 'not_interested') into prv_n, prv_lost
      from public.admin_script_calls_detail(p_institute, pv.script_id::text, pv.version, p_from, p_to) d;
  end if;
  lost_n := cur_lost;

  select coalesce(jsonb_agg(jsonb_build_object('reason', x.reason, 'calls', x.n)
           order by x.n desc, x.reason), '[]'::jsonb) into reasons
    from (select coalesce(d.loss_reason, 'not_recorded') as reason, count(*) as n
          from public.admin_script_calls_detail(p_institute, v.script_id::text, v.version, p_from, p_to) d
          where d.outcome = 'not_interested'
          group by 1) x;

  select coalesce(jsonb_agg(jsonb_build_object('stage', x.stage, 'calls', x.n)
           order by x.n desc, x.stage), '[]'::jsonb) into stages
    from (select coalesce(d.stage_reached, 'not_recorded') as stage, count(*) as n
          from public.admin_script_calls_detail(p_institute, v.script_id::text, v.version, p_from, p_to) d
          where d.outcome = 'not_interested'
          group by 1) x;

  select coalesce(jsonb_agg(jsonb_build_object('objection', x.objection, 'calls', x.n)
           order by x.n desc, x.objection), '[]'::jsonb) into objs
    from (select d.objection, count(*) as n
          from public.admin_script_calls_detail(p_institute, v.script_id::text, v.version, p_from, p_to) d
          where d.outcome = 'not_interested' and d.objection is not null
          group by d.objection) x;

  if cur_n >= 10 then
    -- Stage: the stage where most lost calls ended.
    for rec in select * from jsonb_to_recordset(stages) as s(stage text, calls bigint) loop
      share := rec.calls::numeric / nullif(lost_n, 0);
      if rec.stage <> 'not_recorded' and lost_n >= 5 and share >= 0.3 then
        k := 'stage:' || rec.stage;
        sugg := sugg || jsonb_build_object('key', k, 'kind', 'stage', 'text',
          'Most lost calls end in the ' || rec.stage || ' stage (' || round(share * 100) ||
          '% of lost calls). Review the lines in that stage first.');
      end if;
    end loop;

    -- Objections: one that keeps coming up in lost calls.
    for rec in select * from jsonb_to_recordset(objs) as s(objection text, calls bigint) loop
      share := rec.calls::numeric / nullif(lost_n, 0);
      if rec.calls >= 3 and share >= 0.2 then
        k := 'objection:' || rec.objection;
        sugg := sugg || jsonb_build_object('key', k, 'kind', 'objection', 'text',
          '"' || rec.objection || '" comes up in ' || rec.calls || ' lost calls. Give the rep a clear answer for it in the script.');
      end if;
    end loop;

    -- Reasons: price as the top recorded reason.
    for rec in select * from jsonb_to_recordset(reasons) as s(reason text, calls bigint) loop
      share := rec.calls::numeric / nullif(lost_n, 0);
      if rec.reason = 'price' and lost_n >= 5 and share >= 0.4 then
        k := 'reason:price';
        sugg := sugg || jsonb_build_object('key', k, 'kind', 'reason', 'text',
          'Price is the top recorded reason for lost calls (' || round(share * 100) ||
          '%). Try showing the fee and payment options earlier in the call.');
      end if;
    end loop;

    -- Version: lost calls rose compared with the version before.
    if pv.id is not null and prv_n >= 10 and
       (cur_lost::numeric / cur_n) - (prv_lost::numeric / prv_n) >= 0.05 then
      k := 'version:' || v.version;
      sugg := sugg || jsonb_build_object('key', k, 'kind', 'version', 'text',
        'Lost calls rose from ' || round(prv_lost * 100.0 / prv_n) || '% in v' || pv.version ||
        ' to ' || round(cur_lost * 100.0 / cur_n) || '% in v' || v.version ||
        '. Look at what changed in the last version.');
    end if;
  end if;

  -- Attach the admin's decision to each suggestion.
  for i in 0 .. jsonb_array_length(sugg) - 1 loop
    item := sugg -> i;
    select d.decision, d.decided_at into dec from public.script_suggestion_decisions d
      where d.institute_id = p_institute and d.script_id = v.script_id::text
        and d.version = v.version and d.target_key = item ->> 'key';
    sugg := jsonb_set(sugg, array[i::text], item || jsonb_build_object(
      'decision', dec.decision, 'decided_at', dec.decided_at));
  end loop;

  return jsonb_build_object(
    'script_id', v.script_id, 'version', v.version, 'previous_version', pv.version,
    'calls', cur_n, 'lost', cur_lost,
    'lost_rate', case when cur_n > 0 then round(cur_lost::numeric / cur_n, 4) end,
    'previous_calls', prv_n, 'previous_lost', prv_lost,
    'previous_lost_rate', case when prv_n > 0 then round(prv_lost::numeric / prv_n, 4) end,
    'enough_calls', cur_n >= 10,
    'reasons', reasons, 'stages', stages, 'objections', objs, 'suggestions', sugg);
end $$;

-- The admin approves or rejects a suggestion. The change to the script is made in the script editor.
drop function if exists public.admin_decide_suggestion(uuid, uuid, text, text);
create or replace function public.admin_decide_suggestion(
  p_institute uuid, p_script_version_id uuid, p_target_key text, p_decision text, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare v public.script_versions;
begin
  perform public.admin_require(p_institute);
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;
  select * into v from public.script_versions where id = p_script_version_id and institute_id = p_institute;
  if v.id is null then raise exception 'script version not found in this institute' using errcode = '22023'; end if;
  insert into public.script_suggestion_decisions (institute_id, script_id, version, target_key, decision, decided_by, decided_at, note)
  values (p_institute, v.script_id::text, v.version, left(p_target_key, 200), p_decision, auth.uid(), now(), left(p_note, 300))
  on conflict (institute_id, script_id, version, target_key)
  do update set decision = excluded.decision, decided_by = excluded.decided_by,
                decided_at = excluded.decided_at, note = excluded.note;
end $$;

-- Rep view: the signed-in rep's own calls for the range, and the changes the team approved recently.
-- Reps never see other seats' calls here.
create or replace function public.rep_loss_summary(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  inst    uuid;
  seat    uuid;
  total   bigint;
  lost    bigint;
  reasons jsonb;
  stages  jsonb;
  changes jsonb;
begin
  select s.institute_id, s.id into inst, seat from public.seats s
    where s.user_id = auth.uid() and s.status = 'active' limit 1;
  if seat is null then raise exception 'no active seat for this login' using errcode = '42501'; end if;
  perform public.admin_check_range(p_from, p_to);

  select count(*), count(*) filter (where e.outcome = 'not_interested') into total, lost
    from public.admin_effective_outcomes(inst, p_from, p_to) e
    join public.call_outcomes r on r.id = e.root_id
    where r.seat_id = seat and r.corrects_id is null;

  select coalesce(jsonb_agg(jsonb_build_object('reason', x.reason, 'calls', x.n)
           order by x.n desc, x.reason), '[]'::jsonb) into reasons
    from (select coalesce(r.loss_reason, 'not_recorded') as reason, count(*) as n
          from public.admin_effective_outcomes(inst, p_from, p_to) e
          join public.call_outcomes r on r.id = e.root_id
          where r.seat_id = seat and r.corrects_id is null and e.outcome = 'not_interested'
          group by 1) x;

  select coalesce(jsonb_agg(jsonb_build_object('stage', x.stage, 'calls', x.n)
           order by x.n desc, x.stage), '[]'::jsonb) into stages
    from (select coalesce(r.stage_reached, 'not_recorded') as stage, count(*) as n
          from public.admin_effective_outcomes(inst, p_from, p_to) e
          join public.call_outcomes r on r.id = e.root_id
          where r.seat_id = seat and r.corrects_id is null and e.outcome = 'not_interested'
          group by 1) x;

  -- Approved changes for the latest version of each script.
  select coalesce(jsonb_agg(jsonb_build_object('note', x.note, 'decided_at', x.decided_at)
           order by x.decided_at desc), '[]'::jsonb) into changes
    from (select d.note, d.decided_at
          from public.script_suggestion_decisions d
          where d.institute_id = inst and d.decision = 'approved' and d.note is not null
            and d.version = (select max(sv.version) from public.script_versions sv
                             where sv.script_id::text = d.script_id and sv.institute_id = inst)
          order by d.decided_at desc limit 5) x;

  return jsonb_build_object('calls', total, 'lost', lost,
    'reasons', reasons, 'stages', stages, 'approved_changes', changes);
end $$;

-- ---------- grants: signed-in admins only ----------
revoke all on function public.admin_script_calls_detail(uuid, text, int, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_loss_insights(uuid, uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_decide_suggestion(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.rep_loss_summary(timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_loss_insights(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_decide_suggestion(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.rep_loss_summary(timestamptz, timestamptz) to authenticated;
