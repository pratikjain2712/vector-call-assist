// whatsapp-admin: the Settings panel's WhatsApp actions that need Meta (web/js/admin/settings-whatsapp.js).
// The logic lives here (tested in tests/web/whatsapp-functions.test.js); index.ts only wires it.
// Saving a template's text is a plain RPC (admin_whatsapp_save_template); only these go through here.
//
// Request: POST, "Authorization: Bearer <the admin's access token>", JSON with an action:
//   { action: "connect", phone_number_id, waba_id, display_name, access_token, use_platform }   owner only
//        Checks the token and the ids with Meta, subscribes our app to the business account's webhooks, then
//        stores the token encrypted (WHATSAPP_TOKEN_KEY). access_token may be left out to keep the stored one.
//        use_platform: true uses our own system-user token (WHATSAPP_PLATFORM_TOKEN) instead.
//   { action: "disconnect" }                                                                       owner only
//   { action: "submit_template", template_id }       admins: sends the template to Meta for approval
//   { action: "refresh_templates" }                  admins: reads every template's status from Meta
// Answer: 200 { ok: true, … } or 4xx/5xx { error } with a sentence to show. The token is never sent back.
import {
  CORS, UUID, META_ID, reply, dbFailure, readJson, graph, encryptToken, tokenFor, templateComponents, countBlanks,
} from '../_shared/whatsapp.mjs';

const TOKEN = /^[A-Za-z0-9_\-.|]{20,2000}$/;

async function context(deps, user) {
  return deps.rpc('wa_admin_context', { p_user: user });
}

async function connect(deps, user, body) {
  const env = deps.env || {};
  const ctx = await context(deps, user);
  if (!ctx.is_owner) return reply(403, { error: 'Only an owner can connect WhatsApp.' });
  const phoneId = String(body.phone_number_id || '').trim();
  const waba = String(body.waba_id || '').trim();
  const name = String(body.display_name || '').trim();
  const typed = String(body.access_token || '').trim();
  const usePlatform = body.use_platform === true;
  if (!META_ID.test(phoneId)) return reply(400, { error: 'Enter the phone number ID (only digits) from Meta.' });
  if (!META_ID.test(waba)) return reply(400, { error: 'Enter the WhatsApp Business Account ID (only digits) from Meta.' });
  if (name.length < 1 || name.length > 80) return reply(400, { error: 'Enter the display name (up to 80 characters).' });
  if (typed && !TOKEN.test(typed)) return reply(400, { error: 'The access token does not look right. Copy it again from Meta.' });

  let token;
  let source = 'stored';
  if (usePlatform) {
    if (!env.WHATSAPP_PLATFORM_TOKEN) return reply(400, { error: 'Connecting through Vector is not set up yet. Paste your own access token.' });
    token = env.WHATSAPP_PLATFORM_TOKEN;
    source = 'platform';
  } else if (typed) {
    token = typed;
  } else if (ctx.token_cipher || (ctx.account && ctx.account.token_source === 'platform')) {
    try { token = await tokenFor(ctx, env); } catch (e) { return reply(400, { error: 'Paste the access token again.' }); }
    source = ctx.account && ctx.account.token_source === 'platform' ? 'platform' : 'stored';
  } else {
    return reply(400, { error: 'Paste the access token.' });
  }
  if (typed && !usePlatform && !env.WHATSAPP_TOKEN_KEY) {
    console.error('whatsapp-admin: WHATSAPP_TOKEN_KEY is not set');
    return reply(500, { error: 'The server is not set up to keep WhatsApp tokens yet.' });
  }

  const num = await graph(deps, 'GET', '/' + phoneId + '?fields=display_phone_number,verified_name,quality_rating', token);
  if (!num.ok) return reply(400, { error: num.error });
  const list = await graph(deps, 'GET', '/' + waba + '/phone_numbers?fields=id', token);
  if (!list.ok) return reply(400, { error: list.error });
  const ids = (list.data && Array.isArray(list.data.data) ? list.data.data : []).map((p) => String(p.id));
  if (!ids.includes(phoneId)) return reply(400, { error: 'This phone number ID is not in that WhatsApp Business Account.' });
  // Without this subscription Meta sends no statuses or replies for this business account.
  const sub = await graph(deps, 'POST', '/' + waba + '/subscribed_apps', token);

  let cipher = null;
  if (typed && !usePlatform) cipher = await encryptToken(token, env.WHATSAPP_TOKEN_KEY);
  await deps.rpc('wa_connect', {
    p_user: user, p_phone_number_id: phoneId, p_waba_id: waba, p_display_name: name,
    p_display_phone: num.data && num.data.display_phone_number ? String(num.data.display_phone_number).slice(0, 30) : null,
    p_token_cipher: cipher, p_token_source: source,
  });
  return reply(200, {
    ok: true,
    display_phone: (num.data && num.data.display_phone_number) || null,
    verified_name: (num.data && num.data.verified_name) || null,
    warning: sub.ok ? null : 'Connected, but Meta did not turn on delivery updates: ' + sub.error,
  });
}

