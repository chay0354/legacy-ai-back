import { callClaudeJson } from './anthropic.js';
import { getExtractionSystem, buildExtractionUserMessage } from './extractionPrompt.js';
import { saveExtractionPg } from '../db/legacyRepo.js';
import { getCoverageCategoriesForStage, stageCompleteLevel } from '../interviewStages.js';
import { filterNewMemories } from './memoryDedupe.js';

function normalizeAnswers(answers) {
  return (answers || []).map((a, i) => ({
    questionIndex: a.question_index ?? a.questionIndex ?? i,
    question: a.question ?? '',
    answer: a.answer ?? '',
    category: a.category ?? 'general',
    skipped: Boolean(a.skipped),
    mode: a.answer_mode ?? a.mode ?? 'text',
  }));
}

function buildFallbackExtraction(answers, creatorName, stage) {
  const minLevel = stageCompleteLevel(stage);
  const categories = getCoverageCategoriesForStage(stage);
  const coverage = Object.fromEntries(categories.map((c) => [c, 35]));
  const answered = answers.filter((a) => a.answer?.trim() && !a.skipped);

  return {
    session_summary: `${creatorName} finished the ${stage} interview with ${answered.length} answer${answered.length === 1 ? '' : 's'} recorded. We saved your responses; detailed story extraction will run again soon.`,
    recommended_next_topics: [],
    coverage,
    completion_score: Math.min(33, 10 + answered.length * 3),
    avatar_level: minLevel,
    memories: [],
    relationships: [],
    values: [],
    wisdom: [],
    threads: [],
    personality: {},
  };
}

async function fetchExistingMemories(supabase, creatorId) {
  const { data, error } = await supabase
    .from('legacy_memories')
    .select('title, year, summary')
    .eq('creator_id', creatorId);
  if (error) throw error;
  return data || [];
}

