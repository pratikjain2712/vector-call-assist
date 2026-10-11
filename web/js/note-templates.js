/* Note templates for the notes field on a call's end card. Static text with no lead names or numbers.
   main.js inserts the chosen text at the cursor; the rep edits the [bracketed] parts. */
(function (root) {
  const NOTE_TEMPLATES = [
    { id: "callback", label: "Asked for a callback", text: "Asked for a callback on [day] at [time]." },
    { id: "busy", label: "Busy right now", text: "Busy on the call. Try again [when]." },
    { id: "no_answer", label: "No answer, tried", text: "No answer at [time]. Try again [when]." },
    { id: "whatsapp", label: "Wants details on WhatsApp", text: "Asked for the details on WhatsApp. Check back on [day]." },
    { id: "not_interested", label: "Not interested", text: "Not interested. Reason: [reason]." },
    { id: "fee", label: "Fee is the concern", text: "Fee is the concern. Team to check payment options, reply by [day]." },
    { id: "approval", label: "Needs family or manager", text: "Needs to check with [family or manager] before deciding." },
    { id: "schedule", label: "Schedule does not fit", text: "Schedule does not fit: [weekday or weekend] clash." },
    { id: "wrong", label: "Wrong number", text: "Wrong number. Needs checking on the sheet." },
    { id: "dnc", label: "Do not call", text: "Asked not to be called again. Marked do not call." },
  ];
  const api = NOTE_TEMPLATES;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.NOTE_TEMPLATES = api;
})(typeof window !== "undefined" ? window : globalThis);
