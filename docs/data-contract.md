# Data contract: Phase A cloud data

_24 Oct 2026, Sprint 7. Migrations `20261024100012_call_types_campaigns_leads.sql` and `20261024100013_money_rules.sql`. Tests: `supabase/tests/campaigns_leads_test.sql`, `supabase/tests/money_rules_test.sql` (run with `supabase/tests/run.sh <db> [files]`)._

This is what every Phase A feature builds on (campaigns, lead upload, caller screen, reports, insights, WhatsApp). If a feature needs something that is not here, add it in a new migration and update this file.

## Rules every feature must follow

1. **Money only through checked functions.** The browser role has no SELECT on `leads.amount_due`, `leads.promised_amount` or `call_outcomes.amount`, for anyone, owners included. A query that names these columns (or uses `select *` / `select('*')` on `leads` or `call_outcomes`) fails with "permission denied". Read money only through a `security definer` function.
2. **Every function that returns an amount, a total of amounts or anything computed from amounts calls `public.can_see_money(institute)` first.** If it is false, return the row with the money fields `null` (and say so, for example a `money_hidden boolean` column), or return counts only. Never raise just because money is hidden: a manager without money access still gets the counts.
3. **A caller sees money for one lead at a time**, through `lead_money(lead_id)`, and only for a lead assigned to their active seat. Never return amounts of other leads, totals or averages to a caller.
4. **`hide_money` hides money for everyone**, owners and callers included (exceptions: the caller of the lead on the call, see "Caller screen", and Accounts seats, see "Phase A.2"). `can_see_money()` and `lead_money()` already apply it; do not re-implement the check.
5. **Every export that contains money calls `log_money_export(institute, what, rows)` first** and stops if it raises. Exports for people who cannot see money have no ₹ columns.
6. **Paid amounts from calls are labelled "Parent said (not paid yet)"** in the UI (decision 3; was "reported by
   caller" until the admin simplification), and money the fees office recorded in the fee ledger is "Paid
   (office)". The admin app shows due now, collected, promised and "Promised date missed" from one function,
   `admin_fees_ledger` (`VectorAdminShared.loadFeeNumbers` / `feeCards`), with the period next to the number
   ("this month", "today", "in these dates").
7. **Store amounts and dates only.** No bank, card or UPI details anywhere, including `leads.extra` and notes.
8. **Money never goes in `leads.extra`.** A check refuses extra keys that look like money (see `extra_has_money_key`). Map the sheet's fee or amount column to `amount_due` in the lead upload.
9. **Select columns by name.** Because of column grants, `select('*')` on `leads` or `call_outcomes` fails for the browser. List the columns you need (see the grant lists below).
10. **A new column on `leads` or `call_outcomes` is invisible to the browser until you grant it.** Add `grant select (new_col) on public.<table> to authenticated;` in your migration if it is not money; never grant a money column.
11. **Writes go through checked functions.** The browser can only read `call_types`, `call_type_results`, `campaigns`, `campaign_members`; it can update a few lead columns (below) and insert `call_outcomes`. Campaign creation, adding members, lead upload, moving leads: write `security definer` functions that check `is_admin_of()` (or `is_owner_of()`), validate input, and write `audit_log`.
12. **Keep the old `outcome` column filled.** New rows with `result_key` get it from the result's `legacy_outcome` automatically. Old reports (`admin_results_by_outcome`, `admin_team_activity`, `admin_rep_progress`, script and loss reports) keep working on new rows.
13. Use the style of the existing functions: `language plpgsql security definer set search_path = public`, `#variable_conflict use_column` for `returns table`, plain-English error text, `errcode '42501'` for "not allowed" and `'22023'` for bad input, `revoke all ... from public, anon` then `grant execute ... to authenticated`.

## Roles

`seats.role` keeps its old values (`'admin'`, `'rep'`), so `is_admin_of()` and every check of `role = 'admin'` work as before. A new column says which kind of admin.

| Person | `seats.role` | `seats.admin_kind` | `seats.access_role` (generated) | Sees money |
|---|---|---|---|---|
| Owner | `admin` | `owner` | `owner` | yes, unless `hide_money` |
| Manager | `admin` | `manager` | `manager` | only when `seats.can_see_money` and not `hide_money` |
| Caller | `rep` | null | `caller` | only `lead_money()` of a lead assigned to them, not when `hide_money` |
| Accounts (A.2) | `accounts` | `accounts` | `accounts` | yes, always (`hide_money` does not apply); not an admin: see "Phase A.2" below |

- `is_admin_of(inst)` is true for owners **and** managers. Use it for everything an admin did before.
- `is_owner_of(inst)` is true for owners only. Use it for owner-only actions (money switches, roles).
- Admin seats that existed before 0013 are owners. A new admin seat is the owner when it is the institute's first admin seat (`create_institute`, `start_trial_institute`), otherwise a manager (`invite_seat(..., 'admin')`). A trigger fills `admin_kind`; a `rep` seat always has `admin_kind` null and `can_see_money` false.
- `can_see_money` can only be true on a manager seat (check constraint).
- `admin_set_seat_role()` changes the role. An owner cannot change their own role, so an institute always keeps at least one owner.
- In web pages, read `access_role` (from `my_trial_status()`, `my_active_seat()` or the `seats` table). `role` stays for old code.

## Tables

### `institutes` (new column)
| Column | Type | Notes |
|---|---|---|
| `hide_money` | boolean not null default false | "Hide money everywhere". Set with `admin_set_hide_money()`. |

### `seats` (new columns)
| Column | Type | Notes |
|---|---|---|
| `admin_kind` | text null, `owner` / `manager` | Null for callers. Must be set exactly when `role = 'admin'`. |
| `can_see_money` | boolean not null default false | Managers only. Set with `admin_set_money_access()`. |
| `access_role` | text, generated | `owner` / `manager` / `caller`. |
| unique `(id, institute_id)` | | Lets other tables point at a seat of the same institute. |

### `call_types`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `institute_id` | uuid null | Null = built in, for every institute. |
| `key` | text, `^[a-z][a-z0-9_]{1,39}$` | Unique per institute (built-in keys are unique among themselves; an institute key cannot repeat a built-in key). Never changes. |
| `label` | text 1–60 | |
| `sort_order` | int 0–10000, default 100 | Built-in: 10, 20 … 80. Added types: 500 unless given. |
| `active` | boolean | Off = not offered for new campaigns. |
| `created_at` | timestamptz | |

Built-in keys: `sales`, `fees`, `follow_up`, `admission`, `absence`, `event`, `feedback`, `renewal`.

### `call_type_results`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `call_type_id` | uuid null | Null = a common result every type has (built in only). |
| `institute_id` | uuid null | Null = built in. Set = an institute's own result, on its own type or on a built-in type. |
| `key` | text, same pattern | Unique within what one institute sees for a type (type results + institute results + common results). Never changes. Saved in `call_outcomes.result_key`. |
| `label` | text 1–60 | |
| `needs_date` | boolean | Saving requires `call_outcomes.promised_date`. |
| `needs_amount` | boolean | Saving requires `call_outcomes.amount`. |
| `needs_reason` | boolean | Saving requires `call_outcomes.result_reason` (non-blank). |
| `needs_rating` | boolean | Saving requires `call_outcomes.rating` (1–5). |
| `reason_choices` | text[] null, 1–20 items | Buttons for the reason (e.g. Sick, Travel, Other). Null = free text. |
| `counts_as_good` | boolean | The call got what the campaign wants (success rate, forecast). |
| `legacy_outcome` | text | Old `outcome` value for this result. Built-in values below; added results get `won` when good, else `other`. |
| `sort_order` | int | Type results first, then common results (900–940). |
| `active` | boolean | Off = not offered and not accepted for new outcomes. |

Built-in results (key → label · needs · good · legacy):

| Type | Results |
|---|---|
| `sales` | `joined` Joined · good · won; `interested` Interested · interested; `will_think` Will think · callback; `not_interested` Not interested · reason · not_interested |
| `fees` | `paid` Paid · amount · good · won; `will_pay_on` Will pay on date · date + amount · good · interested; `paid_part` Paid part · amount · good · won; `already_paid` Says already paid · answered; `refused` Refused · reason · not_interested |
| `follow_up` | `confirmed` Confirmed · good · won; `new_date` New date · date · callback; `cancelled` Cancelled · reason · not_interested |
| `admission` | `visit_booked` Visit booked · date · good · won; `form_sent` Form sent · good · interested; `not_this_year` Not this year · not_interested; `joined_elsewhere` Joined elsewhere · not_interested |
| `absence` | `reason_given` Reason given · reason (Sick, Travel, Other) · good · answered; `will_come_on` Will come on · date · good · answered; `needs_counsellor` Needs counsellor · answered |
| `event` | `coming` Coming · good · won; `not_coming` Not coming · not_interested; `maybe` Maybe · answered |
| `feedback` | `rated` Rating given · rating (comment optional in `result_reason`) · good · answered; `refused` Refused · not_interested |
| `renewal` | `renewed` Renewed · good · won; `will_renew_on` Will renew on date · date · interested; `not_renewing` Not renewing · reason · not_interested |
| common (every type) | `no_answer` No answer · no_answer; `busy` Busy · busy; `wrong_number` Wrong number · other; `call_back_later` Call back later · date · callback; `do_not_call` Do not call again · not_interested |

The caller screen should also set the lead after saving: `call_back_later` → `status 'callback'`, `next_call_at`; `will_pay_on` → `status 'promised'`, `promised_date`, `promised_amount`; `wrong_number` → `status 'wrong_number'`; `do_not_call` → `do_not_call = true`. The database does not do this for you.

### `campaigns`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | unique `(id, institute_id)` |
| `institute_id` | uuid not null | |
| `name` | text 1–120 | |
| `call_type_id` | uuid not null | Built-in or the institute's own type (trigger). |
| `script_id` | uuid null | A script of the same institute (FK `(script_id, institute_id)`); null when the script is deleted. |
| `start_date`, `end_date` | date null | `end_date >= start_date`. |
| `status` | `draft` / `running` / `paused` / `closed` | Default `draft`. Callers never see drafts. |
| `daily_target` | int null, 1–10000 | Calls per day for the campaign. |
| `share_mode` | `equal` / `next_free` | Default `equal`. |
| `call_hours` | jsonb object null, ≤ 4000 chars | Shape is up to the Insights feature ("Set call hours"). Null = any time. |
| `created_by` | uuid null → seats | |
| `created_at`, `updated_at` | timestamptz | `updated_at` kept by a trigger. |

### `campaign_members`
| Column | Type | Notes |
|---|---|---|
| `campaign_id`, `seat_id` | uuid, primary key together | Many-to-many: a seat can be on several campaigns. |
| `institute_id` | uuid not null | Must match both the campaign and the seat (composite FKs). |
| `added_at` | timestamptz | |

### `leads`
| Column | Type | Browser SELECT | Browser UPDATE | Notes |
|---|---|---|---|---|
| `id` | uuid pk | yes | | |
| `institute_id` | uuid | yes | | |
| `campaign_id` | uuid not null | yes | | Same institute (composite FK). Deleting a campaign deletes its leads. |
| `name` | text 1–120 | yes | | |
| `phone` | text `^\+91[0-9]{10}$` | yes | | Normalised on write by `normalise_phone()` (same rules as `normalizePhone` in `web/js/import-check.js`). Unique per campaign. |
| `extra` | jsonb object ≤ 8000 chars | yes | | Sheet columns (student, class …). No money keys. |
| `amount_due` | numeric(12,2) ≥ 0 | **no** (money) | | Read with `lead_money()`. |
| `promised_amount` | numeric(12,2) ≥ 0 | **no** (money) | yes | A caller can record it but not read it back directly. |
| `assigned_seat_id` | uuid null | yes | | Same institute. Moving leads is a checked function (feature). |
| `status` | `new` / `callback` / `promised` / `done` / `wrong_number` / `do_not_call` | yes | yes | Set to `do_not_call` automatically when `do_not_call` is true. |
| `next_call_at` | timestamptz null | yes | yes | When to call again. |
| `promised_date` | date null | yes | yes | |
| `consent_call` | boolean default true | yes | yes | The institute may call this number. |
| `consent_whatsapp` | boolean default false | yes | yes | Check before any WhatsApp message (Sprint 12). |
| `do_not_call` | boolean default false | yes | yes | Only an admin can turn it off again. |
| `created_at`, `updated_at` | timestamptz | yes | | `updated_at` kept by a trigger. |

No INSERT or DELETE for the browser. Due-now queue rule used by `my_campaigns()`: `status in ('new','callback','promised') and not do_not_call and (next_call_at is null or next_call_at <= now())`.

### `call_outcomes` (new columns; all old columns unchanged)
| Column | Type | Browser SELECT | Notes |
|---|---|---|---|
| `campaign_id` | uuid null | yes | Filled from the lead when `lead_id` is given. Same institute. |
| `lead_id` | uuid null | yes | Same institute and campaign. The lead may since have moved to another caller (offline sync is accepted). |
| `result_key` | text null | yes | Must be an active result of the campaign's type (type, institute's own, or common). Needs a campaign. |
| `promised_date` | date null | yes | The date the result asks for (payment, visit, call back …). |
| `amount` | numeric(12,2) ≥ 0 null | **no** (money) | The amount the result asks for, reported by the caller. |
| `result_reason` | text ≤ 300 null | yes | Reason or comment. |
| `rating` | smallint 1–5 null | yes | |
| `step_times` | jsonb object ≤ 20000 chars | yes | `{ "<step id>": seconds }`. |
| `reached_step` | text ≤ 80 | yes | Furthest step reached ("heard the pitch"). |

