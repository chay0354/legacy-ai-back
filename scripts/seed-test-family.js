/**
 * Create a family-member and administrator login attached to an owner's archive.
 *
 * Usage: node scripts/seed-test-family.js [owner-email]
 * Requires SUPABASE_URL + SUPABASE_SECRET_KEY in .env
 *
 * Re-runnable: if the accounts already exist, their passwords and roles are reset.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const ownerEmail = (process.argv[2] || 'chay.moalem2108@gmail.com').trim().toLowerCase();

const ACCOUNTS = [
  {
    role: 'member',
    email: 'chay.moalem2108+family@gmail.com',
    password: 'FamilyTest2108!',
    name: 'Maya Moalem',
  },
  {
    role: 'administrator',
    email: 'chay.moalem2108+admin@gmail.com',
    password: 'AdminTest2108!',
    name: 'Yossi Cohen',
  },
];

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY required');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function findUserByEmail(supabase, email) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = (data?.users || []).find((u) => String(u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if ((data?.users || []).length < 200) break;
  }
  return null;
}

async function upsertAuthUser(supabase, { email, password, name }) {
  const existing = await findUserByEmail(supabase, email);
  if (existing) {
    const { data, error } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
      user_metadata: { ...(existing.user_metadata || {}), full_name: name },
    });
    if (error) throw error;
    return data.user;
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error) throw error;
  return data.user;
}

const supabase = admin();

const owner = await findUserByEmail(supabase, ownerEmail);
if (!owner) {
  console.error(`No auth user found for ${ownerEmail}`);
  process.exit(1);
}

const { data: creator, error: creatorErr } = await supabase
  .from('legacy_creators')
  .select('id, display_name')
  .eq('user_id', owner.id)
  .maybeSingle();
if (creatorErr) throw creatorErr;
if (!creator) {
  console.error(`${ownerEmail} has no archive yet.`);
  process.exit(1);
}

console.log(`Attaching test family to ${creator.display_name || ownerEmail} (${creator.id})\n`);

const created = [];
for (const account of ACCOUNTS) {
  const user = await upsertAuthUser(supabase, account);
  const { error } = await supabase.from('legacy_members').upsert(
    {
      creator_id: creator.id,
      user_id: user.id,
      role: account.role,
      invited_by: owner.id,
    },
    { onConflict: 'creator_id,user_id' },
  );
  if (error) throw error;
  created.push({ ...account, userId: user.id });
  console.log(`  ${account.role.padEnd(15)} ${account.email}`);
}

const { data: members, error: listErr } = await supabase
  .from('legacy_members')
  .select('user_id, role')
  .eq('creator_id', creator.id);
if (listErr) throw listErr;

console.log(`\nArchive now has ${members.length} member(s). Sign in with:\n`);
for (const a of created) {
  console.log(`${a.role === 'administrator' ? 'Administrator' : 'Family member'}`);
  console.log(`  email:    ${a.email}`);
  console.log(`  password: ${a.password}`);
  console.log(`  name:     ${a.name}\n`);
}
