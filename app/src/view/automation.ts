import type { AutomationLane, ParamSpec } from "@chord-garden/format/pure";

/**
 * The automation editor's arithmetic: a param value to a pixel, a pixel back to
 * a value in the param's own unit, and a drag to a legal breakpoint.
 *
 * Pure and separate from the component for the same reason `view/roll.ts` is.
 * The mistakes available here are all invisible on screen: a curve drawn from
 * the first point rather than from the value the instrument actually produces, a
 * drag that rounds a Hz value to something outside the registry's range, a point
 * dragged past its neighbour so the file stops being strictly increasing
 * (docs/format-spec.md §7). None of those can be caught by looking at a picture
 * of a line, and none need React to test.
 */

export interface AutomationGeometry {
  pxPerTick: number;
  /** Height of the value area in CSS pixels; `min` is the bottom, `max` the top. */
  height: number;
  min: number;
  max: number;
}

/**
 * Bounds for a param, refusing one the registry leaves open.
 *
 * An unbounded automatable param cannot be drawn — there is no top of the graph
 * to put `max` at — and every automatable entry in the v1 registry has both
 * bounds. Failing loudly here means the day one does not, this says so instead
 * of silently drawing everything at y=NaN.
 */
export function automationBounds(spec: ParamSpec, param: string): { min: number; max: number } {
  if (spec.min === undefined || spec.max === undefined) {
    throw new Error(`cannot draw automation for "${param}": the registry gives it no range to draw against`);
  }
  return { min: spec.min, max: spec.max };
}

/** Pixels from the top of the value area for a value in the param's unit. */
export function valueToY(value: number, geometry: AutomationGeometry): number {
  const span = geometry.max - geometry.min;
  if (span <= 0) return geometry.height / 2;
  const fraction = (value - geometry.min) / span;
  return geometry.height - fraction * geometry.height;
}

/** The integer value a y offset means, clamped into range. */
export function yToValue(y: number, geometry: AutomationGeometry): number {
  const span = geometry.max - geometry.min;
  if (span <= 0) return geometry.min;
  const fraction = 1 - y / geometry.height;
  return clampInteger(geometry.min + fraction * span, geometry.min, geometry.max);
}

export function tickToX(tick: number, geometry: AutomationGeometry): number {
  return tick * geometry.pxPerTick;
}

/** The integer tick an x offset means, clamped to the arrangement. */
export function xToTick(x: number, geometry: AutomationGeometry, lengthTicks: number): number {
  return clampInteger(x / geometry.pxPerTick, 0, lengthTicks);
}

/**
 * Where dragging point `index` to `(tick, value)` may actually put it.
 *
 * Clamping happens here rather than in the store, and the split is deliberate:
 * the store refuses an illegal point outright, because a typed value that
 * silently became a different value is a lie about what the file now says. A
 * *drag* has no such text to contradict — the pointer is a request for "as far
 * as this goes", and stopping at the neighbour is what every editor does and
 * what makes a curve draggable at all.
 *
 * A point may not reach its neighbour's tick, only the tick before it, because
 * the format requires strictly increasing points. That also means a point can be
 * pinned: two neighbours one tick apart leave it nowhere to go, which is honest
 * rather than something to work around.
 */
export function clampAutomationPoint(
  lane: AutomationLane,
  index: number,
  tick: number,
  value: number,
  geometry: AutomationGeometry,
  lengthTicks: number,
): [number, number] {
  const before = lane.points[index - 1]?.[0];
  const after = lane.points[index + 1]?.[0];
  const low = before === undefined ? 0 : before + 1;
  const high = after === undefined ? lengthTicks : after - 1;
  return [
    clampInteger(tick, Math.min(low, high), Math.max(low, high)),
    clampInteger(value, geometry.min, geometry.max),
  ];
}

/** A point on the drawn curve, in pixels. */
export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * The curve as the *engine* reads it, in pixels, split at the first breakpoint.
 *
 * `before` is the stretch the lane does not cover. `AutomationRamps.update`
 * falls back to the instrument's static value there — the lane's first point
 * does not reach backwards — so drawing a flat line at the first point's value
 * would show a sweep starting somewhere it does not. It is returned separately
 * so the editor can draw it as what it is.
 *
 * `after` is the covered stretch, and holds the interpolation: `linear` joins
 * the points, `step` holds each value until the next one, and both extend flat
 * to the end of the arrangement because the last point holds from then on.
 */
export function curveOf(
  lane: AutomationLane,
  fallback: number,
  geometry: AutomationGeometry,
  lengthTicks: number,
): { before: CurvePoint[]; after: CurvePoint[] } {
  const first = lane.points[0];
  if (first === undefined) {
    return {
      before: [
        { x: 0, y: valueToY(fallback, geometry) },
        { x: tickToX(lengthTicks, geometry), y: valueToY(fallback, geometry) },
      ],
      after: [],
    };
  }

  const before: CurvePoint[] =
    first[0] === 0
      ? []
      : [
          { x: 0, y: valueToY(fallback, geometry) },
          { x: tickToX(first[0], geometry), y: valueToY(fallback, geometry) },
        ];

  const after: CurvePoint[] = [];
  lane.points.forEach((point, index) => {
    const at = { x: tickToX(point[0], geometry), y: valueToY(point[1], geometry) };
    const previous = lane.points[index - 1];
    if (previous !== undefined && lane.interp === "step") {
      // The corner a step curve turns: hold the previous value all the way to
      // this tick, then jump.
      after.push({ x: at.x, y: valueToY(previous[1], geometry) });
    }
    after.push(at);
  });
  const last = lane.points[lane.points.length - 1]!;
  if (last[0] < lengthTicks) {
    after.push({ x: tickToX(lengthTicks, geometry), y: valueToY(last[1], geometry) });
  }
  return { before, after };
}

/** An SVG `points` attribute for a polyline. */
export function polylinePoints(points: readonly CurvePoint[]): string {
  return points.map((point) => `${round(point.x)},${round(point.y)}`).join(" ");
}

/**
 * Zoom levels for the automation view, as a multiple of "the whole arrangement
 * fits". Automation spans the song rather than a pattern, so the useful default
 * is the shape of the whole thing; the multiples are for placing a point at a
 * particular bar.
 */
export const AUTOMATION_ZOOMS = [1, 2, 4, 8] as const;

/** Pixels per tick that fit `lengthTicks` into `width`, times the zoom. */
export function automationPxPerTick(lengthTicks: number, width: number, zoom: number): number {
  if (lengthTicks <= 0) throw new Error(`cannot lay out automation for a ${lengthTicks}-tick arrangement`);
  return (width / lengthTicks) * zoom;
}

function clampInteger(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.round(value)));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
