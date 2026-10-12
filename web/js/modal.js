/* Keeps Tab focus inside an open dialog. Used by the feedback, walkthrough and still-there dialogs. */
(function (root) {
  const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

  /* Call from a keydown listener on the dialog. Wraps Tab and Shift+Tab at the ends. */
  function trap(container, ev) {
    if (ev.key !== "Tab") return;
    const items = Array.from(container.querySelectorAll(FOCUSABLE)).filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const last = items.length - 1;
    if (ev.shiftKey && i <= 0) { ev.preventDefault(); items[last].focus(); }
    else if (!ev.shiftKey && (i === -1 || i === last)) { ev.preventDefault(); items[0].focus(); }
  }

  root.Modal = { trap };
})(window);
