import {
  EXPRESSION_FIELDS,
  type ExpressionField,
  type GridLane,
  type StepEventField,
} from "@chord-garden/format/pure";

/**
 * What a grid step actually sounds like, resolving the same fallback chain the
 * compiler does: the step's own `stepEvents` entry, then the lane's `defaults`,
 * then the format's default.
 *
 * It is here rather than inlined in the sequencer because four separate things
 * need the answer and they must not disagree: the placeholder in an empty box
 * ("inherits 800"), the height of a velocity bar, the value a velocity drag
 * starts from, and the rule that dragging back to the inherited value removes
 * the override rather than restating it. Four private copies of "velocity
 * defaults to 800" is how a UI ends up showing a musician a number the renderer
 * is not using — and `compileGridPattern` reads the same
 * `EXPRESSION_FIELDS` table, so there is one statement of it in the repo.
 */

export interface LaneContext {
  /** Ticks in one step of this lane, which is what `gateTicks` falls back to. */
  stepTicks: number;
  /** `project.json.swing`, which a lane's own `defaults.swing` overrides. */
  projectSwing: number;
}

/**
 * The value a step gets for `field` when its own entry does not set it, or
 * `undefined` when the format states no constant — which is only `gateTicks` on
 * a lane with no `defaults.gateTicks`, where the answer is "one step" and
 * `context.stepTicks` says how long that is.
 */
export function inheritedStepValue(lane: GridLane, field: StepEventField, context: LaneContext): number {
  const laneDefault = field === "microTicks" || field === "ratchet" ? undefined : lane.defaults?.[field];
  return laneDefault ?? formatDefault(field, context);
}

/**
 * The value the format itself supplies for a field, with no lane in the way:
 * what a lane's *own* `defaults` box is empty against.
 *
 * `gateTicks` is the only field whose default is not a constant — the registry
 * records `null` for it precisely so this is a case that has to be handled
 * rather than a zero that looks plausible — and one step is what the compiler
 * uses.
 */
export function formatDefault(field: ExpressionField, context: LaneContext): number {
  if (field === "swing") return context.projectSwing;
  const fallback = EXPRESSION_FIELDS[field].default;
  if (fallback !== null) return fallback;
  if (field === "gateTicks") return context.stepTicks;
  throw new Error(`"${field}" states no default and this context cannot derive one`);
}

/** What one step of a lane sounds like for `field`, override included. */
export function effectiveStepValue(
  lane: GridLane,
  step: number,
  field: StepEventField,
  context: LaneContext,
): number {
  const override = lane.stepEvents?.find((entry) => entry.step === step)?.[field];
  return override ?? inheritedStepValue(lane, field, context);
}

/** The swing this lane runs at, and whether it came from the lane or the project. */
export function laneSwing(lane: GridLane, projectSwing: number): { permille: number; from: "lane" | "project" } {
  const own = lane.defaults?.swing;
  return own === undefined ? { permille: projectSwing, from: "project" } : { permille: own, from: "lane" };
}

/**
 * How many ticks swing displaces an odd step by, and how many of this lane's
 * hits it actually moves.
 *
 * Both numbers exist for one reason: a four-on-the-floor kick is entirely on
 * even steps, so turning swing up does nothing to it and the editor has to say
 * why rather than looking broken (docs/format-spec.md §4). `moved` of 0 out of 4
 * is the whole explanation, and it is a fact about the lane rather than a
 * sentence someone has to read.
 */
export function swingEffect(
  hits: readonly number[],
  swingPermille: number,
  stepTicks: number,
): { delayTicks: number; moved: number; total: number } {
  return {
    // The compiler's own formula (docs/format-spec.md §4), so the number shown is
    // the number applied.
    delayTicks: Math.round((swingPermille * stepTicks) / 2000),
    moved: hits.filter((step) => step % 2 === 1).length,
    total: hits.length,
  };
}

/** Permille a velocity drag covers per pixel of vertical movement. */
export const VELOCITY_PER_PX = 8;

/** Pixels of vertical movement before a press on a cell becomes a drag, not a click. */
export const DRAG_THRESHOLD_PX = 3;

/** A velocity a drag of `deltaY` pixels from `from` lands on, clamped to range. */
export function draggedVelocity(from: number, deltaY: number): number {
  const spec = EXPRESSION_FIELDS.velocity;
  const raw = Math.round(from - deltaY * VELOCITY_PER_PX);
  return Math.max(spec.min, Math.min(spec.max ?? raw, raw));
}

/** A value's position between a field's bounds, 0..1, for drawing a bar. */
export function expressionFraction(field: ExpressionField, value: number): number {
  const spec = EXPRESSION_FIELDS[field];
  const max = spec.max;
  if (max === undefined || max <= spec.min) return 1;
  return Math.max(0, Math.min(1, (value - spec.min) / (max - spec.min)));
}
