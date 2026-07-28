export function permilleToUnit(value: number): number {
  return value / 1000;
}

/**
 * A note's `velocity` as the amplitude coefficient it scales the voice by.
 *
 * Linear, and deliberately so: `docs/format-spec.md` §2 settles a signal-scaling
 * permille as an amplitude rather than a power or a decibel value, so that one
 * unit means one thing everywhere — `amp.sustain` is already a permille used
 * directly as an amplitude in the same signal path, and the format already owns a
 * logarithmic unit in `gain` (dB×100). It is also what makes `velocity: 0`
 * exactly silent with no special case.
 *
 * It is one function rather than the same expression written in the synth and in
 * the sampler because "the two voice types answer the same velocity the same way"
 * is a promise in the spec, and two copies can only be held to it by a test that
 * notices afterwards.
 */
export function velocityToGain(velocity: number): number {
  return permilleToUnit(velocity);
}

export function centsToRatio(value: number): number {
  return 2 ** (value / 1200);
}

export function db100ToGain(value: number): number {
  return 10 ** (value / 2000);
}

export function msToSamples(value: number, sampleRate: number): number {
  return Math.max(0, Math.round((value * sampleRate) / 1000));
}

export function midiToFrequency(midi: number, detuneCents = 0): number {
  return 440 * 2 ** ((midi - 69 + detuneCents / 100) / 12);
}

/**
 * Constant-power pan law: -1000 is hard left, 0 gives each side sqrt(1/2),
 * and +1000 is hard right.
 */
export function panGains(panPermille: number): [number, number] {
  if (panPermille <= -1000) return [1, 0];
  if (panPermille >= 1000) return [0, 1];
  const angle = ((panPermille / 1000 + 1) * Math.PI) / 4;
  return [Math.cos(angle), Math.sin(angle)];
}
