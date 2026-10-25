// Vercel serverless function: POST /api/chat (the floating chat assistant)
// All logic lives in ../server/chat.js so it can be tested without Vercel.
import { createChat } from '../server/chat.js';

const app = createChat();

export default {
  fetch: (request) => app.chat(request),
};
