// Lists the AI models YOUR keys can use and checks the names in your settings.
//   npm run check-models        (or: node --env-file=.env scripts/check-models.js)
// It only reads model lists (no text generation), prints model names only, and never prints keys.

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../server/config.js';

async function getJson(fetchImpl, url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'timed out' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

// Each distinct key is checked once (the two sections may use different keys).
function distinctKeys(byLabel) {
  const seen = new Map();
  for (const [label, key] of Object.entries(byLabel)) {
    if (!key) continue;
    if (seen.has(key)) seen.get(key).labels.push(label);
    else seen.set(key, { key, labels: [label] });
  }
  return [...seen.values()];
}

/**
 * @returns {Promise<{provider: string, keyFor: string, error?: string, available: string[], settings: {model: string, listed: boolean}[]}[]>}
 */
export async function checkModels({ config = loadConfig(), fetchImpl = globalThis.fetch, print = console.log } = {}) {
  const results = [];

  const report = (provider, labels, available, configured) => {
    const settings = configured.map((model) => ({ model, listed: available.includes(model) }));
    results.push({ provider, keyFor: labels.join(' + '), available, settings });
    print(`\n${provider} models available to the ${labels.join(' + ')} key:`);
    if (available.length === 0) print('  (no models returned)');
    available.forEach((m) => print(`  - ${m}`));
    print('  Your settings:');
    settings.forEach((s) => print(`  ${s.listed ? 'OK        ' : 'NOT LISTED'}  ${s.model}`));
  };

  const geminiKeys = distinctKeys({ 'Hidden Gems': config.keys.gemini.hidden, 'Iconic India': config.keys.gemini.iconic });
  if (geminiKeys.length === 0) print('Gemini: no GEMINI_API_KEY set, skipping.');
  for (const { key, labels } of geminiKeys) {
    const r = await getJson(fetchImpl, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { 'x-goog-api-key': key });
    if (r.error) {
      results.push({ provider: 'Gemini', keyFor: labels.join(' + '), error: r.error, available: [], settings: [] });
      print(`\nGemini (${labels.join(' + ')}): could not list models (${r.error}). Check the key.`);
      continue;
    }
    const names = (r.data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      .sort();
    report('Gemini', labels, names, config.gemini.models);
  }

  const groqKeys = distinctKeys({ 'Hidden Gems': config.keys.groq.hidden, 'Iconic India': config.keys.groq.iconic });
  if (groqKeys.length === 0) print('\nGroq: no GROQ_API_KEY set, skipping.');
  for (const { key, labels } of groqKeys) {
    const r = await getJson(fetchImpl, 'https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${key}` });
    if (r.error) {
      results.push({ provider: 'Groq', keyFor: labels.join(' + '), error: r.error, available: [], settings: [] });
      print(`\nGroq (${labels.join(' + ')}): could not list models (${r.error}). Check the key.`);
      continue;
    }
    report('Groq', labels, (r.data.data || []).map((m) => m.id).sort(), config.groq.models);
  }

  print('\nA model being listed means it exists for your key; it does not guarantee quota or JSON-schema support.');
  return results;
}

// Run only when started from the command line (not when imported by the tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkModels();
}
