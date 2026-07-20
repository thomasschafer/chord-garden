import { closeSync, ftruncateSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProject } from "../src/index.js";

const INVALID_ROOT = fileURLToPath(new URL("../../../fixtures/invalid", import.meta.url));

/**
 * Fixture directory → diagnostic code that must be reported as an error.
 * The completeness test below keeps this table in lockstep with the
 * directories on disk.
 */
const EXPECTED: Record<string, string> = {
  "absolute-sample-path": "sample.path-invalid",
  "accent-x": "pattern.accent-unsupported",
  "bad-engine-param": "registry.unknown-param",
  "bad-id": "schema.pattern",
  "bad-step-events": "pattern.step-event-not-a-hit",
  comment: "json.comment",
  "dangling-sample": "sample.missing",
  "dotdot-sample-path": "sample.path-invalid",
  "duplicate-automation-lane": "automation.duplicate-lane",
  "duplicate-key": "json.duplicate-key",
  "float-param": "number.float",
  "float-tempo": "number.float",
  "format-2": "project.format-unsupported",
  "id-file-mismatch": "id.file-mismatch",
  "malformed-pattern-string": "pattern.invalid-char",
  "missing-reference": "ref.missing-instrument",
  "mixed-pattern": "schema.unevaluatedProperties",
  "non-automatable-param": "automation.param-not-automatable",
  "not-wav-sample": "sample.not-wav",
  "pattern-kind-mismatch": "track.pattern-kind-mismatch",
  "tie-marker": "pattern.tie-unsupported",
  "trackorder-duplicate": "trackorder.duplicate",
  "trackorder-unknown": "trackorder.unknown-track",
  "unknown-field": "schema.unevaluatedProperties",
  "wrong-step-count": "pattern.step-count-mismatch",
};

describe("invalid fixtures", () => {
  it("the expectation table covers exactly the fixture directories", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(readdirSync(INVALID_ROOT).sort());
  });

  for (const [dir, code] of Object.entries(EXPECTED)) {
    it(`${dir} reports ${code}`, () => {
      const result = loadProject(join(INVALID_ROOT, dir));
      expect(result.ok).toBe(false);
      const match = result.diagnostics.find((d) => d.code === code);
      expect(match, `expected code ${code} in: ${result.diagnostics.map((d) => d.code).join(", ")}`).toBeDefined();
      expect(match!.severity).toBe("error");
      // Every diagnostic must carry at least one locator.
      for (const d of result.diagnostics) {
        expect(d.pointer !== undefined || d.span !== undefined || d.loc !== undefined).toBe(true);
      }
    });
  }

  it("bad-engine-param includes a did-you-mean suggestion", () => {
    const result = loadProject(join(INVALID_ROOT, "bad-engine-param"));
    const diag = result.diagnostics.find((d) => d.code === "registry.unknown-param");
    expect(diag?.suggestion).toContain("filter.cutoff");
  });

  it("format-2 reports only the format error, nothing downstream", () => {
    const result = loadProject(join(INVALID_ROOT, "format-2"));
    expect(result.diagnostics.map((d) => d.code)).toEqual(["project.format-unsupported"]);
  });

  it("oversize samples are rejected", () => {
    const root = join(tmpdir(), `chord-garden-oversize-${process.pid}`);
    mkdirSync(join(root, "instruments"), { recursive: true });
    mkdirSync(join(root, "samples"), { recursive: true });
    writeFileSync(
      join(root, "project.json"),
      JSON.stringify({
        format: 1,
        name: "oversize",
        ppqn: 960,
        tempoMap: [{ startTick: 0, bpm: 12000 }],
        meterMap: [{ startTick: 0, timeSignature: [4, 4] }],
        swing: 0,
        trackOrder: [],
      }),
    );
    writeFileSync(join(root, "arrangement.json"), JSON.stringify({ lengthTicks: 3840, clips: [] }));
    writeFileSync(
      join(root, "instruments", "k.json"),
      JSON.stringify({ id: "k", type: "drumkit", kit: { kick: { sample: "samples/big.wav" } } }),
    );
    const fd = openSync(join(root, "samples", "big.wav"), "w");
    ftruncateSync(fd, 51 * 1024 * 1024);
    closeSync(fd);

    const result = loadProject(root);
    expect(result.diagnostics.some((d) => d.code === "sample.oversize")).toBe(true);
  });
});
