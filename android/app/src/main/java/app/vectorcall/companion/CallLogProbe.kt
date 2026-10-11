package app.vectorcall.companion

import android.Manifest
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Strategy 3b, OPT-IN and off by default.
 *
 * After a Vector call ends, reads exactly one row: the outgoing call to the same number placed
 * after this session's dial request. CallLog.Calls.DURATION is the connected time in seconds
 * (0 when nobody answered). Nothing else from the call log is read, stored or sent.
 */
object CallLogProbe {
    private val main = Handler(Looper.getMainLooper())
    private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSXXX")

    fun schedule(c: Context, s: Sessions.Session) {
        // The dialer writes the call-log row a moment after the call ends.
        main.postDelayed({ probe(c, s, attempt = 1) }, 2_500)
    }

    private fun probe(c: Context, s: Sessions.Session, attempt: Int) {
        if (!Dialer.has(c, Manifest.permission.READ_CALL_LOG)) {
            EventLog.add("CALL_LOG_SKIPPED", s.id, "READ_CALL_LOG not granted")
            return
        }
        val since = s.dialWallMs - 5_000
        val wanted = Phone.tail(s.number)
        var found = false
        try {
            c.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE),
                "${CallLog.Calls.DATE} >= ? AND ${CallLog.Calls.TYPE} = ?",
                arrayOf(since.toString(), CallLog.Calls.OUTGOING_TYPE.toString()),
                "${CallLog.Calls.DATE} ASC",
            )?.use { cur ->
                while (cur.moveToNext()) {
                    if (Phone.tail(cur.getString(0)) != wanted) continue
                    val startMs = cur.getLong(1)
                    val seconds = cur.getLong(2)
                    val start = Instant.ofEpochMilli(startMs).atZone(ZoneId.systemDefault()).format(ISO)
                    EventLog.add(
                        "CALL_LOG_RESULT", s.id,
                        "connected=${seconds}s answered=${if (seconds > 0) "yes" else "no"} logStart=$start " +
                            "(dial request +${(startMs - s.dialWallMs) / 1000.0}s)",
                    )
                    found = true
                    break
                }
            }
        } catch (e: Exception) {
            EventLog.add("CALL_LOG_ERROR", s.id, "${e.javaClass.simpleName}: ${e.message?.take(80)}")
            return
        }
        if (!found) {
            if (attempt < 3) main.postDelayed({ probe(c, s, attempt + 1) }, 4_000)
            else EventLog.add("CALL_LOG_NOT_FOUND", s.id, "no matching outgoing row after $attempt attempts")
        }
    }
}
