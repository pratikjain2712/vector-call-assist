# Phase 2 test plan: what Android really reports on the Nothing Phone (2)

The goal is to find out, **from the actual phone**, which signals are available, before building the laptop integration. Nothing in this table counts as verified until a log from the phone backs it.

## Before you start (5 min)

1. Install the APK (see README) and open **Vector Companion**.
2. Tap **Grant phone permissions** and allow everything. Then tap **Battery: unrestricted** and set it.
3. Check the status block. It should say **Monitor: watching call state** and list your SIMs in the log (`WATCHER_STARTED …`).
4. Tap **Request companion role** once. Whatever it says is a result. Note it.
5. Optional: tick **Call-log lookup** and allow it. Scenarios 1–6 are more useful with it on.
6. Have a second phone, or a friend, available to answer, reject and hang up.

## How to run each scenario

1. Choose the scenario in the dropdown and tap **Start this scenario**. This writes a marker into the log.
2. Type the other phone's number and tap **Call**.
3. **At the exact moment the other side answers, tap "They answered".** This is the ground truth for checking accuracy.
4. Do what the scenario says, and wait about 10 s after it ends, so the call-log lookup can finish.
5. When all scenarios are done, tap **Share log** and send it to yourself (WhatsApp, email), then put it in the Vector folder or paste it to Claude.

## Scenarios

| # | Scenario | What to do | What we expect (assumption) | What to look for in the log |
|---|---|---|---|---|
| 1 | Answered normally | Other side answers, talk 30 s, you hang up | OFFHOOK at dial, IDLE at end. No answer event from Strategy 1. | `SESSION_BOUND`, `MANUAL_ANSWER_MARK`, `SESSION_ENDED`, `SUMMARY`, `CALL_LOG_RESULT connected≈30s` |
| 2 | Rings, never answered | Let it ring until it stops by itself | Same OFFHOOK→IDLE shape as #1 | `CALL_LOG_RESULT connected=0s` (if enabled) |
| 3 | Busy / rejected | Other side rejects; also try calling while they're on another call | Same shape, shorter | Any `ICS_STATE … cause=BUSY/REJECTED` (only if companion bound) |
| 4 | I cancel before answer | Tap **Hang up** in the app while it rings | `HANGUP_SENT` then IDLE | Check that `endCall` works: `HANGUP_SENT` vs `HANGUP_FAILED` |
| 5 | Ends normally | Answer, then you hang up on your phone | Same as #1 | |
| 6 | Remote hangs up | Answer, then the **other** side hangs up | Same as #1 | |
| 7 | Incoming, no session | Have someone call you while no test call is running | RINGING→OFFHOOK→IDLE logged, **no session touched** | `CALL_STATE` lines without a `[session]` tag |
| 8 | Incoming during session | While your test call is ringing or connected, have a third person call you | RINGING flagged, not counted | `INCOMING_DURING_SESSION`, possibly `SESSION_AMBIGUOUS` |
| 9 | SIM 1 vs SIM 2 / eSIM | Repeat #1 once per SIM using the SIM dropdown; also once with "phone default" | Each call goes out on the chosen SIM; per-SIM states | `sim=<id>` on `CALL_STATE` lines. Does the system SIM picker appear for "default"? |
| 10 | Network loss | Start a call, then switch on Airplane mode or walk out of coverage | Call drops to IDLE | Timing of IDLE vs the real drop |
| 11 | Background / screen off | Start a call, lock the phone, wait, end the call, unlock | Events still logged while locked | No gaps; `MONITOR_STOPPED` must not appear |
| 15a | Phone restart | Restart the phone, then open the app | `BOOT_COMPLETED` and `MONITOR_STARTED` appear without opening the app | |
| 15b | Permission revoked | Mid-call, revoke Phone permission in Settings | App is killed; next start shows `SESSION_ORPHANED` | Record is marked unknown, not saved as a success |

Scenarios 12–14 (browser refresh, duplicate events, lost pairing) need the laptop link and are tested in Phases 3–4.

## Results to fill in after testing

| # | Observed transitions (copy from log) | Connected time from: manual mark / call log / ICS | Accurate? | Verified on device |
|---|---|---|---|---|
| 1 | | | | ☐ |
| 2 | | | | ☐ |
| 3 | | | | ☐ |
| 4 | | | | ☐ |
| 5 | | | | ☐ |
| 6 | | | | ☐ |
| 7 | | | | ☐ |
| 8 | | | | ☐ |
| 9 | | | | ☐ |
| 10 | | | | ☐ |
| 11 | | | | ☐ |
| 15a | | | | ☐ |
| 15b | | | | ☐ |

## Questions this phase answers

1. Does OFFHOOK fire at dial time for outgoing calls on Nothing OS, as Android documents? (expected: yes)
2. Is `ICS_BOUND` ever logged? Is the **call companion role** available? If yes, we get exact answer and disconnect-cause events without becoming the dialer.
3. Does the opt-in call-log lookup match the manual answer mark to within about 1–2 s?
4. Does `placeCall` with a chosen SIM go out on that SIM, and does `endCall` still work on Android 14+?
5. Does the monitor survive the screen being off, the app in the background, and a reboot?
