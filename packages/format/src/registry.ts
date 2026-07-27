import type { InstrumentDoc } from "./model.js";

export type ParamUnit = "Hz" | "ms" | "cents" | "permille" | "dB100" | "bpm100" | "count" | "enum";

export interface ParamSpec {
  unit: ParamUnit;
  min?: number;
  max?: number;
  values?: readonly string[];
  default: number | string;
  automatable: boolean;
}

const SHARED_SUBTRACTIVE: Record<string, ParamSpec> = {
  oscillator: {
    unit: "enum",
    values: ["sine", "triangle", "sawtooth", "square"],
    default: "sawtooth",
    automatable: false,
  },
  detune: { unit: "cents", min: -1200, max: 1200, default: 0, automatable: true },
  "filter.type": {
    unit: "enum",
    values: ["lowpass", "highpass", "bandpass"],
    default: "lowpass",
    automatable: false,
  },
  "filter.cutoff": { unit: "Hz", min: 20, max: 20000, default: 12000, automatable: true },
  "filter.resonance": { unit: "permille", min: 0, max: 1000, default: 100, automatable: true },
  "filterEnv.amount": { unit: "permille", min: 0, max: 1000, default: 0, automatable: true },
  "amp.attack": { unit: "ms", min: 0, max: 20000, default: 5, automatable: false },
  "amp.decay": { unit: "ms", min: 0, max: 20000, default: 100, automatable: false },
  "amp.sustain": { unit: "permille", min: 0, max: 1000, default: 900, automatable: false },
  "amp.release": { unit: "ms", min: 0, max: 60000, default: 1000, automatable: false },
  gain: { unit: "dB100", min: -6000, max: 600, default: 0, automatable: true },
  pan: { unit: "permille", min: -1000, max: 1000, default: 0, automatable: true },
};

export const BASIC_MONO_PARAMS: Record<string, ParamSpec> = {
  ...SHARED_SUBTRACTIVE,
  portamento: { unit: "ms", min: 0, max: 5000, default: 0, automatable: false },
};

export const BASIC_POLY_PARAMS: Record<string, ParamSpec> = {
  ...SHARED_SUBTRACTIVE,
  maxVoices: { unit: "count", min: 1, max: 32, default: 16, automatable: false },
};

/** Per-voice drumkit params; the full key is `<voice>.<param>`. */
export const DRUMKIT_VOICE_PARAMS: Record<string, ParamSpec> = {
  gain: { unit: "dB100", min: -6000, max: 600, default: 0, automatable: true },
  pan: { unit: "permille", min: -1000, max: 1000, default: 0, automatable: true },
  pitch: { unit: "cents", min: -2400, max: 2400, default: 0, automatable: false },
  chokeGroup: { unit: "count", min: 0, max: 16, default: 0, automatable: false },
};

export interface ResolvedParam {
  spec: ParamSpec;
  /** For drumkit params, the voice this param addresses. */
  voice?: string;
}

/**
 * Resolves a dotted param key against an instrument. Returns undefined when
 * the key does not exist; `suggestions` lists valid keys for did-you-mean
 * diagnostics.
 */
export function resolveParam(instrument: InstrumentDoc, key: string): ResolvedParam | undefined {
  if (instrument.type === "synth") {
    const table = instrument.engine === "basic-mono" ? BASIC_MONO_PARAMS : BASIC_POLY_PARAMS;
    const spec = table[key];
    return spec ? { spec } : undefined;
  }
  const dot = key.indexOf(".");
  if (dot <= 0) return undefined;
  const voice = key.slice(0, dot);
  const param = key.slice(dot + 1);
  if (!(voice in instrument.kit)) return undefined;
  const spec = DRUMKIT_VOICE_PARAMS[param];
  return spec ? { spec, voice } : undefined;
}

export function validParamKeys(instrument: InstrumentDoc): string[] {
  if (instrument.type === "synth") {
    const table = instrument.engine === "basic-mono" ? BASIC_MONO_PARAMS : BASIC_POLY_PARAMS;
    return Object.keys(table);
  }
  const keys: string[] = [];
  for (const voice of Object.keys(instrument.kit)) {
    for (const param of Object.keys(DRUMKIT_VOICE_PARAMS)) {
      keys.push(`${voice}.${param}`);
    }
  }
  return keys;
}

/**
 * How each unit is written for a person. Lives here rather than in whoever is
 * printing, because `docs/format-spec.md` and `PLAN.md` both publish these
 * spellings and `test/registryDocs.test.ts` pins the tables to them.
 */
