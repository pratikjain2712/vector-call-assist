# AI script maker: quality check (Haiku 5.5 vs Sonnet 5.5)

_23 Oct 2026, Sprint 9. Logic: `supabase/functions/ai-script-draft/logic.mjs` (the same prompt, schema and checks the Edge Function uses). Each brief went through the real Messages API once with each model, side by side, with the default settings (effort `low`, structured output, cached system prefix). 22 API calls in total: 20 for the comparison, 2 to re-check a prompt change (below). Total cost: $0.25._

## Result in one line

Keep **Claude Haiku 5.5 as the default** and Claude Sonnet 5.5 as the fallback. All 20 drafts passed every check on the first try, so the fallback never ran. Haiku costs a tenth of Sonnet (about $0.0023, roughly ₹0.20, per draft) and the drafts are as usable. Haiku is slower (about 20 s against 13 s) and its Hindi was more formal until the prompt change below.

## The 10 briefs

| # | Type | Language | Who | What the call is for (short) |
|---|---|---|---|---|
| 1 | Fees | Simple English | Parents | Class 10 second term fee ₹18,000 due 31 Oct, late fee ₹500 after 5 Nov, two parts with principal's OK |
| 2 | Fees | Hinglish | Parents | Class 6–8 bus fee ₹2,400, was due 10 Nov; never say the bus will stop |
| 3 | Fees | Hindi | Parents | JEE coaching second installment ₹35,000 due 15 Nov |
| 4 | Fees | Simple English | Working people | Tally course balance ₹4,500 before the exam on 28 Nov; never say they cannot sit the exam |
| 5 | Sales | Simple English | Students | Data Analytics course, 4 months, weekends, ₹28,000 in 2 parts, batch 7 Dec, demo 30 Nov; no job promise |
| 6 | Sales | Hinglish | Working people | Spoken English, 3 months, 7–8 pm weekdays, ₹6,000; never say their English is bad |
| 7 | Sales | Simple English | Parents | Class 11 NEET/JEE foundation, 4–7 pm, ₹65,000 a year, scholarship test 14 Dec; no rank guarantee |
| 8 | Admission | Simple English | Parents | Nursery 2027: visits Mon–Sat 10–12, form fee ₹500, address given; never mention seats running out |
| 9 | Admission | Hindi | Students | B.Com: visit 10–4 Mon–Fri or online form; never talk about marks |
| 10 | Admission | Hinglish | Parents | Class 9 for April 2027: campus tour Saturdays 11 am, entrance test 18 Jan |

## Per brief: drafts, checks, tokens and cost

Checks = the editor's validator (every ending linked to a result of the type, at most 3 options, every step reachable), a "do not call again" ending, the pressure word list and the model's own check. Marks = "Check this" marks (they block publishing until a person removes them). Score = easy-to-read score. Tokens = input + system prefix (written to or read from the cache) / output (of which thinking).

