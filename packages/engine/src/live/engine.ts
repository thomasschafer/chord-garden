import type { CompiledAutomationLane, CompiledTrack } from "../compiler.js";
import { CONTROL_BLOCK_SIZE, type SampleData } from "../dsp/index.js";
import { createTrackRunner, type TrackRunner } from "../graph/trackRunner.js";
import {
  assertNever,
  type LiveCommand,
  type LiveEvent,
  type LivePosition,
  type LiveSampleRef,
  type LiveTrackConfig,
} from "./protocol.js";
import { SampleStore } from "./sampleCache.js";

export interface LiveEngineOptions {
  sampleRate: number;
  post: (event: LiveEvent) => void;
  /** Blocks between position/meter reports; 8 is ~21 ms at 48 kHz. */
  reportEveryBlocks?: number;
}

interface Graph {
  generation: number;
  /** Position the graph starts at; null means it is already active. */
  atSample: number | null;
  runners: TrackRunner[];
  configs: readonly LiveTrackConfig[];
}

/**
 * Everything the AudioWorkletProcessor does, minus the AudioWorklet.
 *
 * It is a separate class from `worklet.ts` for one reason: `worklet.ts` can only
 * be loaded where `AudioWorkletProcessor` and `registerProcessor` exist, and the
 * equivalence test has to drive this logic in Node. The split is not a second
 * implementation — `worklet.ts` holds no audio logic at all, only the two lines
 * that hand the render quantum over.
 *
 * Real-time notes, since none of this is checkable from a test:
 * - `process` allocates nothing: the per-track scratch buffers, the reused
 *   position message, and the runners' command pools are all built up front.
 * - The exceptions are both structural and named. Building a replacement graph
 *   happens in the message callback, not in `process`, so a bar-boundary swap is
 *   an array-reference assignment. Dropping the outgoing graph does leave garbage
 *   for the audio thread's collector, which no amount of pooling avoids while the
 *   DSP objects are per-generation.
 * - A block whose events have not arrived yet is rendered anyway and counted as
 *   an underrun. Nothing stalls, repeats or interpolates: the audio simply misses
 *   the notes, and the count says so, because silently glossing over a starved
 *   scheduler is how a scheduling bug survives to production.
 */
export class LiveEngine {
  private readonly sampleRate: number;
  private readonly post: (event: LiveEvent) => void;
  private readonly reportEveryBlocks: number;
  private readonly samples = new SampleStore<SampleData>();
  private readonly scratchLeft = new Float32Array(CONTROL_BLOCK_SIZE);
  private readonly scratchRight = new Float32Array(CONTROL_BLOCK_SIZE);
  private graph: Graph = { generation: -1, atSample: null, runners: [], configs: [] };
  private next: Graph | undefined;
  private playing = false;
  private position = 0;
  private scheduledThrough = 0;
  private underrunBlocks = 0;
  private peakLeft = 0;
  private peakRight = 0;
  private blocksSinceReport = 0;
  /** Reused: `postMessage` copies, so one object per engine is enough. */
  private readonly report: LivePosition = {
    type: "position",
    playing: false,
    positionSample: 0,
    scheduledThroughSample: 0,
    underrunBlocks: 0,
    peakLeft: 0,
    peakRight: 0,
    activeVoices: 0,
    generation: -1,
  };

  constructor(options: LiveEngineOptions) {
    if (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0) {
      throw new Error(`cannot create live engine: sampleRate ${options.sampleRate} must be a positive integer`);
    }
    this.sampleRate = options.sampleRate;
    this.post = options.post;
    this.reportEveryBlocks = options.reportEveryBlocks ?? 8;
  }

  get positionSample(): number {
    return this.position;
  }

