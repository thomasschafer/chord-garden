import { describe, expect, it } from "vitest";
import {
  AdsrEnvelope,
  BasicMonoProcessor,
  BasicPolyProcessor,
  BiquadFilter,
  Oscillator,
  type NoteCommand,
  type SynthSettings,
} from "../src/index.js";

const SAMPLE_RATE = 48_000;

function settings(overrides: Partial<SynthSettings> = {}): SynthSettings {
  return {
    oscillator: "sine",
    detune: 0,
    filterType: "lowpass",
    filterCutoff: 20_000,
    filterResonance: 0,
    filterEnvAmount: 0,
    attackMs: 5,
    decayMs: 0,
    sustainPermille: 1000,
    releaseMs: 5,
    gainDb100: 0,
    panPermille: 0,
    portamentoMs: 0,
    maxVoices: 8,
    ...overrides,
  };
}

function rms(values: Float32Array): number {
  let energy = 0;
  for (const value of values) energy += value * value;
  return Math.sqrt(energy / values.length);
}

function oscillatorSpectrum(shape: "sawtooth" | "square"): Float64Array {
  const size = 4096;
  const oscillator = new Oscillator();
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  const frequency = (SAMPLE_RATE * 427) / size;
  for (let index = 0; index < size; index++) real[index] = oscillator.next(shape, frequency, SAMPLE_RATE);
  fft(real, imag);
  return real.map((value, index) => value * value + imag[index]! * imag[index]!);
}

describe("oscillators", () => {
  it("keeps high-frequency saw alias energy far below the fundamental", () => {
    const spectrum = oscillatorSpectrum("sawtooth");
    const fundamentalBin = 427;
    const fundamental = spectrum[fundamentalBin]!;
    let aliasEnergy = 0;
    for (let bin = 1; bin < spectrum.length / 2; bin++) {
      const harmonic = bin / fundamentalBin;
      const isExpectedHarmonic = Number.isInteger(harmonic) && harmonic <= 4;
      if (!isExpectedHarmonic) aliasEnergy += spectrum[bin]!;
    }
    expect(aliasEnergy / fundamental).toBeLessThan(0.015);
  });

  it("produces finite samples for every shape", () => {
    for (const shape of ["sine", "triangle", "sawtooth", "square"] as const) {
      const oscillator = new Oscillator();
      for (let index = 0; index < 10_000; index++) {
        expect(Number.isFinite(oscillator.next(shape, 17_000, SAMPLE_RATE))).toBe(true);
      }
    }
  });
});

describe("filter", () => {
  it("stays finite and bounded at maximum resonance through a 20 Hz to 20 kHz sweep", () => {
    const filter = new BiquadFilter(SAMPLE_RATE);
    let peak = 0;
    for (let sample = 0; sample < SAMPLE_RATE; sample++) {
      const cutoff = 20 * (1000 ** (sample / (SAMPLE_RATE - 1)));
      filter.setParameters("lowpass", cutoff, 1000);
      const output = filter.process(sample === 0 ? 1 : Math.sin((2 * Math.PI * 997 * sample) / SAMPLE_RATE) * 0.1);
      expect(Number.isFinite(output)).toBe(true);
      peak = Math.max(peak, Math.abs(output));
    }
    expect(peak).toBeLessThan(20);
  });
});

describe("ADSR", () => {
  it("lands segment timings within one control block and releases to exact zero", () => {
    const envelope = new AdsrEnvelope(SAMPLE_RATE, {
      attackMs: 10,
      decayMs: 20,
      sustainPermille: 400,
      releaseMs: 30,
    });
    envelope.noteOn();
    for (let sample = 0; sample < 480; sample++) envelope.next();
    expect(envelope.getLevel()).toBeCloseTo(1, 10);
    for (let sample = 0; sample < 960; sample++) envelope.next();
    expect(envelope.getLevel()).toBeCloseTo(0.4, 10);
    envelope.noteOff();
    for (let sample = 0; sample < 1440; sample++) envelope.next();
    expect(envelope.getLevel()).toBe(0);
    expect(envelope.isIdle()).toBe(true);
  });

  it("has no large note-on or note-off discontinuity", () => {
    const processor = new BasicMonoProcessor(SAMPLE_RATE, settings({ attackMs: 10, releaseMs: 10 }));
    const length = 2000;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    processor.processBlock(left, right, length, [
      { offset: 0, kind: "on", noteId: 1, midi: 69, velocity: 1000 },
      { offset: 1000, kind: "off", noteId: 1, midi: 69, velocity: 1000 },
    ], {});
    let maxJump = 0;
    for (let sample = 1; sample < length; sample++) {
      maxJump = Math.max(maxJump, Math.abs(left[sample]! - left[sample - 1]!));
    }
    expect(maxJump).toBeLessThan(0.09);
  });
});

