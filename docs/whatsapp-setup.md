# WhatsApp setup (Sprint 12)

_Meta WhatsApp Cloud API, used directly (no provider). Migration `supabase/migrations/20261024100027_whatsapp.sql`; Edge Functions `whatsapp-send`, `whatsapp-webhook`, `whatsapp-reminders`, `whatsapp-admin` (logic in `logic.mjs` next to each, shared code in `supabase/functions/_shared/`); Settings panel `web/js/admin/settings-whatsapp.js`; caller helper `web/js/whatsapp-client.js`. Tests: `supabase/tests/whatsapp_test.sql`, `tests/web/whatsapp-functions.test.js`, `tests/web/whatsapp-web.test.js`, `tests/e2e/whatsapp.spec.js`._

What it does:
- A caller sends an approved message (template) to the lead they just called, only when the lead agreed to WhatsApp (`consent_whatsapp`) and is not "do not call". The same message goes to the same lead at most once a day.
- Delivery and read status come back by webhook. Replies are stored on the lead. A reply "STOP" (also "band karo", "mat bhejo", "बंद करो" …) turns WhatsApp consent off for that number.
- Every day at 9:30 am India time, a reminder goes to each lead whose promised payment date is tomorrow (template `promise_due`, utility). Never twice for the same promise.
- Every Monday, owners who turned it on get the weekly brief on WhatsApp (template `weekly_brief`), with the lines of `admin_weekly_brief(campaign)` from Insights. If the database has no `admin_weekly_brief` yet, this is skipped.
- Settings shows the number, the templates and their approval status, and this month's count and estimated cost (Meta India rates before GST: utility ₹0.115, marketing ₹0.86). The cost is shown only to people who can see money.

## 1. What Pratik does at Meta (start early: checks take days to weeks)

For our own test number now, and for each institute that uses its own Meta account later (the "who pays" decision is still open; both ways work, see step 6).

1. **Meta Business account.** business.facebook.com, create the business with its legal name.
2. **Business verification.** Business settings > Security Centre > Start verification. Have ready: GST certificate or company registration (or Udyam), a business phone and address that match the papers, and a website on the business domain that names the business. Meta may ask for a verification email on that domain. Usually 2 to 10 working days.
3. **App.** developers.facebook.com > My Apps > Create app > type "Business", linked to the business. Add the product **WhatsApp**. This creates a test WhatsApp Business Account (WABA) as well.
4. **Phone number.** WhatsApp > API Setup > Add phone number. Use a number that is **not** on the WhatsApp or WhatsApp Business app (delete the app account first if it was). It must get an SMS or call for the code.
5. **Display name.** Set it when adding the number. It must match the business name (or an obvious short form) and the website. Meta reviews it; messages can only go out after it is approved. Unverified businesses can message only 250 people a day.
6. **Permanent token (System User).** Business settings > Users > System users > Add (role Admin). "Add assets": the app (full control) and the WhatsApp account (full control). "Generate token": choose the app, expiry **Never**, permissions `whatsapp_business_messaging` and `whatsapp_business_management`. Copy it once. **Never paste it in chat, email or the repo.**
   - Institute's own account: the owner pastes this token in Vector > Settings > WhatsApp (it is stored encrypted, see "Where the token lives").
   - Through our Meta business (pass-through): keep our system user's token as the Supabase secret `WHATSAPP_PLATFORM_TOKEN` instead. (The Settings panel's "connect through Vector" switch is not built yet; the server already accepts `use_platform: true`.)
