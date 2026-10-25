// Photos and destination details: photo found / missing / failed, Wikipedia's rate limit,
// better matching, and the destination page's text + gallery. All with a fake Wikipedia.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { photoState, wikimediaImage } from '../public/render.js';
import {
  areaCandidates, countSentences, createWikipediaClient, isRelevantTitle, pickParagraphs, plainText, safeLink, withoutBrackets,
} from '../server/wikipedia.js';
import { jsonRes, makeApp, read } from './helpers.js';

/** Fake Wikipedia: the first route whose fragment is in the URL answers. Unknown URLs fail the test. */
function fakeWiki(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = decodeURIComponent(String(url));
    calls.push(u);
    for (const [fragment, reply] of routes) {
      if (u.includes(fragment)) return typeof reply === 'function' ? reply(u, init) : reply.clone();
    }
    throw new Error(`unexpected request ${u}`);
  };
  return { fetchImpl, calls };
}

const THUMB = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/4/41/Hawa.jpg/330px-Hawa.jpg';
const summary = (title, extra = {}) => jsonRes(200, { type: 'standard', title, thumbnail: { source: THUMB }, ...extra });
const noPhotoSummary = (title) => jsonRes(200, { type: 'standard', title });
const views = (n) => jsonRes(200, { items: [{ views: n }] });
const missing = () => jsonRes(404, {});
const noResults = () => jsonRes(200, { query: { search: [] } });
const extract = (text) => jsonRes(200, { query: { pages: [{ title: 'x', extract: text }] } });
const mediaList = (files) => jsonRes(200, { items: files.map((title) => ({ title, type: 'image', showInGallery: true })) });

/** imageinfo answer for media-list file names (underscores), in reverse order like the real API may send. */
function imageInfo(files, { evil = [] } = {}) {
  const pages = files.map((file, i) => {
    const name = file.replace(/^File:/, '');
    return {
      title: file.replace(/_/g, ' '),
      imageinfo: [{
        thumburl: evil.includes(file)
          ? 'https://evil.example/960px-x.jpg'
          : `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a${i}/${name}/960px-${name}`,
        thumbwidth: 960,
        thumbheight: i === 1 ? 1280 : 720,
        descriptionurl: `https://commons.wikimedia.org/wiki/${file}`,
        extmetadata: {
          Artist: { value: `<a href="//commons.wikimedia.org/wiki/User:A${i}">Asha ${i}</a> (<a href="//x">talk</a>)` },
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
          ImageDescription: { value: `<p>View number ${i}</p>` },
        },
      }],
    };
  }).reverse();
  return jsonRes(200, { query: { normalized: files.map((f) => ({ from: f, to: f.replace(/_/g, ' ') })), pages } });
}

const LONG_TEXT = 'The Hawa Mahal is a palace in Jaipur. It was built in 1799. Its facade has 953 small windows.\n'
  + 'The windows let cool air through the building. Royal women watched festivals from them.\n\n\nHistory\n\n'
  + 'It was designed by Lal Chand Ustad. It is five storeys high...\n\n\nSee also\nCity Palace\nJantar Mantar\n\n\nReferences';
const SIX_PHOTOS = [1, 2, 3, 4, 5, 6].map((n) => `File:Hawa_Mahal_${n}.jpg`);

const at = Date.UTC(2026, 9, 24, 12);
function client(routes, opts = {}) {
  const wiki = fakeWiki(routes);
  return { wiki, wp: createWikipediaClient({ fetchImpl: wiki.fetchImpl, timeoutMs: 1000, now: () => at, ...opts }) };
}

// ---------- the photo on each itinerary card ----------

test('photo found: the card shows the Wikipedia photo', async () => {
  const { wp } = client([['page/summary/Hawa Mahal', summary('Hawa Mahal')], ['per-article', views(1000)]]);
  const info = await wp.lookup({ name: 'Hawa Mahal', city: 'Jaipur' });
  assert.equal(info.status, 'found');
  assert.deepEqual(photoState(info), { kind: 'photo', src: THUMB });
});

