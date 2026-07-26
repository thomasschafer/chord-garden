import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@chord-garden/format";
import { compile, musicalGrid, type CompiledSchedule } from "../../src/compiler.js";
import { CONTROL_BLOCK_SIZE } from "../../src/dsp/index.js";
import { liveGraph, requiredSamplePaths, type LiveGraph } from "../../src/live/configure.js";
import { LiveTransport, lookaheadSamples, type Ticker } from "../../src/live/host.js";
import { LIVE_PROCESSOR_NAME, type LiveCommand, type LiveEvent } from "../../src/live/protocol.js";
import { hashContent } from "../../src/live/sampleCache.js";
import { LiveScheduler } from "../../src/live/scheduler.js";
import { decodeWav } from "../../src/render/wav.js";
import { createWorkletHarness, type WorkletHarness } from "./workletHarness.js";

export interface LiveRunOptions {
  sampleRate?: number;
  seed?: number;
  /** Lookahead in samples; must be a whole number of render quanta. */
  lookaheadSamples?: number;
}

/**
 * What `renderLive` needs to drive a live path: a worklet, something to schedule
 * into it, and a clock. Narrower than `LiveRun` so a test that builds its transport
 * through `LiveSession` — as the app does — can be rendered by the same function
 * rather than a second copy of the render loop.
 */
export interface LiveRenderTarget {
  harness: WorkletHarness;
  transport: LiveTransport;
  clock: { currentTime: number };
  sampleRate: number;
}

export interface LiveRun extends LiveRenderTarget {
  scheduler: LiveScheduler;
  schedule: CompiledSchedule;
  barStarts: readonly number[];
  /** Every command the transport posted, in order, for protocol assertions. */
  posted: LiveCommand[];
  graphOf: (schedule: CompiledSchedule) => LiveGraph;
  contentHashes: Map<string, string>;
  /** Send replacement content for a sample, as the sidecar-fed cache would. */
  sendSample(path: string, bytes: Uint8Array): void;
}

/**
 * Wires a project to a real worklet instance the way the browser will: samples
 * pushed in first, then a configure, then slices from the lookahead scheduler.
 * Nothing here reaches into the engine's internals, so a test driving this is
 * testing the same path the app will take.
 */
export async function createLiveRun(project: Project, options: LiveRunOptions = {}): Promise<LiveRun> {
  const sampleRate = options.sampleRate ?? 48_000;
  const seed = options.seed ?? 0;
  const lookahead = options.lookaheadSamples ?? lookaheadSamples(sampleRate);
  const schedule = compile(project, { sampleRate, seed });
  const barStarts = musicalGrid(project, { sampleRate, seed }).barStarts;
  const harness = await createWorkletHarness(LIVE_PROCESSOR_NAME);
  const contentHashes = new Map<string, string>();
  const posted: LiveCommand[] = [];

  const sendSample = (path: string, bytes: Uint8Array): void => {
    const decoded = decodeWav(bytes);
    contentHashes.set(path, hashContent(bytes));
    const right = decoded.channels[1];
    harness.send({
      type: "sampleData",
      path,
      contentHash: hashContent(bytes),
      sampleRate: decoded.sampleRate,
      left: decoded.channels[0],
      ...(right === undefined ? {} : { right }),
    });
  };

  for (const path of requiredSamplePaths(project, schedule)) {
    sendSample(path, readFileSync(join(project.root, path)));
  }

  const graphOf = (target: CompiledSchedule): LiveGraph =>
    liveGraph(project, target, (path) => {
      const hash = contentHashes.get(path);
      if (hash === undefined) throw new Error(`test setup has no content hash for "${path}"`);
      return hash;
    });

  const clock = { currentTime: 0 };
  const scheduler = new LiveScheduler(schedule, barStarts, lookahead);
  const ticker: Ticker = { start() {}, stop() {} };
  const transport = new LiveTransport({
    clock,
    sink: {
      postMessage(message) {
        posted.push(message);
        harness.send(message);
      },
    },
    scheduler,
    sampleRate,
    ticker,
    graphOf,
  });

  transport.sendConfigure({ generation: 0, atSample: null, schedule }, graphOf(schedule));

  return {
    harness,
    transport,
    scheduler,
    schedule,
    barStarts,
    clock,
    sampleRate,
    posted,
    graphOf,
    contentHashes,
    sendSample,
  };
}

export interface LiveRenderOptions {
  /** Scheduling passes happen every this many blocks; 8 blocks is ~21 ms. */
  tickEveryBlocks?: number;
  /** Feed position reports back to the transport, as the app's onmessage will. */
  acceptReports?: boolean;
}

export interface LiveRenderResult {
  left: Float32Array;
  right: Float32Array;
  events: LiveEvent[];
}

/**
 * Render `totalSamples` of live output, advancing the clock exactly as fast as
 * blocks are produced. `totalSamples` must be a whole number of quanta: the live
 * path only ever renders whole quanta, and pretending otherwise would hide the one
 * real difference from the offline renderer, whose final block may be short.
 */
export function renderLive(run: LiveRenderTarget, totalSamples: number, options: LiveRenderOptions = {}): LiveRenderResult {
  if (totalSamples % CONTROL_BLOCK_SIZE !== 0) {
    throw new Error(`live render length ${totalSamples} is not a whole number of ${CONTROL_BLOCK_SIZE}-sample quanta`);
  }
  const tickEveryBlocks = options.tickEveryBlocks ?? 8;
  const acceptReports = options.acceptReports ?? true;
  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const blockLeft = new Float32Array(CONTROL_BLOCK_SIZE);
  const blockRight = new Float32Array(CONTROL_BLOCK_SIZE);
  let seenEvents = 0;

  for (let blockStart = 0; blockStart < totalSamples; blockStart += CONTROL_BLOCK_SIZE) {
    if ((blockStart / CONTROL_BLOCK_SIZE) % tickEveryBlocks === 0) run.transport.tick();
    if (acceptReports) {
      for (; seenEvents < run.harness.events.length; seenEvents++) {
        run.transport.acceptEvent(run.harness.events[seenEvents]!);
      }
    }
    if (!run.harness.render(blockLeft, blockRight)) {
      throw new Error(`worklet refused to continue at sample ${blockStart}`);
    }
    left.set(blockLeft, blockStart);
    right.set(blockRight, blockStart);
    run.clock.currentTime += CONTROL_BLOCK_SIZE / run.sampleRate;
  }
  return { left, right, events: run.harness.events };
}

/** Render length that is a whole number of quanta and leaves at least `tailSeconds`. */
export function alignedTail(schedule: CompiledSchedule, sampleRate: number, tailSeconds: number): number {
  const minimum = schedule.totalSamples + Math.round(tailSeconds * sampleRate);
  return Math.ceil(minimum / CONTROL_BLOCK_SIZE) * CONTROL_BLOCK_SIZE;
}