`outcome` stays required; when a row has `result_key` and no `outcome`, the trigger fills it from `legacy_outcome`. The checks run on INSERT (corrections included). Inserting stays a plain table insert, so `cloud.js`'s `upsert(row, { onConflict: 'seat_id,client_record_id', ignoreDuplicates: true })` keeps working; do not ask for the row back (`.select()`), because `amount` cannot be read.

Browser SELECT columns on `call_outcomes`: `id, institute_id, seat_id, client_record_id, corrects_id, script_id, script_version, script_step, objection, outcome, dialled_at, connected_seconds, phone_session_id, uploaded_at, loss_reason, stage_reached, campaign_id, lead_id, result_key, promised_date, result_reason, rating, step_times, reached_step`.

## Who reads what (RLS)

| Table | Caller | Manager / Owner | Other institutes |
|---|---|---|---|
| `call_types`, `call_type_results` | built-in rows + own institute's | same | nothing of yours |
| `campaigns` | non-draft campaigns their active seat is a member of | all of the institute | nothing |
| `campaign_members` | own memberships | all of the institute | nothing |
| `leads` | read and update only leads assigned to their **active** seat | read and update all of the institute | nothing |
| `call_outcomes` | own rows (as before) | all of the institute (as before) | nothing |

A revoked seat loses its leads at once.

## Helpers and RPCs

All take the caller's login from `auth.uid()`; anon cannot run any of them.

| Function | Returns | Who | What |
|---|---|---|---|
| `is_owner_of(inst uuid)` | boolean | any signed-in | Active owner of `inst`. |
| `can_see_money(inst uuid)` | boolean | any signed-in | Active owner, or active manager with `can_see_money`, and `hide_money` off. False for callers. **Call before returning any amount.** |
| `lead_money(p_lead uuid)` | table `(lead_id uuid, amount_due numeric, promised_amount numeric, promised_date date, money_hidden boolean)` | caller of that lead, admins | Amounts are null and `money_hidden` true when not allowed. Raises "lead not found" (42501) for a lead the person cannot see. |
| `log_money_export(p_institute uuid, p_what text, p_rows int)` | bigint (audit id) | `can_see_money` only | Writes `audit_log` action `money.exported`, target `<what>:<rows>`. `p_what` matches `^[a-z][a-z0-9_]{1,59}$` (e.g. `fees_report`, `callers_excel`). Raises when not allowed: stop the export. |
| `admin_set_money_access(p_seat uuid, p_allowed boolean)` | void | owner | Manager seats only. Audit `money.access_given` / `money.access_removed`. |
| `admin_set_hide_money(p_hide boolean)` | void | owner | For the caller's own institute. Audit `money.hidden` / `money.shown`. |
| `admin_set_seat_role(p_seat uuid, p_role text)` | void | owner | `owner` / `manager` / `caller`. Not your own seat, not a revoked seat. Clears `can_see_money` unless the result is a manager. Audit `seat.role_set`, target `<seat>:<role>`. |
| `admin_list_call_types()` | table `(id uuid, key text, label text, sort_order int, active boolean, built_in boolean, results jsonb)` | admin | Built-in and own types, active or not. `results` = active results in button order: `[{id, key, label, needs_date, needs_amount, needs_reason, needs_rating, reason_choices, counts_as_good, sort_order, common, built_in}]`. |
| `admin_upsert_call_type(p_id uuid, p_label text, p_key text default null, p_sort_order int default null, p_active boolean default true)` | uuid | admin | `p_id` null adds a type to the admin's institute (key from the label when null). Otherwise changes label, order, active of an own type. Built-in types refuse. Audit `call_type.added` / `call_type.changed`. |
| `admin_upsert_call_type_result(p_id uuid, p_call_type uuid, p_label text, p_key text default null, p_needs_date boolean default false, p_needs_amount boolean default false, p_needs_reason boolean default false, p_needs_rating boolean default false, p_counts_as_good boolean default false, p_reason_choices text[] default null, p_sort_order int default null, p_active boolean default true)` | uuid | admin | `p_id` null adds a result to a built-in or own type (`p_call_type`). Otherwise changes an own result (`p_call_type` ignored; null flags keep their value, `p_reason_choices` is replaced). Built-in and common results refuse. Audit `call_type_result.added` / `.changed`. |
| `my_campaigns()` | table `(campaign_id uuid, name text, status text, call_type_key text, call_type_label text, script_id uuid, start_date date, end_date date, daily_target int, call_hours jsonb, my_leads bigint, my_leads_due bigint, results jsonb)` | seat holder | Running and paused campaigns the active seat is on. `results` = button list `[{key, label, needs_date, needs_amount, needs_reason, needs_rating, reason_choices, counts_as_good, common}]`. No money. |
| `my_trial_status()` | jsonb | seat holder | As before, plus `access_role`, `can_see_money` (effective) and `hide_money`. `role` keeps `admin` / `rep`. |
| `normalise_phone(text)` | text or null | any signed-in | `+91` and 10 digits, or null. |
| `extra_has_money_key(jsonb)` | boolean | any signed-in | True when an extra key looks like money (words amount, fee, fees, paid, balance, rupee(s), rs, inr, price, cost, or ₹). Run it on the column mapping before upload. |
| `key_from_label(text)` | text | any signed-in | "Fee follow-up" → `fee_follow_up`. |

Internal (granted to nobody; use only inside your `security definer` functions): `call_type_results_for(p_call_type uuid, p_institute uuid)` returns the active `call_type_results` rows a campaign of that type can save, in button order.

## Patterns

A money report for admins:

```sql
create or replace function public.admin_fees_summary(p_institute uuid, p_campaign uuid)
returns table (leads bigint, paid_calls bigint, paid_amount numeric, money_hidden boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare money boolean;
begin
  perform public.admin_require(p_institute);          -- owner or manager, else 42501
  money := public.can_see_money(p_institute);
  return query
    select count(distinct l.id),
           count(o.id) filter (where o.result_key in ('paid', 'paid_part')),
           case when money then sum(o.amount) filter (where o.result_key in ('paid', 'paid_part')) end,
           not money
    from public.leads l
    left join public.call_outcomes o on o.lead_id = l.id
    where l.institute_id = p_institute and l.campaign_id = p_campaign;
end $$;
```

An export with ₹ columns: call `log_money_export(inst, 'fees_report', rowCount)` first; on error, build the file without ₹ columns (or stop and say "You cannot export money").

Caller lead card: read the lead's plain columns from `leads`, then `lead_money(lead.id)` for the amount due; show "Hidden" when `money_hidden`.

## Built in Phase A (round 2)

Campaign create / edit / pause / close, members, lead upload and moving leads, the caller queue, reports, insights, script tests, practice and WhatsApp are built: each feature's section follows, and "Phase A integration" at the end says which page calls what.

<!-- Phase A: campaigns -->
## Campaigns: admin functions

_Sprint 8. Migration `20261024100020_campaign_admin.sql`, tests `supabase/tests/campaign_admin_test.sql`. Admin screen: `web/js/admin/campaigns.js`; lead sheet helpers: `web/js/lead-upload.js`._

All are `security definer`; "admin" means owner or manager of the campaign's institute (`is_admin_of`). A campaign of another institute is "campaign not found" (42501). Each write adds an `audit_log` row.

