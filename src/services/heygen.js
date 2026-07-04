/**
 * HeyGen — Avatar IV image-to-video for the Legacy AI talking avatar.
 *
 * Given the creator's portrait (public URL) and audio (the cloned voice speaking
 * the answer, public URL), HeyGen animates the photo and lip-syncs it to the
 * audio, returning a talking-head MP4.
 *
 * NOTE: HeyGen's real-time Streaming/Interactive Avatar API was sunset
 * (March 2026), so this uses the asynchronous /v3/videos render. The chat keeps
 * conversation smooth by showing the answer text immediately and letting the
 * talking video catch up.
 *
 * Requires HEYGEN_API_KEY. Docs: https://developers.heygen.com/reference/create-video
 */

import { heyGenVoiceSettings } from '../config/voice.js';

const BASE_URL = 'https://api.heygen.com/v3';
const POLL_MS = Number(process.env.HEYGEN_POLL_MS || 5000);
const MAX_WAIT_MS = Number(process.env.HEYGEN_MAX_WAIT_MS || 300000);
const VOICE_POLL_MS = Number(process.env.HEYGEN_VOICE_POLL_MS || 3000);
const VOICE_MAX_WAIT_MS = Number(process.env.HEYGEN_VOICE_MAX_WAIT_MS || 180000);

