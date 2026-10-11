package app.vectorcall.companion

import android.Manifest
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Append-only, file-backed event log. Survives app restarts and reboots.
 *
 * Every entry carries:
 *  - seq:  increasing number, never reused (used later for de-duplication on the website)
 *  - at:   wall-clock time, ISO 8601 with the device's UTC offset, e.g. 2026-10-11T14:05:09.123+05:30
 *  - mono: SystemClock.elapsedRealtime() in ms. Durations are computed from this, so a clock
 *          change during a call cannot corrupt them. It restarts at 0 after a reboot, hence `boot`.
 *  - boot: Settings.Global.BOOT_COUNT, so mono values from different boots are never compared.
 *
 * Lead names and phone numbers are never written here, not even masked. Session ids are random UUIDs.
 */
object EventLog {
    data class Entry(
        val seq: Long,
        val at: String,
        val mono: Long,
        val boot: Int,
        val type: String,
        val session: String?,
        val detail: String,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("seq", seq).put("at", at).put("mono", mono).put("boot", boot)
            .put("type", type).put("session", session ?: JSONObject.NULL).put("detail", detail)

        fun line(): String =
            "#$seq  ${if (at.length >= 23) at.substring(11, 23) else at}  $type" +
                (if (session != null) "  [${session.take(8)}]" else "") +
                (if (detail.isNotEmpty()) "  $detail" else "")

        companion object {
            fun fromJson(o: JSONObject) = Entry(
                o.getLong("seq"), o.getString("at"), o.getLong("mono"), o.optInt("boot", -1),
                o.getString("type"), if (o.isNull("session")) null else o.getString("session"),
                o.optString("detail", ""),
            )
        }
    }

    private const val TAG = "VectorCompanion"
    private const val FILE_NAME = "events.jsonl"
    private const val KEEP_IN_MEMORY = 2000
    private val MASKED_NUMBER = Regex("(?<![A-Za-z])to=\\S+")

    /** Replaces any "to=<number>" text, so no phone number stays in the log. */
    fun scrub(detail: String): String = detail.replace(MASKED_NUMBER, "to=(hidden)")

    private val entries = ArrayList<Entry>()
    private val listeners = CopyOnWriteArrayList<(Entry) -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private var file: File? = null
    private var nextSeq = 1L
    private var bootCount = -1

