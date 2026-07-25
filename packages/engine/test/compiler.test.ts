import { fileURLToPath } from "node:url";
import {
  loadProject,
  type AutomationDoc,
  type DrumkitInstrumentDoc,
  type GridPatternDoc,
  type NotesPatternDoc,
  type PatternDoc,
  type Project,
  type SynthInstrumentDoc,
} from "@chord-garden/format";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
const SWUNG_HATS_FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/swung-hats", import.meta.url));

interface ProjectOptions {
  pattern: PatternDoc;
  repeatCount?: number;
  lengthTicks?: number;
  ppqn?: number;
  bpm?: number;
  swing?: number;
  automation?: AutomationDoc;
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
      clips: [{ track: "main-track", pattern: options.pattern.id, startTick: 0, repeatCount }],
    },
    automation: options.automation === undefined ? new Map() : new Map([["main-track", options.automation]]),
  };
}

function notesPattern(notes: NotesPatternDoc["notes"], lengthTicks = 3840): NotesPatternDoc {
  return { id: "notes-main", kind: "notes", lengthTicks, notes };
}

describe("compile", () => {
  it("compiles the worked example to its golden schedule", () => {
    const loaded = loadProject(FIXTURE);
    expect(loaded.ok).toBe(true);
    const schedule = compile(loaded.project!);
    const drums = schedule.tracks[0]!;
    const bass = schedule.tracks[1]!;
    const pad = schedule.tracks[2]!;

    expect(schedule.totalSamples).toBe(1_486_452);
    expect(drums.events).toHaveLength(239);
    expect(bass.events).toHaveLength(17);
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
    const loaded = loadProject(SWUNG_HATS_FIXTURE);
    expect(loaded.ok).toBe(true);
    const events = compile(loaded.project!).tracks[0]!.events;
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
