// Error types used by the server.
//
//   ApiError       - an error we deliberately send to the browser. Its message is always our own
//                    friendly text, never raw text from Gemini/Groq.
//   ProviderError  - something went wrong talking to one AI provider. It tells generate.js what to
//                    do next (see `disposition` and `backoff`) and is never sent to the browser.
//   summarizeFailure - turns the list of failed attempts into ONE clear ApiError for the user.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code short machine-readable name the browser can react to
   * @param {string} message friendly text shown to the user
   * @param {{retryable?: boolean, retryAfterSec?: number, meta?: object}} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = Boolean(extra.retryable);
    this.retryAfterSec = extra.retryAfterSec;
    this.meta = extra.meta;
  }
}

// What each kind of provider problem means for the retry plan:
//   disposition 'next-provider' = permanent for this provider (bad key, bad request): give up on it now.
//   disposition 'next-model'    = permanent for this model only (unknown model, blocked): drop that model.
//   backoff                     = temporary: wait a little (growing pause) before the next try.
//   (neither)                   = try again straight away (e.g. the AI returned unusable output).
const KINDS = {
  auth: { disposition: 'next-provider', backoff: false },
  bad_request: { disposition: 'next-provider', backoff: false },
  model_unavailable: { disposition: 'next-model', backoff: false },
  blocked: { disposition: 'next-model', backoff: false },
  rate_limit: { disposition: null, backoff: true },
  overloaded: { disposition: null, backoff: true },
  network: { disposition: null, backoff: true },
  timeout: { disposition: null, backoff: false }, // already waited the full timeout
  invalid_output: { disposition: null, backoff: false },
};

export class ProviderError extends Error {
  /**
   * @param {keyof typeof KINDS} kind
   * @param {{status?: number, retryAfterMs?: number|null, detail?: string}} [opts]
   */
  constructor(kind, opts = {}) {
    super(`${kind}${opts.detail ? `: ${opts.detail}` : ''}`);
    this.name = 'ProviderError';
    const rule = KINDS[kind] || KINDS.network;
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.disposition = rule.disposition;
    this.backoff = rule.backoff;
  }
}

// Outcomes that mean "the setup is wrong", as opposed to "try again later".
const SETUP_PROBLEMS = new Set(['auth', 'bad_request', 'model_unavailable']);
const UNUSABLE_ANSWERS = new Set(['invalid_output', 'blocked']);
const NOT_REAL_ATTEMPTS = new Set(['ok', 'skipped', 'not_configured', 'deadline']);

/**
 * @param {Array<{provider: string, model?: string, outcome: string}>} attempts
 * @param {object} meta safe summary (no keys, no raw provider text) attached to the error
 */
export function summarizeFailure(attempts, meta) {
  const real = attempts.filter((a) => !NOT_REAL_ATTEMPTS.has(a.outcome));
  const hitDeadline = attempts.some((a) => a.outcome === 'deadline');

  if (real.length === 0) {
    if (hitDeadline) {
      return new ApiError(504, 'timeout', 'This took too long, so we stopped. Please try again.', { retryable: true, meta });
    }
    return new ApiError(
      503,
      'not_configured',
      'The server has no AI provider key configured yet. The site owner needs to add one (see the README).',
      { retryable: false, meta },
    );
  }

  // Setup problems only matter if nothing else went wrong: a dead Gemini key plus a busy Groq is "busy".
  const others = real.filter((a) => !SETUP_PROBLEMS.has(a.outcome));
  if (others.length === 0) {
    // Only unknown-model answers: the keys may be fine, the model NAMES are the problem.
    if (real.every((a) => a.outcome === 'model_unavailable')) {
      return new ApiError(
        503,
        'ai_model_unavailable',
        'The AI services are not available with the current configuration (for example a model name your account cannot use). The site owner can check this with the check-models command.',
        { retryable: false, meta },
      );
    }
    return new ApiError(
      503,
      'ai_credentials',
      "The AI provider rejected the server's credentials. The site owner needs to check the API keys (see the README).",
      { retryable: false, meta },
    );
  }
  if (others.some((a) => UNUSABLE_ANSWERS.has(a.outcome))) {
    return new ApiError(
      502,
      'bad_output',
      'The AI gave an answer we could not use. Please try again.',
      { retryable: true, meta },
    );
  }
  if (others.every((a) => a.outcome === 'timeout')) {
    return new ApiError(504, 'timeout', 'The AI took too long to answer. Please try again.', { retryable: true, meta });
  }
  return new ApiError(
    503,
    'providers_busy',
    'The AI services are busy or rate-limited right now. Please wait a minute and try again.',
    { retryable: true, meta },
  );
}
