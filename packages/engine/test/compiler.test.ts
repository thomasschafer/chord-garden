import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalFiles,
  EXPRESSION_FIELDS,
  loadProject,
  type AutomationDoc,
  type Clip,
  type DrumkitInstrumentDoc,
  type GridPatternDoc,
  type NotesPatternDoc,
  type PatternDoc,
  type Project,
  type SynthInstrumentDoc,
} from "@chord-garden/format";
import { afterEach, describe, expect, it } from "vitest";
import { compile, type CompiledNoteEvent, type CompiledSchedule, type CompiledTrack } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
const SWUNG_HATS_FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/swung-hats", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface ProjectOptions {
  pattern: PatternDoc;
  repeatCount?: number;
  lengthTicks?: number;
  ppqn?: number;
  bpm?: number;
  swing?: number;
  automation?: AutomationDoc;
  /** Replaces the default single clip at tick 0. */
  clips?: Clip[];
}

function loadFixture(root: string): Project {
  const loaded = loadProject(root);
  expect(loaded.ok).toBe(true);
  return loaded.project!;
}

function trackEvents(schedule: CompiledSchedule, trackId: string): CompiledNoteEvent[] {
  const track = schedule.tracks.find((candidate) => candidate.trackId === trackId);
  if (track === undefined) throw new Error(`schedule has no track "${trackId}"`);
  return track.events;
}

function tracksExcept(schedule: CompiledSchedule, trackId: string): CompiledTrack[] {
  return schedule.tracks.filter((track) => track.trackId !== trackId);
}

function makeProject(options: ProjectOptions): Project {
  const repeatCount = options.repeatCount ?? 1;
  const trackType = options.pattern.kind === "grid" ? "drumkit" : "instrument";
  let instrument: DrumkitInstrumentDoc | SynthInstrumentDoc;
  if (options.pattern.kind === "grid") {
    instrument = {
      id: "main-instrument",
      type: "drumkit",
      kit: Object.fromEntries(options.pattern.lanes.map((lane) => [lane.lane, { sample: `samples/${lane.lane}.wav` }])),
    };
  } else {
    instrument = { id: "main-instrument", type: "synth", engine: "basic-poly" };
  }

  return {
    root: "",
    project: {
      format: 1,
      name: "compiler test",
      ppqn: options.ppqn ?? 960,
      tempoMap: [{ startTick: 0, bpm: options.bpm ?? 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: options.swing ?? 0,
      trackOrder: ["main-track"],
    },
    tracks: new Map([
      [
        "main-track",
        {
          id: "main-track",
          type: trackType,
          instrument: instrument.id,
          patterns: [options.pattern.id],
        },
      ],
    ]),
    instruments: new Map([[instrument.id, instrument]]),
    patterns: new Map([[options.pattern.id, options.pattern]]),
    arrangement: {
      lengthTicks: options.lengthTicks ?? options.pattern.lengthTicks * repeatCount,
      clips: options.clips ?? [{ track: "main-track", pattern: options.pattern.id, startTick: 0, repeatCount }],
    },
    automation: options.automation === undefined ? new Map() : new Map([["main-track", options.automation]]),
  };
}

function notesPattern(notes: NotesPatternDoc["notes"], lengthTicks = 3840): NotesPatternDoc {
  return { id: "notes-main", kind: "notes", lengthTicks, notes };
}

function notesPatternOf(project: Project, patternId: string): NotesPatternDoc {
  const pattern = project.patterns.get(patternId);
  if (pattern?.kind !== "notes") throw new Error(`fixture pattern "${patternId}" is not a notes pattern`);
  return pattern;
}

function pitchOrder(patternJson: string): string[] {
  const doc = JSON.parse(patternJson) as { notes: { pitch: string }[] };
  return doc.notes.map((note) => note.pitch);
}

function copyFixtureToTemporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "chord-garden-compiler-"));
  temporaryDirectories.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

