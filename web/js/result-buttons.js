/* Result buttons of a campaign call: the call type's own results and the five common ones (from my_campaigns()
   results: { key, label, needs_date, needs_amount, needs_reason, needs_rating, reason_choices, counts_as_good,
   common }), the fields a result needs, and the save_call_result() arguments. Pure functions; the page draws
   the buttons in main.js. Tested in tests/web/result-buttons.test.js. */
(function (root) {
  // Colour hint per result: good results green, a clear no red.
  const BAD = { refused: 1, not_interested: 1, cancelled: 1, not_coming: 1, not_renewing: 1, not_this_year: 1, joined_elsewhere: 1, do_not_call: 1 };

  /* main: the call type's results in button order; common: No answer, Busy, Wrong number, Call back later,
     Do not call again. */
  function split(results) {
    const list = Array.isArray(results) ? results.filter((r) => r && r.key && r.label) : [];
    return { main: list.filter((r) => !r.common), common: list.filter((r) => r.common) };
  }

  function tone(result) { return result.counts_as_good ? "good" : BAD[result.key] ? "bad" : ""; }

  /* "18,000", "₹ 18000.50", "18000" -> 18000 / 18000.5. Blank or not a number -> null. */
  function parseAmount(text) {
    const s = String(text == null ? "" : text).replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
    if (!s || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && n <= 9999999999.99 ? n : null;
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  /* The fields this result asks for, in order: date, amount, reason, rating. */
  function fields(result) {
    if (!result) return [];
    const f = [];
    if (result.needs_date) f.push("date");
    if (result.needs_amount) f.push("amount");
    if (result.needs_reason) f.push("reason");
    if (result.needs_rating) f.push("rating");
    return f;
  }

  /* What is still missing or wrong, as short messages for the caller. Empty when the result can be saved. */
  function problems(result, values) {
    const v = values || {};
    if (!result) return ["Pick how the call ended."];
    const out = [];
    if (result.needs_date && !DATE_RE.test(String(v.date || ""))) out.push("Pick the date.");
    if (v.time && !TIME_RE.test(String(v.time))) out.push("Enter the time as hh:mm.");
    if (result.needs_amount && parseAmount(v.amount) == null) out.push("Enter the amount in rupees.");
    if (result.needs_reason && !String(v.reason || "").trim()) out.push("Give the reason.");
    if (result.needs_rating && !(Number(v.rating) >= 1 && Number(v.rating) <= 5)) out.push("Pick a rating from 1 to 5.");
    if (String(v.note || "").length > 300) out.push("Keep the note under 300 characters.");
    return out;
  }

  /* A date and an optional hh:mm, in India time, as milliseconds; null without a time. */
  function callAt(date, time) {
    if (!DATE_RE.test(String(date || "")) || !TIME_RE.test(String(time || ""))) return null;
    return Date.parse(date + "T" + time + ":00+05:30");
  }

  /* The save_call_result() arguments. ctx: { id, leadId, stepTimes, reachedStep, scriptStep, scriptId,
     scriptVersion, dialledAt (ms), connectedSeconds, phoneSessionId }. Fields the result does not ask for are
     left out, except the reason (a comment is allowed on any result), the note and WhatsApp consent. */
  function toArgs(result, values, ctx) {
    const v = values || {}, c = ctx || {};
    const args = { p_client_record_id: c.id, p_lead: c.leadId, p_result_key: result.key };
    if (result.needs_date) args.p_promised_date = v.date;
    if (result.needs_date && v.time) args.p_next_call_at = new Date(callAt(v.date, v.time)).toISOString();
    if (result.needs_amount) args.p_amount = parseAmount(v.amount);
    const reason = String(v.reason || "").trim();
    if (reason) args.p_reason = reason.slice(0, 300);
    if (result.needs_rating) args.p_rating = Number(v.rating);
    const note = String(v.note || "").trim();
    if (note) args.p_note = note.slice(0, 300);
    if (v.waConsent === true || v.waConsent === false) args.p_consent_whatsapp = v.waConsent;
    if (c.stepTimes && Object.keys(c.stepTimes).length) args.p_step_times = c.stepTimes;
    if (c.reachedStep) args.p_reached_step = String(c.reachedStep).slice(0, 80);
    if (c.scriptStep) args.p_script_step = String(c.scriptStep).slice(0, 80);
    if (c.scriptId) args.p_script_id = String(c.scriptId).slice(0, 80);
    if (c.scriptVersion != null) args.p_script_version = Number(c.scriptVersion);
    if (c.dialledAt) args.p_dialled_at = new Date(c.dialledAt).toISOString();
    if (c.connectedSeconds != null) args.p_connected_seconds = Math.max(0, Math.round(c.connectedSeconds));
    if (c.phoneSessionId) args.p_phone_session_id = String(c.phoneSessionId).slice(0, 80);
    return args;
  }

  const api = { split, tone, parseAmount, fields, problems, callAt, toArgs };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ResultButtons = api;
})(typeof window !== "undefined" ? window : globalThis);
