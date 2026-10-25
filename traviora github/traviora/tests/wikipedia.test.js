// Wikipedia enrichment: results, failure states, timeouts and caching - all with a fake Wikipedia.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IMAGE_HOSTS, createWikipediaClient, isRelevantTitle, safeImage, viewsToScore } from '../server/wikipedia.js';
import { hang, jsonRes, makeApp, read } from './helpers.js';

/** Fake Wikipedia. `routes` maps a URL fragment to a Response (or function). Unknown URLs are a test failure. */
function fakeWiki(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = decodeURIComponent(String(url));
    calls.push({ url: u, init });
    for (const [fragment, reply] of routes) {
      if (u.includes(fragment)) return typeof reply === 'function' ? reply(u, init) : reply.clone();
    }
    throw new Error(`unexpected request ${u}`);
  };
  return { fetchImpl, calls };
}

const summary = (title, extra = {}) =>
  jsonRes(200, { type: 'standard', title, thumbnail: { source: 'https://upload.wikimedia.org/x/thumb.jpg' }, ...extra });
const views = (n) => jsonRes(200, { items: [{ views: n }, { views: 0 }] });
const client = (routes, opts = {}) => {
  const wiki = fakeWiki(routes);
  return { wiki, wp: createWikipediaClient({ fetchImpl: wiki.fetchImpl, timeoutMs: 1000, ...opts }) };
};

test('score formula is unchanged: 0 views -> 10, famous pages -> near 0, clamped to 0-10', () => {
  assert.equal(viewsToScore(0), 10);
  assert.equal(viewsToScore(1000), 5.8);
  assert.equal(viewsToScore(10 ** 9), 0);
});

test('found: exact title gives photo and score', async () => {
  const { wp } = client([['page/summary/Golghar', summary('Golghar')], ['per-article', views(1000)]]);
  const r = await wp.lookup({ name: 'Golghar', city: 'Patna' });
  assert.equal(r.status, 'found');
  assert.equal(r.hasArticle, true);
  assert.equal(r.score, 5.8);
  assert.equal(r.image, 'https://upload.wikimedia.org/x/thumb.jpg');
});

test('found: search fallback includes the city and checks relevance', async () => {
  const { wiki, wp } = client([
    ['page/summary/Agam Kuan (well)', summary('Agam Kuan (well)')],
    ['page/summary/Agam Kuan', jsonRes(404, {})],
    ['srsearch=Agam Kuan Patna', jsonRes(200, { query: { search: [{ title: 'Unrelated Thing' }, { title: 'Agam Kuan (well)' }] } })],
    ['per-article', views(50)],
  ]);
  const r = await wp.lookup({ name: 'Agam Kuan', city: 'Patna' });
  assert.equal(r.status, 'found');
  assert.equal(r.title, 'Agam Kuan (well)'); // skipped the unrelated first result
  assert.ok(wiki.calls.some((c) => c.url.includes('srsearch=Agam Kuan Patna')));
});

test('not_found: Wikipedia answered "no article" -> shown as "Not yet on Wikipedia"', async () => {
  const { wp } = client([['page/summary', jsonRes(404, {})], ['list=search', jsonRes(200, { query: { search: [] } })]]);
  const r = await wp.lookup({ name: 'Tiny Village Shrine', city: 'X' });
  assert.equal(r.status, 'not_found');
  assert.equal(r.hasArticle, false);
});

test('an irrelevant search result is rejected (no wrong photo or score)', async () => {
  const { wp } = client([
    ['page/summary', jsonRes(404, {})],
    ['list=search', jsonRes(200, { query: { search: [{ title: 'Completely different subject' }] } })],
  ]);
  assert.equal((await wp.lookup({ name: 'Quiet Ghat', city: 'Patna' })).status, 'not_found');
});

test('disambiguation pages are not accepted as a match', async () => {
  const { wp } = client([
    ['page/summary', jsonRes(200, { type: 'disambiguation', title: 'Gandhi Maidan (disambiguation)' })],
    ['list=search', jsonRes(200, { query: { search: [] } })],
  ]);
  assert.equal((await wp.lookup({ name: 'Gandhi Maidan', city: 'Patna' })).status, 'not_found');
});

test('unavailable: a Wikipedia outage is NOT reported as "not on Wikipedia"', async () => {
  const { wp } = client([['page/summary', () => { throw new TypeError('fetch failed'); }], ['list=search', () => { throw new TypeError('fetch failed'); }]]);
  const r = await wp.lookup({ name: 'Golghar', city: 'Patna' });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.hasArticle, null);
});

