import { parseSteps, type GridPatternDoc, type NoteEvent, type NotesPatternDoc } from "@chord-garden/format/pure";
import { describe, expect, it } from "vitest";
import { createDocumentStore, type DocumentSink, type DocumentStore, type PendingFile } from "../src/store/documentStore";
import { FIXTURE, openedFrom } from "./fixture";

/**
 * What the grid and note editors do to the document.
 *
 * Asserted on the canonical bytes the store would write rather than on the model,
 * because the bytes are the artefact: `test/byteIdentity.test.ts` proves those bytes
 * are what `musictool fmt` would produce, and everything here is about what is *in*
 * them. The failure this file exists to catch is the quiet one — an unrelated
 * `stepEvents` entry, a `defaults` block or a note's `microTicks` disappearing
 * because an editor rebuilt a document instead of editing it.
 */

const DRUMS = "patterns/drums-verse.json";
const BASS = "patterns/bass-main.json";

class NullSink implements DocumentSink {
  readonly batches: PendingFile[][] = [];
  async write(files: readonly PendingFile[]) {
    this.batches.push(files.map((file) => ({ ...file })));
    return { diagnostics: [] };
  }
}

function open(): DocumentStore {
  const store = createDocumentStore({ sink: new NullSink(), debounceMs: 10_000 });
  store.getState().open(openedFrom(FIXTURE));
  return store;
}

/**
 * The fixture with the `hat` lane taken out — a project whose kit has a voice its
 * pattern does not use. It is a perfectly ordinary document (an agent deleting a
 * lane produces one), and the only way to reach the "voice with no lane" state from
 * this fixture, since no store action removes a lane.
 */
function openWithoutHatLane(): DocumentStore {
  const store = createDocumentStore({ sink: new NullSink(), debounceMs: 10_000 });
  const loaded = openedFrom(FIXTURE);
  const pattern = loaded.project.patterns.get("drums-verse");
  if (pattern?.kind !== "grid") throw new Error("fixture lost its grid pattern");
  pattern.lanes = pattern.lanes.filter((lane) => lane.lane !== "hat");
  store.getState().open(loaded);
  return store;
}

/** The canonical bytes of one document as the store currently holds them. */
function bytes(store: DocumentStore, path: string): string {
  const text = store.getState().canonical.get(path);
  if (text === undefined) throw new Error(`no canonical bytes for "${path}"`);
  return text;
}

function grid(store: DocumentStore, id = "drums-verse"): GridPatternDoc {
  const pattern = store.getState().project!.patterns.get(id);
  if (pattern?.kind !== "grid") throw new Error(`"${id}" is not a grid pattern`);
  return pattern;
}

function notes(store: DocumentStore, id = "bass-main"): NotesPatternDoc {
  const pattern = store.getState().project!.patterns.get(id);
  if (pattern?.kind !== "notes") throw new Error(`"${id}" is not a note pattern`);
  return pattern;
}

function laneOf(store: DocumentStore, name: string) {
  const lane = grid(store).lanes.find((entry) => entry.lane === name);
  if (lane === undefined) throw new Error(`no lane "${name}"`);
  return lane;
}

function hits(store: DocumentStore, name: string): number[] {
  const lane = laneOf(store, name);
  const parsed = parseSteps(lane.steps, { file: DRUMS, pointer: "", stepsPerBar: lane.grid.stepsPerBar, bars: 1 });
  if (parsed.hits === undefined) throw new Error(`lane "${name}" does not parse`);
  return parsed.hits;
}

/** The document as JSON, with one lane's `steps` string removed. */
function withoutSteps(text: string, laneName: string): unknown {
  const doc = JSON.parse(text) as { lanes: { lane: string; steps?: string }[] };
  for (const lane of doc.lanes) if (lane.lane === laneName) delete lane.steps;
  return doc;
}

