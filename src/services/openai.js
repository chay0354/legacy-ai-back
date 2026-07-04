const OPENAI_BASE = 'https://api.openai.com/v1';

function apiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');
  return key;
}

/** Transcribe audio with Whisper (buffer from webm/mp4/wav). */
export async function transcribeWhisper(audioBuffer, filename = 'audio.webm') {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', process.env.OPENAI_WHISPER_MODEL || 'whisper-1');
  form.append('language', 'en');

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Whisper error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return (data.text || '').trim();
}

/** OpenAI TTS — returns MP3 bytes. */
export async function speakOpenAI(text, voice = process.env.OPENAI_TTS_VOICE || 'nova') {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Nothing to speak');

  const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || 'tts-1-hd',
      voice,
      input: trimmed.slice(0, 4096),
      response_format: 'mp3',
      speed: Number(process.env.OPENAI_TTS_SPEED) || 0.94,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI TTS error ${res.status}: ${err}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

export function openAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}
