# Template library

_25 Oct 2026. Files: `supabase/templates/library.json` (26 scripts), `supabase/templates/common_answers.json` (21 answers). Test: `tests/web/template-library.test.js`. Plan items: "Central template library", "Common answers" and "Cold-calling templates" in `docs/phase-a-plan.md` (Phase A.2)._

The Vector team writes and keeps the call scripts. Every institute picks from this one shared library. Institutes do not write scripts with AI. They pick a template, fill in the "Check this" marks with their own facts in the script editor, and publish. The library has to cover most needs as it comes.

## Format

Each template is a script in the `web/js/script-model.js` format, plus library fields:

```
{ key, name, call_type, audience, about, tags: { class_labels: [], boards: [] }, language: "en" | "hinglish",
  steps: [{ id, title, start?, stage, result?, say: [...], tip?, check?: [...], opts?: [{ label, to }] }],
  pushbacks: [{ label, answer, check?: [...] }] }
```

- `call_type` is a built-in call type key. Every ending (a step with no `opts`) has a `result` from that type or a common result (`no_answer`, `busy`, `wrong_number`, `call_back_later`, `do_not_call`).
- `tags`: empty lists mean "suits every class and board". Today every template is general, so all are empty. Add tags only for a template written for certain classes or boards (for example `{"class_labels": ["9th", "10th"], "boards": ["CBSE"]}`).
- `check` holds "Check this" notes for the admin: facts that differ by institute (fee structure, batch timings, address, offer terms, late fee rule, payment modes). A script with any mark cannot be published, so the admin must fill these in or remove them.
- `language`: `en` (simple Indian English) or `hinglish` (Latin script). A Hinglish template's key is the English key plus `_hinglish`.

Every template follows the same rules, and the test enforces them:
- 5 to 10 steps, at most 3 options a step, 4 to 8 pushbacks, every step reachable, no loops.
- It opens with "Hello, am I speaking with {name}?", then who is calling ({me}, {institute}), why, and "Is this a good time?" (the cold call asks "Is it okay if I take one minute?").
- The second step always has a "Stop calling" option (Hinglish: "Call mat karo") that goes to the `do_not_call` ending ("Sorry for the trouble. We will not call you again.").
- Every template has "Wrong person" and "Busy now" endings.
- No threats, shame or false urgency. The test uses the AI script maker's `PRESSURE_WORDS` plus a few more words ("guaranteed", "100%", "last chance", "legal", "penalty", "strict", "warning", "limited period" …).
- No fixed ₹ amounts or percentages. The amount comes from the lead (`{amount_due}`) or from a check mark.
- No promises of jobs, marks, ranks, admission or discounts. Where people ask, the answer says "we cannot promise", or there is a check mark.
- Lines have 20 words at most. English templates must score "Easy to read" (75 or more) on the AI script maker's score.

## Placeholders

The call page fills these from the lead and the campaign. Templates use no others.

| Placeholder | What it is | Example | How to write around it |
|---|---|---|---|
| `{name}` | The person called | Mrs Sharma | |
| `{me}` | Caller's first name | Priya | |
| `{institute}` | Institute name | Sunrise Public School | |
| `{student}` | Student name | Aarav | |
| `{class}` | Class, without the word "class" | 8th, Nursery, LKG | Templates say "in {class} class". |
| `{board}` | Board | CBSE, ICSE, State | Templates say "the {board} board". |
| `{amount_due}` | Amount due, ₹ formatted | ₹18,000 | Fees templates need leads with an amount. |
| `{due_date}` | Due date | 31 October | |
| `{course}` | Course name, without the word "course" | Spoken English, JEE Foundation | Templates say "our {course} course" and "looking for {course}". |
| `{source}` | Where the lead came from, as words that read after "from" or "through" | the enquiry form on our website | The webinar template says "Thank you for joining {source}", so its leads need a source like "our free career webinar". |
| `{source_date}` | When the lead came in | 20 October | |

## Templates

"Admin fills in" lists the check marks: the facts the institute adds before publishing.

### Fees (call type `fees`)

