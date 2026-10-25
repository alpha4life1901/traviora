// Builds the planner's itinerary columns. Every piece of AI or Wikipedia text goes in with
// textContent (never innerHTML), so it can never be interpreted as HTML.
import { icon } from './icons.js';

export function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

const SECTION_META = {
  hidden: { icon: 'binoculars', blurb: 'Lesser-known places' },
  iconic: { icon: 'landmark', blurb: 'Well-known sights' },
};

const numberFormat = new Intl.NumberFormat('en-IN');

/** A Google Maps search (no API key needed). It lets people check a place exists and where it is. */
export function mapsSearchUrl(name, city) {
  const query = [name, city].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function wikipediaUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

// The only image servers the page's security policy allows (see server.js and vercel.json).
const IMAGE_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org'];

/** The URL if it is an https photo on Wikimedia's image servers, otherwise null. */
export function wikimediaImage(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const ok = u.protocol === 'https:' && IMAGE_HOSTS.includes(u.hostname) && !u.port && !u.username && !u.password;
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

/** What a place card's photo slot shows: the Wikipedia photo, or a labelled placeholder. */
export function photoState(info) {
  const src = wikimediaImage(info?.image);
  if (src) return { kind: 'photo', src };
  // "unavailable" means Wikipedia could not be asked (busy or offline), not that there is no photo.
  if (!info || info.status === 'unavailable') return { kind: 'placeholder', label: 'Photo unavailable' };
  return { kind: 'placeholder', label: 'No photo yet' };
}

function photoPlaceholder(label) {
  const box = h('div', 'place-photo place-photo--empty');
  box.setAttribute('aria-hidden', 'true'); // decorative: the text next to it already says what was found
  box.append(icon('mountain'), h('span', 'place-photo-label', label));
  return box;
}

function externalLink(href, label, iconName, className = 'ext-link') {
  const a = h('a', className);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (iconName) a.append(icon(iconName));
  a.append(h('span', null, label), h('span', 'visually-hidden', ' (opens in a new tab)'));
  return a;
}

function withIcon(tag, className, iconName, text) {
  const el = h(tag, className);
  el.append(icon(iconName), h('span', null, text));
  return el;
}

/** One fact line, e.g. "2 hours". The hidden prefix tells screen readers what the value is. */
function fact(iconName, srLabel, value, tag) {
  const li = h('li', 'fact');
  li.append(icon(iconName), h('span', 'visually-hidden', `${srLabel}: `), h('span', null, value));
  if (tag) li.append(h('span', 'est-tag', tag));
  return li;
}

export function renderPlaceCard(place, ctx = {}) {
  const card = h('li', 'place');
  const main = h('div', 'place-main');
  const text = h('div', 'place-text');
  const heading = h('h5', 'place-name');
const detailLink = h('button', 'place-detail-link', place.name);
detailLink.type = 'button';
detailLink.addEventListener('click', () => {
  try {
    sessionStorage.setItem('traviora:selectedDestination', JSON.stringify({
      place,
      city: ctx.city || '',
      info: card._travioraInfo || null,
    }));
    window.location.href = './destination.html';
  } catch {
    window.alert('Could not open destination details. Please try again.');
  }
});
heading.append(detailLink);
text.append(heading);
  if (place.location) text.append(withIcon('p', 'place-loc', 'map-pin', place.location));
  if (place.description) text.append(h('p', 'place-desc', place.description));
  if (place.whyItFits) {
    const why = h('p', 'place-why');
    why.append(h('span', 'place-why-label', 'Why it fits: '), document.createTextNode(place.whyItFits));
    text.append(why);
  }
  main.append(text);
  card.append(main);

  const facts = h('ul', 'place-facts');
  if (place.duration) facts.append(fact('clock', 'Time needed', place.duration));
  if (place.estimatedCost) facts.append(fact('wallet', 'Estimated cost', place.estimatedCost, 'AI estimate'));
  if (facts.childElementCount) card.append(facts);

  const links = h('div', 'place-links');
  links.append(externalLink(mapsSearchUrl(place.name, ctx.city), 'Map search', 'map'));
  // Replaced as soon as the Wikipedia lookup finishes (or removed if it can't be done).
  links.append(h('span', 'wiki-status wiki-pending', 'Checking Wikipedia…'));
  card.append(links);
  return card;
}

/** Adds the Wikipedia match, photo and Underrated Score once the (optional) lookup returns. */
export function applyPlaceInfo(card, place, info) {
  card._travioraInfo = info || null;
  card.querySelector('.wiki-pending')?.remove();
  const links = card.querySelector('.place-links');
  if (!info || !links) return;

  const title = typeof info.title === 'string' && info.title ? info.title : null;
  if (title || typeof info.score === 'number') {
    const wiki = h('span', 'wiki-info');
    // The matched article is named so people can see when the match is wrong.
    if (title) wiki.append(externalLink(wikipediaUrl(title), `Wikipedia: ${title}`, 'book-open'));
    if (typeof info.score === 'number') {
      wiki.append(h('span', 'score-badge', `Underrated Score ${info.score.toFixed(1)}/10`));
      if (typeof info.views === 'number') {
        wiki.append(h('span', 'views', `${numberFormat.format(info.views)} page views in 30 days`));
      }
    }
    links.append(wiki);
  } else if (info.status === 'not_found') {
    // Only shown when Wikipedia really answered "no article". An outage shows nothing.
    links.append(h('span', 'wiki-status', 'No matching Wikipedia article found'));
  }

  // Every card gets a photo slot: the Wikipedia photo, or a placeholder when there is none.
  const main = card.querySelector('.place-main');
  const current = card.querySelector('.place-photo');
  if (!main || (current && !current.classList.contains('place-photo--empty'))) return; // a photo is already shown
  const state = photoState(info);
  let slot;
  if (state.kind === 'photo') {
    slot = h('figure', 'place-photo');
    const img = h('img');
    img.alt = title ? `Photo from the Wikipedia article ${title}` : 'Photo from Wikipedia';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.width = 96;
    img.height = 96;
    img.addEventListener('error', () => slot.replaceWith(photoPlaceholder('Photo unavailable')));
    img.src = state.src;
    slot.append(img);
  } else {
    slot = photoPlaceholder(state.label);
  }
  if (current) current.replaceWith(slot);
  else main.append(slot);
}

function logisticsBlock(iconName, title, items, { note, mapCity } = {}) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const block = h('section', 'logistics');
  block.append(withIcon('h4', 'logistics-title', iconName, title));
  if (note) block.append(h('p', 'logistics-note', note));
  const list = h('ul', 'options');
  items.forEach((item) => {
    const li = h('li', 'option');
    const top = h('div', 'option-top');
    top.append(h('span', 'option-name', item.name));
    if (item.estimatedCost) {
      const cost = h('span', 'option-cost');
      cost.append(h('span', 'visually-hidden', 'Estimated cost: '), document.createTextNode(item.estimatedCost));
      top.append(cost);
    }
    li.append(top);
    if (item.description) li.append(h('p', 'option-desc', item.description));
    if (mapCity !== undefined) li.append(externalLink(mapsSearchUrl(item.name, mapCity), 'Map search', 'map', 'ext-link ext-link--small'));
    list.append(li);
  });
  block.append(list);
  return block;
}

export function createColumn(def) {
  const col = h('article', `column column--${def.key}`);
  col.id = `col-${def.key}`;
  col.dataset.section = def.key;
  col.setAttribute('aria-labelledby', `col-${def.key}-title`);
  return col;
}

function header(def) {
  const meta = SECTION_META[def.key] || { icon: 'compass', blurb: '' };
  const head = h('header', 'col-header');
  const mark = h('span', 'col-icon');
  mark.append(icon(meta.icon));
  const text = h('div', 'col-heading');
  const title = h('h3', 'col-title', def.label);
  title.id = `col-${def.key}-title`;
  text.append(title, h('p', 'col-subtitle', meta.blurb));
  head.append(mark, text);
  return head;
}

export function setColumnLoading(col, def) {
  col.setAttribute('aria-busy', 'true');
  const box = h('div', 'column-state column-loading');
  box.append(h('span', 'spinner'), h('p', null, `Creating your ${def.label} itinerary…`));
  const skeleton = h('div', 'skeleton');
  skeleton.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) skeleton.append(h('span', 'skeleton-line'));
  box.append(skeleton);
  col.replaceChildren(header(def), box);
}

