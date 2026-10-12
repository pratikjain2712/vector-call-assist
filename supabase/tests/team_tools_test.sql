-- Team tools tests for 20261011100006_team_tools.sql. Run after 0001 to 0006 on a fresh scratch database
-- with the same stub auth layer as access_test.sql. Every expected number is hand-counted in the
-- fixture comments below. The last line prints passed and failed counts: expect failed = 0.
\set ON_ERROR_STOP 0
create or replace function pg_temp.as_user(u uuid, mail text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(u::text,''), false),
         set_config('request.jwt.claims', json_build_object('sub', coalesce(u::text,''), 'email', mail)::text, false);
  select 1;
$$;
create temp table results (test text, passed boolean, detail text);
grant all on results to authenticated, anon;
create or replace function pg_temp.ok(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, true, '');
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.fails(name text, sql text) returns void language plpgsql as $$
begin execute sql; insert into results values (name, false, 'expected denial, succeeded');
exception when others then insert into results values (name, true, sqlerrm); end $$;
create or replace function pg_temp.rows_is(name text, sql text, want int) returns void language plpgsql as $$
declare n int; begin execute sql into n; insert into results values (name, n = want, 'got '||n||', want '||want);
exception when others then insert into results values (name, false, sqlerrm); end $$;
create or replace function pg_temp.val_is(name text, sql text, want text) returns void language plpgsql as $$
declare v text; begin execute sql into v;
  insert into results values (name, v is not distinct from want, 'got '||coalesce(v,'null')||', want '||coalesce(want,'null'));
exception when others then insert into results values (name, false, sqlerrm); end $$;

-- ---------- fixed ids ----------
\set inst_i '61111111-0000-0000-0000-000000000001'
\set inst_j '62222222-0000-0000-0000-000000000002'
\set u_a  'a6000000-0000-0000-0000-000000000001'
\set u_r1 'a6000000-0000-0000-0000-000000000002'
\set u_r2 'a6000000-0000-0000-0000-000000000003'
\set u_n  'a6000000-0000-0000-0000-000000000004'
\set u_x  'a6000000-0000-0000-0000-000000000005'
\set u_o  'a6000000-0000-0000-0000-000000000006'
\set s_a  '71000000-0000-0000-0000-000000000001'
\set s_r1 '71000000-0000-0000-0000-000000000002'
\set s_r2 '71000000-0000-0000-0000-000000000003'
\set s_r3 '71000000-0000-0000-0000-000000000004'
\set s_x  '72000000-0000-0000-0000-000000000005'
\set s_o  '72000000-0000-0000-0000-000000000006'

-- ---------- fixtures (as the table owner) ----------
-- Team Inst (inst_i): admin A; Rep 1 and Rep 2 active; Rep 3 invited only.
-- Other Inst (inst_j): admin X; Other Rep O active. Nobody with user id u_n holds a seat.
--
-- Call outcomes, hand-counted (UTC unless a test says otherwise):
--   Rep 1, 2026-10-06: c1 10:00 answered 120s; c2 11:00 no_answer 0s, corrected by c2fix to answered 45s;
--                      c4 12:00 callback 30s.   -> 3 calls, 3 connected, 195 s = 3 talk minutes (3.25 rounded).
--   Rep 1, 2026-10-07: c5 09:00 won 300s; c6 09:30 busy, no time.   -> 2 calls, 1 connected, 300 s = 5 minutes.
--   Rep 1, 2026-10-04: c10 answered 999s, before the week of 2026-10-05.   -> in no report for that week.
--   Rep 2, 2026-10-06: c7 14:00 not_interested 0s, corrected by c8 callback 0s, corrected by c9 won 80s
--                      (a correction of a correction); c11 15:00 answered 60s.
--                      -> 2 calls, 2 connected, 140 s = 2 talk minutes (2.33 rounded).
--   Other Rep, 2026-10-06: c12 answered 500s. Must never appear in Team Inst.
-- In Pacific/Auckland (UTC+13 in October) c2, c3 (12:00), c7, c11 move to 2026-10-07 and c1 stays on 10-06:
--   2026-10-06 has 1 call (c1). 2026-10-07 has 6 calls: Rep 1 c2, c4, c5, c6; Rep 2 c7, c11.
-- Connected seconds per effective outcome on 10-07 Auckland: c2 45, c4 30, c5 300, c7 80, c11 60 (c6 null).

