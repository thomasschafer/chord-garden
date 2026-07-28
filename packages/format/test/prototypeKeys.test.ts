import { describe, expect, it } from "vitest";
import { parseStrictJson, resolveEffectParam, resolveParam, serializeCanonical } from "../src/index.js";
import type { JsonObject } from "../src/index.js";
import type { InstrumentDoc } from "../src/model.js";

/**
 * Names a project file may legitimately choose that are also members of
 * `Object.prototype`. Nothing in the source special-cases any of them: they are
 * here to demonstrate that own-property lookup makes the whole class behave, not
 * to enumerate a deny-list anyone has to maintain.
 */
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

describe("keys that collide with Object.prototype", () => {
  it("parses a `__proto__` member as an own key without moving the prototype", () => {
    const parsed = parseStrictJson('{"__proto__": 5, "id": "s"}', "instruments/s.json");
    expect(parsed.diagnostics).toEqual([]);
    const value = parsed.value as JsonObject;
    // Assigning `__proto__` to a normal object literal reaches the setter instead
    // of creating a property, which is how the key used to disappear between the
    // file and the parse result — and how `fmt` came to delete it.
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(Object.keys(value)).toEqual(["__proto__", "id"]);
    expect(Object.getPrototypeOf(value)).toBe(null);
  });

  it("round-trips a `__proto__` member through the canonical serializer", () => {
    const text = '{"id": "s", "type": "synth", "engine": "basic-mono", "params": {"__proto__": 5}}';
    const parsed = parseStrictJson(text, "instruments/s.json");
    const written = serializeCanonical(parsed.value!, "instrument.synth");
    expect(written).toContain('"__proto__": 5');
    // `fmt` never changes a value (docs/format-spec.md §5.2), so a second pass
    // over its own output has to be a fixed point rather than a deletion.
    const reparsed = parseStrictJson(written, "instruments/s.json");
    expect(reparsed.diagnostics).toEqual([]);
    expect(serializeCanonical(reparsed.value!, "instrument.synth")).toBe(written);
  });

  it("does not resolve a synth param named after an Object.prototype member", () => {
    const instrument = { id: "s", type: "synth", engine: "basic-mono" } as InstrumentDoc;
    for (const key of PROTOTYPE_KEYS) {
      expect(resolveParam(instrument, key), key).toBeUndefined();
    }
    expect(resolveParam(instrument, "filter.cutoff")).toBeDefined();
  });

  it("does not resolve a drumkit voice or param named after an Object.prototype member", () => {
    const instrument = {
      id: "d",
      type: "drumkit",
      kit: { kick: { sample: "samples/kick.wav" } },
    } as unknown as InstrumentDoc;
    for (const key of PROTOTYPE_KEYS) {
      // The voice half: `"constructor" in kit` was true, so the lane resolved and
      // its automation was then silently ignored at render time.
      expect(resolveParam(instrument, `${key}.gain`), key).toBeUndefined();
      // And the param half, against the shared per-voice table.
      expect(resolveParam(instrument, `kick.${key}`), key).toBeUndefined();
    }
    expect(resolveParam(instrument, "kick.gain")).toBeDefined();
  });

  it("does not resolve an effect param named after an Object.prototype member", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(resolveEffectParam("delay", key), key).toBeUndefined();
    }
    expect(resolveEffectParam("delay", "feedback")).toBeDefined();
  });
});
