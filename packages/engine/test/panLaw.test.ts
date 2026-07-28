import { describe, expect, it } from "vitest";
import { panGains } from "../src/dsp/units.js";
import { render } from "../src/index.js";
import { DRUM_SAMPLE_VALUE, DRUM_VOICE, drumkitProject, peak, synthProject } from "./support/valueProjects.js";

/**
 * The pan law's defining properties, asserted from the law rather than from the
 * output.
 *
 * Which *curve* to pan on is a design decision — a linear-amplitude law, a −3 dB
 * law and a −4.5 dB compromise are all defensible. But this engine has written
 * "constant-power" down (`panGains`), and once that word is on the page the rest
 * is arithmetic, not taste: constant power means `L² + R² = 1` at every position,
 * which fixes the centre at `cos(π/4) = 0.70710678…` and nothing else.
 *
 * Direction is not a design decision at all. Positive pan is right, everywhere in
 * audio. A mirrored pan is inaudible to a symmetry test and obvious to a listener,
 * so it is asserted separately and end to end.
 */

/** cos(π/4), written out rather than computed, so a wrong angle cannot agree with it. */
const CENTRE_GAIN = 0.7071067811865476;

describe("constant-power pan law", () => {
  it("holds L^2 + R^2 = 1 at every position in the registry's range", () => {
    for (let pan = -1000; pan <= 1000; pan++) {
      const [left, right] = panGains(pan);
      expect(left * left + right * right, `power is not unity at pan ${pan}`).toBeCloseTo(1, 12);
    }
  });

  it("puts the centre at cos(pi/4) on both sides", () => {
    const [left, right] = panGains(0);
    expect(left).toBeCloseTo(CENTRE_GAIN, 12);
    expect(right).toBeCloseTo(CENTRE_GAIN, 12);
    // The two assertions above are what matters: they name the number. Equality
    // between the sides is only asserted to within an ulp, because the law is
    // evaluated as cos and sin of the same angle and `Math.cos(Math.PI / 4)` and
    // `Math.sin(Math.PI / 4)` differ in the last bit. That is float arithmetic,
    // not a channel imbalance: it is 1.1e-16, some 30 orders below a 24-bit LSB.
    expect(Math.abs(left - right)).toBeLessThan(Number.EPSILON);
  });

  it("is symmetric about the centre: +p mirrors -p", () => {
    for (let pan = 0; pan <= 1000; pan += 5) {
      const [leftPositive, rightPositive] = panGains(pan);
      const [leftNegative, rightNegative] = panGains(-pan);
      expect(leftPositive).toBeCloseTo(rightNegative, 12);
      expect(rightPositive).toBeCloseTo(leftNegative, 12);
    }
  });

  it("sends positive pan to the right and negative pan to the left", () => {
    expect(panGains(1000)).toEqual([0, 1]);
    expect(panGains(-1000)).toEqual([1, 0]);
    for (let pan = 1; pan <= 1000; pan++) {
      const [left, right] = panGains(pan);
      expect(right, `pan +${pan} did not favour the right channel`).toBeGreaterThan(left);
      const [mirroredLeft, mirroredRight] = panGains(-pan);
      expect(mirroredLeft, `pan -${pan} did not favour the left channel`).toBeGreaterThan(mirroredRight);
    }
  });

  it("moves each side monotonically across the range", () => {
    let previousRight = -1;
    let previousLeft = 2;
    for (let pan = -1000; pan <= 1000; pan++) {
      const [left, right] = panGains(pan);
      expect(right, `right gain fell going from pan ${pan - 1} to ${pan}`).toBeGreaterThanOrEqual(previousRight);
      expect(left, `left gain rose going from pan ${pan - 1} to ${pan}`).toBeLessThanOrEqual(previousLeft);
      previousRight = right;
      previousLeft = left;
    }
  });

  it("clamps beyond the registry's range rather than continuing round the circle", () => {
    expect(panGains(-4000)).toEqual([1, 0]);
    expect(panGains(4000)).toEqual([0, 1]);
  });

  /**
   * The quarter-power points, computed from the law: at the pan where the right
   * channel carries three quarters of the power, R = sqrt(3)/2 and L = 1/2. The
   * law puts that at angle π/3, i.e. pan = +333.33… permille.
   */
  it("puts the quarter-power point where the law puts it", () => {
    const [left, right] = panGains((1000 * 4) / 3 - 1000);
    expect(left).toBeCloseTo(0.5, 12);
    expect(right).toBeCloseTo(Math.sqrt(3) / 2, 12);
  });
});

describe("pan direction in rendered audio", () => {
  it("puts a synth panned right into the right channel, at the law's exact ratio", () => {
    const pan = 700;
    const audio = render(synthProject({ params: { pan } }), { tailSeconds: 0 });
    const [expectedLeft, expectedRight] = panGains(pan);
    const leftPeak = peak(audio.master.left);
    const rightPeak = peak(audio.master.right);
    expect(rightPeak).toBeGreaterThan(leftPeak);
    // Both channels are the same mono signal scaled, so their peaks stand in
    // exactly the ratio of the pan gains.
    expect(rightPeak / leftPeak).toBeCloseTo(expectedRight / expectedLeft, 5);

    const mirrored = render(synthProject({ params: { pan: -pan } }), { tailSeconds: 0 });
    expect(peak(mirrored.master.left)).toBeCloseTo(rightPeak, 6);
    expect(peak(mirrored.master.right)).toBeCloseTo(leftPeak, 6);
  });

  it("puts a kit voice panned right into the right channel, at absolute levels the law fixes", () => {
    // A DC sample means the rendered value is the product of the gain stages and
    // nothing else, so this is an absolute assertion rather than a ratio.
    const pan = -400;
    const { project, cleanup } = drumkitProject({ voiceParams: { pan }, velocities: [1000] });
    try {
      const audio = render(project, { tailSeconds: 0, stems: true });
      const voice = audio.voices?.get("drums")?.get(DRUM_VOICE);
      if (voice === undefined) throw new Error("kit voice audio missing");
      const [expectedLeft, expectedRight] = panGains(pan);
      expect(peak(voice.left)).toBeCloseTo(DRUM_SAMPLE_VALUE * expectedLeft, 6);
      expect(peak(voice.right)).toBeCloseTo(DRUM_SAMPLE_VALUE * expectedRight, 6);
      expect(peak(voice.left)).toBeGreaterThan(peak(voice.right));
    } finally {
      cleanup();
    }
  });
});
