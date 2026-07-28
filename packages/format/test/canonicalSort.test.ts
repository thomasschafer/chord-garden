import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalFiles, loadProject } from "../src/index.js";
import { createTempProject } from "./tempProject.js";

/**
 * `fmt`'s two sort orders (docs/format-spec.md §5.2), pinned against inputs
 * whose *given* order, whose string order, and whose canonical order are three
 * different things.
 *
 * The worked-example fixture cannot pin either one: its notes and its clips are
 * already in canonical order on disk, so a comparator that returned 0 for every
 * pair produced byte-identical output through a stable sort. The same blind spot
 * hid the pitch key — the fixture's `A1`, `A1`, `C2` sort the same way whether
 * pitch is read as a MIDI number or compared as a string, so the documented
 * promise of "pitch as a MIDI number" was never actually exercised.
 *
 * The pitches below are chosen so the two disagree in both directions:
 *
 * | pitch | MIDI |
 * |---|---|
 * | `C0`  | 12 |
 * | `A0`  | 21 |
 * | `D1`  | 26 |
 * | `C2`  | 36 |
 * | `Db4` | 61 |
 * | `D4`  | 62 |
 *
 * String order is `A0 < C0 < C2 < D1 < D4 < Db4`, which agrees with MIDI order
 * on no adjacent pair: letters run `C D E F G A B` within an octave, octave
 * numbers are compared as digits after the letter rather than as the outer key,
 * and a flat sorts after the natural it is below.
 */

interface TempNote {
  pitch: string;
  startTick: number;
  durationTicks: number;
}

interface TempClip {
  track: string;
  pattern: string;
  startTick: number;
  repeatCount: number;
}

/** A valid one-instrument project carrying exactly the notes and clips given. */
function projectWith(label: string, tracks: string[], notes: TempNote[], clips: TempClip[]): string {
  const root = createTempProject(label);
  writeFileSync(
    join(root, "project.json"),
    JSON.stringify({
      format: 1,
      name: label,
      ppqn: 960,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: tracks,
    }),
  );
  writeFileSync(
    join(root, "instruments", "s.json"),
    JSON.stringify({ id: "s", type: "synth", engine: "basic-mono" }),
  );
  for (const track of tracks) {
    writeFileSync(
      join(root, "tracks", `${track}.json`),
      JSON.stringify({ id: track, type: "instrument", instrument: "s", patterns: ["p"] }),
    );
  }
  writeFileSync(
    join(root, "patterns", "p.json"),
    JSON.stringify({
      id: "p",
      kind: "notes",
      lengthTicks: 3840,
      // `velocity` is required by the schema and is the same on every note here,
      // so it plays no part in the order under test.
      notes: notes.map((note) => ({ ...note, velocity: 800 })),
    }),
  );
  writeFileSync(join(root, "arrangement.json"), JSON.stringify({ lengthTicks: 7680, clips }));
  return root;
}

/** Loads, canonicalises, and hands back the canonical text of one file. */
function canonicalText(root: string, file: string): string {
  const result = loadProject(root);
  expect(
    result.diagnostics.filter((d) => d.severity === "error"),
    "the sort fixtures must be valid projects, so only the sort is under test",
  ).toEqual([]);
  const text = canonicalFiles(result.project!).get(file);
  expect(text).toBeDefined();
  return text!;
}

describe("canonical note order", () => {
  const NOTES: TempNote[] = [
    { pitch: "D4", startTick: 960, durationTicks: 240 },
    { pitch: "A0", startTick: 0, durationTicks: 240 },
    { pitch: "C2", startTick: 0, durationTicks: 240 },
    { pitch: "Db4", startTick: 960, durationTicks: 240 },
    { pitch: "C0", startTick: 0, durationTicks: 240 },
    { pitch: "D1", startTick: 0, durationTicks: 240 },
    { pitch: "C0", startTick: 0, durationTicks: 120 },
  ];

  /** `pitch` and `durationTicks` of each note, in the order they were written. */
  function canonicalNotes(root: string): [string, number][] {
    const text = canonicalText(root, "patterns/p.json");
    return [...text.matchAll(/"pitch": "([^"]+)",\n\s+"startTick": \d+,\n\s+"durationTicks": (\d+)/g)].map(
      (m) => [m[1]!, Number(m[2]!)],
    );
  }

  it("sorts by startTick, then pitch as a MIDI number, then durationTicks", () => {
    const root = projectWith("note-sort", ["t"], NOTES, [
      { track: "t", pattern: "p", startTick: 0, repeatCount: 1 },
    ]);
    try {
      expect(canonicalNotes(root)).toEqual([
        // startTick 0, ascending MIDI: C0 12, A0 21, D1 26, C2 36.
        ["C0", 120],
        ["C0", 240],
        ["A0", 240],
        ["D1", 240],
        ["C2", 240],
        // startTick 960, ascending MIDI: Db4 61 then D4 62.
        ["Db4", 240],
        ["D4", 240],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not put the notes in the order the file happened to list them", () => {
    const root = projectWith("note-sort-input", ["t"], NOTES, [
      { track: "t", pattern: "p", startTick: 0, repeatCount: 1 },
    ]);
    try {
      expect(canonicalNotes(root).map(([pitch]) => pitch)).not.toEqual(NOTES.map((n) => n.pitch));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not order pitches the way a string comparison would", () => {
    const root = projectWith("note-sort-string", ["t"], NOTES, [
      { track: "t", pattern: "p", startTick: 0, repeatCount: 1 },
    ]);
    try {
      const byString = [...NOTES]
        .sort(
          (a, b) =>
            a.startTick - b.startTick ||
            (a.pitch < b.pitch ? -1 : a.pitch > b.pitch ? 1 : 0) ||
            a.durationTicks - b.durationTicks,
        )
        .map((n) => n.pitch);
      // Same notes, different sequence: `A0` before `C0`, and `D4` before `Db4`.
      expect(byString).toEqual(["A0", "C0", "C0", "C2", "D1", "D4", "Db4"]);
      expect(canonicalNotes(root).map(([pitch]) => pitch)).not.toEqual(byString);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("canonical clip order", () => {
  const CLIPS: TempClip[] = [
    { track: "b", pattern: "p", startTick: 1920, repeatCount: 1 },
    { track: "b", pattern: "p", startTick: 0, repeatCount: 1 },
    { track: "a", pattern: "p", startTick: 1920, repeatCount: 1 },
  ];

  it("sorts clips by startTick, then track, whatever order the file listed them in", () => {
    const root = projectWith(
      "clip-sort",
      ["a", "b"],
      [{ pitch: "C2", startTick: 0, durationTicks: 240 }],
      CLIPS,
    );
    try {
      const text = canonicalText(root, "arrangement.json");
      const order = [...text.matchAll(/"track": "([^"]+)",\n\s+"pattern": "[^"]+",\n\s+"startTick": (\d+)/g)].map(
        (m) => [m[1]!, Number(m[2]!)],
      );
      expect(order).toEqual([
        ["b", 0],
        ["a", 1920],
        ["b", 1920],
      ]);
      // Neither the given order nor track-first order produces that sequence.
      expect(order).not.toEqual(CLIPS.map((c) => [c.track, c.startTick]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
