// ai-script-draft logic (logic.mjs): the AI script maker's prompt, model calls, safety checks and request flow, in plain
// JavaScript (no Deno APIs) so tests/web/ai-script-draft.test.js can run it in Node with fetch mocked.
// index.ts is the thin Deno wrapper: it reads the request and the env, makes the Supabase clients and calls
// handle() below.
//
// What a request does (handle):
//   1. The admin's own token: a signed-in user with an active admin seat, and the ai_drafts add-on
//      (has_feature, a trial has everything).
//   2. One request reserved against the monthly limit (ai_reserve_request, service role; 20 drafts a month per
//      institute, "Make simpler" has its own limit of 100).
//   3. The Messages API with the key from the server env (never from the browser). Drafts use the default model
//      (Claude Haiku 5.5); when a draft fails the checks twice, one more try with the fallback (Claude Sonnet 5.5).
//   4. The draft is checked: the same validator as the editor (web/js/script-model.js), a "do not call again"
//      ending, no threats or false urgency (word list and the model's own check), facts only from the form
//      (a number, date or amount not in the form gets a "Check this" mark, which blocks publishing) and an
//      easy-to-read score.
//   5. Tokens, model and cost are written to ai_requests (ai_finish_request).
// The long fixed instructions and the starter templates (the examples) are sent as a cached system prefix.

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const FALLBACK_MODEL = 'claude-sonnet-5-5';
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2026-10-21';
export const EFFORT = 'low';           // drafting is short structured writing; low keeps thinking (output) tokens down
export const MAX_TOKENS = 16000;
export const CALL_TIMEOUT_MS = 90000;

// US dollars per million tokens (Claude API, prompts up to 100K tokens). Cache writes (5-minute) cost 1.25x the
// input price, cache reads 0.1x. Unknown models are priced as the fallback so the log never says 0 by mistake.
export const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
  'claude-sonnet-5-5': { input: 2.00, output: 10.00 },
};

export const LANGUAGES = { simple_english: 'Simple English', hinglish: 'Hinglish', hindi: 'Hindi' };
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const LIMITS = { audience: 60, purpose: 600, facts: 1500, never_say: 600 };

// ---------- small helpers ----------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const lines = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const clone = (x) => JSON.parse(JSON.stringify(x));