reset role;
insert into auth.users (id, email, email_confirmed_at) values
 (:'u_a',  'admin@team.test', now()),
 (:'u_r1', 'rep1@team.test', now()),
 (:'u_r2', 'rep2@team.test', now()),
 (:'u_n',  'nobody@team.test', now()),
 (:'u_x',  'admin@other.test', now()),
 (:'u_o',  'orep@other.test', now());
insert into institutes (id, name, status, seat_limit) values
 (:'inst_i', 'Team Inst', 'active', 10),
 (:'inst_j', 'Other Inst', 'active', 10);
insert into seats (id, institute_id, user_id, label, role, status) values
 (:'s_a',  :'inst_i', :'u_a',  'Admin', 'admin', 'active'),
 (:'s_r1', :'inst_i', :'u_r1', 'Rep 1', 'rep', 'active'),
 (:'s_r2', :'inst_i', :'u_r2', 'Rep 2', 'rep', 'active'),
 (:'s_r3', :'inst_i', null,    'Rep 3', 'rep', 'invited'),
 (:'s_x',  :'inst_j', :'u_x',  'Other Admin', 'admin', 'active'),
 (:'s_o',  :'inst_j', :'u_o',  'Other Rep', 'rep', 'active');
insert into call_outcomes (id, institute_id, seat_id, client_record_id, corrects_id, outcome, dialled_at, connected_seconds) values
 ('c0000000-0000-0000-0000-000000000001', :'inst_i', :'s_r1', 'r1-A', null, 'answered', '2026-10-06 10:00+00', 120),
 ('c0000000-0000-0000-0000-000000000002', :'inst_i', :'s_r1', 'r1-B', null, 'no_answer', '2026-10-06 11:00+00', 0),
 ('c0000000-0000-0000-0000-000000000003', :'inst_i', :'s_r1', 'r1-B-fix', 'c0000000-0000-0000-0000-000000000002', 'answered', null, 45),
 ('c0000000-0000-0000-0000-000000000004', :'inst_i', :'s_r1', 'r1-D', null, 'callback', '2026-10-06 12:00+00', 30),
 ('c0000000-0000-0000-0000-000000000005', :'inst_i', :'s_r1', 'r1-E', null, 'won', '2026-10-07 09:00+00', 300),
 ('c0000000-0000-0000-0000-000000000006', :'inst_i', :'s_r1', 'r1-F', null, 'busy', '2026-10-07 09:30+00', null),
 ('c0000000-0000-0000-0000-000000000007', :'inst_i', :'s_r2', 'r2-H', null, 'not_interested', '2026-10-06 14:00+00', 0),
 ('c0000000-0000-0000-0000-000000000008', :'inst_i', :'s_r2', 'r2-H-fix1', 'c0000000-0000-0000-0000-000000000007', 'callback', null, 0),
 ('c0000000-0000-0000-0000-000000000009', :'inst_i', :'s_r2', 'r2-H-fix2', 'c0000000-0000-0000-0000-000000000008', 'won', null, 80),
 ('c0000000-0000-0000-0000-00000000000a', :'inst_i', :'s_r2', 'r2-J', null, 'answered', '2026-10-06 15:00+00', 60),
 ('c0000000-0000-0000-0000-00000000000b', :'inst_i', :'s_r1', 'r1-G', null, 'answered', '2026-10-04 10:00+00', 999),
 ('c0000000-0000-0000-0000-00000000000c', :'inst_j', :'s_o', 'o-1', null, 'answered', '2026-10-06 10:00+00', 500);