test('unavailable: HTTP 500 from Wikipedia is an outage too', async () => {
  const { wp } = client([['page/summary', jsonRes(500, {})], ['list=search', jsonRes(500, {})]]);
  assert.equal((await wp.lookup({ name: 'Golghar', city: 'Patna' })).status, 'unavailable');
});

test('timeout: a hanging Wikipedia is cut off quickly and reported as unavailable', async () => {
  const { wp } = client([['page/summary', hang], ['list=search', hang]], { timeoutMs: 300 });
  const started = Date.now();
  const r = await wp.lookup({ name: 'Golghar', city: 'Patna' });
  assert.equal(r.status, 'unavailable');
  assert.ok(Date.now() - started < 1500, 'must not wait for the hung request');
});

test('pageview failure keeps the match and photo, but no score is invented', async () => {
  const { wp } = client([['page/summary/Golghar', summary('Golghar')], ['per-article', jsonRes(500, {})]]);
  const r = await wp.lookup({ name: 'Golghar', city: 'Patna' });
  assert.equal(r.status, 'found');
  assert.equal(r.score, null);
  assert.ok(r.image);
});

test('images from non-Wikimedia hosts or non-https URLs are dropped', async () => {
  for (const source of ['https://evil.example/x.jpg', 'http://upload.wikimedia.org/x.jpg', 'javascript:alert(1)']) {
    const { wp } = client([['page/summary', jsonRes(200, { type: 'standard', title: 'Golghar', thumbnail: { source } })], ['per-article', views(5)]]);
    assert.equal((await wp.lookup({ name: 'Golghar', city: 'P' })).image, null, source);
  }
});

// Real thumbnail URL shapes, as Wikipedia's summary API returned them on 2026-10-24.
const THUMB_URL = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fb/20191219_Fort_Amber%2C_Amer%2C_Jaipur_0955_9481.jpg/330px-20191219_Fort_Amber%2C_Amer%2C_Jaipur_0955_9481.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail';
const UPLOAD_URL = 'https://upload.wikimedia.org/wikipedia/commons/f/fb/20191219_Fort_Amber%2C_Amer%2C_Jaipur_0955_9481.jpg';

test('image filter accepts https photos from thumb.wikimedia.org and upload.wikimedia.org', () => {
  assert.deepEqual([...IMAGE_HOSTS].sort(), ['thumb.wikimedia.org', 'upload.wikimedia.org']);
  assert.equal(safeImage(THUMB_URL), THUMB_URL);
  assert.equal(safeImage(UPLOAD_URL), UPLOAD_URL);
  assert.equal(safeImage('https://upload.wikimedia.org/x/thumb.jpg'), 'https://upload.wikimedia.org/x/thumb.jpg');
  assert.equal(safeImage('https://THUMB.wikimedia.org/a.jpg'), 'https://thumb.wikimedia.org/a.jpg'); // hosts are case-insensitive
  assert.equal(safeImage('https://thumb.wikimedia.org:443/a.jpg'), 'https://thumb.wikimedia.org/a.jpg'); // 443 is the https default
});

test('image filter rejects other hosts, lookalikes, http and unsafe URL formats', () => {
  const rejected = [
    'http://thumb.wikimedia.org/a.jpg', // not https
    'http://upload.wikimedia.org/a.jpg',
    'https://evil.example/a.jpg',
    'https://wikimedia.org/a.jpg', // parent domain is not an image host
    'https://commons.wikimedia.org/a.jpg', // other Wikimedia subdomain
    'https://maps.wikimedia.org/a.jpg',
    'https://thumb.wikimedia.org.evil.example/a.jpg', // lookalike suffix
    'https://evilthumb.wikimedia.org/a.jpg',
    'https://xthumb.wikimedia.org/a.jpg',
    'https://thumb-wikimedia.org/a.jpg',
    'https://thumb.wikimedia.org./a.jpg', // trailing dot
    'https://thumb.wikimedia.org@evil.example/a.jpg', // real host is evil.example
    'https://user@thumb.wikimedia.org/a.jpg', // credentials
    'https://user:pass@upload.wikimedia.org/a.jpg',
    'https://thumb.wikimedia.org:8443/a.jpg', // non-default port
    '//thumb.wikimedia.org/a.jpg', // protocol-relative
    '/wikipedia/commons/a.jpg', // relative
    'thumb.wikimedia.org/a.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'blob:https://thumb.wikimedia.org/1234',
    'ftp://thumb.wikimedia.org/a.jpg',
    `https://thumb.wikimedia.org/${'a'.repeat(2100)}.jpg`, // absurdly long
    '',
    null,
    undefined,
    42,
    { href: THUMB_URL },
  ];
  for (const url of rejected) assert.equal(safeImage(url), null, String(url).slice(0, 80));
});

