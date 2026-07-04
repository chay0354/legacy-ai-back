import { createClient } from '@supabase/supabase-js';

// Service-role client (RLS-bypassing). Used for privileged access management
// such as accepting invitations. Only created when SUPABASE_SECRET_KEY is set.
let adminClient = null;
function getAdminClient() {
  if (adminClient !== null) return adminClient || null;
  if (process.env.SUPABASE_SECRET_KEY) {
    adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } else {
    adminClient = false;
  }
  return adminClient || null;
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = header.slice(7);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY,
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
