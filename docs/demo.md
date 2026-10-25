# Sales demo: "Sunrise Coaching Academy (Demo)"

A ready-made, busy institute for sales demos. Prospects sign in with an email and a password and see every
screen full: today's calls, campaigns, insights, reports, scripts, the fees ledger and the caller screen.

**Everything in it is fake.** The people are made up and every phone number is in the +91 9999xxxxxx block,
used here only as an obviously fake range. Never call these numbers and never put real data in this institute.
The one exception is **Shronit** (+91 96197 07601) in *Course sales – Data Analytics*: a real person who agreed
to take a live call during demos (see "Live call" below). Do not add other real numbers.

Files: `supabase/demo/` (`reset-demo.sh`, `create-demo-users.mjs`, `demo_seed.sql`, `remove-demo.sql`).

## The logins

All eight use the one password you choose (`DEMO_PASSWORD`, at least 10 characters).

| Login | Who | What they see |
|---|---|---|
| `owner.sunrise@example.com` | Anita Sharma, Owner | Everything, with ₹ amounts |
| `manager.sunrise@example.com` | Rahul Verma, Manager | Everything an admin sees, but no ₹: counts only |
| `ravi.sunrise@example.com` | Ravi, caller | Oct fees – Class 10 (fees reminders) |
| `priya.sunrise@example.com` | Priya, caller | Course sales – Data Analytics |
| `neha.sunrise@example.com` | Neha, caller | Course sales – Data Analytics (the best caller) |
| `amit.sunrise@example.com` | Amit, caller | Oct fees – Class 10 (no calls today, long openings) |
| `sana.sunrise@example.com` | Sana, caller | Admission follow-up (phone offline today) |
| `accounts.sunrise@example.com` | Kavita Joshi, Accounts | The Fees tab only: students, balances, payments, fees campaigns from the ledger (always with ₹) |

