// Frontend guard rails: the page stays compatible with the strict security policy,
// matches what the server accepts, and keeps the plain visual style (no emoji, no gradients).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INTERESTS } from '../server/validate.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (name) => readFileSync(join(PUBLIC, name), 'utf8');
const textFiles = readdirSync(PUBLIC).filter((n) => /\.(html|css|js)$/.test(n));
const html = read('index.html');

test('page has no inline styles or inline scripts (the security policy blocks them)', () => {
  assert.ok(!/\sstyle\s*=/.test(html), 'style attribute in index.html');
  assert.ok(!/<style[\s>]/i.test(html), '<style> tag in index.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler in index.html');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\ssrc=/, 'inline <script> in index.html');
    assert.equal(m[2].trim(), '', 'inline <script> body in index.html');
  }
});

test('scripts build the page with DOM methods, never innerHTML', () => {
  for (const name of textFiles.filter((n) => n.endsWith('.js'))) {
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(read(name)), name);
  }
});

test('interest checkboxes match exactly what the server accepts', () => {
  const values = [...html.matchAll(/name="interests" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, INTERESTS);
});

test('every local file the page references exists', () => {
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]).filter((r) => r !== '/');
  for (const name of textFiles.filter((n) => n.endsWith('.css'))) {
    refs.push(...[...read(name).matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]));
  }
  assert.ok(refs.length > 0);
  for (const ref of refs) assert.ok(existsSync(join(PUBLIC, ref)), `missing ${ref}`);
});

test('every icon the page asks for is defined', async () => {
  const { ICON_NAMES } = await import('../public/icons.js');
  const wanted = new Set([...html.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1]));
  const patterns = [
    /\bicon\(\s*'([a-z-]+)'/g, // icon('x')
    /\bicon:\s*'([a-z-]+)'/g, // { icon: 'x' }
    /\b(?:fact|logisticsBlock)\(\s*'([a-z-]+)'/g, // helpers whose first argument is an icon
    /\bwithIcon\('[^']*',\s*'[^']*',\s*'([a-z-]+)'/g, // third argument
    /\bexternalLink\([^;]*?,\s*'([a-z-]+)'\s*[,)]/g, // third argument
  ];
  for (const name of textFiles.filter((n) => n.endsWith('.js') && n !== 'icons.js')) {
    for (const re of patterns) for (const m of read(name).matchAll(re)) wanted.add(m[1]);
  }
  assert.ok(wanted.size >= 15, `only found ${wanted.size} icon uses; the patterns may be stale`);
  for (const name of wanted) assert.ok(ICON_NAMES.includes(name), `unknown icon ${name}`);
});

test('no emoji, em dashes or gradients in the page files', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  for (const name of textFiles) {
    const text = read(name);
    assert.ok(!emoji.test(text.replace(/[©®™]/g, '')), `emoji in ${name}`);
    assert.ok(!text.includes('\u2014'), `em dash in ${name}`);
    assert.ok(!/gradient\(/.test(text), `gradient in ${name}`);
  }
});
