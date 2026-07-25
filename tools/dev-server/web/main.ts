import { compile, musicalGrid, type CompiledSchedule } from "@chord-garden/engine/compiler";
import {
  LIVE_PROCESSOR_NAME,
  LiveScheduler,
  LiveTransport,
  hashContent,
  intervalTicker,
  liveGraph,
  lookaheadSamples,
  requiredSamplePaths,
  type LiveCommand,
  type LiveEvent,
  type LiveGraph,
} from "@chord-garden/engine/live";
import { decodeWav } from "@chord-garden/engine/wav";
import { assembleProject, parseStrictJson, type AssembledFile, type Project } from "@chord-garden/format/pure";
import type { ProjectSummary } from "../src/api.js";

/**
 * The Phase 2 verification harness: load a project over HTTP, run it through the
 * real live engine in a real AudioWorklet, and say loudly enough for an
 * automated check whether sound came out.
 *
 * Deliberately plain. Phase 3 builds the actual UI (PLAN.md §16); this page
 * exists to prove the engine works in a browser, and every line of it is
 * observable from the console under one prefix.
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

let context: AudioContext | undefined;
let transport: LiveTransport | undefined;
let schedule: CompiledSchedule | undefined;
let endSample = 0;
let lastLogAt = 0;

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * Fetch and index a project bundle.
 *
 * The server has already schema- and semantic-validated it, and says so in the
 * summary; the browser re-parses each document with the format package's own
 * strict parser rather than `JSON.parse` so that a file the loader would reject
 * (a comment, a duplicate key) is rejected here too instead of quietly becoming
 * a different document than the one on disk.
 */
async function fetchProject(name: string): Promise<Project> {
  const base = `/api/projects/${encodeURIComponent(name)}`;
  const summary = await getJson<ProjectSummary>(base);
  const errors = summary.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  for (const diagnostic of summary.diagnostics) {
    log(`project ${diagnostic.severity}: ${diagnostic.file}: ${diagnostic.code} ${diagnostic.message}`);
  }
  if (!summary.ok) {
    throw new Error(`project "${name}" does not validate (${errors.length} errors); fix it before playing it`);
  }

  const documents: AssembledFile[] = [];
  for (const file of summary.files) {
    const response = await fetch(`${base}/files/${file.path}`);
    if (!response.ok) throw new Error(`GET ${file.path} → ${response.status}`);
    const parsed = parseStrictJson(await response.text(), file.path);
    if (parsed.value === undefined) {
      throw new Error(
        `${file.path} did not parse: ${parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
      );
    }
    documents.push({ kind: file.kind, value: parsed.value });
  }

  const project = assembleProject(base, documents);
  log(`project "${name}" loaded: ${summary.files.length} documents, ${project.tracks.size} tracks, ${project.instruments.size} instruments`);
  return project;
}

/** Fetch, hash and decode every sample the schedule needs, then push it across. */
async function sendSamples(
  project: Project,
  target: CompiledSchedule,
  post: (command: LiveCommand) => void,
): Promise<Map<string, string>> {
  const base = `/api/projects/${encodeURIComponent(projectName)}/files`;
  const hashes = new Map<string, string>();
  for (const path of requiredSamplePaths(project, target)) {
    const response = await fetch(`${base}/${path}`);
    if (!response.ok) throw new Error(`GET ${path} → ${response.status} ${await response.text()}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Hashed over the bytes on the wire, exactly as the offline path hashes the
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
      left: decoded.channels[0],
      ...(right === undefined ? {} : { right }),
    });
    log(
      `sample ${path}: ${bytes.byteLength} bytes, hash ${contentHash}, ${decoded.channels[0].length} frames @ ${decoded.sampleRate} Hz, ${decoded.channels.length} channel(s)`,
    );
  }
  return hashes;
}

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
    transport = undefined;
    log("closed the previous audio context");
  }
  const project = await fetchProject(projectName);
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

  const compiled = compile(project, { sampleRate, seed });
  schedule = compiled;
  const barStarts = musicalGrid(project, { sampleRate, seed }).barStarts;
  const events = compiled.tracks.reduce((total, track) => total + track.events.length, 0);
  status.scheduleSamples = compiled.totalSamples;
  endSample = compiled.totalSamples + TAIL_SECONDS * sampleRate;
  log(
    `compiled schedule for ${sampleRate} Hz seed ${seed}: ${compiled.tracks.length} tracks, ${events} events, ${compiled.totalSamples} samples (${(compiled.totalSamples / sampleRate).toFixed(2)} s), ${barStarts.length} bars`,
  );

  const post = (command: LiveCommand): void => {
    worklet.port.postMessage(command);
  };
  const hashes = await sendSamples(project, compiled, post);
  const graphOf = (target: CompiledSchedule): LiveGraph =>
    liveGraph(project, target, (path) => {
      const hash = hashes.get(path);
      if (hash === undefined) throw new Error(`no content hash was fetched for "${path}"`);
      return hash;
    });

  const scheduler = new LiveScheduler(compiled, barStarts, lookaheadSamples(sampleRate));
  transport = new LiveTransport({
    clock: audio,
    sink: { postMessage: post },
    scheduler,
    sampleRate,
    ticker: intervalTicker(window),
    graphOf,
  });
  transport.sendConfigure({ generation: 0, atSample: null, schedule: compiled }, graphOf(compiled));

  await audio.resume();
  status.contextState = audio.state;
  status.outputLatencySeconds = audio.outputLatency;
  log(`context resumed: state=${audio.state} outputLatency=${audio.outputLatency.toFixed(4)} s`);

  status.phase = "playing";
  status.reports = 0;
  status.reportsWithSound = 0;
  status.peakMax = 0;
  lastLogAt = performance.now();
  transport.start();
  stopButton.disabled = false;
  log("transport started");
  render();
}

function stop(): void {
  if (transport === undefined) return;
  transport.stop();
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

  transport?.acceptEvent(event);
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
      `pos=${status.positionSeconds.toFixed(2)}s/${((schedule?.totalSamples ?? 0) / (status.contextSampleRate ?? 1)).toFixed(2)}s peakL=${event.peakLeft.toFixed(4)} peakR=${event.peakRight.toFixed(4)} peakMax=${status.peakMax.toFixed(4)} underruns=${status.underrunBlocks} voices=${status.activeVoices} gen=${status.generation} reports=${status.reports}`,
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
