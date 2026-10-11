package app.vectorcall.companion

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * Tiny HTTP server on the phone (Phase 3 spike). Plain HTTP on the Wi-Fi, no library.
 * Bodies are encrypted with LinkCrypto, so the network never sees numbers or events in clear text.
 *
 *   POST /pair  {"code":"123456","nonce":"<b64>"}      one-time code, valid 2 minutes, 5 tries
 *   POST /api   encrypted {"op":"ping"}                phone is alive and paired
 *                         {"op":"events","after":N}    event log entries with seq > N
 *                         {"op":"dial","number":"+91…"} places a call, same rules as the Call button
 *
 * SPIKE LIMITS (see docs/phase3-spike.md before production):
 *  - the pairing key is stored in plain SharedPreferences; production must use the Android Keystore
 *  - a 6-digit code can be brute-forced offline by someone who captures the /pair exchange
 *  - no notification is shown per laptop-initiated call yet
 *  - the server only runs while this app is running in the foreground
 */
object LinkServer {
    const val PORT = 8765

    // Origins allowed to call the phone. localhost is for testing from the laptop; remove before release.
    private val ALLOWED_ORIGINS = setOf("https://pratikjain2712.github.io", "http://localhost:8000")

    private const val PREFS = "vector_link"
    private const val KEY_ENC = "enc_key"          // SPIKE ONLY: plain prefs
    private const val CODE_TTL_MS = 120_000L
    private const val MAX_TRIES = 5
    private const val SKEW_MS = 60_000L
    private const val DIAL_GAP_MS = 5_000L
    private const val MAX_BODY = 16_384
    private const val JSON = "application/json"

    @Volatile private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    private val seenNonces = ConcurrentHashMap<String, Long>()

    // Pairing state, in memory only. A code lives for 2 minutes anyway.
    private var pendingCode: String? = null
    private var pendingExpires = 0L
    private var tries = 0
    private var lastDialMs = 0L

    fun isRunning() = server != null

    fun isPaired(c: Context) = prefs(c).contains(KEY_ENC)

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Starts the listener if needed and issues a pairing code. Throws if the port is unavailable. */
    @Synchronized
    fun start(c: Context): String {
        val ctx = c.applicationContext
        if (server == null) {
            val s = ServerSocket()
            s.reuseAddress = true
            s.bind(InetSocketAddress(PORT))
            server = s
            Thread({ acceptLoop(s, ctx) }, "vca-link").start()
            EventLog.add("LINK_STARTED", null, "port $PORT")
        }
        return newPairingCode()
    }

    @Synchronized
    fun stop() {
        server?.close()
        server = null
        pendingCode = null
        EventLog.add("LINK_STOPPED")
    }

    @Synchronized
    fun newPairingCode(): String {
        val code = LinkCrypto.newCode()
        pendingCode = code
        pendingExpires = System.currentTimeMillis() + CODE_TTL_MS
        tries = 0
        EventLog.add("LINK_PAIR_CODE", null, "new code issued, valid 2 min")   // the code itself is never logged
        return code
    }

    /** The pairing code that can still be used, or null. */
    @Synchronized
    fun activeCode(): String? =
        pendingCode?.takeIf { System.currentTimeMillis() <= pendingExpires && tries < MAX_TRIES }

    fun lanAddresses(): List<String> = try {
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .filter { it.isUp && !it.isLoopback }
            .flatMap { Collections.list(it.inetAddresses) }
            .filterIsInstance<Inet4Address>()
            .mapNotNull { it.hostAddress }
    } catch (e: Exception) {
        emptyList()
    }

    // ---- HTTP plumbing -------------------------------------------------------------------

