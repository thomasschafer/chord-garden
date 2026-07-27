import { writeFileSync } from "node:fs";
import type { RenderedAudio } from "./renderer.js";
import { encodeWav, type PcmBitDepth, type WavAudio } from "./wav.js";

/**
 * Write a WAV file. Split from `wav.ts` so that encoding and decoding stay free
 * of `node:fs`: the browser decodes project samples with the same `decodeWav`
 * the offline renderer uses, and one `writeFileSync` in that module would make
 * the whole web bundle unresolvable.
 */
export function writeWav(path: string, audio: WavAudio | RenderedAudio, bitsPerSample: PcmBitDepth = 24): void {
  const source: WavAudio =
    "master" in audio ? { sampleRate: audio.sampleRate, left: audio.master.left, right: audio.master.right } : audio;
  writeFileSync(path, encodeWav(source, bitsPerSample));
}
