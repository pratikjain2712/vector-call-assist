/* Vector link: pairs this browser with the Vector Companion app on the phone and sends encrypted
   requests over HTTPS on the Wi-Fi. Must match android/.../LinkCrypto.kt and LinkServer.kt (protocol v2). */
(function () {
  const STORE = 'vca2-link';
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const DEFAULT_PORT = 8765;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  const cleanHost = (v) => String(v || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const validHost = (h) => /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/.test(h);

  function load() { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) {} }

  /* Accepts dashes, spaces, lower case, and I/L as 1, O as 0, as the phone does. */
  function normalizeSecret(input) {
    const s = String(input || '').toUpperCase().replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0').replace(/[^0-9A-Z]/g, '');
    return s.length === 16 && [...s].every((c) => ALPHA.includes(c)) ? s : null;
  }

  async function hmac(keyBytes, msgBytes) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
  }

  async function derive(secret, nonce) {
    const k = enc.encode(secret);
    const proof = await hmac(k, enc.encode('vca-proof-v2|' + nonce));
    const pairingKey = await hmac(k, enc.encode('vca-pair-v2|' + nonce));
    const encKey = await hmac(pairingKey, enc.encode('vca-enc-v1'));
    return { proof, encKey };
  }

  /* The phone's QR code holds JSON: {"vca":2,"host":"192.168.1.42","port":8765,"code":"XXXX-XXXX-XXXX-XXXX"}.
     Returns { host: "ip:port", code } or null when the text is not a Vector pairing code. */
  function parseQr(text) {
    let j;
    try { j = JSON.parse(String(text || '')); } catch (e) { return null; }
    if (!j || j.vca !== 2 || typeof j.host !== 'string') return null;
    const port = Number(j.port) || DEFAULT_PORT;
    const host = cleanHost(j.host) + ':' + port;
    if (!validHost(host) || !normalizeSecret(j.code)) return null;
    return { host, code: j.code };
  }

  /* Browser could not reach the phone over HTTPS. Most often the certificate has not been accepted yet. */
  function unreachable(host) {
    const e = new Error('Could not reach the phone at ' + host + '. Open https://' + host + '/ in this browser, accept the certificate warning once, then try again.');
    e.unreachable = true;
    e.host = host;
    return e;
  }

  /* Pair with the phone. Throws an Error with a message a person can read. */
  async function pair(hostInput, codeInput) {
    const host = cleanHost(hostInput);
    if (!validHost(host.includes(':') ? host : host + ':' + DEFAULT_PORT)) {
      throw new Error('Enter the phone address shown in the app, for example 192.168.1.20:8765.');
    }
    const hostPort = host.includes(':') ? host : host + ':' + DEFAULT_PORT;
    const secret = normalizeSecret(codeInput);
    if (!secret) throw new Error('The pairing code has 16 letters and digits, shown as XXXX-XXXX-XXXX-XXXX.');
    const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
    const { proof, encKey } = await derive(secret, nonce);
    let res;
    try {
      res = await fetch('https://' + hostPort + '/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce, proof: b64(proof) }),
      });
    } catch (e) { throw unreachable(hostPort); }
    const j = await res.json().catch(() => ({ ok: false, error: 'unexpected reply (HTTP ' + res.status + ')' }));
    if (!j.ok) throw new Error(j.error || 'pairing refused');
    save({ host: hostPort, ek: b64(encKey), lastSeq: 0 });
    return hostPort;
  }

  /* One encrypted request. op: ping | dial | hangup | status | result | events. */
  async function request(op, extra) {
    const st = load();
    if (!st) throw new Error('This browser is not paired with the phone yet.');
    const key = await crypto.subtle.importKey('raw', unb64(st.ek), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const path = '/api';
    const ts = String(Date.now());
    const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = enc.encode('POST\n' + path + '\n' + ts + '\n' + nonce);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad }, key, enc.encode(JSON.stringify(Object.assign({ op }, extra || {})))));

    let res;
    try {
      res = await fetch('https://' + st.host + path, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Vca-Ts': ts, 'X-Vca-Nonce': nonce },
        body: b64(concat(iv, ct)),
      });
    } catch (e) { throw unreachable(st.host); }

    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error || text; } catch (e) {}
      const err = new Error(msg || ('phone said HTTP ' + res.status));
      err.status = res.status;
      // The phone has no key for this browser, or a different one: it was forgotten there or another browser paired.
      if (res.status === 401 && (msg === 'not paired' || msg === 'authentication failed')) err.unpaired = true;
      if (msg === 'stale or missing timestamp') err.clock = true;
      throw err;
    }
    const raw = unb64(text);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode('RESP\n' + nonce) }, key, raw.slice(12));
    return JSON.parse(dec.decode(plain));
  }

  /* Dialling format, the same rules as the phone: a bare 10-digit Indian mobile, 0 + 10 digits,
     or a number with +country code. Returns E.164 or null. */
  function toE164(raw) {
    const trimmed = String(raw || '').trim();
    const digits = trimmed.replace(/\D/g, '');
    let out = null;
    if (trimmed.startsWith('+')) out = '+' + digits;
    else if (digits.length === 10) out = '+91' + digits;
    else if (digits.length === 11 && digits.startsWith('0')) out = '+91' + digits.slice(1);
    else if (digits.length === 12 && digits.startsWith('91')) out = '+' + digits;
    return out && /^\+[1-9]\d{7,14}$/.test(out) ? out : null;
  }

  window.PhoneLink = {
    isPaired: () => !!load(),
    host: () => (load() || {}).host || '',
    certUrl: (host) => 'https://' + host + '/',
    pair,
    parseQr,
    request,
    forget: () => { try { localStorage.removeItem(STORE); } catch (e) {} },
    normalizeSecret,
    toE164,
  };
})();
