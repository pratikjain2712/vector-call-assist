'use strict';
/* Calling tab of the admin app (web/admin.html): who to call and what to say, as two views, plus Reports.
   - Calling lists (#calling): js/admin/campaigns.js, shown here as a part (a calling list was a "campaign").
   - Call scripts (#calling/scripts): js/admin/scripts.js, shown here as a part.
   - Reports (#calling/reports): js/admin/reports.js, the same report code as Today's Reports.
   The params of the address go to the view (#calling?id=<list>, #calling/scripts?edit=<script>, …). */
(function () {
  const S = window.VectorAdminShared;
  const el = S.el;
  const $ = (id) => document.getElementById(id);
  const VIEWS = [
    { id: 'lists', sub: null, label: 'Calling lists', part: 'campaigns' },
    { id: 'scripts', sub: 'scripts', label: 'Call scripts', part: 'scripts' },
    { id: 'reports', sub: 'reports', label: 'Reports', part: 'reports' },
  ];

  let ctx = null;

  function build(box) {
    box.appendChild(el('div', { className: 'tab-head' }, [
      el('h1', { id: 'calling-title', text: 'Calling' }),
      el('p', { className: 'muted', text: 'Who your callers call, and what they say.' }),
    ]));
    box.appendChild(el('nav', { className: 'subnav', 'aria-label': 'Calling' }, VIEWS.map((v) =>
      el('a', { href: '#calling' + (v.sub ? '/' + v.sub : ''), id: 'calling-view-' + v.id, 'data-view': v.id, text: v.label }))));
    VIEWS.forEach((v) => box.appendChild(el('div', { id: 'calling-' + v.id, className: 'calling-view', hidden: true })));
  }

  function showView(sub, params) {
    const view = VIEWS.find((v) => v.sub === (sub || null)) || VIEWS[0];
    VIEWS.forEach((v) => {
      $('calling-' + v.id).hidden = v !== view;
      const a = $('calling-view-' + v.id);
      if (v === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    ctx.part(view.part, $('calling-' + view.id));
    if (view.part === 'reports') {
      const rep = S.tab('reports');
      if (rep && typeof rep.setMode === 'function') rep.setMode('calls', 'calling');
    }
    ctx.showPart(view.part, params || {});
  }

  S.registerTab({
    id: 'calling',
    label: 'Calling',
    mount(box, c) {
      ctx = c;
      build(box);
    },
    show(params, sub) { if (ctx) showView(sub, params); },
    unmount() { ctx = null; },
  });
})();