    @Synchronized
    fun init(context: Context) {
        if (file != null) return
        val f = File(context.applicationContext.filesDir, FILE_NAME)
        file = f
        bootCount = try {
            Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT)
        } catch (e: Exception) {
            -1
        }
        if (f.exists()) {
            var scrubbed = false
            f.forEachLine { raw ->
                if (raw.isNotBlank()) {
                    try {
                        val e = Entry.fromJson(JSONObject(raw))
                        val clean = scrub(e.detail)
                        if (clean != e.detail) scrubbed = true
                        entries.add(if (clean == e.detail) e else e.copy(detail = clean))
                    } catch (e: Exception) {
                        // A torn last line (power loss mid-write) is skipped, not fatal.
                    }
                }
            }
            while (entries.size > KEEP_IN_MEMORY) entries.removeAt(0)
            // Older builds wrote masked phone numbers here. Rewrite the stored file without them.
            if (scrubbed) try {
                f.writeText(entries.joinToString("") { it.toJson().toString() + "\n" })
            } catch (ex: Exception) {
                Log.w(TAG, "could not clean event log", ex)
            }
            nextSeq = (entries.lastOrNull()?.seq ?: 0L) + 1
        }
    }

    @Synchronized
    fun add(type: String, session: String? = null, detail: String = ""): Entry {
        val e = Entry(
            seq = nextSeq++,
            at = nowIso(),
            mono = SystemClock.elapsedRealtime(),
            boot = bootCount,
            type = type,
            session = session,
            detail = detail,
        )
        entries.add(e)
        if (entries.size > KEEP_IN_MEMORY) entries.removeAt(0)
        try {
            file?.appendText(e.toJson().toString() + "\n")
        } catch (ex: Exception) {
            Log.w(TAG, "could not write event log", ex)
        }
        Log.i(TAG, e.line())
        for (l in listeners) main.post { l(e) }
        return e
    }

    @Synchronized
    fun snapshot(): List<Entry> = ArrayList(entries)

    @Synchronized
    fun clear() {
        entries.clear()
        try {
            file?.writeText("")
        } catch (ex: Exception) {
            Log.w(TAG, "could not clear event log", ex)
        }
        // seq keeps increasing so old exports never collide with new ones.
    }

    fun addListener(l: (Entry) -> Unit) { listeners.add(l) }
    fun removeListener(l: (Entry) -> Unit) { listeners.remove(l) }

    // Fixed format so every timestamp has milliseconds and an explicit offset (OffsetDateTime.toString drops ".000").
    private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSXXX")

    fun nowIso(): String = OffsetDateTime.now().format(ISO)

    fun isoAt(ms: Long): String =
        OffsetDateTime.ofInstant(java.time.Instant.ofEpochMilli(ms), java.time.ZoneId.systemDefault()).format(ISO)

    /**
     * Text for the "Save diagnostic file" button: app version, the phone's status words and the last 200
     * event log lines. Lead names and numbers are never in it, so it is safe to send to support.
     */
    fun diagnosticText(c: Context): String {
        val sb = StringBuilder()
        sb.append("Vector Companion diagnostics\n")
        sb.append("Exported: ").append(nowIso()).append('\n')
        sb.append("App version: ").append(PhoneStatus.appVersion(c)).append('\n')
        sb.append("Device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(", Android ").append(Build.VERSION.RELEASE)
            .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n")
        sb.append("\nStatus\n")
        for ((name, word) in PhoneStatus.lines(c)) sb.append(name).append(": ").append(word).append('\n')
        sb.append("\nLast 200 event log lines\n")
        sb.append("Columns: seq | at | mono_ms | boot | type | session | detail\n\n")
        for (e in snapshot().takeLast(200)) {
            sb.append(e.seq).append(" | ").append(e.at).append(" | ").append(e.mono)
                .append(" | ").append(e.boot).append(" | ").append(e.type)
                .append(" | ").append(e.session ?: "-").append(" | ").append(e.detail).append('\n')
        }
        return sb.toString()
    }
}

/** Avoids depending on the generated BuildConfig class (disabled by default in AGP 8). */
object BuildConfigInfo {
    const val VERSION = "0.2.0-poc"
}

/**
 * The status words shown on the phone and written to the diagnostic file. Each pair is name and plain word.
 */
object PhoneStatus {
    private val CALL_PERMS = arrayOf(
        Manifest.permission.CALL_PHONE,
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.ANSWER_PHONE_CALLS,
    )

    fun appVersion(c: Context): String = try {
        c.packageManager.getPackageInfo(c.packageName, 0).versionName ?: BuildConfigInfo.VERSION
    } catch (e: Exception) {
        BuildConfigInfo.VERSION
    }

    fun lines(c: Context): List<Pair<String, String>> {
        val paired = LinkServer.isPaired(c)
        val running = LinkServer.isRunning()
        val lastHeard = LinkServer.lastHeardAt
        val wifi = LinkServer.lanAddresses().firstOrNull()
        val calls = CALL_PERMS.all { Dialer.has(c, it) }
        val battery = c.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(c.packageName) == true
        return listOf(
            "Pairing" to if (paired) "Paired" else "Not paired",
            "Link" to if (running) "On" else "Off",
            "Last heard from laptop" to if (lastHeard == 0L) "never" else EventLog.isoAt(lastHeard),
            "Calls" to if (calls) "Allowed" else "Not allowed",
            "Call log" to if (Dialer.has(c, Manifest.permission.READ_CALL_LOG)) "Allowed" else "Not allowed",
            "Notifications" to if (Dialer.has(c, Manifest.permission.POST_NOTIFICATIONS)) "Allowed" else "Not allowed",
            "Battery" to if (battery) "Unrestricted" else "Restricted",
            "Wi-Fi" to if (wifi != null) "Connected, $wifi" else "Not connected",
            "Call monitoring" to if (CallMonitorService.watching) "Watching" else "Not watching",
        )
    }
}
