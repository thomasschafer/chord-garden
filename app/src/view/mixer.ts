import type { InstrumentParam, ParamSpec } from "@chord-garden/format/pure";

/**
 * The mixer's arithmetic: which params belong on a mixer strip at all, where a
 * value sits along a fader, and what a drag of the pointer means.
 *
 * Pure and separate from the component for the same reasons `view/automation.ts`
 * is: every mistake available here is invisible on screen. A fader whose travel
 * does not reach its own range, a drag that rounds a permille pan to something
 * outside ±1000, a whole-kit trim that squashes the balance between voices the
 * moment one of them hits the rail — none of those look wrong in a picture of a
 * slider, and none need React to test.
 */

/**
 * What a param is, seen from a mixer.
 *
 * Decided from the param's *unit*, never its name. That is not fastidiousness
 * about hardcoding: it is what makes this a view over the registry rather than a
 * hand-written list of two params. Anything the registry measures in dB is a
 * level, and any bipolar 0-centred permille is a position between two speakers, so
 * a drumkit's four per-voice params sort themselves into faders and pans with no
 * knowledge of drumkits, and a per-track effect chain whose params are declared
 * the same way arrives on the strip already laid out.
 *
 * The limit, stated because it is real: a future `dB×100` param that is a
 * *threshold* rather than an output level would show up here as a fader. It would
 * still be labelled with its own key, so nothing is mislabelled — but that is the
 * point at which the registry needs to say what a param is *for*, and this
 * function is where that would be read from.
 */
export type MixerRole = "level" | "pan";

export function mixerRole(spec: ParamSpec): MixerRole | undefined {
  if (spec.unit === "dB100") return "level";
  if (spec.unit === "permille" && spec.min !== undefined && spec.min < 0) return "pan";
  return undefined;
}

/** The params of one instrument that belong on a mixer strip, by role. */
export function mixerParams(params: readonly InstrumentParam[], role: MixerRole): InstrumentParam[] {
  return params.filter((param) => mixerRole(param.spec) === role);
}

/**
 * One row of controls on a strip: everything a mixer draws for one voice, or for
 * the instrument itself.
 *
 * `levels` and `pans` are arrays rather than single params, and that is not
 * speculative generality — it is the shape the registry can already produce. A
 * per-track effect chain declared the same way as the built-in engines would put a
 * second `dB×100` param on the instrument, and a lane that could hold only one
 * would either drop it or need this file rewritten to notice it.
 */
export interface MixerLane {
  /** The voice these controls belong to, or `""` for the instrument itself. */
  voice: string;
  levels: InstrumentParam[];
  pans: InstrumentParam[];
}

/** The strip's rows, in the order the registry lists the params. */
export function mixerLanes(params: readonly InstrumentParam[]): MixerLane[] {
  const lanes = new Map<string, MixerLane>();
  for (const param of params) {
    const role = mixerRole(param.spec);
    if (role === undefined) continue;
    const voice = param.voice ?? "";
    let lane = lanes.get(voice);
    if (lane === undefined) {
      lane = { voice, levels: [], pans: [] };
      lanes.set(voice, lane);
    }
    if (role === "level") lane.levels.push(param);
    else lane.pans.push(param);
  }
  return [...lanes.values()];
}

/**
 * A control's travel: `length` pixels covering `min`..`max` in the param's own
 * unit. A fader is this along y with `min` at the bottom; a pan slider is this
 * along x with `min` at the left.
 */
export interface ControlAxis {
  length: number;
  min: number;
  max: number;
}

/** The axis for a param, refusing one the registry leaves unbounded. */
export function axisFor(spec: ParamSpec, key: string, length: number): ControlAxis {
  if (spec.min === undefined || spec.max === undefined) {
    throw new Error(`cannot draw a mixer control for "${key}": the registry gives it no range`);
  }
  return { length, min: spec.min, max: spec.max };
}

/** Pixels from the `min` end of the axis for a value in the param's unit. */
export function axisOffset(value: number, axis: ControlAxis): number {
  const span = axis.max - axis.min;
  if (span <= 0) return 0;
  return ((value - axis.min) / span) * axis.length;
}

/**
 * The integer value an offset from the `min` end means, clamped into range.
 *
 * Linear in the param's own unit, which for a level means linear in decibels. A
 * fader shaped like a console's — travel bunched towards unity — would need a
 * curve, and a curve is a second opinion about what a number means: the value
 * under the pointer would stop being readable off the axis, and typing a number
 * and dragging to it would land in different places. 66 dB over the fader's travel
 * is about half a decibel per pixel, which is finer than the ear, so the plain
 * mapping costs nothing that a curve would buy back.
 */
