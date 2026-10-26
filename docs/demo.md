# Sales demo: "Sunrise Coaching Academy (Demo)"

A ready-made, busy institute for sales demos. Prospects sign in with an email and a password and see every
screen full: Today (calls, forecast, reports), Fees, Calling (calling lists and call scripts), Team, Settings
and the caller screen.

**Everything in it is fake.** The people are made up and every phone number is in the +91 9999xxxxxx block,
used here only as an obviously fake range. Never call these numbers and never put real data in this institute.
The one exception is **Shronit** (+91 96197 07601) in *Course sales – Data Analytics*: a real person who agreed
to take a live call during demos (see "Live call" below). Do not add other real numbers.

Files: `supabase/demo/` (`reset-demo.sh`, `create-demo-users.mjs`, `demo_seed.sql`, `remove-demo.sql`).

## The logins

All eight use the one password you choose (`DEMO_PASSWORD`, at least 10 characters).

| Login | Who | What they see |
|---|---|---|
| `owner.sunrise@example.com` | Anita Sharma, Owner | All five tabs, with ₹ amounts |
| `manager.sunrise@example.com` | Rahul Verma, Manager | Today, Calling and Team, no ₹: counts only |
| `ravi.sunrise@example.com` | Ravi, caller | Oct fees – Class 10 (fees reminders) |
| `priya.sunrise@example.com` | Priya, caller | Course sales – Data Analytics |
| `neha.sunrise@example.com` | Neha, caller | Course sales – Data Analytics (the best caller) |
| `amit.sunrise@example.com` | Amit, caller | Oct fees – Class 10 (no calls today, long openings) |
| `sana.sunrise@example.com` | Sana, caller | Admission follow-up (phone offline today) |
| `accounts.sunrise@example.com` | Kavita Joshi, Accounts | The Fees tab only: students, balances, payments, the collection report, fees calling lists (always with ₹) |

Owner, manager and accounts sign in at `admin.html`; callers at `app.html`. Every calling list is open to all
callers, so any caller can pick any running list (the names in the table are where each one usually works).
The institute has 8 team places and all 8 are used, so nobody can send invite emails from the demo.

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

Load it fresh so the Today tab is today. Best 15–30 minutes before the demo, after 10 am India time
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

The admin page (`admin.html`) has at most five tabs: **Today, Fees, Calling, Team, Settings**. It opens in
simple mode; **Your account → Show advanced options** (or the switch at the top of Settings) shows the rarely
used fields and panels too. Old bookmarks (#home, #campaigns, #reports …) still work: they open the new place.
On a phone the tabs are a bar at the bottom of the screen.

**Owner (Anita)**: all five tabs.
- **Today**: about 140 calls today ("x% more than yesterday"), ~60% picked up, talk time, 9 joined and 13
  interested on sales, and *Collected today* (Paid (office): what the fees office recorded today). Callers right
  now: Neha and Ravi on a call, Priya ready, Amit no calls for 45 min, Sana's phone offline. Needs your
  attention: fee promises due today not paid yet, Sana's phone, "Course sales: ~40% of picked-up calls end at
  the Fees step", Amit idle, and **4 follow-ups went to other callers today** (walk-in enquiries in Admission
  follow-up that Priya took 3 days ago and has not worked since; their call back came due this morning, so the
  next free caller gets them).
- Below that: **This week in 4 lines**, and the **forecast** for a calling list with *What closes the gap* and
  *Apply plan*. Everything else from the old Insights tab (what-if sliders, compare, best time to call, where
  calls end, promises kept, caller coaching, the v6 vs v7 script test) is under **More analysis**, closed until
  you open it.
- The **Reports** button (top right of Today, and in Calling): Call results, Weekly summary, Enquiry to
  admission (the old sales funnel), Why calls are lost (pick Course sales, v7). Each has **Download Excel**.
- The first time, a **Getting started** card lists what is left to set up (import students and fees, fill
  common answers n of 5, add a caller, start a calling list from a template, connect WhatsApp). In the demo
  only "Fill common answers" and "Connect WhatsApp" are open; **Hide** closes the card for good on that browser.
- **Calling → Calling lists** (the old Campaigns), all open to all callers and tagged by class and board:
  - *Oct fees – Class 10* (10th · CBSE, fees): 240 parents, Ravi and Amit, Term 2 overdue since 15 days ago.
    Call script "Overdue fees – Class 10".
  - *Term 2 fees – Class 8* (8th · CBSE, fees): made from Fees by Kavita this morning; ~133 parents with Term 2
    due in 6 days (one entry for twins who share a phone, two students with no phone left out), waiting for the
    next free caller. Call script "Term 2 reminder – Class 8".
  - *Class 9 admission enquiries* (9th · ICSE, admission): 64 new enquiries from the website, the admission fair
    at Phoenix Mall and calls to the office. Call script "Class 9 admission enquiry".
  - *Course sales – Data Analytics* (sales): 421 people, Priya and Neha, the v6 vs v7 script test.
  - *Admission follow-up* (admission): 154 enquiries, Sana.
  - *PTM reminder – Nov* (not started) and *Sept fees – Class 9* (closed, all 150 Class 9 parents called).
