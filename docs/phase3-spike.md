# Phase 3: laptop ↔ phone link (spike)

Goal: prove that the website on your laptop can reach the Nothing Phone over Wi-Fi, pair with it, and send encrypted requests (ping, read events, dial), before any integration work.

## What is built
| File | Role |
|---|---|
| `android/.../LinkCrypto.kt` | Pairing key, AES-GCM seal/open (framework `javax.crypto` only) |
| `android/.../LinkServer.kt` | Plain-HTTP server on port **8765**, no library. Routes `/pair` and `/api`. |
| `android/.../MainActivity.kt` | Section **4 · Laptop link**: Start link + code, New code, Stop link, status |
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

## Known gaps (must close before production)
- **Pairing key storage:** plain SharedPreferences. Move to an Android Keystore-wrapped key.
- **Brute-force risk:** a 6-digit code sent in clear text on the Wi-Fi can be recovered offline by someone who captures the `/pair` exchange, within the 2-minute window. Production should pair with a 128-bit secret (for example in a QR code) instead.
- **Per-call notification:** the plan requires a notification for every laptop-initiated call. Not yet implemented.
- **Server lifetime:** runs only while the app is open. Production needs the foreground service (`connectedDevice`) to keep it alive with the screen off.
- **Origin allowlist:** includes `http://localhost:8000` for testing. Remove before release.
- **Local Network Access:** Chrome's prompt is expected but has not been observed yet on your laptop. Edge's behaviour is unverified.
- **No WebSockets:** events are fetched on demand, not pushed.
