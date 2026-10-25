// Local development server:  npm start   (or:  node --env-file=.env server.js)
//
// It does the same job Vercel does when deployed:
//   - serves the files in /public (the planner page)
//   - sends /api/itinerary and /api/place to the very same handler code Vercel runs
// It has no dependencies, so there is nothing to install.
//
// Differences from Vercel (see README): no CDN caching, no platform security headers beyond
// the ones below, one long-lived process (so the in-memory rate limit behaves more strictly
// than it will on serverless), and your computer's IP address is used as the client id.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './server/app.js';
import { createChat } from './server/chat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // only this computer can reach it

const app = createApp();
const chatApp = createChat();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// The same protective headers vercel.json adds in production.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://upload.wikimedia.org https://thumb.wikimedia.org data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Turns Node's request object into the standard Request object the handlers expect. */
function toWebRequest(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (['x-forwarded-for', 'x-real-ip', 'x-vercel-forwarded-for'].includes(key)) continue; // never trust these locally
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  headers.set('x-forwarded-for', req.socket.remoteAddress || 'unknown');
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req;
    init.duplex = 'half';
  }
  return new Request(`http://${req.headers.host || `localhost:${PORT}`}${req.url}`, init);
}

async function sendWebResponse(res, response, extraHeaders = {}) {
  // Header names are case-insensitive: merge by lowercase name so none is sent twice.
  const headers = {};
  for (const [key, value] of Object.entries(extraHeaders)) headers[key.toLowerCase()] = value;
  response.headers.forEach((value, key) => { headers[key] = value; }); // keys arrive lowercase
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS).end('Bad request'); // e.g. a stray "%" in the address
    return;
  }
  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = normalize(join(ROOT, requested));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) { // blocks ../ tricks
    res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, SECURITY_HEADERS).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/itinerary') return await sendWebResponse(res, await app.itinerary(toWebRequest(req)), SECURITY_HEADERS);
    if (pathname === '/api/place') return await sendWebResponse(res, await app.place(toWebRequest(req)), SECURITY_HEADERS);
    if (pathname === '/api/chat') return await sendWebResponse(res, await chatApp.chat(toWebRequest(req)), SECURITY_HEADERS);
    return await serveStatic(req, res);
  } catch (err) {
    console.error('Unexpected server error:', err?.name || 'Error');
    if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
    res.end('Internal server error');
  }
});

// Say plainly what is (and is not) configured, without ever printing a key.
const c = app.config;
const has = (k) => (k ? 'set' : 'MISSING');
console.log('Traviora local server');
console.log(`  Gemini key: ${has(c.keys.gemini.hidden && c.keys.gemini.iconic)} | models: ${c.gemini.models.join(', ')}`);
console.log(`  Groq key:   ${has(c.keys.groq.hidden && c.keys.groq.iconic)} | models: ${c.groq.models.join(', ')}`);
console.log(`  Wikipedia contact: ${c.wikimediaContact ? 'set' : 'MISSING (most photos will not load: add WIKIMEDIA_CONTACT to .env, see README)'}`);
console.log(`  Agent 37 chat: ${chatApp.configured ? 'set' : 'MISSING (add AGENT37_API_URL and AGENT37_API_KEY to .env, see CHAT_SETUP.md)'}`);
if (c.forceGroqTest) console.log('  FORCE_GROQ_TEST is on: Gemini will be skipped.');
if (!c.keys.gemini.hidden && !c.keys.groq.hidden) console.log('  No provider key found. Did you copy .env.example to .env and fill it in?');

server.listen(PORT, HOST, () => console.log(`\nOpen http://localhost:${PORT} in your browser. Press Ctrl+C to stop.`));
