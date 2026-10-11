package app.vectorcall.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
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
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * Small HTTP server on the phone for the Vector website. Plain HTTP on the Wi-Fi, no library.
 * Bodies are encrypted (LinkCrypto), so the network sees no numbers or events in clear text.
 * It keeps running with the monitor service, so it survives the screen being off or a reboot.
 *
 *   POST /pair  {"nonce":"<b64>","proof":"<b64>"}     one pairing secret, valid 2 minutes, 5 tries
 *   POST /api   encrypted:
 *       {"op":"ping"}
 *       {"op":"dial","number":"+91…"}                 same rules as the Call button; shows a notification
 *       {"op":"hangup"}                               ends the current call
 *       {"op":"status","session":"<id>"}              phase and wall-clock times, for a live timer
 *       {"op":"result","session":"<id>"}              connected time from the call log, when available
 *       {"op":"events","after":N}                     event log entries with seq > N
 *
 * LIMITS STILL OPEN (see docs/phase3-spike.md): the server runs only while the monitor service runs,
 * and the call-log result needs READ_CALL_LOG, which is opt-in.
 */
object LinkServer {
    const val PORT = 8765

    // Origins allowed to call the phone. The laptop test copy runs at http://localhost:8000
    // (plain http from a secure localhost origin avoids the browser mixed-content block).
    private val ALLOWED_ORIGINS = setOf(
        "https://pratikjain2712.github.io",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    )

    private const val PREFS = "vector_link"
    private const val KEY_ENABLED = "link_enabled"
    private const val CODE_TTL_MS = 120_000L
    private const val MAX_TRIES = 5
    private const val SKEW_MS = 60_000L
    private const val DIAL_GAP_MS = 5_000L
    private const val MAX_BODY = 16_384
    private const val JSON = "application/json"
    private const val NOTIFY_CHANNEL = "vector_link_calls"
    private const val NOTIFY_ID = 4201

    @Volatile private var server: ServerSocket? = null
    private val pool = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    private val seenNonces = ConcurrentHashMap<String, Long>()

    // Pairing state, in memory only.
    private var pendingSecret: String? = null     // normalised, 16 characters
    private var pendingDisplay: String? = null    // XXXX-XXXX-XXXX-XXXX
    private var pendingExpires = 0L
    private var tries = 0
    private var lastDialMs = 0L

    fun isRunning() = server != null

    fun isPaired(c: Context) = LinkKeyStore.isSaved(c)

    fun enabled(c: Context) = prefs(c).getBoolean(KEY_ENABLED, false)

    private fun prefs(c: Context) = c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Turns the link on: starts listening and issues a pairing secret. Throws if the port is unavailable. */
    @Synchronized
    fun start(c: Context): String {
        bindLocked(c.applicationContext)
        prefs(c).edit().putBoolean(KEY_ENABLED, true).apply()
        return newPairingCode()
    }

    /** Called when the monitor service starts: resumes listening if the link was on before. */
    @Synchronized
    fun listen(c: Context) {
        if (!enabled(c)) return
        try {
            bindLocked(c.applicationContext)
        } catch (e: Exception) {
            EventLog.add("LINK_RESUME_FAILED", null, "${e.javaClass.simpleName}: ${e.message?.take(80)}")
        }
    }

    @Synchronized
    fun stop(c: Context) {
        prefs(c).edit().putBoolean(KEY_ENABLED, false).apply()
        val s = server ?: return   // already stopped: nothing to close or log
        s.close()
        server = null
        pendingSecret = null
        pendingDisplay = null
        EventLog.add("LINK_STOPPED")
    }

