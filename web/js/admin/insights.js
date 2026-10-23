'use strict';
/* Insights tab of the admin app (web/admin.html): forecast, best time to call, where calls end, coaching and
   the weekly brief (docs/phase-a-plan.md, Sprint 11). Not built yet: shows a short note.
   Fill mount() and unmount(); styles go in web/css/admin-insights.css. ₹ only when ctx.canSeeMoney. */
(function () {
  const S = window.VectorAdminShared;

  S.registerTab({
    id: 'insights',
    label: 'Insights',
    mount(box) {
      S.placeholder(box, 'Insights', 'Here you will see whether each campaign will reach its target, the best time to call, and tips for each caller.');
    },
    unmount() {},
  });
})();
