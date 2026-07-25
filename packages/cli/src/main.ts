#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalFiles,
  describeProject,
  loadProject,
  type Diagnostic,
  type DescribeReport,
  type LoadResult,
} from "@chord-garden/format";
import { compile, render, writeWav } from "@chord-garden/engine";
import { analyzeRender, type AnalysisReport } from "./analysis.js";
import { fmtAspects, type FmtAspect } from "./fmtAspects.js";

const RENDER_FLAGS = `  --out <path>         master WAV path (default: <project>/render/master.wav)
  --bars <start>-<end> render zero-based bars in [start, end); start inclusive, end exclusive
  --stems              also write <outdir>/stems/<track>.wav
  --seed <n>           integer probability seed (default: 0)
  --analyze            write <outdir>/analysis.json and print an analysis summary
  --json               with --analyze, print the analysis JSON instead of the summary
  --sample-rate <n>    positive integer sample rate (default: 48000)
  --tail <seconds>     non-negative release tail (default: 2)
`;

const USAGE = `usage:
  musictool validate <project> [--json]   check schema, pattern grammar, and semantic rules
  musictool fmt <project> [--check]       rewrite files to canonical bytes (--check: report only)
  musictool describe <project> [--json]   summarise the project
  musictool render <project> [flags]      deterministically render a project to WAV

render flags:
${RENDER_FLAGS}`;

const RENDER_USAGE = `usage:
  musictool render <project> [flags]

Renders the whole arrangement (or --bars) to a 24-bit stereo PCM WAV at the
--sample-rate, plus a release tail. Stems use the same format. Renders are
deterministic: the same project, seed, and sample rate give byte-identical
audio.

flags:
${RENDER_FLAGS}
analysis report (--analyze) — written to <outdir>/analysis.json and printed by
--json. The signal fields appear both on "master" and on each entry of
"tracks"; the onset, event, and spectral fields are per track:
  warnings           the list to read first; empty means nothing was flagged
  peakDb             loudest sample, dBFS; measured before WAV quantisation
  rmsDb              average level, dBFS; null means exactly silent
  clipping           .clipped, .sampleCount, .firstSampleIndex for samples
                     past |1.0|
  eventCount         events the compiler scheduled for the track, after
                     "probability" has been resolved with the seed
  onsets.expected    distinct sample positions those events start at, so
                     coincident events count once
  onsets.matched     expected positions a detected onset landed on; equal to
                     .detected. Below .expected means scheduled sound is
                     missing, and .unmatchedExpected lists where
  onsets.spurious    detected attacks matching no scheduled position (a
                     doubled clip, a runaway ratchet); .spuriousPositions
                     gives sample offsets to seek to
  silent             peak below parameters.silencePeakThreshold. Silent with a
                     nonzero eventCount is a warning; silent with zero events
                     is normal
  spectral           .centroidHz and energy .share per band in .bands
  parameters         every threshold, window, and band edge the report used,
                     so the numbers above are self-describing
  seed, barRange     what was rendered, echoed back
`;

export interface CliIo {
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
}

const PROCESS_IO: CliIo = { stdout: process.stdout, stderr: process.stderr };

if (isDirectExecution()) process.exitCode = runCli(process.argv.slice(2));

export function runCli(args: readonly string[], io: CliIo = PROCESS_IO): number {
  const [command, ...rest] = args;
  if (rest.includes("--help") || command === "--help" || command === "-h") {
    io.stdout.write(command === "render" ? RENDER_USAGE : USAGE);
    return 0;
  }
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const root = positional[0];

  switch (command) {
    case "validate":
      return root === undefined ? missingRoot(io) : runValidate(resolve(root), flags.has("--json"), io);
    case "fmt":
      return root === undefined ? missingRoot(io) : runFmt(resolve(root), flags.has("--check"), io);
    case "describe":
      return root === undefined ? missingRoot(io) : runDescribe(resolve(root), flags.has("--json"), io);
    case "render":
      return runRender(rest, io);
    default:
      io.stderr.write(USAGE);
      return 2;
  }
}

