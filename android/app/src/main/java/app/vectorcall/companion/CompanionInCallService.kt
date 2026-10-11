package app.vectorcall.companion

import android.telecom.Call
import android.telecom.DisconnectCause
import android.telecom.InCallService

/**
 * Strategy 3a probe. Observer only: it never answers, rejects, mutes or shows UI.
 *
 * Telecom binds InCallServices for the default dialer, car-mode apps and "call companion" apps.
 * Whether this sideloaded app can become a call companion on the Nothing Phone (2) is exactly
 * what Phase 2 checks. If ICS_BOUND never appears in the log, this path is not available.
 */
class CompanionInCallService : InCallService() {

    private val callback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            report(call, state)
        }
    }

    override fun onCreate() {
        super.onCreate()
        EventLog.init(this)
        Sessions.init(this)
        bindCount++
        EventLog.add("ICS_BOUND", Sessions.current?.takeIf { it.open }?.id, "Telecom bound the companion InCallService")
    }

    override fun onDestroy() {
        EventLog.add("ICS_UNBOUND")
        super.onDestroy()
    }

    override fun onCallAdded(call: Call) {
        call.registerCallback(callback)
        report(call, call.details.state)
    }

    override fun onCallRemoved(call: Call) {
        call.unregisterCallback(callback)
        EventLog.add("ICS_CALL_REMOVED", Sessions.current?.takeIf { it.open }?.id, direction(call))
    }

    private fun report(call: Call, state: Int) {
        val name = stateName(state)
        val outgoing = call.details.callDirection == Call.Details.DIRECTION_OUTGOING
        var cause: String? = null
        if (state == Call.STATE_DISCONNECTED) {
            val dc = call.details.disconnectCause
            cause = causeName(dc.code) + (dc.reason?.takeIf { it.isNotBlank() }?.let { "/$it" } ?: "")
        }
        EventLog.add(
            "ICS_STATE", Sessions.current?.takeIf { it.open }?.id,
            "${direction(call)} state=$name" + (cause?.let { " cause=$it" } ?: ""),
        )
        Sessions.onTelecomState(name, outgoing, cause)
    }

    private fun direction(call: Call) = when (call.details.callDirection) {
        Call.Details.DIRECTION_OUTGOING -> "outgoing"
        Call.Details.DIRECTION_INCOMING -> "incoming"
        else -> "unknown-direction"
    }

    companion object {
        @Volatile var bindCount = 0
            private set

        fun stateName(s: Int) = when (s) {
            Call.STATE_NEW -> "NEW"
            Call.STATE_DIALING -> "DIALING"
            Call.STATE_RINGING -> "RINGING"
            Call.STATE_HOLDING -> "HOLDING"
            Call.STATE_ACTIVE -> "ACTIVE"
            Call.STATE_DISCONNECTED -> "DISCONNECTED"
            Call.STATE_SELECT_PHONE_ACCOUNT -> "SELECT_PHONE_ACCOUNT"
            Call.STATE_CONNECTING -> "CONNECTING"
            Call.STATE_DISCONNECTING -> "DISCONNECTING"
            Call.STATE_PULLING_CALL -> "PULLING_CALL"
            Call.STATE_AUDIO_PROCESSING -> "AUDIO_PROCESSING"
            Call.STATE_SIMULATED_RINGING -> "SIMULATED_RINGING"
            else -> "STATE_$s"
        }

        fun causeName(c: Int) = when (c) {
            DisconnectCause.UNKNOWN -> "UNKNOWN"
            DisconnectCause.ERROR -> "ERROR"
            DisconnectCause.LOCAL -> "LOCAL"
            DisconnectCause.REMOTE -> "REMOTE"
            DisconnectCause.CANCELED -> "CANCELED"
            DisconnectCause.MISSED -> "MISSED"
            DisconnectCause.REJECTED -> "REJECTED"
            DisconnectCause.BUSY -> "BUSY"
            DisconnectCause.RESTRICTED -> "RESTRICTED"
            DisconnectCause.OTHER -> "OTHER"
            DisconnectCause.CONNECTION_MANAGER_NOT_SUPPORTED -> "CONNECTION_MANAGER_NOT_SUPPORTED"
            DisconnectCause.ANSWERED_ELSEWHERE -> "ANSWERED_ELSEWHERE"
            DisconnectCause.CALL_PULLED -> "CALL_PULLED"
            else -> "CAUSE_$c"
        }
    }
}
