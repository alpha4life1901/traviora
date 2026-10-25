# Traviora – secure planner (Phase 2)

Your planner now talks to a small **backend** (code that runs on a server, not in the visitor's browser).
The backend holds the Gemini and Groq keys, so the web page never sees them.

The planner page was redesigned (calmer colours, self-hosted icons and font, clearer form errors, phone-friendly layout). It keeps the same inputs, interests, Hidden Gems and Iconic India columns, day cards, "Getting around", "Where to stay", photos and Underrated Score. The backend, prompts and API requests are unchanged.

**Landing page (redesign phase 1):** the home page now opens with a photo-led introduction (cobalt, lime, tangerine and coral on cream, Bricolage Grotesque headings), a "How it works" route, a "What you get" list and the trip form styled as a ticket. The form itself, its checks, the loading and error states, the requests and the itinerary results work exactly as before. The destination page keeps its purple accents. Every "Plan my trip" button only scrolls to the form; it never sends anything.

## Folder structure

```
traviora/
├── public/                  What visitors' browsers receive (contains NO keys)
│   ├── index.html           The landing page with the planner form and results
│   ├── styles.css           All page styles (colours are defined once at the top)
│   ├── render.js            Builds the cards safely (text can never run as code)
│   ├── app.js               Page logic: form checks, one request per section, per-section retry, Wikipedia fill-in
│   ├── landing.js           "Plan my trip" focus handling and a plain panel if a landing photo fails to load
│   ├── icons.js             The SVG icons (from Lucide, ISC licence), drawn without any outside requests
│   ├── images/              Six landing photos from Wikimedia Commons (CC BY-SA, cropped and resized;
│   │                        authors and licences are credited in the page footer, keep those credits)
│   └── fonts/               Source Serif 4 and Bricolage Grotesque (both SIL Open Font License, texts included)
├── api/                     The two serverless functions Vercel runs
│   ├── itinerary.js         POST /api/itinerary  – generates ONE section (hidden or iconic)
│   └── place.js             GET  /api/place      – Wikipedia photo + Underrated Score for one place
├── server/                  Shared backend code (used by both api/ files and the local server)
│   ├── app.js               The two endpoints: limits, validation, responses
│   ├── config.js            Reads settings from environment variables
│   ├── generate.js          Bounded Gemini → Groq fallback plan
│   ├── providers.js         The actual Gemini / Groq requests (with timeouts)
│   ├── schema.js            The itinerary format the AI must follow
│   ├── validate.js          Checks incoming requests and the AI's answers
│   ├── prompts.js           The prompts (wording carried over from your original)
│   ├── wikipedia.js         Wikipedia + pageviews lookup (never blocks, never throws)
│   ├── rateLimit.js         Best-effort request counter
│   ├── errors.js            Safe, user-friendly error messages
│   └── http.js              Response helpers, size limits, origin check
├── scripts/check-models.js  Lists the models YOUR keys can use
├── tests/                   Automated tests (fake providers; no keys, no internet)
├── server.js                Local development server (no installs needed)
├── vercel.json              Vercel settings: function time limits + security headers
├── package.json             Project info and the commands below
├── .vercelignore            Keeps .env out of CLI uploads to Vercel
├── .env.example             Template for your settings (placeholders only)
└── .gitignore               Keeps .env (your real keys) out of Git
```

## 1. Before anything else: replace the old keys

The four keys that were inside the old HTML file must be treated as public. Do this first:

1. Open your Google AI Studio and Groq accounts and **delete / revoke** the old keys.
2. Create **new** keys. Keep them to yourself: never paste them in chat, code, screenshots or Git.

## 2. Run it on your computer

You need **Node.js 22** (download from nodejs.org – it also installs `npm`). No other installs are needed; this project has no dependencies.

1. Open a terminal **inside the `traviora` folder**.
2. Make your private settings file:
   - Mac/Linux: `cp .env.example .env`
   - Windows (PowerShell): `copy .env.example .env`
3. Open `.env` in a text editor. Replace `paste_your_new_gemini_key_here` and `paste_your_new_groq_key_here` with your new keys (no quotes, no spaces). Save. (`.env` is ignored by Git, so it will not be uploaded.)
4. Start the server: `npm start`
   (same as `node --env-file=.env server.js`)
5. It prints whether each key is **set** or **MISSING** (never the key itself). Open **http://localhost:3000**. Do not double-click `public/index.html`: the page uses modern script modules that browsers refuse to load from a plain file.
6. Stop it with `Ctrl+C`.

One key is enough to start. Without any key, the page shows "The server has no AI provider key configured yet".

### Check which models your account can use

```
npm run check-models
```

This asks Google and Groq which models your keys can use and compares them with `GEMINI_MODELS` / `GROQ_MODELS` in `.env` (if you set separate per-section keys, each distinct key is checked once). Lines marked `NOT LISTED` will not work for your key. **Nothing is ever switched automatically**: change the names in `.env` yourself.
(Your old file used `gemini-3.5-flash`; Google's public model list on 24 Oct 2026 did not show that exact name, so confirm with this command.)

To use more than one Gemini model, list them in order, e.g. `GEMINI_MODELS=gemini-3.6-flash,gemini-3.5-flash-lite`. They are tried only in that order, and the browser console shows which model produced each side.

### Run the tests

```
npm test
```

## 3. Deploy to Vercel (free Hobby plan)

Hobby is for personal, non-commercial use.

1. Put the project in a GitHub repository. **Check that `.env` is not in it** (it shouldn't be: `.gitignore` excludes it).
2. At vercel.com: *Add New → Project → import the repository*. Leave the build settings as they are (no build step).
3. Before deploying, open *Settings → Environment Variables* and add (for Production, and Preview if you use it):
   - `GEMINI_API_KEY` – choose the **Secret** type so it cannot be read back
   - `GROQ_API_KEY` – choose the **Secret** type so it cannot be read back
   - Optional: any other setting from `.env.example` (e.g. `GEMINI_MODELS`, `WIKIMEDIA_CONTACT=your-email`).
4. Deploy. Open the `*.vercel.app` address and generate a trip.
5. Changed a variable later? Vercel only applies it to **new** deployments – redeploy.

Alternative without GitHub: install the Vercel command-line tool and run `vercel` in this folder; add the variables with the same names.

## 4. Local vs deployed: what differs

| | On your computer (`npm start`) | On Vercel |
|---|---|---|
| Code that handles requests | Same files in `server/` | Same files in `server/` |
| Where keys come from | `.env` file | Vercel dashboard variables |
| Process | One program that keeps running | Functions that start/stop on demand |
| Rate limit counters | One counter, behaves strictly | **Separate counter per running instance**; resets when an instance restarts |
| Wikipedia answer caching | None | Vercel can cache `/api/place` answers (up to a day) |
| Security headers | Added by `server.js` | Added by `vercel.json` |
| Visitor identification | Your computer's address | Address headers set by Vercel (not verified on a live deployment) |
| Reachable by | Only your computer | Anyone with the link |
| Function time limit | None | 60 s for itineraries (set in `vercel.json`) |

Because the page and API share one address, no cross-site (CORS) setup is needed.

## 5. Limits and protection (and their limits)

All of these are settings in `.env` / Vercel variables (see `.env.example` for every name):

| Protection | Default |
|---|---|
| Destination 2–80 characters, letters/digits/space/`. , ' ( ) & -` only | fixed |
| Budget 1 … `MAX_BUDGET`, days 1 … `MAX_DAYS`, travelers 1 … `MAX_TRAVELERS` | 7 days, 20 travelers |
| Request body size | 4 KB |
| AI answer size | `MAX_OUTPUT_TOKENS` 6000; places per day 1–5; text lengths capped |
| Time per AI request / for everything | 12 s / 45 s (`PROVIDER_TIMEOUT_MS` / `TOTAL_TIMEOUT_MS`; the total is capped at 55 s so it fits inside Vercel's 60 s function limit) |
| Gemini tries / Groq tries per section | 3 / 2 (permanent errors are not retried) |
| Requests per visitor per 10 min | 20 itineraries (= 10 trips, two sections each), 300 Wikipedia lookups |
| Requests across all visitors per 10 min | 200 itineraries |

**Rate limiting is best-effort, not a guarantee.** On Vercel the counters live in each instance's memory, so a determined person can get around them. Treat them as protection against accidents and casual misuse. The real safety net is **spending limits on your provider accounts**:

- In each provider's console, set a **budget / spend limit and an alert email** (look for "billing", "budget" or "spend limits" in the Google AI Studio / Google Cloud console and the Groq console; menu names change, so check their current documentation).
- Use separate keys for testing and production so you can revoke one without breaking the other.
- Check usage after your first public day.

For stronger protection later you would add a shared counter service or Vercel's firewall rules (not part of this phase).

## 6. How failures are handled

- **Two independent requests**: Hidden Gems and Iconic India are generated separately. If one fails, the other still appears, and "Try again" retries **only that side**.
- **Fallback**: Gemini (your listed models, in order) → Groq. Empty, cut-off, malformed or wrongly-shaped answers count as failed attempts; broken JSON is never "repaired".
- **Slow Gemini?** If the logs show Gemini timeouts, try `PROVIDER_TIMEOUT_MS=25000`. Fewer retries then fit in the 45 s total, which is a deliberate trade-off.
- **Permanent errors** (bad key, unknown model) are not retried; temporary ones (busy, rate limit, timeout) are retried with short pauses. A rate-limit reply asking for a long wait skips that provider.
- **Wikipedia is optional**: the itinerary appears first; photos and scores fill in afterwards (3 at a time, 12 s limit each). If Wikipedia is down the card simply has no photo/score. "Not yet on Wikipedia" appears **only** when Wikipedia really answered that there is no article.

## 7. Troubleshooting

| Message / symptom | What to do |
|---|---|
| "The server has no AI provider key configured yet" | `.env` missing or still has `paste_your_…` values; on Vercel, add variables and redeploy |
| "The AI provider rejected the server's credentials" | Key wrong, revoked or from the wrong account; create a new one |
| "The AI services are not available with the current configuration" | Every model name was reported as unknown by the provider – run `npm run check-models` and fix the names in `.env` |
| Gemini always fails, Groq always answers | Look at the server log lines (`gemini/<model>=...`). If you see `bad_request`, try `GEMINI_SEND_SCHEMA=false` |
| "The AI services are busy or rate-limited right now" | Wait a minute. Free tiers have limits, and limits apply per Google project / Groq organisation, not per key |
| "Too many requests" | Best-effort limit reached; wait the shown seconds or raise `RATE_LIMIT_*` |
| Page shows but nothing happens (local) | Use `http://localhost:3000`, not by opening `index.html` directly |

## 8. What has and has not been verified

**Automated tests**: `node --test "tests/*.test.js"` ran 121 tests, all passing, using **fake** provider replies and fake keys (no internet): validation, limits, fallback, timeouts, permanent vs temporary errors, model-unavailable handling, section independence, Wikipedia failure states, the model checker, a scan for key-shaped strings in the project, and page checks (no inline styles or scripts, no innerHTML, interests match the server, every referenced file and icon exists, no emoji, em dashes or gradients), the Wikipedia photo filter (only https photos from `upload.wikimedia.org` and `thumb.wikimedia.org`), identical security headers locally and in `vercel.json`, `.gitignore` / `.vercelignore` excluding real env files, and no env file inside `public/`. The landing page tests (`tests/landing.test.js`) check that every photo file exists and has a size, description and matching footer credit, that every in-page link has a target, that the form keeps every element `app.js` needs, that "Plan my trip" links only point at the form, that the page offers no accounts, bookings or reviews, and that photos, the new font and `landing.js` are served with the right file types.

**Landing page browser check** (fake backend, Chrome only): widths 360, 390, 768, 1024, 1366 and 1440 px with no sideways scrolling; "Plan my trip" scrolls to the form without sending anything (focus goes to the first field with a mouse, or to the form heading on touch screens so no keyboard pops up); keyboard Tab order and visible focus rings; reduced-motion setting (no smooth scrolling, still spinner); empty-form errors; a full plan, one section failing and its retry; restoring a saved trip after reload; opening a destination page; broken-photo fallback.

**Manual browser check** (not an automated test): the real page files were loaded in a browser against a **fake** backend. Checked at desktop (1366 px) and phone (390 px) width after the redesign: empty-form errors; server-side input errors shown next to the right fields; loading state; one section failing while the other renders; both sections failing; retry of only the failed section; Wikipedia found, not found and unavailable states; photos; HTML-looking text from the AI shown as plain text; no sideways scrolling on the phone. Not checked: real screen readers, browsers other than Chrome, and the real backend.

**Not run**: the `npm` shortcuts (`npm start`, `npm test`, `npm run check-models`) because `npm` was not available where this was built; the equivalent `node` commands were used instead.

**Not verified** (needs your new keys / a real deployment): real Gemini and Groq responses and model availability, Gemini accepting the `responseJsonSchema` hint, Groq strict mode with the real model, Wikipedia photos and pageviews on the deployed site (a live run of the lookup code outside any deployment on 2026-10-24 did return `thumb.wikimedia.org` photos for Amber Fort, Hawa Mahal, Taj Mahal and Golghar), quality or accuracy of itineraries, running on Vercel, Vercel's client-address headers, and real provider spending limits.
