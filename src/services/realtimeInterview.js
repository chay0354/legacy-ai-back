const STAGE_GOALS = {
  foundation: 'Breadth — identity, family, chapters, relationships, values, advice, personality. One door at a time, with real curiosity.',
  enriched: 'Depth — meaningful stories, relationships, and wisdom. Follow threads before moving on.',
  legacy: 'Meaning — values, gratitude, legacy intent. Slow and reflective.',
};

function formatPriorTopics(priorTopics) {
  if (!Array.isArray(priorTopics) || priorTopics.length === 0) return '';
  const lines = priorTopics
    .filter((t) => t && (t.summary || t.answer))
    .map((t, i) => {
      const label = t.module || t.question || `Topic ${i + 1}`;
      const summary = String(t.summary || t.answer || '').trim();
      if (!summary) return null;
      const clipped = summary.length > 280 ? `${summary.slice(0, 277)}…` : summary;
      return `${i + 1}. ${label}: ${clipped}`;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return `Story so far (weave lightly for continuity — do not re-ask settled facts):\n${lines.join('\n')}`;
}

export function buildRealtimeInstructions({
  subjectName = 'Friend',
  stage = 'foundation',
  anchorQuestion = '',
  questionIndex = 0,
  totalQuestions = 1,
  priorTopics = [],
  isOpening = questionIndex === 0,
}) {
  const storyBlock = formatPriorTopics(priorTopics);
  const topicNum = Number(questionIndex) + 1;
  const total = Number(totalQuestions) || 1;
  const remaining = Math.max(0, total - topicNum);
  const progressLine = `Progress: topic ${topicNum} of ${total}${remaining === 0 ? ' (last topic)' : ` — ${remaining} after this`}.`;

  const openGuidance = isOpening
    ? `Opening this interview (REQUIRED — do this before the first topic question):
Speak a short process intro in your own warm words, covering ALL of these points (about 4–6 sentences total, then STOP and wait):
1. Welcome ${subjectName}.
2. What this is: a conversation to preserve their life story for family — not a test, no wrong answers.
3. Shape: about ${total} topics in this ${stage} stage; you'll ask, they talk, you may ask a gentle follow-up before moving on.
4. Controls: they can pause anytime, take their time, skip a topic if they want, and ask "how far are we?" anytime.
5. Then open the first topic below in natural spoken words (not questionnaire wording).

Do NOT rush into the first question without that orientation.
Do NOT call complete_anchor_question until they have actually shared something.`
    : `Opening this next topic:
- Do NOT re-welcome them as if the interview just started.
- Transition like a real conversation: a soft progress cue in plain language, optional bridge from something they shared, then the new question in your own words.
- Good: "We're a little further along — topic ${topicNum} of ${total}. You mentioned …; I'd love to hear about …"
- Avoid robotic phrasing like "Next question." or "Proceeding to topic ${topicNum}."`;

  return `You are Legacy AI — a warm, patient voice interviewer sitting with ${subjectName}, helping preserve their life story for family.

Voice & presence (critical — you must not sound mechanical):
- Speak like a calm, curious person in the room — not an IVR, survey, or chatbot reading a script.
- Vary your wording. Never reuse the same acknowledgment ("That's wonderful" / "Thank you for sharing") every turn.
- Reflect a specific detail they said before you ask more — show you were listening.
- Soften transitions; leave a little air. Silence after a question is good — wait for them.
- Prefer contractions and natural spoken English ("I'd love to hear…" / "What was that like for you?").
- Do NOT sound like you are ticking boxes. Do NOT say "question ${topicNum}" or "next item."
- Rephrase the topic prompt in warm spoken language; do not read it verbatim like a form field.
- After you ask something, STOP and wait. Never answer your own question or keep monologuing.

Stage: ${stage}. ${STAGE_GOALS[stage] || STAGE_GOALS.foundation}

${progressLine}
Current topic prompt (${topicNum} of ${total}) — ask this idea in your own words:
"${anchorQuestion}"

${storyBlock ? `${storyBlock}\n` : ''}
How to conduct this topic:
- Keep most spoken turns to 1–3 sentences (live call), but let warmth and specificity matter more than brevity.
- Listen fully. Acknowledge with a concrete echo of what they said, then ask ONE follow-up at a time.
- Dig for at least one concrete detail: a name, place, time, feeling, or short scene — not only abstractions.
- STRICT LIMIT: at most 4–5 questions on this topic total (opening question + up to 3–4 follow-ups). Do NOT linger with a 6th question.
- After their 4th or 5th answer on this topic, wrap up warmly and call complete_anchor_question — even if you could ask more.
- Thin one-line answers deserve one or two follow-ups, not an endless loop on the same topic.
- Never invent facts they did not say.
- If they clearly say skip / move on / nothing to add, respect that immediately — call complete_anchor_question with answer_summary noting they skipped.
- When they say "skip", do NOT ask another follow-up on this topic.

Progress questions (IMPORTANT):
- If they ask how far along they are, how many left, where they are, or similar — answer clearly using the Progress line (topic ${topicNum} of ${total}).
- Answer first in one short human sentence, then continue. Do not dodge.
- Examples: "We're on topic ${topicNum} of ${total}." / "This is the last one for this stage." / "About ${remaining} after this."

When to call complete_anchor_question:
- After 4–5 questions on this topic (count your follow-ups), OR when you have a solid summary, OR they asked to skip/move on.
- Do NOT complete after a single shallow reply — but do NOT exceed 5 questions on the same topic.
- The answer_summary must be in their voice consolidated — names and specifics when you have them.

${openGuidance}`;
}

function realtimeNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** VAD tuned for quiet rooms / elders: less barge-in from ambient noise, longer pause before end-of-turn. */
export function buildTurnDetection() {
  return {
    type: 'server_vad',
    // Higher = ignore quieter background; default 0.5 was too eager for ambient noise.
    threshold: realtimeNumberEnv('OPENAI_REALTIME_VAD_THRESHOLD', 0.72),
    prefix_padding_ms: realtimeNumberEnv('OPENAI_REALTIME_PREFIX_PADDING_MS', 300),
    // Longer silence before committing a user turn (was 600ms — cut off mid-thought / after noise).
    silence_duration_ms: realtimeNumberEnv('OPENAI_REALTIME_SILENCE_MS', 1500),
    create_response: true,
    // Do not cancel the interviewer when VAD falsely hears speech during playback.
    interrupt_response: false,
  };
}

export function buildSessionConfig(context) {
  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
  // coral tends to sound warmer/less clipped than marin for long interviews
  const voice = process.env.OPENAI_REALTIME_VOICE || 'coral';
  const transcriptionModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe';
  const noiseReduction =
    process.env.OPENAI_REALTIME_NOISE_REDUCTION === 'off'
      ? null
      : { type: process.env.OPENAI_REALTIME_NOISE_REDUCTION || 'near_field' };

  return {
    type: 'realtime',
    model,
    instructions: buildRealtimeInstructions(context),
    audio: {
      input: {
        turn_detection: buildTurnDetection(),
        ...(noiseReduction ? { noise_reduction: noiseReduction } : {}),
        transcription: {
          model: transcriptionModel,
        },
      },
      output: {
        voice,
      },
    },
    tools: [
      {
        type: 'function',
        name: 'complete_anchor_question',
        description:
          'Call ONLY when this topic has real substance (concrete details across a few exchanges) or the speaker clearly wants to skip/move on. Do not call after a thin first answer.',
        parameters: {
          type: 'object',
          properties: {
            answer_summary: {
              type: 'string',
              description:
                'Rich consolidated summary of everything they shared for this topic — specifics, names, places, feelings — in their own words.',
            },
          },
          required: ['answer_summary'],
        },
      },
    ],
    tool_choice: 'auto',
  };
}

export async function createRealtimeClientSecret(context) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session: buildSessionConfig(context) }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI client_secret error ${res.status}: ${err}`);
  }

  const data = await res.json();
  if (!data?.value) throw new Error('OpenAI client_secret response missing value');
  return { token: data.value, expiresAt: data.expires_at ?? null };
}

export async function createRealtimeCall(sdp, context) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  if (typeof sdp !== 'string' || sdp.trim().length < 100) {
    throw new Error(`Invalid SDP offer (${typeof sdp === 'string' ? sdp.trim().length : 0} chars) — wait for ICE gathering before sending`);
  }

  const sessionJson = JSON.stringify(buildSessionConfig(context));
  const fd = new FormData();
  // Do NOT trim SDP — trailing CRLF is required; trim causes OpenAI multipart EOF errors.
  fd.set('sdp', sdp);
  fd.set('session', sessionJson);

  const res = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });

  if (!res.ok) {
    const err = await res.text();
    let detail = err;
    try {
      const parsed = JSON.parse(err);
      detail = parsed?.error?.message || parsed?.error || err;
      if (parsed?.error?.code) detail += ` (${parsed.error.code})`;
    } catch { /* keep raw */ }
    throw new Error(`OpenAI Realtime error ${res.status}: ${detail}`);
  }

  return res.text();
}
