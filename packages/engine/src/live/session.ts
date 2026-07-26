import type { Project } from "@chord-garden/format";
import { compile, musicalGrid, type CompiledSchedule } from "../compiler.js";
import { decodeWav } from "../render/wav.js";
import { liveGraph, requiredSamplePaths, type LiveGraph } from "./configure.js";
import { intervalTicker, lookaheadSamples, LiveTransport, type AudioClock, type CommandSink, type Ticker } from "./host.js";
import type { LiveCommand, LiveEvent } from "./protocol.js";
import { hashContent } from "./sampleCache.js";
import { LiveScheduler } from "./scheduler.js";

/** How a session gets a sample's bytes; the browser fetches them from the sidecar. */
export type SampleFetcher = (path: string) => Promise<Uint8Array>;

export interface LiveSessionOptions {
  /** The `AudioContext`, for its clock. */
  clock: AudioClock;
  /** The worklet node's `port`. */
  sink: CommandSink;
  /** The context's actual sample rate; the schedule is compiled for it. */
  sampleRate: number;
  project: Project;
  /** Probability seed, matching `musictool render --seed` (PLAN.md §13). */
  seed?: number;
  fetchSample: SampleFetcher;
  /** Injected so tests can drive the scheduler without a real timer. */
  ticker?: Ticker;
  /** Called for every sample as it is loaded, before the graph is configured. */
  onSampleLoaded?: (info: { path: string; bytes: number; contentHash: string; frames: number; sampleRate: number; channels: number }) => void;
}

/**
 * Everything between "here is a validated project and a running AudioContext"
 * and "the transport is ready to play it".
 *
 * This exists because it was written twice: the Phase 2 harness and the Phase 3
 * app need the identical sequence — compile the schedule for the context's rate,
 * fetch and hash and decode every sample the schedule names, build the graph,
 * wire a scheduler and transport — and two copies of it is exactly the split
 * PLAN.md §18 warns about, one step up from the DSP core.
 *
 * Deliberately free of Web Audio types, in the same way `host.ts` is: the caller
 * loads the worklet module and constructs the node, because that is four lines of
 * platform plumbing and pulling the DOM's types into this package to own them
 * would cost more than it saves. What the caller hands over is a clock, a port to
 * post commands to, and a sample rate.
 */
export class LiveSession {
  readonly schedule: CompiledSchedule;
  readonly barStarts: readonly number[];
  readonly transport: LiveTransport;
  readonly sampleRate: number;
  /** Content hash per project-relative sample path, as sent to the worklet. */
  readonly sampleHashes: ReadonlyMap<string, string>;

  private constructor(
    schedule: CompiledSchedule,
    barStarts: readonly number[],
    transport: LiveTransport,
    sampleRate: number,
    sampleHashes: Map<string, string>,
  ) {
    this.schedule = schedule;
    this.barStarts = barStarts;
    this.transport = transport;
    this.sampleRate = sampleRate;
    this.sampleHashes = sampleHashes;
  }

  /**
   * Compile, load samples, and configure the worklet. Resolves once the graph
   * has been posted, so the caller can `start()` immediately after.
   */
  static async create(options: LiveSessionOptions): Promise<LiveSession> {
    const { clock, sink, sampleRate, project } = options;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error(`cannot start a live session: sample rate ${sampleRate} must be a positive integer`);
    }
    const seed = options.seed ?? 0;
    const schedule = compile(project, { sampleRate, seed });
    const barStarts = musicalGrid(project, { sampleRate, seed }).barStarts;

    const post = (command: LiveCommand): void => {
      sink.postMessage(command);
    };
    const hashes = await loadSamples(project, schedule, options.fetchSample, post, options.onSampleLoaded);

    const graphOf = (target: CompiledSchedule): LiveGraph =>
      liveGraph(project, target, (path) => {
        const hash = hashes.get(path);
        // Not defensive noise: a configure naming content the worklet was never
        // sent is rejected by the worklet, and the failure is far easier to read
        // here than as silence three layers down.
        if (hash === undefined) throw new Error(`no content hash was loaded for sample "${path}"`);
        return hash;
      });

    const scheduler = new LiveScheduler(schedule, barStarts, lookaheadSamples(sampleRate));
    const transport = new LiveTransport({
      clock,
      sink: { postMessage: post },
      scheduler,
      sampleRate,
      ticker: options.ticker ?? intervalTicker(globalTimers()),
      graphOf,
    });
    transport.sendConfigure({ generation: 0, atSample: null, schedule }, graphOf(schedule));

    return new LiveSession(schedule, barStarts, transport, sampleRate, hashes);
  }

  /** Total scheduled length in samples, before any release tail. */
  get totalSamples(): number {
    return this.schedule.totalSamples;
  }

  /** Events across every track, for a readout. */
  get eventCount(): number {
    return this.schedule.tracks.reduce((total, track) => total + track.events.length, 0);
  }

  /**
   * Begin playing. The caller must already have resumed the `AudioContext` from a
   * user gesture (PLAN.md §14); nothing here can supply one.
   */
  start(): void {
    this.transport.start();
  }

  stop(): void {
    this.transport.stop();
  }

  seek(sample: number): void {
    this.transport.seek(sample);
  }

  /** Feed a worklet message back to the transport so its playhead re-anchors. */
  acceptEvent(event: LiveEvent): void {
    this.transport.acceptEvent(event);
  }
}

/** Fetch, hash, decode and post every sample the schedule needs. */
async function loadSamples(
  project: Project,
  schedule: CompiledSchedule,
  fetchSample: SampleFetcher,
  post: (command: LiveCommand) => void,
  onLoaded: LiveSessionOptions["onSampleLoaded"],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const path of requiredSamplePaths(project, schedule)) {
    const bytes = await fetchSample(path);
    // Hashed over the bytes as delivered, exactly as the offline path hashes the
    // bytes on disk, so a replaced sample invalidates identically (PLAN.md §14).
    const contentHash = hashContent(bytes);
    const decoded = decodeWav(bytes);
    hashes.set(path, contentHash);
    const right = decoded.channels[1];
    post({
      type: "sampleData",
      path,
      contentHash,
      sampleRate: decoded.sampleRate,
      left: decoded.channels[0]!,
      ...(right === undefined ? {} : { right }),
    });
    onLoaded?.({
      path,
      bytes: bytes.byteLength,
      contentHash,
      frames: decoded.channels[0]!.length,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels.length,
    });
  }
  return hashes;
}

/**
 * `setInterval` from whatever global this runs in. Split out so the default is
 * one expression and a test that wants control passes its own ticker instead.
 */
function globalTimers(): Parameters<typeof intervalTicker>[0] {
  return globalThis as unknown as Parameters<typeof intervalTicker>[0];
}
