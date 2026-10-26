# Vector Autopilot: the admin sets it up once, Vector runs it

_26 Oct 2026. Direction from Pratik after the first institute demos: the owner should not spend hours in our tool.
They spend a little time on setup; Vector does the work behind the scenes, asks only when a decision is really
theirs, and shows them insights and growth they are happy to see._

## 1. What the owner's week looks like

| When | Owner does | Vector does behind the scenes |
|---|---|---|
| Day 1 (about 30 min) | Setup: classes and fees (import), callers (add), WhatsApp (connect), goals (pick), "ask me / do it" choices | Builds fee plans, picks scripts, fills common answers it can, plans the first calling lists |
| Every morning (1–2 min) | Opens Today: reads 3 numbers, taps OK on 0–3 decisions | Overnight: plans the day's calls per caller, creates lists that are due, queues reminders, releases stuck follow-ups |
| During the day (0 min) | Nothing, unless a phone alert says "needs your OK" | Re-orders every caller's list (promises due first, best time to call), balances work between callers, sends reminders, closes paid parents |
| Evening (0–1 min) | Optional: Today's collection sheet | Day closing, receipts sent, tomorrow planned |
| Monday (1 min) | Reads the weekly brief on WhatsApp | Week summary, growth versus last week and last term, 1–2 recommended decisions |

Success measures: owner time under 10 minutes a week after setup; at least 60% of decisions confirmed in one tap;
more fees collected by the due date than last term; admissions confirmed per 100 enquiries going up.

## 2. Three kinds of action (the trust model)

Every behind-the-scenes action belongs to one of three groups. The owner can move an action between "Do it" and
"Ask me" in Settings > Autopilot; money and deletions are always "Ask me".

