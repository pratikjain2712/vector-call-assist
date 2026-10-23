// Shared WhatsApp code for the whatsapp-* Edge Functions (Meta WhatsApp Cloud API).
// Plain JavaScript with no imports, so the same file runs in Deno (deployed) and in Node (tests/web,
// with fetch mocked). Only Web APIs are used: fetch, crypto.subtle, TextEncoder, btoa/atob.
//
// What is here: Graph API calls (send a template, submit a template, check a number), template filling
// (with amounts masked for the message log), STOP detection (English, Hindi, Hinglish), token encryption
// (AES-256-GCM with the server secret WHATSAPP_TOKEN_KEY), webhook signature checks, and the small HTTP
// helpers the functions share. Nothing here prints a token or a secret.

export const GRAPH_VERSION = 'v23.0';

// Meta India rates (June 2026, before GST), ₹ per message. Same values as wa_rate() in the migration.
export const RATES = Object.freeze({ utility: 0.115, marketing: 0.86 });

// What can fill a {{n}} blank of a template. Same list as the whatsapp_templates check in the migration.
export const PARAM_SOURCES = Object.freeze([
  'lead_name', 'amount_due', 'promised_amount', 'promised_date', 'institute_name', 'caller_name', 'typed',
]);
const MONEY_SOURCES = ['amount_due', 'promised_amount'];
export const MASK = '₹…';

// ---------- HTTP helpers ----------

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// An error from one of our database functions (raised with errcode 42501 or 22023 and plain-English text,
// safe to show) or anything else (logged, answered with a generic message).
export function dbFailure(err, where) {
  const code = (err && err.code) || '';
  const text = sentence((err && err.message) || '');
  if (code === '42501') return reply(403, { error: text || 'You are not allowed to do that.' });
  if (code === '22023' || code === 'P0001') return reply(400, { error: text || 'Not done.' });
  console.error((where || 'whatsapp') + ' database error', code, err && err.message);
  return reply(500, { error: 'Something went wrong. Try again.' });
}

// 'this lead is not assigned to you' to 'This lead is not assigned to you.'
export function sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const out = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(out) ? out : out + '.';
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const META_ID = /^[0-9]{5,30}$/;

