import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASIC_MONO_PARAMS,
  BASIC_POLY_PARAMS,
  DRUMKIT_VOICE_PARAMS,
  EFFECT_PARAMS,
  EFFECT_TYPES,
  canonicalFiles,
  effectParamKey,
  ID_PATTERN,
  loadProject,
  resolveParam,
} from "../src/index.js";

/**
 * One grammar for a param key, pinned across every schema that names one.
 *
 * A param key is dot-separated segments, and a segment has to be able to hold a
 * *kit voice id* — `swung-hat` — because a drumkit's params are keyed
 * `<voice>.<param>` (docs/format-spec.md §6). Voice ids are kebab-case, so a key
 * grammar that forbids `-` cannot name half the params a legal drumkit has.
 *
 * That is not hypothetical: `fixtures/valid/swung-hats` has voices `straight-hat`
 * and `swung-hat`, and until this was pinned the *identical string*
 * `swung-hat.gain` was accepted as an automation lane's target and rejected as a
 * key of the instrument's own `params`. A param an editor could automate but not
 * set, with a `schema.additionalProperties` naming a key the format defines.
 *
 * Four schemas say what a param key may look like and none of them can `$ref` the
 * others — `schema.ts` compiles each document schema standalone. So they are four
 * copies of one rule, and four copies drift. This file is the standing proof that
 * they have not: change one and the failure names the rest.
 *
 * The schema stays deliberately coarse. It is a shape gate, not a spelling
 * checker — the registry is what knows that `swung-hat.gain` exists and
 * `swung-hat.gaim` does not, and it answers with `registry.unknown-param` and a
 * did-you-mean. Tightening the pattern to the keys that exist today would only
 * move a good diagnostic to a worse one.
 */
const PARAM_KEY_PATTERN = "^[a-zA-Z][a-zA-Z0-9-]*(\\.[a-zA-Z][a-zA-Z0-9-]*)*$";

const SCHEMAS = fileURLToPath(new URL("../schemas/", import.meta.url));

interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  patternProperties?: Record<string, JsonSchema>;
  pattern?: string;
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

/** The sole key of a `patternProperties` map — the regex that gates its keys. */
function soleKeyPattern(node: JsonSchema): string {
  const keys = Object.keys(node.patternProperties ?? {});
  if (keys.length !== 1) {
    throw new Error(`expected exactly one patternProperties entry, found ${keys.length}: ${keys.join(", ")}`);
  }
  return keys[0]!;
}

/**
 * Every place in the format where a param key's *shape* is decided. A new one
 * added without a line here is the drift this file exists to catch, so the count
 * is asserted below rather than left implicit.
 */
const PARAM_KEY_SITES: { label: string; pattern: () => string }[] = [
  {
    label: "instrument-synth /properties/params",
    pattern: () => soleKeyPattern(at(schema("instrument-synth"), ["params"])),
  },
  {
    label: "instrument-drumkit /properties/params",
    pattern: () => soleKeyPattern(at(schema("instrument-drumkit"), ["params"])),
  },
  {
    label: "track /properties/effects/items/properties/params",
    pattern: () => soleKeyPattern(at(schema("track"), ["effects", "[]", "params"])),
  },
  {
    label: "automation /properties/lanes/items/properties/param",
    pattern: () => {
      const node = at(schema("automation"), ["lanes", "[]", "param"]);
      if (node.pattern === undefined) throw new Error("the automation lane's `param` has no pattern");
      return node.pattern;
    },
  },
];

describe("the param-key grammar", () => {
  it("is the same rule in every schema that names a param key", () => {
    const found = Object.fromEntries(PARAM_KEY_SITES.map((site) => [site.label, site.pattern()]));
    const expected = Object.fromEntries(PARAM_KEY_SITES.map((site) => [site.label, PARAM_KEY_PATTERN]));
    expect(found).toEqual(expected);
  });

  it("covers every site there is", () => {
    // Guards the list above: a fifth `params` map added to a schema without a
    // line in `PARAM_KEY_SITES` would leave this file passing while the new
    // schema disagreed with the other four.
    const maps = [
      ...Object.keys(at(schema("instrument-synth"), ["params"]).patternProperties ?? {}),
      ...Object.keys(at(schema("instrument-drumkit"), ["params"]).patternProperties ?? {}),
      ...Object.keys(at(schema("track"), ["effects", "[]", "params"]).patternProperties ?? {}),
    ];
    expect(maps).toEqual([PARAM_KEY_PATTERN, PARAM_KEY_PATTERN, PARAM_KEY_PATTERN]);
  });
});

