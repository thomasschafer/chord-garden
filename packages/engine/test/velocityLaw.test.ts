import { describe, expect, it } from "vitest";
import { render } from "../src/index.js";
import {
  BAR_TICKS,
  DRUM_SAMPLE_VALUE,
  DRUM_VOICE,
  drumkitProject,
  peak,
  synthProject,
} from "./support/valueProjects.js";

/**
 * The velocity law: `velocity` permille is a **linear amplitude coefficient**.
 *
 * This is a decision rather than a derivation. `docs/format-spec.md` §2 calls a
 * permille "a 0.0–1.0 normalised value" without saying normalised *what*, and
 * MIDI practice is genuinely split (SoundFont and DLS make amplitude
 * proportional to velocity *squared*; plenty of hardware does something else
 * again). The format settles it as amplitude, for four reasons:
 *
 *  - One unit, one meaning. `amp.sustain` is already a permille the envelope
 *    uses as a straight amplitude multiplier. If `velocity` were a power while
 *    `amp.sustain` was an amplitude, two fields the §2 table describes with the
 *    same sentence would behave differently in the same signal path.
 *  - The format already owns a logarithmic unit: `gain` is dB×100. A curve
 *    hidden inside a permille would duplicate what dB×100 exists to say, and
 *    hide it.
 *  - `velocity: 0` must be exactly silent, which linear reaches with no special
 *    case.
 *  - Predictability is the premise (PLAN.md §6.3, §9): "half the permille, half
 *    the amplitude" is a rule an agent can apply without knowing the patch.
 *
 * Both voices obey it. Nothing in the suite used to pin the sampler's copy at
 * all — its velocity gain could be scaled to a hundredth and every test still
 * passed — which is why the drumkit assertions below are absolute rather than
 * relative.
 */

/** The law itself, written once, here, from the statement above. */
function velocityGain(permille: number): number {
  return permille / 1000;
}

const VELOCITIES = [1000, 750, 500, 250, 100] as const;

/**
 * Peak of one drum hit, panned hard left so the pan gain is exactly 1 and drops
 * out. With a DC sample the whole chain is then `sampleValue x velocityGain`, an
 * absolute number that owes nothing to what the renderer happens to do.
 */
function drumHitPeak(velocity: number): number {
  const { project, cleanup } = drumkitProject({ voiceParams: { pan: -1000 }, velocities: [velocity] });
  try {
    const audio = render(project, { tailSeconds: 0, stems: true });
    const voice = audio.voices?.get("drums")?.get(DRUM_VOICE);
    if (voice === undefined) throw new Error("kit voice audio missing");
    return peak(voice.left);
  } finally {
    cleanup();
  }
}

/** Peak of one synth note through the neutral patch. */
function synthNotePeak(velocity: number): number {
  const project = synthProject({ notes: [{ pitch: "A3", startTick: 0, durationTicks: BAR_TICKS, velocity }] });
  return peak(render(project, { tailSeconds: 0 }).master.left);
}

describe("velocity law: drumkit (absolute)", () => {
  for (const velocity of VELOCITIES) {
    it(`plays velocity ${velocity} at exactly ${velocity / 1000} of full amplitude`, () => {
      expect(drumHitPeak(velocity)).toBeCloseTo(DRUM_SAMPLE_VALUE * velocityGain(velocity), 6);
    });
  }

  it("plays velocity 1000 at unity, applying no attenuation of its own", () => {
    expect(drumHitPeak(1000)).toBeCloseTo(DRUM_SAMPLE_VALUE, 6);
  });

  it("makes velocity 0 exactly silent", () => {
    expect(drumHitPeak(0)).toBe(0);
  });
});

describe("velocity law: synth", () => {
  /**
   * A synth voice always passes through the filter, whose passband gain is close
   * to but never exactly unity, so its absolute peak is not something the law
   * predicts. The *ratio* between two velocities is: everything but the velocity
   * stage is identical and linear, so the peaks stand in exactly the ratio the
   * law gives. Together with the absolute drumkit assertions above — which fix
   * the law's constant, not just its shape — the pair pins the law completely.
   */
  for (const velocity of VELOCITIES) {
    it(`scales velocity ${velocity} to exactly ${velocity / 1000} of the velocity-1000 peak`, () => {
      // Under a squared law this ratio would be velocityGain(v)^2 — 0.25 rather
      // than 0.5 at velocity 500 — so the tolerance below separates the
      // candidate laws by four orders of magnitude.
      expect(synthNotePeak(velocity) / synthNotePeak(1000)).toBeCloseTo(velocityGain(velocity), 4);
    });
  }

  it("makes velocity 0 exactly silent", () => {
    expect(synthNotePeak(0)).toBe(0);
  });
});

describe("velocity law: one law, both voices", () => {
  it("gives a synth note and a drum hit the same response to the same velocity pair", () => {
    // The two voices carry separate copies of the law, so a drift between them
    // shows up here even if each stayed internally monotonic.
    const fullNote = synthNotePeak(1000);
    const fullHit = drumHitPeak(1000);
    for (const velocity of [250, 750] as const) {
      expect(synthNotePeak(velocity) / fullNote).toBeCloseTo(drumHitPeak(velocity) / fullHit, 4);
    }
  });
});