export function axisValue(offset: number, axis: ControlAxis): number {
  const span = axis.max - axis.min;
  if (span <= 0) return axis.min;
  return clampInteger(axis.min + (offset / axis.length) * span, axis.min, axis.max);
}

/**
 * The value a drag of `delta` pixels *towards `max`* from `from` lands on.
 *
 * The caller supplies the sign, because up is towards `max` on a fader and right
 * is towards `max` on a pan slider, and only the component knows which axis it
 * drew. One pixel of pointer movement is one pixel of travel — a fader that moves
 * a different distance from the hand under it is the thing that stops feeling like
 * a fader.
 */
export function draggedAxisValue(from: number, delta: number, axis: ControlAxis): number {
  return axisValue(axisOffset(from, axis) + delta, axis);
}

/**
 * Value per pixel of travel. What makes a trim feel like the faders under it:
 * both move the same number of decibels for the same movement of the hand.
 */
export function valuePerPixel(axis: ControlAxis): number {
  if (axis.length <= 0) return 0;
  return (axis.max - axis.min) / axis.length;
}

/**
 * How far a whole group of levels can move together before any one of them leaves
 * its range.
 *
 * A kit trim has to keep the balance between voices, so the bound is on the
 * *delta* rather than on each voice: clamping per voice would let a drag past the
 * bottom flatten the quiet voices onto the floor while the loud ones kept moving,
 * and the mix would not come back when the drag came back. Bounding the gesture
 * means the trim stops at the rail with every relative level intact.
 */
export function trimBounds(values: readonly number[], spec: ParamSpec, key: string): { min: number; max: number } {
  const axis = axisFor(spec, key, 1);
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: axis.min - Math.min(...values), max: axis.max - Math.max(...values) };
}

/** A trim delta clamped to what the group can actually take. */
export function clampTrim(delta: number, bounds: { min: number; max: number }): number {
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(delta)));
}

/**
 * A `dB×100` value as decibels, for a caption.
 *
 * Two decimals because that is the unit's resolution (PLAN.md §6), so the label is
 * lossless: −1000 reads as −10.00 dB and can be typed back as exactly that.
 */
export function db100Label(value: number): string {
  return `${(value / 100).toFixed(2)} dB`;
}

/**
 * A bipolar permille pan as a position, for a caption. 0 is centre, ±1000 hard.
 *
 * Spelled with a side rather than only a number because "−350" is not something
 * anyone hears; "35% left" is.
 */
export function panLabel(value: number, max: number): string {
  if (value === 0) return "centre";
  const percent = Math.round((Math.abs(value) / max) * 100);
  return `${percent}% ${value < 0 ? "left" : "right"}`;
}

/**
 * A value as a person reads it, chosen by unit rather than by param name.
 *
 * `-1000` is not a level anybody hears and `-350` is not a position; "−10.00 dB"
 * and "35% left" are. Anything else is shown as the integer it is, because the
 * registry's unit is already the honest label for it.
 */
export function paramValueLabel(spec: ParamSpec, value: number): string {
  if (spec.unit === "dB100") return db100Label(value);
  if (mixerRole(spec) === "pan") return panLabel(value, spec.max ?? 1000);
  return String(value);
}

/**
 * How far one arrow-key press moves a control: about a hundredth of its travel,
 * or exactly one unit with Shift held.
 *
 * Derived from the range so it needs no per-param table. A `gain` press is 0.66 dB
 * and a `pan` press is 2% of the width, both of which are a noticeable nudge rather
 * than the one-unit step a keyboard would otherwise give — 0.01 dB per press is a
 * control that appears not to respond to the keyboard at all.
 */
export function keyboardStep(axis: ControlAxis, fine: boolean): number {
  if (fine) return 1;
  return Math.max(1, Math.round((axis.max - axis.min) / 100));
}

/**
 * A linear amplitude as dBFS, for the master meter. `-inf` below the floor.
 *
 * The meter exists because of PLAN.md §6.3: the engine applies no hidden gain
 * reduction, so a mixer can and should be able to clip, and the only honest way to
 * ship that is to show the number rather than to prevent it. Above 0 dBFS the
 * float master is genuinely over — `render --analyze` reports the same overshoot as
 * a warning — and this says so while it is happening.
 */
export function dbfsLabel(peak: number): string {
  if (peak <= 0) return "-inf dBFS";
  return `${(20 * Math.log10(peak)).toFixed(2)} dBFS`;
}

function clampInteger(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.round(value)));
}
