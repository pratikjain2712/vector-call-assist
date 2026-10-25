# Vector: Phase A task plan (campaigns, call types, AI scripts, new admin, Insights A, WhatsApp)

_24 Oct 2026. Feature details: `claude/vector-v2-campaigns-features.md`. UI mockup: "Vector Admin – UI" design artifact. Status: [ ] open · [x] done. Size: S (≤1 day), M (2–4 days), L (1 week+)._

## Decisions recorded (24 Oct)
1. Lead lists are stored in the cloud (needed for campaigns).
2. AI script drafts: limit 20 per institute per month for now; log the cost of every request to learn the real cost.
3. Fees "Paid" = what the caller marks, labelled "reported by caller".
4. Call types are data, not code: new types are added without a release. We collect needs from institutes and add the common types up front (list below, to confirm).
5. Mockup approved. Concern: money data. Show it only to people allowed to see it (see Money data rules).
6. Insights: Phase A in this round. Phase B (lead scoring, script suggestions, ask a question, alerts) next round.
7. WhatsApp integration is in scope (this changes the earlier "not building WhatsApp campaigns" line; we send call follow-ups and reminders, not bulk promotions).
8. AI model: cheapest model (Claude Haiku 5.5) by default for drafts and "Make simpler". If a draft fails the script checks twice, retry once with Sonnet 5.5. Model name is a server setting, so it can change without a release.

## Needed from Pratik (collect before and during the build)
Status: [ ] open · [x] done.

Access and accounts:
- [ ] GitHub: push access for `vector-call-assist` in the session, or keep pushing from the laptop (and confirm whether the laptop has unpushed work after 22 Oct)
- [ ] Supabase: who runs `supabase db push` and deploys Edge Functions (Pratik on the laptop, or a CLI access token set up for the laptop shell)
- [ ] Supabase plan: Pro before the pilot (daily backups, needed once real fee data is stored)
- [ ] Anthropic API: console account, billing, monthly spend limit (suggest $10), key saved only as a Supabase secret (`supabase secrets set`), never pasted in chat
- [ ] Email sender for the weekly brief and alerts (e.g. Resend or SendGrid) and a sending domain
- [ ] Domain for the product (needed for email, and as the website for Meta business verification)

WhatsApp (start early, Meta checks take days to weeks):
- [ ] Provider: Meta Cloud API directly, or a provider (Gupshup, Interakt, AiSensy …)
- [ ] Who pays message costs: each institute on its own Meta account, or through us with a markup
- [ ] For our own test number: Meta Business account, business verification documents, a phone number not used on the WhatsApp app, display name

Product decisions:
- [ ] Confirm the call type list below
- [ ] Prices (pending since 12 Oct), including the script add-on now that AI cost is small
- [ ] Trial end: block after the trial (now 5 days in migration 0011) or show a warning only
- [ ] Old open items: upgrade xlsx 0.18.5, rotate the debug keystore, keep `READ_CALL_LOG` (needed for answered yes/no), drop `CHANGE_NETWORK_STATE`, keep `admin.html` out of the public site until tested

Pilot and checks:
- [ ] Pilot institute: name, admin email, 2 callers, real fee script facts (amount, due date, late fee, ways to pay, part-payment rule)
- [ ] A sample lead sheet with fake names and numbers in their real column format
- [ ] Phone tests on the Android phone at the end of each sprint that touches calls
- [ ] Native Hindi speaker for Hindi and Hinglish text
- [ ] Privacy notice and data processing terms checked by a lawyer (DPDP Act; lead, money and WhatsApp data)

## Call types to seed (confirm)
- Sales: Joined, Interested, Will think, Not interested (reason)
- Fees collection: Paid (₹), Will pay on date (date + ₹), Paid part (₹), Says already paid, Refused (reason)
- Follow-up / appointment: Confirmed, New date (date), Cancelled (reason)
- Admission enquiry: Visit booked (date), Form sent, Not this year, Joined elsewhere
- Absence call (to parents): Reason given (sick, travel, other), Will come on (date), Needs counsellor
- Event or PTM reminder: Coming, Not coming, Maybe
- Feedback or survey: Rating 1–5 + comment, Refused
- Renewal / re-enrolment: Renewed, Will renew on (date), Not renewing (reason)
- Every type also has: No answer, Busy, Wrong number, Call back later (date), Do not call again

## Money data rules
- Roles: Owner (sees everything), Manager (no ₹ unless allowed), Caller.
- A "Can see money" switch per admin seat; an institute switch "Hide money everywhere" (reports show counts only).
- Callers see the amount due of the lead on the call only, never totals or other leads.
- Money in exports only for people who can see money; every money export is written to the audit log.
- We store amounts and dates only. No bank, card or UPI details.
- Amounts are labelled "reported by caller" until matched with the institute's fee records (later).
- Privacy notice and data processing terms cover lead and money data (India DPDP Act).

