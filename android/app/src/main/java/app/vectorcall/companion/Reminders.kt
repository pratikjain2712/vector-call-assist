package app.vectorcall.companion

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * Callback reminders the laptop schedules with {"op":"remind"}. The phone shows only the text it is given.
 * Pending reminders are kept in SharedPreferences as {at, text} pairs, so they survive a restart. One alarm is
 * armed for the earliest one. setAndAllowWhileIdle needs no exact-alarm permission, so a reminder can be a few
 * minutes late. A restart clears alarms, so BootReceiver calls [rearm].
 */
object Reminders {
    const val MAX_TEXT = 60
    private const val MAX_AHEAD_MS = 60L * 24 * 60 * 60 * 1000
    private const val MAX_PENDING = 50
    private const val PREFS = "vector_reminders"
    private const val KEY_PENDING = "pending"
    private const val CHANNEL_ID = "callbacks"
    private const val ALARM_REQUEST = 4301
    private const val OPEN_REQUEST = 4302
    private const val NOTIFY_BASE = 5000

    private class Pending(val at: Long, val text: String)

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** True when this app may show notifications: the POST_NOTIFICATIONS permission (Android 13+) and the app switch. */
    fun notificationsAllowed(c: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 33 && !Dialer.has(c, Manifest.permission.POST_NOTIFICATIONS)) return false
        return c.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() == true
    }

    /** Handles {"op":"remind","at":<epoch ms>,"text":"..."}. Runs on the main thread, like the other operations. */
    @Synchronized
    fun schedule(c: Context, req: JSONObject): JSONObject {
        fun fail(code: String) = JSONObject().put("ok", false).put("error", code)
        if (!req.has("at")) return fail("bad_time")
        val at = req.optLong("at", 0L)
        val text = req.optString("text", "")
        if (text.isBlank()) return fail("text_required")
        if (text.codePointCount(0, text.length) > MAX_TEXT) return fail("text_too_long")
        if (text.any { it.isISOControl() }) return fail("bad_text")
        val now = System.currentTimeMillis()
        if (at <= now) return fail("time_in_past")
        if (at > now + MAX_AHEAD_MS) return fail("time_too_far")
        if (!notificationsAllowed(c)) return fail("notifications_off")
        val items = load(c)
        if (items.size >= MAX_PENDING) return fail("too_many_pending")
        items.add(Pending(at, text))
        items.sortBy { it.at }
        save(c, items)
        arm(c, items.first().at)
        EventLog.add("REMINDER_SCHEDULED", null, "in ${(at - now) / 60_000} min")
        return JSONObject().put("ok", true).put("scheduled", 1)
    }

    /** Shows the reminders that are due, then arms the next one. Called by the alarm. */
    @Synchronized
    fun fireDue(c: Context) {
        val now = System.currentTimeMillis()
        val items = load(c)
        val due = items.filter { it.at <= now }
        val later = items.filter { it.at > now }
        if (due.isNotEmpty()) save(c, later)
        due.forEach { show(c, it) }
        later.minOfOrNull { it.at }?.let { arm(c, it) }
    }

    /** After a restart: drop the reminders that passed while the phone was off, and arm the next one. */
    @Synchronized
    fun rearm(c: Context) {
        val now = System.currentTimeMillis()
        val items = load(c)
        if (items.isEmpty()) return
        val later = items.filter { it.at > now }
        if (later.size != items.size) save(c, later)
        EventLog.add("REMINDERS_REARMED", null, "${later.size} pending, ${items.size - later.size} passed while off")
        later.minOfOrNull { it.at }?.let { arm(c, it) }
    }

    private fun show(c: Context, p: Pending) {
        if (!notificationsAllowed(c)) {
            EventLog.add("REMINDER_SKIPPED", null, "notifications are off")
            return
        }
        val nm = c.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Callback reminders", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            c, OPEN_REQUEST, Intent(c, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val note = Notification.Builder(c, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentText(p.text)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(NOTIFY_BASE + ((p.at / 1000) % 1_000_000).toInt(), note)
        EventLog.add("REMINDER_SHOWN")
    }

    /** One alarm slot: arming again replaces the earlier alarm, since the PendingIntent is the same. */
    private fun arm(c: Context, atMs: Long) {
        val am = c.getSystemService(AlarmManager::class.java) ?: return
        val pi = PendingIntent.getBroadcast(
            c, ALARM_REQUEST, Intent(c, ReminderReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi)
    }

    private fun load(c: Context): MutableList<Pending> {
        val raw = prefs(c).getString(KEY_PENDING, null) ?: return mutableListOf()
        val arr = try { JSONArray(raw) } catch (e: Exception) { return mutableListOf() }
        val out = mutableListOf<Pending>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out.add(Pending(o.optLong("at", 0L), o.optString("text", "")))
        }
        return out
    }

    private fun save(c: Context, items: List<Pending>) {
        val arr = JSONArray()
        items.forEach { arr.put(JSONObject().put("at", it.at).put("text", it.text)) }
        prefs(c).edit().putString(KEY_PENDING, arr.toString()).apply()
    }
}

/** Fired by AlarmManager when a callback reminder is due. Not exported: only the system alarm sends it. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        EventLog.init(context)
        try {
            Reminders.fireDue(context)
        } catch (e: Exception) {
            EventLog.add("REMINDER_FIRE_FAILED", null, "${e.javaClass.simpleName}: ${e.message?.take(100)}")
        }
    }
}
