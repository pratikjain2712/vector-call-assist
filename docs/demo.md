# Sales demo: "Sunrise Coaching Academy (Demo)"

A ready-made, busy institute for sales demos. Prospects sign in with an email and a password and see every
screen full: today's calls, campaigns, insights, reports, scripts and the caller screen.

**Everything in it is fake.** The people are made up and every phone number is in the +91 9999xxxxxx block,
used here only as an obviously fake range. Never call these numbers and never put real data in this institute.

Files: `supabase/demo/` (`reset-demo.sh`, `create-demo-users.mjs`, `demo_seed.sql`, `remove-demo.sql`).

## The logins

All seven use the one password you choose (`DEMO_PASSWORD`, at least 10 characters).

| Login | Who | What they see |
|---|---|---|
| `owner.sunrise@example.com` | Anita Sharma, Owner | Everything, with ₹ amounts |
| `manager.sunrise@example.com` | Rahul Verma, Manager | Everything an admin sees, but no ₹: counts only |
| `ravi.sunrise@example.com` | Ravi, caller | Oct fees – Class 10 (fees reminders) |
| `priya.sunrise@example.com` | Priya, caller | Course sales – Data Analytics |
| `neha.sunrise@example.com` | Neha, caller | Course sales – Data Analytics (the best caller) |
| `amit.sunrise@example.com` | Amit, caller | Oct fees – Class 10 (no calls today, long openings) |
| `sana.sunrise@example.com` | Sana, caller | Admission follow-up (phone offline today) |

Owner and manager sign in at `admin.html`; callers at `app.html`.

## Before the first time (10 minutes, once)

You need, on the laptop: Node.js 18 or newer (run `npm install` once in the repo folder), `psql` (macOS:
`brew install libpq && brew link --force libpq`; Windows: use WSL or Git Bash with the PostgreSQL client), and
the repo checked out.

Collect four values from the Supabase dashboard of the project the demo runs on:

1. **SUPABASE_URL**: Project Settings → API → *Project URL* (`https://<ref>.supabase.co`).
2. **SUPABASE_SERVICE_ROLE_KEY**: Project Settings → API Keys → the *service_role* key (or a *secret* key,
   `sb_secret_…`). It can do anything in the project: keep it on the laptop, never in chat, email or git.
3. **SUPABASE_DB_URL**: the **Connect** button at the top of the project → *Connection string* → *Session
   pooler* (works on any network). Replace `[YOUR-PASSWORD]` with the database password. Forgot it? Project
   Settings → Database → *Reset database password* (nothing else uses it; the app uses the API keys).
4. **DEMO_PASSWORD**: any password of 10+ characters for the seven demo logins.

The database must already have every migration in `supabase/migrations/` (`supabase db push`).

## The morning of the demo

