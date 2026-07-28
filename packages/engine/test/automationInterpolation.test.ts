import { describe, expect, it } from "vitest";
import type { CompiledAutomationLane } from "../src/compiler.js";
import { CONTROL_BLOCK_SIZE, rampValue } from "../src/dsp/control.js";
import { db100ToGain } from "../src/dsp/units.js";
import { AutomationRamps, render } from "../src/index.js";
import {
  BAR_TICKS,
  DRUM_SAMPLE_FRAMES,
  DRUM_SAMPLE_VALUE,
  DRUM_VOICE,
  drumkitProject,
} from "./support/valueProjects.js";

/**
 * Automation is interpolated per sample, against the closed form rather than
 * against "it does not jump much".
 *
 * A lane is evaluated at each 128-sample control block's endpoints and ramped
 * across it, so flattening the ramp — returning the block's start value for all
 * 128 samples — produces a staircase whose steps are 2.7 ms apart at 48 kHz.
 * That is gradual enough to pass an anti-click test and audible as zipper noise
 * on anything with a steep lane. The only assertion that catches it is one that
 * names the value every sample should have:
 *
 *     value(n) = A + (B - A) * (n - n0) / (n1 - n0)
 *
 * for a linear lane from `A` at sample `n0` to `B` at `n1`.
 */

/**
 * At 120 BPM, 480 PPQN and 48 kHz a quarter note is 24 000 samples, so a tick is
 * 50 samples and a bar is 96 000.
 */
const SAMPLES_PER_TICK = 50;
const SPAN_TICKS = BAR_TICKS;
const SPAN_SAMPLES = SPAN_TICKS * SAMPLES_PER_TICK;
/**
 * A tick offset used for an interior breakpoint. Multiples of 64 ticks land on
 * control-block boundaries (50 x 64 = 3200 = 25 x 128), which matters because a
 * block *straddling* a breakpoint is legitimately not on either segment's line —
 * the engine ramps between that block's own endpoints — so asserting the closed
 * form across a straddle would be asserting something untrue of a correct
 * implementation. Every breakpoint here is therefore block-aligned.
 */
const KINK_TICKS = 640;
const KINK_SAMPLES = KINK_TICKS * SAMPLES_PER_TICK;

type Breakpoint = [number, number];

/** The closed form, written from the statement above and from nothing else. */
function linearValueAt(sample: number, from: Breakpoint, to: Breakpoint): number {
  const [startSample, startValue] = from;
  const [endSample, endValue] = to;
  return startValue + ((endValue - startValue) * (sample - startSample)) / (endSample - startSample);
}

/**
 * Check every sample in `[from, to)` against `expected`, reporting the worst
 * offender in a single assertion.
 *
 * Every sample really is compared; only the reporting is condensed. One
 * `expect` per sample would mean tens of thousands of matcher calls per test.
 */
function expectEverySample(
  values: ArrayLike<number>,
  expected: (sample: number) => number,
  tolerance: number,
  from: number,
  to: number,
): void {
  let worstSample = -1;
  let worstError = 0;
  for (let sample = from; sample < to; sample++) {
    const error = Math.abs(values[sample]! - expected(sample));
    if (error > worstError) {
      worstError = error;
      worstSample = sample;
    }
  }
  expect(
    worstError,
    worstSample < 0
      ? "no samples were compared"
      : `sample ${worstSample} is ${values[worstSample]!} but the closed form says ${expected(worstSample)}`,
  ).toBeLessThanOrEqual(tolerance);
}

/** Every per-sample value the control path hands the DSP across `[0, totalSamples)`. */
function perSampleValues(
  lanes: readonly CompiledAutomationLane[],
  param: string,
  fallback: number,
  totalSamples: number,
): Float64Array {
  const ramps = new AutomationRamps(lanes, { [param]: fallback });
  const values = new Float64Array(totalSamples);
  for (let blockStart = 0; blockStart < totalSamples; blockStart += CONTROL_BLOCK_SIZE) {
    const length = Math.min(CONTROL_BLOCK_SIZE, totalSamples - blockStart);
    const block = ramps.update(blockStart, length);
    for (let index = 0; index < length; index++) {
      values[blockStart + index] = rampValue(block[param], fallback, index, length);
    }
  }
  return values;
}

