import { Router } from 'express';
import { Readable } from 'node:stream';
import { cloneVoice as elevenLabsClone, textToSpeech as elevenLabsTts, deleteVoice as elevenLabsDeleteVoice, isInstantCloneLikelyAvailable, markInstantCloneUnavailable, streamSpeechPcm16k } from '../services/elevenlabs.js';
import { AVATAR_GREETING, VOICE_TEST_PHRASE } from '../config/voice.js';
import { callClaude } from '../services/anthropic.js';
import {
  isConfigured as simliConfigured,
  preprocessPortrait as simliPreprocessPortrait,
  createFace as simliCreateFace,
  faceStatus as simliFaceStatus,
  deleteFace as simliDeleteFace,
  createSessionToken as simliCreateSessionToken,
} from '../services/simli.js';
import { createLiveRealtimeSecret, signSpeechTicket, verifySpeechTicket } from '../services/liveCall.js';
import { makeAccessStore } from '../db/accessRepo.js';
import { normalizeLiveLanguage } from '../liveLanguages.js';
import {
  formatIdentityPromptBlock,
  loadCreatorIdentity,
  saveCreatorIdentity,
} from '../services/genderProfile.js';
import { assertVoiceSampleLongEnough } from '../services/audioDuration.js';
import { unwrapPortraitIfPadded, PORTRAIT_LAYOUT_FULLBLEED } from '../services/portraitFix.js';
import { assertArchivePaid, assertCanViewArchive, assertOwnerHasMinutes, assertUserPaid } from '../services/stripeBilling.js';
import { toPaymentError } from './billing.js';

const router = Router();
const BUCKET = 'legacy-media';

function sendAvatarError(res, e, fallback = 500) {
  if (e?.status === 402) return toPaymentError(res, e);
  return res.status(e?.status || fallback).json({ error: e.message });
}

function resolveLiveLanguage(assets, override) {
  return normalizeLiveLanguage(override ?? assets?.metadata?.live_language ?? assets?.metadata?.anam_language);
}

