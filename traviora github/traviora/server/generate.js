// Runs the bounded "try Gemini, then Groq" plan for ONE section and returns a validated itinerary.
//
// Rules (all limits come from config, nothing loops forever):
//   - Each provider gets at most `maxAttempts` requests; each request has its own timeout.
//   - Temporary problems (timeout, busy, rate limit) are retried after a short, growing pause.
//   - Empty/malformed/invalid output is retried immediately (counts as an attempt).
//   - Permanent problems skip ahead at once: a bad key abandons that provider, a bad/unknown
//     model abandons just that model. They are never retried.
//   - A hard overall deadline stops everything, whatever is left of the attempt budget.
//   - Gemini models are tried only in the order configured. Which model answered is reported.

import { ApiError, ProviderError, summarizeFailure } from './errors.js';
import { buildSectionPrompt } from './prompts.js';
import { callGemini, callGroq, parseModelJson } from './providers.js';
import { SECTION_JSON_SCHEMA } from './schema.js';
import { validateSection } from './validate.js';

const MIN_USEFUL_ATTEMPT_MS = 1500;
const MAX_BACKOFF_MS = 4000;
const LONG_RETRY_AFTER_MS = 5000; // a provider asking us to wait longer than this is skipped instead

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function generateSection(input, config, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const sleep = deps.sleep || realSleep;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const { section } = input;

  const startedAt = now();
  const deadline = startedAt + config.limits.totalTimeoutMs;
  const prompt = buildSectionPrompt(section, input);
  const attempts = []; // safe summary of what happened; contains no keys and no raw provider text
  const base = { fetchImpl, schema: SECTION_JSON_SCHEMA, prompt, maxOutputTokens: config.limits.maxOutputTokens };

  const providers = [
    {
      name: 'gemini',
      apiKey: config.keys.gemini[section],
      models: config.gemini.models,
      maxAttempts: config.gemini.maxAttempts,
      skip: config.forceGroqTest,
      call: (model, timeoutMs, apiKey) =>
        callGemini({ ...base, apiKey, model, timeoutMs, sendSchema: config.gemini.sendSchema }),
    },
    {
      name: 'groq',
      apiKey: config.keys.groq[section],
      models: config.groq.models,
      maxAttempts: config.groq.maxAttempts,
      skip: false,
      call: (model, timeoutMs, apiKey) => callGroq({ ...base, apiKey, model, timeoutMs }),
    },
  ];

  for (const provider of providers) {
    if (provider.skip) {
      attempts.push({ provider: provider.name, outcome: 'skipped' });
      continue;
    }
    if (!provider.apiKey || provider.models.length === 0 || provider.maxAttempts === 0) {
      attempts.push({ provider: provider.name, outcome: 'not_configured' });
      continue;
    }

    const deadModels = new Set();
    let turn = 0;
    let providerAbandoned = false;

    while (turn < provider.maxAttempts && !providerAbandoned) {
      const liveModels = provider.models.filter((m) => !deadModels.has(m));
      if (liveModels.length === 0) break;

      const remaining = deadline - now();
      if (remaining < MIN_USEFUL_ATTEMPT_MS) {
        attempts.push({ provider: provider.name, outcome: 'deadline' });
        break;
      }

      const model = liveModels[turn % liveModels.length];
      turn += 1;
      const timeoutMs = Math.min(config.limits.providerTimeoutMs, remaining);

      try {
        const text = await provider.call(model, timeoutMs, provider.apiKey);
        const parsed = parseModelJson(text);
        const checked = validateSection(parsed, input);
        if (!checked.ok) {
          log(`[${section}] ${provider.name}/${model}: schema check failed (${checked.errors.length} problem(s)): ${checked.errors.slice(0, 3).join(' | ')}`);
          throw new ProviderError('invalid_output', { detail: 'did not match the itinerary format' });
        }
        attempts.push({ provider: provider.name, model, outcome: 'ok' });
        return {
          data: checked.value,
          meta: { provider: provider.name, model, attempts, elapsedMs: now() - startedAt },
        };
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError('network', { detail: 'unexpected error' });
        attempts.push({ provider: provider.name, model, outcome: e.kind, status: e.status ?? undefined });
        log(`[${section}] ${provider.name}/${model}: ${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}`);

        if (e.disposition === 'next-provider') {
          providerAbandoned = true;
        } else if (e.disposition === 'next-model') {
          deadModels.add(model);
        } else if (e.kind === 'rate_limit' && e.retryAfterMs !== null && e.retryAfterMs > LONG_RETRY_AFTER_MS) {
          providerAbandoned = true; // quota exhausted for a while; waiting is pointless
        } else if (e.backoff && turn < provider.maxAttempts) {
          const wait = Math.min(MAX_BACKOFF_MS, e.retryAfterMs ?? 1000 * 2 ** (turn - 1));
          if (deadline - now() - wait < MIN_USEFUL_ATTEMPT_MS) {
            attempts.push({ provider: provider.name, outcome: 'deadline' });
            break;
          }
          await sleep(wait);
        }
      }
    }
  }

  const meta = { attempts, elapsedMs: now() - startedAt };
  throw summarizeFailure(attempts, meta);
}

export { ApiError };
