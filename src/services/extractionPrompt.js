import { getCoverageCategoriesForStage, stageCompleteLevel } from '../interviewStages.js';

const STAGE_PROMPTS = {
  foundation: {
    title: 'Foundation Avatar',
    focus: 'Breadth, not depth — the first usable avatar. Extract identity, origins, chapters, relationships, values, advice, and basic personality.',
    avatarLevelRule: 'Set avatar_level to 1 when Foundation requirements are met (identity, family, life chapters, relationships, values, advice, basic personality have reasonable coverage).',
    targetLevel: 1,
  },
  enriched: {
    title: 'Enriched Avatar',
    focus: 'Depth through meaningful stories, relationships, and wisdom. Extract rich memories with scene/emotion/meaning, deepen relationships, and pull wisdom from lived experience.',
    avatarLevelRule: 'Set avatar_level to 2 when Enriched requirements are met (at least 2 deep stories, 2 meaningful relationships, and wisdom extracted from experience).',
    targetLevel: 2,
  },
  legacy: {
    title: 'Legacy Avatar',
    focus: 'The deepest layer — worldview, personality, difficult memories, and conscious legacy. Extract values-in-action, personality traits, gratitude, hope, and legacy intent.',
    avatarLevelRule: 'Set avatar_level to 3 when Legacy requirements are met (legacy anchors answered: what to remember, family identity, life summary, gratitude, and hope).',
    targetLevel: 3,
  },
};

function coverageSchema(categories) {
  const entries = categories.map((c) => `    "${c}": 0-100`).join(',\n');
  return `{\n${entries}\n  }`;
}

export function getExtractionSystem(stage = 'foundation') {
  const config = STAGE_PROMPTS[stage] || STAGE_PROMPTS.foundation;
  const categories = getCoverageCategoriesForStage(stage);
  const targetLevel = stageCompleteLevel(stage);

  return `You are the Legacy AI knowledge extraction engine. Your job is to transform a ${config.title} interview into structured legacy knowledge.

Stage focus: ${config.focus}

Follow the Legacy Interview Blueprint principles:
- Preserve identity, not just facts. Extract stories, relationships, values, wisdom, and personality.
- Story first: every meaningful answer may contain memories worth preserving.
- Detect threads: anything interesting the interviewer should revisit later.
- Coverage is based on whether meaningful questions CAN be answered, not whether all fields are filled.
- Never invent facts. Only extract what the creator actually said.
- Do not enrich thin answers with plausible details. If they did not name a person, place, year, or event, leave those fields empty or omit the memory.
- answer summaries and memory titles must stay faithful to their words — no dramatization.
- Pronouns (CRITICAL): Never infer gender or pronouns from the creator's name. Use ONLY the explicit profile pronouns provided in the user message (she/her or he/him). If pronouns are UNKNOWN, rephrase with "you" or the name — never invent pronouns. Do not invent gender or pronouns in personality.
- When the creator mentions a year or when something happened (e.g. "in 1977", "back in '58"), always set memory.year to the 4-digit year and year_confidence to exact or approximate. Create a separate memory for each distinct dated life event.
- The life timeline is built ONLY from saved memories. Every dated life event must live in the memories array — not in relationships, values, wisdom, or threads alone.
- Do not duplicate memories: one memory per distinct event. If the same story was captured in a prior session, skip it. Do not re-insert the same title+year or the same story with slightly different wording.
- Preserve contradictions if present — do not resolve them.
- Assign importance: low | medium | high | critical for stories and relationships.

Return ONLY valid JSON matching this exact schema (no markdown fences, no text before or after the JSON object):
{
  "session_summary": "2-3 sentence summary of what was learned this session",
  "recommended_next_topics": ["topic1", "topic2"],
  "coverage": ${coverageSchema(categories)},
  "completion_score": 0-100,
  "avatar_level": ${targetLevel},
  "memories": [{
    "title": "",
    "summary": "",
    "full_transcript": "",
    "category": "",
    "tags": [],
    "people_involved": [],
    "location": null,
    "age": null,
    "year": null,
    "year_confidence": "exact|approximate|unknown",
    "emotional_significance": "",
    "lesson_learned": "",
    "importance": "low|medium|high|critical"
  }],
  "relationships": [{
    "name": "",
    "relationship_type": "",
    "description": "",
    "importance_score": 0-100,
    "influence_score": 0-100,
    "emotional_tone": "",
    "relationship_summary": ""
  }],
  "values": [{
    "value_name": "",
    "description": "",
    "importance_score": 0-100,
    "confidence_score": 0-100,
    "supporting_stories": [],
    "origin_story": "",
    "is_core": false
  }],
  "wisdom": [{
    "title": "",
    "advice_statement": "",
    "life_category": "",
    "supporting_story": "",
    "supporting_value": "",
    "confidence_score": 0-100,
    "importance_score": 0-100
  }],
  "threads": [{
    "title": "",
    "origin_statement": "",
    "priority": "low|medium|high|critical",
    "category": "",
    "related_people": []
  }],
  "personality": {
    "humor_style": "",
    "communication_style": "",
    "emotional_style": "",
    "decision_making_style": "",
    "favorite_phrases": [],
    "storytelling_style": "",
    "traits": {},
    "topic_exclusions": []
  }
}

${config.avatarLevelRule} Always set avatar_level to at least ${targetLevel} when this ${config.title} session is complete with meaningful answers. completion_score is overall legacy completeness (Foundation ~33%, Enriched ~66%, Legacy ~100% when all stages done).`;
}

/** @deprecated use getExtractionSystem('foundation') */
export const EXTRACTION_SYSTEM = getExtractionSystem('foundation');

export function buildExtractionUserMessage(
  creatorName,
  answers,
  stage = 'foundation',
  { gender = null, pronouns = null } = {},
) {
  const config = STAGE_PROMPTS[stage] || STAGE_PROMPTS.foundation;
  const transcript = answers
    .map((a, i) => `Q${i + 1} [${a.category || 'general'}]: ${a.question}\nA: ${a.skipped ? '(skipped)' : (a.answer || '(no answer)')}`)
    .join('\n\n');

  const genderLine = gender || 'UNKNOWN (not set)';
  const pronounsLine = pronouns
    || 'UNKNOWN — use second person or the name; do not invent he/him or she/her';

  return `Creator name: ${creatorName}
Explicit profile gender: ${genderLine}
Explicit profile pronouns: ${pronounsLine}
(Never guess pronouns from the name. All extracted text that refers to the creator in third person must follow these pronouns.)

${config.title} transcript:
${transcript}

Extract all structured legacy knowledge from this interview. Be thorough but faithful to what was actually said.
If they said not to talk about / discuss / bring up certain subjects, list short labels in personality.topic_exclusions.
Do NOT put gender or pronouns into personality — those are set only via the explicit profile fields above.`;
}
