import { rampValue, type ParamRamps } from "./control.js";
import { centsToRatio, db100ToGain, panGains, velocityToGain } from "./units.js";

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
  /** Index of the voice in `voiceNames`, so the mix loop needs no key lookup. */
  slot: number;
  settings: DrumVoiceSettings;
  /**
   * The audio this hit is playing, captured when it was triggered rather than
   * read from `settings` each sample.
   *
   * That is what makes replacing a sample file inaudible as a glitch: swapping
   * `settings.sample` under a hit that is already sounding changes the waveform
   * mid-flight — a step discontinuity, so a click — and leaves `rate` describing
   * the old file's sample rate. Holding the buffer here means a replacement is
   * adopted by the *next* trigger, and a hit in progress finishes on what it
   * started with (PLAN.md §14). The reference also bounds how long the old buffer
   * lives: it is dropped when this playback ends, which is within the sample's own
   * length.
   */
  sample: SampleData;
  position: number;
  rate: number;
  velocityGain: number;
  chokeSamplesRemaining: number;
  chokeSamplesTotal: number;
}

/** One stereo destination per kit voice, keyed by voice name. */
export type DrumVoiceOutputs = Readonly<Record<string, { left: Float32Array; right: Float32Array }>>;

export class DrumkitProcessor {
  private readonly playbacks: PlaybackVoice[] = [];
  private readonly voiceNames: readonly string[];
  /**
   * One sample of each voice's contribution. The mix is the sum of these slots,
   * accumulated at float32 precision in voice order, so per-voice output written
   * from the same slots reproduces the mix bit for bit when summed the same way.
   * Summed any other way — float64, or a different voice order — it agrees only
   * to within float32 rounding, which grows with the number of voices: roughly
   * one ulp of the running sum per voice, so well under a 24-bit LSB for a
   * handful of voices, not zero.
   */
  private readonly slotLeft: Float32Array;
  private readonly slotRight: Float32Array;
  private readonly slotOf: Readonly<Record<string, number>>;

  constructor(
    private readonly sampleRate: number,
    private readonly voices: Readonly<Record<string, DrumVoiceSettings>>,
  ) {
    this.voiceNames = Object.keys(voices);
    this.slotLeft = new Float32Array(this.voiceNames.length);
    this.slotRight = new Float32Array(this.voiceNames.length);
    const slotOf: Record<string, number> = {};
    this.voiceNames.forEach((voice, slot) => {
      slotOf[voice] = slot;
    });
    this.slotOf = slotOf;
  }

  /**
   * Voice names in the order the mix sums them, which is the order per-voice
   * output must be summed in to reproduce the mix bit for bit.
   */
  getVoiceNames(): readonly string[] {
    return this.voiceNames;
  }

  /**
   * `voiceOutputs`, when given, receives each voice's isolated contribution to
   * this block; every voice of the kit must be present. Choke groups reach
   * across voices, so isolation happens here rather than by running a processor
   * per voice, which would lose the cross-voice chokes.
   */
  processBlock(
    left: Float32Array,
    right: Float32Array,
    length: number,
    commands: readonly DrumHitCommand[],
    ramps: ParamRamps,
    voiceOutputs?: DrumVoiceOutputs,
  ): void {
    const outputs = this.resolveVoiceOutputs(voiceOutputs);
    let commandIndex = 0;
    for (let index = 0; index < length; index++) {
      while (commands[commandIndex]?.offset === index) {
        this.trigger(commands[commandIndex]!);
        commandIndex++;
      }

      this.slotLeft.fill(0);
      this.slotRight.fill(0);
      for (const playback of this.playbacks) {
        const sample = interpolateSample(playback.sample, playback.position);
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
        this.slotLeft[playback.slot] = this.slotLeft[playback.slot]! + amplitude * leftPan;
        this.slotRight[playback.slot] = this.slotRight[playback.slot]! + amplitude * rightPan;
        playback.position += playback.rate;
      }

      let leftSample = 0;
      let rightSample = 0;
      for (let slot = 0; slot < this.voiceNames.length; slot++) {
        const slotLeft = this.slotLeft[slot]!;
        const slotRight = this.slotRight[slot]!;
        const output = outputs?.[slot];
        if (output !== undefined) {
          output.left[index] = slotLeft;
          output.right[index] = slotRight;
        }
        leftSample = Math.fround(leftSample + slotLeft);
        rightSample = Math.fround(rightSample + slotRight);
      }

      left[index] = leftSample;
      right[index] = rightSample;
      this.removeFinished();
    }
  }

  getActiveVoiceCount(): number {
    return this.playbacks.length;
  }

  /** Stop every playback immediately; used when the transport jumps. */
  reset(): void {
    this.playbacks.length = 0;
  }

  private resolveVoiceOutputs(
    voiceOutputs: DrumVoiceOutputs | undefined,
  ): { left: Float32Array; right: Float32Array }[] | undefined {
    if (voiceOutputs === undefined) return undefined;
    return this.voiceNames.map((voice) => {
      const output = voiceOutputs[voice];
      if (output === undefined) {
        throw new Error(`cannot render drumkit: per-voice output for "${voice}" is missing`);
      }
      return output;
    });
  }

  private trigger(command: DrumHitCommand): void {
    const settings = this.voices[command.voice];
    if (settings === undefined) return;
    const slot = this.slotOf[command.voice];
    if (slot === undefined) throw new Error(`cannot render drumkit: voice "${command.voice}" has no mix slot`);
    if (settings.chokeGroup !== 0) {
      const rampSamples = Math.max(1, Math.round(this.sampleRate * 0.005));
      for (const playback of this.playbacks) {
        if (playback.settings.chokeGroup === settings.chokeGroup) {
          playback.chokeSamplesRemaining = rampSamples;
          playback.chokeSamplesTotal = rampSamples;
        }
      }
    }
    // Read once here, so this hit's audio and the `rate` derived from its sample
    // rate describe the same file even if the file is replaced while it sounds.
    const sample = settings.sample;
    this.playbacks.push({
      voice: command.voice,
      slot,
      settings,
      sample,
      position: 0,
      // Linear interpolation is deterministic and sufficient for v1, though
      // it is not an audiophile-grade resampler.
      rate: (sample.sampleRate / this.sampleRate) * centsToRatio(settings.pitchCents),
      velocityGain: velocityToGain(command.velocity),
      chokeSamplesRemaining: 0,
      chokeSamplesTotal: 1,
    });
  }

  private removeFinished(): void {
    for (let index = this.playbacks.length - 1; index >= 0; index--) {
      const playback = this.playbacks[index]!;
      if (
        playback.position >= playback.sample.left.length ||
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
