/**
 * Permanently remove a user and their legacy data.
 * Usage: node scripts/delete-user-by-email.js <email>
 *
 * Requires SUPABASE_URL + SUPABASE_SECRET_KEY in .env
 * Also best-effort deletes Anam/ElevenLabs clones from avatar metadata.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { deleteAvatar as anamDeleteAvatar, deleteVoice as anamDeleteVoice } from '../src/services/anam.js';
import { deleteVoice as elevenLabsDeleteVoice } from '../src/services/elevenlabs.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/delete-user-by-email.js <email>');
  process.exit(1);
}

const BUCKET = 'legacy-media';

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY required');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function wipeExternal(meta = {}, voiceId, voiceProvider) {
  const elId = meta.elevenlabs_voice_id || (voiceProvider === 'elevenlabs' ? voiceId : null);
  if (elId && process.env.ELEVENLABS_API_KEY) {
    try {
      await elevenLabsDeleteVoice(elId);
      console.log('ElevenLabs voice deleted', elId);
    } catch (e) {
      console.warn('ElevenLabs:', e.message);
    }
  }
  if (meta.anam_avatar_id && process.env.ANAM_API_KEY) {
    try {
      await anamDeleteAvatar(meta.anam_avatar_id);
      console.log('Anam avatar deleted', meta.anam_avatar_id);
    } catch (e) {
      console.warn('Anam avatar:', e.message);
    }
  }
  if (meta.anam_voice_id && process.env.ANAM_API_KEY) {
    try {
      await anamDeleteVoice(meta.anam_voice_id);
      console.log('Anam voice deleted', meta.anam_voice_id);
    } catch (e) {
      console.warn('Anam voice:', e.message);
    }
  }
}

async function wipeStorage(supabase, creatorId) {
  const prefix = `${creatorId}/`;
  const { data: files, error } = await supabase.storage.from(BUCKET).list(creatorId, { limit: 1000 });
  if (error) {
    console.warn('Storage list:', error.message);
    return;
  }
  const paths = (files || []).map((f) => `${creatorId}/${f.name}`);
  if (!paths.length) return;
  const { error: delErr } = await supabase.storage.from(BUCKET).remove(paths);
  if (delErr) console.warn('Storage delete:', delErr.message);
  else console.log(`Storage deleted ${paths.length} file(s) under ${prefix}`);
}

const supabase = admin();

const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listErr) throw listErr;

const user = (listData?.users || []).find((u) => String(u.email || '').toLowerCase() === email);
if (!user) {
  console.log(`No auth user found for ${email}`);
  process.exit(0);
}

console.log('Found user', user.id, user.email);

const { data: creator } = await supabase
  .from('legacy_creators')
  .select('id, display_name')
  .eq('user_id', user.id)
  .maybeSingle();

if (creator?.id) {
  console.log('Creator', creator.id, creator.display_name || '(no name)');
  const { data: assets } = await supabase
    .from('legacy_avatar_assets')
    .select('voice_id, voice_provider, metadata, portrait_path, voice_sample_path')
    .eq('creator_id', creator.id)
    .maybeSingle();

  if (assets) {
    await wipeExternal(assets.metadata || {}, assets.voice_id, assets.voice_provider);
  }
  await wipeStorage(supabase, creator.id);
}

const { error: delErr } = await supabase.auth.admin.deleteUser(user.id);
if (delErr) throw delErr;

console.log(`Deleted user ${email} (${user.id}). Legacy data cascaded from auth.users.`);
