import { ticksPerBar, type Project } from "@chord-garden/format/pure";

/**
 * The geometry both editors draw with, and the snapping rules the piano roll
 * offers.
 *
 * Two things to keep straight.
 *
 * A grid is a *view* (PLAN.md §6). Every number a document holds is an integer
 * tick, and nothing here rounds a value the user did not just place — snapping
 * applies to the note being dragged and to nothing else, because silently
 * requantising the rest of a pattern is data loss with a friendly name.
 *
 * Note values come from `ppqn`, not from the bar. A bar is only four quarter notes
 * in 4/4, and the format allows any single meter (docs/format-spec.md §3), so
 * dividing a bar by sixteen gives a 24th note in 3/4 and a snap labelled "1/16"
 * that is nothing of the kind.
 */

/** Width of one sixteenth note, in CSS pixels. */
export const CELL_PX = 26;
/** Height of one piano-roll pitch row, in CSS pixels. */
export const ROW_PX = 15;

export interface GridGeometry {
  barTicks: number;
  beatsPerBar: number;
  /** Ticks per notated beat, i.e. one denominator unit of the meter. */
  beatTicks: number;
  /** Ticks per sixteenth note, whatever the meter. */
  sixteenthTicks: number;
  /** CSS pixels per tick, scaled so a sixteenth note is `CELL_PX` wide. */
  pxPerTick: number;
}

export function gridGeometry(project: Project): GridGeometry {
  const meter = project.project.meterMap[0];
  if (meter === undefined) throw new Error("project has no meterMap point");
  const barTicks = ticksPerBar(project.project.ppqn, meter.timeSignature);
  const beatsPerBar = meter.timeSignature[0];
  const sixteenthTicks = noteTicks(project, 16);
  if (sixteenthTicks <= 0) {
    throw new Error(`cannot draw a grid: ${project.project.ppqn} PPQN gives a sixteenth of ${sixteenthTicks} ticks`);
  }
  return {
    barTicks,
    beatsPerBar,
    beatTicks: barTicks / beatsPerBar,
    sixteenthTicks,
    pxPerTick: CELL_PX / sixteenthTicks,
  };
}

/** Ticks in a 1/`division` note: a whole note is four quarters, i.e. `4 * ppqn`. */
function noteTicks(project: Project, division: number): number {
  return (project.project.ppqn * 4) / division;
}

export interface SnapOption {
  label: string;
  /** Ticks to snap to; 1 means "every tick", i.e. no musical grid at all. */
  ticks: number;
}

/**
 * Snap resolutions the piano roll offers, coarsest first.
 *
 * Note values, plus the bar, which is the one option that is a function of the
 * meter rather than of `ppqn`.
 *
 * A division is left out when it would not come out as a whole tick — a snap that
 * lands between ticks cannot be represented, so offering it would be offering to
 * round — and when it comes out as one tick or as a whole bar, because "off" and
 * "bar" already say that and two labels for one resolution is a choice with no
 * consequence.
 */
export function snapOptions(project: Project): SnapOption[] {
  const { barTicks } = gridGeometry(project);
  const options: SnapOption[] = [{ label: "bar", ticks: barTicks }];
  for (const division of [4, 8, 16, 32]) {
    const ticks = noteTicks(project, division);
    if (Number.isInteger(ticks) && ticks > 1 && ticks !== barTicks) {
      options.push({ label: `1/${division}`, ticks });
    }
  }
  options.sort((left, right) => right.ticks - left.ticks);
  return [...options, { label: "off (1 tick)", ticks: 1 }];
}

/** The default snap: a sixteenth note. */
export function defaultSnapTicks(project: Project): number {
  return gridGeometry(project).sixteenthTicks;
}

/** Nearest multiple of `snap`, never below zero. */
export function snapNearest(tick: number, snap: number): number {
  return Math.max(0, Math.round(tick / snap) * snap);
}
