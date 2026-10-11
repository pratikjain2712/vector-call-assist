package app.vectorcall.companion

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Logs reboots (test scenario 15) and restarts the monitor if permission is still granted. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        EventLog.init(context)
        EventLog.add("BOOT_COMPLETED", null, CallMonitorService.permissionSnapshot(context))
        if (!Dialer.has(context, Manifest.permission.READ_PHONE_STATE)) return
        try {
            CallMonitorService.start(context)
        } catch (e: Exception) {
            EventLog.add("MONITOR_BOOT_START_FAILED", null, "${e.javaClass.simpleName}: ${e.message?.take(100)}")
        }
    }
}
