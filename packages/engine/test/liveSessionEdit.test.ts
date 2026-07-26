import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadProject,
  type DrumkitInstrumentDoc,
  type GridPatternDoc,
  type Project,
  type SynthInstrumentDoc,
} from "@chord-garden/format";
import { describe, expect, it } from "vitest";
import { CONTROL_BLOCK_SIZE } from "../src/dsp/index.js";
import { LIVE_PROCESSOR_NAME, type LiveCommand, type LiveEvent } from "../src/live/protocol.js";
import { LiveSession } from "../src/live/session.js";
import type { Ticker } from "../src/live/host.js";
import { renderLive, type LiveRenderTarget } from "./live/liveRun.js";
import { createWorkletHarness } from "./live/workletHarness.js";

/**
 * Editing the document while the engine is running.
 *
 * Driven through `LiveSession` against the real worklet, which is the path the web
 * app takes: the app hands `update` an edited project and a classification, and
 * everything below — recompiling, loading sample content the edit newly needs, and
 * the §12-step-6 timing — happens here. `liveTransport.test.ts` covers the transport
 * and scheduler beneath this; what these cases add is that a *document* edit gets
 * through them intact.
 */

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
const SAMPLE_RATE = 48_000;

function loadedProject(root = FIXTURE): Project {
  const loaded = loadProject(root);
  if (loaded.project === undefined) {
    throw new Error(`fixture ${root} did not load: ${loaded.diagnostics.map((each) => each.message).join("; ")}`);
  }
  return loaded.project;
}

interface SessionRun extends LiveRenderTarget {
  session: LiveSession;
  posted: LiveCommand[];
  fetched: string[];
}

/** A real `LiveSession` wired to the real worklet, as `LivePlayer` wires it in the app. */
async function createSessionRun(project: Project): Promise<SessionRun> {
  const harness = await createWorkletHarness(LIVE_PROCESSOR_NAME);
  const clock = { currentTime: 0 };
  const posted: LiveCommand[] = [];
  const fetched: string[] = [];
  const ticker: Ticker = { start() {}, stop() {} };
  const session = await LiveSession.create({
    clock,
    sink: {
      postMessage(command) {
        posted.push(command);
        harness.send(command);
      },
    },
    sampleRate: SAMPLE_RATE,
    project,
    seed: 0,
    ticker,
    fetchSample: async (path) => {
      fetched.push(path);
      return readFileSync(join(project.root, path));
    },
  });
  return { harness, transport: session.transport, clock, sampleRate: SAMPLE_RATE, session, posted, fetched };
}

function errors(events: readonly LiveEvent[]): string[] {
  return events.flatMap((event) => (event.type === "error" ? [event.message] : []));
}

function configures(posted: readonly LiveCommand[]) {
  return posted.filter((command) => command.type === "configure");
}

/** The fixture with one more kick hit in the second half of the bar. */
function withExtraKick(project: Project): Project {
  const edited = structuredClone(project);
  const pattern = edited.patterns.get("drums-verse");
  if (pattern?.kind !== "grid") throw new Error("fixture lost its grid pattern");
  const kick = pattern.lanes.find((lane) => lane.lane === "kick");
  if (kick === undefined) throw new Error("fixture lost its kick lane");
  kick.steps = "x..x ..x. x..x x.x.";
  return edited;
}

/** The fixture reduced to a kick-only kit and a kick-only pattern. */
function kickOnly(project: Project): Project {
  const edited = structuredClone(project);
  const drumkit = edited.instruments.get("drumkit-main") as DrumkitInstrumentDoc | undefined;
  if (drumkit === undefined || drumkit.type !== "drumkit") throw new Error("fixture lost its drumkit");
  drumkit.kit = { kick: drumkit.kit["kick"]! };
  const pattern = edited.patterns.get("drums-verse") as GridPatternDoc | undefined;
  if (pattern === undefined || pattern.kind !== "grid") throw new Error("fixture lost its grid pattern");
  pattern.lanes = pattern.lanes.filter((lane) => lane.lane === "kick");
  return edited;
}