describe("toggling a grid step", () => {
  it("turns a rest into a hit and back, leaving the bytes exactly as they were", () => {
    const store = open();
    const before = bytes(store, DRUMS);

    // The hat lane is the interesting one: it carries `defaults` (velocity and a
    // swing override) and two `stepEvents`. Step 5 is a rest and carries nothing.
    store.getState().toggleGridStep("drums-verse", "hat", 5, 16);
    expect(hits(store, "hat")).toEqual([0, 2, 4, 5, 6, 8, 10, 12, 14]);
    expect(laneOf(store, "hat").steps).toBe("x.x. xxx. x.x. x.x.");
    expect(bytes(store, DRUMS)).not.toBe(before);

    store.getState().toggleGridStep("drums-verse", "hat", 5, 16);

    expect(bytes(store, DRUMS)).toBe(before);
    expect(store.getState().dirty).toEqual([]);
  });

  it("is byte-reversible on every step that carries no overrides", () => {
    // The general form of the test above. Any step of any lane, toggled twice,
    // must land on the bytes it started from — which is only true if the editor
    // rewrites the placement string and nothing else.
    const store = open();
    const before = bytes(store, DRUMS);
    const overridden = new Set(
      grid(store).lanes.flatMap((lane) => (lane.stepEvents ?? []).map((event) => `${lane.lane}/${event.step}`)),
    );

    let checked = 0;
    for (const lane of grid(store).lanes) {
      for (let step = 0; step < lane.grid.stepsPerBar; step++) {
        if (overridden.has(`${lane.lane}/${step}`)) continue;
        store.getState().toggleGridStep("drums-verse", lane.lane, step, lane.grid.stepsPerBar);
        expect(bytes(store, DRUMS), `${lane.lane} step ${step} after one toggle`).not.toBe(before);
        store.getState().toggleGridStep("drums-verse", lane.lane, step, lane.grid.stepsPerBar);
        expect(bytes(store, DRUMS), `${lane.lane} step ${step} after two toggles`).toBe(before);
        checked++;
      }
    }
    expect(checked).toBe(30);
  });

  it("leaves defaults, swing, stepEvents, probability, ratchets and micro-timing untouched", () => {
    const store = open();
    const before = bytes(store, DRUMS);

    store.getState().toggleGridStep("drums-verse", "hat", 5, 16);
    const after = bytes(store, DRUMS);

    // Everything except the one lane's placement string is identical, field for
    // field — including the `stepEvents` entries for steps 2 and 8, which carry
    // velocity, probability, microTicks, gateTicks and a ratchet between them.
    expect(withoutSteps(after, "hat")).toEqual(withoutSteps(before, "hat"));
    // And literally: one line differs in the whole file.
    const changedLines = after
      .split("\n")
      .filter((line, index) => line !== before.split("\n")[index]);
    expect(changedLines).toEqual(['      "steps": "x.x. xxx. x.x. x.x.",']);
    expect(after).toContain('"swing": 120');
    expect(after).toContain('"ratchet": 2');
    expect(after).toContain('"microTicks": -12');
    expect(after).toContain('"probability": 800');
  });

  it("takes a step's overrides with it when the hit is cleared, and only that step's", () => {
    // Not data loss by accident: `pattern.step-event-not-a-hit` makes an override
    // on a rest an invalid document, so there is no way to keep them. The UI marks
    // such a step and its tooltip says what clicking it will do.
    const store = open();

    store.getState().toggleGridStep("drums-verse", "hat", 2, 16);

    const lane = laneOf(store, "hat");
    expect(lane.stepEvents?.map((event) => event.step)).toEqual([8]);
    expect(lane.stepEvents?.[0]).toEqual({ step: 8, microTicks: -12, gateTicks: 120, ratchet: 2 });
    expect(lane.defaults).toEqual({ velocity: 600, swing: 120 });
  });

  it("drops the stepEvents array entirely when its last entry goes", () => {
    const store = open();

    store.getState().toggleGridStep("drums-verse", "hat", 2, 16);
    store.getState().toggleGridStep("drums-verse", "hat", 8, 16);

    expect(laneOf(store, "hat").stepEvents).toBeUndefined();
    expect(bytes(store, DRUMS)).not.toContain("stepEvents");
  });

  it("creates a lane for a kit voice the pattern does not use yet", () => {
    const store = openWithoutHatLane();
    expect(grid(store).lanes.map((lane) => lane.lane)).toEqual(["kick"]);

    store.getState().toggleGridStep("drums-verse", "hat", 4, 16);

    const lane = laneOf(store, "hat");
    expect(lane.grid.stepsPerBar).toBe(16);
    expect(lane.steps).toBe(".... x... .... ....");
    expect(lane.defaults).toBeUndefined();
    expect(lane.stepEvents).toBeUndefined();
    // Appended, not inserted: `fmt` does not reorder `lanes`, so the new lane's
    // position is the one the editor gave it (docs/format-spec.md §5.2).
    expect(grid(store).lanes.map((entry) => entry.lane)).toEqual(["kick", "hat"]);
    expect(bytes(store, DRUMS)).toContain('"steps": ".... x... .... ...."');
  });

  it("creates the lane at the resolution the caller asked for", () => {
    const store = openWithoutHatLane();

    store.getState().toggleGridStep("drums-verse", "hat", 3, 8);

    expect(laneOf(store, "hat").grid.stepsPerBar).toBe(8);
    expect(laneOf(store, "hat").steps).toBe("...x ....");
  });

  it("refuses a lane for a voice no kit playing this pattern has", () => {
    const store = open();

    expect(() => store.getState().toggleGridStep("drums-verse", "clap", 0, 16)).toThrow(/no such voice/);
    expect(store.getState().dirty).toEqual([]);
  });

  it("refuses a step index the lane does not have, rather than padding the string", () => {
    const store = open();

    expect(() => store.getState().toggleGridStep("drums-verse", "kick", 16, 16)).toThrow(/steps 0\.\.15/);
    expect(() => store.getState().toggleGridStep("drums-verse", "kick", -1, 16)).toThrow(/steps 0\.\.15/);
    expect(() => store.getState().toggleGridStep("drums-verse", "kick", 1.5, 16)).toThrow(/steps 0\.\.15/);
    expect(store.getState().dirty).toEqual([]);
  });

  it("refuses a grid that does not divide a bar into whole ticks", () => {
    const store = openWithoutHatLane();

    // 3840 ticks per bar over 7 steps is 548.57…, and a grid step must be a whole
    // number of ticks (docs/format-spec.md §5).
    expect(() => store.getState().toggleGridStep("drums-verse", "hat", 0, 7)).toThrow(/3840 ticks evenly/);
    expect(store.getState().dirty).toEqual([]);
  });

  it("keeps the lane's own resolution when the caller's differs", () => {
    // A 32-step lane clicked from a 16-cell display: the lane's grid decides what
    // step 3 means, not the caller's idea of the display resolution.
    const store = open();
    store.getState().setPatternLaneSteps("drums-verse", "kick", "x..x ..x. x..x ..x.");

    store.getState().toggleGridStep("drums-verse", "kick", 3, 32);

    expect(laneOf(store, "kick").grid.stepsPerBar).toBe(16);
    expect(hits(store, "kick")).toEqual([0, 6, 8, 11, 14]);
  });
});

