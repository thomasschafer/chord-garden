// The registry is imported from its own module, not the package root: the root
// re-exports `loadProject`, which imports `node:fs`, and this file is in the
// AudioWorklet's import graph, where a `node:*` specifier cannot be bundled at
// all. `workletBundle.test.ts` keeps that true.
import { BASIC_MONO_PARAMS, BASIC_POLY_PARAMS, DRUMKIT_VOICE_PARAMS } from "@chord-garden/format/registry";
import type { DrumkitInstrumentDoc, SynthInstrumentDoc } from "@chord-garden/format";
import type { DrumVoiceSettings, SampleData, SynthSettings } from "../dsp/index.js";

/**
 * Instrument document -> DSP settings. Shared by the offline renderer and the
 * live worklet so neither can drift into its own interpretation of a param.
 * Sample bytes arrive through `resolveSample` because the two paths get them
 * from different places (filesystem vs. a transferred Float32Array) and neither
 * concern belongs in here.
 */
export type SampleResolver = (projectRelativePath: string) => SampleData;

export interface DrumkitConfiguration {
  /** Kit order, which is the order the mix sums voices in. */
  voiceNames: readonly string[];
  settings: Record<string, DrumVoiceSettings>;
  /** Automatable per-voice values, keyed as `<voice>.<param>`. */
  staticValues: Record<string, number>;
}

export function synthSettings(instrument: SynthInstrumentDoc): SynthSettings {
  const params = instrument.params ?? {};
  const table = instrument.engine === "basic-mono" ? BASIC_MONO_PARAMS : BASIC_POLY_PARAMS;
  return {
    oscillator: enumParam(params, "oscillator", table.oscillator!.default) as SynthSettings["oscillator"],
    detune: numericSynthParam(params, "detune", table),
    filterType: enumParam(params, "filter.type", table["filter.type"]!.default) as SynthSettings["filterType"],
    filterCutoff: numericSynthParam(params, "filter.cutoff", table),
    filterResonance: numericSynthParam(params, "filter.resonance", table),
    filterEnvAmount: numericSynthParam(params, "filterEnv.amount", table),
    attackMs: numericSynthParam(params, "amp.attack", table),
    decayMs: numericSynthParam(params, "amp.decay", table),
    sustainPermille: numericSynthParam(params, "amp.sustain", table),
    releaseMs: numericSynthParam(params, "amp.release", table),
    gainDb100: numericSynthParam(params, "gain", table),
    panPermille: numericSynthParam(params, "pan", table),
    portamentoMs: instrument.engine === "basic-mono" ? numericSynthParam(params, "portamento", table) : 0,
    maxVoices: instrument.engine === "basic-poly" ? numericSynthParam(params, "maxVoices", table) : 1,
  };
}

export function synthAutomationValues(settings: SynthSettings): Record<string, number> {
  return {
    detune: settings.detune,
    "filter.cutoff": settings.filterCutoff,
    "filter.resonance": settings.filterResonance,
    "filterEnv.amount": settings.filterEnvAmount,
    gain: settings.gainDb100,
    pan: settings.panPermille,
  };
}

export function drumkitConfiguration(
  instrument: DrumkitInstrumentDoc,
  resolveSample: SampleResolver,
): DrumkitConfiguration {
  const settings: Record<string, DrumVoiceSettings> = {};
  const staticValues: Record<string, number> = {};
  const voiceNames: string[] = [];
  const params = instrument.params ?? {};
  for (const [voice, kitVoice] of Object.entries(instrument.kit)) {
    voiceNames.push(voice);
    const voiceSettings: DrumVoiceSettings = {
      sample: resolveSample(kitVoice.sample),
      gainDb100: numericParam(params, `${voice}.gain`, "gain"),
      panPermille: numericParam(params, `${voice}.pan`, "pan"),
      pitchCents: numericParam(params, `${voice}.pitch`, "pitch"),
      chokeGroup: numericParam(params, `${voice}.chokeGroup`, "chokeGroup"),
    };
    settings[voice] = voiceSettings;
    staticValues[`${voice}.gain`] = voiceSettings.gainDb100;
    staticValues[`${voice}.pan`] = voiceSettings.panPermille;
  }
  return { voiceNames, settings, staticValues };
}

function numericSynthParam(
  params: Readonly<Record<string, number | string>>,
  key: string,
  table: typeof BASIC_MONO_PARAMS,
): number {
  const value = params[key] ?? table[key]?.default;
  if (typeof value !== "number") throw new Error(`cannot configure synth: param "${key}" is not numeric`);
  return value;
}

function numericParam(
  params: Readonly<Record<string, number | string>>,
  key: string,
  registryKey: keyof typeof DRUMKIT_VOICE_PARAMS,
): number {
  const value = params[key] ?? DRUMKIT_VOICE_PARAMS[registryKey]?.default;
  if (typeof value !== "number") throw new Error(`cannot configure drumkit: param "${key}" is not numeric`);
  return value;
}

function enumParam(
  params: Readonly<Record<string, number | string>>,
  key: string,
  fallback: number | string,
): string {
  const value = params[key] ?? fallback;
  if (typeof value !== "string") throw new Error(`cannot configure synth: param "${key}" is not an enum`);
  return value;
}
