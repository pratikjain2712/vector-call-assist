/* Script model for the admin script editor (web/script-editor.html), for Vector 2.0.
   Pure functions only: no DOM and no network. Loads as window.ScriptModel in the browser and as
   module.exports in Node (tests/web/script-model.test.js).

   Saved format (the steps list in script_versions.steps):
     { id: "open", title: "Opening", start: true, say: ["Hi {name}, {me} here."], tip: "Smile first.",
       opts: [{ label: "Yes", to: "discovery" }, { label: "No", to: "close" }] }
   A step with no opts is an end card. A call starts at a step marked start. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScriptModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
  const MAX_CHANGE_NOTE = 500;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const listOf = (v) => (Array.isArray(v) ? v : []);
  const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

  function findStep(steps, id) {
    return listOf(steps).find((s) => isObj(s) && s.id === id) || null;
  }

  // Text from a textarea: one line per entry, trimmed, blank lines dropped.
  function splitLines(s) {
    return String(s == null ? '' : s).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  }

  // Returns a list of problems in English, for the editor to show. An empty list means the script is valid.
  function validateSteps(steps) {
    if (!Array.isArray(steps)) return ['The script must be a list of steps.'];
    if (steps.length === 0) return ['Add at least one step.'];
    const errs = [];
    const ids = new Set(steps.filter(isObj).map((s) => s.id).filter((id) => typeof id === 'string' && id));
    const seen = new Set();
    const reported = new Set();
    let hasStart = false;

    steps.forEach((s, i) => {
      if (!isObj(s)) { errs.push('Step ' + (i + 1) + ' is not a step.'); return; }
      const id = typeof s.id === 'string' ? s.id : '';
      const name = id ? 'Step "' + id + '"' : 'Step ' + (i + 1);
      if (!id) errs.push(name + ' has no id.');
      else if (!ID_RE.test(id)) errs.push('Step id "' + id + '" may use only letters, digits, "_" and "-" (40 characters at most).');
      if (id) {
        if (seen.has(id)) {
          if (!reported.has(id)) { reported.add(id); errs.push('Step id "' + id + '" is used more than once.'); }
        } else seen.add(id);
      }
      if (s.start === true) hasStart = true;

      const says = Array.isArray(s.say) ? s.say.map(trimmed).filter(Boolean) : [];
      if (says.length === 0) errs.push(name + ' has nothing to say.');

      if (s.opts !== undefined && !Array.isArray(s.opts)) { errs.push(name + ' has malformed options.'); return; }
      const labels = new Set();
      listOf(s.opts).forEach((o) => {
        const label = isObj(o) ? trimmed(o.label) : '';
        const to = isObj(o) && typeof o.to === 'string' ? o.to : '';
        if (!label) errs.push(name + ' has an option with no label.');
        if (label && labels.has(label)) errs.push(name + ' has two options labelled "' + label + '".');
        if (label) labels.add(label);
        if (!to || !ids.has(to)) {
          errs.push(name + ': the option "' + (label || '(no label)') + '" goes to "' + (to || '(nothing)') + '", which is not a step.');
        }
      });
    });

    if (!hasStart) errs.push('Mark at least one step as the start.');
    return errs;
  }

  // The lines a rep would see for the steps walked in `path` (a list of step ids).
  function renderPreview(steps, path) {
    const lines = [];
    listOf(path).forEach((id) => {
      const s = findStep(steps, id);
      if (!s) { lines.push('(step "' + id + '" is missing)'); return; }
      listOf(s.say).map(trimmed).filter(Boolean).forEach((l) => lines.push(l));
      if (trimmed(s.tip)) lines.push('Tip: ' + trimmed(s.tip));
      const labels = listOf(s.opts).map((o) => trimmed(isObj(o) ? o.label : '')).filter(Boolean);
      lines.push(labels.length ? 'Choices: ' + labels.join(' / ') : 'End of call');
    });
    return lines;
  }

  // Walks the script from its first start step. `choices` is the list of option labels picked so far.
  // status:
  //   'end'            reached a step with no options
  //   'unfinished'     ran out of choices at a step with options; `options` lists them
  //   'loop'           a choice led back to a step already on the path (path ends with the repeated id)
  //   'dead_end'       a choice leads to a step id that does not exist; `missing` is that id
  //   'invalid_choice' a choice is not an option of the current step
  //   'no_start'       no step is marked as the start
  function testRun(steps, choices) {
    const list = listOf(steps);
    const picks = listOf(choices);
    const start = list.find((s) => isObj(s) && s.start === true);
    const result = (path, status, current, options, missing) =>
      ({ path: path.slice(), status, current, options, missing });
    if (!start) return result([], 'no_start', null, [], null);

    const path = [start.id];
    const visited = new Set(path);
    let i = 0;
    for (;;) {
      const cur = findStep(list, path[path.length - 1]);
      const opts = listOf(cur.opts).filter(isObj);
      const labels = opts.map((o) => trimmed(o.label));
      if (opts.length === 0) return result(path, 'end', null, [], null);
      if (i >= picks.length) return result(path, 'unfinished', cur.id, labels, null);

      const pick = picks[i++];
      const opt = opts.find((o) => trimmed(o.label) === pick);
      if (!opt) return result(path, 'invalid_choice', cur.id, labels, null);
      if (!findStep(list, opt.to)) return result(path, 'dead_end', cur.id, [], opt.to === undefined ? null : opt.to);

      path.push(opt.to);
      if (visited.has(opt.to)) return result(path, 'loop', null, [], null);
      visited.add(opt.to);
    }
  }

  // Keys sorted at every level, so two step objects compare equal when their content is equal.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (isObj(v)) {
      return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  function byId(steps) {
    const m = new Map();
    listOf(steps).forEach((s) => { if (isObj(s) && typeof s.id === 'string') m.set(s.id, canon(s)); });
    return m;
  }

  // What changed from version a to version b, by step id. Each list is sorted.
  // changed: the step is in both versions but its content differs (text, tip, options or their order).
  function diffVersions(a, b) {
    const A = byId(a);
    const B = byId(b);
    const added = [];
    const removed = [];
    const changed = [];
    B.forEach((v, id) => {
      if (!A.has(id)) added.push(id);
      else if (A.get(id) !== v) changed.push(id);
    });
    A.forEach((v, id) => { if (!B.has(id)) removed.push(id); });
    return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
  }

  // A report range from two 'YYYY-MM-DD' dates (both days included), as [from, to) ISO instants in the
  // browser's local time. Throws an Error with a message for the page when the range is not usable.
  const MAX_REPORT_DAYS = 400;
  function reportRange(fromYmd, toYmd) {
    const parse = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
      if (!m) return null;
      const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
      const dt = new Date(y, mo, d);
      return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d ? dt : null;
    };
    const a = parse(fromYmd);
    const b = parse(toYmd);
    if (!a || !b) throw new Error('Pick both dates.');
    if (b < a) throw new Error('The to date is before the from date.');
    if (Math.round((b - a) / 86400000) + 1 > MAX_REPORT_DAYS) throw new Error('Choose a range of ' + MAX_REPORT_DAYS + ' days or less.');
    return {
      from: a.toISOString(),
      to: new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1).toISOString(),
    };
  }

  return { ID_RE, MAX_CHANGE_NOTE, MAX_REPORT_DAYS, splitLines, validateSteps, renderPreview, testRun, diffVersions, reportRange };
}));
