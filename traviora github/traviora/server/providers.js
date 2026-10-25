// One function per AI provider. Each makes exactly ONE request (no retrying here) and either
// returns the model's text or throws a ProviderError describing what went wrong.
// `fetchImpl` is injectable so the tests can use fake responses instead of the real internet.

import { ProviderError } from './errors.js';

const MODEL_NAME = /^[A-Za-z0-9._\-/]+$/;

/** fetch() with a hard time limit that also covers reading the response body. */
export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, readBody = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!readBody) return { response, text: '' };
    const text = await response.text();
    return { response, text };
  } catch (err) {
    if (controller.signal.aborted || err?.name === 'AbortError') {
      throw new ProviderError('timeout', { detail: `no answer within ${timeoutMs} ms` });
    }
    throw new ProviderError('network', { detail: err?.name || 'fetch failed' });
  } finally {
    clearTimeout(timer);
  }
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (raw === null || raw === undefined || String(raw).trim() === '') return null; // header absent
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? Math.round(secs * 1000) : null;
}

/** Maps an HTTP failure to an error kind. The provider's message text is only used for matching. */
export function classifyHttpError(status, bodyText, response) {
  const lower = (bodyText || '').toLowerCase();
  const opts = { status, retryAfterMs: response ? retryAfterMs(response) : null };
  if (status === 401 || status === 403) return new ProviderError('auth', opts);
  if (status === 400 && /api key|api_key|permission/.test(lower)) return new ProviderError('auth', opts);
  if (status === 404) return new ProviderError('model_unavailable', opts);
  if (status === 429) return new ProviderError('rate_limit', opts);
  if (status === 408 || status === 425 || status === 529) return new ProviderError('overloaded', opts);
  if (status >= 500) return new ProviderError('overloaded', opts);
  return new ProviderError('bad_request', opts);
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function callGemini({ fetchImpl, apiKey, model, prompt, schema, sendSchema, maxOutputTokens, timeoutMs }) {
  if (!MODEL_NAME.test(model)) throw new ProviderError('bad_request', { detail: 'invalid model name' });
  const generationConfig = { responseMimeType: 'application/json', maxOutputTokens };
  if (sendSchema) generationConfig.responseJsonSchema = schema;

  const { response, text } = await fetchWithTimeout(
    fetchImpl,
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
    },
    timeoutMs,
  );
  if (!response.ok) throw classifyHttpError(response.status, text, response);

  const data = parseJsonSafely(text);
  if (!data) throw new ProviderError('invalid_output', { detail: 'provider reply was not JSON' });
  if (data.promptFeedback?.blockReason) throw new ProviderError('blocked', { detail: 'prompt blocked' });

  const candidate = data.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish === 'SAFETY' || finish === 'RECITATION') throw new ProviderError('blocked', { detail: String(finish) });
  if (finish === 'MAX_TOKENS') throw new ProviderError('invalid_output', { detail: 'output was cut off' });

  const output = (candidate?.content?.parts || [])
    .filter((p) => typeof p?.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!output.trim()) throw new ProviderError('invalid_output', { detail: 'empty output' });
  return output;
}

export async function callGroq({ fetchImpl, apiKey, model, prompt, schema, maxOutputTokens, timeoutMs }) {
  if (!MODEL_NAME.test(model)) throw new ProviderError('bad_request', { detail: 'invalid model name' });
  const { response, text } = await fetchWithTimeout(
    fetchImpl,
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_completion_tokens: maxOutputTokens,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'trip_section', strict: true, schema },
        },
      }),
    },
    timeoutMs,
  );
  if (!response.ok) throw classifyHttpError(response.status, text, response);

  const data = parseJsonSafely(text);
  if (!data) throw new ProviderError('invalid_output', { detail: 'provider reply was not JSON' });

  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new ProviderError('blocked', { detail: 'model refused' });
  if (choice?.finish_reason === 'length') throw new ProviderError('invalid_output', { detail: 'output was cut off' });
  const output = choice?.message?.content;
  if (typeof output !== 'string' || !output.trim()) throw new ProviderError('invalid_output', { detail: 'empty output' });
  return output;
}

/**
 * Parses the model's text as JSON. Deliberately strict: it only removes a surrounding
 * ``` fence. There is no "repair" step, because guessing at broken JSON can silently
 * produce a wrong itinerary. Bad output is treated as a failed attempt instead.
 */
export function parseModelJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ProviderError('invalid_output', { detail: 'output was not valid JSON' });
  }
}
