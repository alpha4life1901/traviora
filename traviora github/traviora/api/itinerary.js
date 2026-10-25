// Vercel serverless function: POST /api/itinerary
// All logic lives in ../server so it can be tested without Vercel.
import { createApp } from '../server/app.js';

const app = createApp();

export default {
  fetch: (request) => app.itinerary(request),
};
