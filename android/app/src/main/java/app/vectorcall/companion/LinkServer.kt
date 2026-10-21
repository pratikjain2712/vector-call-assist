package app.vectorcall.companion

import app.vectorcall.companion.BuildConfig
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
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
 * Small HTTPS server on the phone for the Vector website. Self-signed certificate (LinkTls), so the
 * website, served from GitHub Pages over HTTPS, can call it. Request bodies are also encrypted (LinkCrypto).
 * It keeps running with the monitor service, so it survives the screen being off or a reboot.
 *
 *   GET  /      plain-text page; the browser opens it once to accept the certificate
 *   POST /pair  {"nonce":"<b64>","proof":"<b64>"}     one pairing secret, valid 2 minutes, 5 tries
 *   POST /api   encrypted:
 *       {"op":"ping"}
 *       {"op":"dial","number":"+91…"}                 same rules as the Call button; shows a notification
 *       {"op":"hangup"}                               ends the current call
 *       {"op":"status","session":"<id>"}              phase and wall-clock times, for a live timer
 *       {"op":"result","session":"<id>"}              connected time from the call log, when available
 *       {"op":"events","after":N}                     event log entries with seq > N
 *       {"op":"remind","at":<epoch ms>,"text":"…"}    a notification at that time; text up to 60 characters
 *
 * LIMITS STILL OPEN (see docs/phase3-spike.md): the server runs only while the monitor service runs,
 * and the call-log result needs READ_CALL_LOG, which is opt-in.
 */
object LinkServer {
    const val PORT = 8765

    // Origins allowed to call the phone. Release builds allow only the published site. The laptop test copy
    // (http://localhost:8000, plain http from a secure localhost origin) is allowed in debug builds only.
    private val ALLOWED_ORIGINS: Set<String> = buildSet {
        add("https://pratikjain2712.github.io")
        if (BuildConfig.DEBUG) {
            add("http://localhost:8000")
            add("http://127.0.0.1:8000")
        }
    }

    private const val PREFS = "vector_link"
    private const val KEY_ENABLED = "link_enabled"
    private const val CODE_TTL_MS = 120_000L
    private const val MAX_TRIES = 5
    private const val SKEW_MS = 60_000L
    private const val DIAL_GAP_MS = 5_000L
    private const val MAX_BODY = 16_384
    private const val MAX_REQUEST_LINE = 1_024   // "POST /api HTTP/1.1" needs about 20 bytes
    private const val MAX_HEADER_COUNT = 50
    private const val MAX_HEADER_BYTES = 8_192   // all header lines together, and each line on its own
    private const val JSON = "application/json"
    private const val NOTIFY_CHANNEL = "vector_link_calls"
    private const val NOTIFY_ID = 4201
    private const val MOVED_NOTIFY_ID = 4202

