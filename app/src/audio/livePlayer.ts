import { LIVE_PROCESSOR_NAME, LiveSession, type LiveEvent } from "@chord-garden/engine/live";
import type { Project } from "@chord-garden/format/pure";

/** Everything a transport readout needs, pushed on each worklet report. */
export interface PlayerStatus {
  phase: "idle" | "starting" | "playing" | "stopped" | "failed";
  sampleRate: number | null;
  positionSample: number;
  totalSamples: number;
  activeVoices: number;
  underrunBlocks: number;
  /** Peak of the most recent report; the "is there sound right now" light. */
  peak: number;
  /**
   * Loudest sample this run. The instantaneous peak is zero between hits, so on
   * its own it cannot answer "is this playing or silently pretending to" — which
   * is the first question anyone asks of a transport that shows a moving
   * playhead. The session peak can.
   */
  peakSession: number;
  /** Reports carrying signal, out of `reports`. */
  reportsWithSound: number;
  reports: number;
  error: string | undefined;
}

const IDLE: PlayerStatus = {
  phase: "idle",
  sampleRate: null,
  positionSample: 0,
  totalSamples: 0,
  activeVoices: 0,
  underrunBlocks: 0,
  peak: 0,
  peakSession: 0,
  reportsWithSound: 0,
  reports: 0,
  error: undefined,
};

/** Seconds of silence after the last event, so release tails are not cut off. */
const TAIL_SECONDS = 2;

/**
 * The app's Web Audio plumbing: create a context from a user gesture, load the
 * worklet, hand a `LiveSession` the port, and forward its reports.
 *
 * Everything musical lives in `LiveSession` (and below it, the shared compiler
 * and DSP core). What is left here is the four things only a page can do —
 * construct an `AudioContext` inside a click handler (PLAN.md §14), load the
 * worklet module by URL, construct the node, and connect it to the destination.
 */
export class LivePlayer {
  private context: AudioContext | undefined;
  private session: LiveSession | undefined;
  private status: PlayerStatus = IDLE;
  private endSample = 0;
  private readonly listeners = new Set<(status: PlayerStatus) => void>();

  constructor(
    private readonly workletUrl: string,
    private readonly fetchSample: (path: string) => Promise<Uint8Array>,
  ) {}

  getStatus(): PlayerStatus {
    return this.status;
  }

  subscribe(listener: (status: PlayerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start playing `project` from the top. Must be called from a user gesture:
   * browsers will not let an `AudioContext` produce sound without one, and the
   * UI makes that explicit rather than hiding it behind an autoplay attempt.
   */
  async start(project: Project, seed: number): Promise<void> {
    if (this.status.phase === "starting" || this.status.phase === "playing") return;
    this.update({ ...IDLE, phase: "starting" });
    try {
      await this.startInternal(project, seed);
    } catch (error) {
      this.update({ ...this.status, phase: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async startInternal(project: Project, seed: number): Promise<void> {
    // A fresh context per run: browsers allow only a handful per page, and this
    // one is started and stopped repeatedly while editing.
    if (this.context !== undefined) {
      await this.context.close();
      this.context = undefined;
      this.session = undefined;
    }

    const audio = new AudioContext({ latencyHint: "interactive" });
    this.context = audio;
    const sampleRate = audio.sampleRate;
    if (!Number.isInteger(sampleRate)) {
      throw new Error(`audio context sample rate ${sampleRate} is not an integer; the engine schedules whole samples`);
    }

    await audio.audioWorklet.addModule(this.workletUrl);
    const node = new AudioWorkletNode(audio, LIVE_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.onprocessorerror = () => {
      this.update({ ...this.status, phase: "failed", error: "the audio worklet threw and left the graph" });
    };
    node.port.onmessage = (event: MessageEvent) => {
      this.handleEvent(event.data as LiveEvent);
    };
    node.connect(audio.destination);

    const session = await LiveSession.create({
      clock: audio,
      // Wrapped rather than passed straight through: `MessagePort.postMessage`
      // has a transfer-list overload whose optionality does not line up with the
      // engine's narrower `CommandSink`, and the engine's is the honest one.
      sink: { postMessage: (command) => node.port.postMessage(command) },
      sampleRate,
      project,
      seed,
      fetchSample: this.fetchSample,
    });
    this.session = session;
    this.endSample = session.totalSamples + TAIL_SECONDS * sampleRate;

    await audio.resume();
    session.start();
    this.update({
      ...this.status,
      phase: "playing",
      sampleRate,
      totalSamples: session.totalSamples,
      error: undefined,
    });
  }

  stop(): void {
    if (this.session === undefined) return;
    this.session.stop();
    this.update({ ...this.status, phase: "stopped" });
  }

  private handleEvent(event: LiveEvent): void {
    if (event.type === "error") {
      this.update({ ...this.status, phase: "failed", error: event.message });
      return;
    }
    if (event.type === "ready") return;

    this.session?.acceptEvent(event);
    const peak = Math.max(event.peakLeft, event.peakRight);
    this.update({
      ...this.status,
      positionSample: event.positionSample,
      activeVoices: event.activeVoices,
      underrunBlocks: event.underrunBlocks,
      peak,
      peakSession: Math.max(this.status.peakSession, peak),
      reports: this.status.reports + 1,
      reportsWithSound: this.status.reportsWithSound + (peak > 0 ? 1 : 0),
    });
    if (this.status.phase === "playing" && event.playing && event.positionSample >= this.endSample) {
      this.stop();
    }
  }

  private update(status: PlayerStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
