/* Script model for the admin script editor (web/script-editor.html), for Vector 2.0.
   Pure functions only: no DOM and no network. Loads as window.ScriptModel in the browser and as
   module.exports in Node (tests/web/script-model.test.js).

   Saved format (the steps list in script_versions.steps):
     { id: "open", title: "Opening", start: true, say: ["Hi {name}, {me} here."], tip: "Smile first.",
       opts: [{ label: "Yes", to: "discovery" }, { label: "No", to: "close" }] }
   A step with no opts is an end card. A call starts at a step marked start.
   Since Sprint 9 (migration 20261024100022):
     an end card names the result it saves, a key of the script's call type: { id: "paid", say: [...], result: "paid" }
     a step or pushback may carry "Check this" marks, notes a person must check before publishing:
       { ..., check: ["Is the fee ₹18,000?"] }   (a version with any mark cannot be published)
   Pushback answers are saved with each version (script_versions.pushbacks): [{ label, answer, check? }].
   A script as a whole (templates, AI drafts): { name, call_type, steps, pushbacks }. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScriptModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
  const MAX_CHANGE_NOTE = 500;
  const MAX_OPTS = 3;               // the call page shows at most 3 choices (web/js/script-adapter.js)
  const MAX_PUSHBACKS = 12;         // same limits as script_pushbacks_problem in the migration
  const PUSHBACK_LABEL_MAX = 60;
  const PUSHBACK_ANSWER_MAX = 600;

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

  // A step with no options is an end card (an ending of the call).
  const isEnding = (s) => isObj(s) && (s.opts === undefined || (Array.isArray(s.opts) && s.opts.length === 0));

  // The "Check this" marks of a step or pushback: trimmed, blank ones dropped.
  const marksOf = (item) => (isObj(item) && Array.isArray(item.check) ? item.check.map(trimmed).filter(Boolean) : []);

  // Returns a list of problems in English, for the editor to show. An empty list means the script is valid.
  // options.resultKeys: the result keys of the script's call type. When given, every ending must name one
  // of them in its "result". "Check this" marks are listed as problems, so a marked script cannot be published.
  function validateSteps(steps, options) {
    const resultKeys = options && Array.isArray(options.resultKeys) ? options.resultKeys : null;
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

      marksOf(s).forEach((m) => errs.push('Check this (' + (id ? 'step "' + id + '"' : 'step ' + (i + 1)) + '): ' + m));

      if (s.opts !== undefined && !Array.isArray(s.opts)) { errs.push(name + ' has malformed options.'); return; }
      if (s.opts !== undefined && s.opts.length > MAX_OPTS) {
        errs.push(name + ' has more than ' + MAX_OPTS + ' options. Callers can pick from ' + MAX_OPTS + ' at most.');
      }
      if (resultKeys && isEnding(s)) {
        const result = trimmed(s.result);
        const end = 'The ending "' + (trimmed(s.title) || id || String(i + 1)) + '"';
        if (!result) errs.push(end + ' is not linked to a result.');
        else if (!resultKeys.includes(result)) errs.push(end + ' is linked to "' + result + '", which is not a result of this call type.');
      }
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

  // Problems with a pushback list ([{ label, answer, check? }]), in English. Same rules as the database.
  function validatePushbacks(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) return ['Pushback answers must be a list.'];
    const errs = [];
    if (list.length > MAX_PUSHBACKS) errs.push('Keep to ' + MAX_PUSHBACKS + ' pushback answers or fewer.');
    const seen = new Set();
    list.forEach((p, i) => {
      const label = isObj(p) ? trimmed(p.label) : '';
      const answer = isObj(p) ? trimmed(p.answer) : '';
      const name = label ? 'The pushback "' + label + '"' : 'Pushback ' + (i + 1);
      if (!label) errs.push(name + ' has no label.');
      else if (label.length > PUSHBACK_LABEL_MAX) errs.push(name + ' has a label longer than ' + PUSHBACK_LABEL_MAX + ' characters.');
      if (!answer) errs.push(name + ' has no answer.');
      else if (answer.length > PUSHBACK_ANSWER_MAX) errs.push(name + ' has an answer longer than ' + PUSHBACK_ANSWER_MAX + ' characters.');
      if (label && seen.has(label.toLowerCase())) errs.push('Two pushbacks are labelled "' + label + '".');
      if (label) seen.add(label.toLowerCase());
      marksOf(p).forEach((m) => errs.push('Check this (' + (label ? 'pushback "' + label + '"' : 'pushback ' + (i + 1)) + '): ' + m));
    });
    return errs;
  }

  // Steps and pushbacks of a whole script ({ steps, pushbacks }) together. Used by the editor and by the AI
  // script maker (supabase/functions/ai-script-draft), so a draft is checked exactly like a script by hand.
  function validateScript(script, options) {
    if (!isObj(script)) return ['The script must be an object with steps.'];
    return validateSteps(script.steps, options).concat(validatePushbacks(script.pushbacks));
  }

  // Every "Check this" mark in a script, in order: { where: 'step' | 'pushback', index, name, text }.
  function checkMarks(script) {
    const out = [];
    listOf(isObj(script) ? script.steps : null).forEach((s, i) => marksOf(s).forEach((text) =>
      out.push({ where: 'step', index: i, name: trimmed(s.title) || trimmed(s.id), text })));
    listOf(isObj(script) ? script.pushbacks : null).forEach((p, i) => marksOf(p).forEach((text) =>
      out.push({ where: 'pushback', index: i, name: trimmed(p.label), text })));
    return out;
  }

  // The end cards of a step list.
  function endings(steps) { return listOf(steps).filter(isEnding); }

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

  return {
    ID_RE, MAX_CHANGE_NOTE, MAX_REPORT_DAYS, MAX_OPTS, MAX_PUSHBACKS, PUSHBACK_LABEL_MAX, PUSHBACK_ANSWER_MAX,
    splitLines, validateSteps, validatePushbacks, validateScript, checkMarks, endings, isEnding,
    renderPreview, testRun, diffVersions, reportRange,
  };
}));
