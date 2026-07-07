import { Router } from 'express';
import { cloneVoice as elevenLabsClone, textToSpeech as elevenLabsTts, deleteVoice as elevenLabsDeleteVoice, isInstantCloneLikelyAvailable, markInstantCloneUnavailable } from '../services/elevenlabs.js';
import {
  startTalkingVideo,
  startAvatarVideo,
  getVideoStatus,
  uploadAsset,
  cloneVoiceFromSample,
  createPhotoAvatar,
  generateSpeech as heygenTts,
  AVATAR_GREETING,
} from '../services/heygen.js';
import { heyGenVoiceSettings, VOICE_TEST_PHRASE } from '../config/voice.js';
import { callClaude } from '../services/anthropic.js';
import {
  isConfigured as anamConfigured,
  listAvatars as anamListAvatars,
  deleteAvatar as anamDeleteAvatar,
  deleteVoice as anamDeleteVoice,
  createAvatarFromImageUrl as anamCreateAvatar,
  cloneVoice as anamCloneVoice,
  createSessionToken as anamCreateSessionToken,
  buildSessionOptions as anamBuildSessionOptions,
} from '../services/anam.js';
import { makeAccessStore } from '../db/accessRepo.js';

const router = Router();
const BUCKET = 'legacy-media';

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

/** True when the HeyGen photo avatar is registered for this creator. */
function avatarReady(assets) {
  return assets?.metadata?.avatar_status === 'ready'
    && Boolean(assets.metadata?.heygen_photo_avatar_id);
}

/**
 * Upload the creator's portrait to HeyGen and register a Photo Avatar (their face).
 * Idempotent — skips if already provisioned for the same portrait path.
 */
