import { BASIC_POLY_PARAMS, type AutomationLane } from "@chord-garden/format/pure";
import { describe, expect, it } from "vitest";
import {
  automationBounds,
  automationPxPerTick,
  clampAutomationPoint,
  curveOf,
  polylinePoints,
  tickToX,
  valueToY,
  xToTick,
  yToValue,
  type AutomationGeometry,
} from "../src/view/automation";
import {
  draggedVelocity,
  effectiveStepValue,
  expressionFraction,
  formatDefault,
  inheritedStepValue,
  laneSwing,
  swingEffect,
  type LaneContext,
} from "../src/view/expression";

/**
 * The arithmetic behind the automation editor and the grid's velocity display.
 *
 * All of it is the kind of thing that is wrong in a way you cannot see: an axis
 * that maps a Hz value to the wrong height looks like a perfectly good curve, a
 * drag that lets a point past its neighbour writes a file the validator rejects
 * with no visible warning first, and a curve drawn flat from tick 0 shows a
 * sweep the engine is not playing. None of it needs React.
 */

/** A 20..20000 Hz axis, 100 px tall, over a 16-bar arrangement at 3840 ticks a bar. */
const CUTOFF = BASIC_POLY_PARAMS["filter.cutoff"]!;
const LENGTH_TICKS = 61_440;
const GEOMETRY: AutomationGeometry = {
  pxPerTick: 900 / LENGTH_TICKS,
  height: 100,
  ...automationBounds(CUTOFF, "filter.cutoff"),
};

describe("the value axis", () => {
  it("puts the registry's minimum at the bottom and its maximum at the top", () => {
    expect(valueToY(20, GEOMETRY)).toBe(100);
    expect(valueToY(20_000, GEOMETRY)).toBe(0);
    expect(yToValue(100, GEOMETRY)).toBe(20);
    expect(yToValue(0, GEOMETRY)).toBe(20_000);
  });

  it("round-trips a value through a pixel to within the axis's own resolution", () => {
    // 100 px over 19980 Hz is 200 Hz a pixel, so this is as exact as the axis gets.
    for (const value of [20, 5000, 12_000, 20_000]) {
      expect(Math.abs(yToValue(valueToY(value, GEOMETRY), GEOMETRY) - value)).toBeLessThan(200);
    }
  });

  it("clamps a pixel outside the box rather than producing a value the format rejects", () => {
    expect(yToValue(-500, GEOMETRY)).toBe(20_000);
    expect(yToValue(9999, GEOMETRY)).toBe(20);
    expect(xToTick(-40, GEOMETRY, LENGTH_TICKS)).toBe(0);
    expect(xToTick(99_999, GEOMETRY, LENGTH_TICKS)).toBe(LENGTH_TICKS);
  });

  it("always produces an integer, because the format holds no floats", () => {
    for (let y = 0; y <= 100; y += 7) expect(Number.isInteger(yToValue(y, GEOMETRY))).toBe(true);
    for (let x = 0; x < 900; x += 37) expect(Number.isInteger(xToTick(x, GEOMETRY, LENGTH_TICKS))).toBe(true);
  });

  it("refuses to draw a param the registry gives no range", () => {
    expect(() => automationBounds({ unit: "Hz", default: 0, automatable: true }, "mystery")).toThrow(/no range/);
  });
});

