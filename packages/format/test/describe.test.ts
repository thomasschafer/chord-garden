import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeProject, loadProject } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));
const GOLDEN = fileURLToPath(new URL("../../../fixtures/golden/describe-first-track.json", import.meta.url));

describe("describe --json golden output", () => {
  it("matches the committed golden file", () => {
    const result = loadProject(FIXTURE);
    const report = describeProject(result.project!);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(report).toEqual(golden);
  });
});
