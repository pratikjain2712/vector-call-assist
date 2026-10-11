# Vector Companion: install and setup guide

This guide sets up one rep at a time: one Android phone and one Windows laptop. Plan about 20 minutes per rep.

Words used in this guide:

- **APK**: the installation file for the app. It works like a setup file.
- **QR code**: the square black-and-white pattern that carries the pairing details.
- **Pairing**: linking one phone to one laptop. You do it once per phone.
- **Certificate**: a digital ID the phone uses to prove who it is. Your browser asks you to accept it once.

## 1. Before you start

1. An Android phone for each rep, with a working SIM card. Calls go out on this SIM.
2. Calling credit on that SIM. Calls use credit as normal.
3. Phone and laptop on the same Wi-Fi network. The link works over Wi-Fi only, not mobile data.
4. A Windows laptop with Chrome or Edge installed. Use one of these two browsers. Firefox has not been tested for calls yet.
5. The Vector Companion APK file, sent to you by the Vector team.

## 2. Install the app on the phone

1. Copy the APK file to the phone, by USB cable or by sending it to yourself.
2. Open the file from your Downloads folder.
3. The phone says installs from this source are blocked. Tap Settings on that message, switch on "Allow from this source", then go back.
4. Tap Install, then Open.

**What the warning means:** Android shows this for any app that did not come from the Google Play Store. The warning is expected here. Install only the APK file that Vector sent you.

**How to update:** Repeat the steps above with the new APK. It installs over the old one and keeps the saved log. Automatic update checks are coming later.

## 3. Allow permissions on first launch

Open Vector Companion. It asks for access one item at a time. Tap Allow each time.

1. **Calls (needed).** Lets the app place the calls you start and see when they connect and end.
2. **Phone state (needed).** Lets the app see each call's status and list your SIM cards. It does not read contacts or messages.
3. **Notifications (recommended).** Shows a note while the link runs, so Android does not stop it.
4. **Call log (optional).** Lets the app measure exact talk time. You can skip it.

**If you tap Don't allow:** The pairing QR code stays hidden until the needed permissions are allowed. To allow them later:

1. Open the app and tap **Fix** next to the item in the Phone setup card.
2. Or open phone Settings, then Apps, then Vector Companion, then Permissions, and switch the item on.

If you tapped Don't allow twice, Android stops asking. Use the Settings route.

## 4. Pair the phone with the laptop

Do this once for each phone.

1. Check that the phone and laptop are on the same Wi-Fi.
2. On the phone, the pairing QR code appears on screen. It is valid for 2 minutes. If it expires, tap **New code**.
3. On the laptop, open the Vector call page and click **Scan pairing QR**. Allow the camera when asked.
4. Hold the phone screen in front of the laptop camera until the page says the phone is connected.
5. If the browser asks "Allow access to devices on your local network", click **Allow**. The link needs it.
6. If scanning fails, type the address and code shown under the QR code into the page.

## 5. The one-time certificate step

Sometimes the laptop page shows **Open phone certificate page** and **Pair again**. This is normal. Here is why it happens and what to do.

**Why:** The phone makes its own digital ID, which your browser does not recognise, so it warns you. Accept it once per phone. You repeat it only if the phone's Wi-Fi address changes.

1. Click **1. Open phone certificate page**. A new tab opens.
2. The browser shows a warning such as "Your connection is not private." Click **Advanced**, then click the link that says **Proceed** or **Continue (unsafe)**.
3. The page may look blank or show a short message. That is fine. Close the tab.
4. Go back to the Vector page and click **2. Pair again**.

This is safe here: the connection runs only between your laptop and your own phone.

## 6. Set battery to unrestricted

Some phones, including Nothing phones, stop background apps to save battery. Then calls stop working when the screen is off.

1. In the app's Phone setup card, tap **Fix** next to **Battery unrestricted**.
2. If that fails, open phone Settings, then Apps, then Vector Companion, then Battery, and choose **Unrestricted**.

## 7. Make a test call

1. On the phone, the app shows **Ready for calls**.
2. On the laptop, open a test lead. Use your own second number, not a customer's number.
3. Click **Call**. Your second phone rings, using the SIM you chose.
4. Answer, talk briefly, then end the call on the phone.
5. Check the laptop shows the call result.

## 8. Invite reps and manage seats

A seat is one rep, with one laptop and one phone.

- **Invite a rep:** coming later, on the admin screen.
- **Reassign a seat to another person:** coming later, on the admin screen.
- **Reset a seat's phone pairing:** available now. On the phone, tap **Forget laptop**, then pair again as in section 4.

## 9. When the phone shows offline or the Call button is disabled

The Call button is greyed out when the laptop cannot reach the phone. The message under the lead says why. Try these steps in order.

1. On the phone, check that the app says **Ready for calls**. If it says **Link is off**, tap **Turn link on**.
2. Check that both devices are on the same Wi-Fi. If the phone says it is not on Wi-Fi, tap **Open Wi-Fi settings**.
3. Set the phone's date and time to automatic. The page shows a clock message if they are wrong.
4. If the page says the phone is not paired, pair again (section 4).
5. Close and reopen Vector Companion, then reload the laptop page.
6. If it is still offline, ask the person who runs your Wi-Fi to let devices see each other.

## 10. Export outcomes

1. On the laptop page, click **Download results (.xlsx)**.
2. Open the file in Excel. The **Leads** sheet shows each lead's latest result. The **Calls** sheet has one row per call.
3. Save the file safely. Results stay in this browser only, so download them regularly.

CSV export is coming later.

## 11. What to send to support

Each phone keeps a call-event log for support. A button to send that log is coming later. Until then, send:

1. The rep's name, the phone model, and the date and time of the problem. Do not send full customer phone numbers.
2. A photo of the phone screen and of the laptop page showing the message.
3. A short note of what you tapped just before the problem.
