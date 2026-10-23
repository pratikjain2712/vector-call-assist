# Architecture and decisions (from the Phase 1 audit)

Audited: `pratikjain2712/vector-call-guide` at `main` (`757ac53`, 8 Oct 2026). 3 files: `index.html` (565 lines, 49 KB), `README.md`, `.nojekyll`.

Each statement below is tagged:
- **[code]** read directly from the code
- **[doc]** confirmed against vendor documentation
- **[unverified]** must be tested on the Nothing Phone (2) or in your Chrome before relying on it

---

## 1. What exists today [code]

| Area | Implementation |
|---|---|
| Framework | None. A single static `index.html` with vanilla JS and inline CSS. No build step. The only external dependencies are SheetJS 0.18.5 from cdnjs and Google Fonts. Hosted on GitHub Pages. |
| Script content | `FLOW` (about 60 nodes: `say`, `tip`, `opts` → `to`), `STAGES` (6 stages), `OBJECTIONS` (11 pushback + 18 worry chips). The code has markers `/*DATA*/…/*END*/` and `/*SHEET*/…/*ENDSHEET*/`. |
| State | One global `state = {node, history, trail, objs, objection, started, elapsed, timer}` plus a global `sheet`. `render()` redraws everything. |
| Import | `#sheet-file` change → `readSheet(file)` → `XLSX.read(..., {raw:true})` → `ingest(aoa, fileName)`. The name and phone columns are found by regex on the header row. Six result columns are appended if they're missing. Returns `{fileName, header, rows, cols, idx, guessed}`. |
| Current customer | `sheet.idx` (row index). Helpers: `loadLead(i)`, `leadName()`, `nextOpen()`. **There is no customer ID**; a lead is identified only by its row position. |
| Phone numbers | Kept **raw**, exactly as the cell held them. The only processing is in `renderSheet()`: `tel:` + `phone.replace(/[^\d+]/g,"")`. There is no normalisation, validation, or country code handling. |
| Timer | `startClock()` runs on the **first script tap** (in `go()`), not when the call starts. `tick()` derives the time from `Date.now() - started`. `stopClock()` runs when an end node is reached. `back()` can restart it. **It measures script time, not call time.** |
| Outcomes | Reaching one of 8 `end_*` nodes calls `writeResult(sheet, state, label, when)`, which writes Call outcome, Called at (`en-IN` locale string, not ISO), Call duration (`MM:SS` from `elapsed`), Answers (the trail), and Objections raised. |
| Notes | A textarea on the end card writes `r[cols.notes]` and persists on every keystroke. |
| Persistence | `localStorage`: `vcg-sheet` holds the whole sheet as JSON and `vcg-me` holds the caller's name. `persist()` swallows errors. The active call is **not** persisted, so a refresh mid-call loses the script position and timer. |
| Export | `downloadSheet()` writes **XLSX** (`<name>-called.xlsx`) using SheetJS. There is no CSV export. |
| History | **One result per lead.** Calling a lead again overwrites the row ("Calling again replaces that result"). |
| Dialing | A plain `tel:` link. On a laptop it opens whatever app Windows has registered (for example Phone Link). |
| Keyboard | Y / N / M / Enter / Backspace, ignored while typing in inputs. |

### Must stay unchanged
The script flow, objection chips and copy; the stage rail; keyboard shortcuts; the WhatsApp message templates and Copy buttons; XLSX/CSV lead import with column guessing; the write-back to the six existing columns; **Download updated sheet (.xlsx)**; resuming from localStorage; Remove sheet; the visual design and dark mode; and the app working fully with **no phone connected**.

### Defects found that matter for v2
1. **Lost leading zeros.** Import uses `raw:true`, so a CSV phone like `09876543210` may become the number `9876543210`. [unverified, test with a sample CSV]
2. **No call history.** Re-calling a lead overwrites its only record, so a call log can't be kept in the row alone.
3. **Locale timestamps.** "Called at" uses an `en-IN` string, which isn't sortable or ISO.
4. **Timer accuracy.** The duration comes from a tick counter that starts on script interaction. It's useful as "talk-through time" but isn't call duration.

