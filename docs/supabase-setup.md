# Connecting the website to Supabase

The website syncs **call outcomes** to Supabase: outcome, end card reached, last objection, dial time, connected seconds and phone session ID. **Lead names and phone numbers from a sheet opened on the laptop never leave the browser.** From Phase A (Sprint 7), leads uploaded to a **campaign** are stored in the cloud so they can be shared between callers; see `docs/data-contract.md` for who can read them and the money rules. With `web/js/config.js` left empty, the site runs exactly as before, local only.

## 1. Create the tables

In the Supabase dashboard, open **SQL Editor**, paste `supabase/migrations/20261011100001_init.sql` and run it.

## 2. Auth settings

- **Authentication > Providers > Email:** enabled.
- **Authentication > Sign In / Up:** turn **Allow new users to sign up** off. Accounts are invited; the website asks for a link with `shouldCreateUser: false`, so it never creates accounts either way.
- **Authentication > URL Configuration:**
  - Site URL: `https://pratikjain2712.github.io/vector-call-assist/` (the rep page)
  - Redirect URLs: add the rep page and the admin page, and the two local pages for testing:
    - `https://pratikjain2712.github.io/vector-call-assist/`
    - `https://pratikjain2712.github.io/vector-call-assist/admin.html`
    - `http://localhost:8000/`
    - `http://localhost:8000/admin.html`

## 3. Add a rep

1. **Authentication > Users > Invite user**, with the rep's email.
2. In **SQL Editor**, give them an institute and an active seat (replace the email):

```sql
insert into institutes (name, status) values ('TechSimPlus', 'active') returning id;

insert into seats (institute_id, user_id, label, role, status)
select i.id, u.id, 'Pratik', 'rep', 'active'
from institutes i, auth.users u
where i.name = 'TechSimPlus' and u.email = 'rep@example.com';
```

Use `role = 'admin'` for someone who should see every seat and outcome in the institute.

Once the admin page works, admins can add seats there instead (section 5). The steps above are for the first setup.

## 4. Point the website at the project

Fill in `web/js/config.js` from **Project Settings > API**:

```js
window.VECTOR_CONFIG = {
  supabaseUrl: "https://<project-ref>.supabase.co",
  supabaseAnonKey: "<anon public key>",
};
```

The anon key is meant to be public. Row-level security decides what each signed-in user can read and write. **Never put the `service_role` key in the website.**

## 5. Seat invitations (Edge Function)

The admin page adds, reassigns, revokes and unpairs seats through the `seat-admin` Edge Function (`supabase/functions/seat-admin/index.ts`). The browser never calls the seat functions directly and never holds the service role key. Deploy the function from the repo root, after `supabase link`:

```
supabase functions deploy seat-admin
```

The function sends invitation emails with the service role key. Supabase gives deployed functions `SUPABASE_SERVICE_ROLE_KEY` automatically, so there is no secret to create by hand; the Supabase CLI does not allow secrets whose names start with `SUPABASE_`. Never add that key to `config.js` or to the repo. If the function answers "The server is not configured for seat changes", redeploy it and check its logs.

## 6. Phase A: new migrations, Edge Functions and secrets

Apply the new migrations (`20261024100020` to `20261024100030`) with `supabase db push` after `supabase link`. Then deploy the Edge Functions and set their secrets (`supabase secrets set NAME=value`, never in the repo or in chat):

| Function | Secrets | Details |
|---|---|---|
| `ai-script-draft` | `ANTHROPIC_API_KEY`; optional `ANTHROPIC_MODEL_DRAFT`, `ANTHROPIC_MODEL_FALLBACK` | `docs/data-contract.md` (Scripts), `docs/ai-draft-quality.md` |
| `weekly-brief` | `RESEND_API_KEY`, `BRIEF_FROM_EMAIL`, `BRIEF_CRON_SECRET`; optional `BRIEF_APP_URL`, `BRIEF_EMAIL_PROVIDER` | `docs/weekly-brief.md` (Monday pg_cron job, 02:30 UTC) |
| `whatsapp-admin`, `whatsapp-send`, `whatsapp-webhook`, `whatsapp-reminders` | `WHATSAPP_TOKEN_KEY`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_CRON_SECRET`; optional `WHATSAPP_PLATFORM_TOKEN`, `WHATSAPP_GRAPH_VERSION` | `docs/whatsapp-setup.md` (Meta app, webhook, daily pg_cron job) |

```
supabase functions deploy ai-script-draft
supabase functions deploy weekly-brief
supabase functions deploy whatsapp-admin
supabase functions deploy whatsapp-send
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy whatsapp-reminders --no-verify-jwt
```

Check `docs/whatsapp-setup.md` for the exact flags of each WhatsApp function (Meta and the schedule call the webhook and the reminders without a Supabase login). The two schedules (weekly brief, WhatsApp reminders) need the project URL and a Vault secret, so they are set up by hand from those docs, not by a migration.

## How it behaves

- **Order of screens:** sign in (emailed link) → pair the phone → calling workspace.
- **Account without an active seat:** shown "No active seat" with Try again and Sign out.
- **When a call uploads:** once its outcome is tapped. For laptop calls it waits for the phone's result, or 2 minutes.
- **Offline:** results queue in the browser and upload when the connection is back. The header pill shows "Synced", "N to sync" or "Cloud offline".
- **Changing an outcome after upload:** adds a correction row that points at the earlier one (`corrects_id`). Nothing is overwritten or deleted.
- **Retries:** the `(seat_id, client_record_id)` key means a retried upload is stored once.
- **History before sign-in:** calls finished before an account first signs in on a browser stay local.
