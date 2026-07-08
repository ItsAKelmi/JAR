'use strict';

/**
 * Saucepan (saucepan.ai) native extraction.
 *
 * Unlike the JanitorAI path, Saucepan needs no browser: its companion
 * definition is available directly from the authenticated REST API. The catch
 * is that definitions ship as a SHUFFLED list of text fragments padded with
 * decoy fragments — a naive join is garbled. Each real fragment carries a
 * `proof` hash that the decoys fail; reassembly validates the proof, orders the
 * survivors by `key ^ mask`, and concatenates. Ported from Saucepan's own web
 * client so the output matches byte-for-byte.
 *
 * Data comes from two endpoints:
 *   GET /api/v1/companion/definition?companion_id=ID  -> named prose sections
 *       (Companion Core, Example Dialogue, Advanced Prompt, Response Formatting)
 *   GET /api/v2/companions/ID                          -> metadata + the body
 *       fragments + starting scenarios (the greetings; absent from definition)
 */

const zlib = require('node:zlib');

const SAUCEPAN_BASE = 'https://saucepan.ai';
const SAUCEPAN_ORIGIN = 'https://saucepan.ai';
const SAUCEPAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

// ---- persisted bearer token (set from settings on boot / via the login route) ----
let token = '';
function setToken(t) { token = String(t || '').trim(); }
function getToken() { return token; }
function hasToken() { return !!token; }

function headers(withAuth) {
  const h = {
    'User-Agent': SAUCEPAN_UA,
    Accept: '*/*',
    // Negotiate gzip/deflate/br so undici auto-decompresses; the zstd fallback
    // below covers a server that ignores this and answers zstd anyway.
    'Accept-Encoding': 'gzip, deflate, br',
    Origin: SAUCEPAN_ORIGIN,
    Referer: `${SAUCEPAN_ORIGIN}/`,
    'x-saucepan-client-version': '1',
  };
  if (withAuth && token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function readBody(response) {
  const ce = (response.headers.get('content-encoding') || '').toLowerCase();
  if (ce.includes('zstd')) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('server returned zstd but this Node lacks zlib.zstdDecompress (needs Node >= 22.15)');
    }
    return zlib.zstdDecompressSync(buf).toString('utf8');
  }
  return response.text();
}

