/**
 * Remove the Simli live face for a creator and reset DB so provision can run again.
 * Usage: node scripts/reset-live-avatar.js <creatorId>
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { deleteFace as simliDeleteFace } from '../src/services/simli.js';

const creatorId = process.argv[2];
if (!creatorId) {
  console.error('Usage: node scripts/reset-live-avatar.js <creatorId>');
  process.exit(1);
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
if (meta.simli_face_id && process.env.SIMLI_API_KEY) {
  try {
    await simliDeleteFace(meta.simli_face_id);
    console.log(`Simli face deleted ${meta.simli_face_id}`);
  } catch (e) {
    console.warn(`Simli face: ${e.message}`);
  }
}

const { error: upErr } = await admin
  .from('legacy_avatar_assets')
  .update({ metadata: clearedSimliMetadata(meta) })
  .eq('creator_id', creatorId);

if (upErr) throw upErr;

console.log(`Live face cleared for creator ${creatorId}. Portrait + voice kept — run provision to create a new one.`);
