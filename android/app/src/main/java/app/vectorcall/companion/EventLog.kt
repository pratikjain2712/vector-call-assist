package app.vectorcall.companion

import android.content.Context
import android.os.Build
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
 * Phone numbers are never written here, only masked forms (see Phone.mask).
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
            f.forEachLine { raw ->
                if (raw.isNotBlank()) {
                    try {
                        entries.add(Entry.fromJson(JSONObject(raw)))
                    } catch (e: Exception) {
                        // A torn last line (power loss mid-write) is skipped, not fatal.
                    }
                }
            }
            while (entries.size > KEEP_IN_MEMORY) entries.removeAt(0)
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

    /** Plain-text export for sharing test results. Contains masked numbers only. */
    fun exportText(): String {
        val sb = StringBuilder()
        sb.append("Vector Companion event log\n")
        sb.append("Exported: ").append(nowIso()).append('\n')
        sb.append("Device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
            .append(", Android ").append(Build.VERSION.RELEASE)
            .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n")
        sb.append("App: ").append(BuildConfigInfo.VERSION).append('\n')
        sb.append("Columns: seq | at | mono_ms | boot | type | session | detail\n\n")
        for (e in snapshot().takeLast(1500)) {
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
