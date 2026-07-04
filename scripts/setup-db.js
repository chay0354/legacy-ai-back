import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../../supabase/migrations');

const MIGRATIONS = [
  '20250620180000_legacy_ai_schema.sql',
  '20250621120000_roles_and_access.sql',
  '20250621140000_link_only_invitations.sql',
  '20250621150000_public_invite_lookup.sql',
  '20250621160000_accept_invitation_rpc.sql',
  '20250621170000_get_or_create_creator_rpc.sql',
];

const url = process.env.DATABASE_URL;
if (!url || url.includes('[YOUR-PASSWORD]')) {
  console.error('Set DATABASE_URL in back/.env with your Supabase database password.');
  console.error('Dashboard → Project Settings → Database → Connection string (URI)');
  console.error('');
  console.error('Or paste supabase/run-all-migrations.sql into the Supabase SQL Editor.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  for (const file of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`Applying ${file}…`);
    await pool.query(sql);
    console.log(`  ✓ ${file}`);
  }
  console.log('\nAll migrations applied on', process.env.SUPABASE_URL);
} catch (err) {
  console.error('Setup failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
