// Traviora planner page logic. It never sees an AI key: it only talks to this site's own
// /api/itinerary and /api/place endpoints. The request and response formats are unchanged.
import { icon, hydrateIcons } from './icons.js';
import { applyPlaceInfo, createColumn, errorBox, h, setColumnData, setColumnError, setColumnLoading } from './render.js';

hydrateIcons();

const SECTIONS = [
  { key: 'hidden', label: 'Hidden Gems' },
  { key: 'iconic', label: 'Iconic India' },
];
const ITINERARY_TIMEOUT_MS = 70000; // a little longer than the server's own limit
const PLACE_TIMEOUT_MS = 12000;
const PLACE_CONCURRENCY = 3; // at most this many Wikipedia lookups at once

// Same character rule as server/validate.js. The server still checks everything itself.
const CITY_PATTERN = /^[\p{L}\p{M}\p{N} .,'’()&-]+$/u;
const FIELD_NAMES = ['city', 'budget', 'days', 'travelers'];
// Server validation messages start with these words (see server/validate.js).
const SERVER_FIELD_PREFIXES = { Destination: 'city', Budget: 'budget', Days: 'days', Travelers: 'travelers' };

const els = {
  form: document.getElementById('tripForm'),
  btn: document.getElementById('generateBtn'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  summary: document.getElementById('formSummary'),
  result: document.getElementById('result'),
  fields: Object.fromEntries(FIELD_NAMES.map((name) => [name, document.getElementById(name)])),
};
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

let currentRun = null; // everything about the trip currently on screen
let showLiveErrors = false; // after the first submit, fields re-check as you type
const SAVED_TRIP_KEY = 'traviora:savedTrip';

function saveTripInputs(inputs) {
  try {
    const saved = {
      inputs,
      sections: {},
    };
    sessionStorage.setItem(SAVED_TRIP_KEY, JSON.stringify(saved));
  } catch {
    // Storage may be unavailable; the planner should still work.
  }
}

function saveTripSection(key, data) {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(SAVED_TRIP_KEY) || 'null'
    );
    if (!saved || !saved.inputs || !saved.sections) return;

    saved.sections[key] = data;
    sessionStorage.setItem(SAVED_TRIP_KEY, JSON.stringify(saved));
  } catch {
    // Saving results must never interrupt itinerary generation.
  }
}

// ---- Form input and validation ----

function readInputs() {
  const value = (name) => els.fields[name].value.trim();
  return {
    city: value('city'),
    budget: value('budget'),
    days: value('days'),
    travelers: value('travelers') || '1',
    interests: Array.from(els.form.querySelectorAll('input[name="interests"]:checked'), (box) => box.value),
  };
}

function validate(inputs) {
  const errors = {};
  const bad = (name) => els.fields[name].validity.badInput; // e.g. letters typed into a number box

  if (inputs.city.length < 2) errors.city = 'Enter a destination of at least 2 characters.';
  else if (inputs.city.length > 80) errors.city = 'Use 80 characters or fewer.';
  else if (!CITY_PATTERN.test(inputs.city)) errors.city = "Use only letters, numbers, spaces and . , ' ( ) & -";

  if (bad('budget')) errors.budget = 'Use numbers only, without commas.';
  else if (!inputs.budget) errors.budget = 'Enter your total budget in rupees.';
  else if (!/^\d+(\.\d{1,2})?$/.test(inputs.budget) || Number(inputs.budget) < 1) errors.budget = 'Enter a budget of at least ₹1.';

  if (bad('days')) errors.days = 'Use a whole number, for example 3.';
  else if (!inputs.days) errors.days = 'Enter the number of days.';
  else if (!/^\d+$/.test(inputs.days) || Number(inputs.days) < 1) errors.days = 'Use a whole number of 1 or more.';

  if (bad('travelers') || !/^\d+$/.test(inputs.travelers) || Number(inputs.travelers) < 1) {
    errors.travelers = 'Use a whole number of 1 or more.';
  }
  return errors;
}

