/**
 * Remove every avatar in Legacy AI: external clones (Anam, ElevenLabs, HeyGen) + DB rows + storage.
 * Usage: node scripts/wipe-all-avatars.js
 *
 * Requires SUPABASE_URL + SUPABASE_SECRET_KEY in .env (or env vars).
 * External cleanup is best-effort when API keys are missing.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { listAvatars as anamListAvatars, deleteAvatar as anamDeleteAvatar, deleteVoice as anamDeleteVoice } from '../src/services/anam.js';
import { deleteVoice as elevenLabsDeleteVoice } from '../src/services/elevenlabs.js';

const HEYGEN_BASE = 'https://api.heygen.com/v3';
const BUCKET = 'legacy-media';

const AVATAR_STORAGE_PATTERNS = [
  /^[^/]+\/portrait-/,
  /^[^/]+\/voice-sample-/,
  /^[^/]+\/idle-/,
  /^[^/]+\/speaking-/,
  /^[^/]+\/tts-/,
];

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY required');
  return createClient(url, key);
}

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

async function wipeExternalForRow(row) {
  const md = row.metadata || {};
  const elId = md.elevenlabs_voice_id || (row.voice_provider === 'elevenlabs' ? row.voice_id : null);
  const heygenVoiceId = row.voice_provider === 'heygen' ? row.voice_id : md.heygen_voice_id;

  if (elId && process.env.ELEVENLABS_API_KEY) {
    try {
      await elevenLabsDeleteVoice(elId);
      console.log(`ElevenLabs voice deleted ${elId}`);
    } catch (e) {
      console.warn(`ElevenLabs ${elId}: ${e.message}`);
    }
  }

  if (heygenVoiceId) await heygenDelete(`/voices/${encodeURIComponent(heygenVoiceId)}`);
  if (md.heygen_photo_avatar_id) await heygenDelete(`/photo_avatar/${md.heygen_photo_avatar_id}`);

  if (md.anam_avatar_id && process.env.ANAM_API_KEY) {
    try {
      await anamDeleteAvatar(md.anam_avatar_id);
      console.log(`Anam avatar deleted ${md.anam_avatar_id}`);
    } catch (e) {
      console.warn(`Anam avatar ${md.anam_avatar_id}: ${e.message}`);
    }
  }

  if (md.anam_voice_id && process.env.ANAM_API_KEY) {
    try {
      await anamDeleteVoice(md.anam_voice_id);
      console.log(`Anam voice deleted ${md.anam_voice_id}`);
    } catch (e) {
      console.warn(`Anam voice ${md.anam_voice_id}: ${e.message}`);
    }
  }
}

/** Delete custom Anam one-shots (display names tied to creator ids). */
async function wipeStaleAnamAvatars() {
  if (!process.env.ANAM_API_KEY) return;
  try {
    const avatars = await anamListAvatars();
    for (const a of avatars) {
      const name = a.displayName || '';
      const isCustom = a.type === 'custom' || a.isCustom || /[0-9a-f]{6}$/i.test(name) || name.includes('Legacy');
      if (!isCustom) continue;
      try {
        await anamDeleteAvatar(a.id);
        console.log(`Anam stale avatar deleted ${a.id} (${name})`);
      } catch (e) {
        console.warn(`Anam stale ${a.id}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`Anam list avatars: ${e.message}`);
  }
}

async function wipeStorage(admin) {
  const { data: objects, error } = await admin.storage.from(BUCKET).list('', { limit: 1000 });
  if (error) throw error;

  const toDelete = [];
  for (const folder of objects || []) {
    if (!folder.name || folder.id) continue;
    const { data: files } = await admin.storage.from(BUCKET).list(folder.name, { limit: 1000 });
    for (const f of files || []) {
      const path = `${folder.name}/${f.name}`;
      if (AVATAR_STORAGE_PATTERNS.some((re) => re.test(path))) toDelete.push(path);
    }
  }

  if (!toDelete.length) {
    console.log('No avatar storage files to delete.');
    return;
  }

  const chunk = 100;
  for (let i = 0; i < toDelete.length; i += chunk) {
    const batch = toDelete.slice(i, i + chunk);
    const { error: delErr } = await admin.storage.from(BUCKET).remove(batch);
    if (delErr) console.warn(`Storage delete batch: ${delErr.message}`);
    else console.log(`Storage deleted ${batch.length} file(s)`);
  }
}

const admin = supabaseAdmin();

const { data: rows, error: selErr } = await admin
  .from('legacy_avatar_assets')
  .select('creator_id, voice_id, voice_provider, metadata');

if (selErr) throw selErr;

console.log(`Found ${rows?.length || 0} avatar asset row(s).`);

for (const row of rows || []) {
  console.log(`Wiping external clones for creator ${row.creator_id}...`);
  await wipeExternalForRow(row);
}

await wipeStaleAnamAvatars();

const { error: delRowsErr } = await admin.from('legacy_avatar_assets').delete().neq('creator_id', '00000000-0000-0000-0000-000000000000');
if (delRowsErr) throw delRowsErr;
console.log('Deleted all legacy_avatar_assets rows.');

await wipeStorage(admin);

console.log('All avatars removed.');