    @Volatile private var server: ServerSocket? = null
    @Volatile private var host: String? = null     // the Wi-Fi address the certificate names
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private val wifiLocks = mutableListOf<WifiManager.WifiLock>()   // held while the link listens, so Wi-Fi power saving does not drop requests
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
        watchNetworkLocked(c.applicationContext)
        prefs(c).edit().putBoolean(KEY_ENABLED, true).apply()
        return newPairingCode()
    }

    /** Called when the monitor service starts: resumes listening if the link was on before. */
    @Synchronized
    fun listen(c: Context) {
        if (!enabled(c)) return
        // Registered first, so a phone that boots before Wi-Fi connects still starts the link when it does.
        watchNetworkLocked(c.applicationContext)
        try {
            bindLocked(c.applicationContext)
        } catch (e: Exception) {
            EventLog.add("LINK_RESUME_FAILED", null, "${e.javaClass.simpleName}: ${e.message?.take(80)}")
        }
    }

    @Synchronized
    fun stop(c: Context) {
        prefs(c).edit().putBoolean(KEY_ENABLED, false).apply()
        unwatchNetworkLocked(c.applicationContext)
        val s = server ?: return   // already stopped: nothing to close or log
        s.close()
        server = null
        releaseWifiLockLocked()
        pendingSecret = null
        pendingDisplay = null
        EventLog.add("LINK_STOPPED")
    }

    private fun bindLocked(ctx: Context) {
        if (server != null) return
        val ip = lanAddresses().firstOrNull() ?: throw IllegalStateException("no Wi-Fi address")
        val tls = LinkTls.contextFor(ctx, ip)
        val s = tls.serverSocketFactory.createServerSocket()
        s.reuseAddress = true
        s.bind(InetSocketAddress(PORT))
        server = s
        host = ip
        holdWifiLockLocked(ctx)
        Thread({ acceptLoop(s, ctx) }, "vca-link").start()
        EventLog.add("LINK_STARTED", null, "https port $PORT")
    }

    /**
     * What the phone's screen shows as a QR code: where to reach the phone and the pairing code.
     * Turns the link on if it is off, and issues a new code if none is active.
     */
    @Synchronized
    fun pairingQrPayload(c: Context): String {
        turnOn(c)
        val code = activeCode() ?: newPairingCode()
        return JSONObject().put("vca", 2).put("host", host).put("port", PORT).put("code", code).toString()
    }

    /** Turns the link on without issuing a pairing code. Throws if there is no Wi-Fi address. */
    @Synchronized
    fun turnOn(c: Context) {
        prefs(c).edit().putBoolean(KEY_ENABLED, true).apply()
        watchNetworkLocked(c.applicationContext)
        refreshAddressLocked(c.applicationContext, force = true)   // starts the link, or moves it to the current address
        if (server == null) bindLocked(c.applicationContext)        // still off: throws "no Wi-Fi address"
    }

    /** When the active pairing code stops working (ms since epoch), or 0 when there is none. */
    @Synchronized
    fun codeExpiresAt(): Long = if (activeCode() != null) pendingExpires else 0L

    /** Time of the last successful pairing in this run, so the phone screen can switch to "connected". */
    @Volatile var lastPairedAt = 0L
        private set

    /** Time of the last request from the laptop that passed its checks (0 until one does). Shown on the phone screen. */
    @Volatile var lastHeardAt = 0L
        private set

    /** Forgets the last-heard time. Called when the laptop is forgotten or a different laptop is about to be paired. */
    @Synchronized
    fun clearLastHeard() {
        lastHeardAt = 0L
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

    /**
     * The phone's local-network addresses, Wi-Fi first. Mobile data (rmnet, ccmni, CGNAT 100.x), VPN and
     * tunnel addresses are left out: the laptop cannot reach them. The phone's own hotspot is kept.
     */
    fun lanAddresses(): List<String> = try {
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .filter { nif -> nif.isUp && !nif.isLoopback && !nif.isVirtual && NOT_LAN.none { nif.name.startsWith(it) } }
            .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
            .flatMap { Collections.list(it.inetAddresses) }
            .filterIsInstance<Inet4Address>()
            .filter { it.isSiteLocalAddress }
            .mapNotNull { it.hostAddress }
            .distinct()
    } catch (e: Exception) {
        emptyList()
    }

    private val NOT_LAN = listOf("rmnet", "ccmni", "v4-", "clat", "tun", "ppp", "ipsec", "dummy")

    /** The address and port the laptop should use, or null while the link is off. */
    fun address(): String? = host?.takeIf { server != null }?.let { "$it:$PORT" }

    /**
     * Follows the Wi-Fi: starts the link once Wi-Fi is up, and restarts it with a certificate for the new
     * address if the router gave the phone a different one. The laptop then needs to pair again.
     */
    @Synchronized
    fun refreshAddress(c: Context) = refreshAddressLocked(c.applicationContext, force = false)

    private fun refreshAddressLocked(ctx: Context, force: Boolean) {
        if (!enabled(ctx) && !force) return
        val ip = lanAddresses().firstOrNull() ?: return
        if (server != null && ip == host) return
        val moved = server != null
        server?.close()
        server = null
        try {
            bindLocked(ctx)
            if (moved) {
                EventLog.add("LINK_ADDRESS_CHANGED", null, "now $ip:$PORT, laptop must pair again")
                if (isPaired(ctx)) showMovedNotification(ctx, "$ip:$PORT")
            }
        } catch (e: Exception) {
            EventLog.add("LINK_RESUME_FAILED", null, "${e.javaClass.simpleName}: ${e.message?.take(80)}")
        }
    }

    private fun watchNetworkLocked(ctx: Context) {
        if (netCallback != null) return
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            // The address can lag the "available" event slightly, so look again a moment later.
            override fun onAvailable(network: Network) { main.postDelayed({ refreshAddress(ctx) }, 1_500) }
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) { main.post { refreshAddress(ctx) } }
            // The Wi-Fi went away: log the fact only; the call's end reason still comes from the phone (see Sessions.onLinkLost).
            override fun onLost(network: Network) { main.post { Sessions.onLinkLost() } }
        }
        try {
            cm.registerNetworkCallback(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), cb)
            netCallback = cb
        } catch (e: Exception) {
            EventLog.add("LINK_WATCH_FAILED", null, e.javaClass.simpleName)
        }
    }

    private fun unwatchNetworkLocked(ctx: Context) {
        val cb = netCallback ?: return
        netCallback = null
        try { ctx.getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } catch (e: Exception) {}
    }

    // ---- HTTP plumbing -------------------------------------------------------------------

    private class Reply(private val out: OutputStream, private val origin: String?) {
        fun send(status: Int, type: String?, body: String) {
            val bytes = body.toByteArray(Charsets.UTF_8)
            val reason = when (status) {
                200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"; 401 -> "Unauthorized"
                403 -> "Forbidden"; 404 -> "Not Found"; 413 -> "Payload Too Large"; 431 -> "Request Header Fields Too Large"; else -> "Error"
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

    /** A request line or header that is longer or more numerous than allowed; [status] is the reply. */
    private class TooLarge(val status: Int) : Exception()

    /** One line without its CRLF, at most [max] bytes. Null at end of stream. */
    private fun readLine(inp: InputStream, max: Int, status: Int): String? {
        val line = ByteArrayOutputStream()
        while (true) {
            val b = inp.read()
            if (b < 0) return if (line.size() == 0) null else String(line.toByteArray(), Charsets.UTF_8)
            if (b == '\n'.code) break
            if (b == '\r'.code) continue
            if (line.size() >= max) throw TooLarge(status)
            line.write(b)
        }
        return String(line.toByteArray(), Charsets.UTF_8)
    }

    private fun serve(inp: InputStream, out: OutputStream, ctx: Context) {
        // Byte-level reads with limits, so a client cannot make the phone buffer an unbounded line.
        val input = BufferedInputStream(inp)
        val headers = HashMap<String, String>()
        val requestLine: String = try {
            readLine(input, MAX_REQUEST_LINE, 400) ?: return
        } catch (e: TooLarge) {
            return Reply(out, null).send(400, "text/plain", "request line too long")
        }
        try {
            var count = 0
            var bytes = 0
            while (true) {
                val line = readLine(input, MAX_HEADER_BYTES, 431) ?: break
                if (line.isEmpty()) break
                bytes += line.toByteArray(Charsets.UTF_8).size + 2
                if (++count > MAX_HEADER_COUNT || bytes > MAX_HEADER_BYTES) throw TooLarge(431)
                val i = line.indexOf(':')
                if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
            }
        } catch (e: TooLarge) {
            return Reply(out, null).send(e.status, "text/plain", "request headers too large")
        }
        val parts = requestLine.split(' ')
        val origin = headers["origin"]?.takeIf { it in ALLOWED_ORIGINS }
        val reply = Reply(out, origin)
        if (parts.size < 2) return reply.send(400, "text/plain", "bad request")
        val method = parts[0]
        val path = parts[1].substringBefore('?')

        // Opened once in the browser so it accepts the phone's certificate; the website asks for this.
        if (method == "GET" && path == "/") {
            return reply.send(200, "text/plain; charset=utf-8",
                "Vector link: certificate accepted. Go back to the Vector page and tap Scan pairing QR.")
        }
        if (method == "OPTIONS") return reply.send(204, null, "")
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        if (len < 0 || len > MAX_BODY) return reply.send(413, JSON, errJson("body too large"))
        val buf = ByteArray(len)
        var read = 0
        while (read < len) {
            val n = input.read(buf, read, len - read)
            if (n < 0) break
            read += n
        }
        val body = String(buf, 0, read, Charsets.UTF_8)

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
                        lastPairedAt = System.currentTimeMillis()
                        lastHeardAt = lastPairedAt
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
        lastHeardAt = now

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
        "remind" -> Reminders.schedule(ctx, req)
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
            .put("endWallMs", s.endWallMs).put("nowWallMs", System.currentTimeMillis()).put("endReason", s.endReason ?: JSONObject.NULL)
    }

    private fun result(id: String, ctx: Context): JSONObject {
        val s = Sessions.find(id) ?: return JSONObject().put("ok", false).put("error", "unknown session")
        val base = JSONObject().put("ok", true).put("phase", s.phase.name).put("endReason", s.endReason ?: JSONObject.NULL)
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

    /**
     * Without this, many phones put the Wi-Fi into power saving after the screen goes off, and the laptop's
     * requests time out ("Phone offline"). Two locks: low-latency mode while the screen is on, and the older
     * high-performance mode, which some Android versions still honour with the screen off. Newer versions
     * may ignore it; the foreground service and "Battery unrestricted" then matter most.
     */
    @Suppress("DEPRECATION")   // WIFI_MODE_FULL_HIGH_PERF
    private fun holdWifiLockLocked(ctx: Context) {
        if (wifiLocks.isNotEmpty()) return
        val wm = ctx.getSystemService(WifiManager::class.java) ?: return
        for (mode in listOf(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, WifiManager.WIFI_MODE_FULL_HIGH_PERF)) {
            try {
                val lock = wm.createWifiLock(mode, "vector:link")
                lock.setReferenceCounted(false)
                lock.acquire()
                wifiLocks += lock
            } catch (e: Exception) {
                EventLog.add("LINK_WIFI_LOCK_FAILED", null, "mode $mode: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun releaseWifiLockLocked() {
        for (lock in wifiLocks) try { if (lock.isHeld) lock.release() } catch (e: Exception) {}
        wifiLocks.clear()
    }

    /** The router gave the phone a new address: the laptop cannot reach it until it scans the pairing QR again. */
    private fun showMovedNotification(ctx: Context, address: String) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (!nm.areNotificationsEnabled()) return
        nm.createNotificationChannel(NotificationChannel(NOTIFY_CHANNEL, "Calls from the laptop", NotificationManager.IMPORTANCE_DEFAULT))
        val open = android.app.PendingIntent.getActivity(ctx, 0, android.content.Intent(ctx, MainActivity::class.java),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
        val note: Notification = Notification.Builder(ctx, NOTIFY_CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Phone address changed")
            .setContentText("Now $address. On the laptop, tap Pair again and scan the QR here.")
            .setStyle(Notification.BigTextStyle().bigText("The Wi-Fi router gave this phone a new address ($address), so the laptop can no longer reach it. On the laptop, tap Pair again and scan the QR shown here. To stop this happening, reserve a fixed address for this phone in the router settings."))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(MOVED_NOTIFY_ID, note)
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