/**
 * The off-by-one the grammar exists to prevent.
 *
 * `canonicalFiles` re-derives every `steps` string from its parsed hit set, so a UI
 * that hand-formatted the string would still write canonical bytes and the
 * byte-identity test would not notice. What a byte comparison cannot catch is an
 * editor that treats a character offset as a step index: spaces and `|` are not
 * steps, so on a hand-spaced string the two disagree, and the *wrong step moves*.
 * These are the cases with teeth against that.
 */
describe("a step index is a step, not a character offset", () => {
  /** The fixture's kick lane, respaced by hand and with a bar separator. */
  const HAND_SPACED = "x..x  ..x.x..x   ..x. |";

  it("toggles the step the grammar names, whatever the spacing on disk", () => {
    const store = open();
    store.getState().setPatternLaneSteps("drums-verse", "kick", HAND_SPACED);
    expect(laneOf(store, "kick").steps).toBe(HAND_SPACED);
    expect(hits(store, "kick")).toEqual([0, 3, 6, 8, 11, 14]);

    // Character 5 of that string is a space, and character 6 is a `.` belonging to
    // step 4. An implementation indexing the raw string moves neither step 5 nor
    // anything sensible.
    store.getState().toggleGridStep("drums-verse", "kick", 5, 16);

    expect(hits(store, "kick")).toEqual([0, 3, 5, 6, 8, 11, 14]);
  });

  it("toggles every step of a hand-spaced lane to exactly the intended index", () => {
    const store = open();

    for (let step = 0; step < 16; step++) {
      store.getState().setPatternLaneSteps("drums-verse", "kick", HAND_SPACED);
      const before = new Set(hits(store, "kick"));

      store.getState().toggleGridStep("drums-verse", "kick", step, 16);

      const after = new Set(hits(store, "kick"));
      const added = [...after].filter((hit) => !before.has(hit));
      const removed = [...before].filter((hit) => !after.has(hit));
      expect([...added, ...removed], `step ${step}`).toEqual([step]);
    }
  });

  it("rewrites the string in the canonical grouping, not the one it found", () => {
    const store = open();
    store.getState().setPatternLaneSteps("drums-verse", "kick", HAND_SPACED);

    store.getState().toggleGridStep("drums-verse", "kick", 5, 16);

    // `fmt` owns spacing (docs/format-spec.md §5.2), and the editor's output is
    // already what it would write, bar separator and stray spaces gone.
    expect(laneOf(store, "kick").steps).toBe("x..x .xx. x..x ..x.");
  });

  it("refuses a string whose step count does not match the grid, rather than padding it", () => {
    const store = open();

    expect(() => store.getState().setPatternLaneSteps("drums-verse", "kick", "x..x ..x. x..x")).toThrow(
      /12 steps but stepsPerBar\*bars = 16/,
    );
    expect(() => store.getState().setPatternLaneSteps("drums-verse", "kick", "X..x ..x. x..x ..x.")).toThrow(
      /accented trigger/,
    );
    expect(store.getState().dirty).toEqual([]);
  });
});