---

## 2. What Android can actually tell us

| Strategy | What it gives | Cost | Verdict |
|---|---|---|---|
| **1. `TelephonyCallback.CallStateListener`** (`READ_PHONE_STATE`) | Only IDLE / RINGING / OFFHOOK. For an outgoing call, OFFHOOK fires at **dial time**, not answer. You get no number and no disconnect cause. | Small | **Baseline.** It gives a reliable *total* call window (OFFHOOK→IDLE) but **no answer detection**. Busy, no-answer, rejected and a 5-second answered call all look the same. |
| Precise call state (`READ_PRECISE_PHONE_STATE`) | Dialing / alerting / active | Privileged/carrier-only | Not available to a sideloaded app. [unverified, but this is the expected platform rule] |
| **2. `InCallService` as default dialer** (`ROLE_DIALER`) | Exact `STATE_DIALING → ACTIVE → DISCONNECTED` plus `DisconnectCause` (BUSY, REJECTED, MISSED, ERROR) | **Large.** It replaces the phone's dialer and must handle every incoming call and in-call screen. | Only if Strategy 1+3 prove insufficient, and only with your explicit approval, as a separate phase. |
| **3a. Companion `InCallService`** (`CALL_COMPANION_APP`) | Same call objects as Strategy 2, without becoming the dialer | Medium | [unverified] I couldn't confirm from the docs in this session what Android 14 requires for an app to be bound as a call companion. Phase 2 will test it on the device. If Telecom binds it, this is the best option. |
| **3b. One-row call-log lookup after hang-up** (`READ_CALL_LOG`, opt-in) | `CallLog.Calls.DURATION` = connected seconds (0 if never answered) for the one call just placed | Small | It reliably separates "answered" from "not answered" and gives the true talk time, **after** the call. It can't tell busy from rejected from no-answer. You ruled it out as the *primary* method, so it's offered as an **optional, off-by-default enrichment** that queries only the matching number and time window. |
| Accessibility, notification scraping, audio | n/a | n/a | Excluded, as you asked. |

**Consequence.** Unless 3a works on your phone, the live website can show "Dialling / in call (approximate)" but **cannot start a true connected-time timer while the call is in progress**. At hang-up, 3b (if enabled) gives the exact talk time and answered yes/no.

**Placing the call.** `TelecomManager.placeCall(uri, extras)` with `CALL_PHONE` is a direct call, not a dialer pre-fill. Passing `EXTRA_PHONE_ACCOUNT_HANDLE` selects the SIM. The list of SIMs comes from `getCallCapablePhoneAccounts()` (`READ_PHONE_STATE`). If no SIM is chosen and Android is set to "Ask every time", the system SIM picker appears on the phone. Whether `placeCall` works while the app is in the background with a foreground service is [unverified]; Phase 2 tests it. Hang up uses `TelecomManager.endCall()` (deprecated in API 29) with `ANSWER_PHONE_CALLS`; whether it still works on Android 14 is [unverified].

---

## 3. Laptop ↔ phone connection

The site is HTTPS (GitHub Pages). An HTTPS page normally can't call `http://192.168.x.x` (mixed content), and it can't use the phone's self-signed HTTPS without a certificate warning.

