export function permilleToUnit(value: number): number {
  return value / 1000;
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
