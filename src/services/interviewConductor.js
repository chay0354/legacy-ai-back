import { callClaude, parseJsonFromClaude } from './anthropic.js';
import { formatExclusionsPromptBlock } from './topicExclusions.js';
import { formatIdentityPromptBlock } from './genderProfile.js';

const STAGE_GOALS = {
  foundation: 'Breadth — identity, family, chapters, relationships, values, advice, personality. One gentle door at a time.',
  enriched: 'Depth — meaningful stories, relationships, and wisdom. Follow threads before moving on.',
  legacy: 'Meaning — values, gratitude, legacy intent. Slow, reflective, silence is welcome.',
};

function buildSystem(stage, subjectName, language = 'en', gender = null, pronouns = null) {
  const lang = String(language || 'en').trim().toLowerCase().split(/[-_]/)[0] || 'en';
  const identityBlock = formatIdentityPromptBlock({ name: subjectName, gender, pronouns });
  return `You are Legacy AI — a warm, patient interviewer preserving ${subjectName}'s life story for their family.

Stage: ${stage}. ${STAGE_GOALS[stage] || STAGE_GOALS.foundation}
SESSION LANGUAGE: Speak and write answerSummary ONLY in language code "${lang}". Do not switch languages mid-interview. If "${lang}" is en, never reply in Hebrew, Arabic, or German.

Confirmed speaker identity:
${identityBlock}

You manage ONE anchor question at a time. You:
- Speak naturally, like a calm person in the room — never robotic, form-like, or therapy-scripted
- After you ask something, STOP and wait. Never answer your own question or keep talking
- Acknowledge by echoing a specific detail they said — never "That's wonderful" / "Thank you for sharing" / "What a beautiful story"
- Ask ONE specific follow-up at a time when the anchor needs depth
- Never ask vague or cliché prompts: "Tell me more", "How did that make you feel?", "What was that like?", "What comes up for you?", "Anything else?", "Can you unpack that?"
- Prefer concrete digs tied to their words: a name, place, time, what they saw, what someone said, one short example
- Keep the topic's scope — do not broaden into "tell me about your whole life" or greeting-card openers
- Use brief transitions only when moving to the next topic
- Personal background: ONLY use facts they explicitly said. Never invent or assume hometown, age, spouse/kids/parents, jobs, religion, dates, places, or feelings. Pronouns: follow the identity block strictly; if UNKNOWN never use he/him or she/her. Prefer "you" / their name. If vague, ask for one concrete detail — do not guess or fill gaps to sound warmer.
- Exclusions: If they say don't talk about / prefer not to discuss a subject, honor it — never ask about it again. If that subject IS the current anchor, set advance:true with a short answerSummary noting they asked to leave it alone.
- Stop/no intents: If they say skip, that's enough, stop asking, I don't want to answer, or decline a follow-up with no/no thanks — set advance:true immediately. Do not dig further. If they ask to pause/stop the interview, acknowledge and set advance:false with speak asking them to resume when ready (do not push a new question).
- Keep "speak" under 2–3 sentences
- answerSummary must contain only what they said — no embellishment

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
  digFor = '',
  questionIndex,
  totalQuestions,
  turns,
  userTranscript,
  isOpening,
  topicExclusions = [],
}) {
  const history = (turns || [])
    .map((t) => `${t.role === 'assistant' ? 'You' : subjectName}: ${t.text}`)
    .join('\n');
  const exclusionBlock = formatExclusionsPromptBlock(topicExclusions, { role: 'interviewer' });
  const digLine = String(digFor || '').trim()
    ? `Dig for: ${String(digFor).trim()}`
    : 'Dig for one concrete name, place, time, scene, or example.';

  if (isOpening) {
    return `Start the ${stage} interview. Anchor question ${questionIndex + 1} of ${totalQuestions}:
"${anchorQuestion}"
${digLine}

${exclusionBlock ? `${exclusionBlock}\n\n` : ''}Greet ${subjectName} briefly (one sentence), then ask this topic in warm spoken words that invite a concrete answer (do not broaden it).
Do NOT advance. answerSummary must be empty string.`;
  }

  return `Anchor question ${questionIndex + 1} of ${totalQuestions}:
"${anchorQuestion}"
${digLine}

${exclusionBlock ? `${exclusionBlock}\n\n` : ''}Conversation so far:
${history || '(none)'}

${subjectName} just said:
"${userTranscript}"

Respond as the interviewer. If you follow up, ask ONE specific question tied to something they said — never a vague or cliché line ("tell me more" / "how did that feel?" / "thank you for sharing").
Update answerSummary with everything they've shared for this anchor question.
Remember: advance:false unless they have clearly finished this topic with enough detail (or asked to leave this topic alone).`;
}

function isPauseInterviewIntent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return (
    /\b(pause( the interview)?|can we pause|let'?s pause|take a break)\b/i.test(t) ||
    /\b(stop the interview|end the interview|end (this )?session|quit the interview)\b/i.test(t) ||
    /\b(i(?:'m| am) done for (now|today)|we(?:'re| are) done for (now|today)|i(?:'m| am) done with (the|this) interview)\b/i.test(
      t,
    ) ||
    /\b(please stop the interview|can we stop( now| the interview|for now)|let'?s stop( now| the interview| for now))\b/i.test(
      t,
    )
  );
}

function isSkipIntent(text) {
  const t = String(text || '').trim();
  if (!t || isPauseInterviewIntent(t)) return false;
  return (
    /\b(skip|pass|next question|next topic|move on|don't know|dont know|not sure|nothing to add|that's all|thats all|no more)\b/i.test(
      t,
    ) ||
    /\b(that's enough|thats enough|enough( for now)?|stop asking|i (?:don'?t|do not) want to answer|prefer not to answer)\b/i.test(
      t,
    ) ||
    /^(stop|please stop|no|nope|nah|no thanks|no thank you|not really)\.?$/i.test(t)
  );
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
  if (isPauseInterviewIntent(userTranscript)) return false;
  if (isSkipIntent(userTranscript)) return true;

  const minTurns = stage === 'foundation' ? 2 : 1;
  const minWords = stage === 'legacy' ? 25 : stage === 'enriched' ? 30 : 20;

  if (turnsCount < minTurns && words < minWords) return false;
  if (words < 12 && !advance) return false;

  return Boolean(advance);
}

export async function conductorTurn(params) {
  const raw = await callClaude({
    system: buildSystem(
      params.stage || 'foundation',
      params.subjectName || 'Friend',
      params.language || 'en',
      params.gender || null,
      params.pronouns || null,
    ),
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
