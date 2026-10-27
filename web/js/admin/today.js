'use strict';
/* Today tab of the admin app (web/admin.html): what an owner or manager looks at first.
   - Autopilot (js/admin/autopilot.js, docs/autopilot-plan.md): three numbers against the goals, "Needs your OK"
     (at most 3 cards) and "Vector did for you". The panels below are under a closed "Details"; on a database
     without Autopilot Today is as before (Details open, no summary line).
   - A first-run checklist for owners (Import students and fees, Fill common answers (n of 5), Add a caller,
     Start a calling list from a template, Connect WhatsApp), worked out from real data, hidden when everything is
     done or when the owner closes it (remembered in this browser).
   - The day's numbers, callers right now, what needs attention and calling-list progress: js/admin/home.js,
     shown here as a part. It refreshes itself every minute.
   - "This week in 4 lines" and the forecast with "What closes the gap" / "Apply plan": js/admin/insights.js,
     shown here as a part; the rest of the old Insights tab is under "More analysis", closed by default.
   - Reports (call results, weekly summary, enquiry to admission, why calls are lost) open as a sub-view,
     #today/reports, with the same report code as Calling (js/admin/reports.js).
   Routes: #today, #today?more=1 (More analysis open), #today?campaign=<id>, #today/reports?report=…
   Reads for the checklist: admin_fees_ledger (has_ledger), my_common_answers, admin_seat_list,
   admin_campaign_list, admin_whatsapp_overview. Each is optional: an item whose answer cannot be read is left out.
   The pure helpers below are also loaded by tests/web/admin-today.test.js (Node, no DOM). */
