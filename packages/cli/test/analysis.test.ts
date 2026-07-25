import type { CompiledSchedule, StereoAudio } from "@chord-garden/engine";
import { describe, expect, it } from "vitest";
import { analyzeRender, type AnalysisReport } from "../src/analysis.js";

const SAMPLE_RATE = 48_000;
const BUFFER_SAMPLES = 48_000;
const TRANSIENT_SPACING = 4_800;
/**
 * A 2 ms attack is the shape that exposed the sample-0 blind spot: the first
 * analysis window holds slightly less energy than the next one, so the onset is
 * only found if the windows before sample 0 count as silence.
 */
const RAMPED_ATTACK_SAMPLES = 96;
/** Peaks 0.25 ms in, so the envelope peak and the transient start coincide. */
const SHARP_ATTACK_SAMPLES = 12;
const DEFAULT_AMPLITUDE = 0.8;
/** Comfortably inside SPURIOUS_MAX_ATTACK_LAG_MS (30 ms). */
const INSIDE_ATTACK_LAG_SAMPLES = 720;
/** Comfortably outside it — a 32nd note at 124 BPM, the case that must stay visible. */
const OUTSIDE_ATTACK_LAG_SAMPLES = 2_880;

interface Transient {
  start: number;
  amplitude: number;
}

describe("scheduled onset detection", () => {
  it("detects and matches a transient at sample 0", () => {
    const report = analyze([0], [0]);
    const track = trackOf(report);

    expect(track.onsets.expected).toBe(1);
    expect(track.onsets.detected).toBe(1);
    expect(track.onsets.matched).toBe(1);
    expect(track.onsets.unmatchedExpected).toEqual([]);
    expect(Math.abs(track.onsets.maxOffsetSamples)).toBeLessThanOrEqual(
      report.parameters.onset.toleranceSamples,
    );
    expect(report.warnings).toEqual([]);
  });

  it("detects a transient at sample 0 exactly as it does the same transient later in the buffer", () => {
    for (const start of [0, TRANSIENT_SPACING, 2 * TRANSIENT_SPACING]) {
      const track = trackOf(analyze([start], [start]));
      expect({ start, matched: track.onsets.matched, unmatched: track.onsets.unmatchedExpected }).toEqual({
        start,
        matched: 1,
        unmatched: [],
      });
    }
  });

  it("detects transients at sample 0 and at the downbeats that follow", () => {
    const starts = [0, TRANSIENT_SPACING, 2 * TRANSIENT_SPACING, 3 * TRANSIENT_SPACING];
    const track = trackOf(analyze(starts, starts));

    expect(track.onsets.matched).toBe(starts.length);
    expect(track.onsets.spurious).toBe(0);
    expect(track.onsets.unmatchedExpected).toEqual([]);
  });

  it("reports the pre-buffer-as-silence baseline in the parameters block", () => {
    const report = analyze([0], [0]);
    expect(report.parameters.onset.preBufferTreatedAsSilence).toBe(true);
    expect(report.parameters.onset.baselineLookbackFrames).toBe(
      report.parameters.onset.windowSamples / report.parameters.onset.hopSamples,
    );
  });
});

describe("expected onset positions", () => {
  it("lists the scheduled positions and matches the offsets reported against them", () => {
    const starts = [0, TRANSIENT_SPACING, 2 * TRANSIENT_SPACING];
    const track = trackOf(analyze(starts, starts));

    expect(track.onsets.expectedPositions).toEqual(starts);
    expect(track.onsets.unmatchedExpected).toEqual([]);
  });

  it("caps the list at the reported limit and leaves the truncation visible", () => {
    const scheduled = Array.from({ length: 300 }, (_, index) => index * 160);
    const report = analyze([], scheduled);
    const onsets = trackOf(report).onsets;
    const limit = report.parameters.onset.expectedPositionsLimit;

    expect(onsets.expected).toBe(scheduled.length);
    expect(onsets.expectedPositions).toEqual(scheduled.slice(0, limit));
    expect(onsets.expectedPositions.length).toBeLessThan(onsets.expected);
  });
});

describe("spurious onset positions", () => {
  it("places reported positions within the documented tolerance of the real transients", () => {
    const unscheduled = [TRANSIENT_SPACING, 2 * TRANSIENT_SPACING, 3 * TRANSIENT_SPACING, 4 * TRANSIENT_SPACING];
    const report = analyze([0, ...unscheduled], [0], SHARP_ATTACK_SAMPLES);
    const track = trackOf(report);
    const tolerance = report.parameters.onset.spurious.timestampMaxErrorSamples;

    expect(tolerance).toBe(report.parameters.onset.spurious.hopSamples);
    // One hop at 48 kHz: 1 ms, well inside the "a few ms" an agent can act on.
    expect(tolerance).toBeLessThanOrEqual(SAMPLE_RATE / 1_000);
    expect(track.onsets.matched).toBe(1);
    expect(track.onsets.spurious).toBe(unscheduled.length);
    expect(track.onsets.spuriousPositions).toHaveLength(unscheduled.length);
    for (const [index, position] of track.onsets.spuriousPositions.entries()) {
      expect(Math.abs(position - unscheduled[index]!)).toBeLessThanOrEqual(tolerance);
    }
  });

  it("keeps a ramped transient's position within one hop of its envelope peak", () => {
    const unscheduled = [TRANSIENT_SPACING, 2 * TRANSIENT_SPACING];
    const report = analyze([0, ...unscheduled], [0], RAMPED_ATTACK_SAMPLES);
    const track = trackOf(report);
    const tolerance = report.parameters.onset.spurious.timestampMaxErrorSamples;

    expect(track.onsets.spurious).toBe(unscheduled.length);
    for (const [index, position] of track.onsets.spuriousPositions.entries()) {
      const peak = unscheduled[index]! + RAMPED_ATTACK_SAMPLES;
      expect(position).toBeGreaterThan(peak - tolerance - 1);
      expect(position).toBeLessThanOrEqual(peak);
    }
  });
});

