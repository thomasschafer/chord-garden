// The registry is imported from its own module for the same reason
// `instrumentSettings.ts` does it: the package root re-exports `loadProject`,
// which reaches `node:fs`.
import { resolveEffectParam, resolveParam } from "@chord-garden/format/registry";
import type { EffectDoc, InstrumentDoc } from "@chord-garden/format";

/**
 * What changing one instrument param means to a running transport
 * (PLAN.md §12 step 6), as the DSP is actually built.
 *
 * This is an engine fact, not a format fact, which is why it lives here and not
 * as a column in the parameter registry. Every param in the registry is a value
 * the renderer reads; what differs is *when* — most are read per block, so a new
 * value is heard in the next one, while a few are read once when a voice pool or
 * a processor is constructed and cannot change without building a new one. An
 * agent editing a project file never needs to know which is which (both are just
 * a number in a file), so publishing it in `docs/format-spec.md` §6 would add a
 * column that means nothing on disk.
 *
 * Getting it wrong in the optimistic direction is loud rather than silent:
 * `SynthTrackRunner.updateSettings` and `DrumkitTrackRunner.updateSettings`
 * throw when asked to change something they fixed at construction, and the error
 * reaches the app as a failed transport. `test/paramEffect.test.ts` walks every
 * param of every engine through `updateSettings` and asserts this function's
 * answer matches what actually happened, so the two cannot drift.
 */
export type ParamEditEffect = "parameters" | "structural";

/**
 * Params the DSP reads once, when it constructs the thing that plays a note.
 *
 * `maxVoices` sizes `basic-poly`'s voice pool in its constructor, so a change
 * means a new processor — and therefore a new graph, at a bar boundary. Keyed by
 * the unqualified param name, so a future per-voice drumkit param of the same
 * kind is covered without a second rule.
 */
const FIXED_AT_CONSTRUCTION: readonly string[] = ["maxVoices"];

/** Whether a new value for `key` can be pushed in place, or needs a new graph. */
export function paramEditEffect(instrument: InstrumentDoc, key: string): ParamEditEffect {
  const resolved = resolveParam(instrument, key);
  if (resolved === undefined) {
    throw new Error(`cannot classify param "${key}": instrument "${instrument.id}" has no such param`);
  }
  const name = resolved.voice === undefined ? key : key.slice(resolved.voice.length + 1);
  return FIXED_AT_CONSTRUCTION.includes(name) ? "structural" : "parameters";
}

/**
 * Whether an effect *param* edit can be pushed in place. It always can.
 *
 * Nothing in an effect is sized by a param value: the delay line is allocated for
 * the registry's maximum `time` and `time` picks a read offset inside it, the
 * reverb's lines are fixed by its topology and `size` is a feedback coefficient,
 * and the filter's coefficients are recomputed per block. So no effect param can
 * require a new processor, and this function exists to say so in one place rather
 * than have callers assume it — the day one does need rebuilding, this is where it
 * gets a name and `effectParamEffect.test.ts` is what proves the answer against
 * what `updateSettings` actually accepts.
 *
 * Throws for a key the effect does not have, so a typo cannot be silently
 * classified as harmless.
 */
export function effectParamEditEffect(effect: EffectDoc, param: string): ParamEditEffect {
  if (resolveEffectParam(effect.type, param) === undefined) {
    throw new Error(`cannot classify param "${param}": a "${effect.type}" effect has no such param`);
  }
  return "parameters";
}

/**
 * What replacing a track's whole chain means to a running transport.
 *
 * `structural` exactly when the chain's *shape* changed — an effect added,
 * removed, reordered, or retyped.
 *
 * A reorder is the case worth stating twice over. It moves no event, so the
 * scheduler's own event comparison cannot catch one passed off as a parameter
 * change, and `EffectChain.updateSettings` refusing it is the only guard. And it is
 * `structural` even though a *static* chain of the three effects we ship is
 * inaudible when reordered: a delay, a reverb and a filter are each linear and
 * time-invariant while their params hold still, and an LTI cascade commutes, so the
 * order reaches nothing but float32 rounding (measured at 2e-6 of peak, and pinned
 * in `effects.test.ts`). It stops commuting the moment a param moves — a swept
 * filter is not time-invariant, and there the difference is larger than the signal —
 * and it would stop commuting outright the day a nonlinear effect joins the set. The
 * classification therefore follows what changed, the graph, rather than how much of
 * a difference it happens to make today.
 */
export function chainEditEffect(before: readonly EffectDoc[], after: readonly EffectDoc[]): ParamEditEffect {
  return shape(before) === shape(after) ? "parameters" : "structural";
}

function shape(effects: readonly EffectDoc[]): string {
  return effects.map((effect) => `${effect.id}:${effect.type}`).join(", ");
}
