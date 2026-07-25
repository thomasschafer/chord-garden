import type { CompiledSchedule } from "../compiler.js";
import { CONTROL_BLOCK_SIZE } from "../dsp/index.js";
import { ScheduleSlicer, type ScheduleSlice } from "./slicer.js";

export interface SliceAction {
  generation: number;
  slice: ScheduleSlice;
}

export interface StructuralChange {
  generation: number;
  /** Position the new graph takes effect at; null means "at the next block". */
  atSample: number | null;
  schedule: CompiledSchedule;
}

/**
 * What the scheduler hands the worklet, and when.
 *
 * Transport state and the §12-step-6 timing rule live here, away from any clock:
 * `advance` is told the playback position rather than reading one, so every
 * boundary case is reachable in a test.
 *
 * PLAN.md §12 step 6, as implemented:
 * - A parameter tweak reaches the audio thread as an in-place `params` update and
 *   takes effect at the next block. It cannot move an event, so nothing already
 *   scheduled has to be withdrawn. `updateParameters` checks that claim against
 *   the recompiled schedule instead of trusting it.
 * - A structural change is deferred to the first bar boundary at or after the
 *   horizon — deliberately the horizon and not the playhead, because everything
 *   between them is already inside the worklet, and a boundary before it would
 *   mean withdrawing events that may already have sounded. The boundary is then
 *   rounded up to a whole render quantum, because the DSP graph cannot be
 *   swapped mid-block: a bar line is a tick position and lands wherever it lands,
 *   so the change is up to one quantum (2.7 ms at 48 kHz) later than the bar.
 * - When stopped, both apply immediately.
 */
export class LiveScheduler {
  private slicer: ScheduleSlicer;
  /** Generation of the graph currently rendering, which a pending change is not. */
  private activeGeneration = 0;
  /** Allocates generation numbers; ahead of `activeGeneration` while one is pending. */
  private generationSeed = 0;
  private pending: StructuralChange | undefined;
  private playing = false;
  private position = 0;

  constructor(
    schedule: CompiledSchedule,
    /** Bar boundaries in samples, i.e. `musicalGrid(...).barStarts`. */
    private barStarts: readonly number[],
    /** How far past the playhead to schedule; see `LiveTransport` for sizing. */
    readonly lookaheadSamples: number,
  ) {
    if (!Number.isInteger(lookaheadSamples) || lookaheadSamples <= 0) {
      throw new Error(`cannot create scheduler: lookahead ${lookaheadSamples} must be a positive integer of samples`);
    }
    this.slicer = new ScheduleSlicer(schedule);
  }

  get generation(): number {
    return this.activeGeneration;
  }

