import { rampValue, type ParamRamps } from "./control.js";
import { centsToRatio, db100ToGain, panGains } from "./units.js";

export interface SampleData {
  sampleRate: number;
  left: Float32Array;
  right?: Float32Array;
}

export interface DrumVoiceSettings {
  sample: SampleData;
  gainDb100: number;
  panPermille: number;
  pitchCents: number;
  chokeGroup: number;
}

export interface DrumHitCommand {
  offset: number;
  voice: string;
  velocity: number;
}

interface PlaybackVoice {
  voice: string;
  settings: DrumVoiceSettings;
  position: number;
  rate: number;
  velocityGain: number;
  chokeSamplesRemaining: number;
  chokeSamplesTotal: number;
}

export class DrumkitProcessor {
  private readonly playbacks: PlaybackVoice[] = [];

  constructor(
    private readonly sampleRate: number,
    private readonly voices: Readonly<Record<string, DrumVoiceSettings>>,
  ) {}

  processBlock(
    left: Float32Array,
    right: Float32Array,
    length: number,
    commands: readonly DrumHitCommand[],
    ramps: ParamRamps,
  ): void {
    let commandIndex = 0;
    for (let index = 0; index < length; index++) {
      while (commands[commandIndex]?.offset === index) {
        this.trigger(commands[commandIndex]!);
        commandIndex++;
      }

      let leftSample = 0;
      let rightSample = 0;
      for (const playback of this.playbacks) {
        const sample = interpolateSample(playback.settings.sample, playback.position);
        if (sample === undefined) continue;
        let chokeGain = 1;
        if (playback.chokeSamplesRemaining > 0) {
          chokeGain = playback.chokeSamplesRemaining / playback.chokeSamplesTotal;
          playback.chokeSamplesRemaining--;
        }

        const gainKey = `${playback.voice}.gain`;
        const panKey = `${playback.voice}.pan`;
        const gain = db100ToGain(rampValue(ramps[gainKey], playback.settings.gainDb100, index, length));
        const [leftPan, rightPan] = panGains(
          rampValue(ramps[panKey], playback.settings.panPermille, index, length),
        );
        const amplitude = sample * playback.velocityGain * chokeGain * gain;
        leftSample += amplitude * leftPan;
        rightSample += amplitude * rightPan;
        playback.position += playback.rate;
      }

      left[index] = leftSample;
      right[index] = rightSample;
      this.removeFinished();
    }
  }

  getActiveVoiceCount(): number {
    return this.playbacks.length;
  }

  private trigger(command: DrumHitCommand): void {
    const settings = this.voices[command.voice];
    if (settings === undefined) return;
    if (settings.chokeGroup !== 0) {
      const rampSamples = Math.max(1, Math.round(this.sampleRate * 0.005));
      for (const playback of this.playbacks) {
        if (playback.settings.chokeGroup === settings.chokeGroup) {
          playback.chokeSamplesRemaining = rampSamples;
          playback.chokeSamplesTotal = rampSamples;
        }
      }
    }
    this.playbacks.push({
      voice: command.voice,
      settings,
      position: 0,
      // Linear interpolation is deterministic and sufficient for v1, though
      // it is not an audiophile-grade resampler.
      rate: (settings.sample.sampleRate / this.sampleRate) * centsToRatio(settings.pitchCents),
      velocityGain: command.velocity / 1000,
      chokeSamplesRemaining: 0,
      chokeSamplesTotal: 1,
    });
  }

  private removeFinished(): void {
    for (let index = this.playbacks.length - 1; index >= 0; index--) {
      const playback = this.playbacks[index]!;
      if (
        playback.position >= playback.settings.sample.left.length ||
        (playback.chokeSamplesTotal > 1 && playback.chokeSamplesRemaining === 0)
      ) {
        this.playbacks.splice(index, 1);
      }
    }
  }
}

function interpolateSample(sample: SampleData, position: number): number | undefined {
  const index = Math.floor(position);
  if (index < 0 || index >= sample.left.length) return undefined;
  const fraction = position - index;
  const nextIndex = Math.min(index + 1, sample.left.length - 1);
  const left = sample.left[index]! + (sample.left[nextIndex]! - sample.left[index]!) * fraction;
  if (sample.right === undefined) return left;
  const right = sample.right[index]! + (sample.right[nextIndex]! - sample.right[index]!) * fraction;
  return (left + right) * 0.5;
}
