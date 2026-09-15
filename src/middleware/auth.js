import { createClient } from '@supabase/supabase-js';

/** Prefer the current secret name; keep the older service-role name as a fallback. */
export function serviceRoleKey() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function looksLikeServiceRole(key) {
  if (!key) return false;
  if (key.startsWith('sb_publishable_') || key.startsWith('sb_anon_')) return false;
  if (key.startsWith('sb_secret_')) return true;
  if (key.startsWith('eyJ')) {
    try {
      const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
      return payload.role === 'service_role';
    } catch {
      return false;
    }
  }
  return key.length > 20;
}

// Service-role client (RLS-bypassing). Never reuse the caller's user JWT.
let adminClient = null;
function getAdminClient() {
  if (adminClient !== null) return adminClient || null;
  const key = serviceRoleKey();
  if (looksLikeServiceRole(key)) {
    adminClient = createClient(process.env.SUPABASE_URL, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } else {
    if (key) console.warn('[auth] SUPABASE_SECRET_KEY is not a service-role key — admin writes will be skipped.');
    adminClient = false;
  }
  return adminClient || null;
}

export { getAdminClient };

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = header.slice(7);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PUBLISHABLE_KEY || serviceRoleKey(),
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = user;
  req.userEmail = user.email || null;
  req.token = token;
  req.supabase = supabase;
  req.admin = getAdminClient();
  next();
}
