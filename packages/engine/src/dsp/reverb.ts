import { rampValue, type ParamRamps } from "./control.js";
import { flushToZero } from "./silence.js";
import { permilleToUnit } from "./units.js";

export interface ReverbSettings {
  /** permille 0..1000, as persisted. */
  sizePermille: number;
  /** permille 0..1000, as persisted. */
  dampingPermille: number;
  /** permille 0..1000, as persisted. */
  widthPermille: number;
  /** permille 0..1000, as persisted. */
  mixPermille: number;
}

/**
 * Comb and allpass lengths in samples at 44 100 Hz, and the right channel's
 * offset from them (Schroeder/Moorer topology as popularised by Freeverb). The
 * numbers are mutually prime on purpose: shared factors make the comb resonances
 * line up and the tail ring on a pitch.
 *
 * They are scaled to the render's actual rate, so the room is the same size at
 * 44.1 and 48 kHz rather than 8% smaller at the higher one.
 */
const COMB_LENGTHS_44100 = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617] as const;
const ALLPASS_LENGTHS_44100 = [556, 441, 341, 225] as const;
const STEREO_SPREAD_44100 = 23;
const REFERENCE_RATE = 44_100;

/**
 * `size` maps onto comb recirculation gain over this range, and the maximum is
 * strictly below 1. That inequality *is* the stability guarantee: no value the
 * registry admits can make the tail grow, so bounded output is a property of the
 * mapping rather than something a limiter has to rescue. 0.98 per circulation over
 * a ~27 ms comb is roughly a nine-second RT60, which is as large a room as this is
 * meant to be.
 */
const MIN_FEEDBACK = 0.7;
const FEEDBACK_RANGE = 0.28;

/** Fraction of a comb's own output its damping lowpass may hold back at maximum. */
const MAX_DAMPING = 0.4;

/**
 * Input trim before the tank. The eight parallel combs each contribute roughly a
 * full-scale recirculating signal, so feeding them unattenuated would put the wet
 * bus tens of dB above the dry one and make `mix` unusable below its first
 * percent. This is the wet path's own gain staging, not hidden makeup gain on the
 * mix: PLAN.md §6.3 forbids the engine quietly correcting the *author's* levels,
 * and says nothing about an effect's internals being scaled so its one exposed
 * control means what it says.
 */
const INPUT_TRIM = 0.015;

/** Wet-bus gain, so `mix: 1000` is comparable in level to `mix: 0`. */
const WET_GAIN = 3;

class LowpassComb {
  private readonly buffer: Float32Array;
  private index = 0;
  private store = 0;

  constructor(length: number) {
    this.buffer = new Float32Array(length);
  }

  get length(): number {
    return this.buffer.length;
  }

  process(input: number, feedback: number, damping: number): number {
    const output = this.buffer[this.index]!;
    this.store = flushToZero(output * (1 - damping) + this.store * damping);
    this.buffer[this.index] = flushToZero(input + this.store * feedback);
    this.index = this.index + 1 === this.buffer.length ? 0 : this.index + 1;
    return output;
  }

  reset(): void {
    this.buffer.fill(0);
    this.index = 0;
    this.store = 0;
  }
}

/** Fixed at 0.5: this allpass diffuses, it is not a decay control. */
const ALLPASS_FEEDBACK = 0.5;

class Allpass {
  private readonly buffer: Float32Array;
  private index = 0;

  constructor(length: number) {
    this.buffer = new Float32Array(length);
  }

  get length(): number {
    return this.buffer.length;
  }

  process(input: number): number {
    const buffered = this.buffer[this.index]!;
    this.buffer[this.index] = flushToZero(input + buffered * ALLPASS_FEEDBACK);
    this.index = this.index + 1 === this.buffer.length ? 0 : this.index + 1;
    return buffered - input;
  }

  reset(): void {
    this.buffer.fill(0);
    this.index = 0;
  }
}

class ReverbChannel {
  readonly combs: LowpassComb[];
  readonly allpasses: Allpass[];

