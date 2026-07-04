import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';

const router = Router();

function authClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase is not configured on the server');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function sessionPayload(session, user) {
  if (!session || !user) return { session: null, user: null };
  return {
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      expires_in: session.expires_in,
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.user_metadata?.full_name || null,
    },
  };
}

/** POST /api/auth/sign-in — email/password via server (not direct browser → Supabase) */
router.post('/sign-in', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const supabase = authClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('invalid login') || msg.includes('invalid credentials')) {
        return res.status(401).json({ error: 'Wrong email or password' });
      }
      return res.status(400).json({ error: error.message });
    }

    res.json(sessionPayload(data.session, data.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/auth/sign-up — create account via server */
router.post('/sign-up', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const supabase = authClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: name ? { data: { full_name: name } } : undefined,
    });
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('already registered') || msg.includes('already exists') || error.status === 422) {
        return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
      }
      return res.status(400).json({ error: error.message });
    }

    if (!data.session) {
      return res.json({
        ...sessionPayload(null, data.user),
        needsEmailConfirmation: true,
      });
    }

    res.status(201).json(sessionPayload(data.session, data.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/auth/forgot-password */
router.post('/forgot-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const redirectTo = String(req.body.redirectTo || process.env.FRONTEND_URL || 'http://localhost:5173');
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const supabase = authClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
