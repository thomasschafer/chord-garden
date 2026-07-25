import type { SynthInstrumentDoc } from "@chord-garden/format";
import { describe, expect, it } from "vitest";
import type { CompiledNoteEvent, CompiledTrack } from "../src/compiler.js";
import { CONTROL_BLOCK_SIZE } from "../src/index.js";
import { SynthTrackRunner } from "../src/graph/trackRunner.js";

const INSTRUMENT: SynthInstrumentDoc = {
  id: "synth-main",
  type: "synth",
  engine: "basic-poly",
  params: {
    oscillator: "sawtooth",
    "filter.cutoff": 4000,
    "amp.attack": 1,
    "amp.decay": 0,
    "amp.sustain": 1000,
    "amp.release": 5,
    maxVoices: 8,
  },
};

/**
 * Event shapes the fixtures do not contain but the compiler can produce, and
 * which are exactly where an incremental merge differs from a single sort: a
 * zero-length note (its note-off shares the sample of its note-on), two notes
 * starting together, a note ending precisely where the next begins, and a note
 * whose note-off falls past the end of the render.
 */
const EVENTS: CompiledNoteEvent[] = [
  { startSample: 0, durationSamples: 0, midi: 60, velocity: 900 },
  { startSample: 0, durationSamples: 1000, midi: 64, velocity: 800 },
  { startSample: 0, durationSamples: 1000, midi: 67, velocity: 700 },
  { startSample: 127, durationSamples: 1, midi: 55, velocity: 600 },
  { startSample: 128, durationSamples: 128, midi: 57, velocity: 600 },
  { startSample: 256, durationSamples: 0, midi: 59, velocity: 600 },
  { startSample: 1000, durationSamples: 4000, midi: 48, velocity: 900 },
  { startSample: 4999, durationSamples: 100_000, midi: 36, velocity: 900 },
];

const TOTAL_SAMPLES = 64 * CONTROL_BLOCK_SIZE;

/** Render the track, delivering its events in windows of `windowSize` samples. */
function renderSliced(windowSize: number): { left: Float32Array; right: Float32Array } {
  const track: CompiledTrack = {
    trackId: "synth",
    instrumentId: INSTRUMENT.id,
    events: EVENTS,
    automation: [],
  };
  const runner = new SynthTrackRunner(track, INSTRUMENT, 48_000);
  const left = new Float32Array(TOTAL_SAMPLES);
  const right = new Float32Array(TOTAL_SAMPLES);
  let horizon = 0;
  let cursor = 0;

  for (let blockStart = 0; blockStart < TOTAL_SAMPLES; blockStart += CONTROL_BLOCK_SIZE) {
    while (horizon < blockStart + CONTROL_BLOCK_SIZE) {
      horizon += windowSize;
      const due: CompiledNoteEvent[] = [];
      while (cursor < EVENTS.length && EVENTS[cursor]!.startSample < horizon) {
        due.push(EVENTS[cursor]!);
        cursor++;
      }
      runner.enqueue(due);
    }
    runner.processBlock(
      left.subarray(blockStart, blockStart + CONTROL_BLOCK_SIZE),
      right.subarray(blockStart, blockStart + CONTROL_BLOCK_SIZE),
      CONTROL_BLOCK_SIZE,
      blockStart,
    );
  }
  return { left, right };
}

describe("track runner", () => {
  it("produces identical audio however the events are sliced", () => {
    const reference = renderSliced(TOTAL_SAMPLES * 2);
    let nonZero = 0;
    for (const sample of reference.left) if (sample !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(TOTAL_SAMPLES / 2);

    for (const windowSize of [1, 7, 127, CONTROL_BLOCK_SIZE, 129, 512, 4864]) {
      const sliced = renderSliced(windowSize);
      for (let index = 0; index < TOTAL_SAMPLES; index++) {
        if (!Object.is(reference.left[index], sliced.left[index])) {
          throw new Error(`window ${windowSize} diverged at sample ${index}`);
        }
        if (!Object.is(reference.right[index], sliced.right[index])) {
          throw new Error(`window ${windowSize} diverged at sample ${index} (right)`);
        }
      }
    }
  });

  it("refuses events that arrive after the block that should have played them", () => {
    const track: CompiledTrack = { trackId: "synth", instrumentId: INSTRUMENT.id, events: [], automation: [] };
    const runner = new SynthTrackRunner(track, INSTRUMENT, 48_000);
    const left = new Float32Array(CONTROL_BLOCK_SIZE);
    const right = new Float32Array(CONTROL_BLOCK_SIZE);
    runner.processBlock(left, right, CONTROL_BLOCK_SIZE, 0);
    expect(() => runner.enqueue([{ startSample: 10, durationSamples: 10, midi: 60, velocity: 900 }])).toThrow(
      /inside a block already processed/,
    );
  });

  it("refuses events that go backwards, and blocks that do not continue", () => {
    const track: CompiledTrack = { trackId: "synth", instrumentId: INSTRUMENT.id, events: [], automation: [] };
    const runner = new SynthTrackRunner(track, INSTRUMENT, 48_000);
    runner.enqueue([{ startSample: 500, durationSamples: 10, midi: 60, velocity: 900 }]);
    expect(() => runner.enqueue([{ startSample: 400, durationSamples: 10, midi: 60, velocity: 900 }])).toThrow(
      /behind the queued sample/,
    );
    const left = new Float32Array(CONTROL_BLOCK_SIZE);
    const right = new Float32Array(CONTROL_BLOCK_SIZE);
    expect(() => runner.processBlock(left, right, CONTROL_BLOCK_SIZE, CONTROL_BLOCK_SIZE)).toThrow(
      /does not continue from 0/,
    );
  });

  it("silences its voices and forgets its queue on reset", () => {
    const track: CompiledTrack = { trackId: "synth", instrumentId: INSTRUMENT.id, events: EVENTS, automation: [] };
    const runner = new SynthTrackRunner(track, INSTRUMENT, 48_000);
    runner.enqueue(EVENTS);
    const left = new Float32Array(CONTROL_BLOCK_SIZE);
    const right = new Float32Array(CONTROL_BLOCK_SIZE);
    runner.processBlock(left, right, CONTROL_BLOCK_SIZE, 0);
    expect(runner.activeVoiceCount()).toBeGreaterThan(0);

    runner.reset(0);
    expect(runner.activeVoiceCount()).toBe(0);
    left.fill(1);
    right.fill(1);
    runner.processBlock(left, right, CONTROL_BLOCK_SIZE, 0);
    expect([...left].every((sample) => sample === 0)).toBe(true);
    expect([...right].every((sample) => sample === 0)).toBe(true);
  });
});
