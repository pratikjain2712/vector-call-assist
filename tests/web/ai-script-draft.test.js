'use strict';
/* Tests for the AI script maker's logic (supabase/functions/ai-script-draft/logic.mjs) with the Messages API
   and the database mocked: the form, the request sent to the API (model, cached system prefix, structured
   output, key only in the header), retries and the Sonnet fallback, the safety checks ("Check this" marks for
   facts not in the form, pressure words, the do-not-call ending, easy-to-read score), "Make simpler", the
   monthly limit and the cost log. Also checks that the function's copies of script-model.js and
   script-templates.js are the same as web/js/. No network.
   Run: node --test tests/web/ai-script-draft.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'ai-script-draft');
const M = require(path.join(ROOT, 'web', 'js', 'script-model.js'));
const T = require(path.join(ROOT, 'web', 'js', 'script-templates.js'));
let L;
test.before(async () => { L = await import(pathToFileURL(path.join(FN, 'logic.mjs')).href); });

const FEES = {
  key: 'fees', label: 'Fees collection', active: true,
  results: ['paid', 'will_pay_on', 'paid_part', 'already_paid', 'refused', 'no_answer', 'busy', 'wrong_number', 'call_back_later', 'do_not_call']
    .map((key) => ({ key, label: key, counts_as_good: key === 'paid' })),
};
const BRIEF = {
  call_type: 'fees', audience: 'Parents', language: 'simple_english',
  purpose: 'Remind parents of Class 10 that the second term fee is due, and get a date when they will pay.',
  facts: 'Fee ₹18,000. Due 31 Oct. Late fee ₹500 after 5 Nov. Pay by UPI, card or at the office.',
  never_say: 'Do not threaten.',
};

// A clean draft in the model's reply format (every schema field present), from the fees template.
function modelDraft(change) {
  const t = T.template('fees_reminder');
  const d = {
    name: 'Fees reminder Class 10',
    steps: t.steps.map((s) => ({ id: s.id, title: s.title, stage: s.stage, say: s.say, tip: s.tip || '',
      opts: s.opts || [], result: s.result || '', check: [] })),
    pushbacks: t.pushbacks.map((p) => ({ label: p.label, answer: p.answer, check: [] })),
    self_check: { pressure_or_threats: false, false_urgency: false, breaks_never_say: false, facts_not_in_request: [] },
  };
  d.steps[1].say = ['This is {me} from the school office.', 'The second term fee of ₹18,000 is due on 31 Oct.'];
  if (change) change(d);
  return d;
}
const noDnc = (d) => {
  d.steps = d.steps.filter((s) => s.id !== 'stop');
  d.steps.find((s) => s.id === 'problem').opts = [{ label: 'Can pay later', to: 'promise' }, { label: 'Cannot pay', to: 'refused' }];
};

// A fetch that answers with the given replies in order and records each request.
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    const status = r.status || 200;
    const payload = r.status && r.status !== 200 ? { type: 'error', error: { type: r.type || 'api_error', message: 'x' } } : {
      id: 'msg_' + calls.length, type: 'message', role: 'assistant', model: body.model, stop_reason: r.stop_reason || 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: typeof r.text === 'string' ? r.text : JSON.stringify(r.json) }],
      usage: { input_tokens: 900, output_tokens: 3000, cache_creation_input_tokens: calls.length === 1 ? 4000 : 0,
        cache_read_input_tokens: calls.length === 1 ? 0 : 4000 },
    };
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  fn.calls = calls;
  return fn;
}

const MODELS = { draft: 'claude-haiku-5-5', fallback: 'claude-sonnet-5-5' };
const common = (fetchFn) => ({ brief: BRIEF, callType: FEES, apiKey: 'test-key', models: MODELS, fetchFn, ScriptModel: M, templates: T.TEMPLATES });

// ----- the function's copies -----
test('the function\'s script-model.js and script-templates.js are exact copies of web/js', () => {
  for (const f of ['script-model.js', 'script-templates.js']) {
    assert.strictEqual(fs.readFileSync(path.join(FN, f), 'utf8'), fs.readFileSync(path.join(ROOT, 'web', 'js', f), 'utf8'), f + ' differs: copy web/js/' + f + ' over it');
  }
});
test('index.ts only wires things up and never holds a key', () => {
  const src = fs.readFileSync(path.join(FN, 'index.ts'), 'utf8');
  assert.match(src, /Deno\.env\.get\("ANTHROPIC_API_KEY"\)/);
  assert.match(src, /ANTHROPIC_MODEL_DRAFT/);
  assert.match(src, /ANTHROPIC_MODEL_FALLBACK/);
  assert.doesNotMatch(src, /sk-ant-/);
});

// ----- the form -----
test('readBrief trims the form and defaults the language', () => {
  const r = L.readBrief({ call_type: ' fees ', audience: ' Parents ', purpose: ' Remind ', facts: '', never_say: '' });
  assert.deepStrictEqual(r.brief, { call_type: 'fees', audience: 'Parents', language: 'simple_english', purpose: 'Remind', facts: '', never_say: '' });
});
test('readBrief refuses a missing type, purpose or audience, a bad language and long text', () => {
  assert.match(L.readBrief({ audience: 'P', purpose: 'x' }).error, /call type/);
  assert.match(L.readBrief({ call_type: 'fees', audience: 'P' }).error, /what the call is for/);
  assert.match(L.readBrief({ call_type: 'fees', purpose: 'x' }).error, /who you call/);
  assert.match(L.readBrief({ call_type: 'fees', audience: 'P', purpose: 'x', language: 'tamil' }).error, /Hinglish/);
  assert.match(L.readBrief({ call_type: 'fees', audience: 'P', purpose: 'x', facts: 'y'.repeat(1501) }).error, /1500/);
});

// ----- cost -----
test('costUsd prices Haiku and Sonnet with cache writes at 1.25x and reads at 0.1x', () => {
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 };
  assert.strictEqual(L.costUsd('claude-haiku-5-5', u), 0.1 + 0.5 + 0.125 + 0.01);
  assert.strictEqual(L.costUsd('claude-sonnet-5-5', u), 2 + 10 + 2.5 + 0.2);
  assert.strictEqual(L.costUsd('claude-haiku-5-5', {}), 0);
});

// ----- safety checks -----
test('numbersIn reads amounts in every common form, Devanagari digits too', () => {
  assert.deepStrictEqual(L.numbersIn('Fee ₹18,000 or Rs. 18000/- and 5%, on 31 Oct').map((n) => [n.value, n.money]),
    [['18000', true], ['18000', true], ['5', true], ['31', false]]);
  assert.deepStrictEqual(L.numbersIn('₹१८,०००').map((n) => n.value), ['18000']);
});
test('a number not in the form gets a "Check this" mark; form numbers and small counts do not', () => {
  const s = L.toScript(modelDraft((d) => {
    d.steps[2].say = ['Can you pay by 25 Oct?', 'It takes 2 minutes.'];
    d.pushbacks[1].answer = 'You can pay ₹500 late fee after 5 Nov, or ₹9,000 now.';
  }), 'fees');
  const added = L.markUnknownFacts(s, BRIEF);
  assert.strictEqual(added, 2);
  assert.deepStrictEqual(s.steps[2].check, ['"25" is not in the facts you gave. Check it or remove it.']);
  assert.deepStrictEqual(s.pushbacks[1].check, ['"₹9,000" is not in the facts you gave. Check it or remove it.']);
  assert.strictEqual(s.steps[1].check, undefined, '₹18,000 and 31 are in the form');
});
test('pressure words are found as whole words in English, Hinglish and Hindi', () => {
  assert.strictEqual(L.pressureWord('Otherwise we will call the police.'), 'police');
  assert.strictEqual(L.pressureWord('This is your LAST CHANCE to pay'), 'LAST CHANCE');
  assert.strictEqual(L.pressureWord('Aaj pay karo warna naam kat jayega'), 'warna');
  assert.strictEqual(L.pressureWord('नहीं तो पुलिस आएगी'), 'पुलिस');
  assert.strictEqual(L.pressureWord('Our fee policy is simple and courteous.'), null);
  assert.strictEqual(L.pressureWord('Thank you, have a good day.'), null);
});
test('readingScore: short plain lines read easily, long heavy lines do not', () => {
  const easy = L.readingScore({ steps: [{ id: 'a', say: ['Hello {name}.', 'The fee is due on 31 Oct.'] }], pushbacks: [] });
  assert.strictEqual(easy.label, 'Easy to read');
  const hard = L.readingScore({ steps: [{ id: 'a', say: ['Notwithstanding administrative considerations, institutional regulations necessitate immediate remittance of outstanding educational contributions, which unfortunately accumulate additional penalties progressively whenever acknowledgement remains unforthcoming beyond stipulated timelines.'] }], pushbacks: [] });
  assert.strictEqual(hard.label, 'Hard to read');
  assert.deepStrictEqual(hard.long_lines, [{ step: 'a', line: 0 }]);
});
test('checkDraft passes a clean draft and lists no failures', () => {
  const s = L.toScript(modelDraft(), 'fees');
  const c = L.checkDraft(s, BRIEF, FEES, M, modelDraft().self_check);
  assert.deepStrictEqual(c.failures, []);
  assert.deepStrictEqual(c.problems, []);
  assert.strictEqual(c.marks, 0);
  assert.ok(c.score.score > 0);
});
test('checkDraft fails a draft without a do-not-call ending and marks it', () => {
  const s = L.toScript(modelDraft(noDnc), 'fees');
  const c = L.checkDraft(s, BRIEF, FEES, M, null);
  assert.ok(c.failures.some((f) => /do_not_call/.test(f)));
  assert.ok(s.steps[0].check.some((m) => /Do not call again/.test(m)));
});
test('checkDraft fails and marks pressure, and the model\'s own check counts', () => {
  const s = L.toScript(modelDraft((d) => { d.steps[3].say = ['Pay today or we take legal action.']; }), 'fees');
  const c = L.checkDraft(s, BRIEF, FEES, M, { pressure_or_threats: true, false_urgency: false, breaks_never_say: false, facts_not_in_request: ['a 10% discount'] });
  assert.ok(c.failures.some((f) => /legal action/.test(f)));
  assert.ok(c.failures.some((f) => /own check/.test(f)));
  assert.ok(s.steps[3].check.some((m) => /threat or pressure/.test(m)));
  assert.ok(s.steps[0].check.some((m) => /a 10% discount/.test(m)), 'facts the model doubts become marks');
});
test('checkDraft fails a draft with an ending of the wrong type or more than 3 options', () => {
  const s = L.toScript(modelDraft((d) => {
    d.steps.find((x) => x.id === 'promise').result = 'joined';
    d.steps[0].opts.push({ label: 'Maybe', to: 'later' });
  }), 'fees');
  const c = L.checkDraft(s, BRIEF, FEES, M, null);
  assert.strictEqual(c.problems.length, 2);
  assert.strictEqual(c.failures.length, 1);
});
test('toScript makes the first step the start and keeps results on endings only', () => {
  const s = L.toScript(modelDraft((d) => { d.steps[0].result = 'paid'; }), 'fees');
  assert.strictEqual(s.steps[0].start, true);
  assert.strictEqual(s.steps[0].result, undefined);
  assert.strictEqual(s.steps.filter((x) => x.start).length, 1);
  assert.strictEqual(s.steps.find((x) => x.id === 'promise').result, 'will_pay_on');
  assert.strictEqual(s.call_type, 'fees');
});

// ----- the request to the API -----
test('callModel sends the model, the cached system prefix and structured output; the key only in the header', async () => {
  const f = fakeFetch([{ json: modelDraft() }]);
  const r = await L.callModel({ fetchFn: f, apiKey: 'test-key', model: 'claude-haiku-5-5', system: L.systemBlocks(T.TEMPLATES), user: 'hi', schema: L.DRAFT_SCHEMA });
  assert.strictEqual(r.ok, true);
  const c = f.calls[0];
  assert.strictEqual(c.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(c.headers['x-api-key'], 'test-key');
  assert.strictEqual(c.headers['anthropic-version'], L.API_VERSION);
  assert.strictEqual(c.body.model, 'claude-haiku-5-5');
  assert.deepStrictEqual(c.body.system[1].cache_control, { type: 'ephemeral' });
  assert.strictEqual(c.body.system[0].cache_control, undefined);
  assert.match(c.body.system[1].text, /Fees reminder/);
  assert.strictEqual(c.body.output_config.format.type, 'json_schema');
  assert.strictEqual(c.body.output_config.effort, 'low');
  assert.strictEqual(c.body.temperature, undefined);
  assert.strictEqual(JSON.stringify(c.body).includes('test-key'), false);
});
test('the cached prefix is the same for every form, so it can be reused', () => {
  const a = JSON.stringify(L.systemBlocks(T.TEMPLATES));
  const b = JSON.stringify(L.systemBlocks(T.TEMPLATES));
  assert.strictEqual(a, b);
  assert.doesNotMatch(a, /18,000/);
  assert.match(L.userPrompt(BRIEF, FEES), /Fee ₹18,000/);
  assert.match(L.userPrompt(BRIEF, FEES), /- do_not_call: do_not_call/);
});
test('callModel: a refusal, a cut-off reply and bad JSON are failures that may be retried', async () => {
  assert.deepStrictEqual(pick(await L.callModel(args(fakeFetch([{ stop_reason: 'refusal', text: '' }])))), [false, true]);
  assert.deepStrictEqual(pick(await L.callModel(args(fakeFetch([{ stop_reason: 'max_tokens', text: '{"a"' }])))), [false, true]);
  assert.deepStrictEqual(pick(await L.callModel(args(fakeFetch([{ text: 'not json' }])))), [false, true]);
  assert.deepStrictEqual(pick(await L.callModel(args(fakeFetch([{ status: 401, type: 'authentication_error' }])))), [false, false]);
  assert.deepStrictEqual(pick(await L.callModel(args(fakeFetch([{ status: 529, type: 'overloaded_error' }])))), [false, true]);
  assert.deepStrictEqual(pick(await L.callModel(args(fakeFetch([new Error('offline')])))), [false, true]);
});
const args = (f) => ({ fetchFn: f, apiKey: 'k', model: 'claude-haiku-5-5', system: [], user: 'x', schema: L.LINE_SCHEMA });
const pick = (r) => [r.ok, r.retry];

// ----- drafts: retries and the fallback -----
test('a good first draft takes one Haiku call', async () => {
  const f = fakeFetch([{ json: modelDraft() }]);
  const out = await L.makeDraft(common(f));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.model, 'claude-haiku-5-5');
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(out.checks.passed, true);
  assert.deepStrictEqual(out.totals, { input: 900, output: 3000, cache_read: 0, cache_write: 4000, cost: L.costUsd('claude-haiku-5-5', { input_tokens: 900, output_tokens: 3000, cache_creation_input_tokens: 4000 }) });
  assert.deepStrictEqual(M.validateScript(out.script, { resultKeys: FEES.results.map((r) => r.key) }), []);
});
test('a draft that fails the checks is tried again with the problems, then once with Sonnet', async () => {
  const f = fakeFetch([{ json: modelDraft(noDnc) }, { json: modelDraft(noDnc) }, { json: modelDraft() }]);
  const out = await L.makeDraft(common(f));
  assert.deepStrictEqual(f.calls.map((c) => c.body.model), ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.match(f.calls[1].body.messages[0].content, /had these problems[\s\S]*do_not_call/);
  assert.strictEqual(out.model, 'claude-sonnet-5-5');
  assert.strictEqual(out.checks.passed, true);
  assert.strictEqual(out.attempts.length, 3);
  assert.ok(out.totals.cost > L.costUsd('claude-sonnet-5-5', { input_tokens: 900, output_tokens: 3000 }) - 1e-9);
});
test('the second Haiku try passing means no Sonnet call', async () => {
  const f = fakeFetch([{ json: modelDraft(noDnc) }, { json: modelDraft() }]);
  const out = await L.makeDraft(common(f));
  assert.strictEqual(f.calls.length, 2);
  assert.strictEqual(out.model, 'claude-haiku-5-5');
});
test('when all three fail, the best draft comes back with its problems and marks', async () => {
  const f = fakeFetch([{ json: modelDraft(noDnc) }]);
  const out = await L.makeDraft(common(f));
  assert.strictEqual(f.calls.length, 3);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.checks.passed, false);
  assert.ok(out.checks.marks >= 1);
});
test('a bad API key stops at once, without Sonnet', async () => {
  const f = fakeFetch([{ status: 401, type: 'authentication_error' }]);
  const out = await L.makeDraft(common(f));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(f.calls.length, 1);
});
test('a busy service is tried twice; the fallback is only for drafts that failed the checks', async () => {
  const f = fakeFetch([{ status: 529, type: 'overloaded_error' }]);
  const out = await L.makeDraft(common(f));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(f.calls.length, 2);
});

// ----- "Make simpler" -----
function cleanScript() {
  const t = T.template('fees_reminder');
  t.steps.forEach((s) => delete s.check);
  t.pushbacks.forEach((p) => delete p.check);
  t.steps[1].check = ['Keep me'];
  return { name: t.name, call_type: 'fees', steps: t.steps, pushbacks: t.pushbacks };
}
test('Make simpler on one line changes that line only and keeps the marks', async () => {
  const f = fakeFetch([{ json: { text: 'When can you pay?' } }]);
  const script = cleanScript();
  const out = await L.makeSimpler(Object.assign(common(f), { script, target: { step: 'when', line: 0, text: script.steps[2].say[0] } }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.script.steps[2].say[0], 'When can you pay?');
  assert.deepStrictEqual(out.script.steps[1].check, ['Keep me']);
  assert.strictEqual(script.steps[2].say[0], 'Thank you. On which date can you pay?', 'the input is not changed');
  assert.deepStrictEqual(Object.keys(f.calls[0].body.output_config.format.schema.properties), ['text']);
});
test('Make simpler on a pushback answer, and a pressure word in the new line is refused', async () => {
  const ok = await L.makeSimpler(Object.assign(common(fakeFetch([{ json: { text: 'Tell me a date that works.' } }])), { script: cleanScript(), target: { pushback: 1, text: 'x' } }));
  assert.strictEqual(ok.script.pushbacks[1].answer, 'Tell me a date that works.');
  const bad = await L.makeSimpler(Object.assign(common(fakeFetch([{ json: { text: 'Pay now or else.' } }])), { script: cleanScript(), target: { pushback: 1, text: 'x' } }));
  assert.strictEqual(bad.ok, false);
});
test('Make simpler on the whole script refuses a reply that changes steps or options', async () => {
  const changed = modelDraft((d) => { d.steps[0].opts = d.steps[0].opts.slice(0, 2); });
  const out = await L.makeSimpler(Object.assign(common(fakeFetch([{ json: changed }])), { script: cleanScript(), target: null }));
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /changed the steps/);
});
test('Make simpler on the whole script keeps the structure and the marks', async () => {
  const simpler = modelDraft((d) => {
    const t = T.template('fees_reminder');
    d.steps.forEach((s, i) => { s.say = t.steps[i].say.map((l) => l.replace('Thank you.', 'Thanks.')); });
  });
  const out = await L.makeSimpler(Object.assign(common(fakeFetch([{ json: simpler }])), { script: cleanScript(), target: null }));
  assert.strictEqual(out.ok, true, out.error);
  assert.strictEqual(out.script.steps[2].say[0], 'Thanks. On which date can you pay?');
  assert.deepStrictEqual(out.script.steps[1].check, ['Keep me']);
  assert.strictEqual(L.shape(out.script), L.shape(cleanScript()));
});
test('readTarget refuses a line that is not in the script', () => {
  const s = cleanScript();
  assert.match(L.readTarget({ step: 'nope', line: 0 }, s).error, /not in the script/);
  assert.match(L.readTarget({ step: 'open', line: 9 }, s).error, /not in the script/);
  assert.match(L.readTarget({ pushback: 99 }, s).error, /not in the script/);
  assert.strictEqual(L.readTarget(null, s).target, null);
});

// ----- the whole request -----
function fakeDb(opts) {
  const o = Object.assign({ user: { id: 'u1' }, seat: { id: 's1', institute_id: 'i1', role: 'admin' }, feature: true, limit: false }, opts);
  const db = {
    finished: [], reserved: [],
    userFromToken: async (t) => (t === 'good' ? o.user : null),
    activeSeat: async () => o.seat,
    hasFeature: async (inst, f) => o.feature && inst === 'i1' && f === 'ai_drafts',
    callTypes: async () => [FEES],
    usage: async () => ({ used: 4, monthly_limit: 20 }),
    reserve: async (inst, seat, kind) => {
      if (o.limit) throw new Error('limit reached: 20 AI draft requests this month');
      db.reserved.push([inst, seat, kind]);
      return 77;
    },
    finish: async (id, row) => { db.finished.push([id, row]); },
  };
  return db;
}
const req = (db, fetchFn, body, token) => L.handle({
  body: body || { action: 'draft', brief: BRIEF }, token: token === undefined ? 'good' : token,
  env: { apiKey: 'test-key', models: MODELS }, fetchFn, ScriptModel: M, templates: T.TEMPLATES, db,
});
test('handle: no token or a bad token is 401', async () => {
  assert.strictEqual((await req(fakeDb(), fakeFetch([]), null, '')).status, 401);
  assert.strictEqual((await req(fakeDb(), fakeFetch([]), null, 'bad')).status, 401);
});
test('handle: a caller seat or no seat is 403', async () => {
  assert.strictEqual((await req(fakeDb({ seat: { id: 's', institute_id: 'i1', role: 'rep' } }), fakeFetch([]))).status, 403);
  assert.strictEqual((await req(fakeDb({ seat: null }), fakeFetch([]))).status, 403);
});
test('handle: without the ai_drafts add-on it is 403 and nothing is reserved', async () => {
  const db = fakeDb({ feature: false });
  const out = await req(db, fakeFetch([]));
  assert.strictEqual(out.status, 403);
  assert.strictEqual(out.body.code, 'no_feature');
  assert.strictEqual(db.reserved.length, 0);
});
test('handle: no API key on the server is 500 without calling anything', async () => {
  const f = fakeFetch([]);
  const out = await L.handle({ body: { action: 'draft', brief: BRIEF }, token: 'good', env: { apiKey: '', models: MODELS }, fetchFn: f, ScriptModel: M, templates: T.TEMPLATES, db: fakeDb() });
  assert.strictEqual(out.status, 500);
  assert.strictEqual(f.calls.length, 0);
});
test('handle: a bad form or an unknown call type is 400', async () => {
  assert.strictEqual((await req(fakeDb(), fakeFetch([]), { action: 'draft', brief: {} })).status, 400);
  assert.strictEqual((await req(fakeDb(), fakeFetch([]), { action: 'draft', brief: Object.assign({}, BRIEF, { call_type: 'sales' }) })).status, 400);
  assert.strictEqual((await req(fakeDb(), fakeFetch([]), { action: 'chat', brief: BRIEF })).status, 400);
});
test('handle: the monthly limit is 429 and the API is not called', async () => {
  const f = fakeFetch([]);
  const out = await req(fakeDb({ limit: true }), f);
  assert.strictEqual(out.status, 429);
  assert.strictEqual(out.body.code, 'limit');
  assert.strictEqual(f.calls.length, 0);
});
test('handle: a draft is reserved, made, logged with tokens and cost, and returned with usage', async () => {
  const db = fakeDb();
  const out = await req(db, fakeFetch([{ json: modelDraft() }]));
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(db.reserved, [['i1', 's1', 'draft']]);
  assert.strictEqual(db.finished.length, 1);
  const [id, row] = db.finished[0];
  assert.strictEqual(id, 77);
  assert.deepStrictEqual(row, { model: 'claude-haiku-5-5', attempts: 1, input: 900, output: 3000, cache_read: 0, cache_write: 4000,
    cost: L.costUsd('claude-haiku-5-5', { input_tokens: 900, output_tokens: 3000, cache_creation_input_tokens: 4000 }), ok: true });
  assert.strictEqual(out.body.model, 'claude-haiku-5-5');
  assert.deepStrictEqual(out.body.usage, { used: 4, monthly_limit: 20 });
  assert.strictEqual(out.body.script.steps[0].start, true);
  assert.strictEqual(typeof out.body.checks.score.score, 'number');
});
test('handle: a failed draft is logged as not ok (so it does not count) and is 502', async () => {
  const db = fakeDb();
  const out = await req(db, fakeFetch([{ status: 500 }]));
  assert.strictEqual(out.status, 502);
  assert.strictEqual(db.finished[0][1].ok, false);
  assert.strictEqual(db.finished[0][1].attempts, 2);
});
test('handle: Make simpler is reserved as its own kind', async () => {
  const db = fakeDb();
  const out = await req(db, fakeFetch([{ json: { text: 'Hello, is this {name}?' } }]),
    { action: 'simplify', brief: BRIEF, script: cleanScript(), target: { step: 'open', line: 0 } });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(db.reserved, [['i1', 's1', 'simplify']]);
  assert.strictEqual(out.body.script.steps[0].say[0], 'Hello, is this {name}?');
  assert.strictEqual(out.body.script.steps[0].start, true);
});
test('handle: Make simpler needs a script and a real line', async () => {
  assert.strictEqual((await req(fakeDb(), fakeFetch([]), { action: 'simplify', brief: BRIEF })).status, 400);
  assert.strictEqual((await req(fakeDb(), fakeFetch([]), { action: 'simplify', brief: BRIEF, script: cleanScript(), target: { step: 'x', line: 0 } })).status, 400);
});
