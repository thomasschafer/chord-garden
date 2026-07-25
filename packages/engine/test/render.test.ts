import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProject,
  type AutomationDoc,
  type Project,
  type SynthInstrumentDoc,
} from "@chord-garden/format";
import { describe, expect, it } from "vitest";
import { CONTROL_BLOCK_SIZE, compile, decodeWav, encodeWav, render, writeWav } from "../src/index.js";
import { valueAt } from "../src/render/automation.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
/** One LSB of 24-bit PCM: a difference this small cannot survive being written out. */
const VOICE_SUM_TOLERANCE = 2 ** -23;

function synthProject(
  automation?: AutomationDoc,
  instrumentOverrides: Partial<SynthInstrumentDoc> = {},
): Project {
  const instrument: SynthInstrumentDoc = {
    id: "synth-main",
    type: "synth",
    engine: "basic-mono",
    params: {
      oscillator: "sawtooth",
      "filter.cutoff": 1000,
      "filter.resonance": 100,
      "amp.attack": 5,
      "amp.decay": 0,
      "amp.sustain": 1000,
      "amp.release": 10,
    },
    ...instrumentOverrides,
  };
  return {
    root: "",
    project: {
      format: 1,
      name: "render test",
      ppqn: 480,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: ["synth"],
    },
    tracks: new Map([
      ["synth", { id: "synth", type: "instrument", instrument: "synth-main", patterns: ["notes"] }],
    ]),
    instruments: new Map([["synth-main", instrument]]),
    patterns: new Map([
      [
        "notes",
        {
          id: "notes",
          kind: "notes",
          lengthTicks: 1920,
          notes: [{ pitch: "A3", startTick: 0, durationTicks: 1920, velocity: 900 }],
        },
      ],
    ]),
    arrangement: {
      lengthTicks: 1920,
      clips: [{ track: "synth", pattern: "notes", startTick: 0, repeatCount: 1 }],
    },
    automation: automation === undefined ? new Map() : new Map([["synth", automation]]),
  };
}

describe("automation rendering", () => {
  it("raises spectral centroid during a linear cutoff sweep without clicks", () => {
    const project = synthProject({
      track: "synth",
      lanes: [{ param: "filter.cutoff", interp: "linear", points: [[0, 200], [1920, 12000]] }],
    });
    const audio = render(project, { tailSeconds: 0 });
    const early = spectralCentroid(audio.master.left, 4096, 4096, audio.sampleRate);
    const late = spectralCentroid(audio.master.left, audio.totalSamples - 8192, 4096, audio.sampleRate);
    expect(late).toBeGreaterThan(early * 2);

    const smoothProject = synthProject(
      {
        track: "synth",
        lanes: [{ param: "filter.cutoff", interp: "linear", points: [[0, 20], [480, 20000]] }],
      },
      { params: { oscillator: "sine", "filter.cutoff": 20, "filter.resonance": 0 } },
    );
    const smooth = render(smoothProject, { tailSeconds: 0 });
    let maxJump = 0;
    for (let sample = 1; sample < 24_000; sample++) {
      maxJump = Math.max(maxJump, Math.abs(smooth.master.left[sample]! - smooth.master.left[sample - 1]!));
    }
    expect(maxJump).toBeLessThan(0.1);
  });

  it("holds a step lane and changes it at a control-block boundary", () => {
    const lane = {
      param: "gain",
      interp: "step" as const,
      points: [[0, -6000], [48_000, 0]] as [number, number][],
    };
    expect(valueAt(lane, 47_999, 0)).toBe(-6000);
    expect(valueAt(lane, 48_000, 0)).toBe(0);
    expect(48_000 % CONTROL_BLOCK_SIZE).toBe(0);

    const project = synthProject({
      track: "synth",
      lanes: [{ param: "gain", interp: "step", points: [[0, -6000], [960, 0]] }],
    });
    const audio = render(project, { tailSeconds: 0 });
    const quiet = rms(audio.master.left.subarray(10_000, 40_000));
    const loud = rms(audio.master.left.subarray(55_000, 85_000));
    expect(loud).toBeGreaterThan(quiet * 500);
  });
});

