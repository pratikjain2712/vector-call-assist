-- Removes the demo institute "Sunrise Coaching Academy (Demo)" and everything in it: seats, campaigns, leads,
-- calls, scripts, notes, presence, AI and audit rows. No other institute is touched.
-- The 7 demo logins (*.sunrise@example.com) are left in Authentication > Users: docs/demo.md says how to
-- delete them.
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/demo/remove-demo.sql

\set ON_ERROR_STOP on
begin;

-- Corrections point at the rows they correct (on delete restrict), and a published script version refuses
-- to be deleted, so both are undone first. Everything else goes with the institute (on delete cascade).
update public.call_outcomes set corrects_id = null
  where institute_id = '5a1e0000-0000-4000-8000-000000000001' and corrects_id is not null;
delete from public.call_outcomes where institute_id = '5a1e0000-0000-4000-8000-000000000001';
update public.script_versions set published = false
  where institute_id = '5a1e0000-0000-4000-8000-000000000001' and published;
delete from public.institutes where id = '5a1e0000-0000-4000-8000-000000000001';

commit;
\echo 'Demo institute removed. The demo logins are still there; see docs/demo.md to delete them.'
