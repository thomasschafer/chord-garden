import { execFileSync } from "node:child_process";
import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject, MAX_DOCUMENT_BYTES } from "../src/index.js";
import { addDrumkitReferencing, createTempProject } from "./tempProject.js";

/**
 * A project directory is a directory on the user's disk, so it contains whatever
 * ends up there — and `loadProject` is what the CLI and the dev server both call
 * on it, synchronously, per request.
 *
 * A FIFO used to be the worst case: `readFileSync` on one blocks until something
 * opens the write end, which for a stray `mkfifo tracks/pipe.json` is never. One
 * GET wedged the dev server's event loop permanently — it did not recover even
 * after the FIFO was deleted, taking the watcher and the user's unsaved edits
 * with it.
 *
 * Every test here would hang rather than fail if that regressed, so a failure may
 * show up as the suite timeout rather than as an assertion.
 */

const roots: string[] = [];

function project(label: string): string {
  const root = createTempProject(label);
  roots.push(root);
  return root;
}

function makeFifo(path: string): void {
  execFileSync("mkfifo", [path]);
}

afterEach(() => {
  // FIFOs are removed with the directory; nothing here holds one open.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a project directory containing something that is not a document", () => {
  it("reports a FIFO in a document directory instead of blocking on it", () => {
    const root = project("fifo-doc");
    makeFifo(join(root, "tracks", "pipe.json"));

    const result = loadProject(root);
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === "project.not-a-file");
    expect(diagnostic?.file).toBe("tracks/pipe.json");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("FIFO");
  });

  it("reports a FIFO in place of a required document rather than calling it missing", () => {
    const root = project("fifo-required");
    rmSync(join(root, "arrangement.json"));
    makeFifo(join(root, "arrangement.json"));

    const result = loadProject(root);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain("project.not-a-file");
    // "missing" would send the reader looking for a file that is right there.
    expect(result.diagnostics.map((d) => d.code)).not.toContain("project.missing-file");
  });

  it("reports a directory named like a document", () => {
    const root = project("dir-doc");
    mkdirSync(join(root, "tracks", "folder.json"));

    const result = loadProject(root);
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === "project.not-a-file");
    expect(diagnostic?.file).toBe("tracks/folder.json");
    expect(diagnostic?.message).toContain("directory");
  });

  it("reports a FIFO where a sample belongs instead of blocking on it", () => {
    const root = project("fifo-sample");
    addDrumkitReferencing(root, "samples/kick.wav");
    makeFifo(join(root, "samples", "kick.wav"));

    const result = loadProject(root);
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === "sample.not-a-file");
    expect(diagnostic?.file).toBe("instruments/k.json");
    expect(diagnostic?.pointer).toBe("/kit/kick/sample");
    expect(diagnostic?.message).toContain("FIFO");
  });

  it("reports a directory where a sample belongs", () => {
    // The sibling of "a directory named like a document": samples reach the disk
    // through `checkSamples` rather than through the document loader, so the two
    // are separate call sites of `readRegularFile` and only one of them was
    // covered. A plain `readFileSync` here fails with `EISDIR`, which had nowhere
    // to be caught and left `validate` printing a V8 stack.
    const root = project("dir-sample");
    addDrumkitReferencing(root, "samples/kick.wav");
    mkdirSync(join(root, "samples", "kick.wav"));

    const result = loadProject(root);
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === "sample.not-a-file");
    expect(diagnostic?.file).toBe("instruments/k.json");
    expect(diagnostic?.pointer).toBe("/kit/kick/sample");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("directory");
    // Specifically not reported as absent: the path is right there.
    expect(result.diagnostics.map((d) => d.code)).not.toContain("sample.missing");
  });

  it("refuses a document past the size cap instead of reading it into memory", () => {
    const root = project("huge-doc");
    const path = join(root, "tracks", "huge.json");
    const fd = openSync(path, "w");
    ftruncateSync(fd, MAX_DOCUMENT_BYTES + 1);
    closeSync(fd);

    const result = loadProject(root);
    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find((d) => d.code === "project.file-too-large");
    expect(diagnostic?.file).toBe("tracks/huge.json");
    expect(diagnostic?.message).toContain(String(MAX_DOCUMENT_BYTES));
  });

  it("still reads a document that sits just under the cap", () => {
    const root = project("under-cap");
    // Padding a real track document with a long description keeps this a test of
    // the size gate rather than of the parser.
    const track = {
      id: "t",
      name: "t".padEnd(1024, "t"),
      instrument: "k",
      description: "x".repeat(64 * 1024),
      clips: [],
    };
    writeFileSync(join(root, "tracks", "t.json"), JSON.stringify(track));
    addDrumkitReferencing(root, "samples/kick.wav");

    const result = loadProject(root);
    // It fails on the missing sample and the unknown-field rules, not on size.
    expect(result.diagnostics.map((d) => d.code)).not.toContain("project.file-too-large");
    expect(result.files.has("tracks/t.json") || result.diagnostics.some((d) => d.file === "tracks/t.json")).toBe(true);
  });
});
