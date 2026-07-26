import { describe, expect, it } from "vitest";
import { HIGHEST_MIDI, LOWEST_MIDI, midiToPitch, pitchToMidi } from "../src/pitch.js";

/**
 * The pitch grammar and the MIDI convention, from both directions.
 *
 * `midiToPitch` exists so no editor writes its own octave arithmetic, so the
 * tests that matter most are the ones that would catch an octave-out or
 * semitone-out implementation: the anchors docs/format-spec.md §5.1 names, and a
 * round trip across the whole range.
 */

/** Every name the grammar admits, in `^[A-G][#b]?(-1|[0-9])$` order. */
function everyGrammaticalName(): string[] {
  const names: string[] = [];
  for (const octave of ["-1", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
    for (const letter of ["A", "B", "C", "D", "E", "F", "G"]) {
      for (const accidental of ["", "#", "b"]) names.push(`${letter}${accidental}${octave}`);
    }
  }
  return names;
}

describe("pitch names to MIDI numbers", () => {
  it("puts the spec's anchors where the spec says", () => {
    expect(pitchToMidi("C-1")).toBe(0);
    expect(pitchToMidi("A1")).toBe(33);
    expect(pitchToMidi("C4")).toBe(60);
    expect(pitchToMidi("A4")).toBe(69);
    expect(pitchToMidi("G9")).toBe(127);
  });

  it("treats enharmonic spellings as the same note", () => {
    expect(pitchToMidi("A#1")).toBe(34);
    expect(pitchToMidi("Bb1")).toBe(34);
  });

  it("rejects every spelling outside the grammar", () => {
    for (const bad of ["bb2", "Gbb2", "A#10", "C 4", "33", "", "H4", "C♯4", "c4", "C-2", "C10"]) {
      expect(pitchToMidi(bad), bad).toBeUndefined();
    }
  });
});

describe("MIDI numbers to pitch names", () => {
  it("round-trips every representable note", () => {
    for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi++) {
      const name = midiToPitch(midi);
      expect(pitchToMidi(name), `${midi} named "${name}"`).toBe(midi);
    }
  });

  it("names the anchors the way the spec spells them", () => {
    expect(midiToPitch(0)).toBe("C-1");
    expect(midiToPitch(33)).toBe("A1");
    expect(midiToPitch(60)).toBe("C4");
    expect(midiToPitch(69)).toBe("A4");
    expect(midiToPitch(127)).toBe("G9");
  });

  it("produces names the grammar accepts, and only sharps", () => {
    for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi++) {
      expect(midiToPitch(midi)).toMatch(/^[A-G]#?(-1|[0-9])$/);
    }
  });

  it("refuses a number no document could hold, rather than inventing a name", () => {
    for (const bad of [-1, 128, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => midiToPitch(bad), String(bad)).toThrow(/representable range/);
    }
  });

  it("maps a flat spelling to its sharp twin, and back to the same number", () => {
    // The one asymmetry worth stating: naming is not spelling-preserving, so a
    // round trip through a number normalises `Bb1` to `A#1`. Both are MIDI 34,
    // which is why `fmt` may keep either and the compiler hears no difference.
    const midi = pitchToMidi("Bb1")!;
    expect(midiToPitch(midi)).toBe("A#1");
    expect(pitchToMidi(midiToPitch(midi))).toBe(midi);
  });
});

describe("the two functions agree across the whole grammar", () => {
  it("names every in-range grammatical spelling back to its own number", () => {
    let inRange = 0;
    for (const name of everyGrammaticalName()) {
      const midi = pitchToMidi(name);
      expect(midi, name).toBeTypeOf("number");
      if (midi! < LOWEST_MIDI || midi! > HIGHEST_MIDI) {
        // The grammar admits a handful of unrepresentable names (`A9`, `Cb-1`);
        // the validator rejects those as `note.pitch-out-of-range`.
        expect(() => midiToPitch(midi!), name).toThrow();
        continue;
      }
      inRange++;
      expect(pitchToMidi(midiToPitch(midi!)), name).toBe(midi);
    }
    expect(inRange).toBeGreaterThan(200);
  });
});
