import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "@chord-garden/format";
import { compile, decodeWav, encodeWav } from "@chord-garden/engine";
import { afterEach, describe, expect, it } from "vitest";
import { type AnalysisReport } from "../src/analysis.js";
import { runCli, type CliIo } from "../src/main.js";

const VALID_FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
const INVALID_FIXTURE = fileURLToPath(new URL("../../../fixtures/invalid/comment", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("render CLI", () => {
  it("writes a master WAV at the schedule-plus-tail length", () => {
    const projectRoot = copyFixture();
    const result = run(["render", projectRoot]);
    const masterPath = join(projectRoot, "render", "master.wav");
    const decoded = decodeWav(readFileSync(masterPath));
    const project = loadProject(projectRoot).project!;

    expect(result.code).toBe(0);
    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.channels[0]).toHaveLength(compile(project).totalSamples + 96_000);
  });

  it("renders a shorter half-open bar range and rejects malformed ranges as usage errors", () => {
    const projectRoot = copyFixture();
    const fullPath = join(projectRoot, "full.wav");
    const shortPath = join(projectRoot, "short.wav");
    expect(run(["render", projectRoot, "--out", fullPath, "--tail", "0"]).code).toBe(0);
    expect(
      run(["render", projectRoot, "--out", shortPath, "--bars", "0-2", "--tail", "0"]).code,
    ).toBe(0);
    expect(decodeWav(readFileSync(shortPath)).channels[0].length).toBeLessThan(
      decodeWav(readFileSync(fullPath)).channels[0].length,
    );

    const badPath = join(projectRoot, "bad.wav");
    const malformed = run(["render", projectRoot, "--out", badPath, "--bars", "4..8"]);
    expect(malformed.code).toBe(2);
    expect(malformed.stderr).toContain('--bars must be "<start>-<end>"');
    expect(existsSync(badPath)).toBe(false);
  });

  it("writes one stem per track using track IDs as filenames", () => {
    const projectRoot = copyFixture();
    const out = join(projectRoot, "audio", "mix.wav");
    expect(run(["render", projectRoot, "--out", out, "--stems", "--tail", "0"]).code).toBe(0);
    expect(["bass.wav", "drums.wav", "pad.wav"].map((name) => existsSync(join(projectRoot, "audio", "stems", name)))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("is byte-identical for the same seed and changes when probability outcomes change", () => {
    const projectRoot = copyFixture();
    const first = join(projectRoot, "seed-1-a.wav");
    const second = join(projectRoot, "seed-1-b.wav");
    const different = join(projectRoot, "seed-2.wav");
    expect(run(["render", projectRoot, "--out", first, "--seed", "1", "--tail", "0"]).code).toBe(0);
    expect(run(["render", projectRoot, "--out", second, "--seed", "1", "--tail", "0"]).code).toBe(0);
    expect(run(["render", projectRoot, "--out", different, "--seed", "2", "--tail", "0"]).code).toBe(0);
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
    expect(readFileSync(first).equals(readFileSync(different))).toBe(false);
  });

  it("reports worked-example onsets, audible drums and bass, and a normally silent empty pad", () => {
    const projectRoot = copyFixture();
    const out = join(projectRoot, "analysis", "master.wav");
    const result = run(["render", projectRoot, "--out", out, "--analyze", "--json"]);
    const report = JSON.parse(result.stdout) as AnalysisReport;
    const drums = report.tracks.find((track) => track.id === "drums")!;
    const bass = report.tracks.find((track) => track.id === "bass")!;
    const pad = report.tracks.find((track) => track.id === "pad")!;

    expect(result.code).toBe(0);
    expect(drums.onsets.expected).toBe(191);
    expect(drums.onsets.matched).toBe(191);
    expect(bass.onsets.expected).toBe(17);
    expect(bass.onsets.matched).toBe(17);
    expect(drums.onsets.spurious).toBeLessThan(report.parameters.onset.spurious.warning.minimumCount);
    expect(bass.onsets.spurious).toBeLessThan(report.parameters.onset.spurious.warning.minimumCount);
    expect(report.parameters.onset.reportsScheduleMatchedCandidatesOnly).toBe(false);
    expect(drums.silent).toBe(false);
    expect(bass.silent).toBe(false);
    expect(pad.eventCount).toBe(0);
    expect(pad.silent).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('Track "pad"'))).toBe(false);
    // The worked example gain-stages its bass explicitly (PLAN.md §6.3), so a
    // healthy render must produce no warnings at all.
    expect(report.master.clipping.clipped).toBe(false);
    expect(report.warnings).toEqual([]);
    expect(JSON.parse(readFileSync(join(projectRoot, "analysis", "analysis.json"), "utf8"))).toEqual(report);
  });

  it("reports extra transients from a long drum sample through the real render path", () => {
    const projectRoot = copyFixture();
    const drumsPatternPath = join(projectRoot, "patterns", "drums-verse.json");
    const drumsPattern = readJson<{
      lanes: {
        lane: string;
        steps: string;
        defaults?: { gateTicks?: number };
        stepEvents?: unknown[];
      }[];
    }>(drumsPatternPath);
    for (const lane of drumsPattern.lanes) {
      lane.steps = lane.lane === "kick" ? "x... .... .... ...." : ".... .... .... ....";
      delete lane.stepEvents;
      if (lane.lane === "kick") lane.defaults = { ...lane.defaults, gateTicks: 120 };
    }
    writeJson(drumsPatternPath, drumsPattern);
    writeFileSync(join(projectRoot, "samples", "kick.wav"), longMultiTransientSample());

    const out = join(projectRoot, "spurious", "master.wav");
    const result = run(["render", projectRoot, "--out", out, "--analyze", "--json"]);
    const report = JSON.parse(result.stdout) as AnalysisReport;
    const drums = report.tracks.find((track) => track.id === "drums")!;

    expect(result.code).toBe(0);
    expect(drums.onsets.spurious).toBeGreaterThan(0);
    expect(drums.onsets.spuriousPositions).toHaveLength(
      Math.min(drums.onsets.spurious, report.parameters.onset.spurious.positionsLimit),
    );
    expect(report.warnings).toContainEqual(
      expect.stringContaining('Track "drums": disproportionate spurious onsets'),
    );
  });

  it("warns when scheduled events render silent without warning for empty tracks", () => {
    const projectRoot = copyFixture();
    const bassPatternPath = join(projectRoot, "patterns", "bass-main.json");
    const bassPattern = readJson<{ notes: { velocity: number }[] }>(bassPatternPath);
    for (const note of bassPattern.notes) note.velocity = 0;
    writeJson(bassPatternPath, bassPattern);

    const out = join(projectRoot, "broken", "master.wav");
    const result = run(["render", projectRoot, "--out", out, "--analyze", "--json"]);
    const report = JSON.parse(result.stdout) as AnalysisReport;
    expect(result.code).toBe(0);
    expect(report.warnings).toContainEqual(expect.stringContaining('Track "bass": events but silent'));
    expect(report.warnings.some((warning) => warning.includes('Track "pad"'))).toBe(false);
  });

  it("detects clipping before WAV quantisation and reports a quiet signal as unclipped", () => {
    const clippingRoot = copyFixture();
    removeBassHeadroom(clippingRoot);
    const clippingResult = run([
      "render",
      clippingRoot,
      "--out",
      join(clippingRoot, "loud", "master.wav"),
      "--analyze",
      "--json",
    ]);
    const clippingReport = JSON.parse(clippingResult.stdout) as AnalysisReport;
    expect(clippingReport.master.clipping.clipped).toBe(true);
    expect(clippingReport.master.clipping.sampleCount).toBeGreaterThan(100);
    expect(clippingReport.master.clipping.firstSampleIndex).not.toBeNull();

    const quietRoot = copyFixture();
    silenceEveryEvent(quietRoot);
    const quietResult = run([
      "render",
      quietRoot,
      "--out",
      join(quietRoot, "quiet", "master.wav"),
      "--analyze",
      "--json",
    ]);
    const quietReport = JSON.parse(quietResult.stdout) as AnalysisReport;
    expect(quietReport.master.clipping).toEqual({
      clipped: false,
      sampleCount: 0,
      firstSampleIndex: null,
    });
  });

  it("exits 1 on validation errors, prints diagnostics, and writes no audio", () => {
    const directory = temporaryDirectory();
    const out = join(directory, "render", "master.wav");
    const result = run(["render", INVALID_FIXTURE, "--out", out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error json.comment");
    expect(existsSync(out)).toBe(false);
  });

  it("writes the diagnostic render but exits 1 when every track is silent", () => {
    const projectRoot = copyFixture();
    silenceEveryEvent(projectRoot);
    const out = join(projectRoot, "silent", "master.wav");
    const result = run(["render", projectRoot, "--out", out, "--analyze", "--json"]);
    const report = JSON.parse(result.stdout) as AnalysisReport;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("every track is silent");
    expect(report.tracks.every((track) => track.silent)).toBe(true);
    expect(existsSync(out)).toBe(true);
  });
});

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  };
  return { code: runCli(args, io), stdout, stderr };
}

function copyFixture(): string {
  const root = temporaryDirectory();
  cpSync(VALID_FIXTURE, root, { recursive: true });
  return root;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "chord-garden-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Returns the bass to the unity gain the engine defaults to. The resonant
 * filter then pushes the master past full scale, which is the point of PLAN.md
 * §6.3: the engine applies no hidden gain reduction, so an author who does not
 * gain-stage gets measured overshoot rather than a silent fix.
 */
function removeBassHeadroom(root: string): void {
  const path = join(root, "instruments", "bass-synth.json");
  const instrument = readJson<{ params: Record<string, unknown> }>(path);
  instrument.params.gain = 0;
  writeJson(path, instrument);
}

function silenceEveryEvent(root: string): void {
  const bassPatternPath = join(root, "patterns", "bass-main.json");
  const bassPattern = readJson<{ notes: { velocity: number }[] }>(bassPatternPath);
  for (const note of bassPattern.notes) note.velocity = 0;
  writeJson(bassPatternPath, bassPattern);

  const drumsPatternPath = join(root, "patterns", "drums-verse.json");
  const drumsPattern = readJson<{
    lanes: { defaults?: { velocity?: number }; stepEvents?: { velocity?: number }[] }[];
  }>(drumsPatternPath);
  for (const lane of drumsPattern.lanes) {
    lane.defaults = { ...lane.defaults, velocity: 0 };
    for (const event of lane.stepEvents ?? []) event.velocity = 0;
  }
  writeJson(drumsPatternPath, drumsPattern);
}

function longMultiTransientSample(): Uint8Array {
  const sampleRate = 48_000;
  const samples = new Float32Array(Math.round(sampleRate * 0.4));
  const burstLength = Math.round(sampleRate * 0.004);
  for (const startSeconds of [0, 0.1, 0.2, 0.3]) {
    const start = Math.round(startSeconds * sampleRate);
    for (let offset = 0; offset < burstLength; offset++) {
      const envelope = 1 - offset / burstLength;
      samples[start + offset] = Math.sin((2 * Math.PI * 4_000 * offset) / sampleRate) * envelope * 0.8;
    }
  }
  return encodeWav({ sampleRate, left: samples });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
