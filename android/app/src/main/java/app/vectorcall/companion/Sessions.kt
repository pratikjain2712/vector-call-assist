package app.vectorcall.companion

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.telephony.TelephonyManager
import org.json.JSONObject
import java.util.Locale
import java.util.UUID

/**
 * The call-session state machine. All methods run on the main thread.
 *
 *   (none) --request--> REQUESTED --aggregate OFFHOOK within 20 s--> OFFHOOK --all SIMs IDLE--> ENDED
 *                           |                                           |
 *                           +--no OFFHOOK in 20 s / placeCall error--> FAILED
 *
 * Rules that keep unrelated calls out of a session:
 *  - A session can only start while every SIM is IDLE and no other session is open.
 *  - It binds only to the first OFFHOOK after the app itself asked Telecom to dial.
 *  - RINGING while a session is open is an *incoming* call: it is flagged, never added.
 *  - With no session open, call states are logged but change nothing.
 *
 * Answer time is recorded only from a real signal (companion InCallService ACTIVE).
 * OFFHOOK -> IDLE is reported as total call time, labelled approximate.
 */
object Sessions {
    enum class Phase { REQUESTED, OFFHOOK, ENDED, FAILED }

    class Session(
        val id: String,
        val number: String,         // E.164, kept in memory/private storage only, never logged
        val simLabel: String,
        val dialWallMs: Long,
        val dialMono: Long,
    ) {
        var phase = Phase.REQUESTED
        var offhookMono = 0L
        var activeMono = 0L          // from companion InCallService only
        var endMono = 0L
        var offhookWallMs = 0L       // wall clock, for the laptop website
        var endWallMs = 0L
        var manualAnswerMono = 0L    // tester's "they answered" tap, ground truth for Phase 2
        var incomingSeen = false
        var disconnectCause: String? = null
        var endReason: String? = null     // set when the phone sees the call go IDLE ("person"); the laptop link never sets it
        val open get() = phase == Phase.REQUESTED || phase == Phase.OFFHOOK

        fun toJson(): String = JSONObject().put("id", id).put("phase", phase.name)
            .put("dialWallMs", dialWallMs).put("dialMono", dialMono).toString()
    }

    const val BIND_WINDOW_MS = 20_000L

    private val main = Handler(Looper.getMainLooper())
    private val subStates = HashMap<Int, Int>()
    private lateinit var app: Context

    var current: Session? = null
        private set

    /** Recent sessions, newest first, so the laptop can ask for a result after the call ends. */
    private val history = ArrayDeque<Session>()

    fun find(id: String): Session? = history.firstOrNull { it.id == id }

    fun init(c: Context) {
        if (!::app.isInitialized) app = c.applicationContext
    }

    fun aggregate(): Int = when {
        subStates.values.any { it == TelephonyManager.CALL_STATE_OFFHOOK } -> TelephonyManager.CALL_STATE_OFFHOOK
        subStates.values.any { it == TelephonyManager.CALL_STATE_RINGING } -> TelephonyManager.CALL_STATE_RINGING
        else -> TelephonyManager.CALL_STATE_IDLE
    }

    fun stateName(s: Int) = when (s) {
        TelephonyManager.CALL_STATE_IDLE -> "IDLE"
        TelephonyManager.CALL_STATE_RINGING -> "RINGING"
        TelephonyManager.CALL_STATE_OFFHOOK -> "OFFHOOK"
        else -> "UNKNOWN($s)"
    }

    /** After a restart: a session that was open when the app died is reported, never guessed. */
    fun restore(c: Context) {
        init(c)
        val raw = Prefs.activeSession(c) ?: return
        val id = try { JSONObject(raw).getString("id") } catch (e: Exception) { null }
        EventLog.add("SESSION_ORPHANED", id, "app restarted while a call session was open; result unknown")
        Prefs.setActiveSession(c, null)
    }

    /** Opens a session. Returns null (and logs why) if the phone is not free. */
    fun request(c: Context, e164: String, simLabel: String): Session? {
        init(c)
        val cur = current
        if (cur != null && cur.open) {
            EventLog.add("REJECT_SESSION_OPEN", cur.id, "a session is already in progress")
            return null
        }
        if (!CallMonitorService.watching) {
            EventLog.add("REJECT_NOT_MONITORING", null, "call monitor not running; grant phone permission first")
            return null
        }
        if (aggregate() != TelephonyManager.CALL_STATE_IDLE) {
            EventLog.add("REJECT_PHONE_BUSY", null, "phone is ${stateName(aggregate())}")
            return null
        }
        val s = Session(UUID.randomUUID().toString(), e164, simLabel, System.currentTimeMillis(), SystemClock.elapsedRealtime())
        current = s
        history.addFirst(s)
        while (history.size > 20) history.removeLast()
        Prefs.setActiveSession(app, s.toJson())
        EventLog.add("DIAL_REQUESTED", s.id, "sim=$simLabel")
        main.postDelayed({
            if (current === s && s.phase == Phase.REQUESTED) {
                s.phase = Phase.FAILED
                EventLog.add("DIAL_NO_OFFHOOK", s.id, "no OFFHOOK within ${BIND_WINDOW_MS / 1000}s; call probably never started")
                close(s)
            }
        }, BIND_WINDOW_MS)
        return s
    }

