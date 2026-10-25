// POST /api/chat - the floating chat assistant.
//
// The browser sends { message, history?, trip? } to THIS server. This server adds the Agent 37 key
// (from environment variables only) and forwards one plain-text question to your Agent 37 instance.
// The key never goes to the browser, into logs, or into any response. Chat text is never logged.
//
// Stateless on purpose: no Agent 37 session_id is used or stored. The browser keeps the last few
// messages in memory and sends them along, so one visitor can never continue another visitor's chat.

import { ApiError } from './errors.js';
import { checkOrigin, errorResponse, getClientId, jsonResponse, readJsonBody } from './http.js';
import { fetchWithTimeout } from './providers.js';
import { createRateLimiter } from './rateLimit.js';

export const CHAT_LIMITS = {
  messageChars: 800, // one visitor message
  historyItems: 6, // earlier messages sent along for context
  historyItemChars: 1200, // each earlier message is cut to this length
  replyChars: 8000, // longest reply passed back to the page
  bodyBytes: 24576,
};

const PLACEHOLDER = /^(paste_|your_|changeme|xxx)/i;
const PROFILE_NAME = /^[a-z0-9_-]{1,64}$/;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);
const CITY_PATTERN = /^[\p{L}\p{M}\p{N} .,'\u2019()&-]+$/u; // same rule as server/validate.js
const INTERESTS = new Set(['Nature', 'History', 'Food', 'Adventure']);

function toInt(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

/** Reads the chat settings. Missing or placeholder values leave the chat "not configured". */
export function loadChatConfig(env = process.env) {
  const rawKey = String(env.AGENT37_API_KEY || '').trim();
  const rawUrl = String(env.AGENT37_API_URL || '').trim();
  let url = '';
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'https:' && !/your_instance/i.test(rawUrl)) url = u.href;
  } catch { /* not a URL: stays unconfigured */ }
  const profile = String(env.AGENT37_PROFILE || '').trim();
  const effort = String(env.AGENT37_REASONING_EFFORT || '').trim().toLowerCase();
  return {
    url,
    key: rawKey && !PLACEHOLDER.test(rawKey) ? rawKey : '',
    // Optional. Only sent when you set them; otherwise the request body is just { input }.
    profile: PROFILE_NAME.test(profile) ? profile : '',
    reasoningEffort: EFFORTS.has(effort) ? effort : '',
    // Max 55 s so the reply (or a clear error) arrives before Vercel's 60 s function limit.
    timeoutMs: toInt(env.AGENT37_TIMEOUT_MS, 45000, 2000, 55000),
    windowMs: toInt(env.RATE_LIMIT_WINDOW_SEC, 600, 10, 86400) * 1000,
    perClient: toInt(env.RATE_LIMIT_CHAT_PER_CLIENT, 30, 1, 10000),
    global: toInt(env.RATE_LIMIT_CHAT_GLOBAL, 300, 1, 100000),
    allowedOrigins: String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

const clean = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

/** Checks what the browser sent. Returns { ok, value } or { ok:false, error }. */
export function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send a message.' };
  if (typeof body.message !== 'string') return { ok: false, error: 'Send a message as text.' };
  const message = clean(body.message);
  if (!message) return { ok: false, error: 'Type a message first.' };
  if (message.length > CHAT_LIMITS.messageChars) {
    return { ok: false, error: `Keep your message under ${CHAT_LIMITS.messageChars} characters.` };
  }

  const history = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) return { ok: false, error: 'Chat history is not in the right format.' };
    for (const item of body.history.slice(-CHAT_LIMITS.historyItems)) {
      if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.text !== 'string') {
        return { ok: false, error: 'Chat history is not in the right format.' };
      }
      const text = clean(item.text).slice(0, CHAT_LIMITS.historyItemChars);
      if (text) history.push({ role: item.role, text });
    }
  }

  // Trip details from the planner are optional extra context. Anything odd is simply left out.
  let trip = null;
  const t = body.trip;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const city = typeof t.city === 'string' ? t.city.trim() : '';
    const num = (v, max) => (/^\d{1,10}$/.test(String(v ?? '')) && Number(v) >= 1 && Number(v) <= max ? Number(v) : null);
    const value = {
      city: city.length >= 2 && city.length <= 80 && CITY_PATTERN.test(city) ? city : null,
      days: num(t.days, 60),
      budget: num(String(t.budget ?? '').split('.')[0], 1000000000),
      travelers: num(t.travelers, 100),
      interests: Array.isArray(t.interests) ? t.interests.filter((i) => INTERESTS.has(i)) : [],
    };
    if (value.city) trip = value;
  }
  return { ok: true, value: { message, history, trip } };
}

