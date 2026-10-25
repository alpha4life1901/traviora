// The JSON "shape" the AI must return. This is the same shape the planner page already renders
// (title, transportationOptions, accommodationOptions, days -> places). It is sent to Groq
// (strict mode) and Gemini (structured output) and is ALSO re-checked by validateSection()
// in validate.js, because a provider promising a shape is not the same as us verifying it.

const optionItem = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    estimatedCost: { type: 'string' },
  },
  required: ['name', 'description', 'estimatedCost'],
  additionalProperties: false,
};

const placeItem = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    whyItFits: { type: 'string' },
    duration: { type: 'string' },
    estimatedCost: { type: 'string' },
    location: { type: 'string' },
  },
  required: ['name', 'description', 'whyItFits', 'duration', 'estimatedCost', 'location'],
  additionalProperties: false,
};

export const SECTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    transportationOptions: { type: 'array', items: optionItem },
    accommodationOptions: { type: 'array', items: optionItem },
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'integer' },
          title: { type: 'string' },
          places: { type: 'array', items: placeItem },
        },
        required: ['day', 'title', 'places'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'transportationOptions', 'accommodationOptions', 'days'],
  additionalProperties: false,
};

// Hard caps on what we accept back (strict output limits).
export const OUTPUT_LIMITS = {
  optionsPerList: 3,
  placesPerDayMin: 1,
  placesPerDayMax: 5,
  name: 120,
  short: 300, // description, whyItFits
  tiny: 80, // duration, estimatedCost, location, day title
};

export const SECTION_TITLES = {
  hidden: 'India Beyond The Map.',
  iconic: 'Experience the classics.',
};
