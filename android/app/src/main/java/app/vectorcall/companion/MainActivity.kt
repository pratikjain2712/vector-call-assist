package app.vectorcall.companion

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * Vector Companion: one screen.
 *  - Main card: allow access, then the pairing QR (with the address and code as text), then
 *    "Ready for calls" once a laptop is paired. It switches to "Ready" by itself when the laptop pairs.
 *  - Phone setup card: each thing the app needs, with a tick or a Fix button.
 * Built in code with framework views only; colours match the website (web/index.html).
 */
class MainActivity : Activity() {

    private class Palette(val dark: Boolean) {
        val bg = if (dark) 0xFF0E1320.toInt() else 0xFFF2F4F8.toInt()
        val surface = if (dark) 0xFF171E2E.toInt() else 0xFFFFFFFF.toInt()
        val fg = if (dark) 0xFFE8ECF4.toInt() else 0xFF111A2E.toInt()
        val muted = if (dark) 0xFF98A2B8.toInt() else 0xFF5A657C.toInt()
        val line = if (dark) 0xFF2A3347.toInt() else 0xFFD5DAE5.toInt()
        val accent = if (dark) 0xFF8FB4FF.toInt() else 0xFF2447C8.toInt()
        val onAccent = if (dark) 0xFF0E1320.toInt() else 0xFFFFFFFF.toInt()
        val ok = if (dark) 0xFF5BD68C.toInt() else 0xFF0F7A3D.toInt()
        val okBg = if (dark) 0xFF12301F.toInt() else 0xFFE2F4E8.toInt()
        val warn = if (dark) 0xFFF5C451.toInt() else 0xFF8A5A00.toInt()
        val warnBg = if (dark) 0xFF33270C.toInt() else 0xFFFBF0D3.toInt()
        val bad = if (dark) 0xFFFF8A8A.toInt() else 0xFFB4232A.toInt()
        val ripple = if (dark) 0x33FFFFFF else 0x22000000
    }

    private enum class Kind { PRIMARY, SECONDARY, QUIET, DANGER }

    private class Item(val title: String, val detail: String, val ok: Boolean, val okWord: String, val noWord: String, val fix: () -> Unit)

    private lateinit var pal: Palette
    private var dp = 1f
    private lateinit var mainCard: LinearLayout
    private lateinit var setupCard: LinearLayout
    private lateinit var footer: TextView

    private var pairingAnother = false      // paired already, but showing the QR to pair a different laptop
    private var countdown: TextView? = null
    private var qrBox: View? = null
    private var seenPairedAt = 0L
    private var ticks = 0
    private var healthLine: TextView? = null   // "last heard from the laptop", refreshed every second

    private val ticker = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            onTick()
            ticker.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        EventLog.init(this)
        Sessions.init(this)
        pal = Palette((resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES)
        dp = resources.displayMetrics.density
        setContentView(buildUi())
        styleSystemBars()
        if (Dialer.has(this, Manifest.permission.READ_PHONE_STATE)) CallMonitorService.start(this)
        seenPairedAt = LinkServer.lastPairedAt
    }

    override fun onResume() {
        super.onResume()
        refresh()
        ticker.removeCallbacks(tick)
        ticker.post(tick)
    }

    override fun onPause() {
        ticker.removeCallbacks(tick)
        super.onPause()
    }

