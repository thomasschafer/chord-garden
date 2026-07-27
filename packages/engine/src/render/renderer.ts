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
   *
   * With an effect chain on the track that identity holds against the track's
   * `dry` buffer rather than its stem: the chain is one insert across the summed
   * kit, so no voice owns a share of a delay repeat. A kit voice cannot be given
   * its own chain — effects are per track, by design.
   */
  voices?: Map<string, Map<string, StereoAudio>>;
  /**
   * Each effected track's audio before its effect chain, present exactly when
   * `stems` are and only for tracks that have a chain.
   *
   * Analysis needs it: "did this note sound where it was scheduled" and "is there
   * sound nothing scheduled" are questions about the source, and a delay's repeats
   * are deliberate sound at unscheduled positions. Measuring onsets on the wet bus
   * would report a healthy delay as `spurious` and a reverb bed as a missed onset
   * — both false positives of the kind PLAN.md §13 forbids.
   */
  dry?: Map<string, StereoAudio>;
  totalSamples: number;
  /**
   * Samples of *music*, before the release/effect tail — i.e. the compiled
   * schedule's length. `totalSamples` includes `tailSeconds` on top of it.
   *
   * Reported because with an effect chain the tail is no longer reliably silent,
   * so a consumer measuring levels needs to be able to say which window it
   * measured over.
   */
  musicalSamples: number;
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
    ? {
        stems: new Map<string, StereoAudio>(),
        voices: new Map<string, Map<string, StereoAudio>>(),
        dry: new Map<string, StereoAudio>(),
      }
    : undefined;
  const resolveSample = fileSampleResolver(project);

  for (const compiledTrack of schedule.tracks) {
    const instrument = project.instruments.get(compiledTrack.instrumentId);
    if (instrument === undefined) throw new Error(`cannot render: instrument "${compiledTrack.instrumentId}" is missing`);
    const trackVoices =
      isolated === undefined || instrument.type !== "drumkit"
        ? undefined
        : new Map(Object.keys(instrument.kit).map((voice) => [voice, emptyStereo(totalSamples)] as const));
    // Allocated only for a track that actually has a chain: for every other track
    // the dry bus *is* the stem, so a second copy of it would be pure memory (see
    // PLAN.md §18 on per-voice buffers, the same trade one level down).
    const dry =
      isolated === undefined || compiledTrack.effects.length === 0 ? undefined : emptyStereo(totalSamples);
    const runner = createTrackRunner(
      compiledTrack,
      instrument,
      resolved.sampleRate,
      resolveSample,
      trackVoices,
      dry,
    );
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
      if (dry !== undefined) isolated.dry.set(compiledTrack.trackId, dry);
    }
    // The float master deliberately remains unclipped so later analysis can
    // detect overloads. Integer WAV quantisation is where clamping occurs.
    for (let sample = 0; sample < totalSamples; sample++) {
      master.left[sample] = master.left[sample]! + stem.left[sample]!;
      master.right[sample] = master.right[sample]! + stem.right[sample]!;
    }
  }

  const musicalSamples = schedule.totalSamples;
  return isolated === undefined
    ? { sampleRate: resolved.sampleRate, master, totalSamples, musicalSamples }
    : { sampleRate: resolved.sampleRate, master, ...isolated, totalSamples, musicalSamples };
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
