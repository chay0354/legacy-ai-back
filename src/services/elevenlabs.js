/**
 * ElevenLabs integration for Legacy AI.
 *
 *  - cloneVoice(): Instant Voice Cloning from one or more recorded samples.
 *  - textToSpeech(): renders speech in the creator's cloned voice.
 *
 * The API key lives only on the server (ELEVENLABS_API_KEY).
 */

import { elevenLabsTtsModel, elevenLabsVoiceSettings } from '../config/voice.js';

const BASE_URL = 'https://api.elevenlabs.io/v1';

/** Cached from GET /v1/user/subscription — null = unknown. */
let instantCloneAvailable = null;
let subscriptionCache = null;
let subscriptionCacheAt = 0;
const SUBSCRIPTION_TTL_MS = 5 * 60 * 1000;

export async function getElevenLabsSubscription(force = false) {
  if (!process.env.ELEVENLABS_API_KEY) return null;
  if (!force && subscriptionCache && Date.now() - subscriptionCacheAt < SUBSCRIPTION_TTL_MS) {
    return subscriptionCache;
  }
  const res = await fetch(`${BASE_URL}/user/subscription`, {
    headers: { 'xi-api-key': apiKey() },
  });
  if (!res.ok) return null;
  subscriptionCache = await res.json();
  subscriptionCacheAt = Date.now();
  instantCloneAvailable = subscriptionCache.can_use_instant_voice_cloning === true;
  return subscriptionCache;
}

export async function isInstantCloneLikelyAvailable() {
  if (!process.env.ELEVENLABS_API_KEY) return false;
  try {
    const sub = await getElevenLabsSubscription();
    if (sub) return sub.can_use_instant_voice_cloning === true;
  } catch {
    /* fall through */
  }
  return instantCloneAvailable !== false;
}

export function markInstantCloneUnavailable(err) {
  const code = err?.code;
  // Only lock the process on a real plan/quota denial — never on sample-quality
  // errors (those messages also mention "instant voice cloning" and used to
  // disable cloning for every later user until the server restarted).
  if (code === 'paid_plan_required' || code === 'can_not_use_instant_voice_cloning') {
    instantCloneAvailable = false;
  }
}

function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not configured');
  return key;
}

/**
 * Instant Voice Cloning. Pass `sample` or `samples` (array of { buffer, filename, contentType }).
 * Returns the created voice_id.
 */
export async function cloneVoice({ name, sample, samples, description }) {
  const form = new FormData();
  form.append('name', name);
  if (description) form.append('description', description);
  // Studio recordings are already in a quiet room. Isolation can make a clean
  // sample worse (ElevenLabs docs) and sometimes fail the clone.
  if (process.env.ELEVENLABS_REMOVE_BACKGROUND_NOISE === 'true') {
    form.append('remove_background_noise', 'true');
  }

  const allSamples = samples?.length ? samples : sample ? [sample] : [];
  if (!allSamples.length) throw new Error('At least one voice sample is required');

  for (const s of allSamples) {
    const blob = new Blob([s.buffer], { type: s.contentType || 'audio/wav' });
    form.append('files', blob, s.filename || 'sample.wav');
  }

  const res = await fetch(`${BASE_URL}/voices/add`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey() },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    let code;
    try { code = JSON.parse(errText)?.detail?.code; } catch { /* non-JSON error */ }
    const e = new Error(`ElevenLabs clone error ${res.status}: ${errText}`);
    e.code = code;
    e.httpStatus = res.status;
    markInstantCloneUnavailable(e);
    throw e;
  }

  const data = await res.json();
  return data.voice_id;
}

/** Render text in a cloned voice. Returns a Buffer of MP3 audio. */
export async function textToSpeech({ voiceId, text, modelId, voiceSettings }) {
  const res = await fetch(`${BASE_URL}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey(),
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId || elevenLabsTtsModel(),
      voice_settings: voiceSettings || elevenLabsVoiceSettings(),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS error ${res.status}: ${err}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

const LIVE_FALLBACK_MODEL = 'eleven_v3_conversational';
let modelLanguages = null;
let modelLanguagesAt = 0;

async function languagesByModel() {
  if (modelLanguages && Date.now() - modelLanguagesAt < SUBSCRIPTION_TTL_MS * 12) return modelLanguages;
  const res = await fetch(`${BASE_URL}/models`, { headers: { 'xi-api-key': apiKey() } });
  if (!res.ok) return modelLanguages || new Map();
  const models = await res.json();
  modelLanguages = new Map(
    (Array.isArray(models) ? models : []).map((m) => [
      m.model_id,
      new Set((m.languages || []).map((l) => l.language_id)),
    ]),
  );
  modelLanguagesAt = Date.now();
  return modelLanguages;
}

/** Fast live model, unless it cannot speak this language (Flash has no Hebrew). */
export async function liveModelFor(languageCode) {
  const preferred = process.env.ELEVENLABS_LIVE_MODEL || 'eleven_flash_v2_5';
  const code = String(languageCode || 'en').toLowerCase();
  try {
    const byModel = await languagesByModel();
    if (byModel.get(preferred)?.has(code)) return { modelId: preferred, languageCode: code };
    if (byModel.get(LIVE_FALLBACK_MODEL)?.has(code)) return { modelId: LIVE_FALLBACK_MODEL, languageCode: code };
  } catch {
    /* fall through to the preferred model without a language hint */
  }
  return { modelId: preferred, languageCode: null };
}

/**
 * Stream speech in the cloned voice as raw 16 kHz mono PCM16 — the format Simli lip-syncs to.
 * Returns the upstream web ReadableStream; abort `signal` to stop billing mid-sentence.
 */
export async function streamSpeechPcm16k({ voiceId, text, languageCode, signal }) {
  const { modelId, languageCode: hint } = await liveModelFor(languageCode);
  const body = {
    text,
    model_id: modelId,
    voice_settings: elevenLabsVoiceSettings(),
  };
  if (hint) body.language_code = hint;

  const res = await fetch(
    `${BASE_URL}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_16000`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey(),
        'content-type': 'application/json',
        accept: 'audio/pcm',
      },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => '');
    throw new Error(`ElevenLabs stream error ${res.status}: ${err}`);
  }
  return res.body;
}

/** Remove a cloned voice (cleanup when re-recording). */
export async function deleteVoice(voiceId) {
  if (!voiceId) return;
  try {
    await fetch(`${BASE_URL}/voices/${voiceId}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': apiKey() },
    });
  } catch {
    /* best-effort cleanup */
  }
}