test('a lookup whose summary has a thumb.wikimedia.org thumbnail returns that photo', async () => {
  const { wp } = client([
    ['page/summary/Amber Fort', jsonRes(200, { type: 'standard', title: 'Amber Fort', thumbnail: { source: THUMB_URL } })],
    ['per-article', views(1000)],
  ]);
  const r = await wp.lookup({ name: 'Amber Fort', city: 'Jaipur' });
  assert.equal(r.status, 'found');
  assert.equal(r.image, THUMB_URL);
});

test('/api/place passes a thumb.wikimedia.org photo through, and drops an untrusted one', async () => {
  for (const [source, expected] of [[THUMB_URL, THUMB_URL], ['https://thumb.wikimedia.org.evil.example/a.jpg', null]]) {
    const wiki = fakeWiki([
      ['page/summary', jsonRes(200, { type: 'standard', title: 'Amber Fort', thumbnail: { source } })],
      ['per-article', views(1000)],
    ]);
    const { app } = makeApp({ fetchImpl: wiki.fetchImpl });
    const r = await read(await app.place(new Request('http://localhost/api/place?name=Amber%20Fort&city=Jaipur')));
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'found');
    assert.equal(r.json.image, expected);
  }
});

test('results are cached; outages are not', async () => {
  const ok = client([['page/summary/Golghar', summary('Golghar')], ['per-article', views(5)]]);
  await ok.wp.lookup({ name: 'Golghar', city: 'Patna' });
  const callsAfterFirst = ok.wiki.calls.length;
  await ok.wp.lookup({ name: 'Golghar', city: 'Patna' });
  assert.equal(ok.wiki.calls.length, callsAfterFirst);

  let down = true;
  const flaky = client([
    ['page/summary', () => (down ? jsonRes(500, {}) : summary('Golghar'))],
    ['list=search', () => (down ? jsonRes(500, {}) : jsonRes(200, { query: { search: [] } }))],
    ['per-article', views(5)],
  ]);
  assert.equal((await flaky.wp.lookup({ name: 'Golghar', city: 'Patna' })).status, 'unavailable');
  down = false;
  assert.equal((await flaky.wp.lookup({ name: 'Golghar', city: 'Patna' })).status, 'found');
});

test('requests identify the app with a User-Agent', async () => {
  const { wiki, wp } = client([['page/summary/Golghar', summary('Golghar')], ['per-article', views(5)]], { contact: 'owner@example.com' });
  await wp.lookup({ name: 'Golghar', city: 'Patna' });
  assert.match(wiki.calls[0].init.headers['User-Agent'], /^Traviora\/1\.0 .*owner@example\.com/);
});

test('relevance check: shared meaningful word required; empty comparison is NOT a match', () => {
  assert.equal(isRelevantTitle('Agam Kuan', 'Agam Kuan'), true);
  assert.equal(isRelevantTitle('Golghar Patna', 'Golghar'), true);
  assert.equal(isRelevantTitle('Agam Kuan', 'Delhi'), false);
  assert.equal(isRelevantTitle('Taj', 'Taj'), false); // words under 4 letters are ignored, so nothing to compare -> no match
});

// ---------- the HTTP endpoint ----------

test('/api/place returns 200 with an explicit status even when Wikipedia is down', async () => {
  const wiki = fakeWiki([['page/summary', () => { throw new TypeError('down'); }], ['list=search', () => { throw new TypeError('down'); }]]);
  const { app } = makeApp({ fetchImpl: wiki.fetchImpl });
  const res = await app.place(new Request('http://localhost/api/place?name=Golghar&city=Patna'));
  const r = await read(res);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'unavailable');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('/api/place caches stable answers and validates its query', async () => {
  const wiki = fakeWiki([['page/summary/Golghar', summary('Golghar')], ['per-article', views(5)]]);
  const { app } = makeApp({ fetchImpl: wiki.fetchImpl });
  const ok = await app.place(new Request('http://localhost/api/place?name=Golghar&city=Patna'));
  assert.match(ok.headers.get('Cache-Control'), /s-maxage=86400/);
  const bad = await app.place(new Request('http://localhost/api/place?city=Patna'));
  assert.equal(bad.status, 400);
});

test('/api/place has its own request limit', async () => {
  const wiki = fakeWiki([['page/summary', jsonRes(404, {})], ['list=search', jsonRes(200, { query: { search: [] } })]]);
  const { app } = makeApp({ fetchImpl: wiki.fetchImpl, env: { RATE_LIMIT_PLACE_PER_CLIENT: '1' } });
  const req = () => new Request('http://localhost/api/place?name=Somewhere&city=X', { headers: { 'x-forwarded-for': '5.5.5.5' } });
  assert.equal((await app.place(req())).status, 200);
  assert.equal((await app.place(req())).status, 429);
});
