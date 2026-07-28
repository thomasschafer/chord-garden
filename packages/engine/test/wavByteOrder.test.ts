import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "@chord-garden/format";
import { afterAll, describe, expect, it } from "vitest";
import { decodeWav, encodeWav, render, writeWav } from "../src/index.js";

/**
 * The WAV codec's byte order, asserted against two references outside this
 * repository rather than against itself.
 *
 * Encoder and decoder are each other's only witness in a round-trip test, so
 * flipping the byte order in *both* halves round-trips perfectly and produces
 * files no other program can read. The two references here cannot be satisfied
 * by a self-consistent mistake:
 *
 *  1. The RIFF/WAVE specification, which fixes every multi-byte field and every
 *     PCM sample as little-endian two's complement. The expected bytes below are
 *     written out by hand from the spec, not captured from this implementation.
 *  2. Python's standard-library `wave` module — a separate implementation, by
 *     other people, that parses the header itself. It is the only oracle here
 *     that can catch a mistake this codebase makes consistently in both
 *     directions.
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "chord-garden-byte-order-"));
  directories.push(directory);
  return directory;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** ASCII at a byte offset, so a field can be named by the spec's tag rather than a number. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index++) value += String.fromCharCode(bytes[offset + index]!);
  return value;
}

/**
 * Read a little-endian unsigned integer *without* using a DataView, so this
 * assertion does not inherit the endianness choice from the same platform call
 * the implementation makes.
 */
function readLittleEndian(bytes: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let index = width - 1; index >= 0; index--) value = value * 256 + bytes[offset + index]!;
  return value;
}

interface PythonWav {
  sampleRate: number;
  channels: number;
  sampleWidth: number;
  frames: number;
  samples: number[];
}

/**
 * Decode a WAV with python's stdlib `wave` module.
 *
 * `wave` parses the RIFF container on its own — chunk ids, chunk sizes and every
 * `fmt ` field — so the rate, channel count, sample width and frame count it
 * reports are an independent verdict on the header's byte order. It hands PCM
 * frames back as raw bytes, so the sample words are unpacked here as the spec
 * defines them: little-endian two's complement.
 */
function pythonDecode(path: string): PythonWav {
  const script = [
    "import json, sys, wave",
    "with wave.open(sys.argv[1], 'rb') as handle:",
    "    params = handle.getparams()",
    "    frames = handle.readframes(handle.getnframes())",
    "width = params.sampwidth",
    "count = params.nframes * params.nchannels",
    "samples = [int.from_bytes(frames[i * width:(i + 1) * width], 'little', signed=True) for i in range(count)]",
    "json.dump({'sampleRate': params.framerate, 'channels': params.nchannels,",
    "           'sampleWidth': width, 'frames': params.nframes, 'samples': samples}, sys.stdout)",
  ].join("\n");
  const stdout = execFileSync("python3", ["-c", script, path], { encoding: "utf8" });
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) throw new Error("python decoder returned no object");
  const record = parsed as Record<string, unknown>;
  const { sampleRate, channels, sampleWidth, frames, samples } = record;
  if (
    typeof sampleRate !== "number" ||
    typeof channels !== "number" ||
    typeof sampleWidth !== "number" ||
    typeof frames !== "number" ||
    !Array.isArray(samples) ||
    !samples.every((sample): sample is number => typeof sample === "number")
  ) {
    throw new Error(`python decoder returned an unexpected shape: ${stdout}`);
  }
  return { sampleRate, channels, sampleWidth, frames, samples };
}

/**
 * Write a WAV with python's `wave` module, which emits the container itself.
 * Used to point the second reference at the *decoder*: a reader that flipped
 * byte order the same way the writer did would still be caught reading a file
 * this repository did not produce.
 */
function pythonEncode(path: string, sampleRate: number, channels: number, samples: readonly number[]): void {
  const script = [
    "import json, sys, wave",
    "path, payload = sys.argv[1], json.loads(sys.argv[2])",
    "with wave.open(path, 'wb') as handle:",
    "    handle.setnchannels(payload['channels'])",
    "    handle.setsampwidth(2)",
    "    handle.setframerate(payload['sampleRate'])",
    "    handle.writeframes(b''.join(int(s).to_bytes(2, 'little', signed=True) for s in payload['samples']))",
  ].join("\n");
  execFileSync("python3", ["-c", script, path, JSON.stringify({ sampleRate, channels, samples })]);
}