| Function | Returns | Who | What |
|---|---|---|---|
| `admin_create_campaign(p_name text, p_call_type uuid, p_script uuid default null, p_start date default null, p_end date default null, p_daily_target int default null, p_share_mode text default 'equal')` | uuid | admin | Always a draft. Type: active, built in or own. Script: same institute, has a live (published) version, and `has_feature(inst, 'scripts')`. Audit `campaign.created`. |
| `admin_update_campaign(p_campaign uuid, p_name, p_call_type, p_script, p_clear_script boolean, p_start, p_end, p_clear_dates boolean, p_daily_target int, p_share_mode, p_status)` (all but the first `default null` / `false`) | void | admin | Null keeps a value; `p_daily_target` 0 clears it. Type changes only on a draft. Status: draft → running (needs an active member and a lead) or closed; running ↔ paused; running/paused → closed; closed is final (no changes at all). Audit `campaign.changed` and `campaign.<status>`. |
| `admin_add_leads(p_campaign uuid, p_rows jsonb)` | table `(added int, bad_numbers int, repeats int, other_skipped int)` | admin | `p_rows`: up to 5000 `{name, phone, amount_due, extra}`. Bad rows are skipped and counted; a money key in any `extra` refuses the whole call. Repeats = twice in the rows or already in the campaign. Keeps sheet order in `created_at`. Equal mode shares the new leads at once. Not for a closed campaign. Audit `leads.added` `<campaign>:<n>`. |
| `admin_set_campaign_members(p_campaign uuid, p_seats uuid[])` | int (members) | admin | Replaces the member list (active seats of the institute). Open leads of a seat that leaves go back to the pool; equal mode then shares again. Audit `campaign.members_set`. |
| `admin_share_leads(p_campaign uuid, p_mode text)` | int (leads that changed hands) | admin | Saves the mode. `equal`: every member ends with the same number of open leads (±1) where possible; callbacks, promises and leads already called stay; only uncalled leads move. `next_free`: uncalled leads go back to the pool. Audit `leads.shared`. |
| `admin_move_leads(p_from_seat uuid, p_to_seat uuid, p_campaign uuid default null)` | int (leads moved) | admin | Open leads (new, callback, promised; not do-not-call) of one seat to another, in one campaign or every campaign that is not closed. `p_to_seat` null = back to the pool. The new seat joins each campaign it gets leads in. Audit `leads.moved` `<from>:<to or pool>:<n>`. For the Callers tab. |
| `admin_campaign_list()` | table `(id, name, status, call_type_id, call_type_key, call_type_label, script_id, script_name, start_date, end_date, daily_target, share_mode, leads_total, leads_called, leads_open, leads_unassigned, callers jsonb, created_at, updated_at)` | admin | Running, paused, draft, closed; newest first in each. `leads_called` = status not new, or a saved call. `callers` = `[{seat_id, label}]`. No money. |
| `admin_campaign_detail(p_campaign uuid)` | jsonb | admin | Campaign fields, `script_live_version`, `leads {total, called, open, unassigned, new, callback, promised, done, wrong_number, do_not_call}`, `calls_today` (Asia/Kolkata day), `callers [{seat_id, label, status, leads, open, called, calls_today}]`, `results [{key, label, count}]` (corrections applied), `amount_due_total` (null unless `can_see_money`), `money_hidden`. |
| `next_free_lead(p_campaign uuid)` | table `(lead_id, campaign_id, name, phone, extra, status, next_call_at, promised_date)`, 0 or 1 row | caller whose active seat is a member | Running campaigns only (22023 otherwise). Gives back a lead the caller took but has not called yet, else locks (`for update skip locked`) and assigns the next pool lead: due callbacks and promises first, then new leads in upload order; only `consent_call` and not do-not-call. No money: use `lead_money(lead_id)`. For the caller screen. |

Internal (granted to nobody): `campaign_for_admin`, `campaign_admin_seat`, `lead_is_open`, `lead_is_uncalled`, `campaign_check_script`, `campaign_share_equal`, `campaign_share_next_free`.

Script type rule (integration, 0030): `campaign_check_script` requires the script to be of the campaign's type or untyped (saved before 0022), like the `campaigns_check_script` trigger; `SCRIPT_TYPE_FILTER` in `web/js/admin/campaigns.js` is on, so step 2 offers only those scripts.
<!-- /Phase A: campaigns -->

<!-- Phase A: scripts -->
## Scripts and the AI script maker (Sprint 9)

_Migration `20261024100022_script_types_ai.sql`, tests `supabase/tests/script_types_ai_test.sql`. Edge Function `supabase/functions/ai-script-draft`._

- **`scripts.call_type_id`** uuid null → `call_types`. Built in or the institute's own (trigger). Null only for scripts saved before 0022. Cannot change to another type while a campaign of the old type uses the script.
- **A campaign uses a live script of its own type**: trigger `campaigns_check_script` on `campaigns.script_id` / `call_type_id` refuses a script of another type (`23514`, "that script is for another call type") or one with no published version ("no live version yet"). An untyped (pre-0022) live script is accepted for any type. In the Campaigns tab, offer only live scripts whose `call_type_id` is the campaign's type (or null).
- **Steps** (`script_versions.steps`, format in `web/js/script-model.js`): an ending (a step with no `opts`) has `result`, a result key of the script's type; a step may have `stage` (0–5, the call page's progress rail) and `check` (a list of "Check this" notes). `web/js/script-adapter.js` copies an ending's `result` to `FLOW[id].end.result`, so the caller screen can preselect that result button.
- **`script_versions.pushbacks`** jsonb, default `[]`: `[{label (1–60), answer (1–600), check?}]`, 12 at most, labels unique (any case). Read it with the steps (`select('steps, pushbacks')`); the caller screen shows `label` as a button and `answer` as what to say. Immutable once published.
- **Publishing** needs the Scripts add-on, a call type, no "Check this" mark on a step or pushback, and every ending linked to an active result of the type (`script_publish_problem`).

| Function | Returns | Who | What |
|---|---|---|---|
| `admin_save_script(p_script uuid, p_name text, p_call_type uuid, p_steps jsonb, p_pushbacks jsonb, p_change_note text, p_publish boolean)` | jsonb `{script_id, version_id, version}` | admin, `has_feature('scripts')` | `p_script` null creates the script. `p_call_type` null keeps the type, `p_pushbacks` null keeps the latest version's. Audit `script.published` / `script.draft_saved`. |
| `admin_save_script_version(...)` (0007) | uuid | admin, Scripts add-on | Kept for old pages: keeps type and pushbacks; may still publish an untyped script; marks still block publishing. |
| `admin_list_scripts()` | table `(id, name, call_type_id, call_type_key, call_type_label, live_version int, live_version_id uuid, latest_version int, changed_at, used_in jsonb [{id,name,status}], calls bigint, good_calls bigint, check_marks int)` | admin | The Scripts tab list. Calls: original calls of the last 90 days with `script_id` = the script; good: the result counts as good for the campaign's type, or old outcome `won`. No money. |
| `admin_ai_usage()` | table `(used int, monthly_limit int, month date, cost_usd numeric)` | admin | For Settings ("N of 20 AI drafts used this month"). `used` counts drafts (including "Try again") that worked or are still running, this calendar month in India time; `cost_usd` is the month's cost of all AI requests (US dollars, not lead money). |
| `ai_reserve_request(p_institute, p_seat, p_kind)` / `ai_finish_request(...)` | bigint / void | service role only | Used by the Edge Function: reserve one request against the monthly limit (`54000` "limit reached"), then record model, attempts, tokens, cost and ok. Limits: 20 drafts, 100 "Make simpler" a month. |

**`ai_requests`** (one row per AI request): `institute_id`, `seat_id`, `kind` (`draft` / `simplify`), `model`, `attempts`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `ok` (null while running), `created_at`, `finished_at`. Admins of the institute read it; only the service role writes.

**Edge Function `ai-script-draft`** (POST, `Authorization: Bearer <admin access token>`): `{action:"draft", brief:{call_type, audience, language: simple_english|hinglish|hindi, purpose, facts, never_say}}` or `{action:"simplify", brief, script, target:{step, line}|{pushback}|null}`. Answers `{script, checks:{passed, failures, problems, marks, score:{score, label, long_lines}}, model, usage}`; errors `{error, code?}` with 401, 403 (`code: "no_feature"`), 429 (`code: "limit"`), 400, 500, 502. Secrets: `ANTHROPIC_API_KEY`; optional `ANTHROPIC_MODEL_DRAFT` (default `claude-haiku-5-5`), `ANTHROPIC_MODEL_FALLBACK` (default `claude-sonnet-5-5`).
<!-- Phase A: scripts (end) -->

<!-- Phase A: caller -->
## Caller screen (Phase A: caller)

_Migration `20261024100021_caller_screen.sql`. Tests: `supabase/tests/caller_screen_test.sql`._

- **`lead_money()` change:** the caller the lead is assigned to sees its `amount_due` and `promised_amount` even when `hide_money` is on (decision 24 Oct: a caller cannot run a fees call without the amount due). Rule 4 above still holds for admins, reports and exports: `can_see_money()` is unchanged.
- **`call_outcomes.note`** text ≤ 300, browser SELECT granted. The caller's note on a campaign call; shown to the next caller as "last call". No bank, card or UPI details.

| Function | Returns | Who | What |
|---|---|---|---|
| `my_call_queue(p_campaign uuid)` | jsonb `{campaign_id, status, share_mode, daily_target, my_calls_today, team_calls_today, leads: [{id, name, phone, extra, status, next_call_at, promised_date, consent_whatsapp, created_at, calls, last_called_at, last_result_key, last_note}]}` | member seat of a running or paused campaign | The seat's open leads (new, callback, promised; not do-not-call; `consent_call`), due first, then new, then later; at most 500. Calls today use the India day. No money. |
| `save_call_result(p_client_record_id text, p_lead uuid, p_result_key text, p_promised_date date, p_amount numeric, p_reason text, p_rating int, p_note text, p_step_times jsonb, p_reached_step text, p_script_step text, p_script_id text, p_script_version int, p_dialled_at timestamptz, p_connected_seconds int, p_phone_session_id text, p_next_call_at timestamptz, p_consent_whatsapp boolean)` (all after `p_result_key` default null) | jsonb `{outcome_id, duplicate, lead_updated, lead_status, next_call_at}` | seat of the lead, or a member of its campaign (lead moved while offline) | One transaction: inserts `call_outcomes` (checked by `call_outcomes_check`; fields the result does not need are dropped, except reason and note) and updates the lead with the mapping below. Same seat + `p_client_record_id` = saved once (`duplicate: true`). The lead changes only while it is still the seat's, not do-not-call, and no later call of it is saved. |
| `india_day_start()` | timestamptz | any signed-in | Start of today in Asia/Kolkata. |