test('photo missing: an article without a photo, or no article, shows a "No photo yet" placeholder', async () => {
  const { wp } = client([
    ['page/summary/Talle Valley', noPhotoSummary('Talle Valley Wildlife Sanctuary')],
    ['page/summary', missing()],
    ['list=search', noResults()],
    ['per-article', views(50)],
  ]);
  const noPhoto = await wp.lookup({ name: 'Talle Valley', city: 'Ziro' });
  assert.equal(noPhoto.status, 'found');
  assert.equal(noPhoto.image, null);
  assert.deepEqual(photoState(noPhoto), { kind: 'placeholder', label: 'No photo yet' });

  const noArticle = await wp.lookup({ name: 'Blue Lassi Shop', city: 'Varanasi' });
  assert.equal(noArticle.status, 'not_found');
  assert.deepEqual(photoState(noArticle), { kind: 'placeholder', label: 'No photo yet' });
});

test('photo failed: a failed lookup shows "Photo unavailable", never a wrong or unsafe photo', () => {
  assert.deepEqual(photoState({ status: 'unavailable' }), { kind: 'placeholder', label: 'Photo unavailable' });
  assert.deepEqual(photoState(null), { kind: 'placeholder', label: 'Photo unavailable' });
  for (const image of ['https://evil.example/a.jpg', 'http://upload.wikimedia.org/a.jpg', 'javascript:alert(1)', 42]) {
    assert.equal(photoState({ status: 'found', image }).kind, 'placeholder', String(image));
  }
  assert.equal(wikimediaImage('https://upload.wikimedia.org/a.jpg'), 'https://upload.wikimedia.org/a.jpg');
  assert.equal(wikimediaImage('https://thumb.wikimedia.org.evil.example/a.jpg'), null);
});

// ---------- Wikipedia's rate limit ----------

test('rate limit: a 429 pauses every lookup for Retry-After seconds, then lookups work again', async () => {
  let clock = at;
  let busy = true;
  const wiki = fakeWiki([
    ['page/summary/Golghar', () => (busy ? jsonRes(429, 'Too many requests', { 'Retry-After': '30' }) : summary('Golghar'))],
    ['per-article', views(5)],
  ]);
  const wp = createWikipediaClient({ fetchImpl: wiki.fetchImpl, timeoutMs: 1000, now: () => clock });

  const first = await wp.lookup({ name: 'Golghar', city: 'Patna' });
  assert.equal(first.status, 'unavailable'); // not "not on Wikipedia"
  assert.equal(first.retryAfter, 30);
  assert.equal(wiki.calls.length, 1, 'stops at the first 429 instead of trying more requests');

  const during = await wp.lookup({ name: 'Agam Kuan', city: 'Patna' });
  assert.equal(during.status, 'unavailable');
  assert.equal(wiki.calls.length, 1, 'nothing is sent while paused');

  clock += 31_000;
  busy = false;
  assert.equal((await wp.lookup({ name: 'Golghar', city: 'Patna' })).status, 'found');
});

test('rate limit: 503 with Retry-After pauses too (at most 60 s); a plain 500 does not pause', async () => {
  const limited = client([['page/summary', jsonRes(503, {}, { 'Retry-After': '600' })], ['list=search', noResults()]]);
  assert.equal((await limited.wp.lookup({ name: 'Golghar', city: 'Patna' })).retryAfter, 60);

  const broken = client([['page/summary', jsonRes(500, {})], ['list=search', jsonRes(500, {})]]);
  await broken.wp.lookup({ name: 'Golghar', city: 'Patna' });
  const before = broken.wiki.calls.length;
  await broken.wp.lookup({ name: 'Agam Kuan', city: 'Patna' });
  assert.ok(broken.wiki.calls.length > before, 'an ordinary error does not stop other lookups');
});

// ---------- better matching ----------

