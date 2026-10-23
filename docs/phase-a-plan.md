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

## Sprint 7: Data foundation (cloud)
- [ ] M · `call_types` and `call_type_results` tables (key, label, needs date / amount / reason, counts as good result), seeded with the list above; admin-only write
- [ ] M · `campaigns` (type, script, dates, status, daily target) and `campaign_members` (seat ↔ campaign)
- [ ] L · `leads` in the cloud: name, phone, extra fields (student, class, amount due…), campaign, assigned seat, status, next call date, consent; RLS: a caller sees only leads assigned to them
- [ ] M · `call_outcomes`: add campaign, lead, result key (checked against the call type), promised date, amount, step times; keep the old `outcome` column working for old data
- [ ] M · Money rules: roles, "can see money", "hide money", money only through checked functions; audit money exports
- [ ] S · SQL tests for every new table and rule (same style as `supabase/tests`)

## Sprint 8: Campaigns and the caller screen
- [ ] L · Admin: campaigns list, 4-step "New campaign" (details, script, leads, callers), pause and close, add leads
- [ ] M · Lead upload to the cloud: reuse `import-check.js` (bad numbers, repeats), column matching for extra fields
- [ ] M · Share leads: equal parts or "whoever is free next"; move leads between callers
- [ ] L · Caller: campaign picker, cloud lead queue (callbacks and promises due first, then new), lead card with campaign fields, offline copy in IndexedDB and sync
- [ ] M · Caller: result buttons from the call type, with date and ₹ fields
- [ ] S · Caller page loads the campaign's script (replace `publishedScript()` "newest for institute")

## Sprint 9: Scripts and the AI script maker
- [ ] S · Script type on each script; only scripts of the same type can be used in a campaign
- [ ] M · Editor: link every ending to a result; pushback buttons per script (closes the two open Sprint 4 items)
- [ ] S · 3 starter templates: Fees reminder, Course sales, Admission follow-up (also used as examples in the AI prompt, which helps Haiku)
- [ ] L · AI draft server function (Supabase Edge Function; key stays on the server; Haiku 5.5, Sonnet 5.5 fallback): form → script JSON in the `script-model.js` format, checked by the same validator
- [ ] M · Safety checks: facts only from the form, "Check this" marks block publishing, no threats or false urgency, "do not call again" exit, easy-to-read score
- [ ] S · "Make simpler" (one line or whole script), "Try again"
- [ ] S · Usage limit 20 a month per institute; log tokens, model and cost per request; show usage in Settings
- [ ] S · Quality check: 10 test briefs (fees, sales, admission), compare Haiku and Sonnet drafts side by side before the pilot

## Sprint 10: New admin app
- [ ] M · One admin page with top tabs (Home, Insights, Campaigns, Scripts, Callers, Reports, Settings); merge `admin.html` and `script-editor.html`; keep the CSP and no inline scripts
- [ ] M · Home: today's numbers, callers right now, needs attention, campaign progress
- [ ] M · Callers: seats plus campaigns per caller, target, phone status, move leads
- [ ] M · Reports: Fees view (due, paid, promised, broken promises, due this week → send back to callers), Sales funnel, existing reports moved over
- [ ] S · Excel export (closes the open Sprint 3 item), with money rules
- [ ] S · Settings: call types, money switches, plan and AI usage, WhatsApp usage
- [ ] S · Browser test at 375px and desktop

## Sprint 11: Insights, Phase A
- [ ] M · Caller page records time spent on each script step (needed for coaching and drop-off)
- [ ] M · Forecast per campaign: pace + promise-kept rate, low–high range, target; "not enough data" under 50 calls
- [ ] S · What-if sliders (same model, in the browser)
- [ ] M · Best time to call heatmap (day × hour) per campaign and caller; "Set call hours" saves to the campaign
- [ ] S · Where calls end, by step (extend the existing script report)
- [ ] S · Promises kept, by days away
- [ ] M · Caller coaching: results vs team average, steps skipped, time per step; buttons for a note or practice mode
- [ ] M · Script A/B test: split calls between two versions, winner with "how sure" (needs enough calls)
- [ ] M · Weekly brief: 4 plain lines from rules, shown on Insights and sent by email (WhatsApp in Sprint 12)
- [ ] M · Charts: hover tooltips, table view for each chart, dark mode, phone width

## Sprint 12: WhatsApp
- [ ] S · Quick win (free): "Send on WhatsApp" opens the caller's own WhatsApp with the message filled in (`wa.me` link)
- [ ] M · Per-institute WhatsApp Business number setup: Meta business verification, connect in Settings
- [ ] M · Message templates per call-type ending (fees reminder, promise due, course details); submit for approval from the app
- [ ] L · Send from the app after a call, with consent check; delivery and read status; replies shown on the lead; STOP = do not message again
- [ ] S · Automatic reminder a day before a promised payment date (utility)
- [ ] S · Weekly brief to the admin on WhatsApp
- [ ] S · Message count and cost per institute in Settings

## Before release
- [ ] Pilot with one institute on a fees campaign (2 callers, 1 week)
- [ ] Check AI and WhatsApp cost logs after the pilot; set plan prices
- [ ] Privacy notice and data processing terms updated for cloud leads, money data and WhatsApp

## Next round (Phase B)
Lead scoring, script suggestions, "Ask about your calls", alerts.
