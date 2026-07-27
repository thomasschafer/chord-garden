import type { EffectDoc, EffectType, InstrumentDoc } from "./model.js";

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

/**
 * Feedback delay. Four params, and each one earns its place.
 *
 * `time` is milliseconds, not a musical division, and that is a decision rather
 * than an omission. Every *position* in this format is ticks and every *device
 * time constant* is already ms — `amp.attack`, `amp.release`, `portamento` — and
 * a delay time is the second kind: it is a property of the box, not a place in
 * the arrangement. A synced `1/8.` enum would also be unautomatable by
 * construction and would turn the delay line's length into a function of tempo,
 * which is a much larger change the day tempo ramps arrive (a time-varying tap
 * needs a fractional read pointer, and the pitch artefacts that come with it).
 * An author who wants a synced delay computes it once: a beat at `bpm` is
 * `60000 / bpm` ms, so an eighth at 124 BPM is 242.
 *
 * `time` is not automatable for the same reason: the tap is read at an integer
 * offset, so sweeping it would step rather than glide. Modulated delay is
 * deferred, not faked.
 *
 * `feedback` stops at 950, not 1000. Unity feedback is a loop that never decays,
 * and the format's habit is to encode an invariant in the declared range rather
 * than to rely on a runtime clamp nobody can see (PLAN.md's typing rule). 950
 * still rings for tens of seconds, which is as long as anyone wants.
 *
 * `damping` is a one-pole lowpass inside the feedback path. It is here because a
 * delay without it is not a smaller feature, it is a worse one: every repeat is
 * an identical copy, so high frequencies pile up and a long feedback setting
 * turns metallic. It is also what makes maximum feedback musically usable.
 */
export const DELAY_PARAMS: Record<string, ParamSpec> = {
  time: { unit: "ms", min: 1, max: 2000, default: 375, automatable: false },
  feedback: { unit: "permille", min: 0, max: 950, default: 300, automatable: true },
  damping: { unit: "permille", min: 0, max: 1000, default: 300, automatable: true },
  mix: { unit: "permille", min: 0, max: 1000, default: 250, automatable: true },
};

/**
 * Reverb. `size` and `damping` are the two controls that decide what the room
 * sounds like — how long it rings and how dark the ring is — and `mix` decides
 * how much of it you hear.
 *
 * `width` is the fourth because a reverb collapsed to the centre and a reverb
 * spread across the image are different musical objects, not different amounts
 * of the same one, and it costs one multiply. Its maximum is 1000, so the wet
 * signal is at most fully decorrelated; there is no over-wide setting that
 * inverts a channel.
 *
 * `size` maps onto the recirculation gain of the structure's comb filters, and
 * the maximum maps strictly below unity — the stability guarantee lives in the
 * mapping, so no reachable value can make the tail grow.
 */
export const REVERB_PARAMS: Record<string, ParamSpec> = {
  size: { unit: "permille", min: 0, max: 1000, default: 500, automatable: true },
  damping: { unit: "permille", min: 0, max: 1000, default: 500, automatable: true },
  width: { unit: "permille", min: 0, max: 1000, default: 1000, automatable: true },
  mix: { unit: "permille", min: 0, max: 1000, default: 200, automatable: true },
};

/**
 * Filter. The same biquad, the same Q mapping and the same three responses as a
 * synth voice's `filter.*` — literally the same `BiquadFilter` class — so a
 * cutoff sweep on a whole track and one inside an instrument cannot sound like
 * two different filters.
 *
 * The mode is called `mode` rather than `type` because an effect entry already
 * has a `type` (`"filter"`), and `{"type": "filter", "params": {"type":
 * "lowpass"}}` is a sentence nobody should have to read twice.
 *
 * There is no `mix`: a filter is an insert, so it is fully wet by definition. To
 * blend, automate `cutoff`.
 */
export const FILTER_EFFECT_PARAMS: Record<string, ParamSpec> = {
  mode: {
    unit: "enum",
    values: ["lowpass", "highpass", "bandpass"],
    default: "lowpass",
    automatable: false,
  },
  cutoff: { unit: "Hz", min: 20, max: 20000, default: 1000, automatable: true },
  resonance: { unit: "permille", min: 0, max: 1000, default: 100, automatable: true },
};

/** Every effect type's parameter table, keyed by the `type` an entry declares. */
export const EFFECT_PARAMS: Record<EffectType, Record<string, ParamSpec>> = {
  delay: DELAY_PARAMS,
  reverb: REVERB_PARAMS,
  filter: FILTER_EFFECT_PARAMS,
};

export const EFFECT_TYPES: readonly EffectType[] = ["delay", "reverb", "filter"];

/**
 * The namespace an automation lane addresses an effect param through:
 * `fx.<effectId>.<param>`.
 *
 * Three segments exactly, which is what keeps it from ever colliding with a
 * drumkit's two-segment `<voice>.<param>` — even for a kit that happens to have a
 * voice named `fx`.
 */
export const EFFECT_PARAM_PREFIX = "fx";

