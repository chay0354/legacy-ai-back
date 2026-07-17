/**
 * Anam.ai — real-time conversational avatar built from the user's OWN photo and
 * voice, entirely via API (no manual dashboard step).
 *
 *   1. createAvatarFromImageUrl(portrait)  -> avatarId   (the user's face)
 *   2. cloneVoice(voiceSample)             -> voiceId    (the user's voice)
 *   3. createSessionToken(persona)         -> sessionToken for the frontend SDK
 *
 * The browser SDK (@anam-ai/js-sdk) takes the session token and streams the live
 * talking face over WebRTC. Auth: Bearer <ANAM_API_KEY>.
 * Docs: https://anam.ai/docs
 */

const BASE_URL = 'https://api.anam.ai';

function apiKey() {
  const key = process.env.ANAM_API_KEY;
  if (!key) throw new Error('ANAM_API_KEY not configured');
  return key;
}

export function isConfigured() {
  return Boolean(process.env.ANAM_API_KEY);
}

export function defaultLlmId() {
  return process.env.ANAM_LLM_ID || 'ANAM_GPT_4O_MINI_V1';
}

/** Cara 4 is generally available; cara-4-latest needs org early access. */
export function defaultAvatarModel() {
  return process.env.ANAM_AVATAR_MODEL || 'cara-4';
}

/**
 * Browser live calls: prefer adaptive bitrate (`auto`) so the stream can drop
 * quality instead of freezing when the network/CPU can't hold max Cara-4 bitrate.
 * Set ANAM_VIDEO_QUALITY=high only on very strong connections.
 */
export function buildSessionOptions() {
  const model = defaultAvatarModel();
  const qualityRaw = (process.env.ANAM_VIDEO_QUALITY || 'auto').toLowerCase();
  const opts = { videoQuality: qualityRaw === 'high' ? 'high' : 'auto' };

  const w = process.env.ANAM_VIDEO_WIDTH;
  const h = process.env.ANAM_VIDEO_HEIGHT;
  if (w && h) {
    opts.videoWidth = parseInt(w, 10);
    opts.videoHeight = parseInt(h, 10);
  } else if (model.startsWith('cara-4')) {
    // Cara 4 native landscape. With videoQuality=auto, Anam ABR can still adapt bitrate.
    opts.videoWidth = 1152;
    opts.videoHeight = 768;
  } else {
    opts.videoWidth = 720;
    opts.videoHeight = 480;
  }
  return opts;
}

async function parse(res, label) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.message || data?.error || text || `Anam error ${res.status}`;
    const err = new Error(`Anam ${label} failed (${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Create a one-shot avatar from a portrait image URL (the URL must be publicly
 * reachable by Anam for the duration of the call — a signed Supabase URL works).
 * Returns the avatar id. This can take ~60-90s while the face is generated.
 */
/** List avatars on this Anam org (includes stock + custom one-shots). */
export async function listAvatars() {
  const res = await fetch(`${BASE_URL}/v1/avatars`, {
    headers: { Authorization: `Bearer ${apiKey()}`, Accept: 'application/json' },
  });
  const data = await parse(res, 'list avatars');
  return data?.data || [];
}

/** Permanently delete a custom one-shot avatar to free a plan slot. */
export async function deleteAvatar(avatarId) {
  const res = await fetch(`${BASE_URL}/v1/avatars/${avatarId}?hard=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  await parse(res, 'delete avatar');
}

/** Delete a cloned voice on Anam (best-effort; 404 is OK). */
export async function deleteVoice(voiceId) {
  if (!voiceId) return;
  const res = await fetch(`${BASE_URL}/v1/voices/${voiceId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (res.status === 404) return;
  await parse(res, 'delete voice');
}

export async function createAvatarFromImageUrl({ displayName, imageUrl }) {
  const res = await fetch(`${BASE_URL}/v1/avatars`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      displayName: displayName.slice(0, 50),
      imageUrl,
      avatarModel: defaultAvatarModel(),
    }),
  });
  const data = await parse(res, 'create avatar');
  const id = data?.id;
  if (!id) throw new Error('Anam did not return an avatar id');
  return id;
}

/** Clone a voice from an audio sample buffer (multipart). Returns the voice id. */
export async function cloneVoice({ name, buffer, contentType = 'audio/wav', filename = 'voice-sample.wav', language = 'en' }) {
  const form = new FormData();
  form.append('name', name.slice(0, 50));
  form.append('language', language || 'en');
  form.append('audioFile', new Blob([buffer], { type: contentType }), filename);

  const res = await fetch(`${BASE_URL}/v1/voices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  const data = await parse(res, 'create voice');
  const id = data?.id;
  if (!id) throw new Error('Anam did not return a voice id');
  return id;
}

/**
 * Mint a short-lived (1h) session token for an ephemeral persona. The frontend
 * SDK uses it to open the live WebRTC call.
 */
export async function createSessionToken({
  name,
  avatarId,
  voiceId,
  llmId,
  systemPrompt,
  initialMessage,
  languageCode = 'en',
}) {
  if (!avatarId) throw new Error('Live Call requires an Anam avatar id.');
  if (!voiceId) {
    throw new Error('Live Call requires a cloned Anam voice — stock voice fallback is disabled.');
  }

  const personaConfig = {
    name: (name || 'Legacy').slice(0, 50),
    avatarId,
    voiceId,
    avatarModel: defaultAvatarModel(),
    llmId: llmId || defaultLlmId(),
    // Speech recognition language (Anam multilingual docs).
    languageCode: languageCode || 'en',
    systemPrompt: (systemPrompt || 'You are a warm, present person speaking with family.').slice(0, 12000),
  };
  if (initialMessage) personaConfig.initialMessage = initialMessage.slice(0, 1000);

  const res = await fetch(`${BASE_URL}/v1/auth/session-token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ personaConfig, sessionOptions: buildSessionOptions() }),
  });
  const data = await parse(res, 'session token');
  const token = data?.sessionToken;
  if (!token) throw new Error('Anam did not return a session token');
  return token;
}