    // ---------------------------------------------------------------- layout

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(18), px(20), px(18), px(28))
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(pal.bg)
            isFillViewport = true
            addView(root)
            // Android 15 draws edge to edge; keep content clear of the status and navigation bars.
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }

        root.addView(header())
        mainCard = card()
        root.addView(mainCard, cardParams())
        setupCard = card()
        root.addView(setupCard, cardParams())
        footer = label("", 12f, pal.muted).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(px(8), px(4), px(8), 0)
        }
        root.addView(button("Save diagnostic file", Kind.SECONDARY) { exportDiagnostics() }, full(0))
        root.addView(footer, full(0))
        return scroll
    }

    private fun styleSystemBars() {
        window.decorView.setBackgroundColor(pal.bg)
        if (!pal.dark) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(light, light)
        }
    }

    private fun header(): View {
        val row = row().apply { setPadding(px(2), 0, 0, px(16)) }
        val logo = label("V", 22f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            background = rounded(0xFF2447C8.toInt(), 12f)
        }
        row.addView(logo, LinearLayout.LayoutParams(px(44), px(44)))
        val col = column()
        col.addView(label("Vector Companion", 20f, pal.fg, bold = true))
        col.addView(label("Calls from your laptop, through this phone", 13f, pal.muted))
        row.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = px(12) })
        return row
    }

    private fun refresh() {
        renderMain()
        renderSetup()
        footer.text = "Vector Companion ${versionName()} · Only calls you start on the Vector page are placed."
    }

    // ---------------------------------------------------------------- main card

    private fun renderMain() {
        mainCard.removeAllViews()
        countdown = null
        qrBox = null
        healthLine = null
        when {
            !has(*CORE) -> mainNeedsAccess()
            LinkServer.isPaired(this) && !pairingAnother -> mainReady()
            else -> mainPairing()
        }
    }

    private fun mainNeedsAccess() {
        mainCard.addView(badge(false, 48))
        mainCard.addView(label("Allow phone access", 20f, pal.fg, bold = true), full(12))
        mainCard.addView(label(
            "Vector places the calls you start on the laptop and watches when they connect and end. " +
                "It never records audio and never reads your contacts or messages.", 15f, pal.muted), full(6))
        mainCard.addView(button("Allow access", Kind.PRIMARY) {
            askFor(arrayOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.ANSWER_PHONE_CALLS, Manifest.permission.POST_NOTIFICATIONS,
                Manifest.permission.READ_CALL_LOG))
        }, full(18))
    }

    private fun mainReady() {
        val running = LinkServer.isRunning()
        val head = row()
        head.addView(badge(running, 48))
        val col = column()
        col.addView(label(if (running) "Ready for calls" else "Link is off", 20f, pal.fg, bold = true))
        col.addView(label(if (running) "Paired with your laptop" else "Paired, but the laptop can't reach this phone", 14f, pal.muted))
        head.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = px(14) })
        mainCard.addView(head)
        mainCard.addView(statusBox(running), full(14))

        if (running) {
            mainCard.addView(infoBox(listOf("Phone address" to (LinkServer.address() ?: ""))), full(16))
            mainCard.addView(label("Calls you start on the Vector page ring out from this phone. Keep it on this Wi-Fi.", 14f, pal.muted), full(12))
        } else {
            mainCard.addView(label("Turn the link on so calls from the Vector page work.", 14f, pal.muted), full(12))
            mainCard.addView(button("Turn link on", Kind.PRIMARY) {
                try {
                    LinkServer.turnOn(this@MainActivity)
                } catch (e: Exception) {
                    toast("Connect the phone to Wi-Fi first.")
                }
                refresh()
            }, full(14))
        }

        mainCard.addView(button("Pair a different laptop", Kind.SECONDARY) {
            LinkServer.clearLastHeard()
            pairingAnother = true
            refresh()
        }, full(if (running) 16 else 8))

        val quiet = row()
        if (running) {
            quiet.addView(button("Stop link", Kind.QUIET) {
                LinkServer.stop(this@MainActivity)
                toast("Laptop link stopped")
                refresh()
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        quiet.addView(button("Forget laptop", Kind.DANGER) { confirmForget() },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        mainCard.addView(quiet, full(4))
    }

    /** Plain status words for pairing and link, then when the laptop last reached this phone. */
    private fun statusBox(running: Boolean): View {
        val paired = LinkServer.isPaired(this)
        val box = column().apply {
            background = rounded(pal.bg, 12f, pal.line)
            setPadding(px(14), px(4), px(14), px(10))
        }
        box.addView(statusRow("Pairing", if (paired) "Paired" else "Not paired", paired))
        box.addView(statusRow("Link", if (running) "On" else "Off", running))
        val hl = label("", 13f, pal.muted).apply { setPadding(0, px(8), 0, 0) }
        healthLine = hl
        box.addView(hl)
        updateHealth()
        return box
    }

    private fun statusRow(name: String, word: String, ok: Boolean) = row().apply {
        setPadding(0, px(6), 0, 0)
        addView(label(name, 14f, pal.muted), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(label(word, 14f, if (ok) pal.ok else pal.warn, bold = true))
    }

    private fun updateHealth() {
        val tv = healthLine ?: return
        val at = LinkServer.lastHeardAt
        tv.text = if (at == 0L) {
            "The laptop has not reached this phone yet."
        } else {
            "Last heard from the laptop ${ago(System.currentTimeMillis() - at)} (${EventLog.isoAt(at).substring(11, 19)})."
        }
    }

    private fun ago(ms: Long): String = when {
        ms < 10_000 -> "just now"
        ms < 60_000 -> "${ms / 1000} s ago"
        ms < 3_600_000 -> "${ms / 60_000} min ago"
        else -> "${ms / 3_600_000} h ago"
    }

    private fun mainPairing() {
        mainCard.addView(label(if (pairingAnother) "Pair a different laptop" else "Pair with your laptop", 20f, pal.fg, bold = true))
        mainCard.addView(label("On the laptop, open the Vector page and tap Scan pairing QR. Then point the laptop camera at this code.", 14f, pal.muted), full(6))

        val payload = try {
            LinkServer.pairingQrPayload(this)
        } catch (e: Exception) {
            null
        }
        if (payload == null) {
            val box = column().apply {
                background = rounded(pal.warnBg, 12f)
                setPadding(px(14), px(12), px(14), px(12))
            }
            box.addView(label("This phone isn't on Wi-Fi", 15f, pal.warn, bold = true))
            box.addView(label("Connect it to the same Wi-Fi as the laptop, then try again.", 14f, pal.fg), full(2))
            mainCard.addView(box, full(16))
            mainCard.addView(button("Open Wi-Fi settings", Kind.PRIMARY) { startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) }, full(14))
            mainCard.addView(button("Try again", Kind.SECONDARY) { refresh() }, full(8))
            if (pairingAnother) mainCard.addView(button("Cancel", Kind.QUIET) { pairingAnother = false; refresh() }, full(4))
            return
        }
        val j = JSONObject(payload)

        val size = minOf(resources.displayMetrics.widthPixels - px(36 + 36 + 24), px(300))
        val frame = FrameLayout(this).apply {
            background = rounded(Color.WHITE, 14f, pal.line)
            setPadding(px(12), px(12), px(12), px(12))
        }
        val img = ImageView(this).apply {
            setImageBitmap(QrCode.bitmap(payload, size))
            contentDescription = "Pairing QR code"
        }
        frame.addView(img, FrameLayout.LayoutParams(size, size))
        mainCard.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            topMargin = px(16)
        })
        qrBox = frame

        val cd = label("", 14f, pal.muted, bold = true).apply { gravity = Gravity.CENTER_HORIZONTAL }
        mainCard.addView(cd, full(10))
        countdown = cd

        mainCard.addView(label("Can't scan? Type these in on the laptop:", 13f, pal.muted), full(14))
        mainCard.addView(infoBox(listOf(
            "Phone address" to "${j.optString("host")}:${j.optInt("port")}",
            "Pairing code" to j.optString("code"),
        )), full(6))

        mainCard.addView(button("New code", Kind.SECONDARY) {
            LinkServer.newPairingCode()
            refresh()
        }, full(14))
        if (pairingAnother) {
            mainCard.addView(button("Cancel", Kind.QUIET) {
                pairingAnother = false
                refresh()
            }, full(4))
        }
        updateCountdown()
    }

    private fun confirmForget() {
        AlertDialog.Builder(this)
            .setTitle("Forget this laptop?")
            .setMessage("The laptop will need to scan a new pairing code before it can place calls again.")
            .setPositiveButton("Forget") { _, _ ->
                LinkKeyStore.clear(this)
                LinkServer.clearLastHeard()
                pairingAnother = false
                toast("Laptop forgotten")
                refresh()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ---------------------------------------------------------------- setup card

    private fun renderSetup() {
        setupCard.removeAllViews()
        val wifi = LinkServer.lanAddresses().firstOrNull()
        val items = listOf(
            Item("Calls", "Place calls and see when they connect", has(*CALL_PERMS), "Allowed", "Not allowed") { askFor(CALL_PERMS) },
            Item("Call log", "Shows whether the lead answered, and for how long", has(Manifest.permission.READ_CALL_LOG), "Allowed", "Not allowed") {
                askFor(arrayOf(Manifest.permission.READ_CALL_LOG))
            },
            Item("Notifications", "Keeps the link running in the background", has(Manifest.permission.POST_NOTIFICATIONS), "Allowed", "Not allowed") {
                askFor(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            },
            Item("Battery unrestricted", "So calls keep working with the screen off", batteryOk(), "Unrestricted", "Restricted") { openBatterySettings() },
            Item("Wi-Fi", if (wifi != null) "Connected, address $wifi" else "Join the same Wi-Fi as the laptop", wifi != null, "Connected", "Not connected") {
                startActivity(Intent(Settings.ACTION_WIFI_SETTINGS))
            },
            Item("Call monitoring", "Watches call state for the calls Vector places", CallMonitorService.watching, "Watching", "Not watching") {
                if (!has(Manifest.permission.READ_PHONE_STATE)) {
                    askFor(CALL_PERMS)
                } else {
                    CallMonitorService.start(this, restartWatcher = true)
                    ticker.postDelayed({ refresh() }, 800)
                }
            },
        )

        val todo = items.count { !it.ok }
        val head = row()
        head.addView(label("Phone setup", 17f, pal.fg, bold = true), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(label(
            when (todo) { 0 -> "All set"; 1 -> "1 thing to fix"; else -> "$todo things to fix" },
            13f, if (todo == 0) pal.ok else pal.warn, bold = true))
        setupCard.addView(head)

        for (item in items) {
            setupCard.addView(View(this).apply { setBackgroundColor(pal.line) },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(1)).apply { topMargin = px(12) })
            val r = row().apply { setPadding(0, px(12), 0, 0) }
            r.addView(badge(item.ok, 28))
            val col = column()
            col.addView(label(item.title, 15f, pal.fg, bold = true))
            col.addView(label(item.detail, 13f, pal.muted))
            r.addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = px(12)
                rightMargin = px(8)
            })
            r.addView(label(if (item.ok) item.okWord else item.noWord, 13f, if (item.ok) pal.ok else pal.warn, bold = true)
                .apply { setPadding(px(8), 0, px(4), 0) })
            if (!item.ok) {
                r.addView(button("Fix", Kind.PRIMARY) { item.fix() }.apply {
                    minHeight = px(38)
                    minimumHeight = px(38)
                    minWidth = px(64)
                    minimumWidth = px(64)
                })
            }
            setupCard.addView(r)
        }
    }

    // ---------------------------------------------------------------- ticking

    private fun onTick() {
        // A laptop just paired: switch to "Ready for calls" without the person doing anything.
        if (LinkServer.lastPairedAt != seenPairedAt) {
            seenPairedAt = LinkServer.lastPairedAt
            if (LinkServer.isPaired(this)) {
                pairingAnother = false
                toast("Paired with your laptop")
                refresh()
                return
            }
        }
        updateCountdown()
        updateHealth()
        ticks++
        if (ticks % 5 == 0) renderSetup()   // Wi-Fi or battery may have changed
    }

    private fun updateCountdown() {
        val cd = countdown ?: return
        val left = LinkServer.codeExpiresAt() - System.currentTimeMillis()
        if (left > 0) {
            val s = (left / 1000).toInt()
            cd.text = "Code expires in %d:%02d".format(s / 60, s % 60)
            cd.setTextColor(pal.muted)
            qrBox?.alpha = 1f
        } else {
            cd.text = "Code expired. Tap New code."
            cd.setTextColor(pal.bad)
            qrBox?.alpha = 0.25f
        }
    }

    // ---------------------------------------------------------------- permissions and settings

    private fun has(vararg perms: String) = perms.all { Dialer.has(this, it) }

    private fun askFor(perms: Array<String>) {
        val missing = perms.filter { !Dialer.has(this, it) }
        if (missing.isEmpty()) {
            refresh()
            return
        }
        // After a permanent "Don't allow", Android no longer shows the dialog: open the app's settings instead.
        val prefs = getSharedPreferences(UI_PREFS, MODE_PRIVATE)
        val asked = prefs.getStringSet(KEY_ASKED, emptySet()) ?: emptySet()
        val blocked = missing.filter { it in asked && !shouldShowRequestPermissionRationale(it) }
        if (blocked.size == missing.size) {
            toast("Allow it in the app settings, then come back.")
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            return
        }
        prefs.edit().putStringSet(KEY_ASKED, asked + missing).apply()
        requestPermissions(missing.toTypedArray(), REQ_PERMS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (Dialer.has(this, Manifest.permission.READ_PHONE_STATE)) {
            CallMonitorService.start(this, restartWatcher = CallMonitorService.running)
        }
        refresh()
    }

    // ---------------------------------------------------------------- diagnostic file

    /** Asks where to save the text file, then the person shares it from the Files app. Nothing goes over the network. */
    @Suppress("DEPRECATION")
    private fun exportDiagnostics() {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TITLE, "vector-companion-diagnostics.txt")
        try {
            startActivityForResult(intent, REQ_EXPORT)
        } catch (e: Exception) {
            toast("No app on this phone can save the file.")
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_EXPORT || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        try {
            val text = EventLog.diagnosticText(this)
            contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                ?: throw IllegalStateException("no output stream")
            toast("Diagnostic file saved")
        } catch (e: Exception) {
            toast("Could not save the diagnostic file.")
        }
    }

    private fun batteryOk() = getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) == true

    private fun openBatterySettings() {
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
    }

    private fun versionName() = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: ""
    } catch (e: Exception) {
        ""
    }

    // ---------------------------------------------------------------- view helpers

    private fun px(v: Int) = (v * dp).toInt()

    private fun rounded(fill: Int, radiusDp: Float, stroke: Int? = null) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = radiusDp * dp
        if (stroke != null) setStroke(px(1), stroke)
    }

    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(pal.surface, 16f, pal.line)
        setPadding(px(18), px(18), px(18), px(18))
    }

    private fun cardParams() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        bottomMargin = px(14)
    }

    private fun full(topDp: Int) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        topMargin = px(topDp)
    }

    private fun row() = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

    private fun label(s: CharSequence, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        textSize = sp
        setTextColor(color)
        setLineSpacing(0f, 1.15f)
        if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }

    private fun badge(ok: Boolean, sizeDp: Int) = TextView(this).apply {
        text = if (ok) "✓" else "!"
        gravity = Gravity.CENTER
        textSize = if (sizeDp >= 40) 24f else 14f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(if (ok) pal.ok else pal.warn)
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (ok) pal.okBg else pal.warnBg)
        }
        layoutParams = LinearLayout.LayoutParams(px(sizeDp), px(sizeDp))
    }

    private fun infoBox(rows: List<Pair<String, String>>) = column().apply {
        background = rounded(pal.bg, 12f, pal.line)
        setPadding(px(14), px(12), px(14), px(4))
        for ((name, value) in rows) {
            addView(label(name.uppercase(), 11f, pal.muted, bold = true).apply { letterSpacing = 0.08f })
            addView(label(value, if (name == "Pairing code") 22f else 17f, pal.fg).apply {
                typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
                letterSpacing = if (name == "Pairing code") 0.05f else 0f
                setTextIsSelectable(true)
                setPadding(0, px(2), 0, px(10))
            })
        }
    }

    private fun button(s: String, kind: Kind, onClick: () -> Unit) = Button(this).apply {
        text = s
        isAllCaps = false
        textSize = 15f
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        stateListAnimator = null
        minHeight = px(48)
        minimumHeight = px(48)
        setPadding(px(16), 0, px(16), 0)
        val fill = when (kind) {
            Kind.PRIMARY -> pal.accent
            Kind.SECONDARY -> pal.surface
            Kind.QUIET, Kind.DANGER -> Color.TRANSPARENT
        }
        val textColor = when (kind) {
            Kind.PRIMARY -> pal.onAccent
            Kind.SECONDARY -> pal.fg
            Kind.QUIET -> pal.accent
            Kind.DANGER -> pal.bad
        }
        setTextColor(textColor)
        val shape = rounded(fill, 10f, if (kind == Kind.SECONDARY) pal.line else null)
        background = RippleDrawable(ColorStateList.valueOf(pal.ripple), shape, rounded(Color.WHITE, 10f))
        setOnClickListener { onClick() }
    }

    private fun toast(t: String) = Toast.makeText(this, t, Toast.LENGTH_SHORT).show()

    companion object {
        private const val REQ_PERMS = 1
        private const val REQ_EXPORT = 2
        private const val UI_PREFS = "vector_ui"
        private const val KEY_ASKED = "asked_permissions"

        /** What the calling feature cannot work without; the QR stays hidden until these are allowed. */
        private val CORE = arrayOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.POST_NOTIFICATIONS,
        )
        private val CALL_PERMS = arrayOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.ANSWER_PHONE_CALLS,
        )
    }
}
