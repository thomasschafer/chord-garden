import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, type DrumkitInstrumentDoc, type GridPatternDoc, type Project } from "@chord-garden/format";
import { describe, expect, it } from "vitest";
import { CONTROL_BLOCK_SIZE } from "../src/dsp/index.js";
import { LiveEngine } from "../src/live/engine.js";
import { LIVE_PROCESSOR_NAME, type LiveCommand, type LiveEvent } from "../src/live/protocol.js";
import { hashContent } from "../src/live/sampleCache.js";
import { LiveSession } from "../src/live/session.js";
import type { Ticker } from "../src/live/host.js";
import { decodeWav, encodeWav } from "../src/render/wav.js";
import { renderLive, type LiveRenderTarget } from "./live/liveRun.js";
import { createWorkletHarness } from "./live/workletHarness.js";

/**
 * Replacing a sample file while the engine is playing (PLAN.md §14, and §16's
 * Phase 2 criterion).
 *
 * The gap this closes: a replaced `samples/kick.wav` changes what the project sounds
 * like without changing a single document, so nothing in the document path can carry
 * it. What the sidecar sends is an announcement of content hashes, and this is the
 * receiving end of it — driven through `LiveSession` against the real worklet, which
 * is the path the app takes.
 *
 * Two properties are worth more than the rest, and each has its own case below:
 * the new audio really is what plays afterwards, and a hit that was already sounding
 * when the file changed is not spliced onto the new buffer mid-flight.
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
  /**
   * The bytes the fetcher serves per path — this test's stand-in for the disk, so
   * "the file was replaced" is one assignment and the fixture is never written to.
   */
  disk: Map<string, Uint8Array>;
}

/** A real `LiveSession` and worklet, fed from a disk the test can rewrite. */
async function createSessionRun(project: Project): Promise<SessionRun> {
  const harness = await createWorkletHarness(LIVE_PROCESSOR_NAME);
  const clock = { currentTime: 0 };
  const posted: LiveCommand[] = [];
  const fetched: string[] = [];
  const disk = new Map<string, Uint8Array>();
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
      const held = disk.get(path);
      if (held !== undefined) return held;
      return readFileSync(join(project.root, path));
    },
  });
  return { harness, transport: session.transport, clock, sampleRate: SAMPLE_RATE, session, posted, fetched, disk };
}

function errors(events: readonly LiveEvent[]): string[] {
  return events.flatMap((event) => (event.type === "error" ? [event.message] : []));
}

/** The fixture's kick, at a level nothing else in the project reaches. */
function loudKick(): Uint8Array {
  const original = decodeWav(readFileSync(join(FIXTURE, "samples/kick.wav")));
  const left = new Float32Array(original.channels[0].length).fill(0.9);
  return encodeWav({ sampleRate: original.sampleRate, left }, 16);
}

/** How many output samples one hit of `bytes` lasts at the engine's rate. */
function soundingSamples(bytes: Uint8Array): number {
  const decoded = decodeWav(bytes);
  return Math.floor((decoded.channels[0].length * SAMPLE_RATE) / decoded.sampleRate);
}

/** Sample positions the drum track triggers `voice` at, in schedule order. */
function onsetsOf(session: LiveSession, voice: string): number[] {
  const track = session.schedule.tracks.find((each) => each.trackId === "drums");
  if (track === undefined) throw new Error("the fixture lost its drums track");
  return track.events.filter((event) => event.voice === voice).map((event) => event.startSample);
}

/** First index at which two renders disagree, or -1 when they never do. */
function firstDifference(a: Float32Array, b: Float32Array): number {
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return index;
  }
  return -1;
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

/** The content hash of a path as the session currently holds it. */
function heldHash(session: LiveSession, path: string): string {
  const hash = session.sampleHashes.get(path);
  if (hash === undefined) throw new Error(`the session holds no content for "${path}"`);
  return hash;
}

