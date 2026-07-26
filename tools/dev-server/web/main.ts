import { LIVE_PROCESSOR_NAME, LiveSession, type LiveEvent } from "@chord-garden/engine/live";
import { ProjectClient } from "../src/client.js";

/**
 * The Phase 2 verification harness: load a project over HTTP, run it through the
 * real live engine in a real AudioWorklet, and say loudly enough for an
 * automated check whether sound came out.
 *
 * Deliberately plain. Phase 3's app is at `/app/`; this page exists to prove the
 * engine works in a browser, and every line of it is observable from the console
 * under one prefix. Project loading, sample delivery and transport wiring are
 * `ProjectClient` and `LiveSession`, shared with the app so the two pages cannot
 * end up exercising different engines.
 */
const PREFIX = "[chord-garden]";

/**
 * The rate the offline renderer and every golden test use (PLAN.md §14). The
 * schedule is compiled for whatever rate the `AudioContext` actually gives us —
 * that is the only self-consistent choice — but a device running at anything
 * else is running the engine down a path no test has ever covered, so it is
 * called out rather than silently accepted.
 */
const REFERENCE_SAMPLE_RATE = 48_000;

/** Seconds of silence to let release tails ring before stopping at the end. */
const TAIL_SECONDS = 2;

/** How often the console gets a position line; reports arrive ~47× a second. */
const LOG_INTERVAL_MS = 1000;

interface HarnessStatus {
  phase: "idle" | "loading" | "ready" | "playing" | "stopped" | "failed";
  project: string;
  contextState: string | null;
  contextSampleRate: number | null;
  /** Whether the context runs at the rate every offline golden was made at. */
  sampleRateMatchesReference: boolean | null;
  outputLatencySeconds: number | null;
  scheduleSamples: number;
  positionSample: number;
  positionSeconds: number;
  underrunBlocks: number;
  activeVoices: number;
  generation: number;
  reports: number;
  reportsWithSound: number;
  /** Highest absolute sample the worklet has produced this session. */
  peakMax: number;
  /** Highest since the last console line, i.e. "is there sound right now". */
  peakRecent: number;
  /** The point of the whole page: non-zero output was observed. */
  audioProven: boolean;
  errors: string[];
}

interface HarnessApi {
  start(): Promise<void>;
  stop(): void;
  status(): HarnessStatus;
}

declare global {
  interface Window {
    chordGarden?: HarnessApi;
  }
}

const status: HarnessStatus = {
  phase: "idle",
  project: "",
  contextState: null,
  contextSampleRate: null,
  sampleRateMatchesReference: null,
  outputLatencySeconds: null,
  scheduleSamples: 0,
  positionSample: 0,
  positionSeconds: 0,
  underrunBlocks: 0,
  activeVoices: 0,
  generation: -1,
  reports: 0,
  reportsWithSound: 0,
  peakMax: 0,
  peakRecent: 0,
  audioProven: false,
  errors: [],
};

function log(message: string): void {
  console.log(`${PREFIX} ${message}`);
}

function fail(message: string): void {
  status.errors.push(message);
  console.error(`${PREFIX} ERROR ${message}`);
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`the harness page has no #${id}`);
  return found as T;
}

const params = new URLSearchParams(window.location.search);
const projectName = params.get("project") ?? "first-track";
const seed = Number(params.get("seed") ?? "0");
/** `?rate=48000` forces the context rate instead of taking the device's. */
const forcedRate = params.get("rate") === null ? undefined : Number(params.get("rate"));

const startButton = element<HTMLButtonElement>("start");
const stopButton = element<HTMLButtonElement>("stop");
const readout = element<HTMLPreElement>("readout");

const client = ProjectClient.fromPage(window as unknown as Record<string, unknown>);

let context: AudioContext | undefined;
let session: LiveSession | undefined;
let endSample = 0;
let lastLogAt = 0;