async function provisionCreatorAvatar(req, creator) {
  if (!process.env.HEYGEN_API_KEY) {
    throw new Error('Avatar provisioning requires HEYGEN_API_KEY.');
  }

  const assets = await getAssets(req, creator.id);
  if (!assets?.portrait_path) {
    throw new Error('Add a portrait photo in the Avatar Studio first.');
  }
  if (!voiceReady(assets)) {
    throw new Error('Record your voice in the Avatar Studio first.');
  }

  const portraitKey = assets.portrait_path;
  const meta = assets.metadata || {};
  if (
    meta.avatar_status === 'ready'
    && meta.heygen_photo_avatar_id
    && meta.avatar_portrait_path === portraitKey
  ) {
    return assets;
  }

  await upsertAssets(req, creator.id, {
    metadata: {
      ...meta,
      avatar_status: 'processing',
      avatar_error: null,
    },
  });

  const { data: file, error: dlError } = await req.supabase.storage.from(BUCKET).download(portraitKey);
  if (dlError || !file) {
    await upsertAssets(req, creator.id, {
      metadata: { ...meta, avatar_status: 'failed', avatar_error: 'Could not read portrait photo.' },
    });
    throw new Error(`Could not read portrait photo: ${dlError?.message || 'not found'}`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = (portraitKey.split('.').pop() || 'jpg').toLowerCase();
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';

  let avatarId;
  let groupId;
  let previewUrl;
  try {
    ({ avatarId, groupId, previewUrl } = await createPhotoAvatar({
      name: `Legacy — ${creator.display_name || 'Creator'} (${creator.id.slice(0, 8)})`,
      buffer,
      contentType,
      filename: `portrait.${ext === 'png' ? 'png' : 'jpg'}`,
    }));
  } catch (e) {
    console.error('[avatar/provision] HeyGen photo avatar failed:', e);
    await upsertAssets(req, creator.id, {
      metadata: { ...meta, avatar_status: 'failed', avatar_error: e.message },
    });
    throw e;
  }

  return upsertAssets(req, creator.id, {
    metadata: {
      ...meta,
      avatar_status: 'ready',
      avatar_error: null,
      avatar_portrait_path: portraitKey,
      heygen_photo_avatar_id: avatarId,
      heygen_avatar_group_id: groupId,
      heygen_avatar_preview_url: previewUrl,
      avatar_provisioned_at: new Date().toISOString(),
    },
  });
}

/** True when the Anam live avatar (face) + voice are provisioned for this creator. */
function anamReady(assets) {
  return Boolean(assets?.metadata?.anam_avatar_id);
}

function anamDisplayName(creator) {
  return `${creator.display_name || 'Legacy'} ${creator.id.slice(0, 6)}`.slice(0, 50);
}

/** Free/starter plans allow few concurrent one-shots — remove stale faces for this creator. */
async function freeAnamAvatarSlots(creator, keepId = null) {
  const prefix = creator.id.slice(0, 6);
  const avatars = await anamListAvatars();
  for (const a of avatars) {
    if (a.id === keepId) continue;
    const name = a.displayName || '';
    if (name.endsWith(prefix) || name.includes(` ${prefix}`)) {
      try {
        await anamDeleteAvatar(a.id);
        console.info('[avatar/anam] deleted stale avatar', a.id, name);
      } catch (e) {
        console.warn('[avatar/anam] could not delete avatar', a.id, e.message);
      }
    }
  }
}

async function createAnamAvatarWithSlotRetry(creator, portraitUrl) {
  const displayName = anamDisplayName(creator);
  try {
    return await anamCreateAvatar({ displayName, imageUrl: portraitUrl });
  } catch (e) {
    if (e.status !== 403 || !/one-shot avatars/i.test(e.message)) throw e;
    console.warn('[avatar/anam] avatar slot full — cleaning stale one-shots for creator');
    await freeAnamAvatarSlots(creator);
    return anamCreateAvatar({ displayName, imageUrl: portraitUrl });
  }
}

/**
 * Provision the live-call assets on Anam from the creator's OWN photo + voice:
 * create a one-shot avatar from the portrait and clone the recorded voice.
 * Idempotent — reuses existing Anam ids when the source media hasn't changed.
 */
async function provisionAnam(req, creator) {
  if (!anamConfigured()) throw new Error('Live calls require ANAM_API_KEY.');

  const assets = await getAssets(req, creator.id);
  if (!assets?.portrait_path) throw new Error('Add a portrait photo in the Avatar Studio first.');
  if (!assets?.voice_sample_path) throw new Error('Record your voice in the Avatar Studio first.');

  const meta = assets.metadata || {};
  const portraitKey = assets.portrait_path;
  const voiceKey = assets.voice_sample_path;

  const haveAvatar = meta.anam_avatar_id && meta.anam_avatar_portrait_path === portraitKey;
  const haveVoice = meta.anam_voice_id && meta.anam_voice_sample_path === voiceKey;
  if (haveAvatar && haveVoice) return assets;

  await upsertAssets(req, creator.id, {
    metadata: { ...meta, anam_status: 'processing', anam_error: null },
  });

  try {
    let anamAvatarId = haveAvatar ? meta.anam_avatar_id : null;
    let anamVoiceId = haveVoice ? meta.anam_voice_id : null;

    // Face — Anam downloads the signed portrait URL and builds the live avatar.
    if (!anamAvatarId) {
      const portraitUrl = await signed(req, portraitKey);
      if (!portraitUrl) throw new Error('Could not read the portrait photo.');
      // Portrait changed — drop the previous one-shot so Free-plan slot limits aren't hit.
      if (meta.anam_avatar_id && meta.anam_avatar_portrait_path !== portraitKey) {
        try {
          await anamDeleteAvatar(meta.anam_avatar_id);
        } catch (e) {
          console.warn('[avatar/anam] old avatar delete failed:', e.message);
        }
      }
      anamAvatarId = await createAnamAvatarWithSlotRetry(creator, portraitUrl);
    }

    // Voice — clone from the recorded sample stored in Supabase.
    if (!anamVoiceId) {
      const { data: file, error: dlError } = await req.supabase.storage.from(BUCKET).download(voiceKey);
      if (dlError || !file) throw new Error(`Could not read voice sample: ${dlError?.message || 'not found'}`);
      const buffer = Buffer.from(await file.arrayBuffer());
      const ext = (voiceKey.split('.').pop() || 'wav').toLowerCase();
      const contentType = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav';
      anamVoiceId = await anamCloneVoice({
        name: `${creator.display_name || 'Legacy'} ${creator.id.slice(0, 6)}`,
        buffer,
        contentType,
        filename: `voice.${ext === 'mp3' ? 'mp3' : 'wav'}`,
      });
    }

    return upsertAssets(req, creator.id, {
      metadata: {
        ...meta,
        anam_status: 'ready',
        anam_error: null,
        anam_avatar_id: anamAvatarId,
        anam_avatar_portrait_path: portraitKey,
        anam_voice_id: anamVoiceId,
        anam_voice_sample_path: voiceKey,
        anam_provisioned_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('[avatar/provisionAnam] failed:', e);
    await upsertAssets(req, creator.id, {
      metadata: { ...meta, anam_status: 'failed', anam_error: e.message },
    });
    throw e;
  }
}

function buildProvisionResponse(assets, extra = {}) {
  return {
    success: true,
    status: anamReady(assets) ? 'ready' : (assets?.metadata?.anam_status || 'none'),
    avatarReady: avatarReady(assets),
    liveReady: anamReady(assets),
    heygenPhotoAvatarId: assets?.metadata?.heygen_photo_avatar_id || null,
    anamAvatarId: assets?.metadata?.anam_avatar_id || null,
    previewUrl: assets?.metadata?.heygen_avatar_preview_url || null,
    assets,
    ...extra,
  };
}

function clearedAnamMetadata(meta = {}) {
  return {
    ...meta,
    anam_status: 'none',
    anam_error: null,
    anam_avatar_id: null,
    anam_avatar_portrait_path: null,
    anam_voice_id: null,
    anam_voice_sample_path: null,
    anam_provisioned_at: null,
  };
}

/** Run Anam + HeyGen provisioning after the HTTP response (Vercel waitUntil). */
async function runBackgroundProvision(req, creator) {
  const ctx = { supabase: req.supabase, admin: req.admin, user: req.user };
  try {
    if (anamConfigured()) {
      await provisionAnam(ctx, creator);
    }
    try {
      await provisionCreatorAvatar(ctx, creator);
    } catch (e) {
      console.warn('[avatar/provision/bg] HeyGen:', e.message);
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

    const ext = (path.split('.').pop() || 'jpg').toLowerCase();
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(await file.arrayBuffer()));
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

    const assets = await getAssetsForViewer(req, creatorId);
    const { data: creatorRow } = await req.supabase
      .from('legacy_creators')
      .select('display_name')
      .eq('id', creatorId)
      .maybeSingle();
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
      displayName: creatorRow?.display_name || null,
      assets: assets || null,
      voiceCloned: assets?.metadata?.cloned === true,
      avatarReady: avatarReady(assets),
      liveReady: anamReady(assets),
      hasPortrait: Boolean(assets?.portrait_path),
      previewUrl: assets?.metadata?.heygen_avatar_preview_url || null,
      urls,
    });
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

function hasClonedVoice(assets) {
  if (!assets || assets.voice_status !== 'ready') return false;
  return Boolean(assets.voice_id || resolveElevenLabsVoiceId(assets) || assets.metadata?.heygen_voice_id);
}

function resolveElevenLabsVoiceId(assets) {
  if (!assets) return null;
  if (assets.voice_provider === 'elevenlabs' && assets.voice_id) return assets.voice_id;
  return assets.metadata?.elevenlabs_voice_id || null;
}

/** Collect the primary sample plus any older voice-sample files for richer cloning. */
async function gatherVoiceSamples(req, creatorId, primaryPath, primaryBuffer, primaryFile) {
  const samples = [{
    buffer: primaryBuffer,
    filename: primaryPath.split('/').pop() || 'voice-sample.wav',
    contentType: primaryFile.type || 'audio/wav',
  }];

  const { data: list } = await req.supabase.storage.from(BUCKET).list(creatorId, { search: 'voice-sample' });
  for (const item of (list || []).slice(0, 4)) {
    const path = `${creatorId}/${item.name}`;
    if (path === primaryPath) continue;
    const { data } = await req.supabase.storage.from(BUCKET).download(path);
    if (!data) continue;
    samples.push({
      buffer: Buffer.from(await data.arrayBuffer()),
      filename: item.name,
      contentType: data.type || 'audio/wav',
    });
  }

  return samples;
}

async function cloneCreatorVoice({ req, creator, voiceSamplePath, buffer, file }) {
  const voiceName = `Legacy — ${creator.display_name || 'Creator'} (${creator.id.slice(0, 8)})`;
  const samples = await gatherVoiceSamples(req, creator.id, voiceSamplePath, buffer, file);

  if (await isInstantCloneLikelyAvailable()) {
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
        heygenVoiceId: null,
      };
    } catch (e) {
      markInstantCloneUnavailable(e);
      console.warn('[avatar/voice] ElevenLabs clone unavailable, using HeyGen:', e.message);
    }
  }

  if (!process.env.HEYGEN_API_KEY) {
    throw new Error('Voice cloning requires ELEVENLABS_API_KEY or HEYGEN_API_KEY.');
  }

  const heygenVoiceId = await cloneVoiceFromSample({
    voiceName,
    buffer,
    mimeType: file.type || 'audio/wav',
    filename: voiceSamplePath,
  });

  return {
    voiceId: heygenVoiceId,
    provider: 'heygen',
    elevenlabsVoiceId: null,
    heygenVoiceId,
  };
}

async function synthesizeSpeech(assets, text) {
  const elVoiceId = resolveElevenLabsVoiceId(assets);
  const heygenVoiceId = assets.voice_provider === 'heygen' ? assets.voice_id : assets.metadata?.heygen_voice_id;

  if (elVoiceId && process.env.ELEVENLABS_API_KEY) {
    try {
      const buffer = await elevenLabsTts({ voiceId: elVoiceId, text });
      return { buffer, provider: 'elevenlabs', voiceId: heygenVoiceId || assets.voice_id, text };
    } catch (e) {
      console.warn('[avatar/tts] ElevenLabs TTS failed, trying HeyGen:', e.message);
    }
  }

  if (heygenVoiceId) {
    try {
      const { audioUrl, buffer } = await heygenTts({ voiceId: heygenVoiceId, text });
      return {
        url: audioUrl,
        buffer: buffer || undefined,
        voiceId: heygenVoiceId,
        text,
        provider: 'heygen',
      };
    } catch (e) {
      if (!isHeyGenCreditsError(e)) throw e;
      if (elVoiceId && process.env.ELEVENLABS_API_KEY) {
        console.warn('[avatar/tts] HeyGen credits exhausted — using ElevenLabs voice');
        const buffer = await elevenLabsTts({ voiceId: elVoiceId, text });
        return { buffer, provider: 'elevenlabs', text };
      }
      throw heygenCreditsExhaustedError(assets);
    }
  }

  throw new Error('No cloned voice available for this legacy.');
}

function isHeyGenCreditsError(err) {
  return /insufficient api credits/i.test(err?.message || '');
}

function heygenCreditsExhaustedError(assets) {
  const liveReady = Boolean(assets?.metadata?.anam_avatar_id && assets?.metadata?.anam_voice_id);
  const msg = liveReady
    ? 'Pre-recorded talking video is unavailable right now. Your cloned face and voice still work on Live Call.'
    : 'Pre-recorded talking video is unavailable right now. Finish Avatar Studio setup to enable Live Call.';
  const err = new Error(msg);
  err.code = 'heygen_credits_exhausted';
  err.liveCallAvailable = liveReady;
  return err;
}

/* POST /api/avatar/voice-sample { voiceSamplePath } — save a voice recording for playback on the avatar page (no cloning). */
router.post('/voice-sample', async (req, res) => {
  try {
    const { voiceSamplePath } = req.body || {};
    if (!voiceSamplePath?.trim()) return res.status(400).json({ error: 'voiceSamplePath required' });

    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy found for this user' });

    const saved = await upsertAssets(req, creator.id, {
      voice_sample_path: voiceSamplePath.trim(),
      voice_status: 'ready',
    });

    res.json({
      success: true,
      assets: saved,
      voiceSampleUrl: await signed(req, saved.voice_sample_path),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* POST /api/avatar/voice { voiceSamplePath } — clone the creator's voice (ElevenLabs first, HeyGen fallback). */
router.post('/voice', async (req, res) => {
  try {
    const { voiceSamplePath } = req.body || {};
    if (!voiceSamplePath) return res.status(400).json({ error: 'voiceSamplePath required' });

    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy to attach a voice to' });

    if (!process.env.ELEVENLABS_API_KEY && !process.env.HEYGEN_API_KEY) {
      return res.status(503).json({ error: 'Voice cloning requires ELEVENLABS_API_KEY or HEYGEN_API_KEY.' });
    }

    await upsertAssets(req, creator.id, { voice_sample_path: voiceSamplePath, voice_status: 'processing' });

    const { data: file, error: dlError } = await req.supabase.storage.from(BUCKET).download(voiceSamplePath);
    if (dlError || !file) {
      await upsertAssets(req, creator.id, { voice_status: 'failed' });
      return res.status(400).json({ error: `Could not read voice sample: ${dlError?.message || 'not found'}` });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const existing = await getAssets(req, creator.id);

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
        ...(existing?.metadata || {}),
        cloned: true,
        voice_provider: cloned.provider,
        elevenlabs_voice_id: cloned.elevenlabsVoiceId,
        heygen_voice_id: cloned.heygenVoiceId || existing?.metadata?.heygen_voice_id || null,
      },
    });

    let provisioned = null;
    if (saved.portrait_path) {
      try {
        provisioned = await provisionCreatorAvatar(req, creator);
      } catch (e) {
        console.warn('[avatar/voice] auto-provision deferred:', e.message);
      }
    }

    res.json({
      success: true,
      voiceId: cloned.voiceId,
      voiceProvider: cloned.provider,
      cloned: true,
      message: 'Your voice is cloned and ready for your live avatar.',
      assets: provisioned || saved,
      avatarReady: avatarReady(provisioned || saved),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

    const ext = synth.provider === 'elevenlabs' ? 'mp3' : 'wav';
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

/** Pull the legacy's preserved content (RLS-scoped) to ground the avatar's answers. */
async function buildAvatarContext(req, creatorId) {
  const [creator, memories, relationships, values, wisdom, personality] = await Promise.all([
    req.supabase.from('legacy_creators').select('display_name').eq('id', creatorId).maybeSingle(),
    req.supabase.from('legacy_memories')
      .select('title, summary, lesson_learned, year, emotional_significance, people_involved, category, certainty')
      .eq('creator_id', creatorId).order('importance', { ascending: false }).limit(30),
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
  ]);

  return {
    name: creator.data?.display_name || 'this person',
    memories: memories.data || [],
    relationships: relationships.data || [],
    values: values.data || [],
    wisdom: wisdom.data || [],
    personality: personality.data || null,
  };
}

function buildAvatarSystemPrompt(ctx) {
  const phrases = ctx.personality?.favorite_phrases?.length
    ? `Favorite phrases (use them naturally, do not overuse): ${ctx.personality.favorite_phrases.join(' | ')}`
    : '';
  const style = ctx.personality?.profile?.communication_style
    ? `Communication style: ${ctx.personality.profile.communication_style}`
    : '';

  const memText = ctx.memories.map((m) => {
    const who = (m.people_involved || []).join(', ');
    return `- [${m.certainty || 'accurate'}] ${m.title || 'Memory'}${m.year ? ` (${m.year})` : ''}: ${m.summary || ''}${m.lesson_learned ? ` Lesson: ${m.lesson_learned}.` : ''}${who ? ` People: ${who}.` : ''}`;
  }).join('\n') || '(no specific memories preserved yet)';

  const relText = ctx.relationships.map((r) =>
    `- ${r.name} (${r.relationship_type || 'relationship'}): ${r.relationship_summary || r.description || ''}`,
  ).join('\n') || '(none preserved yet)';

  const valText = ctx.values.map((v) =>
    `- ${v.value_name}${v.is_core ? ' (core)' : ''}: ${v.description || ''}`,
  ).join('\n') || '(none preserved yet)';

  const wisText = ctx.wisdom.map((w) =>
    `- ${w.advice_statement}${w.life_category ? ` [${w.life_category}]` : ''}`,
  ).join('\n') || '(none preserved yet)';

  return `You ARE ${ctx.name}. You are their preserved Legacy AI avatar, speaking in the first person to a family member who came to talk with you. Be warm, present, and conversational — like a real person in a quiet room, not an assistant.

HARD RULES:
1. Never invent specific facts (names, dates, places, events) that are not in the material below. Fabrication betrays the family's trust.
2. Answer using this hierarchy:
   a. If a preserved memory directly answers, speak it in your own voice.
   b. If a related memory is close, draw on it and say so gently.
   c. If there's no memory but your values/personality imply an answer, reason from them and make clear it's how you would have felt ("Knowing me, I'd say…").
   d. If you truly have nothing, say so honestly and warmly ("We never got to talk about that one") — do not guess at facts.
3. Keep replies SHORT and spoken — 2 to 4 sentences. They will be voiced aloud by your avatar.
4. Write the way you'd actually speak aloud: short sentences, natural pauses (commas), contractions, and a warm conversational rhythm. Avoid bullet points, lists, or formal written tone.
5. Stay in character. Never mention being an AI, a model, or "preserved data."

${style}
${phrases}

PRESERVED MEMORIES:
${memText}

PEOPLE IN YOUR LIFE:
${relText}

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

    const ctx = await buildAvatarContext(req, creatorId);
    const { text: answer } = await callClaude({
      system: buildAvatarSystemPrompt(ctx),
      userMessage: question,
      maxTokens: 400,
    });

    res.json({ answer: answer.trim(), creatorId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* POST /api/avatar/live/start { creatorId? } — start a real-time Anam live call
   using the creator's OWN face + cloned voice, grounded in their memories. Returns
   a short-lived Anam session token for the frontend WebRTC SDK. */
router.post('/live/start', async (req, res) => {
  try {
    if (!anamConfigured()) {
      return res.status(503).json({ error: 'Live calls are not configured (missing ANAM_API_KEY).' });
    }

    const creatorId = await resolveTalkCreatorId(req);
    if (!creatorId) return res.status(404).json({ error: 'No legacy specified' });

    // The creator's own Anam face + voice. Provision on demand if the owner is calling;
    // viewers rely on the owner having provisioned already.
    let assets = await getAssetsForViewer(req, creatorId);
    let usingOwnFace = anamReady(assets);
    if (!usingOwnFace) {
      const owned = await getOwnedCreator(req);
      if (owned?.id === creatorId) {
        try {
          assets = await provisionAnam(req, owned);
          usingOwnFace = anamReady(assets);
        } catch (e) {
          console.warn('[avatar/live/start] provision failed:', e.message);
        }
      }
    }

    const avatarId = assets?.metadata?.anam_avatar_id;
    if (!avatarId) {
      return res.status(409).json({
        error: 'This legacy needs a photo and voice in the Avatar Studio before a live call. The owner should open Avatar Studio and finish setup.',
      });
    }
    const voiceId = assets?.metadata?.anam_voice_id || undefined;

    const ctx = await buildAvatarContext(req, creatorId);
    const systemPrompt = buildAvatarSystemPrompt(ctx);

    const sessionToken = await anamCreateSessionToken({
      name: ctx.name,
      avatarId,
      voiceId,
      systemPrompt,
      initialMessage: `Hello. It's me — ${ctx.name}. I'm right here. Ask me anything.`,
    });

    res.json({
      sessionToken,
      usingOwnFace: true,
      usingOwnVoice: Boolean(voiceId),
      creatorId,
      videoProfile: anamBuildSessionOptions(),
    });
  } catch (e) {
    console.error('[avatar/live/start] failed:', e);
    res.status(502).json({ error: e.message });
  }
});

/* POST /api/avatar/say { text, creatorId? } — render the avatar speaking `text` (HeyGen + cloned voice).
   Returns a videoId to poll. Requires the creator's own portrait + voice. */
router.post('/say', async (req, res) => {
  try {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (!process.env.HEYGEN_API_KEY) {
      return res.status(503).json({ error: 'Talking video is not configured (missing HEYGEN_API_KEY).' });
    }

    // Talking video uses the creator's own portrait + voice (RLS allows owner only).
    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(403).json({ error: 'Only the legacy owner can render the talking avatar.' });

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

    const portraitUrl = await signed(req, assets.portrait_path);
    if (!portraitUrl) return res.status(409).json({ error: 'Could not read the portrait photo.' });

    // Ensure HeyGen photo avatar exists (face registered from the user's portrait).
    let activeAssets = assets;
    if (!avatarReady(assets)) {
      try {
        activeAssets = await provisionCreatorAvatar(req, creator);
      } catch (e) {
        console.warn('[avatar/say] provision failed, falling back to image render:', e.message);
      }
    }

    const synth = await synthesizeSpeech(activeAssets, text.slice(0, 1500));
    const { url: ttsUrl, buffer, voiceId, text: speechText, provider } = synth;

    let playbackUrl = null;
    let videoId;
    const photoAvatarId = activeAssets.metadata?.heygen_photo_avatar_id;
    const audioOnlyNotice =
      'Pre-recorded talking video is unavailable right now. Your cloned voice still plays as audio — use Live Call for real-time face and voice.';

    if (buffer) {
      const ext = provider === 'elevenlabs' ? 'mp3' : ttsUrl?.includes('.wav') ? 'wav' : 'mp3';
      const contentType = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
      const audioPath = `${creator.id}/tts-${Date.now()}.${ext}`;
      const { error: upErr } = await req.supabase.storage.from(BUCKET).upload(audioPath, buffer, {
        contentType, upsert: true,
      });
      if (upErr) throw new Error(`Could not store voice audio: ${upErr.message}`);
      playbackUrl = await signed(req, audioPath);

      try {
        const audioAssetId = await uploadAsset(buffer, { filename: `legacy-speech.${ext}`, contentType });
        if (photoAvatarId) {
          videoId = await startAvatarVideo({
            avatarId: photoAvatarId,
            audioAssetId,
            script: speechText || text.slice(0, 1500),
            voiceId,
          });
        } else {
          videoId = await startTalkingVideo({ imageUrl: portraitUrl, audioAssetId });
        }
      } catch (e) {
        if (!isHeyGenCreditsError(e)) throw e;
        console.warn('[avatar/say] HeyGen video skipped — credits exhausted');
        return res.json({
          videoId: null,
          audioUrl: playbackUrl,
          audioOnly: true,
          notice: audioOnlyNotice,
          voiceCloned: true,
          avatarReady: avatarReady(activeAssets),
        });
      }
    } else if (ttsUrl) {
      try {
        if (photoAvatarId) {
          videoId = await startAvatarVideo({
            avatarId: photoAvatarId,
            script: speechText || text.slice(0, 1500),
            voiceId,
            voiceSettings: heyGenVoiceSettings(),
          });
        } else {
          videoId = await startTalkingVideo({
            imageUrl: portraitUrl,
            script: speechText || text.slice(0, 1500),
            voiceId,
            voiceSettings: heyGenVoiceSettings(),
          });
        }
      } catch (e) {
        if (!isHeyGenCreditsError(e)) throw e;
        return res.json({
          videoId: null,
          audioUrl: null,
          audioOnly: true,
          notice: audioOnlyNotice,
          voiceCloned: true,
          avatarReady: avatarReady(activeAssets),
        });
      }
    } else {
      throw new Error('Could not synthesize speech');
    }

    res.json({ videoId, audioUrl: playbackUrl, voiceCloned: true, avatarReady: avatarReady(activeAssets) });
  } catch (e) {
    if (e.code === 'heygen_credits_exhausted') {
      console.info('[avatar/say] HeyGen unavailable — Live Call is ready');
    } else {
      console.error('[avatar/say] failed:', e);
    }
    const status = e.code === 'heygen_credits_exhausted' ? 402 : 502;
    res.status(status).json({
      error: e.message,
      code: e.code || 'say_failed',
      liveCallAvailable: Boolean(e.liveCallAvailable),
    });
  }
});

/* GET /api/avatar/video/:videoId — poll a HeyGen render. */
router.get('/video/:videoId', async (req, res) => {
  try {
    if (!process.env.HEYGEN_API_KEY) {
      return res.status(503).json({ error: 'Talking video is not configured (missing HEYGEN_API_KEY).' });
    }
    const status = await getVideoStatus(req.params.videoId);
    res.json(status);
  } catch (e) {
    console.error('[avatar/video] failed:', e);
    res.status(502).json({ error: e.message });
  }
});

/* GET /api/avatar/greeting-text — the fixed greeting used for the studio preview. */
router.get('/greeting-text', (_req, res) => res.json({ text: AVATAR_GREETING }));

/* DELETE /api/avatar/live — remove Anam live avatar + voice; keeps portrait/voice sample for re-provision. */
router.delete('/live', async (req, res) => {
  try {
    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy found for this user' });

    const assets = await getAssets(req, creator.id);
    const meta = assets?.metadata || {};
    const warnings = [];

    if (anamConfigured()) {
      if (meta.anam_avatar_id) {
        try {
          await anamDeleteAvatar(meta.anam_avatar_id);
        } catch (e) {
          warnings.push(`Anam avatar: ${e.message}`);
        }
      }
      if (meta.anam_voice_id) {
        try {
          await anamDeleteVoice(meta.anam_voice_id);
        } catch (e) {
          warnings.push(`Anam voice: ${e.message}`);
        }
      }
    }

    const saved = assets
      ? await upsertAssets(req, creator.id, { metadata: clearedAnamMetadata(meta) })
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

/* POST /api/avatar/provision — set up the creator's avatar from their photo + voice:
   Anam live avatar + cloned voice (real-time call) and HeyGen photo avatar (talking video).
   On Vercel, Anam runs in the background — client polls GET /assets until liveReady. */
router.post('/provision', async (req, res) => {
  try {
    const creator = await getOwnedCreator(req);
    if (!creator) return res.status(404).json({ error: 'No legacy found for this user' });

    let assets = await getAssets(req, creator.id);
    if (anamReady(assets)) {
      return res.json(buildProvisionResponse(assets));
    }

    const meta = assets?.metadata || {};
    if (meta.anam_status === 'processing') {
      return res.status(202).json(buildProvisionResponse(assets || { metadata: meta }, {
        status: 'processing',
        liveReady: false,
        message: 'Creating your live avatar. This usually takes about a minute.',
      }));
    }

    if (!assets?.portrait_path || !assets?.voice_sample_path) {
      return res.status(409).json({
        error: 'Add a portrait photo and voice sample in the Avatar Studio first.',
      });
    }

    if (!anamConfigured()) {
      return res.status(503).json({ error: 'Live calls require ANAM_API_KEY.' });
    }

    await upsertAssets(req, creator.id, {
      metadata: { ...meta, anam_status: 'processing', anam_error: null },
    });

    const onVercel = Boolean(process.env.VERCEL);
    if (onVercel) {
      const { waitUntil } = await import('@vercel/functions');
      waitUntil(runBackgroundProvision(req, creator));
      return res.status(202).json({
        success: true,
        status: 'processing',
        liveReady: false,
        avatarReady: avatarReady(assets),
        message: 'Creating your live avatar. This usually takes about a minute.',
      });
    }

    await runBackgroundProvision(req, creator);
    assets = await getAssets(req, creator.id);
    return res.json(buildProvisionResponse(assets));
  } catch (e) {
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
      // New photo — re-provision the HeyGen face avatar on next provision call.
      if (portraitPath !== existing?.portrait_path) {
        const oldAnamId = existing?.metadata?.anam_avatar_id;
        if (oldAnamId && anamConfigured()) {
          anamDeleteAvatar(oldAnamId).catch((e) =>
            console.warn('[avatar/assets] anam avatar delete:', e.message),
          );
        }
        patch.metadata = {
          ...(existing?.metadata || {}),
          avatar_status: 'none',
          heygen_photo_avatar_id: null,
          avatar_portrait_path: null,
          anam_status: 'none',
          anam_avatar_id: null,
          anam_avatar_portrait_path: null,
        };
      }
    }
    if (idleVideoPath !== undefined) patch.idle_video_path = idleVideoPath;
    if (speakingVideoPath !== undefined) patch.speaking_video_path = speakingVideoPath;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    let saved = await upsertAssets(req, creator.id, patch);

    // Photo + voice both ready — register HeyGen photo avatar automatically.
    if (portraitPath !== undefined && voiceReady(saved)) {
      try {
        saved = await provisionCreatorAvatar(req, creator);
      } catch (e) {
        console.warn('[avatar/assets] auto-provision deferred:', e.message);
      }
    }

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

    const { url, buffer } = await synthesizeSpeech(assets, text.slice(0, 5000));
    if (buffer) {
      const isWav = url?.includes('.wav');
      res.setHeader('Content-Type', isWav ? 'audio/wav' : 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buffer);
    }
    return res.status(502).json({ error: 'Could not download voice audio. Is the backend running and reachable?' });
  } catch (e) {
    if (e.code === 'heygen_credits_exhausted') {
      console.info('[avatar/speak] HeyGen unavailable — Live Call is ready');
    } else {
      console.error('[avatar/speak] failed:', e);
    }
    const status = e.code === 'heygen_credits_exhausted' ? 402 : 500;
    res.status(status).json({
      error: e.message,
      code: e.code || 'speak_failed',
      liveCallAvailable: Boolean(e.liveCallAvailable),
    });
  }
});

export default router;