| Option | Works from GitHub Pages? | Notes |
|---|---|---|
| **A. Chrome/Edge Local Network Access + phone HTTP server on the same Wi-Fi** | **Yes, for `fetch()`** [doc] | Chrome shows a "connect to devices on your local network" permission prompt (launched in Chrome 142). Requests to **private IP literals** are exempt from mixed-content blocking. **WebSockets are not covered yet**, so events use `fetch` long-polling. Needs: the same Wi-Fi with no client isolation, a reachable phone IP, and a recent Chrome or Edge. [unverified] Edge's rollout and your Chrome version. |
| **B. Web Bluetooth** (phone acts as a BLE GATT peripheral) | Yes | No Wi-Fi or IP issues. Needs laptop Bluetooth and Chrome or Edge. After a page refresh the user must click and pick the phone again. Windows BLE can be flaky. A good fallback. |
| C. Self-signed HTTPS on the phone | Poor | Certificate warnings, and the phone's IP changes. |
| D. WebRTC with manual or QR signalling | Clunky | Needs a two-way copy/paste or scan, or a third-party signalling server. |
| E. Small relay (for example a free Cloudflare Worker) | Yes | Adds a backend. Last resort only. |
| F. WebUSB + ADB | Yes | Needs USB debugging and Windows drivers. Not appropriate for daily use. |

**Recommendation: A, with B as the fallback** if your office Wi-Fi isolates clients or Edge/Chrome blocks it. Phase 3 is a 1-page spike that proves A on your actual laptop, phone and network before any integration work.

### Security design (applies to A or B)
- **Pairing.** The phone shows a QR code containing the phone's IP, port and a one-time 6-digit code that expires after 2 minutes. You type it on the website, or scan it with the laptop webcam, which is optional. Both sides derive a 32-byte **pairing key** (the website stores it in localStorage; the phone stores it in EncryptedSharedPreferences). The code is single-use.
- **Every message is signed.** HMAC-SHA256 over `{v, type, sessionId, seq, ts, body}`, with a nonce and a ±60 s timestamp window to block replays. The phone rejects unsigned requests with no details. The phone server binds only while the companion is running and paired.
- **No secrets in the GitHub Pages JS.** The key is created per pairing, per browser.
- **Plain HTTP on the LAN means no confidentiality**, so phone numbers could be seen by someone sniffing the same Wi-Fi. Mitigation: encrypt payloads with AES-GCM under the pairing key (WebCrypto on the site, javax.crypto on the phone). This is cheap, so I'll include it.
- **Validation.** The phone accepts only E.164 numbers (`^\+[1-9]\d{7,14}$`) and only one active session at a time. It refuses to dial if the phone isn't IDLE, rate-limits to 1 dial per 5 s, and **shows a notification for every call it places**. A per-call "Confirm on phone" setting is available; see question 3.
- **CORS.** The phone server answers preflights only for `https://pratikjain2712.github.io`, and also sends `Access-Control-Allow-Private-Network: true` for older Chrome.

---

## 4. Call lifecycle (website state machine)

```
IDLE ─Call─▶ REQUESTED ─ack─▶ PLACING ─OFFHOOK─▶ IN_CALL ─IDLE─▶ ENDED ─outcome saved─▶ SAVED ─▶ IDLE
              │ timeout/reject     │ fail/no OFFHOOK in 20s          │ link lost
              ▼                    ▼                                  ▼
            FAILED               FAILED                         UNCERTAIN ─replay on reconnect─▶ ENDED
```
- **Session ID:** `crypto.randomUUID()`. The active session is persisted to `localStorage["vcg-active"]` **before** sending, so a page refresh resumes it.
- **Phone-side event log:** every event `{sessionId, seq, type, at (ISO with offset)}` is appended to a file on the phone first and then sent. When the site reconnects, it asks for "events after seq N", so nothing is lost and **duplicates are dropped by `(sessionId, seq)`**. That makes handling idempotent.
- **Binding:** a session binds only to the **first IDLE→OFFHOOK within 20 s of `placeCall`**. RINGING during a session (an incoming call) is logged as `interrupted_by_incoming`. Its time is never added to the lead, and with no session active, phone state is ignored entirely.
- **Timer:**
  - No companion: the existing script timer is **unchanged**.
  - With the companion: the clock shows *"Call time (incl. ringing), approximate"* from OFFHOOK and freezes at IDLE.
  - Connected duration is shown only when the source is 3a or 3b. A connected time is never made up.
