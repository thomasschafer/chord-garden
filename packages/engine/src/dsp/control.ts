/** Fixed for deterministic offline/worklet-equivalent control-rate processing. */
export const CONTROL_BLOCK_SIZE = 128;

export interface ParamRamp {
  start: number;
  end: number;
}

export type ParamRamps = Readonly<Record<string, ParamRamp>>;

export function rampValue(ramp: ParamRamp | undefined, fallback: number, index: number, length: number): number {
  if (ramp === undefined) return fallback;
  if (length <= 1 || ramp.start === ramp.end) return ramp.start;
  return ramp.start + ((ramp.end - ramp.start) * index) / length;
}
