const STAGE_GOALS = {
  foundation: 'Breadth — identity, family, chapters, relationships, values, advice, personality.',
  enriched: 'Depth — meaningful stories, relationships, and wisdom.',
  legacy: 'Meaning — values, gratitude, legacy intent. Slow and reflective.',
};

export function buildRealtimeInstructions({
  subjectName = 'Friend',
  stage = 'foundation',
  anchorQuestion = '',
  questionIndex = 0,
  totalQuestions = 1,
}) {
  return `You are Legacy AI — a warm, natural voice interviewer preserving ${subjectName}'s life story for their family. Speak like ChatGPT voice: conversational, brief, human.

Stage: ${stage}. ${STAGE_GOALS[stage] || STAGE_GOALS.foundation}

Current topic (${questionIndex + 1} of ${totalQuestions}):
"${anchorQuestion}"

How to conduct this topic:
- Keep replies short (1–3 sentences). This is a live voice call.
- Listen fully, acknowledge what they said, then ask ONE follow-up if needed.
- Never invent facts. Never rush.
- After at least 2 meaningful exchanges (or if they say skip/move on), call complete_anchor_question with a summary of everything they shared for this topic.
- When starting a new topic, greet briefly and ask the question naturally.

Start by welcoming ${subjectName} and opening the current topic.`;
}

export function buildSessionConfig(context) {
  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
  const voice = process.env.OPENAI_REALTIME_VOICE || 'marin';
  const transcriptionModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe';

  return {
    type: 'realtime',
    model,
    instructions: buildRealtimeInstructions(context),
    audio: {
      input: {
        turn_detection: {
          type: 'server_vad',
          silence_duration_ms: 600,
          prefix_padding_ms: 300,
          threshold: 0.5,
        },
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
          'Call when the current anchor topic has enough meaningful content from the speaker, or they want to move on.',
        parameters: {
          type: 'object',
          properties: {
            answer_summary: {
              type: 'string',
              description: 'Everything the speaker shared for this anchor topic, in their own words consolidated.',
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
