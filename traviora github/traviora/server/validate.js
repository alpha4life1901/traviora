// Checks everything that crosses a trust boundary:
//   validateItineraryRequest  - what the browser sends us
//   validateSection           - what the AI sends back
//   validatePlaceQuery        - what the browser asks for on /api/place
// Each returns { ok: true, value } or { ok: false, errors: [...] }.

import { OUTPUT_LIMITS, SECTION_TITLES } from './schema.js';

export const SECTIONS = ['hidden', 'iconic'];
export const INTERESTS = ['Nature', 'History', 'Food', 'Adventure'];

// Letters (any language), digits, spaces and a few harmless punctuation marks.
// Quotes, brackets, newlines and similar are rejected, which also blocks most prompt tricks.
const CITY_PATTERN = /^[\p{L}\p{M}\p{N} .,'’()&\-]+$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const t = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

function parseWholeNumber(value, { allowDecimal = false } = {}) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const v = value.trim();
  const re = allowDecimal ? /^\d+(\.\d{1,2})?$/ : /^\d+$/;
  return re.test(v) ? Number(v) : NaN;
}

export function validateItineraryRequest(body, limits) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['Request body must be a JSON object.'] };
  }

  const section = body.section;
  if (!SECTIONS.includes(section)) errors.push('section must be "hidden" or "iconic".');

  const rawCity = typeof body.city === 'string' ? body.city.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim() : '';
  if (rawCity.length < 2 || rawCity.length > 80) errors.push('Destination must be 2 to 80 characters.');
  else if (!CITY_PATTERN.test(rawCity)) errors.push('Destination may only contain letters, numbers, spaces and . , \' ( ) & -');

  const budget = parseWholeNumber(body.budget, { allowDecimal: true });
  if (!(budget >= 1 && budget <= limits.maxBudget)) {
    errors.push(`Budget must be a number between 1 and ${limits.maxBudget}.`);
  }

  const days = parseWholeNumber(body.days);
  if (!Number.isInteger(days) || days < 1 || days > limits.maxDays) {
    errors.push(`Days must be a whole number between 1 and ${limits.maxDays}.`);
  }

  const travelersRaw = body.travelers === undefined || body.travelers === '' ? 1 : body.travelers;
  const travelers = parseWholeNumber(travelersRaw);
  if (!Number.isInteger(travelers) || travelers < 1 || travelers > limits.maxTravelers) {
    errors.push(`Travelers must be a whole number between 1 and ${limits.maxTravelers}.`);
  }

  let interests = [];
  if (body.interests !== undefined) {
    if (!Array.isArray(body.interests) || body.interests.length > INTERESTS.length) {
      errors.push('Interests must be a list of known interests.');
    } else if (body.interests.some((i) => !INTERESTS.includes(i))) {
      errors.push(`Interests must be among: ${INTERESTS.join(', ')}.`);
    } else {
      interests = [...new Set(body.interests)];
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      section,
      city: rawCity,
      budget: Math.round(budget),
      days,
      travelers,
      interests: interests.length ? interests : ['general sightseeing'],
    },
  };
}

function checkOptionList(list, path, errors) {
  if (!Array.isArray(list) || list.length !== OUTPUT_LIMITS.optionsPerList) {
    errors.push(`${path} must contain exactly ${OUTPUT_LIMITS.optionsPerList} items.`);
    return [];
  }
  return list.map((item, i) => {
    const name = cleanText(item?.name, OUTPUT_LIMITS.name);
    const description = cleanText(item?.description, OUTPUT_LIMITS.short);
    const estimatedCost = cleanText(item?.estimatedCost, OUTPUT_LIMITS.tiny);
    if (!name) errors.push(`${path}[${i}].name is missing.`);
    if (description === null) errors.push(`${path}[${i}].description must be text.`);
    if (estimatedCost === null) errors.push(`${path}[${i}].estimatedCost must be text.`);
    return { name, description: description ?? '', estimatedCost: estimatedCost ?? '' };
  });
}

/**
 * Validates and cleans the AI's itinerary. Only known fields are kept, text is trimmed and
 * length-capped, and the day count must match what was asked for.
 */
export function validateSection(data, { section, days }) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['Response is not a JSON object.'] };
  }

  const transportationOptions = checkOptionList(data.transportationOptions, 'transportationOptions', errors);
  const accommodationOptions = checkOptionList(data.accommodationOptions, 'accommodationOptions', errors);

  let cleanDays = [];
  if (!Array.isArray(data.days) || data.days.length !== days) {
    errors.push(`days must contain exactly ${days} items.`);
  } else {
    cleanDays = data.days.map((d, di) => {
      const places = Array.isArray(d?.places) ? d.places : null;
      if (!places || places.length < OUTPUT_LIMITS.placesPerDayMin || places.length > OUTPUT_LIMITS.placesPerDayMax) {
        errors.push(`days[${di}].places must contain ${OUTPUT_LIMITS.placesPerDayMin}-${OUTPUT_LIMITS.placesPerDayMax} places.`);
        return null;
      }
      const title = cleanText(d?.title, OUTPUT_LIMITS.tiny);
      if (title === null) errors.push(`days[${di}].title must be text.`);
      return {
        day: di + 1, // numbering is normalised rather than trusted
        title: title ?? '',
        places: places.map((p, pi) => {
          const name = cleanText(p?.name, OUTPUT_LIMITS.name);
          const description = cleanText(p?.description, OUTPUT_LIMITS.short);
          const whyItFits = cleanText(p?.whyItFits, OUTPUT_LIMITS.short);
          const duration = cleanText(p?.duration, OUTPUT_LIMITS.tiny);
          const estimatedCost = cleanText(p?.estimatedCost, OUTPUT_LIMITS.tiny);
          const location = cleanText(p?.location, OUTPUT_LIMITS.name);
          if (!name) errors.push(`days[${di}].places[${pi}].name is missing.`);
          if (description === null) errors.push(`days[${di}].places[${pi}].description must be text.`);
          for (const [k, v] of Object.entries({ whyItFits, duration, estimatedCost, location })) {
            if (v === null) errors.push(`days[${di}].places[${pi}].${k} must be text.`);
          }
          return {
            name,
            description: description ?? '',
            whyItFits: whyItFits ?? '',
            duration: duration ?? '',
            estimatedCost: estimatedCost ?? '',
            location: location ?? '',
          };
        }),
      };
    });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      // The title is fixed per section so the page heading never depends on AI wording.
      title: SECTION_TITLES[section],
      transportationOptions,
      accommodationOptions,
      days: cleanDays,
    },
  };
}

export function validatePlaceQuery(params) {
  const name = cleanText(params.name ?? '', 120);
  const city = cleanText(params.city ?? '', 80);
  const location = cleanText(params.location ?? '', 120);
  if (!name) return { ok: false, errors: ['name is required.'] };
  if (city === null || location === null) return { ok: false, errors: ['Invalid query.'] };
  return { ok: true, value: { name, city, location } };
}
