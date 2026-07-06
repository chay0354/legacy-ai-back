/**
 * Dry-run test: Foundation interview → AI extraction (no database writes).
 * Usage: node scripts/test-foundation-extraction.js
 */
import 'dotenv/config';
import { FOUNDATION_QUESTIONS } from '../src/foundationQuestions.js';
import { callClaudeJson } from '../src/services/anthropic.js';
import { getExtractionSystem, buildExtractionUserMessage } from '../src/services/extractionPrompt.js';
import { getCoverageCategoriesForStage, stageCompleteLevel } from '../src/interviewStages.js';

const CREATOR_NAME = 'Shimon';

/** Realistic sample answers for all 10 Foundation questions */
const SAMPLE_ANSWERS = [
  {
    category: 'identity',
    answer:
      "I'd want them to know I was a man who tried to be honest, even when it cost me. I wasn't famous — I was a teacher and a father. I loved my family more than anything, and I believed ordinary life, lived with integrity, is worth remembering.",
  },
  {
    category: 'family',
    answer:
      "I grew up in Haifa in the 1950s. My father Moshe worked at the port; my mother Rivka kept the house and sang while she cooked. We were four brothers in a small apartment — loud, crowded, and full of love. Friday nights were sacred.",
  },
  {
    category: 'childhood',
    answer:
      "My earliest memory is maybe age four — sitting on my father's shoulders watching the ships come into the harbor. He pointed and said, 'Everything that looks far away can still reach you.' I still think about that.",
  },
  {
    category: 'life_chapters',
    answer:
      "Chapter one: childhood in Haifa. Chapter two: army service, 1973 — that changed me. Chapter three: university and becoming a teacher in 1978. Chapter four: meeting my wife Dana in 1982. Chapter five: raising our three children. Chapter six: retirement and grandchildren since 2015.",
  },
  {
    category: 'relationships',
    answer:
      "My wife Dana is the center of my life. My brother Yitzhak — we talk every week. My teacher Eli Cohen changed how I see education. And my granddaughter Noa, born in 2018 — she makes me feel young again.",
  },
  {
    category: 'love_family',
    answer:
      "I met Dana at a friend's wedding in Tel Aviv in 1982. She spilled wine on my shirt and laughed instead of apologizing. We danced until midnight. We married in 1984 and built a home on patience and humor.",
  },
  {
    category: 'career',
    answer:
      "I taught history at a high school in Haifa for 35 years, from 1978 to 2013. I'm proudest of the students who said I made the past feel alive — and the ones who became teachers themselves.",
  },
  {
    category: 'values',
    answer:
      "Honesty first. Show up for people. Education is freedom. Family before ego. And never humiliate anyone — my father taught me that at the dinner table.",
  },
  {
    category: 'advice',
    answer:
      "Listen more than you speak. Repair relationships while you still can. Learn something every year. And tell the people you love that you love them — don't wait for a eulogy.",
  },
  {
    category: 'personality',
    answer:
      "Dry humor — I love a good pun and old Israeli comedy. I say 'Nu, so what do we do now?' when things get stuck, and 'Slowly slowly' when someone rushes. I laugh at my grandchildren's nonsense.",
  },
];

function buildAnswers() {
  return FOUNDATION_QUESTIONS.map((q, i) => ({
    questionIndex: i,
    question: q.q,
    category: q.category,
    answer: SAMPLE_ANSWERS[i].answer,
    skipped: false,
    mode: 'voice',
  }));
}

