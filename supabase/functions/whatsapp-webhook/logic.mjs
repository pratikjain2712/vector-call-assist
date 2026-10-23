// whatsapp-webhook: what Meta calls when a message's status changes, a person replies, or a template is
// approved or rejected. The logic lives here (tested in tests/web/whatsapp-functions.test.js); index.ts only
// wires it.
//
// GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…   Meta checks the URL once, when the webhook is
//      set up in the Meta app. Answers the challenge when the token equals WHATSAPP_VERIFY_TOKEN.
// POST Meta's JSON with "X-Hub-Signature-256: sha256=<HMAC of the raw body with WHATSAPP_APP_SECRET>".
//      A bad or missing signature is refused (401) before anything is read.
//      statuses  -> wa_status_update (sent, delivered, read, failed)
//      messages  -> wa_store_reply (stored on the lead; STOP and its Hindi / Hinglish forms turn WhatsApp
//                   consent off)
//      message_template_status_update -> wa_template_status
// Answers 200 when everything was stored, 500 when the database failed (Meta then sends it again; every step
// is safe to repeat).
import { reply, verifySignature, sameSecret, isStopMessage } from '../_shared/whatsapp.mjs';

// The text of an incoming message, whatever its type. Media is noted, never downloaded.
export function replyText(m) {
  if (!m || typeof m !== 'object') return '';
  if (m.type === 'text' && m.text) return String(m.text.body || '');
  if (m.type === 'button' && m.button) return String(m.button.text || m.button.payload || '');
  if (m.type === 'interactive' && m.interactive) {
    const r = m.interactive.button_reply || m.interactive.list_reply || {};
    return String(r.title || r.id || '');
  }
  if (m.type === 'reaction' && m.reaction) return String(m.reaction.emoji || '');
  return '[' + String(m.type || 'message').slice(0, 20) + ']';
}

const when = (ts) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};

// Meta's payload to a flat list of things to store.
export function parsePayload(payload) {
  const out = { statuses: [], replies: [], templates: [] };
  const entries = payload && Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const v = change && change.value ? change.value : {};
      if (change.field === 'messages') {
        const phoneNumberId = v.metadata && v.metadata.phone_number_id ? String(v.metadata.phone_number_id) : '';
        for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
          const err = Array.isArray(s.errors) && s.errors[0] ? s.errors[0] : null;
          out.statuses.push({
            id: String(s.id || ''), status: String(s.status || ''), at: when(s.timestamp),
            error: err ? String(err.title || err.message || err.code || 'failed').slice(0, 300) : null,
          });
        }
        for (const m of Array.isArray(v.messages) ? v.messages : []) {
          const text = replyText(m);
          out.replies.push({
            phoneNumberId, from: String(m.from || ''), id: String(m.id || ''), text: text.slice(0, 4096),
            at: when(m.timestamp), stop: isStopMessage(text),
          });
        }
      } else if (change.field === 'message_template_status_update') {
        out.templates.push({
          waba: String(entry.id || ''), name: v.message_template_name ? String(v.message_template_name) : null,
          id: v.message_template_id ? String(v.message_template_id) : null, event: String(v.event || ''),
          reason: v.reason ? String(v.reason) : null,
        });
      }
    }
  }
  return out;
}

const STATUSES = ['sent', 'delivered', 'read', 'failed'];
const TEMPLATE_EVENTS = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'FLAGGED', 'REINSTATED',
  'PENDING_DELETION', 'DELETED'];

// deps: { env, rpc(name, args) with the service role }
export async function handle(req, deps) {
  const env = deps.env || {};
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe'
      && sameSecret(url.searchParams.get('hub.verify_token'), env.WHATSAPP_VERIFY_TOKEN);
    if (!ok) return new Response('Forbidden', { status: 403 });
    return new Response(url.searchParams.get('hub.challenge') || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
  if (!env.WHATSAPP_APP_SECRET) {
    console.error('whatsapp-webhook: WHATSAPP_APP_SECRET is not set');
    return reply(500, { error: 'not configured' });
  }
  const raw = new Uint8Array(await req.arrayBuffer());
  const good = await verifySignature(raw, req.headers.get('X-Hub-Signature-256') || '', env.WHATSAPP_APP_SECRET);
  if (!good) return reply(401, { error: 'bad signature' });
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch (e) { return reply(400, { error: 'not JSON' }); }

  const work = parsePayload(payload);
  const done = { statuses: 0, replies: 0, stops: 0, templates: 0 };
  try {
    for (const s of work.statuses) {
      if (!s.id || !STATUSES.includes(s.status)) continue;
      await deps.rpc('wa_status_update', { p_meta_id: s.id, p_status: s.status, p_at: s.at, p_error: s.error });
      done.statuses++;
    }
    for (const r of work.replies) {
      if (!r.id || !r.phoneNumberId || !r.from) continue;
      const out = await deps.rpc('wa_store_reply', {
        p_phone_number_id: r.phoneNumberId, p_from: r.from, p_meta_id: r.id, p_body: r.text,
        p_is_stop: r.stop, p_at: r.at,
      });
      if (out && out.stored) done.replies++;
      if (out && out.stored && r.stop) done.stops++;
    }
    for (const t of work.templates) {
      if (!TEMPLATE_EVENTS.includes(t.event.toUpperCase())) continue;
      await deps.rpc('wa_template_status', {
        p_template: null, p_waba_id: t.waba, p_meta_name: t.name, p_meta_template_id: t.id,
        p_status: t.event, p_reason: t.reason,
      });
      done.templates++;
    }
  } catch (err) {
    console.error('whatsapp-webhook database error', err && err.code, err && err.message);
    return reply(500, { error: 'try again' });
  }
  return reply(200, { ok: true, done });
}
