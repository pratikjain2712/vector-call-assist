-- Trial sign-up tests for 0009_trial_signup.sql. Run after 0001-0009 on a scratch Postgres with the stub
-- auth layer used by the other tests. Each check prints "ok"; a failed check raises an error.

reset role;
insert into auth.users values ('aaaaaaa9-0000-0000-0000-000000000001'), ('aaaaaaa9-0000-0000-0000-000000000002')
  on conflict do nothing;

do $$
declare
  t1   uuid := 'aaaaaaa9-0000-0000-0000-000000000001';
  t2   uuid := 'aaaaaaa9-0000-0000-0000-000000000002';
  st   jsonb;
  inst uuid;
begin
  -- Before a trial, the login holds no seat.
  perform set_config('request.jwt.claim.sub', t2::text, true);
  set local role authenticated;
  st := public.my_trial_status();
  if st is not null then raise exception 'FAIL: login without a seat has a status'; end if;
  raise notice 'ok: no seat, no status';

  -- A name that is too short is refused.
  begin
    perform public.start_trial_institute(' a ');
    raise exception 'FAIL: one-letter name accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    raise notice 'ok: short name refused';
  end;

  -- The first login starts a trial: admin seat, 5 seats, about 5 days (migration 0011).
  perform set_config('request.jwt.claim.sub', t1::text, true);
  inst := public.start_trial_institute('Bright Coaching');
  st := public.my_trial_status();
  if st is null or st->>'role' <> 'admin' or (st->>'seat_limit')::int <> 5 then
    raise exception 'FAIL: trial admin context wrong: %', st;
  end if;
  if (st->>'trial_ends_at')::timestamptz < now() + interval '4 days'
     or (st->>'trial_ends_at')::timestamptz > now() + interval '6 days' then
    raise exception 'FAIL: trial length is not 5 days';
  end if;
  if (st->>'institute_id')::uuid <> inst then raise exception 'FAIL: status points at another institute'; end if;
  raise notice 'ok: trial started with an admin seat, 5 seats, 5 days';

  -- The same login cannot start a second trial.
  begin
    perform public.start_trial_institute('Second Trial');
    raise exception 'FAIL: second trial allowed';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    raise notice 'ok: second trial refused';
  end;

  -- The trial institute is visible to its admin only (row-level security still applies).
  if (select count(*) from public.institutes where id = inst) <> 1 then
    raise exception 'FAIL: admin cannot read own institute';
  end if;
  reset role;
  -- The other login cannot read it.
  perform set_config('request.jwt.claim.sub', t2::text, true);
  set local role authenticated;
  if (select count(*) from public.institutes where id = inst) <> 0 then
    raise exception 'FAIL: another login can read the trial institute';
  end if;
  raise notice 'ok: other logins cannot read the trial institute';
  reset role;
end $$;

select 'trial_signup_test: done' as result;
