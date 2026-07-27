import type { EffectDoc, InstrumentDoc } from "@chord-garden/format";
import type { CompiledAutomationLane, CompiledSchedule } from "../compiler.js";
import { CONTROL_BLOCK_SIZE } from "../dsp/index.js";
import type { LiveGraph } from "./configure.js";
import type { LiveCommand, LiveEvent } from "./protocol.js";
import type { LiveScheduler, StructuralChange } from "./scheduler.js";

/**
 * The `AudioContext` shape this file needs. Structural on purpose: a real
 * `AudioContext` satisfies it, and typing it this way keeps Web Audio's ambient
 * types out of a package that also runs in Node.
 */
export interface AudioClock {
  readonly currentTime: number;
}

/** Satisfied by `AudioWorkletNode.port`. */
export interface CommandSink {
  postMessage(message: LiveCommand, transfer?: ArrayBuffer[]): void;
}

/** Satisfied by `setInterval`/`clearInterval`; injected so tests own the timer. */
export interface Ticker {
  start(intervalMs: number, tick: () => void): void;
  stop(): void;
}

/**
 * 100 ms of lookahead at a 25 ms tick, from Chris Wilson's "A Tale of Two
 * Clocks". The ratio is what matters: the window has to survive a timer callback
 * arriving late, and browser timers are throttled hard in background tabs, so
 * four ticks of margin is the cheapest insurance available. Latency is unaffected
 * — the worklet plays events at their sample position, not on arrival — so the
 * only cost of a longer window is that a structural edit waits longer for its bar
 * boundary.
 */
export const DEFAULT_LOOKAHEAD_SECONDS = 0.1;
export const DEFAULT_TICK_INTERVAL_MS = 25;

/**
 * A lookahead of at least `seconds`, rounded up to a whole render quantum.
 *
 * The rounding is not cosmetic: the horizon is compared against block positions
 * to detect a starved scheduler, so a window ending mid-block would leave one
 * block per window looking half-fed and make the underrun count useless. 100 ms at
 * 48 kHz is 4800 samples, which is 37.5 blocks, so the rounding is load-bearing at
 * the default settings rather than a rare edge.
 */
export function lookaheadSamples(sampleRate: number, seconds = DEFAULT_LOOKAHEAD_SECONDS): number {
  return Math.ceil((seconds * sampleRate) / CONTROL_BLOCK_SIZE) * CONTROL_BLOCK_SIZE;
}

export interface LiveTransportOptions {
  clock: AudioClock;
  sink: CommandSink;
  scheduler: LiveScheduler;
  sampleRate: number;
  ticker: Ticker;
  tickIntervalMs?: number;
  /**
   * Builds the configure payload for a schedule. Injected because it needs the
   * project's instruments and the sample content hashes, neither of which the
   * transport should hold a second copy of.
   */
  graphOf: (schedule: CompiledSchedule) => LiveGraph;
}

/**
 * The main-thread half: turns clock time into a playback position, asks the
 * scheduler what is due, and posts it. Deliberately the only file in `live/` that
 * knows about wall-clock time at all.
 *
 * Notes are never timed with `setTimeout`; the timer only decides when to *ask*
 * for the next window, and every event carries an absolute sample position that
 * the worklet honours.
 */
export class LiveTransport {
  private readonly clock: AudioClock;
  private readonly sink: CommandSink;
  private readonly scheduler: LiveScheduler;
  private readonly sampleRate: number;
  private readonly ticker: Ticker;
  private readonly tickIntervalMs: number;
  private readonly graphOf: (schedule: CompiledSchedule) => LiveGraph;
  /** Last position the worklet reported, and the clock time it was believed at. */
  private anchorSample = 0;
  private anchorTime = 0;
  private estimate = 0;

  constructor(options: LiveTransportOptions) {
    if (!Number.isInteger(options.sampleRate) || options.sampleRate <= 0) {
      throw new Error(`cannot create transport: sampleRate ${options.sampleRate} must be a positive integer`);
    }
    if (options.scheduler.lookaheadSamples % CONTROL_BLOCK_SIZE !== 0) {
      throw new Error(
        `cannot create transport: lookahead ${options.scheduler.lookaheadSamples} must be a whole number of ${CONTROL_BLOCK_SIZE}-sample blocks`,
      );
    }
    this.clock = options.clock;
    this.sink = options.sink;
    this.scheduler = options.scheduler;
    this.sampleRate = options.sampleRate;
    this.ticker = options.ticker;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.graphOf = options.graphOf;
  }

  /** Estimated playhead, quantised down to a block so slice windows tile blocks. */
  get positionSample(): number {
    return this.estimate;
  }

  /**
   * Begin playing. The caller is responsible for having resumed the
   * `AudioContext` from a user gesture first (PLAN.md §14); this posts no gesture
   * of its own and cannot.
   */
  start(): void {
    this.anchorSample = this.scheduler.positionSample;
    this.anchorTime = this.clock.currentTime;
    this.estimate = this.anchorSample;
    this.scheduler.start();
    this.sink.postMessage({ type: "start" });
    this.ticker.start(this.tickIntervalMs, () => {
      this.tick();
    });
    this.tick();
  }

