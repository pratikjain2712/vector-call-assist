package app.vectorcall.companion

import android.content.ComponentName
import android.content.Context
import android.telecom.PhoneAccountHandle

/** Number validation and masking. Only E.164 numbers are ever dialled. */
object Phone {
    private val E164 = Regex("^\\+[1-9]\\d{7,14}$")

    /**
     * Accepts what a person usually types for an Indian number and returns E.164, or null.
     *   98765 43210 / 098765-43210 / 919876543210 / +91 98765 43210  ->  +919876543210
     * Numbers with any other country code must be typed with a leading +.
     */
    fun normalize(input: String, defaultCountryCode: String = "91"): String? {
        val trimmed = input.trim()
        val plus = trimmed.startsWith("+")
        val digits = trimmed.filter { it.isDigit() }
        val candidate = when {
            plus -> "+$digits"
            digits.length == 10 -> "+$defaultCountryCode$digits"
            digits.length == 11 && digits.startsWith("0") -> "+$defaultCountryCode${digits.substring(1)}"
            digits.length == 12 && digits.startsWith(defaultCountryCode) -> "+$digits"
            else -> return null
        }
        return if (E164.matches(candidate)) candidate else null
    }

    fun isE164(s: String) = E164.matches(s)

    /** "+919876543210" -> "+91•••••••210". Used in every log line. */
    fun mask(e164: String): String {
        if (e164.length <= 6) return "•••"
        return e164.take(3) + "•".repeat(e164.length - 6) + e164.takeLast(3)
    }

    /** Last 10 digits, for matching the same number written differently in the call log. */
    fun tail(number: String?): String = (number ?: "").filter { it.isDigit() }.takeLast(10)
}

/** Small settings store. Lives in the app's private storage. */
object Prefs {
    private const val FILE = "vector_companion"
    private const val KEY_SIM = "sim_handle"            // "<flattened component>|<id>" or empty = phone's default/ask
    private const val KEY_CALL_LOG = "call_log_probe"   // opt-in, default false
    private const val KEY_ACTIVE = "active_session"     // JSON of the session in progress, for crash recovery

    private fun sp(c: Context) = c.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun simHandle(c: Context): PhoneAccountHandle? {
        val raw = sp(c).getString(KEY_SIM, "") ?: ""
        val bar = raw.indexOf('|')
        if (bar <= 0) return null
        val component = ComponentName.unflattenFromString(raw.substring(0, bar)) ?: return null
        return PhoneAccountHandle(component, raw.substring(bar + 1))
    }

    fun setSimHandle(c: Context, h: PhoneAccountHandle?) {
        val v = if (h == null) "" else h.componentName.flattenToString() + "|" + h.id
        sp(c).edit().putString(KEY_SIM, v).apply()
    }

    fun callLogProbe(c: Context) = sp(c).getBoolean(KEY_CALL_LOG, false)
    fun setCallLogProbe(c: Context, on: Boolean) { sp(c).edit().putBoolean(KEY_CALL_LOG, on).apply() }

    fun activeSession(c: Context): String? = sp(c).getString(KEY_ACTIVE, null)
    fun setActiveSession(c: Context, json: String?) {
        // commit(), not apply(): this must be on disk before the call starts.
        sp(c).edit().apply { if (json == null) remove(KEY_ACTIVE) else putString(KEY_ACTIVE, json) }.commit()
    }
}