describe("spurious onset attribution", () => {
  /**
   * Pins both sides of the SPURIOUS_MAX_ATTACK_LAG_MS blind spot. The quiet
   * scheduled hit is followed by a louder unscheduled one, so the envelope
   * genuinely rises at the second transient either way — the "nothing
   * scheduled" run proves the detector sees it, so a spurious count of zero can
   * only come from attribution, never from the detector missing the sound.
   */
  it("excuses a candidate inside the attack lag and reports one outside it", () => {
    const scheduled: Transient = { start: 0, amplitude: 0.5 };
    const inside: Transient = { start: INSIDE_ATTACK_LAG_SAMPLES, amplitude: 0.9 };
    const outside: Transient = { start: OUTSIDE_ATTACK_LAG_SAMPLES, amplitude: 0.9 };

    const insideReport = analyzeTransients([scheduled, inside], [0], SHARP_ATTACK_SAMPLES);
    const insideUnscheduled = analyzeTransients([scheduled, inside], [], SHARP_ATTACK_SAMPLES);
    const outsideReport = analyzeTransients([scheduled, outside], [0], SHARP_ATTACK_SAMPLES);
    const attribution = insideReport.parameters.onset.spurious.attribution;

    expect(INSIDE_ATTACK_LAG_SAMPLES).toBeLessThan(attribution.latestSamples);
    expect(OUTSIDE_ATTACK_LAG_SAMPLES).toBeGreaterThan(attribution.latestSamples);

    expect(trackOf(insideUnscheduled).onsets.spuriousPositions).toEqual([0, INSIDE_ATTACK_LAG_SAMPLES]);
    expect(trackOf(insideReport).onsets.matched).toBe(1);
    expect(trackOf(insideReport).onsets.spurious).toBe(0);
    expect(insideReport.warnings).toEqual([]);

    expect(trackOf(outsideReport).onsets.matched).toBe(1);
    expect(trackOf(outsideReport).onsets.spurious).toBe(1);
    expect(trackOf(outsideReport).onsets.spuriousPositions).toEqual([OUTSIDE_ATTACK_LAG_SAMPLES]);
  });

  it("reports the attack lag as a named millisecond judgement, not a derived window", () => {
    const attribution = analyze([0], [0]).parameters.onset.spurious.attribution;
    expect(attribution.maxAttackLagMs).toBe(30);
    expect(attribution.latestSamples).toBe((attribution.maxAttackLagMs * SAMPLE_RATE) / 1_000);
    // Asymmetric: sound cannot precede the note that makes it.
    expect(attribution.earliestSamples).toBe(-576);
    expect(attribution.latestSamples).toBeGreaterThan(-attribution.earliestSamples);
  });
});

function analyze(
  transientStarts: readonly number[],
  expectedStarts: readonly number[],
  attackSamples = RAMPED_ATTACK_SAMPLES,
): AnalysisReport {
  return analyzeTransients(
    transientStarts.map((start) => ({ start, amplitude: DEFAULT_AMPLITUDE })),
    expectedStarts,
    attackSamples,
  );
}

function analyzeTransients(
  transients: readonly Transient[],
  expectedStarts: readonly number[],
  attackSamples = RAMPED_ATTACK_SAMPLES,
): AnalysisReport {
  const audio = silence(BUFFER_SAMPLES);
  for (const transient of transients) {
    writeTransient(audio, transient.start, attackSamples, transient.amplitude);
  }
  return analyzeRender(audio, new Map([["kit", audio]]), schedule(expectedStarts), { seed: 0 });
}

function trackOf(report: AnalysisReport) {
  const track = report.tracks.find((candidate) => candidate.id === "kit");
  if (track === undefined) throw new Error("analysis report is missing the kit track");
  return track;
}

function silence(length: number): StereoAudio {
  return { left: new Float32Array(length), right: new Float32Array(length) };
}

/** 4 kHz burst: linear ramp up over the attack, linear decay back to silence. */
function writeTransient(
  audio: StereoAudio,
  start: number,
  attackSamples: number,
  amplitude: number,
): void {
  const decaySamples = 192;
  for (let index = 0; index < attackSamples + decaySamples; index++) {
    const envelope =
      index < attackSamples
        ? index / attackSamples
        : 1 - (index - attackSamples) / decaySamples;
    const value = Math.sin((2 * Math.PI * 4_000 * index) / SAMPLE_RATE) * envelope * amplitude;
    audio.left[start + index] = value;
    audio.right[start + index] = value;
  }
}

function schedule(expectedStarts: readonly number[]): CompiledSchedule {
  return {
    sampleRate: SAMPLE_RATE,
    seed: 0,
    totalSamples: BUFFER_SAMPLES,
    tracks: [
      {
        trackId: "kit",
        instrumentId: "kit-instrument",
        events: expectedStarts.map((startSample) => ({
          startSample,
          durationSamples: 240,
          midi: 36,
          velocity: 1_000,
          voice: "tick",
        })),
        automation: [],
      },
    ],
  };
}