Lead mapping in `save_call_result`: `do_not_call` → do_not_call; `wrong_number` → wrong_number; `no_answer` / `busy` → try again in 2 h / 30 min (new becomes callback); result with date and amount → promised (`promised_date`, `promised_amount`, next call on that date); result with a date → callback on that date (`p_next_call_at` or 10:00 India); legacy `callback` result without a date (Will think) → callback in 2 days; anything else → done. `p_consent_whatsapp` sets `consent_whatsapp` when not null. The browser mirrors this in `web/js/campaign-queue.js` (`applyResult`) for its offline copy.

`next_free_lead(p_campaign uuid)` (campaigns feature, 0020; returns 0 or 1 row with `lead_id`) is called by the caller page when a `next_free` campaign has nothing waiting; the page also accepts a lead id or a list of rows, and works without it.
<!-- end Phase A: caller -->

<!-- Phase A: admin -->
## Admin Home, Callers and Settings

_Sprint 10. Migration `20261024100023_admin_home_settings.sql`, tests `supabase/tests/admin_home_settings_test.sql`. Screens: `web/js/admin/home.js`, `callers.js`, `settings.js`._

New column `institutes.time_zone` (text, default `Asia/Kolkata`; Home counts "today" in it; set with `admin_set_institute`). New table `seat_presence` (one row per seat; no browser access).