async function start(): Promise<void> {
  if (status.phase === "playing" || status.phase === "loading") return;
  startButton.disabled = true;
  status.phase = "loading";
  try {
    await startAudio();
  } catch (error) {
    status.phase = "failed";
    fail(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
    startButton.disabled = false;
    render();
  }
}

async function startAudio(): Promise<void> {
  // Each run gets a fresh context and worklet, so the previous one has to go:
  // browsers allow only a handful of AudioContexts per page, and a harness is
  // started and stopped repeatedly by whoever is verifying it.
  if (context !== undefined) {
    await context.close();
    context = undefined;
    session = undefined;
    log("closed the previous audio context");
  }

  const loaded = await client.loadProject(projectName);
  for (const diagnostic of loaded.summary.diagnostics) {
    log(`project ${diagnostic.severity}: ${diagnostic.file}: ${diagnostic.code} ${diagnostic.message}`);
  }
  const project = loaded.project;
  log(
    `project "${projectName}" loaded: ${loaded.summary.files.length} documents, ${project.tracks.size} tracks, ${project.instruments.size} instruments`,
  );
  status.project = projectName;

  // Created inside the click handler: browsers only resume an AudioContext from
  // a user gesture, which PLAN.md §14 says to bake in rather than fight.
  const audio = new AudioContext(forcedRate === undefined ? { latencyHint: "interactive" } : { sampleRate: forcedRate });
  context = audio;
  const sampleRate = audio.sampleRate;
  status.contextSampleRate = sampleRate;
  status.contextState = audio.state;
  log(`audio context created: sampleRate=${sampleRate} state=${audio.state} baseLatency=${audio.baseLatency}`);

  if (sampleRate === REFERENCE_SAMPLE_RATE) {
    status.sampleRateMatchesReference = true;
    log(`sample rate MATCHES the ${REFERENCE_SAMPLE_RATE} Hz reference rate the offline renderer and goldens use`);
  } else {
    status.sampleRateMatchesReference = false;
    log(
      `sample rate MISMATCH: context runs at ${sampleRate} Hz, the offline renderer and every golden use ${REFERENCE_SAMPLE_RATE} Hz. The schedule below is compiled for ${sampleRate} Hz, so playback is self-consistent, but this rate is untested — append ?rate=${REFERENCE_SAMPLE_RATE} to compare.`,
    );
  }
  if (!Number.isInteger(sampleRate)) {
    throw new Error(`context sample rate ${sampleRate} is not an integer; the engine schedules in whole samples`);
  }

  audio.onstatechange = () => {
    status.contextState = audio.state;
    log(`audio context state → ${audio.state}`);
  };

  await audio.audioWorklet.addModule("/worklet.js");
  log("worklet module loaded from /worklet.js");

  const worklet = new AudioWorkletNode(audio, LIVE_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  worklet.onprocessorerror = () => {
    fail("the AudioWorkletProcessor threw and has been removed from the graph (onprocessorerror)");
  };
  worklet.port.onmessage = (event: MessageEvent) => {
    handleEvent(event.data as LiveEvent);
  };
  worklet.connect(audio.destination);
  log(`worklet node created and connected: ${LIVE_PROCESSOR_NAME}, 1 output × 2 channels`);

  const live = await LiveSession.create({
    clock: audio,
    sink: { postMessage: (command) => worklet.port.postMessage(command) },
    sampleRate,
    project,
    seed,
    fetchSample: (path) => client.asset(projectName, path),
    onSampleLoaded: (info) => {
      log(
        `sample ${info.path}: ${info.bytes} bytes, hash ${info.contentHash}, ${info.frames} frames @ ${info.sampleRate} Hz, ${info.channels} channel(s)`,
      );
    },
  });
  session = live;
  status.scheduleSamples = live.totalSamples;
  endSample = live.totalSamples + TAIL_SECONDS * sampleRate;
  log(
    `compiled schedule for ${sampleRate} Hz seed ${seed}: ${live.schedule.tracks.length} tracks, ${live.eventCount} events, ${live.totalSamples} samples (${(live.totalSamples / sampleRate).toFixed(2)} s), ${live.barStarts.length} bars`,
  );

  await audio.resume();
  status.contextState = audio.state;
  status.outputLatencySeconds = audio.outputLatency;
  log(`context resumed: state=${audio.state} outputLatency=${audio.outputLatency.toFixed(4)} s`);

  status.phase = "playing";
  status.reports = 0;
  status.reportsWithSound = 0;
  status.peakMax = 0;
  lastLogAt = performance.now();
  live.start();
  stopButton.disabled = false;
  log("transport started");
  render();
}

function stop(): void {
  if (session === undefined) return;
  session.stop();
  status.phase = "stopped";
  stopButton.disabled = true;
  startButton.disabled = false;
  log("transport stopped");
  verdict();
  render();
}

/** The line an automated check reads to decide whether sound actually happened. */
function verdict(): void {
  const summary = `peak ${status.peakMax.toFixed(4)} over ${status.reports} reports (${status.reportsWithSound} with signal), ${status.underrunBlocks} underrun blocks`;
  if (status.audioProven) {
    log(`AUDIO PROOF OK: ${summary} — non-zero output means the worklet really produced sound`);
  } else {
    fail(`AUDIO PROOF FAILED: ${summary} — the graph ran but every sample was silent`);
  }
}

function handleEvent(event: LiveEvent): void {
  if (event.type === "error") {
    fail(`worklet: ${event.message}`);
    return;
  }
  if (event.type === "ready") {
    log(`worklet ready: generation ${event.generation}`);
    return;
  }

  session?.acceptEvent(event);
  const peak = Math.max(event.peakLeft, event.peakRight);
  status.reports++;
  if (peak > 0) status.reportsWithSound++;
  if (peak > status.peakMax) status.peakMax = peak;
  if (peak > status.peakRecent) status.peakRecent = peak;
  if (status.peakMax > 0) status.audioProven = true;
  status.positionSample = event.positionSample;
  status.positionSeconds = event.positionSample / (status.contextSampleRate ?? 1);
  status.underrunBlocks = event.underrunBlocks;
  status.activeVoices = event.activeVoices;
  status.generation = event.generation;

  const now = performance.now();
  if (now - lastLogAt >= LOG_INTERVAL_MS) {
    lastLogAt = now;
    log(
      `pos=${status.positionSeconds.toFixed(2)}s/${((session?.totalSamples ?? 0) / (status.contextSampleRate ?? 1)).toFixed(2)}s peakL=${event.peakLeft.toFixed(4)} peakR=${event.peakRight.toFixed(4)} peakMax=${status.peakMax.toFixed(4)} underruns=${status.underrunBlocks} voices=${status.activeVoices} gen=${status.generation} reports=${status.reports}`,
    );
    status.peakRecent = 0;
    render();
  }

  if (status.phase === "playing" && event.playing && event.positionSample >= endSample) {
    log(`reached the end of the arrangement at ${status.positionSeconds.toFixed(2)} s`);
    stop();
  }
}

function render(): void {
  readout.textContent = [
    `phase              ${status.phase}`,
    `project            ${status.project}`,
    `context            ${status.contextState ?? "-"} @ ${status.contextSampleRate ?? "-"} Hz` +
      (status.sampleRateMatchesReference === null
        ? ""
        : status.sampleRateMatchesReference
          ? ` (matches the ${REFERENCE_SAMPLE_RATE} Hz reference)`
          : ` (NOT the ${REFERENCE_SAMPLE_RATE} Hz reference rate)`),
    `output latency     ${status.outputLatencySeconds === null ? "-" : `${status.outputLatencySeconds.toFixed(4)} s`}`,
    `position           ${status.positionSeconds.toFixed(2)} s (sample ${status.positionSample} of ${status.scheduleSamples})`,
    `underrun blocks    ${status.underrunBlocks}`,
    `active voices      ${status.activeVoices}`,
    `generation         ${status.generation}`,
    `reports            ${status.reports} (${status.reportsWithSound} with signal)`,
    `peak (session)     ${status.peakMax.toFixed(4)}`,
    `audio proven       ${status.audioProven ? "yes" : "no"}`,
    `errors             ${status.errors.length === 0 ? "none" : status.errors.join(" | ")}`,
  ].join("\n");
}

startButton.addEventListener("click", () => {
  void start();
});
stopButton.addEventListener("click", stop);

window.chordGarden = { start, stop, status: () => ({ ...status }) };
window.addEventListener("error", (event) => {
  fail(`uncaught: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  fail(`unhandled rejection: ${String(event.reason)}`);
});

log(`harness loaded for project "${projectName}" (seed ${seed}); click "start audio" or call window.chordGarden.start()`);
render();