// The status of one template at Meta, by name (used when Meta says the name already exists).
async function lookupByName(deps, token, waba, name) {
  const r = await graph(deps, 'GET', '/' + waba + '/message_templates?fields=id,name,status,rejected_reason&name=' + encodeURIComponent(name), token);
  if (!r.ok) return null;
  const rows = r.data && Array.isArray(r.data.data) ? r.data.data : [];
  return rows.find((x) => x.name === name) || null;
}

async function submitTemplate(deps, user, body) {
  const id = typeof body.template_id === 'string' && UUID.test(body.template_id) ? body.template_id : null;
  if (!id) return reply(400, { error: 'Choose a template.' });
  const ctx = await context(deps, user);
  if (!ctx.account || ctx.account.status !== 'connected') return reply(400, { error: 'Connect your WhatsApp number first.' });
  const t = await deps.rpc('wa_template_for_admin', { p_user: user, p_template: id });
  if (countBlanks(t.body) !== (t.param_sources || []).length) return reply(400, { error: 'Fix the blanks in this message first.' });
  let token;
  try { token = await tokenFor(ctx, deps.env || {}); } catch (e) {
    console.error('whatsapp-admin token problem', e && e.message);
    return reply(400, { error: 'Connect your WhatsApp number again.' });
  }
  const components = templateComponents(t, ctx.account && ctx.account.display_name);
  const waba = ctx.account.waba_id;
  let r;
  if (t.meta_template_id) {
    r = await graph(deps, 'POST', '/' + t.meta_template_id, token, { components });   // an edit keeps its category
  } else {
    r = await graph(deps, 'POST', '/' + waba + '/message_templates', token, {
      name: t.meta_name, language: t.language, category: t.category.toUpperCase(), components,
    });
  }
  if (!r.ok) {
    if (r.tokenProblem) await deps.rpc('wa_account_error', { p_institute: ctx.institute_id, p_error: r.error });
    // Already at Meta under this name (sent before from another place): take its id and status.
    const found = !t.meta_template_id && r.code === 100 ? await lookupByName(deps, token, waba, t.meta_name) : null;
    if (!found) return reply(400, { error: r.error });
    await deps.rpc('wa_template_status', {
      p_template: id, p_waba_id: null, p_meta_name: null, p_meta_template_id: String(found.id), p_status: found.status,
      p_reason: found.rejected_reason || null,
    });
    return reply(200, { ok: true, status: String(found.status).toLowerCase(), note: 'This template was already at Meta.' });
  }
  const status = (r.data && r.data.status) || 'PENDING';
  await deps.rpc('wa_template_status', {
    p_template: id, p_waba_id: null, p_meta_name: null,
    p_meta_template_id: r.data && r.data.id ? String(r.data.id) : (t.meta_template_id || null),
    p_status: status, p_reason: null,
  });
  const metaCategory = r.data && r.data.category ? String(r.data.category).toLowerCase() : t.category;
  return reply(200, {
    ok: true,
    status: String(status).toLowerCase(),
    note: metaCategory !== t.category ? 'Meta put this template in the ' + metaCategory + ' category.' : null,
  });
}

async function refreshTemplates(deps, user) {
  const ctx = await context(deps, user);
  if (!ctx.account || ctx.account.status !== 'connected') return reply(400, { error: 'Connect your WhatsApp number first.' });
  let token;
  try { token = await tokenFor(ctx, deps.env || {}); } catch (e) { return reply(400, { error: 'Connect your WhatsApp number again.' }); }
  const waba = ctx.account.waba_id;
  const r = await graph(deps, 'GET', '/' + waba + '/message_templates?fields=id,name,status,language,rejected_reason&limit=200', token);
  if (!r.ok) {
    if (r.tokenProblem) await deps.rpc('wa_account_error', { p_institute: ctx.institute_id, p_error: r.error });
    return reply(400, { error: r.error });
  }
  let updated = 0;
  for (const x of (r.data && Array.isArray(r.data.data) ? r.data.data : [])) {
    if (!/^vec_[a-z][a-z0-9_]{1,39}$/.test(String(x.name || ''))) continue;
    try {
      updated += Number(await deps.rpc('wa_template_status', {
        p_template: null, p_waba_id: waba, p_meta_name: x.name, p_meta_template_id: x.id ? String(x.id) : null,
        p_status: x.status, p_reason: x.rejected_reason || null,
      })) || 0;
    } catch (e) {
      if (e && e.code !== '22023') throw e;   // a status we do not know: skip that template
    }
  }
  return reply(200, { ok: true, updated });
}

// deps: { env, fetch, rpc(name, args) with the service role, userId(authorizationHeader) }
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
  try {
    if (body.action === 'connect') return await connect(deps, user, body);
    if (body.action === 'disconnect') {
      await deps.rpc('wa_disconnect', { p_user: user });
      return reply(200, { ok: true });
    }
    if (body.action === 'submit_template') return await submitTemplate(deps, user, body);
    if (body.action === 'refresh_templates') return await refreshTemplates(deps, user);
  } catch (err) {
    return dbFailure(err, 'whatsapp-admin');
  }
  return reply(400, { error: 'Unknown action.' });
}