describe("what the param-key grammar accepts", () => {
  const matches = (key: string): boolean => new RegExp(PARAM_KEY_PATTERN).test(key);

  it("accepts every param key the registry actually defines", () => {
    const keys = [...Object.keys(BASIC_MONO_PARAMS), ...Object.keys(BASIC_POLY_PARAMS)];
    for (const type of EFFECT_TYPES) keys.push(...Object.keys(EFFECT_PARAMS[type]));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(matches(key), `registry param "${key}" is unwritable`).toBe(true);
  });

  it("accepts a drumkit voice param for any legal voice id", () => {
    // The case the asymmetry broke. Voice ids share `ID_PATTERN` with every other
    // id in the format, so the grammar has to admit each of these composed with
    // each voice param, or a legal kit has params no document can carry.
    const voices = ["kick", "swung-hat", "hat-909-open", "x2"];
    for (const voice of voices) {
      expect(ID_PATTERN.test(voice), `"${voice}" is not a legal id`).toBe(true);
      for (const param of Object.keys(DRUMKIT_VOICE_PARAMS)) {
        expect(matches(`${voice}.${param}`), `"${voice}.${param}" is unwritable`).toBe(true);
      }
    }
  });

  it("accepts an effect param key for any legal effect id", () => {
    for (const type of EFFECT_TYPES) {
      for (const param of Object.keys(EFFECT_PARAMS[type])) {
        const key = effectParamKey("tape-echo", param);
        expect(matches(key), `"${key}" is unwritable`).toBe(true);
      }
    }
  });

  it("still refuses the shapes a param key may not have", () => {
    // `__proto__` above all: `fixtures/invalid/proto-key-param` rests on the
    // pattern rejecting it, and loosening the grammar to admit `-` must not have
    // opened that door. The rest pin the boundary the hyphen fix moved — a hyphen
    // is legal *inside* a segment and never at the start of one.
    for (const key of ["__proto__", "-hat.gain", "hat.-gain", "1hat.gain", ".gain", "gain.", "swung hat.gain", ""]) {
      expect(matches(key), `"${key}" should not be a legal param key`).toBe(false);
    }
  });
});

describe("a hyphenated kit voice's param, end to end", () => {
  const VALID_ROOT = fileURLToPath(new URL("../../../fixtures/valid", import.meta.url));
  const temps: string[] = [];
  afterEach(() => {
    for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * `fixtures/valid/swung-hats` with the same key set two ways: as an override on
   * the instrument, and as an automation lane targeting it. A writable copy,
   * because the committed fixture is a golden and this test's whole point is the
   * key it does not currently carry.
   */
  function projectWithSwungHatGain(): string {
    const root = mkdtempSync(join(tmpdir(), "chord-garden-hyphen-param-"));
    temps.push(root);
    cpSync(join(VALID_ROOT, "swung-hats"), root, { recursive: true });

    const instrument = join(root, "instruments/hats-kit.json");
    const kit = JSON.parse(readFileSync(instrument, "utf8")) as Record<string, unknown>;
    kit["params"] = { "swung-hat.gain": -300 };
    writeFileSync(instrument, JSON.stringify(kit, null, 2));

    mkdirSync(join(root, "automation"), { recursive: true });
    writeFileSync(
      join(root, "automation/hats.json"),
      JSON.stringify(
        { track: "hats", lanes: [{ param: "swung-hat.gain", interp: "linear", points: [[0, -300], [3840, -100]] }] },
        null,
        2,
      ),
    );
    return root;
  }

  it("validates as an instrument param and as an automation lane at once", () => {
    const result = loadProject(projectWithSwungHatGain());
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);

    // The asymmetry stated as one assertion: one key, both carriers, same answer.
    const instrument = result.project!.instruments.get("hats-kit")!;
    expect(instrument.params?.["swung-hat.gain"]).toBe(-300);
    expect(result.project!.automation.get("hats")?.lanes[0]?.param).toBe("swung-hat.gain");
  });

  it("resolves through the registry to the voice it names", () => {
    const result = loadProject(projectWithSwungHatGain());
    const resolved = resolveParam(result.project!.instruments.get("hats-kit")!, "swung-hat.gain");
    expect(resolved?.spec.unit).toBe(DRUMKIT_VOICE_PARAMS["gain"]!.unit);
  });

  it("survives a canonical round trip byte for byte", () => {
    const root = projectWithSwungHatGain();
    const first = loadProject(root);
    const written = canonicalFiles(first.project!);
    expect(written.get("instruments/hats-kit.json")).toContain('"swung-hat.gain"');

    // Written back out and read again: `fmt` cannot drop or mangle the key, and
    // the second pass is byte-identical to the first — the property
    // `test/byteIdentity.test.ts` holds for the format as a whole.
    for (const [path, text] of written) writeFileSync(join(root, path), text);
    const second = loadProject(root);
    expect(second.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(canonicalFiles(second.project!)).toEqual(written);
  });
});
