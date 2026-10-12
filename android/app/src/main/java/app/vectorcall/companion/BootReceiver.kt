package app.vectorcall.companion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Logs reboots (test scenario 15), re-arms callback reminders, and restarts the monitor if permission is still granted.
 * If the link was on but READ_PHONE_STATE is missing, it posts one notice telling the person to open the app.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        EventLog.init(context)
        EventLog.add("BOOT_COMPLETED", null, CallMonitorService.permissionSnapshot(context))
        try {
            Reminders.rearm(context)
        } catch (e: Exception) {
            EventLog.add("REMINDER_REARM_FAILED", null, "${e.javaClass.simpleName}: ${e.message?.take(100)}")
        }
        if (!Dialer.has(context, Manifest.permission.READ_PHONE_STATE)) {
            if (LinkServer.enabled(context)) noticeLinkOff(context)
            return
        }
        try {
            CallMonitorService.start(context)
        } catch (e: Exception) {
            EventLog.add("MONITOR_BOOT_START_FAILED", null, "${e.javaClass.simpleName}: ${e.message?.take(100)}")
        }
    }

    /** One notice per boot (BOOT_COMPLETED arrives once; the fixed id keeps it from stacking). */
    private fun noticeLinkOff(ctx: Context) {
        if (!Reminders.notificationsAllowed(ctx)) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(NotificationChannel(LINK_CHANNEL, "Laptop link", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            ctx, OPEN_REQUEST, Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val note = Notification.Builder(ctx, LINK_CHANNEL)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentText("Open Vector Companion to restore the laptop link")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(LINK_NOTICE_ID, note)
        EventLog.add("LINK_RESTORE_NOTICE", null, "READ_PHONE_STATE missing after restart")
    }

    companion object {
        private const val LINK_CHANNEL = "link"
        private const val LINK_NOTICE_ID = 4203
        private const val OPEN_REQUEST = 4303
    }
}