function withBassGain(project: Project, gainDb100: number): Project {
  const edited = structuredClone(project);
  const bass = edited.instruments.get("bass-synth") as SynthInstrumentDoc | undefined;
  if (bass === undefined || bass.type !== "synth") throw new Error("fixture lost its bass synth");
  bass.params = { ...bass.params, gain: gainDb100 };
  return edited;
}

describe("a document edit during playback", () => {
  /**
   * The guarantee PLAN.md §12 step 6 asks for, stated as audio: the sound before the
   * bar line is bit-identical to a run that never received the edit, and the sound
   * after it is not.
   */
  it("takes effect at the next bar boundary and changes nothing before it", async () => {
    const blocks = 900;
    const untouched = await createSessionRun(loadedProject());
    untouched.session.start();
    const plain = renderLive(untouched, blocks * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    const edited = await createSessionRun(loadedProject());
    edited.session.start();
    edited.transport.tick();
    await edited.session.update(withExtraKick(loadedProject()), "structural");

    const barLine = edited.session.barStarts[1]!;
    const switchBlock = Math.ceil(barLine / CONTROL_BLOCK_SIZE) * CONTROL_BLOCK_SIZE;
    expect(configures(edited.posted).at(-1)).toMatchObject({ atSample: switchBlock, generation: 1 });

    const live = renderLive(edited, blocks * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    for (let index = 0; index < switchBlock; index++) {
      if (!Object.is(plain.left[index], live.left[index])) {
        throw new Error(`a document edit changed sample ${index}, before the bar line at ${switchBlock}`);
      }
    }
    let differs = 0;
    for (let index = switchBlock; index < blocks * CONTROL_BLOCK_SIZE; index++) {
      if (!Object.is(plain.left[index], live.left[index])) differs++;
    }
    expect(differs).toBeGreaterThan(0);
    expect(errors(edited.harness.events)).toEqual([]);
  });

  it("applies at once while stopped, because there is nothing left to wait for", async () => {
    const run = await createSessionRun(loadedProject());

    const outcome = await run.session.update(withExtraKick(loadedProject()), "structural");

    expect(outcome).toEqual({ effect: "structural", atSample: null });
    expect(configures(run.posted).at(-1)).toMatchObject({ atSample: null, generation: 1 });
    expect(errors(run.harness.events)).toEqual([]);
  });

  it("recompiles from the edited document, so the new schedule is the one playing", async () => {
    const run = await createSessionRun(loadedProject());
    const before = run.session.schedule.tracks[0]!.events.length;

    await run.session.update(withExtraKick(loadedProject()), "structural");

    // One hit added to a one-bar pattern that the arrangement repeats sixteen times.
    expect(before).toBe(239);
    expect(run.session.schedule.tracks[0]!.events.length).toBe(before + 16);
  });

  it("loads sample content the edit newly needs, and the worklet accepts the graph", async () => {
    const run = await createSessionRun(kickOnly(loadedProject()));
    expect(run.fetched).toEqual(["samples/kick.wav"]);
    expect(run.session.sampleHashes.has("samples/hat.wav")).toBe(false);
    run.session.start();
    renderLive(run, 200 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    // The edit restores the hat voice and its lane, so a sample the worklet has
    // never been sent is now named by the graph. A configure naming unknown content
    // is rejected by the worklet, so this only works if the bytes go first.
    await run.session.update(loadedProject(), "structural");

    expect(run.fetched).toEqual(["samples/kick.wav", "samples/hat.wav"]);
    expect(run.session.sampleHashes.get("samples/hat.wav")).toBeTypeOf("string");
    expect(errors(run.harness.events)).toEqual([]);
    const tail = renderLive(run, 400 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
    expect(errors(run.harness.events)).toEqual([]);
    expect(Math.max(...tail.left)).toBeGreaterThan(0);
  });

  it("does not re-post sample content it has already loaded", async () => {
    const run = await createSessionRun(loadedProject());
    const sampleCommands = run.posted.filter((command) => command.type === "sampleData").length;
    expect(sampleCommands).toBe(2);

    await run.session.update(withExtraKick(loadedProject()), "structural");

    expect(run.posted.filter((command) => command.type === "sampleData")).toHaveLength(sampleCommands);
    // In kit order, which `fmt` sorts alphabetically; the point is that it is the
    // same two paths, fetched once each.
    expect(run.fetched).toEqual(["samples/hat.wav", "samples/kick.wav"]);
  });

  it("pushes a parameter edit in place, without waiting for a bar", async () => {
    const run = await createSessionRun(loadedProject());
    run.session.start();
    renderLive(run, 100 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
    const configuresBefore = configures(run.posted).length;

    const outcome = await run.session.update(withBassGain(loadedProject(), -1800), "parameters");

    expect(outcome).toEqual({ effect: "parameters", atSample: null });
    // No graph swap at all: the events did not move, so nothing is withdrawn.
    expect(configures(run.posted)).toHaveLength(configuresBefore);
    const params = run.posted.filter((command) => command.type === "params");
    expect(params).toHaveLength(3);
    expect(params.map((command) => (command.type === "params" ? command.generation : -1))).toEqual([0, 0, 0]);
    expect(errors(run.harness.events)).toEqual([]);
  });

  /**
   * The reason the classification can live in the editor that made the edit: a wrong
   * answer in the dangerous direction is loud. The scheduler compares the recompiled
   * schedule against what is playing and refuses.
   */
  it("refuses an edit called parametric that actually moved an event", async () => {
    const run = await createSessionRun(loadedProject());
    run.session.start();
    run.transport.tick();

    await expect(run.session.update(withExtraKick(loadedProject()), "parameters")).rejects.toThrow(
      /cannot apply a parameter change: .*which is structural/,
    );
  });

  it("keeps working after a rejected edit rather than wedging the queue", async () => {
    const run = await createSessionRun(loadedProject());
    run.session.start();
    run.transport.tick();

    await expect(run.session.update(withExtraKick(loadedProject()), "parameters")).rejects.toThrow();
    const outcome = await run.session.update(withExtraKick(loadedProject()), "structural");

    expect(outcome.effect).toBe("structural");
    expect(errors(run.harness.events)).toEqual([]);
  });

  it("applies a burst of edits in order, and ends on the last one", async () => {
    const run = await createSessionRun(loadedProject());
    run.session.start();
    run.transport.tick();

    const steps = ["x..x ..x. x..x x.x.", "x..x ..x. x..x xxx.", "xx.x ..x. x..x xxx."];
    const outcomes = await Promise.all(
      steps.map((pattern) => {
        const edited = structuredClone(loadedProject());
        const grid = edited.patterns.get("drums-verse");
        if (grid?.kind !== "grid") throw new Error("fixture lost its grid pattern");
        grid.lanes.find((lane) => lane.lane === "kick")!.steps = pattern;
        return run.session.update(edited, "structural");
      }),
    );

    expect(outcomes.map((outcome) => outcome.effect)).toEqual(["structural", "structural", "structural"]);
    // The last edit's schedule is the one held — three hits added to each of the
    // sixteen bars — and its generation is the one the worklet was last configured
    // for. Each edit queued its own change and replaced the one before it.
    expect(run.session.schedule.tracks[0]!.events.length).toBe(239 + 3 * 16);
    expect(configures(run.posted).at(-1)).toMatchObject({ generation: 3 });
    expect(errors(run.harness.events)).toEqual([]);
  });
});

describe("a document edit while nothing has started", () => {
  it("is heard when playback begins, because the session holds the edited schedule", async () => {
    const run = await createSessionRun(loadedProject());
    await run.session.update(withExtraKick(loadedProject()), "structural");
    const expected = run.session.schedule.tracks[0]!.events.length;

    run.session.start();
    renderLive(run, 400 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    expect(run.session.schedule.tracks[0]!.events.length).toBe(expected);
    expect(errors(run.harness.events)).toEqual([]);
  });
});
