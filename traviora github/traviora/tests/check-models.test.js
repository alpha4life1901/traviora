// The "which models can my account use?" helper, tested with fake provider replies (no internet, fake keys).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../server/config.js';
import { checkModels } from '../scripts/check-models.js';
import { FAKE_GEMINI_KEY, FAKE_GROQ_KEY, jsonRes, testEnv } from './helpers.js';

function fakeLists({ geminiModels, groqModels, geminiStatus = 200, groqStatus = 200 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('generativelanguage.googleapis.com')) {
      return geminiStatus === 200 ? jsonRes(200, { models: geminiModels }) : jsonRes(geminiStatus, {});
    }
    if (u.includes('api.groq.com')) {
      return groqStatus === 200 ? jsonRes(200, { data: groqModels }) : jsonRes(groqStatus, {});
    }
    throw new Error('unexpected ' + u);
  };
  return { fetchImpl, calls };
}

const gm = (name, methods = ['generateContent']) => ({ name: `models/${name}`, supportedGenerationMethods: methods });

test('check-models: reports which configured model names your account lists, and flags missing ones', async () => {
  const { fetchImpl } = fakeLists({
    geminiModels: [gm('gemini-3.6-flash'), gm('gemini-embed-only', ['embedContent'])],
    groqModels: [{ id: 'openai/gpt-oss-20b' }],
  });
  const lines = [];
  const config = loadConfig(testEnv({ GEMINI_MODELS: 'gemini-3.6-flash,gemini-made-up' }));
  const results = await checkModels({ config, fetchImpl, print: (l) => lines.push(l) });

  const gemini = results.find((r) => r.provider === 'Gemini');
  assert.deepEqual(gemini.settings, [
    { model: 'gemini-3.6-flash', listed: true },
    { model: 'gemini-made-up', listed: false },
  ]);
  assert.ok(!gemini.available.includes('gemini-embed-only'), 'models that cannot generate text are not offered');
  assert.deepEqual(results.find((r) => r.provider === 'Groq').settings, [{ model: 'openai/gpt-oss-20b', listed: true }]);
  assert.ok(lines.some((l) => l.includes('NOT LISTED') && l.includes('gemini-made-up')));
});

test('check-models: never prints a key and sends keys only in headers', async () => {
  const { fetchImpl, calls } = fakeLists({ geminiModels: [gm('gemini-3.6-flash')], groqModels: [{ id: 'openai/gpt-oss-20b' }] });
  const lines = [];
  await checkModels({ config: loadConfig(testEnv()), fetchImpl, print: (l) => lines.push(l) });
  const printed = lines.join('\n');
  assert.ok(!printed.includes(FAKE_GEMINI_KEY) && !printed.includes(FAKE_GROQ_KEY));
  assert.ok(calls.every((c) => !c.url.includes(FAKE_GEMINI_KEY) && !c.url.includes(FAKE_GROQ_KEY)));
  assert.equal(calls.length, 2, 'one shared key per provider means one request per provider');
});

test('check-models: separate section keys are each checked once', async () => {
  const { fetchImpl, calls } = fakeLists({ geminiModels: [gm('gemini-3.6-flash')], groqModels: [{ id: 'openai/gpt-oss-20b' }] });
  const env = testEnv({ GEMINI_API_KEY_HIDDEN: 'FAKE_HIDDEN_ONLY_KEY' });
  const results = await checkModels({ config: loadConfig(env), fetchImpl, print: () => {} });
  assert.equal(calls.filter((c) => c.url.includes('generativelanguage')).length, 2);
  assert.deepEqual(results.filter((r) => r.provider === 'Gemini').map((r) => r.keyFor), ['Hidden Gems', 'Iconic India']);
});

test('check-models: a rejected key or an outage is reported plainly, not as a crash', async () => {
  const { fetchImpl } = fakeLists({ geminiStatus: 400, groqStatus: 401 });
  const lines = [];
  const results = await checkModels({ config: loadConfig(testEnv()), fetchImpl, print: (l) => lines.push(l) });
  assert.ok(results.every((r) => r.error));
  assert.ok(lines.some((l) => l.includes('could not list models (HTTP 400)')));
});

test('check-models: with no keys it says so and makes no requests', async () => {
  const { fetchImpl, calls } = fakeLists({});
  const lines = [];
  await checkModels({ config: loadConfig({}), fetchImpl, print: (l) => lines.push(l) });
  assert.equal(calls.length, 0);
  assert.ok(lines.some((l) => l.includes('no GEMINI_API_KEY')));
});
