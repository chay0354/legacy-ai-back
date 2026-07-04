import { textToSpeech as elevenLabsTts } from './elevenlabs.js';
import { speakOpenAI } from './openai.js';

function elevenLabsReady() {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.INTERVIEWER_VOICE_ID);
}

/** Natural interviewer TTS — ElevenLabs when configured, else OpenAI HD. */
export async function speakInterviewer(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Nothing to speak');

  const provider = (process.env.INTERVIEWER_TTS_PROVIDER || 'elevenlabs').toLowerCase();

  if (provider === 'elevenlabs' && elevenLabsReady()) {
    return elevenLabsTts({
      voiceId: process.env.INTERVIEWER_VOICE_ID,
      text: trimmed,
      modelId: process.env.INTERVIEWER_TTS_MODEL || process.env.ELEVENLABS_TTS_MODEL || 'eleven_turbo_v2_5',
      voiceSettings: {
        stability: 0.62,
        similarity_boost: 0.78,
        style: 0.18,
        use_speaker_boost: true,
      },
    });
  }

  return speakOpenAI(trimmed);
}

export function interviewerTtsConfigured() {
  return elevenLabsReady() || Boolean(process.env.OPENAI_API_KEY);
}
