import { compile } from "@chord-garden/engine/compiler";
import type { AutomationDoc, GridLane, GridPatternDoc, Project } from "@chord-garden/format/pure";
import { describe, expect, it } from "vitest";
import {
  createDocumentStore,
  type DocumentSink,
  type DocumentStore,
  type PendingDelete,
  type PendingFile,
} from "../src/store/documentStore";
import { FIXTURE, openedFrom } from "./fixture";

/**
 * Stage 1 of Phase 5: the automation, swing and lane-expression edits, at the
 * level of what they do to the document and to the compiled schedule.
 *
 * Two things are asserted throughout and neither is incidental.
 *
 * **Nothing else moves.** Every case that changes one field also states that the
 * fields beside it are exactly what they were. The failure this catches is the
 * one a UI reaches for by accident: rebuilding an object from the controls on
 * screen, which quietly drops whatever the controls do not know about.
 *
 * **The claim that an automation edit is a `parameters` change is checked
 * against the compiler,** not asserted by reading the store's own literal. If a
 * future compiler let an automation lane reach an event, the schedule comparison
 * here fails and the classification has to be revisited — which is the whole
 * reason PLAN.md §12 step 6 is a decision worth pinning.
 */

const DRUMS = "patterns/drums-verse.json";
const PAD_AUTOMATION = "automation/pad.json";

class NullSink implements DocumentSink {
  readonly batches: { files: PendingFile[]; deletes: PendingDelete[] }[] = [];
  async write(files: readonly PendingFile[], deletes: readonly PendingDelete[]) {
    this.batches.push({ files: files.map((file) => ({ ...file })), deletes: deletes.map((file) => ({ ...file })) });
    return { diagnostics: [] };
  }
}

function open(): { store: DocumentStore; sink: NullSink } {
  const sink = new NullSink();
  const store = createDocumentStore({ sink, debounceMs: 10_000 });
  store.getState().open(openedFrom(FIXTURE));
  return { store, sink };
}

function project(store: DocumentStore): Project {
  const value = store.getState().project;
  if (value === undefined) throw new Error("no project is open");
  return value;
}

function grid(store: DocumentStore, id = "drums-verse"): GridPatternDoc {
  const pattern = project(store).patterns.get(id);
  if (pattern?.kind !== "grid") throw new Error(`"${id}" is not a grid pattern`);
  return pattern;
}

function laneOf(store: DocumentStore, name: string): GridLane {
  const lane = grid(store).lanes.find((entry) => entry.lane === name);
  if (lane === undefined) throw new Error(`no lane "${name}"`);
  return lane;
}

function automation(store: DocumentStore, trackId: string): AutomationDoc {
  const doc = project(store).automation.get(trackId);
  if (doc === undefined) throw new Error(`no automation for "${trackId}"`);
  return doc;
}

/** Every track's events, with no automation, so two schedules can be compared. */
function eventsOf(target: Project): Record<string, unknown> {
  const schedule = compile(target, { sampleRate: 48_000, seed: 0 });
  return Object.fromEntries(schedule.tracks.map((track) => [track.trackId, track.events]));
}

/**
 * Where and how loud every hit is, ignoring how long it is held.
 *
 * The distinction matters for one edit only, and it is not a fudge. A lane's
 * `gateTicks` defaults to *one step*, so changing a lane's grid resolution
 * necessarily changes the gate a hit inherits — halving the resolution doubles
 * it. Nothing about when a hit happens moves, which is what "a grid is a view"
 * means, and on a drumkit the gate reaches no sound at all unless the hit
 * ratchets (`DrumkitTrackRunner.collect` takes an offset, a voice and a
 * velocity, and the sample plays out).
 */
function onsetsOf(target: Project): Record<string, unknown> {
  const schedule = compile(target, { sampleRate: 48_000, seed: 0 });
  return Object.fromEntries(
    schedule.tracks.map((track) => [
      track.trackId,
      track.events.map((event) => ({
        startSample: event.startSample,
        midi: event.midi,
        velocity: event.velocity,
        voice: event.voice,
      })),
    ]),
  );
}