test('names with brackets are tried without them, and the bracket words are never used alone', async () => {
  assert.equal(withoutBrackets('Namdroling Monastery (Golden Temple)'), 'Namdroling Monastery');
  assert.equal(withoutBrackets('Hawa Mahal'), 'Hawa Mahal');
  const { wiki, wp } = client([
    ['page/summary/Namdroling Monastery, Coorg', missing()],
    ['page/summary/Namdroling Monastery (Golden Temple)', missing()],
    ['srsearch=Namdroling Monastery Golden Temple', noResults()],
    ['page/summary/Namdroling Monastery', summary('Namdroling Monastery')],
    ['per-article', views(100)],
  ]);
  const r = await wp.lookup({ name: 'Namdroling Monastery (Golden Temple)', city: 'Coorg' });
  assert.equal(r.status, 'found');
  assert.equal(r.title, 'Namdroling Monastery');
  assert.equal(r.image, THUMB);
  assert.ok(!wiki.calls.some((u) => u.includes('Golden Temple') && !u.includes('Namdroling')));

  // The other way round: both names are searched together, so the famous "Golden Temple" in Amritsar is not picked.
  const reverse = client([
    ['page/summary/Golden Temple, Coorg', missing()],
    ['page/summary/Golden Temple (Namdroling Monastery)', missing()],
    ['srsearch=Golden Temple Namdroling Monastery', jsonRes(200, { query: { search: [{ title: 'Namdroling Monastery' }] } })],
    ['page/summary/Namdroling Monastery', summary('Namdroling Monastery')],
    ['page/summary/Golden Temple', summary('Golden Temple')],
    ['per-article', views(100)],
  ]);
  const r2 = await reverse.wp.lookup({ name: 'Golden Temple (Namdroling Monastery)', city: 'Coorg' });
  assert.equal(r2.title, 'Namdroling Monastery');
  assert.ok(!reverse.wiki.calls.some((u) => u.endsWith('summary/Golden Temple')));
});

test('the trip city alone is never a match: no "Jaipur" article or photo for a small place', async () => {
  assert.equal(isRelevantTitle('Amer, Jaipur', 'Jaipur'), true); // the old check: shares "jaipur"
  assert.equal(isRelevantTitle('Amer, Jaipur', 'Jaipur', 'Jaipur'), false);
  assert.equal(isRelevantTitle('Amer Fort walk', 'Amber Fort', 'Jaipur'), true);

  const { wiki, wp } = client([
    ['page/summary/Jaipur Wax Museum', missing()],
    ['srsearch=Jaipur Wax Museum Jaipur', jsonRes(200, { query: { search: [{ title: 'Jaipur' }] } })],
    ['page/summary/Amer, Jaipur', summary('Jaipur')], // the location redirects to the city's own article
  ]);
  const r = await wp.lookup({ name: 'Jaipur Wax Museum', city: 'Jaipur', location: 'Amer, Jaipur' });
  assert.equal(r.status, 'not_found');
  assert.equal(r.image, null);
  assert.ok(!wiki.calls.some((u) => u.includes('srsearch=Amer')), 'the location is looked up by exact title only');
});

test('a place that shares its name with others is matched as "Name, City" first', async () => {
  const { wp } = client([
    ['page/summary/Birla Mandir, Jaipur', summary('Birla Mandir, Jaipur')],
    ['page/summary/Birla Mandir', summary('Birla Mandir')], // the general article: its photo is of a temple in Delhi
    ['per-article', views(100)],
  ]);
  const r = await wp.lookup({ name: 'Birla Mandir', city: 'Jaipur' });
  assert.equal(r.title, 'Birla Mandir, Jaipur');
  assert.equal(r.matchedBy, 'name');

  // "Name, City" that leads to the city's own article is not used; the place's own article is
  const other = client([
    ['page/summary/Sunset Point, Mount Abu', summary('Mount Abu')],
    ['page/summary/Sunset Point', summary('Sunset Point')],
    ['per-article', views(100)],
  ]);
  assert.equal((await other.wp.lookup({ name: 'Sunset Point', city: 'Mount Abu' })).title, 'Sunset Point');

  // a name that already contains the city is not doubled
  const own = client([['page/summary/City Palace Jaipur', summary('City Palace, Jaipur')], ['per-article', views(1)]]);
  assert.equal((await own.wp.lookup({ name: 'City Palace Jaipur', city: 'Jaipur' })).title, 'City Palace, Jaipur');
  assert.ok(!own.wiki.calls.some((u) => u.includes('Jaipur, Jaipur')));
});

test('a location that only repeats the city is not looked up at all', async () => {
  const { wiki, wp } = client([['page/summary/Hidden Stepwell', missing()], ['list=search', noResults()]]);
  assert.equal((await wp.lookup({ name: 'Hidden Stepwell', city: 'Jaipur', location: 'Jaipur' })).status, 'not_found');
  assert.ok(!wiki.calls.some((u) => u.endsWith('summary/Jaipur')));
});

// ---------- destination page text ----------

