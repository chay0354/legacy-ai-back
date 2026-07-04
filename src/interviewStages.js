import { FOUNDATION_QUESTIONS, COVERAGE_CATEGORIES as FOUNDATION_CATEGORIES } from './foundationQuestions.js';
import { ENRICHED_QUESTIONS, ENRICHED_COVERAGE_CATEGORIES } from './enrichedQuestions.js';
import { LEGACY_QUESTIONS, LEGACY_COVERAGE_CATEGORIES } from './legacyQuestions.js';

export const STAGE_ORDER = ['foundation', 'enriched', 'legacy'];

/** avatar_level after each stage is fully processed */
export const STAGE_COMPLETE_LEVEL = {
  foundation: 1,
  enriched: 2,
  legacy: 3,
};

const STAGE_CONFIG = {
  foundation: {
    label: 'Foundation Interview',
    shortLabel: 'Foundation',
    goal: 'Breadth — the first usable avatar',
    questions: FOUNDATION_QUESTIONS,
    coverageCategories: FOUNDATION_CATEGORIES,
  },
  enriched: {
    label: 'Enriched Interview',
    shortLabel: 'Enriched',
    goal: 'Depth — stories, relationships, and wisdom',
    questions: ENRICHED_QUESTIONS,
    coverageCategories: ENRICHED_COVERAGE_CATEGORIES,
  },
  legacy: {
    label: 'Legacy Interview',
    shortLabel: 'Legacy',
    goal: 'Meaning — worldview, personality, and conscious legacy',
    questions: LEGACY_QUESTIONS,
    coverageCategories: LEGACY_COVERAGE_CATEGORIES,
  },
};

export function getStageConfig(stage) {
  return STAGE_CONFIG[stage] || STAGE_CONFIG.foundation;
}

export function getQuestionsForStage(stage) {
  return getStageConfig(stage).questions;
}

export function getCoverageCategoriesForStage(stage) {
  return getStageConfig(stage).coverageCategories;
}

export function stageCompleteLevel(stage) {
  return STAGE_COMPLETE_LEVEL[stage] ?? 1;
}

export function nextStage(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx >= 0 && idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : null;
}

/** Which stage the creator should work on next (null = all complete). */
export function resolveInterviewStage(creator, requestedStage) {
  const level = creator?.avatar_level ?? 0;

  if (requestedStage && STAGE_ORDER.includes(requestedStage)) {
    const reqIdx = STAGE_ORDER.indexOf(requestedStage);
    const maxIdx = Math.min(level, STAGE_ORDER.length - 1);
    if (reqIdx <= maxIdx) return requestedStage;
  }

  if (level >= STAGE_COMPLETE_LEVEL.legacy) return null;
  if (level >= STAGE_COMPLETE_LEVEL.enriched) return 'legacy';
  if (level >= STAGE_COMPLETE_LEVEL.foundation) return 'enriched';
  return 'foundation';
}

export function computeResumeIndex(savedAnswers, questions) {
  const answeredIndices = new Set((savedAnswers || []).map((a) => a.question_index));
  let resumeIndex = 0;
  for (let i = 0; i < questions.length; i++) {
    if (!answeredIndices.has(i)) {
      resumeIndex = i;
      break;
    }
    resumeIndex = Math.min(i + 1, questions.length - 1);
  }
  return savedAnswers?.length ? resumeIndex : 0;
}

export function buildSessionPayload({ session, creator, stage, savedAnswers }) {
  const config = getStageConfig(stage);
  const questions = config.questions;
  return {
    session,
    creator,
    stage,
    stageLabel: config.shortLabel,
    stageGoal: config.goal,
    questions: questions.map((q) => ({ q: q.q })),
    questionMeta: questions,
    savedAnswers: savedAnswers || [],
    resumeIndex: computeResumeIndex(savedAnswers, questions),
    stages: STAGE_ORDER.map((s) => ({
      id: s,
      label: getStageConfig(s).shortLabel,
      done: (creator.avatar_level ?? 0) >= stageCompleteLevel(s),
      current: s === stage,
    })),
  };
}
