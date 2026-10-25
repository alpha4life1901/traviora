// Generation, fallback, timeouts, permanent errors and independent sections - all with fake providers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAKE_GEMINI_KEY, FAKE_GROQ_KEY, fakeInternet, geminiOk, goodBody, groqOk, hang, jsonRes,
  makeApp, postItinerary, read, validSection,
} from './helpers.js';

const call = async (net, body = goodBody(), env = {}) => {
  const { app, logs, sleeps } = makeApp({ fetchImpl: net.fetchImpl, env });
  const out = await read(await postItinerary(app, body));
  return { ...out, logs, sleeps, app };
};

// ---------- success ----------

test('success: valid Gemini answer is returned in the planner format, with the model reported', async () => {
  const net = fakeInternet({ gemini: [geminiOk(validSection({ days: 2 }))] });
  const r = await call(net);
  assert.equal(r.status, 200);
  assert.equal(r.json.section, 'hidden');
  assert.equal(r.json.meta.provider, 'gemini');
  assert.equal(r.json.meta.model, 'gemini-3.6-flash');
  assert.equal(r.json.data.days.length, 2);
  assert.equal(r.json.data.days[0].places[0].name, 'Place 1-1 x');
  assert.equal(r.json.data.title, 'India Beyond The Map.');
  assert.equal(r.json.data.transportationOptions.length, 3);
  assert.equal(net.count('groq'), 0);
});

test('success: iconic section uses the iconic title and prompt', async () => {
  const net = fakeInternet({ gemini: [geminiOk(validSection())] });
  const r = await call(net, goodBody({ section: 'iconic' }));
  assert.equal(r.json.data.title, 'Experience the classics.');
  assert.equal(net.calls[0].section, 'iconic');
});

test('success: Gemini request carries the key in a header and a response schema (key never in the URL)', async () => {
  const net = fakeInternet({ gemini: [geminiOk(validSection())] });
  await call(net);
  const c = net.calls[0];
  assert.equal(c.init.headers['x-goog-api-key'], FAKE_GEMINI_KEY);
  assert.ok(!c.url.includes(FAKE_GEMINI_KEY));
  assert.equal(c.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(c.body.generationConfig.responseJsonSchema);
  assert.ok(c.body.generationConfig.maxOutputTokens > 0);
});

test('GEMINI_SEND_SCHEMA=false omits the schema hint', async () => {
  const net = fakeInternet({ gemini: [geminiOk(validSection())] });
  await call(net, goodBody(), { GEMINI_SEND_SCHEMA: 'false' });
  assert.equal(net.calls[0].body.generationConfig.responseJsonSchema, undefined);
});

// ---------- malformed / empty output -> bounded fallback ----------

test('malformed JSON from Gemini is retried within the limit, then falls back to Groq', async () => {
  const net = fakeInternet({ gemini: [geminiOk('this is not json {')], groq: [groqOk(validSection())] });
  const r = await call(net);
  assert.equal(r.status, 200);
  assert.equal(r.json.meta.provider, 'groq');
  assert.equal(net.count('gemini'), 3, 'exactly GEMINI_MAX_ATTEMPTS Gemini tries');
  assert.equal(net.count('groq'), 1);
  assert.deepEqual(r.sleeps, [], 'bad output is retried without waiting');
});

test('empty output from Gemini triggers fallback', async () => {
  const net = fakeInternet({ gemini: [jsonRes(200, { candidates: [] })], groq: [groqOk(validSection())] });
  const r = await call(net);
  assert.equal(r.json.meta.provider, 'groq');
});

test('valid JSON in the wrong shape (wrong number of days) triggers fallback', async () => {
  const net = fakeInternet({ gemini: [geminiOk(validSection({ days: 1 }))], groq: [groqOk(validSection({ days: 2 }))] });
  const r = await call(net);
  assert.equal(r.json.meta.provider, 'groq');
  assert.equal(r.json.data.days.length, 2);
  assert.ok(r.logs.some((l) => l.includes('schema check failed')));
});

test('output cut off by the token limit counts as invalid and falls back', async () => {
  const cut = jsonRes(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"title":' }] } }] });
  const net = fakeInternet({ gemini: [cut], groq: [groqOk(validSection())] });
  assert.equal((await call(net)).json.meta.provider, 'groq');
});

test('JSON wrapped in a ``` fence is accepted, but broken JSON is never "repaired"', async () => {
  const fenced = '```json\n' + JSON.stringify(validSection()) + '\n```';
  assert.equal((await call(fakeInternet({ gemini: [geminiOk(fenced)] }))).status, 200);
  const truncated = JSON.stringify(validSection()).slice(0, 200);
  const net = fakeInternet({ gemini: [geminiOk(truncated)], groq: [groqOk(truncated)] });
  const r = await call(net);
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'bad_output');
  assert.equal(r.json.error.retryable, true);
});

test('Groq request uses strict JSON schema mode and a token limit', async () => {
  const net = fakeInternet({ gemini: [jsonRes(401, { error: { message: 'x' } })], groq: [groqOk(validSection())] });
  await call(net);
  const g = net.calls.find((c) => c.provider === 'groq');
  assert.equal(g.body.response_format.json_schema.strict, true);
  assert.equal(g.body.model, 'openai/gpt-oss-20b');
  assert.ok(g.body.max_completion_tokens > 0);
  assert.equal(g.init.headers.Authorization, `Bearer ${FAKE_GROQ_KEY}`);
});

// ---------- output cleaning and limits ----------

test('AI output is cleaned: extra fields dropped, long text capped, day numbers normalised', async () => {
  const dirty = validSection();
  dirty.days[0].day = 99;
  dirty.days[0].places[0].description = 'z'.repeat(5000);
  dirty.days[0].places[0].injected = '<script>alert(1)</script>';
  dirty.extraTopLevel = 'nope';
  const r = await call(fakeInternet({ gemini: [geminiOk(dirty)] }));
  const place = r.json.data.days[0].places[0];
  assert.equal(r.json.data.days[0].day, 1);
  assert.ok(place.description.length <= 300);
  assert.equal(place.injected, undefined);
  assert.equal(r.json.data.extraTopLevel, undefined);
});

test('too many places in a day is rejected (strict output limits)', async () => {
  const big = validSection();
  big.days[0].places = Array.from({ length: 9 }, () => big.days[0].places[0]);
  const net = fakeInternet({ gemini: [geminiOk(big)], groq: [groqOk(big)] });
  assert.equal((await call(net)).status, 502);
});

// ---------- timeouts ----------

test('timeout: a hanging Gemini request is cut off and Groq takes over', async () => {
  const net = fakeInternet({ gemini: [hang], groq: [groqOk(validSection())] });
  const started = Date.now();
  const r = await call(net, goodBody(), { PROVIDER_TIMEOUT_MS: '200', GEMINI_MAX_ATTEMPTS: '1' });
  assert.equal(r.json.meta.provider, 'groq');
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.json.meta.attempts[0].outcome, 'timeout');
});

