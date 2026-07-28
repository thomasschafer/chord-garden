import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeProject, loadProject } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
const INVALID_ROOT = fileURLToPath(new URL("../../../fixtures/invalid", import.meta.url));
const GOLDEN = fileURLToPath(new URL("../../../fixtures/golden/describe-first-track.json", import.meta.url));

describe("describe --json golden output", () => {
  it("matches the committed golden file", () => {
    const result = loadProject(FIXTURE);
    const report = describeProject(result.project!);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(report).toEqual(golden);
  });
});

/**
 * `describe` is a read-only command an agent reaches for *because* something is
 * wrong, so it has to survive a project that does not validate. It used to die on
 * one: `trackOrder` naming a track with no document threw a raw `TypeError` out of
 * the CLI, with a V8 stack instead of a diagnostic.
 */
describe("describing a project that does not validate", () => {
  it("summarises what it can when trackOrder names a track that does not exist", () => {
    const result = loadProject(join(INVALID_ROOT, "trackorder-unknown"));
    // The premise of the whole case: the project assembles, and is still invalid.
    expect(result.project).toBeDefined();
    expect(result.ok).toBe(false);

    const report = describeProject(result.project!);

    // Everything that does not depend on the broken track is still reported.
    expect(report.name).toBe(result.project!.project.name);
    expect(report.bars).toBeGreaterThan(0);
    // And the track that is wrong keeps its place, named, rather than vanishing.
    expect(report.tracks.map((track) => track.id)).toEqual(result.project!.project.trackOrder);
    const missing = report.tracks.filter((track) => "missing" in track);
    expect(missing.length).toBeGreaterThan(0);
    for (const track of missing) expect(result.project!.tracks.has(track.id)).toBe(false);
  });

  it("does not throw on any invalid fixture the loader still assembles", () => {
    // The general property, not just the one fixture that was reported: describe
    // is total over anything `loadProject` hands back a model for. A new invalid
    // fixture that breaks it fails here.
    const assembled = readdirSync(INVALID_ROOT)
      .map((dir) => [dir, loadProject(join(INVALID_ROOT, dir))] as const)
      .filter(([, result]) => result.project !== undefined);
    expect(assembled.length).toBeGreaterThan(0);
    for (const [dir, result] of assembled) {
      expect(() => describeProject(result.project!), `describe threw on fixtures/invalid/${dir}`).not.toThrow();
    }
  });
});