describe("WAV bytes against the RIFF specification", () => {
  it("is the exact byte sequence the spec prescribes for a 24-bit mono file", () => {
    // Hand-assembled from the RIFF/WAVE spec for three frames at 44 100 Hz:
    //   "RIFF"                        52 49 46 46
    //   riff size = 36 + 9 = 45       2d 00 00 00   (little-endian)
    //   "WAVE"                        57 41 56 45
    //   "fmt "                        66 6d 74 20
    //   fmt chunk size = 16           10 00 00 00
    //   audioFormat = 1 (PCM)         01 00
    //   channels = 1                  01 00
    //   sampleRate = 44100 = 0xac44   44 ac 00 00
    //   byteRate = 132300 = 0x204cc   cc 04 02 00
    //   blockAlign = 3                03 00
    //   bitsPerSample = 24            18 00
    //   "data"                        64 61 74 61
    //   data size = 3 frames x 3      09 00 00 00
    //   +1.0 -> 0x7fffff              ff ff 7f
    //   -1.0 -> 0x800000              00 00 80
    //    0.0 -> 0x000000              00 00 00
    const expected =
      "52494646" +
      "2d000000" +
      "57415645" +
      "666d7420" +
      "10000000" +
      "0100" +
      "0100" +
      "44ac0000" +
      "cc040200" +
      "0300" +
      "1800" +
      "64617461" +
      "09000000" +
      "ffff7f" +
      "000080" +
      "000000";
    expect(hex(encodeWav({ sampleRate: 44_100, left: Float32Array.of(1, -1, 0) }, 24))).toBe(expected);
  });

  it("puts the spec's chunk ids and the sample rate at the spec's offsets", () => {
    for (const sampleRate of [8000, 44_100, 48_000, 96_000]) {
      for (const bits of [16, 24] as const) {
        const bytes = encodeWav({ sampleRate, left: Float32Array.of(0.25), right: Float32Array.of(-0.25) }, bits);
        expect(ascii(bytes, 0, 4)).toBe("RIFF");
        expect(ascii(bytes, 8, 4)).toBe("WAVE");
        expect(ascii(bytes, 12, 4)).toBe("fmt ");
        expect(ascii(bytes, 36, 4)).toBe("data");
        // Every one of these is a little-endian integer by definition of RIFF.
        expect(readLittleEndian(bytes, 4, 4)).toBe(bytes.length - 8);
        expect(readLittleEndian(bytes, 16, 4)).toBe(16);
        expect(readLittleEndian(bytes, 20, 2)).toBe(1);
        expect(readLittleEndian(bytes, 22, 2)).toBe(2);
        expect(readLittleEndian(bytes, 24, 4)).toBe(sampleRate);
        expect(readLittleEndian(bytes, 28, 4)).toBe((sampleRate * 2 * bits) / 8);
        expect(readLittleEndian(bytes, 32, 2)).toBe((2 * bits) / 8);
        expect(readLittleEndian(bytes, 34, 2)).toBe(bits);
        expect(readLittleEndian(bytes, 40, 4)).toBe(bytes.length - 44);
      }
    }
  });

  it("writes full-scale samples as the spec's little-endian two's-complement words", () => {
    // 16-bit: +1.0 saturates at 0x7fff, -1.0 is 0x8000.
    expect(hex(encodeWav({ sampleRate: 48_000, left: Float32Array.of(1, -1) }, 16).slice(44))).toBe("ff7f" + "0080");
    // 24-bit, and the interleave order the spec fixes: left frame word first.
    const stereo = encodeWav({ sampleRate: 48_000, left: Float32Array.of(1), right: Float32Array.of(-1) }, 24);
    expect(hex(stereo.slice(44))).toBe("ffff7f" + "000080");
  });
});

