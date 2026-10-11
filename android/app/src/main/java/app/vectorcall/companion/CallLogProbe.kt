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
 * Reads the call-log row for one Vector session: the outgoing call to the same number placed after
 * the session's dial request. CallLog.Calls.DURATION is the connected time in seconds (0 when nobody
 * answered). Nothing else from the call log is read, stored or sent.
 *
 * Used two ways:
 *  - opt-in probe after each call (Prefs.callLogProbe), written to the event log;
 *  - on demand from the laptop website, via the "result" operation in LinkServer.
 */
object CallLogProbe {
    private val main = Handler(Looper.getMainLooper())
    private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSXXX")

    /** connectedSeconds 0 means not answered. logStartMs is the call's start as the phone recorded it. */
    class Lookup(val connectedSeconds: Long, val logStartMs: Long)

    /** Null if READ_CALL_LOG is missing, the row is not there yet, or the query fails. */
    fun lookup(c: Context, s: Sessions.Session): Lookup? {
        if (!Dialer.has(c, Manifest.permission.READ_CALL_LOG)) return null
        val since = s.dialWallMs - 5_000
        val wanted = Phone.tail(s.number)
        return try {
            c.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE),
                "${CallLog.Calls.DATE} >= ? AND ${CallLog.Calls.TYPE} = ?",
                arrayOf(since.toString(), CallLog.Calls.OUTGOING_TYPE.toString()),
                "${CallLog.Calls.DATE} ASC",
            )?.use { cur ->
                var found: Lookup? = null
                while (cur.moveToNext()) {
                    if (Phone.tail(cur.getString(0)) != wanted) continue
                    found = Lookup(cur.getLong(2), cur.getLong(1))
                    break
                }
                found
            }
        } catch (e: Exception) {
            null
        }
    }

    fun schedule(c: Context, s: Sessions.Session) {
        // The dialer writes the call-log row a moment after the call ends.
        main.postDelayed({ probe(c, s, attempt = 1) }, 2_500)
    }

    private fun probe(c: Context, s: Sessions.Session, attempt: Int) {
        if (!Dialer.has(c, Manifest.permission.READ_CALL_LOG)) {
            EventLog.add("CALL_LOG_SKIPPED", s.id, "READ_CALL_LOG not granted")
            return
        }
        val hit = lookup(c, s)
        if (hit != null) {
            val start = Instant.ofEpochMilli(hit.logStartMs).atZone(ZoneId.systemDefault()).format(ISO)
            EventLog.add(
                "CALL_LOG_RESULT", s.id,
                "connected=${hit.connectedSeconds}s answered=${if (hit.connectedSeconds > 0) "yes" else "no"} " +
                    "logStart=$start (dial request +${(hit.logStartMs - s.dialWallMs) / 1000.0}s)",
            )
        } else if (attempt < 3) {
            main.postDelayed({ probe(c, s, attempt + 1) }, 4_000)
        } else {
            EventLog.add("CALL_LOG_NOT_FOUND", s.id, "no matching outgoing row after $attempt attempts")
        }
    }
}