- **Auto-save:** at IDLE the record is written immediately with `saveStatus:"awaiting-outcome"`. When an end node is reached, or the outcome is picked manually, it becomes `"saved"`. **Next lead** stays disabled until then, unless you click "Continue anyway", which saves the record as `incomplete`.

## 5. Record schema

The existing six sheet columns keep working as the per-lead summary. A **new call log** (`localStorage["vcg-calls"]`, an array keyed by `sessionId`) holds one record per call, so re-calls stop overwriting history. It uses the same localStorage mechanism, not a new database.

`sessionId, customerId (sheet name + row + normalised phone), customerName, phoneNumber (E.164), simLabel (if the user picked one), dialInitiatedAt, offhookAt, ringingAt (incoming interruption only), answeredAt (only from 3a/3b; otherwise blank), endedAt, connectedDurationSeconds (blank if unknown), totalCallDurationSeconds (endedAt − offhookAt), callStatus (answered | not_answered | busy | rejected | cancelled | failed | ended_unknown | interrupted), answerDetectionQuality (exact | call-log | approximate | manual), outcome, objections, notes, scriptDurationSeconds, saveStatus (awaiting-outcome | saved | incomplete), updatedAt`

All durations are computed from ISO timestamps, which include the +05:30 offset.

_Update 24 Oct 2026:_ this local call log is still used for calls from a laptop lead sheet. Campaign calls (Phase A) also store the lead, the campaign and the result key in the cloud; see section 10.

## 6. Results download (one workbook)
**Download results (.xlsx)** writes one file, `<name>-called.xlsx`, with two tabs. The separate CSV export was removed.
- **Leads** (first tab, so uploading the file again still reads it as the lead list): the uploaded sheet with the six result columns, plus `Outcome code`, `Answered`, `Connected time (s)` and `Session ID` from the lead's latest call. These four are filled at download time, because the phone's call log answers after the outcome is tapped. A row with no call record keeps what the file already had.
- **Calls**: one row per call attempt, for dashboards. Fixed columns (session, source `laptop`/`manual`, lead row, phone times, connected seconds, outcome label and `Outcome code`, `Stage reached`, `Script time (s)`, `Answer path` as `node=answer > …`), then **one column per script question** (`Q: <label>`, holding Yes/No/Maybe, blank if not asked, last answer if asked twice) and **one column per objection** (`Objection: <chip>`, `Yes` if raised). The question and objection columns are generated from `FLOW`/`LABEL` and `OBJECTIONS`, so new ones get a column automatically.
- Every call finished in the script gets a record, not only laptop calls: calls made another way are saved with source `manual` and no phone times.
- Phone numbers are written as text cells, so Excel keeps the `+` and leading zeros.

## 7. Proposed file structure

```
vector-call-guide/            (existing repo)
  index.html                  existing; small hooks added
  js/phone-link.js            pairing, signing/encryption, fetch long-poll, reconnect
  js/call-session.js          state machine, event dedup, record store, Calls tab
  docs/                       architecture, permissions, test checklist
  .github/workflows/android.yml   builds the debug APK (see note)
android/                      Android Studio project (Kotlin, minSdk 34, targetSdk 35)
  app/src/main/java/.../
    MainActivity.kt           status, permissions, pairing QR, live event log
    CallMonitorService.kt     foreground service (connectedDevice): listener + server
    CallStateWatcher.kt       TelephonyCallback → events
    Dialer.kt                 placeCall / SIM list / endCall
    LinkServer.kt             tiny HTTP server (no library) + HMAC/AES-GCM
    EventLog.kt               append-only, survives restarts
    CallLogProbe.kt           optional 3b lookup (off by default)
```

**Build note.** My cloud workspace can't reach Google's Android SDK or Gradle servers, and this session can't push to your GitHub repo yet. For the APK, either you build in Android Studio on your laptop (I'll give exact steps), or you grant push access and a GitHub Actions workflow builds the APK for download. I won't claim an APK is built until one actually is.

## 8. Phases

