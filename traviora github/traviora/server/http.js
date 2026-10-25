// Small helpers shared by the two API endpoints: JSON replies, client identification,
// origin checking and size-limited body reading. Uses the standard Web Request/Response
// objects, which is what Vercel passes to `fetch(request)` handlers (and what server.js
// recreates locally).

import { ApiError } from './errors.js';

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

export function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

export function errorResponse(err) {
  if (err instanceof ApiError) {
    const headers = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {};
    return jsonResponse(
      err.status,
      {
        error: { code: err.code, message: err.message, retryable: err.retryable, retryAfterSec: err.retryAfterSec ?? undefined },
        meta: err.meta ?? undefined,
      },
      headers,
    );
  }
  // Anything unexpected: generic message only. Details stay out of the response.
  return jsonResponse(500, {
    error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.', retryable: true },
  });
}

/**
 * Identifies the caller for rate limiting. On Vercel the platform sets these headers; locally,
 * server.js sets x-forwarded-for from the real connection. Header spoofing can only matter if
 * the app is placed behind a proxy you do not control.
 */
export function getClientId(request) {
  const h = request.headers;
  const candidate =
    h.get('x-vercel-forwarded-for') || h.get('x-real-ip') || (h.get('x-forwarded-for') || '').split(',')[0];
  return (candidate || 'unknown').trim().slice(0, 64) || 'unknown';
}

/** Browsers always send Origin on cross-site POSTs. Reject ones that are not ours. */
export function checkOrigin(request, allowedOrigins = []) {
  const origin = request.headers.get('origin');
  if (!origin) return; // non-browser clients (curl) or same-origin GET: nothing to check
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, 'forbidden_origin', 'Request origin not allowed.');
  }
  const ownHosts = [request.headers.get('x-forwarded-host'), request.headers.get('host')].filter(Boolean);
  if (ownHosts.includes(originHost) || allowedOrigins.includes(origin)) return;
  throw new ApiError(403, 'forbidden_origin', 'Request origin not allowed.');
}

/** Reads and parses a JSON body, refusing anything bigger than maxBytes. */
export async function readJsonBody(request, maxBytes) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'unsupported_type', 'Send the request as JSON.');
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, 'too_large', 'Request is too large.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid_json', 'Request body is empty.');
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, 'too_large', 'Request is too large.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}