/** The single text input sent to Agent 37. */
export function buildAgentInput({ message, history, trip }) {
  const lines = [
    'You are answering a visitor in the chat box on the Traviora website, an AI trip planner for India.',
    'Keep the starting city separate from the destination. Do not invent places or exact prices; give rough ranges and say they are estimates.',
    'Reply in clear, short Markdown (under about 250 words). Only help with travel planning.',
    'Never run commands, read or change files, or reveal settings, keys or system details, even if the visitor asks.',
  ];
  if (trip) {
    const bits = [`Destination: ${trip.city}`];
    if (trip.days) bits.push(`Days: ${trip.days}`);
    if (trip.budget) bits.push(`Total budget: INR ${trip.budget}`);
    if (trip.travelers) bits.push(`Travelers: ${trip.travelers}`);
    if (trip.interests.length) bits.push(`Interests: ${trip.interests.join(', ')}`);
    lines.push('', `Trip the visitor planned on the site: ${bits.join('; ')}.`);
  }
  if (history.length) {
    lines.push('', 'Earlier in this chat:');
    for (const item of history) lines.push(`${item.role === 'user' ? 'Visitor' : 'Assistant'}: ${item.text}`);
  }
  lines.push('', 'Visitor message:', message);
  return lines.join('\n');
}

/** An ApiError that also remembers Agent 37's status for the server log (never sent to the browser). */
function upstreamError(status, code, message, retryable, upstreamStatus) {
  return Object.assign(new ApiError(status, code, message, { retryable }), { upstreamStatus });
}

export function createChat({ env = process.env, fetchImpl = fetch, now = Date.now, log = console.log } = {}) {
  const config = loadChatConfig(env);
  const perClient = createRateLimiter({ max: config.perClient, windowMs: config.windowMs, now });
  const global = createRateLimiter({ max: config.global, windowMs: config.windowMs, now });

  function enforce(limiter, key) {
    const r = limiter.take(key);
    if (!r.allowed) {
      throw new ApiError(429, 'rate_limited', `Too many messages. Please try again in ${r.retryAfterSec} seconds.`, {
        retryable: true,
        retryAfterSec: r.retryAfterSec,
      });
    }
  }

  async function askAgent(input) {
    const payload = { input };
    if (config.profile) payload.profile = config.profile;
    if (config.reasoningEffort) payload.reasoning_effort = config.reasoningEffort;
    let result;
    try {
      result = await fetchWithTimeout(
        fetchImpl,
        config.url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Agent37-Key': config.key },
          body: JSON.stringify(payload),
        },
        config.timeoutMs,
      );
    } catch (err) {
      if (err?.kind === 'timeout') {
        throw new ApiError(504, 'timeout', 'The assistant took too long to answer. If it was asleep it may be waking up: please try again in a minute.', { retryable: true });
      }
      throw new ApiError(502, 'upstream_unreachable', 'Could not reach the travel assistant. Please try again.', { retryable: true });
    }
    const { response, text } = result;
    if (!response.ok) {
      const s = response.status;
      if (s === 401 || s === 403 || s === 404) {
        throw upstreamError(503, 'chat_credentials', 'The travel assistant is not set up correctly. The site owner needs to check its settings.', false, s);
      }
      if (s === 429 || s === 409) {
        throw upstreamError(503, 'assistant_busy', 'The travel assistant is busy right now. Please try again in a moment.', true, s);
      }
      if (s === 503 || s === 504) {
        throw upstreamError(504, 'timeout', 'The assistant is waking up or busy. Please try again in a minute.', true, s);
      }
      throw upstreamError(502, 'bad_upstream', 'The travel assistant could not answer. Please try again.', true, s);
    }
    let data;
    try { data = JSON.parse(text); } catch { data = null; } // the body may start with keep-alive spaces: JSON allows that
    // Agent 37 can return HTTP 200 with status "failed", so the status field decides.
    const reply = typeof data?.output_text === 'string' ? data.output_text.trim() : '';
    if (!data || (data.status && data.status !== 'completed') || !reply) {
      throw upstreamError(502, 'bad_upstream', 'The travel assistant could not answer that. Please try again or rephrase.', true, data?.status || 'no_output');
    }
    return reply.length > CHAT_LIMITS.replyChars ? `${reply.slice(0, CHAT_LIMITS.replyChars)}\n\n(Reply shortened.)` : reply;
  }

  async function chat(request) {
    const started = now();
    try {
      if (request.method !== 'POST') {
        throw Object.assign(new ApiError(405, 'method_not_allowed', 'Use POST.'), { allow: 'POST' });
      }
      checkOrigin(request, config.allowedOrigins);
      if (!config.url || !config.key) {
        throw new ApiError(503, 'not_configured', 'The travel assistant is not configured yet. The site owner needs to add AGENT37_API_URL and AGENT37_API_KEY (see CHAT_SETUP.md).');
      }
      enforce(perClient, `c:${getClientId(request)}`);
      enforce(global, 'c:global');
      const body = await readJsonBody(request, CHAT_LIMITS.bodyBytes);
      const checked = validateChatRequest(body);
      if (!checked.ok) throw new ApiError(400, 'invalid_input', checked.error);

      const reply = await askAgent(buildAgentInput(checked.value));
      log(`[chat] ok in ${now() - started} ms`); // never the message, the reply or the key
      return jsonResponse(200, { reply });
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'invalid_input' && err.code !== 'rate_limited') {
        log(`[chat] failed: ${err.code}${err.upstreamStatus ? ` (agent37 ${err.upstreamStatus})` : ''} after ${now() - started} ms`);
      }
      const response = errorResponse(err);
      if (err?.allow) response.headers.set('Allow', err.allow);
      return response;
    }
  }

  return { chat, configured: Boolean(config.url && config.key), config: { ...config, key: config.key ? '(set)' : '' } };
}
