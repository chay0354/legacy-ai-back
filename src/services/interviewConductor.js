import { callClaude, parseJsonFromClaude } from './anthropic.js';
import { formatExclusionsPromptBlock } from './topicExclusions.js';
import { formatIdentityPromptBlock } from './genderProfile.js';

const STAGE_GOALS = {
  foundation: 'Breadth — identity, family, chapters, relationships, values, advice, personality. One gentle door at a time.',
  enriched: 'Depth — meaningful stories, relationships, and wisdom. Follow threads before moving on.',
  legacy: 'Meaning — values, gratitude, legacy intent. Slow, reflective, silence is welcome.',
  memory: 'One more story — follow them. Do not run a questionnaire.',
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
- Keep the topic, but let them answer in their own shape — if they wander into a real memory, stay with it
- Do not broaden into "tell me about your whole life" or greeting-card openers, and do not treat the prompt like a form to complete
- Use brief transitions only when moving to the next topic — then immediately ask that topic. Never wait for them to say continue.
- Do not summarize earlier topics or their life unless they asked how far they are.
- Never re-ask facts they already answered (spouse, children, parents, hometown, siblings, work).
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
  priorTopics = [],
}) {
  const history = (turns || [])
    .map((t) => `${t.role === 'assistant' ? 'You' : subjectName}: ${t.text}`)
    .join('\n');
  const exclusionBlock = formatExclusionsPromptBlock(topicExclusions, { role: 'interviewer' });
  const digLine = String(digFor || '').trim()
    ? `Listen for (do not quiz): ${String(digFor).trim()}`
    : 'If they stay thin, you may later ask for one name, place, time, or example.';

  const prior = (priorTopics || [])
    .filter((t) => t && (t.summary || t.answer))
    .slice(0, 8)
    .map((t, i) => `${i + 1}. ${t.question || t.module || 'Earlier'} — ${String(t.summary || t.answer).trim().slice(0, 220)}`)
    .join('\n');
  const priorBlock = prior
    ? `They already shared (cite if this is a later sitting; do not re-ask):\n${prior}\n\n`
    : '';

  if (isOpening) {
    return `Start the ${stage} interview. Anchor question ${questionIndex + 1} of ${totalQuestions}:
"${anchorQuestion}"
${digLine}

${priorBlock}${exclusionBlock ? `${exclusionBlock}\n\n` : ''}${prior
    ? `Welcome ${subjectName} back and mention one thing they already shared, then open this topic.`
    : `Greet ${subjectName} briefly (one sentence), then ask this topic in warm spoken words that leave them room to talk in their own way (keep the topic; do not turn it into a form).`}
Do NOT advance. answerSummary must be empty string.`;
  }

  return `Anchor question ${questionIndex + 1} of ${totalQuestions}:
"${anchorQuestion}"
${digLine}

${priorBlock}${exclusionBlock ? `${exclusionBlock}\n\n` : ''}Conversation so far:
${history || '(none)'}

${subjectName} just said:
"${userTranscript}"

Respond as the interviewer. Every speak turn must end with ONE question, or set advance:true with a one-sentence close. Never recap only. Never wait for "continue".
If you follow up, ask ONE specific question tied to something they just said — never a vague or cliché line ("tell me more" / "how did that feel?" / "thank you for sharing").
Do not re-ask settled facts from earlier topics.
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

/** A turn that neither asks nor closes leaves the person waiting — that is the "stuck" case. */
function endsWithQuestion(text) {
  return /[?؟]\s*["”']?\s*$/.test(String(text || '').trim());
}

function normalizeAsk(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarQuestion(a, b) {
  const na = normalizeAsk(a);
  const nb = normalizeAsk(b);
  if (!na || !nb || na.length < 18 || nb.length < 18) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = na.split(' ').filter((w) => w.length > 3);
  const tb = new Set(nb.split(' ').filter((w) => w.length > 3));
  if (ta.length < 3 || tb.size < 3) return false;
  const hit = ta.filter((w) => tb.has(w)).length;
  return hit / Math.min(ta.length, tb.size) >= 0.72;
}

/** Same or near-same question asked twice on one topic. */
function repeatsEarlierQuestion(speak, turns) {
  return (turns || []).some((t) => t.role === 'assistant' && similarQuestion(speak, t.text));
}

/** Recap-only turn — they sit waiting because nothing was asked. */
function looksLikeRecapOnly(text) {
  const t = String(text || '').trim();
  if (!t || endsWithQuestion(t)) return false;
  return /\b(so far (you('ve| have)|we('ve| have))|to (summarize|recap)|in summary|what we('ve| have) (covered|talked|discussed)|you (already )?(told|shared|mentioned)|we (already )?(talked|covered|discussed|heard)|let me (just )?(reflect|summarize|recap))\b/i.test(t);
}

async function askConductor(params, correction = '') {
  const raw = await callClaude({
    system: buildSystem(
      params.stage || 'foundation',
      params.subjectName || 'Friend',
      params.language || 'en',
      params.gender || null,
      params.pronouns || null,
    ),
    userMessage: buildUserMessage(params) + (correction ? `\n\nCORRECTION (your previous draft was rejected): ${correction}` : ''),
    maxTokens: 1024,
  });
  const text = typeof raw === 'string' ? raw : raw.text;
  try {
    return parseJsonFromClaude(text);
  } catch {
    throw new Error('Interviewer returned invalid response');
  }
}

export async function conductorTurn(params) {
  let parsed = await askConductor(params);

  const pausing = isPauseInterviewIntent(params.userTranscript);
  const evaluate = (p) => {
    const speak = String(p.speak || '').trim();
    const advance = guardAdvance({
      advance: Boolean(p.advance),
      isOpening: Boolean(params.isOpening),
      turns: params.turns,
      userTranscript: params.userTranscript,
      stage: params.stage || 'foundation',
    });
    return { speak, advance };
  };

  let { speak, advance } = evaluate(parsed);
  // One corrective retry so the interviewer never stalls, recaps, or repeats itself.
  if (!pausing && !advance && (looksLikeRecapOnly(speak) || (speak && !endsWithQuestion(speak)))) {
    parsed = await askConductor(params, 'Do not recap. End this turn with ONE new specific question tied to their last words — or set advance:true with a one-sentence close. Never wait for them to say continue.');
    ({ speak, advance } = evaluate(parsed));
  } else if (!pausing && !advance && repeatsEarlierQuestion(speak, params.turns)) {
    parsed = await askConductor(params, 'You already asked that. Ask a different specific follow-up about something they just said — or set advance:true with a one-sentence close.');
    ({ speak, advance } = evaluate(parsed));
  }

  if (!speak) speak = 'Take your time — I am listening. What comes to mind first?';
  if (!pausing && !advance && !endsWithQuestion(speak)) {
    speak = 'What else comes to mind about that?';
  }
  const answerSummary = String(parsed.answerSummary || '').trim();
  return { speak, advance, answerSummary };
}