- Every person on a list says where their number came from ("the enquiry form on our website", "our admission
  fair at Phoenix Mall", "a call to our office"; fees: "your child's admission form"), so "Where did you get my
  number?" has an answer.
- **Calling → Call scripts**: the institute's own scripts first. Three were made from the template library, each
  with version 1 as copied (with its "Check this" marks) and version 2 *ready for callers* with the institute's
  facts filled in: Overdue fees – Class 10, Term 2 reminder – Class 8, Class 9 admission enquiry. Also Fees
  reminder (used by the closed Sept list), Course sales, Admission check and Late fee warning (not ready, with
  a "Check this" mark). **+ New script** opens 6 ready scripts for the kinds of calls the institute makes, and
  **See all 26** opens the whole library with filters (purpose, class, board, language). The AI script maker
  is the Vector team's own tool; institutes do not see it.
- **Fees** (also what Kavita sees). *This month*: Due now, Collected this month, Promised, not paid yet, and
  Promised date missed, then 570 students (Class 8 CBSE 180 in sections A–C, Class 9 ICSE 150, Class 10 CBSE
  240, plus about 10 new students from "Admission confirmed" calls with no fee plan yet). Fee items for 2026-27:
  Term 1 and Term 2 tuition, and a bus fee per term for bus users. An opening balance import 58 days ago (Term 1
  "paid so far"; a few still owe part of it). About 400 payments in the last 8 weeks, mostly UPI, then cash,
  cheque and bank transfer, with references, and 3 reversals (a bounced cheque, a UPI payment first put on the
  wrong student, a cash payment typed twice). **Collection report** (next to Students): the fees collection
  report for any dates (this month by default) with collected by mode and by day, the promises due this week
  against what the office recorded, "Send these back to callers", and Download Excel. Its four cards are the
  same numbers as the Fees cards for the same dates. **Fee plan** (next to Students): Class 8 (CBSE), Class 9 (ICSE) and Class 10 (CBSE)
  for 2026-27, each with Term 1 and Term 2 tuition and a bus fee per term for bus students; every student already
  has them, so "Apply" says "Nothing to add" (Class 8 also has the rule "Sibling 10% on tuition"). Six students
  have a **discount**: the Class 8 twins' second child (Sibling 10%, by Kavita) and three teachers' children in
  Class 9 and 10 (Staff child 50% on tuition, approved by Anita). **Today's collection** (the button at the top of
  Fees): this morning's payments at the office (cash, UPI, a cheque to bank, one taken by Anita, a cash entry
  typed wrong and reversed) plus the payments from today's calls, by mode and by person, in figures and words,
  with Print and Download Excel. **Import from Excel** and **+ Add student** sit side by side
  (one student by hand, with fees and "paid so far"; it warns about the same admission number or the same name and
  phone first), and **Edit details** is on each student's page. Every calling list has **Import from Excel** and
  **+ Add lead**, and New calling list can take leads typed **by hand**. Each import has **Download a ready Excel
  template**. Use only 9999xxxxxx numbers when you show adding by hand in the demo.
- **Team**: one row per person: Anita, Rahul, the five callers and Kavita (Accounts, "No phone needed"), with
  today's calls against the target, what they are doing now, and a hint under the name ("Not calling today",
  few calls picked up, short calls). **Edit** on a row: role, money access (managers), daily target, notes for
  today (one about Priya skipping the questions), **Give their calls to others**, **Sign out their phone**,
  Remove. Advanced options add targets and notes columns, calling lists for chosen callers only and "give their
  calls to one person".
- **Settings**: institute name and time zone, **Common answers** (5 answers that need the institute's facts,
  e.g. "Where is the institute?", "How much is the fee?": callers see them only once they are filled in),
  WhatsApp **not connected** (so you can show how to connect). Advanced options add call result options (with
  two added results: "Asked for concession", "Admission confirmed"), money, plan, terms and the activity log.
- **Your account** (next to Sign out): change your password, email yourself a reset link, show advanced options.

**Manager (Rahul)**: Today, Calling and Team (no Fees and no Settings: he cannot see money). No ₹ anywhere: the
fees forecast counts payments, Today shows "Fees: paid N calls", reports show counts, Excel has no ₹ columns.
An owner who gives him money access (Team → Edit → Can see money) gives him the Fees tab too: who owes and how
much, but he cannot record payments.

**Accounts (Kavita)**: only Fees, always with ₹ (the fees office needs amounts), with its Collection report.
The students list by class, section and board with the balance due now, the total for the year and the last
payment; "Only with dues" shows ~160 Class 10 parents with Term 2 overdue, ~19 Class 9 and a few Class 8. On a
phone each student is a small card with **Record payment**. A student page: fee items, payments with mode and
reference (UPI UTRs, cheque numbers, receipts), reversals with their reason, and the calls made to the parent.
Things to look for:
- **Parent said they paid, not in Paid (office)**: a few Oct fees calls ended "Says already paid" in the last
  10 days with no matching payment. Open the student, see the call, and check with the parent or the bank.