    private class Reply(private val out: OutputStream, private val origin: String?) {
        fun send(status: Int, type: String?, body: String) {
            val bytes = body.toByteArray(Charsets.UTF_8)
            val reason = when (status) {
                200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"; 401 -> "Unauthorized"
                403 -> "Forbidden"; 404 -> "Not Found"; 413 -> "Payload Too Large"; else -> "Error"
            }
            val sb = StringBuilder()
            sb.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n")
            if (type != null) sb.append("Content-Type: ").append(type).append("\r\n")
            sb.append("Content-Length: ").append(bytes.size).append("\r\n")
            sb.append("Connection: close\r\n")
            if (origin != null) {
                sb.append("Access-Control-Allow-Origin: ").append(origin).append("\r\n")
                sb.append("Access-Control-Allow-Methods: POST, OPTIONS\r\n")
                sb.append("Access-Control-Allow-Headers: Content-Type, X-Vca-Ts, X-Vca-Nonce\r\n")
                sb.append("Access-Control-Allow-Private-Network: true\r\n")
                sb.append("Access-Control-Max-Age: 600\r\n")
                sb.append("Vary: Origin\r\n")
            }
            sb.append("\r\n")
            out.write(sb.toString().toByteArray(Charsets.UTF_8))
            out.write(bytes)
            out.flush()
        }
    }

