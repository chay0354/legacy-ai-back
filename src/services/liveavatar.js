/**
 * LiveAvatar — HeyGen's real-time avatar streaming API (separate from the async
 * /v3/videos render used elsewhere). Powers the true live video call: the browser
 * connects to a WebRTC room and the avatar listens, thinks, and speaks back live.
 *
 * Backend only mints a session token (and an optional persona "context"). The
 * frontend SDK (@heygen/liveavatar-web-sdk) takes that token and handles the
 * LiveKit/WebRTC connection itself.
 *
 * Docs: https://docs.liveavatar.com   Auth: X-API-KEY header.
 */

const BASE_URL = 'https://api.liveavatar.com';

// A public stock avatar used for testing until a custom LiveAvatar avatar (the
// creator's own face, created in the LiveAvatar dashboard) is configured.
const DEFAULT_PUBLIC_AVATAR_ID = '65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0'; // "June HR"

function apiKey() {
  const key = process.env.LIVEAVATAR_API_KEY;
  if (!key) throw new Error('LIVEAVATAR_API_KEY not configured');
  return key;
}

export function isConfigured() {
  return Boolean(process.env.LIVEAVATAR_API_KEY);
}

export function defaultAvatarId() {
  return process.env.LIVEAVATAR_AVATAR_ID || DEFAULT_PUBLIC_AVATAR_ID;
}

export function sandboxEnabled() {
  // Sandbox = no credits consumed. Default ON; set LIVEAVATAR_SANDBOX=false to go live.
  return String(process.env.LIVEAVATAR_SANDBOX ?? 'true').toLowerCase() !== 'false';
}

async function laFetch(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'X-API-KEY': apiKey(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.message || text || `LiveAvatar error ${res.status}`;
    throw new Error(`LiveAvatar ${path} failed (${res.status}): ${msg}`);
  }
  return data?.data ?? data;
}

/**
 * Create a persona "context" (knowledge base + system prompt) so the FULL-mode
 * avatar answers as the preserved person. Returns the context_id.
 */
export async function createContext({ name, prompt, openingText }) {
  const data = await laFetch('/v1/contexts', {
    body: {
      name: name.slice(0, 100),
      prompt: prompt.slice(0, 8000),
      opening_text: (openingText || 'Hello. It really is me. Talk to me.').slice(0, 1000),
    },
  });
  const id = data?.id || data?.context_id;
  if (!id) throw new Error('LiveAvatar did not return a context id');
  return id;
}

/**
 * Create a FULL-mode session token. HeyGen handles STT + LLM + TTS + the live
 * avatar video; we supply the avatar, an optional persona context, and voice.
 * Returns { sessionId, sessionToken } — pass sessionToken to the frontend SDK.
 */
export async function createFullSessionToken({ avatarId, voiceId, contextId, language = 'en', isSandbox } = {}) {
  const avatarPersona = { language };
  if (voiceId) avatarPersona.voice_id = voiceId;
  if (contextId) avatarPersona.context_id = contextId;

  const data = await laFetch('/v1/sessions/token', {
    body: {
      mode: 'FULL',
      avatar_id: avatarId || defaultAvatarId(),
      is_sandbox: isSandbox ?? sandboxEnabled(),
      avatar_persona: avatarPersona,
    },
  });

  const sessionToken = data?.session_token;
  const sessionId = data?.session_id;
  if (!sessionToken) throw new Error('LiveAvatar did not return a session token');
  return { sessionId, sessionToken };
}
