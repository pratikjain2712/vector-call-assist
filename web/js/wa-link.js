/* "Send on WhatsApp" after a campaign call (Sprint 12 quick win): a wa.me link that opens the caller's own
   WhatsApp with the message filled in. Nothing is sent by Vector itself.
   Consent: the button is offered unless the lead is "do not call" or said no to WhatsApp on this call or before
   (consent_whatsapp is false by default until a caller records it, so "not recorded yet" still shows the
   button with a reminder to ask first).
   Hook for later: WaLink.setSender(fn) registers an in-app sender (WhatsApp Business API, Sprint 12). When one
   is set, the page calls WaLink.send({ leadId, phone, text }) instead of opening wa.me. Tested in
   tests/web/wa-link.test.js. */
(function (root) {
  let sender = null;

  /* +91 98765 43210, 09876543210, 9876543210 -> 919876543210. Anything else -> "". */
  function waNumber(phone) {
    let d = String(phone == null ? "" : phone).replace(/[^\d+]/g, "");
    if (d.startsWith("+")) d = d.slice(1);
    else if (d.startsWith("0") && d.length === 11) d = "91" + d.slice(1);
    else if (d.length === 10) d = "91" + d;
    return /^\d{11,15}$/.test(d) ? d : "";
  }

  /* consent: "yes" | "no" | "" (not asked on this call). lead.consent_whatsapp: what was recorded before. */
  function allowed(lead, consent, resultKey) {
    if (!lead || lead.do_not_call || resultKey === "do_not_call" || resultKey === "wrong_number") return false;
    if (consent === "no") return false;
    return true;
  }
  /* True when nobody has recorded a yes: the caller should ask before sending. */
  function needsAsking(lead, consent) { return consent !== "yes" && !(lead && lead.consent_whatsapp === true); }

  function rupees(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  function longDate(iso) {
    const t = Date.parse(String(iso || "") + "T12:00:00+05:30");
    return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "Asia/Kolkata" }) : "";
  }

  /* The message for a result. p: { key, name, me, campaign, date (YYYY-MM-DD), amount (number) }. */
  function message(p) {
    const first = String(p.name || "").trim().split(/\s+/)[0] || "there";
    const hi = "Hello " + first + ", this is " + (String(p.me || "").trim() || "your caller") + (p.campaign ? " (" + p.campaign + ")" : "") + ".";
    const date = longDate(p.date);
    const amt = p.amount != null && p.amount !== "" ? rupees(p.amount) : "";
    const lines = {
      will_pay_on: "Thank you for talking to me. As we discussed, you will pay" + (amt ? " " + amt : "") + (date ? " on " + date : "") + ". Please message me here if anything changes.",
      paid: "Thank you for the payment" + (amt ? " of " + amt : "") + ". We will confirm it once it reaches us.",
      paid_part: "Thank you for the part payment" + (amt ? " of " + amt : "") + ". We will confirm it once it reaches us.",
      already_paid: "Thank you. We will check our records for your payment and get back to you.",
      call_back_later: "As we discussed, I will call you again" + (date ? " on " + date : "") + ".",
      no_answer: "I tried calling you just now. Please tell me a good time to call you back.",
      busy: "I tried calling you just now. I will call again in a little while.",
      visit_booked: "Your visit is booked" + (date ? " for " + date : "") + ". We look forward to meeting you.",
      new_date: "As we discussed, the new date is " + (date || "the one we agreed") + ".",
      will_come_on: "Thank you. We have noted that the student will come" + (date ? " on " + date : "") + ".",
      will_renew_on: "Thank you. I will check with you again" + (date ? " on " + date : "") + " about the renewal.",
      confirmed: "Thank you for confirming.",
      coming: "Thank you, we have noted that you are coming.",
      form_sent: "As promised, here is the form. Message me here if you need help.",
    };
    return hi + "\n\n" + (lines[p.key] || "Thank you for your time today.");
  }

  function link(phone, text) {
    const n = waNumber(phone);
    return n ? "https://wa.me/" + n + "?text=" + encodeURIComponent(text || "") : "";
  }

  function setSender(fn) { sender = typeof fn === "function" ? fn : null; }
  function hasSender() { return !!sender; }
  /* In-app send through the registered sender. Rejects when none is set. */
  function send(msg) { return sender ? Promise.resolve(sender(msg)) : Promise.reject(new Error("No in-app WhatsApp sender is set up.")); }

  const api = { waNumber, allowed, needsAsking, message, link, rupees, setSender, hasSender, send };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WaLink = api;
})(typeof window !== "undefined" ? window : globalThis);
