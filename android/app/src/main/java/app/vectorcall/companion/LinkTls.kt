package app.vectorcall.companion

import android.content.Context
import org.bouncycastle.asn1.DEROctetString
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.io.File
import java.math.BigInteger
import java.net.InetAddress
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext

/**
 * Self-signed HTTPS certificate for the phone's link server.
 *
 * The certificate names the phone's current Wi-Fi address. The browser asks you to accept it once
 * (the website shows the page to open). It is recreated only when the phone's address changes.
 * The key is stored in the app's private files as a PKCS#12 file; its password is in private prefs.
 */
object LinkTls {
    private const val PREFS = "vector_link"
    private const val KEY_PW = "tls_pw"
    private const val KEY_IP = "tls_ip"
    private const val FILE = "link_tls.p12"
    private const val ALIAS = "vector-link"
    private const val PW_CHARS = "ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz23456789"

    /** An SSLContext that serves [ip], creating a new certificate first if needed. */
    @Synchronized
    fun contextFor(c: Context, ip: String): SSLContext {
        val app = c.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val file = File(app.filesDir, FILE)
        val savedPw = prefs.getString(KEY_PW, null)
        if (savedPw == null || prefs.getString(KEY_IP, null) != ip || !file.exists()) {
            val pw = randomPassword()
            build(file, pw, ip)
            prefs.edit().putString(KEY_PW, pw).putString(KEY_IP, ip).apply()
        }
        val pw = prefs.getString(KEY_PW, null) ?: error("missing certificate password")
        val ks = KeyStore.getInstance("PKCS12")
        file.inputStream().use { ks.load(it, pw.toCharArray()) }
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(ks, pw.toCharArray())
        return SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, null, null) }
    }

    private fun build(file: File, pw: String, ip: String) {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val now = System.currentTimeMillis()
        val name = X500Name("CN=Vector Companion")
        val builder = JcaX509v3CertificateBuilder(
            name,
            BigInteger(63, SecureRandom()).add(BigInteger.ONE),
            Date(now - 86_400_000L),
            Date(now + 10L * 365 * 86_400_000L),
            name,
            kp.public,
        )
        val addr = DEROctetString(InetAddress.getByName(ip).address)
        builder.addExtension(Extension.subjectAlternativeName, false, GeneralNames(GeneralName(GeneralName.iPAddress, addr)))
        val signer = JcaContentSignerBuilder("SHA256withECDSA").build(kp.private)
        val cert = JcaX509CertificateConverter().getCertificate(builder.build(signer))

        val ks = KeyStore.getInstance("PKCS12")
        ks.load(null, null)
        ks.setKeyEntry(ALIAS, kp.private, pw.toCharArray(), arrayOf<java.security.cert.Certificate>(cert))
        file.outputStream().use { ks.store(it, pw.toCharArray()) }
    }

    private fun randomPassword(): String {
        val r = SecureRandom()
        return (1..24).map { PW_CHARS[r.nextInt(PW_CHARS.length)] }.joinToString("")
    }
}
