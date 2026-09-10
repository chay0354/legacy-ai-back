/** Minimum usable length for a voice-clone sample. */
export const MIN_VOICE_SAMPLE_SECONDS = 30;

/**
 * Duration of a RIFF/WAVE buffer in seconds.
 * Returns 0 when the file is not a parseable WAV.
 */
export function wavDurationSeconds(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return 0;
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  if (!channels || !sampleRate || !bitsPerSample) return 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
      return bytesPerSec > 0 ? size / bytesPerSec : 0;
    }
    offset += 8 + Math.max(0, size) + (size % 2);
  }

  const bytesPerSec = sampleRate * channels * (bitsPerSample / 8);
  return bytesPerSec > 0 ? Math.max(0, (buffer.length - 44) / bytesPerSec) : 0;
}

const SHORT_SAMPLE_MESSAGE =
  `Record at least ${MIN_VOICE_SAMPLE_SECONDS} seconds — 60–90 seconds in a quiet room clones much more reliably.`;

/**
 * Reject samples shorter than 30s. Unknown formats are estimated as 16 kHz mono 16-bit.
 * Throws an Error with `status = 400` when too short.
 */
export function assertVoiceSampleLongEnough(buffer) {
  const parsed = wavDurationSeconds(buffer);
  if (parsed > 0 && parsed < MIN_VOICE_SAMPLE_SECONDS) {
    const err = new Error(SHORT_SAMPLE_MESSAGE);
    err.status = 400;
    throw err;
  }
  if (parsed <= 0) {
    const estimated = buffer.length / (16000 * 2);
    if (estimated < MIN_VOICE_SAMPLE_SECONDS) {
      const err = new Error(SHORT_SAMPLE_MESSAGE);
      err.status = 400;
      throw err;
    }
  }
  return parsed;
}
