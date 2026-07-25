import { describe, expect, it } from "vitest";
import { DrumkitProcessor, type DrumVoiceSettings } from "../src/index.js";

function voice(
  length: number,
  overrides: Partial<DrumVoiceSettings> = {},
  sourceSampleRate = 1000,
): DrumVoiceSettings {
  return {
    sample: { sampleRate: sourceSampleRate, left: new Float32Array(length).fill(1) },
    gainDb100: 0,
    panPermille: 0,
    pitchCents: 0,
    chokeGroup: 0,
    ...overrides,
  };
}

function renderSampler(
  renderSampleRate: number,
  voices: Record<string, DrumVoiceSettings>,
  length: number,
  commands: { offset: number; voice: string; velocity: number }[],
): { left: Float32Array; processor: DrumkitProcessor } {
  const processor = new DrumkitProcessor(renderSampleRate, voices);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  processor.processBlock(left, right, length, commands, {});
  return { left, processor };
}

describe("drumkit sampler", () => {
  it("changes playback duration by the expected cents ratio", () => {
    const normal = renderSampler(1000, { hit: voice(100) }, 120, [{ offset: 0, voice: "hit", velocity: 1000 }]);
    const octave = renderSampler(
      1000,
      { hit: voice(100, { pitchCents: 1200 }) },
      120,
      [{ offset: 0, voice: "hit", velocity: 1000 }],
    );
    expect(nonZeroLength(normal.left)).toBe(100);
    expect(nonZeroLength(octave.left)).toBe(50);
  });

  it("chokes an earlier voice with a short release ramp", () => {
    const output = renderSampler(
      1000,
      { open: voice(1000, { chokeGroup: 1 }), closed: voice(1000, { chokeGroup: 1 }) },
      40,
      [
        { offset: 0, voice: "open", velocity: 1000 },
        { offset: 20, voice: "closed", velocity: 1000 },
      ],
    ).left;
    expect(output[20]).toBeGreaterThan(output[25]!);
    expect(output[25]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it("produces silence after the sample end", () => {
    const output = renderSampler(1000, { hit: voice(10) }, 30, [
      { offset: 0, voice: "hit", velocity: 1000 },
    ]).left;
    expect(Array.from(output.slice(10))).toEqual(new Array(20).fill(0));
  });

  it("resamples a differing source rate to the correct duration", () => {
    const output = renderSampler(
      2000,
      { hit: voice(100, {}, 1000) },
      220,
      [{ offset: 0, voice: "hit", velocity: 1000 }],
    ).left;
    expect(nonZeroLength(output)).toBe(200);
  });

  it("applies per-voice gain and hard pan", () => {
    const processor = new DrumkitProcessor(1000, {
      left: voice(10, { gainDb100: -600, panPermille: -1000 }),
      right: voice(10, { panPermille: 1000 }),
    });
    const left = new Float32Array(2);
    const right = new Float32Array(2);
    processor.processBlock(left, right, 2, [
      { offset: 0, voice: "left", velocity: 1000 },
      { offset: 1, voice: "right", velocity: 1000 },
    ], {});
    expect(left[0]).toBeCloseTo(10 ** (-6 / 20), 6);
    expect(right[0]).toBe(0);
    expect(right[1]).toBe(1);
  });
});

function nonZeroLength(values: Float32Array): number {
  let last = -1;
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== 0) last = index;
  }
  return last + 1;
}
