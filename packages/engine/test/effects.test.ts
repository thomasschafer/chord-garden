import {
  DELAY_PARAMS,
  FILTER_EFFECT_PARAMS,
  REVERB_PARAMS,
  type EffectDoc,
  type ParamSpec,
} from "@chord-garden/format";
import { describe, expect, it } from "vitest";
import {
  CONTROL_BLOCK_SIZE,
  DelayEffect,
  EffectChain,
  FilterEffect,
  ReverbEffect,
  SILENCE_FLOOR,
  effectChainSpecs,
  effectStaticValues,
  flushToZero,
  type EffectSpec,
  type ParamRamp,
  type ParamRamps,
} from "../src/index.js";

/** A registry entry, or a loud failure: a missing param means the table moved. */
function spec(table: Record<string, ParamSpec>, param: string): ParamSpec {
  const found = table[param];
  if (found === undefined) throw new Error(`the registry has no "${param}" in this table`);
  return found;
}

function bound(table: Record<string, ParamSpec>, param: string, which: "min" | "max"): number {
  const value = spec(table, param)[which];
  if (value === undefined) throw new Error(`"${param}" has no ${which}`);
  return value;
}

const SAMPLE_RATE = 48_000;

/** No automation: every param sits at its settings value. */
const STATIC: ParamRamps = {};

function ramp(param: string, start: number, end: number): ParamRamps {
  const value: ParamRamp = { start, end };
  return { [param]: value };
}

interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

function stereo(length: number): Stereo {
  return { left: new Float32Array(length), right: new Float32Array(length) };
}

/**
 * Runs `effect` over `length` samples in `CONTROL_BLOCK_SIZE` blocks, feeding a
 * single full-scale impulse at sample 0 and silence thereafter. Blocked rather
 * than one long call because that is how both the renderer and the worklet drive
 * these, so a bug that only appears at a block boundary is reachable.
 */
function impulseResponse(
  effect: { processBlock(l: Float32Array, r: Float32Array, n: number, ramps: ParamRamps): void },
  length: number,
  ramps: ParamRamps = STATIC,
): Stereo {
  const out = stereo(length);
  out.left[0] = 1;
  out.right[0] = 1;
  for (let start = 0; start < length; start += CONTROL_BLOCK_SIZE) {
    const size = Math.min(CONTROL_BLOCK_SIZE, length - start);
    effect.processBlock(
      out.left.subarray(start, start + size),
      out.right.subarray(start, start + size),
      size,
      ramps,
    );
  }
  return out;
}

function peak(values: Float32Array, from = 0): number {
  let highest = 0;
  for (let index = from; index < values.length; index++) highest = Math.max(highest, Math.abs(values[index]!));
  return highest;
}

/** The last index holding anything at all, or -1 when the buffer is exactly zero. */
function lastNonZero(values: Float32Array): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index] !== 0) return index;
  }
  return -1;
}