Owner, manager and accounts sign in at `admin.html`; callers at `app.html`. Every campaign is open to all
callers, so any caller can pick any running campaign (the names in the table are where each one usually works).
The institute has 8 seats and all 8 are used, so nobody can send invite emails from the demo.

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
4. **DEMO_PASSWORD**: any password of 10+ characters for the eight demo logins.

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
- A real caller using the demo (saving a call) changes the numbers like real work would; so does a payment
  recorded by Kavita (the parent's lead closes when nothing is left to pay).

## What each login shows

**Owner (Anita)**
- Home: about 140 calls today ("x% more than yesterday"), ~60% picked up, talk time, 9 joined and 13
  interested on sales, fees paid and promised in ₹. Callers right now: Neha and Ravi on a call, Priya ready,
  Amit no calls for 45 min, Sana's phone offline. Needs your attention: 6 fee promises due today, Sana's phone,
  "Course sales: ~40% of picked-up calls end at the Fees step", Amit idle.
- Needs your attention also shows **4 follow-ups back in the pool today**: walk-in enquiries in Admission
  follow-up that Priya took 3 days ago and has not worked since; their call back came due this morning, so
  they went back to the pool for the next free caller.
- Campaigns, all open to all callers and tagged by class and board:
  - *Oct fees – Class 10* (10th · CBSE, fees): 240 parents, Ravi and Amit, Term 2 overdue since 15 days ago.
    Script "Overdue fees – Class 10".
  - *Term 2 fees – Class 8* (8th · CBSE, fees): made from the ledger by Kavita this morning; ~133 parents with
    Term 2 due in 6 days (one lead for twins who share a phone, two students with no phone left out), all in the
    pool. Script "Term 2 reminder – Class 8".
  - *Class 9 admission enquiries* (9th · ICSE, admission): 64 new enquiries from the website, the admission fair
    at Phoenix Mall and calls to the office, in the pool. Script "Class 9 admission enquiry".
  - *Course sales – Data Analytics* (sales): 421 leads, Priya and Neha, the v6 vs v7 script test.
  - *Admission follow-up* (admission): 154 enquiries, Sana.
  - *PTM reminder – Nov* (draft) and *Sept fees – Class 9* (closed, all 150 Class 9 parents called).
- Every lead says where it came from (`extra.source` and `extra.source_date`, e.g. "the enquiry form on our
  website", "our admission fair at Phoenix Mall", "a call to our office"; fees leads: "your child's admission
  form"), so "Where did you get my number?" has an answer.
- Insights: the weekly brief in 4 lines, forecast and what-if, best time to call (7–9 pm wins), where calls
  end, promises kept by how far away the date was, caller coaching, the v6 vs v7 script test.
- Reports: Fees collection (14 broken promises, mostly Class 10-B), promises against the ledger (kept, part
  paid, broken), collected by mode, Sales funnel, Results, Why calls are lost (pick Course sales, v7), Weekly
  summary.
- Scripts: three made from the template library, each with v1 as copied (with its "Check this" marks) and v2
  published with the institute's facts filled in: Overdue fees – Class 10 (*Overdue fee reminder*), Term 2
  reminder – Class 8 (*Fee reminder before the due date*), Class 9 admission enquiry (*School admission enquiry
  follow-up*). Also Fees reminder v3 (used by the closed Sept campaign), Course sales v7, Admission check v2 and
  Late fee warning (a draft with a "Check this" mark). **Start from a template** opens the ready script
  library: 26 scripts for fees, admissions, sales and cold calling, in English and Hinglish, filtered by
  purpose, class, board and language. (The AI script maker is the Vector team's own tool; institutes do not
  see it or an AI drafts count.)
- Fees (the ledger, also what Kavita sees): 570 students (Class 8 CBSE 180 in sections A–C, Class 9 ICSE 150,
  Class 10 CBSE 240, plus about 10 new students from "Admission confirmed" calls with no fee plan yet), each
  with an admission number, parent and phone. Fee items for 2026-27: Term 1 and Term 2 tuition, and a bus fee
  per term for bus users. An opening balance import 58 days ago (Term 1 "paid so far"; a few still owe part of
  it). About 400 payments in the last 8 weeks, mostly UPI, then cash, cheque and bank transfer, with
  references, and 3 reversals (a bounced cheque, a UPI payment first put on the wrong student, a cash payment
  typed twice).
- Callers: team activity, daily targets, supervisor notes (one about Priya skipping the questions), seats,
  phones paired. Settings: call types (with two added results: "Asked for concession", "Admission
  confirmed"), **common answers** (5 answers that need the institute's facts, e.g. "Where is the institute?",
  "How much is the fee?": callers see them only once the owner fills them in), money switch, plan, WhatsApp
  **not connected** (so you can show how to connect), activity log. Callers: Kavita (Accounts) is in the seats
  list with the role Accounts, but never as a caller (not on Home, not in campaign or move lists).

**Manager (Rahul)**: the same screens with no ₹ anywhere: the fees forecast counts payments, Home shows
"Fees: paid N calls", reports show counts, Excel has no ₹ columns. In Fees he sees who owes, not how much, and
cannot record payments.

**Accounts (Kavita)**: only the Fees tab, always with ₹ (the fees office needs amounts). The students list by
class, section and board with the balance due now, the total for the year and the last payment; "only due"
shows ~160 Class 10 parents with Term 2 overdue, ~19 Class 9 and a few Class 8. A student page: fee items,
payments with mode and reference (UPI UTRs, cheque numbers, receipts), reversals with their reason, and the
calls made to the parent. Things to look for:
- **Says already paid, not in the ledger**: a few Oct fees calls ended "Says already paid" in the last 10 days
  with no matching payment. Open the student, see the call, and check with the parent or the bank.
- The bounced cheque (Class 8): reversed, so the student owes Term 2 again and is in *Term 2 fees – Class 8*.
- *Term 2 fees – Class 8* was made here ("Fees campaign from the ledger": class 8th, CBSE, due by Term 2's due
  date).
- She cannot see Home, Callers, campaigns, scripts or settings.

**Live call (Shronit)**: Shronit is in *Course sales – Data Analytics*, Neha's first due call back (source "a
call to our office", no WhatsApp consent). Sign in as Neha on the paired laptop and he is at the top of her list;
the owner calls him live. Reset the demo afterwards to put him back.

**Caller (Ravi)**: his Oct fees list with broken promises first, the lead card (parent, student, class, amount
due, last call), the script step by step, pushback answers, result buttons with date and ₹ fields.

## A 15-minute walkthrough

Eight logins: owner, manager, five callers and Accounts. Every running campaign is open to every caller and
tagged by class and board; callers pick the campaign, the script follows it.

1. **Owner → Home** (2 min). "This is today, live." The five tiles (collected today comes from the fee ledger),
   callers right now (point at Sana's phone and Amit idle; Kavita is not listed, she is Accounts), then
   *Needs your attention*: **See list** on the promises due today, and the 4 follow-ups back in the pool
   ("nobody waits on a caller who stopped").
2. **Campaigns** (1 min). Every campaign says *All callers* and carries its tags (8th · CBSE, 9th · ICSE,
   10th · CBSE). *Term 2 fees – Class 8* was made from the ledger by Kavita this morning. Show **+ New
   campaign** without saving: open to all callers by default, class and board, or restricted to chosen callers.
3. **Fees** (1.5 min). 570 students with balances. Search "Bhosale": Riya Bhosale (10-A, CBSE), parent Sunita,
   ₹18,000 due now (Term 2), Term 1 paid in the opening import; fee items, payments with **Receipt**, and the
   calls to the parent (Ravi, "Will pay on date" today).
4. **Insights** (2.5 min). Read the 4-line brief. Pick **Oct fees – Class 10**: the forecast in ₹, "What closes
   the gap", the What-if sliders, best time to call, promises kept (measured against the fee ledger),
   coaching (Amit's long opening). Switch to **Course sales**: the script test, v7 winning.
5. **Reports** (1 min). Campaign **Oct fees – Class 10**, *Fees collection*: total due now and collected from the
   ledger (by mode: UPI, cash, cheque, bank), promised not yet paid, the 14 broken promises, "Send these back
   to callers". Then *Sales funnel*.
6. **Scripts and Settings** (1.5 min). **Start from a template**: the ready script library (filter Fees +
   Hinglish, Preview one, "Use this template"). Placeholders such as {name}, {student}, {amount_due} and
   {due_date} are filled from each lead on the call. Settings → **Common answers**: fill in "Where is the
   institute?"; callers get it at once. New scripts on request: our team adds them to the library.
7. **Manager** (30 s). Sign out, sign in as Rahul: same Home and Reports, no ₹.
8. **Caller Neha** (2 min). On the paired laptop as Neha (`app.html`): the **campaign picker** lists every open
   campaign by purpose with "N waiting"; tap class **8th**: *Term 2 fees – Class 8* stays, and the untagged
   campaigns stay too, marked "All classes". Pick **Course sales – Data Analytics**: **Shronit** is at the top
   (call back now), the card says *Source: a call to our office*. Type "number" in the answer search (or press
   `/`): **Where did you get my number?** answers "We got your number from a call to our office, on …".
   For the live call, the owner calls Shronit now (see "Live call").
9. **Caller Ravi and Accounts** (2 min). As Ravi: *Oct fees – Class 10*, broken promises first; the lead card
   shows the balance and last payment from the ledger and the due date; **Sunita Bhosale** promised ₹18,000
   for today. Then, in another browser, sign in as **Kavita** at `admin.html`: only Fees and Reports. Search
   "Bhosale", **Record a payment**: ₹18,000, mode UPI, reference `512345678901` (any 12 digits not used yet),
   today. The balance is 0, a receipt number shows, and the lead closes (paid). Back on Ravi's screen,
   refresh: Sunita Bhosale has left his list. In Reports Kavita sees Fees collection only (no campaign or
   caller filters).

Tip: in Reports pick the *Oct fees* campaign. Every fees lead's amount due is its student's balance, so
"Total due" is what is still owed (the closed Sept campaign adds only what Class 9 parents still owe).

## After the demo

- **Change the demo password** (run `reset-demo.sh` with a new `DEMO_PASSWORD`), and rotate the service role
  key if it was ever shown on screen or shared (Project Settings → API Keys).
- **Remove the demo before real institutes join** (or keep it only in a separate demo project):
  ```bash
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/demo/remove-demo.sql
  ```
  This deletes the institute and everything in it. The 8 logins stay; delete them in Authentication → Users
  (search `sunrise@example.com`, then Delete user for each), or with the service role key:
  ```bash
  node -e 'const {createClient}=require("@supabase/supabase-js");const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);(async()=>{const {data}=await db.auth.admin.listUsers({perPage:1000});for(const u of data.users.filter(u=>/\.sunrise@example\.com$/.test(u.email))){await db.auth.admin.deleteUser(u.id);console.log("deleted",u.email);}})()'
  ```
- The demo logins hold seats only in the demo institute; do not use them for anything else.

## Reset from anywhere (no laptop terminal)

The project has a server function `demo-reset` (supabase/functions/demo-reset). Signed in as the demo owner, a POST to
`https://ehkjtowrcsplidjjjjca.supabase.co/functions/v1/demo-reset` rebuilds the demo institute with today's dates
(about a minute). It refuses every other login. It runs the seed pinned to commit 6e7fb04, which is older
than the Phase A.2 demo (no ledger, no Accounts login): after this demo_seed.sql is merged and pushed, update
SEED_URL in the function to that commit and deploy it again. The database needs migration
`20261025130000_ledger_open_campaigns.sql` first.