describe("voice behavior", () => {
  it("makes velocity zero silent and velocity monotonic in RMS amplitude", () => {
    const amplitudes = [0, 250, 500, 1000].map((velocity) => {
      const processor = new BasicMonoProcessor(SAMPLE_RATE, settings());
      const left = new Float32Array(2400);
      const right = new Float32Array(2400);
      processor.processBlock(left, right, left.length, [
        { offset: 0, kind: "on", noteId: 0, midi: 69, velocity },
      ], {});
      return rms(left.subarray(1000));
    });
    expect(amplitudes[0]).toBe(0);
    expect(amplitudes[1]).toBeLessThan(amplitudes[2]!);
    expect(amplitudes[2]).toBeLessThan(amplitudes[3]!);
  });

  it("uses hard endpoints and an equal-power centre pan", () => {
    const renderPan = (panPermille: number): [number, number] => {
      const processor = new BasicMonoProcessor(SAMPLE_RATE, settings({ panPermille }));
      const left = new Float32Array(2400);
      const right = new Float32Array(2400);
      processor.processBlock(left, right, left.length, [
        { offset: 0, kind: "on", noteId: 0, midi: 69, velocity: 1000 },
      ], {});
      return [rms(left.subarray(1000)), rms(right.subarray(1000))];
    };
    const hardLeft = renderPan(-1000);
    const center = renderPan(0);
    const hardRight = renderPan(1000);
    expect(hardLeft[1]).toBe(0);
    expect(hardRight[0]).toBe(0);
    expect(center[0]).toBeCloseTo(center[1], 7);
    expect(center[0]).toBeCloseTo(hardLeft[0] * Math.SQRT1_2, 5);
  });

  it("caps polyphony and steals the oldest released voice before the oldest sounding voice", () => {
    const processor = new BasicPolyProcessor(SAMPLE_RATE, settings({ maxVoices: 2, releaseMs: 100 }));
    const left = new Float32Array(4);
    const right = new Float32Array(4);
    const commands: NoteCommand[] = [
      { offset: 0, kind: "on", noteId: 0, midi: 60, velocity: 1000 },
      { offset: 1, kind: "on", noteId: 1, midi: 64, velocity: 1000 },
      { offset: 2, kind: "off", noteId: 1, midi: 64, velocity: 1000 },
      { offset: 3, kind: "on", noteId: 2, midi: 67, velocity: 1000 },
    ];
    processor.processBlock(left, right, left.length, commands, {});
    expect(processor.getVoiceCount()).toBe(2);
    expect(processor.getActiveNoteIds().sort()).toEqual([0, 2]);
    processor.processBlock(left.subarray(0, 1), right.subarray(0, 1), 1, [
      { offset: 0, kind: "on", noteId: 3, midi: 71, velocity: 1000 },
    ], {});
    expect(processor.getActiveNoteIds().sort()).toEqual([2, 3]);
  });

  it("glides mono pitch through intermediate frequencies", () => {
    const processor = new BasicMonoProcessor(1000, settings({ portamentoMs: 100 }));
    const left = new Float32Array(1);
    const right = new Float32Array(1);
    processor.processBlock(left, right, 1, [
      { offset: 0, kind: "on", noteId: 0, midi: 60, velocity: 1000 },
    ], {});
    const low = processor.getCurrentFrequency();
    processor.processBlock(left, right, 1, [
      { offset: 0, kind: "on", noteId: 1, midi: 72, velocity: 1000 },
    ], {});
    const firstGlideSample = processor.getCurrentFrequency();
    for (let sample = 0; sample < 49; sample++) processor.processBlock(left, right, 1, [], {});
    const midpoint = processor.getCurrentFrequency();
    expect(firstGlideSample).toBeGreaterThan(low);
    expect(firstGlideSample).toBeLessThan(low * 2);
    expect(midpoint).toBeGreaterThan(firstGlideSample);
    expect(midpoint).toBeLessThan(low * 2);
  });
});

function fft(real: Float64Array, imag: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    for (; (reversed & bit) !== 0; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed]!, real[index]!];
      [imag[index], imag[reversed]] = [imag[reversed]!, imag[index]!];
    }
  }
  for (let width = 2; width <= size; width <<= 1) {
    const angle = (-2 * Math.PI) / width;
    for (let start = 0; start < size; start += width) {
      for (let offset = 0; offset < width / 2; offset++) {
        const cosine = Math.cos(angle * offset);
        const sine = Math.sin(angle * offset);
        const even = start + offset;
        const odd = even + width / 2;
        const oddReal = real[odd]! * cosine - imag[odd]! * sine;
        const oddImag = real[odd]! * sine + imag[odd]! * cosine;
        real[odd] = real[even]! - oddReal;
        imag[odd] = imag[even]! - oddImag;
        real[even] = real[even]! + oddReal;
        imag[even] = imag[even]! + oddImag;
      }
    }
  }
}
