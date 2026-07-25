import type { CompiledAutomationLane } from "../compiler.js";
import type { ParamRamp, ParamRamps } from "../dsp/control.js";

/**
 * Per-block parameter ramps for one track, derived from its compiled automation
 * lanes and the instrument's static values.
 *
 * The ramp objects are allocated once and mutated in place: this runs per block
 * on the audio thread in the live engine, where allocating a fresh record per
 * block would produce garbage at 375 Hz and risk collection during a render
 * quantum. The offline renderer uses the same instance for the same reason it
 * uses the same DSP — one code path, one set of numbers.
 */
export class AutomationRamps {
  private readonly lanes = new Map<string, CompiledAutomationLane>();
  private readonly staticValues: Readonly<Record<string, number>>;
  private readonly buffer: Record<string, ParamRamp>;
  /** Same keys as `buffer`, captured once so the hot path never calls Object.keys. */
  private readonly params: readonly string[];

  constructor(lanes: readonly CompiledAutomationLane[], staticValues: Readonly<Record<string, number>>) {
    for (const lane of lanes) this.lanes.set(lane.param, lane);
    this.staticValues = staticValues;
    const buffer: Record<string, ParamRamp> = {};
    const params: string[] = [];
    for (const param of Object.keys(staticValues)) {
      buffer[param] = { start: 0, end: 0 };
      params.push(param);
    }
    this.buffer = buffer;
    this.params = params;
  }

  /**
   * Swap the lanes without disturbing anything sounding: an automation edit is a
   * parameter change, so it must not restart a voice (PLAN.md §12 step 6). The
   * param set is fixed by the instrument's engine, so a lane naming a param this
   * track does not have is a compile-time impossibility and an error here.
   */
  replaceLanes(lanes: readonly CompiledAutomationLane[]): void {
    this.lanes.clear();
    for (const lane of lanes) {
      if (this.buffer[lane.param] === undefined) {
        throw new Error(`cannot replace automation: param "${lane.param}" is not one of this track's ramped params`);
      }
      this.lanes.set(lane.param, lane);
    }
  }

  /** Ramps covering `[blockStart, blockStart + blockLength)`, in absolute samples. */
  update(blockStart: number, blockLength: number): ParamRamps {
    for (const param of this.params) {
      const fallback = this.staticValues[param]!;
      const ramp = this.buffer[param]!;
      const lane = this.lanes.get(param);
      if (lane === undefined || lane.points.length === 0) {
        ramp.start = fallback;
        ramp.end = fallback;
        continue;
      }
      ramp.start = valueAt(lane, blockStart, fallback);
      ramp.end = lane.interp === "step" ? ramp.start : valueAt(lane, blockStart + blockLength, fallback);
    }
    return this.buffer;
  }
}

export function valueAt(lane: CompiledAutomationLane, sample: number, fallback: number): number {
  const first = lane.points[0];
  if (first === undefined || sample < first[0]) return fallback;
  let previous = first;
  for (let index = 1; index < lane.points.length; index++) {
    const next = lane.points[index]!;
    if (sample < next[0]) {
      if (lane.interp === "step") return previous[1];
      const progress = (sample - previous[0]) / (next[0] - previous[0]);
      return previous[1] + (next[1] - previous[1]) * progress;
    }
    previous = next;
  }
  return previous[1];
}
