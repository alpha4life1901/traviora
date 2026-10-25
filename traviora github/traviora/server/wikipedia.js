// Wikipedia photo + "Underrated Score" lookup for one place, done on the server.
// It never throws: problems become a status the page can show honestly.
//
//   status "found"       an article was matched (score may still be null if pageviews failed)
//   status "not_found"   Wikipedia answered and has no suitable article  -> "Not yet on Wikipedia"
//   status "unavailable" Wikipedia could not be reached / timed out / asked us to slow down
//                        -> show a placeholder, NOT "not on Wikipedia"
//
// detail() adds what the destination page shows: a few paragraphs of article text (at least three
// sentences when Wikipedia has them, topped up from the surrounding area's article if the place's own
// article is short or missing) and up to five photos, each with its author and licence.

import { fetchWithTimeout } from './providers.js';

const SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const SEARCH_URL = 'https://en.wikipedia.org/w/api.php'; // also used for article text and photo details
const MEDIA_URL = 'https://en.wikipedia.org/api/rest_v1/page/media-list/';
const VIEWS_URL = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/';

// Wikimedia allows apps that do not identify themselves only about 10 requests a minute and answers
// the rest with HTTP 429 + Retry-After. When that happens every lookup pauses (no requests at all)
// until the time Wikipedia asked for has passed, instead of hammering it and failing anyway.
const DEFAULT_PAUSE_MS = 10_000;
const MAX_PAUSE_MS = 60_000;

const MAX_PHOTOS = 5;
const MAX_AREA_PHOTOS = 3; // a city's article soon moves on to portraits and buildings elsewhere
const PHOTO_FILE = /\.(jpe?g|png|webp)$/i; // photos only: no maps, logos or flags (those are .svg)

export function viewsToScore(views) {
  const raw = 10 - Math.log10(views + 1) * 1.4;
  return Math.max(0, Math.min(10, Math.round(raw * 10) / 10));
}

function pvDateStr(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${mm}${dd}00`;
}

const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);

/**
 * Needs at least one meaningful word in common. "No comparable words" means NO match.
 * Words in `ignore` (the trip's city) do not count: "Amer, Jaipur" must not match the "Jaipur" article.
 */
export function isRelevantTitle(query, title, ignore = '') {
  const skip = new Set(words(ignore));
  const q = words(query).filter((w) => !skip.has(w));
  const t = words(title);
  if (q.length === 0 || t.length === 0) return false;
  return q.some((w) => t.includes(w));
}

/** "Namdroling Monastery (Golden Temple)" -> "Namdroling Monastery". Wikipedia's search finds nothing for the first. */
export function withoutBrackets(name) {
  return String(name || '').replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

const sameName = (a, b) => String(a).split(/[,(]/)[0].trim().toLowerCase() === String(b).split(/[,(]/)[0].trim().toLowerCase();

// The only hosts Wikipedia serves article photos from. Wikipedia's summary API now returns
// thumbnails on thumb.wikimedia.org; older answers and full-size images use upload.wikimedia.org.
// The page's Content-Security-Policy (server.js and vercel.json) must list exactly these hosts.
export const IMAGE_HOSTS = Object.freeze(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const MAX_IMAGE_URL_LENGTH = 2000;

/** Returns the URL if it is a plain https link to a Wikimedia image host, otherwise null. */
export function safeImage(url) {
  if (typeof url !== 'string' || url.length > MAX_IMAGE_URL_LENGTH) return null;
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:'
      && IMAGE_HOSTS.includes(u.hostname) // exact match: no lookalikes or other subdomains
      && u.port === '' // default port only
      && u.username === '' && u.password === ''; // no "user@host" tricks
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

/** A credit link (licence or file page) is only kept if it points at one of the expected sites. */
export function safeLink(url, hosts) {
  if (typeof url !== 'string' || url.length > MAX_IMAGE_URL_LENGTH) return null;
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url);
    if (u.protocol === 'http:') u.protocol = 'https:';
    const ok = u.protocol === 'https:' && hosts.includes(u.hostname) && u.port === '' && !u.username && !u.password;
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Wikimedia gives photo authors and descriptions as HTML. The page only ever shows plain text. */
export function plainText(value, max = 160) {
  if (typeof value !== 'string') return '';
  let s = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\(\s*(talk|contribs|uploads)\s*\)/gi, ' ') // "Name (talk) (Uploads)" -> "Name"
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    s = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), Math.floor(max * 0.6))).trim()}…`;
  }
  return s;
}

