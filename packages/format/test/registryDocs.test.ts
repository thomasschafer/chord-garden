import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASIC_MONO_PARAMS,
  BASIC_POLY_PARAMS,
  DRUMKIT_VOICE_PARAMS,
  EFFECT_PARAMS,
  PARAM_UNIT_LABELS,
  type ParamSpec,
} from "../src/registry.js";

/**
 * The parameter registry is documented in two places an agent may read without
 * the source. Prose can drift; these tables must not, so they are pinned to
 * `registry.ts` rather than reviewed by eye. Comparison is on meaning, not
 * bytes: each document keeps its own markup conventions.
 */
const DOCS = [
  { label: "docs/format-spec.md", path: fileURLToPath(new URL("../../../docs/format-spec.md", import.meta.url)) },
  { label: "PLAN.md", path: fileURLToPath(new URL("../../../PLAN.md", import.meta.url)) },
] as const;

interface DocumentedParam {
  unit: string;
  range: string;
  default: string;
  automatable: string;
}

/** What a row claims, reduced to the facts the registry also states. */
interface ParamFacts {
  unit: string;
  bounds: [number, number] | undefined;
  values: string[] | undefined;
  default: string;
  automatable: boolean;
}

describe.each(DOCS)("$label documents the parameter registry", ({ path }) => {
  const rows = parseParamRows(readFileSync(path, "utf8"));

  it("documents every param exactly once, and no param that does not exist", () => {
    expect([...rows.keys()].sort()).toStrictEqual(registryEntries().map(({ key }) => key).sort());
  });

  it.each(registryEntries())("states the registry's unit, range, default, and automatability for $key", ({ key, spec }) => {
    const row = rows.get(key);
    if (row === undefined) throw new Error(`no table row documents "${key}"`);
    expect(documentedFacts(row)).toStrictEqual(registryFacts(spec));
  });
});

function registryEntries(): { key: string; spec: ParamSpec }[] {
  const merged: [string, ParamSpec][] = [
    ...Object.entries({ ...BASIC_MONO_PARAMS, ...BASIC_POLY_PARAMS }),
    ...Object.entries(DRUMKIT_VOICE_PARAMS).map(([param, spec]): [string, ParamSpec] => [`<voice>.${param}`, spec]),
    // Effect params are keyed `fx.<type>.<param>` here because that is how the docs
    // head their tables; the automation key an author writes is `fx.<id>.<param>`,
    // where the id is the author's, not the type. Both halves of this lock must
    // move together: adding a row here without the doc table, or the reverse, is
    // exactly the drift this test exists to catch.
    ...Object.entries(EFFECT_PARAMS).flatMap(([type, table]) =>
      Object.entries(table).map(([param, spec]): [string, ParamSpec] => [`fx.${type}.${param}`, spec]),
    ),
  ];
  return merged.map(([key, spec]) => ({ key, spec }));
}

function registryFacts(spec: ParamSpec): ParamFacts {
  if (spec.unit === "enum") {
    if (spec.values === undefined) throw new Error("enum param has no values");
    return {
      unit: "enum",
      bounds: undefined,
      values: [...spec.values],
      default: String(spec.default),
      automatable: spec.automatable,
    };
  }
  if (spec.min === undefined || spec.max === undefined) throw new Error("numeric param has no bounds");
  return {
    unit: PARAM_UNIT_LABELS[spec.unit],
    bounds: [spec.min, spec.max],
    values: undefined,
    default: String(spec.default),
    automatable: spec.automatable,
  };
}

function documentedFacts(row: DocumentedParam): ParamFacts {
  const unit = plain(row.unit);
  const range = plain(row.range);
  const bounds = /^(-?\d+)\.\.(-?\d+)$/.exec(range);
  return {
    unit,
    bounds: bounds === null ? undefined : [Number(bounds[1]), Number(bounds[2])],
    values: unit === "enum" ? range.split(",").map((value) => value.trim()) : undefined,
    // Trailing gloss such as "0 (none)" documents the value, it is not part of it.
    default: plain(row.default).split(" ")[0] ?? "",
    automatable: parseAutomatable(row.automatable),
  };
}

function parseAutomatable(cell: string): boolean {
  const value = plain(cell);
  if (value !== "yes" && value !== "no") throw new Error(`expected "yes" or "no" in an automatable cell, got "${cell}"`);
  return value === "yes";
}

/** Drops markup and normalises the typographic minus the tables use. */
function plain(cell: string): string {
  return cell.replaceAll("`", "").replaceAll("−", "-").trim();
}

/**
 * Markdown rows whose first cell is a backticked param name.
 *
 * Effect tables are scoped by the bold effect type that introduces them, so a
 * row reads `damping` in the docs where a musician wants to see it, while the
 * key compared against the registry is `fx.reverb.damping`. Without that, delay and
 * reverb both documenting a `damping` would read as one param documented twice —
 * and keying by the bare name would silently let each check the other's spec. Any
 * heading ends a scope, so an instrument table after an effects section is never
 * attributed to an effect.
 */
function parseParamRows(markdown: string): Map<string, DocumentedParam> {
  const rows = new Map<string, DocumentedParam>();
  const EFFECT_HEADING = /^\*\*(delay|reverb|filter)\*\*/;
  let scope: string | undefined;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) {
      scope = undefined;
      continue;
    }
    const heading = EFFECT_HEADING.exec(line);
    if (heading !== null) {
      scope = heading[1];
      continue;
    }
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5) continue;
    const [name, unit, range, defaultValue, automatable] = cells;
    if (name === undefined || unit === undefined || range === undefined) continue;
    if (defaultValue === undefined || automatable === undefined) continue;
    const bare = plain(name);
    const key = scope === undefined ? bare : `fx.${scope}.${bare}`;
    if (rows.has(key)) throw new Error(`param "${key}" is documented by more than one table row`);
    rows.set(key, { unit, range, default: defaultValue, automatable });
  }
  return rows;
}