-- ---------- terms acceptance ----------
reset role;
select pg_temp.as_user(:'u_r1', 'rep1@team.test');
set role authenticated;
select pg_temp.ok('rep1 accepts terms v1', format($q$select accept_terms(%L,'v1','hash-v1-first-0000')$q$, :'inst_i'));
select pg_temp.ok('accepting v1 again is accepted without error', format($q$select accept_terms(%L,'v1','hash-v1-second-111')$q$, :'inst_i'));
select pg_temp.val_is('idempotent: rep1 has exactly one v1 row', $q$select count(*)::text from accepted_terms where terms_version='v1'$q$, '1');
select pg_temp.val_is('idempotent: the first hash is kept', $q$select text_hash from accepted_terms where terms_version='v1'$q$, 'hash-v1-first-0000');
select pg_temp.rows_is('my_terms_status returns one row for rep1', format($q$select count(*)::int from my_terms_status(%L)$q$, :'inst_i'), 1);
select pg_temp.fails('terms hash shorter than 16 characters refused', format($q$select accept_terms(%L,'v2','short')$q$, :'inst_i'));
select pg_temp.fails('rep1 cannot accept terms for an institute where it holds no seat', format($q$select accept_terms(%L,'v1','hash-v1-first-0000')$q$, :'inst_j'));
reset role;

select pg_temp.as_user(:'u_r2', 'rep2@team.test');
set role authenticated;
select pg_temp.rows_is('rep2 cannot read rep1 acceptances', $q$select count(*)::int from accepted_terms$q$, 0);
reset role;

select pg_temp.as_user(:'u_a', 'admin@team.test');
set role authenticated;
select pg_temp.rows_is('admin reads the institute acceptances', format($q$select count(*)::int from accepted_terms where institute_id=%L$q$, :'inst_i'), 1);
reset role;

select pg_temp.as_user(:'u_n', 'nobody@team.test');
set role authenticated;
select pg_temp.fails('login with no seat cannot accept terms', format($q$select accept_terms(%L,'v1','hash-v1-first-0000')$q$, :'inst_i'));
reset role;

-- ---------- feedback ----------
select pg_temp.as_user(:'u_r1', 'rep1@team.test');
set role authenticated;
select pg_temp.ok('rep1 sends short feedback', $q$select submit_feedback('Dialer drops calls on Wi-Fi')$q$);
select pg_temp.ok('rep1 sends feedback of exactly 2000 characters', $q$select submit_feedback(repeat('a', 2000))$q$);
select pg_temp.fails('feedback of 2001 characters refused', $q$select submit_feedback(repeat('a', 2001))$q$);
select pg_temp.fails('blank feedback refused', $q$select submit_feedback('   ')$q$);
select pg_temp.fails('rep1 cannot insert feedback directly', format($q$insert into feedback (institute_id, seat_id, message) values (%L, %L, 'direct')$q$, :'inst_i', :'s_r1'));
reset role;

select pg_temp.as_user(:'u_n', 'nobody@team.test');
set role authenticated;
select pg_temp.fails('login with no seat cannot send feedback', $q$select submit_feedback('hello')$q$);
reset role;

select pg_temp.as_user(:'u_r2', 'rep2@team.test');
set role authenticated;
select pg_temp.rows_is('rep2 cannot read other seats feedback', $q$select count(*)::int from feedback$q$, 0);
reset role;

select pg_temp.as_user(:'u_a', 'admin@team.test');
set role authenticated;
select pg_temp.rows_is('admin reads the institute feedback (2 messages)', format($q$select count(*)::int from feedback where institute_id=%L$q$, :'inst_i'), 2);