async function saveExtractionSupabase(supabase, creatorId, sessionId, extracted, stage = 'foundation') {
  if (extracted.memories?.length) {
    const existing = await fetchExistingMemories(supabase, creatorId);
    const memories = filterNewMemories(extracted.memories, existing);
    extracted.memories = memories;

    if (memories.length) {
    const rows = memories.map((m) => ({
      creator_id: creatorId,
      session_id: sessionId,
      title: m.title,
      summary: m.summary,
      full_transcript: m.full_transcript,
      category: m.category,
      tags: m.tags || [],
      people_involved: m.people_involved || [],
      location: m.location,
      age: m.age,
      year: m.year,
      year_confidence: m.year_confidence,
      emotional_significance: m.emotional_significance,
      lesson_learned: m.lesson_learned,
      importance: m.importance || 'medium',
      metadata: {},
    }));
    const { error } = await supabase.from('legacy_memories').insert(rows);
    if (error) throw error;
    }
  }

  if (extracted.relationships?.length) {
    const rows = extracted.relationships.map((r) => ({
      creator_id: creatorId,
      name: r.name,
      relationship_type: r.relationship_type,
      description: r.description,
      importance_score: r.importance_score ?? 50,
      influence_score: r.influence_score ?? 50,
      emotional_tone: r.emotional_tone,
      relationship_summary: r.relationship_summary,
      metadata: {},
    }));
    const { error } = await supabase.from('legacy_relationships').insert(rows);
    if (error) throw error;
  }

  if (extracted.values?.length) {
    const rows = extracted.values.map((v) => ({
      creator_id: creatorId,
      value_name: v.value_name,
      description: v.description,
      importance_score: v.importance_score ?? 50,
      confidence_score: v.confidence_score ?? 50,
      supporting_stories: v.supporting_stories || [],
      origin_story: v.origin_story,
      is_core: v.is_core ?? false,
      metadata: {},
    }));
    const { error } = await supabase.from('legacy_values').insert(rows);
    if (error) throw error;
  }

  if (extracted.wisdom?.length) {
    const rows = extracted.wisdom.map((w) => ({
      creator_id: creatorId,
      title: w.title,
      advice_statement: w.advice_statement,
      life_category: w.life_category,
      supporting_story: w.supporting_story,
      supporting_value: w.supporting_value,
      confidence_score: w.confidence_score ?? 50,
      importance_score: w.importance_score ?? 50,
      metadata: {},
    }));
    const { error } = await supabase.from('legacy_wisdom').insert(rows);
    if (error) throw error;
  }

  if (extracted.threads?.length) {
    const rows = extracted.threads.map((t) => ({
      creator_id: creatorId,
      session_id: sessionId,
      title: t.title,
      origin_statement: t.origin_statement,
      priority: t.priority || 'medium',
      category: t.category,
      status: 'open',
      related_people: t.related_people || [],
      metadata: {},
    }));
    const { error } = await supabase.from('legacy_threads').insert(rows);
    if (error) throw error;
  }

  if (extracted.coverage) {
    for (const [cat, score] of Object.entries(extracted.coverage)) {
      const { error } = await supabase.from('legacy_coverage').upsert(
        { creator_id: creatorId, category: cat, score, updated_at: new Date().toISOString() },
        { onConflict: 'creator_id,category' }
      );
      if (error) throw error;
    }
  }

  if (extracted.personality) {
    const { error } = await supabase.from('legacy_personality_profiles').upsert({
      creator_id: creatorId,
      profile: extracted.personality,
      favorite_phrases: extracted.personality.favorite_phrases || [],
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  const { error: sessionUpdErr } = await supabase
    .from('legacy_interview_sessions')
    .update({
      status: 'processed',
      session_summary: { text: extracted.session_summary },
      recommended_next_topics: extracted.recommended_next_topics || [],
    })
    .eq('id', sessionId);
  if (sessionUpdErr) throw sessionUpdErr;

  const { data: existingCreator } = await supabase
    .from('legacy_creators')
    .select('avatar_level, completion_score')
    .eq('id', creatorId)
    .maybeSingle();

  const minLevel = stageCompleteLevel(stage);
  const newLevel = Math.max(existingCreator?.avatar_level ?? 0, extracted.avatar_level ?? minLevel, minLevel);
  const newScore = Math.max(existingCreator?.completion_score ?? 0, extracted.completion_score ?? 0);

  const { error: creatorUpdErr } = await supabase
    .from('legacy_creators')
    .update({
      avatar_level: newLevel,
      completion_score: newScore,
      updated_at: new Date().toISOString(),
    })
    .eq('id', creatorId);
  if (creatorUpdErr) throw creatorUpdErr;
}

export async function processInterviewSession({ supabase, pgMode, sessionId, creatorId, creatorName, answers, stage = 'foundation' }) {
  const normalized = normalizeAnswers(answers);
  if (!normalized.length) throw new Error('No answers to process');

  const name = creatorName || 'Creator';
  const minLevel = stageCompleteLevel(stage);

  let extracted;
  try {
    extracted = await callClaudeJson({
      system: getExtractionSystem(stage),
      userMessage: buildExtractionUserMessage(name, normalized, stage),
      maxTokens: 16384,
    });
  } catch (err) {
    console.error('[interviewProcessor] extraction failed, using fallback:', err.message);
    extracted = buildFallbackExtraction(normalized, name, stage);
  }

  extracted.avatar_level = Math.max(extracted.avatar_level ?? minLevel, minLevel);

  if (pgMode) {
    await saveExtractionPg(creatorId, sessionId, extracted);
  } else {
    await saveExtractionSupabase(supabase, creatorId, sessionId, extracted, stage);
  }

  return {
    session_summary: extracted.session_summary,
    recommended_next_topics: extracted.recommended_next_topics,
    coverage: extracted.coverage,
    completion_score: extracted.completion_score,
    avatar_level: extracted.avatar_level,
    counts: {
      memories: extracted.memories?.length ?? 0,
      relationships: extracted.relationships?.length ?? 0,
      values: extracted.values?.length ?? 0,
      wisdom: extracted.wisdom?.length ?? 0,
      threads: extracted.threads?.length ?? 0,
    },
  };
}
