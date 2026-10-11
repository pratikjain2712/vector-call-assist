package app.vectorcall.companion

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Pairing and message encryption for the laptop <-> phone link (Phase 3 spike).
 * Framework javax.crypto only. The browser side (web/link-spike.html) must match this exactly.
 *
 *   pairingKey = HMAC-SHA256(key = UTF-8(code), msg = "vca-pair-v1|" + nonceB64)
 *   encKey     = HMAC-SHA256(key = pairingKey, msg = "vca-enc-v1")           -> AES-256-GCM key
 *
 *   request body  = base64( iv[12] || AES-GCM(encKey, iv, json, aad = "POST\n" + path + "\n" + ts + "\n" + nonce) )
 *   response body = base64( iv[12] || AES-GCM(encKey, iv, json, aad = "RESP\n" + requestNonce) )
 *
 * GCM authenticates the body and binds it to the path, timestamp and nonce, so a separate HMAC
 * signature is not needed. The timestamp window and nonce cache stop replays.
 */
object LinkCrypto {
    private val rng = SecureRandom()

    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

    fun hmac(key: ByteArray, msg: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(msg)
    }

    fun pairingKey(code: String, nonceB64: String): ByteArray =
        hmac(code.toByteArray(Charsets.UTF_8), "vca-pair-v1|$nonceB64".toByteArray(Charsets.UTF_8))

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

    /** 6-digit pairing code, 100000..999999. */
    fun newCode(): String = (100000 + rng.nextInt(900000)).toString()
}
