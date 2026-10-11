package app.vectorcall.companion

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Pairing and message encryption for the laptop <-> phone link.
 * Framework javax.crypto only. The browser side (web/js/phone-link.js) must match exactly.
 *
 * Pairing secret: 16 characters from Crockford base32 (80 random bits), shown as XXXX-XXXX-XXXX-XXXX.
 * The secret itself is never sent. The laptop proves it knows the secret:
 *
 *   proof      = HMAC-SHA256(key = secret, msg = "vca-proof-v2|" + nonceB64)     (sent, checked by phone)
 *   pairingKey = HMAC-SHA256(key = secret, msg = "vca-pair-v2|" + nonceB64)
 *   encKey     = HMAC-SHA256(key = pairingKey, msg = "vca-enc-v1")               -> AES-256-GCM key
 *
 * Messages after pairing:
 *   request body  = base64( iv[12] || AES-GCM(encKey, iv, json, aad = "POST\n" + path + "\n" + ts + "\n" + nonce) )
 *   response body = base64( iv[12] || AES-GCM(encKey, iv, json, aad = "RESP\n" + requestNonce) )
 */
object LinkCrypto {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   // Crockford: no I, L, O, U
    private const val SECRET_LEN = 16
    private val rng = SecureRandom()

    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

    fun hmac(key: ByteArray, msg: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(msg)
    }

    /** New secret, formatted for display: XXXX-XXXX-XXXX-XXXX. */
    fun newSecret(): String {
        val bytes = ByteArray(10).also { rng.nextBytes(it) }   // 80 bits
        var bits = 0L
        var nbits = 0
        val out = StringBuilder()
        for (b in bytes) {
            bits = (bits shl 8) or (b.toLong() and 0xFF)
            nbits += 8
            while (nbits >= 5 && out.length < SECRET_LEN) {
                nbits -= 5
                out.append(ALPHABET[((bits shr nbits) and 31).toInt()])
            }
        }
        return out.toString().chunked(4).joinToString("-")
    }

    /** Accepts what a person types (dashes, spaces, lower case, I/L as 1, O as 0). Returns null if invalid. */
    fun normalizeSecret(input: String): String? {
        val s = input.uppercase()
            .replace('I', '1').replace('L', '1').replace('O', '0')
            .filter { it.isLetterOrDigit() }
        return if (s.length == SECRET_LEN && s.all { it in ALPHABET }) s else null
    }

    fun proof(secret: String, nonceB64: String): ByteArray =
        hmac(secret.toByteArray(Charsets.UTF_8), "vca-proof-v2|$nonceB64".toByteArray(Charsets.UTF_8))

    fun pairingKey(secret: String, nonceB64: String): ByteArray =
        hmac(secret.toByteArray(Charsets.UTF_8), "vca-pair-v2|$nonceB64".toByteArray(Charsets.UTF_8))

    fun encKey(pairingKey: ByteArray): ByteArray =
        hmac(pairingKey, "vca-enc-v1".toByteArray(Charsets.UTF_8))

    fun seal(key: ByteArray, plaintext: ByteArray, aad: String): String {
        val iv = ByteArray(12).also { rng.nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad.toByteArray(Charsets.UTF_8))
        return b64(iv + c.doFinal(plaintext))
    }

    /** Returns the plaintext, or null if the body is malformed or the tag does not verify. */
    fun open(key: ByteArray, sealed: String, aad: String): ByteArray? = try {
        val raw = unb64(sealed.trim())
        if (raw.size < 12 + 16) {
            null
        } else {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
            c.updateAAD(aad.toByteArray(Charsets.UTF_8))
            c.doFinal(raw.copyOfRange(12, raw.size))
        }
    } catch (e: Exception) {
        null
    }

    fun newNonce(): String = b64(ByteArray(16).also { rng.nextBytes(it) })
}
