import { rampValue, type ParamRamps } from "./control.js";
import { flushToZero } from "./silence.js";
import { permilleToUnit } from "./units.js";

export interface DelaySettings {
  /** ms 1..2000, as persisted. */
  timeMs: number;
  /** permille 0..950, as persisted. */
  feedbackPermille: number;
  /** permille 0..1000, as persisted. */
  dampingPermille: number;
  /** permille 0..1000, as persisted. */
  mixPermille: number;
}

/** The longest delay the registry admits, which is what the line is sized for. */
export const MAX_DELAY_MS = 2000;

/**
 * At maximum `damping` the feedback path keeps this much of each sample's change,
 * i.e. the one-pole is still open rather than shut. A coefficient of exactly zero
 * would freeze the filter's state and kill the feedback path outright, which would
 * make "maximum damping" mean "no repeats" — a control that stops doing its job at
 * one end of its range. 0.05 at 48 kHz is a corner around 390 Hz: as dark as any
 * musical use wants, and still unmistakably a delay.
 */
const MIN_DAMPING_COEFFICIENT = 0.05;

/**
 * Stereo feedback delay with a damped feedback path.
 *
 * The line is allocated for `MAX_DELAY_MS` once, at construction, and `time`
 * chooses a read offset within it. That is why every delay param is a
 * next-block-effective parameter change rather than a graph rebuild: nothing here
 * is sized by a param value, so nothing has to be rebuilt to change one, and the
 * audio thread never allocates.
 *
 * The two channels are independent lines with no cross-feed. A ping-pong is a
 * different effect, not a setting of this one, and adding a cross-feed param would
 * make the stereo image a function of a number rather than a property of the
 * input.
 */
export class DelayEffect {
  private readonly bufferLeft: Float32Array;
  private readonly bufferRight: Float32Array;
  private writeIndex = 0;
  private lowpassLeft = 0;
  private lowpassRight = 0;
  /** Ramp keys, built once: the audio thread must not concatenate strings. */
  private readonly feedbackKey: string;
  private readonly dampingKey: string;
  private readonly mixKey: string;

  constructor(
    id: string,
    private readonly sampleRate: number,
    readonly settings: DelaySettings,
  ) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error(`cannot create delay "${id}": sampleRate ${sampleRate} must be a positive integer`);
    }
    // One sample of slack so the maximum offset can be read without the write and
    // read positions colliding.
    const length = Math.ceil((MAX_DELAY_MS * sampleRate) / 1000) + 1;
    this.bufferLeft = new Float32Array(length);
    this.bufferRight = new Float32Array(length);
    this.feedbackKey = `fx.${id}.feedback`;
    this.dampingKey = `fx.${id}.damping`;
    this.mixKey = `fx.${id}.mix`;
  }

  /** Samples the line holds; the flush must clear all of them to end a tail. */
  get lineSamples(): number {
    return this.bufferLeft.length;
  }

  processBlock(left: Float32Array, right: Float32Array, length: number, ramps: ParamRamps): void {
    const lineLength = this.bufferLeft.length;
    // `time` is not automatable, so the offset is fixed for the block. Clamped
    // rather than trusted: the registry's range is the guarantee, this is the
    // proof that a value outside it cannot index outside the line.
    const offset = Math.min(
      Math.max(Math.round((this.settings.timeMs * this.sampleRate) / 1000), 1),
      lineLength - 1,
    );

    for (let index = 0; index < length; index++) {
      const feedback = permilleToUnit(rampValue(ramps[this.feedbackKey], this.settings.feedbackPermille, index, length));
      const damping = permilleToUnit(rampValue(ramps[this.dampingKey], this.settings.dampingPermille, index, length));
      const mix = permilleToUnit(rampValue(ramps[this.mixKey], this.settings.mixPermille, index, length));
      const coefficient = 1 - (1 - MIN_DAMPING_COEFFICIENT) * damping;
      const readIndex = (this.writeIndex + lineLength - offset) % lineLength;

      const dryLeft = left[index]!;
      const wetLeft = this.bufferLeft[readIndex]!;
      this.lowpassLeft = flushToZero(this.lowpassLeft + coefficient * (wetLeft - this.lowpassLeft));
      this.bufferLeft[this.writeIndex] = flushToZero(dryLeft + this.lowpassLeft * feedback);
      left[index] = dryLeft * (1 - mix) + wetLeft * mix;

      const dryRight = right[index]!;
      const wetRight = this.bufferRight[readIndex]!;
      this.lowpassRight = flushToZero(this.lowpassRight + coefficient * (wetRight - this.lowpassRight));
      this.bufferRight[this.writeIndex] = flushToZero(dryRight + this.lowpassRight * feedback);
      right[index] = dryRight * (1 - mix) + wetRight * mix;

      this.writeIndex = this.writeIndex + 1 === lineLength ? 0 : this.writeIndex + 1;
    }
  }

  reset(): void {
    this.bufferLeft.fill(0);
    this.bufferRight.fill(0);
    this.writeIndex = 0;
    this.lowpassLeft = 0;
    this.lowpassRight = 0;
  }
}
