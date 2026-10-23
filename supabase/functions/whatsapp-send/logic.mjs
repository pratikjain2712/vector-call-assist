// whatsapp-send: a caller sends an approved WhatsApp template to the lead they just called.
// The logic lives here (plain JS, tested in tests/web/whatsapp-functions.test.js); index.ts only wires it.
//
// Request: POST, "Authorization: Bearer <the caller's access token>", JSON
//   { lead_id, template_key, params }   params: what the caller typed for "typed" blanks, as an array
//                                        ({{1}} is params[0]) or an object { "3": "Monday" }. Optional.
// Answer: 200 { ok: true, message_id }, or 4xx/5xx { error } with a sentence to show.
// Checks (in wa_prepare_send, migration 20261024100027): the caller's active seat has the lead assigned, the
// lead agreed to WhatsApp and is not "do not call", the number is connected, the template is approved, and
// the same template goes to the same lead at most once a day.
import { CORS, UUID, reply, dbFailure, readJson, sendClaimed } from '../_shared/whatsapp.mjs';

const KEY = /^[a-z][a-z0-9_]{1,39}$/;

// deps: { env, fetch, rpc(name, args) with the service role (throws { code, message }),
//         userId(authorizationHeader) -> the signed-in user's id or null }
export async function handle(req, deps) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return reply(401, { error: 'Sign in first.' });
  let user = null;
  try { user = await deps.userId(auth); } catch (e) { user = null; }
  if (!user) return reply(401, { error: 'Sign in first.' });

  const body = await readJson(req);
  if (!body) return reply(400, { error: 'The request is not valid JSON.' });
  const lead = typeof body.lead_id === 'string' && UUID.test(body.lead_id) ? body.lead_id : null;
  const key = typeof body.template_key === 'string' && KEY.test(body.template_key) ? body.template_key : null;
  if (!lead || !key) return reply(400, { error: 'Choose a lead and a message.' });
  const typed = Array.isArray(body.params) || (body.params && typeof body.params === 'object') ? body.params : undefined;

  let ctx;
  try {
    ctx = await deps.rpc('wa_prepare_send', { p_user: user, p_lead: lead, p_template_key: key });
  } catch (err) {
    return dbFailure(err, 'whatsapp-send');
  }
  try {
    const out = await sendClaimed(deps, ctx, { typed });
    if (!out.ok) return reply(out.status, { error: out.error });
    return reply(200, { ok: true, message_id: out.message_id });
  } catch (err) {
    console.error('whatsapp-send failed', err && err.message);
    return reply(500, { error: 'Something went wrong. Try again.' });
  }
}