describe("editing a step's expression", () => {
  it("adds an overrides entry to a hit that had none", () => {
    const store = open();

    store.getState().setStepEvent("drums-verse", "kick", 3, { velocity: 950, ratchet: 3 });

    expect(laneOf(store, "kick").stepEvents).toEqual([{ step: 3, velocity: 950, ratchet: 3 }]);
    expect(bytes(store, DRUMS)).toContain('"velocity": 950');
  });

  it("merges into an existing entry and clears one field at a time", () => {
    const store = open();

    store.getState().setStepEvent("drums-verse", "hat", 2, { microTicks: 6 });
    expect(laneOf(store, "hat").stepEvents?.[0]).toEqual({ step: 2, velocity: 350, probability: 800, microTicks: 6 });

    store.getState().setStepEvent("drums-verse", "hat", 2, { probability: undefined });
    expect(laneOf(store, "hat").stepEvents?.[0]).toEqual({ step: 2, velocity: 350, microTicks: 6 });
  });

  it("removes an entry that has stopped overriding anything", () => {
    const store = open();

    store.getState().setStepEvent("drums-verse", "hat", 2, {
      velocity: undefined,
      probability: undefined,
    });

    expect(laneOf(store, "hat").stepEvents?.map((event) => event.step)).toEqual([8]);
  });

  it("refuses overrides on a rest, which no valid document can express", () => {
    const store = open();

    expect(() => store.getState().setStepEvent("drums-verse", "kick", 1, { velocity: 500 })).toThrow(/that step is a rest/);
  });

  it("refuses values the format cannot hold", () => {
    const store = open();

    expect(() => store.getState().setStepEvent("drums-verse", "kick", 3, { velocity: 1200 })).toThrow(/0\.\.1000/);
    expect(() => store.getState().setStepEvent("drums-verse", "kick", 3, { velocity: 12.5 })).toThrow(/integer/);
    expect(() => store.getState().setStepEvent("drums-verse", "kick", 3, { ratchet: 0 })).toThrow(/at least 1/);
    // The refusal names the range as well as the bound, because the box the value
    // was typed into is about to show this message and "gateTicks must be at
    // least 1" alone does not say what unit it is counting.
    expect(() => store.getState().setStepEvent("drums-verse", "kick", 3, { gateTicks: 0 })).toThrow(/ticks ≥ 1/);
    expect(store.getState().dirty).toEqual([]);
  });
});

