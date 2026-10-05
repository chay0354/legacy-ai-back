/**
 * Simli — real-time talking face driven by audio we send it.
 *
 *   1. createFace(portrait)      -> faceId   (the creator's own face, generated async)
 *   2. faceStatus(faceId)        -> 'processing' | 'ready' | 'failed'
 *   3. createSessionToken(face)  -> session token for the browser SDK (simli-client)
 *
 * Simli only renders the face. The browser streams the creator's cloned
 * ElevenLabs voice into it, so the voice and the answers stay on our side.
 * Docs: https://docs.simli.com   Auth: x-simli-api-key
 */

const BASE_URL = 'https://api.simli.ai';

function apiKey() {
  const key = process.env.SIMLI_API_KEY;
  if (!key) throw new Error('SIMLI_API_KEY not configured');
  return key;
}

export function isConfigured() {
  return Boolean(process.env.SIMLI_API_KEY);
}

async function parse(res, label) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const detail = data?.detail;
    const msg = (typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : '')
      || data?.message || data?.error || text || `Simli error ${res.status}`;
    const err = new Error(`Simli ${label} failed (${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data ?? {};
}

/** The face endpoints do not publish a response schema; accept the id under any of its known names. */
function pickFaceId(data) {
  const id = data?.face_id || data?.faceId || data?.character_uid || data?.id || data?.uuid
    || data?.data?.face_id || data?.data?.id;
  if (!id) throw new Error(`Simli did not return a face id (${JSON.stringify(data).slice(0, 200)})`);
  return String(id);
}

function portraitForm({ buffer, contentType, filename }) {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
  return form;
}

function faceCreatePath() {
  return process.env.SIMLI_FACE_MODEL === 'trinity' ? '/faces/trinity' : '/faces/legacy';
}

/** Reframe a portrait to the head-and-shoulders framing Trinity expects. Returns PNG bytes. */
export async function preprocessPortrait({ buffer, contentType = 'image/jpeg', filename = 'portrait.jpg' }) {
  const res = await fetch(`${BASE_URL}/faces/trinity/preprocess`, {
    method: 'POST',
    headers: { 'x-simli-api-key': apiKey() },
    body: portraitForm({ buffer, contentType, filename }),
  });
  if (!res.ok) await parse(res, 'preprocess portrait');
  return Buffer.from(await res.arrayBuffer());
}

async function postFace(path, { name, buffer, contentType, filename }) {
  const query = new URLSearchParams({ face_name: String(name || 'legacy').slice(0, 60) });
  const res = await fetch(`${BASE_URL}${path}?${query}`, {
    method: 'POST',
    headers: { 'x-simli-api-key': apiKey(), Accept: 'application/json' },
    body: portraitForm({ buffer, contentType, filename }),
  });
  return parse(res, 'create face');
}

/**
 * Start generating a face from the portrait. Generation is async — poll faceStatus().
 * Default is Simli's legacy face model: Trinity/GS is blocked on free accounts.
 * Set SIMLI_FACE_MODEL=trinity to use the newer model after upgrading.
 */
export async function createFace({ name, buffer, contentType = 'image/jpeg', filename = 'portrait.jpg' }) {
  const preferred = faceCreatePath();
  try {
    return pickFaceId(await postFace(preferred, { name, buffer, contentType, filename }));
  } catch (e) {
    if (preferred === '/faces/trinity' && e.status === 403) {
      return pickFaceId(await postFace('/faces/legacy', { name, buffer, contentType, filename }));
    }
    throw e;
  }
}

const READY = /^(ready|done|complete|completed|success|succeeded|finished|available)$/i;
const FAILED = /^(fail|failed|failure|error|errored|rejected|cancel|cancelled|canceled)$/i;

function readStatus(data) {
  const raw = String(
    (typeof data === 'string' ? data : null)
    ?? data?.status ?? data?.state ?? data?.generation_status ?? data?.data?.status ?? '',
  ).trim();
  if (READY.test(raw)) return { status: 'ready', raw };
  if (FAILED.test(raw)) {
    return { status: 'failed', raw, error: data?.error || data?.detail || data?.message || 'Simli could not build the face' };
  }
  return { status: 'processing', raw };
}

export async function faceStatus(faceId) {
  const query = new URLSearchParams({ face_id: faceId });
  const paths = faceCreatePath() === '/faces/trinity'
    ? ['/faces/trinity/generation_status', '/faces/legacy/generation_status']
    : ['/faces/legacy/generation_status', '/faces/trinity/generation_status'];
  let lastErr;
  for (const path of paths) {
    try {
      const res = await fetch(`${BASE_URL}${path}?${query}`, {
        headers: { 'x-simli-api-key': apiKey(), Accept: 'application/json' },
      });
      const data = await parse(res, 'face status');
      const parsed = readStatus(data);
      if (parsed.raw || parsed.status !== 'processing') return parsed;
      lastErr = { data, parsed };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr?.parsed) return lastErr.parsed;
  if (lastErr instanceof Error) throw lastErr;
  return { status: 'processing', raw: '' };
}

export async function listFaces() {
  const res = await fetch(`${BASE_URL}/faces`, {
    headers: { 'x-simli-api-key': apiKey(), Accept: 'application/json' },
  });
  const data = await parse(res, 'list faces');
  return Array.isArray(data) ? data : (data?.faces || data?.data || []);
}

export async function deleteFace(faceId) {
  if (!faceId) return;
  for (const path of [`/faces/legacy/${encodeURIComponent(faceId)}`, `/faces/trinity/${encodeURIComponent(faceId)}`]) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'DELETE',
      headers: { 'x-simli-api-key': apiKey() },
    });
    if (res.status === 404) continue;
    if (!res.ok) await parse(res, 'delete face');
    return;
  }
}

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Short-lived token the browser uses to open the face stream. Nobody sees the API key. */
export async function createSessionToken({ faceId }) {
  if (!faceId) throw new Error('Live Call requires a Simli face id.');
  const res = await fetch(`${BASE_URL}/compose/token`, {
    method: 'POST',
    headers: {
      'x-simli-api-key': apiKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      faceId,
      handleSilence: true,
      maxSessionLength: numberEnv('SIMLI_MAX_SESSION_SECONDS', 1800),
      maxIdleTime: numberEnv('SIMLI_MAX_IDLE_SECONDS', 180),
    }),
  });
  const data = await parse(res, 'session token');
  const token = data?.session_token;
  if (!token) throw new Error('Simli did not return a session token');
  return token;
}