Load it fresh so "Today" on Home is today. Best 15–30 minutes before the demo, after 10 am India time
(today's calls are spread over the working hours so far; loaded at 8 am they all fall in the last hour or two).

```bash
cd vector-call-assist
export SUPABASE_URL='https://<ref>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='…'
export SUPABASE_DB_URL='postgresql://postgres.<ref>:<db password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
export DEMO_PASSWORD='…'
supabase/demo/reset-demo.sh
```

It takes under a minute. It creates the logins (or resets their password), deletes the old demo institute and
builds it again. It never touches another institute. Run it again any time to start over (for example after
the prospect clicked "Use v7 for everyone").

**Caller screen: pair a phone first.** The caller page only opens after this browser is paired with the
Vector Companion app on an Android phone (the pairing is stored in the browser, not in the database, so the
demo data cannot do it). Before the demo, sign in as `ravi.sunrise@example.com` on the demo laptop and pair
your phone once (Scan pairing QR). The pairing stays in that browser. Without a phone, show the caller screen
from the screenshots instead.

Good to know:
- "Callers right now" (On a call, Ready, Phone offline) stays as loaded for about 8 hours. "Ready" turns into
  "No calls for N min" after 15 minutes, and Amit's idle time keeps growing; that is real behaviour.
- The numbers are a simulation with a fixed seed, shifted to today, so they differ a little from day to day.
- A real caller using the demo (saving a call) changes the numbers like real work would.

## What each login shows

**Owner (Anita)**
- Home: about 140 calls today ("x% more than yesterday"), ~60% picked up, talk time, 9 joined and 13
  interested on sales, fees paid and promised in ₹. Callers right now: Neha and Ravi on a call, Priya ready,
  Amit no calls for 45 min, Sana's phone offline. Needs your attention: 6 fee promises due today, Sana's phone,
  "Course sales: ~40% of picked-up calls end at the Fees step", Amit idle.
- Campaigns: Course sales – Data Analytics (420 leads, Priya and Neha), Admission follow-up (150, Sana),
  Oct fees – Class 10 (240 parents, Ravi and Amit, due 31 Oct), PTM reminder – Nov (draft), Sept fees –
  Class 9 (closed, all 212 called).
- Insights: the weekly brief in 4 lines, forecast and what-if, best time to call (7–9 pm wins), where calls
  end, promises kept by how far away the date was, caller coaching, the v6 vs v7 script test.
- Reports: Fees collection (14 broken promises, mostly Class 10-B), Sales funnel, Results, Why calls are lost
  (pick Course sales, v7), Weekly summary.
- Scripts: Fees reminder v3, Course sales v7, Admission check v2, Late fee warning (a draft with a "Check this"
  mark). 3 of 20 AI drafts used this month.
- Callers: team activity, daily targets, supervisor notes (one about Priya skipping the questions), seats,
  phones paired. Settings: call types (with two added results: "Asked for concession", "Admission
  confirmed"), money switch, plan, WhatsApp **not connected** (so you can show how to connect), activity log.

**Manager (Rahul)**: the same screens with no ₹ anywhere: the fees forecast counts payments, Home shows
"Fees: paid N calls", reports show counts, Excel has no ₹ columns.

**Caller (Ravi)**: his Oct fees list with broken promises first, the lead card (parent, student, class, amount
due, last call), the script step by step, pushback answers, result buttons with date and ₹ fields.

## A 10-minute walkthrough

1. **Owner → Home** (2 min). "This is today, live." The five tiles, callers right now (point at Sana's phone
   and Amit idle), then *Needs your attention*: click **See list** on the promises due today.
2. **Campaigns** (1 min). One script, one lead list, its callers. Open *Oct fees – Class 10*: progress, results,
   amount due. Show **+ New campaign** steps without saving.
3. **Insights** (3 min). Read the 4-line brief. Pick **Oct fees – Class 10**: the forecast in ₹ against the
   90% target, "What closes the gap", move the What-if sliders (add a caller, more evening calls). Show best
   time to call (evenings), promises kept (dates within 7 days are kept far more), coaching (Amit's long
   opening → *Send Amit to practice mode*). Switch to **Course sales**: the script test, v7 winning.
4. **Reports** (1.5 min). Campaign **Oct fees – Class 10**, *Fees collection*: due, paid, promised, the 14
   broken promises, "Send these back to callers". Then *Sales funnel*: called → picked up → heard the pitch →
   interested → joined.
5. **Scripts** (1 min). Open Course sales (steps, pushback answers, endings linked to results). **Make with
   AI**: fill the form to show it (a real draft needs the AI key on the server; the counter shows 3 of 20).
6. **Manager** (30 s). Sign out, sign in as Rahul: same Home and Reports, no ₹.
7. **Caller** (1 min). On the paired laptop as Ravi: the waiting list, the lead card, the script, result
   buttons with date and amount, "Send on WhatsApp".

Tip: in Reports pick the *Oct fees* campaign. With *All campaigns*, "Total due" also counts the closed Sept
campaign (₹ due on its lead list, although it was collected).

## After the demo

- **Change the demo password** (run `reset-demo.sh` with a new `DEMO_PASSWORD`), and rotate the service role
  key if it was ever shown on screen or shared (Project Settings → API Keys).
- **Remove the demo before real institutes join** (or keep it only in a separate demo project):
  ```bash
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/demo/remove-demo.sql
  ```
  This deletes the institute and everything in it. The 7 logins stay; delete them in Authentication → Users
  (search `sunrise@example.com`, then Delete user for each), or with the service role key:
  ```bash
  node -e 'const {createClient}=require("@supabase/supabase-js");const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);(async()=>{const {data}=await db.auth.admin.listUsers({perPage:1000});for(const u of data.users.filter(u=>/\.sunrise@example\.com$/.test(u.email))){await db.auth.admin.deleteUser(u.id);console.log("deleted",u.email);}})()'
  ```
- The demo logins hold seats only in the demo institute; do not use them for anything else.

## Reset from anywhere (no laptop terminal)

The project has a server function `demo-reset` (supabase/functions/demo-reset). Signed in as the demo owner, a POST to
`https://ehkjtowrcsplidjjjjca.supabase.co/functions/v1/demo-reset` rebuilds the demo institute with today's dates
(about a minute). It refuses every other login. It runs the seed pinned to commit 1898f1b; after changing
demo_seed.sql, update SEED_URL in the function and deploy it again.
