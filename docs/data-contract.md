# Data contract: Phase A cloud data

_24 Oct 2026, Sprint 7. Migrations `20261024100012_call_types_campaigns_leads.sql` and `20261024100013_money_rules.sql`. Tests: `supabase/tests/campaigns_leads_test.sql`, `supabase/tests/money_rules_test.sql` (run with `supabase/tests/run.sh <db> [files]`)._

This is what every Phase A feature builds on (campaigns, lead upload, caller screen, reports, insights, WhatsApp). If a feature needs something that is not here, add it in a new migration and update this file.

## Rules every feature must follow

1. **Money only through checked functions.** The browser role has no SELECT on `leads.amount_due`, `leads.promised_amount` or `call_outcomes.amount`, for anyone, owners included. A query that names these columns (or uses `select *` / `select('*')` on `leads` or `call_outcomes`) fails with "permission denied". Read money only through a `security definer` function.
2. **Every function that returns an amount, a total of amounts or anything computed from amounts calls `public.can_see_money(institute)` first.** If it is false, return the row with the money fields `null` (and say so, for example a `money_hidden boolean` column), or return counts only. Never raise just because money is hidden: a manager without money access still gets the counts.
3. **A caller sees money for one lead at a time**, through `lead_money(lead_id)`, and only for a lead assigned to their active seat. Never return amounts of other leads, totals or averages to a caller.
4. **`hide_money` hides money for everyone**, owners and callers included. `can_see_money()` and `lead_money()` already apply it; do not re-implement the check.
5. **Every export that contains money calls `log_money_export(institute, what, rows)` first** and stops if it raises. Exports for people who cannot see money have no ₹ columns.
6. **Paid amounts are labelled "reported by caller"** in the UI (decision 3).
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

## Not built here (for the feature agents)

Campaign create / edit / pause / close, adding and removing members, lead upload and moving leads, the caller queue order, reports, insights, WhatsApp. Each needs its own checked functions following the rules above.

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

When `scripts.call_type_id` exists (scripts feature), `campaign_check_script` and `SCRIPT_TYPE_FILTER` in `web/js/admin/campaigns.js` should also require the script's type to match (marked TODO in both).
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
