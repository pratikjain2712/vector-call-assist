# Weekly brief, script test and practice mode

_Phase A, Sprint 11 (insights-extra). Migration `supabase/migrations/20261024100026_insights_extra.sql`, tests
`supabase/tests/insights_extra_test.sql`, `tests/web/insights-extra.test.js`, `tests/web/practice.test.js`,
`tests/web/weekly-brief.test.js`, `tests/e2e/insights-extra.spec.js`. Function reference: `docs/data-contract.md`
("Insights extra")._

## Weekly brief

Four plain lines, made from rules in SQL (no AI):

1. **Forecast**: the campaign's pace over the last 7 days carried to its end date (or one week). Fees, when the
   person may see money: rupees collected (reported by callers) against rupees due. Otherwise: leads with a good
   result against all leads. Under 50 calls: "not enough calls yet".
2. **Best hours**: the two-hour window (weekdays or weekends, India time) with the highest pickup rate over the
   last 4 weeks (at least 20 calls in the window), and a caller whose most common calling hour is outside it.
3. **Promises**: leads still "promised" after the promised date (broken), and how often promises more than 7
   days away were kept against promises within 7 days. When the far ones are kept 10 points less often, it adds
   "Ask for a date within 7 days."
4. **Script version change**: the newest script version against the one before, in good results per 100
   picked-up calls (last 90 days, 30 picked-up calls each), and the step where most calls without a good result
   end. Needs the Scripts add-on.

Where it shows:

- **Insights tab**: `VectorInsightsExtra.mountWeeklyBrief(box, ctx, { campaignId })` calls
  `admin_weekly_brief(p_campaign)`. Rupees only when `can_see_money()`.
- **Email** (this doc): the Edge Function `weekly-brief`, every Monday, to each institute's active owners.
  The email is **counts only** (no rupees): an inbox is not a place for fee totals, and owners see the rupee
  version in the app.
- **WhatsApp** (Sprint 12): reuse `admin_weekly_brief()` (as the admin) or `weekly_brief_lines()` (service role).

### The Edge Function

`supabase/functions/weekly-brief/index.ts` is a thin Deno wrapper; the logic is `logic.js` (Node-tested with
fetch mocked). It reads `weekly_brief_recipients()` and `weekly_brief_lines(inst, null, false)` with the service
role key and sends one email per owner through a provider-neutral sender (Resend built in). One institute
failing does not stop the others. The log names institutes by id, never email addresses or keys.

Secrets (`supabase secrets set NAME=value`, never in the repo or in chat):

| Name | Needed | What |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | given by Supabase | Database calls. |
| `RESEND_API_KEY` | to send | Resend API key. Without it (or without `BRIEF_FROM_EMAIL`) the run composes, logs "email is not set up" and sends nothing. |
| `BRIEF_FROM_EMAIL` | to send | Sender, e.g. `Vector <brief@yourdomain.in>`, on a domain verified in Resend. |
| `BRIEF_EMAIL_PROVIDER` | no | `resend` (default). Another provider is one more branch in `createSender()` in `logic.js`. |
| `BRIEF_APP_URL` | no | Site address for the "See more on Insights" link, e.g. `https://app.yourdomain.in`. |
| `BRIEF_CRON_SECRET` | no | Lets the schedule call with an `x-brief-secret` header instead of the service role key. |

Deploy (not done in this round): `supabase functions deploy weekly-brief`.

Try it without sending: `POST /functions/v1/weekly-brief` with body `{"dry_run": true}` returns every institute's
subject and lines.

### Schedule (Supabase Cron)

Monday 8:00 am India time = **02:30 UTC Monday**. In the Supabase dashboard: Integrations → Cron → enable
`pg_cron` and `pg_net`, keep the service role key in Vault (Project Settings → Vault, name `service_role_key`),
then run once in the SQL editor:

```sql
select cron.schedule(
  'weekly-brief',
  '30 2 * * 1',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/weekly-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
  $$);
```

Check runs with `select * from cron.job_run_details order by start_time desc limit 5;` and the function log.
Stop it with `select cron.unschedule('weekly-brief');`. This is not in a migration on purpose: it needs the
project's URL and a Vault secret, which differ per project (and must not run on a laptop database).

## Script A/B test

- Admin, Insights: `VectorInsightsExtra.mountScriptTest(box, ctx, { campaignId })`; `handle.setCampaign(id)`
  when the Insights campaign filter changes. Pick two versions of the campaign's script → `admin_start_script_test`.
- Leads are split 50/50: the first lead asked about gets A, the next B, and so on. The choice is stored per lead
  (`script_test_leads`), so a lead called again hears the same version.
- **Caller page (integration)**: before showing the script for a lead, call
  `campaign_script_version(p_campaign, p_lead)` and use its `steps`. Save the call with
  `script_id = <returned script_id as text>` and `script_version = <returned version>`, or the call is not counted
  in the test. No rows means "no script for this campaign" (no script, nothing published, or no Scripts add-on).
- Results: good results per 100 picked-up calls, average call length, and "how sure" (the chance one version
  really gets more good results, Bayesian with a flat prior, worked out in the browser). No winner before 50
  picked-up calls on each version; a winner at 90% sure.
- "Use vX for everyone" ends the test and publishes vX for the script (every campaign using the script uses it).
  "Keep testing" hides the suggestion. "Stop test" ends it with no change.

## Practice mode

- Admin (coaching): `admin_assign_practice(p_seat, p_script, p_note)`; the list is `admin_list_practice()`.
- Caller: `web/practice.html` (or `practice.html?script=<script id>` to open one script). It lists
  `my_practice()`: the scripts the admin asked for first, then every other published script. A pretend lead
  (made-up name, student, fee) fills `{name}`, `{student}`, `{amount}` …; `{me}` is the caller's seat label.
  The page shows the time on the current step and in total, Back one step, and a summary (time on each step,
  the longest step). Finishing an asked-for practice calls `my_practice_done(id, seconds)`.
- Nothing is dialled and nothing is written to `call_outcomes`.
- **Caller app (integration)**: show a link to `practice.html` when `my_practice()` has a row with
  `assignment_id` set and `done_at` null (or always, as "Practise a script").