(function () {
  const S = (typeof window !== 'undefined' && window.VectorAdminShared) || require('./shared.js');

  // ---------- pure helpers ----------

  const CHECKLIST_KEY = 'vector-admin-checklist-closed';

  // The checklist from what the server said. Each input may be null (not known: that item is left out).
  //   ledger     admin_fees_ledger answer (has_ledger: the institute has students)
  //   answers    my_common_answers rows (the ones with a "check" list need the institute's facts)
  //   seats      admin_seat_list rows
  //   campaigns  admin_campaign_list rows
  //   whatsapp   admin_whatsapp_overview answer
  // Returns [{ key, text, done, href, link }] in a fixed order.
  function checklistItems(d) {
    const x = d || {};
    const out = [];
    if (x.ledger) {
      out.push({ key: 'students', text: 'Import students and fees', done: !!x.ledger.has_ledger, href: '#fees', link: 'Import' });
    }
    if (Array.isArray(x.answers)) {
      const need = x.answers.filter((r) => Array.isArray(r.check) && r.check.length > 0);
      const filled = need.filter((r) => r.filled).length;
      out.push({ key: 'answers', text: 'Fill common answers (' + filled + ' of ' + need.length + ')',
        done: need.length > 0 && filled === need.length, href: '#settings', link: 'Fill in' });
    }
    if (Array.isArray(x.seats)) {
      const caller = x.seats.some((s) => s.status !== 'revoked' && (s.role === 'rep' || s.access_role === 'caller'));
      out.push({ key: 'caller', text: 'Add a caller', done: caller, href: '#team', link: 'Add' });
    }
    if (Array.isArray(x.campaigns)) {
      const started = x.campaigns.some((c) => c.status !== 'draft' && !!(c.script_name || c.script_id));
      out.push({ key: 'list', text: 'Start a calling list from a template', done: started, href: '#calling/scripts?new=pick', link: 'Start' });
    }
    if (x.whatsapp) {
      const acc = x.whatsapp.account;
      out.push({ key: 'whatsapp', text: 'Connect WhatsApp', done: !!(acc && acc.status === 'connected'), href: '#settings', link: 'Connect' });
    }
    return out;
  }

  // Whether to show the checklist: an owner, something left to do, and not closed.
  const showChecklist = (items, closed) => !closed && (items || []).some((i) => !i.done);

  const helpers = { CHECKLIST_KEY, checklistItems, showChecklist };
  if (typeof module !== 'undefined' && module.exports) { module.exports = helpers; return; }

  // ---------- the tab (browser only) ----------

  const el = S.el;
  const $ = (id) => document.getElementById(id);
  const storeKey = () => CHECKLIST_KEY + ':' + String((ctx && ctx.email) || '').toLowerCase();
  const closedGet = () => { try { return localStorage.getItem(storeKey()) === '1'; } catch (err) { return false; } };
  const closedSet = () => { try { localStorage.setItem(storeKey(), '1'); } catch (err) { /* only a convenience */ } };

  let ctx = null;
  let checkSeq = 0;
  let pilot = null;        // VectorAutopilot.today(...)
  let apMissing = false;   // the database has no Autopilot functions

  function build(box) {
    box.appendChild(el('div', { className: 'tab-head today-head' }, [
      el('div', null, [
        el('h1', { id: 'today-title', text: 'Today' }),
        el('p', { className: 'muted', id: 'today-sub', text: 'Live numbers from all callers.' }),
        // Collect fee (js/admin/collect.js): what this person recorded today and this month.
        el('p', { className: 'today-me', id: 'today-me', hidden: true }),
      ]),
      el('div', { className: 'today-head-acts' }, [
        el('a', { href: '#fees/collect', id: 'today-collect', className: 'button-link primary collect-open', text: 'Collect fee', hidden: true }),
        el('a', { href: '#today/reports', id: 'today-reports-open', className: 'button-link', text: 'Reports' }),
      ]),
    ]));
    const main = el('div', { id: 'today-main', className: 'today-main' }, [
      // Autopilot (js/admin/autopilot.js): the three numbers, Needs your OK, Vector did for you.
      el('section', { id: 'today-numbers', className: 'today-numbers', hidden: true, 'aria-label': 'Your numbers' }),
      el('section', { className: 'panel ap-ok', id: 'today-ok', hidden: true, 'aria-labelledby': 'today-ok-title' }, [
        el('h2', { id: 'today-ok-title' }, ['Needs your OK ', el('span', { className: 'ap-count' })]),
        el('ul', { className: 'plain ap-cards', id: 'today-ok-list' }),
        el('p', { className: 'muted ap-empty', id: 'today-ok-empty', text: 'Nothing needs your OK right now.' }),
        el('p', { className: 'msg', id: 'today-ap-msg', role: 'status' }),
      ]),
      el('section', { className: 'panel ap-did', id: 'today-did', hidden: true, 'aria-labelledby': 'today-did-title' }, [
        el('h2', { id: 'today-did-title', text: 'Vector did for you' }),
        el('ul', { className: 'plain ap-feed', id: 'today-did-list' }),
      ]),
      // Getting started stays until setup is done (below the decisions: it is not urgent).
      el('section', { className: 'panel today-check', id: 'today-checklist', hidden: true, 'aria-labelledby': 'today-check-title' }, [
        el('div', { className: 'row between' }, [
          el('h2', { id: 'today-check-title', text: 'Getting started' }),
          el('button', { type: 'button', id: 'today-check-close', className: 'linkish', text: 'Hide' }),
        ]),
        el('ol', { id: 'today-check-list', className: 'plain today-check-list' }),
      ]),
      // The detailed panels: callers right now, calling-list progress, the forecast and More analysis. Closed while
      // Autopilot is on the page; open (as before) on a database without it.
      el('details', { id: 'today-details', className: 'today-details' }, [
        el('summary', { id: 'today-details-summary', text: 'Details' }),
        el('div', { id: 'today-home' }),
        el('div', { id: 'today-insights' }),
      ]),
    ]);
    box.appendChild(main);
    box.appendChild(el('div', { id: 'today-reports', hidden: true }, [
      el('p', { className: 'back' }, [el('a', { href: '#today', id: 'today-reports-back', text: '← Back to Today' })]),
      el('div', { id: 'today-reports-host' }),
    ]));
    $('today-check-close').addEventListener('click', () => { closedSet(); $('today-checklist').hidden = true; if (pilot) pilot.render(); });
    $('today-details').addEventListener('toggle', () => { if ($('today-details').open) ctx.showPart('home', {}); });
  }

  // Autopilot on Today. Without its functions (an older database) Today is as before: Details open.
  function startAutopilot() {
    const AP = window.VectorAutopilot;
    if (!AP || apMissing) { noAutopilot(); return; }
    if (!pilot) {
      pilot = AP.today({ numbers: $('today-numbers'), ok: $('today-ok'), did: $('today-did'), msg: $('today-ap-msg') }, ctx, {
        onMissing: noAutopilot,
        // The Getting started list already says what setup is left.
        skipKinds: () => ($('today-checklist').hidden ? [] : ['setup_gaps']),
      });
    }
    $('today-ok').hidden = false;
    pilot.load();
  }
  function noAutopilot() {
    apMissing = true;
    $('today-numbers').hidden = true;
    $('today-ok').hidden = true;
    $('today-did').hidden = true;
    $('today-details').open = true;
    $('today-details').classList.add('flat');
  }

  // The checklist: owners only, from real data, every time Today opens (cheap reads).
  async function loadChecklist() {
    if (S.seatKind(ctx.seat) !== 'owner' || closedGet()) { $('today-checklist').hidden = true; if (pilot) pilot.render(); return; }
    const mine = ++checkSeq;
    const ask = (p) => p.then((v) => v, () => null);
    const range = S.monthToDate(new Date());
    const [ledger, answers, seats, campaigns, whatsapp] = await Promise.all([
      ask(ctx.rpc('admin_fees_ledger', { p_institute: ctx.institute.id, p_from: range.from, p_to: range.to, p_campaign: null, p_seat: null })),
      ask(ctx.rpc('my_common_answers')),
      ask(ctx.rpc('admin_seat_list', { p_institute: ctx.institute.id })),
      ask(ctx.rpc('admin_campaign_list')),
      ask(ctx.rpc('admin_whatsapp_overview')),
    ]);
    if (mine !== checkSeq || !ctx) return;
    const items = checklistItems({ ledger, answers, seats, campaigns, whatsapp });
    const list = $('today-check-list');
    list.textContent = '';
    items.forEach((it) => {
      list.appendChild(el('li', { className: 'today-check-item' + (it.done ? ' done' : ''), 'data-key': it.key }, [
        el('span', { className: 'today-check-mark', 'aria-hidden': 'true', text: it.done ? '✓' : '' }),
        el('span', { className: 'today-check-text', text: it.text }),
        el('span', { className: 'sr-only', text: it.done ? ' (done)' : ' (to do)' }),
        it.done ? null : el('a', { href: it.href, className: 'today-check-link', text: it.link, 'aria-label': it.link + ': ' + it.text }),
      ]));
    });
    $('today-checklist').hidden = !showChecklist(items, false);
    if (pilot) pilot.render();
  }

  function showMain(params) {
    $('today-main').hidden = false;
    $('today-reports').hidden = true;
    $('today-reports-open').hidden = false;
    $('today-title').textContent = 'Today';
    ctx.part('home', $('today-home'));
    ctx.part('insights', $('today-insights'));
    ctx.showPart('home', {});
    ctx.showPart('insights', params);
    // An old link to More analysis (#today?more=1, #insights) opens Details too.
    if (params && (params.more || params.campaign)) $('today-details').open = true;
    loadChecklist();
    startAutopilot();
    loadCollect();
  }

  // Who records payments and has Today (the owner, a manager who can see money): "Collect fee" and "By you today
  // ₹ · this month ₹".
  async function loadCollect() {
    const on = S.canCollect(ctx.seat, ctx.canSeeMoney) && ctx.canSeeMoney && S.tabsFor(ctx.seat, ctx.canSeeMoney).includes('fees');
    $('today-collect').hidden = !on;
    if (!on) { $('today-me').hidden = true; return; }
    try {
      const me = await ctx.rpc('collected_by_me');
      if (!ctx) return;
      const CO = window.VectorCollect;
      $('today-me').textContent = me && CO ? CO.meLine(me) : '';
      $('today-me').hidden = !(me && CO);
    } catch (err) {
      if (ctx) $('today-me').hidden = true;
    }
  }

  function showReports(params) {
    $('today-main').hidden = true;
    $('today-reports').hidden = false;
    $('today-reports-open').hidden = true;
    $('today-title').textContent = 'Reports';
    ctx.part('reports', $('today-reports-host'));
    const rep = S.tab('reports');
    if (rep && typeof rep.setMode === 'function') rep.setMode('calls', 'today');
    ctx.showPart('reports', params);
  }

  S.registerTab({
    id: 'today',
    label: 'Today',
    mount(box, c) {
      ctx = c;
      build(box);
    },
    show(params, sub) {
      if (!ctx) return;
      if (sub === 'reports') showReports(params || {});
      else showMain(params || {});
    },
    unmount() { ctx = null; checkSeq++; pilot = null; apMissing = false; },
  });
})();
