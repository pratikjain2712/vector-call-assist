# Phase 3: laptop ↔ phone link (spike)

Goal: prove that the website on your laptop can reach the Nothing Phone over Wi-Fi, pair with it, and send encrypted requests (ping, read events, dial), before any integration work.

## What is built
| File | Role |
|---|---|
| `android/.../LinkCrypto.kt` | Pairing key, AES-GCM seal/open (framework `javax.crypto` only) |
| `android/.../LinkServer.kt` | Plain-HTTP server on port **8765**, no library. Routes `/pair` and `/api`. |
| `android/.../MainActivity.kt` | Section **3 · Laptop link**: Start link + code, New code, Stop link, status |
| `android/.../AndroidManifest.xml` | `INTERNET` permission added |
| `web/link-spike.html` | Test page: Pair, Ping, Fetch events, Dial from phone |

## Protocol
```
Pairing  (plain JSON, once)
  POST http://<phone>:8765/pair   {"code":"482913","nonce":"<b64, 16 random bytes>"}
  -> {"ok":true}   or   {"ok":false,"error":"wrong code" | "code expired" | "too many attempts"}

  pairingKey = HMAC-SHA256(key=UTF8(code), msg=UTF8("vca-pair-v1|" + nonce))
  encKey     = HMAC-SHA256(key=pairingKey, msg=UTF8("vca-enc-v1"))      (AES-256-GCM key)

Requests (encrypted, after pairing)
  POST http://<phone>:8765/api
  Headers: X-Vca-Ts: <ms since epoch>   X-Vca-Nonce: <b64, 16 random bytes>
  Body:    base64( iv[12] || AES-GCM-ciphertext+tag )
  AAD:     "POST\n/api\n" + ts + "\n" + nonce
  Plain:   {"op":"ping"} | {"op":"events","after":N} | {"op":"dial","number":"+91…"}

Responses
  Body:    base64( iv[12] || AES-GCM-ciphertext+tag ),   AAD = "RESP\n" + requestNonce
  Errors (401/400/403/413) are plain JSON: {"ok":false,"error":"…"}
```
Rules the phone enforces on `/api`: timestamp within ±60 s, nonce not seen before (replay cache), GCM tag must verify, E.164 numbers only, one dial per 5 s, dial only when the phone is idle and monitoring is on.

Design note: GCM already authenticates the body and binds it to path, timestamp and nonce, so the separate HMAC signature in the Phase 1 plan is not needed. The security properties are the same.

Browser ↔ phone crypto was cross-checked (pairing key, request decrypt, tamper rejection, response decrypt) with a Java mirror of `LinkCrypto.kt`. The Android code itself is not compiled in this session (no Android SDK here); the first CI run is the first compile.

## Test steps (you, on the phone and laptop)
1. Install the new build (from the Android APK workflow) and open **Vector Companion**.
2. Tap **Start link + code**. Note the address (for example `192.168.1.20:8765`) and the 6-digit code. The code expires after 2 minutes.
3. On the laptop, open the test page. Use the GitHub Pages URL once Pages is set up, or `python -m http.server 8000` in `web/` and open `http://localhost:8000/link-spike.html`.
4. Enter the address and code, then tap **Pair**. Chrome may ask to let the site reach devices on your local network: choose **Allow**.
5. Tap **Ping**. Expect `Ping: {"ok":true,"op":"ping","phoneTime":…}`.
6. Tap **Fetch events**. Expect the recent phone event log.
7. Enter a number, tap **Dial from phone**, and confirm. The call should start on the phone with the same log entries as the Call button.
8. Check the phone log shows `LINK_STARTED`, `LINK_PAIR_CODE`, `LINK_PAIRED`, `DIAL_REQUESTED`, `PLACE_CALL_OK`.
9. Negative checks: a wrong code (expect "wrong code"), a second Ping after a page reload (should still work), and Ping with the link stopped (should fail with a network error on the page).

Please report: which step failed, the exact message on the page, and the phone log.

## Test results (2026-10-11, Nothing Phone + Firefox on the laptop, page served from localhost:8000)
| Check | Result |
|---|---|
| Pair with the right code | Pass (`LINK_PAIRED`) |
| Ping | Pass, phone time returned |
| Fetch events | Pass, 20 events |
| Dial from laptop | Pass. `DIAL_REQUESTED` to `PLACE_CALL_OK` in 19 ms, OFFHOOK 0.3 s after the request, call lasted 22.6 s |
| Number validation on the page | Pass, a number without country code is refused before sending |
| Wrong code | Pass, `Pairing refused: wrong code` |
| Ping after page reload | Pass, the key is kept in browser storage |
| Ping with link stopped | Pass, network error as expected |

Not yet tested: the attempt limit (`too many attempts`), and Chrome/Edge. Firefox reached the phone from a localhost page with no permission prompt, so Chrome's Local Network Access prompt is still unobserved.

Fixes after the test: Stop link no longer logs when already stopped, New code does nothing while the link is stopped, the test page restores the paired address after a reload, and the app sections are numbered in order.

## Known gaps (must close before production)
- **Pairing key storage:** plain SharedPreferences. Move to an Android Keystore-wrapped key.
- **Brute-force risk:** a 6-digit code sent in clear text on the Wi-Fi can be recovered offline by someone who captures the `/pair` exchange, within the 2-minute window. Production should pair with a 128-bit secret (for example in a QR code) instead.
- **Per-call notification:** the plan requires a notification for every laptop-initiated call. Not yet implemented.
- **Server lifetime:** runs only while the app is open. Production needs the foreground service (`connectedDevice`) to keep it alive with the screen off.
- **Origin allowlist:** includes `http://localhost:8000` and `http://127.0.0.1:8000` for testing. Remove before release.
- **Local Network Access:** Firefox needed no prompt. Chrome's prompt is expected but not yet observed, and Edge is unverified.
- **No WebSockets:** events are fetched on demand, not pushed.

## Protocol v2 and Phase 4 changes (website calls through the phone)
- **Pairing** now uses a 16-character secret (80 bits, shown as `XXXX-XXXX-XXXX-XXXX`). The secret is never sent. The browser sends `nonce` and `proof = HMAC(secret, "vca-proof-v2|"+nonce)`. Pairing needs a new code, so existing pairings must be redone.
- **Encryption key** on the phone is wrapped with an Android Keystore key (`LinkKeyStore`), not plain preferences.
- **Operations:** `ping`, `dial`, `hangup`, `status` (phase and wall-clock times), `result` (connected time from the call log), `events`.
- **Dial** shows a notification on the phone for each laptop-started call.
- **The server** restarts with the monitor service after a reboot if the link was on.
- **Allowed origin:** only `https://pratikjain2712.github.io`. Test from the Pages address.
- **Website:** `web/js/phone-link.js` (pairing and encrypted requests), `web/js/call-session.js` (per-call records, CSV export), and the "Call from laptop" controls in `web/index.html`. Lead sheets: CSV is read as text (leading zeros kept); numeric phone cells in spreadsheets are flagged.
- **Not yet verified on a phone:** the Android build of the v2 files (first CI compile), the Keystore wrap on Android 16, and the call-log result on your phone. The browser flow is tested against a mock phone (`mock-phone.mjs`, `e2e.py`).
