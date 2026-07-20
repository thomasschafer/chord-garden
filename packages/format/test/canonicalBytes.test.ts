import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalFiles, loadProject } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/valid/first-track", import.meta.url));

/**
 * Cross-implementation byte-identical serialization harness (PLAN §18/§19.9):
 * a single TypeScript implementation today, but the assertion is against a
 * fixed byte snapshot, not "whatever the code currently produces" — so a
 * second implementation (e.g. Rust) can be tested against these same
 * snapshots later without this file changing.
 */
describe("canonical byte-identical serialization", () => {
  it("produces the exact expected bytes for every file in the worked example", () => {
    const result = loadProject(FIXTURE);
    const canonical = canonicalFiles(result.project!);

    expect(canonical.get("project.json")).toBe(
      [
        "{",
        '  "format": 1,',
        '  "name": "first track",',
        '  "ppqn": 960,',
        '  "tempoMap": [',
        "    {",
        '      "startTick": 0,',
        '      "bpm": 12400',
        "    }",
        "  ],",
        '  "meterMap": [',
        "    {",
        '      "startTick": 0,',
        '      "timeSignature": [4, 4]',
        "    }",
        "  ],",
        '  "key": {',
        '    "root": "A",',
        '    "scale": "minor"',
        "  },",
        '  "swing": 0,',
        '  "trackOrder": ["drums", "bass", "pad"]',
        "}",
        "",
      ].join("\n"),
    );

    expect(canonical.get("arrangement.json")).toBe(
      [
        "{",
        '  "lengthTicks": 61440,',
        '  "clips": [',
        "    {",
        '      "track": "drums",',
        '      "pattern": "drums-verse",',
        '      "startTick": 0,',
        '      "repeatCount": 16',
        "    },",
        "    {",
        '      "track": "bass",',
        '      "pattern": "bass-main",',
        '      "startTick": 15360,',
        '      "repeatCount": 6',
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
  });
});
