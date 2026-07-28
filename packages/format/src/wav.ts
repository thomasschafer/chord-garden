/**
 * The properties a decoder needs before it can turn a WAV's `data` chunk into
 * samples. Every field is read from the file's `fmt ` chunk except the data
 * window, which comes from its `data` chunk.
 */
export interface WavHeader {
  /** Frames per second. Always > 0; a zero rate is refused by `parseWavHeader`. */
  sampleRate: number;
  channels: 1 | 2;
  bitsPerSample: 8 | 16 | 24 | 32;
  /** Bytes per frame: `channels * bitsPerSample / 8`. */
  blockAlign: number;
  /** Byte offset of the first frame. */
  dataOffset: number;
  /** Length of the `data` chunk in bytes; always a whole number of frames. */
  dataSize: number;
}

export type WavHeaderResult = { ok: true; header: WavHeader } | { ok: false; reason: string };

export interface WavCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Parse and fully check a PCM WAV header.
 *
 * The single source of truth for "is this a sample this tool can play?", shared
 * by the validator (`sample.not-wav`) and by the renderer's `decodeWav`. It is
 * one function rather than two agreeing ones because the two drifted, and a
 * validator that accepts what the decoder cannot read is worse than no validator
 * at all: an agent's `validate` passes and its render then fails, or — the case
 * that motivated this — succeeds and is wrong. A `sampleRate` of 0 sailed past
 * the old header check *and* past `decodeWav`, and rendered every hit pinned to
 * its first sample at +33 dBFS.
 *
 * So: if a property below is needed to decode, it is checked here, and there is
 * nowhere else for the two callers to disagree.
 */
export function parseWavHeader(bytes: Uint8Array): WavHeaderResult {
  if (bytes.length < 12) return { ok: false, reason: "file is too small to be a WAV file" };
  if (ascii(bytes, 0, 4) !== "RIFF") return { ok: false, reason: "missing RIFF header" };
  if (ascii(bytes, 8, 4) !== "WAVE") return { ok: false, reason: "missing WAVE marker" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let format: Omit<WavHeader, "dataOffset" | "dataSize"> | undefined;
  let dataOffset = -1;
  let dataSize = 0;

  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + chunkSize > bytes.length) return { ok: false, reason: `truncated "${chunkId}" chunk` };
    if (chunkId === "fmt ") {
      if (chunkSize < 16) return { ok: false, reason: "fmt chunk is too small" };
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (audioFormat !== 1) {
        return { ok: false, reason: `audio format ${audioFormat} is not uncompressed PCM (1)` };
      }
      if (channels !== 1 && channels !== 2) {
        return { ok: false, reason: `unsupported channel count ${channels}; v1 reads mono or stereo` };
      }
      if (bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
        return { ok: false, reason: `unsupported bits per sample: ${bitsPerSample}` };
      }
      // A rate of 0 is the quiet one. Nothing downstream divides by it and
      // throws; the sampler's playback ratio just becomes 0, so every hit reads
      // frame 0 forever — a full-scale DC blast that renders and analyses as
      // "successful" audio.
      if (sampleRate === 0) return { ok: false, reason: "sample rate is 0" };
      const expectedBlockAlign = (channels * bitsPerSample) / 8;
      if (blockAlign !== expectedBlockAlign) {
        return {
          ok: false,
          reason: `block align ${blockAlign} does not match ${channels} channels at ${bitsPerSample} bits (${expectedBlockAlign})`,
        };
      }
      format = { sampleRate, channels, bitsPerSample, blockAlign };
    } else if (chunkId === "data" && dataOffset < 0) {
      dataOffset = body;
      dataSize = chunkSize;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (format === undefined) return { ok: false, reason: "no fmt chunk found" };
  if (dataOffset < 0) return { ok: false, reason: "no data chunk found" };
  if (dataSize % format.blockAlign !== 0) {
    return { ok: false, reason: "data size is not a whole number of PCM frames" };
  }
  return { ok: true, header: { ...format, dataOffset, dataSize } };
}

/**
 * The validator's view of `parseWavHeader`: is this a sample the renderer can
 * read? Derived from the parse rather than reimplementing it, so the two cannot
 * disagree about what a valid sample is.
 */
export function checkWavHeader(bytes: Uint8Array): WavCheckResult {
  const parsed = parseWavHeader(bytes);
  return parsed.ok ? { ok: true } : { ok: false, reason: parsed.reason };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}