/** The dotted key that addresses one param of one effect. */
export function effectParamKey(effectId: string, param: string): string {
  return `${EFFECT_PARAM_PREFIX}.${effectId}.${param}`;
}

/**
 * Splits `fx.<effectId>.<param>`, or returns undefined for any other key.
 *
 * Deliberately strict about the segment count: a two-segment `fx.gain` is a
 * drumkit voice's param and must not be read as a malformed effect target, and a
 * four-segment key is not addressing anything that exists.
 */
export function parseEffectParamKey(key: string): { effectId: string; param: string } | undefined {
  const parts = key.split(".");
  if (parts.length !== 3) return undefined;
  const [prefix, effectId, param] = parts;
  if (prefix !== EFFECT_PARAM_PREFIX) return undefined;
  if (effectId === undefined || effectId === "" || param === undefined || param === "") return undefined;
  return { effectId, param };
}

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

/** Resolves an effect's own param name (`mix`, `cutoff`) against its type. */
export function resolveEffectParam(type: EffectType, param: string): ParamSpec | undefined {
  return EFFECT_PARAMS[type][param];
}

/** Every param name an effect of this type accepts, in table order. */
export function validEffectParamKeys(type: EffectType): string[] {
  return Object.keys(EFFECT_PARAMS[type]);
}

/** One effect's params, sorted by name — the effect-side twin of `instrumentParams`. */
export function effectParams(effect: EffectDoc): InstrumentParam[] {
  return Object.entries(EFFECT_PARAMS[effect.type])
    .map(([key, spec]) => ({ key, spec }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

/** What an effect param is set to right now, or its registry default. */
export function effectiveEffectParamValue(effect: EffectDoc, param: string): number | string | undefined {
  const spec = resolveEffectParam(effect.type, param);
  if (spec === undefined) return undefined;
  return effect.params?.[param] ?? spec.default;
}

/**
 * A param an automation lane on one track may address: an instrument param, or an
 * effect param on that track's chain.
 *
 * `effectId` is present exactly when the key is `fx.<id>.<param>`, and is the
 * effect's own id rather than anything positional — so this resolves to the same
 * effect however the chain is ordered.
 */
export interface ResolvedTrackParam {
  spec: ParamSpec;
  voice?: string;
  effectId?: string;
  /** The param's name within its effect, without the `fx.<id>.` prefix. */
  effectParam?: string;
}

/**
 * Resolves an automation target against a track: its instrument's params plus its
 * effect chain's.
 *
 * The single place that decides what a lane's `param` string may name, so
 * validation, the compiler and the automation picker cannot disagree about it.
 */
export function resolveTrackParam(
  instrument: InstrumentDoc,
  effects: readonly EffectDoc[] | undefined,
  key: string,
): ResolvedTrackParam | undefined {
  const parsed = parseEffectParamKey(key);
  if (parsed !== undefined) {
    const effect = effects?.find((candidate) => candidate.id === parsed.effectId);
    if (effect === undefined) return undefined;
    const spec = resolveEffectParam(effect.type, parsed.param);
    return spec === undefined ? undefined : { spec, effectId: effect.id, effectParam: parsed.param };
  }
  const resolved = resolveParam(instrument, key);
  if (resolved === undefined) return undefined;
  return resolved.voice === undefined ? { spec: resolved.spec } : { spec: resolved.spec, voice: resolved.voice };
}

/** Every param key valid on this track, for did-you-mean and for a picker. */
export function validTrackParamKeys(instrument: InstrumentDoc, effects: readonly EffectDoc[] | undefined): string[] {
  const keys = validParamKeys(instrument);
  for (const effect of effects ?? []) {
    for (const param of validEffectParamKeys(effect.type)) keys.push(effectParamKey(effect.id, param));
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

/**
 * Every param an automation lane on this track may target, sorted by key:
 * the instrument's automatable params, then each effect's, in chain order.
 *
 * The automation picker's only source, so an effect param flipped to
 * `automatable: true` in the registry appears in it with the right unit and range
 * and nothing in the UI edited — the same contract `automatableParams` already
 * has for instruments.
 */
export function automatableTrackParams(
  instrument: InstrumentDoc,
  effects: readonly EffectDoc[] | undefined,
): InstrumentParam[] {
  const params: InstrumentParam[] = automatableParams(instrument);
  for (const effect of effects ?? []) {
    for (const param of effectParams(effect)) {
      if (param.spec.automatable) params.push({ key: effectParamKey(effect.id, param.key), spec: param.spec });
    }
  }
  return params;
}

/**
 * The value a track param holds with no automation running — an instrument param
 * or an effect param. Numeric by definition: an enum param is not automatable.
 */
export function staticTrackParamValue(
  instrument: InstrumentDoc,
  effects: readonly EffectDoc[] | undefined,
  key: string,
): number | undefined {
  const parsed = parseEffectParamKey(key);
  if (parsed === undefined) return staticParamValue(instrument, key);
  const effect = effects?.find((candidate) => candidate.id === parsed.effectId);
  if (effect === undefined) return undefined;
  const value = effectiveEffectParamValue(effect, parsed.param);
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