| Template (key) | Steps / pushbacks | Who it is for | Admin fills in |
|---|---|---|---|
| Fee reminder before the due date (`fees_reminder_polite`) | 10 / 6 | Parents of current students, a few days before the due date | Ways to pay and office hours; part-payment rule; late fee rule; fee break-up; how receipts are given |
| Overdue fee reminder (`fees_overdue`) | 10 / 6 | Parents whose fee is past the due date | Ways to pay; part-payment rule; who decides on late fee waivers |
| Fee in parts (`fees_part_payment`) | 10 / 5 | Parents with a large pending fee | Part-payment rule (parts, amounts, dates); who confirms the plan; any extra charge; that classes are not affected |
| Late fee notice (`fees_late_fee_notice`) | 10 / 5 | Parents with a fee pending near or after the late fee date | Late fee rule (amount, start date); who decides waivers; ways to pay; where the rule is written |
| Follow-up: says already paid (`fees_already_paid_check`) | 10 / 5 | Parents who said they paid, when the office cannot find it | How the office confirms; which WhatsApp number takes payment proofs; ways to pay |
| Bus (transport) fee reminder (`fees_transport`) | 10 / 5 | Parents of bus users | Ways to pay; rule for stopping the bus; one-way fee; safety facts (only if true) |
| New term fee announcement (`fees_new_term`) | 10 / 5 | Parents of current students | How parents get the fee details; ways to pay; part-payment rule; sibling discount; what the fee covers |

### Admissions (call type `admission`)

| Template (key) | Steps / pushbacks | Who it is for | Admin fills in |
|---|---|---|---|
| School admission enquiry follow-up (`admission_enquiry_school`) | 10 / 6 | Parents who enquired about a class | Visiting days, hours, address; board; school timings; bus; open seats; documents; age rule |
| Campus visit booking (`admission_visit_booking`) | 9 / 5 | Parents who showed interest | Visiting days and hours, visit length; what to bring |
| Admission form follow-up (`admission_form_follow_up`) | 10 / 5 | Parents who got the form but did not submit | How to submit, office hours, documents; form fee; real last date; online submission |
| Admission test or counselling slot (`admission_test_slot`) | 10 / 5 | Parents or students who applied | Test or counselling (or both), what it covers; slot days and times; what to bring; test fee; how the test is used; changing a slot |
| Re-admission for next year (`readmission_next_year`) | 10 / 5 | Parents of current students moving up a class | How re-admission works (form, fee, last date); when teachers meet parents; next year's fee; re-admission fee; transfer certificate |
| Demo class invite, coaching (`demo_class_invite`) | 10 / 5 | Students or parents who enquired at a coaching institute | That the demo is free; demo days, times, place or link; online demo; teachers (only true facts); what the institute offers; batch timings |

### Sales and cold calling (call type `sales`)

| Template (key) | Steps / pushbacks | Who it is for | Admin fills in |
|---|---|---|---|
| Course sales to an enquiry (`course_sales_enquiry`) | 10 / 6 | People who enquired about a course | Course summary, length, mode, timings, fee; how to pay and confirm a seat; what the fee includes; job support (no promises); certificate; demo; online or in class |
| Cold call, bought or shared list (`cold_call_list`) | 10 / 5 | People on a list who never asked us to call | Two-line course summary; website; online or in class. Leads must carry `{source}`. |
| Webinar or seminar follow-up (`webinar_follow_up`) | 10 / 5 | People who registered for or attended a session | Next batch date, timings, fee; how to join; recording and slides; course plan; any real webinar offer; job support (no promises) |
| Fee offer ending, honest (`offer_ending`) | 10 / 5 | Past enquiries who have not joined | The exact offer and its real end date; offer terms (normal fee, offer fee, who qualifies); how to join; that callers cannot extend it |

The cold call says "This is a sales call" in its first lines and asks permission. It says where the number came from when asked, and offers to stop at every step. It sends WhatsApp details only when the person says yes.

### Others

| Template (key) | Call type | Steps / pushbacks | Who it is for | Admin fills in |
|---|---|---|---|---|
| Absence call to parents (`absence_call`) | `absence` | 10 / 5 | Parents of a student absent today | Who the caller tells at once when a parent did not know about the absence; how missed work is shared; leave note rule; whether you call for every absence |
| PTM or event reminder (`ptm_event_reminder`) | `event` | 9 / 5 | Parents of current students | Event name (if not a PTM), date, time, place; what to bring; what to do if they cannot come; other slots; phone or video; who may come; whether children come |
| Parent feedback survey (`feedback_survey`) | `feedback` | 10 / 5 | Parents of current students | Who handles complaints and how parents hear back; who sees feedback; the WhatsApp number for written feedback |
| Renewal for the next term (`renewal_reenrolment`) | `renewal` | 10 / 5 | Students or parents of a current course or batch | Term end and start dates; ways to pay; payment dates; next term's batch timings; any real renewal discount |
| Report card discussion invite (`result_discussion_invite`) | `event` | 9 / 5 | Parents after results or a report card | Meeting days, times, place; whether every parent is invited; what to bring; other days; how report cards are given |

