export type TimeSignature = [number, number];

/**
 * Ticks in one bar. May be non-integer for pathological ppqn/meter
 * combinations; callers must validate integrality (see semantic rules).
 */
export function ticksPerBar(ppqn: number, timeSignature: TimeSignature): number {
  return (ppqn * 4 * timeSignature[0]) / timeSignature[1];
}

/**
 * The swing delay applied to a grid step: odd steps only, rounded to whole
 * ticks. `swing` is permille of half a step (docs/format-spec.md §4).
 */
export function swingOffsetTicks(step: number, stepTicks: number, swing: number): number {
  return step % 2 === 1 ? Math.round((swing * stepTicks) / 2000) : 0;
}

/**
 * Where a grid hit sounds, relative to the start of its pattern repetition.
 *
 * Shared by the compiler and by validation. A second copy of this arithmetic is
 * how `validate` would come to report an event at a tick the renderer never
 * schedules — and a rule that fires on a healthy project is worse than no rule,
 * so the two have to be the same expression rather than two that agree today.
 */
export function gridStepOffsetTicks(step: number, stepTicks: number, swing: number, microTicks: number): number {
  return step * stepTicks + swingOffsetTicks(step, stepTicks, swing) + microTicks;
}
