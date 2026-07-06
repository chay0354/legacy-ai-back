import { callClaude, parseJsonFromClaude } from './anthropic.js';

const STAGE_GOALS = {
  foundation: 'Breadth — identity, family, chapters, relationships, values, advice, personality. One gentle door at a time.',
  enriched: 'Depth — meaningful stories, relationships, and wisdom. Follow threads before moving on.',
  legacy: 'Meaning — values, gratitude, legacy intent. Slow, reflective, silence is welcome.',
};

function buildSystem(stage, subjectName) {
  return `You are Legacy AI — a warm, patient interviewer preserving ${subjectName}'s life story for their family.

Stage: ${stage}. ${STAGE_GOALS[stage] || STAGE_GOALS.foundation}

You manage ONE anchor question at a time. You:
- Speak naturally, like a calm person in the room — never robotic or form-like
- After you ask something, STOP and wait. Never answer your own question or keep talking
- Acknowledge what they shared before asking more
- Ask ONE follow-up at a time when the anchor needs depth
- Use brief transitions only when moving to the next topic
- Never invent facts they did not say
- Keep "speak" under 2–3 sentences

CRITICAL pacing rules:
- advance MUST stay false until they have actually spoken and you have enough substance
- Do NOT rush to the next topic — most anchors need 2–4 exchanges
- If they just started, ask a gentle follow-up instead of advancing
- Only set advance:true when they clearly have nothing more to add OR you have rich content for this anchor

Return ONLY valid JSON:
{
  "speak": "What you say aloud next",
  "advance": false,
  "answerSummary": "Consolidated answer for the anchor question so far (empty string if nothing yet)"
}`;
}

function buildUserMessage({
  subjectName,
  stage,
  anchorQuestion,
  questionIndex,
  totalQuestions,
  turns,
  userTranscript,
  isOpening,
}) {
  const history = (turns || [])
    .map((t) => `${t.role === 'assistant' ? 'You' : subjectName}: ${t.text}`)
    .join('\n');

  if (isOpening) {
    return `Start the ${stage} interview. Anchor question ${questionIndex + 1} of ${totalQuestions}:
"${anchorQuestion}"

Greet ${subjectName} briefly (one sentence), then ask this question in your own warm words.
Do NOT advance. answerSummary must be empty string.`;
  }

  return `Anchor question ${questionIndex + 1} of ${totalQuestions}:
"${anchorQuestion}"

Conversation so far:
${history || '(none)'}

${subjectName} just said:
"${userTranscript}"

Respond as the interviewer. Update answerSummary with everything they've shared for this anchor question.
Remember: advance:false unless they have clearly finished this topic with enough detail.`;
}

function isSkipIntent(text) {
  return /\b(skip|pass|next question|move on|don't know|not sure|nothing to add|that's all)\b/i.test(text || '');
}

function countUserWords(turns, userTranscript) {
  const parts = (turns || [])
    .filter((t) => t.role === 'user')
    .map((t) => t.text || '');
  if (userTranscript) parts.push(userTranscript);
  return parts.join(' ').trim().split(/\s+/).filter(Boolean).length;
}

function userTurnCount(turns, userTranscript) {
  let n = (turns || []).filter((t) => t.role === 'user').length;
  if (userTranscript?.trim()) n += 1;
  return n;
}

/** Server-side guardrails so the AI cannot skip ahead before the person speaks. */
function guardAdvance({ advance, isOpening, turns, userTranscript, stage }) {
  if (isOpening) return false;

  const turnsCount = userTurnCount(turns, userTranscript);
  const words = countUserWords(turns, userTranscript);

  if (turnsCount === 0) return false;
  if (isSkipIntent(userTranscript)) return true;

  const minTurns = stage === 'foundation' ? 2 : 1;
  const minWords = stage === 'legacy' ? 25 : stage === 'enriched' ? 30 : 20;

  if (turnsCount < minTurns && words < minWords) return false;
  if (words < 12 && !advance) return false;

  return Boolean(advance);
}

export async function conductorTurn(params) {
  const raw = await callClaude({
    system: buildSystem(params.stage || 'foundation', params.subjectName || 'Friend'),
    userMessage: buildUserMessage(params),
    maxTokens: 1024,
  });
  const text = typeof raw === 'string' ? raw : raw.text;

  let parsed;
  try {
    parsed = parseJsonFromClaude(text);
  } catch {
    throw new Error('Interviewer returned invalid response');
  }

  const speak = String(parsed.speak || '').trim() || 'Take your time — I am listening.';
  const answerSummary = String(parsed.answerSummary || '').trim();
  const advance = guardAdvance({
    advance: Boolean(parsed.advance),
    isOpening: Boolean(params.isOpening),
    turns: params.turns,
    userTranscript: params.userTranscript,
    stage: params.stage || 'foundation',
  });

  return { speak, advance, answerSummary };
}