describe("clamping a dragged point", () => {
  const lane: AutomationLane = {
    param: "filter.cutoff",
    interp: "linear",
    points: [
      [0, 200],
      [30_720, 4000],
      [61_440, 800],
    ],
  };

  it("stops one tick short of a neighbour, keeping the points strictly increasing", () => {
    expect(clampAutomationPoint(lane, 1, 0, 4000, GEOMETRY, LENGTH_TICKS)).toEqual([1, 4000]);
    expect(clampAutomationPoint(lane, 1, 99_999, 4000, GEOMETRY, LENGTH_TICKS)).toEqual([61_439, 4000]);
  });

  it("lets the first and last points reach the ends of the arrangement", () => {
    expect(clampAutomationPoint(lane, 0, -50, 200, GEOMETRY, LENGTH_TICKS)[0]).toBe(0);
    expect(clampAutomationPoint(lane, 2, 99_999, 800, GEOMETRY, LENGTH_TICKS)[0]).toBe(LENGTH_TICKS);
  });

  it("clamps the value to the param's own range, not to a normalised one", () => {
    expect(clampAutomationPoint(lane, 1, 30_720, 99_999, GEOMETRY, LENGTH_TICKS)[1]).toBe(20_000);
    expect(clampAutomationPoint(lane, 1, 30_720, -5, GEOMETRY, LENGTH_TICKS)[1]).toBe(20);
  });

  it("pins a point its neighbours leave no room for, rather than reordering them", () => {
    const tight: AutomationLane = { param: "gain", interp: "linear", points: [[10, 0], [11, 0], [12, 0]] };
    expect(clampAutomationPoint(tight, 1, 0, 0, GEOMETRY, LENGTH_TICKS)[0]).toBe(11);
    expect(clampAutomationPoint(tight, 1, 9999, 0, GEOMETRY, LENGTH_TICKS)[0]).toBe(11);
  });
});

describe("the drawn curve", () => {
  it("draws the stretch before the first point at the instrument's static value, not the point's", () => {
    const lane: AutomationLane = { param: "filter.cutoff", interp: "linear", points: [[30_720, 4000]] };

    const curve = curveOf(lane, 1200, GEOMETRY, LENGTH_TICKS);

    // Flat at 1200 — what `AutomationRamps.update` falls back to — up to the point.
    expect(curve.before).toEqual([
      { x: 0, y: valueToY(1200, GEOMETRY) },
      { x: tickToX(30_720, GEOMETRY), y: valueToY(1200, GEOMETRY) },
    ]);
    expect(curve.before[0]!.y).not.toBe(valueToY(4000, GEOMETRY));
  });

  it("draws no lead-in when the lane already starts at tick 0", () => {
    const lane: AutomationLane = { param: "filter.cutoff", interp: "linear", points: [[0, 4000]] };

    expect(curveOf(lane, 1200, GEOMETRY, LENGTH_TICKS).before).toEqual([]);
  });

  it("holds the last value to the end of the arrangement", () => {
    const lane: AutomationLane = { param: "filter.cutoff", interp: "linear", points: [[0, 4000]] };

    const curve = curveOf(lane, 1200, GEOMETRY, LENGTH_TICKS);

    expect(curve.after.at(-1)).toEqual({ x: tickToX(LENGTH_TICKS, GEOMETRY), y: valueToY(4000, GEOMETRY) });
  });

  it("turns a corner per point for a step lane and none for a linear one", () => {
    const points: [number, number][] = [
      [0, 200],
      [30_720, 4000],
    ];

    const linear = curveOf({ param: "filter.cutoff", interp: "linear", points }, 200, GEOMETRY, LENGTH_TICKS);
    const stepped = curveOf({ param: "filter.cutoff", interp: "step", points }, 200, GEOMETRY, LENGTH_TICKS);

    // Two points plus the hold to the end.
    expect(linear.after).toHaveLength(3);
    // The same, plus one corner: hold 200 until 30720, then jump to 4000.
    expect(stepped.after).toHaveLength(4);
    expect(stepped.after[1]).toEqual({ x: tickToX(30_720, GEOMETRY), y: valueToY(200, GEOMETRY) });
    expect(stepped.after[2]).toEqual({ x: tickToX(30_720, GEOMETRY), y: valueToY(4000, GEOMETRY) });
  });

  it("renders as an SVG points list", () => {
    expect(polylinePoints([{ x: 0, y: 100 }, { x: 12.345, y: 0 }])).toBe("0,100 12.35,0");
  });
});