describe("lane defaults", () => {
  it("adds a default without disturbing the ones already set", () => {
    const { store } = open();
    expect(laneOf(store, "hat").defaults).toEqual({ velocity: 600, swing: 120 });

    store.getState().setLaneDefaults("drums-verse", "hat", { gateTicks: 90 });

    expect(laneOf(store, "hat").defaults).toEqual({ velocity: 600, swing: 120, gateTicks: 90 });
    // And the per-step overrides that read against those defaults are untouched.
    expect(laneOf(store, "hat").stepEvents).toEqual([
      { step: 2, velocity: 350, probability: 800 },
      { step: 8, microTicks: -12, gateTicks: 120, ratchet: 2 },
    ]);
  });

  it("drops the whole defaults block when its last field is cleared, because an empty one is not a document", () => {
    const { store } = open();

    store.getState().setLaneDefaults("drums-verse", "hat", { velocity: undefined, swing: undefined });

    expect(laneOf(store, "hat").defaults).toBeUndefined();
    expect(store.getState().canonical.get(DRUMS)).not.toContain("defaults");
  });

  it("refuses a value the expression registry does not allow, and changes nothing", () => {
    const { store } = open();

    expect(() => store.getState().setLaneDefaults("drums-verse", "hat", { velocity: 1200 })).toThrow(/0\.\.1000/);
    expect(() => store.getState().setLaneDefaults("drums-verse", "hat", { swing: -1 })).toThrow(/at least 0/);
    expect(laneOf(store, "hat").defaults).toEqual({ velocity: 600, swing: 120 });
    expect(store.getState().dirty).toEqual([]);
  });
});

describe("swing", () => {
  it("moves only odd-indexed steps, which is why a four-on-the-floor kick does not change", () => {
    const { store } = open();
    // The kick lane's own hits, from the fixture: 0, 3, 6, 8, 11, 14.
    const before = eventsOf(project(store));

    store.getState().setProjectSwing(600);

    const after = eventsOf(project(store));
    expect(after).not.toEqual(before);
    // The bass has no grid lane at all, so nothing about it may move.
    expect(after["bass"]).toEqual(before["bass"]);
  });

  it("leaves a lane whose hits are all even sounding identical at every swing value", () => {
    const { store } = open();
    // A kick on 0, 4, 8, 12 — the case docs/format-spec.md §4 calls out.
    store.getState().setPatternLaneSteps("drums-verse", "kick", "x... x... x... x...");
    // The hat has its own `defaults.swing`, so the project value cannot reach it;
    // pinning it to 0 leaves the kick as the only thing the next edit could move.
    store.getState().setLaneDefaults("drums-verse", "hat", { swing: 0 });
    const straight = eventsOf(project(store));

    store.getState().setProjectSwing(1000);

    expect(eventsOf(project(store))).toEqual(straight);
  });

  /**
   * The fixture's own hat is the trap this stage exists to make visible: it
   * carries `defaults.swing: 120`, and its hits are on 0, 2, 4… — every one of
   * them even — so that 120 moves nothing at all. Asserted here so the fact is
   * pinned rather than folklore, because the lane panel's "0 of 8 hits move"
   * line is only worth showing if it is true.
   */
  it("does nothing to the fixture's hat, whose hits are all on even steps", () => {
    const { store } = open();
    const withFixtureSwing = eventsOf(project(store));

    store.getState().setLaneDefaults("drums-verse", "hat", { swing: 0 });

    expect(eventsOf(project(store))).toEqual(withFixtureSwing);
  });

  it("is a lane setting a lane may override", () => {
    const { store } = open();
    // Offbeat hats: every hit on an odd step, so swing has something to move.
    store.getState().setPatternLaneSteps("drums-verse", "hat", ".x.x .x.x .x.x .x.x");
    store.getState().setLaneDefaults("drums-verse", "hat", { swing: undefined });
    store.getState().setProjectSwing(600);
    const followingTheProject = eventsOf(project(store));

    store.getState().setLaneDefaults("drums-verse", "hat", { swing: 0 });

    // Same project swing, straight lane: the override is what changed the sound.
    expect(project(store).project.swing).toBe(600);
    expect(eventsOf(project(store))).not.toEqual(followingTheProject);
  });

  it("refuses a swing outside the registry's range", () => {
    const { store } = open();

    expect(() => store.getState().setProjectSwing(1500)).toThrow(/at most 1000/);
    expect(project(store).project.swing).toBe(0);
  });
});

