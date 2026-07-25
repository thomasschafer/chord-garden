import { msToSamples, permilleToUnit } from "./units.js";

export type EnvelopeStage = "idle" | "attack" | "decay" | "sustain" | "release";

export interface EnvelopeSettings {
  attackMs: number;
  decayMs: number;
  sustainPermille: number;
  releaseMs: number;
}

export class AdsrEnvelope {
  private stage: EnvelopeStage = "idle";
  private level = 0;
  private target = 0;
  private samplesRemaining = 0;
  private increment = 0;

  constructor(
    private readonly sampleRate: number,
    private settings: EnvelopeSettings,
  ) {}

  setSettings(settings: EnvelopeSettings): void {
    this.settings = settings;
  }

  noteOn(): void {
    const attackSamples = msToSamples(this.settings.attackMs, this.sampleRate);
    if (attackSamples === 0) {
      this.level = 1;
      this.beginDecay();
      return;
    }
    // A reused voice attacks from its current level, avoiding a hard reset.
    this.beginSegment("attack", 1, attackSamples);
  }

  noteOff(): void {
    if (this.level === 0) {
      this.finish();
      return;
    }
    const releaseSamples = msToSamples(this.settings.releaseMs, this.sampleRate);
    if (releaseSamples === 0) {
      this.finish();
      return;
    }
    this.beginSegment("release", 0, releaseSamples);
  }

  next(): number {
    const output = this.level;
    if (this.stage === "idle" || this.stage === "sustain") return output;

    this.level += this.increment;
    this.samplesRemaining--;
    if (this.samplesRemaining <= 0) {
      this.level = this.target;
      if (this.stage === "attack") this.beginDecay();
      else if (this.stage === "decay") this.stage = "sustain";
      else if (this.stage === "release") this.finish();
    }
    return output;
  }

  getLevel(): number {
    return this.level;
  }

  getStage(): EnvelopeStage {
    return this.stage;
  }

  isIdle(): boolean {
    return this.stage === "idle";
  }

  /** Return to silence immediately, with no release stage. */
  reset(): void {
    this.finish();
  }

  private beginDecay(): void {
    const sustain = permilleToUnit(this.settings.sustainPermille);
    const decaySamples = msToSamples(this.settings.decayMs, this.sampleRate);
    if (decaySamples === 0) {
      this.level = sustain;
      this.stage = "sustain";
      return;
    }
    this.beginSegment("decay", sustain, decaySamples);
  }

  private beginSegment(stage: EnvelopeStage, target: number, samples: number): void {
    this.stage = stage;
    this.target = target;
    this.samplesRemaining = samples;
    this.increment = (target - this.level) / samples;
  }

  private finish(): void {
    // Snap exactly to zero so no denormal tail can keep a voice alive.
    this.level = 0;
    this.target = 0;
    this.increment = 0;
    this.samplesRemaining = 0;
    this.stage = "idle";
  }
}
