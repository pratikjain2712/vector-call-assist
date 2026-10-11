package app.vectorcall.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager

/** Places and ends normal cellular calls through Telecom. Never dials on its own. */
object Dialer {
    data class Sim(val handle: PhoneAccountHandle, val label: String)

    fun has(c: Context, perm: String) = c.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

    /** SIMs / eSIMs that can place calls. Needs READ_PHONE_STATE. */
    fun sims(c: Context): List<Sim> {
        if (!has(c, Manifest.permission.READ_PHONE_STATE)) return emptyList()
        val tm = c.getSystemService(TelecomManager::class.java) ?: return emptyList()
        return try {
            tm.callCapablePhoneAccounts.map { h ->
                val label = tm.getPhoneAccount(h)?.label?.toString()?.takeIf { it.isNotBlank() } ?: "SIM ${h.id.takeLast(4)}"
                Sim(h, label)
            }
        } catch (e: SecurityException) {
            emptyList()
        }
    }

    fun simLabel(c: Context, h: PhoneAccountHandle?): String =
        if (h == null) "phone default" else sims(c).firstOrNull { it.handle == h }?.label ?: "saved SIM (not found)"

    /**
     * Starts the call. Returns null on success or a short reason on failure.
     * If no SIM is chosen, Android uses its default SIM or shows its own SIM picker.
     */
    fun place(c: Context, e164: String, sim: PhoneAccountHandle?): String? {
        if (!Phone.isE164(e164)) return "invalid number"
        if (!has(c, Manifest.permission.CALL_PHONE)) return "CALL_PHONE not granted"
        val tm = c.getSystemService(TelecomManager::class.java) ?: return "no TelecomManager"
        val extras = Bundle()
        if (sim != null) {
            // Only use the saved SIM if it still exists (eSIM may have been switched off).
            if (sims(c).none { it.handle == sim }) return "saved SIM is no longer available"
            extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, sim)
        }
        return try {
            tm.placeCall(Uri.fromParts("tel", e164, null), extras)
            null
        } catch (e: SecurityException) {
            "SecurityException: ${e.message?.take(80)}"
        } catch (e: Exception) {
            "${e.javaClass.simpleName}: ${e.message?.take(80)}"
        }
    }

    /** Hang up / cancel. Deprecated API; Phase 2 checks if it still works on Nothing OS. */
    @Suppress("DEPRECATION")
    fun end(c: Context): String? {
        if (!has(c, Manifest.permission.ANSWER_PHONE_CALLS)) return "ANSWER_PHONE_CALLS not granted"
        val tm = c.getSystemService(TelecomManager::class.java) ?: return "no TelecomManager"
        return try {
            if (tm.endCall()) null else "endCall returned false"
        } catch (e: SecurityException) {
            "SecurityException: ${e.message?.take(80)}"
        } catch (e: Exception) {
            "${e.javaClass.simpleName}: ${e.message?.take(80)}"
        }
    }
}
