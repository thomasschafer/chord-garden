// The registry is imported from its own subpath for the reason
// `instrumentSettings.ts` records: the package root reaches `node:fs`, and this
// file is in the AudioWorklet's import graph, where that cannot be bundled at all.
import { EFFECT_PARAMS, effectParamKey } from "@chord-garden/format/registry";
import type { EffectDoc } from "@chord-garden/format";
import type { EffectSpec, FilterEffectSettings } from "../dsp/effects.js";
import type { DelaySettings } from "../dsp/delay.js";
import type { ReverbSettings } from "../dsp/reverb.js";

/**
 * Effect document -> DSP settings, the effect-side twin of `synthSettings`.
 *
 * Shared by the offline renderer and the live worklet, so neither can drift into
 * its own reading of a param. Every value comes from the document or, where the
 * document is silent, from the registry's own default — there is no second table
 * of defaults here to fall out of step with the one `validate` checks against.
 */
export function effectChainSpecs(effects: readonly EffectDoc[] | undefined): EffectSpec[] {
  return (effects ?? []).map((effect): EffectSpec => {
    switch (effect.type) {
      case "delay":
        return { id: effect.id, type: "delay", settings: delaySettings(effect) };
      case "reverb":
        return { id: effect.id, type: "reverb", settings: reverbSettings(effect) };
      case "filter":
        return { id: effect.id, type: "filter", settings: filterSettings(effect) };
    }
  });
}

/**
 * Every automatable effect param's current value, keyed exactly as an automation
 * lane names it (`fx.<id>.<param>`).
 *
 * `AutomationRamps` is built from this map, so an effect param appears as a
 * ramped param on the track for free and a lane targeting it needs no new
 * machinery — the same route an instrument param takes through
 * `synthAutomationValues`.
 */
export function effectStaticValues(effects: readonly EffectDoc[] | undefined): Record<string, number> {
  const values: Record<string, number> = {};
  for (const effect of effects ?? []) {
    for (const [param, spec] of Object.entries(EFFECT_PARAMS[effect.type])) {
      if (!spec.automatable) continue;
      const value = effect.params?.[param] ?? spec.default;
      if (typeof value !== "number") {
        throw new Error(`cannot configure effect "${effect.id}": automatable param "${param}" is not numeric`);
      }
      values[effectParamKey(effect.id, param)] = value;
    }
  }
  return values;
}

function delaySettings(effect: EffectDoc): DelaySettings {
  return {
    timeMs: numeric(effect, "time"),
    feedbackPermille: numeric(effect, "feedback"),
    dampingPermille: numeric(effect, "damping"),
    mixPermille: numeric(effect, "mix"),
  };
}

function reverbSettings(effect: EffectDoc): ReverbSettings {
  return {
    sizePermille: numeric(effect, "size"),
    dampingPermille: numeric(effect, "damping"),
    widthPermille: numeric(effect, "width"),
    mixPermille: numeric(effect, "mix"),
  };
}

function filterSettings(effect: EffectDoc): FilterEffectSettings {
  return {
    mode: enumeration(effect, "mode") as FilterEffectSettings["mode"],
    cutoffHz: numeric(effect, "cutoff"),
    resonancePermille: numeric(effect, "resonance"),
  };
}

function raw(effect: EffectDoc, param: string): number | string {
  const spec = EFFECT_PARAMS[effect.type][param];
  if (spec === undefined) {
    throw new Error(`cannot configure effect "${effect.id}": "${effect.type}" has no param "${param}"`);
  }
  return effect.params?.[param] ?? spec.default;
}

function numeric(effect: EffectDoc, param: string): number {
  const value = raw(effect, param);
  if (typeof value !== "number") {
    throw new Error(`cannot configure effect "${effect.id}": param "${param}" is not numeric`);
  }
  return value;
}

function enumeration(effect: EffectDoc, param: string): string {
  const value = raw(effect, param);
  if (typeof value !== "string") {
    throw new Error(`cannot configure effect "${effect.id}": param "${param}" is not an enum`);
  }
  return value;
}