test('timeout: when every provider hangs the user gets a clear, retryable timeout error', async () => {
  const net = fakeInternet({ gemini: [hang], groq: [hang] });
  const r = await call(net, goodBody(), { PROVIDER_TIMEOUT_MS: '200', GEMINI_MAX_ATTEMPTS: '1', GROQ_MAX_ATTEMPTS: '1' });
  assert.equal(r.status, 504);
  assert.equal(r.json.error.code, 'timeout');
  assert.equal(r.json.error.retryable, true);
});

test('overall deadline stops further attempts even if attempts remain', async () => {
  let t = 0;
  const net = fakeInternet({ gemini: [async () => { t += 30000; return jsonRes(503, { error: { message: 'busy' } }); }], groq: [groqOk(validSection())] });
  const { app } = makeApp({ fetchImpl: net.fetchImpl, now: () => t, env: { TOTAL_TIMEOUT_MS: '45000', PROVIDER_TIMEOUT_MS: '60000' } });
  const r = await read(await postItinerary(app, goodBody()));
  assert.equal(net.count('gemini'), 2, 'third attempt must not start');
  assert.equal(net.count('groq'), 0);
  assert.equal(r.status, 503);
  assert.ok(r.json.meta.attempts.some((a) => a.outcome === 'deadline'));
});

// ---------- permanent vs temporary errors ----------

test('permanent error: invalid key (401) is NOT retried; moves straight to Groq', async () => {
  const net = fakeInternet({ gemini: [jsonRes(401, { error: { message: 'bad key' } })], groq: [groqOk(validSection())] });
  const r = await call(net);
  assert.equal(net.count('gemini'), 1);
  assert.equal(r.json.meta.provider, 'groq');
  assert.deepEqual(r.sleeps, []);
});

test('permanent error: "API key not valid" returned as HTTP 400 is treated as a key problem', async () => {
  const net = fakeInternet({ gemini: [jsonRes(400, { error: { message: 'API key not valid. Please pass a valid API key.' } })], groq: [groqOk(validSection())] });
  await call(net);
  assert.equal(net.count('gemini'), 1);
});

