# Permissions: Vector Companion (Phase 2)

The app asks only for what call-state testing needs. It never records or sends audio, and never reads contacts or SMS. It reads one call-log row only if you turn that option on. Phone numbers appear in its log in masked form only (`+91•••••••210`).

| Permission | Why | How it's granted | Needed? |
|---|---|---|---|
| `CALL_PHONE` | Place the call when you press **Call** (`TelecomManager.placeCall`) | **Grant phone permissions** button → Allow | Yes |
| `READ_PHONE_STATE` | Receive IDLE / RINGING / OFFHOOK for each SIM and list your SIMs. This doesn't give the number. | Same button | Yes |
| `POST_NOTIFICATIONS` | Show the "watching call state" notification | Same button | Recommended |
| `ANSWER_PHONE_CALLS` | **Hang up** button only (`TelecomManager.endCall`) | Same button | Optional |
| `READ_CALL_LOG` | Optional lookup: after a Vector call ends, read **only that call's row** to get the connected seconds | Tick **Call-log lookup** → Allow | Optional, off by default |
| `CALL_COMPANION_APP` | Allows Telecom to bind the observer-only InCallService if Android accepts the app as a call companion | Automatic (normal permission) | Being tested |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `CHANGE_NETWORK_STATE` | Keep the monitor running with the screen off. Android 14 requires a service type; `CHANGE_NETWORK_STATE` is that type's prerequisite and is also used by the Phase 3 laptop link. | Automatic | Yes |
| `RECEIVE_BOOT_COMPLETED` | Log reboots and restart the monitor afterwards | Automatic | Yes |

## Nothing OS battery setting (important)

Nothing OS may stop background apps. On the phone:

1. Tap **Battery: unrestricted** in the app. If the list opens, choose **All apps → Vector Companion → Don't optimise**.
2. Also check **Settings → Apps → Vector Companion → Battery → Unrestricted**.

## Turning things off

- **Revoke a permission:** Settings → Apps → Vector Companion → Permissions. Android stops the app when you do this. The next start logs the new permission set, and any open call session is marked `SESSION_ORPHANED`, never guessed.
- **Uninstalling** removes the app and its log.

## What the app will never do

- Dial without you pressing **Call**. In Phase 3, this changes to a signed request from your paired browser.
- Pick a SIM silently. It uses the SIM you chose in the app, or Android's default or "ask every time" picker.
- Record audio, or read contacts, SMS or other call-log entries.
- Become your default phone app.
