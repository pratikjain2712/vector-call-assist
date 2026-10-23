'use strict';
/* Home tab of the admin app (web/admin.html): today's numbers, callers right now, what needs attention and
   campaign progress (docs/phase-a-plan.md, Sprint 10). Not built yet: shows a short note.
   Fill mount() and unmount(); styles go in web/css/admin-home.css. ₹ only when ctx.canSeeMoney. */
(function () {
  const S = window.VectorAdminShared;

  S.registerTab({
    id: 'home',
    label: 'Home',
    mount(box) {
      S.placeholder(box, 'Today', 'Here you will see today\'s calls, who is calling right now and what needs your attention.');
    },
    unmount() {},
  });
})();