// A full stop after a single letter or a short form ("r. 1628", "e.g.", "St. Mary's") does not end a sentence.
const SENTENCE_END = /(?<!(?:^|[\s(.])(?:[A-Za-z]|St|Dr|Mr|Mrs|Ms|Mt|Rs|Sr|Jr|vs|lit|approx|ca|fl))[.!?]["'\u2019\u201D)\]]*(?=\s|$)/g;
const STOP_HEADING = /^(see also|references|notes|footnotes|citations|sources|bibliography|further reading|external links|gallery)$/i;

export const countSentences = (text) => (String(text || '').match(SENTENCE_END) || []).length;

// Brackets holding how a name is pronounced or written in other languages, e.g. "(Hindi: [ʋaːˈɾaːɳəsi])",
// "( GOH-ə; Konkani: [ɡɔ̃j] )", "(or ನಮ್ಡ್ರೋಲಿಂಗ್ ವಿಹಾರ)" or what is left of them, "( ; )".
// Ordinary notes like "(NCT)" or "(573 sq mi)" stay.
const NAME_NOTE = /\[|;|pronounc|\bIPA\b|\blisten\b|\blit\.|^\s|^[^:()]{1,30}:|^[^\p{L}\p{N}]*$|[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/iu;

/** Removes pronunciation and other-language notes, which read badly as plain text. */
export function withoutNameNotes(text) {
  let out = '';
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0 && !NAME_NOTE.test(text.slice(start + 1, i))) out += text.slice(start, i + 1);
    } else if (depth === 0) {
      out += c;
    }
  }
  if (depth > 0) out += text.slice(start); // a bracket that never closes: leave the rest as it was
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

/** Keeps only complete sentences that fit in `max` characters. */
function upToLastSentence(text, max) {
  const s = text.slice(0, max);
  let end = 0;
  for (const m of s.matchAll(SENTENCE_END)) end = m.index + m[0].length;
  return s.slice(0, end).trim();
}

/**
 * Turns a plain-text Wikipedia extract into readable paragraphs: complete sentences only (lists,
 * headings, pronunciation notes and the cut-off end are dropped), stopping at "See also"/"References", up to `maxChars`.
 * A paragraph that would overflow is shortened, unless `minSentences` are already there.
 */
export function pickParagraphs(extract, { minSentences = 3, maxChars = 1000 } = {}) {
  if (typeof extract !== 'string') return [];
  const lines = [];
  const blocks = extract.replace(/\r/g, '').split(/\n{3,}/); // sections; each later one starts with its heading
  for (let i = 0; i < blocks.length; i += 1) {
    const rows = blocks[i].split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (i > 0 && STOP_HEADING.test(rows.shift() || '')) break;
    lines.push(...rows);
  }
  const out = [];
  let total = 0;
  let sentences = 0;
  for (const line of lines) {
    const clean = withoutNameNotes(line.replace(/(\.\.\.|…)$/, ''));
    let p = upToLastSentence(clean, clean.length);
    if (!p) continue;
    if (p.length > maxChars - total) {
      if (sentences >= minSentences) break;
      p = upToLastSentence(p, maxChars - total);
      if (p) out.push(p);
      break;
    }
    out.push(p);
    total += p.length;
    sentences += countSentences(p);
  }
  return out;
}

/** Places to try, broadest last, when the place's own article is short or missing. */
export function areaCandidates({ name, city = '', location = '' }) {
  const strip = (s) => s.trim().replace(/^(near|opposite|opp\.?|behind|off|inside|outside|around)\s+/i, '').trim();
  const parts = location.split(',').map(strip).filter(Boolean);
  const list = [...(parts.length > 1 ? [parts.join(', ')] : []), ...parts, city.trim()];
  const seen = new Set([name.toLowerCase(), withoutBrackets(name).toLowerCase(), '']);
  return list.filter((c) => {
    const k = c.toLowerCase();
    if (seen.has(k) || words(c).length === 0) return false;
    seen.add(k);
    return true;
  }).slice(0, 4);
}

function createCache(ttlMs, maxEntries, now) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) { map.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(key, { value, expires: now() + ttlMs });
    },
  };
}