  stop(): void {
    this.ticker.stop();
    const flushed = this.scheduler.stop();
    // A stop applies a queued structural change at once, so the configure must
    // reach the worklet before the stop that resets the graph it configures.
    if (flushed !== undefined) this.sendConfigure(flushed, this.graphOf(flushed.schedule));
    this.sink.postMessage({ type: "stop" });
  }

  /**
   * Jump the playhead. The target is aligned down to a render quantum: the DSP
   * only ever starts a block on a quantum boundary, and pretending to a
   * sample-accurate seek would put every later block off the grid a structural
   * change has to land on.
   */
  seek(requested: number): void {
    const sample = Math.floor(requested / CONTROL_BLOCK_SIZE) * CONTROL_BLOCK_SIZE;
    const flushed = this.scheduler.seek(sample);
    if (flushed !== undefined) this.sendConfigure(flushed, this.graphOf(flushed.schedule));
    this.anchorSample = sample;
    this.anchorTime = this.clock.currentTime;
    this.estimate = sample;
    this.sink.postMessage({ type: "seek", sample });
    if (this.scheduler.isPlaying) this.tick();
  }

  /** One scheduling pass. Public so tests can step it without a real timer. */
  tick(): void {
    const elapsed = Math.max(0, this.clock.currentTime - this.anchorTime);
    const estimated = this.anchorSample + Math.round(elapsed * this.sampleRate);
    const aligned = Math.floor(estimated / CONTROL_BLOCK_SIZE) * CONTROL_BLOCK_SIZE;
    // Monotonic: a clock or a report that appears to go backwards must not make
    // the scheduler re-slice a window it has already committed.
    this.estimate = Math.max(this.estimate, aligned);
    for (const action of this.scheduler.advance(this.estimate)) {
      this.sink.postMessage({
        type: "slice",
        generation: action.generation,
        startSample: action.slice.startSample,
        endSample: action.slice.endSample,
        tracks: action.slice.tracks,
      });
    }
  }

  /**
   * Adopt the worklet's own view of the playhead. The clock estimate is only an
   * estimate — it cannot see the output latency or a starved render — so each
   * report re-anchors it and the drift never accumulates.
   */
  acceptEvent(event: LiveEvent): void {
    if (event.type !== "position" || !event.playing) return;
    this.anchorSample = event.positionSample;
    this.anchorTime = this.clock.currentTime;
    this.estimate = Math.max(this.estimate, event.positionSample);
  }

  /**
   * Whether a graph rebuild is queued and has not landed yet.
   *
   * Read by `LiveSession.update`, which may not push a parameter change in place
   * while one is outstanding; see the comment there for why.
   */
  get hasPendingStructuralChange(): boolean {
    return this.scheduler.pendingChange !== undefined;
  }

  /** Post a queued graph replacement; `change` comes from the scheduler. */
  sendConfigure(change: StructuralChange, graph: LiveGraph): void {
    this.sink.postMessage({
      type: "configure",
      generation: change.generation,
      atSample: change.atSample,
      tracks: graph.tracks,
      samples: graph.samples,
    });
  }

  /** Post an in-place parameter update for one track of the active generation. */
  sendParams(
    trackIndex: number,
    instrument: InstrumentDoc,
    effects: EffectDoc[],
    automation: CompiledAutomationLane[],
    generation = this.scheduler.generation,
  ): void {
    this.sink.postMessage({ type: "params", generation, trackIndex, instrument, effects, automation });
  }

  /**
   * Queue a graph rebuild: pattern length, clips, routing, an instrument swap.
   * Lands at the next bar boundary at or after the horizon while playing, or at
   * once while stopped (PLAN.md §12 step 6).
   */
  applyStructuralChange(schedule: CompiledSchedule, barStarts: readonly number[]): StructuralChange {
    const change = this.scheduler.queueStructuralChange(schedule, barStarts);
    this.sendConfigure(change, this.graphOf(change.schedule));
    return change;
  }

  /**
   * Adopt a recompiled schedule whose events are unchanged and push the changed
   * tracks' parameters in place. Throws if the schedule's events actually moved,
   * which would make this a structural change wearing a parameter change's hat.
   */
  applyParameterChange(
    schedule: CompiledSchedule,
    updates: readonly {
      trackIndex: number;
      instrument: InstrumentDoc;
      effects: EffectDoc[];
      automation: CompiledAutomationLane[];
    }[],
  ): void {
    const generation = this.scheduler.updateParameters(schedule);
    for (const update of updates) {
      this.sendParams(update.trackIndex, update.instrument, update.effects, update.automation, generation);
    }
  }
}

/** `setInterval`-backed ticker for the browser; tests inject their own. */
export function intervalTicker(scope: {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: never): void;
}): Ticker {
  let handle: unknown;
  return {
    start(intervalMs, tick) {
      handle = scope.setInterval(tick, intervalMs);
    },
    stop() {
      if (handle !== undefined) scope.clearInterval(handle as never);
      handle = undefined;
    },
  };
}
