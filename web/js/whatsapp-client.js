/* WhatsApp from the caller page (Sprint 12). A caller sends an approved template to the lead they just
   called, through the whatsapp-send Edge Function (supabase/functions/whatsapp-send). The server checks
   everything again: the lead is assigned to this caller, the person agreed to WhatsApp and is not
   "do not call", the template is approved, and the same message goes at most once a day.
   Use:
     const list = await VectorWhatsApp.loadTemplates(client);                 // approved, [] when not connected
     const offer = VectorWhatsApp.forResult(list, 'fees', 'will_pay_on');     // the ones for this call ending
     VectorWhatsApp.typedBlanks(offer[0]);                                   // blanks the caller must type
     await VectorWhatsApp.sendAfterCall(client, lead.id, offer[0].key, ['Monday']);
     const msgs = await VectorWhatsApp.leadMessages(client, lead.id);        // sent messages and replies
   sendAfterCall resolves to { ok: true, messageId } or { ok: false, error } (a sentence to show); it never
   throws. params: what the caller typed, as an array ({{1}} is params[0]) or { "3": "Monday" }.
   The pure helpers are also loaded by tests/web/whatsapp-client.test.js (Node, no DOM). */
(function () {
  const FUNCTION = 'whatsapp-send';
  const KEY = /^[a-z][a-z0-9_]{1,39}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Readable labels for what fills a blank (used in previews).
  const SOURCE_LABELS = {
    lead_name: 'name', amount_due: 'amount due', promised_amount: 'promised amount', promised_date: 'promised date',
    institute_name: 'institute name', caller_name: 'your name', typed: 'typed by you',
  };

  // The templates offered after a call ending: the ones for this exact ending first, then those for any ending
  // of this call type, then those for any call. Marketing templates are left out when onlyUtility is true.
  function forResult(templates, callTypeKey, resultKey, onlyUtility) {
    const list = (templates || []).filter((t) => t && KEY.test(String(t.key || '')) && (!onlyUtility || t.category === 'utility'));
    const exact = list.filter((t) => t.result_key && t.result_key === resultKey && t.call_type_key === callTypeKey);
    const type = list.filter((t) => !t.result_key && t.call_type_key && t.call_type_key === callTypeKey);
    const any = list.filter((t) => !t.call_type_key && !t.result_key);
    return exact.concat(type, any);
  }

  // The blank numbers (1-based) the caller must type before sending.
  function typedBlanks(template) {
    const out = [];
    ((template && template.param_sources) || []).forEach((s, i) => { if (s === 'typed') out.push(i + 1); });
    return out;
  }

  // The message as the caller will see it before sending: known values in, the rest as [label].
  // values: { lead_name, amount_due (already formatted), … } and typed as for sendAfterCall.
  function preview(template, values, typed) {
    const v = values || {};
    const sources = (template && template.param_sources) || [];
    return String((template && template.body) || '').replace(/\{\{([0-9]{1,2})\}\}/g, (m, n) => {
      const i = Number(n) - 1;
      const src = sources[i];
      let val = src === 'typed'
        ? (Array.isArray(typed) ? typed[i] : (typed && typed[String(i + 1)]))
        : v[src];
      val = val === null || val === undefined ? '' : String(val).trim();
      return val || '[' + (SOURCE_LABELS[src] || 'blank ' + n) + ']';
    });
  }

  // Turns the Edge Function's answer (or a network failure) into { ok, messageId } / { ok: false, error }.
  async function readAnswer(data, error) {
    if (!error) {
      if (data && data.ok) return { ok: true, messageId: data.message_id || null };
      return { ok: false, error: (data && data.error) || 'The message was not sent. Try again.' };
    }
    let text = '';
    const res = error.context;
    if (res && typeof res.json === 'function') {
      try { const body = await res.json(); text = body && body.error ? String(body.error) : ''; } catch (e) { text = ''; }
    }
    if (!text && /fetch|network|relay/i.test(String(error.name || '') + ' ' + String(error.message || ''))) {
      text = 'No connection. Try again.';
    }
    return { ok: false, error: text || 'The message was not sent. Try again.' };
  }

  // Sends one approved template to a lead, after a call. client: the page's signed-in supabase-js client.
  async function sendAfterCall(client, leadId, templateKey, params) {
    if (!client || !client.functions) return { ok: false, error: 'Sign in to send WhatsApp messages.' };
    if (!UUID.test(String(leadId || ''))) return { ok: false, error: 'Choose a lead first.' };
    if (!KEY.test(String(templateKey || ''))) return { ok: false, error: 'Choose a message first.' };
    const body = { lead_id: leadId, template_key: templateKey };
    if (Array.isArray(params) || (params && typeof params === 'object')) body.params = params;
    try {
      const { data, error } = await client.functions.invoke(FUNCTION, { body });
      return await readAnswer(data, error);
    } catch (e) {
      return { ok: false, error: 'No connection. Try again.' };
    }
  }

  // The approved templates this caller can send ([] when the institute has no connected number).
  async function loadTemplates(client) {
    const { data, error } = await client.rpc('my_whatsapp_templates');
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data : [];
  }

  // Messages sent to a lead and their replies, newest first. RLS lets a caller read only their own leads'.
  async function leadMessages(client, leadId, limit) {
    const { data, error } = await client.from('whatsapp_messages')
      .select('id, direction, kind, status, template_key, body, is_stop, created_at, status_at')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(limit || 20);
    if (error) throw new Error(error.message);
    return data || [];
  }

  // Short words for a message status, for the lead card.
  const STATUS_TEXT = { queued: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not delivered', received: 'Reply' };
  const statusText = (s) => STATUS_TEXT[s] || '';

  const api = { FUNCTION, SOURCE_LABELS, forResult, typedBlanks, preview, readAnswer, sendAfterCall, loadTemplates, leadMessages, statusText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.VectorWhatsApp = api;
})();
