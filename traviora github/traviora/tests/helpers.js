// Shared test tools. Everything here is FAKE: fake keys, fake provider replies, no internet.
import { createApp } from '../server/app.js';

export const FAKE_GEMINI_KEY = 'FAKE_GEMINI_KEY_FOR_TESTS_ONLY';
export const FAKE_GROQ_KEY = 'FAKE_GROQ_KEY_FOR_TESTS_ONLY';

export function testEnv(extra = {}) {
  return {
    GEMINI_API_KEY: FAKE_GEMINI_KEY,
    GROQ_API_KEY: FAKE_GROQ_KEY,
    PROVIDER_TIMEOUT_MS: '1000',
    ...extra,
  };
}

/** A valid itinerary in the exact shape the AI is asked to return. */
export function validSection({ days = 2, tag = 'x' } = {}) {
  const option = (n) => ({ name: `Option ${n} ${tag}`, description: 'A short sentence.', estimatedCost: '₹100 per day' });
  return {
    title: 'ignored - server sets the title',
    transportationOptions: [option(1), option(2), option(3)],
    accommodationOptions: [option(4), option(5), option(6)],
    days: Array.from({ length: days }, (_, i) => ({
      day: i + 1,
      title: `Theme ${i + 1}`,
      places: [1, 2].map((p) => ({
        name: `Place ${i + 1}-${p} ${tag}`,
        description: 'Nice place.',
        whyItFits: 'Fits your interests.',
        duration: '1-2 hours',
        estimatedCost: '₹50',
        location: `Place ${i + 1}-${p}`,
      })),
    })),
  };
}

export const jsonRes = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
export const geminiOk = (obj) => jsonRes(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] });
export const groqOk = (obj) => jsonRes(200, { choices: [{ finish_reason: 'stop', message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });

/** A fetch that hangs until the caller's timeout aborts it (like a stuck server). */
export const hang = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

/**
 * Fake internet. `script` has two lists of behaviours, one per provider; each call uses the next
 * one (the last one repeats). A behaviour is a Response or a function (url, init, body) => Response.
 * Every call is recorded in `calls`.
 */
export function fakeInternet({ gemini = [], groq = [], other = null } = {}) {
  const calls = [];
  const counters = { gemini: 0, groq: 0 };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const provider = u.includes('generativelanguage.googleapis.com') ? 'gemini' : u.includes('api.groq.com') ? 'groq' : 'other';
    const body = init.body ? JSON.parse(init.body) : null;
    const prompt = provider === 'gemini' ? body?.contents?.[0]?.parts?.[0]?.text : body?.messages?.[0]?.content;
    const model = provider === 'gemini' ? u.match(/models\/([^:]+):/)?.[1] : body?.model;
    calls.push({ provider, url: u, init, body, prompt, model, section: prompt?.includes('Experience the classics') ? 'iconic' : prompt?.includes('India Beyond') ? 'hidden' : undefined });
    if (provider === 'other') {
      if (!other) throw new Error('unexpected request to ' + u);
      return other(u, init);
    }
    const list = provider === 'gemini' ? gemini : groq;
    const behaviour = list[Math.min(counters[provider], list.length - 1)];
    counters[provider] += 1;
    if (!behaviour) throw new Error(`no scripted behaviour for ${provider}`);
    return typeof behaviour === 'function' ? behaviour(u, init, body, calls[calls.length - 1]) : behaviour.clone();
  };
  return { fetchImpl, calls, count: (p) => calls.filter((c) => c.provider === p).length };
}

export function makeApp({ fetchImpl, env = {}, now } = {}) {
  const logs = [];
  const sleeps = [];
  const app = createApp({
    env: testEnv(env),
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    now,
    log: (line) => logs.push(String(line)),
  });
  return { app, logs, sleeps };
}

export const goodBody = (extra = {}) => ({ section: 'hidden', city: 'Patna', budget: '5000', days: '2', travelers: '2', interests: ['Food'], ...extra });

export function postItinerary(app, body, { headers = {}, ip = '1.1.1.1', raw } = {}) {
  return app.itinerary(new Request('http://localhost/api/itinerary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, ...headers },
    body: raw ?? JSON.stringify(body),
  }));
}

export async function read(res) {
  return { status: res.status, headers: res.headers, json: await res.json() };
}
