// Landing page checks: photos and their credits, in-page links, the form app.js needs, and the
// "Plan my trip" links. Only the last test starts the local server (no keys, nothing sent out).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const read = (name) => readFileSync(join(PUBLIC, name), 'utf8');
const html = read('index.html');
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const count = (text, needle) => text.split(needle).length - 1;
const images = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);

test('every landing photo is a local file with its size, a description and every srcset file', () => {
  assert.equal(images.length, 6);
  for (const img of images) {
    const src = attr(img, 'src');
    assert.match(src, /^images\/[a-z0-9-]+\.webp$/, src);
    assert.match(attr(img, 'width') || '', /^\d+$/, `width on ${src}`);
    assert.match(attr(img, 'height') || '', /^\d+$/, `height on ${src}`);
    assert.ok((attr(img, 'alt') || '').length > 20, `alt text on ${src}`);
    const files = (attr(img, 'srcset') || '').split(',').map((c) => c.trim().split(/\s+/)[0]);
    assert.ok(files.includes(src), `srcset on ${src} should include src`);
    for (const file of files) assert.ok(existsSync(join(PUBLIC, file)), `missing ${file}`);
  }
});

test('each numbered photo has a matching credit with its Commons page and licence', () => {
  const figures = [...html.matchAll(/<figure\b[\s\S]*?<\/figure>/g)].map((m) => m[0]).filter((f) => f.includes('<img'));
  const captions = figures.map((f) => f.match(/<figcaption>[\s\S]*?<span class="photo-index">(\d\d)<\/span>/)?.[1]).filter(Boolean);
  const list = html.match(/<ol class="credits-list">([\s\S]*?)<\/ol>/)?.[1] || '';
  const credits = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(captions.length, images.length, 'every photo caption has a number');
  assert.deepEqual(credits.map((c) => c.match(/photo-index">(\d\d)</)?.[1]), [...captions].sort());
  for (const credit of credits) {
    assert.match(credit, /href="https:\/\/commons\.wikimedia\.org\/wiki\/File:[^"]+"/);
    assert.match(credit, /href="https:\/\/creativecommons\.org\/licenses\/by-sa\/[34]\.0\/">CC BY-SA [34]\.0</);
    assert.match(credit, /<\/a> by [^<]+, <a/, 'credit names the author');
  }
});

test('every in-page link points at something on the page', () => {
  const targets = [...html.matchAll(/href="#([^"]+)"/g), ...read('app.js').matchAll(/href = '#([^']+)'/g)].map((m) => m[1]);
  assert.ok(targets.length >= 5);
  for (const id of targets) assert.equal(count(html, `id="${id}"`), 1, `#${id}`);
});

test('the form keeps every element app.js looks up, each exactly once', () => {
  const app = read('app.js');
  const fields = [...app.match(/const FIELD_NAMES = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const ids = [...app.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(fields, ['city', 'budget', 'days', 'travelers']);
  for (const name of fields) ids.push(name, `${name}-hint`, `${name}-error`);
  for (const id of ids) assert.equal(count(html, `id="${id}"`), 1, `id="${id}"`);
  for (const name of fields) assert.match(html, new RegExp(`<input id="${name}" name="${name}"[^>]*aria-describedby="${name}-hint ${name}-error"`));
});

test('"Plan my trip" links only move to the form; the one submit button is inside it', () => {
  const ctas = [...html.matchAll(/<[a-z]+\b[^>]*\sdata-plan-cta\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(ctas.length >= 2);
  for (const cta of ctas) assert.match(cta, /^<a\b[^>]*\shref="#tripForm"/, cta);
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(buttons, ['<button class="btn-primary" type="submit" id="generateBtn">']);
  assert.equal(count(html, '<form'), 1);
  const form = html.match(/<form[\s\S]*?<\/form>/)[0];
  assert.ok(form.includes('id="generateBtn"'), 'submit button sits inside the form');
  assert.ok(!/submit\(|requestSubmit|dispatchEvent/.test(read('landing.js')), 'landing.js must never submit');
  assert.ok(html.indexOf('src="app.js"') < html.indexOf('src="landing.js"'), 'app.js loads first');
});

test('the page offers nothing the app does not have (no accounts, bookings or reviews)', () => {
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.ok(!/type="password"/.test(html));
  assert.ok(!/\b(log in|login|sign in|book now|checkout|testimonials?|reviews?|ratings?)\b/i.test(text));
  assert.ok(!/\u2605|\u2606/.test(text), 'no star ratings');
});

test('the display font is local and ships with its licence', () => {
  const css = read('styles.css');
  assert.match(css, /@font-face\s*{[^}]*font-family:\s*['"]Bricolage Grotesque['"][^}]*url\(['"]?fonts\/bricolage-grotesque-latin-wght-normal\.woff2/);
  assert.match(read('fonts/OFL-bricolage-grotesque.txt'), /SIL OPEN FONT LICENSE/i);
});

let child;
let base;

before(async () => {
  const port = 39500 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
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

test('local server: serves landing photos, the display font and landing.js with the right types', async () => {
  const expected = {
    '/images/key-monastery-spiti-600.webp': 'image/webp',
    '/fonts/bricolage-grotesque-latin-wght-normal.woff2': 'font/woff2',
    '/landing.js': /javascript/,
  };
  for (const [path, type] of Object.entries(expected)) {
    const res = await fetch(base + path);
    await res.arrayBuffer();
    assert.equal(res.status, 200, path);
    if (type instanceof RegExp) assert.match(res.headers.get('content-type'), type, path);
    else assert.equal(res.headers.get('content-type'), type, path);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/, path);
  }
});
