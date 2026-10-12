/* Terms acceptance for reps. Needs the my_terms_status and accept_terms database functions.
   - Only when the cloud is on. With the cloud off the panel stays hidden and calls are not blocked.
   - After sign-in, if there is no acceptance for the current terms version, the panel shows and calls
     are blocked (allowed() is false) until the rep accepts.
   - If the functions are missing or the cloud cannot be reached, nothing is blocked (it degrades quietly).
   The hash is SHA-256 of TERMS.text, computed with crypto.subtle. */
(function (root) {
  const $ = (id) => document.getElementById(id);
  // idle | checking | needed | accepted | degraded
  let state = "idle";
  let checkedKey = null;   // who the last check was for (email and institute): a new sign-in checks again
  let busy = false;
  let textFilled = false;
  const listeners = [];

  /* Pure: true when rows (the my_terms_status result) hold an acceptance of this version. */
  function acceptedFor(rows, version) {
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    return list.some((r) => r && r.terms_version === version && !!r.accepted_at);
  }

  /* Pure given a string: lower-case hex SHA-256 of the UTF-8 bytes. */
  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function allowed() {
    const c = root.Cloud.info();
    if (!c.enabled) return true;
    return state === "accepted" || state === "degraded";
  }

  function fillText() {
    if (textFilled) return;
    const box = $("terms-text");
    String(root.TERMS.text).split("\n\n").forEach((para) => {
      const p = document.createElement("p");
      p.textContent = para;
      box.appendChild(p);
    });
    textFilled = true;
  }
  function render() {
    const panel = $("terms-panel");
    if (!panel) return;
    fillText();
    panel.hidden = !(root.Cloud.info().enabled && state === "needed");
    $("terms-draft").hidden = !root.TERMS.draft;
    $("terms-accept").disabled = busy;
  }
  function setState(next) {
    state = next;
    render();
    listeners.forEach((fn) => { try { fn(state); } catch (e) {} });
  }

  async function check(c) {
    const key = c.email + "|" + c.instituteId;
    checkedKey = key;
    setState("checking");
    let res;
    try { res = await root.Cloud.rpc("my_terms_status", { p_institute: c.instituteId }); }
    catch (e) { res = { error: e }; }
    if (checkedKey !== key) return;   // a later sign-in is in charge now
    if (res.error) { setState("degraded"); return; }
    setState(acceptedFor(res.data, root.TERMS.version) ? "accepted" : "needed");
  }

  function onCloud(c) {
    if (!c.enabled) { if (state !== "idle") setState("idle"); return; }
    if (c.status === "ready") {
      if (checkedKey !== c.email + "|" + c.instituteId) check(c);
    } else if (c.status === "offline") {
      checkedKey = null;   // check again when the connection is back
      if (state === "idle" || state === "checking") setState("degraded");
    } else {
      checkedKey = null;
      if (state !== "idle") setState("idle");
    }
  }

  async function accept() {
    if (busy) return;
    const c = root.Cloud.info();
    busy = true;
    $("terms-msg").textContent = "";
    render();
    try {
      const hash = await sha256Hex(root.TERMS.text);
      const res = await root.Cloud.rpc("accept_terms", { p_institute: c.instituteId, p_version: root.TERMS.version, p_text_hash: hash });
      if (res.error) throw new Error("accept_terms failed");
      busy = false;
      $("sheet-msg").textContent = root.I18n.t("terms.saved");
      setState("accepted");
    } catch (e) {
      busy = false;
      $("terms-msg").textContent = root.I18n.t("terms.error");
      render();
    }
  }

  function init() {
    $("terms-accept").addEventListener("click", accept);
    root.Cloud.onChange(onCloud);
    render();
  }

  root.TermsGate = {
    acceptedFor, sha256Hex, allowed, init,
    state: () => state,
    onChange: (fn) => { listeners.push(fn); },
  };
})(window);
