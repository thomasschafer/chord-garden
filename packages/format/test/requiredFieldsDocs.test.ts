import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSchema } from "../src/schema.js";
import type { DocKind } from "../src/serialize.js";

/**
 * `docs/format-spec.md` §1.1 is the only statement of which fields a document
 * must carry, and an agent writing a project reads it instead of the schemas.
 * Prose drifts; this pins every row of it to the `required` and `properties`
 * of the schema that actually decides, so a field added to or moved within a
 * schema fails here until the table says so too.
 *
 * The pin runs in both directions: an undocumented object fails as surely as a
 * documented one that no longer exists.
 */
const SPEC_PATH = fileURLToPath(new URL("../../../docs/format-spec.md", import.meta.url));

const DOC_KINDS: readonly DocKind[] = [
  "project",
  "track",
  "instrument.synth",
  "instrument.drumkit",
  "pattern.grid",
  "pattern.notes",
  "arrangement",
  "automation",
];

/** The field inventory of one object, as either the spec or a schema states it. */
interface FieldSets {
  required: string[];
  optional: string[];
}

const schemaObjects = collectSchemaObjects();
const documentedObjects = parseFieldTables(readFileSync(SPEC_PATH, "utf8"));

describe("docs/format-spec.md §1.1 documents the schemas' required fields", () => {
  it("documents every object with fields exactly once, and no object that does not exist", () => {
    expect([...documentedObjects.keys()].sort()).toStrictEqual([...schemaObjects.keys()].sort());
  });

  it.each([...schemaObjects.keys()])("states the required and optional fields of %s", (context) => {
    const documented = documentedObjects.get(context);
    if (documented === undefined) throw new Error(`no table row documents "${context}"`);
    expect(documented).toStrictEqual(schemaObjects.get(context));
  });

  /**
   * §1.1's two closing paragraphs make claims no field table can carry: which
   * objects may not be empty, and which arrays may not be. They are pinned
   * here so the prose cannot outlive the constraint it describes.
   */
  it("states which objects may not be empty", () => {
    expect(emptinessRules("minProperties")).toStrictEqual({
      "instrument.drumkit.kit": 1,
      "pattern.grid.lanes[].defaults": 1,
      // Two, not one: an entry that names only the `step` it targets overrides
      // nothing, so `step` plus at least one override is the real floor.
      "pattern.grid.lanes[].stepEvents[]": 2,
    });
  });

  it("states which arrays may not be empty, and which are fixed-arity", () => {
    expect(emptinessRules("minItems")).toStrictEqual({
      "automation.lanes": 1,
      "automation.lanes[].points": 1,
      "pattern.grid.lanes": 1,
      "pattern.grid.lanes[].stepEvents": 1,
      "project.meterMap": 1,
      "project.tempoMap": 1,
      // These two are tuple arity rather than emptiness: an automation point is
      // exactly [tick, value] and a time signature exactly two integers.
      "automation.lanes[].points[]": 2,
      "project.meterMap[].timeSignature": 2,
    });
  });
});

/**
 * Every object in every schema that has a fixed set of fields, keyed by a
 * dotted path from its document kind. `[]` is an array element and `[*]` a
 * value in an open map, which is the notation §1.1 and canonical key order
 * (§5.2) both use.
 *
 * Objects with no `properties` — the open `params` and `kit` maps, and the
 * tuple-shaped automation points — have no field set to document and are
 * deliberately absent.
 */
function collectSchemaObjects(): Map<string, FieldSets> {
  const objects = new Map<string, FieldSets>();
  for (const kind of DOC_KINDS) walkSchema(loadSchema(kind), kind, objects);
  return objects;
}

function walkSchema(node: unknown, context: string, into: Map<string, FieldSets>): void {
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  const properties = asRecord(schema["properties"]);
  if (properties !== undefined) {
    const required = (schema["required"] as string[] | undefined) ?? [];
    const names = Object.keys(properties);
    const unknown = required.filter((name) => !names.includes(name));
    if (unknown.length > 0) throw new Error(`${context} requires fields it does not declare: ${unknown.join(", ")}`);
    if (into.has(context)) throw new Error(`two schema objects share the path "${context}"`);
    into.set(context, {
      required: [...required].sort(),
      optional: names.filter((name) => !required.includes(name)).sort(),
    });
    for (const [name, child] of Object.entries(properties)) walkSchema(child, `${context}.${name}`, into);
  }
  walkSchema(schema["items"], `${context}[]`, into);
  const patternProperties = asRecord(schema["patternProperties"]);
  if (patternProperties !== undefined) {
    for (const child of Object.values(patternProperties)) walkSchema(child, `${context}[*]`, into);
  }
}

/** Every `minProperties`/`minItems` constraint in the schemas, by object path. */
function emptinessRules(keyword: "minProperties" | "minItems"): Record<string, number> {
  const found: Record<string, number> = {};
  const visit = (node: unknown, context: string): void => {
    if (node === null || typeof node !== "object") return;
    const schema = node as Record<string, unknown>;
    const value = schema[keyword];
    if (typeof value === "number") found[context] = value;
    for (const [name, child] of Object.entries(asRecord(schema["properties"]) ?? {})) {
      visit(child, `${context}.${name}`);
    }
    visit(schema["items"], `${context}[]`);
    for (const child of Object.values(asRecord(schema["patternProperties"]) ?? {})) visit(child, `${context}[*]`);
  };
  for (const kind of DOC_KINDS) visit(loadSchema(kind), kind);
  return found;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * The §1.1 tables: three-cell rows whose first cell is a backticked object
 * path. Parsing is confined to that section rather than to a row shape,
 * because §2's unit table is also three cells wide and also leads with a
 * backticked cell — a shape-only parser reads `permille` as an object.
 */
function parseFieldTables(markdown: string): Map<string, FieldSets> {
  const rows = new Map<string, FieldSets>();
  let inSection = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) {
      if (inSection) break;
      inSection = /^### 1\.1\b/.test(line);
      continue;
    }
    if (!inSection || !line.startsWith("| `")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 3) continue;
    const [object, required, optional] = cells;
    if (object === undefined || required === undefined || optional === undefined) continue;
    const context = plain(object);
    if (rows.has(context)) throw new Error(`object "${context}" is documented by more than one table row`);
    rows.set(context, { required: fieldList(required), optional: fieldList(optional) });
  }
  if (rows.size === 0) throw new Error("no field tables found in docs/format-spec.md — has §1.1 moved?");
  return rows;
}

/** A cell of comma-separated backticked field names, or the literal "(none)". */
function fieldList(cell: string): string[] {
  const text = cell.trim();
  if (text === "(none)") return [];
  return text
    .split(",")
    .map((field) => plain(field))
    .filter((field) => field !== "")
    .sort();
}

function plain(cell: string): string {
  return cell.replaceAll("`", "").trim();
}
