import type { CompiledAutomationLane, CompiledNoteEvent } from "../compiler.js";
import type { InstrumentDoc } from "@chord-garden/format";

/** Name the worklet module registers, and the name the node must be created with. */
export const LIVE_PROCESSOR_NAME = "chord-garden-live";

/**
 * A sample the worklet must already hold, identified by content rather than by
 * path: replacing `samples/kick.wav` changes the hash, so a configure carrying
 * the old hash is a stale configure and is rejected instead of quietly playing
 * the wrong audio (PLAN.md §14).
 */
export interface LiveSampleRef {
  path: string;
  contentHash: string;
}

/**
 * One track's configuration. The instrument *document* crosses the boundary, not
 * a bag of pre-resolved DSP numbers, so the worklet derives its settings with the
 * same `synthSettings`/`drumkitConfiguration` code the offline renderer uses. A
 * second interpretation of a registry param is exactly the divergence the one-DSP
 * -core rule exists to prevent.
 */
export interface LiveTrackConfig {
  trackId: string;
  instrument: InstrumentDoc;
  automation: CompiledAutomationLane[];
}

/** Events of one track that start inside a slice's window, in schedule order. */
export interface LiveSliceTrack {
  /** Index into the active configure's `tracks`, which is `trackOrder` order. */
  trackIndex: number;
  events: CompiledNoteEvent[];
}

export type LiveCommand =
  /**
   * Replace the whole track graph. `atSample` is the position the new graph takes
   * effect at (a bar boundary for a structural edit, per PLAN.md §12 step 6), or
   * null to take effect at the next block. Slices tagged with the new generation
   * may arrive before the switch and are held until it happens.
   */
  | {
      type: "configure";
      generation: number;
      atSample: number | null;
      tracks: LiveTrackConfig[];
      samples: LiveSampleRef[];
    }
  /**
   * Decoded sample content. The worklet cannot fetch, so every byte of audio it
   * plays arrives this way. Sent as a structured-clone copy rather than a
   * transfer so the main thread keeps its content-hash cache usable after the
   * `AudioContext` is closed and a new worklet is created; `transfer` is left
   * available on the sink for the day profiling says the copy matters.
   */
  | {
      type: "sampleData";
      path: string;
      contentHash: string;
      sampleRate: number;
      left: Float32Array;
      right?: Float32Array;
    }
  /** Events due in `[startSample, endSample)`; windows must tile without gaps. */
  | {
      type: "slice";
      generation: number;
      startSample: number;
      endSample: number;
      tracks: LiveSliceTrack[];
    }
  /**
   * In-place parameter update for one track: no voice is restarted, no event is
   * withdrawn, and nothing is re-rolled. Envelope times take effect on the next
   * note, everything else on the next block.
   */
  | {
      type: "params";
      generation: number;
      trackIndex: number;
      instrument: InstrumentDoc;
      automation: CompiledAutomationLane[];
    }
  | { type: "start" }
  | { type: "stop" }
  | { type: "seek"; sample: number };

export interface LivePosition {
  type: "position";
  playing: boolean;
  positionSample: number;
  /** Highest slice end delivered so far; the horizon the scheduler has reached. */
  scheduledThroughSample: number;
  /** Blocks rendered past that horizon since the last reset — starved blocks. */
  underrunBlocks: number;
  peakLeft: number;
  peakRight: number;
  activeVoices: number;
  generation: number;
}

export type LiveEvent =
  | { type: "ready"; generation: number }
  | LivePosition
  /** Any invariant the audio thread cannot throw its way out of. */
  | { type: "error"; message: string };

/**
 * Exhaustiveness guard. An unrecognised message is a protocol bug, so it fails
 * loudly here rather than being dropped and debugged later from a silence.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unexpected ${JSON.stringify(value)}`);
}
