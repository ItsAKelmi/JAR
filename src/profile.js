'use strict';

/**
 * Temporarily reshape the JanitorAI profile so a capture works, then put it back.
 *
 * Two things must be true for the extractor to get a clean, tag-wrapped prompt:
 *  1. A custom OpenAI-compatible PROXY preset must be selected (not JLLM). Only then
 *     does the client assemble the prompt for a proxy and fire `/generateAlpha`
 *     with the `<…Persona>` / `<Scenario>` wrappers we rely on.
 *  2. `generation_settings.context_length` must be 0. With a finite context, the
 *     JanitorAI server compresses/reorders the prompt to fit — which UNWRAPS the
 *     persona block and breaks separation. 0 = "don't truncate".
 *
 * We GET the profile, snapshot its `config`, PATCH a modified copy (inject + select
 * a self-owned dummy proxy preset, force context_length 0), run the capture, then
 * PATCH the original snapshot back — which also removes our dummy preset.
 */

const { authedFetch } = require('./autotrigger');

const PROFILE_URL = 'https://janitorai.com/hampter/profiles/mine';

// A self-owned proxy preset the tool injects for the duration of a run. The URL is
// intentionally unreachable: we capture the `/generateAlpha` RESPONSE (the assembled
// prompt) BEFORE the client ever POSTs to the proxy, so the proxy never needs to
// answer. Fixed id so a crashed run doesn't leave duplicates behind.
const DUMMY_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

/**
 * Build the throwaway proxy preset with a RANDOM name and port (always above
 * 8000). The id stays fixed (see {@link DUMMY_ID}) so dedup / crash-cleanup
 * still works, but the name/port are randomised each run so the injected preset
 * isn't fingerprintable by a constant string or port.
 */
function buildDummyPreset() {
  const port = 8001 + Math.floor(Math.random() * 57000); // 8001..65000
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let name = '';
  for (let i = 0; i < 12; i += 1) {
    name += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return {
    apiKey: 'x',
    apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    id: DUMMY_ID,
    jailbreakPrompt: '',
    model: 'gpt-4o',
    name,
  };
}

async function getProfile(page) {
  const r = await authedFetch(page, PROFILE_URL);
  if (r.status >= 400) throw new Error(`get profile failed: HTTP ${r.status}`);
  try { return JSON.parse(r.body); } catch (e) {
    throw new Error('get profile: response was not JSON');
  }
}

async function patchConfig(page, config) {
  const r = await authedFetch(page, PROFILE_URL, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  if (r.status >= 400) {
    throw new Error(`patch profile failed: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  }
  return r.body;
}

/**
 * Switch the profile into "extraction mode" (dummy proxy preset selected,
 * context_length 0). Returns the ORIGINAL config snapshot to pass to
 * {@link restoreProfile}. PATCH the returned snapshot back after the run.
 * @returns {Promise<object>} original config snapshot
 */
async function enterExtractionMode(page) {
  const profile = await getProfile(page);
  const original = profile && profile.config;
  if (!original) throw new Error('profile has no config to modify');

  const next = JSON.parse(JSON.stringify(original));

  const dummyPreset = buildDummyPreset();
  next.proxyConfigurations = Array.isArray(next.proxyConfigurations)
    ? next.proxyConfigurations.slice() : [];
  // Drop any stale copy from a crashed run, then add a freshly-randomised one
  // (so the random name/port actually take effect each run).
  next.proxyConfigurations = next.proxyConfigurations.filter((p) => !(p && p.id === DUMMY_ID));
  next.proxyConfigurations.push(dummyPreset);
  next.selectedProxyConfigId = DUMMY_ID;
  next.api = 'openai';
  next.open_ai_mode = 'proxy';
  next.open_ai_reverse_proxy = dummyPreset.apiUrl;
  next.openAiModel = dummyPreset.model;

  next.generation_settings = Object.assign({}, next.generation_settings, {
    context_length: 0,
  });

  await patchConfig(page, next);
  const prevCtx = original.generation_settings && original.generation_settings.context_length;
  console.log(`[profile] extraction mode on (context_length ${prevCtx} -> 0, dummy proxy selected)`);
  return original;
}

/** PATCH the original config snapshot back (also drops the injected dummy preset). */
async function restoreProfile(page, original) {
  if (!original) return;
  await patchConfig(page, original);
  console.log('[profile] restored original config (preset + context_length)');
}

module.exports = {
  getProfile, enterExtractionMode, restoreProfile, PROFILE_URL, DUMMY_ID,
};
