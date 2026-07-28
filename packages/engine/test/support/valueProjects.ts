import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AutomationDoc,
  DrumkitInstrumentDoc,
  NoteEvent,
  Project,
  SynthEngine,
  SynthInstrumentDoc,
} from "@chord-garden/format";
import { encodeWav } from "../../src/render/wav.js";

/**
 * Project builders for the tests that assert *values* rather than shape.
 *
 * Those tests need a signal path whose output can be written down in closed
 * form before the renderer is run, so the assertion can be an equation rather
 * than a golden. Hence the deliberate choices here: one note or one hit, one
 * track, no effects, and — for the drumkit — a synthetic sample whose every
 * frame is an exactly representable constant.
 */

export const TEST_PPQN = 480;
/** One bar of 4/4 at `TEST_PPQN`. */
export const BAR_TICKS = TEST_PPQN * 4;

export interface SynthProjectOptions {
  engine?: SynthEngine;
  /** Merged over the defaults below, so a test states only what it depends on. */
  params?: Record<string, number | string>;
  notes?: NoteEvent[];
  automation?: AutomationDoc;
  bpm100?: number;
}

/**
 * A synth voice with everything that could colour the amplitude turned off:
 * instant attack, no decay, full sustain, no filter envelope, a sine at 0 dB.
 * What remains between the oscillator and the output is the filter (never
 * exactly unity, so absolute peaks are not predictable), velocity, and pan.
 */
export const NEUTRAL_SYNTH_PARAMS: Readonly<Record<string, number | string>> = {
  oscillator: "sine",
  "filter.type": "lowpass",
  "filter.cutoff": 20_000,
  "filter.resonance": 0,
  "filterEnv.amount": 0,
  "amp.attack": 0,
  "amp.decay": 0,
  "amp.sustain": 1000,
  "amp.release": 0,
  gain: 0,
  pan: 0,
};

export function synthProject(options: SynthProjectOptions = {}): Project {
  const notes = options.notes ?? [{ pitch: "A3", startTick: 0, durationTicks: BAR_TICKS, velocity: 1000 }];
  const instrument: SynthInstrumentDoc = {
    id: "synth-main",
    type: "synth",
    engine: options.engine ?? "basic-mono",
    params: { ...NEUTRAL_SYNTH_PARAMS, ...options.params },
  };
  return {
    root: "",
    project: {
      format: 1,
      name: "value test",
      ppqn: TEST_PPQN,
      tempoMap: [{ startTick: 0, bpm: options.bpm100 ?? 12_000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: ["synth"],
    },
    tracks: new Map([["synth", { id: "synth", type: "instrument", instrument: "synth-main", patterns: ["notes"] }]]),
    instruments: new Map([["synth-main", instrument]]),
    patterns: new Map([["notes", { id: "notes", kind: "notes", lengthTicks: BAR_TICKS, notes }]]),
    arrangement: {
      lengthTicks: BAR_TICKS,
      clips: [{ track: "synth", pattern: "notes", startTick: 0, repeatCount: 1 }],
    },
    automation: options.automation === undefined ? new Map() : new Map([["synth", options.automation]]),
  };
}

/**
 * The constant every frame of the synthetic drum sample holds.
 *
 * 0.5 survives 24-bit quantisation exactly (0.5 x 2^23 is an integer), so a test
 * can multiply it by the pan and velocity laws and compare to the rendered
 * sample with no allowance for the file format at all.
 */
export const DRUM_SAMPLE_VALUE = 0.5;
/** One second at 48 kHz, so a single hit sounds across a whole bar of automation. */
export const DRUM_SAMPLE_FRAMES = 48_000;
export const DRUM_VOICE = "thud";

export interface DrumkitProjectOptions {
  /** Merged into the kit voice's params under the `<voice>.` prefix. */
  voiceParams?: Record<string, number | string>;
  /** Velocities of the hits, one per sixteenth from the top of the bar. */
  velocities?: number[];
  automation?: AutomationDoc;
}

export interface DrumkitProjectHandle {
  project: Project;
  cleanup: () => void;
}

/**
 * A one-voice kit whose sample is a DC constant at `DRUM_SAMPLE_VALUE`.
 *
 * A constant means the sampler's linear interpolation is exact and the hit's
 * amplitude is a pure product of the gain stages, so the expected output is
 * `DRUM_SAMPLE_VALUE x velocityLaw(v) x panGain x dBGain` with nothing left
 * over. The caller must call `cleanup`; the sample has to exist on disk because
 * the offline renderer resolves samples through the filesystem.
 */
export function drumkitProject(options: DrumkitProjectOptions = {}): DrumkitProjectHandle {
  const root = mkdtempSync(join(tmpdir(), "chord-garden-kit-"));
  writeFileSync(
    join(root, "constant.wav"),
    encodeWav({ sampleRate: 48_000, left: new Float32Array(DRUM_SAMPLE_FRAMES).fill(DRUM_SAMPLE_VALUE) }, 24),
  );

  const velocities = options.velocities ?? [1000];
  const stepsPerBar = 16;
  const steps = velocities.map(() => "x").join("") + ".".repeat(stepsPerBar - velocities.length);
  const instrument: DrumkitInstrumentDoc = {
    id: "kit",
    type: "drumkit",
    kit: { [DRUM_VOICE]: { sample: "constant.wav" } },
    params: Object.fromEntries(
      Object.entries(options.voiceParams ?? {}).map(([key, value]) => [`${DRUM_VOICE}.${key}`, value]),
    ),
  };
  const project: Project = {
    root,
    project: {
      format: 1,
      name: "value test kit",
      ppqn: TEST_PPQN,
      tempoMap: [{ startTick: 0, bpm: 12_000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: ["drums"],
    },
    tracks: new Map([["drums", { id: "drums", type: "drumkit", instrument: "kit", patterns: ["hits"] }]]),
    instruments: new Map([["kit", instrument]]),
    patterns: new Map([
      [
        "hits",
        {
          id: "hits",
          kind: "grid",
          lengthTicks: BAR_TICKS,
          lanes: [
            {
              lane: DRUM_VOICE,
              grid: { stepsPerBar },
              steps,
              stepEvents: velocities.map((velocity, step) => ({ step, velocity })),
            },
          ],
        },
      ],
    ]),
    arrangement: {
      lengthTicks: BAR_TICKS,
      clips: [{ track: "drums", pattern: "hits", startTick: 0, repeatCount: 1 }],
    },
    automation: options.automation === undefined ? new Map() : new Map([["drums", options.automation]]),
  };
  return { project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Largest absolute sample in `[from, to)`. */
export function peak(samples: Float32Array, from = 0, to = samples.length): number {
  let highest = 0;
  for (let index = from; index < to; index++) {
    const magnitude = Math.abs(samples[index]!);
    if (magnitude > highest) highest = magnitude;
  }
  return highest;
}
