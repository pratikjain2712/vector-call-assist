'use strict';
/* Scripts tab of the admin app (web/admin.html). Hosts the script editor (web/js/script-editor.js), which
   was its own page (script-editor.html, now a redirect to admin.html#scripts). The editor keeps its working
   copy while other tabs are open; leaving the page with unsaved changes asks first. */
(function () {
  const S = window.VectorAdminShared;
  const E = window.VectorScriptEditor;

  // The browser's own "Leave site?" question while the editor has unsaved changes.
  function onLeave(e) {
    if (!E.hasUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  }

  S.registerTab({
    id: 'scripts',
    label: 'Scripts',
    mount(box, ctx) {
      window.addEventListener('beforeunload', onLeave);
      E.mount(box, ctx);
    },
    unmount() {
      window.removeEventListener('beforeunload', onLeave);
      E.unmount();
    },
  });
})();
