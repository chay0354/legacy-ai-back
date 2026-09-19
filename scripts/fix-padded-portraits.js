/**
 * Crop the blurred picture-in-picture frame off stored portraits.
 * Usage: node scripts/fix-padded-portraits.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { unwrapPortraitIfPadded, PORTRAIT_LAYOUT_FULLBLEED } from '../src/services/portraitFix.js';
import { deleteAvatar as anamDeleteAvatar } from '../src/services/anam.js';

const BUCKET = 'legacy-media';
const force = process.argv.includes('--force');

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY required');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const sb = admin();
const { data: rows, error } = await sb
  .from('legacy_avatar_assets')
  .select('creator_id, portrait_path, metadata');
if (error) throw error;

let fixed = 0;
let skipped = 0;
let failed = 0;

for (const row of rows || []) {
  const path = row.portrait_path;
  const meta = row.metadata || {};
  if (!path) {
    skipped += 1;
    continue;
  }
  if (!force && meta.portrait_layout === PORTRAIT_LAYOUT_FULLBLEED) {
    console.log('skip already full-bleed', row.creator_id);
    skipped += 1;
    continue;
  }

  const { data: file, error: dlErr } = await sb.storage.from(BUCKET).download(path);
  if (dlErr || !file) {
    console.warn('download failed', row.creator_id, dlErr?.message);
    failed += 1;
    continue;
  }

  const original = Buffer.from(await file.arrayBuffer());
  let result;
  try {
    result = await unwrapPortraitIfPadded(original, { force });
  } catch (e) {
    console.warn('unwrap failed', row.creator_id, e.message);
    failed += 1;
    continue;
  }

  const nextMeta = { ...meta, portrait_layout: PORTRAIT_LAYOUT_FULLBLEED };
  if (!result.changed) {
    await sb.from('legacy_avatar_assets').update({
      metadata: nextMeta,
      updated_at: new Date().toISOString(),
    }).eq('creator_id', row.creator_id);
    console.log('no pad detected', row.creator_id, result.check);
    skipped += 1;
    continue;
  }

  const nextPath = `${row.creator_id}/portrait-fullbleed-${Date.now()}.jpg`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(nextPath, result.buffer, {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (upErr) {
    console.warn('upload failed', row.creator_id, upErr.message);
    failed += 1;
    continue;
  }

  if (meta.anam_avatar_id) {
    try { await anamDeleteAvatar(meta.anam_avatar_id); } catch (e) {
      console.warn('anam delete', meta.anam_avatar_id, e.message);
    }
    nextMeta.anam_status = 'none';
    nextMeta.anam_avatar_id = null;
    nextMeta.anam_avatar_portrait_path = null;
    nextMeta.anam_avatar_source = null;
  }

  const { error: dbErr } = await sb.from('legacy_avatar_assets').update({
    portrait_path: nextPath,
    metadata: nextMeta,
    updated_at: new Date().toISOString(),
  }).eq('creator_id', row.creator_id);
  if (dbErr) {
    console.warn('db update failed', row.creator_id, dbErr.message);
    failed += 1;
    continue;
  }

  if (path !== nextPath) {
    await sb.storage.from(BUCKET).remove([path]).catch(() => {});
  }

  console.log('fixed', row.creator_id, result.check);
  fixed += 1;
}

console.log(JSON.stringify({ fixed, skipped, failed, total: (rows || []).length }));