test('article text: whole sentences only, no headings or lists, stops at "See also", drops the cut-off end', () => {
  assert.deepEqual(pickParagraphs(LONG_TEXT), [
    'The Hawa Mahal is a palace in Jaipur. It was built in 1799. Its facade has 953 small windows.',
    'The windows let cool air through the building. Royal women watched festivals from them.',
    'It was designed by Lal Chand Ustad.',
  ]);
  assert.deepEqual(pickParagraphs('A list\nwithout sentences'), []);
  assert.deepEqual(pickParagraphs(undefined), []);
});

test('article text is capped in length but keeps at least the minimum number of sentences', () => {
  const sentence = 'This sentence is exactly fifty characters long ok. ';
  const text = `${sentence.repeat(10).trim()}\n${sentence.repeat(10).trim()}`;
  const out = pickParagraphs(text, { minSentences: 3, maxChars: 300 });
  assert.equal(out.length, 1);
  assert.ok(out[0].length <= 300);
  assert.ok(countSentences(out[0]) >= 3);
  assert.equal(countSentences('One. Two! Three? "Four."'), 4);
  assert.equal(countSentences("Built by Shah Jahan (r. 1628) for his wife. It is near St. Mary's, e.g. the old one. Go."), 3);
});

test('article text drops pronunciation and other-language notes, but keeps ordinary brackets', () => {
  const lead = 'Jaipur (Rajasthani: Jayapura, pronounced [ˈd͡ʑɛpʊɾᵊ]) is the capital of Rajasthan. '
    + "The Taj Mahal ( TAHJ mə-HAHL; Hindustani: [t̪ɑːd͡ʒ ˈmɛɦ(ɛ)l]; lit. 'Crown of the Palace') was built by Shah Jahan (r. 1628–1658). "
    + 'Mumbai ( muum-BY; Marathi: Mumbaī ), also known as Bombay ( bom-BAY; its official name until 1995), covers 603 km2 (233 sq mi). '
    + 'Hawa Mahal ( ; ) is a palace in the National Capital Territory (NCT) style. '
    + 'Namdroling Monastery (or ನಮ್ಡ್ರೋಲಿಂಗ್ ವಿಹಾರ, Namdroling Vihara) is in Bylakuppe (Seat of the King).';
  assert.deepEqual(pickParagraphs(lead), [
    'Jaipur is the capital of Rajasthan. The Taj Mahal was built by Shah Jahan (r. 1628–1658). '
    + 'Mumbai, also known as Bombay, covers 603 km2 (233 sq mi). Hawa Mahal is a palace in the National Capital Territory (NCT) style. '
    + 'Namdroling Monastery is in Bylakuppe (Seat of the King).',
  ]);
});

test('area candidates go from the specific location to the city, without repeating the place', () => {
  assert.deepEqual(areaCandidates({ name: 'Chiklihole Reservoir', city: 'Coorg', location: 'Near Kushalnagar, Kodagu' }),
    ['Kushalnagar, Kodagu', 'Kushalnagar', 'Kodagu', 'Coorg']);
  assert.deepEqual(areaCandidates({ name: 'Hawa Mahal', city: 'Jaipur', location: 'Hawa Mahal' }), ['Jaipur']);
});

// ---------- destination page details ----------

function hawaRoutes(extra = []) {
  return [
    ...extra,
    ['page/summary/Hawa Mahal', summary('Hawa Mahal')],
    ['per-article', views(20000)],
    ['prop=extracts', extract(LONG_TEXT)],
    ['media-list/Hawa_Mahal', mediaList([...SIX_PHOTOS.slice(0, 2), 'File:Locator_map.svg', ...SIX_PHOTOS.slice(2)])],
    ['prop=imageinfo', imageInfo(SIX_PHOTOS.slice(0, 5), { evil: ['File:Hawa_Mahal_3.jpg'] })],
  ];
}

