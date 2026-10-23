/* Converts a rep's published script (the steps list in script_versions.steps, written by the admin editor
   in web/js/script-model.js) into the FLOW shape the call page walks (web/js/main.js). Pure functions only:
   no DOM, no network. Loads as window.ScriptAdapter in the browser and as module.exports in Node
   (tests/web/script-adapter.test.js).

   Saved step:  { id, title?, start?, stage?, say: [lines], tip?, opts: [{ label, to }] }   no opts = end card
   FLOW node:   { stage, say: [lines], tip?, opts: [{ k: yes|no|maybe|next, hint, to }] }
   FLOW end:    { end: { tone, label, note, result? } }   result: the ending's result key, when the step names one

   adaptSteps returns null, and never throws, when the script cannot be shown exactly as saved. The call page
   then keeps its built-in script. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScriptAdapter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KINDS = ['yes', 'no', 'maybe', 'next'];
  const SPARE = ['yes', 'no', 'maybe'];
  const MAX_OPTS = 3;
  const MAX_STAGE = 5;   // last index of STAGES in web/js/main.js ("Close")

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

  // The id of the one step marked start, or null when there is not exactly one.
  function startStepId(savedSteps) {
    if (!Array.isArray(savedSteps)) return null;
    const starts = savedSteps.filter((s) => isObj(s) && s.start === true);
    return starts.length === 1 && typeof starts[0].id === 'string' && starts[0].id ? starts[0].id : null;
  }

  // The k for each option label. A single option is next. Otherwise a label that names yes, no, maybe or
  // next (any case) takes that k, and the other labels take the unused yes, no, maybe in order.
  // Returns null if a label cannot be given a k.
  function kindsFor(labels) {
    if (labels.length === 1) return ['next'];
    const out = labels.map(() => null);
    const used = new Set();
    labels.forEach((label, i) => {
      const low = label.toLowerCase();
      if (KINDS.includes(low) && !used.has(low)) { out[i] = low; used.add(low); }
    });
    const spare = SPARE.filter((k) => !used.has(k));
    out.forEach((k, i) => { if (k === null) out[i] = spare.length ? spare.shift() : null; });
    return out.every((k) => k !== null) ? out : null;
  }

  function convert(savedSteps) {
    if (!Array.isArray(savedSteps) || savedSteps.length === 0) return null;

    const ids = new Set();
    for (const s of savedSteps) {
      if (!isObj(s) || typeof s.id !== 'string' || !s.id) return null;   // missing id
      if (ids.has(s.id)) return null;                                     // duplicate id
      ids.add(s.id);
    }
    const start = startStepId(savedSteps);
    if (!start) return null;

    // Object.create(null): a step id such as "__proto__" or "constructor" is an ordinary key here.
    const flow = Object.create(null);
    let stage = 0;
    for (const s of savedSteps) {
      if (s.stage !== undefined) {
        if (!Number.isInteger(s.stage) || s.stage < 0 || s.stage > MAX_STAGE) return null;
        stage = s.stage;
      }   // otherwise the step inherits the stage of the step before it in the list

      if (s.opts === undefined || (Array.isArray(s.opts) && s.opts.length === 0)) {
        flow[s.id] = { end: { tone: 'neutral', label: trimmed(s.title) || s.id, note: '' } };
        // Sprint 9: the result key the ending saves (a key of the script's call type), for the result buttons.
        if (trimmed(s.result)) flow[s.id].end.result = trimmed(s.result);
        continue;
      }
      if (!Array.isArray(s.opts) || s.opts.length > MAX_OPTS) return null;

      const labels = s.opts.map((o) => (isObj(o) ? trimmed(o.label) : ''));
      const targets = s.opts.map((o) => (isObj(o) && typeof o.to === 'string' ? o.to : ''));
      if (labels.some((l) => !l)) return null;
      if (targets.some((t) => !ids.has(t))) return null;   // dangling target

      const say = (Array.isArray(s.say) ? s.say : []).map(trimmed).filter(Boolean);
      if (say.length === 0) return null;
      const kinds = kindsFor(labels);
      if (!kinds) return null;

      const node = {
        stage: stage,
        say: say,
        opts: s.opts.map((o, i) => ({ k: kinds[i], hint: labels[i], to: targets[i] })),
      };
      const tip = trimmed(s.tip);
      if (tip) node.tip = tip;
      flow[s.id] = node;
    }
    return flow;
  }

  /** Saved steps to FLOW, or null when they cannot be shown exactly as saved. */
  function adaptSteps(savedSteps) {
    try { return convert(savedSteps); } catch (e) { return null; }
  }

  return { adaptSteps: adaptSteps, startStepId: startStepId, KINDS: KINDS };
}));