describe("compile", () => {
  it("compiles the worked example to its golden schedule", () => {
    const schedule = compile(loadFixture(FIXTURE));
    const drums = schedule.tracks[0]!;
    const bass = schedule.tracks[1]!;
    const pad = schedule.tracks[2]!;

    expect(schedule.totalSamples).toBe(1_486_452);
    expect(drums.events).toHaveLength(239);
    expect(bass.events).toHaveLength(15);
    expect(pad.events).toHaveLength(0);
    expect(drums.events.filter((event) => event.voice === "kick")).toHaveLength(96);
    expect(drums.events.filter((event) => event.voice === "hat")).toHaveLength(143);
    expect(
      drums.events.filter((event) => event.voice === "kick").slice(0, 7).map((event) => event.startSample),
    ).toEqual([0, 17_419, 34_839, 46_452, 63_871, 81_290, 92_903]);
    expect(
      drums.events.filter((event) => event.voice === "hat").slice(0, 10).map((event) => event.startSample),
    ).toEqual([0, 11_613, 23_226, 34_839, 46_161, 47_613, 58_065, 69_677, 81_290, 92_903]);
  });

  it("places four-on-the-floor hits at exact 124 BPM sample offsets", () => {
    const project = makeProject({
      bpm: 12400,
      pattern: {
        id: "drums-main",
        kind: "grid",
        lengthTicks: 3840,
        lanes: [{ lane: "kick", grid: { stepsPerBar: 16 }, steps: "x... x... x... x..." }],
      },
    });

    expect(compile(project).tracks[0]!.events.map((event) => event.startSample)).toEqual([
      0, 23_226, 46_452, 69_677,
    ]);
  });

  it("delays only odd steps by the lane swing amount", () => {
    const project = makeProject({
      bpm: 12400,
      pattern: {
        id: "drums-main",
        kind: "grid",
        lengthTicks: 3840,
        lanes: [
          { lane: "straight", grid: { stepsPerBar: 16 }, steps: "xxxx .... .... ....", defaults: { swing: 0 } },
          { lane: "swung", grid: { stepsPerBar: 16 }, steps: "xxxx .... .... ....", defaults: { swing: 500 } },
        ],
      },
    });
    const events = compile(project).tracks[0]!.events;
    const straight = events.filter((event) => event.voice === "straight").map((event) => event.startSample);
    const swung = events.filter((event) => event.voice === "swung").map((event) => event.startSample);

    expect(straight).toEqual([0, 5_806, 11_613, 17_419]);
    expect(swung).toEqual([0, 7_258, 11_613, 18_871]);
    expect(swung.map((sample, index) => sample - straight[index]!)).toEqual([0, 1_452, 0, 1_452]);
  });

  it("compiles the swung hats fixture to exact straight and swung offsets", () => {
    const events = compile(loadFixture(SWUNG_HATS_FIXTURE)).tracks[0]!.events;
    const straight = events.filter((event) => event.voice === "straight-hat").map((event) => event.startSample);
    const swung = events.filter((event) => event.voice === "swung-hat").map((event) => event.startSample);

    expect(straight).toEqual([5_806, 17_419, 29_032, 40_645]);
    expect(swung).toEqual([7_258, 18_871, 30_484, 42_097]);
  });

  it("adds microTicks to the rounded swing delay", () => {
    const project = makeProject({
      pattern: {
        id: "drums-main",
        kind: "grid",
        lengthTicks: 3840,
        lanes: [
          {
            lane: "hat",
            grid: { stepsPerBar: 4 },
            steps: ".x..",
            defaults: { swing: 333 },
            stepEvents: [{ step: 1, microTicks: -40 }],
          },
        ],
      },
    });

    expect(compile(project).tracks[0]!.events[0]!.startSample).toBe(27_000);
  });

  it("tiles ratchet gates exactly for counts two and three", () => {
    const project = makeProject({
      pattern: notesPattern([
        { pitch: "C4", startTick: 0, durationTicks: 5, velocity: 800, ratchet: 2 },
        { pitch: "D4", startTick: 100, durationTicks: 5, velocity: 800, ratchet: 3 },
      ]),
    });
    const events = compile(project).tracks[0]!.events;
    const twos = events.filter((event) => event.midi === 60);
    const threes = events.filter((event) => event.midi === 62);

    expect(twos.map((event) => [event.startSample, event.durationSamples])).toEqual([
      [0, 63],
      [63, 62],
    ]);
    expect(threes.map((event) => [event.startSample, event.durationSamples])).toEqual([
      [2_500, 42],
      [2_542, 41],
      [2_583, 42],
    ]);
    expect(twos[0]!.durationSamples + twos[1]!.durationSamples).toBe(125);
    expect(threes.reduce((sum, event) => sum + event.durationSamples, 0)).toBe(125);
  });

  it("tiles adjacent gates at non-integer samples per tick", () => {
    const project = makeProject({
      bpm: 12400,
      pattern: notesPattern(
        Array.from({ length: 8 }, (_, index) => ({
          pitch: "C4",
          startTick: index * 100,
          durationTicks: 100,
          velocity: 800,
        })),
      ),
    });
    const events = compile(project).tracks[0]!.events;

    expect(
      events.slice(0, -1).map((event, index) => events[index + 1]!.startSample - event.startSample - event.durationSamples),
    ).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("resolves probability exactly and stably per seed", () => {
    const project = makeProject({
      repeatCount: 24,
      pattern: notesPattern([
        { pitch: "C4", startTick: 0, durationTicks: 120, velocity: 800, probability: 1000 },
        { pitch: "C#4", startTick: 240, durationTicks: 120, velocity: 800, probability: 0 },
        { pitch: "D4", startTick: 480, durationTicks: 120, velocity: 800, probability: 500 },
      ]),
    });
    const first = compile(project, { seed: 7 }).tracks[0]!.events;
    const second = compile(project, { seed: 7 }).tracks[0]!.events;
    const otherSeed = compile(project, { seed: 8 }).tracks[0]!.events;

    expect(first.filter((event) => event.midi === 60)).toHaveLength(24);
    expect(first.filter((event) => event.midi === 61)).toHaveLength(0);
    expect(first.filter((event) => event.midi === 62).map((event) => event.startSample)).toEqual(
      second.filter((event) => event.midi === 62).map((event) => event.startSample),
    );
    expect(first.filter((event) => event.midi === 62).map((event) => event.startSample)).not.toEqual(
      otherSeed.filter((event) => event.midi === 62).map((event) => event.startSample),
    );
  });

  it("does not reshuffle one lane when another lane is edited", () => {
    const pattern: GridPatternDoc = {
      id: "drums-main",
      kind: "grid",
      lengthTicks: 3840,
      lanes: [
        {
          lane: "stable",
          grid: { stepsPerBar: 16 },
          steps: "xxxx xxxx xxxx xxxx",
          defaults: { probability: 500 },
        },
        { lane: "other", grid: { stepsPerBar: 16 }, steps: "x... x... x... x..." },
      ],
    };
    const editedPattern: GridPatternDoc = {
      ...pattern,
      lanes: [pattern.lanes[0]!, { ...pattern.lanes[1]!, steps: ".x.. .x.. .x.. .x.." }],
    };
    const before = compile(makeProject({ pattern, repeatCount: 16 }), { seed: 99 }).tracks[0]!.events;
    const after = compile(makeProject({ pattern: editedPattern, repeatCount: 16 }), { seed: 99 }).tracks[0]!.events;

    expect(before.filter((event) => event.voice === "stable")).toEqual(
      after.filter((event) => event.voice === "stable"),
    );
  });

  it("does not re-roll another track's events when an unrelated clip is inserted", () => {
    const before = compile(loadFixture(FIXTURE));
    const withExtraClip = loadFixture(FIXTURE);
    // The fixture's pad track owns no pattern, so the inserted clip borrows the
    // bass pattern; what matters is that it touches neither drums nor bass.
    withExtraClip.arrangement.clips.unshift({ track: "pad", pattern: "bass-main", startTick: 0, repeatCount: 1 });
    const after = compile(withExtraClip);

    expect(trackEvents(after, "drums")).toEqual(trackEvents(before, "drums"));
    expect(trackEvents(after, "bass")).toEqual(trackEvents(before, "bass"));
    expect(trackEvents(before, "drums")).toHaveLength(239);
    expect(trackEvents(before, "bass")).toHaveLength(15);
    expect(trackEvents(after, "pad")).toHaveLength(3);
  });

  it("compiles the same schedule whichever order the clips array is in", () => {
    const reversed = loadFixture(FIXTURE);
    reversed.arrangement.clips.reverse();

    expect(reversed.arrangement.clips.map((clip) => clip.track)).toEqual(["bass", "drums"]);
    expect(compile(reversed)).toEqual(compile(loadFixture(FIXTURE)));
  });

  it("leaves other tracks untouched when a clip is removed or moved", () => {
    const before = compile(loadFixture(FIXTURE));
    const withoutDrums = loadFixture(FIXTURE);
    withoutDrums.arrangement.clips = withoutDrums.arrangement.clips.filter((clip) => clip.track !== "drums");
    const movedBass = loadFixture(FIXTURE);
    const bassClip = movedBass.arrangement.clips.find((clip) => clip.track === "bass")!;
    bassClip.startTick = 7680;

    // Removing the drums clip vacates the array slot the bass clip followed.
    expect(tracksExcept(compile(withoutDrums), "drums")).toEqual(tracksExcept(before, "drums"));
    expect(trackEvents(compile(withoutDrums), "drums")).toEqual([]);
    // Moving a clip may re-roll its own events, but nothing else may move.
    expect(tracksExcept(compile(movedBass), "bass")).toEqual(tracksExcept(before, "bass"));
  });

  it("does not re-roll a clip's events when another clip on the same track is inserted", () => {
    const pattern = notesPattern([
      { pitch: "C4", startTick: 0, durationTicks: 120, velocity: 800, probability: 500 },
      { pitch: "E4", startTick: 480, durationTicks: 120, velocity: 800, probability: 500 },
      { pitch: "G4", startTick: 960, durationTicks: 120, velocity: 800, probability: 500 },
    ]);
    const clip = (startTick: number): Clip => ({
      track: "main-track",
      pattern: pattern.id,
      startTick,
      repeatCount: 1,
    });
    const twoClips = makeProject({ pattern, lengthTicks: 11_520, clips: [clip(0), clip(3840)] });
    const threeClips = makeProject({ pattern, lengthTicks: 11_520, clips: [clip(7680), clip(0), clip(3840)] });
    const before = compile(twoClips, { seed: 3 }).tracks[0]!.events;
    const after = compile(threeClips, { seed: 3 }).tracks[0]!.events;

    // Both existing clips must keep exactly their events; the appended clip
    // starts after them, so they stay a prefix of the sorted schedule.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(before).toHaveLength(4);
    expect(after).toHaveLength(6);
  });

  it("leaves every other note's events untouched when a note is inserted or removed", () => {
    const before = compile(loadFixture(FIXTURE));
    const withNote = loadFixture(FIXTURE);
    // Deliberately non-canonical: this note sorts last musically (tick 7200)
    // but sits first in the array, which is exactly what `fmt` would move.
    notesPatternOf(withNote, "bass-main").notes.unshift({
      pitch: "D2",
      startTick: 7200,
      durationTicks: 240,
      velocity: 800,
    });
    const after = compile(withNote);
    const withoutFirst = loadFixture(FIXTURE);
    const removed = notesPatternOf(withoutFirst, "bass-main").notes.shift();
    const afterRemoval = compile(withoutFirst);

    // The event count alone hides this bug and must not stand in for the
    // comparison: keying on the array index also produced exactly +6 events
    // here, while silently swapping which C2 events fired.
    expect(trackEvents(after, "bass")).toHaveLength(trackEvents(before, "bass").length + 6);
    expect(trackEvents(after, "bass").filter((event) => event.midi === 38)).toHaveLength(6);
    expect(trackEvents(after, "bass").filter((event) => event.midi !== 38)).toEqual(trackEvents(before, "bass"));
    expect(tracksExcept(after, "bass")).toEqual(tracksExcept(before, "bass"));

    // Removing the note the probabilistic C2 followed must not re-roll it.
    expect(removed?.startTick).toBe(0);
    expect(trackEvents(afterRemoval, "bass")).toHaveLength(trackEvents(before, "bass").length - 6);
    expect(trackEvents(afterRemoval, "bass").filter((event) => event.midi === 36)).toEqual(
      trackEvents(before, "bass").filter((event) => event.midi === 36),
    );
    expect(tracksExcept(afterRemoval, "bass")).toEqual(tracksExcept(before, "bass"));
  });

  it("compiles the same schedule whichever order the notes array is in", () => {
    const reversed = loadFixture(FIXTURE);
    notesPatternOf(reversed, "bass-main").notes.reverse();

    expect(notesPatternOf(reversed, "bass-main").notes.map((note) => note.startTick)).toEqual([2400, 960, 0]);
    expect(compile(reversed)).toEqual(compile(loadFixture(FIXTURE)));
  });

  it("compiles the same schedule after fmt sorts a non-canonically ordered notes array", () => {
    const root = copyFixtureToTemporaryDirectory();
    const patternPath = join(root, "patterns", "bass-main.json");
    const handWritten =
      JSON.stringify(
        {
          id: "bass-main",
          kind: "notes",
          lengthTicks: 7680,
          notes: [
            { pitch: "D2", startTick: 7200, durationTicks: 240, velocity: 700, probability: 600 },
            { pitch: "C2", startTick: 2400, durationTicks: 960, velocity: 800, probability: 800 },
            { pitch: "A1", startTick: 960, durationTicks: 480, velocity: 700, microTicks: -8 },
            { pitch: "E2", startTick: 2400, durationTicks: 480, velocity: 700, probability: 400 },
            { pitch: "A1", startTick: 0, durationTicks: 720, velocity: 900 },
          ],
        },
        null,
        2,
      ) + "\n";
    writeFileSync(patternPath, handWritten);

    const project = loadFixture(root);
    const before = compile(project, { seed: 5 });
    const canonical = canonicalFiles(project);
    const canonicalPattern = canonical.get("patterns/bass-main.json");
    if (canonicalPattern === undefined) throw new Error("canonicalFiles produced no bass pattern");
    for (const [relativePath, contents] of canonical) writeFileSync(join(root, relativePath), contents);
    const after = compile(loadFixture(root), { seed: 5 });

    // Guards against a vacuous pass: fmt must really have reordered the notes,
    // and probability must really be dropping some of them (5 notes over 6
    // repetitions would otherwise schedule 30 events).
    expect(pitchOrder(canonicalPattern)).not.toEqual(pitchOrder(handWritten));
    expect(pitchOrder(canonicalPattern)).toEqual(["A1", "A1", "C2", "E2", "D2"]);
    expect(trackEvents(before, "bass")).toHaveLength(22);
    expect(after).toEqual(before);
  });

  it("clips automation and supplies interpolated range boundaries", () => {
    const automation: AutomationDoc = {
      track: "main-track",
      lanes: [
        {
          param: "filter.cutoff",
          interp: "linear",
          points: [
            [0, 200],
            [5760, 800],
            [7680, 1000],
          ],
        },
        {
          param: "gain",
          interp: "step",
          points: [
            [0, -600],
            [5760, 0],
          ],
        },
      ],
    };
    const project = makeProject({
      pattern: notesPattern([], 11_520),
      lengthTicks: 11_520,
      automation,
    });
    const lanes = compile(project, { barRange: { start: 1, end: 2 } }).tracks[0]!.automation;

    expect(lanes[0]!.points).toEqual([
      [0, 600],
      [48_000, 800],
      [96_000, 1000],
    ]);
    expect(lanes[1]!.points).toEqual([
      [0, -600],
      [48_000, 0],
      [96_000, 0],
    ]);
  });

  it("keeps only the latest automation value when points round to the same sample", () => {
    const automation: AutomationDoc = {
      track: "main-track",
      lanes: [
        {
          param: "filter.cutoff",
          interp: "linear",
          points: [
            [0, 100],
            [1, 200],
            [2, 300],
          ],
        },
      ],
    };
    const project = makeProject({
      pattern: notesPattern([]),
      automation,
    });
    const points = compile(project, { sampleRate: 1 }).tracks[0]!.automation[0]!.points;

    expect(points).toEqual([
      [0, 300],
      [2, 300],
    ]);
    expect(points.every((point, index) => index === 0 || point[0] > points[index - 1]![0])).toBe(true);
  });

  it("rebases a bar range and excludes events that start outside it", () => {
    const project = makeProject({
      repeatCount: 2,
      pattern: {
        id: "drums-main",
        kind: "grid",
        lengthTicks: 3840,
        lanes: [{ lane: "kick", grid: { stepsPerBar: 4 }, steps: "xxxx" }],
      },
    });
    const schedule = compile(project, { barRange: { start: 1, end: 2 } });

    expect(schedule.totalSamples).toBe(96_000);
    expect(schedule.tracks[0]!.events.map((event) => event.startSample)).toEqual([0, 24_000, 48_000, 72_000]);
  });

  it("is deeply deterministic", () => {
    const project = makeProject({
      repeatCount: 8,
      pattern: notesPattern([
        { pitch: "A2", startTick: 0, durationTicks: 480, velocity: 700, probability: 650, ratchet: 3 },
      ]),
    });

    expect(compile(project, { seed: 123 })).toEqual(compile(project, { seed: 123 }));
  });

  it("fails loudly on invalid validated-state assumptions", () => {
    const project = makeProject({ pattern: notesPattern([]) });
    project.arrangement.clips[0]!.pattern = "missing-pattern";

    expect(() => compile(project)).toThrow('cannot compile clip 0: pattern "missing-pattern" does not exist');
  });
});

/**
 * The values a hit or a note gets when the document says nothing.
 *
 * Nothing pinned these before, and the hole was not theoretical: changing the
 * grid velocity default from 800 to 700 moved the worked example's kick from
 * −9.95 to −11.11 dBFS and its master from −2.91 to −3.32, and the whole suite
 * still passed. Every default is now stated twice — once as the number a
 * musician would recognise, once against `EXPRESSION_FIELDS` — because the UI
 * shows these as the placeholder in an empty box, and a UI promising 800 over a
 * compiler applying 700 is exactly the divergence the shared registry exists to
 * make impossible.
 */
describe("the defaults an unadorned event compiles at", () => {
  const gridPattern: GridPatternDoc = {
    id: "grid-main",
    kind: "grid",
    lengthTicks: 3840,
    lanes: [{ lane: "kick", grid: { stepsPerBar: 16 }, steps: "x... x... x... x..." }],
  };

  it("gives a grid hit with no defaults and no override the registry's velocity", () => {
    const events = trackEvents(compile(makeProject({ pattern: gridPattern })), "main-track");

    expect(events).not.toHaveLength(0);
    expect(new Set(events.map((event) => event.velocity))).toEqual(new Set([800]));
    expect(EXPRESSION_FIELDS.velocity.default).toBe(800);
  });

  it("gates a grid hit for one step when nothing overrides it", () => {
    const events = trackEvents(compile(makeProject({ pattern: gridPattern })), "main-track");

    // 16 steps to a 3840-tick bar is 240 ticks a step, which at 120 BPM, 960
    // ppqn and 48 kHz is 6000 samples — one *step*, not the gap to the next hit,
    // which here is four steps away.
    expect(events.map((event) => event.durationSamples)).toEqual([6000, 6000, 6000, 6000]);
    // Stated as `null` in the registry because the default is derived rather
    // than constant; this is what deriving it comes to.
    expect(EXPRESSION_FIELDS.gateTicks.default).toBeNull();
  });

  it("fires every event when nothing sets a probability, and ratchets once", () => {
    const withProbability: GridPatternDoc = {
      ...gridPattern,
      lanes: [{ ...gridPattern.lanes[0]!, stepEvents: [{ step: 0, probability: 0 }] }],
    };

    // Four hits with no probability at all; one of them silenced by an explicit
    // 0 proves the other three are firing because the default is 1000, not
    // because probability is being ignored.
    expect(trackEvents(compile(makeProject({ pattern: gridPattern })), "main-track")).toHaveLength(4);
    expect(trackEvents(compile(makeProject({ pattern: withProbability })), "main-track")).toHaveLength(3);
    expect(EXPRESSION_FIELDS.probability.default).toBe(1000);
    expect(EXPRESSION_FIELDS.ratchet.default).toBe(1);
  });

  /**
   * Unreachable from disk — the schema floors both at 1 — and reachable from
   * here, which is the point. `compile` is a public entry point that takes a
   * `Project` object, and the live engine and every test in this file build one
   * without going near a validator. Left alone, `ratchet: 0` divided by zero and
   * dropped the note, and a zero duration emitted an event of no length: a part
   * with something missing from it and nothing saying why.
   */
  it("refuses a zero ratchet or a zero duration rather than silently dropping the note", () => {
    const zeroRatchet = makeProject({
      pattern: notesPattern([{ pitch: "A2", startTick: 0, durationTicks: 240, velocity: 800, ratchet: 0 }]),
    });
    expect(() => compile(zeroRatchet)).toThrow(/ratchet 0/);

    const zeroDuration = makeProject({
      pattern: notesPattern([{ pitch: "A2", startTick: 0, durationTicks: 0, velocity: 800 }]),
    });
    expect(() => compile(zeroDuration)).toThrow(/0 ticks/);

    const zeroGate = makeProject({
      pattern: {
        ...gridPattern,
        lanes: [{ ...gridPattern.lanes[0]!, defaults: { gateTicks: 0 } }],
      },
    });
    expect(() => compile(zeroGate)).toThrow(/0 ticks/);
  });

  it("places a hit on its step exactly when nothing nudges or swings it", () => {
    const events = trackEvents(compile(makeProject({ pattern: gridPattern })), "main-track");

    // 240 ticks a step at 120 BPM, 960 ppqn, 48 kHz is 6000 samples a step.
    expect(events.map((event) => event.startSample)).toEqual([0, 24_000, 48_000, 72_000]);
    expect(EXPRESSION_FIELDS.microTicks.default).toBe(0);
    expect(EXPRESSION_FIELDS.swing.default).toBe(0);
  });

  it("leaves a note's own velocity alone and defaults the rest of its expression", () => {
    const project = makeProject({
      pattern: notesPattern([{ pitch: "A2", startTick: 480, durationTicks: 240, velocity: 333 }]),
    });

    const events = trackEvents(compile(project), "main-track");

    expect(events).toHaveLength(1);
    expect(events[0]!.velocity).toBe(333);
    // No microTicks, so the note is exactly on its own startTick.
    expect(events[0]!.startSample).toBe(12_000);
    // No ratchet, so one event; a note's gate is its own duration.
    expect(events[0]!.durationSamples).toBe(6000);
  });
});
