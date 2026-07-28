import { closeSync, ftruncateSync, openSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProject } from "../src/index.js";
import { addDrumkitReferencing, createTempProject } from "./tempProject.js";

const INVALID_ROOT = fileURLToPath(new URL("../../../fixtures/invalid", import.meta.url));

/**
 * Fixture directory → diagnostic code that must be reported as an error.
 * The completeness test below keeps this table in lockstep with the
 * directories on disk.
 */
const EXPECTED: Record<string, string> = {
  "absolute-sample-path": "sample.path-invalid",
  "accent-x": "pattern.accent-unsupported",
  "bad-effect-param": "registry.unknown-param",
  "bad-engine-param": "registry.unknown-param",
  "bad-id": "schema.pattern",
  "bad-step-events": "pattern.step-event-not-a-hit",
  // The two clip-side twins of `pattern-kind-mismatch` and a kit-lane mistake:
  // the pattern is reached only through `arrangement.clips`, which is the one
  // reference the *renderer* uses, so these are the pairings that used to
  // validate clean and then fail to render.
  "clip-lane-unknown-voice": "pattern.lane-unknown-voice",
  "clip-pattern-kind-mismatch": "track.pattern-kind-mismatch",
  comment: "json.comment",
  "dangling-sample": "sample.missing",
  "dotdot-sample-path": "sample.path-invalid",
  "duplicate-automation-lane": "automation.duplicate-lane",
  "duplicate-effect-id": "effect.duplicate-id",
  "duplicate-key": "json.duplicate-key",
  "float-param": "number.float",
  "float-tempo": "number.float",
  "format-1-effects": "format.effects-require-2",
  // Named for its purpose rather than for a version number: it holds one *past*
  // `SUPPORTED_FORMAT`, so bumping the format moves the fixture's contents and a
  // name like `format-2` would end up describing a version the tool now reads.
  "format-newer": "project.format-unsupported",
  "id-file-mismatch": "id.file-mismatch",
  "malformed-pattern-string": "pattern.invalid-char",
  // A note nudged before tick 0 by `microTicks`: the compiler drops it and says
  // nothing. The same pattern in a clip that starts later is legal and stays so.
  "microticks-before-zero": "event.before-timeline-start",
  "missing-reference": "ref.missing-instrument",
  "mixed-pattern": "schema.unevaluatedProperties",
  "non-automatable-effect-param": "automation.param-not-automatable",
  "non-automatable-param": "automation.param-not-automatable",
  "not-wav-sample": "sample.not-wav",
  "pattern-kind-mismatch": "track.pattern-kind-mismatch",
  // Four surfaces of one mistake: a name a project file chose that happens to be
  // a member of `Object.prototype`. Each used to be accepted by an `in` test or a
  // bare index against a table, and each fails differently afterwards — a crash,
  // a silently ignored automation lane, a param nothing reads.
  // Schema, not registry: `__proto__` fails the param-name pattern, which is the
  // closed-schema guarantee doing its job. The bug was never the rule — it was
  // that the key vanished during parsing, so no rule ever saw it.
  "proto-key-param": "schema.additionalProperties",
  "prototype-automation-voice": "registry.unknown-param",
  "prototype-kit-lane": "pattern.lane-unknown-voice",
  "prototype-synth-param": "registry.unknown-param",
  "tie-marker": "pattern.tie-unsupported",
  "trackorder-duplicate": "trackorder.duplicate",
  // A track with clips that `trackOrder` does not place. `compile` walks
  // `trackOrder`, so the whole part is absent from the render — previously with
  // `warnings: none` to report it.
  "trackorder-missing-track": "trackorder.missing-track",
  "trackorder-unknown": "trackorder.unknown-track",
  "unknown-effect-automation": "ref.missing-effect",
  "unknown-field": "schema.unevaluatedProperties",
  "wrong-step-count": "pattern.step-count-mismatch",
  // A structurally perfect WAV whose sample rate is 0. It used to pass both the
  // header check and the decoder, and rendered every hit pinned to its first
  // sample at +33 dBFS — the one case in this group that produced audio rather
  // than a crash, and so the one an agent could not have caught by reading
  // `warnings`.
  "zero-rate-sample": "sample.not-wav",
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

  it("a newer format reports only the format error, nothing downstream", () => {
    const result = loadProject(join(INVALID_ROOT, "format-newer"));
    expect(result.diagnostics.map((d) => d.code)).toEqual(["project.format-unsupported"]);
  });

  it("bad-effect-param suggests the effect param that was meant", () => {
    const result = loadProject(join(INVALID_ROOT, "bad-effect-param"));
    const diag = result.diagnostics.find((d) => d.code === "registry.unknown-param");
    expect(diag?.suggestion).toContain("feedback");
    expect(diag?.pointer).toBe("/effects/0/params/feedbak");
  });

  it("a format-1 project with effects names the version it needs", () => {
    const result = loadProject(join(INVALID_ROOT, "format-1-effects"));
    const diag = result.diagnostics.find((d) => d.code === "format.effects-require-2");
    expect(diag?.file).toBe("tracks/t.json");
    expect(diag?.pointer).toBe("/effects");
    expect(diag?.suggestion).toContain('"format" to 2');
    // The version is the only complaint: reporting the chain's params against a
    // format that has no chains would be a page of consequences of one mistake.
    expect(result.diagnostics.map((d) => d.code)).toEqual(["format.effects-require-2"]);
  });

  it("unknown-effect-automation suggests the effect id that was meant", () => {
    const result = loadProject(join(INVALID_ROOT, "unknown-effect-automation"));
    const diag = result.diagnostics.find((d) => d.code === "ref.missing-effect");
    expect(diag?.suggestion).toContain("slap");
  });

  it("oversize samples are rejected", () => {
    const root = createTempProject("oversize");
    addDrumkitReferencing(root, "samples/big.wav");
    const fd = openSync(join(root, "samples", "big.wav"), "w");
    ftruncateSync(fd, 51 * 1024 * 1024);
    closeSync(fd);

    try {
      const result = loadProject(root);
      expect(result.diagnostics.some((d) => d.code === "sample.oversize")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