- The bounced cheque (Class 8): reversed, so the student owes Term 2 again and is in *Term 2 fees – Class 8*.
- *Term 2 fees – Class 8* was made here (**Call parents with dues**: class 8th, CBSE, due by Term 2's due date).
- She cannot see Today, Calling, Team or Settings.

**Live call (Shronit)**: Shronit is in *Course sales – Data Analytics*, Neha's first due call back (source "a
call to our office", no WhatsApp consent). Sign in as Neha on the paired laptop and he is at the top of her list;
the owner calls him live. Reset the demo afterwards to put him back.

**Caller (Ravi)**: his Oct fees list with missed promised dates first, the lead card (parent, student, class,
amount due, last call), the call script step by step, answers to objections, and the result options with date
and ₹ fields.

## A 15-minute walkthrough

Eight logins: owner, manager, five callers and Accounts. Every running calling list is open to every caller and
tagged by class and board; callers pick the list, the call script follows it.

1. **Owner → Today** (3 min). "This is today, live." The tiles (*Collected today* is what the fees office
   recorded), callers right now (point at Sana's phone and Amit idle; Kavita is not listed, she is Accounts),
   then *Needs your attention*: **See list** on the promises due today, and the 4 follow-ups that went to other
   callers ("nobody waits on a caller who stopped"). Scroll: **This week in 4 lines**, then the forecast for
   **Oct fees – Class 10** in ₹ and *What closes the gap*. Open **More analysis** only if asked: best time to
   call (7–9 pm wins), promises kept, coaching (Amit's long opening), the v6 vs v7 test on Course sales.
2. **Calling** (1.5 min). *Calling lists*: every list says *All callers* and carries its tags (8th · CBSE,
   9th · ICSE, 10th · CBSE). *Term 2 fees – Class 8* was made from Fees by Kavita this morning. Show **+ New
   calling list** without saving. *Call scripts*: the institute's own scripts; **+ New script** shows six ready
   ones for fees and admissions (Preview one, "Use this template"); **See all 26** for the whole library.
   Placeholders such as {name}, {student}, {amount_due} and {due_date} are filled from each person on the call.
3. **Fees** (1.5 min). The four cards for this month, then 570 students with balances. Search "Bhosale": Riya
   Bhosale (10-A, CBSE), parent Sunita, ₹18,000 due now (Term 2), Term 1 paid in the opening import; fee items,
   payments with **Receipt**, and the calls to the parent (Ravi, "Will pay on date" today). Open **Collection
   report**: the same four numbers, by mode (UPI, cash, cheque, bank), promises due this week, "Send these back
   to callers", Download Excel.
4. **Reports** (1 min). From Today: **Reports** → *Call results*, then *Enquiry to admission* and *Why calls are
   lost* (Course sales, v7). Download Excel on any of them.
5. **Team and Settings** (1.5 min). Team: one table, today's calls per person, "Not calling today" under Amit;
   **Edit** on Sana: give her calls to others, sign out her phone. Settings → **Common answers**: fill in "Where
   is the institute?"; callers get it at once (and the Getting started card on Today counts it). Turn on
   **Show advanced options** to show what was hidden (call result options, money, plan, activity log).
6. **Manager** (30 s). Sign out, sign in as Rahul: Today, Calling and Team only, no ₹.
7. **Caller Neha** (2 min). On the paired laptop as Neha (`app.html`): the **campaign picker** lists every open
   calling list by purpose with "N waiting"; tap class **8th**: *Term 2 fees – Class 8* stays, and the untagged
   lists stay too, marked "All classes". Pick **Course sales – Data Analytics**: **Shronit** is at the top
   (call back now), the card says *Source: a call to our office*. Type "number" in the answer search (or press
   `/`): **Where did you get my number?** answers "We got your number from a call to our office, on …".
   For the live call, the owner calls Shronit now (see "Live call").
8. **Caller Ravi and Accounts** (2 min). As Ravi: *Oct fees – Class 10*, missed promised dates first; the lead
   card shows the balance and last payment and the due date; **Sunita Bhosale** promised ₹18,000 for today.
   Then, in another browser (a phone is best), sign in as **Kavita** at `admin.html`: only Fees. Search
   "Bhosale", **Record payment**: ₹18,000, mode UPI, reference `512345678901` (any 12 digits not used yet),
   today. The balance is 0, a receipt number shows, and the lead closes (paid). Back on Ravi's screen,
   refresh: Sunita Bhosale has left his list. Kavita's **Collection report** now counts the payment in
   *Collected*, and so do the owner's Fees cards and *Collected today* on Today.

Tip: in the Collection report, turn on advanced options to pick one calling list (*Oct fees*). Every fees
person's amount due is their student's balance, so "Due now" is what is still owed.

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