-- ---------- supervisor notes (admin only) ----------
select pg_temp.ok('admin adds a note on rep1', format($q$select add_supervisor_note(%L,'2026-10-06','Good pace on follow-ups')$q$, :'s_r1'));
select pg_temp.ok('admin adds a note on rep2', format($q$select add_supervisor_note(%L,'2026-10-07','Check the objection script')$q$, :'s_r2'));
select pg_temp.fails('note of 1001 characters refused', format($q$select add_supervisor_note(%L,'2026-10-06',repeat('n',1001))$q$, :'s_r1'));
select pg_temp.fails('blank note refused', format($q$select add_supervisor_note(%L,'2026-10-06','  ')$q$, :'s_r1'));
select pg_temp.fails('admin cannot add a note on a seat in another institute', format($q$select add_supervisor_note(%L,'2026-10-06','Not mine')$q$, :'s_o'));
select pg_temp.rows_is('admin lists both notes', format($q$select count(*)::int from list_supervisor_notes(%L)$q$, :'inst_i'), 2);
select pg_temp.rows_is('admin lists notes for rep1 only', format($q$select count(*)::int from list_supervisor_notes(%L, %L)$q$, :'inst_i', :'s_r1'), 1);
select pg_temp.rows_is('admin lists notes from 2026-10-07 onwards', format($q$select count(*)::int from list_supervisor_notes(%L, null, '2026-10-07', null)$q$, :'inst_i'), 1);
select pg_temp.fails('list with from after to refused', format($q$select count(*) from list_supervisor_notes(%L, null, '2026-10-08', '2026-10-01')$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_r1', 'rep1@team.test');
set role authenticated;
select pg_temp.rows_is('rep1 cannot read supervisor notes directly', $q$select count(*)::int from supervisor_notes$q$, 0);
select pg_temp.fails('rep1 cannot list supervisor notes', format($q$select count(*) from list_supervisor_notes(%L)$q$, :'inst_i'));
select pg_temp.fails('rep1 cannot add a supervisor note', format($q$select add_supervisor_note(%L,'2026-10-06','mine')$q$, :'s_r1'));
reset role;

select pg_temp.rows_is('audit log has two supervisor_note.added rows', $q$select count(*)::int from audit_log where action='supervisor_note.added'$q$, 2);

-- ---------- rep targets (admin only) ----------
select pg_temp.as_user(:'u_a', 'admin@team.test');
set role authenticated;
select pg_temp.ok('admin sets rep1 calls target 4', format($q$select set_rep_target(%L,'calls',4)$q$, :'s_r1'));
select pg_temp.ok('admin sets rep1 connected_calls target 2', format($q$select set_rep_target(%L,'connected_calls',2)$q$, :'s_r1'));
select pg_temp.ok('admin sets rep1 talk_minutes target 5', format($q$select set_rep_target(%L,'talk_minutes',5)$q$, :'s_r1'));
select pg_temp.ok('admin sets rep2 calls target 8', format($q$select set_rep_target(%L,'calls',8)$q$, :'s_r2'));
select pg_temp.fails('target of 0 refused', format($q$select set_rep_target(%L,'calls',0)$q$, :'s_r1'));
select pg_temp.fails('target of 501 refused', format($q$select set_rep_target(%L,'calls',501)$q$, :'s_r1'));
select pg_temp.fails('unknown metric refused', format($q$select set_rep_target(%L,'texts',5)$q$, :'s_r1'));
select pg_temp.fails('target on an admin seat refused', format($q$select set_rep_target(%L,'calls',5)$q$, :'s_a'));
select pg_temp.fails('target for a rep in another institute refused', format($q$select set_rep_target(%L,'calls',5)$q$, :'s_o'));
reset role;

select pg_temp.as_user(:'u_r1', 'rep1@team.test');
set role authenticated;
select pg_temp.fails('rep1 cannot set its own target', format($q$select set_rep_target(%L,'calls',1)$q$, :'s_r1'));
select pg_temp.rows_is('rep1 cannot read rep targets', $q$select count(*)::int from rep_targets$q$, 0);
reset role;

select pg_temp.rows_is('audit log has four rep_target.set rows (the refused ones are not logged)', $q$select count(*)::int from audit_log where action='rep_target.set'$q$, 4);

-- ---------- team progress (admin only) ----------
select pg_temp.as_user(:'u_a', 'admin@team.test');
set role authenticated;
select pg_temp.ok('admin reads progress for 2026-10-06', format($q$select * from admin_rep_progress(%L,'2026-10-06')$q$, :'inst_i'));
select pg_temp.rows_is('progress lists the 2 active reps only', format($q$select count(*)::int from admin_rep_progress(%L,'2026-10-06')$q$, :'inst_i'), 2);
select pg_temp.val_is('rep1 10-06: 3 calls (correction c2fix is not a call)', format($q$select calls::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 1'$q$, :'inst_i'), '3');
select pg_temp.val_is('rep1 10-06: 3 connected', format($q$select connected_calls::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 1'$q$, :'inst_i'), '3');
select pg_temp.val_is('rep1 10-06: 3 talk minutes (195 s)', format($q$select talk_minutes::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 1'$q$, :'inst_i'), '3');
select pg_temp.val_is('rep1 10-06: calls 3 of 4 target is 75%', format($q$select (calls_pct = 75)::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 1'$q$, :'inst_i'), 'true');
select pg_temp.val_is('rep1 10-06: connected 3 of 2 target is 150%', format($q$select (connected_pct = 150)::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 1'$q$, :'inst_i'), 'true');
select pg_temp.val_is('rep1 10-06: talk 3 of 5 target is 60%', format($q$select (talk_pct = 60)::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 1'$q$, :'inst_i'), 'true');
select pg_temp.val_is('rep2 10-06: 2 calls (two corrections are not calls)', format($q$select calls::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 2'$q$, :'inst_i'), '2');
select pg_temp.val_is('rep2 10-06: 2 of 8 target is 25%', format($q$select (calls_pct = 25)::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 2'$q$, :'inst_i'), 'true');
select pg_temp.val_is('rep2 10-06: no talk target means null percentage', format($q$select (talk_pct is null)::text from admin_rep_progress(%L,'2026-10-06') where label='Rep 2'$q$, :'inst_i'), 'true');
select pg_temp.val_is('rep1 10-07 UTC: 2 calls', format($q$select calls::text from admin_rep_progress(%L,'2026-10-07') where label='Rep 1'$q$, :'inst_i'), '2');
select pg_temp.val_is('rep1 10-07 UTC: 2 of 4 target is 50%', format($q$select (calls_pct = 50)::text from admin_rep_progress(%L,'2026-10-07') where label='Rep 1'$q$, :'inst_i'), 'true');
select pg_temp.val_is('rep1 10-07 Auckland: 4 calls (c2 and c3 move to this day)', format($q$select calls::text from admin_rep_progress(%L,'2026-10-07','Pacific/Auckland') where label='Rep 1'$q$, :'inst_i'), '4');
select pg_temp.val_is('rep1 10-07 Auckland: 4 of 4 target is 100%', format($q$select (calls_pct = 100)::text from admin_rep_progress(%L,'2026-10-07','Pacific/Auckland') where label='Rep 1'$q$, :'inst_i'), 'true');
select pg_temp.val_is('rep1 10-07 Auckland: 6 talk minutes (375 s), 120% of 5', format($q$select (talk_pct = 120)::text from admin_rep_progress(%L,'2026-10-07','Pacific/Auckland') where label='Rep 1'$q$, :'inst_i'), 'true');
select pg_temp.fails('progress with an unknown time zone refused', format($q$select * from admin_rep_progress(%L,'2026-10-06','Mars/Olympus')$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_r1', 'rep1@team.test');
set role authenticated;
select pg_temp.fails('rep1 cannot read team progress', format($q$select * from admin_rep_progress(%L,'2026-10-06')$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_x', 'admin@other.test');
set role authenticated;
select pg_temp.fails('admin of another institute cannot read team progress', format($q$select * from admin_rep_progress(%L,'2026-10-06')$q$, :'inst_i'));
reset role;

-- ---------- weekly summary (admin only) ----------
select pg_temp.as_user(:'u_a', 'admin@team.test');
set role authenticated;
select pg_temp.ok('admin reads the weekly summary', format($q$select * from admin_weekly_summary(%L,'2026-10-05')$q$, :'inst_i'));
select pg_temp.rows_is('weekly summary has 7 days', format($q$select count(*)::int from admin_weekly_summary(%L,'2026-10-05')$q$, :'inst_i'), 7);
select pg_temp.val_is('UTC 10-06: 5 calls', format($q$select calls::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-06'$q$, :'inst_i'), '5');
select pg_temp.val_is('UTC 10-06: 5 connected', format($q$select connected_calls::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-06'$q$, :'inst_i'), '5');
select pg_temp.val_is('UTC 10-06: connect rate 1', format($q$select (connect_rate = 1)::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-06'$q$, :'inst_i'), 'true');
select pg_temp.val_is('UTC 10-06: 6 talk minutes (335 s)', format($q$select talk_minutes::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-06'$q$, :'inst_i'), '6');
select pg_temp.val_is('UTC 10-06: both reps made calls, none without', format($q$select reps_with_no_calls::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-06'$q$, :'inst_i'), '0');
select pg_temp.val_is('UTC 10-07: 2 calls', format($q$select calls::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-07'$q$, :'inst_i'), '2');
select pg_temp.val_is('UTC 10-07: connect rate 0.5', format($q$select (connect_rate = 0.5)::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-07'$q$, :'inst_i'), 'true');
select pg_temp.val_is('UTC 10-07: rep2 made no call', format($q$select reps_with_no_calls::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-07'$q$, :'inst_i'), '1');
select pg_temp.val_is('UTC 10-05: no calls means null connect rate', format($q$select (connect_rate is null)::text from admin_weekly_summary(%L,'2026-10-05') where day='2026-10-05'$q$, :'inst_i'), 'true');
select pg_temp.val_is('week total: 7 calls (999 s call of 10-04 and other institute excluded)', format($q$select sum(calls)::text from admin_weekly_summary(%L,'2026-10-05')$q$, :'inst_i'), '7');
select pg_temp.val_is('Auckland 10-06: 1 call (c1 only)', format($q$select calls::text from admin_weekly_summary(%L,'2026-10-05','Pacific/Auckland') where day='2026-10-06'$q$, :'inst_i'), '1');
select pg_temp.val_is('Auckland 10-07: 6 calls', format($q$select calls::text from admin_weekly_summary(%L,'2026-10-05','Pacific/Auckland') where day='2026-10-07'$q$, :'inst_i'), '6');
select pg_temp.val_is('Auckland 10-07: 5 connected', format($q$select connected_calls::text from admin_weekly_summary(%L,'2026-10-05','Pacific/Auckland') where day='2026-10-07'$q$, :'inst_i'), '5');
select pg_temp.val_is('Auckland 10-07: 9 talk minutes (515 s)', format($q$select talk_minutes::text from admin_weekly_summary(%L,'2026-10-05','Pacific/Auckland') where day='2026-10-07'$q$, :'inst_i'), '9');
select pg_temp.fails('weekly summary with an unknown time zone refused', format($q$select * from admin_weekly_summary(%L,'2026-10-05','Mars/Olympus')$q$, :'inst_i'));
reset role;

select pg_temp.as_user(:'u_r2', 'rep2@team.test');
set role authenticated;
select pg_temp.fails('rep2 cannot read the weekly summary', format($q$select * from admin_weekly_summary(%L,'2026-10-05')$q$, :'inst_i'));
reset role;

-- ---------- grants ----------
select pg_temp.val_is('anon cannot execute accept_terms', $q$select has_function_privilege('anon','public.accept_terms(uuid,text,text)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('anon cannot execute submit_feedback', $q$select has_function_privilege('anon','public.submit_feedback(text)','EXECUTE')::text$q$, 'false');
select pg_temp.val_is('authenticated can execute add_supervisor_note', $q$select has_function_privilege('authenticated','public.add_supervisor_note(uuid,date,text)','EXECUTE')::text$q$, 'true');
select pg_temp.val_is('anon cannot read supervisor_notes', $q$select has_table_privilege('anon','public.supervisor_notes','SELECT')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot insert into accepted_terms', $q$select has_table_privilege('authenticated','public.accepted_terms','INSERT')::text$q$, 'false');
select pg_temp.val_is('authenticated cannot call the time zone helper', $q$select has_function_privilege('authenticated','public.admin_check_tz(text)','EXECUTE')::text$q$, 'false');

reset role;
select test, case when passed then 'PASS' else 'FAIL' end as result, detail from results order by test;
select count(*) filter (where passed) as passed, count(*) filter (where not passed) as failed from results;