    private fun bindLocked(ctx: Context) {
        if (server != null) return
        val s = ServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(PORT))
        server = s
        Thread({ acceptLoop(s, ctx) }, "vca-link").start()
        EventLog.add("LINK_STARTED", null, "port $PORT")
    }

    @Synchronized
    fun newPairingCode(): String {
        val display = LinkCrypto.newSecret()
        pendingSecret = LinkCrypto.normalizeSecret(display)
        pendingDisplay = display
        pendingExpires = System.currentTimeMillis() + CODE_TTL_MS
        tries = 0
        EventLog.add("LINK_PAIR_CODE", null, "new pairing code issued, valid 2 min")   // the code is never logged
        return display
    }

    /** The pairing code that can still be used, or null. */
    @Synchronized
    fun activeCode(): String? =
        if (pendingSecret != null && System.currentTimeMillis() <= pendingExpires && tries < MAX_TRIES) pendingDisplay else null

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
        val nonce = j.optString("nonce")
        val proof = j.optString("proof")

        val result: String = synchronized(this) {
            val secret = pendingSecret
            when {
                secret == null -> "code expired"
                System.currentTimeMillis() > pendingExpires -> "code expired"
                tries >= MAX_TRIES -> "too many attempts"
                nonce.length !in 16..64 || proof.isEmpty() -> "bad request"
                else -> {
                    tries++
                    val given = try { LinkCrypto.unb64(proof) } catch (e: Exception) { ByteArray(0) }
                    if (!MessageDigest.isEqual(LinkCrypto.proof(secret, nonce), given)) {
                        if (tries >= MAX_TRIES) pendingSecret = null   // locked: a new code is needed
                        "wrong code"
                    } else {
                        val existed = LinkKeyStore.isSaved(ctx)
                        LinkKeyStore.save(ctx, LinkCrypto.encKey(LinkCrypto.pairingKey(secret, nonce)))
                        pendingSecret = null
                        pendingDisplay = null
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
        val key = LinkKeyStore.load(ctx) ?: return reply.send(401, JSON, errJson("not paired"))

        val ts = headers["x-vca-ts"]?.toLongOrNull()
        val nonce = headers["x-vca-nonce"] ?: ""
        if (ts == null || Math.abs(System.currentTimeMillis() - ts) > SKEW_MS) {
            return reply.send(401, JSON, errJson("stale or missing timestamp"))
        }
        if (nonce.length !in 16..64) return reply.send(401, JSON, errJson("bad nonce"))

        val aad = "POST\n/api\n$ts\n$nonce"
        val plain = LinkCrypto.open(key, body, aad) ?: return reply.send(401, JSON, errJson("authentication failed"))

        // Replay check only after the message authenticates, so forged requests cannot fill the cache.
        val now = System.currentTimeMillis()
        seenNonces.values.removeIf { now - it > 2 * SKEW_MS }
        if (seenNonces.putIfAbsent(nonce, ts) != null) return reply.send(401, JSON, errJson("replayed request"))

        val req = (try { JSONObject(String(plain, Charsets.UTF_8)) } catch (e: Exception) { null })
            ?: return reply.send(400, JSON, errJson("bad request"))

        val answer: JSONObject = try {
            onMain { route(req, ctx) }
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", "phone error: ${e.javaClass.simpleName}")
        }
        reply.send(200, "text/plain", LinkCrypto.seal(key, answer.toString().toByteArray(Charsets.UTF_8), "RESP\n$nonce"))
    }

    private fun route(req: JSONObject, ctx: Context): JSONObject = when (req.optString("op")) {
        "ping" -> JSONObject().put("ok", true).put("op", "ping").put("phoneTime", EventLog.nowIso())
        "dial" -> dial(req.optString("number"), ctx)
        "hangup" -> hangup(ctx)
        "status" -> status(req.optString("session"))
        "result" -> result(req.optString("session"), ctx)
        "events" -> {
            val after = req.optLong("after", 0L)
            val arr = JSONArray()
            EventLog.snapshot().filter { it.seq > after }.takeLast(200).forEach { arr.put(it.toJson()) }
            JSONObject().put("ok", true).put("events", arr)
        }
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
        showDialNotification(ctx, number)
        return JSONObject().put("ok", true).put("session", session.id).put("dialWallMs", session.dialWallMs)
    }

    private fun hangup(ctx: Context): JSONObject {
        val s = Sessions.current?.takeIf { it.open }
        val error = Dialer.end(ctx)
        EventLog.add(if (error == null) "HANGUP_SENT" else "HANGUP_FAILED", s?.id, error ?: "from laptop")
        return JSONObject().put("ok", error == null).put("error", error ?: "")
    }

    private fun status(id: String): JSONObject {
        val s = Sessions.find(id) ?: return JSONObject().put("ok", true).put("found", false)
        return JSONObject().put("ok", true).put("found", true).put("phase", s.phase.name)
            .put("dialWallMs", s.dialWallMs).put("offhookWallMs", s.offhookWallMs)
            .put("endWallMs", s.endWallMs).put("nowWallMs", System.currentTimeMillis())
    }

    private fun result(id: String, ctx: Context): JSONObject {
        val s = Sessions.find(id) ?: return JSONObject().put("ok", false).put("error", "unknown session")
        val base = JSONObject().put("ok", true).put("phase", s.phase.name)
            .put("dialWallMs", s.dialWallMs).put("offhookWallMs", s.offhookWallMs).put("endWallMs", s.endWallMs)
        if (s.phase == Sessions.Phase.FAILED) return base.put("failed", true).put("pending", false)
        if (s.phase != Sessions.Phase.ENDED) return base.put("pending", true).put("reason", "call still in progress")
        if (!Dialer.has(ctx, android.Manifest.permission.READ_CALL_LOG)) {
            return base.put("pending", false).put("connectedSeconds", JSONObject.NULL)
                .put("answered", JSONObject.NULL).put("reason", "READ_CALL_LOG not granted on the phone")
        }
        val hit = CallLogProbe.lookup(ctx, s) ?: return base.put("pending", true).put("reason", "call log not updated yet")
        return base.put("pending", false).put("connectedSeconds", hit.connectedSeconds)
            .put("answered", hit.connectedSeconds > 0).put("logStartMs", hit.logStartMs)
    }

    private fun showDialNotification(ctx: Context, number: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (!nm.areNotificationsEnabled()) {
            EventLog.add("LINK_NOTIFY_SKIPPED", null, "notifications are off for Vector Companion")
            return
        }
        nm.createNotificationChannel(NotificationChannel(NOTIFY_CHANNEL, "Calls from the laptop", NotificationManager.IMPORTANCE_DEFAULT))
        val note: Notification = Notification.Builder(ctx, NOTIFY_CHANNEL)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle("Calling from your laptop")
            .setContentText("Vector is calling ${Phone.mask(number)}")
            .setAutoCancel(true)
            .build()
        nm.notify(NOTIFY_ID, note)
    }

    /** Runs a block on the main thread, where EventLog and Sessions are safe to touch. */
    private fun <T> onMain(block: () -> T): T {
        val task = FutureTask(Callable { block() })
        main.post(task)
        return task.get(5, TimeUnit.SECONDS)
    }
}
