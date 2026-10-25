'use strict';
/* Tests for the central template library (supabase/templates/library.json) and the common answers every script
   gets in search and the helper column (supabase/templates/common_answers.json). The Vector team edits these
   files; this test is the gate for every change. No network, no DOM.
   - every template passes the same validator as the script editor (web/js/script-model.js), with only
     "Check this" marks between it and publishing, and the call page can show it (web/js/script-adapter.js)
   - every ending's result is a result of its call type, read from the seeded call types in
     supabase/migrations/20261024100012_call_types_campaigns_leads.sql
   - only the placeholders the call page fills are used; every template opens with who is calling and asks
     permission, and has a "Do not call again" exit right at the start
   - no threat, shame or false-urgency words (the AI script maker's list plus a few more), no fixed ₹ amounts
   Run: node --test tests/web/template-library.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(ROOT, 'web', 'js', 'script-model.js'));
const A = require(path.join(ROOT, 'web', 'js', 'script-adapter.js'));
const LIB = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase', 'templates', 'library.json'), 'utf8'));
const COMMON = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase', 'templates', 'common_answers.json'), 'utf8'));
let L;   // the AI script maker's logic, for its pressure word list and reading score
test.before(async () => {
  L = await import(pathToFileURL(path.join(ROOT, 'supabase', 'functions', 'ai-script-draft', 'logic.mjs')).href);
});

// ---------- the seeded call types and results, read from the migration ----------
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261024100012_call_types_campaigns_leads.sql'), 'utf8');
const TYPES = [...SQL.matchAll(/^\s*\('([a-z_]+)',\s*'[^']*',\s*\d+\)[,;]/gm)].map((m) => m[1]);
const TYPE_RESULTS = {};
for (const m of SQL.matchAll(/^\s*\('([a-z_]+)',\s*'([a-z_]+)',\s*'[^']*',\s*(?:true|false),/gm)) {
  (TYPE_RESULTS[m[1]] = TYPE_RESULTS[m[1]] || []).push(m[2]);
}
const COMMON_RESULTS = [...SQL.matchAll(/^\s*\(null,\s*'([a-z_]+)',/gm)].map((m) => m[1]);
const resultsOf = (type) => (TYPE_RESULTS[type] || []).concat(COMMON_RESULTS);

// ---------- rules ----------
const PLACEHOLDERS = ['name', 'me', 'institute', 'student', 'class', 'board', 'amount_due', 'due_date', 'course', 'source', 'source_date'];
const LANGUAGES = ['en', 'hinglish'];
const HINGLISH_KEYS = ['fees_reminder_polite', 'fees_overdue', 'admission_enquiry_school', 'cold_call_list'];
// On top of the AI script maker's PRESSURE_WORDS: false promises, more threat and shame words, more false urgency.
const EXTRA_BANNED = [
  'guaranteed', 'guarantee', '100%', 'assured', 'sure-shot', 'surely get', 'definitely get', 'last chance', 'legal',
  'penalty', 'strict', 'warning', 'defaulter', 'debarred', 'blacklisted', 'lazy', 'careless', 'weak student',
  'failed', 'failing', 'seats are filling', 'few seats left', 'only a few seats', 'limited period', 'act fast',
  'don\'t miss', 'do not miss', 'offer ends today', 'immediately',
];
const PERMISSION = /good time|is it okay|baat ho sakti/i;
const MONEY = /(₹|\brs\.?|\binr)\s*\d|\d\s*%|\d+\s*\/-/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let bannedRe = null;
function bannedWord(text) {
  if (!bannedRe) {
    const words = L.PRESSURE_WORDS.concat(EXTRA_BANNED);
    bannedRe = new RegExp('(^|[^\\p{L}\\p{N}])(' + words.map(escapeRe).join('|') + ')(?=$|[^\\p{L}\\p{N}])', 'iu');
  }
  const m = bannedRe.exec(String(text || ''));
  return m ? m[2] : null;
}

// Every string in a value, recursively.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}
// What a caller reads or sees (not the admin's "Check this" notes).
function callerTexts(t) {
  const out = [t.name, t.about];
  t.steps.forEach((s) => {
    out.push(...(s.say || []));
    if (s.tip) out.push(s.tip);
    (s.opts || []).forEach((o) => out.push(o.label));
  });
  t.pushbacks.forEach((p) => out.push(p.label, p.answer));
  return out;
}
const placeholdersIn = (text) => [...String(text).matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
const stepOf = (t, id) => t.steps.find((s) => s.id === id);
const clearMarks = (t) => {
  const c = JSON.parse(JSON.stringify(t));
  c.steps.forEach((s) => delete s.check);
  c.pushbacks.forEach((p) => delete p.check);
  return c;
};

// ---------- the seeded types were read ----------
test('the call types and results are read from the migration', () => {
  assert.deepStrictEqual(TYPES, ['sales', 'fees', 'follow_up', 'admission', 'absence', 'event', 'feedback', 'renewal']);
  assert.deepStrictEqual(COMMON_RESULTS, ['no_answer', 'busy', 'wrong_number', 'call_back_later', 'do_not_call']);
  assert.deepStrictEqual(TYPE_RESULTS.fees, ['paid', 'will_pay_on', 'paid_part', 'already_paid', 'refused']);
  TYPES.forEach((t) => assert.ok((TYPE_RESULTS[t] || []).length >= 2, t + ' has results'));
});

// ---------- the library as a whole ----------
test('the library is a list of templates with unique keys and names', () => {
  assert.ok(Array.isArray(LIB) && LIB.length >= 26, 'at least 22 English and 4 Hinglish templates');
  const keys = LIB.map((t) => t.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'keys are unique');
  const names = LIB.map((t) => t.name.toLowerCase());
  assert.strictEqual(new Set(names).size, names.length, 'names are unique');
});

test('the library covers every call type the plan asks for', () => {
  const byType = (type) => LIB.filter((t) => t.call_type === type && t.language === 'en').length;
  assert.ok(byType('fees') >= 7, 'fees');
  assert.ok(byType('admission') >= 6, 'admission');
  assert.ok(byType('sales') >= 4, 'sales');
  ['absence', 'event', 'feedback', 'renewal'].forEach((type) => assert.ok(byType(type) >= 1, type));
});

test('Hinglish versions exist for the four most used templates, each with its English original', () => {
  const hinglish = LIB.filter((t) => t.language === 'hinglish');
  assert.deepStrictEqual(hinglish.map((t) => t.key).sort(), HINGLISH_KEYS.map((k) => k + '_hinglish').sort());
  hinglish.forEach((h) => {
    const en = LIB.find((t) => t.key === h.key.replace(/_hinglish$/, ''));
    assert.ok(en && en.language === 'en', h.key + ' has an English original');
    assert.strictEqual(h.call_type, en.call_type, h.key + ' has the same call type');
  });
});

// ---------- every template ----------
LIB.forEach((t) => {
  const name = t.key + ': ';

  test(name + 'has the library fields', () => {
    assert.match(t.key, /^[a-z][a-z0-9_]{1,59}$/);
    ['name', 'audience', 'about'].forEach((k) => assert.ok(typeof t[k] === 'string' && t[k].trim(), k));
    assert.ok(TYPES.includes(t.call_type), 'call_type "' + t.call_type + '" is a built-in type');
    assert.ok(LANGUAGES.includes(t.language), 'language');
    assert.ok(t.tags && Array.isArray(t.tags.class_labels) && Array.isArray(t.tags.boards), 'tags');
    assert.deepStrictEqual(Object.keys(t.tags).sort(), ['boards', 'class_labels']);
    [...t.tags.class_labels, ...t.tags.boards].forEach((x) => assert.ok(typeof x === 'string' && x.trim(), 'tag'));
  });

  test(name + 'has 5 to 10 steps and 4 to 8 pushbacks', () => {
    assert.ok(t.steps.length >= 5 && t.steps.length <= 10, t.steps.length + ' steps');
    assert.ok(t.pushbacks.length >= 4 && t.pushbacks.length <= 8, t.pushbacks.length + ' pushbacks');
  });

  test(name + 'only "Check this" marks stand between it and publishing (the editor\'s validator)', () => {
    const problems = M.validateScript(t, { resultKeys: resultsOf(t.call_type) });
    assert.deepStrictEqual(problems.filter((p) => !p.startsWith('Check this')), []);
  });

  test(name + 'with the marks cleared it is valid, every ending has a result of its type', () => {
    const c = clearMarks(t);
    assert.deepStrictEqual(M.validateScript(c, { resultKeys: resultsOf(t.call_type) }), []);
    M.endings(c.steps).forEach((s) => assert.ok(resultsOf(t.call_type).includes(s.result), s.id + ': ' + s.result));
    c.steps.filter((s) => !M.isEnding(s)).forEach((s) => assert.strictEqual(s.result, undefined, s.id + ' has options and a result'));
  });

  test(name + 'at most 3 options a step, and the call page can show it', () => {
    t.steps.forEach((s) => assert.ok((s.opts || []).length <= M.MAX_OPTS, s.id));
    assert.ok(A.adaptSteps(t.steps), 'adaptSteps returned null');
    assert.strictEqual(A.startStepId(t.steps), 'open');
    t.steps.forEach((s) => assert.ok(Number.isInteger(s.stage) && s.stage >= 0 && s.stage <= 5, s.id + ' stage'));
  });

  test(name + 'every step is reachable from the start and no path loops', () => {
    const seen = new Set(['open']);
    const queue = ['open'];
    while (queue.length) {
      const s = stepOf(t, queue.shift());
      (s.opts || []).forEach((o) => { if (!seen.has(o.to)) { seen.add(o.to); queue.push(o.to); } });
    }
    assert.deepStrictEqual(t.steps.map((s) => s.id).filter((id) => !seen.has(id)), []);
    const walk = (id, path) => {
      assert.ok(!path.includes(id), 'loop: ' + path.concat(id).join(' > '));
      (stepOf(t, id).opts || []).forEach((o) => walk(o.to, path.concat(id)));
    };
    walk('open', []);
  });

  test(name + 'opens with who is calling and asks permission', () => {
    const start = stepOf(t, 'open');
    const next = stepOf(t, start.opts[0].to);
    const opening = start.say.concat(next.say).join(' ');
    assert.ok(opening.includes('{me}'), 'the caller says their name');
    assert.ok(opening.includes('{institute}'), 'the caller says the institute');
    assert.match(opening, PERMISSION, 'asks if this is a good time');
  });

  test(name + 'a "Do not call again" exit is offered right at the start', () => {
    const start = stepOf(t, 'open');
    const early = [start].concat(start.opts.map((o) => stepOf(t, o.to)));
    const exits = early.flatMap((s) => s.opts || []).filter((o) => stepOf(t, o.to).result === 'do_not_call');
    assert.ok(exits.length >= 1, 'an option in the first two steps leads to the do_not_call ending');
    const stop = t.steps.find((s) => s.result === 'do_not_call');
    assert.ok(M.isEnding(stop));
  });

  test(name + 'uses only the placeholders the call page fills', () => {
    strings(t).forEach((s) => placeholdersIn(s).forEach((p) =>
      assert.ok(PLACEHOLDERS.includes(p), '{' + p + '} in "' + s + '"')));
  });

  test(name + 'no threat, shame, false promise or false urgency words', () => {
    callerTexts(t).forEach((s) => assert.strictEqual(bannedWord(s), null, '"' + bannedWord(s) + '" in "' + s + '"'));
  });

  test(name + 'no fixed money amounts or percentages (they differ by institute)', () => {
    callerTexts(t).forEach((s) => assert.ok(!MONEY.test(s), s));
  });

  test(name + 'every line is short enough to read aloud (20 words at most)', () => {
    t.steps.forEach((s) => (s.say || []).forEach((line) => {
      const words = line.split(/\s+/).filter(Boolean).length;
      assert.ok(words <= 20, s.id + ': ' + words + ' words: ' + line);
    }));
  });

  test(name + 'is easy to read (the AI script maker\'s score)', () => {
    if (t.language !== 'en') return;
    const r = L.readingScore(t);
    assert.ok(r.score >= 75, 'score ' + r.score + ' (' + r.label + ')');
  });

  test(name + 'every pushback has a label and an answer', () => {
    assert.deepStrictEqual(M.validatePushbacks(clearMarks(t).pushbacks), []);
    t.pushbacks.forEach((p) => {
      assert.ok(p.label.trim() && p.answer.trim());
      Object.keys(p).forEach((k) => assert.ok(['label', 'answer', 'check'].includes(k), 'unknown pushback field ' + k));
    });
  });

  test(name + 'no pushback repeats a common answer (both show in search)', () => {
    const common = new Set(COMMON.map((c) => c.label.toLowerCase()));
    t.pushbacks.forEach((p) => assert.ok(!common.has(p.label.toLowerCase()), p.label));
  });
});

// ---------- common answers ----------
const REQUIRED_COMMON = ['where_number', 'who_are_you', 'sales_call', 'busy_call_later', 'send_whatsapp', 'do_not_call', 'dnd',
  'fee_amount', 'fraud_check', 'speak_hindi', 'ask_family', 'joined_elsewhere', 'other_parent', 'wrong_number', 'location', 'discount'];

test('common answers: at least 15, with every required key, unique keys and labels', () => {
  assert.ok(Array.isArray(COMMON) && COMMON.length >= 15);
  const keys = COMMON.map((c) => c.key);
  REQUIRED_COMMON.forEach((k) => assert.ok(keys.includes(k), 'missing ' + k));
  assert.strictEqual(new Set(keys).size, keys.length);
  keys.forEach((k) => assert.match(k, /^[a-z][a-z0-9_]{1,59}$/));
});

test('common answers: fields, lengths and tags (same limits as pushbacks)', () => {
  const asPushbacks = COMMON.map((c) => ({ label: c.label, answer: c.answer }));
  assert.deepStrictEqual(M.validatePushbacks(asPushbacks).filter((p) => !p.startsWith('Keep to')), []);
  COMMON.forEach((c) => {
    Object.keys(c).forEach((k) => assert.ok(['key', 'label', 'answer', 'fallback', 'result', 'check', 'tags'].includes(k), c.key + ': ' + k));
    assert.ok(Array.isArray(c.tags) && c.tags.length >= 1, c.key + ' tags');
    c.tags.forEach((tag) => assert.ok(tag === 'all' || /^[a-z][a-z ]*$/.test(tag), c.key + ' tag ' + tag));
    if (c.result !== undefined) assert.ok(COMMON_RESULTS.includes(c.result), c.key + ' result ' + c.result);
    if (c.fallback !== undefined) assert.ok(c.fallback.trim().length > 0 && c.fallback.length <= M.PUSHBACK_ANSWER_MAX);
    if (c.check !== undefined) assert.ok(Array.isArray(c.check) && c.check.every((x) => typeof x === 'string' && x.trim()));
  });
});

test('common answers: only allowed placeholders, no banned words, no fixed amounts', () => {
  COMMON.forEach((c) => {
    strings(c).forEach((s) => placeholdersIn(s).forEach((p) => assert.ok(PLACEHOLDERS.includes(p), c.key + ': {' + p + '}')));
    [c.label, c.answer, c.fallback].filter(Boolean).forEach((s) => {
      assert.strictEqual(bannedWord(s), null, c.key + ': ' + bannedWord(s));
      assert.ok(!MONEY.test(s), c.key + ': ' + s);
    });
  });
});

test('"Where did you get my number?" cites the source and date, has an honest fallback, offers to stop', () => {
  const c = COMMON.find((x) => x.key === 'where_number');
  assert.ok(c.answer.includes('{source}') && c.answer.includes('{source_date}'));
  assert.ok(c.fallback, 'a line for when the source is not known');
  assert.deepStrictEqual(placeholdersIn(c.fallback), [], 'the fallback needs no lead data');
  [c.answer, c.fallback].forEach((s) => assert.match(s, /do not want calls|stop/i));
});

test('"Do not call" and "DND" answers apologise and save Do not call; neither argues', () => {
  ['do_not_call', 'dnd'].forEach((k) => {
    const c = COMMON.find((x) => x.key === k);
    assert.strictEqual(c.result, 'do_not_call');
    assert.match(c.answer, /sorry/i);
    assert.doesNotMatch(c.answer, /\bbut\b/i);
  });
});

test('fee and discount answers carry a "Check this" mark (the institute\'s own facts)', () => {
  ['fee_amount', 'discount'].forEach((k) => {
    const c = COMMON.find((x) => x.key === k);
    assert.ok(Array.isArray(c.check) && c.check.length >= 1, k);
  });
  assert.match(COMMON.find((x) => x.key === 'discount').answer, /cannot promise/i);
});
