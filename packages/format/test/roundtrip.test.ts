import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalFiles, loadProject, parseStrictJson } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));

describe("worked example round-trip", () => {
  it("validates with no errors", () => {
    const result = loadProject(FIXTURE);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.project).toBeDefined();
  });

  it("fixture bytes are canonical (fmt is byte-stable)", () => {
    const result = loadProject(FIXTURE);
    const canonical = canonicalFiles(result.project!);
    for (const [path, content] of canonical) {
      expect(readFileSync(`${FIXTURE}/${path}`, "utf8"), `canonical bytes for ${path}`).toBe(content);
    }
    // Every loaded document is covered by the canonical writer and vice versa.
    expect([...canonical.keys()].sort()).toEqual([...result.files.keys()].sort());
  });

  it("parse → serialize → parse is the identity", () => {
    const result = loadProject(FIXTURE);
    for (const [path, content] of canonicalFiles(result.project!)) {
      const original = result.files.get(path)!.value;
      const reparsed = parseStrictJson(content, path);
      expect(reparsed.diagnostics).toEqual([]);
      expect(reparsed.value, `round-trip for ${path}`).toEqual(original);
    }
  });

  it("serializing twice produces identical bytes", () => {
    const result = loadProject(FIXTURE);
    const first = canonicalFiles(result.project!);
    const second = canonicalFiles(result.project!);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });
});