export function costUsd(model, usage) {
  const p = PRICES[model] || PRICES[FALLBACK_MODEL];
  const u = usage || {};
  const n = (k) => Math.max(0, Number(u[k]) || 0);
  const usd = (n('input_tokens') * p.input + n('output_tokens') * p.output
    + n('cache_creation_input_tokens') * p.input * 1.25 + n('cache_read_input_tokens') * p.input * 0.1) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

// ---------- the form ----------

// The form from the request body, trimmed and checked. Returns { brief } or { error } in plain English.
export function readBrief(raw) {
  const b = isObj(raw) ? raw : {};
  const brief = {
    call_type: str(b.call_type),
    audience: str(b.audience),
    language: str(b.language) || 'simple_english',
    purpose: str(b.purpose),
    facts: str(b.facts),
    never_say: str(b.never_say),
  };
  if (!KEY_RE.test(brief.call_type)) return { error: 'Choose the call type.' };
  if (!LANGUAGES[brief.language]) return { error: 'Choose Simple English, Hinglish or Hindi.' };
  if (!brief.audience) return { error: 'Say who you call.' };
  if (!brief.purpose) return { error: 'Say what the call is for.' };
  for (const k of Object.keys(LIMITS)) {
    if (brief[k].length > LIMITS[k]) return { error: 'Keep "' + k.replace('_', ' ') + '" to ' + LIMITS[k] + ' characters.' };
  }
  return { brief };
}

// ---------- the prompt ----------

export const INSTRUCTIONS = [
  'You write phone call scripts for callers at Indian schools, coaching centres and colleges. The callers are',
  'office staff, not trained sales people. They read your lines aloud on a real call, so every line must be',
  'short, polite and easy to say. The institute admin checks and edits your draft before any caller uses it.',
  '',
  'How a script works',
  '- A script is a list of steps. A call starts at the first step.',
  '- Each step has: id (lowercase letters, digits, "_" or "-", unique), title (2 to 4 words), stage (0 Opening,',
  '  1 Discovery, 2 Pitch, 3 Timings, 4 Fee, 5 Close), say (1 to 3 lines the caller reads), tip (a short hint',
  '  for the caller, or ""), opts (what the other person answers, at most 3, each {label, to} where to is the id',
  '  of another step), result (see endings) and check (see facts).',
  '- A step with no opts is an ending. Every ending sets result to one key from the result list in the request.',
  '  A step with opts sets result to "".',
  '- Option labels are what the caller hears back, 1 to 3 words, like "Yes", "Not now", "Already paid".',
  '- Every step must be reachable from the first step. Do not make loops back to an earlier step.',
  '- Use {name} for the person called and {me} for the caller\'s own name. Use no other placeholders.',
  '- Always include an ending with result "do_not_call" that the caller can reach when the person asks not',
  '  to be called again. Its line says sorry for the trouble and that the institute will not call again.',
  '- Also include endings for a wrong person ("wrong_number") and for "call me later" ("call_back_later").',
  '- Pushback answers (pushbacks): 3 to 6 things people often say on this kind of call, each {label, answer,',
  '  check}. label is what the person says (2 to 6 words). answer is what the caller says back (1 or 2 short',
  '  sentences).',
  '',
  'Words',
  '- Write in the language asked for. Simple English: short sentences, common words, Indian English is fine.',
  '  Hinglish: Hindi and English mixed, written in Latin letters, the way people speak on the phone in North',
  '  India. Hindi: simple spoken Hindi in Devanagari, with common English words (fee, form, course) kept as is.',
  '- Hindi and Hinglish: use everyday spoken words, not formal written Hindi ("jama karna", not "dey"). The',
  '  caller may be a man or a woman, so avoid verb forms that show the caller\'s gender where you can',
  '  ("Main {me}, school office se."). Where you cannot, add a check note.',
  '- Most lines have 12 words or fewer. Never more than 20 words in a line.',
  '- Be warm and respectful. Use "please" and "thank you". Listen more than you talk.',
  '',
  'Safety rules (the most important part)',
  '- Facts only from the request. Use only the amounts, dates, numbers, names, places, offers and rules given in',
  '  "What the call is for" and "Facts the caller can use". Never invent a discount, a deadline, a fee, a job',
  '  promise or a result. When a step needs a fact the request does not give, write the line without it and add',
  '  a note to that step\'s check list, like "Add the late fee if there is one."',
  '- If a fact in the request is unclear or needs a person\'s decision, add a check note on the step or',
  '  pushback that uses it, saying what to check. Write check notes in simple English, whatever the language',
  '  of the script: the admin reads them.',
  '- No threats and no pressure: never mention police, court, legal action, a student being removed, results',
  '  held back, shame or "last chance". No false urgency: no "today only", "hurry", "offer ends" or deadlines',
  '  that are not in the facts. A real due date or late fee from the facts may be said calmly, once.',
  '- Follow every "Never say" rule in the request.',
  '- Never ask for bank, card or UPI details, OTPs or passwords on the call.',
  '- Do not say anything about the person\'s caste, religion, health or family problems.',
  '',
  'Your own check (self_check)',
  '- pressure_or_threats: true if any line could sound like a threat or pressure.',
  '- false_urgency: true if any line pushes the person to act fast without a real date from the facts.',
  '- breaks_never_say: true if any line breaks a "Never say" rule.',
  '- facts_not_in_request: every amount, date, number or promise in your draft that is not in the request.',
  '  It should be empty. If it is not, fix the draft.',
  '',
  'Reply with the JSON object only, in the schema given. name is a short name for the script (2 to 5 words).',
].join('\n');

// The fixed system prompt: instructions, then the starter templates as examples. The second block carries the
// cache breakpoint, so both are read from the prompt cache on later requests (5 minutes, refreshed on each hit).
export function systemBlocks(templates) {
  const examples = (templates || []).map((t) => ({
    call_type: t.call_type,
    script: { name: t.name, steps: t.steps, pushbacks: t.pushbacks },
  }));
  return [
    { type: 'text', text: INSTRUCTIONS },
    {
      type: 'text',
      text: 'Examples: three starter scripts in Simple English, written by people. Their check notes show where an '
        + 'institute must add its own facts. Match their tone and length, not their facts.\n\n'
        + JSON.stringify(examples, null, 1),
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// The part of the prompt that changes every request: the call type with its results, and the form.
export function userPrompt(brief, callType, extra) {
  const results = (callType.results || []).map((r) => '- ' + r.key + ': ' + r.label + (r.counts_as_good ? ' (a good result)' : ''));
  const parts = [
    'Write a call script.',
    '',
    'Call type: ' + callType.label + ' (' + callType.key + ')',
    'Result list (every ending uses one of these keys):',
    results.join('\n'),
    '',
    'Who you call: ' + brief.audience,
    'Language: ' + LANGUAGES[brief.language],
    'What the call is for: ' + brief.purpose,
    'Facts the caller can use: ' + (brief.facts || '(none given)'),
    'Never say: ' + (brief.never_say || '(nothing extra)'),
  ];
  if (extra) parts.push('', extra);
  return parts.join('\n');
}

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'stage', 'say', 'tip', 'opts', 'result', 'check'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    stage: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
    say: { type: 'array', items: { type: 'string' } },
    tip: { type: 'string' },
    opts: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['label', 'to'],
        properties: { label: { type: 'string' }, to: { type: 'string' } } },
    },
    result: { type: 'string' },
    check: { type: 'array', items: { type: 'string' } },
  },
};
const PUSHBACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'answer', 'check'],
  properties: { label: { type: 'string' }, answer: { type: 'string' }, check: { type: 'array', items: { type: 'string' } } },
};