7. **App secret.** App settings > Basic > App secret > Show. This becomes `WHATSAPP_APP_SECRET` (it signs every webhook call).
8. **Payment method.** WhatsApp Manager > Payment settings: add a card, or messages stop after the free test allowance.
9. **IDs for Settings.** WhatsApp > API Setup shows the **Phone number ID** and the **WhatsApp Business Account ID**. Both are digits.
10. **Webhook** (after deploying, section 3): App > WhatsApp > Configuration > Webhook > Edit. Callback URL `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`, Verify token = the value of `WHATSAPP_VERIFY_TOKEN`. Then "Manage" and subscribe to the fields **messages** and **message_template_status_update**. (Vector also subscribes the app to each business account when an owner connects.)
11. **App mode.** Switch the app to Live (needs a privacy policy URL on the app's Basic settings).

## 2. Secrets (server only)

Set with the Supabase CLI from the laptop, never in the repo or the web page:

```sh
# 32 random bytes, base64: encrypts each institute's token before it is stored. Keep a copy in the password
# manager: if it is lost, every institute must paste its token again.
supabase secrets set WHATSAPP_TOKEN_KEY="$(openssl rand -base64 32)"
supabase secrets set WHATSAPP_APP_SECRET='<app secret from step 7>'
supabase secrets set WHATSAPP_VERIFY_TOKEN="$(openssl rand -hex 24)"     # typed again in step 10
supabase secrets set WHATSAPP_CRON_SECRET="$(openssl rand -hex 32)"      # also goes in the schedule below
# Only for institutes connected through our own Meta business:
supabase secrets set WHATSAPP_PLATFORM_TOKEN='<our system user token>'
# Optional: Graph API version (default v23.0)
supabase secrets set WHATSAPP_GRAPH_VERSION=v23.0
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions by Supabase.

### Where the token lives (and why)

- The owner pastes the token once. `whatsapp-admin` checks it with Meta, encrypts it with AES-256-GCM using `WHATSAPP_TOKEN_KEY` and stores only the ciphertext in `whatsapp_secrets`.
- `whatsapp_secrets` has row-level security on, **no policy and no grant** for the browser roles: nobody signed in (owners included) can read it, and the Settings panel never shows it again. Only the `wa_*` functions, which only the service role can run, return the ciphertext to the Edge Functions, which decrypt it in memory to call Meta.
- Not one Supabase secret per institute: that needs a CLI deploy for every new institute, and every function would see every institute's token. Not Supabase Vault alone: the key would sit in the same database as the ciphertext. With our scheme a database dump without the server secret reveals no token.
- Disconnecting deletes the stored token. A token Meta refuses (expired, revoked) marks the number "Needs attention" until an owner connects again.

## 3. Deploy

```sh
supabase db push                                   # applies 20261024100027_whatsapp.sql
supabase functions deploy whatsapp-send            # JWT check on (callers)
supabase functions deploy whatsapp-admin           # JWT check on (admins)
supabase functions deploy whatsapp-webhook --no-verify-jwt      # Meta signs requests instead
supabase functions deploy whatsapp-reminders --no-verify-jwt    # the schedule sends x-cron-secret instead
```

The `_shared` folder is bundled with each function automatically.

### Daily job

Run once in the SQL editor (needs the `pg_cron` and `pg_net` extensions: Database > Extensions). The cron secret is kept in Vault, not in the job text:

```sql
select vault.create_secret('<the WHATSAPP_CRON_SECRET value>', 'whatsapp_cron_secret');
select cron.schedule('whatsapp-daily', '0 4 * * *',   -- 04:00 UTC = 9:30 am India
  $$ select net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/whatsapp-reminders',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
                    (select decrypted_secret from vault.decrypted_secrets where name = 'whatsapp_cron_secret')),
       body := '{"job":"all"}'::jsonb) $$);
```

The job is safe to run more than once a day: each reminder and each brief is claimed once (a failed one is tried again on the next run). To try it by hand: `curl -X POST -H "x-cron-secret: …" -d '{"job":"reminders"}' https://<project-ref>.supabase.co/functions/v1/whatsapp-reminders`.

## 4. In Vector (each institute)

1. Owner: Settings > WhatsApp number > fill Phone number ID, WhatsApp Business Account ID, display name and the token > Connect. Vector checks them with Meta.
2. Admin: Messages > "Start from: Fees reminder / Promise due / Course details / Weekly brief" (or New message), adjust the text, Save, then **Submit for approval**. Meta answers within minutes to a day; the webhook (or "Check approval status") updates the status.
   - `promise_due` must stay a **utility** template: the daily reminder uses it.
   - Messages that offer a course or a discount are **marketing** (₹0.86 each); Meta may move a template to marketing on its own.
   - Every message should end with "Reply STOP to stop these messages."
3. Owner (optional): Weekly brief on WhatsApp > tick, own mobile number > Save. Needs `weekly_brief` approved.
4. Callers record consent on the call ("Can we send you this on WhatsApp?"). WhatsApp is off for a lead until a caller records a yes.

## 5. For other features

| What | Where |
|---|---|
| Send after a call (caller page) | `VectorWhatsApp.sendAfterCall(client, leadId, templateKey, params)` in `web/js/whatsapp-client.js` → `{ ok, messageId }` or `{ ok: false, error }`; `loadTemplates(client)`, `forResult(list, callTypeKey, resultKey)`, `typedBlanks(t)`, `preview(t, values, typed)`, `leadMessages(client, leadId)` |
| Settings panel | `VectorSettingsWhatsApp.mount(box, ctx)` / `unmount()` in `web/js/admin/settings-whatsapp.js`; load the script after `shared.js`. It adds `css/admin-settings-whatsapp.css` itself if the page does not link it. |
| Browser RPCs | `admin_whatsapp_overview()`, `admin_whatsapp_save_template(...)`, `admin_whatsapp_delete_template(id)`, `admin_whatsapp_brief(on, phone)`, `my_whatsapp_templates()` |
| Tables the browser reads | `whatsapp_accounts` (admins), `whatsapp_templates` (admins; callers: approved only), `whatsapp_messages` (admins; callers: their leads; no `cost_inr`), `whatsapp_brief_recipients` (own row) |
| Service-role only | `wa_*` functions, `whatsapp_secrets` |

WhatsApp is not an add-on (`has_feature`): every plan can use it; the institute pays Meta for messages.
