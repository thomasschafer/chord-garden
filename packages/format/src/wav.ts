export interface WavCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Minimal WAV header check: RIFF/WAVE container with a PCM (format 1) `fmt `
 * chunk. This is a sanity gate against mislabeled files, not a full decoder.
 */
export function checkWavHeader(bytes: Uint8Array): WavCheckResult {
  if (bytes.length < 44) return { ok: false, reason: "file is too small to be a WAV file" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF") return { ok: false, reason: "missing RIFF header" };
  if (ascii(bytes, 8, 4) !== "WAVE") return { ok: false, reason: "missing WAVE marker" };

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      if (offset + 8 + 16 > bytes.length) return { ok: false, reason: "truncated fmt chunk" };
      const audioFormat = view.getUint16(offset + 8, true);
      if (audioFormat !== 1) {
        return { ok: false, reason: `audio format ${audioFormat} is not uncompressed PCM (1)` };
      }
      const bitsPerSample = view.getUint16(offset + 8 + 14, true);
      if (![8, 16, 24, 32].includes(bitsPerSample)) {
        return { ok: false, reason: `unsupported bits per sample: ${bitsPerSample}` };
      }
      return { ok: true };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return { ok: false, reason: "no fmt chunk found" };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}