  get schedule(): CompiledSchedule {
    return this.slicer.schedule;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get scheduledThrough(): number {
    return this.slicer.scheduledThrough;
  }

  /** Position the transport is at, or will resume from. */
  get positionSample(): number {
    return this.position;
  }

  get pendingChange(): StructuralChange | undefined {
    return this.pending;
  }

  start(): void {
    this.playing = true;
  }

  /**
   * Stop. Committed lookahead is discarded, which is why the worklet also drops
   * its queued events on stop; the two must agree on the horizon or the first
   * block after restarting looks starved.
   *
   * Returns a queued structural change made immediate, if there was one: with
   * nothing committed past the playhead it has nothing left to wait for. The
   * caller must send it to the worklet.
   */
  stop(): StructuralChange | undefined {
    this.playing = false;
    this.slicer.seek(this.position);
    return this.flushPending(this.position);
  }

  /** Jump. Returns a queued structural change made immediate, as `stop` does. */
  seek(sample: number): StructuralChange | undefined {
    this.position = sample;
    this.slicer.seek(sample);
    return this.flushPending(sample);
  }

  private flushPending(atSample: number): StructuralChange | undefined {
    const pending = this.pending;
    if (pending === undefined) return undefined;
    const immediate: StructuralChange = { generation: pending.generation, atSample: null, schedule: pending.schedule };
    this.applyPending(immediate, atSample);
    return immediate;
  }

  /**
   * Slices to deliver for a playhead at `positionSample`. Windows tile forward
   * from the horizon, so a late timer callback produces one longer window rather
   * than a gap.
   */
  advance(positionSample: number): SliceAction[] {
    if (!this.playing) return [];
    if (positionSample < this.position) {
      throw new Error(`cannot advance scheduler: position ${positionSample} is behind ${this.position}`);
    }
    this.position = positionSample;
    const target = positionSample + this.lookaheadSamples;
    const actions: SliceAction[] = [];
    const pending = this.pending;
    if (pending !== undefined && pending.atSample !== null && target >= pending.atSample) {
      if (pending.atSample > this.slicer.scheduledThrough) {
        actions.push({ generation: this.activeGeneration, slice: this.slicer.advanceTo(pending.atSample) });
      }
      this.applyPending(pending, pending.atSample);
    }
    if (target > this.slicer.scheduledThrough) {
      actions.push({ generation: this.activeGeneration, slice: this.slicer.advanceTo(target) });
    }
    return actions;
  }

  /**
   * Adopt a recompiled schedule whose events are unchanged — a parameter or
   * automation edit. Returns the generation the in-place `params` messages must
   * carry.
   *
   * The events are compared from the horizon onwards: a caller that misclassifies
   * a structural edit as a parameter edit gets an error naming the divergence
   * rather than a schedule whose events silently no longer match the audio.
   */
  updateParameters(schedule: CompiledSchedule): number {
    const current = this.slicer.schedule;
    if (schedule.tracks.length !== current.tracks.length) {
      throw new Error(
        `cannot apply a parameter change: track count went from ${current.tracks.length} to ${schedule.tracks.length}, which is structural`,
      );
    }
    const cursors = this.slicer.getCursors();
    current.tracks.forEach((track, index) => {
      const replacement = schedule.tracks[index]!;
      if (replacement.trackId !== track.trackId) {
        throw new Error(
          `cannot apply a parameter change: track ${index} went from "${track.trackId}" to "${replacement.trackId}", which is structural`,
        );
      }
      if (replacement.events.length !== track.events.length) {
        throw new Error(
          `cannot apply a parameter change: track "${track.trackId}" went from ${track.events.length} to ${replacement.events.length} events, which is structural`,
        );
      }
      for (let event = cursors[index]!; event < track.events.length; event++) {
        const before = track.events[event]!;
        const after = replacement.events[event]!;
        if (
          before.startSample !== after.startSample ||
          before.durationSamples !== after.durationSamples ||
          before.midi !== after.midi ||
          before.velocity !== after.velocity ||
          before.voice !== after.voice
        ) {
          throw new Error(
            `cannot apply a parameter change: event ${event} of track "${track.trackId}" moved or changed, which is structural`,
          );
        }
      }
    });

    const horizon = this.slicer.scheduledThrough;
    this.slicer = new ScheduleSlicer(schedule);
    this.slicer.seek(horizon);
    return this.activeGeneration;
  }

  /**
   * Queue a rebuild of the track graph. Applied at the next bar boundary at or
   * after the horizon while playing, or immediately while stopped. A change
   * queued while another is pending replaces it and its boundary is recomputed.
   */
  queueStructuralChange(schedule: CompiledSchedule, barStarts: readonly number[]): StructuralChange {
    const generation = ++this.generationSeed;
    if (!this.playing) {
      const change: StructuralChange = { generation, atSample: null, schedule };
      this.barStarts = barStarts;
      this.applyPending(change, this.position);
      return change;
    }
    const change: StructuralChange = {
      generation,
      atSample: alignUp(nextBarBoundary(this.barStarts, this.slicer.scheduledThrough)),
      schedule,
    };
    this.barStarts = barStarts;
    this.pending = change;
    return change;
  }

  private applyPending(change: StructuralChange, atSample: number): void {
    this.slicer = new ScheduleSlicer(change.schedule);
    this.slicer.seek(atSample);
    this.activeGeneration = change.generation;
    this.pending = undefined;
  }
}

/**
 * First bar boundary at or after `sample`. Past the last bar there is nothing
 * left to wait for, so the change lands at `sample` itself.
 */
export function nextBarBoundary(barStarts: readonly number[], sample: number): number {
  for (const start of barStarts) if (start >= sample) return start;
  return sample;
}

/** The first render-quantum boundary at or after `sample`. */
function alignUp(sample: number): number {
  return Math.ceil(sample / CONTROL_BLOCK_SIZE) * CONTROL_BLOCK_SIZE;
}
