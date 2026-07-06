/** Normalize a memory title for duplicate detection. */
export function normalizeMemoryTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract first 4-digit year from text, if any. */
export function extractYearFromText(...texts) {
  for (const raw of texts) {
    if (!raw) continue;
    const match = String(raw).match(/\b(19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return '';
}

/** Stable key for deduping memories (same event ≈ same title + year). */
export function memoryDedupeKey(memory) {
  const year = String(memory?.year || '').trim() || extractYearFromText(memory?.summary, memory?.title);
  return `${year}|${normalizeMemoryTitle(memory?.title)}`;
}

/** Skip near-duplicate memories before insert (interview re-runs, overlapping sessions). */
export function filterNewMemories(incoming, existing = []) {
  const seen = new Set(existing.map((m) => memoryDedupeKey(m)));

  const fresh = [];
  for (const m of incoming || []) {
    const key = memoryDedupeKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(m);
  }
  return fresh;
}