describe("editing notes", () => {
  it("adds a note without disturbing the ones already there", () => {
    const store = open();
    const before = notes(store).notes.map((note) => ({ ...note }));

    store.getState().addNote("bass-main", { pitch: "E2", startTick: 3840, durationTicks: 480, velocity: 750 });

    const after = notes(store).notes;
    expect(after).toHaveLength(4);
    // Every original note, field for field, including the microTicks on the second
    // and the probability on the third.
    for (const note of before) {
      expect(after).toContainEqual(note);
    }
    expect(bytes(store, BASS)).toContain('"microTicks": -8');
    expect(bytes(store, BASS)).toContain('"probability": 800');
  });

  it("moves a note and keeps its expression fields", () => {
    const store = open();
    const original = notes(store).notes[1]!;
    expect(original).toEqual({ pitch: "A1", startTick: 960, durationTicks: 480, velocity: 700, microTicks: -8 });

    store.getState().updateNote("bass-main", 1, { startTick: 1440, pitch: "C2" });

    expect(notes(store).notes[1]).toEqual({
      pitch: "C2",
      startTick: 1440,
      durationTicks: 480,
      velocity: 700,
      microTicks: -8,
    });
  });

  it("resizes a note without touching its start or its pitch", () => {
    const store = open();

    store.getState().updateNote("bass-main", 0, { durationTicks: 1200 });

    expect(notes(store).notes[0]).toEqual({ pitch: "A1", startTick: 0, durationTicks: 1200, velocity: 900 });
  });

  it("leaves every other note byte-identical when one moves", () => {
    const store = open();
    const before = JSON.parse(bytes(store, BASS)) as { notes: NoteEvent[] };

    store.getState().updateNote("bass-main", 0, { startTick: 1920 });

    const after = JSON.parse(bytes(store, BASS)) as { notes: NoteEvent[] };
    const untouched = (list: NoteEvent[]) => list.filter((note) => !(note.pitch === "A1" && note.durationTicks === 720));
    // Compared as sets: canonical order sorts by start, then pitch, then length
    // (docs/format-spec.md §5.2), so moving a note legitimately reorders the array.
    expect(untouched(after.notes)).toEqual(untouched(before.notes));
    expect(after.notes.find((note) => note.durationTicks === 720)?.startTick).toBe(1920);
  });

  it("deletes only the note asked for", () => {
    const store = open();
    const before = notes(store).notes.map((note) => ({ ...note }));

    store.getState().deleteNote("bass-main", 1);

    expect(notes(store).notes).toEqual([before[0], before[2]]);
  });

  it("clears an optional field without inventing a value for it", () => {
    const store = open();

    store.getState().updateNote("bass-main", 1, { microTicks: undefined });

    expect(notes(store).notes[1]).toEqual({ pitch: "A1", startTick: 960, durationTicks: 480, velocity: 700 });
    expect(bytes(store, BASS)).not.toContain("microTicks");
  });

  it("refuses to remove a field every note must have", () => {
    const store = open();

    // `NotePatch` will not let a TypeScript caller ask for this at all, which is why
    // the cast is here; the runtime guard exists for the callers types cannot reach.
    expect(() => store.getState().updateNote("bass-main", 0, { velocity: undefined } as never)).toThrow(
      /required note field/,
    );
    expect(() => store.getState().updateNote("bass-main", 0, { pitch: undefined } as never)).toThrow(
      /required note field/,
    );
    expect(store.getState().dirty).toEqual([]);
  });

  it("refuses a pitch the grammar does not accept, or one outside the MIDI range", () => {
    const store = open();

    expect(() => store.getState().updateNote("bass-main", 0, { pitch: "H2" })).toThrow(/not a pitch name/);
    expect(() => store.getState().updateNote("bass-main", 0, { pitch: "Cb-1" })).toThrow(/C-1\.\.G9/);
    expect(() => store.getState().addNote("bass-main", { pitch: "a4", startTick: 0, durationTicks: 240, velocity: 800 })).toThrow(
      /not a pitch name/,
    );
    expect(store.getState().dirty).toEqual([]);
  });

  it("refuses a note that would start past the end of its pattern", () => {
    const store = open();

    expect(() =>
      store.getState().addNote("bass-main", { pitch: "A1", startTick: 7680, durationTicks: 240, velocity: 800 }),
    ).toThrow(/past the end/);
    expect(() => store.getState().updateNote("bass-main", 0, { durationTicks: 0 })).toThrow(/positive integer/);
    expect(() => store.getState().updateNote("bass-main", 0, { startTick: -1 })).toThrow(/non-negative/);
  });

  it("refuses a fractional tick, because the file may not hold one", () => {
    const store = open();

    expect(() => store.getState().updateNote("bass-main", 0, { startTick: 100.5 })).toThrow(/integer/);
    expect(() => store.getState().updateNote("bass-main", 0, { microTicks: 0.5 })).toThrow(/integer/);
    expect(() => store.getState().updateNote("bass-main", 0, { velocity: 800.5 })).toThrow(/integer/);
  });

  it("refuses an index that is not there", () => {
    const store = open();

    expect(() => store.getState().updateNote("bass-main", 9, { velocity: 100 })).toThrow(/has 3 notes/);
    expect(() => store.getState().deleteNote("bass-main", 9)).toThrow(/has 3 notes/);
  });

  it("refuses to treat a grid pattern as a note list, and the reverse", () => {
    const store = open();

    expect(() => store.getState().addNote("drums-verse", { pitch: "C4", startTick: 0, durationTicks: 240, velocity: 800 })).toThrow(
      /not a note list/,
    );
    expect(() => store.getState().toggleGridStep("bass-main", "kick", 0, 16)).toThrow(/not a grid/);
  });
});

