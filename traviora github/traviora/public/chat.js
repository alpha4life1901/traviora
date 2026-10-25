// The floating chat assistant. It only talks to this site's own /api/chat endpoint; the server adds
// the Agent 37 key. Replies are built with DOM methods and textContent, never innerHTML.
// Messages live only in this page's memory: nothing is saved, and a reload starts a fresh chat.
import { icon } from './icons.js';
import { parseReply } from './chat-format.js';

const MAX_CHARS = 800; // same limit as server/chat.js
const HISTORY_ITEMS = 6; // earlier messages sent along for context
const TIMEOUT_MS = 60000; // a little longer than the server's own limit
const SUGGESTIONS = [
  'Best time to visit Spiti Valley?',
  'A 2-day trip near Bengaluru under \u20B96,000',
  'How do I get from Delhi to Rishikesh?',
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendInline(parent, pieces) {
  for (const piece of pieces) parent.append(piece.strong ? el('strong', null, piece.text) : document.createTextNode(piece.text));
}

/** Builds the reply from parsed Markdown blocks (text only). */
function renderReply(text) {
  const frag = document.createDocumentFragment();
  for (const block of parseReply(text)) {
    if (block.type === 'h') {
      const p = el('p', 'chat-h');
      appendInline(p, block.inline);
      frag.append(p);
    } else if (block.type === 'ul' || block.type === 'ol') {
      const list = el(block.type);
      for (const item of block.items) { const li = el('li'); appendInline(li, item); list.append(li); }
      frag.append(list);
    } else if (block.type === 'table') {
      const wrap = el('div', 'chat-table');
      const table = el('table');
      block.rows.forEach((row, i) => {
        const tr = el('tr');
        for (const cell of row) { const c = el(i === 0 ? 'th' : 'td'); appendInline(c, cell); tr.append(c); }
        table.append(tr);
      });
      wrap.append(table);
      frag.append(wrap);
    } else {
      const p = el('p');
      block.lines.forEach((line, i) => { if (i) p.append(el('br')); appendInline(p, line); });
      frag.append(p);
    }
  }
  return frag;
}

/** The trip the visitor planned on this page (saved by app.js), if any. */
function savedTrip() {
  try {
    const inputs = JSON.parse(sessionStorage.getItem('traviora:savedTrip') || 'null')?.inputs;
    return inputs?.city ? inputs : null;
  } catch {
    return null;
  }
}

// ---- Build the widget ----

const fab = el('button', 'chat-fab');
fab.type = 'button';
fab.setAttribute('aria-expanded', 'false');
fab.setAttribute('aria-controls', 'chat-panel');
fab.append(icon('compass'), el('span', 'chat-fab-label', 'Ask Traviora'));

const panel = el('section', 'chat-panel');
panel.id = 'chat-panel';
panel.setAttribute('role', 'dialog');
panel.setAttribute('aria-labelledby', 'chat-title');
panel.hidden = true;

const head = el('div', 'chat-head');
const headText = el('div');
const title = el('p', 'chat-title', 'Travel assistant');
title.id = 'chat-title';
headText.append(title, el('p', 'chat-sub', 'Powered by Agent 37. AI answers can be wrong, so check before you book.'));
const closeBtn = el('button', 'chat-close');
closeBtn.type = 'button';
closeBtn.setAttribute('aria-label', 'Close chat');
closeBtn.append(icon('x'));
head.append(headText, closeBtn);

const log = el('div', 'chat-log');
log.setAttribute('role', 'log');
log.setAttribute('aria-live', 'polite');

const tripNote = el('p', 'chat-trip');
tripNote.hidden = true;

const suggest = el('div', 'chat-suggest');
for (const text of SUGGESTIONS) {
  const b = el('button', 'chat-chip', text);
  b.type = 'button';
  b.addEventListener('click', () => send(text));
  suggest.append(b);
}

const form = el('form', 'chat-form');
form.noValidate = true;
const label = el('label', 'visually-hidden', 'Your message');
label.htmlFor = 'chat-input';
const input = el('textarea', 'chat-input');
input.id = 'chat-input';
input.rows = 2;
input.maxLength = MAX_CHARS;
input.placeholder = 'Ask about places, routes or budgets';
const sendBtn = el('button', 'chat-send', 'Send');
sendBtn.type = 'submit';
const count = el('p', 'chat-count', `0/${MAX_CHARS}`);
form.append(label, input, sendBtn);

panel.append(head, log, tripNote, suggest, form, count);
document.body.append(panel, fab);

addMessage('assistant', 'Hi! Ask me anything about travelling in India: where to go, how to get there, what it might cost. If you planned a trip above, I will take it into account.');

// ---- Behaviour ----

const history = []; // { role: 'user'|'assistant', text } for completed exchanges only
let busy = false;

function addMessage(kind, text) {
  const msg = el('div', `chat-msg chat-msg--${kind}`);
  if (kind === 'assistant') msg.append(renderReply(text));
  else if (kind === 'user') appendInline(msg, [{ text }]);
  else msg.append(icon('circle-alert'), el('span', null, text));
  log.append(msg);
  // Long replies: show their start, not their end, so they read top-down.
  if (kind === 'assistant') log.scrollTop += msg.getBoundingClientRect().top - log.getBoundingClientRect().top - 8;
  else log.scrollTop = log.scrollHeight;
  return msg;
}

function showTrip() {
  const trip = savedTrip();
  tripNote.hidden = !trip;
  if (!trip) return;
  tripNote.replaceChildren(icon('map-pin'), el('span', null, `Using your planned trip: ${trip.city}${trip.days ? `, ${trip.days} days` : ''}`));
}

function setOpen(open) {
  panel.hidden = !open;
  fab.setAttribute('aria-expanded', String(open));
  fab.classList.toggle('is-open', open);
  if (open) { showTrip(); input.focus(); } else { fab.focus(); }
}

async function send(rawText) {
  const text = String(rawText || '').trim();
  if (busy || !text) return;
  if (text.length > MAX_CHARS) { addMessage('error', `Please keep your message under ${MAX_CHARS} characters.`); return; }
  busy = true;
  sendBtn.disabled = true;
  suggest.hidden = true;
  input.value = '';
  count.textContent = `0/${MAX_CHARS}`;
  addMessage('user', text);

  const thinking = el('div', 'chat-msg chat-msg--thinking');
  const thinkingText = el('span', null, 'Thinking');
  thinking.append(el('span', 'chat-dots'), thinkingText);
  log.append(thinking);
  log.scrollTop = log.scrollHeight;
  const started = Date.now();
  const tick = setInterval(() => { thinkingText.textContent = `Thinking, ${Math.round((Date.now() - started) / 1000)} s`; }, 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let reply = null;
  let error = 'Could not reach the Traviora server. Check your connection and try again.';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history: history.slice(-HISTORY_ITEMS), trip: savedTrip() || undefined }),
      signal: controller.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (res.ok && typeof body?.reply === 'string') reply = body.reply;
    else error = body?.error?.message || 'The travel assistant could not answer. Please try again.';
  } catch {
    if (controller.signal.aborted) error = 'This is taking too long. Please try again.';
  } finally {
    clearTimeout(timer);
    clearInterval(tick);
    thinking.remove();
  }

  if (reply !== null) {
    addMessage('assistant', reply);
    history.push({ role: 'user', text }, { role: 'assistant', text: reply });
  } else {
    addMessage('error', error);
    if (!input.value) { input.value = text; count.textContent = `${text.length}/${MAX_CHARS}`; } // easy to resend
  }
  busy = false;
  sendBtn.disabled = false;
  input.focus();
}

fab.addEventListener('click', () => setOpen(panel.hidden));
closeBtn.addEventListener('click', () => setOpen(false));
panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') setOpen(false); });
form.addEventListener('submit', (event) => { event.preventDefault(); send(input.value); });
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(input.value); }
});
input.addEventListener('input', () => { count.textContent = `${input.value.length}/${MAX_CHARS}`; });