function scoreExtraction(extracted, stage) {
  const issues = [];
  const highlights = [];
  const categories = getCoverageCategoriesForStage(stage);
  const minLevel = stageCompleteLevel(stage);

  if (!extracted.session_summary?.trim()) issues.push('Missing session_summary');
  else highlights.push(`Summary: "${extracted.session_summary.slice(0, 120)}…"`);

  if ((extracted.avatar_level ?? 0) < minLevel) {
    issues.push(`avatar_level ${extracted.avatar_level} below expected ${minLevel}`);
  } else {
    highlights.push(`avatar_level: ${extracted.avatar_level}`);
  }

  if (typeof extracted.completion_score !== 'number' || extracted.completion_score < 1) {
    issues.push('completion_score missing or zero');
  } else {
    highlights.push(`completion_score: ${extracted.completion_score}%`);
  }

  const counts = {
    memories: extracted.memories?.length ?? 0,
    relationships: extracted.relationships?.length ?? 0,
    values: extracted.values?.length ?? 0,
    wisdom: extracted.wisdom?.length ?? 0,
    threads: extracted.threads?.length ?? 0,
  };

  if (counts.memories < 2) issues.push(`Only ${counts.memories} memories (expected several dated life events)`);
  else highlights.push(`${counts.memories} memories extracted`);

  if (counts.relationships < 2) issues.push(`Only ${counts.relationships} relationships (expected Dana, family, etc.)`);
  else highlights.push(`${counts.relationships} relationships extracted`);

  if (counts.values < 2) issues.push(`Only ${counts.values} values`);
  else highlights.push(`${counts.values} values extracted`);

  if (counts.wisdom < 1) issues.push('No wisdom/advice extracted');
  else highlights.push(`${counts.wisdom} wisdom items extracted`);

  const missingCoverage = categories.filter((c) => extracted.coverage?.[c] == null);
  if (missingCoverage.length) issues.push(`Missing coverage keys: ${missingCoverage.join(', ')}`);

  const datedMemories = (extracted.memories || []).filter((m) => m.year);
  if (datedMemories.length < 2) {
    issues.push(`Only ${datedMemories.length} memories have years (life chapters mention 1973, 1978, 1982…)`);
  } else {
    highlights.push(`${datedMemories.length} memories with years`);
  }

  const isFallback =
    counts.memories === 0 &&
    counts.relationships === 0 &&
    extracted.session_summary?.includes('detailed story extraction will run again');

  if (isFallback) issues.push('Looks like fallback extraction — AI JSON parse likely failed');

  return { issues, highlights, counts, passed: issues.length === 0 };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set in back/.env');
    process.exit(1);
  }

  const stage = 'foundation';
  const answers = buildAnswers();
  const name = CREATOR_NAME;

  console.log('=== Foundation interview extraction test ===');
  console.log(`Creator: ${name}`);
  console.log(`Questions answered: ${answers.length}`);
  console.log(`Model: ${process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'}`);
  console.log('Calling Claude for extraction (this may take 30–90s)…\n');

  const started = Date.now();
  let extracted;

  try {
    extracted = await callClaudeJson({
      system: getExtractionSystem(stage),
      userMessage: buildExtractionUserMessage(name, answers, stage),
      maxTokens: 16384,
    });
    extracted.avatar_level = Math.max(extracted.avatar_level ?? 0, stageCompleteLevel(stage));
  } catch (err) {
    console.error('EXTRACTION FAILED:', err.message);
    process.exit(1);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const { issues, highlights, counts, passed } = scoreExtraction(extracted, stage);

  console.log(`Done in ${elapsed}s\n`);
  console.log('--- Counts ---');
  console.log(JSON.stringify(counts, null, 2));

  console.log('\n--- Coverage ---');
  console.log(JSON.stringify(extracted.coverage, null, 2));

  console.log('\n--- Sample memories (up to 3) ---');
  for (const m of (extracted.memories || []).slice(0, 3)) {
    console.log(`• ${m.title}${m.year ? ` (${m.year})` : ''}: ${(m.summary || '').slice(0, 100)}…`);
  }

  console.log('\n--- Sample relationships (up to 3) ---');
  for (const r of (extracted.relationships || []).slice(0, 3)) {
    console.log(`• ${r.name} (${r.relationship_type}): ${(r.description || '').slice(0, 80)}…`);
  }

  console.log('\n--- Sample values ---');
  for (const v of (extracted.values || []).slice(0, 3)) {
    console.log(`• ${v.value_name}: ${(v.description || '').slice(0, 80)}`);
  }

  console.log('\n--- Sample wisdom ---');
  for (const w of (extracted.wisdom || []).slice(0, 2)) {
    console.log(`• ${w.title}: ${(w.advice_statement || '').slice(0, 100)}`);
  }

  console.log('\n--- Quality highlights ---');
  highlights.forEach((h) => console.log(`✓ ${h}`));

  if (issues.length) {
    console.log('\n--- Issues ---');
    issues.forEach((i) => console.log(`✗ ${i}`));
  }

  console.log('\n--- Full JSON (truncated) ---');
  const dump = { ...extracted };
  if (dump.memories?.length > 2) dump.memories = [...dump.memories.slice(0, 2), { _truncated: `${dump.memories.length - 2} more` }];
  console.log(JSON.stringify(dump, null, 2));

  console.log(`\n=== ${passed ? 'PASS' : 'FAIL'} ===`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