describe("WAV bytes against python's stdlib wave module", () => {
  it("agrees on rate, channels, depth and every sample value the encoder wrote", () => {
    const path = join(scratchDirectory(), "encoded.wav");
    // Values chosen to land on exact integer PCM words, so the comparison is
    // equality rather than a tolerance.
    const left = Float32Array.of(1, -1, 0, 0.5, -0.5);
    const right = Float32Array.of(-0.5, 0.5, 0, -1, 1);
    writeFileSync(path, encodeWav({ sampleRate: 44_100, left, right }, 24));
    const decoded = pythonDecode(path);
    expect(decoded.sampleRate).toBe(44_100);
    expect(decoded.channels).toBe(2);
    expect(decoded.sampleWidth).toBe(3);
    expect(decoded.frames).toBe(5);
    expect(decoded.samples).toEqual([
      8388607, -4194304, -8388608, 4194304, 0, 0, 4194304, -8388608, -4194304, 8388607,
    ]);
  });

  it("agrees on a 16-bit file too", () => {
    const path = join(scratchDirectory(), "encoded16.wav");
    writeFileSync(path, encodeWav({ sampleRate: 22_050, left: Float32Array.of(1, -1, 0.5) }, 16));
    const decoded = pythonDecode(path);
    expect(decoded.sampleRate).toBe(22_050);
    expect(decoded.channels).toBe(1);
    expect(decoded.sampleWidth).toBe(2);
    expect(decoded.samples).toEqual([32767, -32768, 16384]);
  });

  it("agrees on a file the renderer actually produced", () => {
    const project = loadProject(FIXTURE).project;
    if (project === undefined) throw new Error("fixture failed to load");
    const audio = render(project, { barRange: { start: 0, end: 1 }, tailSeconds: 0 });
    const path = join(scratchDirectory(), "render.wav");
    writeWav(path, audio, 24);
    const decoded = pythonDecode(path);
    expect(decoded.sampleRate).toBe(audio.sampleRate);
    expect(decoded.channels).toBe(2);
    expect(decoded.sampleWidth).toBe(3);
    expect(decoded.frames).toBe(audio.totalSamples);

    // Every sample, as an outside decoder sees it, must be the quantisation of
    // the float master this repository computed — not merely correlated with it.
    // Every one is compared; only the reporting is condensed, because one
    // matcher call per sample would be ~93 000 of them.
    const channels = [audio.master.left, audio.master.right];
    let mismatches = 0;
    let firstMismatch = "";
    let checked = 0;
    for (let frame = 0; frame < decoded.frames; frame++) {
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
        // `| 0` only normalises Math.round's negative zero, which JSON has no
        // way to carry back from python; the words are far inside int32 range.
        const float = channels[channelIndex]![frame]!;
        const expectedWord = Math.min(Math.round(Math.min(Math.max(float, -1), 1) * 8388608), 8388607) | 0;
        const actualWord = decoded.samples[frame * 2 + channelIndex];
        if (actualWord !== expectedWord) {
          mismatches++;
          if (firstMismatch === "") {
            firstMismatch = `frame ${frame} channel ${channelIndex}: python read ${actualWord}, the float master quantises to ${expectedWord}`;
          }
        }
        checked++;
      }
    }
    expect(mismatches, firstMismatch).toBe(0);
    expect(checked).toBeGreaterThan(48_000);
  });

  it("reads back a file python wrote, so the decoder is pinned independently", () => {
    const path = join(scratchDirectory(), "python.wav");
    // Interleaved stereo: left then right, per frame.
    pythonEncode(path, 32_000, 2, [32767, -32768, 16384, -16384, 0, 0]);
    const decoded = decodeWav(readFileSync(path));
    expect(decoded.sampleRate).toBe(32_000);
    expect(decoded.bitsPerSample).toBe(16);
    expect(decoded.channels).toHaveLength(2);
    expect(Array.from(decoded.channels[0]!)).toEqual([32767 / 32768, 0.5, 0]);
    expect(Array.from(decoded.channels[1]!)).toEqual([-1, -0.5, 0]);
  });
});