| Function | Returns | Who | What |
|---|---|---|---|
| `report_presence(p_on_call boolean default false, p_phone_ok boolean default true, p_call_state text default null, p_call_started_at timestamptz default null)` | void | any active seat | **For the caller screen:** call about once a minute, at every phone call-phase change and after a save. Feeds Home's "On a call", "Wrap-up", "Ready", "No calls for N min" and "Phone offline" (seen in the last 3 minutes). The call-state arguments are from `20261025190000` (see "Presence: call state" below); the two-argument call still works. |
| `admin_home_summary(p_day text default 'today', p_campaign uuid default null)` | jsonb | admin | `p_day` `today` / `yesterday` / `week`. Tiles (calls, same stretch before, picked up, talk, sales joined / interested, fees paid / promised counts; `paid_amount`, `promised_amount` null unless `can_see_money`), callers right now with `now {status, since, idle_minutes}` (plus `call_state`, `confirmed`, `seconds` for `on_call` and `wrapup`, see below), `promises_due_today {count, amount}`, `script_ends` (Scripts add-on only: a step where > 35% of a script's picked-up calls in 7 days end, ≥ 10 calls), running campaign progress, campaign filter choices. |
| `admin_callers(p_institute uuid)` | table `(seat_id, label, access_role, can_see_money, status, campaigns jsonb, calls_today, calls_target, now_status jsonb)` | admin | Adds roles, campaigns (not closed) and "now" to `admin_seat_list`. No emails, no money. |
| `admin_institute_settings()` | jsonb | admin | name, time_zone, hide_money, status, trial_ends_at, trial_days_left, seat_limit, seats_used, features (`my_features`), is_owner, access_role. |
| `admin_set_institute(p_name text default null, p_time_zone text default null)` | void | owner | Null keeps a value. Audit `institute.changed` (`name`, `time_zone` or both). |
| `admin_audit_log(p_limit int default 25, p_offset int default 0)` | table `(id, created_at, action, target, actor_label, target_label, target_rest, total_rows)` | admin | Newest first, 1–100 rows a page. `target_label` names a seat, campaign, call type, result or script when the target starts with its id. |

Internal (granted to nobody): `home_seat_status`, `home_calls` (latest correction applied, includes `amount`: check money before returning it), `institute_tz`, `home_admin_seat`.

Callers tab uses `admin_set_campaign_members` and `admin_move_leads` (campaign functions) and shows "not available yet" without them. Settings reads `admin_ai_usage()` when the scripts feature has it, and loads `web/js/admin/settings-whatsapp.js` (an ES module exporting `mount(section, ctx)` and optionally `unmount()`) into `#settings-whatsapp` when the file exists.
<!-- /Phase A: admin -->

<!-- presence -->
### Presence: call state

_Migration `20261025190000_presence_call_state.sql`, tests `supabase/tests/presence_test.sql`. Caller page: `web/js/presence.js` (state and debounce, `tests/web/presence.test.js`) and `campPresence` in `web/js/main.js`. Home: `statusInfo` in `web/js/admin/home.js`._

New `seat_presence` columns: `call_state` (text, not null, default `none`, one of `none`, `dialling`, `connected`, `wrapup`, `unconfirmed`), `call_started_at` (timestamptz, the page's clock), `state_at` (timestamptz, server time `call_state` last changed). Rows from before the migration get `unconfirmed` when `on_call`, else `none`. `on_call` is still written (true for dialling, connected and unconfirmed).

What the caller page sends as `p_call_state`:

| State | When |
|---|---|
| `dialling` | the paired Vector Companion phone reports `REQUESTED` for the call on screen |
| `connected` | the paired phone reports `OFFHOOK` |
| `wrapup` | the phone reported `ENDED` / `FAILED` and the result is not saved yet; ends with the save, when the caller moves to another lead, or after 10 minutes |
| `unconfirmed` | a call started on the page (Dial / "Call on this device" / the first answer tapped) and no paired phone reports it |
| `none` | anything else |

`p_call_started_at`: the moment the line went into use, else the dial, else when the page started the call; null for `none`. A start in the future counts as now; one more than 12 hours ago is ignored. A report without a start keeps the start already known for the call. Null `p_call_state` (older pages): `unconfirmed` when `p_on_call`, else `none`. An unknown state is refused (`22023`).

When the page reports: at once on every change of the call state, phone answering or call start (dial, connect, hang up, save, moving on), on a call start and a save, and every minute (a hidden page with no call skips the minute report); a burst sends at most one report per 2 seconds, with the latest state. On a database without the call state (`PGRST202` / `42883` for the four-argument call) the page falls back to `report_presence(p_on_call, p_phone_ok)`.

`home_seat_status` (and so `admin_home_summary` callers' `now` and `admin_callers.now_status`), in order:

| `status` | Extra keys | When (screen seen in the last 3 minutes unless said) |
|---|---|---|
| `phone_offline` | `since` | the phone does not answer |
| `on_call` | `call_state` (`dialling`, `connected` or `unconfirmed`), `confirmed` (false for `unconfirmed`), `since` (call start), `seconds` | a call is going on |
| `wrapup` | `call_state`, `since` (hang-up), `seconds` | `wrapup` for less than 10 minutes |
| `idle` / `ready` / `not_started` | as before | otherwise |

Home shows "On a call · 3:12", "On a call (unconfirmed) · 0:40", "Wrap-up · 0:40" (`m:ss`, `h:mm:ss` past an hour) and ticks the time on every second between its one-minute refreshes; Callers shows the words without the time.
<!-- /presence -->

<!-- Phase A: insights -->
## Insights (migration `20261024100025_insights.sql`, tests `supabase/tests/insights_test.sql`)

New `campaigns` columns: `goal int null` (1–1000000, good results wanted by the end date, for types other than fees; fees aim at 90% of due) and `insights_plan jsonb null` (the last plan applied: `{ callers, calls_per_caller, evening_share, applied_at, applied_by }`; callers is a note only).

`campaigns.call_hours` shape (written by Insights, read by the caller screen): `{ "tz": "Asia/Kolkata", "days": { "mon": [18, 19, 20], "sat": [10, 11] }, "source": "insights" }`. `days` keys are `mon` … `sun`, values distinct hours 0–23 local to `tz` (the hour that starts the slot). A day that is not listed has no preference; null = any time. Only these keys are accepted.

Words: picked up = outcome not `no_answer` / `busy` / `dropped_network`; good = the result's `counts_as_good` (old rows: outcome `won`); promise = `will_pay_on` or `will_renew_on` with a date; kept = the same lead later got `paid` / `paid_part` / `already_paid` (fees) or `renewed` (renewal) on or before the date. A call is read as its latest correction.

| Function | Returns | Who | What |
|---|---|---|---|
| `admin_insights_setup(p_institute)` | jsonb `{ money, features, practice_available, campaigns: [{ id, name, status, call_type_key, call_type_label, start_date, end_date, daily_target, call_hours, goal, plan, script_id, callers, calls, leads }] }` | admin | Starting data for the tab. `practice_available` = the database has `admin_assign_practice`. |
| `admin_insights_forecast(p_institute, p_campaign, p_tz)` | jsonb | admin | Inputs for `web/js/insights-model.js`: `kind` (`amount` only for fees with `can_see_money`, else `count`), `money_hidden`, `today`, dates, `callers`, `leads`, `cap`, `target`, `stats`, `promises`, `open_promises`, `daily`, `hours`. Amounts only when `kind = 'amount'`. |
| `admin_insights_summary(p_institute, p_campaign, p_from, p_to, p_tz)` | one row `(calls, picked, good, active_days, callers, promises_judged, promises_kept, talk_seconds)` | admin | "Compare with". Null range = whole campaign. |
| `admin_insights_best_time(p_institute, p_campaign, p_seat, p_tz)` | rows `(dow 1–7, hour, calls, picked)` | admin | Heatmap; `p_seat` null = all callers. |
| `admin_insights_call_ends(p_institute, p_campaign)` | rows `(step, step_label, step_order, calls)` | admin + Scripts add-on | Picked-up calls by `reached_step`, in script order. |
| `admin_insights_promises(p_institute, p_campaign, p_tz)` | rows `(bucket, bucket_order, promises, kept, waiting)` | admin | Buckets 1–3, 4–7, 8–14, 15+ days away. Counts only. |
| `admin_insights_coaching(p_institute, p_campaign)` | rows `(seat_id, label, calls, picked, good, talk_seconds)` | admin | Members and anyone who called. |
| `admin_insights_step_coaching(p_institute, p_campaign)` | rows `(seat_id, label, step, step_label, step_order, timed_calls, calls_with_step, avg_seconds)` | admin + Scripts add-on | From `step_times`; `seat_id` null = team. |
| `admin_set_call_hours(p_campaign, p_call_hours)` | void | admin | Not closed campaigns. Audit `campaign.call_hours_set`. |
| `admin_apply_insights_plan(p_campaign, p_callers, p_calls_per_caller, p_evening_share, p_daily_target, p_call_hours default null)` | void | admin | Sets `daily_target`, `insights_plan` and (when given) `call_hours`. Audit `campaign.plan_applied`. |
| `admin_set_campaign_goal(p_campaign, p_goal)` | void | admin | Null clears. Audit `campaign.goal_set`. |
<!-- /Phase A: insights -->

<!-- Phase A: insights-extra -->
## Insights extra: script test, weekly brief, practice (migration `20261024100026_insights_extra.sql`)

Details and the email schedule: `docs/weekly-brief.md`. Tables `script_tests`, `script_test_leads` and `practice_assignments` have RLS on and no browser grants: use the functions.

| Function | Returns | Who | What |
|---|---|---|---|
| `campaign_script_version(p_campaign uuid, p_lead uuid default null)` | table `(script_id uuid, script_name text, version int, steps jsonb, test_id uuid, arm text)` | caller of the lead (active seat, campaign member, not draft), admins | **Caller page: use this for the script of a call** and save `script_id::text` and `version` in `call_outcomes.script_id` / `script_version`. With a running test and a lead: that lead's version (A/B alternate, stored, stable). Otherwise the published version (`test_id` null). No rows: no script, nothing published, or no Scripts add-on. Writes the lead's arm the first time. |
| `admin_script_test(p_campaign uuid)` | jsonb `{campaign:{id,name,status,script_id,script_name}, versions:[{version,published,change_note,created_at}], test:null or {id,status,version_a,version_b,winner,started_at,ended_at,same_script,leads,arms:[{arm,version,calls,picked_up,good,avg_seconds,change_note}]}}` | admin, Scripts add-on | The running test, else the last one. Counts since the test started; corrections applied; no money. |
| `admin_start_script_test(p_campaign uuid, p_version_a int, p_version_b int)` | uuid | admin, Scripts add-on | One running test per campaign. Audit `script_test.started`. |
| `admin_end_script_test(p_test uuid, p_winner int default null)` | void | admin | Winner: publishes that version of the script ("Use vX for everyone"; audit `script.published`). Null: stop. Audit `script_test.ended`, target `<test>:v<n>` or `<test>:none`. |
| `admin_weekly_brief(p_campaign uuid default null)` | text[] (4 lines) | admin | Forecast, best hours, promises, script version change. Rupees only when `can_see_money()`. Null campaign: forecast for the busiest running campaign, the rest across campaigns. |
| `weekly_brief_lines(p_institute uuid, p_campaign uuid default null, p_money boolean default false)` | text[] | **service role only** | Same lines without a login (Edge Function `weekly-brief`, WhatsApp brief). |
| `weekly_brief_recipients()` | table `(institute_id uuid, institute_name text, emails text[])` | **service role only** | Trial, active and grace institutes and their active owners' emails. |
| `admin_assign_practice(p_seat uuid, p_script uuid, p_note text default null)` | uuid | admin, Scripts add-on | Send a caller to practise a published script; again for the same pair refreshes it. Audit `practice.assigned`. |
| `admin_list_practice()` | table `(id, seat_id, seat_label, script_id, script_name, note, assigned_at, done_at, done_seconds, times_done)` | admin | Practice requests of the institute. |
| `my_practice()` | table `(assignment_id uuid, script_id uuid, script_name text, version int, steps jsonb, note text, assigned_at timestamptz, assigned_by text, done_at timestamptz, times_done int)` | seat holder, Scripts add-on | Requests first (`assignment_id` set), then other published scripts. Raises "Practice is part of the Scripts add-on" without it. |
| `my_practice_done(p_assignment uuid, p_seconds int default null)` | void | the caller of that request | Marks it done. Practice never writes `call_outcomes`. |
| `ix_count(numeric)`, `ix_rupees_short(numeric)`, `ix_hour(int)`, `ix_hour_range(int)` | text | any signed-in | Indian number format and hour labels for SQL sentences ('43,20,000', '₹43.2L', '7–9 pm'). |

"Picked up" (script test, brief) = the call's result is not No answer, Busy or Wrong number and its outcome is not no_answer, busy or dropped_network. "Good" = the result's `counts_as_good` (old rows: outcome `won`).
<!-- /Phase A: insights-extra -->

<!-- Phase A: whatsapp -->
## WhatsApp (Sprint 12)

Migration `20261024100027_whatsapp.sql`; details, RPCs and setup in `docs/whatsapp-setup.md`. Tables `whatsapp_accounts`, `whatsapp_templates`, `whatsapp_messages`, `whatsapp_brief_recipients` (browser read-only, RLS: admins of the institute; callers see approved templates and the messages of their own leads) and `whatsapp_secrets` (no browser access at all). Message bodies are stored with amounts masked (`₹…`); `whatsapp_messages.cost_inr` is not granted to the browser and `admin_whatsapp_overview()` returns the cost only when `can_see_money()`. Send only when `leads.consent_whatsapp` and not `do_not_call`; a STOP reply sets `consent_whatsapp = false`.
<!-- end Phase A: whatsapp -->

<!-- Phase A: integration -->
## Phase A integration (round 2)

_Migration `20261024100030_phase_a_integration.sql`. All eight feature branches merged; this is who calls what._

**Fixes in 0030**
- `wa_claim_briefs` flattens the `text[]` that `admin_weekly_brief` returns, so the WhatsApp brief has 4 lines, not one nested array.
- `campaign_check_script(p_institute, p_script, p_call_type)`: the script must be of the campaign's call type or untyped (saved before 0022), as the `campaigns_check_script` trigger already required. The Campaigns tab offers only those scripts (`SCRIPT_TYPE_FILTER` on).

**Caller page (`web/app.html`, `web/js/main.js`, `web/js/cloud.js`)**

| Call | When | Notes |
|---|---|---|
| `my_campaigns()`, `my_features()` | sign-in, reload | kept on the device for offline use |
| `my_call_queue(p_campaign)` | campaign picked, every minute while idle, after a sync | |
| `next_free_lead(p_campaign)` | "whoever is free next" campaign with nothing waiting | |
| `campaign_script_version(p_campaign, p_lead)` | campaign picked (lead null) and each new lead on the card | Script test arm per lead; `script_id::text` and `version` go into `save_call_result` (`p_script_id`, `p_script_version`). Missing function: the published version (`scripts` read). Offline: the device copy (`script:<id>:lead:<lead>` for a test version, else `script:<id>`). |
| `lead_money(p_lead)` | lead on the card | memory only |
| `save_call_result(...)` | Save (through the outbox) | a sync asked for while one runs runs right after it |
| `my_practice()` | sign-in | top-bar link "Practise (N to do)" → `practice.html` or `practice.html?script=<id>` when one is assigned |
| `my_whatsapp_templates()` (via `VectorWhatsApp.loadTemplates`) | sign-in | `[]` without a connected number |
| Edge Function `whatsapp-send` (via `VectorWhatsApp.sendAfterCall`) | after the server has the result, when the caller ticked "After saving, send … from the institute's WhatsApp" | offered only for an approved template of this call type and ending with no typed blanks, and when the person said yes (on this call or before); the `wa.me` link stays beside it |
| `report_presence(p_on_call, p_phone_ok, p_call_state, p_call_started_at)` | every minute, at every phone call-phase change, when a call starts, after a save (at most once per 2 seconds) | `p_phone_ok` false when the paired phone does not answer; the call state as in "Presence: call state"; falls back to the two-argument call on an older database; stops calling if the function is missing |

**Admin page (`web/admin.html`)**
- Settings mounts `window.VectorSettingsWhatsApp` (`js/admin/settings-whatsapp.js`, loaded by `admin.html`) into `#settings-whatsapp`; shows `admin_ai_usage()` as "N of 20 AI drafts used this month".
- Insights mounts `window.VectorInsightsExtra.mountWeeklyBrief` (`#insights-brief`) and `mountScriptTest` (`#insights-abtest`) on the tab's campaign and passes campaign changes on (`refresh(id)`, `setCampaign(id)`); "Send to practice mode" shows because `admin_assign_practice` exists.
- Callers: Edit caller → campaigns with `admin_set_campaign_members`, "Move leads" with `admin_move_leads(p_from_seat, p_to_seat, p_campaign)`.
- Home links "Promises due today" to `#reports?report=fees`.

**Browser RPC names checked**: every `rpc('…')` and `Cloud` call in `web/` and `supabase/functions/` names a function in `supabase/migrations/` with matching argument names.
<!-- end Phase A: integration -->

<!-- Phase A.2 -->
## Phase A.2: open campaigns and the fee ledger

_25 Oct 2026. Migration `20261025130000_ledger_open_campaigns.sql` (after `20261025120000_campaign_script_pushbacks.sql`). Tests: `supabase/tests/ledger_test.sql`, `supabase/tests/open_campaigns_test.sql`; the fixture campaigns of `caller_screen_test.sql`, `campaign_admin_test.sql` and `campaigns_leads_test.sql` are now `open_to_all = false`, because those tests check the member rule._

### Accounts role

- **`seats.role = 'accounts'`, `admin_kind = 'accounts'`, `access_role = 'accounts'`.** Not `role = 'admin'`: `is_admin_of()` is false and every old check of `role = 'admin'` refuses it, so an accounts seat cannot invite or revoke seats, change roles, manage campaigns, call types or scripts, or read admin reports, Home or the audit log. Constraint `seats_admin_kind_matches_role`: `rep` ⇔ `admin_kind` null; `accounts` ⇔ `admin_kind = 'accounts'`. The `can_see_money` column stays false on accounts seats.
- **Always sees money:** `can_see_money(inst)` is true for an active accounts seat even when `hide_money` is on (the fees office cannot work without amounts). Owners and managers still follow `hide_money`.
- Accounts can read the ledger, record and reverse payments, add and void fee items, import students and fees, add and edit students, create fees campaigns from the ledger, and read `ledger_collected` and `promises_vs_payments`. Owners can do all of this too. Managers can read the ledger (amounts only with money access) and, with money access, create fees campaigns from the ledger. Managers cannot record payments.
- **Creating an accounts seat:** use `invite_seat(p_institute, p_email, p_label, 'accounts')` (owner only) or `admin_set_seat_role(p_seat, 'accounts')` (owner). The `seat-admin` Edge Function still accepts only `admin` / `rep`, so the UI agents must add `accounts` there. `my_trial_status()` returns `role 'accounts'`, `access_role 'accounts'`, `can_see_money true`. The admin page (`shell.js` `isAdminRole`, `home.js` routing) must let `access_role = 'accounts'` in and show only the Fees tab.

| Helper | Returns | What |
|---|---|---|
| `is_accounts_of(inst uuid)` | boolean | Active accounts seat of `inst`. |
| `can_read_ledger(inst uuid)` | boolean | `is_admin_of(inst) or is_accounts_of(inst)`. |
| `can_manage_ledger(inst uuid)` | boolean | `is_owner_of(inst) or is_accounts_of(inst)`. |
| `can_see_money(inst uuid)` | boolean | Changed: also true for accounts, ignoring `hide_money`. |
| `admin_set_seat_role(p_seat, p_role)` | void | Changed: `p_role` may also be `'accounts'`. |
| `invite_seat(p_institute, p_email, p_label, p_role default 'rep')` | uuid | Changed: `p_role` may also be `'accounts'` (owner only). |

### Open campaigns

New `campaigns` columns (browser SELECT through the table grant):

| Column | Type | Notes |
|---|---|---|
| `open_to_all` | boolean not null default true | Every existing campaign became open. An open campaign can be seen and worked by every active seat of the institute while it is running or paused, without membership. False: members only (as before). |
| `class_label` | text null, 1–20 | Tag, e.g. `8th`. |
| `board` | text null: `CBSE` / `ICSE` / `State` / `IB` / `IGCSE` / `Other` | Tag. Functions accept any case and "State board". |
| `fees_due_by` | date null | Fees campaigns from the ledger: lead amounts are the balance due by max(today, `fees_due_by`). |

Rules:
- Callers read the running and paused open campaigns of their institute (RLS `campaigns_read`).
- Leads of an open campaign come from the pool through `next_free_lead()`. A lead already assigned stays with its caller: sharing, changes to members and `admin_share_leads` never take an open campaign's leads away from an active seat of the institute. In `next_free` sharing, only uncalled leads go back to the pool.
- Restricting a campaign (`open_to_all` true → false) puts the open leads of non-members back in the pool.
- An open draft can start without members.
- Callers still read and update only the leads assigned to them (`leads` RLS is unchanged).

Changed functions (browser contract):

| Function | Change |
|---|---|
| `admin_create_campaign(p_name text, p_call_type uuid, p_script uuid default null, p_start date default null, p_end date default null, p_daily_target int default null, p_share_mode text default null, p_open_to_all boolean default true, p_class_label text default null, p_board text default null)` | Three new trailing arguments. `p_share_mode` null = `next_free` when open, `equal` when restricted. The old 7-argument function was dropped (no overload); old calls by name or position keep working. |
| `admin_update_campaign(p_campaign uuid, p_name, p_call_type, p_script, p_clear_script, p_start, p_end, p_clear_dates, p_daily_target, p_share_mode, p_status, p_open_to_all boolean default null, p_class_label text default null, p_board text default null, p_release_after_hours int default null)` | Four new trailing arguments; null keeps a value, `''` clears a tag. Draft → running needs a member only when restricted. New audit actions `campaign.opened` / `campaign.restricted`. The old 11-argument function was dropped. |
| `admin_campaign_list()` | New columns at the end: `open_to_all boolean, class_label text, board text`. |
| `admin_campaign_detail(p_campaign)` | New keys `open_to_all`, `class_label`, `board`, `fees_due_by`; `callers` = members plus every seat holding leads of the campaign, each with `member boolean`. |
| `my_campaigns()` | Now returns `(campaign_id, name, status, call_type_id, call_type_key, call_type_label, script_id, start_date, end_date, daily_target, call_hours, share_mode, open_to_all, class_label, board, is_member, my_leads, my_leads_due, pool_leads_due, results)`. Includes campaigns the seat is a member of and open campaigns of the institute, running or paused, ordered by status, call type order, class, board and name. `pool_leads_due` = unassigned leads that `next_free_lead` can hand out now. For the campaign picker: group by `call_type_key`, filter by `class_label` / `board`. |
| `next_free_lead(p_campaign)` | Members, or any active seat of the institute for an open campaign. |
| `my_call_queue(p_campaign)` | Same access rule. New keys `open_to_all`, `class_label`, `board`; each lead has `student_id`. |
| `campaign_script_version(p_campaign, p_lead)` | Same access rule (the pushbacks column and script tests are unchanged). |
| `save_call_result(...)` | Same signature. Allowed: the lead's seat; a member of its campaign (a lead moved while the phone was offline, as before); or, in an open campaign, a seat that already saved a call on that lead (an offline retry). Anyone else gets "lead not found". Also returns `student_id`, set when the result creates a student. |

**Back to the pool (open campaigns).** A call back or promise stays with the caller who spoke to the parent. It goes back to the pool (`assigned_seat_id` null) when both of these are true:
- it is due (`next_call_at <= now()`);
- its caller has not saved a call in that campaign for `campaigns.release_after_hours` working hours (int, default 24, 1–720). Sundays in the institute's time zone are not counted, and a caller who never called in the campaign counts as idle.

Its status, `promised_date`, `promised_amount`, `amount_due` and call history stay as they are, and audit gets `lead.released` with target `<lead>:<seat>:idle`. The rule is in one function, `seat_idle_in_campaign(p_campaign, p_seat, p_now default now())`, which uses `working_hours_between(p_from, p_to, p_tz)`. `release_stale_leads(p_campaign uuid default null)` applies it to running and paused open campaigns. It also releases any open lead held by a seat that is no longer active (`:inactive`). It returns the count and is granted to `service_role` only. `next_free_lead` runs it for its campaign first, so no cron is needed, then hands out due follow-ups first (oldest `next_call_at`), then new leads. Revoking a seat (trigger on `seats.status`) puts its open leads in open campaigns that are not closed back in the pool at once (`lead.released` `<lead>:<seat>:revoked`).

| Function | Returns | Who | What |
|---|---|---|---|
| `admin_release_leads(p_seat uuid, p_campaign uuid default null)` | int (leads released) | owner, manager | "Back to pool": the seat's open leads (new, callback, promised; not do-not-call), in one campaign or in every campaign that is not closed (open or restricted). State and history stay. Audit `lead.released` `<lead>:<seat>:admin` per lead. |

`admin_update_campaign` also takes `p_release_after_hours int default null` (1–720), as its last argument. `admin_campaign_detail` returns `release_after_hours`.

Internal (granted to nobody): `campaign_seat_can_work(p_campaign, p_seat)`, `campaign_check_tags(p_class_label, p_board)`, `seat_idle_in_campaign`, `working_hours_between`, trigger `seats_release_on_revoke`. Unchanged: Home, Insights and `admin_callers` still count a campaign's callers from `campaign_members` (plus "anyone who called" where they did before).

### Ledger tables

RLS is on. The browser has no INSERT, UPDATE or DELETE. Owners, managers and accounts of the institute (`can_read_ledger`) can read all columns of `students`, and the columns of `fee_items` and `payments` other than `amount`. Callers read nothing. Read amounts through the functions below.

**`students`**:
- `id`, `institute_id`
- `admission_no`: text ≤ 40, unique per institute ignoring case, null allowed
- `name` (1–120), `class_label` (≤ 20), `section` (≤ 20), `board` (same values as campaigns), `academic_year` (`2026-27`), `parent_name`
- `phone`, `alt_phone`: normalised like leads (`+91` and 10 digits), null allowed
- `status`: `active` / `left`
- `source`: `import` / `admission` / `manual`
- `admission_lead_id`: unique; the admission lead that became this student
- `created_by` (seat), `created_at`, `updated_at`

**`fee_items`**:
- `id`, `institute_id`, `student_id`
- `head`: 1–80 characters, e.g. "Term 2 tuition"
- `amount`: numeric(12,2) > 0 (**not granted**)
- `due_date`, `academic_year`
- `is_void`, `void_reason`, `voided_at`, `voided_by`
- `created_by`, `created_at`

A trigger allows only one change to a row: voiding it, once. Nothing is deleted.

**`payments`**:
- `id`, `institute_id`, `student_id`
- `amount`: numeric(12,2) > 0 (**not granted**)
- `paid_on`: date
- `mode`: `upi` / `cash` / `cheque` / `card` / `bank` / `other`
- `reference`: ≤ 60 characters (UTR, cheque no.). Never account, card or UPI ids.
- `note`: ≤ 300 characters
- `recorded_by` (seat), `created_at`
- `reverses_id`: unique. A reversal is a new row with the same amount, date and mode that points at the payment; the reason is its note.
- `opening`: true for an import's "paid so far"

A payment is never updated (trigger) or deleted.

**Double entry:** a `upi`, `bank` or `card` payment needs a reference. The same `(institute, mode, reference)` (any case) is refused while the first payment stands. `accounts_record_payment` checks this under an advisory lock, not with a unique index, so a reversed payment frees its reference and the payment can be recorded again on the right student.

**`leads.student_id`**: uuid null → `students` (same institute; deleting a student clears it). Browser SELECT is granted.

**`call_type_results.creates_student`**: boolean, default false (browser SELECT). When `save_call_result` saves such a result, it makes a student from the lead (once per lead). There is no built-in "admission confirmed" result. When an institute adds a result on the built-in `admission` type with key `admission_done` or `admission_confirmed` (for example the demo's "Admission confirmed"), it gets `creates_student = true`; existing results with those keys were also set. Admins change it with `admin_set_result_creates_student`.

**Balances** (internal function `student_balance_rows`):
- `total_fees` = all non-void fee items
- `total_due_to_date` = non-void items with `due_date` ≤ today in the institute's time zone
- `paid` = payments minus reversals
- `balance_due_now` = due to date − paid (negative = paid in advance)
- `balance_total` = total fees − paid
- last payment = the latest payment that is not reversed (amount, date, mode)

**Payments update fees leads.** After a payment, a reversal, a new fee item or a void, the open leads of the student are updated. Open leads are those with status `new`, `callback` or `promised`, not do-not-call, in a fees campaign that is not closed. Each gets `amount_due` = the balance due by max(today, `campaigns.fees_due_by`). When that balance is 0 or less, the lead becomes `done` with `next_call_at` null and `amount_due` 0, and `audit_log` gets `lead.closed_paid` (target: the lead id). A reversal does not reopen a lead that is already done. `lead_money()` reads the new amount.

### Ledger RPCs

"Accounts" = an owner or accounts seat (`can_manage_ledger`); "readers" = owners, managers and accounts (`can_read_ledger`). Money fields are null and `money_hidden` is true unless `can_see_money()`. Errors: 42501 not allowed / not found, 22023 bad input, 23505 duplicate.

| Function | Returns | Who | What |
|---|---|---|---|
| `accounts_import_students(p_rows jsonb)` | jsonb `{added, updated, skipped, fee_items_added, payments_added, skipped_rows: [{row, reason}]}` | accounts | Up to 5000 rows `{admission_no, name, class_label (or class), section, board, academic_year, parent_name, phone, alt_phone, status, fees: [{head, amount, due_date 'YYYY-MM-DD', academic_year}], paid_so_far, paid_on}`. A known admission no updates that student (given fields only). A fee with the same head, amount and due date is not added twice. `paid_so_far` > 0 becomes one payment per student (`mode 'other'`, note "Opening balance import", `opening true`, dated `paid_on` or today). Skip reasons: no name, admission number twice in the file, unknown board, academic year, bad phone number, bad alternate phone number, status, bad paid so far amount, paid on, fees must be a list, bad fee item, fee due date. Amounts accept `12,500` and `₹12500.50`. Audit `students.imported` `<added>:<updated>:<skipped>`. |
| `accounts_save_student(p_student uuid, p_data jsonb)` | uuid | accounts | `p_student` null adds a student (`source 'manual'`). `p_data` takes the import keys (no fees); a missing key keeps its value, `''` clears it. Audit `student.added` / `student.changed`. |
| `accounts_add_fee_item(p_student uuid, p_head text, p_amount numeric, p_due_date date, p_academic_year text default null)` | uuid | accounts | Audit `fee_item.added`. Updates the student's leads. |
| `accounts_void_fee_item(p_fee_item uuid, p_reason text)` | void | accounts | Reason 1–300 characters. Audit `fee_item.voided`. Updates the student's leads. |
| `accounts_record_payment(p_student uuid, p_amount numeric, p_paid_on date, p_mode text, p_reference text default null, p_note text default null)` | uuid | accounts | `p_paid_on` null = today; not in the future, not before 2000. Double-entry rule above. Audit `payment.recorded` `<payment>:<student>`. Updates and closes the student's leads. |
| `accounts_reverse_payment(p_payment uuid, p_reason text)` | uuid (the reversal) | accounts | Not for a reversal; once per payment. Audit `payment.reversed` `<reversal>:<payment>`. Updates the student's leads. |
| `accounts_students(p_filters jsonb default '{}')` | table `(student_id, admission_no, name, class_label, section, board, academic_year, parent_name, phone, alt_phone, status, source, total_fees, total_due_to_date, paid, balance_due_now, balance_total, last_payment_amount, last_payment_on, last_payment_mode, money_hidden, total_rows)` | readers | Filters: `class_label` (any case), `board`, `search` (name, start of the admission no, parent, 4+ phone digits), `only_due` (balance due now > 0; works without money access), `academic_year`, `status` (`active` by default, `left` or `all`), `limit` 1–5000 (default 500), `offset`. Ordered by class, section, name. |
| `accounts_student_detail(p_student uuid)` | jsonb `{student, money_hidden, balance {…as above}, fee_items [{id, head, amount, due_date, academic_year, is_void, void_reason, voided_at, created_at}], payments [{id, amount, paid_on, mode, reference, note, recorded_by, recorded_by_label, created_at, reverses_id, reversed_by}], calls [{outcome_id, at, campaign_id, campaign_name, lead_id, result_key, result_label, promised_date, promised_amount, caller, corrects_id, note}]}` | readers | Calls of the student's leads and of its admission lead, newest first, 200 at most. |
| `accounts_create_fees_campaign(p_name text, p_class_label text default null, p_board text default null, p_due_by date default null, p_min_due numeric default 0, p_script uuid default null, p_open_to_all boolean default true, p_start boolean default true)` | uuid (campaign) | accounts, or a manager who can see money | **Students:** active, with a phone, of that class and board (null = all), whose balance due by max(today, `p_due_by`) is more than `p_min_due`. **Leads:** one per student: name = the parent (or the student), the student's phone, `amount_due` = that balance, `student_id`, `extra {student, class, section, board, admission_no}`. Siblings who share a phone get one lead, for the student with the highest balance. **Campaign:** built-in `fees` type, the tags, `fees_due_by = p_due_by`, script checked as in `admin_create_campaign`, `next_free` sharing when open (`equal` when restricted). It runs at once when `p_start` is true, it is open and it has leads; otherwise it is a draft for an admin to start. Audit `campaign.created`, `leads.added`, `campaign.running`, and `fees_campaign.from_ledger` `<campaign>:<leads>:<no phone>:<same phone>`. |
| `lead_ledger(p_lead uuid)` | table `(lead_id, student_id, balance_due_now, balance_total, last_payment_amount, last_payment_on, last_payment_mode, money_hidden)` | caller of the lead, readers | For the balance and last payment on the caller's lead card. Same rule as `lead_money`: the lead's caller sees amounts even with `hide_money`. One row; nulls when the lead has no student. |
| `ledger_collected(p_institute uuid, p_from date, p_to date, p_campaign uuid default null)` | jsonb `{from, to, campaign_id, payments, reversed, total, by_mode [{mode, payments, amount}], by_day [{day, payments, amount}], money_hidden}` | readers | Payments dated in the range (at most 400 days), leaving out reversed payments and opening imports. With a campaign: only students with a lead in it. Counts always; amounts only when allowed. For "collected" in Reports, Home and Insights. |
| `promises_vs_payments(p_campaign uuid)` | jsonb `{campaign_id, grace_days: 2, promises, kept, part_paid, broken, waiting, no_student, promised_amount, paid_amount, money_hidden, rows [{outcome_id, lead_id, lead_name, student_id, caller, promised_on, promised_date, promised_amount, paid_amount, state}]}` | readers | A promise = a call that was not corrected, with a promised date and amount. Paid = the student's payments that are not reversed, dated from the day of the call to the promised date + 2 days. States: kept (paid ≥ promised), part_paid (paid > 0), broken (nothing paid and the grace is over), waiting, no_student (not judged). `rows`: the newest 500. |
| `admin_set_result_creates_student(p_result uuid, p_on boolean)` | void | admin | The institute's own results only. Audit `call_type_result.creates_student_on` / `_off`. |
| `ledger_board(text)` | text or null | any signed-in | `'cbse'`, `'State board'` → `CBSE`, `State`. |

**Admission → student:** when `save_call_result` saves a result with `creates_student`, it adds one student per lead, with `source 'admission'`, `admission_lead_id`, and the lead's phone. Name, class, section, board and academic year come from the lead's `extra` (keys like `student` / `student name` / `child`, `class` / `grade` / `std`, `section`, `board`, `academic year` / `session`). When a student name is found, the lead's name becomes `parent_name`; otherwise the lead's name is the student's name. The lead's `student_id` is set. Audit `student.added_from_admission` `<student>:<lead>`. Accounts then add the fee plan.

Internal (granted to nobody): `student_balance_rows(p_institute, p_student default null, p_as_of default null)`, `ledger_sync_student(p_student)`, `ledger_student(p_student, p_write)`, `ledger_manager_seat(p_institute)`, `ledger_student_from_lead(p_lead, p_seat)`, `payment_is_live(p_payment)`, `ledger_today(p_institute)`, `ledger_amount(text)`, `ledger_date(text)`, and the triggers `ledger_guard`, `students_before_write`, `call_type_results_creates_student_default`.

**For the demo data:** add students, fee items and payments with the functions above (or with direct inserts as the table owner). If the demo's "Admission confirmed" uses a key other than `admission_done` / `admission_confirmed`, set `call_type_results.creates_student = true` on it. Tag campaigns with `class_label` / `board`.
<!-- end Phase A.2 -->


<!-- Phase A.2: caller -->
## Phase A.2: caller page

_No migration: callers read the ledger with `lead_ledger(p_lead)` (above)._

| Call | When | Notes |
|---|---|---|
| `my_campaigns()` | sign-in, reload | The campaign picker groups by `call_type_key` (fees, admission, sales, others), filters by `class_label` and `board`, shows `my_leads_due + pool_leads_due` as "N waiting" (`web/js/campaign-picker.js`). |
| `my_call_queue(p_campaign)` | as before | Reads `open_to_all`, `class_label`, `board`, `fees_due_by` and each lead's `student_id` and `due_date` (`{due_date}`: the lead's own extra field first, then `due_date`, then `fees_due_by`). |
| `next_free_lead(p_campaign)` | nothing callable in the caller's own queue, and the campaign is open or `next_free` | Rows or a lead id. |
| `lead_ledger(p_lead)` | a lead with `student_id` on the card | Balance due now and last payment (amount, date, mode); memory only. |
| `my_trial_status()` | sign-in | `institute_name` fills `{institute}`; kept on the device with the campaigns. |
| `my_common_answers()` | sign-in | Optional (missing function or no rows: the page uses `web/data/common_answers.json`, a copy of `supabase/templates/common_answers.json`). Rows `{key, label, answer, tags, fallback, result, check, filled}`; an answer with a non-empty `check` shows only when `filled` (or `check_filled`) is true or `check` is empty. |

Placeholders (`web/js/placeholders.js`): `{student}`, `{class}`, `{board}`, `{course}`, `{source}`, `{source_date}`, `{due_date}` come from the lead's `extra` keys (e.g. `student`, `class`, `board`, `course`, `source`, `enquiry date`, `due date`), then the campaign tags; `{source_date}` falls back to `leads.created_at`; `{amount_due}` from `lead_money`, else the ledger balance.
<!-- end Phase A.2: caller -->

<!-- Phase A.2: reports -->
### Reports, Home and Insights from the ledger

_Migration `20261025150000_ledger_reports.sql`, tests `supabase/tests/ledger_reports_test.sql`. Screens: `web/js/admin/reports.js`, `home.js`, `insights.js`._

Money received = ledger payments (not reversed, not reversals, not opening imports). What callers marked Paid stays apart, labelled "reported by caller". A **promise** = a fees lead with a promised date that is open (status `promised`), or closed (`done`) in the last 7 days. **Promised on** = the day of the latest uncorrected call on the lead with a promised date. **Ledger state**: `no_student` (lead not linked), `paid` (payments since the promise reach the promised amount, or the lead was closed), `part_paid`, `not_paid`. **Broken** = open, date passed, not `paid`. `admin_fees_ledger` and `admin_promises_ledger`: owners, managers and accounts (`can_read_ledger`, internal `report_require_ledger`), so an Accounts seat can open Reports > Fees collection (the page then shows only that report, leaves out the caller-reported line and "Send these back", and its Excel export is logged with `log_money_export`, which accounts may call). `admin_home_ledger`: owners and managers only. Amounts null and `money_hidden` true unless `can_see_money()`.

| Function | Returns | What |
|---|---|---|
| `admin_fees_ledger(p_institute uuid, p_from date, p_to date, p_campaign uuid default null, p_seat uuid default null)` | jsonb `{from, to, campaign_id, today, money_hidden, has_ledger, linked_leads, due_now {students, amount}, collected {payments, reversed, total, by_mode, by_day}, promised {leads, amount}, broken {leads, part_paid, amount}, promises_paid {leads}}` | Reports > Fees collection tiles. Due now: active students (of the campaign, when picked) with balance due now > 0. Collected: `ledger_collected`. Promised: open promises dated today or later, not paid. Amounts of promised and broken = still to pay. The caller filter applies to promises only. Range ≤ 400 days. |
| `admin_promises_ledger(p_institute uuid, p_campaign uuid default null, p_seat uuid default null, p_days int default 7)` | table `(lead_id, name, extra, student_id, amount, promised_date, days_late, promised_on, seat_id, caller, campaign_id, campaign, next_call_at, lead_status, ledger_state, paid_amount, paid_on, paid_mode, money_hidden)` | "Promises due this week": dated up to today + `p_days` − 1, open or paid in the ledger; oldest first, 500 at most. `paid_on` / `paid_mode` = latest payment since the promise. "Send these back" skips `paid` rows and closed leads. |
| `admin_home_ledger(p_day text default 'today', p_campaign uuid default null)` | jsonb `{day, from, to, money_hidden, has_ledger, collected {payments, amount}, promises_due_unpaid {count, amount}, released_today {count, idle, inactive, revoked, admin}}` | Home: "Collected today (ledger)" (day / yesterday / Monday–Sunday), "N promises due today not yet paid in the ledger", "N follow-ups returned to the pool today" (audit `lead.released`, today in the institute's time zone; with a campaign, leads of that campaign). |

Internal (granted to nobody): `report_fee_promise_rows(p_institute, p_campaign, p_seat)`, `report_check_days(p_from, p_to)`, `report_require_ledger(p_institute)`.

Pages: without these functions, or when `has_ledger` is false, Reports and Home show what callers reported, as before. Insights "Are promises kept?" calls `promises_vs_payments(p_campaign)`; when at least one promise is linked to a student it is measured against the ledger (buckets from `rows` by days from `promised_on` to `promised_date`; part paid counts as not kept), else `admin_insights_promises`, with a note saying which.
<!-- end Phase A.2: reports -->


<!-- Phase A.2: template library -->
## Phase A.2: template library, common answers and platform admins

_25 Oct 2026. Migration `20261025140000_template_library.sql` (seed made by `scripts/build-template-seed.js` from `supabase/templates/*.json`; `tests/web/template-seed.test.js` checks they match). Tests: `supabase/tests/template_library_test.sql`._

**Tables** (global: no institute column; RLS on; the browser has SELECT only, writes go through the functions below):
- `platform_admins (user_id pk → auth.users, note, added_at)`: the Vector team. No browser access at all; add staff with SQL as the table owner.
- `script_templates (id, key unique, name, call_type (a built-in call_types.key), audience, about, class_labels text[], boards text[], language en|hinglish|hindi, steps jsonb, pushbacks jsonb, version int, active, updated_at, updated_by)`. Empty `class_labels` / `boards` = suits every class / board. Read by any active seat and platform admins (`can_read_library()`).
- `common_answers (id, key unique, label, answer, fallback, result (a common result key), checks text[], tags text[], active, updated_at, updated_by)`. Same read rule.
- `institute_answer_fills (institute_id, answer_key → common_answers.key, answer, updated_at, updated_by; pk (institute_id, answer_key))`: the institute's own text for an answer that has checks. Active seats of the institute read their rows.

| Function | Returns | Who | What |
|---|---|---|---|
| `is_platform_admin()` | boolean | any signed-in | The login is in `platform_admins`. The Scripts tab shows the Library view only then. |
| `list_script_templates(p_call_type text default null, p_class_label text default null, p_board text default null, p_language text default null, p_include_inactive boolean default false)` | table `(key, name, call_type, call_type_label, audience, about, class_labels text[], boards text[], language, steps jsonb, pushbacks jsonb, version int, active boolean, check_marks int, updated_at)` | active seat, platform admin | Null = any. Class matches any case; board takes `cbse`, `State board` …; an untagged template matches every class and board. Inactive templates only for platform admins who ask. Ordered by call type order, name, language. |
| `my_common_answers()` | table `(key text, label text, answer text, tags text[], fallback text, result text, "check" text[], filled boolean)` | active seat (callers too) | **For the caller page.** Active global answers. `answer` = the institute's own text when it filled the answer in, else the global answer. `"check"` = the checks list (quote the name in SQL). `filled` = no checks, or the institute has filled it in: show an answer on a call only when `filled` is true. 42501 without an active seat. |
| `admin_fill_common_answer(p_key text, p_answer text)` | boolean (true saved, false cleared) | owner, manager | The institute's whole answer (≤ 600 characters) for an answer with checks; null or blank clears it. 22023 for an unknown key or an answer without checks. Audit `common_answer.filled` / `common_answer.cleared`, target the key. |
| `platform_upsert_template(p_key text, p_name text, p_call_type text, p_steps jsonb, p_pushbacks jsonb default '[]', p_audience text default null, p_about text default null, p_class_labels text[] default '{}', p_boards text[] default '{}', p_language text default 'en', p_active boolean default true)` | int (version) | platform admin | Adds or changes a template. Checked: key, a built-in call type, 1–30 steps with unique ids, a start step, ≤ 3 choices that go to real steps, every ending linked to a result of the type, pushbacks as for scripts. "Check this" marks are allowed. The version goes up when name, type, language, steps or pushbacks change. |
| `platform_upsert_common_answer(p_key text, p_label text, p_answer text, p_fallback text default null, p_result text default null, p_checks text[] default '{}', p_tags text[] default '{}', p_active boolean default true)` | void | platform admin | Adds or changes a common answer; `p_result` must be a common result. |

Internal (granted to nobody): `platform_require()`, `template_problem(p_call_type, p_steps, p_pushbacks)`. `can_read_library()` is granted to `authenticated` (used by RLS).

**Who uses what.** Scripts tab: "Start from a template" calls `list_script_templates` (filters: purpose, class, board, language) and "Use this template" starts a new institute script (saved with `admin_save_script`) with the template's call type and its check marks; a changed template changes only scripts made later. Library view (platform admins): `list_script_templates(p_include_inactive => true)`, the `common_answers` table, `platform_upsert_template`, `platform_upsert_common_answer`, and the `ai-script-draft` Edge Function, which now answers 403 `code: "not_platform_admin"` for anyone else (`is_platform_admin`; the person still needs an admin seat with AI drafts for the monthly limit and cost log). Settings: "Common answers" card (`my_common_answers`, `admin_fill_common_answer`). Callers tab: "Back to pool" (`admin_release_leads`), role "Accounts" (`admin_set_seat_role`), and the invite form (Caller / Manager / Accounts) through the `seat-admin` Edge Function, which now takes `role` `rep` / `admin` / `accounts` (also `caller` / `manager`) and passes it to `invite_seat` (seat limit; Accounts by owners only).
<!-- end Phase A.2: template library -->

## Phase A.2: integration (migration 20261025180000_phase_a2_integration.sql)

| Function | Change |
|---|---|
| `my_call_queue(p_campaign)` | Same access and keys, plus `fees_due_by` (the campaign's) and, per lead, `due_date`: the campaign's `fees_due_by` when set, else for a lead with a student the due date of the student's oldest fee item not covered by payments (reversals counted), else null. |
| `admin_callers(p_institute)` | Same columns. An Accounts seat (`role = 'accounts'`) has `campaigns = []`, `calls_target` null and `now_status` null: it is listed as a seat with the role Accounts, never as a caller. |
| `admin_home_summary(p_day, p_campaign)` | Same answer. `callers` never holds an Accounts seat; with `p_campaign` set it lists the campaign's members and the callers holding its open leads (open campaigns have no members). |
| `my_common_answers()` | Same columns, in the library's order (`common_answers.sort_order`, new column, default 1000 = last; then label): "Where did you get my number?" first. |
| `institute_tz(p_institute)`, `student_balance_rows(...)` | Same answers, faster: the zone is checked without `pg_timezone_names`, and "today" is worked out once per call (before, `accounts_students` timed out on 570 students). |
| internal `student_next_due_date(p_student)` | Granted to nobody. The due date of the student's oldest unpaid fee item, or null. |

Web: the Callers tab hides campaigns, "Move leads" and "Back to pool" for an Accounts seat, and "Back to pool" counts only leads in campaigns that are not closed (what `admin_release_leads` sends back). Campaign member checks and the Reports caller filter leave Accounts seats out; Reports for an Accounts seat shows no campaign or caller filter. The Settings "AI drafts used" line shows for platform admins only.

<!-- Add row -->
## Add row: "+ Add one" beside every Excel import (migration 20261026100000_add_row.sql)

_26 Oct 2026. Tests: `supabase/tests/add_row_test.sql`, `tests/web/add-row.test.js`, `tests/e2e/add-row.spec.js`._

| Function | Change |
|---|---|
| `admin_add_leads(p_campaign, p_rows)` | Same signature, checks and answer. Each row may also carry `consent_call` (default true) and `consent_whatsapp` (default false): a JSON boolean or the text `yes` / `no` / `true` / `false`; any other value skips the row as `other_skipped`. Rows without the keys (Excel uploads) behave as before. |
| internal `lead_row_consent(p_row jsonb, p_key text)` | Granted to nobody. |

Web (`web/js/admin/add-row.js`, shared by Fees and Calling):
- **Fees → "+ Add student"** (beside "Import from Excel"): `accounts_save_student(null, p_data)` with every detail key, then `accounts_add_fee_item` per fee line and `accounts_record_payment` for "paid so far" (mode and reference; note "Paid so far, added with the student"; dated the day picked, so it counts in Collected for that day, unlike an import's opening balance). Before saving, the page lists students with the same admission number (save blocked; the database refuses it too) or the same name and phone / alternate phone ("Save anyway"). Phones are checked and normalised like the lead importer (`+91` and 10 digits). **Edit details** on a student's page uses the same form with `accounts_save_student(p_student, p_data)`.
- **Calling → a calling list → "+ Add lead"** (beside "Import from Excel"): `admin_add_leads` with one row: name, phone, the list's extra fields (read from a few of its leads' `extra`, or the call type's usual ones), `extra.source` ("Where we got the number"), consent to calls and WhatsApp, and `amount_due` only on a fees list for someone with `can_see_money`. The answer's counts say "added", "not a 10-digit mobile number" or "already on this list".
- **New calling list, step 3 → "+ Add by hand"**: a small table (at least one row, "+ Add row") sent through the same `admin_add_leads` call as a sheet.
- **Excel templates** (`VectorExcel`, `js/excel-export.js`): "Download a ready Excel template" in the Fees import and both lead pickers: the headings the importers match and one example row (fake numbers), and a "How to fill" sheet. A lead template has an "Amount due" column only for a fees list and someone who can see money.
<!-- end Add row -->
