import { pitchToMidi, type NoteEvent, type NotesPatternDoc, type Project } from "@chord-garden/format/pure";
import { describe, expect, it } from "vitest";
import { CELL_PX, defaultSnapTicks, gridGeometry, snapOptions } from "../src/view/grid";
import { movedNote, pitchRange, placementAt, resizedNote, rowTop, widerOf, type RollGeometry } from "../src/view/roll";
import { livePatternTick, patternPlayhead, songTickAt } from "../src/view/playback";
import type { PlayerStatus } from "../src/audio/livePlayer";
import { FIXTURE, openedFrom } from "./fixture";

/**
 * The piano roll's and the playhead's arithmetic.
 *
 * These are the calculations that are wrong silently. A row-to-pitch conversion an
 * octave out writes documents that validate and sound wrong; a drag that snaps the
 * result instead of the delta erases deliberate off-grid timing; a playhead that
 * computes tempo its own way drifts. None of it is visible in a screenshot.
 */

const project = openedFrom(FIXTURE).project;
const geometry = gridGeometry(project);

/** 960 PPQN in 4/4: a bar is 3840 ticks and a 16th is 240. */
const BAR_TICKS = 3840;
const SIXTEENTH = 240;

function pattern(notes: NoteEvent[], lengthTicks = 7680): NotesPatternDoc {
  return { id: "test", kind: "notes", lengthTicks, notes };
}

function roll(highestMidi: number): RollGeometry {
  return { pxPerTick: geometry.pxPerTick, rowPx: 15, highestMidi };
}

/** A worklet report's worth of transport status, playing at 48 kHz. */
function playingAt(positionSample: number): PlayerStatus {
  return {
    phase: "playing",
    sampleRate: 48_000,
    positionSample,
    totalSamples: 48_000 * 60,
    activeVoices: 1,
    underrunBlocks: 0,
    peak: 0.5,
    peakSession: 0.5,
    reportsWithSound: 1,
    reports: 1,
    error: undefined,
    lastEdit: undefined,
    editsApplied: 0,
    samplesReloaded: [],
  };
}

/** The fixture's project with a different meter and PPQN, for the note-value rules. */
function withMeter(timeSignature: [number, number], ppqn = 960): Project {
  const edited = structuredClone(project);
  edited.project.meterMap = [{ startTick: 0, timeSignature }];
  edited.project.ppqn = ppqn;
  return edited;
}