The absence call is a caring call: when a parent did not know the child was absent, the ending says the class teacher is told right away, and the tip tells the caller to tell the class teacher or principal as soon as the call ends. The report card invite never discusses marks on the call.

### Hinglish (needs a native speaker's review)

| Template (key) | Original | Steps / pushbacks |
|---|---|---|
| `fees_reminder_polite_hinglish` | Fee reminder before the due date | 10 / 5 |
| `fees_overdue_hinglish` | Overdue fee reminder | 10 / 6 |
| `admission_enquiry_school_hinglish` | School admission enquiry follow-up | 10 / 5 |
| `cold_call_list_hinglish` | Cold call, bought or shared list | 10 / 5 |

They follow the same steps and endings as the English originals. Lines use "hum" (we, the institute) and the passive ("hum note kar lete hain", "jama ho jayegi"), so the caller's gender never shows in a verb. Option labels are in Hinglish. Tips and check marks stay in English because the admin reads them.

## Common answers

`common_answers.json`: `[{ key, label, answer, tags, fallback?, result?, check? }]`. Every script gets these in answer search (/) and the helper column, next to its own pushbacks. A template's pushback never repeats a common answer's label (the test checks this).

- `tags`: `all`, or the call type keys it suits, plus topic words for search.
- `fallback`: said instead of `answer` when a placeholder in `answer` has no value for this lead.
- `result`: the result to save when this answer ends the call.
- `check`: a fact the institute adds (fee, discount, address, office number). Until it is filled in, the app should not show that answer.

| Key | Label | Notes |
|---|---|---|
| `where_number` | Where did you get my number? | Says `{source}` and `{source_date}`; fallback says honestly that the caller does not have the detail; both offer to stop calls |
| `never_gave_number` | I never gave you my number | Apologises, offers to take the number off the list |
| `who_are_you` | Who are you? Which institute? | |
| `sales_call` | Is this a sales call? | Says yes honestly, offers to stop. Sales, admission and renewal only |
| `busy_call_later` | I am busy, call later | result `call_back_later` |
| `how_long` | How long will this take? | |
| `send_whatsapp` | Send the details on WhatsApp | Asks before sending |
| `do_not_call` | Do not call me again | Apologises, confirms; result `do_not_call` |
| `dnd` | I am on the DND list | Apologises, never argues; result `do_not_call` |
| `fee_amount` | How much is the fee? | Check: point to the campaign's fee facts |
| `discount` | Is there a discount? | "I cannot promise a discount on the call"; check: real discounts only |
| `fraud_check` | Is this a fraud or spam call? | Never asks for OTP or bank details; verify by the office number on the website or a visit; check: landline and website |
| `otp_bank` | Do you need my OTP or bank details? | Never |
| `speak_hindi` | Can you speak in Hindi? | Hindi line, and what to say if the caller cannot speak Hindi |
| `ask_family` | I will ask my husband, wife or parents | |
| `other_parent` | Can you call the other parent? | |
| `joined_elsewhere` | Already joined somewhere else | Admission, sales and renewal |
| `wrong_number` | You have the wrong number | result `wrong_number` |
| `location` | Where is the institute? | Check: address and landmark |
| `speak_senior` | Can I speak to someone senior? | |
| `call_back_number` | Which number can I call you back on? | Check: office number and hours |

## How the Vector team adds or changes a template

1. Edit `supabase/templates/library.json` (or `common_answers.json`). Copy the closest template, give it a new `key` and `name`, and keep the opening, "Stop calling", "Wrong person" and "Busy now" steps as they are.
2. Write facts that differ by institute as a short general line plus a `check` note that says exactly what to fill in. Never write a real amount, date, offer or promise into a template.
3. The AI drafting logic (`supabase/functions/ai-script-draft`) may be used on our side for a first draft. Every line must still be read, corrected and owned by a person on the team.
4. Run `node --test tests/web/*.test.js`. The library test checks the validator, results, placeholders, the opening, the do-not-call exit, banned words, amounts, line length and reading score.
5. A changed template changes only new scripts made from it. Institutes that already published a script keep their version.
6. Hinglish or Hindi text: have a native speaker review it before release (below).

## Needs a native speaker's review

- All four `*_hinglish` templates in `library.json`: lines, option labels and pushbacks. Check that they sound natural on the phone in North India, that they are polite to parents ("ji", "aap"), and that no verb shows the caller's gender.
- The `speak_hindi` common answer ("Ji, bilkul. Hindi mein baat karte hain.").
- When a Hindi (Devanagari) version is added, review it the same way.
