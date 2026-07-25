import type { SynthEngine } from "@chord-garden/format";
import { rampValue, type ParamRamps } from "./control.js";
import { AdsrEnvelope } from "./envelope.js";
import { BiquadFilter, type FilterType } from "./filter.js";
import { Oscillator, type OscillatorShape } from "./oscillator.js";
import { centsToRatio, db100ToGain, midiToFrequency, msToSamples, panGains } from "./units.js";

export interface SynthSettings {
  oscillator: OscillatorShape;
  detune: number;
  filterType: FilterType;
  filterCutoff: number;
  filterResonance: number;
  filterEnvAmount: number;
  attackMs: number;
  decayMs: number;
  sustainPermille: number;
  releaseMs: number;
  gainDb100: number;
  panPermille: number;
  portamentoMs: number;
  maxVoices: number;
}

export interface NoteCommand {
  offset: number;
  kind: "on" | "off";
  noteId: number;
  midi: number;
  velocity: number;
}

export interface SynthProcessor {
  processBlock(
    left: Float32Array,
    right: Float32Array,
    length: number,
    commands: readonly NoteCommand[],
    ramps: ParamRamps,
  ): void;
  /**
   * Silence every voice at once, with no release stage. Used when the transport
   * jumps: a seek that let releases ring would leave the old position audible
   * over the new one.
   */
  reset(): void;
  activeVoiceCount(): number;
}

class SynthVoice {
  readonly envelope: AdsrEnvelope;
  readonly oscillator = new Oscillator();
  readonly filter: BiquadFilter;
  noteId = -1;
  midi = 60;
  velocityGain = 0;
  keyDown = false;
  startedOrder = -1;
  releasedOrder = -1;
  currentFrequency = midiToFrequency(60);
  private glideTarget = this.currentFrequency;
  private glideIncrement = 0;
  private glideSamplesRemaining = 0;

  constructor(
    private readonly sampleRate: number,
    settings: SynthSettings,
  ) {
    this.envelope = new AdsrEnvelope(sampleRate, {
      attackMs: settings.attackMs,
      decayMs: settings.decayMs,
      sustainPermille: settings.sustainPermille,
      releaseMs: settings.releaseMs,
    });
    this.filter = new BiquadFilter(sampleRate);
  }

  noteOn(command: NoteCommand, settings: SynthSettings, startedOrder: number, glide: boolean): void {
    this.noteId = command.noteId;
    this.midi = command.midi;
    // Linear-amplitude velocity is monotonic and makes velocity zero exactly silent.
    this.velocityGain = command.velocity / 1000;
    this.keyDown = true;
    this.startedOrder = startedOrder;
    this.releasedOrder = -1;
    this.envelope.setSettings({
      attackMs: settings.attackMs,
      decayMs: settings.decayMs,
      sustainPermille: settings.sustainPermille,
      releaseMs: settings.releaseMs,
    });

    this.glideTarget = midiToFrequency(command.midi);
    const glideSamples = glide ? msToSamples(settings.portamentoMs, this.sampleRate) : 0;
    if (glideSamples === 0 || this.startedOrder === 0) {
      this.currentFrequency = this.glideTarget;
      this.glideSamplesRemaining = 0;
      this.glideIncrement = 0;
    } else {
      this.glideSamplesRemaining = glideSamples;
      this.glideIncrement = (this.glideTarget - this.currentFrequency) / glideSamples;
    }
    this.envelope.noteOn();
  }

  noteOff(releasedOrder: number): void {
    this.keyDown = false;
    this.releasedOrder = releasedOrder;
    this.envelope.noteOff();
  }

  next(settings: SynthSettings, ramps: ParamRamps, index: number, length: number): number {
    const envelope = this.envelope.next();
    if (this.glideSamplesRemaining > 0) {
      this.currentFrequency += this.glideIncrement;
      this.glideSamplesRemaining--;
      if (this.glideSamplesRemaining === 0) this.currentFrequency = this.glideTarget;
    }

    const detune = rampValue(ramps.detune, settings.detune, index, length);
    const frequency = this.currentFrequency * centsToRatio(detune);
    const oscillator = this.oscillator.next(settings.oscillator, frequency, this.sampleRate);
    const baseCutoff = rampValue(ramps["filter.cutoff"], settings.filterCutoff, index, length);
    const envAmount = rampValue(ramps["filterEnv.amount"], settings.filterEnvAmount, index, length) / 1000;
    // Full filter-envelope amount opens the filter by four octaves.
    const cutoff = baseCutoff * 2 ** (4 * envAmount * envelope);
    const resonance = rampValue(ramps["filter.resonance"], settings.filterResonance, index, length);
    this.filter.setParameters(settings.filterType, cutoff, resonance);
    return this.filter.process(oscillator) * envelope * this.velocityGain;
  }

  isIdle(): boolean {
    return this.envelope.isIdle();
  }

