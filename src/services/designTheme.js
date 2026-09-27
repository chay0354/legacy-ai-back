import { getAdminClient } from '../middleware/auth.js';

/** Must match front/src/design/theme.ts and the :root defaults. */
const DEFAULTS = {
  paper: '#eee5d4',
  card: '#faf5eb',
  ink: '#241c15',
  ink2: '#5e5346',
  status: '#5c5246',
  walnut: '#2b211a',
  sienna: '#b05e37',
  olive: '#3c4433',
  gold: '#b3902f',
  onDark: '#f0e7d6',
  onPrimary: '#ffffff',
  error: '#8f3d2c',
  radiusControl: 6,
  radiusCard: 12,
  gutterDesktop: 44,
  gutterMobile: 16,
  contentMax: 1180,
  controlHeight: 44,
};

const RANGES = {
  radiusControl: [0, 20],
  radiusCard: [0, 32],
  gutterDesktop: [20, 80],
  gutterMobile: [12, 32],
  contentMax: [800, 1440],
  controlHeight: [36, 56],
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function sanitizeTheme(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key in RANGES) {
      const n = Math.round(Number(src[key]));
      if (!Number.isFinite(n)) continue;
      const [min, max] = RANGES[key];
      const clamped = Math.min(max, Math.max(min, n));
      if (clamped !== DEFAULTS[key]) out[key] = clamped;
    } else if (typeof src[key] === 'string' && HEX.test(src[key])) {
      const hex = src[key].toLowerCase();
      if (hex !== DEFAULTS[key]) out[key] = hex;
    }
  }
  return out;
}

function missingTable(error) {
  const message = String(error?.message || '');
  return error?.code === '42P01' || error?.code === 'PGRST205' || /does not exist|schema cache/i.test(message);
}

export async function readTheme() {
  const admin = getAdminClient();
  if (!admin) return {};
  const { data, error } = await admin
    .from('legacy_design_theme')
    .select('tokens')
    .eq('id', 'published')
    .maybeSingle();
  if (error) {
    if (!missingTable(error)) console.warn('[theme] could not load:', error.message);
    return {};
  }
  return sanitizeTheme(data?.tokens);
}

export async function writeTheme(tokens) {
  const admin = getAdminClient();
  if (!admin) {
    const err = new Error('Supabase service role is not configured.');
    err.status = 503;
    throw err;
  }
  const clean = sanitizeTheme(tokens);
  const { error } = await admin.from('legacy_design_theme').upsert({
    id: 'published',
    tokens: clean,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    const err = new Error(missingTable(error)
      ? 'The appearance table is not on this database yet.'
      : (error.message || 'Could not save the appearance.'));
    err.status = missingTable(error) ? 503 : 500;
    throw err;
  }
  return clean;
}