describe("linear automation follows the closed form, sample by sample", () => {
  it("matches A + (B - A)(n - n0)/(n1 - n0) at every sample of a single segment", () => {
    const from: Breakpoint = [0, 200];
    const to: Breakpoint = [SPAN_SAMPLES, 12_000];
    const lane: CompiledAutomationLane = { param: "filter.cutoff", interp: "linear", points: [from, to] };
    const values = perSampleValues([lane], "filter.cutoff", 1000, SPAN_SAMPLES);
    // The lane spans 11 800 Hz; a tolerance of 1e-6 Hz is ten orders below that.
    expectEverySample(values, (sample) => linearValueAt(sample, from, to), 1e-6, 0, SPAN_SAMPLES);
    // The endpoints in particular, so a ramp that is right in the middle and
    // wrong at the joins cannot hide.
    expect(values[0]).toBeCloseTo(200, 9);
    expect(values[SPAN_SAMPLES - 1]).toBeCloseTo(linearValueAt(SPAN_SAMPLES - 1, from, to), 6);
    // The step from one sample to the next is the lane's slope, everywhere. A
    // block-wide staircase would make 127 of every 128 steps exactly zero.
    const slope = (to[1] - from[1]) / (SPAN_SAMPLES - 0);
    expectEverySample(
      values,
      (sample) => values[sample - 1]! + slope,
      1e-6,
      1,
      SPAN_SAMPLES,
    );
  });

  it("follows each segment of a multi-breakpoint lane, not one line through the ends", () => {
    // A deliberately kinked lane: down, then up. A single line from first to last
    // breakpoint would satisfy the endpoints and be wrong everywhere between.
    const first: Breakpoint = [0, 8000];
    const middle: Breakpoint = [KINK_SAMPLES, 400];
    const last: Breakpoint = [SPAN_SAMPLES, 6000];
    const lane: CompiledAutomationLane = { param: "filter.cutoff", interp: "linear", points: [first, middle, last] };
    const values = perSampleValues([lane], "filter.cutoff", 1000, SPAN_SAMPLES);
    expectEverySample(values, (sample) => linearValueAt(sample, first, middle), 1e-6, 0, KINK_SAMPLES);
    expectEverySample(values, (sample) => linearValueAt(sample, middle, last), 1e-6, KINK_SAMPLES, SPAN_SAMPLES);
    // And the kink is really there: a straight line through the two ends would
    // put the midpoint of the lane far from 400.
    expect(values[KINK_SAMPLES]).toBeCloseTo(400, 6);
  });

  it("holds a step lane flat and jumps only at its breakpoints", () => {
    const lane: CompiledAutomationLane = {
      param: "filter.cutoff",
      interp: "step",
      points: [
        [0, 300],
        [KINK_SAMPLES, 9000],
      ],
    };
    const values = perSampleValues([lane], "filter.cutoff", 1000, SPAN_SAMPLES);
    expectEverySample(values, () => 300, 0, 0, KINK_SAMPLES);
    expectEverySample(values, () => 9000, 0, KINK_SAMPLES, SPAN_SAMPLES);
  });

  it("uses the instrument's static value until the lane's first breakpoint", () => {
    const start = CONTROL_BLOCK_SIZE * 4;
    const lane: CompiledAutomationLane = { param: "filter.cutoff", interp: "linear", points: [[start, 5000]] };
    const values = perSampleValues([lane], "filter.cutoff", 1234, CONTROL_BLOCK_SIZE * 8);
    // Up to the block that *contains* the first breakpoint. That block is where
    // the engine ramps from the static value into the lane rather than stepping,
    // which is a property of evaluating lanes at block endpoints and is bounded
    // by one control block — 2.7 ms at 48 kHz.
    expectEverySample(values, () => 1234, 0, 0, start - CONTROL_BLOCK_SIZE);
    expectEverySample(values, () => 5000, 0, start, CONTROL_BLOCK_SIZE * 8);
  });
});

describe("linear automation reaches the audio sample by sample", () => {
  it("puts every rendered sample where the closed form says, through a real render", () => {
    // Hard left, so the pan gain is exactly 1, and a DC sample, so the rendered
    // value is `sampleValue x velocityGain x dBGain` with nothing else in it.
    // The only thing varying across the bar is the automated gain.
    const from: Breakpoint = [0, -2400];
    const to: Breakpoint = [SPAN_SAMPLES, 0];
    const { project, cleanup } = drumkitProject({
      voiceParams: { pan: -1000 },
      velocities: [1000],
      automation: {
        track: "drums",
        lanes: [
          {
            param: `${DRUM_VOICE}.gain`,
            interp: "linear",
            points: [
              [0, from[1]],
              [SPAN_TICKS, to[1]],
            ],
          },
        ],
      },
    });
    try {
      const audio = render(project, { tailSeconds: 0, stems: true });
      const voice = audio.voices?.get("drums")?.get(DRUM_VOICE);
      if (voice === undefined) throw new Error("kit voice audio missing");
      expect(audio.totalSamples).toBe(SPAN_SAMPLES);

      // The hit sounds for exactly the sample's length, so that is the window
      // over which the audio can be compared to the law at all.
      const window = DRUM_SAMPLE_FRAMES;
      expect(window).toBeLessThan(SPAN_SAMPLES);
      expectEverySample(
        voice.left,
        (sample) => DRUM_SAMPLE_VALUE * db100ToGain(linearValueAt(sample, from, to)),
        1e-6,
        0,
        window,
      );

      // A 128-sample staircase holds each value for a whole block. On a monotone
      // lane a per-sample ramp changes value at essentially every sample, so this
      // fails outright the moment the ramp is flattened.
      let distinctValues = 0;
      let previous = Number.NaN;
      for (let sample = 0; sample < window; sample++) {
        if (voice.left[sample] !== previous) distinctValues++;
        previous = voice.left[sample]!;
      }
      expect(distinctValues).toBeGreaterThan(window * 0.9);
    } finally {
      cleanup();
    }
  });
});