describe("grid geometry", () => {
  it("scales pixels so one sixteenth note is one cell wide", () => {
    expect(geometry.barTicks).toBe(BAR_TICKS);
    expect(geometry.beatTicks).toBe(960);
    expect(geometry.sixteenthTicks).toBe(SIXTEENTH);
    expect(SIXTEENTH * geometry.pxPerTick).toBe(CELL_PX);
    // Which in 4/4 makes a bar sixteen cells wide.
    expect(geometry.barTicks * geometry.pxPerTick).toBe(16 * CELL_PX);
  });

  it("takes note values from the PPQN, not from the bar", () => {
    // The trap docs/format-spec.md §3 leaves open: a bar is only four quarter notes
    // in 4/4. Dividing a 3/4 bar by sixteen gives a 24th note, and a "1/16" snap that
    // is nothing of the kind.
    const threeFour = gridGeometry(withMeter([3, 4]));
    expect(threeFour.barTicks).toBe(2880);
    expect(threeFour.beatsPerBar).toBe(3);
    expect(threeFour.beatTicks).toBe(960);
    expect(threeFour.sixteenthTicks).toBe(SIXTEENTH);
    expect(defaultSnapTicks(withMeter([3, 4]))).toBe(SIXTEENTH);
    // A 3/4 bar is twelve cells, because it is three quarter notes.
    expect(threeFour.barTicks * threeFour.pxPerTick).toBe(12 * CELL_PX);
  });

  it("offers note values plus the bar, coarsest first", () => {
    expect(snapOptions(project)).toEqual([
      { label: "bar", ticks: 3840 },
      { label: "1/4", ticks: 960 },
      { label: "1/8", ticks: 480 },
      { label: "1/16", ticks: 240 },
      { label: "1/32", ticks: 120 },
      { label: "off (1 tick)", ticks: 1 },
    ]);
    expect(defaultSnapTicks(project)).toBe(SIXTEENTH);
  });

  it("sorts the bar into place for a meter shorter than a whole note", () => {
    expect(snapOptions(withMeter([3, 4]))).toEqual([
      { label: "bar", ticks: 2880 },
      { label: "1/4", ticks: 960 },
      { label: "1/8", ticks: 480 },
      { label: "1/16", ticks: 240 },
      { label: "1/32", ticks: 120 },
      { label: "off (1 tick)", ticks: 1 },
    ]);
  });

  it("leaves out a division that would not land on a whole tick", () => {
    // At 24 PPQN a 32nd note is 3 ticks and a 64th would be 1.5; the list stops where
    // the format's integers do rather than offering to round.
    const coarse = snapOptions(withMeter([4, 4], 24));
    expect(coarse.map((option) => option.label)).toEqual(["bar", "1/4", "1/8", "1/16", "1/32", "off (1 tick)"]);
    expect(coarse.map((option) => option.ticks)).toEqual([96, 24, 12, 6, 3, 1]);

    const veryCoarse = snapOptions(withMeter([4, 4], 4));
    expect(veryCoarse.map((option) => option.label)).toEqual(["bar", "1/4", "1/8", "off (1 tick)"]);
    expect(veryCoarse.map((option) => option.ticks)).toEqual([16, 4, 2, 1]);
  });

  it("does not offer the bar twice when a bar is exactly a note value", () => {
    // 4/4 at any PPQN makes the bar a whole note, and "bar" is the label for it.
    expect(snapOptions(project).filter((option) => option.ticks === 3840)).toHaveLength(1);
  });
});

describe("placing a note by clicking", () => {
  it("puts middle C on the row the keys label C4", () => {
    // The anchor docs/format-spec.md §5.1 insists on: C4 is MIDI 60. A roll whose
    // top row is C5 (72) must call the twelfth row down C4, not C3 or C5.
    const placed = placementAt(0, 12 * 15, roll(72), SIXTEENTH);

    expect(placed.pitch).toBe("C4");
    expect(pitchToMidi(placed.pitch)).toBe(60);
  });

  it("names every row consistently with the row a pitch is drawn on", () => {
    const geo = roll(72);
    for (let row = 0; row < 40; row++) {
      const placed = placementAt(0, row * geo.rowPx + 3, geo, SIXTEENTH);
      const midi = pitchToMidi(placed.pitch);
      expect(midi, `row ${row}`).toBe(72 - row);
      // The inverse: the note just placed is drawn back on the row it was clicked.
      expect(rowTop(midi!, geo), `row ${row}`).toBe(row * geo.rowPx);
    }
  });

  it("snaps a new note's start to the grid, absolutely", () => {
    const geo = roll(72);
    // Two thirds of the way into the first 16th: nearest grid line is 0.
    expect(placementAt(CELL_PX * 0.4, 0, geo, SIXTEENTH).startTick).toBe(0);
    expect(placementAt(CELL_PX * 0.6, 0, geo, SIXTEENTH).startTick).toBe(SIXTEENTH);
    expect(placementAt(CELL_PX * 4, 0, geo, SIXTEENTH).startTick).toBe(960);
    // Snap off: the tick under the pointer, rounded to a whole tick because the
    // format has no other kind.
    const free = placementAt(CELL_PX * 4.5, 0, geo, 1).startTick;
    expect(free).toBe(1080);
    expect(Number.isInteger(free)).toBe(true);
  });

  it("clamps a click above or below the representable range", () => {
    expect(placementAt(0, -600, roll(127), SIXTEENTH).pitch).toBe("G9");
    expect(placementAt(0, 40 * 15, roll(12), SIXTEENTH).pitch).toBe("C-1");
  });
});