function setFieldError(name, message) {
  const input = els.fields[name];
  const box = document.getElementById(`${name}-error`);
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  box.hidden = !message;
  box.replaceChildren(...(message ? [icon('circle-alert'), h('span', null, message)] : []));
}

function showFieldErrors(errors) {
  FIELD_NAMES.forEach((name) => setFieldError(name, errors[name]));
}

function showSummary(messages) {
  els.summary.hidden = messages.length === 0;
  if (!messages.length) { els.summary.replaceChildren(); return; }
  const list = h('ul');
  messages.forEach((m) => list.append(h('li', null, m)));
  els.summary.replaceChildren(icon('circle-alert'), h('div', null));
  els.summary.lastChild.append(h('p', 'form-summary-title', 'Please check your trip details'), list);
  els.summary.focus();
}

function focusFirstInvalid(errors) {
  const first = FIELD_NAMES.find((name) => errors[name]);
  if (first) els.fields[first].focus();
}

/** Splits the server's "Please check your inputs: ..." message into per-field messages. */
function splitServerMessage(message) {
  const text = String(message || '').replace(/^Please check your inputs:\s*/, '');
  const parts = text.split(/\s+(?=(?:Destination|Budget|Days|Travelers|Interests|section|Request)\b)/);
  const fieldErrors = {};
  const other = [];
  parts.filter(Boolean).forEach((part) => {
    const prefix = Object.keys(SERVER_FIELD_PREFIXES).find((p) => part.startsWith(p));
    const name = prefix && SERVER_FIELD_PREFIXES[prefix];
    if (name && !fieldErrors[name]) fieldErrors[name] = part;
    else other.push(part);
  });
  return { fieldErrors, other };
}

els.form.addEventListener('input', (event) => {
  const name = event.target.name;
  if (!showLiveErrors || !FIELD_NAMES.includes(name)) return;
  setFieldError(name, validate(readInputs())[name]);
});

// ---- Talking to the backend ----

async function fetchJson(url, init, timeoutMs, outerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  outerSignal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { res, body };
  } catch (err) {
    // Browsers reject an aborted fetch with different error types, so we track the timeout ourselves.
    if (timedOut) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves to { ok:true, data, meta } or { ok:false, message, retryable, code }. Never throws. */
async function requestSection(run, key) {
  try {
    const { res, body } = await fetchJson(
      '/api/itinerary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: key, ...run.inputs }),
      },
      ITINERARY_TIMEOUT_MS,
      run.controller.signal,
    );
    if (res.ok && body?.data) return { ok: true, data: body.data, meta: body.meta };
    return {
      ok: false,
      code: body?.error?.code,
      message: body?.error?.message || 'We could not create this itinerary. Please try again.',
      retryable: body?.error?.retryable !== false,
    };
  } catch (err) {
    if (run.controller.signal.aborted) return { ok: false, cancelled: true };
    return {
      ok: false,
      retryable: true,
      message: err?.name === 'TimeoutError'
        ? 'This is taking too long. Please try again.'
        : 'Could not reach the Traviora server. Check your connection and try again.',
    };
  }
}

async function requestPlace(run, place) {
  const params = new URLSearchParams({ name: place.name, city: run.inputs.city });
  if (place.location) params.set('location', place.location);
  try {
    const { res, body } = await fetchJson(`/api/place?${params}`, {}, PLACE_TIMEOUT_MS, run.controller.signal);
    return res.ok && body ? body : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' }; // a Wikipedia problem must never affect the itinerary
  }
}

// ---- Wikipedia photos and scores: filled in AFTER the itinerary is already on screen ----

function enqueuePlaces(run, cards) {
  run.queue.push(...cards);
  while (run.activeLookups < PLACE_CONCURRENCY && run.queue.length) {
    run.activeLookups += 1;
    lookupWorker(run).finally(() => { run.activeLookups -= 1; });
  }
}

async function lookupWorker(run) {
  while (run.queue.length && run === currentRun) {
    const { place, card } = run.queue.shift();
    const cacheKey = `${place.name}|${place.location}`;
    if (!run.lookups.has(cacheKey)) run.lookups.set(cacheKey, requestPlace(run, place));
    const info = await run.lookups.get(cacheKey);
    if (run === currentRun) applyPlaceInfo(card, place, info);
  }
}

