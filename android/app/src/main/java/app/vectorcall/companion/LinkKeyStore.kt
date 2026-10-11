package app.vectorcall.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps the link's encryption key on the phone. The key is wrapped with a hardware-backed
 * Android Keystore key, so the plain value is never written to storage.
 */
object LinkKeyStore {
    private const val ALIAS = "vca_link_wrap_v1"
    private const val PREFS = "vector_link"
    private const val KEY_WRAPPED = "enc_key_wrapped"
    private const val KEY_IV = "enc_key_iv"

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun wrapKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun isSaved(c: Context) = prefs(c).contains(KEY_WRAPPED)

    fun save(c: Context, key: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
        val wrapped = cipher.doFinal(key)
        prefs(c).edit()
            .putString(KEY_WRAPPED, LinkCrypto.b64(wrapped))
            .putString(KEY_IV, LinkCrypto.b64(cipher.iv))
            .apply()
    }

    /** The plain key, or null if not paired or the Keystore entry is gone. */
    fun load(c: Context): ByteArray? {
        return try {
            val p = prefs(c)
            val wrapped = p.getString(KEY_WRAPPED, null) ?: return null
            val iv = p.getString(KEY_IV, null) ?: return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, LinkCrypto.unb64(iv)))
            cipher.doFinal(LinkCrypto.unb64(wrapped))
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Wraps a short secret (the certificate password) with the same Keystore key. Returns "iv.ciphertext"
     * in Base64, which is safe to keep in prefs. Throws if the Keystore is unavailable.
     */
    fun wrapText(text: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
        val wrapped = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        return LinkCrypto.b64(cipher.iv) + "." + LinkCrypto.b64(wrapped)
    }

    /** The secret from [wrapText], or null if it cannot be opened (for example, the Keystore entry is gone). */
    fun unwrapText(blob: String): String? {
        val parts = blob.split('.')
        if (parts.size != 2) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, LinkCrypto.unb64(parts[0])))
            String(cipher.doFinal(LinkCrypto.unb64(parts[1])), Charsets.UTF_8)
        } catch (e: Exception) {
            null
        }
    }

    fun clear(c: Context) {
        prefs(c).edit().remove(KEY_WRAPPED).remove(KEY_IV).apply()
    }
}