describe("changing a lane's grid resolution", () => {
  it("keeps every hit at the tick it was at", () => {
    const { store } = open();
    // Four on the floor: hits at ticks 0, 960, 1920, 2880.
    store.getState().setPatternLaneSteps("drums-verse", "kick", "x... x... x... x...");
    const before = onsetsOf(project(store));

    store.getState().setLaneStepsPerBar("drums-verse", "kick", 4);

    const lane = laneOf(store, "kick");
    expect(lane.grid.stepsPerBar).toBe(4);
    expect(lane.steps).toBe("xxxx");
    // The document says it a new way and no hit moves, which is the whole point:
    // a grid is a view (PLAN.md §6).
    expect(onsetsOf(project(store))).toEqual(before);
  });

  /**
   * The one thing a resolution change does reach, stated rather than hidden: a
   * lane that inherits its gate from the step length inherits a different gate
   * from a different step length. Silent on a drumkit unless the hit ratchets,
   * and the lane panel shows the step length in ticks so the new value is on
   * screen.
   */
  it("changes the gate a lane inherits, because one step is now a different length", () => {
    const { store } = open();
    store.getState().setPatternLaneSteps("drums-verse", "kick", "x... x... x... x...");
    const before = compile(project(store), { sampleRate: 48_000, seed: 0 });

    store.getState().setLaneStepsPerBar("drums-verse", "kick", 4);

    const after = compile(project(store), { sampleRate: 48_000, seed: 0 });
    const gate = (schedule: typeof before): number =>
      schedule.tracks.find((track) => track.trackId === "drums")!.events.find((event) => event.voice === "kick")!
        .durationSamples;
    // Four times as long, to within the tick-to-sample rounding: PLAN.md §18's
    // rule is to difference two rounded positions rather than round a length, so
    // four of these do not add up to exactly one of those.
    expect(gate(after)).toBeGreaterThan(gate(before) * 4 - 4);
    expect(gate(after)).toBeLessThan(gate(before) * 4 + 4);
  });

  it("refuses rather than requantising when a hit would fall between the new steps", () => {
    const { store } = open();
    // The fixture's kick is on 0, 3, 6, 8, 11, 14 — step 3 is tick 720, and an
    // eighth-note grid has steps every 480 ticks, so 720 is between two of them.
    const before = laneOf(store, "kick").steps;

    expect(() => store.getState().setLaneStepsPerBar("drums-verse", "kick", 8)).toThrow(/between steps/);
    expect(laneOf(store, "kick").steps).toBe(before);
    expect(laneOf(store, "kick").grid.stepsPerBar).toBe(16);
    expect(store.getState().dirty).toEqual([]);
  });

  it("makes a finer grid without moving anything", () => {
    const { store } = open();
    const before = onsetsOf(project(store));

    store.getState().setLaneStepsPerBar("drums-verse", "kick", 32);

    // Hits 0, 3, 6, 8, 11, 14 at sixteenths are 0, 6, 12, 16, 22, 28 at
    // thirty-seconds, and `fmt` groups a 32-step bar in blocks of four.
    expect(laneOf(store, "kick").steps).toBe("x... ..x. .... x... x... ..x. .... x...");
    expect(onsetsOf(project(store))).toEqual(before);
  });

  it("carries stepEvents to their new step numbers", () => {
    const { store } = open();
    // The hat is on every other 16th, so halving the grid is exact.
    store.getState().setLaneStepsPerBar("drums-verse", "hat", 8);

    const lane = laneOf(store, "hat");
    expect(lane.grid.stepsPerBar).toBe(8);
    expect(lane.steps).toBe("xxxx xxxx");
    // Steps 2 and 8 at sixteenths are steps 1 and 4 at eighths, and nothing else
    // about the entries changed.
    expect(lane.stepEvents).toEqual([
      { step: 1, velocity: 350, probability: 800 },
      { step: 4, microTicks: -12, gateTicks: 120, ratchet: 2 },
    ]);
  });

  it("refuses a resolution that does not divide a bar", () => {
    const { store } = open();

    expect(() => store.getState().setLaneStepsPerBar("drums-verse", "hat", 7)).toThrow(/divide/);
  });
});

