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
  const content = sanitizeContent(src);
  if (Object.keys(content.copy).length) out.copy = content.copy;
  if (Object.keys(content.images).length) out.images = content.images;
  if (Object.keys(content.blocks).length) out.blocks = content.blocks;
  if (Object.keys(content.styles).length) out.styles = content.styles;
  if (Object.keys(content.added).length) out.added = content.added;
  return out;
}

const SEP = '\u001f';

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function validContentKey(key) {
  if (typeof key !== 'string' || key.length < 3 || key.length > 4000 || !key.startsWith('/')) return false;
  const parts = key.split(SEP);
  return parts.length >= 2 && parts.every((part) => part.length > 0 && part.length < 2500);
}

function collectNudges(input, limit) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (Object.keys(out).length >= limit) break;
    if (!validContentKey(key) || !value || typeof value !== 'object') continue;
    const scale = clamp(Math.round(Number(value.scale) * 100) / 100, 0.5, 2);
    const x = clamp(Math.round(Number(value.x)), -480, 480);
    const y = clamp(Math.round(Number(value.y)), -480, 480);
    if (!Number.isFinite(scale) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (scale === 1 && x === 0 && y === 0) continue;
    out[key] = { scale, x, y };
  }
  return out;
}

function sanitizeContent(input) {
  const src = input && typeof input === 'object' ? input : {};
  const copyIn = src.copy && typeof src.copy === 'object' ? src.copy : {};
  const copy = {};
  for (const [key, value] of Object.entries(copyIn)) {
    if (Object.keys(copy).length >= 800) break;
    if (!validContentKey(key) || typeof value !== 'string') continue;
    const text = sanitizeRich(value.trim());
    const original = key.split(SEP).slice(1).join(SEP);
    if (!text || text.length > 2000 || text === original) continue;
    copy[key] = text;
  }
  return {
    copy,
    images: collectNudges(src.images, 200),
    blocks: collectNudges(src.blocks, 200),
    styles: collectStyles(src.styles, 400),
    added: collectAdded(src.added, 100),
  };
}

function sanitizeRich(value) {
  return String(value)
    .replace(/<\s*(\/?)\s*(strong|b)\s*>/gi, '<$1b>')
    .replace(/<\s*(\/?)\s*(em|i)\s*>/gi, '<$1i>')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\n+$/g, '')
    .trim();
}

function collectAdded(input, limit) {
  const out = {};
  for (const [key, value] of Object.entries(input && typeof input === 'object' ? input : {})) {
    if (Object.keys(out).length >= limit) break;
    if (!validContentKey(key) || !key.includes(`${SEP}add:`) || !value || typeof value !== 'object') continue;
    if (!validContentKey(value.after)) continue;
    if (value.kind === 'text') {
      const text = sanitizeRich(typeof value.text === 'string' ? value.text.trim() : '');
      if (!text || text.length > 2000) continue;
      out[key] = { kind: 'text', after: value.after, text };
    } else if (value.kind === 'image') {
      const src = typeof value.src === 'string' ? value.src.trim() : '';
      if (!/^https:\/\/\S+$/.test(src) || src.length > 1000) continue;
      const alt = typeof value.alt === 'string' ? value.alt.trim().slice(0, 300) : '';
      out[key] = { kind: 'image', after: value.after, src, ...(alt ? { alt } : {}) };
    }
  }
  return out;
}

function collectStyles(input, limit) {
  const out = {};
  for (const [key, value] of Object.entries(input && typeof input === 'object' ? input : {})) {
    if (Object.keys(out).length >= limit) break;
    if (!validContentKey(key) || !value || typeof value !== 'object') continue;
    const style = {};
    if (typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color)) style.color = value.color.toLowerCase();
    if (typeof value.background === 'string' && /^#[0-9a-f]{6}$/i.test(value.background)) style.background = value.background.toLowerCase();
    if (Object.keys(style).length) out[key] = style;
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
