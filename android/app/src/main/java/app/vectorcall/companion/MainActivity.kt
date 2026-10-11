package app.vectorcall.companion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * Vector Companion. One screen:
 *  - a pairing QR code to scan with the laptop's camera on the Vector page
 *  - link and calling status
 *  - the permissions the app needs
 * The website calls and records the results; this screen only pairs and shows status.
 */
class MainActivity : Activity() {
    private lateinit var pairInfo: TextView
    private lateinit var qrView: ImageView
    private lateinit var manualView: TextView
    private lateinit var statusView: TextView

    private var wantQrAfterPerms = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        EventLog.init(this)
        Sessions.init(this)
        setContentView(buildUi())
        if (Dialer.has(this, Manifest.permission.READ_PHONE_STATE)) CallMonitorService.start(this)
        // Ask on launch if anything essential is missing. No pairing code is made until these are granted.
        if (!corePermissionsGranted()) requestCorePermissions()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    // ---------------------------------------------------------------- UI

    private fun buildUi(): View {
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(px(20), px(24), px(20), px(24))
        }
        val outer = ScrollView(this).apply {
            addView(root)
            // Android 15 draws edge to edge; keep content clear of the status and nav bars.
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }

        fun label(s: String, size: Float = 15f, bold: Boolean = false) = TextView(this).apply {
            text = s
            textSize = size
            if (bold) setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, px(6), 0, px(6))
        }
        fun button(s: String, onClick: () -> Unit) = Button(this).apply {
            text = s
            isAllCaps = false
            setOnClickListener { onClick() }
        }
        fun gap(h: Int) = View(this).apply { minimumHeight = px(h) }

        root.addView(label("Vector Companion", 22f, bold = true))
        root.addView(gap(8))

        pairInfo = label("")
        root.addView(pairInfo)

        root.addView(button("Show pairing QR") { showQr() })
        qrView = ImageView(this).apply {
            visibility = View.GONE
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "Pairing QR code"
        }
        root.addView(qrView, LinearLayout.LayoutParams(px(280), px(280)).apply { topMargin = px(12) })
        // The same address and code as text, for typing in by hand if the laptop cannot scan.
        manualView = label("", 16f).apply {
            visibility = View.GONE
            typeface = Typeface.MONOSPACE
            setTextIsSelectable(true)
        }
        root.addView(manualView)
        root.addView(label("On the laptop, open the Vector page, tap Scan pairing QR and point the camera here, " +
            "or enter the address and code shown below by hand. The code is valid for 2 minutes.", 13f))

        root.addView(gap(12))
        root.addView(button("Stop laptop link") {
            LinkServer.stop(this)
            hideQr()
            toast("Laptop link stopped")
            refresh()
        })
        root.addView(button("Forget this laptop") {
            LinkKeyStore.clear(this)
            hideQr()
            toast("Laptop forgotten")
            refresh()
        })

        root.addView(gap(20))
        root.addView(label("Status", 17f, bold = true))
        statusView = label("", 14f)
        root.addView(statusView)
        root.addView(button("Grant phone permissions") { requestCorePermissions() })
        root.addView(button("Battery: set to unrestricted") { openBatterySettings() })
        root.addView(label("Unrestricted battery keeps calls working with the screen off.", 13f))

        return outer
    }

    private fun refresh() {
        val paired = LinkServer.isPaired(this)
        val running = LinkServer.isRunning()
        pairInfo.text = when {
            paired && running -> "Paired with your laptop. Calls from the Vector page work."
            paired -> "Paired with your laptop. The link is off: tap Show pairing QR to turn it on."
            else -> "Not paired yet. Tap Show pairing QR and scan it on the laptop."
        }

        val pm = getSystemService(PowerManager::class.java)
        val permsOk = Dialer.has(this, Manifest.permission.CALL_PHONE) &&
            Dialer.has(this, Manifest.permission.READ_PHONE_STATE)
        val lines = listOf(
            "Phone permissions: " + if (permsOk) "ready" else "missing, tap Grant phone permissions (QR is locked until then)",
            "Notifications: " + if (Dialer.has(this, Manifest.permission.POST_NOTIFICATIONS)) "allowed" else "not allowed",
            "Call log (answered and talk time): " + if (Dialer.has(this, Manifest.permission.READ_CALL_LOG)) "allowed" else "not allowed, tap Grant phone permissions",
            "Laptop link: " + (LinkServer.address()?.let { "on at $it" } ?: "off"),
            "Call monitoring: " + if (CallMonitorService.watching) "on" else "off",
            "Battery: " + if (pm?.isIgnoringBatteryOptimizations(packageName) == true) "unrestricted" else "optimised (may stop calls)",
        )
        statusView.text = lines.joinToString("\n")
    }

    // ---------------------------------------------------------------- actions

    /** Permissions the calling feature cannot work without. */
    private fun corePermissionsGranted(): Boolean =
        listOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.POST_NOTIFICATIONS,
        ).all { Dialer.has(this, it) }

    private fun showQr() {
        if (!corePermissionsGranted()) {
            // No code is generated until the permissions are granted. Ask again, and show the QR after.
            wantQrAfterPerms = true
            toast("Allow the permissions first. The QR code appears after that.")
            requestCorePermissions()
            return
        }
        makeQr()
    }

    private fun makeQr() {
        val payload = try {
            LinkServer.pairingQrPayload(this)
        } catch (e: Exception) {
            toast("Could not start the link. Check that the phone is on Wi-Fi.")
            refresh()
            return
        }
        qrView.setImageBitmap(QrCode.bitmap(payload, 840))
        qrView.visibility = View.VISIBLE
        val j = JSONObject(payload)
        manualView.text = "Can't scan? Enter by hand:
Address  ${j.optString("host")}:${j.optInt("port")}
Code     ${j.optString("code")}"
        manualView.visibility = View.VISIBLE
        refresh()
    }

    private fun hideQr() {
        qrView.visibility = View.GONE
        manualView.visibility = View.GONE
    }

    private fun requestCorePermissions() {
        requestPermissions(
            arrayOf(
                Manifest.permission.CALL_PHONE,
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.ANSWER_PHONE_CALLS,
                Manifest.permission.POST_NOTIFICATIONS,
                // Lets the website show whether a call was answered and for how long. Reads only Vector's calls.
                Manifest.permission.READ_CALL_LOG,
            ),
            REQ_CORE,
        )
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (Dialer.has(this, Manifest.permission.READ_PHONE_STATE)) {
            CallMonitorService.start(this, restartWatcher = CallMonitorService.running)
        }
        if (corePermissionsGranted()) {
            if (wantQrAfterPerms) {
                wantQrAfterPerms = false
                makeQr()
            }
        } else {
            wantQrAfterPerms = false
            // Android stops showing the dialog after a permanent "Don't allow". Send the person to settings then.
            val blocked = listOf(
                Manifest.permission.CALL_PHONE,
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.POST_NOTIFICATIONS,
            ).any { !Dialer.has(this, it) && !shouldShowRequestPermissionRationale(it) }
            if (blocked) {
                toast("Permission is blocked. Allow it in the app settings, then come back.")
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            } else {
                toast("Permissions are needed before the pairing code can be made.")
            }
        }
        refresh()
    }

    private fun openBatterySettings() {
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
    }

    private fun toast(t: String) = Toast.makeText(this, t, Toast.LENGTH_SHORT).show()

    companion object {
        private const val REQ_CORE = 1
    }
}