## Costs to watch
- **AI drafts, default Haiku 5.5** ($0.10 in / $0.50 out per million tokens, prompts up to 100K tokens). A full draft is about 6k tokens in and 12k out ≈ $0.007 ≈ ₹0.60. 20 drafts ≈ ₹12 a month per institute. Sonnet 5.5 fallback ($2 / $10) ≈ ₹11–12 per draft, used only when Haiku fails the checks. Prompt caching cuts the repeated instructions further. Log tokens and cost per request; review after 1 month.
- **WhatsApp** (Meta India rates, June 2026, before GST and provider fee): utility ₹0.115, marketing ₹0.86, authentication ₹0.115 per message. Fee reminders and promise reminders are utility. Course details with an offer are likely marketing. Example: 5 callers × 120 messages a day × 26 days ≈ 3,100 messages ≈ ₹360 as utility, ≈ ₹2,700 as marketing, plus GST and the provider's fee.

## Packaging and prices (suggested 24 Oct, not final)
- Basic: calling, campaigns, cloud leads, result buttons, Home, Reports, Fees and Sales views, Excel, Insights that do not need a script. ₹499 a seat a month (₹399 yearly).
- Scripts add-on: guided scripts, editor, templates, AI script maker (20 drafts a month per institute), script test, step coaching, where calls end. ₹299 a seat a month (₹239 yearly).
- Same volume discounts as the website today. Trial: everything on for 5 days.
- AI top-up later only if the cost log shows need (e.g. ₹299 for 50 drafts). WhatsApp: pass-through or the institute's own Meta account (decision open).
- [x] S · Per-institute feature switches `scripts` and `ai_drafts`, checked on the server (AI function, script publishing) and in the UI ("Add Scripts to use this"); trial turns both on
- [ ] S · Website pricing section updated once prices are confirmed (after the pilot) _(open: prices are not confirmed yet)_

## Sprint 7: Data foundation (cloud)
- [x] M · `call_types` and `call_type_results` tables (key, label, needs date / amount / reason, counts as good result), seeded with the list above; admin-only write
- [x] M · `campaigns` (type, script, dates, status, daily target) and `campaign_members` (seat ↔ campaign)
- [x] L · `leads` in the cloud: name, phone, extra fields (student, class, amount due…), campaign, assigned seat, status, next call date, consent; RLS: a caller sees only leads assigned to them
- [x] M · `call_outcomes`: add campaign, lead, result key (checked against the call type), promised date, amount, step times; keep the old `outcome` column working for old data
- [x] M · Money rules: roles, "can see money", "hide money", money only through checked functions; audit money exports
- [x] S · SQL tests for every new table and rule (same style as `supabase/tests`)

## Sprint 8: Campaigns and the caller screen
- [x] L · Admin: campaigns list, 4-step "New campaign" (details, script, leads, callers), pause and close, add leads
- [x] M · Lead upload to the cloud: reuse `import-check.js` (bad numbers, repeats), column matching for extra fields
- [x] M · Share leads: equal parts or "whoever is free next"; move leads between callers
- [x] L · Caller: campaign picker, cloud lead queue (callbacks and promises due first, then new), lead card with campaign fields, offline copy in IndexedDB and sync
- [x] M · Caller: result buttons from the call type, with date and ₹ fields
- [x] S · Caller page loads the campaign's script (replace `publishedScript()` "newest for institute")

## Sprint 9: Scripts and the AI script maker
- [x] S · Script type on each script; only scripts of the same type can be used in a campaign
- [x] M · Editor: link every ending to a result; pushback buttons per script (closes the two open Sprint 4 items)
- [x] S · 3 starter templates: Fees reminder, Course sales, Admission follow-up (also used as examples in the AI prompt, which helps Haiku)
- [x] L · AI draft server function (Supabase Edge Function; key stays on the server; Haiku 5.5, Sonnet 5.5 fallback): form → script JSON in the `script-model.js` format, checked by the same validator
- [x] M · Safety checks: facts only from the form, "Check this" marks block publishing, no threats or false urgency, "do not call again" exit, easy-to-read score
- [x] S · "Make simpler" (one line or whole script), "Try again"
- [x] S · Usage limit 20 a month per institute; log tokens, model and cost per request; show usage in Settings
- [x] S · Quality check: 10 test briefs (fees, sales, admission), compare Haiku and Sonnet drafts side by side before the pilot

