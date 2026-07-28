import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../src/index.js";
import type { Diagnostic } from "../src/index.js";
import { createTempProject } from "./tempProject.js";

const INVALID_ROOT = fileURLToPath(new URL("../../../fixtures/invalid", import.meta.url));
/** A real PCM WAV, so `orphan.sample` is the only thing a sample test can trip. */
const A_REAL_WAV = join(INVALID_ROOT, "prototype-kit-lane", "samples", "kick.wav");

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempProject(label: string): string {
  const root = createTempProject(label);
  temps.push(root);
  return root;
}

function warnings(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === "warning").map((d) => d.code);
}

function errors(diagnostics: Diagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

function writeJson(root: string, path: string, doc: unknown): void {
  writeFileSync(join(root, path), JSON.stringify(doc));
}

/**
 * The three orphan rules are the only semantic rules that report a `warning`, so
 * they cannot be covered by the `EXPECTED` table in `diagnostics.test.ts` —
 * that table asserts an error and a failed load. Each was deletable with the
 * whole suite still green.
 *
 * Every rule is checked twice: once on the project that has the orphan, and
 * once on the same project with the reference put back. A rule that only ever
 * fires is as useless as one that never does, and an orphan warning that will
 * not go away is the kind of noise PLAN.md §13 says trains agents to stop
 * reading warnings.
 */
describe("orphan warnings", () => {
  const SYNTH = { id: "s", type: "synth", engine: "basic-mono" };
  const PATTERN = {
    id: "p",
    kind: "notes",
    lengthTicks: 3840,
    notes: [{ pitch: "A1", startTick: 0, durationTicks: 480, velocity: 800 }],
  };

  /** A project with one synth track, one pattern, and nothing wrong with it. */
  function wholeProject(label: string): string {
    const root = tempProject(label);
    writeJson(root, "project.json", {
      format: 1,
      name: label,
      ppqn: 960,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: ["t"],
    });
    writeJson(root, "instruments/s.json", SYNTH);
    writeJson(root, "tracks/t.json", { id: "t", type: "instrument", instrument: "s", patterns: ["p"] });
    writeJson(root, "patterns/p.json", PATTERN);
    writeJson(root, "arrangement.json", {
      lengthTicks: 3840,
      clips: [{ track: "t", pattern: "p", startTick: 0, repeatCount: 1 }],
    });
    return root;
  }

  it("names a pattern no track and no clip refers to", () => {
    const root = wholeProject("orphan-pattern");
    writeJson(root, "patterns/lonely.json", { ...PATTERN, id: "lonely" });

    const result = loadProject(root);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(warnings(result.diagnostics)).toEqual(["orphan.pattern"]);
    const diagnostic = result.diagnostics.find((d) => d.code === "orphan.pattern");
    expect(diagnostic?.file).toBe("patterns/lonely.json");
  });

  it("says nothing about a pattern reached only through a clip", () => {
    const root = wholeProject("orphan-pattern-via-clip");
    writeJson(root, "patterns/lonely.json", { ...PATTERN, id: "lonely" });
    // Not in any track's `patterns` list — only the arrangement names it, which
    // is the reference the renderer actually follows.
    writeJson(root, "arrangement.json", {
      lengthTicks: 7680,
      clips: [
        { track: "t", pattern: "p", startTick: 0, repeatCount: 1 },
        { track: "t", pattern: "lonely", startTick: 3840, repeatCount: 1 },
      ],
    });

    const result = loadProject(root);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(warnings(result.diagnostics)).toEqual([]);
  });

  it("names an instrument no track refers to", () => {
    const root = wholeProject("orphan-instrument");
    writeJson(root, "instruments/spare.json", { ...SYNTH, id: "spare" });

    const result = loadProject(root);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(warnings(result.diagnostics)).toEqual(["orphan.instrument"]);
    const diagnostic = result.diagnostics.find((d) => d.code === "orphan.instrument");
    expect(diagnostic?.file).toBe("instruments/spare.json");
  });

  it("says nothing about an instrument a track refers to", () => {
    const root = wholeProject("orphan-instrument-used");
    const result = loadProject(root);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(warnings(result.diagnostics)).toEqual([]);
  });

  it("names a sample file no instrument refers to", () => {
    const root = wholeProject("orphan-sample");
    mkdirSync(join(root, "samples"), { recursive: true });
    cpSync(A_REAL_WAV, join(root, "samples", "unused.wav"));

    const result = loadProject(root);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(warnings(result.diagnostics)).toEqual(["orphan.sample"]);
    const diagnostic = result.diagnostics.find((d) => d.code === "orphan.sample");
    expect(diagnostic?.file).toBe("samples/unused.wav");
  });

  it("says nothing about a sample a kit refers to", () => {
    const root = wholeProject("orphan-sample-used");
    mkdirSync(join(root, "samples"), { recursive: true });
    cpSync(A_REAL_WAV, join(root, "samples", "kick.wav"));
    writeJson(root, "instruments/k.json", {
      id: "k",
      type: "drumkit",
      kit: { kick: { sample: "samples/kick.wav" } },
    });
    writeJson(root, "project.json", {
      format: 1,
      name: "orphan-sample-used",
      ppqn: 960,
      tempoMap: [{ startTick: 0, bpm: 12000 }],
      meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
      swing: 0,
      trackOrder: ["t", "d"],
    });
    writeJson(root, "tracks/d.json", { id: "d", type: "drumkit", instrument: "k", patterns: [] });

    const result = loadProject(root);
    expect(errors(result.diagnostics)).toEqual([]);
    expect(warnings(result.diagnostics)).toEqual([]);
  });

  /**
   * A dotfile is skipped rather than reported: `samples/.DS_Store` is not a
   * sample anybody forgot to reference.
   */
  it("ignores dotfiles in samples/", () => {
    const root = wholeProject("orphan-sample-dotfile");
    mkdirSync(join(root, "samples"), { recursive: true });
    writeFileSync(join(root, "samples", ".DS_Store"), "");

    const result = loadProject(root);
    expect(warnings(result.diagnostics)).toEqual([]);
  });
});