function retryAfterMs(response, now) {
  const raw = response.headers?.get?.('retry-after');
  let ms = DEFAULT_PAUSE_MS;
  if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) ms = secs * 1000;
    else if (Number.isFinite(Date.parse(raw))) ms = Date.parse(raw) - now(); // Retry-After may be a date
  }
  return Math.min(MAX_PAUSE_MS, Math.max(1000, Math.round(ms)));
}

const wikiPath = (title) => encodeURIComponent(title.replace(/ /g, '_'));

export function createWikipediaClient({ fetchImpl = globalThis.fetch, timeoutMs = 6000, contact = '', now = Date.now } = {}) {
  const cache = createCache(60 * 60 * 1000, 500, now);
  const headers = {
    Accept: 'application/json',
    'User-Agent': `Traviora/1.0 (travel planner prototype${contact ? `; ${contact}` : ''})`,
  };
  let pausedUntil = 0; // shared by every lookup: set when Wikipedia says "too many requests"
  const pauseLeftSec = () => Math.max(0, Math.ceil((pausedUntil - now()) / 1000));

  // Returns { state: 'ok', data } | { state: 'missing' } (HTTP 404) | { state: 'error', limited? }
  async function getJson(url, deadline) {
    if (now() < pausedUntil) return { state: 'error', limited: true }; // still paused: do not ask at all
    const remaining = deadline - now();
    if (remaining < 300) return { state: 'error' };
    try {
      const { response, text } = await fetchWithTimeout(fetchImpl, url, { headers }, Math.min(remaining, 4000));
      if (response.status === 404) return { state: 'missing' };
      if (response.status === 429 || (response.status === 503 && response.headers?.get?.('retry-after'))) {
        pausedUntil = Math.max(pausedUntil, now() + retryAfterMs(response, now));
        return { state: 'error', limited: true };
      }
      if (!response.ok) return { state: 'error' };
      return { state: 'ok', data: JSON.parse(text) };
    } catch {
      return { state: 'error' }; // timeout, network problem or unreadable reply
    }
  }

  async function monthlyViews(title, deadline) {
    const end = new Date(now());
    end.setUTCDate(end.getUTCDate() - 2); // pageview data lags by a day or two
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 30);
    const r = await getJson(`${VIEWS_URL}${wikiPath(title)}/daily/${pvDateStr(start)}/${pvDateStr(end)}`, deadline);
    if (r.state !== 'ok' || !Array.isArray(r.data?.items)) return null;
    return r.data.items.reduce((sum, it) => sum + (Number(it.views) || 0), 0);
  }

  async function lookup({ name, city = '', location = '' }) {
    const key = [name, city, location].join('|').toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    const deadline = now() + timeoutMs;
    const queries = [...new Set([name, withoutBrackets(name)].filter(Boolean))].map((q) => ({ q, by: 'name' }));
    // Places that share a name are titled "Name, City" on Wikipedia ("Birla Mandir, Jaipur" next to the
    // general "Birla Mandir" article, whose photo is of a temple in Delhi), so that title is tried first.
    const cityName = city.split(',')[0].trim();
    const plainName = withoutBrackets(name) || name;
    if (cityName && !plainName.toLowerCase().includes(cityName.toLowerCase())) {
      queries.unshift({ q: `${plainName}, ${cityName}`, by: 'name+city' });
    }
    // The location is an alternative name for the photo lookup. One that only repeats the city adds nothing.
    const tokens = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (location && !queries.some((x) => x.q === location) && tokens(location).some((w) => !tokens(city).includes(w))) {
      queries.push({ q: location, by: 'location' });
    }
    let hadError = false;
    let limited = false;
    let matched = null;
    let matchedBy = null;

    const summaryOf = async (title, by) => {
      const r = await getJson(`${SUMMARY_URL}${encodeURIComponent(title)}`, deadline);
      if (r.state === 'error') { hadError = true; limited ||= Boolean(r.limited); }
      if (r.state !== 'ok' || r.data?.type === 'disambiguation' || !r.data?.title) return null;
      if (by !== 'name' && city && sameName(r.data.title, city)) return null; // the city itself is not a photo of the place
      // "Name, City" can redirect to another article: keep it only if that is still about the place
      if (by === 'name+city' && !isRelevantTitle(plainName, r.data.title, city)) return null;
      return r.data;
    };

    for (const { q, by } of queries) {
      if (limited) break; // Wikipedia asked us to wait: further requests would fail too
      matched = await summaryOf(q, by); // 1) exact article title
      if (matched) { matchedBy = by === 'location' ? 'location' : 'name'; break; }
      // A search on the location mostly finds the district or a constituency, not the place, so the
      // location (and "Name, City") is only used when it is the exact name of an article.
      if (by !== 'name') continue;

      // 2) real search, with the city added for context; check up to 3 results for relevance.
      // A name with a second name in brackets is searched for both names together, without the city:
      // the article that has both is the right one ("Golden Temple (Namdroling Monastery)" finds
      // Namdroling Monastery, not the Golden Temple in Amritsar).
      const both = q !== withoutBrackets(q);
      const searchText = both ? q.replace(/[()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim() : `${q} ${city}`.trim();
      const searchUrl = `${SEARCH_URL}?action=query&list=search&srsearch=${encodeURIComponent(searchText)}&srlimit=3&format=json`;
      const s = await getJson(searchUrl, deadline);
      if (s.state === 'error') { hadError = true; limited ||= Boolean(s.limited); continue; }
      const candidates = (s.data?.query?.search || []).map((r) => r.title).filter((t) => typeof t === 'string');
      const pick = candidates.find((t) => isRelevantTitle(q, t, city));
      if (pick) {
        matched = await summaryOf(pick, by);
        if (matched) { matchedBy = by; break; }
      }
    }

    let result;
    if (matched) {
      const views = await monthlyViews(matched.title, deadline);
      result = {
        status: 'found',
        hasArticle: true,
        title: matched.title,
        image: safeImage(matched.thumbnail?.source),
        score: views === null ? null : viewsToScore(views),
        views,
        matchedBy, // "name" or "location": which of the two found the article
      };
      cache.set(key, result);
    } else if (hadError) {
      // Do not cache and do not claim the article is missing.
      result = { status: 'unavailable', hasArticle: null, title: null, image: null, score: null, views: null };
      if (limited && pauseLeftSec() > 0) result.retryAfter = pauseLeftSec();
    } else {
      result = { status: 'not_found', hasArticle: false, title: null, image: null, score: null, views: null };
      cache.set(key, result);
    }
    return result;
  }

  // ---------- destination page details ----------

  async function articleText(title, opts, deadline, run) {
    const url = `${SEARCH_URL}?action=query&prop=extracts&explaintext=1&exsectionformat=plain&exchars=1200&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`;
    const r = await getJson(url, deadline);
    if (r.state === 'error') { run.failed = true; run.limited ||= Boolean(r.limited); }
    return r.state === 'ok' ? pickParagraphs(r.data?.query?.pages?.[0]?.extract, opts) : [];
  }

  async function articlePhotos(title, max, deadline, run) {
    const list = await getJson(`${MEDIA_URL}${wikiPath(title)}`, deadline);
    if (list.state === 'error') { run.failed = true; run.limited ||= Boolean(list.limited); }
    if (list.state !== 'ok') return [];
    const items = Array.isArray(list.data?.items) ? list.data.items : [];
    const files = [...new Set(items
      .filter((it) => it?.type === 'image' && it.showInGallery !== false && typeof it.title === 'string' && PHOTO_FILE.test(it.title))
      .map((it) => it.title))].slice(0, max);
    if (files.length === 0) return [];

    const url = `${SEARCH_URL}?action=query&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=960`
      + '&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl|ImageDescription&iiextmetadatalanguage=en'
      + `&format=json&formatversion=2&titles=${encodeURIComponent(files.join('|'))}`;
    const r = await getJson(url, deadline);
    if (r.state === 'error') { run.failed = true; run.limited ||= Boolean(r.limited); }
    if (r.state !== 'ok') return [];
    const renamed = new Map((r.data?.query?.normalized || []).map((n) => [n?.from, n?.to]));
    const pages = new Map((r.data?.query?.pages || []).map((p) => [p?.title, p]));
    const photos = [];
    for (const file of files) { // keep Wikipedia's order: the article's main photo comes first
      const ii = pages.get(renamed.get(file) || file)?.imageinfo?.[0];
      const src = safeImage(ii?.thumburl);
      if (!src) continue;
      const meta = ii.extmetadata || {};
      photos.push({
        src, // about 960 px wide
        thumb: safeImage(src.replace('/960px-', '/330px-')) || src,
        width: Number(ii.thumbwidth) || null,
        height: Number(ii.thumbheight) || null,
        alt: plainText(meta.ImageDescription?.value, 160) || `Photo from the Wikipedia article ${title}`,
        credit: {
          author: plainText(meta.Artist?.value, 100) || null,
          license: plainText(meta.LicenseShortName?.value, 40) || null,
          licenseUrl: safeLink(meta.LicenseUrl?.value, ['creativecommons.org']),
          fileUrl: safeLink(ii.descriptionurl, ['commons.wikimedia.org', 'en.wikipedia.org']),
        },
      });
    }
    return photos;
  }

  async function findArea(query, exclude, deadline, run) {
    for (const candidate of areaCandidates(query)) {
      const r = await getJson(`${SUMMARY_URL}${encodeURIComponent(candidate)}`, deadline);
      if (r.state === 'error') { run.failed = true; if (r.limited) { run.limited = true; return null; } continue; }
      if (r.state === 'ok' && r.data?.title && r.data.type !== 'disambiguation' && !exclude.has(r.data.title)) return r.data;
    }
    return null;
  }

  /** lookup() plus `detail`: { status: 'ok'|'unavailable', texts: [...], photos: [...], partial?, retryAfter? } */
  async function detail(query) {
    const key = ['detail', query.name, query.city, query.location].join('|').toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    const base = await lookup(query);
    if (base.status === 'unavailable') {
      const busy = { status: 'unavailable', texts: [], photos: [] };
      if (base.retryAfter) busy.retryAfter = base.retryAfter;
      return { ...base, detail: busy };
    }

    const deadline = now() + timeoutMs * 2;
    const run = { failed: false, limited: false };
    const texts = [];
    const photos = [];
    const sentences = () => texts.reduce((n, t) => n + t.paragraphs.reduce((m, p) => m + countSentences(p), 0), 0);

    const addArticle = async (title, about, textOpts, needPhotos, fallbackImage) => {
      if (textOpts && !run.limited) {
        const paragraphs = await articleText(title, textOpts, deadline, run);
        if (paragraphs.length) texts.push({ title, about, paragraphs });
      }
      if (needPhotos) {
        let found = run.limited ? [] : await articlePhotos(title, about === 'area' ? MAX_AREA_PHOTOS : MAX_PHOTOS, deadline, run);
        if (found.length === 0 && fallbackImage) { // the article's main photo, already known from the lookup
          found = [{ src: fallbackImage, thumb: fallbackImage, width: null, height: null, alt: `Photo from the Wikipedia article ${title}`, credit: null }];
        }
        photos.push(...found.map((p) => ({ ...p, about, article: title })));
      }
    };

    const used = new Set();
    if (base.status === 'found') {
      used.add(base.title);
      // Found through the location field: it is still the place itself if the names overlap
      // ("Amer Fort walk" -> "Amber Fort"), otherwise it is the surrounding area.
      const about = base.matchedBy === 'location' && !isRelevantTitle(query.name, base.title, query.city) ? 'area' : 'place';
      await addArticle(base.title, about, { minSentences: 3, maxChars: 1000 }, true, base.image);
    }
    const missingSentences = 3 - sentences();
    if ((missingSentences > 0 || photos.length === 0) && !run.limited) {
      const area = await findArea(query, used, deadline, run);
      if (area) {
        await addArticle(
          area.title,
          'area',
          missingSentences > 0 ? { minSentences: missingSentences, maxChars: 700 } : null,
          photos.length === 0,
          safeImage(area.thumbnail?.source),
        );
      }
    }

    const nothing = texts.length === 0 && photos.length === 0;
    const info = { status: run.failed && nothing ? 'unavailable' : 'ok', texts, photos: photos.slice(0, MAX_PHOTOS) };
    if (run.failed && !nothing) info.partial = true; // some of it could not be loaded: worth asking again later
    if (run.limited && pauseLeftSec() > 0) info.retryAfter = pauseLeftSec();
    const result = { ...base, detail: info };
    if (!run.failed) cache.set(key, result);
    return result;
  }

  return { lookup, detail };
}
