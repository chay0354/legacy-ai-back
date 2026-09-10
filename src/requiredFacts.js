/**
 * Facts a family archive almost always needs. After the regular stage
 * questions, we add at most a few wrap-up topics — same tone as the rest —
 * only for what is still missing.
 */

const MAX_GAP_QUESTIONS = 3;

const NAME = String.raw`[A-ZÀ-ÖØ-ÞΑ-ΩА-Я\u0590-\u05FF][\p{L}'’\-]{1,40}`;

function textOf(answers = []) {
  return answers
    .map((a) => `${a.question || a.q || ''} ${a.answer || ''}`)
    .join('\n');
}

function relsOfType(relationships, types) {
  return (relationships || []).filter((r) => {
    const name = String(r.name || '').trim();
    if (name.length < 2) return false;
    const t = String(r.relationship_type || '').toLowerCase();
    return types.some((x) => t.includes(x));
  });
}

function named(pattern, text) {
  try {
    return pattern.test(text);
  } catch {
    return false;
  }
}

const CHILD_TYPES = ['child', 'son', 'daughter', 'kid', 'stepson', 'stepdaughter'];
const SPOUSE_TYPES = ['spouse', 'husband', 'wife', 'partner', 'fiancé', 'fiance'];
const PARENT_TYPES = ['mother', 'father', 'mom', 'dad', 'parent', 'stepmother', 'stepfather'];
const SIBLING_TYPES = ['sibling', 'brother', 'sister'];

