// Vercel serverless function: GET /api/place?name=...&city=...&location=...
import { createApp } from '../server/app.js';

const app = createApp();

export default {
  fetch: (request) => app.place(request),
};
