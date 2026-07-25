import { describe, expect, it } from "vitest";
import type { CompiledNoteEvent, CompiledSchedule } from "../src/compiler.js";
import { CONTROL_BLOCK_SIZE } from "../src/index.js";
import { expandNoteCommands, noteCommandRank } from "../src/graph/commands.js";
import { LiveScheduler, nextBarBoundary } from "../src/live/scheduler.js";
import { ScheduleSlicer, firstEventAtOrAfter } from "../src/live/slicer.js";

function event(startSample: number, midi = 60, durationSamples = 100): CompiledNoteEvent {
  return { startSample, durationSamples, midi, velocity: 800 };
}

function scheduleOf(trackStarts: readonly (readonly number[])[], totalSamples: number): CompiledSchedule {
  return {
    sampleRate: 48_000,
    seed: 0,
    totalSamples,
    tracks: trackStarts.map((starts, index) => ({
      trackId: `track-${index}`,
      instrumentId: `instrument-${index}`,
      events: starts.map((start) => event(start, 60 + index)),
      automation: [],
    })),
  };
}

/** Everything a run of slices delivered, per track, in delivery order. */
function collect(slicer: ScheduleSlicer, windowSize: number, from = 0): CompiledNoteEvent[][] {
  const delivered = slicer.schedule.tracks.map((): CompiledNoteEvent[] => []);
  let horizon = from;
  while (horizon < slicer.schedule.totalSamples) {
    horizon = Math.min(horizon + windowSize, slicer.schedule.totalSamples);
    for (const track of slicer.advanceTo(horizon).tracks) {
      delivered[track.trackIndex]!.push(...track.events);
    }
  }
  return delivered;
}

describe("lookahead slicing", () => {
  /**
   * The whole point of the slicer: an event delivered twice is a doubled note and
   * an event dropped is a missing one, and both are nearly invisible in a diff.
   * Events sit exactly on window boundaries here on purpose — that is where the
   * off-by-one lives.
   */
  it("delivers every event exactly once, in order, for every window size and alignment", () => {
    const totalSamples = 20_000;
    const schedule = scheduleOf(
      [
        [0, 1, 127, 128, 129, 255, 256, 4863, 4864, 4865, 9728, 19_999],
        [0, 128, 256, 384, 512],
        [],
        [12_800],
      ],
      totalSamples,
    );

    for (const windowSize of [1, 2, 3, 127, 128, 129, 251, 256, 4800, 4864, 19_999, 20_000, 50_000]) {
      const slicer = new ScheduleSlicer(schedule);
      const delivered = collect(slicer, windowSize);
      expect({ windowSize, delivered }).toEqual({
        windowSize,
        delivered: schedule.tracks.map((track) => track.events),
      });
      expect(slicer.scheduledThrough).toBe(totalSamples);
      expect(slicer.done).toBe(true);
    }
  });

  it("puts an event exactly on a window boundary in the window that starts there", () => {
    const schedule = scheduleOf([[0, 128, 256]], 384);
    const slicer = new ScheduleSlicer(schedule);
    expect(slicer.advanceTo(128).tracks[0]!.events.map((each) => each.startSample)).toEqual([0]);
    expect(slicer.advanceTo(256).tracks[0]!.events.map((each) => each.startSample)).toEqual([128]);
    expect(slicer.advanceTo(384).tracks[0]!.events.map((each) => each.startSample)).toEqual([256]);
  });

  it("omits tracks with nothing due rather than sending empty arrays", () => {
    const schedule = scheduleOf([[0], [5000]], 10_000);
    const slice = new ScheduleSlicer(schedule).advanceTo(1000);
    expect(slice.tracks.map((track) => track.trackIndex)).toEqual([0]);
  });

  it("skips events before a seek and never re-delivers them", () => {
    const schedule = scheduleOf([[0, 100, 200, 300]], 1000);
    const slicer = new ScheduleSlicer(schedule);
    slicer.advanceTo(150);
    slicer.seek(200);
    expect(collect(slicer, 100, 200).flat().map((each) => each.startSample)).toEqual([200, 300]);
  });

  it("refuses a window that moves backwards", () => {
    const slicer = new ScheduleSlicer(scheduleOf([[0]], 1000));
    slicer.advanceTo(500);
    expect(() => slicer.advanceTo(400)).toThrow(/behind the horizon/);
  });

  it("finds the first event at or after a sample by binary search", () => {
    const events = [event(0), event(100), event(100), event(300)];
    expect(firstEventAtOrAfter(events, 0)).toBe(0);
    expect(firstEventAtOrAfter(events, 1)).toBe(1);
    expect(firstEventAtOrAfter(events, 100)).toBe(1);
    expect(firstEventAtOrAfter(events, 101)).toBe(3);
    expect(firstEventAtOrAfter(events, 9000)).toBe(4);
  });
});

