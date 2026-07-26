import { describe, expect, it } from "vitest";
import { HIGHEST_MIDI, LOWEST_MIDI, midiToPitch, pitchToMidi, transposePitch } from "../src/pitch.js";

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

describe("transposing a name", () => {
  it("keeps a flat spelling flat, in both directions", () => {
    // The bug this function exists for: an editor that moved a note through
    // `pitchToMidi` and back turned every `Bb` in the file into an `A#`, which is
    // the same sound and an edit the author did not ask for.
    expect(transposePitch("Bb1", 1)).toBe("B1");
    expect(transposePitch("Bb1", 2)).toBe("C2");
    expect(transposePitch("Bb1", -1)).toBe("A1");
    expect(transposePitch("Bb1", -2)).toBe("Ab1");
    expect(transposePitch("Bb1", 12)).toBe("Bb2");
    expect(transposePitch("Bb1", -12)).toBe("Bb0");
    // Every accidental it lands on is a flat, never a sharp.
    expect(transposePitch("Eb3", 1)).toBe("E3");
    expect(transposePitch("Eb3", -1)).toBe("D3");
    expect(transposePitch("Eb3", -2)).toBe("Db3");
    expect(transposePitch("Eb3", 3)).toBe("Gb3");
  });

  it("keeps a sharp spelling sharp, in both directions", () => {
    expect(transposePitch("A#1", 1)).toBe("B1");
    expect(transposePitch("A#1", -2)).toBe("G#1");
    expect(transposePitch("A#1", 12)).toBe("A#2");
    expect(transposePitch("F#4", 5)).toBe("B4");
    expect(transposePitch("F#4", -1)).toBe("F4");
  });

  it("names a natural's neighbours with sharps, as `midiToPitch` does", () => {
    // A note with no accidental has no preference to preserve, so nothing changes
    // for it: the roll's existing behaviour, and the only spelling `midiToPitch`
    // has ever emitted.
    for (const [name, semitones] of [
      ["A1", 1],
      ["C4", 1],
      ["E2", -1],
      ["G3", 6],
    ] as const) {
      const midi = pitchToMidi(name)! + semitones;
      expect(transposePitch(name, semitones), `${name} by ${semitones}`).toBe(midiToPitch(midi));
    }
    expect(transposePitch("A1", 1)).toBe("A#1");
    expect(transposePitch("E2", -1)).toBe("D#2");
  });

  it("moves by the number of semitones asked for, whatever the spelling", () => {
    // The property that would catch a flat table one row out: the result is always
    // the same *sound* as a sharp-spelled move, only spelled differently.
    for (const name of ["Bb1", "Db4", "Gb2", "Ab0", "Eb6", "A#1", "C4", "F5"]) {
      const from = pitchToMidi(name)!;
      for (let semitones = -14; semitones <= 14; semitones++) {
        const moved = transposePitch(name, semitones)!;
        const expected = Math.max(LOWEST_MIDI, Math.min(HIGHEST_MIDI, from + semitones));
        expect(pitchToMidi(moved), `${name} by ${semitones} → ${moved}`).toBe(expected);
      }
    }
  });

  it("clamps at the ends of the keyboard instead of naming the unnameable", () => {
    expect(transposePitch("G9", 5)).toBe("G9");
    expect(transposePitch("C-1", -5)).toBe("C-1");
    // A flat at the bottom clamps to the same note either spelling calls C-1.
    expect(transposePitch("Db-1", -5)).toBe("C-1");
  });

  it("returns the name unchanged for a move of nothing", () => {
    expect(transposePitch("Bb1", 0)).toBe("Bb1");
    expect(transposePitch("A1", 0)).toBe("A1");
    // Including for a grammatical name outside the representable range, which a
    // horizontal-only drag must not quietly pull into range behind the author.
    expect(transposePitch("A9", 0)).toBe("A9");
  });

  it("refuses a name outside the grammar rather than guessing", () => {
    for (const bad of ["bb2", "Gbb2", "H4", "C♯4", "", "33"]) {
      expect(transposePitch(bad, 1), bad).toBeUndefined();
    }
  });

  it("never emits a name the grammar rejects", () => {
    // In particular never `Cb` or `Fb`: the flat table keeps the seven naturals
    // spelled as letters, so no result can leave its own octave.
    for (let midi = LOWEST_MIDI; midi <= HIGHEST_MIDI; midi++) {
      for (const style of [midiToPitch(midi), transposePitch("Bb4", midi - pitchToMidi("Bb4")!)!]) {
        expect(style, `${midi}`).toMatch(/^[A-G][#b]?(-1|[0-9])$/);
        expect(pitchToMidi(style), style).toBe(midi);
      }
    }
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