| Group | Examples | Shown to the owner as |
|---|---|---|
| **Do it quietly** (always safe, reversible, no money) | re-order call lists, give stuck follow-ups to free callers, put promises due today first, pause a list when nobody is left to call, close leads that paid | "Vector did for you" feed (with Undo where possible) |
| **Do it, tell me, let me undo** (default on, owner can switch to Ask) | create the fees calling list 7 days before a due date from the fee plan, assign the best callers, send WhatsApp reminders to parents who agreed, send receipts, adopt a script that won its test with 95%+ certainty | Feed card with a 24-hour Undo |
| **Ask me first** (never automatic) | discounts, changing a fee plan, deleting anything, marketing WhatsApp (paid by Meta's marketing rate), adding a caller seat, contacting people without consent | "Needs your OK" card: one screen, everything filled in, Confirm / Change / Not now |

Guardrails always on: call hours, WhatsApp only with consent and within daily caps, never more than one reminder a day
per parent, Do-not-call is permanent, every automatic action is in the activity log with its reason, one switch pauses
all automation for the institute.

## 3. What the owner sees

**Today (the only screen most owners need)**
1. **Three numbers that matter**, each against the goal: Fees collected this term (₹ and % of due), Admissions
   confirmed this season (count and % of target), Team (calls today, people reached).
2. **Needs your OK** (0–3 cards). Each: what, why (numbers), expected result, one Confirm button.
3. **Vector did for you** (since yesterday): "Created *Term 2 fees – Class 8 State Board* (46 parents, ₹6.2 lakh),
   Ravi and Neha calling 7–9 pm", "Sent 18 payment reminders on WhatsApp", "Gave Amit's 12 waiting parents to Priya".
   Each line has Why and, where possible, Undo.
4. **Growth**: one simple chart, this term versus last term (fees collected by week; admissions by week), plus
   "Vector impact": money paid after a Vector call, follow-ups that would have been missed, hours of calling planned.

Everything else (lists, scripts, team, reports) stays one tap away but is optional.

**Owner phone**: a WhatsApp message only for "Needs your OK" items marked urgent (for example a list running far
behind before a due date) and the Monday brief. Tapping opens the card directly.

## 4. Setup in about 30 minutes (first-run wizard)

1. Institute: name, board(s), classes, working days and hours (defaults: Mon–Sat, 10 am–8 pm).
2. Students and fees: import the Excel (template provided) or pick "Start without fees" (admissions/sales only).
   Vector detects classes, sections, boards and builds a fee plan per class from the sheet; owner confirms.
3. Team: add callers (name + phone); Accounts person if any.
4. Goals: fees collected by due date (default 90%), admissions this season (number), optional sales goal.
5. WhatsApp: connect now or later (reminders and receipts wait until connected).
6. Autopilot choices: three toggles with recommended defaults ("Create calling lists for me", "Send reminders to
   parents who agreed", "Balance work between callers"). Everything else follows section 2.
7. Common answers: 5 short questions (address, landline, website, fee range, discount policy).

At the end Vector shows the plan for the next 2 weeks ("3 calling lists will start, about 420 calls, 2 callers")
and the owner taps Start.

## 5. Behind the scenes: the jobs

| Job | When | What it does |
|---|---|---|
| Plan fees lists | nightly + when a fee plan or payment changes | For each fee due in the next 7 days with unpaid students, create (or top up) the class's fees list with the right template, callers, hours, target |
| Plan admissions | nightly + when enquiries arrive | Enquiries older than 24 h uncalled go first; season list created when the first enquiries come in |
| Daily call plan per caller | 6 am | Each caller's list ordered: promises due today, callbacks due, best-time-now, then new; daily target set from pace needed |
| Balance work | every 15 min while callers work | Release follow-ups of idle callers (existing rule), move waiting leads to callers with spare capacity in that list |
| Reminders | 9 am and 6 pm | WhatsApp (consent only): day before a promised date, on the due date, after a missed date (once) |
| Close and clean | after each payment / nightly | Close paid parents, pause finished lists, mark wrong numbers, find duplicate students/leads for review |
| Learn | nightly | Caller scores per call type (promises kept, admissions confirmed per 100 picked-up calls), best hours per class, script results, what suggestions get accepted |
| Insights | nightly + Monday | Health line per list, forecast versus goal, 1–2 recommended decisions, weekly brief |

## 6. Architecture

- **Database (Supabase Postgres)**
  - `institute_goals` (fees % by due date, admissions target, season dates), `autopilot_settings` (per action
    type: off / ask / auto; global pause), `automation_runs` (job, institute, started, finished, counts, error).
  - `suggestions` (institute, kind, dedupe_key, title, why jsonb (the numbers), impact jsonb, plan jsonb (the
    pre-filled settings), status new/accepted/dismissed/snoozed/expired/auto_done, undo jsonb, expires_at,
    decided_by, decided_at). Unique (institute, dedupe_key) while open.
  - `caller_scores` (seat, call type, period, picked-up calls, good results, promises kept rate, score) refreshed
    nightly; `best_hours` per institute/class.
  - Functions: `autopilot_plan(inst)` (runs the rules, writes suggestions, executes "auto" ones through the
    existing RPCs), `accept_suggestion(id, overrides jsonb)` (one transaction, audit), `undo_suggestion(id)`,
    `dismiss_suggestion(id, snooze)`. Each rule is a small SQL function returning candidate suggestions, so new
    rules are added without touching the rest.
- **Scheduling**: `pg_cron` in Supabase for nightly / morning / 15-minute jobs; plus "plan on event" (payment
  recorded, fee plan applied, lead upload, call saved) and "plan when Today opens and the last plan is over 15
  minutes old". Jobs are idempotent (dedupe keys), so running twice does nothing twice.
- **Messages**: WhatsApp sending reuses the existing whatsapp-send function with caps and consent checks; the owner
  brief reuses weekly-brief.
- **AI**: only to word insights in plain English / Hinglish from numbers the database computed (Haiku, about ₹0.01
  per card). No AI decides money, contacts or deletions.
- **Explainability**: every suggestion and automatic action stores the numbers behind it; "Why?" shows them.
- **Safety**: money rules and roles apply unchanged; Accounts never sees calling suggestions; managers see only
  calling ones; the global pause stops all jobs at once.

## 7. Build phases

| Phase | Scope | Size |
|---|---|---|
| 1. Engine + Today | goals, autopilot settings, suggestions table and API, 5 rules (fees due by class → list; missed promises → remind/prioritise; enquiries uncalled → prioritise; list behind pace → add caller/hours; setup gaps), one-screen confirm with defaults (template, callers by score, hours, target), Vector did for you feed with Undo, the three numbers, simple filter bar with quick filters on Fees / list leads / Team | 1–1.5 weeks |
| 2. Behind the scenes | pg_cron jobs, daily call plan per caller, balance work, automatic reminders with caps, close and clean, caller scores and best hours nightly, list health card | 1 week |
| 3. Growth and setup | 30-minute setup wizard, Growth chart (term vs term, Vector impact), owner WhatsApp alerts and Monday brief with actions, autopilot settings page | 1 week |
| 4. Learning | suggestion acceptance learning, AI wording in English/Hinglish, script auto-adopt with ask, Hindi review | 1 week |
