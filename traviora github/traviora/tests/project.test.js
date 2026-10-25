// Project-level checks: no secrets in files, .env ignored by Git, and the local server
// (server.js) really serves the page and routes API calls. No provider is contacted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRateLimiter } from '../server/rateLimit.js';
import { IMAGE_HOSTS } from '../server/wikipedia.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Real environment files (.env, .env.local, .env.production, ...) hold real keys, so the tests
// skip them by NAME and never open them. .env.example is a committed template and IS scanned.
const isRealEnvFile = (name) => /^\.env(\..*)?$/i.test(name) && name.toLowerCase() !== '.env.example';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || isRealEnvFile(name)) continue;
    const full = join(dir, name);
    statSync(full).isDirectory() ? walk(full, out) : out.push(full);
  }
  return out;
}

// ---------- secrets ----------

const KEY_SHAPES = [/AIza[0-9A-Za-z_-]{20,}/, /gsk_[0-9A-Za-z]{20,}/, /\bsk-[0-9A-Za-z]{20,}/, /Bearer\s+[A-Za-z0-9._-]{30,}/];

test('no file in the project contains something shaped like a real API key', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, 'utf8');
    if (KEY_SHAPES.some((re) => re.test(text))) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});

test('frontend files contain no key variables or provider addresses', () => {
  for (const file of walk(join(ROOT, 'public'))) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/generativelanguage\.googleapis|api\.groq\.com|x-goog-api-key|GEMINI_API_KEY|GROQ_API_KEY/.test(text), relative(ROOT, file));
  }
});

test('secret scan skips real env files by name, without opening them, but still scans .env.example', () => {
  for (const name of ['.env', '.env.local', '.env.development.local', '.env.production', '.env.test', '.ENV']) {
    assert.ok(isRealEnvFile(name), name);
  }
  for (const name of ['.env.example', '.ENV.EXAMPLE', 'env.js', '.envrc', 'my.env', 'README.md']) {
    assert.ok(!isRealEnvFile(name), name);
  }
  // A throwaway folder with empty files: walk() must not list (so the scan cannot read) the real env files.
  const dir = mkdtempSync(join(tmpdir(), 'traviora-walk-'));
  try {
    mkdirSync(join(dir, 'sub'));
    for (const f of ['.env', '.env.local', '.env.development.local', '.env.production', '.env.example', 'notes.txt', 'sub/.env.test', 'sub/app.js']) {
      writeFileSync(join(dir, f), '');
    }
    const listed = walk(dir).map((f) => relative(dir, f).replace(/\\/g, '/')).sort();
    assert.deepEqual(listed, ['.env.example', 'notes.txt', 'sub/app.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- ignore files ----------

/** Minimal .gitignore / .vercelignore evaluation for a top-level file name (last matching rule wins). */
function isIgnored(rulesText, fileName) {
  let ignored = false;
  for (const raw of rulesText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const pattern = (negate ? line.slice(1) : line).replace(/^\//, '');
    if (pattern.endsWith('/') || pattern.includes('/')) continue; // folder and path rules do not apply here
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
    if (re.test(fileName)) ignored = !negate;
  }
  return ignored;
}

const REAL_ENV_NAMES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test'];

for (const ignoreFile of ['.gitignore', '.vercelignore']) {
  test(`${ignoreFile} excludes .env and real .env.* files but keeps .env.example`, () => {
    const rules = readFileSync(join(ROOT, ignoreFile), 'utf8');
    for (const name of REAL_ENV_NAMES) assert.ok(isIgnored(rules, name), `${ignoreFile} does not exclude ${name}`);
    assert.ok(!isIgnored(rules, '.env.example'), `${ignoreFile} excludes .env.example`);
    for (const name of ['package.json', 'server.js', 'vercel.json']) assert.ok(!isIgnored(rules, name), `${ignoreFile} excludes ${name}`);
  });
}

test('no env file of any kind sits inside public/ (everything there is published)', () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(vercel.outputDirectory, 'public'); // the folder Vercel publishes
  const found = [];
  const look = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) { // names only; nothing is opened
      const full = join(dir, entry.name);
      if (/^\.env/i.test(entry.name)) found.push(relative(ROOT, full));
      else if (entry.isDirectory()) look(full);
    }
  };
  look(join(ROOT, 'public'));
  assert.deepEqual(found, []);
});

test('.env.example contains placeholders only', () => {
  const secretNames = /^(GEMINI|GROQ)_API_KEY(_HIDDEN|_ICONIC)?=(.*)$/;
  for (const line of readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n')) {
    const m = line.replace(/^#\s*/, '').match(secretNames);
    if (m) assert.ok(m[3] === '' || m[3].startsWith('paste_your_'), `unexpected value for ${line.split('=')[0]}`);
  }
});

// ---------- rate limiter unit tests ----------

test('rate limiter: counts per key, resets after the window, stays bounded in memory', () => {
  let t = 0;
  const rl = createRateLimiter({ max: 2, windowMs: 1000, now: () => t, maxKeys: 3 });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, true);
  const third = rl.take('a');
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSec, 1);
  assert.equal(rl.take('b').allowed, true);
  t = 1001;
  assert.equal(rl.take('a').allowed, true);
  for (let i = 0; i < 50; i += 1) rl.take(`client-${i}`);
  assert.ok(rl.size() <= 4);
});

// ---------- local server ----------

let child;
let base;

before(async () => {
  const port = 39000 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  // No keys on purpose: nothing here can reach an AI provider.
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), GEMINI_API_KEY: '', GROQ_API_KEY: '' },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('Open http')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
  });
});