describe("what each edit means to a running transport", () => {
  it("classifies an edit that moves, adds or removes an event as structural", () => {
    const store = open();
    const effects: string[] = [];
    const record = () => effects.push(store.getState().audioEdit!.effect);

    store.getState().toggleGridStep("drums-verse", "kick", 1, 16);
    record();
    store.getState().setStepEvent("drums-verse", "kick", 1, { velocity: 900 });
    record();
    store.getState().addNote("bass-main", { pitch: "G2", startTick: 480, durationTicks: 240, velocity: 800 });
    record();
    store.getState().updateNote("bass-main", 0, { startTick: 240 });
    record();
    store.getState().deleteNote("bass-main", 0);
    record();
    store.getState().setTempoBpmX100(13_000);
    record();

    expect(effects).toEqual(Array.from({ length: 6 }, () => "structural"));
  });

  it("classifies an edit no engine can hear as none", () => {
    const store = open();

    store.getState().setProjectName("Renamed");

    expect(store.getState().audioEdit?.effect).toBe("none");
  });

  it("carries the model the edit produced, and a revision that only moves forward", () => {
    const store = open();

    store.getState().toggleGridStep("drums-verse", "kick", 1, 16);
    const first = store.getState().audioEdit!;
    expect(first.project).toBe(store.getState().project);

    store.getState().toggleGridStep("drums-verse", "kick", 2, 16);
    const second = store.getState().audioEdit!;

    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.project).not.toBe(first.project);
    // The snapshot the first edit produced is still intact, which is what lets a
    // scheduler hold one while the document moves on (PLAN.md §12 step 6).
    expect(first.project.patterns.get("drums-verse")).not.toBe(second.project.patterns.get("drums-verse"));
  });

  it("does not report an edit for a refused one", () => {
    const store = open();
    store.getState().toggleGridStep("drums-verse", "kick", 1, 16);
    const before = store.getState().audioEdit;

    expect(() => store.getState().updateNote("bass-main", 0, { pitch: "nope" })).toThrow();

    expect(store.getState().audioEdit).toBe(before);
  });

  it("is cleared by reopening the project", () => {
    const store = open();
    store.getState().toggleGridStep("drums-verse", "kick", 1, 16);
    expect(store.getState().audioEdit).toBeDefined();

    store.getState().open(openedFrom(FIXTURE));

    expect(store.getState().audioEdit).toBeUndefined();
  });
});