export function setColumnError(col, def, message, retryable, onRetry) {
  col.removeAttribute('aria-busy');
  const box = h('div', 'column-state column-error');
  box.append(withIcon('p', 'column-error-message', 'circle-alert', message));
  if (retryable) {
    const btn = h('button', 'btn-secondary column-error-retry');
    btn.type = 'button';
    btn.append(icon('rotate-ccw'), h('span', null, 'Try again'));
    btn.addEventListener('click', () => { btn.disabled = true; onRetry(); });
    box.append(btn);
  } else {
    box.append(h('p', 'column-error-note', 'Trying again will not help until this is fixed.'));
  }
  col.replaceChildren(header(def), box);
}

/** Renders a validated itinerary into the column. Returns [{ place, card }] for enrichment. */
export function setColumnData(col, def, section, ctx = {}) {
  col.removeAttribute('aria-busy');
  const parts = [header(def)]; // the server always sets section.title to the section name, so it is not repeated
  const cards = [];
  section.days.forEach((day) => {
    const block = h('section', 'day');
    const title = h('h4', 'day-title');
    title.append(h('span', 'day-num', `Day ${day.day}`));
    if (day.title) title.append(h('span', 'day-theme', day.title));
    const list = h('ol', 'places');
    day.places.forEach((place) => {
      const card = renderPlaceCard(place, ctx);
      cards.push({ place, card });
      list.append(card);
    });
    block.append(title, list);
    parts.push(block);
  });
  parts.push(logisticsBlock('bus', 'Getting around', section.transportationOptions, {
    note: 'Costs are rough AI estimates.',
  }));
  parts.push(logisticsBlock('bed-double', 'Where to stay', section.accommodationOptions, {
    note: 'AI suggestions, not checked listings. Confirm names, prices and availability before booking.',
    mapCity: ctx.city || '',
  }));
  col.replaceChildren(...parts.filter(Boolean));
  return cards;
}

export function errorBox(message) {
  const box = h('div', 'alert alert--error results-error');
  box.setAttribute('role', 'alert');
  const mark = h('span', 'alert-icon');
  mark.append(icon('circle-alert'));
  const body = h('div', 'alert-body');
  body.append(h('h3', 'alert-title', 'Neither itinerary could be created'), h('p', null, message));
  const close = h('button', 'alert-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss this message');
  close.append(icon('x'));
  close.addEventListener('click', () => box.remove());
  box.append(mark, body, close);
  return box;
}
