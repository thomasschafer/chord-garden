import { checkWavHeader } from "@chord-garden/format/pure";
import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "../src/render/wav.js";

/**
 * `validate` and the renderer must mean the same thing by "a valid sample".
 *
 * These live in the engine package because it is the only one that can see both
 * halves: `checkWavHeader` is what `validate` calls (`sample.not-wav`) and
 * `decodeWav` is what the renderer calls. Each case below is a file the header
 * check used to accept and the decoder could not read — or, for a zero sample
 * rate, one they both accepted and the renderer then got wrong.
 */

/** A well-formed 16-bit mono WAV, as the baseline every mutation starts from. */
function goodWav(): Uint8Array {
  return encodeWav({ sampleRate: 48_000, left: Float32Array.of(0, 0.5, -0.5, 0.25) }, 16);
}

/** Byte offset of a chunk's 4-byte id, searched from the first chunk. */
function chunkOffset(bytes: Uint8Array, id: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    let found = "";
    for (let i = 0; i < 4; i++) found += String.fromCharCode(bytes[offset + i]!);
    if (found === id) return offset;
    offset += 8 + view.getUint32(offset + 4, true) + (view.getUint32(offset + 4, true) % 2);
  }
  throw new Error(`test helper could not find a "${id}" chunk`);
}

function withFmtField(mutate: (view: DataView, body: number) => void): Uint8Array {
  const bytes = goodWav();
  const view = new DataView(bytes.buffer);
  mutate(view, chunkOffset(bytes, "fmt ") + 8);
  return bytes;
}

const BAD_WAVS: { name: string; bytes: () => Uint8Array }[] = [
  {
    // Gap 6a: the header check stopped at the fmt chunk and never looked for
    // data, so a file with no samples at all passed.
    name: "no data chunk",
    bytes: () => goodWav().slice(0, chunkOffset(goodWav(), "data")),
  },
  {
    // Gap 6b: a data chunk whose declared size runs past the end of the file.
    name: "truncated data chunk",
    bytes: () => goodWav().slice(0, -4),
  },
  {
    // Gap 7.
    name: "three channels",
    bytes: () => withFmtField((view, body) => view.setUint16(body + 2, 3, true)),
  },
  {
    // Gap 8, the silent one: nothing divides by this and throws. The sampler's
    // playback ratio becomes 0, so every hit reads frame 0 forever.
    name: "sample rate 0",
    bytes: () => withFmtField((view, body) => view.setUint32(body + 4, 0, true)),
  },
  {
    name: "block align inconsistent with channels and depth",
    bytes: () => withFmtField((view, body) => view.setUint16(body + 12, 3, true)),
  },
  {
    name: "non-PCM audio format",
    bytes: () => withFmtField((view, body) => view.setUint16(body, 3, true)),
  },
  {
    name: "unsupported bit depth",
    bytes: () => withFmtField((view, body) => view.setUint16(body + 14, 12, true)),
  },
];

describe("checkWavHeader and decodeWav agree on what a valid sample is", () => {
  it("both accept a well-formed file", () => {
    const bytes = goodWav();
    expect(checkWavHeader(bytes).ok).toBe(true);
    expect(decodeWav(bytes).sampleRate).toBe(48_000);
  });

  for (const { name, bytes } of BAD_WAVS) {
    it(`both reject ${name}`, () => {
      const wav = bytes();
      const checked = checkWavHeader(wav);
      // The validator must refuse it...
      expect(checked.ok, `checkWavHeader accepted ${name}`).toBe(false);
      expect(checked.reason).toBeTruthy();
      // ...and so must the decoder, with the same reason, since one parse backs
      // both. A decoder that succeeded here would be reading a file `validate`
      // just called invalid.
      expect(() => decodeWav(wav), `decodeWav accepted ${name}`).toThrow(checked.reason!);
    });
  }

  it("round-trips every supported depth and channel count that both accept", () => {
    const left = Float32Array.of(0.3, -0.3);
    for (const depth of [16, 24] as const) {
      for (const channels of [1, 2] as const) {
        const audio =
          channels === 1
            ? { sampleRate: 44_100, left }
            : { sampleRate: 44_100, left, right: Float32Array.of(0.1, 0.2) };
        const wav = encodeWav(audio, depth);
        expect(checkWavHeader(wav).ok).toBe(true);
        const decoded = decodeWav(wav);
        expect(decoded.sampleRate).toBe(44_100);
        expect(decoded.channels).toHaveLength(channels);
      }
    }
  });
});
