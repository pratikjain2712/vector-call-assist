# Demo institute

"Sunrise Coaching Academy (Demo)" for sales demos. **Fake data only**: made-up names, and phone numbers in
the +91 9999xxxxxx block, used as an obviously fake range. Never use it for real calls or real data.

- `reset-demo.sh`: creates the 7 demo logins and loads the data (run on the morning of the demo).
- `create-demo-users.mjs`: the logins only (needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEMO_PASSWORD`).
- `demo_seed.sql`: the data only (`psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f demo_seed.sql`), after the logins.
- `remove-demo.sql`: deletes the demo institute. The logins stay; `docs/demo.md` shows how to delete them.

Steps, where to find the keys, what each login shows and a 10-minute walkthrough: `docs/demo.md`.