function missingRoot(io: CliIo): number {
  io.stderr.write(USAGE);
  return 2;
}

function runValidate(root: string, json: boolean, io: CliIo): number {
  const result = loadProject(root);
  if (json) {
    io.stdout.write(JSON.stringify({ ok: result.ok, diagnostics: result.diagnostics }, null, 2) + "\n");
  } else {
    printDiagnostics(result.diagnostics, io);
    const errors = result.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = result.diagnostics.filter((d) => d.severity === "warning").length;
    io.stdout.write(
      result.ok
        ? `valid (${warnings} warning${warnings === 1 ? "" : "s"})\n`
        : `invalid: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

function runFmt(root: string, checkOnly: boolean, io: CliIo): number {
  const result = loadProject(root);
  if (!result.ok || result.project === undefined) {
    printDiagnostics(result.diagnostics, io);
    io.stderr.write("fmt refused: fix validation errors first\n");
    return 1;
  }
  const changed: { path: string; aspects: FmtAspect[] }[] = [];
  for (const [path, canonical] of canonicalFiles(result.project)) {
    const absolute = join(root, path);
    let current: string | undefined;
    try {
      current = readFileSync(absolute, "utf8");
    } catch {
      current = undefined;
    }
    if (current !== canonical) {
      changed.push({ path, aspects: fmtAspects(current, canonical) });
      if (!checkOnly) writeFileSync(absolute, canonical);
    }
  }
  if (changed.length === 0) {
    io.stdout.write("already canonical\n");
    return 0;
  }
  for (const { path, aspects } of changed) {
    io.stdout.write(`${checkOnly ? "would rewrite" : "rewrote"} ${path} (${aspects.join(", ")})\n`);
  }
  return checkOnly ? 1 : 0;
}

function runDescribe(root: string, json: boolean, io: CliIo): number {
  const result = loadProject(root);
  if (result.project === undefined) {
    printDiagnostics(result.diagnostics, io);
    return 1;
  }
  const report = describeProject(result.project);
  if (json) {
    io.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printHumanDescribe(report, result, io);
  }
  return result.ok ? 0 : 1;
}

function printHumanDescribe(report: DescribeReport, result: LoadResult, io: CliIo): void {
  const [num, den] = report.timeSignature;
  const key = report.key ? `${report.key.root} ${report.key.scale}` : "none";
  io.stdout.write(`${report.name} — ${formatBpm(report.bpm)} bpm, ${num}/${den}, key: ${key}, ${report.bars} bars\n`);
  for (const track of report.tracks) {
    const automation = track.automatedParams.length > 0 ? `, automates ${track.automatedParams.join(", ")}` : "";
    io.stdout.write(
      `  ${track.id} (${track.type} → ${track.instrument}): patterns [${track.patterns.join(", ")}], ${track.clipCount} clip${track.clipCount === 1 ? "" : "s"}${automation}\n`,
    );
  }
  for (const pattern of report.patterns) {
    if (pattern.kind === "grid") {
      const lanes = (pattern.lanes ?? []).map((l) => `${l.lane}:${l.hits}`).join(" ");
      io.stdout.write(`  pattern ${pattern.id} (grid, ${pattern.bars} bar${pattern.bars === 1 ? "" : "s"}): hits ${lanes}\n`);
    } else {
      const range = pattern.pitchRange ? `, ${pattern.pitchRange[0]}–${pattern.pitchRange[1]}` : "";
      io.stdout.write(`  pattern ${pattern.id} (notes, ${pattern.bars} bar${pattern.bars === 1 ? "" : "s"}): ${pattern.noteCount} notes${range}\n`);
    }
  }
  if (result.diagnostics.length > 0) {
    io.stdout.write("diagnostics:\n");
    printDiagnostics(result.diagnostics, io);
  }
}

function formatBpm(bpm100: number): string {
  return bpm100 % 100 === 0 ? String(bpm100 / 100) : (bpm100 / 100).toFixed(2);
}

function printDiagnostics(diagnostics: Diagnostic[], io: CliIo): void {
  for (const d of diagnostics) {
    const loc = d.loc ? `:${d.loc.line}:${d.loc.column}` : "";
    const pointer = d.pointer !== undefined && d.pointer !== "" ? ` ${d.pointer}` : "";
    const suggestion = d.suggestion ? ` (${d.suggestion})` : "";
    io.stderr.write(`${d.severity} ${d.code} ${d.file}${loc}${pointer} — ${d.message}${suggestion}\n`);
  }
}

interface RenderCliOptions {
  root: string;
  out: string;
  barRange?: { start: number; end: number };
  stems: boolean;
  seed: number;
  analyze: boolean;
  json: boolean;
  sampleRate: number;
  tailSeconds: number;
}

function runRender(args: readonly string[], io: CliIo): number {
  const parsed = parseRenderArgs(args);
  if (typeof parsed === "string") {
    io.stderr.write(`musictool render: ${parsed}\n`);
    io.stderr.write("Run 'musictool render --help' for usage.\n");
    return 2;
  }

  const loaded = loadProject(parsed.root);
  if (!loaded.ok || loaded.project === undefined) {
    if (parsed.json) {
      io.stdout.write(JSON.stringify({ ok: false, diagnostics: loaded.diagnostics }, null, 2) + "\n");
    } else {
      printDiagnostics(loaded.diagnostics, io);
    }
    return 1;
  }
  if (loaded.diagnostics.length > 0) printDiagnostics(loaded.diagnostics, io);

  try {
    const scheduleOptions = renderCompileOptions(parsed);
    const schedule = compile(loaded.project, scheduleOptions);
    const rendered = render(loaded.project, {
      ...scheduleOptions,
      stems: true,
      tailSeconds: parsed.tailSeconds,
    });
    if (rendered.stems === undefined) throw new Error("renderer did not return the stems required for analysis");
    const report = analyzeRender(rendered.master, rendered.stems, schedule, {
      seed: parsed.seed,
      ...(parsed.barRange === undefined ? {} : { barRange: parsed.barRange }),
    });

    mkdirSync(dirname(parsed.out), { recursive: true });
    writeWav(parsed.out, rendered);
    if (parsed.stems) {
      const stemsDirectory = join(dirname(parsed.out), "stems");
      mkdirSync(stemsDirectory, { recursive: true });
      for (const [trackId, stem] of rendered.stems) {
        writeWav(join(stemsDirectory, `${trackId}.wav`), {
          sampleRate: rendered.sampleRate,
          left: stem.left,
          right: stem.right,
        });
      }
    }
    if (parsed.analyze) {
      writeFileSync(join(dirname(parsed.out), "analysis.json"), JSON.stringify(report, null, 2) + "\n");
      if (parsed.json) {
        io.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        printHumanAnalysis(report, parsed.out, io);
      }
    } else {
      io.stdout.write(
        `rendered ${rendered.totalSamples} samples (${formatSeconds(rendered.totalSamples / rendered.sampleRate)} s) to ${parsed.out}\n`,
      );
    }

    const allTracksSilent = report.tracks.every((track) => track.silent);
    if (allTracksSilent) {
      io.stderr.write("render failed: every track is silent\n");
      return 1;
    }
    return 0;
  } catch (error) {
    io.stderr.write(`musictool render: ${errorMessage(error)}\n`);
    return isBarRangeError(error) ? 2 : 1;
  }
}

function parseRenderArgs(args: readonly string[]): RenderCliOptions | string {
  let root: string | undefined;
  let out: string | undefined;
  let barRange: { start: number; end: number } | undefined;
  let stems = false;
  let seed = 0;
  let analyze = false;
  let json = false;
  let sampleRate = 48_000;
  let tailSeconds = 2;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      if (root !== undefined) return `unexpected positional argument "${argument}"`;
      root = resolve(argument);
      continue;
    }
    switch (argument) {
      case "--out": {
        const value = optionValue(args, ++index, "--out");
        if (typeof value !== "string") return value.error;
        out = resolve(value);
        break;
      }
      case "--bars": {
        const value = optionValue(args, ++index, "--bars");
        if (typeof value !== "string") return value.error;
        const range = parseBarRange(value);
        if (typeof range === "string") return range;
        barRange = range;
        break;
      }
      case "--stems":
        stems = true;
        break;
      case "--seed": {
        const value = optionValue(args, ++index, "--seed");
        if (typeof value !== "string") return value.error;
        const number = parseSafeInteger(value);
        if (number === undefined) return `--seed must be a safe integer, got "${value}"`;
        seed = number;
        break;
      }
      case "--analyze":
        analyze = true;
        break;
      case "--json":
        json = true;
        break;
      case "--sample-rate": {
        const value = optionValue(args, ++index, "--sample-rate");
        if (typeof value !== "string") return value.error;
        const number = parseSafeInteger(value);
        if (number === undefined || number <= 0) {
          return `--sample-rate must be a positive safe integer, got "${value}"`;
        }
        sampleRate = number;
        break;
      }
      case "--tail": {
        const value = optionValue(args, ++index, "--tail");
        if (typeof value !== "string") return value.error;
        if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
          return `--tail must be a non-negative number of seconds, got "${value}"`;
        }
        tailSeconds = Number(value);
        if (!Number.isFinite(tailSeconds)) return `--tail is too large, got "${value}"`;
        break;
      }
      default:
        return `unknown option "${argument}"`;
    }
  }

  if (root === undefined) return "missing <project>";
  if (json && !analyze) return "--json requires --analyze";
  return {
    root,
    out: out ?? join(root, "render", "master.wav"),
    ...(barRange === undefined ? {} : { barRange }),
    stems,
    seed,
    analyze,
    json,
    sampleRate,
    tailSeconds,
  };
}

function parseBarRange(value: string): { start: number; end: number } | string {
  const match = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(value);
  if (match === null) {
    return `--bars must be "<start>-<end>" using non-negative integers and [start, end) semantics, got "${value}"`;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return `--bars values must be safe integers`;
  if (end <= start) return `--bars must satisfy start < end for [start, end), got "${value}"`;
  return { start, end };
}

function optionValue(
  args: readonly string[],
  index: number,
  option: string,
): string | { error: string } {
  const value = args[index];
  return value === undefined || value.startsWith("--") ? { error: `${option} requires a value` } : value;
}

function parseSafeInteger(value: string): number | undefined {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function renderCompileOptions(options: RenderCliOptions): {
  sampleRate: number;
  seed: number;
  barRange?: { start: number; end: number };
} {
  return options.barRange === undefined
    ? { sampleRate: options.sampleRate, seed: options.seed }
    : { sampleRate: options.sampleRate, seed: options.seed, barRange: options.barRange };
}

function printHumanAnalysis(report: AnalysisReport, out: string, io: CliIo): void {
  io.stdout.write(
    `rendered ${report.totalSamples} samples (${formatSeconds(report.durationSeconds)} s) to ${out}\n`,
  );
  io.stdout.write(
    `master: peak ${formatDb(report.master.peakDb)}, RMS ${formatDb(report.master.rmsDb)}, clipping ${report.master.clipping.clipped ? `yes (${report.master.clipping.sampleCount})` : "no"}\n`,
  );
  for (const track of report.tracks) {
    io.stdout.write(
      `  ${track.id}: ${track.eventCount} events, peak ${formatDb(track.peakDb)}, onsets ${track.onsets.matched}/${track.onsets.expected}, spurious ${track.onsets.spurious}, silent ${track.silent ? "yes" : "no"}\n`,
    );
  }
  if (report.warnings.length === 0) {
    io.stdout.write("warnings: none\n");
  } else {
    io.stdout.write("warnings:\n");
    for (const warning of report.warnings) io.stdout.write(`  - ${warning}\n`);
  }
}

function formatDb(value: number | null): string {
  return value === null ? "-inf dBFS" : `${value.toFixed(2)} dBFS`;
}

function formatSeconds(value: number): string {
  return value.toFixed(3);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBarRangeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("bar range");
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