describe("automation lanes", () => {
  it("adds a lane seeded at the value the instrument already produces", () => {
    const { store } = open();
    // The fixture's bass sits at -1000 (PLAN.md §8's explicit gain staging).
    store.getState().addAutomationLane("bass", "gain");

    expect(automation(store, "bass").lanes).toEqual([
      { param: "gain", interp: "linear", points: [[0, -1000]] },
    ]);
  });

  it("seeds from the registry default when the instrument sets no value", () => {
    const { store } = open();
    // `pad-synth` sets no `pan`, so the registry's 0 is what it produces.
    store.getState().addAutomationLane("pad", "pan");

    const lane = automation(store, "pad").lanes.find((entry) => entry.param === "pan");
    expect(lane?.points).toEqual([[0, 0]]);
    // The lane that was already there is untouched.
    expect(automation(store, "pad").lanes[0]).toEqual({
      param: "filter.cutoff",
      interp: "linear",
      points: [[0, 200], [30_720, 4000], [61_440, 800]],
    });
  });

  it("refuses a param that is not automatable, and one that does not exist", () => {
    const { store } = open();

    expect(() => store.getState().addAutomationLane("pad", "amp.attack")).toThrow(/not automatable/);
    expect(() => store.getState().addAutomationLane("pad", "filter.cutof")).toThrow(/not a param/);
    expect(() => store.getState().addAutomationLane("pad", "filter.cutoff")).toThrow(/already automates/);
    expect(store.getState().dirty).toEqual([]);
  });

  it("names a drumkit voice's param the way the registry does", () => {
    const { store } = open();

    store.getState().addAutomationLane("drums", "kick.gain");

    expect(automation(store, "drums").lanes).toEqual([
      { param: "kick.gain", interp: "linear", points: [[0, 0]] },
    ]);
    expect(() => store.getState().addAutomationLane("drums", "snare.gain")).toThrow(/not a param/);
  });

  it("removes the whole document when the last lane goes", () => {
    const { store } = open();

    store.getState().removeAutomationLane("pad", "filter.cutoff");

    expect(project(store).automation.has("pad")).toBe(false);
    expect(store.getState().removing).toEqual([PAD_AUTOMATION]);
    expect(store.getState().canonical.has(PAD_AUTOMATION)).toBe(false);
  });

  it("sends the removal as a deletion with the bytes it believed it was removing", async () => {
    const { store, sink } = open();
    const before = store.getState().onDisk.get(PAD_AUTOMATION);

    store.getState().removeAutomationLane("pad", "filter.cutoff");
    await store.getState().flushNow();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]!.files).toEqual([]);
    expect(sink.batches[0]!.deletes.map((file) => file.path)).toEqual([PAD_AUTOMATION]);
    expect(before).toBeDefined();
    // The precondition is a hash of real bytes, not a placeholder.
    expect(sink.batches[0]!.deletes[0]!.expectedHash).toHaveLength(
      sink.batches[0]!.deletes[0]!.expectedHash.length,
    );
    expect(store.getState().removing).toEqual([]);
    expect(store.getState().onDisk.has(PAD_AUTOMATION)).toBe(false);
  });

  it("keeps the document when one of several lanes goes", () => {
    const { store } = open();
    store.getState().addAutomationLane("pad", "pan");

    store.getState().removeAutomationLane("pad", "filter.cutoff");

    expect(automation(store, "pad").lanes.map((lane) => lane.param)).toEqual(["pan"]);
    expect(store.getState().removing).toEqual([]);
  });
});

describe("automation points", () => {
  it("keeps points strictly increasing when one is added out of order", () => {
    const { store } = open();

    store.getState().addAutomationPoint("pad", "filter.cutoff", 15_360, 3000);

    expect(automation(store, "pad").lanes[0]!.points).toEqual([
      [0, 200],
      [15_360, 3000],
      [30_720, 4000],
      [61_440, 800],
    ]);
  });

  it("refuses a second point at a tick the lane already has", () => {
    const { store } = open();

    expect(() => store.getState().addAutomationPoint("pad", "filter.cutoff", 30_720, 900)).toThrow(/strictly increasing/);
  });

  it("refuses a move past a neighbour, in either direction", () => {
    const { store } = open();

    expect(() => store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 0, 4000)).toThrow(/after the previous/);
    expect(() => store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 61_440, 4000)).toThrow(/before the next/);
    expect(automation(store, "pad").lanes[0]!.points[1]).toEqual([30_720, 4000]);
  });

  it("refuses a value outside the param's own registry range, in the param's unit", () => {
    const { store } = open();

    // `filter.cutoff` is 20..20000 Hz, not permille.
    expect(() => store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 30_720, 25_000)).toThrow(/maximum is 20000/);
    expect(() => store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 30_720, 10)).toThrow(/minimum is 20/);
    expect(() => store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 30_720, 4000.5)).toThrow(/integer/);
  });

  it("refuses a tick past the end of the arrangement", () => {
    const { store } = open();

    expect(() => store.getState().addAutomationPoint("pad", "filter.cutoff", 99_999, 3000)).toThrow(/past the arrangement/);
  });

  it("refuses to remove a lane's last point, because a lane must keep one", () => {
    const { store } = open();
    store.getState().addAutomationLane("bass", "gain");

    expect(() => store.getState().removeAutomationPoint("bass", "gain", 0)).toThrow(/Remove the lane instead/);
    expect(automation(store, "bass").lanes[0]!.points).toHaveLength(1);
  });

  it("removes a point without disturbing the others", () => {
    const { store } = open();

    store.getState().removeAutomationPoint("pad", "filter.cutoff", 1);

    expect(automation(store, "pad").lanes[0]!.points).toEqual([[0, 200], [61_440, 800]]);
    expect(automation(store, "pad").lanes[0]!.interp).toBe("linear");
  });
});

