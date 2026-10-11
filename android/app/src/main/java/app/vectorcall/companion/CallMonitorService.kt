package app.vectorcall.companion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/**
 * Foreground service that keeps the call-state listener alive while the screen is off or the
 * app is in the background. Shows a permanent notification, as Android requires.
 */
class CallMonitorService : Service() {
    private var watcher: CallStateWatcher? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        EventLog.init(this)
        Sessions.init(this)
        try {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } catch (e: Exception) {
            EventLog.add("MONITOR_FOREGROUND_FAILED", null, "${e.javaClass.simpleName}: ${e.message?.take(100)}")
            stopSelf()
            return
        }
        running = true
        EventLog.add("MONITOR_STARTED", null, permissionSnapshot(this))
        Sessions.restore(this)
        val w = CallStateWatcher(this)
        watcher = w
        watching = w.start()
        LinkServer.listen(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_RESTART_WATCHER) {
            watching = watcher?.start() ?: false
        }
        return START_STICKY
    }

    override fun onDestroy() {
        watcher?.stop()
        watcher = null
        running = false
        watching = false
        EventLog.add("MONITOR_STOPPED")
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Call monitor", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Vector Companion is watching call state"
            }
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle("Vector Companion is watching call state")
            .setContentText("No audio, contacts or SMS are accessed.")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "monitor"
        private const val NOTIFICATION_ID = 1
        const val ACTION_RESTART_WATCHER = "app.vectorcall.companion.RESTART_WATCHER"

        @Volatile var running = false
            private set
        @Volatile var watching = false
            private set

        fun start(c: Context, restartWatcher: Boolean = false) {
            val i = Intent(c, CallMonitorService::class.java)
            if (restartWatcher) i.action = ACTION_RESTART_WATCHER
            c.startForegroundService(i)
        }

        fun stop(c: Context) {
            c.stopService(Intent(c, CallMonitorService::class.java))
        }

        fun permissionSnapshot(c: Context): String {
            val perms = listOf(
                "CALL_PHONE" to Manifest.permission.CALL_PHONE,
                "READ_PHONE_STATE" to Manifest.permission.READ_PHONE_STATE,
                "ANSWER_PHONE_CALLS" to Manifest.permission.ANSWER_PHONE_CALLS,
                "READ_CALL_LOG" to Manifest.permission.READ_CALL_LOG,
                "POST_NOTIFICATIONS" to Manifest.permission.POST_NOTIFICATIONS,
            )
            return perms.joinToString(" ") { (n, p) -> "$n=" + if (Dialer.has(c, p)) "yes" else "no" }
        }
    }
}