    fun dialFailed(s: Session, reason: String) {
        if (!s.open) return
        s.phase = Phase.FAILED
        EventLog.add("DIAL_FAILED", s.id, reason)
        close(s)
    }

    /** From CallStateWatcher, one call per SIM per change. */
    fun onCallState(subId: Int, state: Int) {
        subStates[subId] = state
        val agg = aggregate()
        EventLog.add("CALL_STATE", current?.takeIf { it.open }?.id, "sim=$subId state=${stateName(state)} all=${stateName(agg)}")
        val s = current ?: return
        if (!s.open) return
        val now = SystemClock.elapsedRealtime()

        if (state == TelephonyManager.CALL_STATE_RINGING) {
            s.incomingSeen = true
            EventLog.add("INCOMING_DURING_SESSION", s.id, "an incoming call rang; it is not counted for this lead")
            return
        }
        if (s.phase == Phase.REQUESTED && agg == TelephonyManager.CALL_STATE_OFFHOOK && s.incomingSeen) {
            // An incoming call rang before our call went off-hook: OFFHOOK could be either call.
            s.phase = Phase.FAILED
            EventLog.add("SESSION_AMBIGUOUS", s.id, "incoming call rang before dialling started; not bound")
            close(s)
            return
        }
        if (s.phase == Phase.REQUESTED && agg == TelephonyManager.CALL_STATE_OFFHOOK) {
            s.phase = Phase.OFFHOOK
            s.offhookMono = now
            s.offhookWallMs = System.currentTimeMillis()
            EventLog.add("SESSION_BOUND", s.id, "OFFHOOK ${ms(now - s.dialMono)} after request (dialling started, NOT answered)")
            return
        }
        if (s.phase == Phase.OFFHOOK && agg == TelephonyManager.CALL_STATE_IDLE) {
            s.phase = Phase.ENDED
            s.endMono = now
            s.endWallMs = System.currentTimeMillis()
            s.endReason = s.endReason ?: "person"
            EventLog.add("SESSION_ENDED", s.id, "ended: ${s.endReason}; all SIMs IDLE")
            summarize(s)
            close(s)
            if (Prefs.callLogProbe(app)) CallLogProbe.schedule(app, s)
        }
    }

    /** From LinkServer when the Wi-Fi to the laptop drops. Only records the fact; the call's end reason still comes from the phone. */
    fun onLinkLost() {
        val s = current?.takeIf { it.open } ?: return
        EventLog.add("LINK_LOST_DURING_CALL", s.id, "Wi-Fi to the laptop dropped while the call was open; the phone call is not affected by this")
    }

    /** From CompanionInCallService, if Telecom ever binds it. */
    fun onTelecomState(state: String, outgoing: Boolean, cause: String?) {
        val s = current ?: return
        if (!s.open || !outgoing) return
        if (state == "ACTIVE" && s.activeMono == 0L) {
            s.activeMono = SystemClock.elapsedRealtime()
            EventLog.add("ANSWERED_EXACT", s.id, "Telecom reports ACTIVE ${ms(s.activeMono - s.dialMono)} after request")
        }
        if (state == "DISCONNECTED" && cause != null) s.disconnectCause = cause
    }

    /** Tester taps this the moment the other person answers. Ground truth for accuracy checks. */
    fun markAnswered() {
        val s = current
        if (s == null || s.phase != Phase.OFFHOOK) {
            EventLog.add("MANUAL_MARK_IGNORED", s?.id, "no call in progress")
            return
        }
        s.manualAnswerMono = SystemClock.elapsedRealtime()
        EventLog.add("MANUAL_ANSWER_MARK", s.id, "${ms(s.manualAnswerMono - s.offhookMono)} after OFFHOOK")
    }

    private fun summarize(s: Session) {
        val total = (s.endMono - s.offhookMono) / 1000.0
        val parts = mutableListOf(String.format(Locale.US, "total(OFFHOOK->IDLE)=%.1fs", total))
        val quality: String
        if (s.activeMono > 0) {
            parts += String.format(Locale.US, "connected(ACTIVE->IDLE)=%.1fs", (s.endMono - s.activeMono) / 1000.0)
            quality = "exact"
        } else {
            parts += "connected=unknown"
            quality = "approximate"
        }
        if (s.manualAnswerMono > 0) {
            parts += String.format(Locale.US, "manual-connected=%.1fs", (s.endMono - s.manualAnswerMono) / 1000.0)
        }
        s.disconnectCause?.let { parts += "cause=$it" }
        parts += "ended=${s.endReason ?: "unknown"}"
        if (s.incomingSeen) parts += "incoming-call-during-session"
        parts += "quality=$quality"
        EventLog.add("SUMMARY", s.id, parts.joinToString(" "))
    }

    private fun close(s: Session) {
        if (s.endWallMs == 0L) s.endWallMs = System.currentTimeMillis()
        if (current === s) Prefs.setActiveSession(app, null)
    }

    private fun ms(v: Long) = String.format(Locale.US, "%.1fs", v / 1000.0)
}
