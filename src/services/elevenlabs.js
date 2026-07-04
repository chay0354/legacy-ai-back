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
  form.append('remove_background_noise', 'true');

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