describe("WAV codec", () => {
  const left = Float32Array.of(-1, -0.5, 0, 0.25, 0.999);
  const right = Float32Array.of(0.75, 0.5, 0, -0.25, -0.999);

  for (const bits of [16, 24] as const) {
    for (const stereo of [false, true]) {
      it(`round-trips ${bits}-bit ${stereo ? "stereo" : "mono"} PCM`, () => {
        const directory = mkdtempSync(join(tmpdir(), "chord-garden-wav-"));
        const path = join(directory, "roundtrip.wav");
        const source = stereo ? { sampleRate: 44_100, left, right } : { sampleRate: 44_100, left };
        writeWav(path, source, bits);
        const decoded = decodeWav(readFileSync(path));
        rmSync(directory, { recursive: true });
        const tolerance = bits === 16 ? 1 / 32768 : 1 / 8388608;
        expect(decoded.sampleRate).toBe(44_100);
        expect(decoded.channels).toHaveLength(stereo ? 2 : 1);
        for (let index = 0; index < left.length; index++) {
          expect(Math.abs(decoded.channels[0][index]! - left[index]!)).toBeLessThanOrEqual(tolerance);
          if (stereo) {
            expect(Math.abs(decoded.channels[1]![index]! - right[index]!)).toBeLessThanOrEqual(tolerance);
          }
        }
      });
    }
  }

  it("decodes 8-bit unsigned and 32-bit signed PCM", () => {
    const eight = decodeWav(makePcmWav(8, [0, 128, 255]));
    expect(Array.from(eight.channels[0])).toEqual([-1, 0, 127 / 128]);
    const thirtyTwo = decodeWav(makePcmWav(32, [-2147483648, 0, 2147483647]));
    expect(thirtyTwo.channels[0][0]).toBe(-1);
    expect(thirtyTwo.channels[0][1]).toBe(0);
    expect(thirtyTwo.channels[0][2]).toBeCloseTo(1, 7);
  });

  it("clamps only when integer PCM is quantised", () => {
    const decoded = decodeWav(encodeWav({ sampleRate: 48_000, left: Float32Array.of(-2, 2) }, 24));
    expect(decoded.channels[0][0]).toBe(-1);
    expect(decoded.channels[0][1]).toBeCloseTo(1, 6);
  });
});

