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
  // The four automation rules that only fire once the lane resolves: a lane can
  // name a real, automatable param and still be unplayable.
  "automation-point-past-arrangement": "automation.point-out-of-range",
  "automation-points-not-increasing": "automation.points-not-increasing",
  "automation-unknown-track": "automation.unknown-track",
  "automation-value-out-of-range": "registry.out-of-range",
  "bad-effect-param": "registry.unknown-param",
  "bad-engine-param": "registry.unknown-param",
  "bad-id": "schema.pattern",
  "bad-step-events": "pattern.step-event-not-a-hit",
  // The two clip-side twins of `pattern-kind-mismatch` and a kit-lane mistake:
  // the pattern is reached only through `arrangement.clips`, which is the one
  // reference the *renderer* uses, so these are the pairings that used to
  // validate clean and then fail to render.
  "clip-lane-unknown-voice": "pattern.lane-unknown-voice",
  // `ref.missing-pattern` and `ref.missing-track` are reported from three
  // separate call sites, and each has its own fixture: a dangling reference in a
  // track's `patterns` list is a different line of code from the same mistake in
  // an `arrangement` clip, and deleting either one used to break nothing.
  "clip-missing-pattern": "ref.missing-pattern",
  "clip-missing-track": "ref.missing-track",
  "clip-out-of-range": "clip.out-of-range",
  "clip-pattern-kind-mismatch": "track.pattern-kind-mismatch",
  comment: "json.comment",
  "dangling-sample": "sample.missing",
  "dotdot-sample-path": "sample.path-invalid",
  "duplicate-automation-lane": "automation.duplicate-lane",
  "duplicate-effect-id": "effect.duplicate-id",
  "duplicate-key": "json.duplicate-key",
  "duplicate-step-event": "pattern.step-event-duplicate",
  "float-param": "number.float",
  "float-tempo": "number.float",
  "format-1-effects": "format.effects-require-2",
  // Named for its purpose rather than for a version number: it holds one *past*
  // `SUPPORTED_FORMAT`, so bumping the format moves the fixture's contents and a
  // name like `format-2` would end up describing a version the tool now reads.
  "format-newer": "project.format-unsupported",
  // A bar length of 3840 ticks does not divide into 7 steps, so no step has a
  // whole-tick position.
  "grid-not-divisible": "pattern.grid-not-divisible",
  "id-file-mismatch": "id.file-mismatch",
  "instrument-type-mismatch": "track.instrument-type-mismatch",
  "malformed-pattern-string": "pattern.invalid-char",
  "meter-not-at-zero": "project.meter-map-start",
  // ppqn 25 with a 1/16 bar is 6.25 ticks per bar, which every downstream tick
  // calculation would carry as a float.
  "meter-ticks-not-integer": "project.meter-ticks-not-integer",
  // A note nudged before tick 0 by `microTicks`: the compiler drops it and says
  // nothing. The same pattern in a clip that starts later is legal and stays so.
  "microticks-before-zero": "event.before-timeline-start",
  "missing-reference": "ref.missing-instrument",
  "mixed-pattern": "schema.unevaluatedProperties",
  "non-automatable-effect-param": "automation.param-not-automatable",
  "non-automatable-param": "automation.param-not-automatable",
  "note-start-out-of-range": "note.start-out-of-range",
  // A `.wav` whose bytes are not a WAV. `sample-wrong-extension` is the other
  // half of the same rule, refused on its name before anything is opened.
  "not-wav-sample": "sample.not-wav",
  // The registry's range checks, one fixture per call site: an instrument's
  // `params` and an effect's `params` are validated by separate code.
  "out-of-range-effect-param": "registry.invalid-value",
  "out-of-range-param": "registry.invalid-value",
  // A param key whose first segment starts with `-`. The schemas admit a hyphen
  // *inside* a segment because a drumkit's params are keyed by kit voice and voice
  // ids are kebab-case — so this fixture is the other side of that: the shape stays
  // closed, and `swung-hat.gain` being legal does not make `-swung-hat.gain` legal.
  "param-key-shape": "schema.additionalProperties",
  "pattern-kind-mismatch": "track.pattern-kind-mismatch",
  "pattern-length-not-bar-multiple": "pattern.length-not-bar-multiple",
  // Both spellings pass the schema's pitch pattern and both fall outside MIDI
  // 0..127, one above and one below.
  "pitch-out-of-range": "note.pitch-out-of-range",
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
  // Project-relative and free of `..`, so it clears the first path rule and is
  // still not inside `samples/`.
  "sample-outside-samples-dir": "sample.path-invalid",
  "sample-wrong-extension": "sample.not-wav",
  "tempo-not-at-zero": "project.tempo-map-start",
  "tie-marker": "pattern.tie-unsupported",
  "track-missing-pattern": "ref.missing-pattern",
  "trackorder-duplicate": "trackorder.duplicate",
  // A track with clips that `trackOrder` does not place. `compile` walks
  // `trackOrder`, so the whole part is absent from the render — previously with
  // `warnings: none` to report it.
  "trackorder-missing-track": "trackorder.missing-track",
  "trackorder-unknown": "trackorder.unknown-track",
  // v1 reserves the *shape* of the tempo and meter maps but allows exactly one
  // point in each, at tick 0.
  "two-meter-points": "project.meter-map-size",
  "two-tempo-points": "project.tempo-map-size",
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

  /**
   * A pattern is reached by two independent references and a dangling one is
   * reported from two separate call sites. Sharing a `code` is deliberate — it
   * is the same mistake — but it also means one fixture cannot stand in for the
   * other, so each site is named here by the place it reports.
   */
  it("blames the track's own patterns list when that is where the dangling name is", () => {
    const result = loadProject(join(INVALID_ROOT, "track-missing-pattern"));
    const diagnostic = result.diagnostics.find((d) => d.code === "ref.missing-pattern");
    expect(diagnostic?.file).toBe("tracks/t.json");
    expect(diagnostic?.pointer).toBe("/patterns/0");
  });

  it("blames the clip when the dangling name is in the arrangement", () => {
    const result = loadProject(join(INVALID_ROOT, "clip-missing-pattern"));
    const diagnostic = result.diagnostics.find((d) => d.code === "ref.missing-pattern");
    expect(diagnostic?.file).toBe("arrangement.json");
    expect(diagnostic?.pointer).toBe("/clips/0/pattern");
  });

  it("reports a pitch off either end of the MIDI range, not just the top", () => {
    const result = loadProject(join(INVALID_ROOT, "pitch-out-of-range"));
    const pointers = result.diagnostics
      .filter((d) => d.code === "note.pitch-out-of-range")
      .map((d) => d.pointer);
    // `A9` is MIDI 129 and `Cb-1` is MIDI -1; a rule that only tested the upper
    // bound would report one of these and pass a note the renderer cannot voice.
    expect(pointers).toEqual(["/notes/0/pitch", "/notes/1/pitch"]);
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
