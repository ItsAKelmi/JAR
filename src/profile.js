'use strict';

/**
 * Temporarily reshape the JanitorAI API settings so a capture works, then put
 * them back.
 *
 * Two things must be true for the extractor to get a clean, tag-wrapped prompt:
 *  1. A custom OpenAI-compatible PROXY preset must be selected (not JLLM). Only then
 *     does the client assemble the prompt for a proxy and fire `/generateAlpha`
 *     with the `<…Persona>` / `<Scenario>` wrappers we rely on.
 *  2. `generation_settings.context_length` must be 0. With a finite context, the
 *     JanitorAI server compresses/reorders the prompt to fit — which UNWRAPS the
 *     persona block and breaks separation. 0 = "don't truncate".
 *
 * JanitorAI migrated proxy presets out of the profile blob into a dedicated REST
 * resource under `/hampter/api-settings`:
 *   GET    /hampter/api-settings                    → full snapshot (proxy_configs, settings)
 *   POST   /hampter/api-settings/proxy-configs       → create a preset (we own `client_id`,
 *                                                       server assigns `id`)
 *   PATCH  /hampter/api-settings                     → partial settings merge
 *                                                      (selected_proxy_config_id, source, generation_settings)
 *   DELETE /hampter/api-settings/proxy-configs/{id}   → remove a preset
 *
 * We snapshot the current selection + generation_settings, inject a self-owned dummy
 * proxy preset, select it, force context_length 0, run the capture, then restore the
 * snapshot and delete the dummy.
 *
 * NOTE on `client_id`: the server permanently burns each client_id — reusing one
 * (even after deleting its preset) returns 409 API_SETTINGS_PROXY_CONFIG_CONFLICT.
 * So we mint a fresh random UUID every run rather than a fixed constant.
 */

const crypto = require('crypto');
const { authedFetch } = require('./autotrigger');

const API_SETTINGS_URL = 'https://janitorai.com/hampter/api-settings';
const PROXY_CONFIGS_URL = `${API_SETTINGS_URL}/proxy-configs`;

/** Random lowercase-alphanumeric string of the given length. */
function randomString(len) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i += 1) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

/**
 * Build the throwaway proxy preset (the POST /proxy-configs body). The name, port
 * (always above 8000), api_key and client_id are all randomised each run: the
 * name/port/key so the preset isn't fingerprintable by a constant string/port,
 * and the client_id because the server rejects a reused one (409). The api_key is
 * also required because the frontend rejects presets with an empty/blank key. No
 * prompt_id — the capture doesn't need a jailbreak preset attached.
 */
function buildDummyPreset() {
  const port = 8001 + Math.floor(Math.random() * 57000); // 8001..65000
  return {
    api_key: `sk-${randomString(48)}`,
    api_url: `http://127.0.0.1:${port}/v1/chat/completions`,
    model: 'gpt-4o',
    name: randomString(12),
    prompt_id: null,
    client_id: crypto.randomUUID(),
  };
}

async function getApiSettings(page) {
  const r = await authedFetch(page, API_SETTINGS_URL);
  if (r.status >= 400) throw new Error(`get api-settings failed: HTTP ${r.status}`);
  try { return JSON.parse(r.body); } catch (e) {
    throw new Error('get api-settings: response was not JSON');
  }
}

/** Partial merge-PATCH of the top-level settings (selected_proxy_config_id, source, generation_settings…). */
async function patchApiSettings(page, patch) {
  const r = await authedFetch(page, API_SETTINGS_URL, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (r.status >= 400) {
    throw new Error(`patch api-settings failed: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  }
  return r.body;
}

async function createProxyConfig(page, preset) {
  const r = await authedFetch(page, PROXY_CONFIGS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(preset),
  });
  if (r.status >= 400) {
    throw new Error(`create proxy-config failed: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  }
  return r.body;
}

async function deleteProxyConfig(page, serverId) {
  const r = await authedFetch(page, `${PROXY_CONFIGS_URL}/${serverId}`, { method: 'DELETE' });
  if (r.status >= 400) throw new Error(`delete proxy-config failed: HTTP ${r.status}`);
  return r.body;
}

/**
 * Switch into "extraction mode": create + select a throwaway proxy preset and
 * force context_length 0. Returns a snapshot to pass to {@link restoreProfile}.
 * @returns {Promise<{selectedProxyConfigId:(string|null), source:(string|null),
 *   generationSettings:(object|null), dummyServerId:string, dummyClientId:string}>}
 */
async function enterExtractionMode(page) {
  const before = await getApiSettings(page);
  const settings = (before && before.settings) || {};
  const originalSelectedId = settings.selected_proxy_config_id || null;
  const originalSource = settings.source || null;
  const originalGen = settings.generation_settings || null;

  // Create the throwaway preset, then re-read to resolve the server-assigned id
  // (the POST body only carries our client_id).
  const dummy = buildDummyPreset();
  await createProxyConfig(page, dummy);
  const after = await getApiSettings(page);
  const created = ((after && after.proxy_configs) || [])
    .find((p) => p && p.client_id === dummy.client_id);
  if (!created || !created.id) throw new Error('dummy proxy preset not found after create');
  const dummyServerId = created.id;

  // Select it as the active proxy. This is the must-have (confirmed schema).
  await patchApiSettings(page, { selected_proxy_config_id: dummyServerId });

  // Best-effort extras, isolated so a rejection can't undo the selection above:
  // ensure proxy mode, and force context_length 0 (so the server doesn't
  // truncate/unwrap the prompt).
  try {
    await patchApiSettings(page, { source: 'proxy' });
  } catch (e) {
    console.warn('[profile] could not force source=proxy:', e.message);
  }
  const prevCtx = originalGen && originalGen.context_length;
  try {
    await patchApiSettings(page, {
      generation_settings: Object.assign({}, originalGen, { context_length: 0 }),
    });
  } catch (e) {
    console.warn('[profile] could not force context_length 0:', e.message);
  }

  console.log(`[profile] extraction mode on (context_length ${prevCtx} -> 0, dummy proxy ${dummyServerId} selected)`);
  return {
    selectedProxyConfigId: originalSelectedId,
    source: originalSource,
    generationSettings: originalGen,
    dummyServerId,
    dummyClientId: dummy.client_id,
  };
}

/** Restore the original selection/source/generation settings and delete the injected dummy. */
async function restoreProfile(page, snapshot) {
  if (!snapshot) return;

  const patch = { selected_proxy_config_id: snapshot.selectedProxyConfigId || null };
  if (snapshot.source) patch.source = snapshot.source;
  if (snapshot.generationSettings) patch.generation_settings = snapshot.generationSettings;
  await patchApiSettings(page, patch)
    .catch((e) => console.warn('[profile] restore settings failed:', e.message));

  if (snapshot.dummyServerId) {
    await deleteProxyConfig(page, snapshot.dummyServerId)
      .catch((e) => console.warn('[profile] dummy delete failed:', e.message));
  }
  console.log('[profile] restored api-settings (selection + generation settings, dummy removed)');
}

module.exports = {
  getApiSettings, enterExtractionMode, restoreProfile, API_SETTINGS_URL,
};
