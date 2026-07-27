import { fileURLToPath } from "node:url";
import { loadProject, type Project } from "@chord-garden/format";
import { describe, expect, it } from "vitest";
import { CONTROL_BLOCK_SIZE } from "../src/index.js";
import { render } from "../src/render/renderer.js";
import { alignedTail, createLiveRun, renderLive } from "./live/liveRun.js";

/** `loadProject` returns diagnostics too; a fixture that fails to load is a bug here. */
function loadedProject(root: string): Project {
  const loaded = loadProject(root);
  if (loaded.project === undefined) {
    throw new Error(`fixture ${root} did not load: ${loaded.diagnostics.map((d) => d.message).join("; ")}`);
  }
  return loaded.project;
}

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
const SWUNG = fileURLToPath(new URL("../../../fixtures/valid/swung-hats", import.meta.url));
const EFFECTS = fileURLToPath(new URL("../../../fixtures/valid/effects-chain", import.meta.url));

interface Difference {
  index: number;
  offline: number;
  live: number;
}

function peak(samples: Float32Array): number {
  let highest = 0;
  for (const sample of samples) highest = Math.max(highest, Math.abs(sample));
  return highest;
}

/** Every sample the two paths disagree on, so a failure can name the first one. */
function differences(offline: Float32Array, live: Float32Array): Difference[] {
  if (offline.length !== live.length) throw new Error(`lengths differ: ${offline.length} vs ${live.length}`);
  const found: Difference[] = [];
  for (let index = 0; index < offline.length; index++) {
    const a = offline[index]!;
    const b = live[index]!;
    if (!Object.is(a, b)) found.push({ index, offline: a, live: b });
  }
  return found;
}

describe("live and offline equivalence", () => {
  /**
   * The claim under test is not "both paths call the same compiler" — they
   * obviously do, and that proves nothing about the audio. It is that cutting the
   * schedule into lookahead windows and delivering them incrementally, through the
   * worklet's own block-processing path, produces the same samples as rendering the
   * whole thing at once offline.
   */
  it("renders the worked fixture bit-identically through the worklet in lookahead slices", async () => {
    const project = loadedProject(FIXTURE);
    const run = await createLiveRun(project, { sampleRate: 48_000, seed: 0 });
    const totalSamples = alignedTail(run.schedule, 48_000, 2);
    const tailSeconds = (totalSamples - run.schedule.totalSamples) / 48_000;

    const offline = render(project, { sampleRate: 48_000, seed: 0, tailSeconds });
    expect(offline.totalSamples).toBe(totalSamples);

    run.transport.start();
    const live = renderLive(run, totalSamples);

    expect(differences(offline.master.left, live.left)).toEqual([]);
    expect(differences(offline.master.right, live.right)).toEqual([]);
    // Nothing may be silently absent: an all-zero comparison would also pass.
    expect(peak(live.left)).toBeGreaterThan(0.1);
  });

  it("renders the swung fixture bit-identically, and under a lookahead of one block", async () => {
    const project = loadedProject(SWUNG);
    for (const lookaheadSamples of [CONTROL_BLOCK_SIZE, 640, 4864, 48_000]) {
      const run = await createLiveRun(project, { lookaheadSamples });
      const totalSamples = alignedTail(run.schedule, 48_000, 1);
      const tailSeconds = (totalSamples - run.schedule.totalSamples) / 48_000;
      const offline = render(project, { sampleRate: 48_000, seed: 0, tailSeconds });

      run.transport.start();
      const live = renderLive(run, totalSamples, { tickEveryBlocks: 1 });

      expect({ lookaheadSamples, left: differences(offline.master.left, live.left) }).toEqual({
        lookaheadSamples,
        left: [],
      });
      expect(differences(offline.master.right, live.right)).toEqual([]);
    }
  });

  /**
   * Effects are the case most likely to break this claim and least likely to show
   * it. Every effect here is recursive, so its output at any sample depends on
   * every sample before it: a chain built at the wrong moment, reset on a slice
   * boundary, or fed a ramp computed from the wrong block position produces audio
   * that is still plausible — a slightly different tail — and identical in every
   * onset, level and event count an analysis would report. Bit equality is the only
   * test that catches it.
   */
  it("renders an effect chain bit-identically, including its tail past the last event", async () => {
    const project = loadedProject(EFFECTS);
    for (const lookaheadSamples of [CONTROL_BLOCK_SIZE, 4864, 48_000]) {
      const run = await createLiveRun(project, { lookaheadSamples });
      const totalSamples = alignedTail(run.schedule, 48_000, 3);
      const tailSeconds = (totalSamples - run.schedule.totalSamples) / 48_000;
      const offline = render(project, { sampleRate: 48_000, seed: 0, tailSeconds });

      run.transport.start();
      const live = renderLive(run, totalSamples, { tickEveryBlocks: 1 });

      expect({ lookaheadSamples, left: differences(offline.master.left, live.left) }).toEqual({
        lookaheadSamples,
        left: [],
      });
      expect(differences(offline.master.right, live.right)).toEqual([]);
      // The tail is the part only the effects can produce, so it has to be
      // non-silent or this proves nothing about them.
      expect(peak(live.left.subarray(run.schedule.totalSamples))).toBeGreaterThan(0.0001);
      expect(peak(live.left)).toBeGreaterThan(0.1);
    }
  });

  it("reports no starved blocks when the scheduler keeps up, and counts them when it does not", async () => {
    const project = loadedProject(FIXTURE);
    const healthy = await createLiveRun(project);
    healthy.transport.start();
    renderLive(healthy, 48_000);
    const healthyReports = healthy.harness.events.filter((event) => event.type === "position");
    expect(healthyReports.length).toBeGreaterThan(0);
    expect(healthyReports.at(-1)).toMatchObject({ underrunBlocks: 0, playing: true });

    // A transport that is never ticked delivers nothing: the worklet renders on
    // regardless and says so, rather than stalling or repeating a block.
    const starved = await createLiveRun(project);
    starved.harness.send({ type: "start" });
    const rendered = renderLive(starved, 4096, { tickEveryBlocks: Number.POSITIVE_INFINITY });
    const starvedReport = starved.harness.events.filter((event) => event.type === "position").at(-1);
    expect(starvedReport).toMatchObject({ underrunBlocks: 4096 / CONTROL_BLOCK_SIZE });
    expect(peak(rendered.left)).toBe(0);
  });
});