describe("moving a note", () => {
  const late: NoteEvent = { pitch: "A1", startTick: 968, durationTicks: 480, velocity: 700, microTicks: -8 };

  it("moves by whole grid units and keeps the off-grid offset", () => {
    // The property that matters: 968 is 8 ticks past a 16th line. Dragging it one
    // 16th right must land on 1208, not on 1200 — the lateness was put there on
    // purpose, and straightening it is data loss with a friendly name.
    expect(movedNote(late, SIXTEENTH, 0, pattern([late]))).toEqual({ startTick: 1208, pitch: "A1" });
    expect(movedNote(late, -SIXTEENTH, 0, pattern([late]))).toEqual({ startTick: 728, pitch: "A1" });
  });

  it("returns nothing for a drag that changed nothing, so no edit is recorded", () => {
    expect(movedNote(late, 0, 0, pattern([late]))).toBeUndefined();
  });

  it("changes the pitch by semitone rows, in the spelling the format accepts", () => {
    expect(movedNote(late, 0, 1, pattern([late]))?.pitch).toBe("A#1");
    expect(movedNote(late, 0, 12, pattern([late]))?.pitch).toBe("A2");
    expect(movedNote(late, 0, -1, pattern([late]))?.pitch).toBe("G#1");
  });

  it("keeps the note's own accidental, so a drag does not respell it", () => {
    // Same principle as snapping the delta rather than the value: the accidental is
    // the author's, and a vertical drag is not a request to rewrite it. `Bb1` and
    // `A#1` are both MIDI 34, so this is inaudible — and still an edit nobody asked
    // for, on a document `fmt` is careful to leave spelled as written.
    const flat: NoteEvent = { pitch: "Bb1", startTick: 480, durationTicks: 240, velocity: 800 };
    expect(movedNote(flat, 0, 1, pattern([flat]))?.pitch).toBe("B1");
    expect(movedNote(flat, 0, -2, pattern([flat]))?.pitch).toBe("Ab1");
    expect(movedNote(flat, 0, 12, pattern([flat]))?.pitch).toBe("Bb2");
    expect(movedNote(flat, 0, -12, pattern([flat]))?.pitch).toBe("Bb0");

    const sharp: NoteEvent = { ...flat, pitch: "A#1" };
    expect(movedNote(sharp, 0, 1, pattern([sharp]))?.pitch).toBe("B1");
    expect(movedNote(sharp, 0, -2, pattern([sharp]))?.pitch).toBe("G#1");
    expect(movedNote(sharp, 0, 12, pattern([sharp]))?.pitch).toBe("A#2");

    // A note with no accidental has none to keep, and is unaffected.
    const natural: NoteEvent = { ...flat, pitch: "A1" };
    expect(movedNote(natural, 0, 1, pattern([natural]))?.pitch).toBe("A#1");
    expect(movedNote(natural, 0, -1, pattern([natural]))?.pitch).toBe("G#1");

    // And a horizontal-only drag reports no pitch change at all for any of them.
    for (const note of [flat, sharp, natural]) {
      expect(movedNote(note, SIXTEENTH, 0, pattern([note])), note.pitch).toEqual({
        startTick: 720,
        pitch: note.pitch,
      });
    }
  });

  it("names only the fields it changes, so expression rides along untouched", () => {
    const change = movedNote(late, SIXTEENTH, 2, pattern([late]));

    expect(Object.keys(change!).sort()).toEqual(["pitch", "startTick"]);
    // The merge is the store's job, but the shape is what makes it safe: nothing
    // here can drop `microTicks`, `velocity`, `probability` or `ratchet`.
    expect(change).not.toHaveProperty("microTicks");
  });

  it("keeps the note inside its pattern", () => {
    const last: NoteEvent = { pitch: "C2", startTick: 7440, durationTicks: 240, velocity: 800 };
    expect(movedNote(last, BAR_TICKS, 0, pattern([last]))?.startTick).toBe(7679);
    const first: NoteEvent = { pitch: "C2", startTick: 120, durationTicks: 240, velocity: 800 };
    expect(movedNote(first, -BAR_TICKS, 0, pattern([first]))?.startTick).toBe(0);
  });

  it("clamps a pitch dragged past the ends of the keyboard", () => {
    const high: NoteEvent = { pitch: "G9", startTick: 0, durationTicks: 240, velocity: 800 };
    expect(movedNote(high, 0, 5, pattern([high]))).toBeUndefined();
    const low: NoteEvent = { pitch: "C-1", startTick: 240, durationTicks: 240, velocity: 800 };
    expect(movedNote(low, 0, -5, pattern([low]))).toBeUndefined();
  });
});