function allFinite(values: Float32Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

function delay(overrides: { time?: number; feedback?: number; damping?: number; mix?: number } = {}): DelayEffect {
  return new DelayEffect("d", SAMPLE_RATE, {
    timeMs: overrides.time ?? 100,
    feedbackPermille: overrides.feedback ?? 0,
    dampingPermille: overrides.damping ?? 0,
    mixPermille: overrides.mix ?? 1000,
  });
}

function reverb(overrides: { size?: number; damping?: number; width?: number; mix?: number } = {}): ReverbEffect {
  return new ReverbEffect("r", SAMPLE_RATE, {
    sizePermille: overrides.size ?? 500,
    dampingPermille: overrides.damping ?? 0,
    widthPermille: overrides.width ?? 1000,
    mixPermille: overrides.mix ?? 1000,
  });
}

describe("the silence floor", () => {
  it("flushes only what is far below a 24-bit LSB, and catches a non-finite state", () => {
    // 6e-8 is one 24-bit LSB: the render's own resolution must survive untouched.
    expect(flushToZero(6e-8)).toBe(6e-8);
    expect(flushToZero(-6e-8)).toBe(-6e-8);
    expect(SILENCE_FLOOR).toBeLessThan(6e-8);
    expect(flushToZero(SILENCE_FLOOR / 2)).toBe(0);
    expect(flushToZero(-SILENCE_FLOOR / 2)).toBe(0);
    expect(flushToZero(Number.NaN)).toBe(0);
    expect(flushToZero(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("delay", () => {
  it("repeats the input at its delay time", () => {
    const response = impulseResponse(delay({ time: 100, feedback: 0, mix: 1000 }), SAMPLE_RATE);
    const expected = (100 * SAMPLE_RATE) / 1000;
    expect(response.left[expected]).toBeCloseTo(1, 5);
    // Fully wet, so the dry impulse is gone and the repeat is the only sound.
    expect(response.left[0]).toBe(0);
    expect(peak(response.left, expected + 1)).toBe(0);
  });

  it("passes the dry signal through untouched at mix 0", () => {
    const response = impulseResponse(delay({ time: 100, feedback: 900, mix: 0 }), SAMPLE_RATE);
    expect(response.left[0]).toBe(1);
    expect(peak(response.left, 1)).toBe(0);
  });

  /**
   * The guarantee the registry's `feedback` maximum exists to make. Not "stays
   * small": stays finite, stays bounded by the input, and *stops* — a geometric
   * tail that is merely quiet still keeps a buffer non-silent forever, so the
   * assertion is exact zero.
   */
  it("stays finite and bounded at maximum feedback, and decays to exactly zero", () => {
    const feedback = bound(DELAY_PARAMS, "feedback", "max");
    const timeMs = 10;
    const effect = delay({ time: timeMs, feedback, damping: 0, mix: 1000 });
    // 0.95 per repeat needs ~404 repeats to cross the floor; 10 ms repeats make
    // that ~4 s, and the length is derived rather than guessed so the test cannot
    // quietly stop proving anything if the floor moves.
    const repeats = Math.log(SILENCE_FLOOR) / Math.log(feedback / 1000);
    const length = Math.ceil((repeats + 4) * timeMs * (SAMPLE_RATE / 1000));
    const response = impulseResponse(effect, length);

    expect(allFinite(response.left)).toBe(true);
    expect(allFinite(response.right)).toBe(true);
    // No repeat may exceed the impulse that made it.
    expect(peak(response.left)).toBeLessThanOrEqual(1);
    // It really did ring for a long time rather than dying immediately.
    const stopped = lastNonZero(response.left);
    expect(stopped).toBeGreaterThan(300 * timeMs * (SAMPLE_RATE / 1000));
    expect(stopped).toBeLessThan(length - 1);

    // And once stopped it stays stopped, even fed more silence: nothing is left in
    // the line to trickle back out.
    const after = stereo(SAMPLE_RATE);
    for (let start = 0; start < after.left.length; start += CONTROL_BLOCK_SIZE) {
      effect.processBlock(
        after.left.subarray(start, start + CONTROL_BLOCK_SIZE),
        after.right.subarray(start, start + CONTROL_BLOCK_SIZE),
        CONTROL_BLOCK_SIZE,
        STATIC,
      );
    }
    expect(lastNonZero(after.left)).toBe(-1);
    expect(lastNonZero(after.right)).toBe(-1);
  });

  it("darkens successive repeats as damping rises, without shortening the first one", () => {
    const time = 20;
    const bright = impulseResponse(delay({ time, feedback: 800, damping: 0, mix: 1000 }), SAMPLE_RATE);
    const dark = impulseResponse(delay({ time, feedback: 800, damping: 1000, mix: 1000 }), SAMPLE_RATE);
    const step = (time * SAMPLE_RATE) / 1000;
    // The first repeat is the delayed signal itself, before any feedback filtering.
    expect(dark.left[step]).toBeCloseTo(bright.left[step]!, 5);
    // Later repeats have been through the loop filter, so they carry less energy.
    expect(peak(dark.left, step * 4)).toBeLessThan(peak(bright.left, step * 4));
  });

  it("sizes its line for the registry's maximum time, so time never reallocates", () => {
    const maximumMs = bound(DELAY_PARAMS, "time", "max");
    const effect = delay({ time: maximumMs });
    expect(effect.lineSamples).toBeGreaterThan((maximumMs * SAMPLE_RATE) / 1000);
    const response = impulseResponse(effect, SAMPLE_RATE * 3);
    expect(response.left[(maximumMs * SAMPLE_RATE) / 1000]).toBeCloseTo(1, 5);
  });
});

describe("reverb", () => {
  it("produces a decaying tail from an impulse", () => {
    const response = impulseResponse(reverb({ size: 500, mix: 1000 }), SAMPLE_RATE);
    const early = peak(response.left.subarray(0, SAMPLE_RATE / 4));
    const late = peak(response.left.subarray(SAMPLE_RATE / 2));
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(early);
  });

  it("passes the dry signal through untouched at mix 0", () => {
    const response = impulseResponse(reverb({ size: 1000, mix: 0 }), SAMPLE_RATE);
    expect(response.left[0]).toBe(1);
    expect(peak(response.left, 1)).toBe(0);
  });

  /**
   * The counterpart of the delay's stability test, and the reason `size` maps to a
   * recirculation gain strictly below 1: at the registry's maximum the tail is very
   * long but it is still a decay, and it still terminates exactly.
   */
  it("stays finite and bounded at maximum size, and decays to exactly zero", () => {
    const effect = reverb({ size: bound(REVERB_PARAMS, "size", "max"), damping: 0, mix: 1000 });
    const length = 40 * SAMPLE_RATE;
    const response = impulseResponse(effect, length);

    expect(allFinite(response.left)).toBe(true);
    expect(allFinite(response.right)).toBe(true);
    // Bounded, not merely finite: eight parallel combs could sum well above the
    // input if the wet trim were wrong.
    expect(peak(response.left)).toBeLessThan(2);
    const stopped = lastNonZero(response.left);
    // Genuinely a long tail, and genuinely over before the buffer ends.
    expect(stopped).toBeGreaterThan(10 * SAMPLE_RATE);
    expect(stopped).toBeLessThan(length - 1);
    expect(lastNonZero(response.right)).toBeLessThan(length - 1);
  });

  it("shortens the tail as damping rises", () => {
    const length = 4 * SAMPLE_RATE;
    const bright = impulseResponse(reverb({ size: 800, damping: 0, mix: 1000 }), length);
    const dark = impulseResponse(reverb({ size: 800, damping: 1000, mix: 1000 }), length);
    // Measured as level late in the tail rather than as a termination index: at
    // size 800 neither has reached the silence floor inside this buffer, so
    // comparing where they stop would compare two truncations.
    expect(peak(dark.left, length - SAMPLE_RATE)).toBeLessThan(peak(bright.left, length - SAMPLE_RATE) / 2);
  });

  it("terminates sooner with damping, at a size whose tail fits in the buffer", () => {
    const length = 4 * SAMPLE_RATE;
    const bright = impulseResponse(reverb({ size: 0, damping: 0, mix: 1000 }), length);
    const dark = impulseResponse(reverb({ size: 0, damping: 1000, mix: 1000 }), length);
    // Both reach exact zero here, so the indices are real terminations.
    expect(lastNonZero(bright.left)).toBeLessThan(length - 1);
    expect(lastNonZero(dark.left)).toBeLessThan(lastNonZero(bright.left));
  });

  it("decorrelates the channels at full width and collapses them at zero", () => {
    const wide = impulseResponse(reverb({ width: 1000, mix: 1000 }), SAMPLE_RATE);
    const narrow = impulseResponse(reverb({ width: 0, mix: 1000 }), SAMPLE_RATE);
    // A mono input through offset lines gives two different tails.
    expect(peak(difference(wide.left, wide.right))).toBeGreaterThan(0);
    // At zero width both sides carry the same sum, so the tail is centred.
    expect(peak(difference(narrow.left, narrow.right))).toBe(0);
  });
});

function difference(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(left.length);
  for (let index = 0; index < left.length; index++) out[index] = left[index]! - right[index]!;
  return out;
}

describe("filter effect", () => {
  it("cuts high frequencies in lowpass and lets them through in highpass", () => {
    const cutoffHz = 500;
    const high = sine(4_000, SAMPLE_RATE / 4);
    const lowpassed = runFilter({ mode: "lowpass", cutoffHz, resonancePermille: 0 }, high);
    const highpassed = runFilter({ mode: "highpass", cutoffHz, resonancePermille: 0 }, high);
    // Measured past the filter's own settling so the transient is not the reading.
    expect(peak(lowpassed.left, SAMPLE_RATE / 8)).toBeLessThan(0.1);
    expect(peak(highpassed.left, SAMPLE_RATE / 8)).toBeGreaterThan(0.8);
  });

  it("is the same filter the synth voice uses, at the same settings", () => {
    // Not a behavioural claim but a structural one: `FilterEffect` holds
    // `BiquadFilter` instances, so there is no second Q mapping to drift.
    const effect = new FilterEffect("f", SAMPLE_RATE, {
      mode: "lowpass",
      cutoffHz: spec(FILTER_EFFECT_PARAMS, "cutoff").default as number,
      resonancePermille: spec(FILTER_EFFECT_PARAMS, "resonance").default as number,
    });
    const response = impulseResponse(effect, 1_024);
    expect(allFinite(response.left)).toBe(true);
    expect(peak(response.left)).toBeGreaterThan(0);
  });

  it("follows a cutoff ramp continuously across block boundaries", () => {
    const blocks = 200;
    const length = blocks * CONTROL_BLOCK_SIZE;
    const effect = new FilterEffect("f", SAMPLE_RATE, { mode: "lowpass", cutoffHz: 100, resonancePermille: 0 });
    const input = sine(3_000, length);
    const out = { left: Float32Array.from(input.left), right: Float32Array.from(input.right) };
    for (let block = 0; block < blocks; block++) {
      const start = block * CONTROL_BLOCK_SIZE;
      // Per-block ramps that meet end-to-start, exactly as `AutomationRamps` builds
      // them, so this exercises the boundary a zipper artefact would appear at.
      const at = (index: number): number => 100 + (index / blocks) * 7_900;
      effect.processBlock(
        out.left.subarray(start, start + CONTROL_BLOCK_SIZE),
        out.right.subarray(start, start + CONTROL_BLOCK_SIZE),
        CONTROL_BLOCK_SIZE,
        ramp("fx.f.cutoff", at(block), at(block + 1)),
      );
    }
    // The sweep opens: with the cutoff below the tone the output is attenuated, and
    // by the end, with the cutoff far above it, the tone passes.
    const early = peak(out.left.subarray(Math.round(length * 0.05), Math.round(length * 0.1)));
    const late = peak(out.left.subarray(Math.round(length * 0.9)));
    expect(late).toBeGreaterThan(early * 4);
    expect(late).toBeGreaterThan(0.8);
    expect(allFinite(out.left)).toBe(true);
  });
});

function sine(frequencyHz: number, length: number): Stereo {
  const out = stereo(length);
  for (let index = 0; index < length; index++) {
    const value = Math.sin((2 * Math.PI * frequencyHz * index) / SAMPLE_RATE);
    out.left[index] = value;
    out.right[index] = value;
  }
  return out;
}

function runFilter(settings: { mode: "lowpass" | "highpass" | "bandpass"; cutoffHz: number; resonancePermille: number }, input: Stereo): Stereo {
  const effect = new FilterEffect("f", SAMPLE_RATE, settings);
  const out = { left: Float32Array.from(input.left), right: Float32Array.from(input.right) };
  for (let start = 0; start < out.left.length; start += CONTROL_BLOCK_SIZE) {
    const size = Math.min(CONTROL_BLOCK_SIZE, out.left.length - start);
    effect.processBlock(out.left.subarray(start, start + size), out.right.subarray(start, start + size), size, STATIC);
  }
  return out;
}

describe("effect chains", () => {
  const doc = (id: string, type: EffectDoc["type"], params?: Record<string, number | string>): EffectDoc =>
    params === undefined ? { id, type } : { id, type, params };

  it("derives every setting from the registry's defaults when the document is silent", () => {
    const specs = effectChainSpecs([doc("slap", "delay")]);
    expect(specs).toEqual([
      {
        id: "slap",
        type: "delay",
        settings: {
          timeMs: spec(DELAY_PARAMS, "time").default,
          feedbackPermille: spec(DELAY_PARAMS, "feedback").default,
          dampingPermille: spec(DELAY_PARAMS, "damping").default,
          mixPermille: spec(DELAY_PARAMS, "mix").default,
        },
      },
    ]);
  });

  it("publishes exactly the automatable params as ramped values, keyed as automation names them", () => {
    const values = effectStaticValues([doc("slap", "delay", { mix: 400 }), doc("tone", "filter")]);
    expect(Object.keys(values).sort()).toEqual([
      "fx.slap.damping",
      "fx.slap.feedback",
      "fx.slap.mix",
      "fx.tone.cutoff",
      "fx.tone.resonance",
    ]);
    expect(values["fx.slap.mix"]).toBe(400);
    // `time` and `mode` are not automatable, so no lane may target them and no ramp
    // is published for them.
    expect(values["fx.slap.time"]).toBeUndefined();
    expect(values["fx.tone.mode"]).toBeUndefined();
  });

  /**
   * The chain is applied front to back, pinned against the cascade done by hand
   * rather than against the reverse order.
   *
   * Comparing the two orders would *not* have caught a chain applied backwards, and
   * the reason is worth recording: with static params all three of these effects are
   * linear and time-invariant, and cascaded LTI systems commute. Reversing the chain
   * changed the output by 1.9e-6 of its peak — float32 rounding, nothing more (see
   * the commutation case below). So the only way to fix the direction is to state
   * what the answer should be.
   */
  it("applies its effects front to back, matching the cascade done by hand", () => {
    const effects = [doc("tone", "filter", { cutoff: 400 }), doc("room", "reverb", { mix: 1000 })];
    const ramps = ramp("fx.tone.cutoff", 200, 8_000);
    const viaChain = impulseResponse(chain(effects), SAMPLE_RATE / 4, ramps);

    // The same two processors, driven in the declared order, block for block.
    const filter = new FilterEffect("tone", SAMPLE_RATE, { mode: "lowpass", cutoffHz: 400, resonancePermille: 100 });
    const reverb2 = new ReverbEffect("room", SAMPLE_RATE, {
      sizePermille: 500,
      dampingPermille: 500,
      widthPermille: 1000,
      mixPermille: 1000,
    });
    const byHand = impulseResponse(
      {
        processBlock(l, r, n, blockRamps) {
          filter.processBlock(l, r, n, blockRamps);
          reverb2.processBlock(l, r, n, blockRamps);
        },
      },
      SAMPLE_RATE / 4,
      ramps,
    );

    expect([...viaChain.left]).toEqual([...byHand.left]);
    expect([...viaChain.right]).toEqual([...byHand.right]);
    expect(peak(viaChain.left)).toBeGreaterThan(0);
  });

  /**
   * Why reordering a *static* chain is inaudible, asserted rather than assumed.
   *
   * A delay, a reverb and a filter are each linear and time-invariant while their
   * params hold still, and an LTI cascade commutes — so the order of a static chain
   * reaches nothing but rounding. It stops commuting the moment a param moves,
   * because a swept filter is no longer time-invariant, and there the difference is
   * hundreds of times the signal.
   *
   * This is the honest scope of "reordering is audible": it is a real, large change
   * under automation, or as soon as a nonlinear effect (a distortion, a compressor)
   * joins the set, and it is inaudible for a static chain of these three. It is
   * still `structural`, because what changed is the graph, and because the id-based
   * addressing has to hold either way.
   */
  it("commutes for static params and stops commuting under automation", () => {
    const forward = [doc("tone", "filter", { cutoff: 400 }), doc("room", "reverb", { mix: 1000 })];
    const reversed = [...forward].reverse();

    const staticForward = impulseResponse(chain(forward), SAMPLE_RATE / 4);
    const staticReversed = impulseResponse(chain(reversed), SAMPLE_RATE / 4);
    const staticDrift = peak(difference(staticForward.left, staticReversed.left));
    // Float32 has ~1e-7 relative resolution; a hundred times that is still rounding
    // accumulated through a recursive tail, not a different sound.
    expect(staticDrift / peak(staticForward.left)).toBeLessThan(1e-4);

    const ramps = ramp("fx.tone.cutoff", 200, 8_000);
    const sweptForward = impulseResponse(chain(forward), SAMPLE_RATE / 4, ramps);
    const sweptReversed = impulseResponse(chain(reversed), SAMPLE_RATE / 4, ramps);
    const sweptDifference = peak(difference(sweptForward.left, sweptReversed.left));
    expect(sweptDifference / peak(sweptForward.left)).toBeGreaterThan(1);
  });

  it("adopts new params in place without clearing a tail", () => {
    const specs = effectChainSpecs([doc("slap", "delay", { time: 20, feedback: 800, mix: 1000 })]);
    const built = new EffectChain(SAMPLE_RATE, specs);
    impulseResponse(built, SAMPLE_RATE / 8);
    // A quieter mix mid-tail: the line still holds the repeats, so the next block
    // is not silent.
    built.updateSettings(effectChainSpecs([doc("slap", "delay", { time: 20, feedback: 800, mix: 500 })]));
    const after = stereo(CONTROL_BLOCK_SIZE * 8);
    for (let start = 0; start < after.left.length; start += CONTROL_BLOCK_SIZE) {
      built.processBlock(
        after.left.subarray(start, start + CONTROL_BLOCK_SIZE),
        after.right.subarray(start, start + CONTROL_BLOCK_SIZE),
        CONTROL_BLOCK_SIZE,
        STATIC,
      );
    }
    expect(peak(after.left)).toBeGreaterThan(0);
  });

  /**
   * The guard the scheduler cannot provide. Reordering a chain moves no event, so
   * the schedule-equality check that catches every other misclassified structural
   * edit sees nothing wrong; this refusal is the only thing standing between a
   * reorder claimed as a parameter change and a graph quietly disagreeing with the
   * document.
   */
  it("refuses a chain whose shape changed, naming what moved", () => {
    const built = new EffectChain(SAMPLE_RATE, effectChainSpecs([doc("a", "delay"), doc("b", "reverb")]));
    const reordered = effectChainSpecs([doc("b", "reverb"), doc("a", "delay")]);
    expect(() => built.updateSettings(reordered)).toThrow(/which is structural/);
    expect(() => built.updateSettings(reordered)).toThrow(/a:delay, b:reverb/);
    expect(() => built.updateSettings(effectChainSpecs([doc("a", "delay")]))).toThrow(/which is structural/);
    expect(() =>
      built.updateSettings(effectChainSpecs([doc("a", "delay"), doc("b", "reverb"), doc("c", "filter")])),
    ).toThrow(/which is structural/);
    // A retype keeps the id and the position and is still structural.
    expect(() => built.updateSettings(effectChainSpecs([doc("a", "reverb"), doc("b", "reverb")]))).toThrow(
      /which is structural/,
    );
    // Same shape, different numbers: accepted.
    expect(() =>
      built.updateSettings(effectChainSpecs([doc("a", "delay", { mix: 900 }), doc("b", "reverb")])),
    ).not.toThrow();
  });

  it("resets every effect, leaving no tail to leak across a seek", () => {
    const built = chain([doc("slap", "delay", { time: 20, feedback: 900, mix: 1000 }), doc("room", "reverb")]);
    impulseResponse(built, SAMPLE_RATE / 4);
    built.reset();
    const after = stereo(SAMPLE_RATE / 2);
    for (let start = 0; start < after.left.length; start += CONTROL_BLOCK_SIZE) {
      built.processBlock(
        after.left.subarray(start, start + CONTROL_BLOCK_SIZE),
        after.right.subarray(start, start + CONTROL_BLOCK_SIZE),
        CONTROL_BLOCK_SIZE,
        STATIC,
      );
    }
    expect(lastNonZero(after.left)).toBe(-1);
    expect(lastNonZero(after.right)).toBe(-1);
  });

  function chain(effects: readonly EffectDoc[]): EffectChain {
    const specs: EffectSpec[] = effectChainSpecs(effects);
    return new EffectChain(SAMPLE_RATE, specs);
  }
});