1. ✅ **Audit** (this document)
2. **Android call-state proof of concept.** A bare app with a big log screen: grant permissions, choose a SIM, place a test call, and see timestamped IDLE/RINGING/OFFHOOK. It also tries companion `InCallService` binding (3a) and the optional call-log probe (3b). You run the 15 test scenarios; we record what is actually observed.
3. **Connection spike.** A test page on GitHub Pages ↔ phone server: pairing, the LNA prompt, signed ping, dial command, and event long-poll. Web Bluetooth is the fallback if needed.
4. **Website integration** in `index.html` plus the two JS files.
5. **Test and package.** APK, documentation, test checklist with observed results.

## Decisions (11 Oct 2026)
- Connection: **same Wi-Fi, fetch + Local Network Access** (Web Bluetooth stays as the fallback only if the spike fails).
- Phase 2 tests **companion InCallService** and the **opt-in call-log lookup**.
- No per-call confirmation on the phone; a notification is shown for every call.
- APK is built with **GitHub Actions**, which needs push access to the repo for this session.

## 9. Permissions (planned)

| Permission | Why | When |
|---|---|---|
| `CALL_PHONE` | Place the call with `placeCall` | Runtime prompt |
| `READ_PHONE_STATE` | Call-state listener and SIM list | Runtime prompt |
| `POST_NOTIFICATIONS` | Foreground-service and "calling X" notifications | Runtime prompt |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE` | Stay alive while the screen is off | Install-time |
| `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | Local server and showing the phone's IP | Install-time |
| `ANSWER_PHONE_CALLS` | Hang Up from the laptop only | Runtime; optional |
| `READ_CALL_LOG` | 3b exact talk time only | Runtime; **optional, off by default** |
| Battery: "Unrestricted" for the app | Nothing OS may kill background services | Manual setting |

No contacts, SMS, microphone, audio or call-log upload. The app never dials without a signed request from your paired browser.

## Repo decision (11 Oct 2026)
v2 goes in a **new public monorepo** (`vector-call-assist`); v1 stays live untouched.
```
web/  android/  docs/  .github/workflows/{android-apk.yml, pages.yml}
```
- Pages deploys `web/` via GitHub Actions; the APK is a workflow artifact.
- **Shared origin:** v1 and v2 are both on `pratikjain2712.github.io`, so they share localStorage. v2 must use its own keys (`vca2-*`) and offer a one-time "Import from v1" that reads `vcg-sheet` / `vcg-me` without changing them.
- The companion's CORS allowlist origin stays `https://pratikjain2712.github.io`.

## 10. Cloud data, Phase A (24 Oct 2026)

Decision 1 of `docs/phase-a-plan.md` changes the earlier rule that lead names and numbers stay on the laptop:
- **Leads uploaded to a campaign are stored in Supabase** (`leads`: name, phone as `+91` and 10 digits, extra sheet fields, assigned seat, status, next call date, consent). A caller reads and updates only the leads assigned to their own active seat; admins read their institute's leads. A sheet opened on the laptop without a campaign still stays in the browser.
- **Call types are data** (`call_types`, `call_type_results`), not code: 8 built-in types plus 5 common results, and each institute can add its own. A campaign has one type; the caller's result buttons come from it.
- **`call_outcomes`** gains `campaign_id`, `lead_id`, `result_key`, `promised_date`, `amount`, `result_reason`, `rating`, `step_times`, `reached_step`. The old `outcome` column is still filled (from the result), so the existing reports keep working.
- **Roles and money:** `seats.role` stays `admin` / `rep`; `seats.admin_kind` splits admins into owner and manager (`seats.access_role` = owner / manager / caller). Money columns are never readable directly from the browser; they come only through functions that check `can_see_money()` (owner, or manager with "Can see money", and "Hide money everywhere" off) or, for a caller, `lead_money()` of one assigned lead. Money exports are written to the audit log.

Tables, columns, functions and the rules every feature must follow are in `docs/data-contract.md`. Migrations: `supabase/migrations/20261024100012_call_types_campaigns_leads.sql`, `20261024100013_money_rules.sql`.
