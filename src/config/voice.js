/** Tunable voice settings — override via env without code changes. */

export function elevenLabsVoiceSettings() {
  return {
    stability: Number(process.env.ELEVENLABS_STABILITY ?? 0.4),
    similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST ?? 0.75),
    style: Number(process.env.ELEVENLABS_STYLE ?? 0.15),
    use_speaker_boost: process.env.ELEVENLABS_SPEAKER_BOOST !== 'false',
  };
}

export function elevenLabsTtsModel() {
  return process.env.ELEVENLABS_TTS_MODEL || 'eleven_turbo_v2_5';
}

/** HeyGen voice_settings when rendering script + voice_id (not pre-uploaded audio). */
export function heyGenVoiceSettings() {
  const speed = Number(process.env.HEYGEN_VOICE_SPEED ?? 0.95);
  const settings = {
    speed,
    pitch: Number(process.env.HEYGEN_VOICE_PITCH ?? 0),
    volume: Number(process.env.HEYGEN_VOICE_VOLUME ?? 1),
    locale: process.env.HEYGEN_VOICE_LOCALE || 'en-US',
  };

  if (process.env.HEYGEN_ELEVENLABS_ENGINE !== 'false') {
    settings.engine_settings = {
      engine_type: 'elevenlabs',
      model: process.env.HEYGEN_ELEVENLABS_MODEL || 'eleven_v3',
      stability: Number(process.env.HEYGEN_ELEVENLABS_STABILITY ?? 0.5),
      similarity_boost: Number(process.env.HEYGEN_ELEVENLABS_SIMILARITY_BOOST ?? 0.75),
      style: Number(process.env.HEYGEN_ELEVENLABS_STYLE ?? 0),
      use_speaker_boost: process.env.HEYGEN_ELEVENLABS_SPEAKER_BOOST !== 'false',
    };
  }

  return settings;
}

export const VOICE_TEST_PHRASE =
  'Hello. Pull up a chair — ask me anything you like, and I will answer the way I always would have.';