export const PARAM_UNIT_LABELS: Record<ParamUnit, string> = {
  Hz: "Hz",
  ms: "ms",
  cents: "cents",
  permille: "permille",
  dB100: "dB×100",
  bpm100: "bpm×100",
  count: "count",
  enum: "enum",
};

/** The unit and range as one short label, for a control's caption. */
export function describeParamRange(spec: ParamSpec): string {
  if (spec.unit === "enum") return (spec.values ?? []).join(", ");
  const low = spec.min === undefined ? "" : String(spec.min);
  const high = spec.max === undefined ? "" : String(spec.max);
  return `${PARAM_UNIT_LABELS[spec.unit]} ${low}..${high}`;
}

/** A param of one instrument: the key a `params` entry holds, and its spec. */
export interface InstrumentParam {
  /** The dotted key `params` and an automation lane's `param` hold, e.g. `kick.gain`. */
  key: string;
  spec: ParamSpec;
  /** For drumkit params, the voice this key addresses. */
  voice?: string;
}

/**
 * Every param this instrument has, sorted by key.
 *
 * The one place a UI should ask "what can I edit here?", and the reason an
 * instrument editor needs no list of param names of its own: a param added to the
 * tables above appears in every control, picker and mixer strip that is built
 * from this, with the right unit, range, default and enum values, and nothing in
 * the UI edited. `validParamKeys` and `resolveParam` do the work; this exists so
 * callers get the spec beside the key rather than resolving each one again.
 */
export function instrumentParams(instrument: InstrumentDoc): InstrumentParam[] {
  const params: InstrumentParam[] = [];
  for (const key of validParamKeys(instrument)) {
    const resolved = resolveParam(instrument, key);
    if (resolved === undefined) continue;
    params.push(
      resolved.voice === undefined ? { key, spec: resolved.spec } : { key, spec: resolved.spec, voice: resolved.voice },
    );
  }
  return params.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

/** A param an automation lane may target, resolved against one instrument. */
export type AutomatableParam = InstrumentParam;

/**
 * Every param on this instrument an automation lane may target, sorted by key.
 *
 * `instrumentParams` filtered, rather than a second walk of the tables, so a
 * param flipped to `automatable: true` appears in every picker without anything
 * else being edited, and one flipped the other way disappears from them.
 * `docs/format-spec.md` §7 is the rule this implements: a lane may only target a
 * param with `automatable: yes`.
 */
export function automatableParams(instrument: InstrumentDoc): AutomatableParam[] {
  return instrumentParams(instrument).filter((param) => param.spec.automatable);
}

/**
 * What a param is set to right now: the instrument's own entry, or the registry
 * default when it has none.
 *
 * Both halves of the editor's contract rest on this. An empty box means "the
 * default", so the box needs the default to show as its placeholder; and a value
 * typed back to the default removes the entry rather than restating it, so the
 * comparison needs the same number the renderer would use. Returns `undefined`
 * only for a key the instrument does not have.
 */
export function effectiveParamValue(instrument: InstrumentDoc, key: string): number | string | undefined {
  const resolved = resolveParam(instrument, key);
  if (resolved === undefined) return undefined;
  return instrument.params?.[key] ?? resolved.spec.default;
}

/**
 * The value a param holds when no automation is running.
 *
 * What a new automation lane should start from, so adding one changes nothing
 * until a point is moved — an automation lane that jumps the sound the moment it
 * is created is an editor guessing at music the author did not ask for. Numeric
 * by definition: an enum param is not automatable.
 */
export function staticParamValue(instrument: InstrumentDoc, key: string): number | undefined {
  const value = effectiveParamValue(instrument, key);
  return typeof value === "number" ? value : undefined;
}

export function checkParamValue(spec: ParamSpec, value: number | string): string | undefined {
  if (spec.unit === "enum") {
    if (typeof value !== "string") return "expected a string";
    if (!spec.values!.includes(value)) {
      return `expected one of: ${spec.values!.join(", ")}`;
    }
    return undefined;
  }
  if (typeof value !== "number") return "expected an integer";
  if (!Number.isInteger(value)) return "expected an integer";
  if (spec.min !== undefined && value < spec.min) return `minimum is ${spec.min}`;
  if (spec.max !== undefined && value > spec.max) return `maximum is ${spec.max}`;
  return undefined;
}