test('permanent error: unknown model (404) is not retried', async () => {
  const net = fakeInternet({ gemini: [jsonRes(404, { error: { message: 'model not found' } })], groq: [groqOk(validSection())] });
  const r = await call(net);
  assert.equal(net.count('gemini'), 1);
  assert.equal(r.json.meta.attempts[0].outcome, 'model_unavailable');
});

test('permanent errors everywhere: clear "credentials" error, not retryable, every provider tried once', async () => {
  const net = fakeInternet({ gemini: [jsonRes(401, {})], groq: [jsonRes(401, {})] });
  const r = await call(net);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'ai_credentials');
  assert.equal(r.json.error.retryable, false);
  assert.equal(net.count('gemini'), 1);
  assert.equal(net.count('groq'), 1);
});

test('temporary error (503) is retried with growing pauses, up to the limit, then falls back', async () => {
  const net = fakeInternet({ gemini: [jsonRes(503, { error: { message: 'overloaded' } })], groq: [groqOk(validSection())] });
  const r = await call(net);
  assert.equal(net.count('gemini'), 3);
  assert.deepEqual(r.sleeps, [1000, 2000]);
  assert.equal(r.json.meta.provider, 'groq');
});

test('rate limit (429) with a long Retry-After skips the provider instead of waiting', async () => {
  const net = fakeInternet({ gemini: [jsonRes(429, {}, { 'Retry-After': '60' })], groq: [groqOk(validSection())] });
  const r = await call(net);
  assert.equal(net.count('gemini'), 1);
  assert.deepEqual(r.sleeps, []);
  assert.equal(r.json.meta.provider, 'groq');
});

test('everything busy: clear retryable "busy" error with a bounded number of requests', async () => {
  const net = fakeInternet({ gemini: [jsonRes(503, {})], groq: [jsonRes(429, {})] });
  const r = await call(net);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'providers_busy');
  assert.equal(r.json.error.retryable, true);
  assert.equal(net.count('gemini'), 3);
  assert.equal(net.count('groq'), 2);
});

test('network failure is treated as temporary', async () => {
  const net = fakeInternet({ gemini: [() => { throw new TypeError('fetch failed'); }], groq: [groqOk(validSection())] });
  const r = await call(net);
  assert.equal(net.count('gemini'), 3);
  assert.equal(r.json.meta.provider, 'groq');
});

test('no keys configured: clear non-retryable error and no network calls at all', async () => {
  const net = fakeInternet();
  const { app } = makeApp({ fetchImpl: net.fetchImpl, env: { GEMINI_API_KEY: '', GROQ_API_KEY: '' } });
  const r = await read(await postItinerary(app, goodBody()));
  assert.equal(r.json.error.code, 'not_configured');
  assert.equal(r.json.error.retryable, false);
  assert.equal(net.calls.length, 0);
});

test('placeholder values from .env.example count as "not configured"', async () => {
  const net = fakeInternet();
  const { app } = makeApp({ fetchImpl: net.fetchImpl, env: { GEMINI_API_KEY: 'paste_your_new_gemini_key_here', GROQ_API_KEY: 'paste_your_new_groq_key_here' } });
  const r = await read(await postItinerary(app, goodBody()));
  assert.equal(r.json.error.code, 'not_configured');
  assert.equal(net.calls.length, 0);
});

test('FORCE_GROQ_TEST skips Gemini entirely', async () => {
  const net = fakeInternet({ groq: [groqOk(validSection())] });
  const r = await call(net, goodBody(), { FORCE_GROQ_TEST: 'true' });
  assert.equal(net.count('gemini'), 0);
  assert.equal(r.json.meta.provider, 'groq');
});

// ---------- models are never switched silently ----------

test('with one configured Gemini model, every attempt uses exactly that model', async () => {
  const net = fakeInternet({ gemini: [jsonRes(503, {})], groq: [groqOk(validSection())] });
  await call(net, goodBody(), { GEMINI_MODELS: 'model-a' });
  assert.deepEqual(net.calls.filter((c) => c.provider === 'gemini').map((c) => c.model), ['model-a', 'model-a', 'model-a']);
});

test('with two configured models, they are tried only in the configured order', async () => {
  const net = fakeInternet({ gemini: [jsonRes(503, {})], groq: [groqOk(validSection())] });
  await call(net, goodBody(), { GEMINI_MODELS: 'model-a, model-b' });
  assert.deepEqual(net.calls.filter((c) => c.provider === 'gemini').map((c) => c.model), ['model-a', 'model-b', 'model-a']);
});

test('an unavailable model is dropped and the next CONFIGURED model is used; the answer names it', async () => {
  const net = fakeInternet({ gemini: [jsonRes(404, {}), geminiOk(validSection())] });
  const r = await call(net, goodBody(), { GEMINI_MODELS: 'model-a, model-b' });
  assert.equal(r.json.meta.model, 'model-b');
  assert.deepEqual(r.json.meta.attempts.map((a) => `${a.model}:${a.outcome}`), ['model-a:model_unavailable', 'model-b:ok']);
});

