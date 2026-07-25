import type { CompiledNoteEvent, CompiledSchedule } from "../compiler.js";
import type { LiveSliceTrack } from "./protocol.js";

export interface ScheduleSlice {
  /** Half-open window in samples from the start of the compiled range. */
  startSample: number;
  endSample: number;
  /** Only tracks with at least one event in the window. */
  tracks: LiveSliceTrack[];
}

/**
 * Cuts a compiled schedule into lookahead windows.
 *
 * Pure: no clock, no `AudioContext`, no messages. Everything about *which* events
 * are due in a window is decided here so it can be tested exactly, leaving the
 * timer-driven part (`LiveTransport`) with nothing to get wrong but the timing.
 *
 * The windows a caller asks for must tile `[0, totalSamples)` without gaps or
 * overlap, which the slicer enforces: a dropped or repeated event is inaudible in
 * a diff and obvious only as a wrong note hours later.
 */
export class ScheduleSlicer {
  private readonly cursors: number[];
  private through = 0;

  constructor(readonly schedule: CompiledSchedule) {
    this.cursors = schedule.tracks.map(() => 0);
  }

  /** End of the last window produced, and the start of the next one. */
  get scheduledThrough(): number {
    return this.through;
  }

  get done(): boolean {
    return this.through >= this.schedule.totalSamples;
  }

  /** Per-track index of the next event to emit; exposed for tests. */
  getCursors(): readonly number[] {
    return this.cursors;
  }

  /**
   * Restart at `sample`, skipping everything before it. Events straddling the
   * position are not resurrected: an event that already started is over as far as
   * the schedule is concerned, which is why a seek also silences voices.
   */
  seek(sample: number): void {
    if (!Number.isInteger(sample) || sample < 0) {
      throw new Error(`cannot seek slicer: ${sample} is not a non-negative integer sample`);
    }
    this.through = sample;
    this.schedule.tracks.forEach((track, index) => {
      this.cursors[index] = firstEventAtOrAfter(track.events, sample);
    });
  }

  /** The next window, `[scheduledThrough, endSample)`. */
  advanceTo(endSample: number): ScheduleSlice {
    if (!Number.isInteger(endSample)) {
      throw new Error(`cannot slice schedule: window end ${endSample} is not an integer sample`);
    }
    if (endSample < this.through) {
      throw new Error(`cannot slice schedule: window end ${endSample} is behind the horizon ${this.through}`);
    }
    const startSample = this.through;
    const tracks: LiveSliceTrack[] = [];
    this.schedule.tracks.forEach((track, trackIndex) => {
      const from = this.cursors[trackIndex]!;
      let cursor = from;
      while (cursor < track.events.length && track.events[cursor]!.startSample < endSample) cursor++;
      if (cursor > from) tracks.push({ trackIndex, events: track.events.slice(from, cursor) });
      this.cursors[trackIndex] = cursor;
    });
    this.through = endSample;
    return { startSample, endSample, tracks };
  }
}

/** First index whose event starts at or after `sample`; events are sorted by start. */
export function firstEventAtOrAfter(events: readonly CompiledNoteEvent[], sample: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle]!.startSample < sample) low = middle + 1;
    else high = middle;
  }
  return low;
}