// ---- Results area ----

function plural(n, one, many) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

function tripSummary({ days, travelers, budget, interests }) {
  const bits = [plural(days, 'day', 'days'), plural(travelers, 'traveler', 'travelers'), `₹${rupees.format(Number(budget))} total budget`];
  if (interests.length) bits.push(interests.join(', '));
  return bits.join(' · ');
}

function renderResultsShell(run) {
  const head = h('div', 'results-head');
  const headText = h('div');
  const title = h('h2', 'results-title', `Two itineraries for ${run.inputs.city}`);
  title.id = 'results-title';
  title.tabIndex = -1;
  headText.append(title, h('p', 'results-meta', tripSummary(run.inputs)));
  const edit = h('a', 'link-button');
  edit.href = '#tripForm';
  edit.append(icon('square-pen'), h('span', null, 'Edit trip'));
  head.append(headText, edit);

  const jump = h('nav', 'results-jump');
  jump.setAttribute('aria-label', 'Jump to an itinerary');
  SECTIONS.forEach((def) => {
    const a = h('a', `jump-link jump-link--${def.key}`, def.label);
    a.href = `#col-${def.key}`;
    jump.append(a);
  });

  const notice = h('div', 'notice');
  notice.append(icon('info'), h('p', null, 'These are AI drafts. Places, opening times and costs can be wrong or out of date, so check them before you go. Costs are rough AI estimates, not quotes.'));

  const grid = h('div', 'results-grid');
  SECTIONS.forEach((def) => { run.columns[def.key] = createColumn(def); grid.append(run.columns[def.key]); });

  const inner = h('div', 'wrap results-inner');
  inner.append(head, jump, notice, grid);
  els.result.replaceChildren(inner);
  els.result.hidden = false;
  title.focus({ preventScroll: true });
  title.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

/** The score caveat appears once, and only after at least one itinerary has loaded. */
function ensureScoreNote(run) {
  if (run.scoreNoteShown) return;
  run.scoreNoteShown = true;
  const note = h('p', 'score-note');
  note.append(
    h('strong', null, 'Underrated Score: '),
    document.createTextNode('based only on English Wikipedia page views over about the last 30 days, where fewer views give a higher score (0 to 10). It reflects online attention, not visitor numbers, quality, safety or value.'),
  );
  els.result.querySelector('.notice')?.after(note);
}

// ---- One section at a time, so each can fail and recover on its own ----

function refreshStatus(run) {
  if (run !== currentRun) return;
  const busy = run.loading > 0;
  els.status.classList.toggle('is-busy', busy);
  els.btn.disabled = busy;
  els.btn.textContent = busy ? 'Planning…' : 'Plan my trip';
  if (busy) {
    const retrying = SECTIONS.filter((def) => run.retrying.has(def.key)).map((def) => def.label);
    els.statusText.textContent = retrying.length === 1
      ? `Trying ${retrying[0]} again for ${run.inputs.city}. This can take up to a minute.`
      : `Planning two itineraries for ${run.inputs.city}. This can take up to a minute.`;
  } else {
    const ready = SECTIONS.filter((def) => run.done[def.key]).map((def) => def.label);
    const failed = SECTIONS.filter((def) => run.done[def.key] === false).map((def) => def.label);
    const parts = [];
    if (ready.length) parts.push(`${ready.join(' and ')} ${ready.length > 1 ? 'are' : 'is'} ready.`);
    if (failed.length) parts.push(`${failed.join(' and ')} could not be created.`);
    els.statusText.textContent = parts.join(' ');
  }
}

function stopForInvalidInput(run, message) {
  if (run.invalidHandled) return;
  run.invalidHandled = true;
  run.controller.abort();
  currentRun = null;
  els.result.hidden = true;
  els.result.replaceChildren();
  els.status.classList.remove('is-busy');
  els.btn.disabled = false;
  els.btn.textContent = 'Plan my trip';
  els.statusText.textContent = '';
  const { fieldErrors, other } = splitServerMessage(message);
  showFieldErrors(fieldErrors);
  showLiveErrors = true;
  if (other.length || !Object.keys(fieldErrors).length) showSummary(other.length ? other : [message]);
  else focusFirstInvalid(fieldErrors);
  els.form.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
}

async function loadSection(run, def, { retry = false } = {}) {
  const col = run.columns[def.key];
  if (retry) run.retrying.add(def.key);
  run.loading += 1;
  delete run.done[def.key];
  setColumnLoading(col, def);
  refreshStatus(run);

  const outcome = await requestSection(run, def.key);
  run.loading -= 1;
  run.retrying.delete(def.key);
  if (run !== currentRun || outcome.cancelled) return outcome;

  if (outcome.code === 'invalid_input') {
    // The server rejected the trip details: say so once, next to the form, not in each column.
    stopForInvalidInput(run, outcome.message);
    return outcome;
  }
  if (outcome.ok) {
saveTripSection(def.key, outcome.data);
    // Which provider/model actually answered is shown in the browser console, never hidden.
    console.info(`${def.label}: generated by ${outcome.meta?.provider}/${outcome.meta?.model}`);

    run.done[def.key] = true;
    els.result.querySelector('.results-error')?.remove(); // a section recovered; drop the summary error
    ensureScoreNote(run);
    enqueuePlaces(run, setColumnData(col, def, outcome.data, { city: run.inputs.city }));
  } else {
    run.done[def.key] = false;
    setColumnError(col, def, outcome.message, outcome.retryable, () => loadSection(run, def, { retry: true }));
  }
  refreshStatus(run);
  return outcome;
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (els.btn.disabled) return;
  const inputs = readInputs();
  const errors = validate(inputs);
  showLiveErrors = true;
  showFieldErrors(errors);
  showSummary([]);
  if (Object.keys(errors).length) { focusFirstInvalid(errors); return; }
  saveTripInputs(inputs);
  currentRun?.controller.abort(); // stop any lookups still running for the previous trip
  const run = {
    inputs,
    controller: new AbortController(),
    columns: {},
    done: {},
    loading: 0,
    retrying: new Set(),
    queue: [],
    activeLookups: 0,
    lookups: new Map(),
    scoreNoteShown: false,
  };
  currentRun = run;
  renderResultsShell(run);

  const outcomes = await Promise.all(SECTIONS.map((def) => loadSection(run, def)));
  if (run !== currentRun) return;

  // If everything failed, say why once at the top as well (each column keeps its own Try again).
  const failed = outcomes.filter((o) => !o.ok && !o.cancelled);
  if (failed.length === SECTIONS.length) els.result.querySelector('.notice')?.before(errorBox(failed[0].message));
});
function restoreSavedTrip() {
  let saved;

  try {
    saved = JSON.parse(
      sessionStorage.getItem(SAVED_TRIP_KEY) || 'null'
    );
  } catch {
    return;
  }

  if (!saved?.inputs || !saved?.sections) return;

  const { inputs, sections } = saved;

  els.fields.city.value = inputs.city || '';
  els.fields.budget.value = inputs.budget || '';
  els.fields.days.value = inputs.days || '';
  els.fields.travelers.value = inputs.travelers || '1';

  els.form.querySelectorAll('input[name="interests"]').forEach((box) => {
    box.checked = (inputs.interests || []).includes(box.value);
  });

  const run = {
    inputs,
    controller: new AbortController(),
    columns: {},
    done: {},
    loading: 0,
    retrying: new Set(),
    queue: [],
    activeLookups: 0,
    lookups: new Map(),
    scoreNoteShown: false,
  };

  currentRun = run;
  renderResultsShell(run);

  SECTIONS.forEach((def) => {
    if (sections[def.key]) {
      run.done[def.key] = true;
      enqueuePlaces(
        run,
        setColumnData(
          run.columns[def.key],
          def,
          sections[def.key],
          { city: inputs.city }
        )
      );
    } else {
      loadSection(run, def);
    }
  });

  refreshStatus(run);
}

restoreSavedTrip();