| # | Model | Draft | Checks | Marks | Score | Tokens | Cost | Time |
|---|---|---|---|---|---|---|---|---|
| 1 | Haiku | 14 steps, 6 pushbacks | passed | 5 | 99 | 318 + 6824 written / 6075 (4216 thinking) | $0.0039 | 28.4 s |
| 1 | Sonnet | 12 steps, 5 pushbacks | passed | 4 | 97 | 318 + 6824 written / 1646 (0 thinking) | $0.0342 | 9.5 s |
| 2 | Haiku | 14 steps, 5 pushbacks | passed | 5 | 96 | 311 + 6824 cached / 4009 (1992 thinking) | $0.0021 | 20.7 s |
| 2 | Sonnet | 10 steps, 5 pushbacks | passed | 6 | 99 | 311 + 6824 cached / 1773 (0 thinking) | $0.0197 | 15.1 s |
| 3 | Haiku | 12 steps, 6 pushbacks | passed | 4 | 100 | 293 + 6824 cached / 4512 (2556 thinking) | $0.0024 | 19.6 s |
| 3 | Sonnet | 12 steps, 5 pushbacks | passed | 6 | 99 | 293 + 6824 cached / 2051 (0 thinking) | $0.0225 | 13.4 s |
| 4 | Haiku | 14 steps, 6 pushbacks | passed | 8 | 98 | 297 + 6824 cached / 4089 (2165 thinking) | $0.0021 | 18.0 s |
| 4 | Sonnet | 13 steps, 5 pushbacks | passed | 4 | 98 | 297 + 6824 cached / 1750 (0 thinking) | $0.0195 | 11.9 s |
| 5 | Haiku | 16 steps, 6 pushbacks | passed | 6 | 99 | 322 + 6824 cached / 4169 (2015 thinking) | $0.0022 | 18.0 s |
| 5 | Sonnet | 15 steps, 5 pushbacks | passed | 9 | 99 | 322 + 6824 cached / 2076 (0 thinking) | $0.0228 | 12.6 s |
| 6 | Haiku | 14 steps, 5 pushbacks | passed | 3 | 99 | 266 + 6824 cached / 3792 (1787 thinking) | $0.0020 | 17.6 s |
| 6 | Sonnet | 13 steps, 5 pushbacks | passed | 7 | 100 | 266 + 6824 cached / 2103 (0 thinking) | $0.0229 | 17.3 s |
| 7 | Haiku | 12 steps, 5 pushbacks | passed | 7 | 97 | 282 + 6824 cached / 3115 (1494 thinking) | $0.0017 | 12.8 s |
| 7 | Sonnet | 13 steps, 5 pushbacks | passed | 7 | 97 | 282 + 6824 cached / 1739 (0 thinking) | $0.0193 | 10.9 s |
| 8 | Haiku | 13 steps, 5 pushbacks | passed | 2 | 100 | 314 + 6824 cached / 4602 (2911 thinking) | $0.0024 | 19.5 s |
| 8 | Sonnet | 13 steps, 5 pushbacks | passed | 6 | 99 | 314 + 6824 cached / 1784 (0 thinking) | $0.0198 | 9.9 s |
| 9 | Haiku | 13 steps, 5 pushbacks | passed | 4 | 100 | 282 + 6824 cached / 4518 (2415 thinking) | $0.0024 | 19.7 s |
| 9 | Sonnet | 10 steps, 4 pushbacks | passed | 6 | 99 | 282 + 6824 cached / 1730 (0 thinking) | $0.0192 | 11.4 s |
| 10 | Haiku | 14 steps, 5 pushbacks | passed | 7 | 97 | 285 + 6824 cached / 4292 (2270 thinking) | $0.0022 | 20.4 s |
| 10 | Sonnet | 11 steps, 5 pushbacks | passed | 7 | 97 | 285 + 6824 cached / 1892 (0 thinking) | $0.0209 | 15.1 s |

What the drafts said, in short:

