export type OscillatorShape = "sine" | "triangle" | "sawtooth" | "square";

export class Oscillator {
  private phase = 0;

  resetPhase(phase = 0): void {
    this.phase = phase - Math.floor(phase);
  }

  getPhase(): number {
    return this.phase;
  }

  next(shape: OscillatorShape, frequency: number, sampleRate: number): number {
    const increment = Math.min(Math.max(frequency / sampleRate, 0), 0.5);
    const phase = this.phase;
    let value: number;

    switch (shape) {
      case "sine":
        value = Math.sin(2 * Math.PI * phase);
        break;
      case "triangle":
        value = 1 - 4 * Math.abs(phase - 0.5);
        break;
      case "sawtooth":
        value = 2 * phase - 1 - polyBlep(phase, increment);
        break;
      case "square":
        value =
          (phase < 0.5 ? 1 : -1) +
          polyBlep(phase, increment) -
          polyBlep((phase + 0.5) % 1, increment);
        break;
    }

    this.phase = phase + increment;
    if (this.phase >= 1) this.phase -= 1;
    return value;
  }
}

function polyBlep(phase: number, phaseIncrement: number): number {
  if (phaseIncrement <= 0) return 0;
  if (phase < phaseIncrement) {
    const position = phase / phaseIncrement;
    return position + position - position * position - 1;
  }
  if (phase > 1 - phaseIncrement) {
    const position = (phase - 1) / phaseIncrement;
    return position * position + position + position + 1;
  }
  return 0;
}