    private fun errJson(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()

    private fun acceptLoop(s: ServerSocket, ctx: Context) {
        while (!s.isClosed) {
            val sock = try { s.accept() } catch (e: Exception) { break }
            pool.execute { handle(sock, ctx) }
        }
    }

    private fun handle(sock: Socket, ctx: Context) {
        try {
            sock.soTimeout = 5_000
            serve(sock.getInputStream(), sock.getOutputStream(), ctx)
        } catch (e: Exception) {
            // Client went away or sent something unreadable. Nothing to answer.
        } finally {
            try { sock.close() } catch (e: Exception) { }
        }
    }

    private fun serve(inp: InputStream, out: OutputStream, ctx: Context) {
        val input = BufferedReader(InputStreamReader(inp, Charsets.UTF_8))
        val requestLine = input.readLine() ?: return
        val parts = requestLine.split(' ')
        val headers = HashMap<String, String>()
        while (true) {
            val line = input.readLine() ?: break
            if (line.isEmpty()) break
            val i = line.indexOf(':')
            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        val origin = headers["origin"]?.takeIf { it in ALLOWED_ORIGINS }
        val reply = Reply(out, origin)
        if (parts.size < 2) return reply.send(400, "text/plain", "bad request")
        val method = parts[0]
        val path = parts[1].substringBefore('?')

        if (method == "OPTIONS") return reply.send(204, null, "")
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        if (len < 0 || len > MAX_BODY) return reply.send(413, JSON, errJson("body too large"))
        val buf = CharArray(len)
        var read = 0
        while (read < len) {
            val n = input.read(buf, read, len - read)
            if (n < 0) break
            read += n
        }
        val body = String(buf, 0, read)

        when {
            method == "POST" && path == "/pair" -> pair(reply, body, ctx)
            method == "POST" && path == "/api" -> api(reply, body, headers, ctx)
            else -> reply.send(404, JSON, errJson("not found"))
        }
    }

    // ---- /pair ---------------------------------------------------------------------------

    private fun pair(reply: Reply, body: String, ctx: Context) {
        val j = (try { JSONObject(body) } catch (e: Exception) { null })
            ?: return reply.send(400, JSON, errJson("bad request"))
        val code = j.optString("code")
        val nonce = j.optString("nonce")

        val result: String = synchronized(this) {
            val expected = pendingCode
            when {
                expected == null || System.currentTimeMillis() > pendingExpires -> "code expired"
                tries >= MAX_TRIES -> "too many attempts"
                nonce.length !in 16..64 -> "bad request"
                else -> {
                    tries++
                    if (code != expected) {
                        if (tries >= MAX_TRIES) pendingCode = null
                        "wrong code"
                    } else {
                        val existed = isPaired(ctx)
                        val ek = LinkCrypto.encKey(LinkCrypto.pairingKey(code, nonce))
                        prefs(ctx).edit().putString(KEY_ENC, LinkCrypto.b64(ek)).apply()
                        pendingCode = null
                        EventLog.add(if (existed) "LINK_REPAIRED" else "LINK_PAIRED", null, "laptop paired")
                        "ok"
                    }
                }
            }
        }
        if (result == "ok") {
            reply.send(200, JSON, JSONObject().put("ok", true).toString())
        } else {
            EventLog.add("LINK_PAIR_FAILED", null, result)
            reply.send(if (result == "bad request") 400 else 403, JSON, errJson(result))
        }
    }

    // ---- /api ----------------------------------------------------------------------------

    private fun api(reply: Reply, body: String, headers: Map<String, String>, ctx: Context) {
        val keyB64 = prefs(ctx).getString(KEY_ENC, null)
            ?: return reply.send(401, JSON, errJson("not paired"))
        val key = LinkCrypto.unb64(keyB64)

        val ts = headers["x-vca-ts"]?.toLongOrNull()
        val nonce = headers["x-vca-nonce"] ?: ""
        if (ts == null || Math.abs(System.currentTimeMillis() - ts) > SKEW_MS) {
            return reply.send(401, JSON, errJson("stale or missing timestamp"))
        }
        if (nonce.length !in 16..64) return reply.send(401, JSON, errJson("bad nonce"))

        val aad = "POST\n/api\n$ts\n$nonce"
        val plain = LinkCrypto.open(key, body, aad)
            ?: return reply.send(401, JSON, errJson("authentication failed"))

        // Replay check only after the message has authenticated, so forged requests cannot fill the cache.
        val now = System.currentTimeMillis()
        seenNonces.values.removeIf { now - it > 2 * SKEW_MS }
        if (seenNonces.putIfAbsent(nonce, ts) != null) {
            return reply.send(401, JSON, errJson("replayed request"))
        }

        val req = (try { JSONObject(String(plain, Charsets.UTF_8)) } catch (e: Exception) { null })
            ?: return reply.send(400, JSON, errJson("bad request"))

        val answer: JSONObject = try {
            onMain { route(req, ctx) }
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", "phone error: ${e.javaClass.simpleName}")
        }
        val sealed = LinkCrypto.seal(key, answer.toString().toByteArray(Charsets.UTF_8), "RESP\n$nonce")
        reply.send(200, "text/plain", sealed)
    }

    private fun route(req: JSONObject, ctx: Context): JSONObject = when (req.optString("op")) {
        "ping" -> JSONObject().put("ok", true).put("op", "ping").put("phoneTime", EventLog.nowIso())
        "events" -> {
            val after = req.optLong("after", 0L)
            val arr = JSONArray()
            EventLog.snapshot().filter { it.seq > after }.takeLast(200).forEach { arr.put(it.toJson()) }
            JSONObject().put("ok", true).put("events", arr)
        }
        "dial" -> dial(req.optString("number"), ctx)
        else -> JSONObject().put("ok", false).put("error", "unknown op")
    }

    /** Same rules as the Call button: E.164 only, one session at a time, phone must be idle. */
    private fun dial(number: String, ctx: Context): JSONObject {
        fun fail(msg: String) = JSONObject().put("ok", false).put("error", msg)
        if (!Phone.isE164(number)) return fail("number must be E.164, for example +919876543210")
        val now = System.currentTimeMillis()
        if (now - lastDialMs < DIAL_GAP_MS) return fail("rate limited, wait a few seconds")
        lastDialMs = now

        val sim = Prefs.simHandle(ctx)
        val session = Sessions.request(ctx, number, Dialer.simLabel(ctx, sim))
            ?: return fail("not dialled: phone is busy or monitoring is off (see log)")
        val error = Dialer.place(ctx, number, sim)
        if (error != null) {
            Sessions.dialFailed(session, error)
            return fail(error)
        }
        EventLog.add("PLACE_CALL_OK", session.id, "requested from laptop link")
        return JSONObject().put("ok", true).put("session", session.id)
    }

    /** Runs a block on the main thread, where EventLog and Sessions are safe to touch. */
    private fun <T> onMain(block: () -> T): T {
        val task = FutureTask(Callable { block() })
        main.post(task)
        return task.get(5, TimeUnit.SECONDS)
    }
}
