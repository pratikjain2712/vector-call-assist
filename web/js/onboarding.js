/* First-run walkthrough: four steps (pair the phone, import leads, use the script, send outcomes). Shown
   once; the flag "vca2-onboarded" in localStorage holds only "1". Next and Skip on every step; Escape skips.
   It can be shown again from Settings. */
(function (root) {
  const FLAG = "vca2-onboarded";
  const STEPS = [
    { title: "onb.1.title", body: "onb.1.body" },
    { title: "onb.2.title", body: "onb.2.body" },
    { title: "onb.3.title", body: "onb.3.body" },
    { title: "onb.4.title", body: "onb.4.body" },
  ];
  const $ = (id) => document.getElementById(id);
  const store = () => { try { return root.localStorage; } catch (e) { return null; } };

  /* Pure: true on a first run. No storage (blocked) means no walkthrough, so it never nags. */
  function shouldShow(storage) {
    try { return !!storage && storage.getItem(FLAG) !== "1"; } catch (e) { return false; }
  }
  function markDone(storage) { try { if (storage) storage.setItem(FLAG, "1"); } catch (e) {} }
  function nextStep(i) { return Math.min(i + 1, STEPS.length - 1); }
  function isLast(i) { return i >= STEPS.length - 1; }

  let index = 0;
  let shown = false;
  let opener = null;

  function render() {
    const t = root.I18n.t;
    $("onb-count").textContent = t("onb.count", { n: index + 1, total: STEPS.length });
    $("onb-title").textContent = t(STEPS[index].title);
    $("onb-body").textContent = t(STEPS[index].body);
    $("onb-next").textContent = t(isLast(index) ? "onb.done" : "onb.next");
  }
  function show() {
    index = 0;
    shown = true;
    opener = document.activeElement;
    render();
    $("onboard").hidden = false;
    $("onb-next").focus();
  }
  function finish() {
    markDone(store());
    shown = false;
    $("onboard").hidden = true;
    if (opener && opener.focus) opener.focus();
  }
  /* Called after each screen change: shows the walkthrough once the pairing or workspace screen is up. */
  function maybeShow() {
    if (shown || !shouldShow(store())) return;
    if (!$("signin").hidden) return;
    if ($("gate").hidden && $("app").hidden) return;
    show();
  }
  function init() {
    $("onb-next").addEventListener("click", () => {
      if (isLast(index)) finish();
      else { index = nextStep(index); render(); }
    });
    $("onb-skip").addEventListener("click", finish);
    $("onboard").addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); finish(); return; }
      root.Modal.trap($("onboard"), ev);
    });
  }

  root.Onboarding = { STEPS, shouldShow, markDone, nextStep, isLast, show, maybeShow, init };
})(window);
