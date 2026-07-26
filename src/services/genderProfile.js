/** Explicit gender/pronouns — never infer from display name. */

const GENDER_VALUES = new Set(['female', 'male', 'non_binary', 'unspecified', 'prefer_not_to_say']);

const PRONOUN_PRESETS = {
  'she/her': { subject: 'she', object: 'her', possessive: 'her' },
  'he/him': { subject: 'he', object: 'him', possessive: 'his' },
  'they/them': { subject: 'they', object: 'them', possessive: 'their' },
};

export function normalizeGender(raw) {
  const g = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!g) return null;
  if (g === 'woman' || g === 'f' || g === 'female') return 'female';
  if (g === 'man' || g === 'm' || g === 'male') return 'male';
  if (g === 'non-binary' || g === 'nonbinary' || g === 'nb' || g === 'non_binary') return 'non_binary';
  if (g === 'prefer_not_to_say' || g === 'prefer-not-to-say' || g === 'prefer_not') return 'prefer_not_to_say';
  if (g === 'unspecified' || g === 'unknown' || g === 'other') return 'unspecified';
  return GENDER_VALUES.has(g) ? g : null;
}

export function normalizePronouns(raw) {
  const p = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!p) return null;
  if (p === 'she/her' || p === 'she' || p === 'her') return 'she/her';
  if (p === 'he/him' || p === 'he' || p === 'him') return 'he/him';
  if (p === 'they/them' || p === 'they' || p === 'them') return 'they/them';
  // Allow short custom strings (e.g. "she/they")
  if (p.length <= 40 && /^[a-z/'\- ]+$/i.test(p)) return p;
  return null;
}

/** Infer default pronouns from gender only when pronouns unset — still never from name. */
export function defaultPronounsForGender(gender) {
  const g = normalizeGender(gender);
  if (g === 'female') return 'she/her';
  if (g === 'male') return 'he/him';
  if (g === 'non_binary') return 'they/them';
  return null;
}

export function resolveIdentity({ gender, pronouns } = {}) {
  const g = normalizeGender(gender);
  const p = normalizePronouns(pronouns) || defaultPronounsForGender(g);
  return { gender: g, pronouns: p };
}

export function formatIdentityPromptBlock({ name, gender, pronouns } = {}) {
  const id = resolveIdentity({ gender, pronouns });
  const lines = [`- Preferred / display name: ${name || 'this person'}`];

  if (id.gender && id.gender !== 'unspecified' && id.gender !== 'prefer_not_to_say') {
    lines.push(`- Gender (explicit profile): ${id.gender}`);
  } else if (id.gender === 'prefer_not_to_say') {
    lines.push('- Gender: prefer not to say');
  } else {
    lines.push('- Gender: UNKNOWN (not set on profile)');
  }

  if (id.pronouns) {
    lines.push(`- Pronouns (explicit profile): ${id.pronouns}`);
    const forms = PRONOUN_PRESETS[id.pronouns];
    if (forms) {
      lines.push(`- When referring in third person use: ${forms.subject}/${forms.object}/${forms.possessive}`);
    }
    lines.push(
      `- HARD RULE: In third person use ONLY ${id.pronouns}. Do not switch to he/him or she/her unless those are the explicit pronouns above.`,
    );
  } else {
    lines.push('- Pronouns: UNKNOWN (not set on profile)');
    lines.push(
      '- HARD RULE: Pronouns are UNKNOWN — NEVER use he/him/his or she/her/hers. Use they/them/their, second person ("you"), or the person\'s name. Do not guess.',
    );
  }

  lines.push(
    '- HARD RULE: Never infer gender or pronouns from the name, face, voice, or accent. Names like Yael, Alex, Jordan, etc. must NOT change pronouns. Only the explicit fields above count.',
  );

  return lines.join('\n');
}

/** Load gender/pronouns from creator columns, else personality.profile. */
export async function loadCreatorIdentity(supabase, creatorId) {
  if (!supabase || !creatorId) {
    return { displayName: null, gender: null, pronouns: null };
  }

  try {
    const { data, error } = await supabase
      .from('legacy_creators')
      .select('display_name, gender, pronouns')
      .eq('id', creatorId)
      .maybeSingle();
    if (!error && data) {
      return {
        displayName: data.display_name || null,
        ...resolveIdentity({ gender: data.gender, pronouns: data.pronouns }),
      };
    }
  } catch {
    /* columns may be missing */
  }

  const { data: creator } = await supabase
    .from('legacy_creators')
    .select('display_name')
    .eq('id', creatorId)
    .maybeSingle();
  const { data: personality } = await supabase
    .from('legacy_personality_profiles')
    .select('profile')
    .eq('creator_id', creatorId)
    .maybeSingle();
  const profile = personality?.profile && typeof personality.profile === 'object' ? personality.profile : {};
  return {
    displayName: creator?.display_name || null,
    ...resolveIdentity({ gender: profile.gender, pronouns: profile.pronouns }),
  };
}

/** Persist gender/pronouns to creator columns when available; always mirror into personality.profile. */
export async function saveCreatorIdentity(supabase, creatorId, { gender, pronouns } = {}) {
  const id = resolveIdentity({ gender, pronouns });
  let savedToCreator = false;
  try {
    const { error } = await supabase
      .from('legacy_creators')
      .update({
        gender: id.gender,
        pronouns: id.pronouns,
        updated_at: new Date().toISOString(),
      })
      .eq('id', creatorId);
    if (!error) savedToCreator = true;
  } catch {
    /* columns may be missing */
  }

  const { data: existing } = await supabase
    .from('legacy_personality_profiles')
    .select('profile, favorite_phrases')
    .eq('creator_id', creatorId)
    .maybeSingle();
  const profile = existing?.profile && typeof existing.profile === 'object' ? { ...existing.profile } : {};
  profile.gender = id.gender;
  profile.pronouns = id.pronouns;
  const { error: persErr } = await supabase.from('legacy_personality_profiles').upsert({
    creator_id: creatorId,
    profile,
    favorite_phrases: existing?.favorite_phrases || profile.favorite_phrases || [],
    updated_at: new Date().toISOString(),
  });
  if (persErr) throw persErr;
  return { ...id, savedToCreator };
}
