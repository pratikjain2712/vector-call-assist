package app.vectorcall.companion

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast

/**
 * Phase 2 test screen. Built in code (no layouts, no libraries) to keep the proof of concept small.
 *
 *  1. Permissions and status
 *  2. SIM choice, number, Call / Hang up, "They answered" ground-truth button
 *  3. Scenario marker, live event log, share/copy/clear
 */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var numberInput: EditText
    private lateinit var linkStatus: TextView
    private lateinit var simSpinner: Spinner
    private lateinit var callLogBox: CheckBox
    private var sims: List<Dialer.Sim> = emptyList()
    private var bindingSims = false

    private val onEvent: (EventLog.Entry) -> Unit = { e ->
        appendLog(e)
        refreshStatus()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        EventLog.init(this)
        Sessions.init(this)
        setContentView(buildUi())
        renderLog()
        if (Dialer.has(this, Manifest.permission.READ_PHONE_STATE)) CallMonitorService.start(this)
    }

    override fun onResume() {
        super.onResume()
        EventLog.addListener(onEvent)
        renderLog()
        loadSims()
        refreshStatus()
        refreshLink()
    }

    override fun onPause() {
        EventLog.removeListener(onEvent)
        super.onPause()
    }

    // ---------------------------------------------------------------- UI

    private fun buildUi(): View {
        val dp = resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(16), px(12), px(16), px(12))
        }
        val outer = ScrollView(this).apply {
            addView(root)
            // Android 15 draws apps edge to edge; keep content clear of the status and nav bars.
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }

        fun heading(t: String) = TextView(this).apply {
            text = t
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, px(16), 0, px(4))
            isAllCaps = true
        }
        fun button(t: String, onClick: () -> Unit) = Button(this).apply {
            text = t
            isAllCaps = false
            setOnClickListener { onClick() }
        }
        fun row(vararg views: View) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            for (v in views) addView(v, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }

        root.addView(TextView(this).apply {
            text = "Vector Companion · call-state test"
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
        })
        root.addView(TextView(this).apply {
            text = "Phase 2 proof of concept. Records what Android reports during calls. " +
                "No audio, contacts or SMS are accessed. Numbers are masked in the log."
            textSize = 13f
        })

        // 1. Permissions and status
        root.addView(heading("1 · Setup"))
        status = TextView(this).apply { typeface = Typeface.MONOSPACE; textSize = 12f }
        root.addView(status)
        root.addView(row(
            button("Grant phone permissions") { requestCorePermissions() },
            button("Battery: unrestricted") { openBatterySettings() },
        ))
        root.addView(row(
            button("Restart monitor") { CallMonitorService.start(this, restartWatcher = true) },
            button("Request companion role") { requestCompanionRole() },
        ))
        callLogBox = CheckBox(this).apply {
            text = "Call-log lookup after each call (optional; reads only that one call)"
            isChecked = Prefs.callLogProbe(this@MainActivity)
            setOnCheckedChangeListener { _, on ->
                Prefs.setCallLogProbe(this@MainActivity, on)
                EventLog.add("SETTING", null, "callLogProbe=$on")
                if (on && !Dialer.has(this@MainActivity, Manifest.permission.READ_CALL_LOG)) {
                    requestPermissions(arrayOf(Manifest.permission.READ_CALL_LOG), REQ_CALL_LOG)
                }
            }
        }
        root.addView(callLogBox)

        // 2. Calling
        root.addView(heading("2 · Test call"))
        simSpinner = Spinner(this)
        simSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                if (bindingSims) return
                val h = if (pos == 0) null else sims.getOrNull(pos - 1)?.handle
                Prefs.setSimHandle(this@MainActivity, h)
                EventLog.add("SETTING", null, "sim=${Dialer.simLabel(this@MainActivity, h)}")
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        root.addView(simSpinner)
        numberInput = EditText(this).apply {
            hint = "Number, e.g. 98765 43210 or +91…"
            inputType = InputType.TYPE_CLASS_PHONE
        }
        root.addView(numberInput)
        root.addView(row(
            button("Call") { placeCall() },
            button("Hang up") { hangUp() },
        ))
        root.addView(button("They answered — tap at the moment you hear them") { Sessions.markAnswered() })

        // 3. Laptop link (Phase 3 spike)
        root.addView(heading("3 · Laptop link (spike)"))
        linkStatus = TextView(this).apply {
            textSize = 13f
            setTextIsSelectable(true)
        }
        root.addView(linkStatus)
        root.addView(row(
            button("Start link + code") { startLink() },
            button("New code") {
                // A code is useless while stopped (stop() clears it), so only issue one when running.
                if (LinkServer.isRunning()) LinkServer.newPairingCode() else toast("Link is stopped. Tap Start link + code.")
                refreshLink()
            },
            button("Stop link") { LinkServer.stop(this); refreshLink() },
        ))

        // 4. Log
        root.addView(heading("4 · Scenario and log"))
        val scenario = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, SCENARIOS)
        }
        root.addView(scenario)
        root.addView(button("Start this scenario (writes a marker in the log)") {
            EventLog.add("SCENARIO", null, scenario.selectedItem.toString())
        })
        root.addView(row(
            button("Share log") { shareLog() },
            button("Copy log") { copyLog() },
            button("Clear") { confirmClear() },
        ))
        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
        }
        logScroll = ScrollView(this).apply {
            isNestedScrollingEnabled = true
            addView(logView)
        }
        root.addView(logScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(360)))

        return outer
    }

    private fun refreshStatus() {
        val lines = mutableListOf<String>()
        fun p(label: String, perm: String) = lines.add("$label: " + if (Dialer.has(this, perm)) "granted" else "NOT granted")
        p("Place calls (CALL_PHONE)", Manifest.permission.CALL_PHONE)
        p("Call state (READ_PHONE_STATE)", Manifest.permission.READ_PHONE_STATE)
        p("Hang up (ANSWER_PHONE_CALLS)", Manifest.permission.ANSWER_PHONE_CALLS)
        p("Notifications", Manifest.permission.POST_NOTIFICATIONS)
        p("Call log (optional)", Manifest.permission.READ_CALL_LOG)
        val pm = getSystemService(PowerManager::class.java)
        lines += "Battery unrestricted: " + if (pm?.isIgnoringBatteryOptimizations(packageName) == true) "yes" else "no"
        lines += "Monitor: " + when {
            CallMonitorService.watching -> "watching call state"
            CallMonitorService.running -> "running, NOT watching (permission?)"
            else -> "stopped"
        }
        lines += "Companion role: " + companionRoleStatus()
        lines += "Companion InCallService bound: ${CompanionInCallService.bindCount} time(s) this run"
        val s = Sessions.current
        lines += "Session: " + if (s == null) "none" else "${s.id.take(8)} ${s.phase}"
        status.text = lines.joinToString("\n")
    }

    private fun loadSims() {
        sims = Dialer.sims(this)
        val labels = listOf("SIM: phone default / ask every time") + sims.map { "SIM: ${it.label}" }
        bindingSims = true
        simSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
        val saved = Prefs.simHandle(this)
        val idx = sims.indexOfFirst { it.handle == saved }
        simSpinner.setSelection(if (idx >= 0) idx + 1 else 0, false)
        simSpinner.post { bindingSims = false }
    }

    private fun renderLog() {
        if (!::logView.isInitialized) return
        logView.text = EventLog.snapshot().takeLast(300).joinToString("\n") { it.line() }
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun appendLog(e: EventLog.Entry) {
        if (logView.text.isNotEmpty()) logView.append("\n")
        logView.append(e.line())
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    // ---------------------------------------------------------------- actions

    private fun placeCall() {
        val e164 = Phone.normalize(numberInput.text.toString())
        if (e164 == null) {
            toast("Enter a valid number (10-digit Indian, or + and country code)")
            return
        }
        if (!Dialer.has(this, Manifest.permission.CALL_PHONE) || !Dialer.has(this, Manifest.permission.READ_PHONE_STATE)) {
            toast("Grant phone permissions first")
            requestCorePermissions()
            return
        }
        val sim = Prefs.simHandle(this)
        val session = Sessions.request(this, e164, Dialer.simLabel(this, sim)) ?: run {
            toast("Not dialling, see the log for why")
            return
        }
        val error = Dialer.place(this, e164, sim)
        if (error != null) Sessions.dialFailed(session, error)
        else EventLog.add("PLACE_CALL_OK", session.id, "Telecom accepted the request")
    }

    private fun hangUp() {
        val error = Dialer.end(this)
        EventLog.add(if (error == null) "HANGUP_SENT" else "HANGUP_FAILED", Sessions.current?.takeIf { it.open }?.id, error ?: "")
        if (error != null && !Dialer.has(this, Manifest.permission.ANSWER_PHONE_CALLS)) {
            requestPermissions(arrayOf(Manifest.permission.ANSWER_PHONE_CALLS), REQ_CORE)
        }
    }

    private fun requestCorePermissions() {
        requestPermissions(
            arrayOf(
                Manifest.permission.CALL_PHONE,
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.ANSWER_PHONE_CALLS,
                Manifest.permission.POST_NOTIFICATIONS,
            ),
            REQ_CORE,
        )
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        EventLog.add("PERMISSIONS", null, CallMonitorService.permissionSnapshot(this))
        if (Dialer.has(this, Manifest.permission.READ_PHONE_STATE)) {
            CallMonitorService.start(this, restartWatcher = CallMonitorService.running)
        }
        if (requestCode == REQ_CALL_LOG && !Dialer.has(this, Manifest.permission.READ_CALL_LOG)) {
            callLogBox.isChecked = false
        }
        loadSims()
        refreshStatus()
    }

    private fun openBatterySettings() {
        // Opens the system list; pick Vector Companion and choose "Unrestricted" / "Don't optimise".
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
    }

    private fun companionRoleStatus(): String {
        val rm = getSystemService(RoleManager::class.java) ?: return "no RoleManager"
        return try {
            when {
                !rm.isRoleAvailable(ROLE_CALL_COMPANION) -> "role not available on this phone"
                rm.isRoleHeld(ROLE_CALL_COMPANION) -> "HELD"
                else -> "available, not held"
            }
        } catch (e: Exception) {
            "error: ${e.javaClass.simpleName}"
        }
    }

    private fun requestCompanionRole() {
        val rm = getSystemService(RoleManager::class.java)
        val status = companionRoleStatus()
        EventLog.add("COMPANION_ROLE_CHECK", null, status)
        if (rm == null || status != "available, not held") {
            toast("Companion role: $status")
            return
        }
        try {
            startActivityForResult(rm.createRequestRoleIntent(ROLE_CALL_COMPANION), REQ_ROLE)
        } catch (e: Exception) {
            EventLog.add("COMPANION_ROLE_ERROR", null, "${e.javaClass.simpleName}: ${e.message?.take(80)}")
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_ROLE) {
            EventLog.add("COMPANION_ROLE_RESULT", null, if (resultCode == RESULT_OK) "granted" else "not granted (result $resultCode)")
            refreshStatus()
        }
    }

    private fun shareLog() {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "Vector Companion event log")
            putExtra(Intent.EXTRA_TEXT, EventLog.exportText())
        }
        startActivity(Intent.createChooser(send, "Share log"))
    }

    private fun copyLog() {
        val cm = getSystemService(ClipboardManager::class.java)
        cm?.setPrimaryClip(ClipData.newPlainText("Vector Companion log", EventLog.exportText()))
        toast("Log copied")
    }

    private var clearArmed = 0L
    private fun confirmClear() {
        val now = System.currentTimeMillis()
        if (now - clearArmed < 3000) {
            EventLog.clear()
            renderLog()
            EventLog.add("LOG_CLEARED")
            clearArmed = 0
        } else {
            clearArmed = now
            toast("Tap Clear again within 3 seconds to delete the log")
        }
    }

    private fun startLink() {
        try {
            LinkServer.start(this)
        } catch (e: Exception) {
            toast("Could not start link: ${e.javaClass.simpleName}")
        }
        refreshLink()
    }

    private fun refreshLink() {
        val running = LinkServer.isRunning()
        val addresses = LinkServer.lanAddresses().map { "$it:${LinkServer.PORT}" }
            .joinToString(" or ").ifEmpty { "no Wi-Fi address" }
        linkStatus.text = buildString {
            append("Link: ").append(if (running) "running" else "stopped").append('\n')
            append("Address: ").append(addresses).append('\n')
            if (running) {
                append("Pairing code: ").append(LinkServer.activeCode() ?: "none, tap New code").append('\n')
            }
            append("Paired: ").append(if (LinkServer.isPaired(this@MainActivity)) "yes" else "no")
        }
    }

    private fun toast(t: String) = Toast.makeText(this, t, Toast.LENGTH_SHORT).show()

    companion object {
        private const val REQ_CORE = 1
        private const val REQ_CALL_LOG = 2
        private const val REQ_ROLE = 3
        // RoleManager.ROLE_CALL_COMPANION is a hidden constant; this is its value.
        private const val ROLE_CALL_COMPANION = "android.app.role.CALL_COMPANION"

        private val SCENARIOS = listOf(
            "1 Outgoing answered normally",
            "2 Rings, never answered",
            "3 Busy or rejected",
            "4 I cancel before answer",
            "5 Call ends normally (I hang up)",
            "6 Remote party hangs up",
            "7 Incoming call, no session",
            "8 Incoming call during a session",
            "9 SIM 1 vs SIM 2 / eSIM",
            "10 Phone loses network",
            "11 App in background / screen off",
            "12 (Phase 4) browser refresh",
            "13 (Phase 3) duplicate / out-of-order events",
            "14 (Phase 3) pairing lost",
            "15 Phone restart / permission revoked",
        )
    }
}
