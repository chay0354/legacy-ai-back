/**
 * Remove Anam live avatar + voice for a creator and reset DB so provision can run again.
 * Usage: node scripts/reset-live-avatar.js [creatorId]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { deleteAvatar as anamDeleteAvatar, deleteVoice as anamDeleteVoice } from '../src/services/anam.js';

const creatorId = process.argv[2] || 'b7c7bc8b-19b7-4de9-a56b-39c0c438a0fc';

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

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY required');
  return createClient(url, key);
}

const admin = supabaseAdmin();
const { data: row, error } = await admin
  .from('legacy_avatar_assets')
  .select('creator_id, metadata')
  .eq('creator_id', creatorId)
  .maybeSingle();

if (error) throw error;
if (!row) {
  console.log(`No avatar assets for creator ${creatorId}`);
  process.exit(0);
}

const meta = row.metadata || {};
const anamAvatarId = meta.anam_avatar_id;
const anamVoiceId = meta.anam_voice_id;

if (anamAvatarId && process.env.ANAM_API_KEY) {
  try {
    await anamDeleteAvatar(anamAvatarId);
    console.log(`Anam avatar deleted ${anamAvatarId}`);
  } catch (e) {
    console.warn(`Anam avatar: ${e.message}`);
  }
}

await anamDeleteVoice(anamVoiceId);

const { error: upErr } = await admin
  .from('legacy_avatar_assets')
  .update({ metadata: clearedAnamMetadata(meta) })
  .eq('creator_id', creatorId);

if (upErr) throw upErr;

console.log(`Live avatar cleared for creator ${creatorId}. Portrait + voice sample kept — run provision to create a new one.`);