describe("note command order", () => {
  it("delivers a note-off before a note-on at the same sample, then breaks ties on note id", () => {
    const commands = expandNoteCommands([event(0, 60, 0), event(0, 62, 480)]);
    expect(commands.map((command) => [command.sample, command.kind, command.noteId])).toEqual([
      [0, "off", 0],
      [0, "on", 0],
      [0, "on", 1],
      [480, "off", 1],
    ]);
    expect(noteCommandRank("off")).toBeLessThan(noteCommandRank("on"));
  });
});

describe("transport scheduling and structural change timing", () => {
  const barSamples = 4 * 24_000;
  const barStarts = [0, barSamples, barSamples * 2, barSamples * 3];
  const totalSamples = barSamples * 4;

  function scheduler(lookahead = 4864): LiveScheduler {
    const schedule = scheduleOf([[0, barSamples, barSamples * 2]], totalSamples);
    return new LiveScheduler(schedule, barStarts, lookahead);
  }

  it("schedules nothing until started", () => {
    const live = scheduler();
    expect(live.advance(0)).toEqual([]);
    expect(live.scheduledThrough).toBe(0);
  });

  it("tiles windows forward from the horizon, so a late tick produces one longer window", () => {
    const live = scheduler(4864);
    live.start();
    expect(live.advance(0).map((action) => [action.slice.startSample, action.slice.endSample])).toEqual([[0, 4864]]);
    // Each pass extends the horizon by however far the playhead moved, so a tick
    // that arrives four times late produces one window four times as long rather
    // than a gap. Windows always abut.
    expect(live.advance(128).map((action) => [action.slice.startSample, action.slice.endSample])).toEqual([
      [4864, 4992],
    ]);
    expect(live.advance(4864).map((action) => [action.slice.startSample, action.slice.endSample])).toEqual([
      [4992, 9728],
    ]);
  });

  it("refuses to advance backwards", () => {
    const live = scheduler();
    live.start();
    live.advance(10_000);
    expect(() => live.advance(9000)).toThrow(/behind/);
  });

  /**
   * PLAN.md §12 step 6. The boundary is chosen from the horizon, not the playhead:
   * everything in between is already inside the worklet, so an earlier boundary
   * would mean withdrawing events that may already have sounded.
   */
  it("defers a structural change to the first bar boundary at or after the horizon", () => {
    const live = scheduler(4864);
    live.start();
    live.advance(0);
    expect(live.scheduledThrough).toBe(4864);

    const replacement = scheduleOf([[0, 1000, barSamples, barSamples + 7]], totalSamples);
    const change = live.queueStructuralChange(replacement, barStarts);
    expect(change.atSample).toBe(barSamples);
    expect(live.generation).toBe(0);
    expect(live.pendingChange?.generation).toBe(1);

    // Everything up to the boundary still comes from the old schedule.
    const before = live.advance(barSamples - 4864 - 128);
    expect(before.every((action) => action.generation === 0)).toBe(true);
    expect(before.flatMap((action) => action.slice.tracks.flatMap((track) => track.events))).toEqual([]);

    const crossing = live.advance(barSamples - 128);
    expect(crossing.map((action) => [action.generation, action.slice.startSample, action.slice.endSample])).toEqual([
      [0, barSamples - 4864 - 128 + 4864, barSamples],
      [1, barSamples, barSamples + 4736],
    ]);
    expect(live.generation).toBe(1);
    // The new schedule's event at 1000 is behind the switch and is not resurrected.
    expect(
      crossing.flatMap((action) => action.slice.tracks.flatMap((track) => track.events.map((e) => e.startSample))),
    ).toEqual([barSamples, barSamples + 7]);
  });

  it("applies a structural change at once while stopped", () => {
    const live = scheduler();
    const replacement = scheduleOf([[0]], totalSamples);
    const change = live.queueStructuralChange(replacement, barStarts);
    expect(change.atSample).toBeNull();
    expect(live.generation).toBe(1);
    expect(live.pendingChange).toBeUndefined();
  });

  it("makes a queued change immediate on stop and on seek", () => {
    const live = scheduler();
    live.start();
    live.advance(0);
    live.queueStructuralChange(scheduleOf([[0]], totalSamples), barStarts);
    const flushed = live.stop();
    expect(flushed).toMatchObject({ generation: 1, atSample: null });
    expect(live.pendingChange).toBeUndefined();

    live.start();
    live.advance(live.positionSample);
    live.queueStructuralChange(scheduleOf([[500]], totalSamples), barStarts);
    expect(live.seek(0)).toMatchObject({ generation: 2, atSample: null });
  });

  it("brings the horizon back to the playhead on stop, so a restart is not seen as starved", () => {
    const live = scheduler();
    live.start();
    live.advance(0);
    expect(live.scheduledThrough).toBeGreaterThan(0);
    live.stop();
    expect(live.scheduledThrough).toBe(live.positionSample);
  });

  it("accepts a parameter change whose events are unchanged and re-slices from the horizon", () => {
    const live = scheduler();
    live.start();
    live.advance(0);
    const horizon = live.scheduledThrough;
    const same = scheduleOf([[0, barSamples, barSamples * 2]], totalSamples);
    same.tracks[0]!.automation = [{ param: "filter.cutoff", interp: "linear", points: [[0, 400]] }];
    expect(live.updateParameters(same)).toBe(0);
    expect(live.scheduledThrough).toBe(horizon);
    expect(live.schedule.tracks[0]!.automation).toHaveLength(1);
  });

  it("rejects a structural edit disguised as a parameter change", () => {
    const live = scheduler();
    live.start();
    live.advance(0);
    expect(() => live.updateParameters(scheduleOf([[0, barSamples]], totalSamples))).toThrow(/which is structural/);
    expect(() => live.updateParameters(scheduleOf([[0, barSamples, barSamples * 2 + 1]], totalSamples))).toThrow(
      /moved or changed, which is structural/,
    );
    expect(() => live.updateParameters(scheduleOf([[0], []], totalSamples))).toThrow(/track count/);
  });

  it("ignores an already-past event when a parameter change lands after it", () => {
    const live = scheduler(CONTROL_BLOCK_SIZE * 8);
    live.start();
    live.advance(barSamples);
    // The event at 0 has been delivered; changing it now cannot un-play it, so it
    // is outside what this check is responsible for.
    const edited = scheduleOf([[7, barSamples, barSamples * 2]], totalSamples);
    expect(() => live.updateParameters(edited)).not.toThrow();
  });

  it("falls back to the given sample when no later bar boundary exists", () => {
    expect(nextBarBoundary(barStarts, 0)).toBe(0);
    expect(nextBarBoundary(barStarts, 1)).toBe(barSamples);
    expect(nextBarBoundary(barStarts, barSamples * 3 + 1)).toBe(barSamples * 3 + 1);
    expect(nextBarBoundary([], 999)).toBe(999);
  });
});
