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
 * What a document edit means to a running transport, as classified by whoever made
 * it (PLAN.md §12 step 6). `none` never reaches here — an edit with no audible
 * consequence has no reason to recompile anything.
 */
export type LiveEditEffect = "parameters" | "structural";

/** A sample file and the content hash of the bytes now on disk for it. */
export interface SampleContent {
  path: string;
  contentHash: string;
}

/** What a session did with an announcement that sample files changed on disk. */
export interface SampleChangeOutcome {
  /** Paths whose replacement content was fetched, decoded and sent to the worklet. */
  reloaded: string[];
  /**
   * Paths named by the announcement that this session already holds that exact
   * content for. Its own echo check, and the reason a redundant announcement costs
   * nothing: identity is the content, not the fact of having been told.
   */
  unchanged: string[];
  /**
   * Paths named by the announcement that this session does not hold at all — a kit
   * voice no track in the schedule plays. Ignored rather than fetched: loading audio
   * nothing can trigger would be work with no sound attached to it.
   */
  ignored: string[];
}

/** What the transport did with an edit, so a UI can say when it will be heard. */
export interface LiveEditOutcome {
  effect: LiveEditEffect;
  /**
   * Sample position the edit takes effect at, or `null` for "at the next block" —
   * a parameter change, or a structural change made while stopped.
   */
  atSample: number | null;
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
  readonly transport: LiveTransport;
  readonly sampleRate: number;
  private project: Project;
  private readonly seed: number;
  private readonly fetchSample: SampleFetcher;
  private readonly post: (command: LiveCommand) => void;
  private readonly onSampleLoaded: LiveSessionOptions["onSampleLoaded"];
  private currentSchedule: CompiledSchedule;
  private currentBarStarts: readonly number[];
  /** Content hash per project-relative sample path, as sent to the worklet. */
  private readonly hashes: Map<string, string>;
  /** Serializes `update`, whose sample loading is asynchronous. */
  private updating: Promise<void> = Promise.resolve();

  private constructor(init: {
    project: Project;
    seed: number;
    fetchSample: SampleFetcher;
    post: (command: LiveCommand) => void;
    onSampleLoaded: LiveSessionOptions["onSampleLoaded"];
    schedule: CompiledSchedule;
    barStarts: readonly number[];
    transport: LiveTransport;
    sampleRate: number;
    hashes: Map<string, string>;
  }) {
    this.project = init.project;
    this.seed = init.seed;
    this.fetchSample = init.fetchSample;
    this.post = init.post;
    this.onSampleLoaded = init.onSampleLoaded;
    this.currentSchedule = init.schedule;
    this.currentBarStarts = init.barStarts;
    this.transport = init.transport;
    this.sampleRate = init.sampleRate;
    this.hashes = init.hashes;
  }

  /** The schedule currently rendering, or the one queued to replace it. */
  get schedule(): CompiledSchedule {
    return this.currentSchedule;
  }

  get barStarts(): readonly number[] {
    return this.currentBarStarts;
  }

  get sampleHashes(): ReadonlyMap<string, string> {
    return this.hashes;
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
    const hashes = new Map<string, string>();
    // Declared before the graph builder so the builder can close over the
    // session's *current* project rather than the one it was created with: a
    // document edit replaces it, and a stale instrument map would keep playing
    // the old kit under the new events.
    let session: LiveSession | undefined;
    const graphOf = (target: CompiledSchedule): LiveGraph =>
      liveGraph(session?.project ?? project, target, (path) => {
        const hash = hashes.get(path);
        // Not defensive noise: a configure naming content the worklet was never
        // sent is rejected by the worklet, and the failure is far easier to read
        // here than as silence three layers down.
        if (hash === undefined) throw new Error(`no content hash was loaded for sample "${path}"`);
        return hash;
      });

    await loadSamples(project, schedule, options.fetchSample, post, options.onSampleLoaded, hashes);

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

    session = new LiveSession({
      project,
      seed,
      fetchSample: options.fetchSample,
      post,
      onSampleLoaded: options.onSampleLoaded,
      schedule,
      barStarts,
      transport,
      sampleRate,
      hashes,
    });
    return session;
  }