## Sprint 10: New admin app
- [x] M · One admin page with top tabs (Home, Insights, Campaigns, Scripts, Callers, Reports, Settings); merge `admin.html` and `script-editor.html`; keep the CSP and no inline scripts
- [x] M · Home: today's numbers, callers right now, needs attention, campaign progress
- [x] M · Callers: seats plus campaigns per caller, target, phone status, move leads
- [x] M · Reports: Fees view (due, paid, promised, broken promises, due this week → send back to callers), Sales funnel, existing reports moved over
- [x] S · Excel export (closes the open Sprint 3 item), with money rules
- [x] S · Settings: call types, money switches, plan and AI usage, WhatsApp usage
- [x] S · Browser test at 375px and desktop

## Sprint 11: Insights, Phase A
- [x] M · Caller page records time spent on each script step (needed for coaching and drop-off)
- [x] M · Forecast per campaign: pace + promise-kept rate, low–high range, target; "not enough data" under 50 calls
- [x] S · What-if sliders (same model, in the browser)
- [x] M · Best time to call heatmap (day × hour) per campaign and caller; "Set call hours" saves to the campaign
- [x] S · Where calls end, by step (extend the existing script report)
- [x] S · Promises kept, by days away
- [x] M · Caller coaching: results vs team average, steps skipped, time per step; buttons for a note or practice mode
- [x] M · Script A/B test: split calls between two versions, winner with "how sure" (needs enough calls)
- [ ] M · Weekly brief: 4 plain lines from rules, shown on Insights and sent by email (WhatsApp in Sprint 12) _(open: built and shown on Insights; the Monday email needs an email sender account, the `weekly-brief` deploy and the pg_cron job in `docs/weekly-brief.md`)_
- [x] M · Charts: hover tooltips, table view for each chart, dark mode, phone width

## Sprint 12: WhatsApp
- [x] S · Quick win (free): "Send on WhatsApp" opens the caller's own WhatsApp with the message filled in (`wa.me` link)
- [ ] M · Per-institute WhatsApp Business number setup: Meta business verification, connect in Settings _(open: connect and disconnect in Settings are built and tested on the fake backend only; Meta business verification and a real number are not done)_
- [ ] M · Message templates per call-type ending (fees reminder, promise due, course details); submit for approval from the app _(open: built (Settings), but submitting and the approval check have never run against Meta)_
- [ ] L · Send from the app after a call, with consent check; delivery and read status; replies shown on the lead; STOP = do not message again _(open: sending after a saved result is wired on the caller page with the consent check; delivery and read status, replies and STOP come through `whatsapp-webhook`, never run against Meta; replies are not shown on the lead card yet)_
- [ ] S · Automatic reminder a day before a promised payment date (utility) _(open: `whatsapp-reminders` is built; needs the deploy and the daily pg_cron job in `docs/whatsapp-setup.md`)_
- [ ] S · Weekly brief to the admin on WhatsApp _(open: built (lines fixed in migration 0030); needs the deploy and the Monday job, never run against Meta)_
- [x] S · Message count and cost per institute in Settings

## From the mockup review (24 Oct)
Decisions on the open items: "Compare with" and "Apply plan" are built in Sprint 11; Home numbers refresh every minute (polling, not Realtime); practice mode is built; the three Phase B cards (Call these first, script suggestion, Ask about your calls) stay out of the Insights tab until Phase B.

- [x] S · Home: day (Today, Yesterday, This week) and campaign filters; refresh every minute
- [x] S · Home: "Needs your attention" rules (promises due today, phone offline, a step where many calls end, a caller idle 45 min)
- [x] S · Callers: role (Owner, Manager, Caller) and "Can see money" switch on Edit caller; a caller can be on more than one campaign
- [x] S · Settings: all 8 call types, add a new type and its results; "Hide money everywhere"; WhatsApp connection, message count and cost; admin activity log page
- [x] S · Money labels: "reported by caller" on every paid amount; managers without money access see counts only, and their Excel export has no ₹ columns
- [x] S · New campaign: the type list comes from `call_types` (all 8, not 3)
- [x] M · Caller screen: the waiting lead list (callbacks and promises due first), with the call card beside it
- [x] S · Caller screen: "Send on WhatsApp" opens WhatsApp with the message filled in (replaces "Copy WhatsApp message")
- [x] M · Practice mode: a caller walks a script with a pretend lead; nothing is dialled or counted; the admin can send a caller to it from coaching
- [x] S · Insights: "Compare with" (last 7 days or an earlier campaign)
- [x] S · Insights: "What closes the gap" list with "Apply plan" (sets the What-if values on the campaign: callers, daily target, call hours)
- [x] S · Sales funnel needs the step each call reached ("heard the pitch" = reached the pitch step)
- [ ] S · Design canvas: remove the empty "Artboard 1" on Page 2 _(open: design artifact, not in this repo)_

