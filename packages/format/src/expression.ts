import type { LaneDefaults, NoteEvent, StepEvent } from "./model.js";

/**
 * The expression model's registry: velocity, probability, micro-timing, gate,
 * ratchet and swing, each with its unit, range and default.
 *
 * This exists for the same reason `registry.ts` does. Those numbers were spelled
 * out in four places — the JSON Schemas, the compiler's `?? 800`, the store's
 * range checks, and the UI's placeholder text — and four copies of "velocity
 * defaults to 800" is three chances for the UI to show a musician a default the
 * engine does not actually apply. That is not a cosmetic bug: the whole premise
 * of a document both a human and an agent edit is that what the screen says the
 * file means is what the renderer thinks it means.
 *
 * So this is the single declaration. The compiler reads its defaults, the store
 * validates against its ranges, the UI renders its fields and labels, and
 * `test/expressionSchema.test.ts` proves the JSON Schemas agree — change a bound
 * here and the failing test names the schema that has not caught up.
 *
 * Engine params (`filter.cutoff` and friends) are *not* here: they belong to an
 * instrument's engine and live in `registry.ts`. These fields belong to the
 * pattern, are the same for every engine, and are what the format calls
 * expression (docs/format-spec.md §5, §6.2).
 */

export type ExpressionUnit = "permille" | "ticks" | "count";

export interface ExpressionSpec {
  unit: ExpressionUnit;
  min: number;
  /**
   * `undefined` where the format sets no upper bound (`gateTicks`). Required
   * rather than optional so every field has to say which it is — an unbounded
   * field and a field whose bound someone forgot look identical otherwise.
   */
  max: number | undefined;
  /**
   * What the compiler uses when nothing sets the field, or `null` when there is
   * no constant to state because it is derived from context — `gateTicks`
   * defaults to the lane's step length, and to a note's own `durationTicks`.
   */
  default: number | null;
}

export const EXPRESSION_FIELDS = {
  velocity: { unit: "permille", min: 0, max: 1000, default: 800 },
  probability: { unit: "permille", min: 0, max: 1000, default: 1000 },
  microTicks: { unit: "ticks", min: -1920, max: 1920, default: 0 },
  gateTicks: { unit: "ticks", min: 1, max: undefined, default: null },
  ratchet: { unit: "count", min: 1, max: 16, default: 1 },
  swing: { unit: "permille", min: 0, max: 1000, default: 0 },
} as const satisfies Record<string, ExpressionSpec>;

export type ExpressionField = keyof typeof EXPRESSION_FIELDS;

/**
 * Which fields each carrier accepts, in the order a UI should show them.
 *
 * Typed against the document model rather than as loose strings, so a field
 * added to `StepEvent` and forgotten here — or listed here and not on the
 * document — is a compile error rather than a control that silently does
 * nothing.
 */
export const STEP_EVENT_FIELDS = [
  "velocity",
  "probability",
  "microTicks",
  "gateTicks",
  "ratchet",
] as const satisfies readonly (keyof Omit<StepEvent, "step"> & ExpressionField)[];

export const LANE_DEFAULT_FIELDS = [
  "velocity",
  "probability",
  "gateTicks",
  "swing",
] as const satisfies readonly (keyof LaneDefaults & ExpressionField)[];

/** A note's optional expression. `velocity` is required, so it is not here. */
export const NOTE_EXPRESSION_FIELDS = [
  "microTicks",
  "probability",
  "ratchet",
] as const satisfies readonly (keyof NoteEvent & ExpressionField)[];

export type StepEventField = (typeof STEP_EVENT_FIELDS)[number];
export type LaneDefaultField = (typeof LANE_DEFAULT_FIELDS)[number];
export type NoteExpressionField = (typeof NOTE_EXPRESSION_FIELDS)[number];

/**
 * Why a value is not allowed in this field, or `undefined` when it is.
 *
 * One function, so the store, a future validator and anything else that has to
 * refuse a value all refuse the same set. The message is written to be shown to
 * a person: it names the unit and the bound rather than restating the input.
 */
export function checkExpressionValue(field: ExpressionField, value: number): string | undefined {
  const spec = EXPRESSION_FIELDS[field];
  if (!Number.isInteger(value)) return `${field} must be an integer (${describeExpressionRange(field)})`;
  if (value < spec.min) return `${field} must be at least ${spec.min} (${describeExpressionRange(field)})`;
  if (spec.max !== undefined && value > spec.max) {
    return `${field} must be at most ${spec.max} (${describeExpressionRange(field)})`;
  }
  return undefined;
}

/** The unit and bounds as one short label, for a field's caption. */
export function describeExpressionRange(field: ExpressionField): string {
  const spec = EXPRESSION_FIELDS[field];
  const range = spec.max === undefined ? `≥ ${spec.min}` : `${spec.min}..${spec.max}`;
  return `${spec.unit} ${range}`;
}