describe("what an automation edit means to a running transport", () => {
  /**
   * The decision, checked rather than declared: an automation lane produces no
   * events, so every automation edit is a `parameters` change and is heard in
   * the next scheduling window instead of at the next bar line (PLAN.md §12 step
   * 6). If the compiler ever let a lane reach an event, this fails.
   */
  it.each([
    ["moving a point", (store: DocumentStore) => store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 20_000, 9000)],
    ["adding a point", (store: DocumentStore) => store.getState().addAutomationPoint("pad", "filter.cutoff", 7680, 1500)],
    ["removing a point", (store: DocumentStore) => store.getState().removeAutomationPoint("pad", "filter.cutoff", 1)],
    ["changing interp", (store: DocumentStore) => store.getState().setAutomationInterp("pad", "filter.cutoff", "step")],
    ["adding a lane", (store: DocumentStore) => store.getState().addAutomationLane("drums", "kick.gain")],
    ["removing a lane", (store: DocumentStore) => store.getState().removeAutomationLane("pad", "filter.cutoff")],
  ])("classifies %s as a parameter change, and the compiled events agree", (_label, edit) => {
    const { store } = open();
    const before = eventsOf(project(store));

    edit(store);

    expect(store.getState().audioEdit?.effect).toBe("parameters");
    expect(eventsOf(project(store))).toEqual(before);
  });

  it("still changes the automation the engine will apply", () => {
    const { store } = open();
    const before = compile(project(store), { sampleRate: 48_000, seed: 0 });

    store.getState().moveAutomationPoint("pad", "filter.cutoff", 1, 30_720, 9000);

    const after = compile(project(store), { sampleRate: 48_000, seed: 0 });
    const padBefore = before.tracks.find((track) => track.trackId === "pad")!.automation;
    const padAfter = after.tracks.find((track) => track.trackId === "pad")!.automation;
    expect(padAfter).not.toEqual(padBefore);
    expect(padAfter[0]!.points).toContainEqual([expect.any(Number), 9000]);
  });

  it.each([
    ["a lane default", (store: DocumentStore) => store.getState().setLaneDefaults("drums-verse", "hat", { velocity: 400 })],
    ["project swing", (store: DocumentStore) => store.getState().setProjectSwing(400)],
    ["a lane's grid", (store: DocumentStore) => store.getState().setLaneStepsPerBar("drums-verse", "hat", 8)],
  ])("classifies %s as structural, because the events themselves change", (_label, edit) => {
    const { store } = open();
    const before = eventsOf(project(store));

    edit(store);

    expect(store.getState().audioEdit?.effect).toBe("structural");
    expect(eventsOf(project(store))).not.toEqual(before);
  });
});

/**
 * Store actions must not depend on `this`.
 *
 * React hands an action to a component detached from the state object — a fader
 * receives `useStore(documentStore, (s) => s.setInstrumentParam)` and calls it as a
 * bare function — so any action reaching a sibling through `this` throws once it is
 * wired to a control. Reaching the action as `getState().setInstrumentParam(...)`
 * binds `this` and hides that entirely, which is how `setInstrumentParam` shipped
 * broken past a green suite until a fader was dragged in a browser.
 *
 * So these cases call every action the way React does: pulled off the state and
 * invoked with no receiver.
 */
describe("actions survive being detached from the store", () => {
  it("sets one instrument param when called as a bare function", () => {
    const { store } = open();
    const { setInstrumentParam } = store.getState();
    setInstrumentParam("bass-synth", "filter.cutoff", 1200);
    expect(project(store).instruments.get("bass-synth")?.params?.["filter.cutoff"]).toBe(1200);
  });

  it("leaves the params beside it exactly as they were", () => {
    const { store } = open();
    const before = { ...project(store).instruments.get("bass-synth")!.params };
    const { setInstrumentParam } = store.getState();
    setInstrumentParam("bass-synth", "filter.cutoff", 1200);
    const after = project(store).instruments.get("bass-synth")!.params!;
    for (const [key, value] of Object.entries(before)) {
      if (key === "filter.cutoff") continue;
      expect(after[key], `param "${key}"`).toBe(value);
    }
  });

  it("removes the key when the value goes back to undefined", () => {
    const { store } = open();
    const { setInstrumentParam } = store.getState();
    setInstrumentParam("bass-synth", "filter.cutoff", undefined);
    expect(project(store).instruments.get("bass-synth")?.params?.["filter.cutoff"]).toBeUndefined();
  });
});
