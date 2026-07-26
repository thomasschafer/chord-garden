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

/**
 * Replacing the audio behind a kit voice while it is sounding (PLAN.md §14).
 *
 * The DSP half of "do not click": whoever swaps `settings.sample` — the worklet does,
 * on a `sampleData` command — must not thereby change the waveform of a hit that is
 * already in flight, because splicing two unrelated buffers together mid-voice is a
 * step discontinuity, and a click is the wrong sound for "your file was picked up".
 */
describe("replacing a voice's sample while it plays", () => {
  /**
   * A voice whose buffer is a constant `level`, so a swap is visible sample by
   * sample. Panned hard left, so the left channel carries the amplitude itself
   * rather than the centre pan's 1/√2 of it.
   */
  function flat(level: number, length = 20): DrumVoiceSettings {
    return voice(length, {
      sample: { sampleRate: 1000, left: new Float32Array(length).fill(level) },
      panPermille: -1000,
    });
  }

  it("leaves a sounding hit on the buffer it started with", () => {
    const settings = { hit: flat(1) };
    const processor = new DrumkitProcessor(1000, settings);
    const left = new Float32Array(10);
    const right = new Float32Array(10);

    processor.processBlock(left, right, 5, [{ offset: 0, voice: "hit", velocity: 1000 }], {});
    // The replacement lands between blocks, exactly where the worklet delivers it.
    settings.hit.sample = { sampleRate: 1000, left: new Float32Array(20).fill(0.25) };
    processor.processBlock(left.subarray(5), right.subarray(5), 5, [], {});

    // Not one sample of the hit that was already sounding moved.
    expect(Array.from(left)).toEqual(new Array(10).fill(1));
  });

  it("uses the replacement for the next hit of that voice", () => {
    const settings = { hit: flat(1) };
    const processor = new DrumkitProcessor(1000, settings);
    const left = new Float32Array(10);
    const right = new Float32Array(10);

    processor.processBlock(left, right, 5, [{ offset: 0, voice: "hit", velocity: 1000 }], {});
    settings.hit.sample = { sampleRate: 1000, left: new Float32Array(20).fill(0.25) };
    processor.processBlock(left.subarray(5), right.subarray(5), 5, [{ offset: 0, voice: "hit", velocity: 1000 }], {});

    // The first hit is still ringing at 1 and the second adds the new buffer's 0.25:
    // adopted at the trigger, which is a step away rather than a bar away.
    expect(left[4]).toBe(1);
    expect(left[5]).toBeCloseTo(1.25, 6);
  });

  it("plays a sounding hit out to the length of the buffer it started with", () => {
    // Both ends of the swap: how long the hit lasts and when it is retired come from
    // the buffer it was triggered on, so a shorter replacement does not cut it off
    // early and a longer one does not extend it. The rate was taken from that buffer's
    // sample rate at the same moment, which is why the two can never describe different
    // files.
    const settings = { hit: flat(1, 100) };
    const processor = new DrumkitProcessor(1000, settings);
    const left = new Float32Array(200);
    const right = new Float32Array(200);

    processor.processBlock(left, right, 10, [{ offset: 0, voice: "hit", velocity: 1000 }], {});
    settings.hit.sample = { sampleRate: 4000, left: new Float32Array(40).fill(1) };
    for (let block = 10; block < 200; block += 10) {
      processor.processBlock(left.subarray(block), right.subarray(block), 10, [], {});
    }

    expect(nonZeroLength(left)).toBe(100);
    expect(processor.getActiveVoiceCount()).toBe(0);
  });
});

function nonZeroLength(values: Float32Array): number {
  let last = -1;
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== 0) last = index;
  }
  return last + 1;
}