  /**
   * Adopt an edited document while the session is live.
   *
   * The recompile is unconditional and whole-project: the compiler is the only
   * thing that knows how a document becomes events, and asking it again is both
   * cheaper than a patch and impossible to get subtly wrong. What the caller
   * supplies is `effect` — the §12-step-6 classification — because it made the
   * edit and knows what it touched, whereas this method would have to diff two
   * documents to find out (PLAN.md §12 step 5, deferred to Phase 4).
   *
   * Timing is the scheduler's, not this method's: a structural change lands at the
   * next bar boundary while playing and immediately while stopped, and a parameter
   * change takes effect in the next scheduling window.
   *
   * Calls are serialized against each other because sample loading is
   * asynchronous, so a burst of edits cannot interleave two configures for the
   * same generation.
   */
  update(project: Project, effect: LiveEditEffect): Promise<LiveEditOutcome> {
    const run = this.updating.then(() => this.applyUpdate(project, effect));
    // Kept in the chain even when it rejects, so one failed edit does not wedge
    // every later one behind a permanently rejected promise.
    this.updating = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Adopt replacement bytes for sample files that changed on disk (PLAN.md §14).
   *
   * A replaced `samples/kick.wav` changes no document, so nothing about it can
   * arrive as a document edit: it is announced separately and lands here. What
   * happens is deliberately narrow — the new bytes are fetched, hashed, decoded and
   * posted to the worklet, which points every kit voice on that path at them for
   * its next trigger. No recompile, no graph swap, no configure: the schedule did
   * not move, and rebuilding the graph would silence every voice currently sounding
   * for a change that does not need it.
   *
   * `announced` says what the sidecar believes is on disk, and is only ever used to
   * decide whether this session's content is stale. The content actually adopted is
   * hashed from the bytes that arrive, so a session cannot end up believing it holds
   * content it does not — the announcement may already be out of date by the time
   * the fetch lands, and the bytes are the only honest answer.
   *
   * Fetching and decoding happen before anything is adopted, so a failed fetch or a
   * file that will not decode leaves the session playing exactly what it was, and
   * rejects; the next announcement retries, because the hash it names still differs
   * from what is held.
   *
   * Serialized with `update` through the same queue: a document edit and a sample
   * replacement can arrive from one settle window, and a configure naming content the
   * worklet has not been sent is rejected by the worklet.
   */
  applySampleChange(announced: readonly SampleContent[]): Promise<SampleChangeOutcome> {
    const run = this.updating.then(() => this.applySamples(announced));
    this.updating = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applySamples(announced: readonly SampleContent[]): Promise<SampleChangeOutcome> {
    const outcome: SampleChangeOutcome = { reloaded: [], unchanged: [], ignored: [] };
    for (const sample of announced) {
      const held = this.hashes.get(sample.path);
      if (held === undefined) {
        outcome.ignored.push(sample.path);
        continue;
      }
      if (held === sample.contentHash) {
        outcome.unchanged.push(sample.path);
        continue;
      }
      const loaded = await loadSample(
        sample.path,
        this.fetchSample,
        this.post,
        this.onSampleLoaded,
        this.hashes,
      );
      // The bytes on disk may have moved on again between the announcement and this
      // fetch. Whatever arrived is what the worklet now holds, so it is what gets
      // reported — and if it is a third version, the announcement for that one finds
      // this hash already in place and stops.
      if (loaded === held) outcome.unchanged.push(sample.path);
      else outcome.reloaded.push(sample.path);
    }
    return outcome;
  }

  private async applyUpdate(project: Project, effect: LiveEditEffect): Promise<LiveEditOutcome> {
    const schedule = compile(project, { sampleRate: this.sampleRate, seed: this.seed });
    const barStarts = musicalGrid(project, { sampleRate: this.sampleRate, seed: this.seed }).barStarts;
    // An edit may name sample content the worklet has never been sent — a lane
    // for a kit voice that was not in the graph before. Loaded before the project
    // is adopted, so a fetch that fails leaves the session playing what it was.
    await loadSamples(project, schedule, this.fetchSample, this.post, this.onSampleLoaded, this.hashes);
    this.project = project;
    this.currentSchedule = schedule;
    this.currentBarStarts = barStarts;
    // A parameter edit cannot be pushed in place while a graph rebuild is still
    // queued, and the reason is worth stating because the failure was loud and
    // baffling: toggle a step during playback and then move a fader before the
    // bar line, and the edit was refused as "structural" even though the fader
    // was the only thing the author touched.
    //
    // The queued change owns two things this method would otherwise contradict.
    // It holds the events the worklet will play from the bar line on, so
    // `updateParameters` — which compares the recompiled schedule against what is
    // *currently* playing — sees the step toggle in the comparison and correctly
    // refuses. And its configure was built from the document as it was when it
    // was queued, so even where the events happen to be identical (a `stepsPerBar`
    // change that lands every hit on the same tick) the bar line would restore the
    // pre-fader instrument and silently undo the parameter edit.
    //
    // So the parameter edit joins the queued change instead of racing it: the
    // rebuild is re-queued from the current document, carrying both edits, and the
    // outcome says `structural` because that is honestly what happened and the
    // transport readout should say "at bar N" rather than "already audible".
    const queued = effect === "parameters" && this.transport.hasPendingStructuralChange;
    if (effect === "structural" || queued) {
      const change = this.transport.applyStructuralChange(schedule, barStarts);
      return { effect: "structural", atSample: change.atSample };
    }
    this.transport.applyParameterChange(
      schedule,
      schedule.tracks.map((track, trackIndex) => {
        const instrument = project.instruments.get(track.instrumentId);
        if (instrument === undefined) {
          throw new Error(`cannot apply a parameter change: instrument "${track.instrumentId}" is missing`);
        }
        return { trackIndex, instrument, automation: track.automation };
      }),
    );
    return { effect, atSample: null };
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

/**
 * Fetch, hash, decode and post every sample the schedule needs and `hashes` does
 * not already hold, recording each one in `hashes`.
 *
 * Skipping what is already loaded is what makes this reusable for a document
 * edit: re-posting a multi-megabyte sample on every keystroke would be the
 * obvious way to make editing during playback glitch.
 */
async function loadSamples(
  project: Project,
  schedule: CompiledSchedule,
  fetchSample: SampleFetcher,
  post: (command: LiveCommand) => void,
  onLoaded: LiveSessionOptions["onSampleLoaded"],
  hashes: Map<string, string>,
): Promise<void> {
  for (const path of requiredSamplePaths(project, schedule)) {
    if (hashes.has(path)) continue;
    await loadSample(path, fetchSample, post, onLoaded, hashes);
  }
}

/**
 * Fetch, hash, decode and post one sample, recording it in `hashes`. Returns the
 * content hash of the bytes that arrived.
 *
 * The one place a sample's bytes become audio, so a first load and a replacement
 * cannot differ in how they are hashed or decoded — which they must not, since the
 * hash is the identity the worklet checks a configure against.
 *
 * `hashes` is written only after the decode succeeds: a fetch that fails or bytes
 * that will not decode must leave the session holding what it had, not a path
 * bound to content the worklet was never sent.
 */
async function loadSample(
  path: string,
  fetchSample: SampleFetcher,
  post: (command: LiveCommand) => void,
  onLoaded: LiveSessionOptions["onSampleLoaded"],
  hashes: Map<string, string>,
): Promise<string> {
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
  return contentHash;
}

/**
 * `setInterval` from whatever global this runs in. Split out so the default is
 * one expression and a test that wants control passes its own ticker instead.
 */
function globalTimers(): Parameters<typeof intervalTicker>[0] {
  return globalThis as unknown as Parameters<typeof intervalTicker>[0];
}