export async function readJson(req) {
  try {
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

// ---------- formatting ----------

// Whole rupees with Indian grouping: 1200000 to '₹12,00,000'. Same as rupees() in web/js/admin/shared.js.
export function rupees(amount) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Math.round(Number(amount));
  if (!Number.isFinite(n)) return '';
  const digits = String(Math.abs(n));
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + '₹' + (rest ? rest + ',' + last3 : last3);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-10-25' to '25 Oct 2026'. '' for anything else.
export function dayText(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
}

// Today's date in India as 'YYYY-MM-DD'.
export function indiaToday(now) {
  const d = new Date((now ? now.getTime() : Date.now()) + 330 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// The Monday of the week of a 'YYYY-MM-DD' date.
export function mondayOf(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// '+919876500001' (how leads store numbers) to '919876500001' (how the Graph API wants them).
export function waNumber(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  return /^91[0-9]{10}$/.test(d) ? d : '';
}

// ---------- templates ----------

// Meta refuses a parameter with a new line, a tab or more than 4 spaces in a row.
export function cleanParam(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// The number of {{n}} blanks when they are {{1}} … {{n}} with no gap; -1 otherwise. Same rule as wa_body_params().
export function countBlanks(body) {
  const s = String(body || '');
  if (/\{\{(?![0-9]{1,2}\}\})/.test(s)) return -1;
  const nums = [...new Set([...s.matchAll(/\{\{([0-9]{1,2})\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  if (!nums.length) return 0;
  return nums[0] === 1 && nums[nums.length - 1] === nums.length ? nums.length : -1;
}

// Puts params[0] in {{1}}, params[1] in {{2}} …
export function render(body, params) {
  return String(body || '').replace(/\{\{([0-9]{1,2})\}\}/g, (m, n) => {
    const v = params[Number(n) - 1];
    return v === undefined ? m : v;
  });
}

// Fills the blanks of a template for one send. ctx: { lead: {name, amount_due, promised_amount, promised_date},
// institute_name, caller_name }. typed: what the caller typed, as an array ({{1}} is typed[0]) or an object
// keyed by blank number ({ "3": "Monday" }). Returns { params, masked } (masked has amounts replaced by ₹… for
// the message log) or { error } in plain English.
export function fillParams(template, ctx, typed) {
  const sources = Array.isArray(template && template.param_sources) ? template.param_sources : [];
  const lead = (ctx && ctx.lead) || {};
  const params = [];
  const masked = [];
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    let v = '';
    if (src === 'lead_name') v = lead.name;
    else if (src === 'amount_due') v = rupees(lead.amount_due);
    else if (src === 'promised_amount') v = rupees(lead.promised_amount);
    else if (src === 'promised_date') v = dayText(lead.promised_date);
    else if (src === 'institute_name') v = ctx && ctx.institute_name;
    else if (src === 'caller_name') v = ctx && ctx.caller_name;
    else if (src === 'typed') {
      const raw = Array.isArray(typed) ? typed[i] : (typed && typeof typed === 'object' ? typed[String(i + 1)] : undefined);
      v = raw;
      if (typeof v === 'string' && v.length > 200) return { error: 'Blank ' + (i + 1) + ' is too long (200 characters at most).' };
      if (typeof v === 'string' && /https?:\/\/|www\./i.test(v)) return { error: 'Links cannot be typed into a message.' };
    } else {
      return { error: 'This message has an unknown blank. Ask your admin to fix the template.' };
    }
    v = cleanParam(v);
    if (!v) return { error: missingText(src, i) };
    params.push(v);
    masked.push(MONEY_SOURCES.includes(src) ? MASK : v);
  }
  return { params, masked };
}

function missingText(src, i) {
  if (src === 'amount_due') return 'This lead has no amount due, so this message cannot be sent.';
  if (src === 'promised_amount') return 'This lead has no promised amount, so this message cannot be sent.';
  if (src === 'promised_date') return 'This lead has no promised date, so this message cannot be sent.';
  if (src === 'typed') return 'Fill in blank ' + (i + 1) + ' before sending.';
  return 'Something this message needs is missing (blank ' + (i + 1) + ').';
}

// Example values Meta asks for when a template with blanks is submitted for approval.
export function exampleParams(template, displayName) {
  const ex = {
    lead_name: 'Asha', amount_due: '₹12,000', promised_amount: '₹6,000', promised_date: '25 Oct 2026',
    institute_name: displayName || 'Our Institute', caller_name: 'Priya', typed: 'Monday',
  };
  return (template.param_sources || []).map((s) => ex[s] || 'Example');
}

// The body component for a submit: text plus examples when it has blanks.
export function templateComponents(template, displayName) {
  const body = { type: 'BODY', text: template.body };
  const ex = exampleParams(template, displayName);
  if (ex.length) body.example = { body_text: [ex] };
  return [body];
}

// ---------- STOP ----------

// Whole messages that mean "stop messaging me", in English, Hinglish and Hindi (Devanagari). Compared after
// lower-casing and removing punctuation and emoji.
const STOP_PHRASES = new Set([
  'stop', 'stop all', 'stop it', 'stop please', 'please stop', 'stop messages', 'stop message', 'stop msg',
  'stop sending', 'stop messaging', 'unsubscribe', 'opt out', 'optout', 'cancel', 'end', 'quit',
  'no more messages', 'dont message', 'do not message', 'dont send', 'do not send',
  'band karo', 'band kro', 'band kar do', 'band kardo', 'bandh karo', 'bandh kar do', 'band karein', 'band kijiye',
  'mat bhejo', 'mat bhejna', 'message mat bhejo', 'msg mat bhejo', 'messages mat bhejo', 'sms mat bhejo',
  'message band karo', 'messages band karo', 'msg band karo', 'whatsapp band karo', 'whatsapp mat bhejo',
  'mujhe message mat bhejo', 'mujhe mat bhejo', 'nahi chahiye', 'mat karo message',
  'बंद करो', 'बंद', 'बंद कर दो', 'बंद करें', 'रोको', 'रोक दो', 'मत भेजो', 'मैसेज मत भेजो', 'मैसेज बंद करो',
  'मुझे मैसेज मत भेजो', 'स्टॉप',
]);
// Words that mean stop inside a short message ("pls stop", "STOP!!", "ab band karo bhai").
const STOP_WORD = /(^| )(stop|unsubscribe|स्टॉप)( |$)/;
const STOP_HINDI = /(^| )(band karo|band kro|band kar do|bandh karo|mat bhejo|बंद करो|मत भेजो)( |$)/;

export function normaliseReply(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// True when a reply asks us to stop. Long messages that only mention "stop" in passing do not count.
export function isStopMessage(text) {
  const t = normaliseReply(text);
  if (!t) return false;
  if (STOP_PHRASES.has(t)) return true;
  const words = t.split(' ').length;
  if (words <= 4 && STOP_WORD.test(t)) return true;
  if (words <= 6 && STOP_HINDI.test(t)) return true;
  return false;
}

// ---------- token encryption (AES-256-GCM) ----------

const b64 = (bytes) => { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(keyB64) {
  let raw;
  try { raw = unb64(String(keyB64 || '')); } catch (e) { raw = new Uint8Array(0); }
  if (raw.length !== 32) throw new Error('WHATSAPP_TOKEN_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// 'v1:<iv>:<ciphertext>' (base64). The plain token is never stored.
export async function encryptToken(plain, keyB64) {
  const key = await aesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  return 'v1:' + b64(iv) + ':' + b64(ct);
}

export async function decryptToken(cipher, keyB64) {
  const m = /^v1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(String(cipher || ''));
  if (!m) throw new Error('stored token is not readable');
  const key = await aesKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m[1]) }, key, unb64(m[2]));
  return new TextDecoder().decode(pt);
}

// The token for an account: the institute's own (decrypted) or our platform token.
export async function tokenFor(ctx, env) {
  const source = ctx && ctx.account && ctx.account.token_source;
  if (source === 'platform') {
    if (!env.WHATSAPP_PLATFORM_TOKEN) throw new Error('WHATSAPP_PLATFORM_TOKEN is not set');
    return env.WHATSAPP_PLATFORM_TOKEN;
  }
  if (!ctx || !ctx.token_cipher) throw new Error('no stored token for this institute');
  return decryptToken(ctx.token_cipher, env.WHATSAPP_TOKEN_KEY);
}

// ---------- signatures and secrets ----------

const hexToBytes = (hex) => {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

// Checks X-Hub-Signature-256 ('sha256=<hex HMAC of the raw body with the app secret>'). crypto.subtle.verify
// compares in constant time.
export async function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const sig = hexToBytes(header.slice(7));
  if (!sig || sig.length !== 32) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const body = typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody;
  return crypto.subtle.verify('HMAC', key, sig, body);
}

// Constant-time comparison of two strings (verify token, cron secret).
export function sameSecret(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  if (!x.length || !y.length) return false;
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i % x.length] ^ y[i % y.length]);
  return diff === 0;
}

// ---------- Graph API ----------

function graphBase(env) {
  const v = (env && env.WHATSAPP_GRAPH_VERSION) || GRAPH_VERSION;
  return 'https://graph.facebook.com/' + v;
}

// One Graph API call. Returns { ok, status, data } or { ok: false, error, code, tokenProblem }.
// tokenProblem is true when Meta says the token is wrong or expired (OAuthException code 190, or 401).
export async function graph(deps, method, path, token, body) {
  const url = graphBase(deps.env) + path;
  let res;
  try {
    res = await deps.fetch(url, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: 'Could not reach WhatsApp. Try again.', code: 0, tokenProblem: false };
  }
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (res.ok && !(data && data.error)) return { ok: true, status: res.status, data };
  const e = (data && data.error) || {};
  const code = Number(e.code) || 0;
  return {
    ok: false,
    status: res.status,
    code,
    tokenProblem: code === 190 || res.status === 401,
    error: metaErrorText(e, res.status),
  };
}

// Meta's error as a short sentence for the admin or caller. Common codes get plain words.
export function metaErrorText(e, status) {
  const code = Number(e && e.code) || 0;
  if (code === 190 || status === 401) return 'WhatsApp did not accept the access token. An owner must connect again.';
  if (code === 131026) return 'This number is not on WhatsApp.';
  if (code === 131047) return 'More than 24 hours since their last reply: only approved templates can be sent.';
  if (code === 132001) return 'WhatsApp does not have this template in this language. Check its approval.';
  if (code === 132000) return 'The number of blanks does not match the approved template.';
  if (code === 131056 || code === 130429 || code === 80007) return 'Too many messages right now. Try again in a minute.';
  if (code === 100 && e && /phone/i.test(String(e.message || ''))) return 'WhatsApp did not find this phone number ID.';
  const msg = String((e && (e.error_user_msg || e.message)) || '').slice(0, 200);
  return msg ? 'WhatsApp said: ' + msg : 'WhatsApp refused the request (' + (status || 'no answer') + ').';
}

// Sends an approved template. to: '91…' digits. Returns { ok, id } or the graph() failure.
export async function sendTemplate(deps, token, phoneNumberId, to, template, params) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template.meta_name,
      language: { code: template.language || 'en' },
      components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : [],
    },
  };
  const r = await graph(deps, 'POST', '/' + phoneNumberId + '/messages', token, payload);
  if (!r.ok) return r;
  const id = r.data && Array.isArray(r.data.messages) && r.data.messages[0] && r.data.messages[0].id;
  return id ? { ok: true, id: String(id) } : { ok: false, error: 'WhatsApp did not return a message id.', code: 0, tokenProblem: false };
}

// Fills, sends and logs one claimed message (from wa_prepare_send, wa_claim_reminders or wa_claim_briefs).
// deps: { env, fetch, rpc }. Optional opts: { typed, to, maskedBody, tokenCache }.
// Returns { ok, message_id, meta_id } or { ok: false, error, status }.
export async function sendClaimed(deps, ctx, opts) {
  const o = opts || {};
  const fill = fillParams(ctx.template, ctx, o.typed);
  const fail = async (error, status) => {
    await deps.rpc('wa_mark_message', { p_id: ctx.message_id, p_status: 'failed', p_meta_id: null, p_body: null, p_error: error });
    return { ok: false, error, status: status || 400 };
  };
  if (fill.error) return fail(fill.error, 400);
  const to = o.to || waNumber(ctx.lead && ctx.lead.phone);
  if (!to) return fail('This number cannot get WhatsApp messages.', 400);
  let token;
  try {
    const cache = o.tokenCache;
    const key = ctx.institute_id;
    token = cache && cache.has(key) ? cache.get(key) : await tokenFor(ctx, deps.env);
    if (cache) cache.set(key, token);
  } catch (e) {
    console.error('whatsapp token problem for institute', ctx.institute_id, e && e.message);
    return fail('WhatsApp is not set up correctly on the server.', 500);
  }
  const sent = await sendTemplate(deps, token, ctx.account.phone_number_id, to, ctx.template, fill.params);
  if (!sent.ok) {
    if (sent.tokenProblem) await deps.rpc('wa_account_error', { p_institute: ctx.institute_id, p_error: sent.error });
    return fail(sent.error, 502);
  }
  const body = o.maskedBody !== undefined ? o.maskedBody : render(ctx.template.body, fill.masked);
  await deps.rpc('wa_mark_message', { p_id: ctx.message_id, p_status: 'sent', p_meta_id: sent.id, p_body: body, p_error: null });
  return { ok: true, message_id: ctx.message_id, meta_id: sent.id };
}