// Structured output for a whole script. Fixed for every call type (the result keys are in the prompt and checked
// in code), so the schema never changes the request between institutes.
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'steps', 'pushbacks', 'self_check'],
  properties: {
    name: { type: 'string' },
    steps: { type: 'array', items: STEP_SCHEMA },
    pushbacks: { type: 'array', items: PUSHBACK_SCHEMA },
    self_check: {
      type: 'object',
      additionalProperties: false,
      required: ['pressure_or_threats', 'false_urgency', 'breaks_never_say', 'facts_not_in_request'],
      properties: {
        pressure_or_threats: { type: 'boolean' },
        false_urgency: { type: 'boolean' },
        breaks_never_say: { type: 'boolean' },
        facts_not_in_request: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

// Structured output for "Make simpler" on one line.
export const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};

// ---------- the model call ----------

// One Messages API request. Never throws: returns { ok, value, usage, model, error, retry }.
//   retry false: a request that cannot work by trying again (bad key, bad request).
export async function callModel({ fetchFn, apiKey, model, system, user, schema, effort }) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: effort || EFFORT, format: { type: 'json_schema', schema } },
  };
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetchFn(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined,
    });
  } catch (err) {
    return { ok: false, model, usage: {}, error: 'no connection to the AI service', retry: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
  let out = null;
  try { out = await res.json(); } catch (err) { out = null; }
  if (!res.ok) {
    const type = out && out.error && out.error.type ? out.error.type : 'http_' + res.status;
    // 429 (rate limit), 5xx and overloaded can work on a second try; 400, 401, 403, 404 cannot.
    const retry = res.status === 429 || res.status >= 500;
    return { ok: false, model, usage: {}, error: 'AI service error: ' + type, retry };
  }
  const usage = (out && out.usage) || {};
  if (out && out.stop_reason === 'refusal') return { ok: false, model, usage, error: 'the AI declined this request', retry: true };
  if (out && out.stop_reason === 'max_tokens') return { ok: false, model, usage, error: 'the draft was too long', retry: true };
  const text = ((out && out.content) || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  try {
    return { ok: true, model, usage, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, model, usage, error: 'the AI reply was not a script', retry: true };
  }
}

// ---------- from the model's JSON to a script ----------

// The model's reply in the script-model.js format: blank fields dropped, the first step is the start,
// results only on endings, marks only when there are any.
export function toScript(value, callTypeKey) {
  const v = isObj(value) ? value : {};
  const steps = (Array.isArray(v.steps) ? v.steps : []).filter(isObj).map((s, i) => {
    const step = { id: str(s.id) };
    const title = str(s.title);
    if (title) step.title = title;
    if (i === 0) step.start = true;
    if (Number.isInteger(s.stage) && s.stage >= 0 && s.stage <= 5) step.stage = s.stage;
    step.say = lines(s.say);
    const tip = str(s.tip);
    if (tip) step.tip = tip;
    const opts = (Array.isArray(s.opts) ? s.opts : []).filter(isObj).map((o) => ({ label: str(o.label), to: str(o.to) }));
    if (opts.length) step.opts = opts;
    else if (str(s.result)) step.result = str(s.result);
    const check = lines(s.check);
    if (check.length) step.check = check;
    return step;
  });
  const pushbacks = (Array.isArray(v.pushbacks) ? v.pushbacks : []).filter(isObj).map((p) => {
    const out = { label: str(p.label), answer: str(p.answer) };
    const check = lines(p.check);
    if (check.length) out.check = check;
    return out;
  });
  return { name: str(v.name).slice(0, 120) || 'AI draft', call_type: callTypeKey, steps, pushbacks };
}

// ---------- safety checks ----------

// Words and phrases that sound like a threat, shame or false urgency on a fees, sales or admission call, in
// English, Hinglish and Hindi. Matched as whole words, any case.
export const PRESSURE_WORDS = [
  'police', 'court', 'legal action', 'legal notice', 'lawyer', 'case against', 'file a case', 'blacklist',
  'expel', 'expelled', 'rusticate', 'name will be cut', 'name will be struck', 'removed from', 'thrown out',
  'not allowed to sit', 'withhold', 'held back', 'defaulter', 'shame', 'embarrass', 'or else', 'consequences',
  'last chance', 'final warning', 'final notice', 'act now', 'right now or', 'today only', 'only today',
  'hurry', 'offer ends', 'limited seats left', 'before it is too late', 'you will regret', 'strict action',
  'warna', 'kanooni', 'karyavahi', 'aakhri mauka', 'akhri mauka', 'naam kat', 'nikaal', 'nikal denge', 'sharam',
  'jaldi karo', 'abhi ke abhi',
  'पुलिस', 'कानूनी', 'कार्यवाही', 'वरना', 'आखिरी मौका', 'नाम कट', 'निकाल देंगे', 'शर्म', 'जल्दी करो',
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const PRESSURE_RE = new RegExp('(^|[^\\p{L}\\p{N}])(' + PRESSURE_WORDS.map(escapeRe).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'iu');

// Every line a caller reads or sees in a script, with where it is: { where, index, line, text }.
export function scriptLines(script) {
  const out = [];
  (script.steps || []).forEach((s, i) => {
    (s.say || []).forEach((t, j) => out.push({ where: 'step', index: i, line: j, text: t }));
    if (s.tip) out.push({ where: 'step', index: i, line: 'tip', text: s.tip });
    (s.opts || []).forEach((o) => out.push({ where: 'step', index: i, line: 'option', text: o.label }));
  });
  (script.pushbacks || []).forEach((p, i) => {
    out.push({ where: 'pushback', index: i, line: 'label', text: p.label });
    out.push({ where: 'pushback', index: i, line: 'answer', text: p.answer });
  });
  return out;
}

// The pressure word in a text, or null.
export function pressureWord(text) {
  const m = PRESSURE_RE.exec(String(text || ''));
  return m ? m[2] : null;
}

const DEVANAGARI_DIGITS = '०१२३४५६७८९';
const toAsciiDigits = (s) => String(s || '').replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));

// The numbers in a text, normalised so "₹18,000", "Rs. 18000" and "18000/-" are the same: { raw, value, money }.
export function numbersIn(text) {
  const out = [];
  const re = /(₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)(\s*%)?/giu;
  const t = toAsciiDigits(text);
  let m;
  while ((m = re.exec(t))) {
    const value = m[2].replace(/,/g, '').replace(/\.0+$/, '');
    out.push({ raw: m[0].trim(), value, money: !!m[1] || !!m[3] });
  }
  return out;
}

// Adds a "Check this" mark wherever the draft uses a number, date or amount that is not in the form.
// Small plain counts (0 to 10, not money) are allowed: "two minutes", "Class 10" and the like.
// Returns the number of marks added.
export function markUnknownFacts(script, brief) {
  const known = new Set(numbersIn(brief.purpose + ' \n ' + brief.facts + ' \n ' + brief.audience).map((n) => n.value));
  let added = 0;
  scriptLines(script).forEach((l) => {
    numbersIn(l.text).forEach((n) => {
      if (known.has(n.value)) return;
      if (!n.money && /^\d+$/.test(n.value) && Number(n.value) <= 10) return;
      const item = l.where === 'step' ? script.steps[l.index] : script.pushbacks[l.index];
      const note = '"' + n.raw + '" is not in the facts you gave. Check it or remove it.';
      item.check = item.check || [];
      if (!item.check.includes(note)) { item.check.push(note); added++; }
    });
  });
  return added;
}

// Marks every line with a pressure word. Returns the words found.
export function markPressure(script) {
  const found = [];
  scriptLines(script).forEach((l) => {
    const w = pressureWord(l.text);
    if (!w) return;
    found.push(w);
    const item = l.where === 'step' ? script.steps[l.index] : script.pushbacks[l.index];
    const note = 'This may sound like a threat or pressure ("' + w + '"). Change it.';
    item.check = item.check || [];
    if (!item.check.includes(note)) item.check.push(note);
  });
  return found;
}

// Easy-to-read score from 0 to 100 for the lines a caller says, with a label: shorter sentences and shorter
// words read more easily. long_lines lists lines over 20 words (good candidates for "Make simpler").
export function readingScore(script) {
  const said = [];
  (script.steps || []).forEach((s, i) => (s.say || []).forEach((t, j) => said.push({ step: s.id, index: i, line: j, text: t })));
  (script.pushbacks || []).forEach((p, i) => said.push({ pushback: i, text: p.answer }));
  let sentences = 0;
  let words = 0;
  let longWords = 0;
  const longLines = [];
  said.forEach((l) => {
    const clean = String(l.text || '').replace(/\{[a-z]+\}/g, 'X');
    const ws = clean.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    words += ws.length;
    sentences += Math.max(1, clean.split(/[.?!।]+/).filter((x) => x.trim()).length);
    longWords += ws.filter((w) => /^[A-Za-z]/.test(w) && w.replace(/[^A-Za-z]/g, '').length >= 10).length;
    if (ws.length > 20) longLines.push(l.step ? { step: l.step, line: l.line } : { pushback: l.pushback });
  });
  if (!words) return { score: 0, label: 'Nothing to read', long_lines: [] };
  const perSentence = words / sentences;
  const longShare = longWords / words;
  const score = Math.max(0, Math.min(100, Math.round(100 - 3 * Math.max(0, perSentence - 8) - 150 * longShare)));
  const label = score >= 75 ? 'Easy to read' : score >= 55 ? 'Fairly easy to read' : 'Hard to read';
  return { score, label, long_lines: longLines };
}

// All checks on a draft. Changes the script (adds marks). Returns:
//   failures: why the draft is not good enough (a reason to try again); empty when it passed
//   problems: the editor's validator problems that are not "Check this" marks
//   marks: number of "Check this" marks; pressure: pressure words found; score: easy-to-read score
export function checkDraft(script, brief, callType, ScriptModel, selfCheck) {
  const resultKeys = (callType.results || []).map((r) => r.key);
  const pressure = markPressure(script);
  const self = isObj(selfCheck) ? selfCheck : {};
  const failures = [];
  const problems = ScriptModel.validateScript(script, { resultKeys }).filter((p) => !p.startsWith('Check this'));
  if (problems.length) failures.push('The script has problems: ' + problems.slice(0, 6).join(' '));
  if (!ScriptModel.endings(script.steps).some((s) => s.result === 'do_not_call')) {
    failures.push('There is no ending with result "do_not_call".');
    if (script.steps[0]) {
      script.steps[0].check = (script.steps[0].check || []).concat('Add a way to end the call with "Do not call again".');
    }
  }
  if (pressure.length) failures.push('Some lines sound like pressure or a threat: ' + pressure.join(', ') + '.');
  if (self.pressure_or_threats || self.false_urgency) failures.push('Your own check found pressure or false urgency.');
  if (self.breaks_never_say) failures.push('Your own check found a line that breaks a "Never say" rule.');
  // Facts the model itself says are not in the form become marks on the first step (no retry: a person checks).
  lines(self.facts_not_in_request).forEach((f) => {
    if (!script.steps[0]) return;
    const note = 'The AI was not sure of this fact: ' + f;
    script.steps[0].check = (script.steps[0].check || []).concat(note);
  });
  if (self.breaks_never_say && script.steps[0]) {
    script.steps[0].check = (script.steps[0].check || []).concat('The AI found a line that may break your "Never say" rules. Read every line.');
  }
  markUnknownFacts(script, brief);
  return {
    failures,
    problems,
    pressure,
    marks: ScriptModel.checkMarks(script).length,
    score: readingScore(script),
  };
}

// ---------- drafts ----------

const sumUsage = (attempts) => attempts.reduce((t, a) => ({
  input: t.input + (Number(a.usage.input_tokens) || 0),
  output: t.output + (Number(a.usage.output_tokens) || 0),
  cache_read: t.cache_read + (Number(a.usage.cache_read_input_tokens) || 0),
  cache_write: t.cache_write + (Number(a.usage.cache_creation_input_tokens) || 0),
  cost: Math.round((t.cost + a.cost) * 1e6) / 1e6,
}), { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 });

// Makes a draft: the default model, a second try with what failed, then once with the fallback model.
// Returns { ok, script, checks, model, attempts: [{ model, ok, cost, usage, failures }], totals, error }.
// ok is true when there is a script to show (it may still have problems and marks: checks.passed says).
export async function makeDraft({ brief, callType, apiKey, models, fetchFn, ScriptModel, templates }) {
  const system = systemBlocks(templates);
  const plan = [models.draft, models.draft, models.fallback];
  const attempts = [];
  let best = null;
  let feedback = '';
  for (let i = 0; i < plan.length; i++) {
    // The fallback model is only for a draft that failed the checks twice, not for a service error.
    if (i === 2 && !(best && best.checks.failures.length)) break;
    const r = await callModel({ fetchFn, apiKey, model: plan[i], system, user: userPrompt(brief, callType, feedback), schema: DRAFT_SCHEMA });
    const attempt = { model: plan[i], ok: false, cost: costUsd(plan[i], r.usage), usage: r.usage || {}, failures: [] };
    attempts.push(attempt);
    if (!r.ok) {
      attempt.failures = [r.error];
      if (!r.retry) break;
      continue;
    }
    const script = toScript(r.value, callType.key);
    const checks = checkDraft(script, brief, callType, ScriptModel, r.value && r.value.self_check);
    attempt.failures = checks.failures;
    attempt.ok = checks.failures.length === 0;
    if (!best || checks.failures.length <= best.checks.failures.length) best = { script, checks, model: plan[i] };
    if (attempt.ok) break;
    feedback = 'Your last draft for this request had these problems. Write it again and fix them:\n- '
      + checks.failures.join('\n- ');
  }
  const totals = sumUsage(attempts);
  if (!best) {
    const last = attempts[attempts.length - 1];
    return { ok: false, attempts, totals, model: last ? last.model : null, error: (last && last.failures[0]) || 'no draft' };
  }
  return {
    ok: true,
    script: best.script,
    model: best.model,
    attempts,
    totals,
    checks: {
      passed: best.checks.failures.length === 0,
      failures: best.checks.failures,
      problems: best.checks.problems,
      marks: best.checks.marks,
      score: best.checks.score,
    },
  };
}

// ---------- "Make simpler" ----------

// The structure of a script without its words: ids, options and results. "Make simpler" may change words only.
export function shape(script) {
  return JSON.stringify({
    steps: (script.steps || []).map((s) => [s.id, s.start === true, s.stage, (s.opts || []).map((o) => [o.label, o.to]), s.result || '', (s.say || []).length]),
    pushbacks: (script.pushbacks || []).map((p) => p.label),
  });
}

const SIMPLER_RULES = [
  'Make the words simpler: shorter sentences, common words, the same language as now.',
  'Keep the meaning, every fact, every placeholder ({name}, {me}) and the polite tone.',
  'Add no new facts, numbers, dates, promises, pressure or urgency.',
].join(' ');

// Reads which line to simplify: { step: <id>, line: <index> } or { pushback: <index> }, or null for the whole script.
export function readTarget(raw, script) {
  if (!isObj(raw)) return { target: null };
  if (typeof raw.step === 'string') {
    const s = (script.steps || []).find((x) => x.id === raw.step);
    if (!s || !Number.isInteger(raw.line) || raw.line < 0 || raw.line >= (s.say || []).length) return { error: 'That line is not in the script.' };
    return { target: { step: raw.step, line: raw.line, text: s.say[raw.line] } };
  }
  if (Number.isInteger(raw.pushback)) {
    const p = (script.pushbacks || [])[raw.pushback];
    if (!p) return { error: 'That pushback is not in the script.' };
    return { target: { pushback: raw.pushback, text: p.answer } };
  }
  return { error: 'Say which line to make simpler.' };
}

// Makes one line or the whole script simpler with the default model. The script's structure and its marks are
// kept; new numbers not in the form get marks as in a draft. Returns { ok, script, checks, model, attempts, totals, error }.
export async function makeSimpler({ script, target, brief, callType, apiKey, models, fetchFn, ScriptModel, templates }) {
  const system = systemBlocks(templates);
  const model = models.draft;
  const attempts = [];
  const before = clone(script);
  let result = null;
  for (let i = 0; i < 2 && !result; i++) {
    let r;
    if (target) {
      const user = userPrompt(brief, callType, 'Do not write a script. Rewrite this one line of the script so it is easier '
        + 'to say. ' + SIMPLER_RULES + '\nThe line: ' + target.text);
      r = await callModel({ fetchFn, apiKey, model, system, user, schema: LINE_SCHEMA });
    } else {
      const user = userPrompt(brief, callType, 'Do not write a new script. Here is the script now. ' + SIMPLER_RULES
        + ' Keep every step id, title, stage, option, result, check note and pushback label exactly as they are, and '
        + 'the same number of lines in each step. Change only the say lines, tips and pushback answers.\n'
        + JSON.stringify({ name: before.name, steps: before.steps, pushbacks: before.pushbacks }));
      r = await callModel({ fetchFn, apiKey, model, system, user, schema: DRAFT_SCHEMA });
    }
    const attempt = { model, ok: false, cost: costUsd(model, r.usage), usage: r.usage || {}, failures: [] };
    attempts.push(attempt);
    if (!r.ok) { attempt.failures = [r.error]; if (!r.retry) break; continue; }
    const next = clone(before);
    if (target) {
      const text = str(r.value && r.value.text);
      if (!text || pressureWord(text)) { attempt.failures = ['the simpler line was empty or sounded like pressure']; continue; }
      if (target.step) next.steps.find((s) => s.id === target.step).say[target.line] = text;
      else next.pushbacks[target.pushback].answer = text;
    } else {
      const s2 = toScript(r.value, before.call_type);
      // Keep the original start, check marks and titles; only the words may change.
      s2.steps.forEach((s, k) => {
        const old = before.steps[k];
        if (!old) return;
        if (old.start === true) s.start = true; else delete s.start;
        if (old.check) s.check = old.check.slice(); else delete s.check;
        if (old.title) s.title = old.title;
      });
      s2.pushbacks.forEach((p, k) => { const old = before.pushbacks[k]; if (old && old.check) p.check = old.check.slice(); else delete p.check; });
      if (shape(s2) !== shape(before)) { attempt.failures = ['the simpler script changed the steps or options']; continue; }
      next.steps = s2.steps;
      next.pushbacks = s2.pushbacks;
    }
    attempt.ok = true;
    result = next;
  }
  const totals = sumUsage(attempts);
  if (!result) {
    const last = attempts[attempts.length - 1];
    return { ok: false, attempts, totals, model, error: (last && last.failures[0]) || 'no change' };
  }
  const checks = checkDraft(result, brief, callType, ScriptModel, null);
  return {
    ok: true, script: result, model, attempts, totals,
    checks: { passed: checks.failures.length === 0, failures: checks.failures, problems: checks.problems, marks: checks.marks, score: checks.score },
  };
}

// ---------- the request ----------

// A script sent back for "Make simpler": the editor format, checked for size and shape.
export function readScript(raw) {
  if (!isObj(raw) || !Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 60) return null;
  if (JSON.stringify(raw).length > 60000) return null;
  const s = toScript({ name: raw.name, steps: raw.steps.map((x) => Object.assign({ say: [], opts: [], tip: '', result: '', check: [] }, x)), pushbacks: raw.pushbacks || [] }, str(raw.call_type));
  // toScript sets start on the first step; keep the caller's own start marks instead.
  s.steps.forEach((step, i) => { if (raw.steps[i] && raw.steps[i].start === true) step.start = true; else delete step.start; });
  return s;
}

// Handles one request. deps:
//   body: the parsed JSON body: { action: 'draft', brief } or { action: 'simplify', brief, script, target }
//   token: the admin's access token (from the Authorization header)
//   env: { apiKey, models: { draft, fallback } }
//   fetchFn, ScriptModel, templates
//   db: { userFromToken(token), activeSeat(), hasFeature(inst, f), callTypes(), usage(),
//         reserve(inst, seat, kind) -> id, finish(id, row) }   (index.ts makes these with supabase-js)
// Returns { status, body }. Messages in body.error are plain English for the page.
export async function handle(deps) {
  const { body, token, env, db } = deps;
  if (!token) return { status: 401, body: { error: 'Sign in again.' } };
  const user = await db.userFromToken(token);
  if (!user) return { status: 401, body: { error: 'Sign in again.' } };
  // Phase A.2: the AI script maker is for the Vector team (platform_admins) only; institutes pick from the
  // template library. Their own admin seat still carries the monthly limit and the cost log.
  if (typeof db.isPlatformAdmin === 'function' && !(await db.isPlatformAdmin())) {
    return { status: 403, body: { error: 'The AI script maker is for the Vector team. Pick a ready script from the template library.', code: 'not_platform_admin' } };
  }
  const seat = await db.activeSeat();
  if (!seat || seat.role !== 'admin') return { status: 403, body: { error: 'Only an admin can use the AI script maker.' } };
  if (!(await db.hasFeature(seat.institute_id, 'ai_drafts'))) {
    return { status: 403, body: { error: 'Add AI drafts to your plan to use this.', code: 'no_feature' } };
  }
  if (!env.apiKey) return { status: 500, body: { error: 'The AI script maker is not set up on the server yet.' } };

  const b = isObj(body) ? body : {};
  const action = b.action === 'simplify' ? 'simplify' : b.action === 'draft' ? 'draft' : null;
  if (!action) return { status: 400, body: { error: 'Unknown action.' } };
  const read = readBrief(b.brief);
  if (read.error) return { status: 400, body: { error: read.error } };
  const brief = read.brief;
  const types = (await db.callTypes()) || [];
  const callType = types.find((t) => t.key === brief.call_type && t.active !== false);
  if (!callType) return { status: 400, body: { error: 'That call type is not available.' } };

  let script = null;
  let target = null;
  if (action === 'simplify') {
    script = readScript(b.script);
    if (!script) return { status: 400, body: { error: 'Send the script to make simpler.' } };
    script.call_type = callType.key;
    const t = readTarget(b.target, script);
    if (t.error) return { status: 400, body: { error: t.error } };
    target = t.target;
  }

  let requestId;
  try {
    requestId = await db.reserve(seat.institute_id, seat.id, action);
  } catch (err) {
    if (/limit reached/i.test(String(err && err.message))) {
      return {
        status: 429,
        body: { error: action === 'draft' ? 'You have used all AI drafts for this month.' : 'You have used "Make simpler" too often this month.', code: 'limit' },
      };
    }
    throw err;
  }

  const common = { brief, callType, apiKey: env.apiKey, models: env.models, fetchFn: deps.fetchFn, ScriptModel: deps.ScriptModel, templates: deps.templates };
  let out;
  try {
    out = action === 'draft' ? await makeDraft(common) : await makeSimpler(Object.assign({ script, target }, common));
  } catch (err) {
    out = { ok: false, attempts: [], totals: sumUsage([]), model: null, error: 'unexpected error' };
  }
  await db.finish(requestId, {
    model: out.model, attempts: out.attempts.length, input: out.totals.input, output: out.totals.output,
    cache_read: out.totals.cache_read, cache_write: out.totals.cache_write, cost: out.totals.cost, ok: out.ok,
  });
  if (!out.ok) {
    return { status: 502, body: { error: action === 'draft' ? 'The AI could not make a draft. Try again.' : 'The AI could not make it simpler. Try again.' } };
  }
  let usage = null;
  try { usage = await db.usage(); } catch (err) { usage = null; }
  return { status: 200, body: { script: out.script, checks: out.checks, model: out.model, usage } };
}
