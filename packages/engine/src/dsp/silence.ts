/**
 * The level below which a recursive state is written as exactly zero.
 *
 * This is the guard that makes a tail *end*. Every effect here recirculates its
 * own output through a gain strictly below unity, so its impulse response decays
 * geometrically and, in exact arithmetic, never reaches zero: the level halves
 * forever. Left alone that means a delay line still holds nonzero samples minutes
 * after the last note, a rendered buffer never measures as silent, and any
 * "has this stopped?" question can only ever be answered "not yet".
 *
 * JavaScript is not where the classic denormal *performance* cliff bites — V8's
 * doubles do not stall the way a C float pipeline does — so the cost here is
 * correctness, not speed. It would become a speed problem too the day the hot
 * paths move to Rust/WASM (PLAN.md §14), and the flush belongs in the shared core
 * either way rather than in whichever port notices first.
 *
 * 1e-9 is −180 dBFS: about thirty times below a 24-bit LSB (6e-8, the render's
 * output resolution per docs/format-spec.md §8) and far below float32's useful
 * resolution near a signal. So nothing that survives this flush was ever going to
 * appear in a rendered file, and nothing audible is truncated by it.
 */
export const SILENCE_FLOOR = 1e-9;

/**
 * `value`, or exactly zero when it is too small to matter.
 *
 * Also the single place a non-finite state is caught: a NaN or an infinity in a
 * feedback path would otherwise propagate through every later sample and every
 * later effect, turning one bad number into a silent, permanent hole in the
 * render. Returning zero stops it at the sample it appeared on. Neither this nor
 * the floor can be reached by any value the registry admits — the ranges are what
 * guarantee that (see `DELAY_PARAMS`, `REVERB_PARAMS`) — so this is the guard
 * that proves the guarantee rather than the one the design relies on.
 */
export function flushToZero(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > -SILENCE_FLOOR && value < SILENCE_FLOOR ? 0 : value;
}
