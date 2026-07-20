export type TimeSignature = [number, number];

/**
 * Ticks in one bar. May be non-integer for pathological ppqn/meter
 * combinations; callers must validate integrality (see semantic rules).
 */
export function ticksPerBar(ppqn: number, timeSignature: TimeSignature): number {
  return (ppqn * 4 * timeSignature[0]) / timeSignature[1];
}