describe("zoom", () => {
  it("fits the whole arrangement at 1× and multiplies from there", () => {
    expect(automationPxPerTick(LENGTH_TICKS, 900, 1) * LENGTH_TICKS).toBeCloseTo(900);
    expect(automationPxPerTick(LENGTH_TICKS, 900, 4) * LENGTH_TICKS).toBeCloseTo(3600);
  });

  it("refuses an arrangement with no length rather than dividing by zero", () => {
    expect(() => automationPxPerTick(0, 900, 1)).toThrow(/0-tick/);
  });
});

describe("what a grid step inherits", () => {
  const context: LaneContext = { stepTicks: 240, projectSwing: 0 };

  it("prefers the step's own override, then the lane default, then the format's", () => {
    const lane = {
      lane: "hat",
      grid: { stepsPerBar: 16 },
      steps: "x.x. x.x. x.x. x.x.",
      defaults: { velocity: 600 },
      stepEvents: [{ step: 2, velocity: 350 }],
    };

    expect(effectiveStepValue(lane, 2, "velocity", context)).toBe(350);
    expect(effectiveStepValue(lane, 4, "velocity", context)).toBe(600);
    expect(inheritedStepValue(lane, "velocity", context)).toBe(600);
    // No lane default for probability, so the format's 1000.
    expect(effectiveStepValue(lane, 2, "probability", context)).toBe(1000);
  });

  it("falls back to one step for a gate, which is the only default that is not a constant", () => {
    const lane = { lane: "hat", grid: { stepsPerBar: 16 }, steps: "x..." };

    expect(inheritedStepValue(lane, "gateTicks", context)).toBe(240);
    expect(formatDefault("gateTicks", { stepTicks: 480, projectSwing: 0 })).toBe(480);
  });

  it("reports where a lane's swing came from", () => {
    const bare = { lane: "kick", grid: { stepsPerBar: 16 }, steps: "x..." };
    const own = { ...bare, defaults: { swing: 300 } };

    expect(laneSwing(bare, 120)).toEqual({ permille: 120, from: "project" });
    expect(laneSwing(own, 120)).toEqual({ permille: 300, from: "lane" });
  });
});

describe("what swing actually reaches", () => {
  it("counts the odd-indexed hits, which is why four-on-the-floor is immune", () => {
    expect(swingEffect([0, 4, 8, 12], 600, 240)).toEqual({ delayTicks: 72, moved: 0, total: 4 });
    expect(swingEffect([1, 3, 5, 7], 600, 240)).toEqual({ delayTicks: 72, moved: 4, total: 4 });
    expect(swingEffect([0, 1, 2, 3], 600, 240)).toEqual({ delayTicks: 72, moved: 2, total: 4 });
  });

  it("computes the delay the compiler computes", () => {
    // docs/format-spec.md §4: round(swing * stepTicks / 2000).
    expect(swingEffect([1], 1000, 240).delayTicks).toBe(120);
    expect(swingEffect([1], 667, 240).delayTicks).toBe(80);
    expect(swingEffect([1], 0, 240).delayTicks).toBe(0);
  });
});

describe("dragging a velocity", () => {
  it("moves up when the pointer moves up, and clamps to the registry's range", () => {
    expect(draggedVelocity(500, -10)).toBe(580);
    expect(draggedVelocity(500, 10)).toBe(420);
    expect(draggedVelocity(500, -9999)).toBe(1000);
    expect(draggedVelocity(500, 9999)).toBe(0);
  });

  it("always produces an integer permille", () => {
    for (let delta = -30; delta <= 30; delta += 7) {
      expect(Number.isInteger(draggedVelocity(500, delta + 0.4))).toBe(true);
    }
  });

  it("turns a value into the fraction of its range a bar should be drawn at", () => {
    expect(expressionFraction("velocity", 0)).toBe(0);
    expect(expressionFraction("velocity", 1000)).toBe(1);
    expect(expressionFraction("velocity", 500)).toBe(0.5);
  });
});