describe("offline renderer", () => {
  it("makes stems sum to the master", () => {
    const project = synthProject();
    const secondInstrument: SynthInstrumentDoc = {
      id: "second-instrument",
      type: "synth",
      engine: "basic-poly",
      params: { oscillator: "sine", gain: -600 },
    };
    project.project.trackOrder.push("second");
    project.tracks.set("second", {
      id: "second",
      type: "instrument",
      instrument: secondInstrument.id,
      patterns: ["notes"],
    });
    project.instruments.set(secondInstrument.id, secondInstrument);
    project.arrangement.clips.push({ track: "second", pattern: "notes", startTick: 0, repeatCount: 1 });

    const audio = render(project, { stems: true, tailSeconds: 0 });
    expect(audio.stems).toBeDefined();
    for (let sample = 0; sample < audio.totalSamples; sample++) {
      let left = 0;
      let right = 0;
      for (const stem of audio.stems!.values()) {
        left = Math.fround(left + stem.left[sample]!);
        right = Math.fround(right + stem.right[sample]!);
      }
      expect(audio.master.left[sample]).toBe(left);
      expect(audio.master.right[sample]).toBe(right);
    }
  });

  it("is bit-identical for the same project and seed", () => {
    const project = synthProject();
    const first = render(project, { seed: 42, tailSeconds: 0 });
    const second = render(project, { seed: 42, tailSeconds: 0 });
    expect(new Uint8Array(first.master.left.buffer)).toEqual(new Uint8Array(second.master.left.buffer));
    expect(new Uint8Array(first.master.right.buffer)).toEqual(new Uint8Array(second.master.right.buffer));
  });

  it("honours bar ranges while retaining the configured tail", () => {
    const project = synthProject();
    const audio = render(project, { barRange: { start: 0, end: 1 }, tailSeconds: 0.25 });
    expect(audio.totalSamples).toBe(96_000 + 12_000);
  });

  /**
   * Two claims, because they are not the same claim. Accumulated the way the mix
   * itself is — float32, in kit order — the voices reproduce the stem bit for
   * bit, which is what catches a dropped voice or a gain applied twice. Summed
   * naively in float64 they only agree to within float32 rounding, so that half
   * asserts a stated tolerance instead: VOICE_SUM_TOLERANCE, one LSB of the
   * 24-bit output the stems are written as, which the two-voice fixture comes in
   * an order of magnitude under.
   */
  it("sums each drumkit voice back to its track stem, bit-exactly in float32 and within a 24-bit LSB in float64", () => {
    const project = loadProject(FIXTURE).project!;
    const audio = render(project, { barRange: { start: 0, end: 2 }, stems: true, tailSeconds: 0 });
    const voices = audio.voices!.get("drums")!;
    const stem = audio.stems!.get("drums")!;
    let worstFloat64Difference = 0;

    expect([...voices.keys()]).toEqual(["hat", "kick"]);
    expect(audio.voices!.has("bass")).toBe(false);
    for (let sample = 0; sample < audio.totalSamples; sample++) {
      let left = 0;
      let right = 0;
      let naiveLeft = 0;
      let naiveRight = 0;
      for (const voice of voices.values()) {
        left = Math.fround(left + voice.left[sample]!);
        right = Math.fround(right + voice.right[sample]!);
        naiveLeft += voice.left[sample]!;
        naiveRight += voice.right[sample]!;
      }
      expect(stem.left[sample]).toBe(left);
      expect(stem.right[sample]).toBe(right);
      worstFloat64Difference = Math.max(
        worstFloat64Difference,
        Math.abs(stem.left[sample]! - naiveLeft),
        Math.abs(stem.right[sample]! - naiveRight),
      );
    }

    expect(worstFloat64Difference).toBeGreaterThan(0);
    expect(worstFloat64Difference).toBeLessThanOrEqual(VOICE_SUM_TOLERANCE);
  });

  /**
   * Choke groups reach across voices, so a voice cannot be isolated by rendering
   * it through a processor of its own. This pins that: the hat's own buffer must
   * change when the kick chokes it, and the voices must still reproduce the stem
   * bit for bit.
   */
  it("keeps cross-voice chokes inside the isolated voices", () => {
    const barRange = { start: 0, end: 2 };
    const plain = render(loadProject(FIXTURE).project!, { barRange, stems: true, tailSeconds: 0 });
    const project = loadProject(FIXTURE).project!;
    const kit = project.instruments.get("drumkit-main")!;
    project.instruments.set("drumkit-main", {
      ...kit,
      params: { "hat.chokeGroup": 1, "kick.chokeGroup": 1 },
    });
    const choked = render(project, { barRange, stems: true, tailSeconds: 0 });
    const chokedVoices = choked.voices!.get("drums")!;
    const stem = choked.stems!.get("drums")!;

    expect(chokedVoices.get("hat")!.left).not.toEqual(plain.voices!.get("drums")!.get("hat")!.left);
    for (let sample = 0; sample < choked.totalSamples; sample++) {
      let left = 0;
      for (const voice of chokedVoices.values()) left = Math.fround(left + voice.left[sample]!);
      expect(stem.left[sample]).toBe(left);
    }
  });

  it("is bit-identical per voice for the same project and seed", () => {
    const project = loadProject(FIXTURE).project!;
    const options = { barRange: { start: 0, end: 2 }, stems: true, tailSeconds: 0 };
    const first = render(project, options).voices!.get("drums")!;
    const second = render(project, options).voices!.get("drums")!;

    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [voice, audio] of first) {
      expect(new Uint8Array(second.get(voice)!.left.buffer)).toEqual(new Uint8Array(audio.left.buffer));
      expect(new Uint8Array(second.get(voice)!.right.buffer)).toEqual(new Uint8Array(audio.right.buffer));
    }
  });

  it("renders the worked fixture with audible drums and bass at schedule-plus-tail length", () => {
    const loaded = loadProject(FIXTURE);
    expect(loaded.ok).toBe(true);
    const project = loaded.project!;
    const schedule = compile(project);
    const audio = render(project, { stems: true });
    expect(audio.totalSamples).toBe(schedule.totalSamples + 2 * 48_000);
    expect(rms(audio.stems!.get("drums")!.left)).toBeGreaterThan(0.0001);
    expect(rms(audio.stems!.get("bass")!.left)).toBeGreaterThan(0.0001);
  });
});

function rms(values: Float32Array): number {
  let energy = 0;
  for (const value of values) energy += value * value;
  return Math.sqrt(energy / values.length);
}

function spectralCentroid(
  values: Float32Array,
  start: number,
  size: number,
  sampleRate: number,
): number {
  let weighted = 0;
  let magnitudeSum = 0;
  for (let bin = 0; bin <= size / 2; bin++) {
    let real = 0;
    let imag = 0;
    for (let index = 0; index < size; index++) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
      const angle = (-2 * Math.PI * bin * index) / size;
      const sample = values[start + index]! * window;
      real += sample * Math.cos(angle);
      imag += sample * Math.sin(angle);
    }
    const magnitude = Math.hypot(real, imag);
    weighted += magnitude * ((bin * sampleRate) / size);
    magnitudeSum += magnitude;
  }
  return weighted / magnitudeSum;
}

function makePcmWav(bits: 8 | 32, samples: number[]): Uint8Array {
  const bytesPerSample = bits / 8;
  const dataSize = samples.length * bytesPerSample;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  }
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 48_000 * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bits, true);
  view.setUint32(40, dataSize, true);
  samples.forEach((sample, index) => {
    if (bits === 8) view.setUint8(44 + index, sample);
    else view.setInt32(44 + index * 4, sample, true);
  });
  return bytes;
}
