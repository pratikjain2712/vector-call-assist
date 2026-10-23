/* The caller's waiting leads in a campaign: order, labels, and what a saved result does to a lead. Pure
   functions over the lead objects that my_call_queue() returns (supabase/migrations/20261024100021_caller_screen.sql):
   { id, name, phone, extra, status, next_call_at, promised_date, consent_whatsapp, created_at, calls,
     last_called_at, last_result_key, last_note }.
   applyResult mirrors the lead update in save_call_result(), so a result saved offline moves the lead out of
   the queue at once; the server's copy replaces it on the next refresh. Used by main.js and tested under Node
   (tests/web/campaign-queue.test.js). Times are ISO text or milliseconds; now is milliseconds. */
(function (root) {
  const OPEN = { new: 1, callback: 1, promised: 1 };
  // Results with no date that mean "call again" (legacy outcome 'callback' in the call type seed).
  const CALL_AGAIN = { will_think: 1 };
  const RETRY_MS = { no_answer: 2 * 3600e3, busy: 30 * 60e3 };
  const DAY_MS = 24 * 3600e3;

  const ms = (v) => (v == null || v === "" ? null : typeof v === "number" ? v : Date.parse(v));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* Is the lead waiting now? Open, not "do not call", and its next call time (if any) has come. */
  function isOpen(lead) { return !!lead && own(OPEN, lead.status) && !lead.do_not_call && lead.consent_call !== false; }
  function isDueNow(lead, now) {
    if (!isOpen(lead)) return false;
    const at = ms(lead.next_call_at);
    return at == null || at <= now;
  }

  /* due: call backs and promises whose time has come, earliest first. fresh: new leads never called, oldest
     first. later: open leads whose time has not come yet, soonest first. Done, wrong number and do-not-call
     leads are in none of them. */
  function groups(leads, now) {
    const due = [], fresh = [], later = [];
    (leads || []).forEach((l) => {
      if (!isOpen(l)) return;
      const at = ms(l.next_call_at);
      if (at != null && at > now) later.push(l);
      else if (at == null && l.status === "new") fresh.push(l);
      else due.push(l);
    });
    const by = (key) => (a, b) => {
      const x = ms(a[key]) || 0, y = ms(b[key]) || 0;
      if (x !== y) return x - y;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    };
    due.sort(by("next_call_at"));
    fresh.sort(by("created_at"));
    later.sort(by("next_call_at"));
    return { due, fresh, later };
  }

  /* The leads to call now, in order: due call backs and promises, then new leads. */
  function callable(leads, now) { const g = groups(leads, now); return g.due.concat(g.fresh); }

  /* The lead to call after the one given: the first callable lead that is not it. */
  function nextLead(leads, now, afterId) { return callable(leads, now).find((l) => l.id !== afterId) || null; }

  function clock(at) {
    const d = new Date(at);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const pm = h >= 12; h = h % 12 || 12;
    return h + ":" + m + (pm ? " pm" : " am");
  }
  function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.toDateString() === y.toDateString(); }
  function shortDate(at) {
    return new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  }

  /* One short line about the lead: kind is due | promise | new | later. */
  function statusOf(lead, now) {
    const at = ms(lead.next_call_at);
    if (lead.status === "promised") {
      if (at == null || at <= now) return { kind: "promise", label: "Promise due" + (lead.promised_date ? " " + shortDate(lead.promised_date) : "") };
      return { kind: "later", label: "Promise on " + shortDate(lead.promised_date || at) };
    }
    if (at != null && at > now) return { kind: "later", label: (sameDay(at, now) ? "Call at " + clock(at) : "Call on " + shortDate(at)) };
    if (lead.status === "callback") return { kind: "due", label: at != null && now - at > DAY_MS ? "Call back overdue" : "Call back now" };
    return { kind: "new", label: lead.calls ? "Try again" : "New" };
  }

  /* The lead after a result is saved, as save_call_result() changes it. result: a button from my_campaigns()
     ({ key, needs_date, needs_amount }). values: { date: "YYYY-MM-DD", nextCallAt: ms|null, amount, waConsent }.
     Times are approximate (the server's copy replaces this one). Returns a new object. */
  function applyResult(lead, result, values, now) {
    const v = values || {};
    const out = Object.assign({}, lead);
    out.calls = (lead.calls || 0) + 1;
    out.last_called_at = new Date(now).toISOString();
    out.last_result_key = result.key;
    if (v.note) out.last_note = v.note;
    if (v.waConsent === true || v.waConsent === false) out.consent_whatsapp = v.waConsent;
    if (lead.do_not_call) return out;
    const key = result.key;
    if (key === "do_not_call") { out.do_not_call = true; out.status = "do_not_call"; out.next_call_at = null; }
    else if (key === "wrong_number") { out.status = "wrong_number"; out.next_call_at = null; }
    else if (own(RETRY_MS, key)) {
      if (out.status === "new") out.status = "callback";
      out.next_call_at = new Date(now + RETRY_MS[key]).toISOString();
    } else if (result.needs_date && v.date) {
      const at = v.nextCallAt != null ? v.nextCallAt : Date.parse(v.date + "T10:00:00+05:30");
      out.next_call_at = new Date(at).toISOString();
      if (result.needs_amount) { out.status = "promised"; out.promised_date = v.date; }
      else out.status = "callback";
    } else if (own(CALL_AGAIN, key)) {
      out.status = "callback"; out.next_call_at = new Date(now + 2 * DAY_MS).toISOString();
    } else { out.status = "done"; out.next_call_at = null; }
    return out;
  }

  /* The server's queue with the results still waiting to be sent laid over it, oldest first, so a lead saved
     offline is not offered again. pending: [{ leadId, result, values, savedAt }]. */
  function withPending(leads, pending) {
    const list = (leads || []).map((l) => Object.assign({}, l));
    (pending || []).slice().sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0)).forEach((p) => {
      const i = list.findIndex((l) => l.id === p.leadId);
      if (i >= 0 && p.result) list[i] = applyResult(list[i], p.result, p.values, p.savedAt || 0);
    });
    return list;
  }

  /* Extra sheet fields worth showing on the card: [label, value] pairs, short keys first, blanks dropped. */
  function extraFields(extra) {
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) return [];
    return Object.keys(extra)
      .map((k) => [k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), extra[k] == null ? "" : String(extra[k]).trim()])
      .filter((p) => p[1] !== "")
      .slice(0, 8);
  }

  const api = { isOpen, isDueNow, groups, callable, nextLead, statusOf, applyResult, withPending, extraFields };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CampaignQueue = api;
})(typeof window !== "undefined" ? window : globalThis);