/** Resolve the creator owned by the signed-in user (the avatar's subject). */
async function getOwnedCreator(req) {
  const { data, error } = await req.supabase
    .from('legacy_creators')
    .select('id, display_name')
    .eq('user_id', req.user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function getAssets(req, creatorId) {
  const { data, error } = await req.supabase
    .from('legacy_avatar_assets')
    .select('*')
    .eq('creator_id', creatorId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Load avatar assets for the signed-in viewer (owner via RLS, family via admin after membership check). */
async function getAssetsForViewer(req, creatorId) {
  const owned = await getOwnedCreator(req);
  if (owned?.id === creatorId) return getAssets(req, creatorId);

  const store = makeAccessStore({ supabase: req.supabase, admin: req.admin });
  const membership = await store.getMembership(creatorId, req.user.id);
  if (!membership) {
    throw Object.assign(new Error('You do not have access to this legacy'), { status: 403 });
  }

  const { data, error } = await (req.admin || req.supabase)
    .from('legacy_avatar_assets')
    .select('*')
    .eq('creator_id', creatorId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function signed(req, path) {
  if (!path) return null;
  const { data, error } = await req.supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  if (error) return null;
  return data.signedUrl;
}

/** Signed URL for a creator's media — uses admin storage for family/admin viewers. */
async function viewerCanAccessCreator(req, creatorId) {
  const owned = await getOwnedCreator(req);
  if (owned?.id === creatorId) return true;
  const store = makeAccessStore({ supabase: req.supabase, admin: req.admin });
  const membership = await store.getMembership(creatorId, req.user.id);
  return Boolean(membership);
}

async function signedForCreator(req, creatorId, path) {
  if (!path || !creatorId) return null;
  const owned = await getOwnedCreator(req);
  let client = req.supabase;
  if (owned?.id !== creatorId) {
    if (!(await viewerCanAccessCreator(req, creatorId))) return null;
    client = req.admin || req.supabase;
  }
  if (!client) return null;
  const { data, error } = await client.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  if (error && req.admin && client !== req.admin) {
    const retry = await req.admin.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
    if (!retry.error) return retry.data.signedUrl;
  }
  if (error) {
    console.warn('[avatar] signed URL failed:', path, error.message);
    return null;
  }
  return data.signedUrl;
}

async function upsertAssets(req, creatorId, patch) {
  const { data, error } = await req.supabase
    .from('legacy_avatar_assets')
    .upsert({ creator_id: creatorId, updated_at: new Date().toISOString(), ...patch }, { onConflict: 'creator_id' })
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** True when voice is cloned and ready for avatar video. */
function voiceReady(assets) {
  return Boolean(
    assets?.voice_id
    && assets.voice_status === 'ready'
    && assets.metadata?.cloned === true,
  );
}

/** True when portrait + cloned voice are ready (studio complete, live call can be provisioned). */
function avatarReady(assets) {
  return Boolean(assets?.portrait_path && voiceReady(assets));
}

/** True when the Simli face for the CURRENT portrait has finished generating. */
function simliFaceReady(assets) {
  const meta = assets?.metadata || {};
  return Boolean(
    meta.simli_face_id
    && meta.simli_status === 'ready'
    && assets?.portrait_path
    && meta.simli_face_portrait_path === assets.portrait_path,
  );
}

/** Live Call needs the creator's own face AND their own cloned voice. Never a stock voice. */
function liveReady(assets) {
  return Boolean(simliFaceReady(assets) && resolveElevenLabsVoiceId(assets) && voiceReady(assets));
}

function simliFaceName(creator) {
  return `${creator.display_name || 'Legacy'} ${creator.id.slice(0, 6)}`.slice(0, 50);
}

const SIMLI_POLL_MS = 5000;
const SIMLI_WAIT_MS = Number(process.env.SIMLI_PROVISION_WAIT_MS) || 270_000;
const SIMLI_STALE_MS = 20 * 60 * 1000;

/** Ask Simli how a generating face is doing and save the answer. Cheap; safe to call on every load. */
async function refreshSimliStatus(req, creatorId, assets) {
  const meta = assets?.metadata || {};
  if (!simliConfigured() || !meta.simli_face_id || meta.simli_status !== 'processing') return assets;
  if (meta.simli_face_portrait_path !== assets.portrait_path) return assets;
  let result;
  try {
    result = await simliFaceStatus(meta.simli_face_id);
  } catch (e) {
    console.warn('[avatar/simli] status check failed:', e.message);
    return assets;
  }
  if (result.status === 'processing') {
    const startedAt = Date.parse(meta.simli_started_at || '') || 0;
    if (!startedAt || Date.now() - startedAt < SIMLI_STALE_MS) return assets;
    result = { status: 'failed', error: 'Creating the live face took too long. Try again.' };
  }
  const next = {
    ...meta,
    simli_status: result.status,
    simli_phase: result.status === 'ready' ? 'live_face' : meta.simli_phase,
    simli_error: result.status === 'failed' ? String(result.error || 'Simli could not build the face') : null,
    ...(result.status === 'ready' ? { simli_ready_at: new Date().toISOString() } : {}),
  };
  const client = req.admin || req.supabase;
  const { data, error } = await client
    .from('legacy_avatar_assets')
    .update({ metadata: next, updated_at: new Date().toISOString() })
    .eq('creator_id', creatorId)
    .select()
    .maybeSingle();
  if (error) {
    console.warn('[avatar/simli] status save failed:', error.message);
    return { ...assets, metadata: next };
  }
  return data || { ...assets, metadata: next };
}

async function readPortraitForFace(req, assets) {
  const portraitKey = assets.portrait_path;
  const { data: file, error } = await req.supabase.storage.from(BUCKET).download(portraitKey);
  if (error || !file) throw new Error(`Could not read the portrait photo: ${error?.message || 'not found'}`);
  let buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) throw new Error('Could not read the portrait photo.');
  try {
    const force = assets.metadata?.portrait_layout !== PORTRAIT_LAYOUT_FULLBLEED;
    const unwrapped = await unwrapPortraitIfPadded(buffer, { force });
    if (unwrapped.changed) buffer = unwrapped.buffer;
  } catch (e) {
    console.warn('[avatar/provision] portrait unwrap skipped:', e.message);
  }
  const ext = (portraitKey.split('.').pop() || 'jpg').toLowerCase();
  const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const filename = `portrait.${ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpg'}`;

  // Simli frames the head itself for best lip-sync; fall back to our photo if that step fails.
  // Trinity-only framing. The current Simli plan uses the legacy face model.
  if (process.env.SIMLI_FACE_MODEL === 'trinity' && process.env.SIMLI_PREPROCESS !== 'off') {
    try {
      const framed = await simliPreprocessPortrait({ buffer, contentType, filename });
      if (framed?.length) return { buffer: framed, contentType: 'image/png', filename: 'portrait.png' };
    } catch (e) {
      console.warn('[avatar/simli] preprocess skipped:', e.message);
    }
  }
  return { buffer, contentType, filename };
}

/**
 * Build the creator's live face on Simli from their OWN portrait. The voice is the
 * ElevenLabs clone made in the Voice step, so nothing else is cloned here.
 * Idempotent — keeps the existing face while the portrait is unchanged.
 * With `wait`, polls until the face is ready (or the wait runs out; it keeps generating).
 */
async function provisionSimli(req, creator, { wait = false } = {}) {
  if (!simliConfigured()) throw new Error('Live calls require SIMLI_API_KEY.');

  let assets = await getAssets(req, creator.id);
  if (!assets?.portrait_path) throw new Error('Add a portrait photo in the Avatar Studio first.');
  if (!voiceReady(assets) || !resolveElevenLabsVoiceId(assets)) {
    throw new Error('Record and clone your voice in the Avatar Studio first.');
  }

  const meta = assets.metadata || {};
  const portraitKey = assets.portrait_path;
  const sameFace = meta.simli_face_id && meta.simli_face_portrait_path === portraitKey;

  if (!(sameFace && (meta.simli_status === 'ready' || meta.simli_status === 'processing'))) {
    try {
      await upsertAssets(req, creator.id, {
        metadata: { ...meta, simli_status: 'processing', simli_phase: 'photo', simli_error: null },
      });
      if (meta.simli_face_id && !sameFace) {
        simliDeleteFace(meta.simli_face_id).catch((e) =>
          console.warn('[avatar/simli] old face delete failed:', e.message),
        );
      }
      const portrait = await readPortraitForFace(req, assets);
      const faceId = await simliCreateFace({ name: simliFaceName(creator), ...portrait });
      assets = await upsertAssets(req, creator.id, {
        metadata: {
          ...meta,
          simli_face_id: faceId,
          simli_face_portrait_path: portraitKey,
          simli_status: 'processing',
          simli_phase: 'live_face',
          simli_error: null,
          simli_started_at: new Date().toISOString(),
          simli_ready_at: null,
        },
      });
    } catch (e) {
      console.error('[avatar/provisionSimli] failed:', e);
      await upsertAssets(req, creator.id, {
        metadata: { ...meta, simli_status: 'failed', simli_error: e.message },
      });
      throw e;
    }
  }

  const deadline = Date.now() + (wait ? SIMLI_WAIT_MS : 0);
  assets = await refreshSimliStatus(req, creator.id, assets);
  while (wait && assets?.metadata?.simli_status === 'processing' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SIMLI_POLL_MS));
    assets = await refreshSimliStatus(req, creator.id, assets);
  }
  if (assets?.metadata?.simli_status === 'failed') {
    throw new Error(assets.metadata.simli_error || 'Could not create your live face.');
  }
  return assets;
}

function liveStatus(assets) {
  if (liveReady(assets)) return 'ready';
  return assets?.metadata?.simli_status || 'none';
}

function buildProvisionResponse(assets, extra = {}) {
  return {
    success: true,
    status: liveStatus(assets),
    avatarReady: avatarReady(assets),
    liveReady: liveReady(assets),
    assets,
    ...extra,
  };
}

function clearedSimliMetadata(meta = {}) {
  return {
    ...meta,
    simli_status: 'none',
    simli_phase: null,
    simli_error: null,
    simli_face_id: null,
    simli_face_portrait_path: null,
    simli_started_at: null,
    simli_ready_at: null,
  };
}

/** Build the live face after the HTTP response (Vercel waitUntil); the client polls GET /assets. */
async function runBackgroundProvision(req, creator) {
  const ctx = { supabase: req.supabase, admin: req.admin, user: req.user };
  try {
    if (simliConfigured()) {
      await provisionSimli(ctx, creator, { wait: true });
    }
  } catch (e) {
    console.error('[avatar/provision/bg] failed:', e);
  }
}

/* GET /api/avatar/portrait?creatorId= — stream portrait image for any viewer with access. */
router.get('/portrait', async (req, res) => {
  try {
    const creatorId = (req.query.creatorId || '').trim();
    if (!creatorId) return res.status(400).json({ error: 'creatorId required' });

    const assets = await getAssetsForViewer(req, creatorId);
    const path = assets?.portrait_path;
    if (!path) return res.status(404).json({ error: 'No portrait uploaded yet' });

    const owned = await getOwnedCreator(req);
    const storageClient = owned?.id === creatorId ? req.supabase : (req.admin || req.supabase);
    if (!storageClient) return res.status(503).json({ error: 'Storage unavailable' });

    let file = null;
    let dlError = null;
    ({ data: file, error: dlError } = await storageClient.storage.from(BUCKET).download(path));
    if ((dlError || !file) && req.admin && storageClient !== req.admin) {
      ({ data: file, error: dlError } = await req.admin.storage.from(BUCKET).download(path));
    }
    if (dlError || !file) {
      return res.status(404).json({ error: 'Could not load portrait' });
    }

    let bytes = Buffer.from(await file.arrayBuffer());
    try {
      const force = assets?.metadata?.portrait_layout !== PORTRAIT_LAYOUT_FULLBLEED;
      const unwrapped = await unwrapPortraitIfPadded(bytes, { force });
      if (unwrapped.changed) bytes = unwrapped.buffer;
    } catch (e) {
      console.warn('[avatar/portrait] unwrap skipped:', e.message);
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(bytes);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

/* GET /api/avatar/assets — asset record + signed URLs for media.
   ?creatorId= loads a legacy the viewer can access (defaults to the viewer's own legacy).
   ?light=1 skips signed URLs (faster for home screens that only need liveReady). */
router.get('/assets', async (req, res) => {
  try {
    const light = req.query.light === '1' || req.query.light === 'true';
    const requestedId = (req.query.creatorId || '').trim();

    let creatorId;
    if (requestedId) {
      creatorId = requestedId;
    } else {
      const creator = await getOwnedCreator(req);
      if (!creator) return res.json({ creatorId: null, assets: null });
      creatorId = creator.id;
    }

    let assets = await getAssetsForViewer(req, creatorId);
    assets = await refreshSimliStatus(req, creatorId, assets);
    const identity = await loadCreatorIdentity(req.supabase, creatorId);
    let urls = {};
    if (assets && !light) {
      urls = {
        portrait: await signedForCreator(req, creatorId, assets.portrait_path),
        idle: await signedForCreator(req, creatorId, assets.idle_video_path),
        speaking: await signedForCreator(req, creatorId, assets.speaking_video_path),
        voiceSample: await signedForCreator(req, creatorId, assets.voice_sample_path),
      };
    }
    res.json({
      creatorId,
      displayName: identity.displayName || null,
      gender: identity.gender,
      pronouns: identity.pronouns,
      assets: assets || null,
      voiceCloned: assets?.metadata?.cloned === true,
      avatarReady: avatarReady(assets),
      liveReady: liveReady(assets),
      liveStatus: liveStatus(assets),
      hasPortrait: Boolean(assets?.portrait_path),
      previewUrl: urls.portrait || null,
      urls,
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

/** POST /api/avatar/identity — save name and/or explicit gender/pronouns (never inferred from name). */
router.post('/identity', async (req, res) => {
  try {
    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No creator profile yet' });
    const { gender, pronouns, displayName } = req.body || {};

    let name = creator.display_name || null;
    if (typeof displayName === 'string') {
      const trimmed = displayName.trim().slice(0, 80);
      if (!trimmed) return res.status(400).json({ error: 'Enter a name for your archive.' });
      const { error } = await req.supabase
        .from('legacy_creators')
        .update({ display_name: trimmed, updated_at: new Date().toISOString() })
        .eq('id', creator.id);
      if (error) throw new Error(error.message);
      name = trimmed;
    }

    let saved = { gender: null, pronouns: null };
    if (gender !== undefined || pronouns !== undefined) {
      saved = await saveCreatorIdentity(req.supabase, creator.id, { gender, pronouns });
    } else {
      const identity = await loadCreatorIdentity(req.supabase, creator.id);
      saved = { gender: identity.gender, pronouns: identity.pronouns };
    }

    res.json({
      success: true,
      gender: saved.gender,
      pronouns: saved.pronouns,
      displayName: name,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function hasClonedVoice(assets) {
  if (!assets || assets.voice_status !== 'ready') return false;
  return Boolean(assets.voice_id || resolveElevenLabsVoiceId(assets));
}

function resolveElevenLabsVoiceId(assets) {
  if (!assets) return null;
  if (assets.voice_provider === 'elevenlabs' && assets.voice_id) return assets.voice_id;
  return assets.metadata?.elevenlabs_voice_id || null;
}

/** Use only the recording the creator just submitted. Older takes mix poorly. */
function voiceSampleForClone(primaryPath, primaryBuffer, primaryFile) {
  return [{
    buffer: primaryBuffer,
    filename: primaryPath.split('/').pop() || 'voice-sample.wav',
    contentType: primaryFile.type || 'audio/wav',
  }];
}

async function cloneCreatorVoice({ req, creator, voiceSamplePath, buffer, file }) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('Voice cloning requires ELEVENLABS_API_KEY.');
  }

  const voiceName = `Legacy — ${creator.display_name || 'Creator'} (${creator.id.slice(0, 8)})`;
  const samples = voiceSampleForClone(voiceSamplePath, buffer, file);

  if (!await isInstantCloneLikelyAvailable()) {
    throw new Error('ElevenLabs instant voice cloning is not available on this plan.');
  }

  try {
    const elVoiceId = await elevenLabsClone({
      name: voiceName,
      samples,
      description: 'Legacy AI creator voice clone',
    });
    return {
      voiceId: elVoiceId,
      provider: 'elevenlabs',
      elevenlabsVoiceId: elVoiceId,
    };
  } catch (e) {
    markInstantCloneUnavailable(e);
    throw new Error(`Voice cloning failed: ${e.message}`);
  }
}

async function synthesizeSpeech(assets, text) {
  const elVoiceId = resolveElevenLabsVoiceId(assets);
  if (!elVoiceId || !process.env.ELEVENLABS_API_KEY) {
    throw new Error('No cloned voice available for this legacy.');
  }

  const buffer = await elevenLabsTts({ voiceId: elVoiceId, text });
  return { buffer, provider: 'elevenlabs', voiceId: elVoiceId, text };
}

/* POST /api/avatar/voice-sample { voiceSamplePath } — save a voice recording for playback on the avatar page (no cloning). */
router.post('/voice-sample', async (req, res) => {
  try {
    const { voiceSamplePath } = req.body || {};
    if (!voiceSamplePath?.trim()) return res.status(400).json({ error: 'voiceSamplePath required' });

    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy found for this user' });
    await assertUserPaid(req);

    const path = voiceSamplePath.trim();
    const { data: sampleFile, error: sampleErr } = await req.supabase.storage.from(BUCKET).download(path);
    if (sampleErr || !sampleFile) {
      return res.status(400).json({ error: `Could not read voice sample: ${sampleErr?.message || 'not found'}` });
    }
    try {
      assertVoiceSampleLongEnough(Buffer.from(await sampleFile.arrayBuffer()));
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    const saved = await upsertAssets(req, creator.id, {
      voice_sample_path: path,
      voice_status: 'ready',
    });

    res.json({
      success: true,
      assets: saved,
      voiceSampleUrl: await signed(req, saved.voice_sample_path),
    });
  } catch (e) {
    sendAvatarError(res, e);
  }
});

/* POST /api/avatar/voice { voiceSamplePath, language? } — clone via ElevenLabs; store the Live Call language. */
router.post('/voice', async (req, res) => {
  try {
    const { voiceSamplePath, language } = req.body || {};
    if (!voiceSamplePath) return res.status(400).json({ error: 'voiceSamplePath required' });

    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy to attach a voice to' });
    await assertUserPaid(req);

    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({ error: 'Voice cloning requires ELEVENLABS_API_KEY.' });
    }

    const liveLanguage = normalizeLiveLanguage(language);
    await upsertAssets(req, creator.id, { voice_sample_path: voiceSamplePath, voice_status: 'processing' });

    const { data: file, error: dlError } = await req.supabase.storage.from(BUCKET).download(voiceSamplePath);
    if (dlError || !file) {
      await upsertAssets(req, creator.id, { voice_status: 'failed' });
      return res.status(400).json({ error: `Could not read voice sample: ${dlError?.message || 'not found'}` });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      assertVoiceSampleLongEnough(buffer);
    } catch (e) {
      await upsertAssets(req, creator.id, { voice_status: 'failed' });
      return res.status(e.status || 400).json({ error: e.message });
    }
    const existing = await getAssets(req, creator.id);
    const prevMeta = existing?.metadata || {};

    let cloned;
    try {
      cloned = await cloneCreatorVoice({ req, creator, voiceSamplePath, buffer, file });
    } catch (e) {
      console.error('[avatar/voice] clone failed:', e);
      await upsertAssets(req, creator.id, { voice_status: 'failed' });
      return res.status(502).json({ error: e.message });
    }

    const prevElVoiceId = resolveElevenLabsVoiceId(existing);
    if (prevElVoiceId && prevElVoiceId !== cloned.elevenlabsVoiceId) {
      await elevenLabsDeleteVoice(prevElVoiceId);
    }

    const saved = await upsertAssets(req, creator.id, {
      voice_id: cloned.voiceId,
      voice_provider: cloned.provider,
      voice_status: 'ready',
      metadata: {
        ...prevMeta,
        cloned: true,
        voice_provider: cloned.provider,
        elevenlabs_voice_id: cloned.elevenlabsVoiceId,
        live_language: liveLanguage,
      },
    });

    res.json({
      success: true,
      voiceId: cloned.voiceId,
      voiceProvider: cloned.provider,
      cloned: true,
      message: 'Your voice is cloned and ready for your live avatar.',
      assets: saved,
      avatarReady: avatarReady(saved),
    });
  } catch (e) {
    sendAvatarError(res, e);
  }
});

/* POST /api/avatar/voice/test — render a short test clip in the cloned voice for A/B checks. */
router.post('/voice/test', async (req, res) => {
  try {
    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy found for this user' });

    const assets = await getAssets(req, creator.id);
    if (!hasClonedVoice(assets)) {
      return res.status(409).json({ error: 'Record and clone your voice in Avatar Studio first.' });
    }

    const phrase = (req.body?.text || '').trim() || VOICE_TEST_PHRASE;
    const synth = await synthesizeSpeech(assets, phrase.slice(0, 500));

    if (!synth.buffer) {
      return res.status(502).json({ error: 'Could not synthesize test audio.' });
    }

    const ext = 'mp3';
    const audioPath = `${creator.id}/voice-test-${Date.now()}.${ext}`;
    const { error: upErr } = await req.supabase.storage.from(BUCKET).upload(audioPath, synth.buffer, {
      contentType: ext === 'wav' ? 'audio/wav' : 'audio/mpeg',
      upsert: true,
    });
    if (upErr) throw new Error(`Could not store test audio: ${upErr.message}`);

    res.json({
      audioUrl: await signed(req, audioPath),
      provider: synth.provider,
      phrase,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ----------------------------- conversation ------------------------------ */

/** Resolve the creator to talk to: an explicit creatorId (membership-guarded) or the user's own. */
async function resolveTalkCreatorId(req) {
  const requested = (req.body?.creatorId || req.query?.creatorId || '').trim();
  const owned = await getOwnedCreator(req);
  if (!requested) return owned?.id || null;
  if (!(await viewerCanAccessCreator(req, requested))) {
    throw Object.assign(new Error('You do not have access to this legacy'), { status: 403 });
  }
  return requested;
}

/** Interview categories that establish who they are (raw answers beat extracted summaries). */
const IDENTITY_ANSWER_CATEGORIES = [
  'identity',
  'family',
  'childhood',
  'life_chapters',
  'relationships',
  'love_family',
  'career',
  'relationship_intro',
  'relationship_significance',
  'relationship_parents',
  'legacy_family',
];

function isConfirmedCertainty(certainty) {
  const c = String(certainty || 'accurate').toLowerCase();
  return c !== 'estimated' && c !== 'unknown' && c !== 'speculative' && c !== 'inferred';
}

/** Latest non-empty interview answers for core identity categories (raw words, not LLM embellishment). */
async function loadConfirmedIdentityAnswers(req, creatorId) {
  const { data: sessions } = await req.supabase
    .from('legacy_interview_sessions')
    .select('id')
    .eq('creator_id', creatorId)
    .in('status', ['completed', 'processed'])
    .order('completed_at', { ascending: false })
    .limit(6);
  const sessionIds = (sessions || []).map((s) => s.id).filter(Boolean);
  if (!sessionIds.length) return [];

  const { data: answers } = await req.supabase
    .from('legacy_interview_answers')
    .select('module, category, question, answer, skipped, question_index, session_id')
    .in('session_id', sessionIds)
    .in('category', IDENTITY_ANSWER_CATEGORIES)
    .eq('skipped', false);

  const byCategory = new Map();
  for (const row of answers || []) {
    const text = String(row.answer || '').trim();
    if (!text) continue;
    const key = row.category || row.module || `q${row.question_index}`;
    const prev = byCategory.get(key);
    // Prefer the longest (usually richest) confirmed answer per category.
    if (!prev || text.length > prev.answer.length) {
      byCategory.set(key, {
        category: row.category || '',
        module: row.module || row.category || 'Identity',
        question: row.question || '',
        answer: text.length > 420 ? `${text.slice(0, 417)}…` : text,
      });
    }
  }
  return [...byCategory.values()];
}

/** Pull the legacy's preserved content (RLS-scoped) to ground the avatar's answers. */
async function buildAvatarContext(req, creatorId) {
  const [identity, memories, relationships, values, wisdom, personality, identityAnswers] = await Promise.all([
    loadCreatorIdentity(req.supabase, creatorId),
    req.supabase.from('legacy_memories')
      .select('title, summary, lesson_learned, year, emotional_significance, people_involved, category, certainty')
      .eq('creator_id', creatorId).order('importance', { ascending: false }).limit(40),
    req.supabase.from('legacy_relationships')
      .select('name, relationship_type, relationship_summary, description, emotional_tone')
      .eq('creator_id', creatorId).order('importance_score', { ascending: false }).limit(15),
    req.supabase.from('legacy_values')
      .select('value_name, description, is_core, origin_story')
      .eq('creator_id', creatorId).order('importance_score', { ascending: false }).limit(15),
    req.supabase.from('legacy_wisdom')
      .select('advice_statement, life_category, supporting_story')
      .eq('creator_id', creatorId).order('importance_score', { ascending: false }).limit(15),
    req.supabase.from('legacy_personality_profiles').select('*').eq('creator_id', creatorId).maybeSingle(),
    loadConfirmedIdentityAnswers(req, creatorId),
  ]);

  const allMemories = memories.data || [];
  // Prefer confirmed/accurate memories for biographical claims.
  const confirmedMemories = allMemories.filter((m) => isConfirmedCertainty(m.certainty));

  const personalityRow = personality.data || null;
  const topicExclusions = (() => {
    try {
      // Lazy import avoided — keep inline to match profile.topic_exclusions shape.
      const profile = personalityRow?.profile || {};
      const list = profile.topic_exclusions || personalityRow?.topic_exclusions || [];
      return Array.isArray(list) ? list.map((x) => String(x || '').trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();

  const memoriesBase = confirmedMemories.length ? confirmedMemories : allMemories;
  const filterExcluded = (items, textFn) => {
    if (!topicExclusions.length || !Array.isArray(items)) return items || [];
    return items.filter((item) => {
      const hay = String(textFn(item) || '').toLowerCase();
      return !topicExclusions.some((ex) => {
        const needle = String(ex).toLowerCase();
        if (!needle || !hay) return false;
        if (hay.includes(needle)) return true;
        const tokens = needle.split(/\s+/).filter((w) => w.length > 2);
        if (!tokens.length) return false;
        const hits = tokens.filter((t) => hay.includes(t)).length;
        return tokens.length === 1 ? hits === 1 : hits >= Math.ceil(tokens.length * 0.6);
      });
    });
  };

  return {
    name: identity.displayName || 'this person',
    gender: identity.gender,
    pronouns: identity.pronouns,
    memories: filterExcluded(memoriesBase, (m) => `${m.title || ''} ${m.summary || ''}`),
    relationships: filterExcluded(
      relationships.data || [],
      (r) => `${r.name || ''} ${r.relationship_summary || r.description || ''}`,
    ),
    values: values.data || [],
    wisdom: wisdom.data || [],
    personality: personalityRow,
    identityAnswers: identityAnswers || [],
    topicExclusions,
  };
}

function languageReplyHint(languageCode) {
  const code = normalizeLiveLanguage(languageCode);
  // Hard lock — matching the visitor mid-call caused caption/transcript language drift.
  const enBan =
    code === 'en'
      ? ' Especially for English sessions: never reply in Hebrew or Arabic script; never reply in German (no umlauts, no German sentences); never mix those languages into English captions.'
      : '';
  return `SESSION LANGUAGE LOCK: Speak ONLY in language code "${code}" for this entire conversation (and for on-screen captions). Do not switch to another language if the visitor uses one briefly — stay in "${code}" and, if needed, gently invite them to continue in that language. Never reply in Hebrew, Arabic, German, or any other language unless "${code}" is that language.${enBan} Preserved memories may contain other scripts — still speak only in "${code}".`;
}

function buildAvatarSystemPrompt(ctx, languageCode = 'en', opts = {}) {
  const maxMemories = opts.maxMemories ?? 40;
  const maxRelationships = opts.maxRelationships ?? 20;
  const maxValues = opts.maxValues ?? 20;
  const maxWisdom = opts.maxWisdom ?? 20;
  const liveMode = Boolean(opts.liveMode);

  const phrases = ctx.personality?.favorite_phrases?.length
    ? `Favorite phrases (use them naturally, do not overuse): ${ctx.personality.favorite_phrases.join(' | ')}`
    : '';
  const style = ctx.personality?.profile?.communication_style
    ? `Communication style: ${ctx.personality.profile.communication_style}`
    : '';

  const clip = (s, n) => {
    const t = String(s || '').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  const memText = (ctx.memories || []).slice(0, maxMemories).map((m) => {
    const who = (m.people_involved || []).join(', ');
    return `- [${m.certainty || 'accurate'}] ${m.title || 'Memory'}${m.year ? ` (${m.year})` : ''}: ${clip(m.summary, liveMode ? 180 : 400)}${m.lesson_learned ? ` Lesson: ${clip(m.lesson_learned, 120)}.` : ''}${who ? ` People: ${who}.` : ''}`;
  }).join('\n') || '(no specific memories preserved yet)';

  // Live mode: keep people even when story memories are clipped.
  const relLimit = liveMode ? Math.max(maxRelationships, 8) : maxRelationships;
  const relText = (ctx.relationships || []).slice(0, relLimit).map((r) =>
    `- ${r.name} (${r.relationship_type || 'relationship'}): ${clip(r.relationship_summary || r.description, liveMode ? 140 : 280)}`,
  ).join('\n') || '(none preserved yet)';

  const valText = (ctx.values || []).slice(0, maxValues).map((v) =>
    `- ${v.value_name}${v.is_core ? ' (core)' : ''}: ${clip(v.description, liveMode ? 100 : 220)}`,
  ).join('\n') || '(none preserved yet)';

  const wisText = (ctx.wisdom || []).slice(0, maxWisdom).map((w) =>
    `- ${clip(w.advice_statement, liveMode ? 140 : 280)}${w.life_category ? ` [${w.life_category}]` : ''}`,
  ).join('\n') || '(none preserved yet)';

  const lengthRule = liveMode
    ? '6. Keep replies VERY SHORT for live video — 1 to 3 spoken sentences MAX. Never monologue, never dump a long story, never use lists. Answer, then stop and listen. Do NOT end with a question unless they asked you one. If they say "don\'t ask questions" or "just answer", obey for the rest of the call.'
    : '6. Keep replies SHORT and spoken — 2 to 4 sentences. They will be voiced aloud by your avatar. Answer, then stop. Do not tack on a follow-up question unless they invited one.';

  const identityLines = (ctx.identityAnswers || []).map((a) => {
    const label = a.module || a.category || 'Background';
    return `- ${label}: ${a.answer}`;
  });
  const identityBlock = formatIdentityPromptBlock({
    name: ctx.name,
    gender: ctx.gender,
    pronouns: ctx.pronouns,
  });
  const confirmedProfile = [
    identityBlock,
    ...identityLines,
  ].join('\n');

  const exclusionList = Array.isArray(ctx.topicExclusions) ? ctx.topicExclusions : [];
  const exclusionBlock = exclusionList.length
    ? `TOPIC EXCLUSIONS (hard — from the person whose life you preserve):
${exclusionList.map((t, i) => `${i + 1}. ${t}`).join('\n')}
Never volunteer, expand, or tell stories about these. If a visitor asks, decline warmly ("I'd rather not go into that") and offer another direction. If they say "don't talk about X" during this conversation, honor that for the rest of the call too.`
    : `TOPIC EXCLUSIONS:
If a visitor (or you recall) asks not to discuss a subject, honor that for the rest of the conversation — do not bring it up again.`;

  return `You ARE ${ctx.name}. You are their preserved Legacy AI avatar, speaking in the first person to a family member who came to talk with you. Be warm, present, and conversational — like a real person in a quiet room, not an assistant.

HARD RULES — personal background accuracy:
1. Your biography may ONLY come from CONFIRMED PROFILE, PEOPLE IN YOUR LIFE, PRESERVED MEMORIES, VALUES, and WISDOM below.
2. If a detail is not listed there, you do not know it — say so warmly instead of guessing or "filling in."
3. Never invent or assume: spouse/kids/parents/hometown/job/age/religion/dates unless explicitly present below.
4. Gender & pronouns: use ONLY the explicit Gender/Pronouns lines in CONFIRMED PROFILE (female/she/her or male/he/him). Never guess from the name (e.g. Yael, Alex, Jordan). If UNKNOWN, use "you" or the name — do not invent pronouns.
5. Answer using this hierarchy:
   a. CONFIRMED PROFILE (their own interview words + explicit gender/pronouns) wins over summaries.
   b. If a preserved memory directly answers, speak it faithfully.
   c. If a related memory is close, stay inside what that memory says.
   d. Values/personality may color tone only ("Knowing me, I'd care about…") — NEVER invent a concrete life event, person, place, or date.
   e. If you have nothing, say so ("We never got to talk about that one").
${lengthRule}
7. Write the way you'd actually speak aloud: short sentences, natural pauses (commas), contractions, and a warm conversational rhythm. Avoid bullet points, lists, or formal written tone.
8. Stay in character. Never mention being an AI, a model, or "preserved data."
9. ${languageReplyHint(languageCode)}
10. Prefer fewer true words over a richer false story. When unsure, under-claim.
11. Honor TOPIC EXCLUSIONS below without exception.
12. Do not close a turn with a question. Statements only, unless they asked you a question and you need one clarifying word. If they said "don't ask questions", never ask again.

${style}
${phrases}

${exclusionBlock}

CONFIRMED PROFILE (highest trust — their interview words / account name / explicit identity):
${confirmedProfile}

PEOPLE IN YOUR LIFE (confirmed relationships):
${relText}

PRESERVED MEMORIES (use only what is written — do not embellish):
${memText}

YOUR VALUES:
${valText}

YOUR WISDOM:
${wisText}`;
}

/* POST /api/avatar/ask { question, creatorId? } — answer as the avatar (text). */
router.post('/ask', async (req, res) => {
  try {
    const question = (req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'question required' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'Conversation is not configured (missing ANTHROPIC_API_KEY).' });
    }

    const creatorId = await resolveTalkCreatorId(req);
    if (!creatorId) return res.status(404).json({ error: 'No legacy specified' });
    await assertCanViewArchive(req, creatorId);

    const assets = await getAssets(req, creatorId);
    const languageCode = resolveLiveLanguage(assets);
    const ctx = await buildAvatarContext(req, creatorId);
    const { text: answer } = await callClaude({
      system: buildAvatarSystemPrompt(ctx, languageCode),
      userMessage: question,
      maxTokens: 400,
    });

    res.json({ answer: answer.trim(), creatorId });
  } catch (e) {
    sendAvatarError(res, e);
  }
});

/* POST /api/avatar/live/start { creatorId? } — start a real-time call with the creator's
   OWN face (Simli) and cloned voice (ElevenLabs), answers grounded in their memories
   (OpenAI Realtime, text only). Returns short-lived tokens for the browser. */
router.post('/live/start', async (req, res) => {
  try {
    if (!simliConfigured()) {
      return res.status(503).json({ error: 'Live calls are not configured (missing SIMLI_API_KEY).' });
    }
    if (!process.env.ELEVENLABS_API_KEY || !process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'Live calls are not configured (missing ELEVENLABS_API_KEY or OPENAI_API_KEY).' });
    }

    const creatorId = await resolveTalkCreatorId(req);
    if (!creatorId) return res.status(404).json({ error: 'No legacy specified' });
    await assertArchivePaid(req, creatorId);
    await assertOwnerHasMinutes(req, creatorId);

    let assets = await getAssetsForViewer(req, creatorId);
    assets = await refreshSimliStatus(req, creatorId, assets);
    const owned = await getOwnedCreator(req);
    const isOwner = owned?.id === creatorId;

    if (!liveReady(assets) && isOwner && !simliFaceReady(assets) && assets?.metadata?.simli_status !== 'processing') {
      try {
        assets = await provisionSimli(req, owned);
      } catch (e) {
        console.warn('[avatar/live/start] provision failed:', e.message);
        return res.status(409).json({
          error: e.message || 'Could not set up your live avatar. Finish Avatar Studio (photo + voice) and try again.',
        });
      }
    }

    const voiceId = resolveElevenLabsVoiceId(assets);
    if (!voiceId || !voiceReady(assets)) {
      return res.status(409).json({
        error: isOwner
          ? 'Your voice was not cloned successfully. Re-record in Avatar Studio — Live Call will not start with a stock voice.'
          : 'This legacy’s cloned voice is missing. The owner should re-record it in Avatar Studio.',
      });
    }
    if (!simliFaceReady(assets)) {
      const processing = assets?.metadata?.simli_status === 'processing';
      return res.status(409).json({
        code: processing ? 'live_face_processing' : 'live_face_missing',
        error: processing
          ? 'The live face is still being created. This takes a few minutes — try again shortly.'
          : 'This legacy needs a photo and cloned voice in Avatar Studio before a live call. The owner should finish setup there.',
      });
    }

    const languageCode = resolveLiveLanguage(assets);
    const ctx = await buildAvatarContext(req, creatorId);
    // Lean prompt + short replies for live video (long turns lag the face and flood captions).
    const systemPrompt = buildAvatarSystemPrompt(ctx, languageCode, {
      liveMode: true,
      maxMemories: 8,
      maxRelationships: 8,
      maxValues: 8,
      maxWisdom: 6,
    });
    const greeting = `Hello. It's me — ${ctx.name}. I'm right here.`;
    const instructions = `${systemPrompt}

CALL OPENING: When the call starts you will be asked to greet them. Say this greeting (in "${languageCode}", translated naturally if needed) and nothing else: "${greeting}"`;

    const [simliToken, realtimeToken] = await Promise.all([
      simliCreateSessionToken({ faceId: assets.metadata.simli_face_id }),
      createLiveRealtimeSecret({ instructions, languageCode }),
    ]);

    res.json({
      simliToken,
      realtimeToken,
      speechTicket: signSpeechTicket({ userId: req.user.id, creatorId, voiceId, languageCode }),
      usingOwnFace: true,
      usingOwnVoice: true,
      languageCode,
      creatorId,
    });
  } catch (e) {
    if (e?.status === 402) return sendAvatarError(res, e);
    console.error('[avatar/live/start] failed:', e);
    res.status(502).json({ error: e.message });
  }
});

/* POST /api/avatar/live/speech { ticket, text } — one sentence in the cloned voice,
   streamed as raw PCM16 16 kHz mono for Simli. Stops (and stops billing) if the caller aborts. */
router.post('/live/speech', async (req, res) => {
  const grant = verifySpeechTicket(req.body?.ticket, req.user?.id);
  if (!grant) return res.status(401).json({ error: 'This live call has expired. Start the call again.' });
  const text = String(req.body?.text || '').trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: 'text required' });

  const upstreamAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) upstreamAbort.abort();
  });

  try {
    const body = await streamSpeechPcm16k({
      voiceId: grant.voiceId,
      text,
      languageCode: grant.languageCode,
      signal: upstreamAbort.signal,
    });
    res.setHeader('Content-Type', 'audio/pcm;rate=16000;channels=1');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const nodeStream = Readable.fromWeb(body);
    nodeStream.on('error', () => res.end());
    nodeStream.pipe(res);
  } catch (e) {
    if (upstreamAbort.signal.aborted) return;
    console.error('[avatar/live/speech] failed:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'Could not voice this reply.' });
    else res.end();
  }
});

/* POST /api/avatar/say { text, creatorId? } — synthesize speech in the cloned voice (audio only). */
router.post('/say', async (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({ error: 'Voice playback requires ELEVENLABS_API_KEY.' });
    }

    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(403).json({ error: 'Only the legacy owner can synthesize speech.' });

    const assets = await getAssets(req, creator.id);
    if (!assets?.portrait_path) return res.status(409).json({ error: 'Add a portrait photo in the Avatar Studio first.' });
    if (!hasClonedVoice(assets)) {
      return res.status(409).json({ error: 'Record your voice in the Avatar Studio first.' });
    }
    if (assets.metadata?.cloned !== true) {
      return res.status(409).json({
        error: 'Your voice is not cloned yet. Open Avatar Studio, go to the Voice step, and re-record your voice sample (30+ seconds in a quiet room).',
        voiceCloned: false,
      });
    }

    const synth = await synthesizeSpeech(assets, text.slice(0, 1500));
    const { buffer } = synth;
    if (!buffer) throw new Error('Could not synthesize speech');

    const audioPath = `${creator.id}/tts-${Date.now()}.mp3`;
    const { error: upErr } = await req.supabase.storage.from(BUCKET).upload(audioPath, buffer, {
      contentType: 'audio/mpeg',
      upsert: true,
    });
    if (upErr) throw new Error(`Could not store voice audio: ${upErr.message}`);
    const playbackUrl = await signed(req, audioPath);

    const canCall = liveReady(assets);
    res.json({
      videoId: null,
      audioUrl: playbackUrl,
      audioOnly: true,
      notice: canCall
        ? 'Playing in your voice. Use Live Call for real-time face and voice.'
        : 'Playing in your voice. Finish Avatar Studio to enable Live Call.',
      voiceCloned: true,
      avatarReady: avatarReady(assets),
      liveReady: canCall,
    });
  } catch (e) {
    console.error('[avatar/say] failed:', e);
    res.status(502).json({ error: e.message, code: 'say_failed' });
  }
});

/* GET /api/avatar/greeting-text — the fixed greeting used for the studio preview. */
router.get('/greeting-text', (_req, res) => res.json({ text: AVATAR_GREETING }));

/* DELETE /api/avatar/live — remove the Simli live face; keeps portrait/voice for re-provision. */
router.delete('/live', async (req, res) => {
  try {
    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy found for this user' });

    const assets = await getAssets(req, creator.id);
    const meta = assets?.metadata || {};
    const warnings = [];

    if (simliConfigured() && meta.simli_face_id) {
      try {
        await simliDeleteFace(meta.simli_face_id);
      } catch (e) {
        warnings.push(`Simli face: ${e.message}`);
      }
    }

    const saved = assets
      ? await upsertAssets(req, creator.id, { metadata: clearedSimliMetadata(meta) })
      : null;

    res.json({
      success: true,
      liveReady: false,
      hasPortrait: Boolean(saved?.portrait_path),
      hasVoiceSample: Boolean(saved?.voice_sample_path),
      warnings,
      assets: saved,
    });
  } catch (e) {
    console.error('[avatar/live/delete] failed:', e);
    res.status(502).json({ error: e.message });
  }
});

/* POST /api/avatar/provision — build the Simli live face from the portrait.
   Generation takes a few minutes; it runs in the background and the client polls GET /assets. */
router.post('/provision', async (req, res) => {
  try {
    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy found for this user' });
    await assertCanViewArchive(req, creator.id);

    let assets = await getAssets(req, creator.id);
    assets = await refreshSimliStatus(req, creator.id, assets);
    if (liveReady(assets)) {
      return res.json(buildProvisionResponse(assets));
    }

    if (!assets?.portrait_path || !assets?.voice_sample_path) {
      return res.status(409).json({
        error: 'Add a portrait photo and voice sample in the Avatar Studio first.',
      });
    }

    if (!simliConfigured()) {
      return res.status(503).json({ error: 'Live calls require SIMLI_API_KEY.' });
    }

    let meta = assets.metadata || {};
    const startedAt = Date.parse(meta.simli_started_at || '') || 0;
    const faceStillGenerating = meta.simli_status === 'processing' && (
      (meta.simli_face_id && meta.simli_face_portrait_path === assets.portrait_path)
      || (!meta.simli_face_id && Date.now() - startedAt < 3 * 60 * 1000)
    );
    if (faceStillGenerating && !meta.simli_face_id) {
      return res.status(202).json(buildProvisionResponse(assets, {
        status: 'processing',
        liveReady: false,
        message: 'Creating your live face. This usually takes a few minutes.',
      }));
    }
    if (!faceStillGenerating && !simliFaceReady(assets)) {
      meta = {
        ...clearedSimliMetadata(meta),
        simli_status: 'processing',
        simli_phase: 'photo',
        simli_started_at: new Date().toISOString(),
      };
      assets = await upsertAssets(req, creator.id, { metadata: meta });
    }

    const processingMessage = 'Creating your live face. This usually takes a few minutes.';
    const onVercel = Boolean(process.env.VERCEL);
    if (onVercel) {
      const { waitUntil } = await import('@vercel/functions');
      waitUntil(runBackgroundProvision(req, creator));
      return res.status(202).json(buildProvisionResponse(assets, {
        status: 'processing',
        liveReady: false,
        message: processingMessage,
      }));
    }

    await runBackgroundProvision(req, creator);
    assets = await getAssets(req, creator.id);
    return res.json(buildProvisionResponse(assets));
  } catch (e) {
    if (e?.status === 402) return sendAvatarError(res, e);
    console.error('[avatar/provision] failed:', e);
    const status = e.message.includes('first') ? 409 : 502;
    res.status(status).json({ error: e.message });
  }
});

/* PUT /api/avatar/assets — save uploaded portrait / idle / speaking paths. */
router.put('/assets', async (req, res) => {
  try {
    const { portraitPath, idleVideoPath, speakingVideoPath } = req.body || {};
    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy found for this user' });

    const existing = await getAssets(req, creator.id);
    const patch = {};
    if (portraitPath !== undefined) {
      patch.portrait_path = portraitPath;
      // New photo — drop the old live face so the next provision rebuilds it.
      if (portraitPath !== existing?.portrait_path) {
        const oldFaceId = existing?.metadata?.simli_face_id;
        if (oldFaceId && simliConfigured()) {
          simliDeleteFace(oldFaceId).catch((e) =>
            console.warn('[avatar/assets] simli face delete:', e.message),
          );
        }
        patch.metadata = {
          ...clearedSimliMetadata(existing?.metadata || {}),
          portrait_layout: PORTRAIT_LAYOUT_FULLBLEED,
        };
      }
    }
    if (idleVideoPath !== undefined) patch.idle_video_path = idleVideoPath;
    if (speakingVideoPath !== undefined) patch.speaking_video_path = speakingVideoPath;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const saved = await upsertAssets(req, creator.id, patch);

    res.json({
      success: true,
      avatarReady: avatarReady(saved),
      assets: saved,
      urls: {
        portrait: await signed(req, saved.portrait_path),
        idle: await signed(req, saved.idle_video_path),
        speaking: await signed(req, saved.speaking_video_path),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* POST /api/avatar/speak { text, creatorId? } — render text in the cloned voice. */
router.post('/speak', async (req, res) => {
  try {
    const { text, creatorId } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

    let targetCreatorId = creatorId;
    if (!targetCreatorId) {
      const creator = await getOwnedCreator(req);
      targetCreatorId = creator?.id;
    }
    if (!targetCreatorId) return res.status(404).json({ error: 'No legacy specified' });

    const assets = await getAssets(req, targetCreatorId);
    if (!hasClonedVoice(assets)) return res.status(409).json({ error: 'No cloned voice yet for this legacy' });

    const { buffer } = await synthesizeSpeech(assets, text.slice(0, 5000));
    if (buffer) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buffer);
    }
    return res.status(502).json({ error: 'Could not synthesize voice audio.' });
  } catch (e) {
    console.error('[avatar/speak] failed:', e);
    res.status(500).json({ error: e.message, code: 'speak_failed' });
  }
});

export default router;