describe("resizing a note", () => {
  const note: NoteEvent = { pitch: "A1", startTick: 0, durationTicks: 720, velocity: 900 };

  it("changes only the length, by whole grid units", () => {
    expect(resizedNote(note, SIXTEENTH, SIXTEENTH)).toEqual({ durationTicks: 960 });
    expect(resizedNote(note, -SIXTEENTH, SIXTEENTH)).toEqual({ durationTicks: 480 });
    expect(resizedNote(note, 0, SIXTEENTH)).toBeUndefined();
  });

  it("never shortens a note out of existence", () => {
    expect(resizedNote(note, -BAR_TICKS, SIXTEENTH)).toEqual({ durationTicks: SIXTEENTH });
    expect(resizedNote(note, -BAR_TICKS, 1)).toEqual({ durationTicks: 1 });
  });
});

describe("the pitch rows on show", () => {
  it("covers the pattern's notes with an octave of headroom either side", () => {
    const notes: NoteEvent[] = [
      { pitch: "A1", startTick: 0, durationTicks: 240, velocity: 800 },
      { pitch: "C2", startTick: 240, durationTicks: 240, velocity: 800 },
    ];
    const range = pitchRange(pattern(notes));

    expect(range.low).toBe(pitchToMidi("A0"));
    expect(range.high).toBe(pitchToMidi("C3"));
  });

  it("opens around middle C for an empty pattern", () => {
    const range = pitchRange(pattern([]));
    expect(range.low).toBe(48);
    expect(range.high).toBe(72);
    expect(range.low).toBeLessThan(60);
    expect(range.high).toBeGreaterThan(60);
  });

  it("stays inside the representable range at the extremes", () => {
    const top = pitchRange(pattern([{ pitch: "G9", startTick: 0, durationTicks: 240, velocity: 800 }]));
    expect(top.high).toBe(127);
    const bottom = pitchRange(pattern([{ pitch: "C-1", startTick: 0, durationTicks: 240, velocity: 800 }]));
    expect(bottom.low).toBe(0);
  });

  it("ignores a pitch the grammar rejects rather than throwing on a bad document", () => {
    const range = pitchRange(pattern([{ pitch: "H9", startTick: 0, durationTicks: 240, velocity: 800 }]));
    expect(range).toEqual({ low: 48, high: 72 });
  });

  it("widens without narrowing, so the rows do not shift under the pointer", () => {
    // What `widerOf` is for: dragging a note up an octave, or deleting the highest
    // one, must not resize the canvas and move whatever the user was about to click.
    const before = pitchRange(pattern([{ pitch: "A1", startTick: 0, durationTicks: 240, velocity: 800 }]));
    const after = pitchRange(pattern([{ pitch: "A2", startTick: 0, durationTicks: 240, velocity: 800 }]));

    expect(widerOf(before, after)).toEqual({ low: before.low, high: after.high });
    expect(widerOf(after, before)).toEqual(widerOf(before, after));
    expect(widerOf(before, before)).toEqual(before);
  });
});

