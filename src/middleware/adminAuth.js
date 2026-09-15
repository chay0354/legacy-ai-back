import crypto from 'crypto';
import { getAdminClient } from './auth.js';

const TOKEN_HOURS = 12;

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function sessionSecret() {
  return process.env.ADMIN_SESSION_SECRET
    || process.env.SUPABASE_SECRET_KEY
    || process.env.STRIPE_SECRET_KEY
    || '';
}

export function adminConfigured() {
  return Boolean(
    String(process.env.ADMIN_EMAIL || '').trim()
    && process.env.ADMIN_PASSWORD
    && sessionSecret(),
  );
}

export function adminEmail() {
  return String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

export function signAdminToken(email) {
  const exp = Date.now() + TOKEN_HOURS * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAdminToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.email || !data?.exp || data.exp < Date.now()) return null;
    if (data.email !== adminEmail()) return null;
    return data;
  } catch {
    return null;
  }
}

export function credentialsMatch(email, password) {
  if (!adminConfigured()) return false;
  const emailOk = timingSafeEqual(String(email || '').trim().toLowerCase(), adminEmail());
  const passOk = timingSafeEqual(String(password || ''), String(process.env.ADMIN_PASSWORD));
  return emailOk && passOk;
}

export function requireAdmin(req, res, next) {
  if (!adminConfigured()) {
    return res.status(503).json({ error: 'Admin login is not configured on this server.' });
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin sign-in required' });
  }
  const session = verifyAdminToken(header.slice(7));
  if (!session) {
    return res.status(401).json({ error: 'Admin session expired. Sign in again.' });
  }
  req.adminSession = session;
  req.admin = getAdminClient();
  next();
}
