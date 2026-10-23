'use strict';
/* Campaigns tab of the admin app (web/admin.html): the campaign list and "New campaign" (details, script,
   leads, callers), pause and close (docs/phase-a-plan.md, Sprint 8). Not built yet: shows a short note.
   Fill mount() and unmount(); styles go in web/css/admin-campaigns.css. ₹ only when ctx.canSeeMoney. */
(function () {
  const S = window.VectorAdminShared;

  S.registerTab({
    id: 'campaigns',
    label: 'Campaigns',
    mount(box) {
      S.placeholder(box, 'Campaigns', 'Here you will start a calling campaign: pick a script, add the people to call and share them between your callers.');
    },
    unmount() {},
  });
})();
