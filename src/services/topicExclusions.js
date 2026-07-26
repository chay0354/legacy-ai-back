/** Normalize / merge topic exclusions ("don't talk about X"). */

export function normalizeExclusion(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^["'“”]+|["'“”]+$/g, '');
  s = s.replace(/^(?:the|my|our|that|this)\s+/i, '');
  s = s.replace(/\s+(?:please|ok|okay|thanks|anymore|again|with you|right now|today)$/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 80) return '';
  if (
    /^(this|it|that|the question|this topic|this one|anything|everything|topic|question|subject|that one|stuff)$/i.test(
      s,
    )
  ) {
    return '';
  }
  return s;
}

export function normalizeExclusions(list) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const n = normalizeExclusion(item);
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

export function mergeExclusions(...lists) {
  return normalizeExclusions(lists.flatMap((l) => (Array.isArray(l) ? l : [])));
}

export function formatExclusionsPromptBlock(exclusions, { role = 'interviewer' } = {}) {
  const list = normalizeExclusions(exclusions);
  if (!list.length) return '';
  const lines = list.map((t, i) => `${i + 1}. ${t}`).join('\n');
  if (role === 'avatar') {
    return `TOPIC EXCLUSIONS (hard — from the person whose life you preserve):
${lines}
Never volunteer, expand, or tell stories about these. If a visitor asks, decline warmly ("I'd rather not go into that") and offer another direction. If they say "don't talk about X" during this conversation, honor that for the rest of the call too.`;
  }
  return `TOPIC EXCLUSIONS (hard — they asked not to discuss these):
${lines}
Never ask about, follow up on, bridge into, or re-open these. Acknowledge briefly if they raise an exclusion ("Of course — we can leave that alone"), then steer to a safe part of the current topic or move on. If the current topic IS an exclusion, call complete_anchor_question noting they asked to leave it alone.`;
}

/** True when exclusion keywords meaningfully overlap content text. */
export function contentMatchesExclusion(text, exclusion) {
  const hay = String(text || '').toLowerCase();
  const ex = normalizeExclusion(exclusion).toLowerCase();
  if (!hay || !ex) return false;
  if (hay.includes(ex)) return true;
  const stop = new Set(['the', 'a', 'an', 'my', 'our', 'about', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'his', 'her', 'their']);
  const tokens = ex.split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  if (!tokens.length) return false;
  const hits = tokens.filter((t) => hay.includes(t)).length;
  if (tokens.length === 1) return hits === 1;
  return hits >= Math.ceil(tokens.length * 0.6);
}

export function filterByExclusions(items, exclusions, textFn) {
  const list = normalizeExclusions(exclusions);
  if (!list.length || !Array.isArray(items)) return items || [];
  return items.filter((item) => {
    const text = textFn(item);
    return !list.some((ex) => contentMatchesExclusion(text, ex));
  });
}

export function exclusionsFromPersonality(personality) {
  const profile = personality?.profile || personality || {};
  return normalizeExclusions(profile.topic_exclusions || personality?.topic_exclusions || []);
}

/** Merge exclusions into personality.profile JSONB (creates row if needed). */
export async function persistTopicExclusionsSupabase(supabase, creatorId, exclusions) {
  const incoming = normalizeExclusions(exclusions);
  if (!incoming.length || !creatorId) return [];

  const { data: row } = await supabase
    .from('legacy_personality_profiles')
    .select('profile, favorite_phrases')
    .eq('creator_id', creatorId)
    .maybeSingle();

  const profile = row?.profile && typeof row.profile === 'object' ? { ...row.profile } : {};
  const merged = mergeExclusions(profile.topic_exclusions, incoming);
  profile.topic_exclusions = merged;

  const { error } = await supabase.from('legacy_personality_profiles').upsert({
    creator_id: creatorId,
    profile,
    favorite_phrases: row?.favorite_phrases || profile.favorite_phrases || [],
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  return merged;
}

export async function loadTopicExclusionsSupabase(supabase, creatorId) {
  if (!creatorId) return [];
  const { data } = await supabase
    .from('legacy_personality_profiles')
    .select('profile')
    .eq('creator_id', creatorId)
    .maybeSingle();
  return exclusionsFromPersonality(data);
}