## Left open after the Phase A integration
- [ ] S · Server check of the Scripts add-on in `admin_script_report` and `admin_loss_insights` ("Why calls are lost" is locked only in the screen)
- [ ] S · Results by outcome: filter by campaign on the server (the old function has no campaign argument; the tab says so)
- [ ] S · Script editor: mark the pitch step (`"pitch": true`); until then the funnel uses the middle step and says so
- [ ] S · Caller page: WhatsApp replies on the lead card (`VectorWhatsApp.leadMessages`), and templates with blanks the caller types (only templates without typed blanks are offered now)
- [ ] S · Weekly summary report: follow the campaign and caller filters (it keeps its own week picker)
- [ ] S · Live-Supabase run of the new browser tests (they ran on the fake backend only) and two callers asking `next_free_lead` at the same moment
- [ ] S · Native Hindi review of the new caller strings (`camp.*` in `web/js/i18n.js`, drafts) and of the AI Hindi/Hinglish output

## Phase A.2: open campaigns and the fee ledger (from the first demo, 25 Oct)
Feedback from the first institute demo: admins have no time to attach callers to campaigns; callers should pick the campaign (e.g. "8th · CBSE · Fees"), the script follows the campaign, and fees need a real ledger, fed by admissions, so the institute sees what is actually paid, when and how.

Decisions (25 Oct): payments are recorded by a new Accounts role (and owners), callers record promises only; UPI and cash are entered by hand with the reference (payment links and automatic matching later); every running campaign is open to every caller unless the admin restricts it; students come from an Excel import and from admissions confirmed in Vector.

- [x] S · Answer search (/) and the helper column work for every script, not only the built-in one
- [x] M · Open campaigns: campaigns open to all callers by default, optional restriction to chosen callers; tags for class (e.g. 8th) and board (CBSE, ICSE, State); open campaigns hand out the next free lead
- [x] M · Caller: campaign picker grouped and filtered by type, class and board; the campaign's script loads on pick
- [x] S · Admin: adding a caller is the only step; no campaign membership needed
- [x] L · Ledger: students (class, section, board, admission no, parents and phones), fee items (head, amount, due date, academic year), payments (amount, date, mode UPI/cash/cheque/card/bank, reference, recorded by; corrections by reversal, never deleted), balance per student
- [x] S · Accounts role: records payments, sees money and the ledger; cannot change callers or campaigns
- [x] M · Admin Fees tab: students list with filters and balance, student page (fees, payments, calls), record payment, receipt, Excel import of students and fees
- [x] M · Fees campaign from the ledger: pick class, board and due date; leads carry the student and the live balance; a recorded payment updates the lead and stops calls when nothing is due
- [x] S · Admission confirmed on a call becomes a student (fee plan added by Accounts)
- [x] M · Reports, Home and Insights: collected = ledger payments; promised vs actually paid; promises kept measured against the ledger (migration `20261025150000_ledger_reports.sql`)
- [x] S · Caller lead card shows the ledger: balance, last payment (amount, date, mode)
- [x] M · Demo data: students, fee plans and payments; campaigns tagged by class and board and open to all callers
- [x] L · Central template library: the Vector team writes and updates templates (AI on our side); every institute picks from the shared library (by purpose, class, board, language); new or changed templates reach all institutes without a release
- [x] S · AI script maker moves to the Vector team's own page; institutes get the library and the editor instead (pricing copy updated)
- [x] S · Placeholders filled on the call: {name}, {me}, {institute}, {student}, {class}, {board}, {amount_due}, {due_date}, {course}, {source}, {source_date}
- [x] M · Common answers in every script's search and helper column, e.g. "Where did you get my number?" (answered from the lead's source and date), "Is this a sales call?", "I'm on DND", "Don't call again"; the lead card shows where the lead came from
- [x] S · Cold-calling templates: permission first, honest source, easy exit
- [x] Integration (25 Oct, migration `20261025180000_phase_a2_integration.sql`): {due_date} on ledger leads (the campaign's due-by date, else the student's oldest unpaid fee), Accounts seats never listed as callers, common answers in the library's order, faster balances (`institute_tz`, `student_balance_rows`); homepage "Ready script library" replaces the AI script maker; walkthrough on the local stack with the demo data.

Migrations of Phase A.2, to apply in this order after `20261025035110`: `20261025120000_campaign_script_pushbacks.sql`, `20261025130000_ledger_open_campaigns.sql`, `20261025140000_template_library.sql`, `20261025150000_ledger_reports.sql`, `20261025180000_phase_a2_integration.sql`.


## Before release
- [ ] Pilot with one institute on a fees campaign (2 callers, 1 week)
- [ ] Check AI and WhatsApp cost logs after the pilot; set plan prices
- [ ] Privacy notice and data processing terms updated for cloud leads, money data and WhatsApp

## Next round (Phase B)
Lead scoring, script suggestions, "Ask about your calls", alerts.
