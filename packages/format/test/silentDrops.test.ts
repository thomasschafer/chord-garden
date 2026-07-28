import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../src/index.js";
import type { Diagnostic } from "../src/index.js";

const INVALID_ROOT = fileURLToPath(new URL("../../../fixtures/invalid", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A writable copy of a fixture, so a test can edit one field and re-validate. */
function copyFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `chord-garden-${name}-`));
  temps.push(root);
  cpSync(join(INVALID_ROOT, name), root, { recursive: true });
  return root;
}

function editJson(root: string, path: string, mutate: (doc: Record<string, unknown>) => void): void {
  const file = join(root, path);
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  mutate(doc);
  writeFileSync(file, JSON.stringify(doc));
}

function codes(diagnostics: Diagnostic[], severity: Diagnostic["severity"]): string[] {
  return diagnostics.filter((d) => d.severity === severity).map((d) => d.code);
}

/**
 * The two paths where a project used to render *less music than it says* and
 * report nothing. Both rules had to be written so they fire on exactly the
 * broken shape and not on the legitimate one next to it — a rule that fires on a
 * healthy project is the thing PLAN.md §13 warns is worse than no rule, and an
 * `error` that does it is worse still, because it blocks work.
 */
describe("a track with clips that trackOrder does not place", () => {
  it("is an error, not a warning, because the whole part would be missing", () => {
    const result = loadProject(join(INVALID_ROOT, "trackorder-missing-track"));
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics, "error")).toContain("trackorder.missing-track");
    // Specifically not the warning it used to be.
    expect(codes(result.diagnostics, "warning")).not.toContain("orphan.track");
  });

  it("stays a warning when the track has no clips, since no music is lost", () => {
    const root = copyFixture("trackorder-missing-track");
    editJson(root, "arrangement.json", (doc) => {
      doc["clips"] = [];
    });
    const result = loadProject(root);
    expect(codes(result.diagnostics, "error")).not.toContain("trackorder.missing-track");
    // PLAN.md §8.1 keeps this an orphan warning until versioning arrives.
    expect(codes(result.diagnostics, "warning")).toContain("orphan.track");
  });

  it("says nothing once the track is listed", () => {
    const root = copyFixture("trackorder-missing-track");
    editJson(root, "project.json", (doc) => {
      doc["trackOrder"] = ["t"];
    });
    const result = loadProject(root);
    expect(codes(result.diagnostics, "error")).toEqual([]);
    expect(codes(result.diagnostics, "warning")).not.toContain("orphan.track");
  });
});

describe("an event nudged before the start of the arrangement", () => {
  it("is an error, because no render setting can make it sound", () => {
    const result = loadProject(join(INVALID_ROOT, "microticks-before-zero"));
    expect(result.ok).toBe(false);
    expect(codes(result.diagnostics, "error")).toContain("event.before-timeline-start");
  });

  it("is legal in a clip that starts later, where the nudge lands inside the timeline", () => {
    const root = copyFixture("microticks-before-zero");
    editJson(root, "arrangement.json", (doc) => {
      doc["lengthTicks"] = 7680;
      doc["clips"] = [{ track: "t", pattern: "p", startTick: 3840, repeatCount: 1 }];
    });
    const result = loadProject(root);
    // A hit that lands slightly early is what `microTicks` is for; only tick 0
    // makes it unreachable.
    expect(codes(result.diagnostics, "error")).toEqual([]);
  });

  it("is legal at tick 0 when the nudge is not big enough to cross it", () => {
    const root = copyFixture("microticks-before-zero");
    editJson(root, "patterns/p.json", (doc) => {
      const notes = doc["notes"] as Record<string, unknown>[];
      notes[0]!["startTick"] = 480;
    });
    const result = loadProject(root);
    expect(codes(result.diagnostics, "error")).toEqual([]);
  });

  it("catches a grid step nudged before zero, swing and all", () => {
    const root = copyFixture("microticks-before-zero");
    // Swap the whole project over to a drumkit so the grid arithmetic is
    // exercised rather than the notes arithmetic.
    editJson(root, "tracks/t.json", (doc) => {
      doc["type"] = "drumkit";
      doc["instrument"] = "d";
    });
    writeFileSync(
      join(root, "instruments", "d.json"),
      JSON.stringify({ id: "d", type: "drumkit", kit: { kick: { sample: "samples/kick.wav" } } }),
    );
    rmSync(join(root, "instruments", "s.json"));
    // The fixture has no `samples/`, and git cannot carry an empty directory, so
    // the test makes its own rather than depending on one being there.
    mkdirSync(join(root, "samples"), { recursive: true });
    cpSync(
      join(INVALID_ROOT, "prototype-kit-lane", "samples", "kick.wav"),
      join(root, "samples", "kick.wav"),
    );
    writeFileSync(
      join(root, "patterns", "p.json"),
      JSON.stringify({
        id: "p",
        kind: "grid",
        lengthTicks: 3840,
        lanes: [
          {
            lane: "kick",
            grid: { stepsPerBar: 16 },
            steps: "x... .... .... ....",
            stepEvents: [{ step: 0, microTicks: -8 }],
          },
        ],
      }),
    );
    const result = loadProject(root);
    expect(codes(result.diagnostics, "error")).toContain("event.before-timeline-start");
  });
});
