package app.vectorcall.companion

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.telephony.SubscriptionManager
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager

/**
 * Strategy 1: TelephonyCallback.CallStateListener, registered once per active SIM/eSIM so
 * dual-SIM behaviour is visible in the log. Gives IDLE / RINGING / OFFHOOK only, with no number.
 */
class CallStateWatcher(private val context: Context) {
    private val registered = mutableListOf<Pair<TelephonyManager, TelephonyCallback>>()

    private class Listener(private val subId: Int) : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) {
            Sessions.onCallState(subId, state)
        }
    }

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        stop()
        if (!Dialer.has(context, Manifest.permission.READ_PHONE_STATE)) {
            EventLog.add("WATCHER_NO_PERMISSION", null, "READ_PHONE_STATE not granted")
            return false
        }
        val base = context.getSystemService(TelephonyManager::class.java)
        if (base == null) {
            EventLog.add("WATCHER_ERROR", null, "no TelephonyManager")
            return false
        }
        val sm = context.getSystemService(SubscriptionManager::class.java)
        val subs = try {
            sm?.activeSubscriptionInfoList ?: emptyList()
        } catch (e: SecurityException) {
            emptyList()
        }

        val targets = if (subs.isEmpty()) {
            listOf(-1 to base)
        } else {
            subs.map { it.subscriptionId to base.createForSubscriptionId(it.subscriptionId) }
        }
        for ((subId, tm) in targets) {
            val cb = Listener(subId)
            try {
                tm.registerTelephonyCallback(context.mainExecutor, cb)
                registered += tm to cb
            } catch (e: Exception) {
                EventLog.add("WATCHER_ERROR", null, "sim=$subId ${e.javaClass.simpleName}: ${e.message?.take(80)}")
            }
        }
        val desc = if (subs.isEmpty()) "default line only (no SIM list)"
        else subs.joinToString { "sim=${it.subscriptionId} slot=${it.simSlotIndex} '${it.displayName}'" + if (it.isEmbedded) " eSIM" else "" }
        EventLog.add("WATCHER_STARTED", null, "${registered.size} listener(s): $desc")
        return registered.isNotEmpty()
    }

    fun stop() {
        for ((tm, cb) in registered) {
            try {
                tm.unregisterTelephonyCallback(cb)
            } catch (e: Exception) {
                // already gone
            }
        }
        registered.clear()
    }
}
