import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/main.js";

const VALID_FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("help output", () => {
  it("gives render its own usage block naming the render flags and analysis fields", () => {
    const result = run(["render", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("musictool render <project> [flags]");
    expect(result.stdout).toContain("24-bit stereo PCM WAV");
    expect(result.stdout).toContain("--bars <start>-<end>");
    expect(result.stdout).toContain("--seed <n>");
    for (const field of ["warnings", "peakDb", "clipping", "onsets.expected", "onsets.spurious", "silent", "parameters"]) {
      expect(result.stdout).toContain(field);
    }
    // The render page replaces the global one rather than reprinting it.
    expect(result.stdout).not.toContain("musictool validate <project>");
  });

  it("still prints the global usage for the other commands", () => {
    for (const args of [["--help"], ["validate", "--help"], ["fmt", "--help"]]) {
      const result = run(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("musictool validate <project>");
      expect(result.stdout).toContain("render flags:");
    }
  });
});

describe("fmt --check", () => {
  it("reports nothing to do for a canonical project", () => {
    const projectRoot = copyFixture();
    const result = run(["fmt", projectRoot, "--check"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("already canonical\n");
  });

  it("names re-serialised whitespace as formatting", () => {
    const projectRoot = copyFixture();
    const path = join(projectRoot, "patterns", "bass-main.json");
    writeFileSync(path, JSON.stringify(readJson(path)) + "\n");

    const result = run(["fmt", projectRoot, "--check"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("would rewrite patterns/bass-main.json (formatting)\n");
  });

  it("names a reordered object's keys as key order", () => {
    const projectRoot = copyFixture();
    const path = join(projectRoot, "arrangement.json");
    const arrangement = readJson<{ clips: Record<string, unknown>[] }>(path);
    arrangement.clips = arrangement.clips.map((clip) =>
      Object.fromEntries(Object.entries(clip).reverse()),
    );
    writeCanonicalish(path, arrangement);

    const result = run(["fmt", projectRoot, "--check"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("would rewrite arrangement.json (key order)\n");
  });

  it("names reordered clips as sort order without blaming their keys", () => {
    const projectRoot = copyFixture();
    const path = join(projectRoot, "arrangement.json");
    const arrangement = readJson<{ clips: unknown[] }>(path);
    arrangement.clips = [...arrangement.clips].reverse();
    writeCanonicalish(path, arrangement);

    const result = run(["fmt", projectRoot, "--check"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("would rewrite arrangement.json (sort order)\n");
  });

  it("names respaced steps strings as steps grouping", () => {
    const projectRoot = copyFixture();
    const path = join(projectRoot, "patterns", "drums-verse.json");
    const pattern = readJson<{ lanes: { steps: string }[] }>(path);
    const lane = pattern.lanes[0]!;
    lane.steps = lane.steps.replaceAll(" ", "").replaceAll("|", "");
    writeCanonicalish(path, pattern);

    const result = run(["fmt", projectRoot, "--check"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("would rewrite patterns/drums-verse.json (steps grouping)\n");
  });

  it("lists every aspect a file needs and rewrites it with the same report", () => {
    const projectRoot = copyFixture();
    const path = join(projectRoot, "patterns", "drums-verse.json");
    const pattern = readJson<{ lanes: { steps: string; stepEvents?: { step: number }[] }[] }>(path);
    const lane = pattern.lanes[0]!;
    lane.steps = lane.steps.replaceAll(" ", "");
    const withEvents = pattern.lanes.find((candidate) => (candidate.stepEvents ?? []).length > 1);
    if (withEvents?.stepEvents === undefined) throw new Error("fixture no longer has a lane with stepEvents");
    withEvents.stepEvents = [...withEvents.stepEvents].reverse();
    writeFileSync(path, JSON.stringify(pattern) + "\n");

    const checked = run(["fmt", projectRoot, "--check"]);
    expect(checked.code).toBe(1);
    expect(checked.stdout).toBe("would rewrite patterns/drums-verse.json (sort order, steps grouping)\n");

    const written = run(["fmt", projectRoot]);
    expect(written.code).toBe(0);
    expect(written.stdout).toBe("rewrote patterns/drums-verse.json (sort order, steps grouping)\n");
    expect(run(["fmt", projectRoot, "--check"]).stdout).toBe("already canonical\n");
  });
});

describe("describe on a project that does not validate", () => {
  // `runCli` has no try/catch anywhere above it — `main.ts` assigns its return
  // value straight to `process.exitCode` — so anything thrown in here reached the
  // user as a raw V8 stack trace. These run the real command, not `describeProject`,
  // because the CLI is where that was visible.
  const BROKEN = fileURLToPath(new URL("../../../fixtures/invalid/trackorder-unknown", import.meta.url));

  it("prints the summary it can and the diagnostics, and exits 1", () => {
    const result = run(["describe", BROKEN]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("diagnostics:");
    expect(result.stdout).toContain("trackOrder names a track that does not exist");
    expect(result.stderr).toContain("trackorder.unknown-track");
    // The summary is real, not a stub: the project's own header line is there.
    expect(result.stdout).toMatch(/bpm, \d+\/\d+, key: /);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("still emits parseable JSON on stdout, with the diagnostics on stderr", () => {
    const result = run(["describe", BROKEN, "--json"]);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as { tracks: { id: string; missing?: true }[] };
    expect(report.tracks.some((track) => track.missing === true)).toBe(true);
    // stdout stays exactly the report, so piping it into `jq` keeps working.
    expect(result.stdout).not.toContain("trackorder.unknown-track");
    expect(result.stderr).toContain("trackorder.unknown-track");
  });

  it("describes every valid fixture without complaint", () => {
    const result = run(["describe", VALID_FIXTURE]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("diagnostics:");
    expect(result.stdout).not.toContain("does not exist");
  });
});

function run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
  };
  return { code: runCli(args, io), stdout, stderr };
}

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "chord-garden-cli-"));
  temporaryDirectories.push(root);
  cpSync(VALID_FIXTURE, root, { recursive: true });
  return root;
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Writes 2-space-indented JSON with a trailing newline: close enough to
 * canonical that the only reported aspect is the one the test introduced.
 */
function writeCanonicalish(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
