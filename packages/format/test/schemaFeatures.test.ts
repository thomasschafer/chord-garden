import { describe, expect, it } from "vitest";
import { loadSchema, schemaValidate } from "../src/index.js";

/**
 * Proves the Ajv 2020-12 setup actually enforces the schema features the
 * format depends on, per PLAN §5/§18: a generic misconfiguration (wrong Ajv
 * entry point, missing strict mode) would silently pass malformed documents.
 */
describe("JSON Schema 2020-12 feature enforcement", () => {
  it("prefixItems enforces tuple element types (meterMap timeSignature)", () => {
    const bad = {
      format: 1,
      name: "x",
      ppqn: 960,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: ["four", 4] }],
      swing: 0,
      trackOrder: [],
    };
    const errors = schemaValidate(bad, "project", "project.json", new Map());
    expect(errors.length).toBeGreaterThan(0);
  });

  it("prefixItems rejects a third tuple element via items:false", () => {
    const bad = {
      format: 1,
      name: "x",
      ppqn: 960,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4, 4] }],
      swing: 0,
      trackOrder: [],
    };
    const errors = schemaValidate(bad, "project", "project.json", new Map());
    expect(errors.length).toBeGreaterThan(0);
  });

  it("unevaluatedProperties rejects unknown top-level fields", () => {
    const bad = {
      format: 1,
      name: "x",
      ppqn: 960,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: [],
      tempo: 124,
    };
    const errors = schemaValidate(bad, "project", "project.json", new Map());
    expect(errors.some((e) => e.code === "schema.unevaluatedProperties")).toBe(true);
  });

  it("a schema without unevaluatedProperties would let the same field through (control case)", async () => {
    const permissive = { ...loadSchema("project") } as Record<string, unknown>;
    delete permissive.unevaluatedProperties;
    // This directly exercises Ajv rather than the cached compiled validator,
    // confirming the failure above is due to the keyword, not something else.
    const Ajv2020 = (await import("ajv/dist/2020.js")).default;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(permissive);
    const value = {
      format: 1,
      name: "x",
      ppqn: 960,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: [],
      tempo: 124,
    };
    expect(validate(value)).toBe(true);
  });
});