describe("a sample file replaced while the engine plays", () => {
  /**
   * The whole point, stated as audio: after the swap the *next* hit of that voice is
   * the new file, and every sample before that hit is bit-identical to a run that
   * never heard about the change — including the middle of the hit that was sounding
   * when it landed.
   */
  it("takes effect at the next hit of that voice and changes nothing before it", async () => {
    const blocks = 900;
    const control = await createSessionRun(loadedProject());
    control.session.start();
    const plain = renderLive(control, blocks * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    const run = await createSessionRun(loadedProject());
    run.session.start();
    const replacement = loudKick();
    const kickOnsets = onsetsOf(run.session, "kick");
    const sounding = soundingSamples(readFileSync(join(FIXTURE, "samples/kick.wav")));
    // The swap must land while a kick is still ringing, or this case proves nothing
    // about the sounding voice. Asserted rather than assumed: if the fixture's kick
    // ever becomes shorter than a couple of quanta, this fails instead of going quiet.
    expect(sounding).toBeGreaterThan(4 * CONTROL_BLOCK_SIZE);
    const swapBlock = Math.floor((kickOnsets[1]! + sounding / 2) / CONTROL_BLOCK_SIZE);
    const swapSample = swapBlock * CONTROL_BLOCK_SIZE;
    expect(swapSample).toBeGreaterThan(kickOnsets[1]!);
    expect(swapSample).toBeLessThan(kickOnsets[1]! + sounding);

    const before = renderLive(run, swapSample, { tickEveryBlocks: 4 });
    run.disk.set("samples/kick.wav", replacement);
    const outcome = await run.session.applySampleChange([
      { path: "samples/kick.wav", contentHash: hashContent(replacement) },
    ]);
    expect(outcome).toEqual({ reloaded: ["samples/kick.wav"], unchanged: [], ignored: [] });
    const after = renderLive(run, blocks * CONTROL_BLOCK_SIZE - swapSample, { tickEveryBlocks: 4 });

    const live = new Float32Array(blocks * CONTROL_BLOCK_SIZE);
    live.set(before.left, 0);
    live.set(after.left, swapSample);

    const nextOnset = kickOnsets.find((onset) => onset >= swapSample);
    if (nextOnset === undefined) throw new Error("no kick hit follows the swap; lengthen the render");
    // Not "differs somewhere after the swap": differs at exactly the next trigger. A
    // buffer swapped under the sounding hit would show up at `swapSample` instead.
    expect(firstDifference(plain.left, live)).toBe(nextOnset);
    expect(Math.max(...live.subarray(nextOnset))).toBeGreaterThan(Math.max(...plain.left.subarray(nextOnset)));
    expect(errors(run.harness.events)).toEqual([]);
  });

  it("sends the replacement to the worklet under its new content hash", async () => {
    const run = await createSessionRun(loadedProject());
    const replacement = loudKick();
    const originalHash = heldHash(run.session, "samples/kick.wav");

    run.disk.set("samples/kick.wav", replacement);
    await run.session.applySampleChange([
      { path: "samples/kick.wav", contentHash: hashContent(replacement) },
    ]);

    // Hashed from the bytes that arrived, not copied from the announcement: the disk
    // may have moved again in between, and only the bytes can say what is playing.
    expect(run.session.sampleHashes.get("samples/kick.wav")).toBe(hashContent(replacement));
    expect(run.session.sampleHashes.get("samples/kick.wav")).not.toBe(originalHash);
    const sent = run.posted.filter((command) => command.type === "sampleData");
    expect(sent.at(-1)).toMatchObject({ path: "samples/kick.wav", contentHash: hashContent(replacement) });
    // No graph swap: the schedule did not move, and rebuilding it would silence every
    // voice currently sounding for a change that does not need it.
    expect(run.posted.filter((command) => command.type === "configure")).toHaveLength(1);
    expect(errors(run.harness.events)).toEqual([]);
  });

  it("fetches nothing when the announcement names content it already holds", async () => {
    const run = await createSessionRun(loadedProject());
    const fetchedBefore = run.fetched.length;

    const outcome = await run.session.applySampleChange([
      { path: "samples/kick.wav", contentHash: heldHash(run.session, "samples/kick.wav") },
      { path: "samples/hat.wav", contentHash: heldHash(run.session, "samples/hat.wav") },
    ]);

    // The engine's own echo check. It is what makes a redundant announcement free —
    // and there will be redundant ones, because the sidecar announces what *it*
    // noticed and the page may already have fetched the same bytes.
    expect(outcome).toEqual({ reloaded: [], unchanged: ["samples/kick.wav", "samples/hat.wav"], ignored: [] });
    expect(run.fetched).toHaveLength(fetchedBefore);
  });

  it("ignores a sample no track in the schedule plays", async () => {
    const run = await createSessionRun(kickOnly(loadedProject()));
    expect(run.session.sampleHashes.has("samples/hat.wav")).toBe(false);

    const outcome = await run.session.applySampleChange([{ path: "samples/hat.wav", contentHash: "hat-v2" }]);

    // Loading audio nothing can trigger would be work with no sound attached to it;
    // if a later edit brings the voice back, the load happens then, from the disk as
    // it is then.
    expect(outcome).toEqual({ reloaded: [], unchanged: [], ignored: ["samples/hat.wav"] });
    expect(run.fetched).toEqual(["samples/kick.wav"]);
  });

  it("keeps playing the old audio when the replacement cannot be decoded", async () => {
    const blocks = 400;
    const control = await createSessionRun(loadedProject());
    control.session.start();
    const plain = renderLive(control, blocks * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });

    const run = await createSessionRun(loadedProject());
    run.session.start();
    const originalHash = heldHash(run.session, "samples/kick.wav");
    run.disk.set("samples/kick.wav", new Uint8Array([1, 2, 3, 4, 5]));

    await expect(
      run.session.applySampleChange([{ path: "samples/kick.wav", contentHash: "whatever-the-sidecar-said" }]),
    ).rejects.toThrow(/RIFF|WAVE|decode/);

    // Nothing adopted, so the run is still the run it was — and the path still holds
    // the old hash, which is what makes the next announcement try again rather than
    // conclude it has already dealt with this.
    expect(run.session.sampleHashes.get("samples/kick.wav")).toBe(originalHash);
    const live = renderLive(run, blocks * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
    expect(firstDifference(plain.left, live.left)).toBe(-1);
    expect(errors(run.harness.events)).toEqual([]);
  });

  it("survives a failed fetch and adopts the next good replacement", async () => {
    const run = await createSessionRun(loadedProject());
    run.disk.set("samples/kick.wav", new Uint8Array([0]));
    await expect(
      run.session.applySampleChange([{ path: "samples/kick.wav", contentHash: "bad" }]),
    ).rejects.toThrow();

    const replacement = loudKick();
    run.disk.set("samples/kick.wav", replacement);
    const outcome = await run.session.applySampleChange([
      { path: "samples/kick.wav", contentHash: hashContent(replacement) },
    ]);

    // A rejected reload must not wedge the queue behind a permanently rejected promise
    // — the same rule `update` follows.
    expect(outcome.reloaded).toEqual(["samples/kick.wav"]);
    expect(errors(run.harness.events)).toEqual([]);
  });
});

describe("a sample change and a document edit from one settle window", () => {
  /**
   * An agent adding a kit voice *and* dropping in the WAV it names is one edit to the
   * person making it and two messages on the wire. Both orders have to work: the
   * worklet refuses a graph naming content it has not been sent, and a reload of a
   * path the session does not hold yet has nothing to do.
   */
  it("adopts both when the samples arrive first", async () => {
    const run = await createSessionRun(kickOnly(loadedProject()));
    run.session.start();
    renderLive(run, 200 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
    const replacement = loudKick();
    run.disk.set("samples/kick.wav", replacement);

    const samples = await run.session.applySampleChange([
      { path: "samples/kick.wav", contentHash: hashContent(replacement) },
      // The hat is in the announcement because the sidecar reads the disk after the
      // whole edit landed; this session cannot use it until the edit arrives.
      { path: "samples/hat.wav", contentHash: hashContent(readFileSync(join(FIXTURE, "samples/hat.wav"))) },
    ]);
    await run.session.update(loadedProject(), "structural");

    expect(samples.reloaded).toEqual(["samples/kick.wav"]);
    expect(samples.ignored).toEqual(["samples/hat.wav"]);
    expect(run.session.sampleHashes.get("samples/kick.wav")).toBe(hashContent(replacement));
    expect(run.session.sampleHashes.get("samples/hat.wav")).toBeTypeOf("string");
    const tail = renderLive(run, 400 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
    expect(errors(run.harness.events)).toEqual([]);
    expect(Math.max(...tail.left)).toBeGreaterThan(0);
  });

  it("adopts both when the document edit arrives first", async () => {
    const run = await createSessionRun(kickOnly(loadedProject()));
    run.session.start();
    renderLive(run, 200 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
    const replacement = loudKick();
    run.disk.set("samples/kick.wav", replacement);

    // The document edit's own sample loading skips a path it already holds, so it
    // configures against the *old* kick content — which is exactly what the worklet
    // holds, so the graph is accepted — and the announcement then replaces it.
    await run.session.update(loadedProject(), "structural");
    const samples = await run.session.applySampleChange([
      { path: "samples/kick.wav", contentHash: hashContent(replacement) },
    ]);

    expect(samples.reloaded).toEqual(["samples/kick.wav"]);
    expect(run.session.sampleHashes.get("samples/kick.wav")).toBe(hashContent(replacement));
    const tail = renderLive(run, 400 * CONTROL_BLOCK_SIZE, { tickEveryBlocks: 4 });
    expect(errors(run.harness.events)).toEqual([]);
    expect(Math.max(...tail.left)).toBeGreaterThan(0);
  });

  it("serializes a reload against an edit rather than interleaving them", async () => {
    const run = await createSessionRun(loadedProject());
    run.session.start();
    run.transport.tick();
    const replacement = loudKick();
    run.disk.set("samples/kick.wav", replacement);

    const [samples] = await Promise.all([
      run.session.applySampleChange([{ path: "samples/kick.wav", contentHash: hashContent(replacement) }]),
      run.session.update(loadedProject(), "structural"),
    ]);

    expect(samples.reloaded).toEqual(["samples/kick.wav"]);
    expect(errors(run.harness.events)).toEqual([]);
  });
});

describe("what the worklet keeps hold of", () => {
  /**
   * The lifetime question a sample swap raises: auditioning a kick means replacing the
   * same file over and over, and each replacement is a decoded buffer. One version of
   * it may be retained — the one that is playing — but a run of them must not
   * accumulate.
   */
  it("holds one decoded buffer per path however many times the file is replaced", () => {
    const engine = new LiveEngine({ sampleRate: SAMPLE_RATE, post: () => {} });

    for (let version = 0; version < 20; version++) {
      engine.handle({
        type: "sampleData",
        path: "samples/kick.wav",
        contentHash: `kick-v${version}`,
        sampleRate: SAMPLE_RATE,
        left: new Float32Array(1000).fill(version / 20),
      });
      expect(engine.sampleContentCount).toBe(1);
    }
  });

  it("keeps content that two kit voices share until the last path lets go of it", () => {
    const engine = new LiveEngine({ sampleRate: SAMPLE_RATE, post: () => {} });
    const shared: Omit<Extract<LiveCommand, { type: "sampleData" }>, "path"> = {
      type: "sampleData",
      contentHash: "same-bytes",
      sampleRate: SAMPLE_RATE,
      left: new Float32Array(10).fill(0.5),
    };

    engine.handle({ ...shared, path: "samples/kick.wav" });
    engine.handle({ ...shared, path: "samples/kick-copy.wav" });
    expect(engine.sampleContentCount).toBe(1);

    engine.handle({ ...shared, path: "samples/kick.wav", contentHash: "new-bytes", left: new Float32Array(10) });
    // The copy still plays the old content, so it is still held; the replaced path's
    // is a second buffer, not a leak of a third.
    expect(engine.sampleContentCount).toBe(2);
  });
});