  get generation(): number {
    return this.graph.generation;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get starvedBlocks(): number {
    return this.underrunBlocks;
  }

  /**
   * Distinct decoded sample buffers held, which is where this engine's memory
   * actually goes.
   *
   * Exposed because a sample file being replaced repeatedly — the ordinary way
   * anyone auditions a kick — must not accumulate one decode per version. The
   * `SampleStore` drops content the moment no path refers to it, and this is how
   * that is asserted rather than argued.
   */
  get sampleContentCount(): number {
    return this.samples.contentCount;
  }

  activeVoiceCount(): number {
    let count = 0;
    for (const runner of this.graph.runners) count += runner.activeVoiceCount();
    return count;
  }

  handle(command: LiveCommand): void {
    switch (command.type) {
      case "configure":
        this.configure(command.generation, command.atSample, command.tracks, command.samples);
        return;
      case "sampleData": {
        const data: SampleData =
          command.right === undefined
            ? { sampleRate: command.sampleRate, left: command.left }
            : { sampleRate: command.sampleRate, left: command.left, right: command.right };
        this.samples.set(command.path, command.contentHash, () => data);
        for (const runner of this.graph.runners) runner.replaceSample(command.path, data);
        for (const runner of this.next?.runners ?? []) runner.replaceSample(command.path, data);
        return;
      }
      case "slice": {
        const target = this.graphFor(command.generation);
        for (const track of command.tracks) {
          const runner = target.runners[track.trackIndex];
          if (runner === undefined) {
            throw new Error(`cannot apply slice: generation ${command.generation} has no track ${track.trackIndex}`);
          }
          runner.enqueue(track.events);
        }
        if (command.endSample > this.scheduledThrough) this.scheduledThrough = command.endSample;
        return;
      }
      case "params": {
        if (command.generation !== this.graph.generation) {
          throw new Error(
            `cannot apply params: generation ${command.generation} is not the active generation ${this.graph.generation}`,
          );
        }
        const runner = this.graph.runners[command.trackIndex];
        if (runner === undefined) throw new Error(`cannot apply params: no track ${command.trackIndex}`);
        runner.updateSettings(command.instrument, command.effects, command.automation);
        return;
      }
      case "start":
        this.playing = true;
        return;
      case "stop":
        // Stopping cuts tails rather than letting them ring: the transport's
        // position stops advancing, so a ringing release would be sounding at a
        // position the playhead is no longer at.
        this.playing = false;
        // The scheduler discards its committed lookahead on stop too, so the
        // horizon comes back to the playhead and both sides agree again.
        this.scheduledThrough = this.position;
        this.underrunBlocks = 0;
        this.resetGraph(this.position);
        return;
      case "seek":
        if (!Number.isInteger(command.sample) || command.sample < 0) {
          throw new Error(`cannot seek: ${command.sample} is not a non-negative integer sample`);
        }
        // Blocks advance from the position in whole quanta, so an unaligned
        // position would put every later block boundary off the quantum grid and
        // make a bar-boundary swap impossible to land on. `LiveTransport.seek`
        // aligns for its callers.
        if (command.sample % CONTROL_BLOCK_SIZE !== 0) {
          throw new Error(`cannot seek to ${command.sample}: not a multiple of the ${CONTROL_BLOCK_SIZE}-sample quantum`);
        }
        if (this.next !== undefined) {
          throw new Error(
            `cannot seek with generation ${this.next.generation} queued for sample ${String(this.next.atSample)}: apply it first`,
          );
        }
        this.position = command.sample;
        this.scheduledThrough = command.sample;
        this.underrunBlocks = 0;
        this.resetGraph(command.sample);
        return;
      default:
        return assertNever(command, "cannot handle live command");
    }
  }

  /** Render one quantum. `left` and `right` must be distinct buffers. */
  process(left: Float32Array, right: Float32Array): void {
    if (left.length !== CONTROL_BLOCK_SIZE || right.length !== CONTROL_BLOCK_SIZE) {
      throw new Error(
        `cannot process live block: expected ${CONTROL_BLOCK_SIZE}-sample channels, got ${left.length} and ${right.length}`,
      );
    }
    const queued = this.next;
    if (queued !== undefined && queued.atSample !== null && this.position >= queued.atSample) {
      this.activate(queued);
    }
    left.fill(0);
    right.fill(0);

    if (this.playing) {
      const runners = this.graph.runners;
      for (let index = 0; index < runners.length; index++) {
        runners[index]!.processBlock(this.scratchLeft, this.scratchRight, CONTROL_BLOCK_SIZE, this.position);
        // Accumulated one track at a time at float32 precision, in trackOrder,
        // which is exactly how the offline renderer sums its stems into the
        // master. Summing any other way would agree only to within float32
        // rounding, and the equivalence test asserts bit equality.
        for (let sample = 0; sample < CONTROL_BLOCK_SIZE; sample++) {
          left[sample] = left[sample]! + this.scratchLeft[sample]!;
          right[sample] = right[sample]! + this.scratchRight[sample]!;
        }
      }
      if (this.position + CONTROL_BLOCK_SIZE > this.scheduledThrough) this.underrunBlocks++;
      this.position += CONTROL_BLOCK_SIZE;
    }

    for (let sample = 0; sample < CONTROL_BLOCK_SIZE; sample++) {
      const leftLevel = Math.abs(left[sample]!);
      const rightLevel = Math.abs(right[sample]!);
      if (leftLevel > this.peakLeft) this.peakLeft = leftLevel;
      if (rightLevel > this.peakRight) this.peakRight = rightLevel;
    }
    if (++this.blocksSinceReport >= this.reportEveryBlocks) this.sendReport();
  }

  /** Post the current position and meters immediately, outside the usual cadence. */
  sendReport(): void {
    this.report.playing = this.playing;
    this.report.positionSample = this.position;
    this.report.scheduledThroughSample = this.scheduledThrough;
    this.report.underrunBlocks = this.underrunBlocks;
    this.report.peakLeft = this.peakLeft;
    this.report.peakRight = this.peakRight;
    this.report.activeVoices = this.activeVoiceCount();
    this.report.generation = this.graph.generation;
    this.post(this.report);
    this.peakLeft = 0;
    this.peakRight = 0;
    this.blocksSinceReport = 0;
  }

  private configure(
    generation: number,
    atSample: number | null,
    configs: readonly LiveTrackConfig[],
    samples: readonly LiveSampleRef[],
  ): void {
    for (const sample of samples) {
      const held = this.samples.hashOf(sample.path);
      if (held === undefined) {
        throw new Error(`cannot configure generation ${generation}: sample "${sample.path}" has not been sent`);
      }
      if (held !== sample.contentHash) {
        throw new Error(
          `cannot configure generation ${generation}: sample "${sample.path}" holds content ${held}, not ${sample.contentHash}`,
        );
      }
    }
    if (atSample !== null && (!Number.isInteger(atSample) || atSample < this.position)) {
      throw new Error(`cannot configure generation ${generation}: switch sample ${atSample} is not ahead of ${this.position}`);
    }
    if (atSample !== null && atSample % CONTROL_BLOCK_SIZE !== 0) {
      throw new Error(
        `cannot configure generation ${generation}: switch sample ${atSample} is not a multiple of the ${CONTROL_BLOCK_SIZE}-sample quantum`,
      );
    }
    const start = atSample ?? this.position;
    const graph: Graph = {
      generation,
      atSample,
      runners: configs.map((config) => this.createRunner(config, start)),
      configs,
    };
    if (atSample === null) {
      this.activate(graph);
      return;
    }
    // Built here rather than at the boundary so the swap itself costs the audio
    // thread nothing but an assignment.
    this.next = graph;
  }

  private createRunner(config: LiveTrackConfig, position: number): TrackRunner {
    const track: CompiledTrack = {
      trackId: config.trackId,
      instrumentId: config.instrument.id,
      events: [],
      automation: config.automation as CompiledAutomationLane[],
      effects: config.effects,
    };
    const runner = createTrackRunner(track, config.instrument, this.sampleRate, (path) => {
      const data = this.samples.get(path);
      if (data === undefined) throw new Error(`cannot configure track "${config.trackId}": sample "${path}" is missing`);
      return data;
    });
    runner.reset(position);
    return runner;
  }

  private activate(graph: Graph): void {
    this.graph = { generation: graph.generation, atSample: null, runners: graph.runners, configs: graph.configs };
    if (this.next === graph) this.next = undefined;
    this.post({ type: "ready", generation: graph.generation });
  }

  private graphFor(generation: number): Graph {
    if (generation === this.graph.generation) return this.graph;
    if (this.next !== undefined && generation === this.next.generation) return this.next;
    throw new Error(
      `cannot route slice: generation ${generation} is neither active (${this.graph.generation}) nor queued (${String(this.next?.generation)})`,
    );
  }

  private resetGraph(position: number): void {
    for (const runner of this.graph.runners) runner.reset(position);
  }
}