// ---- fragment reassembly (verbatim port of Saucepan's client scheme) ----
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function rotl(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function fragmentHash(mask, derivedKey, text) {
  const bytes = new TextEncoder().encode(text);
  let h = (FNV_OFFSET ^ rotl(mask, 7) ^ rotl(derivedKey, 13)) >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * Reassemble a `{ fragments, mask }` content object into prose, dropping decoys.
 * @param {{fragments?: Array<{key:number, proof:number, text:string}>, mask?:number}} content
 * @returns {string}
 */
function assembleFragments(content) {
  const fragments = Array.isArray(content && content.fragments) ? content.fragments : [];
  const mask = ((content && content.mask) || 0) >>> 0;
  return fragments
    .filter((f) => {
      if (!f || typeof f.text !== 'string') return false;
      const derivedKey = (f.key ^ mask) >>> 0;
      return fragmentHash(mask, derivedKey, f.text) === (f.proof >>> 0);
    })
    .sort((a, b) => ((a.key ^ mask) >>> 0) - ((b.key ^ mask) >>> 0))
    .map((f) => f.text)
    .join('');
}

// ---- API helpers ----
async function fetchJson(path, withAuth) {
  const response = await fetch(`${SAUCEPAN_BASE}${path}`, { method: 'GET', headers: headers(withAuth) });
  let data = null;
  try { data = JSON.parse(await readBody(response)); } catch (_) { /* leave null */ }
  return { ok: response.ok, status: response.status, data };
}

/** Extract the companion UUID from a saucepan.ai/companion/<id> URL. */
function parseCompanionId(url) {
  const m = String(url || '').match(/saucepan\.ai\/companion\/([a-f0-9-]{8,64})/i);
  return m ? m[1] : null;
}

/**
 * Log in with handle + password. Returns the bearer token (and stores it).
 * @throws on bad credentials / network error
 */
async function login(handle, password) {
  const response = await fetch(`${SAUCEPAN_BASE}/api/v1/auth/sign_in_password`, {
    method: 'POST',
    headers: { ...headers(false), 'Content-Type': 'application/json', Referer: `${SAUCEPAN_ORIGIN}/sign-in` },
    body: JSON.stringify({ handle: String(handle || '').trim(), password: String(password || '') }),
  });
  let data = {};
  try { data = JSON.parse(await readBody(response)); } catch (_) { /* non-JSON */ }
  if (!response.ok) {
    throw new Error((data && data.error && data.error.message) || `Saucepan HTTP ${response.status}`);
  }
  const t = data && (data.token || data.access_token || data.session_token || data.sessionToken);
  if (!t) throw new Error('login succeeded but no token was returned');
  setToken(t);
  return t;
}

/** Download the companion's avatar and return it as a data: URI (or '' on failure). */
async function fetchAvatar(imageId) {
  if (!imageId) return '';
  try {
    const response = await fetch(`${SAUCEPAN_BASE}/cdn/${encodeURIComponent(imageId)}/card`, {
      method: 'GET',
      headers: { 'User-Agent': SAUCEPAN_UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', Referer: `${SAUCEPAN_ORIGIN}/` },
    });
    if (!response.ok) return '';
    const len = parseInt(response.headers.get('content-length'), 10);
    if (len > MAX_IMAGE_BYTES) return '';
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return '';
    const type = response.headers.get('content-type') || 'image/jpeg';
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (_) {
    return '';
  }
}

/**
 * Fetch a Saucepan companion by URL and build a JAR character object.
 * Requires a stored bearer token (definition + scenarios are auth-gated).
 * @param {string} url  saucepan.ai/companion/<id>
 * @returns {Promise<{companionId:string, character:object}>}
 */
async function extractCompanion(url) {
  if (!hasToken()) {
    throw Object.assign(new Error('no Saucepan token configured — log in first'), { status: 401 });
  }
  const companionId = parseCompanionId(url);
  if (!companionId) {
    throw Object.assign(new Error('not a Saucepan companion URL'), { status: 400 });
  }

  const [defRes, compRes] = await Promise.all([
    fetchJson(`/api/v1/companion/definition?companion_id=${encodeURIComponent(companionId)}`, true),
    fetchJson(`/api/v2/companions/${encodeURIComponent(companionId)}`, true),
  ]);

  if (!defRes.ok) {
    const msg = (defRes.data && defRes.data.error && defRes.data.error.message) || `Saucepan HTTP ${defRes.status}`;
    throw Object.assign(new Error(msg), { status: defRes.status === 401 ? 401 : 502 });
  }

  // Named prose sections from the definition endpoint.
  const sections = {};
  for (const s of (defRes.data && Array.isArray(defRes.data.sections) ? defRes.data.sections : [])) {
    if (s && s.title && s.content) sections[s.title] = assembleFragments(s.content);
  }

  const companion = (compRes.data && compRes.data.companion) || null;
  if (!compRes.ok || !companion) {
    console.warn(`[saucepan] greetings/metadata unavailable (companions/${companionId} HTTP ${compRes.status})`);
  }

  // Body: prefer the definition's "Companion Core", fall back to the v2 body.
  let description = sections['Companion Core'] || '';
  if (!description && companion && companion.full_description_fragments) {
    description = assembleFragments(companion.full_description_fragments);
  }

  // Greetings live only on the v2 companion as starting scenarios.
  const greetings = [];
  for (const sc of (companion && Array.isArray(companion.starting_scenarios_fragments) ? companion.starting_scenarios_fragments : [])) {
    const text = assembleFragments(sc && sc.message);
    if (text && text.trim()) greetings.push(text);
  }

  // Advanced Prompt / Response Formatting have no dedicated V2 field here; keep
  // them (labeled) in creator notes so nothing authored is silently dropped.
  const notesParts = [];
  const shortDesc = (companion && companion.short_description) ? String(companion.short_description).trim() : '';
  if (shortDesc) notesParts.push(shortDesc);
  if (sections['Advanced Prompt']) notesParts.push(`--- Advanced Prompt ---\n${sections['Advanced Prompt']}`);
  if (sections['Response Formatting Instructions']) notesParts.push(`--- Response Formatting ---\n${sections['Response Formatting Instructions']}`);

  const imageId = companion && companion.image && companion.image.id;
  const avatarBase64 = await fetchAvatar(imageId);

  const character = {
    name: (companion && (companion.display_name || companion.name)) || 'Unknown',
    avatarBase64,
    description,
    personality: '',
    scenario: '',
    firstMessage: greetings[0] || '',
    alternateGreetings: greetings.slice(1),
    exampleMessages: sections['Example Dialogue'] || '',
    creatorNotes: notesParts.join('\n\n'),
    tags: (companion && Array.isArray(companion.tags)) ? companion.tags : [],
    definitionSource: 'saucepan',
  };

  return { companionId, character };
}

module.exports = {
  setToken, getToken, hasToken, login, extractCompanion, parseCompanionId,
  assembleFragments, // exported for tests
};
