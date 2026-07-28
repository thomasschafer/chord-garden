import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadProject, parseStrictJson } from "../src/index.js";
import { createTempProject } from "./tempProject.js";

const INVALID_ROOT = fileURLToPath(new URL("../../../fixtures/invalid", import.meta.url));

/**
 * `loc` is the only thing in a diagnostic that points at a *place in a file*
 * rather than at a place in the model, and it is the half an agent reads when it
 * opens the file to fix what `validate` complained about. Nothing else in the
 * suite asserts a line or a column, so every mutation of the arithmetic below —
 * a line off by one, a zero-based column, a binary search that picks the
 * previous line at a line boundary — used to ship green while skewing the
 * locator on every diagnostic the tool emits.
 *
 * Positions are checked against text laid out literally in each test so the
 * expected numbers can be counted by eye rather than derived from the code
 * under test.
 */
describe("JSON locator arithmetic", () => {
  const firstDiagnostic = (text: string) => {
    const result = parseStrictJson(text, "f.json");
    expect(result.diagnostics).toHaveLength(1);
    return result.diagnostics[0]!;
  };

  it("locates a fault on the first line, counting columns from one", () => {
    //                     123456789
    const diagnostic = firstDiagnostic('{"a": ?}');
    expect(diagnostic.loc).toEqual({ line: 1, column: 7 });
    expect(diagnostic.span).toEqual({ start: 6, end: 7 });
  });

  it("locates a fault in the very first character", () => {
    const diagnostic = firstDiagnostic("?");
    expect(diagnostic.loc).toEqual({ line: 1, column: 1 });
    expect(diagnostic.span).toEqual({ start: 0, end: 1 });
  });

  it("locates a fault on a later line, counting lines from one", () => {
    const text = ['{', '  "a": 1,', '  "b": ?', "}"].join("\n");
    //                             12345678
    const diagnostic = firstDiagnostic(text);
    expect(diagnostic.loc).toEqual({ line: 3, column: 8 });
    // Offset 19 is the `?`: 2 for `{\n`, 9 for `  "a": 1,`, 1 for `\n`, then 7.
    expect(diagnostic.span).toEqual({ start: 19, end: 20 });
  });

  /**
   * The offset here is exactly a line start, which is the one input that tells
   * the line lookup's `lineStarts[mid] <= offset` apart from `<`. With `<` this
   * reports the end of the previous line instead — a locator that is wrong by a
   * whole line and points at a character that is fine.
   */
  it("locates a fault at the very start of a line on that line, not the previous one", () => {
    const text = ["{", '"a": 1,', "?", "}"].join("\n");
    const diagnostic = firstDiagnostic(text);
    expect(diagnostic.loc).toEqual({ line: 3, column: 1 });
    expect(diagnostic.span).toEqual({ start: 10, end: 11 });
  });

  it("locates a fault at end of input past the last character, with an empty span", () => {
    const diagnostic = firstDiagnostic('{"a": 1');
    expect(diagnostic.loc).toEqual({ line: 1, column: 8 });
    // Clamped to the text length, so the span never points past the file.
    expect(diagnostic.span).toEqual({ start: 7, end: 7 });
  });

  it("locates the fault in an empty file at line 1, column 1", () => {
    const diagnostic = firstDiagnostic("");
    expect(diagnostic.loc).toEqual({ line: 1, column: 1 });
    expect(diagnostic.span).toEqual({ start: 0, end: 0 });
  });

  it("locates a fault at end of input on the last line of a multi-line file", () => {
    const text = ["{", '  "a": 1,', '  "b": 2'].join("\n");
    const diagnostic = firstDiagnostic(text);
    expect(diagnostic.loc).toEqual({ line: 3, column: 9 });
  });

  /**
   * Columns are UTF-16 code units, which is what a JS string index is and what
   * an LSP position is, but is neither a byte offset nor a count of characters.
   * A BMP character such as `é` is one unit and the two agree; an astral one
   * such as an emoji is two, and they do not. Pinned in both shapes so that a
   * later switch to code points or to UTF-8 bytes is a deliberate change with a
   * failing test rather than a silent drift in what `column` means.
   */
  describe("columns count UTF-16 code units", () => {
    it("counts a BMP character as one column", () => {
      const diagnostic = firstDiagnostic('{"éé": ?}');
      expect(diagnostic.loc).toEqual({ line: 1, column: 8 });
    });

    it("counts an astral character as two columns", () => {
      const drum = "\u{1F941}";
      expect(drum).toHaveLength(2);
      const diagnostic = firstDiagnostic(`{"${drum}${drum}": ?}`);
      // Eight *characters* precede the `?`, but ten UTF-16 code units do.
      expect(diagnostic.loc).toEqual({ line: 1, column: 10 });
      expect(diagnostic.span).toEqual({ start: 9, end: 10 });
    });
  });

  it("treats a lone \\n as the line break and leaves \\r in the preceding line", () => {
    const text = ["{", '  "a": ?', "}"].join("\r\n");
    const diagnostic = firstDiagnostic(text);
    expect(diagnostic.loc).toEqual({ line: 2, column: 8 });
  });

  it("locates a duplicate key at the key, not at the value or the enclosing object", () => {
    const text = ["{", '  "a": 1,', '  "a": 2', "}"].join("\n");
    const diagnostic = firstDiagnostic(text);
    expect(diagnostic.code).toBe("json.duplicate-key");
    expect(diagnostic.loc).toEqual({ line: 3, column: 3 });
    // The span covers the whole re-declared key including both quotes.
    expect(diagnostic.span).toEqual({ start: 14, end: 17 });
    expect(diagnostic.pointer).toBe("/a");
  });

  it("locates a comment at the slashes that opened it", () => {
    const text = ["{", "  // hi", '  "a": 1', "}"].join("\n");
    const diagnostic = firstDiagnostic(text);
    expect(diagnostic.code).toBe("json.comment");
    expect(diagnostic.loc).toEqual({ line: 2, column: 3 });
  });

  it("locates trailing content after a complete value", () => {
    const diagnostic = firstDiagnostic("{}  x");
    expect(diagnostic.loc).toEqual({ line: 1, column: 5 });
  });

  /**
   * The pointer→`Loc` map is what every *semantic* diagnostic is placed by, so
   * its convention matters as much as the parse errors above: an entry is the
   * position of the member's **value**, not of its key.
   */
  it("maps every pointer to the position of its value", () => {
    const text = ["{", '  "a": [1, 22],', '  "b": {"c": 3}', "}"].join("\n");
    const result = parseStrictJson(text, "f.json");
    expect(result.diagnostics).toEqual([]);
    expect([...result.locs]).toEqual([
      ["", { line: 1, column: 1 }],
      ["/a", { line: 2, column: 8 }],
      ["/a/0", { line: 2, column: 9 }],
      ["/a/1", { line: 2, column: 12 }],
      ["/b", { line: 3, column: 8 }],
      ["/b/c", { line: 3, column: 14 }],
    ]);
  });
});

