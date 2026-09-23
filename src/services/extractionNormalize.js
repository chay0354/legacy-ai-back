/**
 * The extraction model sometimes answers a 0-100 field with a word ("low") or a
 * string ("80%"). Postgres rejects those against int columns, which surfaced as
 * "invalid input syntax for type integer". Coerce every numeric field here so a
 * single odd value can never lose a whole session.
 */

const WORD_SCORES = {
  none: 0,
  minimal: 15,
  low: 25,
  medium: 50,
  moderate: 50,
  average: 50,
  high: 75,
  strong: 80,
  critical: 95,
  maximum: 100,
};

const IMPORTANCE_WORDS = ['low', 'medium', 'high', 'critical'];

/** 0-100 integer from a number, numeric string, or word like "low". */
export function toScore(value, fallback = 50) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  if (typeof value === 'string') {
    const word = WORD_SCORES[value.trim().toLowerCase()];
    if (word !== undefined) return word;
    const n = Number.parseFloat(value.replace('%', '').trim());
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
  }
  return fallback;
}

/** Text importance ("low"…"critical") from a word or a 0-100 score. */
export function toImportanceWord(value, fallback = 'medium') {
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (IMPORTANCE_WORDS.includes(word)) return word;
  }
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (Number.isFinite(n)) {
    if (n >= 90) return 'critical';
    if (n >= 65) return 'high';
    if (n >= 35) return 'medium';
    return 'low';
  }
  return fallback;
}

function toLevel(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : fallback;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

/** Make every int-bound field safe before it reaches Postgres. */
export function normalizeExtraction(extracted, { minLevel = 0 } = {}) {
  if (!extracted || typeof extracted !== 'object') return extracted;

  extracted.completion_score = toScore(extracted.completion_score, 0);
  extracted.avatar_level = Math.max(toLevel(extracted.avatar_level, minLevel), minLevel);

  if (extracted.coverage && typeof extracted.coverage === 'object') {
    extracted.coverage = Object.fromEntries(
      Object.entries(extracted.coverage).map(([cat, score]) => [cat, toScore(score, 0)]),
    );
  }

  extracted.memories = asArray(extracted.memories).map((m) => ({
    ...m,
    importance: toImportanceWord(m?.importance),
  }));

  extracted.relationships = asArray(extracted.relationships).map((r) => ({
    ...r,
    importance_score: toScore(r?.importance_score),
    influence_score: toScore(r?.influence_score),
  }));

  extracted.values = asArray(extracted.values).map((v) => ({
    ...v,
    importance_score: toScore(v?.importance_score),
    confidence_score: toScore(v?.confidence_score),
    is_core: Boolean(v?.is_core),
  }));

  extracted.wisdom = asArray(extracted.wisdom).map((w) => ({
    ...w,
    confidence_score: toScore(w?.confidence_score),
    importance_score: toScore(w?.importance_score),
  }));

  extracted.threads = asArray(extracted.threads).map((t) => ({
    ...t,
    priority: toImportanceWord(t?.priority),
  }));

  return extracted;
}
