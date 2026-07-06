/**
 * Wipe all Legacy AI users, storage, and external avatar/voice clones.
 * Usage: node scripts/wipe-all.js
 */
import 'dotenv/config';
import { deleteAvatar as anamDeleteAvatar } from '../src/services/anam.js';
import { deleteVoice as elevenLabsDeleteVoice } from '../src/services/elevenlabs.js';

const HEYGEN_BASE = 'https://api.heygen.com/v3';
const ANAM_BASE = 'https://api.anam.ai/v1';

async function heygenDelete(path) {
  if (!process.env.HEYGEN_API_KEY) return;
  const res = await fetch(`${HEYGEN_BASE}${path}`, {
    method: 'DELETE',
    headers: { 'x-api-key': process.env.HEYGEN_API_KEY },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    console.warn(`HeyGen DELETE ${path}: ${res.status} ${text.slice(0, 200)}`);
  } else {
    console.log(`HeyGen deleted ${path}`);
  }
}

async function anamDeleteVoice(voiceId) {
  if (!process.env.ANAM_API_KEY || !voiceId) return;
  const res = await fetch(`${ANAM_BASE}/voices/${voiceId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${process.env.ANAM_API_KEY}` },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    console.warn(`Anam voice delete ${voiceId}: ${res.status} ${text.slice(0, 200)}`);
  } else {
    console.log(`Anam voice deleted ${voiceId}`);
  }
}

/** Asset rows from DB — populated before wipe via Supabase MCP or query. */
const ASSETS = [
  {
    voice_id: 'fa28e5e781794d2397847c84ee644c0c',
    voice_provider: 'heygen',
    metadata: {
      elevenlabs_voice_id: null,
      anam_avatar_id: '2f68a654-8bd2-456c-9ff4-5d8c0badc7cf',
      anam_voice_id: '01178809-9e9e-425b-87df-dfe64f22c921',
      heygen_photo_avatar_id: 'ab4adb4e879544b7bd0b9a8393e00486',
    },
  },
];

async function wipeExternalAvatars() {
  for (const row of ASSETS) {
    const md = row.metadata || {};
    const elId = md.elevenlabs_voice_id || (row.voice_provider === 'elevenlabs' ? row.voice_id : null);
    const heygenVoiceId = row.voice_provider === 'heygen' ? row.voice_id : md.heygen_voice_id;

    if (elId && process.env.ELEVENLABS_API_KEY) {
      try {
        await elevenLabsDeleteVoice(elId);
        console.log(`ElevenLabs voice deleted ${elId}`);
      } catch (e) {
        console.warn(`ElevenLabs: ${e.message}`);
      }
    }

    if (heygenVoiceId) await heygenDelete(`/voices/${encodeURIComponent(heygenVoiceId)}`);
    if (md.heygen_photo_avatar_id) await heygenDelete(`/photo_avatar/${md.heygen_photo_avatar_id}`);

    if (md.anam_avatar_id && process.env.ANAM_API_KEY) {
      try {
        await anamDeleteAvatar(md.anam_avatar_id);
        console.log(`Anam avatar deleted ${md.anam_avatar_id}`);
      } catch (e) {
        console.warn(`Anam avatar: ${e.message}`);
      }
    }

    if (md.anam_voice_id) await anamDeleteVoice(md.anam_voice_id);
  }
}

await wipeExternalAvatars();
console.log('External avatar/voice cleanup finished (best-effort).');
