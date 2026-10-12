/* Send feedback: a short message to the Vector team, through the submit_feedback database function.
   Only the text the rep types is sent. No lead data is attached. Length is counted in characters
   (code points), the same way the database counts. */
(function (root) {
  const MAX = 2000;
  const $ = (id) => document.getElementById(id);

  function count(text) { return Array.from(String(text == null ? "" : text)).length; }
  function clamp(text) { return Array.from(String(text == null ? "" : text)).slice(0, MAX).join(""); }
  /* "empty" (nothing but spaces), "long" (over MAX), or "ok". */
  function check(text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return "empty";
    return count(t) > MAX ? "long" : "ok";
  }

  let opener = null;
  let busy = false;
  const cloudOn = () => !!(root.Cloud && root.Cloud.info && root.Cloud.info().enabled);

  function setMsg(text, bad) {
    const m = $("feedback-msg");
    m.textContent = text || "";
    m.className = bad ? "msgline" : "hint";
  }
  function updateCount() {
    const v = $("feedback-text").value;
    $("feedback-count").textContent = root.I18n.t("feedback.count", { n: count(v), max: MAX });
    $("feedback-send").disabled = busy || check(v) !== "ok";
  }
  function open() {
    opener = document.activeElement;
    $("feedback-dialog").hidden = false;
    setMsg("");
    updateCount();
    $("feedback-text").focus();
  }
  function close() {
    $("feedback-dialog").hidden = true;
    if (opener && opener.focus) opener.focus();
  }
  async function send() {
    const v = $("feedback-text").value;
    const verdict = check(v);
    if (verdict === "empty") { setMsg(root.I18n.t("feedback.empty"), true); return; }
    if (!cloudOn()) { setMsg(root.I18n.t("feedback.offCloud"), true); return; }
    busy = true;
    updateCount();
    setMsg("");
    try {
      const res = await root.Cloud.rpc("submit_feedback", { p_message: v.trim() });
      if (res.error) throw new Error("submit_feedback failed");
      $("feedback-text").value = "";
      setMsg(root.I18n.t("feedback.sent"), false);
    } catch (e) {
      setMsg(root.I18n.t("feedback.error"), true);
    } finally {
      busy = false;
      updateCount();
    }
  }

  function init() {
    $("feedback-open").addEventListener("click", open);
    $("feedback-cancel").addEventListener("click", close);
    $("feedback-send").addEventListener("click", send);
    const ta = $("feedback-text");
    ta.addEventListener("input", () => {
      if (count(ta.value) > MAX) ta.value = clamp(ta.value);
      updateCount();
    });
    $("feedback-dialog").addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); close(); return; }
      root.Modal.trap($("feedback-dialog"), ev);
    });
  }

  root.Feedback = { MAX, count, clamp, check, init };
})(window);