after(() => child?.kill());

test('local server: serves the planner page, styles and scripts with security headers', async () => {
  for (const path of ['/', '/styles.css', '/app.js', '/render.js']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  }
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /id="generateBtn"/);
  assert.match(html, /Plan a trip in India, two ways/);
  const font = await fetch(base + '/fonts/source-serif-4-latin-600-normal.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
});

// ---------- security headers: local server and Vercel must match ----------

const SECURITY_HEADER_NAMES = [
  'content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy',
  'strict-transport-security', 'permissions-policy', 'cross-origin-opener-policy',
  'cross-origin-resource-policy', 'cross-origin-embedder-policy',
];

function vercelHeaders() {
  const rules = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).headers || [];
  const all = rules.filter((r) => r.source === '/(.*)');
  assert.equal(all.length, 1, 'vercel.json should have exactly one header rule for every path, "/(.*)"');
  return Object.fromEntries(all[0].headers.map((h) => [h.key.toLowerCase(), h.value]));
}

test('local server sends exactly the same security headers as vercel.json (pages, files, errors and API)', async () => {
  const expected = vercelHeaders();
  assert.ok(expected['content-security-policy'], 'vercel.json has no Content-Security-Policy');
  for (const path of ['/', '/app.js', '/styles.css', '/no-such-file.txt', '/api/place']) {
    const res = await fetch(base + path);
    await res.arrayBuffer();
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(res.headers.get(key), value, `${key} differs on ${path}`);
    }
    for (const key of SECURITY_HEADER_NAMES) {
      if (res.headers.has(key)) assert.ok(key in expected, `local server sends ${key} on ${path} but vercel.json does not`);
    }
  }
});

test('photo hosts in the Content-Security-Policy match the hosts the server accepts', () => {
  const csp = vercelHeaders()['content-security-policy'];
  const imgSrc = csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === 'img-src');
  assert.ok(imgSrc, 'no img-src directive');
  assert.deepEqual(
    imgSrc.slice(1).sort(),
    ["'self'", 'data:', ...IMAGE_HOSTS.map((h) => `https://${h}`)].sort(),
  );
});

test('local server: refuses path tricks outside public/', async () => {
  for (const path of ['/..%2Fpackage.json', '/%2e%2e/.env.example', '/../server/config.js']) {
    const res = await fetch(base + path);
    assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('GEMINI_MODELS') && !text.includes('"type": "module"'));
  }
});

test('local server: /api/itinerary routes to the real handler (no keys -> clear error, nothing sent out)', async () => {
  const res = await fetch(`${base}/api/itinerary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'hidden', city: 'Patna', budget: '5000', days: '2' }),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'not_configured');
});

test('local server: validation errors come back as JSON 400', async () => {
  const res = await fetch(`${base}/api/itinerary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'hidden', city: '', budget: '5000', days: '2' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_input');
});

test('local server: GET /api/itinerary is 405 and /api/place without a name is 400', async () => {
  assert.equal((await fetch(`${base}/api/itinerary`)).status, 405);
  assert.equal((await fetch(`${base}/api/place`)).status, 400);
});
