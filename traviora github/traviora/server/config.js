// Reads settings from environment variables. Nothing in this file is secret:
// real values live only in your .env file (local) or the Vercel dashboard (deployed).

const PLACEHOLDER = /^(paste_|your_|changeme|xxx)/i;

function cleanKey(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  return v && !PLACEHOLDER.test(v) ? v : '';
}

function toInt(value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function toList(value, fallback) {
  if (value === undefined || String(value).trim() === '') return fallback;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function toBool(value, fallback) {
  if (value === undefined || String(value).trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * @param {Record<string, string | undefined>} env  usually process.env; tests pass their own object
 */
export function loadConfig(env = process.env) {
  const sharedGemini = cleanKey(env.GEMINI_API_KEY);
  const sharedGroq = cleanKey(env.GROQ_API_KEY);

  return {
    keys: {
      // Optional per-section keys. If not set, the shared key is used.
      gemini: {
        hidden: cleanKey(env.GEMINI_API_KEY_HIDDEN) || sharedGemini,
        iconic: cleanKey(env.GEMINI_API_KEY_ICONIC) || sharedGemini,
      },
      groq: {
        hidden: cleanKey(env.GROQ_API_KEY_HIDDEN) || sharedGroq,
        iconic: cleanKey(env.GROQ_API_KEY_ICONIC) || sharedGroq,
      },
    },

    // Models are NEVER switched silently: Gemini models are tried only in the order you list
    // them here, and every response reports which model produced it.
    gemini: {
      models: toList(env.GEMINI_MODELS, ['gemini-3.6-flash']),
      sendSchema: toBool(env.GEMINI_SEND_SCHEMA, true),
      maxAttempts: toInt(env.GEMINI_MAX_ATTEMPTS, 3, 0, 6),
    },
    groq: {
      models: toList(env.GROQ_MODELS, ['openai/gpt-oss-20b']),
      maxAttempts: toInt(env.GROQ_MAX_ATTEMPTS, 2, 0, 4),
    },
    // Same idea as the old FORCE_GROQ_TEST flag: skip Gemini so you can test Groq on purpose.
    forceGroqTest: toBool(env.FORCE_GROQ_TEST, false),

    limits: {
      providerTimeoutMs: toInt(env.PROVIDER_TIMEOUT_MS, 12000, 200, 60000),
      // Max 55 s: vercel.json stops the function at 60 s, and the page needs time to show a clear error first.
      totalTimeoutMs: toInt(env.TOTAL_TIMEOUT_MS, 45000, 2000, 55000),
      maxOutputTokens: toInt(env.MAX_OUTPUT_TOKENS, 6000, 500, 16000),
      maxBodyBytes: toInt(env.MAX_BODY_BYTES, 4096, 256, 65536),
      maxDays: toInt(env.MAX_DAYS, 7, 1, 14),
      maxTravelers: toInt(env.MAX_TRAVELERS, 20, 1, 100),
      maxBudget: toInt(env.MAX_BUDGET, 10000000, 1000, 1000000000),
      wikipediaTimeoutMs: toInt(env.WIKIPEDIA_TIMEOUT_MS, 6000, 1000, 20000),
    },

    // Best-effort limits (see README: they reset when a serverless instance restarts and are not
    // shared between instances). Your provider spending limits are the real safety net.
    rateLimit: {
      windowSec: toInt(env.RATE_LIMIT_WINDOW_SEC, 600, 10, 86400),
      itineraryPerClient: toInt(env.RATE_LIMIT_ITINERARY_PER_CLIENT, 20, 1, 10000),
      itineraryGlobal: toInt(env.RATE_LIMIT_ITINERARY_GLOBAL, 200, 1, 100000),
      placePerClient: toInt(env.RATE_LIMIT_PLACE_PER_CLIENT, 300, 1, 100000),
    },

    // Wikimedia asks API users to identify themselves, e.g. an email or project URL.
    wikimediaContact: (env.WIKIMEDIA_CONTACT || '').trim(),
    // Extra allowed browser origins (comma-separated). Same-origin requests are always allowed.
    allowedOrigins: toList(env.ALLOWED_ORIGINS, []),
  };
}
