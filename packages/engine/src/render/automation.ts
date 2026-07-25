import type { CompiledAutomationLane } from "../compiler.js";
import type { ParamRamp, ParamRamps } from "../dsp/control.js";

export class AutomationSet {
  private readonly lanes = new Map<string, CompiledAutomationLane>();

  constructor(lanes: readonly CompiledAutomationLane[]) {
    for (const lane of lanes) this.lanes.set(lane.param, lane);
  }

  ramps(
    params: readonly string[],
    staticValues: Readonly<Record<string, number>>,
    blockStart: number,
    blockLength: number,
  ): ParamRamps {
    const output: Record<string, ParamRamp> = {};
    for (const param of params) {
      const fallback = staticValues[param];
      if (fallback === undefined) continue;
      const lane = this.lanes.get(param);
      if (lane === undefined || lane.points.length === 0) {
        output[param] = { start: fallback, end: fallback };
        continue;
      }
      const start = valueAt(lane, blockStart, fallback);
      const end = lane.interp === "step" ? start : valueAt(lane, blockStart + blockLength, fallback);
      output[param] = { start, end };
    }
    return output;
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
