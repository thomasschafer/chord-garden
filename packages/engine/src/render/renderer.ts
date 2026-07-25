import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@chord-garden/format";
import { compile } from "../compiler.js";
import { CONTROL_BLOCK_SIZE, type SampleData } from "../dsp/index.js";
import { createTrackRunner } from "../graph/trackRunner.js";
import { decodeWav } from "./wav.js";

export interface RenderOptions {
  sampleRate: number;
  seed: number;
  barRange?: { start: number; end: number };
  /**
   * When true, also return the isolated buffers: one stem per track and, for
   * drumkit tracks, one buffer per kit voice. Isolation is independent of
   * writing files — the CLI always asks for it so `--analyze` can measure a
   * single lane whether or not `--stems` was given. The cost is memory: one
   * full-length stereo buffer per track and per kit voice.
   */
  stems: boolean;
  /** Extra time rendered past the last event so releases/tails are not truncated. */
  tailSeconds: number;
}

export interface StereoAudio {
  /** Planar stereo: both arrays contain exactly totalSamples samples. */
  left: Float32Array;
  right: Float32Array;
}

export interface RenderedAudio {
  sampleRate: number;
  master: StereoAudio;
  stems?: Map<string, StereoAudio>;
  /**
   * Per-kit-voice audio for drumkit tracks: track id, then voice name in kit
   * order. Present exactly when `stems` are; synth tracks never appear, since a
   * synth track has no voices to separate.
   *
   * A track's voices reproduce its stem bit for bit when accumulated at float32
   * precision in this map's iteration order, which is how the mix itself is
   * summed (see `DrumkitProcessor`). Summed in float64 instead they agree to
   * within float32 rounding rather than exactly.
   */
  voices?: Map<string, Map<string, StereoAudio>>;
  totalSamples: number;
}

export const DEFAULT_RENDER_OPTIONS: Readonly<RenderOptions> = {
  sampleRate: 48_000,
  seed: 0,
  stems: false,
  tailSeconds: 2,
};

export function render(project: Project, options: Partial<RenderOptions> = {}): RenderedAudio {
  const resolved = resolveOptions(options);
  const compileOptions =
    resolved.barRange === undefined
      ? { sampleRate: resolved.sampleRate, seed: resolved.seed }
      : { sampleRate: resolved.sampleRate, seed: resolved.seed, barRange: resolved.barRange };
  const schedule = compile(project, compileOptions);
  const totalSamples = schedule.totalSamples + Math.round(resolved.tailSeconds * resolved.sampleRate);
  const master = emptyStereo(totalSamples);
  const isolated = resolved.stems
    ? { stems: new Map<string, StereoAudio>(), voices: new Map<string, Map<string, StereoAudio>>() }
    : undefined;
  const resolveSample = fileSampleResolver(project);

  for (const compiledTrack of schedule.tracks) {
    const instrument = project.instruments.get(compiledTrack.instrumentId);
    if (instrument === undefined) throw new Error(`cannot render: instrument "${compiledTrack.instrumentId}" is missing`);
    const trackVoices =
      isolated === undefined || instrument.type !== "drumkit"
        ? undefined
        : new Map(Object.keys(instrument.kit).map((voice) => [voice, emptyStereo(totalSamples)] as const));
    const runner = createTrackRunner(compiledTrack, instrument, resolved.sampleRate, resolveSample, trackVoices);
    runner.enqueue(compiledTrack.events);

    const stem = emptyStereo(totalSamples);
    for (let blockStart = 0; blockStart < totalSamples; blockStart += CONTROL_BLOCK_SIZE) {
      const length = Math.min(CONTROL_BLOCK_SIZE, totalSamples - blockStart);
      runner.processBlock(
        stem.left.subarray(blockStart, blockStart + length),
        stem.right.subarray(blockStart, blockStart + length),
        length,
        blockStart,
      );
    }

    if (isolated !== undefined) {
      isolated.stems.set(compiledTrack.trackId, stem);
      if (trackVoices !== undefined) isolated.voices.set(compiledTrack.trackId, trackVoices);
    }
    // The float master deliberately remains unclipped so later analysis can
    // detect overloads. Integer WAV quantisation is where clamping occurs.
    for (let sample = 0; sample < totalSamples; sample++) {
      master.left[sample] = master.left[sample]! + stem.left[sample]!;
      master.right[sample] = master.right[sample]! + stem.right[sample]!;
    }
  }

  return isolated === undefined
    ? { sampleRate: resolved.sampleRate, master, totalSamples }
    : { sampleRate: resolved.sampleRate, master, ...isolated, totalSamples };
}

/**
 * Decodes project-relative WAVs from disk, once each. The live engine resolves
 * the same paths from sample data pushed into the worklet instead; nothing below
 * this function knows the difference.
 */
function fileSampleResolver(project: Project): (path: string) => SampleData {
  const cache = new Map<string, SampleData>();
  return (path) => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const decoded = decodeWav(readFileSync(join(project.root, path)));
    const right = decoded.channels[1];
    const data: SampleData =
      right === undefined
        ? { sampleRate: decoded.sampleRate, left: decoded.channels[0] }
        : { sampleRate: decoded.sampleRate, left: decoded.channels[0], right };
    cache.set(path, data);
    return data;
  };
}

function resolveOptions(options: Partial<RenderOptions>): RenderOptions {
  const sampleRate = options.sampleRate ?? DEFAULT_RENDER_OPTIONS.sampleRate;
  const seed = options.seed ?? DEFAULT_RENDER_OPTIONS.seed;
  const stems = options.stems ?? DEFAULT_RENDER_OPTIONS.stems;
  const tailSeconds = options.tailSeconds ?? DEFAULT_RENDER_OPTIONS.tailSeconds;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("render sampleRate must be a positive integer");
  if (!Number.isFinite(seed)) throw new Error("render seed must be finite");
  if (!Number.isFinite(tailSeconds) || tailSeconds < 0) throw new Error("render tailSeconds must be non-negative");
  return options.barRange === undefined
    ? { sampleRate, seed, stems, tailSeconds }
    : { sampleRate, seed, stems, tailSeconds, barRange: options.barRange };
}

function emptyStereo(totalSamples: number): StereoAudio {
  return { left: new Float32Array(totalSamples), right: new Float32Array(totalSamples) };
}