export const REQUIRED_FACTS = [
  {
    id: 'children',
    category: 'facts_children',
    module: 'Family',
    q: 'Tell me about your children — whether you have any, how many, and their names.',
    digFor: 'whether they have children; if yes, how many and each child’s name',
    covered(text, relationships) {
      if (relsOfType(relationships, CHILD_TYPES).length) return true;
      if (/\b(no|never had|didn'?t have|don'?t have|do not have)\s+(any\s+)?(kids|children|child)\b/i.test(text)) return true;
      if (/\b(childless|no children|no kids)\b/i.test(text)) return true;
      if (/(אין לי ילדים|בלי ילדים|לא היו לי ילדים)/.test(text)) return true;
      if (/(הבן שלי|הבת שלי|הילדים שלי)\s+\S+/.test(text)) return true;
      return named(
        new RegExp(
          String.raw`\b((my|our)\s+(son|daughter|boy|girl)\s+${NAME}|(son|daughter|child)\s+(named|called)\s+${NAME}|(children|kids|sons|daughters)\s+(are|were|:)\s+${NAME})`,
          'iu',
        ),
        text,
      );
    },
  },
  {
    id: 'spouse',
    category: 'facts_spouse',
    module: 'Family',
    q: 'Is there a spouse or partner we should know — and what is their name?',
    digFor: 'whether there is a spouse or partner; their name if there is one',
    covered(text, relationships) {
      if (relsOfType(relationships, SPOUSE_TYPES).length) return true;
      if (/\b(never married|not married|unmarried|no (husband|wife|spouse|partner)|didn'?t marry)\b/i.test(text)) return true;
      if (/(לא נשוי|לא נשואה|מעולם לא התחתנ)/.test(text)) return true;
      if (/(בעלי|אשתי|בן הזוג שלי|בת הזוג שלי)\s+\S+/.test(text)) return true;
      return named(
        new RegExp(
          String.raw`\b((my|our)\s+(husband|wife|spouse|partner|fiancé|fiancee?)\s+${NAME}|(husband|wife|spouse|partner)\s+(named|called)\s+${NAME})`,
          'iu',
        ),
        text,
      );
    },
  },
  {
    id: 'parents',
    category: 'facts_parents',
    module: 'Family',
    q: 'What were your parents’ names — your mother and your father, if you want to say?',
    digFor: 'mother’s and/or father’s names, or that they never knew them',
    covered(text, relationships) {
      if (relsOfType(relationships, PARENT_TYPES).length) return true;
      if (/\b(never knew (my )?(parents|mother|father)|don'?t remember (my )?(parents|mother|father)'?s? names?)\b/i.test(text)) return true;
      if (/(לא הכרתי את ההורים|לא זוכר את השמות של ההורים)/.test(text)) return true;
      if (/(אמא שלי|אבא שלי)\s+\S+/.test(text)) return true;
      return named(
        new RegExp(
          String.raw`\b((my\s+)?(mother|mom|mum|mama|father|dad|papa)\s+${NAME}|(mother|mom|mum|father|dad)\s+(was|is)\s+(called|named)\s+${NAME})`,
          'iu',
        ),
        text,
      );
    },
  },
  {
    id: 'hometown',
    category: 'facts_hometown',
    module: 'Origins',
    q: 'Where did you grow up — the place that felt like home?',
    digFor: 'a town, city, or region they name as home',
    covered(text) {
      if (/(גדלתי ב|נולדתי ב|באתי מ)\s+\S+/.test(text)) return true;
      return named(
        new RegExp(
          String.raw`\b(grew up in|was raised in|born in|from|hometown (is|was)|home was in)\s+${NAME}`,
          'iu',
        ),
        text,
      );
    },
  },
  {
    id: 'siblings',
    category: 'facts_siblings',
    module: 'Family',
    q: 'Did you grow up with brothers or sisters? What were their names, if you’d like to say?',
    digFor: 'whether they had siblings, and names if they share them',
    covered(text, relationships) {
      if (relsOfType(relationships, SIBLING_TYPES).length) return true;
      if (/\b(only child|no (brothers|sisters|siblings)|didn'?t have (any )?(brothers|sisters|siblings))\b/i.test(text)) return true;
      if (/(ילד יחיד|ילדה יחידה|אין לי אחים|אין לי אחיות)/.test(text)) return true;
      if (/(אח שלי|אחות שלי)\s+\S+/.test(text)) return true;
      return named(
        new RegExp(
          String.raw`\b((my|our)\s+(brother|sister)\s+${NAME}|(brother|sister)\s+(named|called)\s+${NAME}|(brothers|sisters|siblings)\s+(are|were|:)\s+${NAME})`,
          'iu',
        ),
        text,
      );
    },
  },
];

export function missingRequiredFacts(answers, relationships = []) {
  const text = textOf(answers);
  return REQUIRED_FACTS.filter((fact) => !fact.covered(text, relationships));
}

/** At most a few wrap-up topics, same shape as stage questions. */
export function buildGapFillQuestions({ answers = [], relationships = [], max = MAX_GAP_QUESTIONS } = {}) {
  return missingRequiredFacts(answers, relationships)
    .slice(0, max)
    .map((fact) => ({
      q: fact.q,
      digFor: fact.digFor,
      module: fact.module,
      category: fact.category,
    }));
}

/**
 * Once every core topic has an answer, append missing-fact wrap-ups.
 * Gap list is computed only from core answers so later wrap-ups stay stable.
 */
export function withGapFillQuestions(coreQuestions, savedAnswers = [], relationships = []) {
  const core = coreQuestions || [];
  const coreLen = core.length;
  const coreAnswers = (savedAnswers || []).filter((a) => {
    const idx = a.question_index ?? a.questionIndex;
    return idx == null || idx < coreLen;
  });
  const coreCovered = core.every((_, i) =>
    (savedAnswers || []).some((a) => (a.question_index ?? a.questionIndex) === i),
  );
  if (!coreCovered) return core;

  const locked = (savedAnswers || [])
    .filter((a) => (a.question_index ?? a.questionIndex) >= coreLen)
    .sort((a, b) => (a.question_index ?? a.questionIndex) - (b.question_index ?? b.questionIndex));

  if (locked.length) {
    return [
      ...core,
      ...locked.map((a) => ({
        q: a.question,
        digFor: 'Listen for names, counts, and places they mention.',
        module: 'Family',
        category: 'facts_followup',
      })),
    ];
  }

  return [...core, ...buildGapFillQuestions({ answers: coreAnswers, relationships })];
}
