/**
 * Create Simli live faces for every archive that has a portrait and a cloned voice
 * but no live face yet. Safe to re-run: archives with a face are skipped.
 * Usage: node scripts/provision-live-faces.js [--dry-run]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { unwrapPortraitIfPadded, PORTRAIT_LAYOUT_FULLBLEED } from '../src/services/portraitFix.js';
import { createFace, faceStatus, preprocessPortrait, isConfigured } from '../src/services/simli.js';

const BUCKET = 'legacy-media';
const dryRun = process.argv.includes('--dry-run');

if (!isConfigured()) {
  console.error('SIMLI_API_KEY is missing in .env');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY required');
const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: rows, error } = await sb
  .from('legacy_avatar_assets')
  .select('creator_id, portrait_path, voice_id, voice_status, voice_provider, metadata, legacy_creators(display_name)');
if (error) throw error;

async function save(creatorId, metadata) {
  const { error: upErr } = await sb.from('legacy_avatar_assets')
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq('creator_id', creatorId);
  if (upErr) console.warn('  save failed:', upErr.message);
}

const pending = [];
for (const row of rows || []) {
  const meta = row.metadata || {};
  const hasVoice = row.voice_status === 'ready' && meta.cloned === true
    && (meta.elevenlabs_voice_id || (row.voice_provider === 'elevenlabs' && row.voice_id));
  const label = `${row.creator_id} (${row.legacy_creators?.display_name || 'no name'})`;
  if (!row.portrait_path || !hasVoice) {
    console.log(`skip ${label}: needs portrait + cloned voice`);
    continue;
  }
  if (meta.simli_face_id && meta.simli_face_portrait_path === row.portrait_path && meta.simli_status === 'ready') {
    console.log(`skip ${label}: live face ready`);
    continue;
  }
  if (meta.simli_face_id && meta.simli_face_portrait_path === row.portrait_path && meta.simli_status === 'processing') {
    pending.push({ row, meta, label });
    console.log(`wait ${label}: already generating`);
    continue;
  }
  if (dryRun) {
    console.log(`would create ${label}`);
    continue;
  }

  console.log(`create ${label}`);
  const { data: file, error: dlErr } = await sb.storage.from(BUCKET).download(row.portrait_path);
  if (dlErr || !file) {
    console.warn('  portrait download failed:', dlErr?.message);
    continue;
  }
  let buffer = Buffer.from(await file.arrayBuffer());
  try {
    const unwrapped = await unwrapPortraitIfPadded(buffer, { force: meta.portrait_layout !== PORTRAIT_LAYOUT_FULLBLEED });
    if (unwrapped.changed) buffer = unwrapped.buffer;
  } catch (e) {
    console.warn('  unwrap skipped:', e.message);
  }
  let portrait = { buffer, contentType: 'image/jpeg', filename: 'portrait.jpg' };
  try {
    const framed = await preprocessPortrait(portrait);
    if (framed?.length) portrait = { buffer: framed, contentType: 'image/png', filename: 'portrait.png' };
  } catch (e) {
    console.warn('  preprocess skipped:', e.message);
  }

  try {
    const name = `${row.legacy_creators?.display_name || 'Legacy'} ${row.creator_id.slice(0, 6)}`.slice(0, 50);
    const faceId = await createFace({ name, ...portrait });
    const next = {
      ...meta,
      simli_face_id: faceId,
      simli_face_portrait_path: row.portrait_path,
      simli_status: 'processing',
      simli_phase: 'live_face',
      simli_error: null,
      simli_started_at: new Date().toISOString(),
    };
    await save(row.creator_id, next);
    pending.push({ row, meta: next, label });
    console.log(`  face ${faceId} generating`);
  } catch (e) {
    console.warn('  create failed:', e.message);
    await save(row.creator_id, { ...meta, simli_status: 'failed', simli_error: e.message });
  }
}

const deadline = Date.now() + 15 * 60 * 1000;
while (pending.length && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const { row, meta, label } = pending[i];
    try {
      const s = await faceStatus(meta.simli_face_id);
      if (s.status === 'processing') continue;
      await save(row.creator_id, {
        ...meta,
        simli_status: s.status,
        simli_error: s.status === 'failed' ? String(s.error || 'failed') : null,
        ...(s.status === 'ready' ? { simli_ready_at: new Date().toISOString() } : {}),
      });
      console.log(`${s.status} ${label}`);
      pending.splice(i, 1);
    } catch (e) {
      console.warn(`status ${label}:`, e.message);
    }
  }
}
if (pending.length) {
  console.log(`${pending.length} face(s) still generating — the site picks them up when they finish.`);
}
console.log('Done.');
