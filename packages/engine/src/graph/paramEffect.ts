// The registry is imported from its own module for the same reason
// `instrumentSettings.ts` does it: the package root re-exports `loadProject`,
// which reaches `node:fs`.
import { resolveParam } from "@chord-garden/format/registry";
import type { InstrumentDoc } from "@chord-garden/format";

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
 * `SynthTrackRunner.updateInstrument` and `DrumkitTrackRunner.updateInstrument`
 * throw when asked to change something they fixed at construction, and the error
 * reaches the app as a failed transport. `test/paramEffect.test.ts` walks every
 * param of every engine through `updateInstrument` and asserts this function's
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
