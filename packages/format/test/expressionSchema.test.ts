import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXPRESSION_FIELDS,
  LANE_DEFAULT_FIELDS,
  NOTE_EXPRESSION_FIELDS,
  STEP_EVENT_FIELDS,
  checkExpressionValue,
  describeExpressionRange,
  type ExpressionField,
} from "../src/expression.js";

/**
 * `expression.ts` is the single declaration of what velocity, probability,
 * micro-timing, gate, ratchet and swing may hold — the compiler applies its
 * defaults and the UI renders its ranges. The JSON Schemas are the *other* place
 * those bounds are written down, and they are what actually refuses a bad
 * document.
 *
 * Two statements of one fact drift. So this pins them together in both
 * directions: every field a carrier accepts is declared, every declared field is
 * accepted, and the bounds are the same numbers. Widen a range in one place and
 * the failure names the other.
 */

const SCHEMAS = fileURLToPath(new URL("../schemas/", import.meta.url));

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
}

function schema(name: string): JsonSchema {
  return JSON.parse(readFileSync(`${SCHEMAS}${name}.schema.json`, "utf8")) as JsonSchema;
}

function at(root: JsonSchema, path: readonly string[]): JsonSchema {
  let node = root;
  for (const segment of path) {
    const next = segment === "[]" ? node.items : node.properties?.[segment];
    if (next === undefined) throw new Error(`no schema node at ${path.join("/")} (stopped at "${segment}")`);
    node = next;
  }
  return node;
}

const gridPattern = schema("pattern-grid");
const notesPattern = schema("pattern-notes");

/**
 * Every place the format carries expression, and which fields belong there.
 * Non-expression keys of the same object are named so the "no undeclared field"
 * check can tell "this schema grew a field the registry has never heard of" from
 * "this object also has a `step` index".
 */
const CARRIERS: {
  label: string;
  node: JsonSchema;
  fields: readonly ExpressionField[];
  others: readonly string[];
}[] = [
  {
    label: "a grid lane's defaults",
    node: at(gridPattern, ["lanes", "[]", "defaults"]),
    fields: LANE_DEFAULT_FIELDS,
    others: [],
  },
  {
    label: "a stepEvents entry",
    node: at(gridPattern, ["lanes", "[]", "stepEvents", "[]"]),
    fields: STEP_EVENT_FIELDS,
    others: ["step"],
  },
  {
    label: "a note event",
    node: at(notesPattern, ["notes", "[]"]),
    fields: [...NOTE_EXPRESSION_FIELDS, "velocity"],
    others: ["pitch", "startTick", "durationTicks"],
  },
  {
    label: "project.json",
    node: schema("project"),
    fields: ["swing"],
    others: [
      "format",
      "name",
      "description",
      "ppqn",
      "tempoMap",
      "meterMap",
      "key",
      "trackOrder",
    ],
  },
];

describe.each(CARRIERS)("$label matches the expression registry", ({ node, fields, others }) => {
  it("declares exactly the fields the schema accepts", () => {
    expect(Object.keys(node.properties ?? {}).sort()).toStrictEqual([...fields, ...others].sort());
  });

  it.each(fields)("bounds %s the same way the schema does", (field) => {
    const spec = EXPRESSION_FIELDS[field];
    const property = node.properties?.[field];
    if (property === undefined) throw new Error(`the schema has no "${field}"`);
    expect({ minimum: property.minimum, maximum: property.maximum }).toStrictEqual({
      minimum: spec.min,
      maximum: spec.max,
    });
  });
});

describe("checkExpressionValue", () => {
  it.each(Object.keys(EXPRESSION_FIELDS) as ExpressionField[])("accepts %s at its bounds and refuses just outside", (field) => {
    const spec = EXPRESSION_FIELDS[field];
    expect(checkExpressionValue(field, spec.min)).toBeUndefined();
    expect(checkExpressionValue(field, spec.min - 1)).toContain("at least");
    if (spec.max !== undefined) {
      expect(checkExpressionValue(field, spec.max)).toBeUndefined();
      expect(checkExpressionValue(field, spec.max + 1)).toContain("at most");
    }
    expect(checkExpressionValue(field, spec.min + 0.5)).toContain("integer");
  });

  it("names the unit and the bounds in the caption", () => {
    expect(describeExpressionRange("velocity")).toBe("permille 0..1000");
    expect(describeExpressionRange("gateTicks")).toBe("ticks ≥ 1");
    expect(describeExpressionRange("ratchet")).toBe("count 1..16");
  });
});

describe("the defaults the compiler applies", () => {
  it("states a constant for every field that has one, and null only for gateTicks", () => {
    const derived = (Object.keys(EXPRESSION_FIELDS) as ExpressionField[]).filter(
      (field) => EXPRESSION_FIELDS[field].default === null,
    );
    expect(derived).toStrictEqual(["gateTicks"]);
  });

  it("keeps every constant default inside its own range", () => {
    for (const field of Object.keys(EXPRESSION_FIELDS) as ExpressionField[]) {
      const value = EXPRESSION_FIELDS[field].default;
      if (value === null) continue;
      expect(checkExpressionValue(field, value)).toBeUndefined();
    }
  });
});
