// The two API endpoints as plain functions: Request in, Response out.
// api/*.js (Vercel) and server.js (your laptop) both just call these, so what you test locally
// is the same code that runs when deployed.

import { loadConfig } from './config.js';
import { ApiError } from './errors.js';
import { generateSection } from './generate.js';
import { checkOrigin, errorResponse, getClientId, jsonResponse, readJsonBody } from './http.js';
import { createRateLimiter } from './rateLimit.js';
import { validateItineraryRequest, validatePlaceQuery } from './validate.js';
import { createWikipediaClient } from './wikipedia.js';

export function createApp({ env = process.env, fetchImpl, sleep, now = Date.now, log = console.log } = {}) {
  const config = loadConfig(env);
  const windowMs = config.rateLimit.windowSec * 1000;
  const itineraryLimiter = createRateLimiter({ max: config.rateLimit.itineraryPerClient, windowMs, now });
  const globalLimiter = createRateLimiter({ max: config.rateLimit.itineraryGlobal, windowMs, now });
  const placeLimiter = createRateLimiter({ max: config.rateLimit.placePerClient, windowMs, now });
  const wikipedia = createWikipediaClient({
    fetchImpl,
    timeoutMs: config.limits.wikipediaTimeoutMs,
    contact: config.wikimediaContact,
    now,
  });

  function enforce(limiter, key) {
    const r = limiter.take(key);
    if (!r.allowed) {
      throw new ApiError(429, 'rate_limited', `Too many requests. Please try again in ${r.retryAfterSec} seconds.`, {
        retryable: true,
        retryAfterSec: r.retryAfterSec,
      });
    }
  }

  async function itinerary(request) {
    try {
      if (request.method !== 'POST') {
        throw Object.assign(new ApiError(405, 'method_not_allowed', 'Use POST.'), { allow: 'POST' });
      }
      checkOrigin(request, config.allowedOrigins);

      enforce(itineraryLimiter, `i:${getClientId(request)}`);
      enforce(globalLimiter, 'i:global');

      const body = await readJsonBody(request, config.limits.maxBodyBytes);
      const checked = validateItineraryRequest(body, config.limits);
      if (!checked.ok) {
        throw new ApiError(400, 'invalid_input', `Please check your inputs: ${checked.errors.join(' ')}`);
      }

      const { data, meta } = await generateSection(checked.value, config, { fetchImpl, sleep, now, log });
      log(`[itinerary] ${checked.value.section}: ok via ${meta.provider}/${meta.model} in ${meta.elapsedMs} ms (${meta.attempts.length} attempt(s))`);
      return jsonResponse(200, { section: checked.value.section, data, meta });
    } catch (err) {
      if (err instanceof ApiError && err.meta) {
        log(`[itinerary] failed: ${err.code}; attempts: ${err.meta.attempts.map((a) => `${a.provider}/${a.model ?? '-'}=${a.outcome}`).join(', ')}`);
      }
      const response = errorResponse(err);
      if (err?.allow) response.headers.set('Allow', err.allow);
      return response;
    }
  }

  async function place(request) {
    try {
      if (request.method !== 'GET') {
        throw Object.assign(new ApiError(405, 'method_not_allowed', 'Use GET.'), { allow: 'GET' });
      }
      checkOrigin(request, config.allowedOrigins);
      enforce(placeLimiter, `p:${getClientId(request)}`);

      const params = Object.fromEntries(new URL(request.url).searchParams);
      const checked = validatePlaceQuery(params);
      if (!checked.ok) throw new ApiError(400, 'invalid_input', checked.errors.join(' '));

      // detail=1 is asked for by the destination page: article text and a photo gallery as well.
      const withDetail = params.detail === '1';
      const info = withDetail ? await wikipedia.detail(checked.value) : await wikipedia.lookup(checked.value);
      // Answers that are stable can be cached by the browser/CDN; "unavailable" or incomplete ones never are.
      const stable = info.status !== 'unavailable' && (!withDetail || (info.detail?.status === 'ok' && !info.detail.partial));
      const cache = stable
        ? 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400'
        : 'no-store';
      return jsonResponse(200, info, { 'Cache-Control': cache });
    } catch (err) {
      const response = errorResponse(err);
      if (err?.allow) response.headers.set('Allow', err.allow);
      return response;
    }
  }

  return { itinerary, place, config };
}
