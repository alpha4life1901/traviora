// The destination page: what the planner saved for the place, plus more text and photos from
// Wikipedia, asked for once when the page opens. Everything goes in with textContent, never innerHTML.
import { icon } from './icons.js';
import { h, mapsSearchUrl, wikimediaImage, wikipediaUrl } from './render.js';

const root = document.getElementById('destination-content');
const DETAIL_TIMEOUT_MS = 20000;
const TEXT_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const CREDIT_HOSTS = { 'commons.wikimedia.org': 'Wikimedia Commons', 'en.wikipedia.org': 'Wikipedia' };

function addLink(parent, url, label) {
  const link = h('a', 'btn-secondary', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  parent.append(link);
}

function addDetail(parent, label, value) {
  if (!value) return;
  const row = h('div', 'destination-detail');
  row.append(
    h('span', 'destination-detail-label', label),
    h('p', 'destination-detail-value', String(value))
  );
  parent.append(row);
}

function newTabLink(href, text) {
  const a = h('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/** Credit links are only used when they point at the expected sites. */
function safeHttps(url, hosts) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.includes(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

async function fetchDetail(place, city) {
  const params = new URLSearchParams({ name: place.name, detail: '1' });
  if (city) params.set('city', city);
  if (place.location) params.set('location', place.location);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/place?${params}`, { signal: controller.signal });
    const body = await res.json().catch(() => null);
    return res.ok && body ? body : null;
  } catch {
    return null; // offline or too slow: shown as "could not load", with a Try again button
  } finally {
    clearTimeout(timer);
  }
}

function photoPanel(message, busy = false) {
  const box = h('div', 'destination-photo-empty');
  box.append(busy ? h('span', 'spinner') : icon('mountain'), h('p', null, message));
  return box;
}

function photoCaption(photo) {
  const caption = h('figcaption', 'destination-photo-credit');
  if (photo.about === 'area' && photo.article) {
    caption.append(h('span', 'destination-photo-area', `Photo of the area: ${photo.article}. `));
  }
  const credit = photo.credit || {};
  if (credit.author || credit.license) {
    caption.append(document.createTextNode(`Photo: ${credit.author || 'Unknown author'}`));
    if (credit.license) {
      const licenseUrl = safeHttps(credit.licenseUrl, ['creativecommons.org']);
      caption.append(document.createTextNode(', '), licenseUrl ? newTabLink(licenseUrl, credit.license) : document.createTextNode(credit.license));
    }
    const fileUrl = safeHttps(credit.fileUrl, Object.keys(CREDIT_HOSTS));
    if (fileUrl) caption.append(document.createTextNode(', via '), newTabLink(fileUrl, CREDIT_HOSTS[new URL(fileUrl).hostname]));
  } else if (photo.article) {
    caption.append(document.createTextNode('Photo from the Wikipedia article '), newTabLink(wikipediaUrl(photo.article), photo.article));
  }
  return caption;
}

/** One large photo, a caption with its credit, and small buttons to switch between up to five photos. */
function renderGallery(slot, photos, placeName, emptyMessage) {
  const list = (Array.isArray(photos) ? photos : [])
    .map((p) => ({ ...p, src: wikimediaImage(p?.src), thumb: wikimediaImage(p?.thumb) || wikimediaImage(p?.src) }))
    .filter((p) => p.src)
    .slice(0, 5);
  if (list.length === 0) {
    slot.replaceChildren(photoPanel(emptyMessage));
    return;
  }
  const figure = h('figure', 'destination-hero');
  const img = h('img');
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  figure.append(img, h('figcaption'));
  const strip = h('ul', 'destination-thumbs');
  const buttons = [];
  let shown = 0;

  const show = (i) => {
    const photo = list[i];
    shown = i;
    img.src = photo.src;
    img.alt = photo.alt || `Photo of ${placeName}`;
    img.classList.toggle('is-portrait', Number(photo.height) > Number(photo.width));
    figure.lastChild.replaceWith(photoCaption(photo));
    buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  };

  img.addEventListener('error', () => {
    // This photo would not load: drop it and show the next one, or the placeholder if none is left.
    list[shown].broken = true;
    const hadFocus = buttons[shown] !== undefined && buttons[shown] === document.activeElement;
    buttons[shown]?.closest('li')?.remove();
    const next = list.findIndex((p) => !p.broken);
    if (next === -1) {
      slot.replaceChildren(photoPanel('The photos could not load right now.'));
      return;
    }
    show(next);
    const left = buttons.filter((b) => b.isConnected);
    left.forEach((b, k) => b.setAttribute('aria-label', `Show photo ${k + 1} of ${left.length}`));
    if (left.length < 2) strip.remove();
    else if (hadFocus) buttons[next].focus();
  });

  if (list.length > 1) {
    list.forEach((photo, i) => {
      const li = h('li');
      const button = h('button', 'destination-thumb');
      button.type = 'button';
      button.setAttribute('aria-label', `Show photo ${i + 1} of ${list.length}`);
      const thumb = h('img');
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      thumb.referrerPolicy = 'no-referrer';
      thumb.width = 96;
      thumb.height = 72;
      thumb.src = photo.thumb;
      // If the small version will not load, try the large one once.
      thumb.addEventListener('error', () => { if (photo.src !== photo.thumb) thumb.src = photo.src; }, { once: true });
      button.append(thumb);
      button.addEventListener('click', () => show(i));
      buttons.push(button);
      li.append(button);
      strip.append(li);
    });
  }
  show(0);
  slot.replaceChildren(figure, ...(buttons.length ? [strip] : []));
}

function renderTexts(body, texts) {
  const blocks = (Array.isArray(texts) ? texts : []).filter((t) => t?.title && Array.isArray(t.paragraphs) && t.paragraphs.length);
  if (blocks.length === 0) {
    body.replaceChildren(h('p', 'destination-description', 'Wikipedia has no article about this place or its area yet.'));
    return;
  }
  body.replaceChildren(...blocks.map((t) => {
    const block = h('div', 'destination-wiki-text');
    if (t.about === 'area') block.append(h('h3', 'destination-subtitle', `About the area: ${t.title}`));
    t.paragraphs.forEach((p) => block.append(h('p', 'destination-description', p)));
    const credit = h('p', 'destination-attribution');
    credit.append(
      document.createTextNode('Text from the Wikipedia article '),
      newTabLink(wikipediaUrl(t.title), t.title),
      document.createTextNode(', available under '),
      newTabLink(TEXT_LICENSE_URL, 'CC BY-SA 4.0'),
      document.createTextNode('.'),
    );
    block.append(credit);
    return block;
  }));
}

function renderInsights(section, info) {
  const parts = [h('h2', 'destination-section-title', 'Wikipedia insights')];
  if (info?.title) {
    const link = h('a', 'destination-wiki-link', `Read the Wikipedia article: ${info.title}`);
    link.href = wikipediaUrl(info.title);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parts.push(link);
  }
  if (typeof info?.score === 'number') {
    parts.push(h('p', 'destination-score', `Underrated Score: ${info.score.toFixed(1)}/10`));
    if (typeof info.views === 'number') {
      parts.push(h('p', 'destination-description',
        `${new Intl.NumberFormat('en-IN').format(info.views)} Wikipedia page views in the last 30 days.`));
    }
  }
  section.replaceChildren(...parts);
  section.hidden = parts.length === 1;
}

async function loadFromWikipedia(page) {
  const { place, city, gallery, wikiBody, insights, status } = page;
  wikiBody.replaceChildren(h('p', 'destination-loading', 'Loading more about this place from Wikipedia…'));
  if (!gallery.querySelector('img')) gallery.replaceChildren(photoPanel('Loading photos from Wikipedia…', true));

  const result = await fetchDetail(place, city);
  const detail = result?.detail;
  if (result && result.status !== 'unavailable') renderInsights(insights, result);

  if (!detail || detail.status !== 'ok') {
    const wait = Number(detail?.retryAfter) || Number(result?.retryAfter) || 0;
    if (!gallery.querySelector('img')) gallery.replaceChildren(photoPanel('The photos could not load right now.'));
    const retry = h('button', 'btn-secondary destination-retry');
    retry.type = 'button';
    retry.append(icon('rotate-ccw'), h('span', null, 'Try again'));
    retry.addEventListener('click', () => loadFromWikipedia(page));
    wikiBody.replaceChildren(
      h('p', 'destination-description', wait
        ? `Wikipedia is busy right now. Please try again in about ${wait} seconds.`
        : 'Wikipedia could not be reached right now, so more details could not load.'),
      retry,
    );
    status.textContent = 'More details from Wikipedia could not load.';
    return;
  }
  renderGallery(gallery, detail.photos, place.name, 'Wikipedia has no photo of this place or its area yet.');
  renderTexts(wikiBody, detail.texts);
  const count = gallery.querySelectorAll('.destination-thumb').length || (gallery.querySelector('.destination-hero') ? 1 : 0);
  const loaded = [];
  if (count) loaded.push(count === 1 ? '1 photo' : `${count} photos`);
  if (wikiBody.querySelector('.destination-wiki-text')) loaded.push('text');
  status.textContent = loaded.length
    ? `Loaded ${loaded.join(' and ')} from Wikipedia.`
    : 'Wikipedia has no photos or text about this place or its area yet.';
}

function renderDestination() {
  let selected;

  try {
    selected = JSON.parse(
      sessionStorage.getItem('traviora:selectedDestination') || 'null'
    );
  } catch {
    selected = null;
  }

  if (!selected || !selected.place || !selected.place.name) {
    root.replaceChildren(
      h('h1', 'destination-title', 'No destination selected'),
      h('p', 'destination-description',
        'Return to the planner and click a destination to explore it.')
    );
    return;
  }

  const { place, city, info } = selected;
  const article = h('article', 'destination-article');
  const heading = h('header', 'destination-heading');

  heading.append(
    h('p', 'destination-eyebrow', 'YOUR DESTINATION'),
    h('h1', 'destination-title', place.name)
  );

  if (place.location) {
    heading.append(h('p', 'destination-location', place.location));
  }

  if (city) {
    heading.append(h('p', 'destination-city', city));
  }

  article.append(heading);

  // The small photo the planner already found is shown at once; the gallery replaces it when it arrives.
  const gallery = h('section', 'destination-gallery');
  gallery.setAttribute('aria-label', 'Photos');
  const quickPhoto = wikimediaImage(info?.image);
  if (quickPhoto) {
    renderGallery(gallery, [{ src: quickPhoto, alt: `Photo of ${place.name}`, article: info.title }], place.name, '');
  }
  article.append(gallery);

  const description = h('section', 'destination-section');
  description.append(h('h2', 'destination-section-title', 'About this place'));

  if (place.description) {
    description.append(h('p', 'destination-description', place.description));
  }

  if (place.whyItFits) {
    description.append(h('h3', 'destination-subtitle', 'Why visit?'));
    description.append(h('p', 'destination-description', place.whyItFits));
  }

  article.append(description);

  const wiki = h('section', 'destination-section');
  const wikiBody = h('div', 'destination-wiki-body');
  wiki.append(h('h2', 'destination-section-title', 'From Wikipedia'), wikiBody);
  article.append(wiki);

  const details = h('section', 'destination-section');
  details.append(h('h2', 'destination-section-title', 'Trip details'));
  addDetail(details, 'Time needed', place.duration);
  addDetail(details, 'Estimated cost', place.estimatedCost);

  if (details.querySelector('.destination-detail')) {
    article.append(details);
  }

  const insights = h('section', 'destination-section');
  renderInsights(insights, info);
  article.append(insights);

  const actions = h('div', 'destination-actions');
  addLink(actions, mapsSearchUrl(place.name, city), 'Open in Google Maps');
  article.append(actions);

  const status = h('p', 'visually-hidden');
  status.setAttribute('role', 'status');
  article.append(status);

  root.replaceChildren(article);
  loadFromWikipedia({ place, city, gallery, wikiBody, insights, status });
}
const backLink = document.querySelector('.destination-back');

if (backLink) {
  backLink.addEventListener('click', (event) => {
    if (window.history.length > 1) {
      event.preventDefault();
      window.history.back();
    }
  });
}
renderDestination();
