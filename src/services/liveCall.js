/**
 * Live Call brain + voice plumbing.
 *
 *   Browser mic --WebRTC--> OpenAI Realtime (listens, answers as TEXT only)
 *   answer text --> POST /api/avatar/live/speech --> ElevenLabs cloned voice (PCM 16k)
 *   PCM --> Simli (lip-synced face + the audio the family hears)
 */
import crypto from 'node:crypto';
import { realtimeNumberEnv } from './realtimeInterview.js';

const TICKET_TTL_MS = 2 * 60 * 60 * 1000;

function ticketSecret() {
  const secret = process.env.LIVE_SPEECH_SECRET
    || process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error('Live Call needs LIVE_SPEECH_SECRET (or the Supabase secret key) to sign speech tickets.');
  return crypto.createHash('sha256').update(`live-speech:${secret}`).digest();
}

/** Signed grant that lets this user voice this archive during one call without re-reading the DB. */
export function signSpeechTicket({ userId, creatorId, voiceId, languageCode }) {
  const payload = Buffer.from(JSON.stringify({
    u: userId, c: creatorId, v: voiceId, l: languageCode, e: Date.now() + TICKET_TTL_MS,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', ticketSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySpeechTicket(ticket, userId) {
  const [payload, sig] = String(ticket || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', ticketSecret()).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data?.v || !data?.e || data.e < Date.now()) return null;
  if (userId && data.u !== userId) return null;
  return { userId: data.u, creatorId: data.c, voiceId: data.v, languageCode: data.l };
}

/**
 * Ephemeral OpenAI Realtime token for the call. Text-out only — the voice is the
 * creator's ElevenLabs clone, never an OpenAI stock voice.
 */
export async function createLiveRealtimeSecret({ instructions, languageCode }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Live calls need OPENAI_API_KEY.');

  const noiseReduction = process.env.OPENAI_REALTIME_NOISE_REDUCTION === 'off'
    ? null
    : { type: process.env.OPENAI_REALTIME_NOISE_REDUCTION || 'far_field' };

  const session = {
    type: 'realtime',
    model: process.env.OPENAI_LIVE_MODEL || process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
    instructions,
    output_modalities: ['text'],
    audio: {
      input: {
        turn_detection: {
          type: 'server_vad',
          threshold: realtimeNumberEnv('OPENAI_LIVE_VAD_THRESHOLD', 0.7),
          prefix_padding_ms: 300,
          silence_duration_ms: realtimeNumberEnv('OPENAI_LIVE_SILENCE_MS', 900),
          create_response: true,
          interrupt_response: true,
        },
        ...(noiseReduction ? { noise_reduction: noiseReduction } : {}),
        transcription: {
          model: process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
          language: languageCode,
        },
      },
    },
    max_output_tokens: realtimeNumberEnv('OPENAI_LIVE_MAX_TOKENS', 220),
  };

  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI live session error ${res.status}: ${err}`);
  }
  const data = await res.json();
  if (!data?.value) throw new Error('OpenAI live session response missing token');
  return data.value;
}