describe("the playhead", () => {
  it("converts samples to ticks with the compiler's own tempo factor", () => {
    // 124 BPM at 960 PPQN and 48 kHz: a quarter note is 60/124 s = 23225.8… samples.
    const perQuarter = (60 / 124) * 48_000;
    expect(songTickAt(project, 48_000, perQuarter)).toBeCloseTo(960, 6);
    expect(songTickAt(project, 48_000, 0)).toBe(0);
  });

  it("finds the pattern-local position inside a repeating clip", () => {
    // The fixture plays drums-verse (one bar) sixteen times from tick 0.
    expect(patternPlayhead(project, "drums", "drums-verse", 0)).toEqual({
      localTick: 0,
      repeatIndex: 0,
      clipStartTick: 0,
    });
    expect(patternPlayhead(project, "drums", "drums-verse", BAR_TICKS + 480)).toEqual({
      localTick: 480,
      repeatIndex: 1,
      clipStartTick: 0,
    });
  });

  it("offsets by the clip's start, so a later clip is not read as bar one", () => {
    // The bass clip starts at bar 5 (tick 15360) and repeats six times.
    expect(patternPlayhead(project, "bass", "bass-main", 15_360)?.localTick).toBe(0);
    expect(patternPlayhead(project, "bass", "bass-main", 15_360 + 900)?.localTick).toBe(900);
    expect(patternPlayhead(project, "bass", "bass-main", 15_360 + 7680 + 60)).toEqual({
      localTick: 60,
      repeatIndex: 1,
      clipStartTick: 15_360,
    });
  });

  it("reads a transport status straight through to a pattern-local tick", () => {
    // What `PatternPlayhead` calls on every worklet report, composed once here so
    // the component holds nothing but the subscription.
    const perQuarter = (60 / 124) * 48_000;
    expect(livePatternTick(project, "drums", "drums-verse", playingAt(perQuarter))).toBeCloseTo(960, 6);
    expect(livePatternTick(project, "bass", "bass-main", playingAt(perQuarter))).toBeUndefined();
    expect(livePatternTick(project, "bass", "bass-main", playingAt(perQuarter * 16))).toBeCloseTo(0, 6);
  });

  it("gives back the same snapshot for a report that did not move it", () => {
    // `PatternPlayhead` hands this to `useSyncExternalStore`, which compares
    // snapshots with `Object.is`: a report that changes the meters but not the
    // position must therefore re-render nothing at all. A snapshot that were a
    // fresh object each call would re-render on every report instead — and would
    // trip React's own "the result of getSnapshot should be cached" check.
    const report = playingAt(12_345);
    const louder: PlayerStatus = { ...report, peak: 0.9, activeVoices: 4, reports: 2, underrunBlocks: 1 };
    const tick = livePatternTick(project, "drums", "drums-verse", report);

    expect(typeof tick).toBe("number");
    expect(livePatternTick(project, "drums", "drums-verse", louder)).toBe(tick);
    // And "not playing" is the same `undefined` every time, so a stopped transport
    // does not re-render a playhead either.
    const stopped: PlayerStatus = { ...report, phase: "stopped" };
    expect(livePatternTick(project, "drums", "drums-verse", stopped)).toBe(
      livePatternTick(project, "drums", "drums-verse", { ...stopped, peak: 0 }),
    );
  });

  it("has no position unless the transport is playing with a known sample rate", () => {
    // Three ways there is no line to draw, and the caller asks one question.
    const playing = playingAt(0);
    expect(livePatternTick(project, "drums", "drums-verse", playing)).toBe(0);
    for (const phase of ["idle", "starting", "stopped", "failed"] as const) {
      expect(livePatternTick(project, "drums", "drums-verse", { ...playing, phase }), phase).toBeUndefined();
    }
    expect(livePatternTick(project, "drums", "drums-verse", { ...playing, sampleRate: null })).toBeUndefined();
  });

  it("has no position when no clip of that pattern is playing", () => {
    expect(patternPlayhead(project, "bass", "bass-main", 0)).toBeUndefined();
    // Past the last repetition: 15360 + 6 × 7680 = 61440.
    expect(patternPlayhead(project, "bass", "bass-main", 61_440)).toBeUndefined();
    expect(patternPlayhead(project, "bass", "bass-main", 61_439)).toBeDefined();
    // The right pattern on the wrong track is not playing either.
    expect(patternPlayhead(project, "drums", "bass-main", 15_360)).toBeUndefined();
  });
});