  constructor(sampleRate: number, spread: number) {
    const scale = sampleRate / REFERENCE_RATE;
    // At least one sample per line, so a pathologically low sample rate cannot
    // produce a zero-length buffer and a division by zero downstream.
    const scaled = (length: number): number => Math.max(1, Math.round(length * scale) + spread);
    this.combs = COMB_LENGTHS_44100.map((length) => new LowpassComb(scaled(length)));
    this.allpasses = ALLPASS_LENGTHS_44100.map((length) => new Allpass(scaled(length)));
  }

  process(input: number, feedback: number, damping: number): number {
    let value = 0;
    for (const comb of this.combs) value += comb.process(input, feedback, damping);
    for (const allpass of this.allpasses) value = allpass.process(value);
    return value;
  }

  reset(): void {
    for (const comb of this.combs) comb.reset();
    for (const allpass of this.allpasses) allpass.reset();
  }

  /** Longest single line, which bounds how long a flushed tail takes to clear. */
  get longestLine(): number {
    let longest = 0;
    for (const comb of this.combs) longest = Math.max(longest, comb.length);
    for (const allpass of this.allpasses) longest = Math.max(longest, allpass.length);
    return longest;
  }
}

/**
 * Stereo algorithmic reverb: eight damped parallel combs into four series
 * allpasses per channel, with the right channel's lines offset so the two are
 * decorrelated.
 *
 * Every operation is a multiply or an add — no transcendental functions anywhere —
 * which matters beyond speed: PLAN.md §14 records that JavaScript's `Math.sin`
 * and friends are implementation-defined, so a structure built only from
 * multiplies and adds is one whose output a future port can be held to
 * bit-identically.
 */
export class ReverbEffect {
  private readonly left: ReverbChannel;
  private readonly right: ReverbChannel;
  private readonly sizeKey: string;
  private readonly dampingKey: string;
  private readonly widthKey: string;
  private readonly mixKey: string;

  constructor(
    id: string,
    sampleRate: number,
    readonly settings: ReverbSettings,
  ) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error(`cannot create reverb "${id}": sampleRate ${sampleRate} must be a positive integer`);
    }
    const spread = Math.round((STEREO_SPREAD_44100 * sampleRate) / REFERENCE_RATE);
    this.left = new ReverbChannel(sampleRate, 0);
    this.right = new ReverbChannel(sampleRate, spread);
    this.sizeKey = `fx.${id}.size`;
    this.dampingKey = `fx.${id}.damping`;
    this.widthKey = `fx.${id}.width`;
    this.mixKey = `fx.${id}.mix`;
  }

  /** Longest internal line across both channels, in samples. */
  get longestLine(): number {
    return Math.max(this.left.longestLine, this.right.longestLine);
  }

  processBlock(left: Float32Array, right: Float32Array, length: number, ramps: ParamRamps): void {
    for (let index = 0; index < length; index++) {
      const size = permilleToUnit(rampValue(ramps[this.sizeKey], this.settings.sizePermille, index, length));
      const damp = permilleToUnit(rampValue(ramps[this.dampingKey], this.settings.dampingPermille, index, length));
      const width = permilleToUnit(rampValue(ramps[this.widthKey], this.settings.widthPermille, index, length));
      const mix = permilleToUnit(rampValue(ramps[this.mixKey], this.settings.mixPermille, index, length));
      const feedback = MIN_FEEDBACK + FEEDBACK_RANGE * size;
      const damping = MAX_DAMPING * damp;

      const dryLeft = left[index]!;
      const dryRight = right[index]!;
      // Both channels are fed the mono sum: a reverb's job is to place a source in
      // one room, and two independent rooms fed one side each would widen the
      // source instead of placing it. `width` is what decides how wide the room's
      // answer is.
      const input = (dryLeft + dryRight) * INPUT_TRIM;
      const wetLeft = this.left.process(input, feedback, damping);
      const wetRight = this.right.process(input, feedback, damping);

      const direct = WET_GAIN * mix * (width / 2 + 0.5);
      const crossed = WET_GAIN * mix * ((1 - width) / 2);
      const dryGain = 1 - mix;
      left[index] = dryLeft * dryGain + wetLeft * direct + wetRight * crossed;
      right[index] = dryRight * dryGain + wetRight * direct + wetLeft * crossed;
    }
  }

  reset(): void {
    this.left.reset();
    this.right.reset();
  }
}