/**
 * The arithmetic above only matters if it survives the trip to a diagnostic an
 * agent actually reads, which for a semantic rule runs through the pointer map
 * rather than through a parse failure. These assert positions in committed
 * fixture files, counted by hand from the file on disk.
 */
describe("locators on the diagnostics validate emits", () => {
  it("places a cross-file reference error on the line and column of the offending value", () => {
    const result = loadProject(join(INVALID_ROOT, "missing-reference"));
    const diagnostic = result.diagnostics.find((d) => d.code === "ref.missing-instrument");
    // tracks/t.json line 4 is `  "instrument": "nonexistent",`; the value opens
    // at column 17.
    expect(diagnostic?.loc).toEqual({ line: 4, column: 17 });
  });

  it("places a nested registry error deep inside an effects chain", () => {
    const result = loadProject(join(INVALID_ROOT, "bad-effect-param"));
    const diagnostic = result.diagnostics.find((d) => d.code === "registry.unknown-param");
    // tracks/t.json line 11 is `        "feedbak": 400`; the value opens at
    // column 20.
    expect(diagnostic?.loc).toEqual({ line: 11, column: 20 });
  });

  /**
   * A steps string has its own coordinate system — `parseSteps` counts the
   * characters of the decoded string — and a diagnostic's locators are in the
   * file's. These used to be computed and then dropped, so a column-accurate
   * complaint about one character arrived pointing at the whole string.
   *
   * The escape is the point of the fixture rather than decoration: `X` is
   * one decoded character and six written ones, so a translation that added the
   * string index to the string's start would land in the middle of it.
   */
  it("translates a steps-string column into the file that spells it", () => {
    const root = createTempProject("steps-span");
    //                     1234567890123456789012345678
    const line = '  "steps": "x..\\u0058 ..x. x..x ..x."';
    const text = `{\n  "id": "p",\n  "kind": "grid",\n  "lengthTicks": 3840,\n  "lanes": [\n    {\n      "lane": "kick",\n      "grid": { "stepsPerBar": 16 },\n    ${line}\n    }\n  ]\n}`;
    writeFileSync(join(root, "patterns", "p.json"), text);

    try {
      const result = loadProject(root);
      const diagnostic = result.diagnostics.find((d) => d.code === "pattern.accent-unsupported");
      expect(diagnostic?.pointer).toBe("/lanes/0/steps");
      // The `X` is decoded character 3 of the steps string, written as the six
      // characters `X`. Read back out of the file, the span is exactly them.
      expect(diagnostic?.span).toBeDefined();
      expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe("\\u0058");
      // And the line and column follow the span rather than the pointer, so they
      // name the offending character and not the string that contains it.
      expect(diagnostic?.loc?.line).toBe(9);
      expect(diagnostic?.loc?.column).toBe(text.split("\n")[8]!.indexOf("\\u0058") + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries the parser's span through loadProject to the caller", () => {
    const root = createTempProject("span");
    writeFileSync(join(root, "tracks", "t.json"), '{\n  "id": "t",\n  "id": "t"\n}');

    try {
      const result = loadProject(root);
      const diagnostic = result.diagnostics.find((d) => d.code === "json.duplicate-key");
      // The repeated key opens at offset 17 and closes at 20, so the span is the
      // four characters of `"id"` on the third line.
      expect(diagnostic?.span).toEqual({ start: 17, end: 21 });
      expect(diagnostic?.loc).toEqual({ line: 3, column: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
