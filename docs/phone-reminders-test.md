# Phone reminders: device test

Callback reminders are local notifications the laptop asks the phone to show at a set time. Test on the Nothing Phone (2) with Vector Companion installed, the laptop paired, and the link on.

Request the laptop sends (inside the encrypted `/api` body, like the other operations):

    {"op":"remind","at":1760000000000,"text":"Call back at 4 pm"}

- `at`: epoch milliseconds, later than now and no more than 60 days ahead.
- `text`: up to 60 characters, no control characters.
- Reply: `{"ok":true,"scheduled":1}`, or `{"ok":false,"error":"<code>"}` with one of `bad_time`, `time_in_past`, `time_too_far`, `text_required`, `text_too_long`, `bad_text`, `notifications_off`, `too_many_pending`.

## 1. Reminder two minutes ahead

1. Send `remind` with `at` = now + 2 minutes and `text` = "Test reminder".
2. Expect `{"ok":true,"scheduled":1}`.
3. Lock the screen and wait. The notification "Test reminder" should appear within about 2 to 5 minutes (it can be a few minutes late).
4. Tap it. Vector Companion opens.

## 2. Restart with reminders pending

1. Send `remind` with `at` = now + 10 minutes and `text` = "After restart".
2. Restart the phone before it fires.
3. Unlock and wait past the time. The notification should still appear.
4. Save the diagnostic file and check for `BOOT_COMPLETED` and `REMINDERS_REARMED` (with "1 pending").

A reminder whose time passes while the phone is off is dropped, and the diagnostic file shows it as passed while off.

## 3. Notifications denied

1. In phone Settings, turn off notifications for Vector Companion.
2. Open Vector Companion. The Phone setup card shows "Callback reminders off: allow notifications".
3. Send `remind` again. Expect `{"ok":false,"error":"notifications_off"}`.
4. Turn notifications back on. The line disappears when you return to the app.
