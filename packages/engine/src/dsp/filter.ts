export type FilterType = "lowpass" | "highpass" | "bandpass";

export class BiquadFilter {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(private readonly sampleRate: number) {}

  setParameters(type: FilterType, cutoffHz: number, resonancePermille: number): void {
    const cutoff = Math.min(Math.max(cutoffHz, 20), this.sampleRate * 0.45);
    const resonance = Math.min(Math.max(resonancePermille / 1000, 0), 1);
    // Q=0.707 is maximally flat; Q=12 is self-oscillation-adjacent but stays
    // bounded in this RBJ biquad even at the registry's maximum resonance.
    const q = 0.7071067811865476 + resonance * (12 - 0.7071067811865476);
    const omega = (2 * Math.PI * cutoff) / this.sampleRate;
    const cosine = Math.cos(omega);
    const sine = Math.sin(omega);
    const alpha = sine / (2 * q);
    const a0 = 1 + alpha;

    switch (type) {
      case "lowpass":
        this.b0 = (1 - cosine) / 2 / a0;
        this.b1 = (1 - cosine) / a0;
        this.b2 = this.b0;
        break;
      case "highpass":
        this.b0 = (1 + cosine) / 2 / a0;
        this.b1 = -(1 + cosine) / a0;
        this.b2 = this.b0;
        break;
      case "bandpass":
        this.b0 = alpha / a0;
        this.b1 = 0;
        this.b2 = -this.b0;
        break;
    }
    this.a1 = (-2 * cosine) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(input: number): number {
    const output = this.b0 * input + this.z1;
    this.z1 = this.b1 * input - this.a1 * output + this.z2;
    this.z2 = this.b2 * input - this.a2 * output;
    if (!Number.isFinite(output)) {
      this.reset();
      return 0;
    }
    return output;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}