test('destination detail: 3+ sentences of text and a gallery of up to 5 photos, each with its credit', async () => {
  const { wiki, wp } = client(hawaRoutes());
  const r = await wp.detail({ name: 'Hawa Mahal', city: 'Jaipur', location: 'Hawa Mahal' });
  assert.equal(r.status, 'found');
  assert.equal(r.detail.status, 'ok');
  assert.equal(r.detail.texts.length, 1);
  assert.equal(r.detail.texts[0].about, 'place');
  assert.ok(countSentences(r.detail.texts[0].paragraphs.join(' ')) >= 3);

  const photos = r.detail.photos;
  assert.deepEqual(photos.map((p) => p.src.match(/Hawa_Mahal_(\d)/)[1]), ['1', '2', '4', '5']); // order kept; svg and unsafe one dropped
  for (const p of photos) {
    assert.match(p.src, /^https:\/\/thumb\.wikimedia\.org\/.*\/960px-/);
    assert.match(p.thumb, /^https:\/\/thumb\.wikimedia\.org\/.*\/330px-/);
    assert.equal(p.about, 'place');
    assert.equal(p.article, 'Hawa Mahal');
    assert.equal(p.credit.license, 'CC BY-SA 4.0');
    assert.equal(p.credit.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0');
    assert.match(p.credit.fileUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:Hawa_Mahal_\d\.jpg$/);
    assert.match(p.credit.author, /^Asha \d$/); // HTML and "(talk)" removed
    assert.match(p.alt, /^View number \d$/);
  }
  const imageinfoCall = wiki.calls.find((u) => u.includes('prop=imageinfo'));
  assert.ok(!imageinfoCall.includes('Hawa_Mahal_6') && !imageinfoCall.includes('.svg'), 'at most 5 photos, no maps');

  const count = wiki.calls.length;
  await wp.detail({ name: 'Hawa Mahal', city: 'Jaipur', location: 'Hawa Mahal' });
  assert.equal(wiki.calls.length, count, 'complete details are cached');
});

test('short article: the text is topped up from the area, labelled as the area', async () => {
  const { wp } = client([
    ['page/summary/Dubare Elephant Camp', missing()],
    ['srsearch=Dubare Elephant Camp Coorg', jsonRes(200, { query: { search: [{ title: 'Dubare' }] } })],
    ['page/summary/Dubare, Kodagu', missing()],
    ['page/summary/Dubare', summary('Dubare')],
    ['page/summary/Kodagu', summary('Kodagu district')],
    ['per-article', views(300)],
    ['titles=Dubare', extract('Dubare is a forest camp on the river Kaveri.\n\n\nSee also\nKushalanagar')],
    ['titles=Kodagu district', extract('Kodagu district is in Karnataka. It is known for coffee. It has many hills. Madikeri is its capital.')],
    ['media-list/Dubare', mediaList(['File:Dubare_river.jpg'])],
    ['prop=imageinfo', imageInfo(['File:Dubare_river.jpg'])],
  ]);
  const r = await wp.detail({ name: 'Dubare Elephant Camp', city: 'Coorg', location: 'Dubare, Kodagu' });
  assert.deepEqual(r.detail.texts.map((t) => [t.about, t.title]), [['place', 'Dubare'], ['area', 'Kodagu district']]);
  assert.ok(countSentences(r.detail.texts.flatMap((t) => t.paragraphs).join(' ')) >= 3);
  assert.deepEqual(r.detail.photos.map((p) => p.about), ['place']); // the place has its own photo, so no area photos
});

test('no article: area text and up to 3 area photos, labelled as the area; the location is never searched', async () => {
  const files = [1, 2, 3, 4, 5].map((n) => `File:Varanasi_${n}.jpg`);
  const { wiki, wp } = client([
    ['page/summary/Varanasi', summary('Varanasi')],
    ['page/summary', missing()],
    ['list=search', noResults()],
    ['titles=Varanasi', extract('Varanasi is a city on the Ganges. It is one of the oldest cities. It has many ghats.')],
    ['media-list/Varanasi', mediaList(files)],
    ['prop=imageinfo', imageInfo(files.slice(0, 3))],
  ]);
  const r = await wp.detail({ name: 'Blue Lassi Shop', city: 'Varanasi', location: 'Kachori Gali, Varanasi' });
  assert.equal(r.status, 'not_found');
  assert.equal(r.detail.status, 'ok');
  assert.deepEqual(r.detail.texts.map((t) => [t.about, t.title]), [['area', 'Varanasi']]);
  assert.equal(r.detail.photos.length, 3);
  assert.ok(r.detail.photos.every((p) => p.about === 'area' && p.article === 'Varanasi'));
  assert.ok(!wiki.calls.some((u) => u.includes('srsearch=Kachori')));
});

test('detail when Wikipedia fails: "unavailable" if nothing loaded, "partial" (never cached) if only some did', async () => {
  const down = client([['page/summary', jsonRes(500, {})], ['list=search', jsonRes(500, {})]]);
  const r1 = await down.wp.detail({ name: 'Hawa Mahal', city: 'Jaipur' });
  assert.equal(r1.status, 'unavailable');
  assert.equal(r1.detail.status, 'unavailable');

  let failing = true;
  const flaky = client([
    ['page/summary/Hawa Mahal', summary('Hawa Mahal')],
    ['page/summary', jsonRes(500, {})],
    ['per-article', views(10)],
    ['prop=extracts', () => (failing ? jsonRes(500, {}) : extract(LONG_TEXT))],
    ['media-list', () => (failing ? jsonRes(500, {}) : mediaList([]))],
  ]);
  const r2 = await flaky.wp.detail({ name: 'Hawa Mahal', city: 'Jaipur' });
  assert.equal(r2.detail.status, 'ok');
  assert.equal(r2.detail.partial, true);
  assert.deepEqual(r2.detail.photos.map((p) => [p.src, p.credit]), [[THUMB, null]]); // the lead photo is still shown
  failing = false;
  const r3 = await flaky.wp.detail({ name: 'Hawa Mahal', city: 'Jaipur' });
  assert.equal(r3.detail.partial, undefined, 'asked again instead of serving the incomplete answer');
  assert.ok(r3.detail.texts.length === 1);
});

test('/api/place?detail=1 adds the details; the planner\'s normal call is unchanged', async () => {
  const wiki = fakeWiki(hawaRoutes());
  const { app } = makeApp({ fetchImpl: wiki.fetchImpl });
  const plain = await read(await app.place(new Request('http://localhost/api/place?name=Hawa%20Mahal&city=Jaipur')));
  assert.equal(plain.json.status, 'found');
  assert.equal('detail' in plain.json, false);

  const res = await app.place(new Request('http://localhost/api/place?name=Hawa%20Mahal&city=Jaipur&detail=1'));
  const full = await read(res);
  assert.equal(full.status, 200);
  assert.equal(full.json.detail.status, 'ok');
  assert.equal(full.json.detail.photos.length, 4);
  assert.match(res.headers.get('Cache-Control'), /max-age=3600/);
  for (const p of full.json.detail.photos) assert.ok(wikimediaImage(p.src) && wikimediaImage(p.thumb));
});

test('/api/place?detail=1 is never cached while Wikipedia is down', async () => {
  const wiki = fakeWiki([['page/summary', jsonRes(500, {})], ['list=search', jsonRes(500, {})]]);
  const { app } = makeApp({ fetchImpl: wiki.fetchImpl });
  const res = await app.place(new Request('http://localhost/api/place?name=Hawa%20Mahal&city=Jaipur&detail=1'));
  assert.equal((await read(res)).json.detail.status, 'unavailable');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('photo credits are plain text and only link to Creative Commons or Wikimedia', () => {
  assert.equal(plainText('<b><a href="//commons.wikimedia.org/wiki/User:X">Asha R</a></b> (<a href="//x">talk</a>)'), 'Asha R');
  assert.equal(plainText('Tom &amp; Jerry&#39;s &lt;b&gt;'), "Tom & Jerry's <b>");
  assert.ok(plainText('word '.repeat(100), 50).length <= 51);
  assert.equal(safeLink('http://creativecommons.org/licenses/by/2.0', ['creativecommons.org']), 'https://creativecommons.org/licenses/by/2.0');
  assert.equal(safeLink('//commons.wikimedia.org/wiki/File:A.jpg', ['commons.wikimedia.org']), 'https://commons.wikimedia.org/wiki/File:A.jpg');
  for (const bad of ['javascript:alert(1)', 'https://evil.example/', 'https://creativecommons.org.evil.example/', 'https://u@creativecommons.org/', null]) {
    assert.equal(safeLink(bad, ['creativecommons.org']), null, String(bad));
  }
});

test('destination page asks for the details once and credits Wikipedia text and photos', () => {
  const js = readFileSync(new URL('../public/destination.js', import.meta.url), 'utf8');
  assert.match(js, /detail: '1'/);
  assert.match(js, /creativecommons\.org\/licenses\/by-sa\/4\.0/);
  assert.match(js, /Text from the Wikipedia article /);
  assert.match(js, /Try again/);
  assert.match(js, /wikimediaImage\(/); // every photo address is checked before it is used
});