  reset(): void {
    this.envelope.reset();
    this.filter.reset();
    this.oscillator.resetPhase();
    this.noteId = -1;
    this.keyDown = false;
    this.velocityGain = 0;
    this.startedOrder = -1;
    this.releasedOrder = -1;
    this.glideSamplesRemaining = 0;
    this.glideIncrement = 0;
  }
}

abstract class BaseSynthProcessor implements SynthProcessor {
  protected order = 0;

  constructor(
    protected readonly sampleRate: number,
    protected readonly settings: SynthSettings,
  ) {}

  abstract processBlock(
    left: Float32Array,
    right: Float32Array,
    length: number,
    commands: readonly NoteCommand[],
    ramps: ParamRamps,
  ): void;

  abstract reset(): void;

  abstract activeVoiceCount(): number;

  protected writeStereo(
    mono: number,
    left: Float32Array,
    right: Float32Array,
    index: number,
    length: number,
    ramps: ParamRamps,
  ): void {
    const gainDb100 = rampValue(ramps.gain, this.settings.gainDb100, index, length);
    const pan = rampValue(ramps.pan, this.settings.panPermille, index, length);
    const [leftPan, rightPan] = panGains(pan);
    const gain = db100ToGain(gainDb100);
    left[index] = mono * gain * leftPan;
    right[index] = mono * gain * rightPan;
  }
}

export class BasicMonoProcessor extends BaseSynthProcessor {
  private readonly voice: SynthVoice;

  constructor(sampleRate: number, settings: SynthSettings) {
    super(sampleRate, settings);
    this.voice = new SynthVoice(sampleRate, settings);
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    length: number,
    commands: readonly NoteCommand[],
    ramps: ParamRamps,
  ): void {
    let commandIndex = 0;
    for (let index = 0; index < length; index++) {
      while (commands[commandIndex]?.offset === index) {
        const command = commands[commandIndex]!;
        if (command.kind === "on") {
          this.voice.noteOn(command, this.settings, this.order++, true);
        } else if (this.voice.noteId === command.noteId) {
          this.voice.noteOff(this.order++);
        }
        commandIndex++;
      }
      this.writeStereo(this.voice.next(this.settings, ramps, index, length), left, right, index, length, ramps);
    }
  }

  getCurrentFrequency(): number {
    return this.voice.currentFrequency;
  }

  reset(): void {
    this.voice.reset();
    this.order = 0;
  }

  activeVoiceCount(): number {
    return this.voice.isIdle() ? 0 : 1;
  }
}

export class BasicPolyProcessor extends BaseSynthProcessor {
  private readonly voices: SynthVoice[];

  constructor(sampleRate: number, settings: SynthSettings) {
    super(sampleRate, settings);
    this.voices = Array.from({ length: settings.maxVoices }, () => new SynthVoice(sampleRate, settings));
  }

  processBlock(
    left: Float32Array,
    right: Float32Array,
    length: number,
    commands: readonly NoteCommand[],
    ramps: ParamRamps,
  ): void {
    let commandIndex = 0;
    for (let index = 0; index < length; index++) {
      while (commands[commandIndex]?.offset === index) {
        const command = commands[commandIndex]!;
        if (command.kind === "on") {
          this.allocateVoice().noteOn(command, this.settings, this.order++, false);
        } else {
          const voice = this.voices.find((candidate) => candidate.noteId === command.noteId && candidate.keyDown);
          voice?.noteOff(this.order++);
        }
        commandIndex++;
      }

      let mono = 0;
      for (const voice of this.voices) {
        if (!voice.isIdle()) mono += voice.next(this.settings, ramps, index, length);
      }
      this.writeStereo(mono, left, right, index, length, ramps);
    }
  }

  getVoiceCount(): number {
    return this.voices.length;
  }

  reset(): void {
    for (const voice of this.voices) voice.reset();
    this.order = 0;
  }

  activeVoiceCount(): number {
    let count = 0;
    for (const voice of this.voices) if (!voice.isIdle()) count++;
    return count;
  }

  getActiveNoteIds(): number[] {
    return this.voices.filter((voice) => !voice.isIdle()).map((voice) => voice.noteId);
  }

  private allocateVoice(): SynthVoice {
    const idle = this.voices.find((voice) => voice.isIdle());
    if (idle !== undefined) return idle;

    // Voice stealing: oldest released voice first, then oldest sounding voice.
    const released = this.voices
      .filter((voice) => !voice.keyDown)
      .sort((left, right) => left.releasedOrder - right.releasedOrder)[0];
    if (released !== undefined) return released;
    return this.voices.reduce((oldest, voice) => (voice.startedOrder < oldest.startedOrder ? voice : oldest));
  }
}

export function createSynthProcessor(
  engine: SynthEngine,
  sampleRate: number,
  settings: SynthSettings,
): BasicMonoProcessor | BasicPolyProcessor {
  return engine === "basic-mono"
    ? new BasicMonoProcessor(sampleRate, settings)
    : new BasicPolyProcessor(sampleRate, settings);
}
