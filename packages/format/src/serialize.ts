import type { JsonValue } from "./jsonParse.js";

export type DocKind =
  | "project"
  | "track"
  | "instrument.synth"
  | "instrument.drumkit"
  | "pattern.grid"
  | "pattern.notes"
  | "arrangement"
  | "automation";

/**
 * Canonical key order per serialization context. Contexts are dotted paths
 * rooted at the document kind; `[]` denotes array elements and `[*]` values
 * of map-shaped objects (whose keys are sorted alphabetically instead).
 */
const KEY_ORDER: Record<string, readonly string[]> = {
  project: ["format", "name", "description", "ppqn", "tempoMap", "meterMap", "key", "swing", "trackOrder"],
  "project.tempoMap[]": ["startTick", "bpm"],
  "project.meterMap[]": ["startTick", "timeSignature"],
  "project.key": ["root", "scale"],
  track: ["id", "description", "type", "instrument", "patterns"],
  "instrument.synth": ["id", "description", "type", "engine", "params"],
  "instrument.drumkit": ["id", "description", "type", "kit", "params"],
  "instrument.drumkit.kit[*]": ["sample"],
  "pattern.grid": ["id", "description", "kind", "lengthTicks", "lanes"],
  "pattern.grid.lanes[]": ["lane", "grid", "steps", "defaults", "stepEvents"],
  "pattern.grid.lanes[].grid": ["stepsPerBar"],
  "pattern.grid.lanes[].defaults": ["velocity", "gateTicks", "probability", "swing"],
  "pattern.grid.lanes[].stepEvents[]": ["step", "velocity", "microTicks", "gateTicks", "probability", "ratchet"],
  "pattern.notes": ["id", "description", "kind", "lengthTicks", "notes"],
  "pattern.notes.notes[]": ["pitch", "startTick", "durationTicks", "velocity", "microTicks", "probability", "ratchet"],
  arrangement: ["description", "lengthTicks", "clips"],
  "arrangement.clips[]": ["track", "pattern", "startTick", "repeatCount"],
  automation: ["track", "description", "lanes"],
  "automation.lanes[]": ["param", "interp", "points"],
};

/** Contexts whose objects are open maps: keys sorted alphabetically. */
const MAP_CONTEXTS = new Set([
  "instrument.synth.params",
  "instrument.drumkit.kit",
  "instrument.drumkit.params",
]);

/**
 * Serializes a document to canonical bytes: schema-specific key order,
 * 2-space indent, primitive-only arrays inlined, integers only, trailing
 * newline. This is the single writer every producer must converge on.
 */
export function serializeCanonical(value: JsonValue, kind: DocKind): string {
  return write(value, kind, 0) + "\n";
}

function write(value: JsonValue, ctx: string, level: number): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return writeNumber(value, ctx);
  if (Array.isArray(value)) return writeArray(value, ctx, level);
  return writeObject(value as Record<string, JsonValue>, ctx, level);
}

function writeNumber(value: number, ctx: string): string {
  if (!Number.isInteger(value)) {
    throw new Error(`canonical serializer invariant violated: non-integer number ${value} at ${ctx}`);
  }
  return String(Object.is(value, -0) ? 0 : value);
}

function writeArray(value: JsonValue[], ctx: string, level: number): string {
  if (value.length === 0) return "[]";
  const itemCtx = `${ctx}[]`;
  const allPrimitive = value.every((v) => v === null || typeof v !== "object");
  if (allPrimitive) {
    return `[${value.map((v) => write(v, itemCtx, level)).join(", ")}]`;
  }
  const pad = "  ".repeat(level + 1);
  const items = value.map((v) => pad + write(v, itemCtx, level + 1));
  return `[\n${items.join(",\n")}\n${"  ".repeat(level)}]`;
}

function writeObject(value: Record<string, JsonValue>, ctx: string, level: number): string {
  const keys = orderKeys(Object.keys(value), ctx);
  if (keys.length === 0) return "{}";
  const pad = "  ".repeat(level + 1);
  const entries = keys.map((key) => {
    const childCtx = MAP_CONTEXTS.has(ctx) ? `${ctx}[*]` : `${ctx}.${key}`;
    return `${pad}${JSON.stringify(key)}: ${write(value[key]!, childCtx, level + 1)}`;
  });
  return `{\n${entries.join(",\n")}\n${"  ".repeat(level)}}`;
}

function orderKeys(keys: string[], ctx: string): string[] {
  if (MAP_CONTEXTS.has(ctx)) return keys.sort();
  const order = KEY_ORDER[ctx];
  if (!order) return keys.sort();
  const rank = new Map(order.map((k, i) => [k, i]));
  return keys.sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