function apiKey() {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new Error('HEYGEN_API_KEY not configured');
  return key;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Download TTS bytes from HeyGen's CDN (retries — some networks reset on first attempt). */
async function fetchHeyGenAudioFile(audioUrl, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(audioUrl);
      if (!res.ok) throw new Error(`HeyGen speech download error ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

/** Upload raw file bytes to HeyGen; returns asset_id. */
export async function uploadAsset(buffer, { filename = 'file', contentType = 'application/octet-stream' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), filename);

  const res = await fetch(`${BASE_URL}/assets`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey() },
    body: form,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error?.message || text || `HeyGen upload error ${res.status}`;
    throw new Error(`HeyGen asset upload failed: ${msg}`);
  }

  const assetId = data?.data?.asset_id || data?.data?.id || data?.asset_id;
  if (!assetId) throw new Error('HeyGen did not return an asset_id for the uploaded file');
  return assetId;
}

/** Upload MP3 bytes to HeyGen; returns asset_id for lip-sync. */
export async function uploadAudioAsset(audioBuffer) {
  return uploadAsset(audioBuffer, { filename: 'legacy-speech.mp3', contentType: 'audio/mpeg' });
}

/**
 * Start an Avatar IV render that animates an image and lip-syncs it to audio.
 * Prefer audioAssetId (uploaded to HeyGen) over audioUrl.
 * Returns the HeyGen video_id.
 */
export async function startTalkingVideo({ imageUrl, audioUrl, audioAssetId, script, voiceId, voiceSettings }) {
  if (!imageUrl) throw new Error('imageUrl required for HeyGen video');
  if (!audioAssetId && !audioUrl && !script) {
    throw new Error('audioAssetId, audioUrl, or script required for HeyGen video');
  }

  const body = {
    type: 'image',
    image: { type: 'url', url: imageUrl },
    resolution: process.env.HEYGEN_RESOLUTION || '720p',
    aspect_ratio: process.env.HEYGEN_ASPECT_RATIO || 'auto',
    title: 'Legacy AI avatar reply',
  };

  if (audioAssetId) {
    body.audio_asset_id = audioAssetId;
  } else if (audioUrl) {
    body.audio_url = audioUrl;
  } else {
    body.script = script;
    if (voiceId) body.voice_id = voiceId;
    if (voiceSettings) body.voice_settings = voiceSettings;
  }

  const res = await fetch(`${BASE_URL}/videos`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error?.message || text || `HeyGen error ${res.status}`;
    throw new Error(`HeyGen start error ${res.status}: ${msg}`);
  }

  const videoId = data?.data?.video_id || data?.video_id;
  if (!videoId) throw new Error('HeyGen did not return a video_id');
  return videoId;
}

/**
 * Get the current status of a HeyGen render.
 * Returns { status: 'pending'|'processing'|'completed'|'failed', url, error }.
 */
export async function getVideoStatus(videoId) {
  const res = await fetch(`${BASE_URL}/videos/${encodeURIComponent(videoId)}`, {
    headers: { 'x-api-key': apiKey() },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error?.message || text || `HeyGen error ${res.status}`;
    throw new Error(`HeyGen status error ${res.status}: ${msg}`);
  }

  const d = data?.data || data || {};
  const raw = (d.status || '').toLowerCase();
  // Normalize HeyGen statuses (waiting/pending/processing/completed/failed).
  let status = 'processing';
  if (raw === 'completed' || raw === 'success' || raw === 'done') status = 'completed';
  else if (raw === 'failed' || raw === 'error') status = 'failed';
  else if (raw === 'waiting' || raw === 'pending') status = 'pending';

  return {
    status,
    url: d.video_url || d.url || null,
    error: d.error?.message || d.failure_message || d.error || null,
  };
}

/** Poll until the render finishes; returns the MP4 URL. */
export async function waitForVideo(videoId) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const { status, url, error } = await getVideoStatus(videoId);
    if (status === 'completed' && url) return url;
    if (status === 'failed') throw new Error(`HeyGen render failed: ${error || 'unknown error'}`);
    await sleep(POLL_MS);
  }
  throw new Error('HeyGen render timed out');
}

export const AVATAR_GREETING =
  'Hello. It really is me — you can talk to me here, and I will answer the way I always would have.';

/* ----------------------------- photo avatar (face) ----------------------------- */

/**
 * Register the creator's portrait as a HeyGen Photo Avatar (their face in HeyGen).
 * Returns { avatarId, groupId, previewUrl } — avatarId is passed to video renders.
 */
export async function createPhotoAvatar({ name, buffer, contentType = 'image/jpeg', filename = 'portrait.jpg' }) {
  if (!buffer?.length) throw new Error('Portrait image required');
  const assetId = await uploadAsset(buffer, { filename, contentType });

  const res = await fetch(`${BASE_URL}/avatars`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'photo',
      name,
      file: { type: 'asset_id', asset_id: assetId },
    }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error?.message || text || `HeyGen error ${res.status}`;
    throw new Error(`HeyGen photo avatar failed: ${msg}`);
  }

  const item = data?.data?.avatar_item || data?.avatar_item;
  const group = data?.data?.avatar_group || data?.avatar_group;
  const avatarId = item?.id;
  if (!avatarId) throw new Error('HeyGen did not return a photo avatar id');

  return {
    avatarId,
    groupId: group?.id || item?.group_id || null,
    previewUrl: item?.preview_image_url || null,
  };
}

/**
 * Render a talking video using a registered HeyGen Photo Avatar + cloned voice.
 */
export async function startAvatarVideo({ avatarId, script, voiceId, audioAssetId, audioUrl, voiceSettings }) {
  if (!avatarId) throw new Error('avatarId required');
  if (!script && !audioAssetId && !audioUrl) throw new Error('script or audio required');

  const body = {
    type: 'avatar',
    avatar_id: avatarId,
    resolution: process.env.HEYGEN_RESOLUTION || '720p',
    aspect_ratio: process.env.HEYGEN_ASPECT_RATIO || 'auto',
    title: 'Legacy AI avatar reply',
  };

  if (audioAssetId) body.audio_asset_id = audioAssetId;
  else if (audioUrl) body.audio_url = audioUrl;
  else {
    body.script = script;
    if (voiceId) body.voice_id = voiceId;
    if (voiceSettings) body.voice_settings = voiceSettings;
  }

  const res = await fetch(`${BASE_URL}/videos`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error?.message || text || `HeyGen error ${res.status}`;
    throw new Error(`HeyGen avatar video error ${res.status}: ${msg}`);
  }

  const videoId = data?.data?.video_id || data?.video_id;
  if (!videoId) throw new Error('HeyGen did not return a video_id');
  return videoId;
}

/* ----------------------------- voice clone + TTS ----------------------------- */

/**
 * Clone a voice from a recorded sample. HeyGen only accepts WAV/MP3, and the base64
 * path strictly matches the declared media_type against its own content sniff
 * (e.g. audio/wav vs audio/x-wav), so we upload the sample as an asset first and
 * clone by asset_id, which sidesteps the mismatch entirely.
 */
export async function cloneVoiceFromSample({ voiceName, buffer, mimeType = 'audio/wav', filename = 'voice-sample.wav' }) {
  const ext = (filename.split('.').pop() || 'wav').toLowerCase();
  const contentType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  const assetId = await uploadAsset(buffer, { filename: `voice-sample.${ext === 'mp3' ? 'mp3' : 'wav'}`, contentType });

  const res = await fetch(`${BASE_URL}/voices/clone`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      voice_name: voiceName,
      audio: { type: 'asset_id', asset_id: assetId },
      remove_background_noise: true,
    }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error?.message || text || `HeyGen clone error ${res.status}`;
    throw new Error(`HeyGen voice clone failed: ${msg}`);
  }

  const cloneId = data?.data?.voice_clone_id || data?.voice_clone_id;
  if (!cloneId) throw new Error('HeyGen did not return a voice_clone_id');

  return waitForVoiceClone(cloneId);
}

/** Poll GET /v3/voices/{id} until clone status is complete. */
export async function getVoiceCloneStatus(voiceId) {
  const res = await fetch(`${BASE_URL}/voices/${encodeURIComponent(voiceId)}`, {
    headers: { 'x-api-key': apiKey() },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error?.message || text || `HeyGen error ${res.status}`;
    throw new Error(`HeyGen voice status error: ${msg}`);
  }

  const d = data?.data || data || {};
  return {
    status: (d.status || 'processing').toLowerCase(),
    voiceId: d.voice_id || voiceId,
    error: d.failure_message || null,
  };
}

async function waitForVoiceClone(cloneId) {
  const deadline = Date.now() + VOICE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const { status, voiceId, error } = await getVoiceCloneStatus(cloneId);
    if (status === 'complete') return voiceId;
    if (status === 'failed') throw new Error(`HeyGen voice clone failed: ${error || 'unknown error'}`);
    await sleep(VOICE_POLL_MS);
  }
  throw new Error('HeyGen voice clone timed out — try a longer, clearer recording');
}

/**
 * Synthesize speech with a HeyGen cloned voice.
 * Returns { audioUrl, buffer? } — buffer is set when the CDN download succeeds.
 */
export async function generateSpeech({ voiceId, text }) {
  const res = await fetch(`${BASE_URL}/voices/speech`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 5000), voice_id: voiceId }),
  });

  const bodyText = await res.text();
  let data;
  try { data = JSON.parse(bodyText); } catch { data = null; }

  if (!res.ok) {
    const msg = data?.error?.message || bodyText || `HeyGen speech error ${res.status}`;
    throw new Error(`HeyGen speech failed: ${msg}`);
  }

  const audioUrl = data?.data?.audio_url;
  if (!audioUrl) throw new Error('HeyGen speech did not return an audio_url');

  try {
    const buffer = await fetchHeyGenAudioFile(audioUrl);
    return { audioUrl, buffer };
  } catch {
    // CDN blocked from this network — caller can still lip-sync via script+voice_id.
    return { audioUrl, buffer: null };
  }
}
