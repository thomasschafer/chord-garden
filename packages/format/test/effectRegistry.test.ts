import { describe, expect, it } from "vitest";
import {
  DELAY_PARAMS,
  EFFECT_PARAMS,
  EFFECT_TYPES,
  FILTER_EFFECT_PARAMS,
  REVERB_PARAMS,
  automatableTrackParams,
  effectParamKey,
  parseEffectParamKey,
  resolveEffectParam,
  resolveTrackParam,
  staticTrackParamValue,
  validTrackParamKeys,
  type DrumkitInstrumentDoc,
  type EffectDoc,
  type ParamSpec,
  type SynthInstrumentDoc,
} from "../src/index.js";

/**
 * The effect parameter tables, pinned the way `registryDocs.test.ts` pins the
 * instrument ones — except that the instrument tables are pinned against the two
 * published documents, and these are not yet documented. That is deliberate and
 * temporary: `docs/format-spec.md` is maintainer-owned, so the tables below are
 * the contract until the spec catches up, and the moment it does this file should
 * be replaced by extending `registryEntries()` in `registryDocs.test.ts` so the
 * docs and the registry lock together the way they already do for instruments.
 *
 * Until then this is a real assertion, not a placeholder: every unit, bound,
 * default and automatability that the DSP, the validator and the UI all read is
 * written out once here, so changing one by accident fails.
 */
const EXPECTED: Record<string, Record<string, ParamSpec>> = {
  delay: {
    time: { unit: "ms", min: 1, max: 2000, default: 375, automatable: false },
    feedback: { unit: "permille", min: 0, max: 950, default: 300, automatable: true },
    damping: { unit: "permille", min: 0, max: 1000, default: 300, automatable: true },
    mix: { unit: "permille", min: 0, max: 1000, default: 250, automatable: true },
  },
  reverb: {
    size: { unit: "permille", min: 0, max: 1000, default: 500, automatable: true },
    damping: { unit: "permille", min: 0, max: 1000, default: 500, automatable: true },
    width: { unit: "permille", min: 0, max: 1000, default: 1000, automatable: true },
    mix: { unit: "permille", min: 0, max: 1000, default: 200, automatable: true },
  },
  filter: {
    mode: {
      unit: "enum",
      values: ["lowpass", "highpass", "bandpass"],
      default: "lowpass",
      automatable: false,
    },
    cutoff: { unit: "Hz", min: 20, max: 20000, default: 1000, automatable: true },
    resonance: { unit: "permille", min: 0, max: 1000, default: 100, automatable: true },
  },
};

const SYNTH: SynthInstrumentDoc = { id: "s", type: "synth", engine: "basic-mono" };
const KIT: DrumkitInstrumentDoc = {
  id: "k",
  type: "drumkit",
  // A voice literally named `fx`, to prove the namespaces cannot collide.
  kit: { fx: { sample: "samples/a.wav" }, kick: { sample: "samples/b.wav" } },
};

const CHAIN: EffectDoc[] = [
  { id: "tone", type: "filter" },
  { id: "slap", type: "delay", params: { mix: 400 } },
];

describe("the effect parameter registry", () => {
  it("declares exactly the three effect types", () => {
    expect([...EFFECT_TYPES].sort()).toEqual(["delay", "filter", "reverb"]);
    expect(Object.keys(EFFECT_PARAMS).sort()).toEqual([...EFFECT_TYPES].sort());
    expect(EFFECT_PARAMS.delay).toBe(DELAY_PARAMS);
    expect(EFFECT_PARAMS.reverb).toBe(REVERB_PARAMS);
    expect(EFFECT_PARAMS.filter).toBe(FILTER_EFFECT_PARAMS);
  });

  it.each(Object.keys(EXPECTED))("states every param of a %s exactly once", (type) => {
    expect(EFFECT_PARAMS[type as keyof typeof EFFECT_PARAMS]).toStrictEqual(EXPECTED[type]);
  });

  /**
   * Every unit an effect uses must already exist in the format's unit table
   * (docs/format-spec.md §2). A new unit is a format change and would have to be
   * documented and given a canonical spelling before anything could use it.
   */
  it("uses only units the format already defines", () => {
    const used = new Set(Object.values(EFFECT_PARAMS).flatMap((table) => Object.values(table).map((spec) => spec.unit)));
    expect([...used].sort()).toEqual(["Hz", "enum", "ms", "permille"]);
  });

  it("keeps every automatable param numeric and bounded, so a lane can be drawn", () => {
    for (const [type, table] of Object.entries(EFFECT_PARAMS)) {
      for (const [param, spec] of Object.entries(table)) {
        if (!spec.automatable) continue;
        expect({ type, param, unit: spec.unit }).not.toMatchObject({ unit: "enum" });
        expect(typeof spec.default, `${type}.${param}`).toBe("number");
        // The automation editor derives an axis from these; an unbounded param
        // throws there, so an unbounded automatable param is a broken lane.
        expect(spec.min, `${type}.${param} min`).toBeTypeOf("number");
        expect(spec.max, `${type}.${param} max`).toBeTypeOf("number");
      }
    }
  });

  it("stops delay feedback below unity, so no reachable value fails to decay", () => {
    expect(DELAY_PARAMS.feedback?.max).toBeLessThan(1000);
  });
});