1. **Fees, English.** Both: opening, reminder with ₹18,000 and 31 Oct, pay date, problem step, endings for will pay, already paid, refused, wrong person, call later, do not call. Haiku added a "first part date" step that says "the rest can be paid by 31 October", which is not in the brief (31 Oct is the whole fee's due date). The number check cannot catch it (31 is in the facts), but Haiku marked that step itself ("Add the rule for the second part's date, or remove the line about 31 October"), so it cannot be published unchecked. Haiku also has an odd "No answer" ending after "Busy now". Sonnet put the late fee on its own step and marked "should the late fee be said on every call?". Both marked "two parts need the principal's OK".
2. **Bus fee, Hinglish.** Both natural Hinglish. Neither says the bus will stop; Haiku added a pushback "Will my child lose the bus?" with a mark to get the office's answer. Sonnet wrote some check notes in Hinglish (fixed in the prompt since: notes are now asked for in simple English).
3. **Coaching fee, Hindi.** Haiku used formal written Hindi ("देय") and male verb forms ("बोल रहा हूँ"); Sonnet mixed in common English words (fee, installment, due date) as the prompt asks, which reads more like real calls. See "Prompt change" below.
4. **Tally balance, English.** Neither says the student cannot sit the exam. Haiku has more marks (8), several about the WhatsApp payment link; Sonnet 4.
5. **Data Analytics sales.** Both use only the given facts (4 months, weekends, ₹28,000 in 2 parts, 7 Dec, demo 30 Nov). Both answer "Will I get a job?" without a promise and mark it. Sonnet marked the institute name and the 2-part split.
6. **Spoken English, Hinglish.** Both good. Neither says the person's English is bad. Sonnet added a "Free demo class hai?" pushback and marked it because the brief has no demo.
7. **Class 11 coaching.** Neither guarantees a rank. Sonnet asked "What is your child hoping to study after Class 12?"; the code check marked "12" as a number not in the facts. A false alarm, but a person removes the mark in one click.
8. **Nursery admission.** Both offer a visit or the form, never mention seats running out. Sonnet marked the school phone number and the bus or hostel question.
9. **B.Com, Hindi.** Neither talks about marks. Both mark the address and the website.
10. **Class 9, Hinglish.** Both book a Saturday 11 am tour. Sonnet noticed the gender of "bol raha hoon" and marked it.

Safety checks across all 20 drafts: no pressure or threat words, no false urgency in the model's own check, every draft had a "do not call again" ending, no draft needed a retry, and only one number outside the facts (the "Class 12" above). Every "Never say" rule was kept.

## Totals

| | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| Drafts passing every check on the first try | 10 of 10 | 10 of 10 |
| Average cost a draft | $0.0023 (about ₹0.20) | $0.0221 (about ₹1.90) |
| Average time | 19.5 s | 12.7 s |
| Average output tokens | 4,317 (2,382 thinking) | 1,854 (no thinking at effort low) |
| "Check this" marks a draft | 5.1 | 6.2 |
| Easy-to-read score | 96–100 | 97–100 |

The cached system prefix (instructions and the three templates, 6,824 tokens) is written once per model and then read from the cache at a tenth of the price; the per-request part is about 300 tokens. Plan estimate was ₹0.60 a Haiku draft and ₹11–12 a Sonnet draft; measured costs are lower because of the cache and shorter outputs. 20 Haiku drafts a month cost about ₹4 per institute. A draft that needs the full fallback (2 Haiku + 1 Sonnet) costs about $0.027 (₹2.30).

## Prompt change after the run

Two rules were added to the fixed instructions: everyday spoken Hindi words instead of formal written Hindi, avoid verb forms that show the caller's gender (or add a check note), and write check notes in simple English. Briefs 3 and 10 were run again with Haiku (2 calls, $0.006): brief 3 now uses "बोल रहे हैं" and plainer words and marks "Check the Hindi verb forms work for the caller, man or woman"; brief 10 marks the "bol raha/rahi hoon" line. Both passed every check. The check-notes rule was added afterwards and not re-run.

## Limits of this check

- The easy-to-read score measures sentence and word length only. It scores every draft 96–100, so it shows a problem only when lines get long. It does not see formal Hindi.
- The number check cannot catch a real number used for the wrong thing (brief 1). The model's own marks did here; the admin must still read every line, which is why every draft opens with "Read every line before you use it".
- 10 briefs, one run each: enough to choose the default model, not to measure rare failures. The request log (`ai_requests`) records model, tokens, cost and failures for every real request; review it after the pilot month.
- A native Hindi speaker should still read the Hindi and Hinglish templates and a few drafts before the pilot (open item in the plan).

## Recommendation

1. Keep `claude-haiku-5-5` as `ANTHROPIC_MODEL_DRAFT` (default) and `claude-sonnet-5-5` as `ANTHROPIC_MODEL_FALLBACK`, effort `low`.
2. Keep the limit of 20 drafts a month; at measured costs the limit is about abuse, not money. Revisit with the cost log after the pilot.
3. If pilot admins find Haiku's Hindi or Hinglish stiff after the prompt change, switch the default to Sonnet for those languages only (about ₹1.90 a draft) rather than for all drafts.
4. The UI says drafts take "up to a minute"; Haiku's thinking makes it slower than Sonnet. Worst case (2 Haiku + 1 Sonnet) is about 75 s, inside the Edge Function's time limit.
