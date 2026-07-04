import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool = null;

export function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('[YOUR-PASSWORD]')) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

async function tableExists(db, name) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return rows.length > 0;
}

async function applyMigration(db, file) {
  const migrationPath = path.resolve(__dirname, '../../supabase/migrations/', file);
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await db.query(sql);
  console.log(`Applied migration: ${file}`);
}

export async function ensureSchema() {
  const db = getPool();
  if (!db) return false;

  if (!(await tableExists(db, 'legacy_creators'))) {
    await applyMigration(db, '20250620180000_legacy_ai_schema.sql');
  }
  if (!(await tableExists(db, 'legacy_members'))) {
    await applyMigration(db, '20250621120000_roles_and_access.sql');
  }
  // idempotent: safe to re-run (ALTER COLUMN is no-op if already nullable)
  try {
    await applyMigration(db, '20250621140000_link_only_invitations.sql');
  } catch {
    /* already applied */
  }
  try {
    await applyMigration(db, '20250621150000_public_invite_lookup.sql');
  } catch {
    /* already applied */
  }
  try {
    await applyMigration(db, '20250621160000_accept_invitation_rpc.sql');
  } catch {
    /* already applied */
  }
  try {
    await applyMigration(db, '20250621170000_get_or_create_creator_rpc.sql');
  } catch {
    /* already applied */
  }
  return true;
}