describe("fx.<id>.<param> addressing", () => {
  it("round-trips an id and a param", () => {
    expect(effectParamKey("my-delay", "mix")).toBe("fx.my-delay.mix");
    expect(parseEffectParamKey("fx.my-delay.mix")).toEqual({ effectId: "my-delay", param: "mix" });
  });

  it("claims only three-segment fx keys, so a drumkit voice named fx is untouched", () => {
    // Two segments is the drumkit form, whatever the voice is called.
    expect(parseEffectParamKey("fx.gain")).toBeUndefined();
    expect(resolveTrackParam(KIT, CHAIN, "fx.gain")?.voice).toBe("fx");
    // Four segments addresses nothing that exists.
    expect(parseEffectParamKey("fx.a.b.c")).toBeUndefined();
    expect(parseEffectParamKey("effects.a.b")).toBeUndefined();
    expect(parseEffectParamKey("fx..mix")).toBeUndefined();
  });

  it("resolves an effect param by id, not by position in the chain", () => {
    const forward = resolveTrackParam(SYNTH, CHAIN, "fx.slap.mix");
    const reversed = resolveTrackParam(SYNTH, [...CHAIN].reverse(), "fx.slap.mix");
    expect(forward).toEqual({ spec: DELAY_PARAMS.mix, effectId: "slap", effectParam: "mix" });
    // The whole point: reordering the chain re-targets nothing.
    expect(reversed).toEqual(forward);
  });

  it("resolves instrument params through the same entry point", () => {
    expect(resolveTrackParam(SYNTH, CHAIN, "filter.cutoff")?.spec.unit).toBe("Hz");
    expect(resolveTrackParam(SYNTH, CHAIN, "fx.slap.nope")).toBeUndefined();
    expect(resolveTrackParam(SYNTH, CHAIN, "fx.missing.mix")).toBeUndefined();
    expect(resolveTrackParam(SYNTH, undefined, "fx.slap.mix")).toBeUndefined();
  });

  it("offers every chain param for did-you-mean and for a picker", () => {
    const keys = validTrackParamKeys(SYNTH, CHAIN);
    expect(keys).toContain("fx.tone.cutoff");
    expect(keys).toContain("fx.slap.feedback");
    expect(keys).toContain("filter.cutoff");
    // Non-automatable params are valid keys but must not reach the picker.
    expect(keys).toContain("fx.slap.time");
    const automatable = automatableTrackParams(SYNTH, CHAIN).map((param) => param.key);
    expect(automatable).toContain("fx.slap.feedback");
    expect(automatable).toContain("fx.tone.cutoff");
    expect(automatable).not.toContain("fx.slap.time");
    expect(automatable).not.toContain("fx.tone.mode");
  });

  it("reads a lane's starting value from the document, or the registry default", () => {
    expect(staticTrackParamValue(SYNTH, CHAIN, "fx.slap.mix")).toBe(400);
    expect(staticTrackParamValue(SYNTH, CHAIN, "fx.tone.cutoff")).toBe(FILTER_EFFECT_PARAMS.cutoff?.default);
    expect(staticTrackParamValue(SYNTH, CHAIN, "fx.missing.mix")).toBeUndefined();
    // An enum is not automatable, so it has no numeric starting value.
    expect(staticTrackParamValue(SYNTH, CHAIN, "fx.tone.mode")).toBeUndefined();
  });

  it("resolves an effect param without consulting the instrument at all", () => {
    expect(resolveEffectParam("delay", "mix")).toBe(DELAY_PARAMS.mix);
    expect(resolveEffectParam("reverb", "mix")).toBe(REVERB_PARAMS.mix);
    expect(resolveEffectParam("filter", "mix")).toBeUndefined();
  });
});