// ---------- independent sections ----------

test('independent sections: Hidden Gems failing does not affect Iconic India, and Hidden can be retried alone', async () => {
  let hiddenShouldFail = true;
  const handler = (_u, _i, _b, rec) => {
    if (rec.section === 'hidden' && hiddenShouldFail) return jsonRes(503, {});
    return rec.provider === 'gemini' ? geminiOk(validSection({ tag: rec.section })) : groqOk(validSection({ tag: rec.section }));
  };
  const net = fakeInternet({ gemini: [handler], groq: [handler] });
  const { app } = makeApp({ fetchImpl: net.fetchImpl });

  const [hidden, iconic] = await Promise.all([
    postItinerary(app, goodBody({ section: 'hidden' })).then(read),
    postItinerary(app, goodBody({ section: 'iconic' })).then(read),
  ]);
  assert.equal(hidden.status, 503);
  assert.equal(hidden.json.error.retryable, true);
  assert.equal(iconic.status, 200);
  assert.equal(iconic.json.data.title, 'Experience the classics.');

  const iconicCallsBefore = net.calls.filter((c) => c.section === 'iconic').length;
  hiddenShouldFail = false;
  const retry = await read(await postItinerary(app, goodBody({ section: 'hidden' })));
  assert.equal(retry.status, 200);
  assert.equal(retry.json.data.title, 'India Beyond The Map.');
  assert.equal(net.calls.filter((c) => c.section === 'iconic').length, iconicCallsBefore, 'retrying Hidden must not call Iconic again');
});

test('independent sections: each section uses its own configured key, and a missing section key falls back to the shared one', async () => {
  const net = fakeInternet({ gemini: [geminiOk(validSection())] });
  const { app } = makeApp({ fetchImpl: net.fetchImpl, env: { GEMINI_API_KEY_HIDDEN: 'FAKE_HIDDEN_ONLY_KEY' } });
  await postItinerary(app, goodBody({ section: 'hidden' }));
  await postItinerary(app, goodBody({ section: 'iconic' }));
  assert.equal(net.calls[0].init.headers['x-goog-api-key'], 'FAKE_HIDDEN_ONLY_KEY');
  assert.equal(net.calls[1].init.headers['x-goog-api-key'], FAKE_GEMINI_KEY);
});

test('itinerary generation never waits on or calls Wikipedia', async () => {
  const net = fakeInternet({ gemini: [geminiOk(validSection())] });
  await call(net);
  assert.equal(net.calls.filter((c) => c.provider === 'other').length, 0);
});

// ---------- secrets stay secret ----------

test('keys never appear in responses or logs, even when a provider echoes them in an error', async () => {
  const echo = jsonRes(500, { error: { message: `Invalid request for key ${FAKE_GEMINI_KEY} / ${FAKE_GROQ_KEY}` } });
  const net = fakeInternet({ gemini: [echo], groq: [echo] });
  const r = await call(net);
  const everything = JSON.stringify(r.json) + r.logs.join('\n');
  assert.ok(!everything.includes(FAKE_GEMINI_KEY));
  assert.ok(!everything.includes(FAKE_GROQ_KEY));
  assert.ok(!everything.includes('Invalid request'), 'raw provider text is not forwarded');
});

// ---------- clear messages for each kind of failure ----------

test('every provider says "unknown model" (404): a specific, non-retryable message that points at the model names', async () => {
  const net = fakeInternet({ gemini: [jsonRes(404, {})], groq: [jsonRes(404, {})] });
  const r = await call(net);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'ai_model_unavailable');
  assert.equal(r.json.error.retryable, false);
  assert.match(r.json.error.message, /model name/);
  assert.equal(net.count('gemini'), 1);
  assert.equal(net.count('groq'), 1);
});

test('a dead Gemini key plus a busy Groq is reported as "busy" (retryable), not as a credentials problem', async () => {
  const net = fakeInternet({ gemini: [jsonRes(401, {})], groq: [jsonRes(503, {})] });
  const r = await call(net);
  assert.equal(r.json.error.code, 'providers_busy');
  assert.equal(r.json.error.retryable, true);
});

test('TOTAL_TIMEOUT_MS cannot be set above what the 60-second Vercel function limit allows', async () => {
  const { loadConfig } = await import('../server/config.js');
  assert.equal(loadConfig({ TOTAL_TIMEOUT_MS: '300000' }).limits.totalTimeoutMs, 55000);
});
